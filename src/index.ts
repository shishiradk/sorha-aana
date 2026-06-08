import { RealEstateRAG } from './rag-engine';
import { vectorizeProperties, getVectorizationStatus, cleanupStaleVectors } from './vectorize';
import { html } from './ui';
import { RealEstateAPI } from './api';
import { openApiSpec, swaggerHtml } from './swagger';
import { getDatabaseSchema, formatSchemaForConsole, formatSchemaAsJson } from './inspect-db';
import { queryAll, queryExecute } from './db-utils';
import { processVectorizationQueue, getQueueStatus } from './vectorization-queue-processor';
import { batchGeocode, getGeocodeStatus } from './batch-geocode';
import { geocodeLocation } from './geocoding';

export interface Env {
  HYPERDRIVE: any; // Hyperdrive MySQL connection
  VECTORIZE: VectorizeIndex;
  AI: any;
  SORHAAANA_CACHE: KVNamespace;
  RATE_LIMITER: { limit(opts: { key: string }): Promise<{ success: boolean }> };
  ENVIRONMENT: string;
  MAX_RESULTS: string;
  PRICE_TOLERANCE: string;
  ADMIN_API_KEY?: string; // Optional API key for admin endpoints
  ALLOWED_ORIGINS?: string; // Comma-separated allowed origins (default: *)
}

/** Rate limit by API key — 20 req/min using Cloudflare's strongly-consistent RateLimiter binding */
async function checkRateLimit(env: Env, apiKey: string): Promise<boolean> {
  try {
    const hashBuf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(apiKey));
    const hashHex = [...new Uint8Array(hashBuf)].slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join('');
    const { success } = await env.RATE_LIMITER.limit({ key: hashHex });
    return success;
  } catch {
    return true; // Fail open if rate limiter unavailable
  }
}

/** Check if request has valid admin API key (header only) */
function isAdminAuthorized(request: Request, env: Env): boolean {
  if (!env.ADMIN_API_KEY) return true; // No key configured = open access (backward compatible)
  const authHeader = request.headers.get('Authorization');
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7) === env.ADMIN_API_KEY;
  }
  return false;
}

