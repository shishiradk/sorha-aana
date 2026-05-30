// src/geocoding.ts
// Geocoding utilities using Nominatim (OpenStreetMap) — free, no API key
// Scoped to Kaski district, Nepal (viewbox-bounded)

// Kaski district bounding box
const KASKI_VIEWBOX = '83.70,28.61,84.28,28.08';

function sleepMs(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function tryNominatim(query: string, params: string): Promise<{ lat: number; lng: number } | null> {
  const url = `https://nominatim.openstreetmap.org/search?` +
    `q=${encodeURIComponent(query)}&format=json&limit=1${params}`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'sorha-aana-worker/1.0' },
      signal: AbortSignal.timeout(10000),
    });
    if (res.status === 429) {
      console.warn('Nominatim rate limited (429) — backing off 3s');
      await sleepMs(3000);
      return null;
    }
    if (!res.ok) return null;
    const data = await res.json() as any[];
    if (!data || data.length === 0) return null;
    const lat = parseFloat(data[0].lat);
    const lng = parseFloat(data[0].lon);
    if (isNaN(lat) || isNaN(lng)) return null;
    return { lat, lng };
  } catch (err: any) {
    console.warn('Nominatim fetch error:', err.message);
    return null;
  }
}

/**
 * Geocode a location string using Nominatim (OpenStreetMap)
 *
 * appendContext: text appended to the query for disambiguation.
 *   - Default "Kaski Nepal" — for runtime RAG search (short location names like "Malepatan")
 *   - Pass "Nepal" for batch geocoding where the address already contains the district name
 *
 * Tries 3 tiers of increasing leniency:
 *   1. Strict Kaski viewbox (bounded=1) — only used when context is "Kaski Nepal"
 *   2. Kaski viewbox as preference hint (bounded=0) — only for Kaski context
 *   3. Nepal-wide search
 */
export async function geocodeLocation(
  locationText: string,
  appendContext: string = 'Kaski Nepal'
): Promise<{ lat: number; lng: number } | null> {
  const query = `${locationText} ${appendContext}`;
  const isKaskiContext = appendContext.toLowerCase().includes('kaski');

  if (isKaskiContext) {
    // Tier 1: strict Kaski bounding box
    const r1 = await tryNominatim(query, `&viewbox=${KASKI_VIEWBOX}&bounded=1`);
    if (r1) return r1;

    await sleepMs(1100);

    // Tier 2: Kaski viewbox as preference (not strict)
    const r2 = await tryNominatim(query, `&viewbox=${KASKI_VIEWBOX}&bounded=0`);
    if (r2) return r2;

    await sleepMs(1100);
  }

  // Tier 3 (or Tier 1 for non-Kaski): Nepal-wide
  return tryNominatim(query, `&countrycodes=np`);
}

/**
 * Extract a location phrase from a user query
 * Detects patterns like "near X", "around X", "X ma", "X tira"
 * Returns the location name to geocode, or null if no location intent
 */
export function extractLocationFromQuery(query: string): string | null {
  const stopWords = /\b(?:with|under|below|above|over|more|less|upto|up\s+to|within|budget|price|cost|rent|sale|buy|sell|house|land|flat|room|apartment|property|properties|bedroom|bhk|ropani|aana|sqft|sq|storey|floor|facing|furnished|road|commercial|residential|agriculture|buyers?|tenants?|sellers?|leads?|clients?|\d)/i;
  // Filler words to strip from extracted location phrases
  const fillerWords = new Set(['the', 'a', 'an', 'this', 'that', 'area', 'region', 'place', 'zone', 'side', 'part', 'some', 'any', 'all', 'list', 'show', 'me', 'find', 'get', 'who', 'for']);

  const cleanLocation = (loc: string): string | null => {
    // Strip trailing stop words (e.g., "kaukhola over" → "kaukhola")
    const words = loc.split(/\s+/);
    const cleaned: string[] = [];
    for (const w of words) {
      if (fillerWords.has(w.toLowerCase())) continue;
      if (stopWords.test(w)) break; // stop at filter/price keywords
      cleaned.push(w);
    }
    const result = cleaned.join(' ').trim();
    return result.length >= 2 ? result : null;
  };

  // "near X", "around X", "close to X"
  const nearMatch = query.match(/(?:near|around|close\s+to|nearby)\s+(.+?)(?:\s+(?:with|under|below|above|over|more|less|budget|for|price|rent|sale|house|land|flat|room|apartment|property|bedroom|\d))/i);
  if (nearMatch) return cleanLocation(nearMatch[1]);

  // "near X" at end of query
  const nearEnd = query.match(/(?:near|around|close\s+to|nearby)\s+(.+)$/i);
  if (nearEnd) return cleanLocation(nearEnd[1]);

  // "in X" / "at X" / "of X" — e.g. "house in chauthe", "property at malepatan", "properties of kaudhada"
  const inMatch = query.match(/\b(?:in|at|of)\s+([a-zA-Z][a-zA-Z\-]{2,}(?:\s+[a-zA-Z][a-zA-Z\-]+){0,3})(?:\s|$)/i);
  if (inMatch) {
    const loc = cleanLocation(inMatch[1]);
    if (loc) return loc;
  }

  return null;
}

/**
 * Haversine distance in km between two lat/lng points
 */
export function haversineKm(
  lat1: number, lng1: number,
  lat2: number, lng2: number
): number {
  const R = 6371; // Earth radius in km
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function toRad(deg: number): number {
  return deg * (Math.PI / 180);
}

/**
 * SQL fragment for haversine distance calculation in MySQL
 * Returns distance in km between a point and the given lat/lng
 * Usage: WHERE ${haversineSQL('latitude', 'longitude')} < 5
 */
export function haversineSQL(latCol: string, lngCol: string): string {
  return `(
    6371 * acos(
      LEAST(1.0, cos(radians(?)) * cos(radians(${latCol})) *
      cos(radians(${lngCol}) - radians(?)) +
      sin(radians(?)) * sin(radians(${latCol})))
    )
  )`;
}
