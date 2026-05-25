/**
 * Sorha Aana RAG Eval Suite
 *
 * Run:  npx tsx eval/run-evals.ts
 *
 * Env vars (optional):
 *   API_BASE  — defaults to production URL
 *   API_KEY   — defaults to shishir123
 */
import { extractParsedIntent, detectListingIntent } from '../src/rag-engine';
import dataset from './golden-dataset.json';

const API_BASE = process.env.API_BASE ?? 'https://sorha-aana-worker.neptechpal355.workers.dev';
const API_KEY  = process.env.API_KEY  ?? 'shishir123';

// ── Types ────────────────────────────────────────────────────────────────────

interface TestResult {
  id: string;
  desc: string;
  passed: boolean;
  failures: string[];
  durationMs?: number;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;

function hasEmoji(text: string): boolean {
  return EMOJI_RE.test(text);
}

function numClose(a: number, b: number, tol = 0.001): boolean {
  return Math.abs(a - b) <= tol;
}

function fmt(n: number): string {
  return n.toFixed(0) + 'ms';
}

function pass(id: string, desc: string, ms?: number): TestResult {
  return { id, desc, passed: true, failures: [], durationMs: ms };
}

function fail(id: string, desc: string, failures: string[], ms?: number): TestResult {
  return { id, desc, passed: false, failures, durationMs: ms };
}

async function apiRag(query: string): Promise<{ body: any; durationMs: number }> {
  const t0 = Date.now();
  const res = await fetch(`${API_BASE}/api/rag`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({ query, limit: 20 }),
    signal: AbortSignal.timeout(30_000),
  });
  const durationMs = Date.now() - t0;
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  }
  return { body: await res.json(), durationMs };
}

// ── 1. Intent Detection (unit) ───────────────────────────────────────────────

function runIntentTests(): TestResult[] {
  return (dataset.intent_detection as any[]).map((tc: any, i: number) => {
    const id = `INTENT-${String(i + 1).padStart(2, '0')}`;
    const got = detectListingIntent(tc.query);
    if (got === tc.expected) return pass(id, `"${tc.query}" → ${tc.expected}`);
    return fail(id, `"${tc.query}"`, [`expected ${JSON.stringify(tc.expected)}, got ${JSON.stringify(got)}`]);
  });
}

// ── 2. Filter Parsing (unit) ─────────────────────────────────────────────────