/** Build CORS headers based on env config */
function getCorsHeaders(request: Request, env: Env): Record<string, string> {
  const allowedOrigins = env.ALLOWED_ORIGINS
    ? env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
    : ['*'];
  const origin = request.headers.get('Origin') || '';
  const allowOrigin = allowedOrigins.includes('*') ? '*'
    : (origin && allowedOrigins.includes(origin)) ? origin : '*';

  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

/** Geocode new properties that have latitude IS NULL — called by cron */
async function geocodeNewProperties(env: Env, batchSize: number) {
  const tables = [
    { name: 'sellers', addressCol: 'property_address' },
    { name: 'rental_owners', addressCol: 'address' },
  ];

  let geocoded = 0;
  for (const { name: table, addressCol } of tables) {
    try {
      const { results: rows } = await queryAll(env,
        `SELECT p.id, p.${addressCol} as addr, p.city, d.name as district_name, m.name as municipality_name
         FROM ${table} p
         LEFT JOIN districts d ON p.district_id = d.id
         LEFT JOIN municipalities m ON p.municipal_id = m.id
         WHERE p.latitude IS NULL AND p.status = 'ACTIVE'
         LIMIT ?`,
        [batchSize - geocoded]
      );

      if (!rows || rows.length === 0) continue;
      console.log(`Geocoding ${rows.length} new ${table}...`);

      for (const row of rows as any[]) {
        if (geocoded >= batchSize) break;
        const addrStr = [row.addr, row.city, row.municipality_name, row.district_name].filter(Boolean).join(', ');
        if (!addrStr) continue;

        try {
          const coords = await geocodeLocation(addrStr);
          if (coords) {
            await queryExecute(env,
              `UPDATE ${table} SET latitude = ?, longitude = ? WHERE id = ?`,
              [coords.lat, coords.lng, row.id]
            );
            console.log(`  ${table} #${row.id} → ${coords.lat}, ${coords.lng}`);
            geocoded++;
          } else {
            // Mark as attempted (lat=0) so we don't retry forever
            await queryExecute(env,
              `UPDATE ${table} SET latitude = 0, longitude = 0 WHERE id = ?`,
              [row.id]
            );
            console.log(`  ${table} #${row.id} → geocoding failed, marked as attempted`);
          }
        } catch (err: any) {
          console.warn(`  ${table} #${row.id} geocode error: ${err.message}`);
        }
      }
    } catch (err: any) {
      console.warn(`Geocode scan for ${table} failed:`, err.message);
    }
  }

  if (geocoded > 0) console.log(`Cron geocoded ${geocoded} new properties`);
}

export default {
  // Runs every 5 minutes via Cloudflare Cron Trigger
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    console.log('Cron: running incremental vectorization + geocoding + cleanup...');
    ctx.waitUntil((async () => {
      const start = Date.now();
      const timeLeft = () => 25000 - (Date.now() - start); // 25s budget (5s safety margin)

      // Step 1: Vectorize new/updated properties
      if (timeLeft() > 5000) await vectorizeProperties(env, true);

      // Step 2: Geocode new properties that have no coordinates (5 per run to stay within 30s + rate limits)
      if (timeLeft() > 5000) await geocodeNewProperties(env, 5);

      // Step 3: Cleanup vectors for deleted/inactive properties (once per run)
      if (timeLeft() > 3000) await cleanupStaleVectors(env);
    })());
  },

  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Serve UI
    if (path === '/' && request.method === 'GET') {
      return new Response(html, {
        headers: { 'Content-Type': 'text/html' }
      });
    }

    // CORS — respects ALLOWED_ORIGINS env var
    const corsHeaders = getCorsHeaders(request, env);

    // Admin auth helper — returns 401 Response or null if authorized
    const requireAdmin = (): Response | null => {
      if (!isAdminAuthorized(request, env)) {
        return Response.json(
          { error: 'Unauthorized. Provide admin API key via Authorization: Bearer <key> header.' },
          { status: 401, headers: corsHeaders }
        );
      }
      return null;
    };

    // Serve Swagger UI
    if (path === '/api-docs' && request.method === 'GET') {
      return new Response(swaggerHtml, {
        headers: { 'Content-Type': 'text/html' }
      });
    }

    // Serve OpenAPI JSON
    if (path === '/swagger.json' && request.method === 'GET') {
      return Response.json(openApiSpec, { headers: corsHeaders });
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      // Test endpoint
      if (path === '/test' && request.method === 'GET') {
        const rag = new RealEstateRAG(env);
        const result = await rag.query("apartments");

        return Response.json(result, { headers: corsHeaders });
      }

      // Search endpoint
      if (path === '/search' && request.method === 'POST') {
        let body: any;
        try { body = await request.json(); } catch {
          return Response.json({ error: 'Invalid JSON body' }, { status: 400, headers: corsHeaders });
        }
        const query = body?.query;
        if (!query || typeof query !== 'string' || query.trim().length === 0) {
          return Response.json({ error: 'Missing or empty "query" parameter.' }, { status: 400, headers: corsHeaders });
        }
        if (query.length > 500) {
          return Response.json({ error: 'Query too long. Maximum 500 characters.' }, { status: 400, headers: corsHeaders });
        }
        const { detectPromptInjection } = await import('./rag-engine');
        const injectionError = detectPromptInjection(query.trim());
        if (injectionError) {
          return Response.json({ error: injectionError }, { status: 400, headers: corsHeaders });
        }

        // Owner-scoped search: owner_id is required
        const ownerId = body?.owner_id ? parseInt(body.owner_id, 10) : null;
        if (!ownerId || isNaN(ownerId) || ownerId <= 0) {
          return Response.json({ error: 'Missing or invalid "owner_id". Provide a valid owner_id to search.' }, { status: 400, headers: corsHeaders });
        }
        const authHeader = request.headers.get('Authorization') || '';
        const apiKey = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
        if (!isAdminAuthorized(request, env)) {
          return Response.json({ error: 'Unauthorized. Provide API key via Authorization: Bearer <key> header.' }, { status: 401, headers: corsHeaders });
        }

        const allowed = await checkRateLimit(env, apiKey);
        if (!allowed) {
          const resetIn = 60 - Math.floor((Date.now() % 60000) / 1000);
          return Response.json(
            { error: `Rate limit exceeded. Maximum 20 requests per minute. Try again in ${resetIn}s.` },
            { status: 429, headers: { ...corsHeaders, 'Retry-After': String(resetIn), 'X-RateLimit-Limit': '20', 'X-RateLimit-Remaining': '0' } }
          );
        }

        const role = body?.role === 'seller' ? 'seller' as const : body?.role === 'buyer' ? 'buyer' as const : undefined;
        const rag = new RealEstateRAG(env);
        const limit = Math.min(Math.max(parseInt(body.limit, 10) || 20, 1), 100);
        const offset = Math.max(parseInt(body.offset, 10) || 0, 0);
        const result = await rag.query(query.trim(), { limit, offset, ownerId, role });

        return Response.json(result, { headers: { ...corsHeaders, 'X-RateLimit-Limit': '20' } });
      }

      // Status check (general)
      if (path === '/status' && request.method === 'GET') {
        try {
          const stats = await env.VECTORIZE.describe();
          return Response.json({
            status: 'ok',
            vectors: stats.vectorsCount,
            dimensions: (stats as any).dimensions
          }, { headers: corsHeaders });
        } catch (error: any) {
          return Response.json({
            error: error.message
          }, { status: 500, headers: corsHeaders });
        }
      }

      // Table row counts — admin only
      if (path === '/debug-counts' && request.method === 'GET') {
        const authErr = requireAdmin();
        if (authErr) return authErr;
        try {
          const tables = ['sellers', 'rental_owners', 'buyers', 'tenants', 'agents'];
          const counts: Record<string, number> = {};
          for (const t of tables) {
            try {
              const { results } = await queryAll(env, `SELECT COUNT(*) as n FROM ${t}`);
              counts[t] = (results[0] as any).n;
            } catch { counts[t] = -1; }
          }
          return Response.json(counts, { headers: corsHeaders });
        } catch (e: any) {
          return Response.json({ error: e.message }, { status: 500, headers: corsHeaders });
        }
      }

      // Precision@K / MRR evaluation endpoint
      if (path === '/api/eval' && request.method === 'GET') {
        const authErr = requireAdmin();
        if (authErr) return authErr;

        const K = parseInt(url.searchParams.get('k') || '5');
        const ownerId = parseInt(url.searchParams.get('owner_id') || '3');

        // Ground truth: query → expected property_type or listing_type
        const testCases = [
          { query: 'house for sale in pokhara',       expect_type: 'house', expect_intent: 'sale' },
          { query: 'land for sale in pokhara',        expect_type: 'land',  expect_intent: 'sale' },
          { query: 'flat for rent in lakeside',       expect_type: 'flat',  expect_intent: 'rent' },
          { query: 'house for rent in pokhara',       expect_type: 'house', expect_intent: 'rent' },
          { query: '3 bedroom house under 1 crore',   expect_type: 'house', expect_intent: null   },
          { query: 'land under 50 lakh in pokhara',   expect_type: 'land',  expect_intent: null   },
          { query: 'house near lakeside pokhara',     expect_type: 'house', expect_intent: null   },
          { query: 'land for sale near pokhara',      expect_type: 'land',  expect_intent: 'sale' },
          { query: 'shop for sale in pokhara',        expect_type: 'shop',  expect_intent: 'sale' },
          { query: 'flat for sale',                   expect_type: 'flat',  expect_intent: 'sale' },
        ];

        const rag = new RealEstateRAG(env);
        const results: any[] = [];
        let totalPrecision = 0;
        let totalMRR = 0;

        for (const tc of testCases) {
          const res = await rag.query(tc.query, { limit: K, ownerId });
          const props = res.properties || [];

          // Precision@K: fraction of top-K results with correct property type
          const relevant = props.filter((p: any) =>
            (p.property_type || '').toLowerCase() === tc.expect_type
          );
          const precisionAtK = props.length > 0 ? relevant.length / props.length : 0;

          // MRR: reciprocal rank of first relevant result
          const firstRelevantIdx = props.findIndex((p: any) =>
            (p.property_type || '').toLowerCase() === tc.expect_type
          );
          const rr = firstRelevantIdx >= 0 ? 1 / (firstRelevantIdx + 1) : 0;

          totalPrecision += precisionAtK;
          totalMRR += rr;

          results.push({
            query: tc.query,
            expected_type: tc.expect_type,
            total_results: res.total_results,
            top_k_results: props.length,
            relevant_in_top_k: relevant.length,
            precision_at_k: Math.round(precisionAtK * 100) / 100,
            reciprocal_rank: Math.round(rr * 100) / 100,
          });
        }

        const meanPrecision = Math.round((totalPrecision / testCases.length) * 100) / 100;
        const MRR = Math.round((totalMRR / testCases.length) * 100) / 100;

        return Response.json({
          k: K,
          mean_precision_at_k: meanPrecision,
          mrr: MRR,
          test_cases: results,
          summary: `Mean Precision@${K}: ${(meanPrecision * 100).toFixed(0)}% | MRR: ${MRR.toFixed(2)}`
        }, { headers: corsHeaders });
      }

      // Clear KV cache — deletes all "rag:*" (query cache), "ai:*" (AI answer cache), "role:*" (role decisions)
      if (path === '/cache/clear' && request.method === 'POST') {
        const authErr = requireAdmin();
        if (authErr) return authErr;
        try {
          let deleted = 0;
          for (const prefix of ['rag:', 'ai:', 'role:']) {
            let cursor: string | undefined;
            do {
              const page = await env.SORHAAANA_CACHE.list({ prefix, cursor });
              await Promise.all(page.keys.map(k => env.SORHAAANA_CACHE.delete(k.name)));
              deleted += page.keys.length;
              cursor = page.list_complete ? undefined : (page as any).cursor;
            } while (cursor);
          }
          return Response.json({ deleted, message: `Cleared ${deleted} cache entries.` }, { headers: corsHeaders });
        } catch (e: any) {
          return Response.json({ error: e.message }, { status: 500, headers: corsHeaders });
        }
      }

      // One-time migration: add vectorization tracking columns to buyers, tenants, agents
      if (path === '/api/migrate/add-tracking-columns' && request.method === 'POST') {
        const authErr = requireAdmin();
        if (authErr) return authErr;

        const tables = ['buyers', 'tenants', 'agents'];
        const columns = [
          { name: 'is_vectorized_complete', def: 'TINYINT(1) DEFAULT NULL' },
          { name: 'last_vectorized_at',     def: 'DATETIME DEFAULT NULL' },
          { name: 'vectorization_error_message', def: 'VARCHAR(255) DEFAULT NULL' },
        ];

        const results: Record<string, string[]> = {};
        for (const table of tables) {
          results[table] = [];
          for (const col of columns) {
            try {
              await queryExecute(env,
                `ALTER TABLE ${table} ADD COLUMN ${col.name} ${col.def}`
              );
              results[table].push(`${col.name}: added`);
            } catch (e: any) {
              // "Duplicate column name" means it already exists — that's fine
              if (e.message?.includes('Duplicate column')) {
                results[table].push(`${col.name}: already exists`);
              } else {
                results[table].push(`${col.name}: ERROR — ${e.message}`);
              }
            }
          }
        }

        return Response.json({ results, message: 'Migration complete. Run /api/vectorize/full to vectorize all records.' }, { headers: corsHeaders });
      }

      // Vectorize admin endpoints
      if (path === '/api/vectorize' && request.method === 'POST') {
        const authErr = requireAdmin();
        if (authErr) return authErr;
        // Run in background to avoid timeout
        ctx.waitUntil(vectorizeProperties(env));
        return Response.json({
          message: "Vectorization started in background. Check status endpoint for progress.",
          status: "started"
        }, { headers: corsHeaders });
      }

      // Enhanced vectorization status with database tracking
      if (path === '/api/vectorize/status' && request.method === 'GET') {
        try {
          const [vectorStats, dbStats] = await Promise.all([
            env.VECTORIZE.describe().catch(() => null),
            getVectorizationStatus(env).catch(() => null)
          ]);

          return Response.json({
            vector_index: vectorStats ? {
              vectors_count: vectorStats.vectorsCount,
              dimensions: (vectorStats as any).dimensions
            } : null,
            database_tracking: dbStats || null,
            timestamp: new Date().toISOString()
          }, { headers: corsHeaders });
        } catch (error: any) {
          return Response.json(
            { error: error.message },
            { status: 500, headers: corsHeaders }
          );
        }
      }

      // Full vectorization statistics
      if (path === '/api/vectorization-stats' && request.method === 'GET') {
        try {
          const dbStats = await getVectorizationStatus(env);
          const queueStats = await getQueueStatus(env);

          return Response.json({
            database_vectorization: dbStats,
            processing_queue: queueStats,
            summary: {
              vectorization_coverage: dbStats.total_properties > 0
                ? ((dbStats.vectorized / dbStats.total_properties) * 100).toFixed(2) + '%'
                : '0%',
              pending_vectorization: dbStats.pending,
              queue_backlog: queueStats.pending,
              failed_count: dbStats.failed + queueStats.failed
            },
            timestamp: new Date().toISOString()
          }, { headers: corsHeaders });
        } catch (error: any) {
          return Response.json(
            { error: error.message },
            { status: 500, headers: corsHeaders }
          );
        }
      }

      // Process vectorization queue (manual trigger)
      if (path === '/api/vectorize/queue/process' && request.method === 'POST') {
        const authErr = requireAdmin();
        if (authErr) return authErr;
        let body: any = {};
        try { body = await request.json(); } catch { /* empty body is ok */ }
        const maxJobs = Math.min(Math.max(1, parseInt(body?.max_jobs, 10) || 50), 200);

        ctx.waitUntil(processVectorizationQueue(env, maxJobs));
        return Response.json({
          message: "Queue processing started in background.",
          status: "started",
          max_jobs: maxJobs
        }, { headers: corsHeaders });
      }

      // Get vectorization queue status
      if (path === '/api/vectorize/queue/status' && request.method === 'GET') {
        try {
          const queueStats = await getQueueStatus(env);
          return Response.json({
            queue: queueStats,
            timestamp: new Date().toISOString()
          }, { headers: corsHeaders });
        } catch (error: any) {
          return Response.json(
            { error: error.message },
            { status: 500, headers: corsHeaders }
          );
        }
      }

      // Full vectorization with optional mode selection
      if (path === '/api/vectorize/full' && request.method === 'POST') {
        const authErr = requireAdmin();
        if (authErr) return authErr;
        let body: any = {};
        try { body = await request.json(); } catch { /* empty body is ok */ }
        const mode = ['incremental', 'full'].includes(body?.mode) ? body.mode : 'incremental';

        ctx.waitUntil(vectorizeProperties(env, mode === 'incremental'));
        return Response.json({
          message: `Full ${mode} vectorization started in background.`,
          status: "started",
          mode: mode
        }, { headers: corsHeaders });
      }




      // Update coordinates for specific properties (fixes lat=0 failures)
      if (path === '/api/geocode/update' && request.method === 'POST') {
        const authErr = requireAdmin();
        if (authErr) return authErr;
        try {
          const body = await request.json() as any;
          const updates = body.updates as Array<{ table: string; id: number; lat: number; lng: number }>;

          if (!Array.isArray(updates) || updates.length === 0) {
            return Response.json({ error: 'Send { "updates": [{ "table": "sellers"|"rental_owners", "id": 123, "lat": 28.2, "lng": 83.9 }] }' },
              { status: 400, headers: corsHeaders });
          }

          let updated = 0;
          const errors: string[] = [];
          for (const u of updates) {
            if (!['sellers', 'rental_owners'].includes(u.table)) {
              errors.push(`Invalid table: ${u.table}`);
              continue;
            }
            try {
              await queryExecute(env,
                `UPDATE ${u.table} SET latitude = ?, longitude = ? WHERE id = ?`,
                [u.lat, u.lng, u.id]);
              updated++;
            } catch (err: any) {
              errors.push(`${u.table}#${u.id}: ${err.message}`);
            }
          }

          return Response.json({ updated, errors, total: updates.length }, { headers: corsHeaders });
        } catch (error: any) {
          return Response.json({ error: error.message }, { status: 500, headers: corsHeaders });
        }
      }

      // Batch geocoding endpoints
      if (path === '/api/geocode/batch' && request.method === 'POST') {
        const authErr = requireAdmin();
        if (authErr) return authErr;
        try {
          const body = await request.json() as any;
          const batchSize = Math.min(Math.max(parseInt(body.batch_size, 10) || 20, 1), 25); // Max 25 per call (Nominatim rate limit)

          const result = await batchGeocode(env, batchSize);
          return Response.json(result, { headers: corsHeaders });
        } catch (error: any) {
          return Response.json(
            { error: error.message },
            { status: 500, headers: corsHeaders }
          );
        }
      }

      if (path === '/api/geocode/status' && request.method === 'GET') {
        try {
          const status = await getGeocodeStatus(env);
          return Response.json({
            ...status,
            total_pending: status.sellers.pending + status.rentals.pending,
            total_geocoded: status.sellers.geocoded + status.rentals.geocoded,
            timestamp: new Date().toISOString()
          }, { headers: corsHeaders });
        } catch (error: any) {
          return Response.json(
            { error: error.message },
            { status: 500, headers: corsHeaders }
          );
        }
      }

      // Database schema inspection endpoints
      if (path === '/api/db-schema' && request.method === 'GET') {
        try {
          const schema = await getDatabaseSchema(env);
          const format = url.searchParams.get('format') || 'json'; // json or text

          if (format === 'text') {
            const textSchema = formatSchemaForConsole(schema);
            return new Response(textSchema, {
              headers: { 'Content-Type': 'text/plain' }
            });
          } else {
            return Response.json(schema, { headers: corsHeaders });
          }
        } catch (error: any) {
          return Response.json(
            { error: `Failed to fetch database schema: ${error.message}` },
            { status: 500, headers: corsHeaders }
          );
        }
      }

      // Database query endpoint - read-only SQL queries
      if (path === '/api/query' && request.method === 'POST') {
        const authErr = requireAdmin();
        if (authErr) return authErr;
        try {
          const body = await request.json() as any;
          const { sql } = body;

          if (!sql || typeof sql !== 'string') {
            return Response.json(
              { error: 'Missing or invalid "sql" parameter. Send JSON: {"sql": "SELECT * FROM table"}' },
              { status: 400, headers: corsHeaders }
            );
          }

          // Only allow read-only statements — strip comments, semicolons, and whitespace first
          const sanitized = sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--.*$/gm, '').trim().toUpperCase();
          const allowed = ['SELECT', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN'];
          if (!allowed.some(kw => sanitized.startsWith(kw))) {
            return Response.json(
              { error: 'Only SELECT, SHOW, DESCRIBE, and EXPLAIN queries are permitted.' },
              { status: 403, headers: corsHeaders }
            );
          }
          // Block multiple statements (semicolons)
          if (sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--.*$/gm, '').replace(/;[\s]*$/, '').includes(';')) {
            return Response.json(
              { error: 'Multiple statements are not allowed.' },
              { status: 403, headers: corsHeaders }
            );
          }

          const { results } = await queryAll(env, sql);

          return Response.json({
            success: true,
            rows: results.length,
            data: results
          }, { headers: corsHeaders });

        } catch (error: any) {
          return Response.json(
            { error: 'Query failed. Check your SQL syntax.' },
            { status: 500, headers: corsHeaders }
          );
        }
      }

      // REST API Delegate (read-only, auth needed only for owner_id filtering)
      if (path.startsWith('/api/properties')) {
        const api = new RealEstateAPI(env, corsHeaders, isAdminAuthorized(request, env));
        return api.handleRequest(request);
      }

      const endpoints = [
        'POST /api/vectorize - Start incremental vectorization',
        'POST /api/vectorize/full - Start full or incremental vectorization (body: {"mode": "incremental|full"})',
        'GET /api/vectorize/status - Get detailed vectorization status',
        'GET /api/vectorization-stats - Get full statistics',
        'POST /api/vectorize/queue/process - Process vectorization queue',
        'GET /api/vectorize/queue/status - Get queue status',
        'POST /api/geocode/batch - Batch geocode properties (body: {"batch_size": 20})',
        'POST /api/geocode/update - Update coordinates (body: {"updates": [{"table","id","lat","lng"}]})',
        'GET /api/geocode/status - Get geocoding progress',
        'GET /api/db-schema - Get database schema',
        'POST /api/query - Run SQL query',
        'GET /api/properties - List properties',
        'POST /search - Search (RAG)',
        'GET /test - Test endpoint'
      ];

      return new Response('Available endpoints:\n' + endpoints.map(e => '  ' + e).join('\n'), { status: 404 });

    } catch (error: any) {
      console.error('Unhandled error:', error);
      return Response.json({
        error: 'Internal server error. Please try again later.'
      }, { status: 500, headers: getCorsHeaders(request, env) });
    }
  }
};