function runFilterTests(): TestResult[] {
  return (dataset.filter_parsing as any[]).map((tc: any, i: number) => {
    const id = `FILTER-${String(i + 1).padStart(2, '0')}`;
    const got = extractParsedIntent(tc.query);
    const failures: string[] = [];

    for (const [key, expected] of Object.entries(tc.expected as Record<string, any>)) {
      const actual = (got as any)[key];
      if (typeof expected === 'number') {
        if (!numClose(actual ?? NaN, expected)) {
          failures.push(`${key}: expected ${expected}, got ${actual}`);
        }
      } else {
        if (actual !== expected) {
          failures.push(`${key}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
        }
      }
    }

    const label = Object.entries(tc.expected).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ');
    if (failures.length === 0) return pass(id, `"${tc.query}" → ${label}`);
    return fail(id, `"${tc.query}"`, failures);
  });
}

// ── 3. E2E API Tests ─────────────────────────────────────────────────────────

async function runE2ETest(tc: any): Promise<TestResult> {
  const id: string = tc.id;
  const desc: string = tc.desc;
  let body: any;
  let durationMs: number;

  try {
    ({ body, durationMs } = await apiRag(tc.query));
  } catch (err: any) {
    return fail(id, desc, [`API call failed: ${err.message}`]);
  }

  const checks = tc.checks as Record<string, any>;
  const failures: string[] = [];
  const properties: any[] = body.properties ?? [];
  const answer: string = body.answer ?? '';

  // Result count checks
  if ('min_results' in checks && properties.length < checks.min_results) {
    failures.push(`min_results: expected >= ${checks.min_results}, got ${properties.length}`);
  }
  if ('max_results' in checks && properties.length > checks.max_results) {
    failures.push(`max_results: expected <= ${checks.max_results}, got ${properties.length}`);
  }

  // Detected intent check (from /api/rag response field)
  if ('detected_intent' in checks && body.detected_intent !== checks.detected_intent) {
    failures.push(`detected_intent: expected ${JSON.stringify(checks.detected_intent)}, got ${JSON.stringify(body.detected_intent)}`);
  }

  // All results must have this listing_type
  if ('all_listing_type' in checks) {
    const wrong = properties.filter((p: any) => p.listing_type !== checks.all_listing_type);
    if (wrong.length > 0) {
      failures.push(`all_listing_type=${checks.all_listing_type}: ${wrong.length} results have wrong type (${[...new Set(wrong.map((p: any) => p.listing_type))].join(', ')})`);
    }
  }

  // Answer checks
  if (checks.answer_not_empty && answer.length < 30) {
    failures.push(`answer_not_empty: answer is too short (${answer.length} chars)`);
  }
  if (checks.answer_no_emojis && hasEmoji(answer)) {
    failures.push('answer_no_emojis: answer contains emoji characters');
  }
  if ('answer_contains_any' in checks) {
    const lower = answer.toLowerCase();
    const matched = (checks.answer_contains_any as string[]).some(kw => lower.includes(kw.toLowerCase()));
    if (!matched) {
      failures.push(`answer_contains_any: none of [${checks.answer_contains_any.join(', ')}] found in answer`);
    }
  }

  // Parsed filter checks (values returned in body.parsed_filters)
  if ('parsed_filters' in checks) {
    const pf = body.parsed_filters ?? {};
    for (const [key, expected] of Object.entries(checks.parsed_filters as Record<string, any>)) {
      const actual = pf[key];
      if (typeof expected === 'number') {
        if (!numClose(actual ?? NaN, expected)) {
          failures.push(`parsed_filters.${key}: expected ${expected}, got ${actual}`);
        }
      } else {
        if (actual !== expected) {
          failures.push(`parsed_filters.${key}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
        }
      }
    }
  }

  if (failures.length === 0) return pass(id, desc, durationMs);
  return fail(id, desc, failures, durationMs);
}

// ── Report ────────────────────────────────────────────────────────────────────

function printSection(title: string, results: TestResult[]) {
  const passed = results.filter(r => r.passed).length;
  const total = results.length;
  const pct = total === 0 ? 100 : Math.round((passed / total) * 100);
  console.log(`\n${'━'.repeat(60)}`);
  console.log(`${title}  [${passed}/${total}  ${pct}%]`);
  console.log('━'.repeat(60));
  for (const r of results) {
    const icon = r.passed ? '✓' : '✗';
    const timing = r.durationMs != null ? `  (${fmt(r.durationMs)})` : '';
    console.log(`  ${icon}  [${r.id}] ${r.desc}${timing}`);
    for (const f of r.failures) {
      console.log(`        → ${f}`);
    }
  }
}

function printSummary(all: TestResult[]) {
  const categories = [
    { label: 'Intent Detection', prefix: 'INTENT' },
    { label: 'Filter Parsing  ', prefix: 'FILTER' },
    { label: 'E2E API         ', prefix: 'E'      },
  ];

  console.log(`\n${'═'.repeat(60)}`);
  console.log('SUMMARY');
  console.log('═'.repeat(60));

  let grandPassed = 0;
  let grandTotal = 0;

  for (const { label, prefix } of categories) {
    const subset = all.filter(r => r.id.startsWith(prefix));
    const p = subset.filter(r => r.passed).length;
    const t = subset.length;
    const pct = t === 0 ? 100 : Math.round((p / t) * 100);
    console.log(`  ${label}  ${p}/${t}  (${pct}%)`);
    grandPassed += p;
    grandTotal += t;
  }

  const gPct = grandTotal === 0 ? 100 : Math.round((grandPassed / grandTotal) * 100);
  console.log('─'.repeat(60));
  console.log(`  OVERALL         ${grandPassed}/${grandTotal}  (${gPct}%)`);
  console.log('═'.repeat(60));

  if (grandPassed < grandTotal) {
    const failed = all.filter(r => !r.passed);
    console.log('\nFailed tests:');
    for (const r of failed) {
      console.log(`  [${r.id}] ${r.desc}`);
      for (const f of r.failures) console.log(`    → ${f}`);
    }
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n' + '═'.repeat(60));
  console.log('  SORHA AANA EVAL SUITE');
  console.log(`  API: ${API_BASE}`);
  console.log('═'.repeat(60));

  // Unit tests — instant
  const intentResults = runIntentTests();
  const filterResults = runFilterTests();

  printSection('UNIT: Intent Detection', intentResults);
  printSection('UNIT: Filter Parsing', filterResults);

  // E2E tests — sequential to respect Nominatim 1 req/sec rate limit
  console.log('\n' + '━'.repeat(60));
  console.log(`E2E: API Tests  [0/${dataset.e2e.length}  running...]`);
  console.log('━'.repeat(60));

  const e2eResults: TestResult[] = [];
  for (const tc of dataset.e2e as any[]) {
    process.stdout.write(`  ⋯  [${tc.id}] ${tc.desc} ...`);
    const result = await runE2ETest(tc);
    e2eResults.push(result);
    const icon = result.passed ? '✓' : '✗';
    const timing = result.durationMs != null ? ` (${fmt(result.durationMs)})` : '';
    process.stdout.write(`\r  ${icon}  [${tc.id}] ${tc.desc}${timing}\n`);
    for (const f of result.failures) console.log(`        → ${f}`);
    // 1.5s pause between E2E calls to avoid Nominatim rate limit
    if (tc !== (dataset.e2e as any[]).at(-1)) await new Promise(r => setTimeout(r, 1500));
  }

  const allResults = [...intentResults, ...filterResults, ...e2eResults];
  printSummary(allResults);

  const anyFailed = allResults.some(r => !r.passed);
  process.exit(anyFailed ? 1 : 0);
}

main().catch(err => {
  console.error('\nFatal error:', err);
  process.exit(1);
});
