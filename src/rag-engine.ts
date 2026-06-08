// src/rag-engine.ts
// RAG engine: vector search -> DB fetch -> AI answer generation
// Works with actual tables: sellers + rental_owners with location JOINs
// Supports proximity search via Nominatim geocoding + haversine distance
import { queryAll } from './db-utils';
import { formatPrice, priceToNPR } from './vectorize';
import { geocodeLocation, extractLocationFromQuery, haversineSQL } from './geocoding';

export interface Env {
  HYPERDRIVE: any;
  VECTORIZE: VectorizeIndex;
  AI: any;
  SORHAAANA_CACHE: KVNamespace;
  CACHE_VERSION?: string;
  // Scoring weights (0-1, configurable via wrangler.json vars)
  W_SIMILARITY?: string;   // vector similarity weight
  W_PROXIMITY?: string;    // location proximity weight
  W_TYPE?: string;         // property type match weight
  W_PRICE?: string;        // price fit weight
  W_RERANK?: string;       // keyword rerank boost weight
}

export class RealEstateRAG {
  constructor(private env: Env) {}

  /** Local geocoding: find avg lat/lng from our own property data using LIKE → SOUNDEX+prefix */
  async localGeocode(locationPhrase: string): Promise<{ lat: number; lng: number } | null> {
    try {
      const words = locationPhrase.split(/\s+/).filter(w => w.length >= 3);
      if (words.length === 0) return null;

      // Strategy 1: LIKE match (exact substring)
      // Strategy 2: SOUNDEX + prefix filter (fuzzy but constrained — avoids matching unrelated names)
      for (const strategy of ['like', 'soundex_prefix'] as const) {
        for (const table of [
          { name: 'sellers', col: 'property_address' },
          { name: 'rental_owners', col: 'address' }
        ]) {
          let where: string;
          let params: any[];

          if (strategy === 'like') {
            where = words.map(() => `LOWER(${table.col}) LIKE LOWER(?)`).join(' AND ');
            params = words.map(w => `%${w}%`);
          } else {
            // SOUNDEX for phonetic match + prefix variants to prevent false positives
            // Handles aspiration ambiguity: "khaukhola" matches "Kaukhola" (kha↔kau)
            const wordClauses: string[] = [];
            params = [];
            for (const w of words) {
              const variants = prefixVariants(w);
              const prefixOr = variants.map(() => `LOWER(${table.col}) LIKE LOWER(?)`).join(' OR ');
              wordClauses.push(`(SOUNDEX(${table.col}) LIKE CONCAT('%', SOUNDEX(?), '%') AND (${prefixOr}))`);
              params.push(w, ...variants);
            }
            where = wordClauses.join(' AND ');
          }

          const { results } = await queryAll(this.env,
            `SELECT AVG(latitude) as lat, AVG(longitude) as lng, COUNT(*) as cnt
             FROM ${table.name}
             WHERE latitude IS NOT NULL AND latitude > 0
             AND (${where})`,
            params
          );

          const row = results[0] as any;
          if (row && row.cnt > 0 && row.lat && row.lng) {
            console.log(`Local geocode (${strategy}, ${table.name}): "${locationPhrase}" → ${row.cnt} properties, center ${row.lat}, ${row.lng}`);
            return { lat: parseFloat(row.lat), lng: parseFloat(row.lng) };
          }
        }
      }
      return null;
    } catch (err: any) {
      console.warn('Local geocode failed:', err.message);
      return null;
    }
  }

  async generateQueryEmbedding(query: string): Promise<number[] | null> {
    try {
      const response = await this.env.AI.run('@cf/baai/bge-large-en-v1.5', {
        text: query
      });
      return response.data?.[0] || null;
    } catch {
      console.warn('Embedding generation failed — falling back to text-only search');
      return null;
    }
  }

  async searchProperties(query: string, intent?: 'sale' | 'rent' | null, parsed?: ParsedIntent, ownerId?: number | null, role?: 'buyer' | 'seller'): Promise<{ results: any[]; locationPhrase: string | null; geocodeFailed: boolean; outsideCoverage: boolean; filteredOut: boolean }> {
    console.log(`Searching: "${query}" [intent: ${intent || 'any'}] [owner: ${ownerId || 'all'}] [role: ${role || 'any'}]`);

    // Owner filter helper — appends AND owner_id = N when scoped
    const ownerFilter = (alias: string) => ownerId ? ` AND ${alias}.owner_id = ${ownerId}` : '';

    // Detect location intent and geocode
    const locationPhrase = extractLocationFromQuery(query);
    let searchCoords: { lat: number; lng: number } | null = null;
    let geocodeFailed = false;
    let outsideCoverage = false;
    // Seller role searches buyers/tenants who have no lat/lng — skip all geocoding
    if (locationPhrase && role !== 'seller') {
      console.log(`Location detected: "${locationPhrase}" — geocoding...`);

      // Tier 0: Local geocoding — use average coords from our own DB data
      searchCoords = await this.localGeocode(locationPhrase);
      if (searchCoords) {
        console.log(`Local geocoded to: ${searchCoords.lat}, ${searchCoords.lng}`);
      } else {
        // Tier 1-3: Fall back to Nominatim
        searchCoords = await geocodeLocation(locationPhrase);
        if (searchCoords) {
          // Check if any property in our DB is within 50km of this location
          const distExpr = haversineSQL('latitude', 'longitude');
          try {
            const { results: nearest } = await queryAll(this.env,
              `SELECT MIN(${distExpr}) as min_dist FROM sellers s WHERE s.latitude IS NOT NULL AND s.latitude != 0${ownerFilter('s')}`,
              [searchCoords.lat, searchCoords.lng, searchCoords.lat]);
            const minDist = nearest?.[0]?.min_dist;
            if (minDist != null && minDist > 50) {
              console.log(`Location "${locationPhrase}" is ${minDist.toFixed(0)}km from nearest property — outside coverage`);
              outsideCoverage = true;
              searchCoords = null;
            } else {
              console.log(`Nominatim geocoded to: ${searchCoords.lat}, ${searchCoords.lng} (nearest property: ${minDist?.toFixed(1)}km)`);
            }
          } catch (e) {
            console.log(`Nominatim geocoded to: ${searchCoords!.lat}, ${searchCoords!.lng}`);
          }
        } else {
          console.log('Geocoding failed — falling back to text-only search');
          geocodeFailed = true;
        }
      }
    }

    // If location is outside our coverage area, short-circuit
    if (outsideCoverage) {
      return { results: [], locationPhrase, geocodeFailed, outsideCoverage, filteredOut: false };
    }

    // If we have coordinates, also get nearby property IDs from DB
    let nearbySellerIds: number[] = [];
    let nearbyRentalIds: number[] = [];
    const nearbyDistances = new Map<string, number>(); // key -> distance in km

    if (searchCoords && role !== 'seller') {
      const radiusKm = 5; // 5km radius
      const { lat, lng } = searchCoords;
      const distExpr = haversineSQL('latitude', 'longitude');

      // Query nearby sellers
      if (intent !== 'rent') {
        try {
          const { results: nearby } = await queryAll(this.env,
            `SELECT s.id, ${distExpr} as distance_km
             FROM sellers s
             WHERE s.latitude IS NOT NULL AND s.longitude IS NOT NULL
             AND ${distExpr} < ?${ownerFilter('s')}
             ORDER BY distance_km ASC
             LIMIT 20`,
            [lat, lng, lat, lat, lng, lat, radiusKm]
          );
          nearbySellerIds = nearby.map((r: any) => r.id);
          nearby.forEach((r: any) => nearbyDistances.set(`sellers_${r.id}`, r.distance_km));
          console.log(`Found ${nearbySellerIds.length} sellers within ${radiusKm}km`);
        } catch (err: any) {
          console.warn('Nearby seller query failed:', err.message);
        }
      }

      // Query nearby rentals
      if (intent !== 'sale') {
        try {
          const { results: nearby } = await queryAll(this.env,
            `SELECT ro.id, ${distExpr} as distance_km
             FROM rental_owners ro
             WHERE ro.latitude IS NOT NULL AND ro.longitude IS NOT NULL
             AND ${distExpr} < ?${ownerFilter('ro')}
             ORDER BY distance_km ASC
             LIMIT 20`,
            [lat, lng, lat, lat, lng, lat, radiusKm]
          );
          nearbyRentalIds = nearby.map((r: any) => r.id);
          nearby.forEach((r: any) => nearbyDistances.set(`rental_owners_${r.id}`, r.distance_km));
          console.log(`Found ${nearbyRentalIds.length} rentals within ${radiusKm}km`);
        } catch (err: any) {
          console.warn('Nearby rental query failed:', err.message);
        }
      }
    }

    const wantsAgent = /\bagent\b/i.test(query);

    // Translate Nepali script queries to English before embedding
    // bge-large-en-v1.5 is English-dominant; Nepali Devanagari gets poor embeddings
    let embeddingQuery = containsNepaliScript(query)
      ? await translateToEnglish(query, this.env.AI)
      : query;

    // For seller role, prepend buyer/tenant context so vector search finds demand-side records
    if (role === 'seller') embeddingQuery = `buyer tenant looking to buy rent ${embeddingQuery}`;

    const queryEmbedding = await this.generateQueryEmbedding(embeddingQuery);

    // Use higher topK for seller role — buyers/tenants are ~15% of vectors, need wider net
    // Max topK with returnMetadata='all' is 50
    const topK = role === 'seller' ? 50 : 30;
    let vectorResults: { matches: any[] } = { matches: [] };
    if (queryEmbedding) {
      try {
        vectorResults = await this.env.VECTORIZE.query(queryEmbedding, { topK, returnMetadata: 'all' });
      } catch (err: any) {
        console.warn('Vectorize query failed, falling back to text/SQL search:', err.message);
      }
    }

    console.log(`Vector search returned ${vectorResults.matches.length} matches`);

    // Group matches by source table and ID (deduplicate main + keyword chunks)
    const sellerIds = new Set<number>();
    const rentalIds = new Set<number>();
    const buyerIds = new Set<number>();
    const tenantIds = new Set<number>();
    const agentIds = new Set<number>();
    const scoreMap = new Map<string, number>();

    // Store vector scores but DON'T add to ID lists yet if location search is active
    // — vector-only results from unrelated locations will be filtered out
    for (const match of vectorResults.matches) {
      const meta = match.metadata || {} as any;
      const table = meta.source_table || 'sellers';
      const id = meta.source_id;
      if (!id) continue;

      if (role === 'buyer') {
        // Buyer: only property listings — skip demand-side tables
        if (table === 'buyers' || table === 'tenants') continue;
        if (intent === 'rent' && table !== 'rental_owners') continue;
        if (intent === 'sale' && table !== 'sellers') continue;
      } else if (role === 'seller') {
        // Seller: only demand-side tables — skip property listings
        if (table === 'sellers' || table === 'rental_owners') continue;
        if (intent === 'sale' && table === 'tenants') continue;   // sale intent → buyers only
        if (intent === 'rent' && table === 'buyers') continue;    // rent intent → tenants only
      } else {
        // No role specified: existing behaviour
        if (intent === 'rent' && table !== 'rental_owners') continue;
        if (intent === 'sale' && table !== 'sellers') continue;
      }
      if (table === 'agents' && !wantsAgent) continue;

      const key = `${table}_${id}`;
      const existing = scoreMap.get(key) || 0;
      if (match.score > existing) scoreMap.set(key, match.score);

      // When location is specified, don't add sellers/rentals from vector search alone
      // They'll be added by text search + proximity below; vector scores are still recorded in scoreMap
      if (locationPhrase && (table === 'sellers' || table === 'rental_owners')) {
        // But if this ID is already in the proximity set, keep it (vector + location overlap)
        const isNearby = (table === 'sellers' && nearbySellerIds.includes(id)) ||
                         (table === 'rental_owners' && nearbyRentalIds.includes(id));
        if (!isNearby) continue;
      }

      if (table === 'sellers') sellerIds.add(id);
      if (table === 'rental_owners') rentalIds.add(id);
      if (table === 'buyers') buyerIds.add(id);
      if (table === 'tenants') tenantIds.add(id);
      if (table === 'agents') agentIds.add(id);
    }


    // Step 1: Text-based location search (LIKE + SOUNDEX)
    // For multi-word phrases: each word must match (AND logic) to avoid false positives
    // For single-word: use OR with SOUNDEX for typo tolerance
    let textMatchCount = 0;
    const textMatchedIds = new Set<string>(); // Track IDs found by name match (guaranteed in that location)
    if (locationPhrase) {
      const likeKw = `%${locationPhrase}%`;
      const fillerWords = new Set(['the', 'a', 'an', 'this', 'that', 'area', 'region', 'place', 'zone', 'side', 'part', 'some', 'any', 'all', 'list', 'show', 'find', 'get']);
      const locationWords = locationPhrase.split(/\s+/).filter(w => w.length >= 3 && !fillerWords.has(w.toLowerCase()));

      // Build fuzzy match conditions per address column
      // SOUNDEX is always paired with a prefix filter (first 3 chars) to prevent false positives
      const buildFuzzySQL = (addrCol: string): { sql: string; params: any[] } => {
        if (locationWords.length > 1) {
          // Multi-word: ALL words must appear in address (via LIKE or SOUNDEX+prefix per word)
          const wordConditions = locationWords.map(w => {
            const variants = prefixVariants(w);
            const prefixOr = variants.map(() => `LOWER(${addrCol}) LIKE LOWER(?)`).join(' OR ');
            return `(LOWER(${addrCol}) LIKE LOWER(?) OR (SOUNDEX(${addrCol}) LIKE CONCAT('%', SOUNDEX(?), '%') AND (${prefixOr})))`;
          }).join(' AND ');
          const wordParams = locationWords.flatMap(w => [`%${w}%`, w, ...prefixVariants(w)]);
          return {
            sql: `WHERE (LOWER(${addrCol}) LIKE LOWER(?) OR LOWER(city) LIKE LOWER(?) OR (${wordConditions}))`,
            params: [likeKw, likeKw, ...wordParams]
          };
        } else {
          // Single word: SOUNDEX + prefix variants to handle aspiration ambiguity
          const variants = prefixVariants(locationPhrase);
          const addrPrefixOr = variants.map(() => `LOWER(${addrCol}) LIKE LOWER(?)`).join(' OR ');
          const cityPrefixOr = variants.map(() => `LOWER(city) LIKE LOWER(?)`).join(' OR ');
          return {
            sql: `WHERE (LOWER(${addrCol}) LIKE LOWER(?) OR LOWER(city) LIKE LOWER(?) OR (SOUNDEX(${addrCol}) = SOUNDEX(?) AND (${addrPrefixOr})) OR (SOUNDEX(city) = SOUNDEX(?) AND (${cityPrefixOr})))`,
            params: [likeKw, likeKw, locationPhrase, ...variants, locationPhrase, ...variants]
          };
        }
      };

      if (role !== 'seller') {
        // Buyer role: text-search property listings by address
        if (intent !== 'rent') {
          try {
            const fuzzy = buildFuzzySQL('property_address');
            const { results: textRows } = await queryAll(this.env,
              `SELECT s.id FROM sellers s ${fuzzy.sql}${ownerFilter('s')} LIMIT 20`,
              fuzzy.params
            );
            for (const r of textRows as any[]) {
              sellerIds.add(r.id);
              const key = `sellers_${r.id}`;
              if (!scoreMap.has(key)) scoreMap.set(key, 0.75);
              textMatchedIds.add(key);
            }
            textMatchCount += (textRows as any[]).length;
            console.log(`Text search: ${(textRows as any[]).length} sellers for "${locationPhrase}"`);
          } catch (err: any) {
            console.warn('Text seller search failed:', err.message);
          }
        }
        if (intent !== 'sale') {
          try {
            const fuzzy = buildFuzzySQL('address');
            const { results: textRows } = await queryAll(this.env,
              `SELECT ro.id FROM rental_owners ro ${fuzzy.sql}${ownerFilter('ro')} LIMIT 20`,
              fuzzy.params
            );
            for (const r of textRows as any[]) {
              rentalIds.add(r.id);
              const key = `rental_owners_${r.id}`;
              if (!scoreMap.has(key)) scoreMap.set(key, 0.75);
              textMatchedIds.add(key);
            }
            textMatchCount += (textRows as any[]).length;
            console.log(`Text search: ${(textRows as any[]).length} rentals for "${locationPhrase}"`);
          } catch (err: any) {
            console.warn('Text rental search failed:', err.message);
          }
        }
      } else {
        // Seller role: text-search demand-side tables by seeking_address.
        // No ownerFilter — buyers/tenants may not have owner_id column or may be shared across agencies.
        if (intent !== 'rent') {
          try {
            const { results: textRows } = await queryAll(this.env,
              `SELECT b.id FROM buyers b WHERE LOWER(b.seeking_address) LIKE LOWER(?) LIMIT 20`,
              [likeKw]
            );
            for (const r of textRows as any[]) {
              buyerIds.add(r.id);
              const key = `buyers_${r.id}`;
              if (!scoreMap.has(key)) scoreMap.set(key, 0.75);
              textMatchedIds.add(key);
            }
            textMatchCount += (textRows as any[]).length;
            console.log(`Text search: ${(textRows as any[]).length} buyers for "${locationPhrase}"`);
          } catch (err: any) {
            console.warn('Text buyer search failed:', err.message);
          }
        }
        if (intent !== 'sale') {
          try {
            const { results: textRows } = await queryAll(this.env,
              `SELECT t.id FROM tenants t WHERE LOWER(t.seeking_address) LIKE LOWER(?) LIMIT 20`,
              [likeKw]
            );
            for (const r of textRows as any[]) {
              tenantIds.add(r.id);
              const key = `tenants_${r.id}`;
              if (!scoreMap.has(key)) scoreMap.set(key, 0.75);
              textMatchedIds.add(key);
            }
            textMatchCount += (textRows as any[]).length;
            console.log(`Text search: ${(textRows as any[]).length} tenants for "${locationPhrase}"`);
          } catch (err: any) {
            console.warn('Text tenant search failed:', err.message);
          }
        }
      }
    }

    // Step 2 (seller role): SQL-primary fallback for buyers/tenants.
    // Buyers/tenants may not be in Vectorize (no tracking column → cron re-vectorizes all, may time out).
    // Direct SQL search by property_type + general fallback ensures seller role always returns results.
    if (role === 'seller') {
      const propTypeKw = extractPropertyType(query);

      if (intent !== 'rent' && buyerIds.size < 15) {
        try {
          const sql = propTypeKw
            ? `SELECT b.id FROM buyers b WHERE LOWER(b.property_type) LIKE LOWER(?) ORDER BY b.id DESC LIMIT 15`
            : `SELECT b.id FROM buyers b ORDER BY b.id DESC LIMIT 15`;
          const params = propTypeKw ? [`%${propTypeKw}%`] : [];
          const { results: bRows } = await queryAll(this.env, sql, params);
          for (const r of bRows as any[]) {
            buyerIds.add(r.id);
            if (!scoreMap.has(`buyers_${r.id}`)) scoreMap.set(`buyers_${r.id}`, 0.5);
          }
          console.log(`Seller SQL fallback: ${(bRows as any[]).length} buyers (propType: ${propTypeKw || 'any'})`);
        } catch (err: any) {
          console.warn('Seller buyer SQL fallback failed:', err.message);
        }
      }

      if (intent !== 'sale' && tenantIds.size < 15) {
        try {
          const sql = propTypeKw
            ? `SELECT t.id FROM tenants t WHERE LOWER(t.property_type) LIKE LOWER(?) ORDER BY t.id DESC LIMIT 15`
            : `SELECT t.id FROM tenants t ORDER BY t.id DESC LIMIT 15`;
          const params = propTypeKw ? [`%${propTypeKw}%`] : [];
          const { results: tRows } = await queryAll(this.env, sql, params);
          for (const r of tRows as any[]) {
            tenantIds.add(r.id);
            if (!scoreMap.has(`tenants_${r.id}`)) scoreMap.set(`tenants_${r.id}`, 0.5);
          }
          console.log(`Seller SQL fallback: ${(tRows as any[]).length} tenants (propType: ${propTypeKw || 'any'})`);
        } catch (err: any) {
          console.warn('Seller tenant SQL fallback failed:', err.message);
        }
      }
    }

    // Step 3: Geocoding fallback — only for buyer role (seller role skips geocoding entirely)
    if (locationPhrase && textMatchCount < 3 && searchCoords) {
      console.log(`Text matched only ${textMatchCount} — expanding with geocoding radius`);
      for (const id of nearbySellerIds) {
        sellerIds.add(id);
        const key = `sellers_${id}`;
        if (!scoreMap.has(key)) scoreMap.set(key, 0.5);
      }
      for (const id of nearbyRentalIds) {
        rentalIds.add(id);
        const key = `rental_owners_${id}`;
        if (!scoreMap.has(key)) scoreMap.set(key, 0.5);
      }
    } else if (searchCoords) {
      // Even with text results, still include nearby properties for distance display
      for (const id of nearbySellerIds) {
        sellerIds.add(id);
        if (!scoreMap.has(`sellers_${id}`)) scoreMap.set(`sellers_${id}`, 0.5);
      }
      for (const id of nearbyRentalIds) {
        rentalIds.add(id);
        if (!scoreMap.has(`rental_owners_${id}`)) scoreMap.set(`rental_owners_${id}`, 0.5);
      }
    }

    const hasProximitySearch = searchCoords !== null;

    // Fetch up to 30 per table — hard filters (property type, price) may eliminate many,
    // so we need a wider pool before filtering. Final page trimming happens in query().
    let results: any[] = [];

    // Fetch sellers
    if (sellerIds.size > 0) {
      const ids = [...sellerIds].slice(0, 30);
      const placeholders = ids.map(() => '?').join(',');
      const { results: rows } = await queryAll(this.env,
        `SELECT s.*, d.name as district_name, m.name as municipality_name,
                p.name as province_name, c.name as customer_name,
                c.primary_phone_num as customer_phone
         FROM sellers s
         LEFT JOIN districts d ON s.district_id = d.id
         LEFT JOIN municipalities m ON s.municipal_id = m.id
         LEFT JOIN provinces p ON s.province_id = p.id
         LEFT JOIN customers c ON s.customer_id = c.id
         WHERE s.id IN (${placeholders})${ownerFilter('s')}`,
        ids
      );

      for (const row of rows) {
        const priceText = formatPrice(row.property_price, row.property_price_unit);
        const priceNPR = priceToNPR(row.property_price, row.property_price_unit);
        const location = [
          row.property_address,
          row.city,
          row.municipality_name,
          row.district_name,
          row.ward_num ? `Ward ${row.ward_num}` : null
        ].filter(Boolean).join(', ');

        const distKm = nearbyDistances.get(`sellers_${row.id}`);
        results.push({
          id: row.id,
          source_table: 'sellers',
          listing_type: 'Sale',
          title: `${formatEnum(row.property_type)} for Sale in ${row.property_address || row.district_name || 'Nepal'}`,
          property_type: formatEnum(row.property_type),
          property_category: formatEnum(row.property_category),
          location,
          district: row.district_name,
          municipality: row.municipality_name,
          province: row.province_name,
          city: row.city,
          price: priceText,
          price_npr: priceNPR,
          area: formatAreaDisplay(row.property_area, row.area_unit) || null,
          house_area: row.house_area || null,
          land_area: row.land_area || null,
          layout: row.layout || null,
          bedrooms: parseBHK(row.layout),
          house_storey: row.house_storey || null,
          facing: formatEnum(row.property_face) || null,
          road_access: row.road_size ? `${row.road_size} ft ${formatEnum(row.road_type)} road` : null,
          furnished: row.furnished || null,
          compound: row.compound || null,
          parking: row.parking_space || null,
          amenities: parseJsonField(row.amenities),
          remarks: row.property_remarks || null,
          status: row.status,
          similarity: scoreMap.get(`sellers_${row.id}`) || 0,
          name: row.customer_name || null,
          phone: row.customer_phone || null,
          distance_km: distKm != null ? Math.round(distKm * 100) / 100 : null,
        });
      }
    }

    // Fetch rentals
    if (rentalIds.size > 0) {
      const ids = [...rentalIds].slice(0, 30);
      const placeholders = ids.map(() => '?').join(',');
      const { results: rows } = await queryAll(this.env,
        `SELECT ro.*, d.name as district_name, m.name as municipality_name,
                p.name as province_name, c.name as customer_name,
                c.primary_phone_num as customer_phone
         FROM rental_owners ro
         LEFT JOIN districts d ON ro.district_id = d.id
         LEFT JOIN municipalities m ON ro.municipal_id = m.id
         LEFT JOIN provinces p ON ro.province_id = p.id
         LEFT JOIN customers c ON ro.customer_id = c.id
         WHERE ro.id IN (${placeholders})${ownerFilter('ro')}`,
        ids
      );

      for (const row of rows) {
        const rentText = row.rent_amount ? `NPR ${Number(row.rent_amount).toLocaleString()}/month` : 'Rent negotiable';
        const location = [
          row.address,
          row.city,
          row.municipality_name,
          row.district_name,
          row.ward_num ? `Ward ${row.ward_num}` : null
        ].filter(Boolean).join(', ');

        const distKm = nearbyDistances.get(`rental_owners_${row.id}`);
        results.push({
          id: row.id,
          source_table: 'rental_owners',
          listing_type: 'Rent',
          title: `${formatEnum(row.property_type)} for Rent in ${row.address || row.district_name || 'Nepal'}`,
          property_type: formatEnum(row.property_type),
          property_category: formatEnum(row.category),
          location,
          district: row.district_name,
          municipality: row.municipality_name,
          province: row.province_name,
          city: row.city,
          price: rentText,
          price_npr: row.rent_amount || 0,
          area: formatAreaDisplay(row.property_area, row.area_unit) || null,
          layout: row.layout || null,
          bedrooms: row.bedroom || parseBHK(row.layout) || null,
          kitchen: row.kitchen || null,
          living_room: row.living_room || null,
          facing: formatEnum(row.property_face) || null,
          road_access: row.road_size ? `${row.road_size} ft ${formatEnum(row.road_type)} road` : null,
          parking: row.parking_space || null,
          amenities: parseJsonField(row.amenities),
          remarks: row.remarks || null,
          rental_purpose: row.rental_purpose || null,
          status: row.status,
          name: row.customer_name || null,
          phone: row.customer_phone || null,
          similarity: scoreMap.get(`rental_owners_${row.id}`) || 0,
          distance_km: distKm != null ? Math.round(distKm * 100) / 100 : null,
        });
      }
    }

    // Fetch buyers
    if (buyerIds.size > 0) {
      const ids = [...buyerIds].slice(0, 30);
      const placeholders = ids.map(() => '?').join(',');
      try {
        const { results: rows } = await queryAll(this.env,
          `SELECT b.*, d.name as district_name, m.name as municipality_name,
                  c.name as customer_name, c.primary_phone_num as customer_phone
           FROM buyers b
           LEFT JOIN districts d ON b.district_id = d.id
           LEFT JOIN municipalities m ON b.municipal_id = m.id
           LEFT JOIN customers c ON b.customer_id = c.id
           WHERE b.id IN (${placeholders})${role !== 'seller' ? ownerFilter('b') : ''}`, ids);
        for (const row of rows) {
          const budgetMax = row.maximum_budget ? formatPrice(row.maximum_budget, row.maximum_budget_unit) : null;
          const budgetMin = row.minimum_budget ? formatPrice(row.minimum_budget, row.minimum_budget_unit) : null;
          results.push({
            id: row.id, source_table: 'buyers', listing_type: 'Buyer',
            title: `Buyer: ${row.customer_name || 'Anonymous'} looking in ${row.district_name || 'Nepal'}`,
            entity_type: 'buyer',
            name: row.customer_name || null,
            phone: row.customer_phone || null,
            location: [row.seeking_address, row.municipality_name, row.district_name].filter(Boolean).join(', ') || 'Flexible',
            district: row.district_name || null,
            price: budgetMax ? `Up to ${budgetMax}` : budgetMin ? `From ${budgetMin}` : 'Flexible',
            property_type: formatEnum(row.property_type) || null,
            similarity: scoreMap.get(`buyers_${row.id}`) || 0,
          });
        }
      } catch (err: any) {
        if (!err?.message?.includes('doesn\'t exist')) console.warn('Buyers fetch error:', err.message);
      }
    }

    // Fetch tenants
    if (tenantIds.size > 0) {
      const ids = [...tenantIds].slice(0, 30);
      const placeholders = ids.map(() => '?').join(',');
      try {
        const { results: rows } = await queryAll(this.env,
          `SELECT t.*, d.name as district_name, m.name as municipality_name,
                  c.name as customer_name, c.primary_phone_num as customer_phone
           FROM tenants t
           LEFT JOIN districts d ON t.district_id = d.id
           LEFT JOIN municipalities m ON t.municipal_id = m.id
           LEFT JOIN customers c ON t.customer_id = c.id
           WHERE t.id IN (${placeholders})${role !== 'seller' ? ownerFilter('t') : ''}`, ids);
        for (const row of rows) {
          const rentMax = row.maximum_rent || row.max_rent;
          results.push({
            id: row.id, source_table: 'tenants', listing_type: 'Tenant',
            title: `Tenant: ${row.customer_name || 'Anonymous'} seeking rental in ${row.district_name || 'Nepal'}`,
            entity_type: 'tenant',
            name: row.customer_name || null,
            phone: row.customer_phone || null,
            location: [row.seeking_address, row.municipality_name, row.district_name].filter(Boolean).join(', ') || 'Flexible',
            district: row.district_name || null,
            price: rentMax ? `Up to NPR ${Number(rentMax).toLocaleString()}/month` : 'Flexible',
            bedrooms: row.bedroom || null,
            property_type: formatEnum(row.property_type) || null,
            similarity: scoreMap.get(`tenants_${row.id}`) || 0,
          });
        }
      } catch (err: any) {
        if (!err?.message?.includes('doesn\'t exist')) console.warn('Tenants fetch error:', err.message);
      }
    }

    // Fetch agents
    if (agentIds.size > 0) {
      const ids = [...agentIds].slice(0, 30);
      const placeholders = ids.map(() => '?').join(',');
      try {
        const { results: rows } = await queryAll(this.env,
          `SELECT a.* FROM agents a WHERE a.id IN (${placeholders})${ownerFilter('a')}`, ids);
        for (const row of rows) {
          results.push({
            id: row.id, source_table: 'agents', listing_type: 'Agent',
            title: `Agent: ${row.name || 'Unknown'} — ${row.working_area || 'Nepal'}`,
            entity_type: 'agent',
            name: row.name || null,
            phone: row.phone || null,
            location: row.working_area || row.address || null,
            district: null,
            price: null,
            similarity: scoreMap.get(`agents_${row.id}`) || 0,
          });
        }
      } catch (err: any) {
        if (!err?.message?.includes('doesn\'t exist')) console.warn('Agents fetch error:', err.message);
      }
    }

    // Extract desired property type from query
    const queryPropType = extractPropertyType(query);

    // Scoring helpers
    const typeScore = (p: any): number => {
      if (!queryPropType) return 1;
      const pType = (p.property_type || '').toLowerCase();
      if (pType === queryPropType) return 1;
      return 0.4;
    };

    const priceScore = (p: any): number => {
      if (!parsed?.minNPR && !parsed?.maxNPR) return 1;
      const price = p.price_npr || 0;
      if (!price) return 0.6;
      if (parsed.minNPR && price < parsed.minNPR) return 0.3;
      if (parsed.maxNPR && price > parsed.maxNPR) return 0.3;
      return 1;
    };

    const bedroomScore = (p: any): number => {
      if (!parsed?.bedrooms) return 1;
      const beds = p.bedrooms;
      if (!beds) return 0.7;
      const diff = Math.abs(beds - parsed.bedrooms);
      return Math.max(0.3, 1 - 0.15 * diff);
    };

    // Parse area string from DB into ropani for comparison
    const parseAreaToRopani = (areaStr: string | null): number | null => {
      if (!areaStr) return null;
      const lower = areaStr.toLowerCase();
      const units: Record<string, number> = {
        ropani: 1, aana: 1 / 16, dhur: 1 / 256,
        bigha: 13.31, kattha: 0.83,
        'sq ft': 1 / 5476, 'sq m': 1 / 508.74, 'sqm': 1 / 508.74,
      };
      for (const [unit, mult] of Object.entries(units)) {
        const m = lower.match(new RegExp(`(\\d+(?:\\.\\d+)?)\\s*${unit}`));
        if (m) return parseFloat(m[1]) * mult;
      }
      return null;
    };

    const areaScore = (p: any): number => {
      if (!parsed?.minArea && !parsed?.maxArea) return 1;
      const area = parseAreaToRopani(p.area);
      if (!area) return 0.6;
      if (parsed.minArea && area < parsed.minArea) return 0.3;
      if (parsed.maxArea && area > parsed.maxArea) return 0.3;
      return 1;
    };

    const storeyScore = (p: any): number => {
      if (!parsed?.storeys) return 1;
      const s = parseFloat(p.house_storey);
      if (isNaN(s)) return 0.7;
      const diff = Math.abs(s - parsed.storeys);
      return Math.max(0.3, 1 - 0.2 * diff);
    };

    const facingScore = (p: any): number => {
      if (!parsed?.facing) return 1;
      if (!p.facing) return 0.7;
      return p.facing.toLowerCase() === parsed.facing ? 1 : 0.3;
    };

    const furnishedScore = (p: any): number => {
      if (parsed?.furnished === null || parsed?.furnished === undefined) return 1;
      if (!p.furnished) return 0.7;
      const isFurnished = /yes|furnished|full/i.test(p.furnished);
      return isFurnished === parsed.furnished ? 1 : 0.3;
    };

    const roadScore = (p: any): number => {
      if (!parsed?.roadAccess) return 1;
      return p.road_access ? 1 : 0.5;
    };

    const categoryScore = (p: any): number => {
      if (!parsed?.category) return 1;
      if (!p.property_category) return 0.7;
      return p.property_category.toLowerCase().includes(parsed.category) ? 1 : 0.3;
    };

    // Combined feature score for extra filters
    const featureScore = (p: any): number => {
      const scores = [areaScore(p), storeyScore(p), facingScore(p), furnishedScore(p), roadScore(p), categoryScore(p)];
      return scores.reduce((a, b) => a + b, 0) / scores.length;
    };

    // Exponential proximity decay: sharp boost for very close, gradual drop-off farther
    // Text-matched results (found by address name) get full proximity score even without coordinates
    const proxScore = (p: any): number => {
      const key = `${p.source_table}_${p.id}`;
      if (textMatchedIds.has(key)) return 1.0; // Name match = confirmed in that location
      if (p.distance_km != null) return Math.exp(-p.distance_km / 3);
      return 0;
    };

    // When a location is specified, filter results to only those relevant to that location
    // Word-boundary location match helper — prevents "new" matching "newari"
    const addrContainsLocation = (addr: string, locWords: string[]): boolean => {
      const lowerAddr = addr.toLowerCase();
      return locWords.some(w => {
        if (w.length < 3) return false;
        // Use word boundary check: match as separate word or at start/end of comma-separated segment
        const idx = lowerAddr.indexOf(w);
        if (idx === -1) return false;
        const before = idx === 0 ? ' ' : lowerAddr[idx - 1];
        const after = idx + w.length >= lowerAddr.length ? ' ' : lowerAddr[idx + w.length];
        return /[\s,\-]/.test(before) || idx === 0 ? (/[\s,\-]/.test(after) || idx + w.length === lowerAddr.length) : false;
      });
    };

    if (locationPhrase && role !== 'seller') {
      if (textMatchedIds.size > 0) {
        // We have text matches — keep those + proximity results that contain the location word
        const locWords = locationPhrase.toLowerCase().split(/\s+/);
        results = results.filter(p => {
          const key = `${p.source_table}_${p.id}`;
          if (textMatchedIds.has(key)) return true;
          return addrContainsLocation(p.location || '', locWords);
        });
      } else if (geocodeFailed) {
        // Location specified but not found anywhere — only keep results whose address contains the location word
        const locWords = locationPhrase.toLowerCase().split(/\s+/);
        results = results.filter(p => addrContainsLocation(p.location || '', locWords));
      } else if (searchCoords) {
        // Location geocoded but no text matches — keep only proximity results (within 5km)
        results = results.filter(p => p.distance_km != null && p.distance_km <= 5);
      }
    }

    // Load configurable weights from env (fall back to defaults)
    const wSim   = parseFloat(this.env.W_SIMILARITY || '0.35');
    const wProx  = parseFloat(this.env.W_PROXIMITY  || '0.25');
    const wType  = parseFloat(this.env.W_TYPE        || '0.15');
    const wPrice = parseFloat(this.env.W_PRICE       || '0.15');
    const wRnk   = parseFloat(this.env.W_RERANK      || '0.10');

    // Reranking: keyword overlap between query terms and result fields
    const queryTerms = query.toLowerCase().split(/\s+/);
    const rerank = (p: any) => keywordRerankScore(p, queryTerms);

    // Sort results based on what filters are active
    const hasPrice = !!(parsed?.minNPR || parsed?.maxNPR);
    const hasFeatureFilters = !!(parsed?.minArea || parsed?.maxArea || parsed?.storeys || parsed?.facing || parsed?.furnished !== null && parsed?.furnished !== undefined || parsed?.roadAccess || parsed?.category);

    if (hasProximitySearch && (hasPrice || hasFeatureFilters)) {
      results.sort((a, b) => {
        const aScore = wSim*0.3*a.similarity + wProx*0.8*proxScore(a) + wType*0.7*typeScore(a) + wPrice*priceScore(a) + 0.1*bedroomScore(a) + wPrice*featureScore(a) + wRnk*rerank(a);
        const bScore = wSim*0.3*b.similarity + wProx*0.8*proxScore(b) + wType*0.7*typeScore(b) + wPrice*priceScore(b) + 0.1*bedroomScore(b) + wPrice*featureScore(b) + wRnk*rerank(b);
        return bScore - aScore;
      });
    } else if (hasProximitySearch) {
      results.sort((a, b) => {
        const aScore = wSim*a.similarity + wProx*proxScore(a) + wType*typeScore(a) + wPrice*0.5*priceScore(a) + 0.05*bedroomScore(a) + wRnk*rerank(a);
        const bScore = wSim*b.similarity + wProx*proxScore(b) + wType*typeScore(b) + wPrice*0.5*priceScore(b) + 0.05*bedroomScore(b) + wRnk*rerank(b);
        return bScore - aScore;
      });
    } else if (hasPrice || hasFeatureFilters) {
      results.sort((a, b) => {
        const aScore = wSim*a.similarity + wType*typeScore(a) + wPrice*2*priceScore(a) + 0.1*bedroomScore(a) + wPrice*featureScore(a) + wRnk*rerank(a);
        const bScore = wSim*b.similarity + wType*typeScore(b) + wPrice*2*priceScore(b) + 0.1*bedroomScore(b) + wPrice*featureScore(b) + wRnk*rerank(b);
        return bScore - aScore;
      });
    } else {
      results.sort((a, b) => {
        const aScore = wSim*a.similarity + wType*typeScore(a) + wPrice*priceScore(a) + 0.05*bedroomScore(a) + wRnk*rerank(a);
        const bScore = wSim*b.similarity + wType*typeScore(b) + wPrice*priceScore(b) + 0.05*bedroomScore(b) + wRnk*rerank(b);
        return bScore - aScore;
      });
    }

    const resultsBeforeFilter = results.length;

    // Hard-filter by property type when user is specific (e.g., "house", "land", "flat")
    // Generic terms like "properties", "listings" return all types
    if (queryPropType) {
      results = results.filter(p => {
        const pType = (p.property_type || '').toLowerCase();
        return pType === queryPropType;
      });

      // Type guarantee fallback: if the hard filter wiped everything (rare type not
      // in top vector/proximity results), run a direct SQL to guarantee we find it.
      if (results.length === 0 && role !== 'seller') {
        try {
          const tableMap: Record<string, { table: string; alias: string; addrCol: string }> = {
            sale: { table: 'sellers',       alias: 's',  addrCol: 'property_address' },
            rent: { table: 'rental_owners', alias: 'ro', addrCol: 'address'          },
          };
          const tables = intent === 'rent'
            ? [tableMap.rent]
            : intent === 'sale'
            ? [tableMap.sale]
            : [tableMap.sale, tableMap.rent];

          for (const { table, alias, addrCol } of tables) {
            const locationClause = locationPhrase
              ? ` AND (LOWER(${alias}.${addrCol}) LIKE LOWER(?) OR LOWER(${alias}.city) LIKE LOWER(?))`
              : '';
            const locationParams = locationPhrase ? [`%${locationPhrase}%`, `%${locationPhrase}%`] : [];
            const ownerClause = ownerId ? ` AND ${alias}.owner_id = ${ownerId}` : '';

            // Fetch full row data directly — don't re-use sellerIds (already full at 30)
            const joinMap: Record<string, string> = {
              sellers: `SELECT s.*, d.name as district_name, m.name as municipality_name,
                               p.name as province_name, c.name as customer_name,
                               c.primary_phone_num as customer_phone
                        FROM sellers s
                        LEFT JOIN districts d ON s.district_id = d.id
                        LEFT JOIN municipalities m ON s.municipal_id = m.id
                        LEFT JOIN provinces p ON s.province_id = p.id
                        LEFT JOIN customers c ON s.customer_id = c.id
                        WHERE UPPER(s.property_type) = UPPER(?) AND s.status = 'ACTIVE'${ownerClause}${locationClause} ORDER BY s.id DESC LIMIT 10`,
              rental_owners: `SELECT ro.*, d.name as district_name, m.name as municipality_name,
                                     p.name as province_name, c.name as customer_name,
                                     c.primary_phone_num as customer_phone
                              FROM rental_owners ro
                              LEFT JOIN districts d ON ro.district_id = d.id
                              LEFT JOIN municipalities m ON ro.municipal_id = m.id
                              LEFT JOIN provinces p ON ro.province_id = p.id
                              LEFT JOIN customers c ON ro.customer_id = c.id
                              WHERE UPPER(ro.property_type) = UPPER(?) AND ro.status = 'ACTIVE'${ownerClause.replace(/s\./g, 'ro.')}${locationClause} ORDER BY ro.id DESC LIMIT 10`,
            };

            const { results: fallbackRows } = await queryAll(this.env, joinMap[table], [queryPropType, ...locationParams]);
            if ((fallbackRows as any[]).length > 0) {
              console.log(`Type guarantee fallback: ${(fallbackRows as any[]).length} ${table} for "${queryPropType}"`);
            }

            for (const row of fallbackRows as any[]) {
              if (results.some((r: any) => r.id === row.id && r.source_table === table)) continue;
              const pType = formatEnum(row.property_type);
              const listingType = table === 'sellers' ? 'Sale' : 'Rent';
              const addrField = table === 'sellers' ? row.property_address : row.address;
              const priceField = table === 'sellers'
                ? formatPrice(row.property_price, row.property_price_unit)
                : (row.rent_amount ? `NPR ${Number(row.rent_amount).toLocaleString()}/month` : 'Rent negotiable');
              const priceNpr = table === 'sellers'
                ? priceToNPR(row.property_price, row.property_price_unit)
                : (row.rent_amount || 0);
              results.push({
                id: row.id, source_table: table, listing_type: listingType,
                title: `${pType} for ${listingType} in ${addrField || row.city || 'Nepal'}`,
                property_type: pType,
                location: [addrField, row.city, row.municipality_name, row.district_name].filter(Boolean).join(', '),
                district: row.district_name, city: row.city,
                price: priceField, price_npr: priceNpr,
                area: null, bedrooms: null, amenities: [],
                name: row.customer_name || null, phone: row.customer_phone || null,
                similarity: 0.6, distance_km: null,
              });
            }
          }
        } catch (err: any) {
          console.warn('Type guarantee fallback failed:', err.message);
        }
      }
    }

    // Hard-filter by listing intent (sale vs rent) — skip for seller role:
    // buyers have listing_type='Buyer' and tenants have listing_type='Tenant', not 'Sale'/'Rent'
    if (role !== 'seller') {
      if (intent === 'sale') {
        results = results.filter(p => p.listing_type === 'Sale');
      } else if (intent === 'rent') {
        results = results.filter(p => p.listing_type === 'Rent');
      }
    }

    // Hard-filter by price when explicitly specified
    // price_npr = 0 means "Price on request" — keep those visible even with budget set
    // Tolerance: 5% (strict) to avoid showing obviously over-budget properties
    if (parsed?.minNPR) {
      const threshold = parsed.minNPR * 0.95;
      results = results.filter(p => !p.price_npr || p.price_npr >= threshold);
    }
    if (parsed?.maxNPR) {
      const threshold = parsed.maxNPR * 1.05;
      results = results.filter(p => !p.price_npr || p.price_npr <= threshold);
    }

    // Hard-filter by bedrooms: exclude only if bedroom count is known AND too far off (±2)
    // Properties with null/unknown bedrooms are kept (ranked lower by bedroomScore)
    if (parsed?.bedrooms) {
      results = results.filter(p => !p.bedrooms || Math.abs(p.bedrooms - parsed.bedrooms!) <= 2);
    }

    const filteredOut = resultsBeforeFilter > 0 && results.length === 0;

    return { results, locationPhrase, geocodeFailed, outsideCoverage, filteredOut };
  }

  async generateAnswer(question: string, properties: any[], intent?: 'sale' | 'rent' | null, parsed?: ParsedIntent, locationCtx?: { locationPhrase: string | null; geocodeFailed: boolean; outsideCoverage: boolean; filteredOut: boolean }, role?: 'buyer' | 'seller', totalCount?: number): Promise<string> {
    if (properties.length === 0) {
      if (role === 'seller') {
        const locDesc = locationCtx?.locationPhrase ? ` in ${locationCtx.locationPhrase}` : '';
        if (intent === 'rent') return `We couldn't find any tenants looking for rentals${locDesc}. Try a broader location or different criteria.`;
        if (intent === 'sale') return `We couldn't find any buyers looking to purchase${locDesc}. Try a broader location or different property type.`;
        return `We couldn't find any buyers or tenants matching your criteria${locDesc}. Try adjusting the location or property type.`;
      }
      // Had results but filters (price/bedrooms) eliminated all
      if (locationCtx?.filteredOut) {
        const filterParts: string[] = [];
        const propType = extractPropertyType(question);
        if (propType) filterParts.push(propType);
        if (parsed?.maxNPR) filterParts.push(`under NPR ${parsed.maxNPR.toLocaleString()}`);
        if (parsed?.minNPR) filterParts.push(`above NPR ${parsed.minNPR.toLocaleString()}`);
        if (parsed?.bedrooms) filterParts.push(`${parsed.bedrooms} bedroom`);
        if (intent === 'sale') filterParts.push('for sale');
        if (intent === 'rent') filterParts.push('for rent');
        const filterDesc = filterParts.length > 0 ? ` matching ${filterParts.join(', ')}` : '';
        const locDesc = locationCtx?.locationPhrase ? ` in ${locationCtx.locationPhrase}` : '';
        return `We have properties${locDesc}, but none${filterDesc}. Try adjusting your filters.`;
      }
      // Location is outside our coverage area
      if (locationCtx?.locationPhrase && locationCtx.outsideCoverage) {
        return `Sorry, "${locationCtx.locationPhrase}" is outside our current coverage area. We don't have property listings for that location. Try searching in areas where we have data, like Pokhara and nearby districts.`;
      }
      // Location was detected but couldn't be found in DB or map
      if (locationCtx?.locationPhrase && locationCtx.geocodeFailed) {
        return `We couldn't find any properties for "${locationCtx.locationPhrase}". This location may be outside our coverage area, or we may not recognize the name. Could you provide more details — like the ward number, a nearby landmark, or a well-known nearby area? For example: "property near ward 5" or "house near Prithvi Chowk".`;
      }
      // Location was found on map but no properties nearby
      if (locationCtx?.locationPhrase && !locationCtx.geocodeFailed) {
        return `We don't have any properties listed in "${locationCtx.locationPhrase}" yet. Try searching a nearby area, or check back later as new listings are added regularly.`;
      }
      if (intent === 'rent') return "I couldn't find any rental properties matching your criteria. We may not have rentals in that area yet — try a broader location, or check our sale listings.";
      if (intent === 'sale') return "I couldn't find any properties for sale matching your criteria. Try adjusting your budget, location, or property type.";
      return "I couldn't find any properties matching your criteria in our database. Try adjusting your budget, location, or property type.";
    }

    // Location-only search: show all properties; with filters: show top matches
    const hasFilters = !!(parsed?.minNPR || parsed?.maxNPR || parsed?.bedrooms || parsed?.minArea || parsed?.maxArea || parsed?.storeys || parsed?.facing || (parsed?.furnished !== null && parsed?.furnished !== undefined) || parsed?.roadAccess || parsed?.category);
    const locationOnly = !!locationCtx?.locationPhrase && !hasFilters;
    const contextLimit = locationOnly ? 20 : 10;

    const context = properties.slice(0, contextLimit).map((p, i) => {
      const parts = [
        `${i + 1}. ${p.title} [DB ID: ${p.id}, Table: ${p.source_table}]`,
        p.location ? `   Location: ${p.location}` : null,
        p.price ? `   ${p.listing_type === 'Rent' ? 'Rent' : p.listing_type === 'Buyer' ? 'Budget' : p.listing_type === 'Tenant' ? 'Rent Budget' : 'Price'}: ${p.price}` : null,
        p.area ? `   Area: ${p.area}` : null,
        p.layout ? `   Layout: ${p.layout}` : null,
        p.bedrooms ? `   Bedrooms: ${p.bedrooms}` : null,
        p.house_storey ? `   Storeys: ${p.house_storey}` : null,
        p.property_type ? `   Type: ${p.property_type}${p.property_category ? ` (${p.property_category})` : ''}` : null,
        p.facing ? `   Facing: ${p.facing}` : null,
        p.road_access ? `   Road: ${p.road_access}` : null,
        p.furnished ? `   Furnished: ${p.furnished}` : null,
        p.distance_km != null ? `   Distance: ${p.distance_km} km away` : null,
        p.phone ? `   Contact: ${p.name ? p.name + ' — ' : ''}${p.phone}` : null,
        p.amenities?.length ? `   Amenities: ${p.amenities.join(', ')}` : null
      ].filter(Boolean);
      return parts.join('\n');
    }).join('\n\n');

    const listingTypeNote = intent === 'rent'
      ? 'The user is looking for RENTAL properties. All results below are for rent.'
      : intent === 'sale'
      ? 'The user is looking to BUY/PURCHASE a property. All results below are for sale.'
      : 'Results include both sale and rental listings — note the listing type for each.';

    const intentParts: string[] = [];
    if (parsed?.bedrooms) intentParts.push(`${parsed.bedrooms} bedroom(s)`);
    if (parsed?.maxNPR) intentParts.push(`budget up to NPR ${parsed.maxNPR.toLocaleString()}`);
    if (parsed?.minNPR && !parsed?.maxNPR) intentParts.push(`budget from NPR ${parsed.minNPR.toLocaleString()}`);
    if (parsed?.minArea || parsed?.maxArea) {
      if (parsed.minArea && parsed.maxArea) intentParts.push(`area ${parsed.minArea.toFixed(1)}-${parsed.maxArea.toFixed(1)} ropani`);
      else if (parsed.maxArea) intentParts.push(`area up to ${parsed.maxArea.toFixed(1)} ropani`);
      else if (parsed.minArea) intentParts.push(`area from ${parsed.minArea.toFixed(1)} ropani`);
    }
    if (parsed?.storeys) intentParts.push(`${parsed.storeys} storey(s)`);
    if (parsed?.facing) intentParts.push(`${parsed.facing}-facing`);
    if (parsed?.furnished === true) intentParts.push('furnished');
    if (parsed?.furnished === false) intentParts.push('unfurnished');
    if (parsed?.roadAccess) intentParts.push('road access required');
    if (parsed?.category) intentParts.push(`${parsed.category} property`);
    const parsedNote = intentParts.length ? `Parsed user filters: ${intentParts.join(', ')}.` : '';

    const isSeller = role === 'seller';
    const actualTotal = totalCount ?? properties.length;
    const systemContext = isSeller
      ? `You are a real estate AI assistant helping a property owner find potential buyers or tenants interested in their property.`
      : `You are a real estate AI assistant helping users find properties based on their needs.`;

    const prompt = `${systemContext}

<user_query>${question.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</user_query>
${listingTypeNote}
${parsedNote}
Total matching results: ${actualTotal}. Showing top ${properties.slice(0, contextLimit).length} below.

${isSeller ? 'Potential buyers/tenants from the database:' : 'Matching properties from the database:'}
${context}

INSTRUCTIONS:
- Use ONLY the data above. Never invent or assume any details.
- Reply in English only.
- CRITICAL: ALL properties listed above have already been filtered and validated by the system. Do NOT re-check or re-apply price, bedroom, or any other filters. Do NOT say a property is over budget — if it appears above, it is a valid result.
${isSeller ? `- These are BUYERS or TENANTS looking for a property. Summarise each person's requirements: location preference, budget, property type, and contact if available.
- Group by type if needed (e.g., "Buyers:", "Tenants:").
- At the end say "Found ${actualTotal} potential leads."` :
  locationOnly ? `- The user searched by LOCATION ONLY. List ALL the properties shown above — give a brief summary of each (type, price, area). Do not skip any.
- Group by property type if there are many (e.g., "Houses:", "Land:", "Rentals:").
- At the end say exactly: "Found ${actualTotal} properties."` : hasFilters ? `- The user searched with FILTERS. List each property with its price, area, bedrooms, and key details.
- Group by property type (e.g., "Houses:", "Land:") if there are multiple types.
- At the end say exactly: "Found ${actualTotal} properties matching your criteria."` : `- Highlight the 2-3 best matches and briefly explain why each fits the user's request (location, price, type, size).`}
${!isSeller ? `- If distance data is available, mention how far each property is from the searched location.
- If a property is within 1 km, note it as "very close".
- Show prices exactly as listed. Do not convert or estimate prices.
- If the user asked for rentals but a property is for sale (or vice versa), mention that clearly.` : ''}
- If no results are a good fit, say so and suggest how to adjust the search.
- Be concise. Do not repeat the same details twice.
- Never use emojis.
- End with a short reference list using the exact DB ID and Table shown in brackets, e.g. "sellers #467, sellers #833".`;

    try {
      console.log(`AI prompt length: ${prompt.length} chars`);

      // Cache AI responses in KV — keyed by prompt hash, TTL 1 hour
      // Uses "ai:" prefix so /cache/clear can wipe both query + AI caches
      const hashBuf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(prompt));
      const hashHex = [...new Uint8Array(hashBuf)].map(b => b.toString(16).padStart(2, '0')).join('');
      const kvKey = `ai:${hashHex}`;

      const cachedAnswer = await this.env.SORHAAANA_CACHE.get(kvKey);
      if (cachedAnswer) {
        console.log('AI cache HIT — saving neurons');
        return cachedAnswer;
      }

      const response = await this.env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 1024
      });
      if (!response?.response) {
        console.error('AI returned empty response:', JSON.stringify(response));
        return 'I found matching properties shown below, but the AI analysis is temporarily unavailable.';
      }

      await this.env.SORHAAANA_CACHE.put(kvKey, response.response, { expirationTtl: 3600 });
      console.log('AI cache MISS — stored for 1h');

      return response.response;
    } catch (e: any) {
      const errMsg = e?.message || String(e);
      console.error('AI generation failed:', errMsg, 'Prompt length:', prompt.length);
      return `I found matching properties shown below. (AI error: ${errMsg})`;
    }
  }

  private async resolveIntent(question: string, queryHash: string, overrideRole?: 'buyer' | 'seller'): Promise<{
    role: 'buyer' | 'seller';
    maxBudget: number | null;
    minBudget: number | null;
    bedrooms: number | null;
    listingIntent: 'sale' | 'rent' | null;
    propertyType: string | null;
  } | null> {
    // Check KV cache first (24h TTL)
    const intentKey = `intent:v1:${queryHash}`;
    const cached = await this.env.SORHAAANA_CACHE.get(intentKey);
    if (cached) {
      try {
        const parsed = JSON.parse(cached);
        if (overrideRole) parsed.role = overrideRole;
        return parsed;
      } catch {}
    }

    // Keyword fast-path for role — if clearly seller, skip AI for role at least
    const kwRole = detectRole(question);

    try {
      const response = await this.env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
        messages: [
          {
            role: 'system',
            content: `You extract Nepal real estate search intent. Return ONLY a JSON object, no explanation.

Fields:
- role: "buyer" (user wants to find/buy/rent a property) or "seller" (user wants buyers/tenants/leads for their property)
- maxBudget: max price in NPR as integer (1 crore=10000000, 1 lakh=100000), or null
- minBudget: min price in NPR as integer, or null
- bedrooms: number of bedrooms as integer, or null
- listingIntent: "sale" if buying/selling, "rent" if renting, or null
- propertyType: "house"/"land"/"flat"/"apartment"/"shop"/"commercial"/"hotel" or null

Examples:
"buyer in Pokhara under a budget of 1.5 crores" → {"role":"buyer","maxBudget":15000000,"minBudget":null,"bedrooms":null,"listingIntent":"sale","propertyType":null}
"find me a tenant for 2bhk flat" → {"role":"seller","maxBudget":null,"minBudget":null,"bedrooms":2,"listingIntent":"rent","propertyType":"flat"}
"3 bedroom house under 50 lakhs" → {"role":"buyer","maxBudget":5000000,"minBudget":null,"bedrooms":3,"listingIntent":"sale","propertyType":"house"}
"land between 1 crore and 2 crore" → {"role":"buyer","maxBudget":20000000,"minBudget":10000000,"bedrooms":null,"listingIntent":"sale","propertyType":"land"}
"I need buyer for my land" → {"role":"seller","maxBudget":null,"minBudget":null,"bedrooms":null,"listingIntent":"sale","propertyType":"land"}`
          },
          { role: 'user', content: question }
        ],
        max_tokens: 120,
      });

      const raw = response?.response?.trim() ?? '';
      const jsonStr = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
      const firstBrace = jsonStr.indexOf('{');
      const lastBrace = jsonStr.lastIndexOf('}');
      if (firstBrace === -1 || lastBrace === -1) throw new Error('No JSON in response');

      const intent = JSON.parse(jsonStr.slice(firstBrace, lastBrace + 1));

      // Keyword seller signal overrides AI (keywords are unambiguous)
      if (kwRole === 'seller') intent.role = 'seller';
      if (overrideRole) intent.role = overrideRole;

      // Normalise types
      intent.maxBudget = typeof intent.maxBudget === 'number' ? intent.maxBudget : null;
      intent.minBudget = typeof intent.minBudget === 'number' ? intent.minBudget : null;
      intent.bedrooms  = typeof intent.bedrooms  === 'number' ? intent.bedrooms  : null;

      await this.env.SORHAAANA_CACHE.put(intentKey, JSON.stringify(intent), { expirationTtl: 86400 });
      console.log(`AI intent: "${question}" →`, JSON.stringify(intent));
      return intent;
    } catch (e) {
      console.log('AI intent failed, falling back to regex:', e);
      // Return a minimal intent using keyword detection
      return { role: kwRole, maxBudget: null, minBudget: null, bedrooms: null, listingIntent: null, propertyType: null };
    }
  }

  async query(question: string, options?: { limit?: number; offset?: number; ownerId?: number | null; role?: 'buyer' | 'seller' }): Promise<any> {
    const injectionCheck = detectPromptInjection(question);
    if (injectionCheck) return { error: injectionCheck, properties: [], total_results: 0, answer: injectionCheck };

    const limit = Math.min(options?.limit || 20, 50);
    const offset = options?.offset || 0;

    // Normalize and hash query early — shared between intent cache key and query cache key
    const cacheVersion = this.env.CACHE_VERSION || '1';
    const normalizedQ = question.toLowerCase().trim().replace(/\s+/g, ' ').replace(/[?!.,]+$/, '');
    const queryHashBuf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalizedQ));
    const queryHash = [...new Uint8Array(queryHashBuf)].map(b => b.toString(16).padStart(2, '0')).join('');

    // AI intent extraction: role + price + bedrooms + listing intent in one call (cached 24h)
    const aiIntent = await this.resolveIntent(question, queryHash, options?.role);
    const role = aiIntent?.role ?? detectRole(question);

    // Smart query cache (KV):
    // - Key: rag:<version>:<hash> — includes CACHE_VERSION for deploy-time invalidation
    // - TTL: 3 minutes (short enough to stay fresh; long enough to help repeated queries)
    // - Only stored when results.length > 0 (never caches empty/error responses)
    // - Keys prefixed with "rag:" so /cache/clear can list+delete all entries
    const cacheInput = `rag-v${cacheVersion}:${normalizedQ}|${options?.ownerId ?? 'all'}|${role ?? 'any'}|${limit}|${offset}`;
    const hashBuf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(cacheInput));
    const hashHex = [...new Uint8Array(hashBuf)].map(b => b.toString(16).padStart(2, '0')).join('');
    const kvKey = `rag:${hashHex}`;

    const cachedStr = await this.env.SORHAAANA_CACHE.get(kvKey);
    if (cachedStr) {
      console.log(`Cache HIT: "${normalizedQ}"`);
      const hit = JSON.parse(cachedStr);
      hit.cached = true;
      return hit;
    }

    // AI intent supplements regex — AI handles natural language, regex handles specific formats
    const intent = aiIntent?.listingIntent ?? detectListingIntent(question);
    const parsed = extractParsedIntent(question);
    // AI fills in values that regex missed (never overwrites a successful regex parse)
    if (aiIntent?.maxBudget != null && !parsed.maxNPR) parsed.maxNPR = aiIntent.maxBudget;
    if (aiIntent?.minBudget != null && !parsed.minNPR) parsed.minNPR = aiIntent.minBudget;
    if (aiIntent?.bedrooms  != null && !parsed.bedrooms)  parsed.bedrooms  = aiIntent.bedrooms;

    const { results: allProperties, locationPhrase, geocodeFailed, outsideCoverage, filteredOut } = await this.searchProperties(question, intent, parsed, options?.ownerId, role);

    const properties = allProperties.slice(offset, offset + limit);
    const generatedAnswer = await this.generateAnswer(question, properties, intent, parsed, { locationPhrase, geocodeFailed, outsideCoverage, filteredOut }, role, allProperties.length);

    const result = {
      query: question,
      answer: generatedAnswer,
      properties,
      total_results: allProperties.length,
      page_size: limit,
      page_offset: offset,
      listing_intent: intent || 'any',
      role,
      cached: false,
    };

    // Only cache non-empty results — never persist a bug response
    if (allProperties.length > 0) {
      await this.env.SORHAAANA_CACHE.put(kvKey, JSON.stringify(result), { expirationTtl: 180 });
      console.log(`Cache MISS — stored 3min: "${normalizedQ}" (${allProperties.length} results)`);
    } else {
      console.log(`Cache SKIP — 0 results not cached: "${normalizedQ}"`);
    }

    return result;
  }
}

// -- Utility functions (module-level) --

/**
 * Generate prefix variants for fuzzy matching Nepali romanized words.
 * Handles aspiration ambiguity: kh↔k, bh↔b, ch↔c, th↔t, dh↔d, ph↔p, gh↔g, sh↔s
 * Returns SQL LIKE patterns to match any variant.
 */
function prefixVariants(word: string): string[] {
  const w = word.toLowerCase();
  const base = w.substring(0, 3);
  const variants = new Set<string>([`%${base}%`]);

  // Aspiration pairs: "kh"↔"k", "bh"↔"b", etc.
  const aspirated = ['kh', 'bh', 'ch', 'th', 'dh', 'ph', 'gh', 'sh'];
  for (const asp of aspirated) {
    const plain = asp[0]; // e.g. 'k' from 'kh'
    if (w.startsWith(asp)) {
      // Word starts with aspirated form → also try plain (e.g. "kha" → "ka")
      variants.add(`%${plain}${w.substring(asp.length, asp.length + 2)}%`);
    } else if (w.startsWith(plain) && !aspirated.some(a => w.startsWith(a))) {
      // Word starts with plain consonant (not already aspirated) → also try aspirated
      variants.add(`%${asp}${w.substring(plain.length, plain.length + 1)}%`);
    }
  }
  return Array.from(variants);
}

function parseJsonField(field: any): string[] {
  if (!field) return [];
  if (Array.isArray(field)) return field.filter(item => item && typeof item === 'string');
  if (typeof field === 'string') {
    if (field.startsWith('[')) {
      try {
        const parsed = JSON.parse(field);
        return Array.isArray(parsed) ? parsed.filter(item => item && typeof item === 'string') : [field];
      } catch { return [field]; }
    }
    return field.trim() ? [field] : [];
  }
  return [];
}

function formatEnum(val: string | null): string {
  if (!val) return '';
  return val.split(/[-_]/).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join('-');
}

function formatAreaDisplay(area: string | null, unit: string | null): string {
  if (!area || area === '0') return '';
  const unitMap: Record<string, string> = {
    'HAAT': 'Haat', 'AANA': 'Aana', 'ROPANI': 'Ropani',
    'SQUARE_METER': 'sq m', 'SQUARE_FEET': 'sq ft',
    'BIGHA': 'Bigha', 'KATTHA': 'Kattha', 'DHUR': 'Dhur'
  };
  return `${area} ${unitMap[(unit || '')] || unit || ''}`.trim();
}

function parseBHK(layout: string | null): number | null {
  if (!layout) return null;
  // "3BHK", "3 BHK", "3R"
  const bhkMatch = layout.match(/(\d+)\s*(?:BHK|R)\b/i);
  if (bhkMatch) return parseInt(bhkMatch[1]);
  // "2B1K" format (2 bedrooms, 1 kitchen)
  const bkMatch = layout.match(/(\d+)\s*B\s*\d+\s*K/i);
  if (bkMatch) return parseInt(bkMatch[1]);
  // "2 Bedroom", "2 Bed"
  const bedMatch = layout.match(/(\d+)\s*(?:bedrooms?|bed)\b/i);
  if (bedMatch) return parseInt(bedMatch[1]);
  return null;
}

/** Keyword reranking — boosts results where query terms appear in title/location/type */
export function keywordRerankScore(p: any, queryTerms: string[]): number {
  const text = [p.title, p.location, p.property_type, p.district, p.city, p.remarks]
    .filter(Boolean).join(' ').toLowerCase();
  const meaningful = queryTerms.filter(t => t.length > 2);
  if (meaningful.length === 0) return 0;
  const hits = meaningful.filter(t => text.includes(t)).length;
  return hits / meaningful.length;
}

/** Detect Devanagari script (Nepali) in a query */
function containsNepaliScript(text: string): boolean {
  return /[ऀ-ॿ]/.test(text);
}

/** Translate query to English using AI if it contains Nepali script */
async function translateToEnglish(query: string, ai: any): Promise<string> {
  try {
    const response = await ai.run('@cf/meta/llama-3.1-8b-instruct', {
      messages: [{
        role: 'user',
        content: `Translate this Nepali real estate query to English. Reply with ONLY the translated text, nothing else: "${query}"`
      }],
      max_tokens: 100
    });
    const translated = response?.response?.trim();
    return translated && translated.length > 0 ? translated : query;
  } catch {
    return query;
  }
}

export function detectPromptInjection(query: string): string | null {
  const lower = query.toLowerCase();
  const patterns = [
    /ignore\s+(previous|prior|above|all)\s+(instructions?|prompts?|context|rules?)/i,
    /forget\s+(previous|prior|above|all|everything|what)/i,
    /you\s+are\s+now\s+(a\s+)?(different|new|another|an?\s+)/i,
    /act\s+as\s+(a\s+)?(different|new|another|an?\s+)/i,
    /new\s+(role|persona|identity|instructions?|task|objective)/i,
    /\[system\]/i,
    /\bsystem\s*:/i,
    /\bprompt\s*:/i,
    /reveal\s+(your\s+)?(system\s+)?(prompt|instructions?|rules?|context)/i,
    /show\s+(me\s+)?(your\s+)?(system\s+)?(prompt|instructions?|rules?)/i,
    /print\s+(your\s+)?(system\s+)?(prompt|instructions?)/i,
    /bypass\s+(safety|filter|restriction|rule)/i,
    /jailbreak/i,
    /\bdann\b.*\bdoing\b/i,   // DAN jailbreak variant
    /<\|.*\|>/,               // token injection attempt
    /###\s*(instruction|system|human|assistant)/i,
  ];

  if (patterns.some(p => p.test(query))) {
    return 'Invalid query. Please search for properties using natural language, e.g. "3 bedroom house in Pokhara".';
  }
  return null;
}

export function detectRole(query: string): 'buyer' | 'seller' {
  const lower = query.toLowerCase();
  const sellerSignals = [
    // who wants / who is looking
    'who wants', 'who want', 'who is looking', 'who are looking', 'who needs',
    'who would buy', 'who would rent', 'who can buy', 'who can rent',
    // find / get a buyer or tenant
    'find a buyer', 'find me a buyer', 'find a tenant', 'find me a tenant',
    'find buyers', 'find tenants', 'find leads', 'find clients',
    'get me a buyer', 'get a buyer', 'get me a tenant', 'get a tenant',
    // anyone / someone looking
    'anyone looking', 'anyone interested', 'anyone to buy', 'anyone to rent',
    'someone who wants', 'someone looking',
    // buyer/tenant of/for something
    'a buyer of', 'a buyer for', 'a tenant for', 'a tenant of',
    'buyers for', 'buyers of', 'tenants for', 'tenants of',
    'interested buyer', 'interested tenant',
    'customer for', 'customers for',
    'leads for', 'leads of', 'clients for',
    // intent signals
    'looking to buy', 'looking to rent', 'looking to purchase',
    'interested in buying', 'interested in renting',
    'potential buyers', 'potential tenants', 'potential clients',
    'people looking', 'clients looking',
    // need/want a buyer or tenant
    'need a buyer', 'need buyer', 'need buyers',
    'need a tenant', 'need tenant', 'need tenants',
    'need a client', 'need client', 'need clients', 'need leads',
    'want a buyer', 'want buyer', 'want buyers',
    'want a tenant', 'want tenant', 'want tenants',
    // looking/searching for a buyer or tenant
    'looking for a buyer', 'looking for buyer', 'looking for buyers',
    'looking for a tenant', 'looking for tenant', 'looking for tenants',
    'looking for leads', 'looking for clients',
    'searching for a buyer', 'searching for buyer',
    'searching for a tenant', 'searching for tenant',
    // list/show
    'show buyers', 'show tenants', 'show leads',
    'list buyers', 'list tenants',
  ];
  return sellerSignals.some(s => lower.includes(s)) ? 'seller' : 'buyer';
}

export function detectListingIntent(query: string): 'sale' | 'rent' | null {
  const lower = query.toLowerCase();
  const rentWords = ['rent', 'rental', 'bhadama', 'bhada', 'kiraya', 'bhadai', 'lease', 'for rent', 'to rent', 'monthly'];
  const saleWords = ['sale', 'sell', 'buy', 'purchase', 'kinnu', 'bechnu', 'for sale', 'to buy'];
  const hasRent = rentWords.some(w => lower.includes(w));
  const hasSale = saleWords.some(w => lower.includes(w));
  if (hasRent && !hasSale) return 'rent';
  if (hasSale && !hasRent) return 'sale';
  return null;
}

function extractPropertyType(query: string): string | null {
  const lower = query.toLowerCase();
  const typeMap: Record<string, string> = {
    'house': 'house', 'ghar': 'house',
    'land': 'land', 'jagga': 'land',
    'flat': 'flat',
    'apartment': 'apartment',
    'room': 'room', 'kotha': 'room',
    'shop': 'shop', 'pasal': 'shop',
    'shutter': 'shutter',
    'office': 'office_space',
    'hotel': 'hotel',
    'bungalow': 'bungalow',
    'godown': 'godown',
    'restaurant': 'restaurant',
  };
  for (const [keyword, type] of Object.entries(typeMap)) {
    if (lower.includes(keyword)) return type;
  }
  return null;
}

export interface ParsedIntent {
  minNPR: number | null;
  maxNPR: number | null;
  bedrooms: number | null;
  minArea: number | null;       // in ropani (normalized)
  maxArea: number | null;       // in ropani (normalized)
  storeys: number | null;
  facing: string | null;        // north, south, east, west
  furnished: boolean | null;
  roadAccess: boolean | null;
  category: string | null;      // residential, commercial, agriculture
}

export function extractParsedIntent(query: string): ParsedIntent {
  const lower = query.toLowerCase();

  // Price range extraction — supports: lakh/lakhs/lac/l, crore/crores/cr, thousand/k
  // Uses literal RegExp to avoid template-literal escaping bugs
  const unitMult: Record<string, number> = {
    lakh: 100000, lakhs: 100000, lac: 100000, lacs: 100000, l: 100000,
    crore: 10000000, crores: 10000000, cr: 10000000, crs: 10000000,
    thousand: 1000, k: 1000,
  };
  const toNPR = (num: string, unit: string): number | null => {
    const val = parseFloat(num) * (unitMult[unit.toLowerCase()] ?? 1);
    return isNaN(val) ? null : val;
  };

  let minNPR: number | null = null;
  let maxNPR: number | null = null;

  // Range: "50 lakh to 1 crore", "10l-20l"
  const rangeMatch = lower.match(/(\d+(?:\.\d+)?)\s*(lakhs?|lacs?|crores?|crs?|thousand|[klL])\s*(?:to|and|-)\s*(\d+(?:\.\d+)?)\s*(lakhs?|lacs?|crores?|crs?|thousand|[klL])\b/);
  if (rangeMatch) {
    minNPR = toNPR(rangeMatch[1], rangeMatch[2]);
    maxNPR = toNPR(rangeMatch[3], rangeMatch[4]);
  } else {
    // Under: "under 1 crore", "below 50lakhs", "under a budget of 1.5 crores", "within budget of 2cr"
    const underMatch = lower.match(/(?:under|below|less\s+than|upto|up\s+to|max|maximum|within)\s*(?:a\s+)?(?:budget\s+(?:of\s+)?)?(?:npr\s*)?(\d+(?:\.\d+)?)\s*(lakhs?|lacs?|crores?|crs?|thousand|[klL])\b/);
    if (underMatch) maxNPR = toNPR(underMatch[1], underMatch[2]);

    // Budget phrasing: "budget of 1.5 crore", "budget is 2cr", "1.5 crore budget", "my budget 1cr"
    if (!maxNPR) {
      const budgetOf = lower.match(/budget\s*(?:of|is|:)?\s*(?:npr\s*)?(\d+(?:\.\d+)?)\s*(lakhs?|lacs?|crores?|crs?|thousand|[klL])\b/);
      if (budgetOf) maxNPR = toNPR(budgetOf[1], budgetOf[2]);
    }
    if (!maxNPR) {
      const budgetSuffix = lower.match(/(\d+(?:\.\d+)?)\s*(lakhs?|lacs?|crores?|crs?|thousand|[klL])\s+(?:is\s+(?:my\s+)?)?budget\b/);
      if (budgetSuffix) maxNPR = toNPR(budgetSuffix[1], budgetSuffix[2]);
    }
    if (!maxNPR) {
      const afford = lower.match(/(?:afford|spend(?:ing)?)\s+(?:up\s+to\s+)?(?:npr\s*)?(\d+(?:\.\d+)?)\s*(lakhs?|lacs?|crores?|crs?|thousand|[klL])\b/);
      if (afford) maxNPR = toNPR(afford[1], afford[2]);
    }

    // Over: "above 5cr", "over 1 crore", "more than 50 lakh"
    const overMatch = lower.match(/(?:above|over|more\s+than|minimum|min|at\s+least)\s*(?:npr\s*)?(\d+(?:\.\d+)?)\s*(lakhs?|lacs?|crores?|crs?|thousand|[klL])\b/);
    if (overMatch) minNPR = toNPR(overMatch[1], overMatch[2]);
  }

  // Bedroom extraction
  let bedrooms: number | null = null;
  const bedMatch = lower.match(/(\d+)\s*(?:bhk|bedroom[s]?|bed\s*room[s]?)/);
  if (bedMatch) {
    const v = parseInt(bedMatch[1]);
    if (!isNaN(v)) bedrooms = v;
  } else {
    const wordNums: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5 };
    for (const [word, num] of Object.entries(wordNums)) {
      if (lower.includes(`${word} bedroom`) || lower.includes(`${word} bhk`)) {
        bedrooms = num;
        break;
      }
    }
  }

  // Area extraction (normalize to ropani: 1 ropani = 5476 sq ft = 508.74 sq m = 16 aana)
  let minArea: number | null = null;
  let maxArea: number | null = null;
  const areaUnits: Record<string, number> = {
    ropani: 1, 'ropanies': 1,
    aana: 1 / 16, 'aanas': 1 / 16,
    dhur: 1 / 256, 'dhurs': 1 / 256,
    bigha: 13.31, 'bighas': 13.31,
    kattha: 0.83, 'katthas': 0.83,
    'sq ft': 1 / 5476, 'sqft': 1 / 5476, 'sq feet': 1 / 5476,
    'sq m': 1 / 508.74, 'sqm': 1 / 508.74,
  };
  const toRopani = (num: string, unit: string): number | null => {
    const val = parseFloat(num) * (areaUnits[unit.toLowerCase()] ?? 1);
    return isNaN(val) ? null : val;
  };

  const areaRange = lower.match(/(\d+(?:\.\d+)?)\s*(ropani|aana[s]?|dhur[s]?|bigha[s]?|kattha[s]?|sq\s*ft|sqft|sq\s*m|sqm)\s*(?:to|-)\s*(\d+(?:\.\d+)?)\s*(ropani|aana[s]?|dhur[s]?|bigha[s]?|kattha[s]?|sq\s*ft|sqft|sq\s*m|sqm)/);
  if (areaRange) {
    minArea = toRopani(areaRange[1], areaRange[2]);
    maxArea = toRopani(areaRange[3], areaRange[4]);
  } else {
    const underArea = lower.match(/(?:under|below|less than|upto|up to|max|within)\s*(\d+(?:\.\d+)?)\s*(ropani|aana[s]?|dhur[s]?|bigha[s]?|kattha[s]?|sq\s*ft|sqft|sq\s*m|sqm)/);
    if (underArea) maxArea = toRopani(underArea[1], underArea[2]);

    const overArea = lower.match(/(?:above|over|more than|minimum|min|at least)\s*(\d+(?:\.\d+)?)\s*(ropani|aana[s]?|dhur[s]?|bigha[s]?|kattha[s]?|sq\s*ft|sqft|sq\s*m|sqm)/);
    if (overArea) minArea = toRopani(overArea[1], overArea[2]);

    // Plain "5 ropani" without qualifier — treat as approximate target (±30%)
    if (!minArea && !maxArea) {
      const plainArea = lower.match(/(\d+(?:\.\d+)?)\s*(ropani|aana[s]?|dhur[s]?|bigha[s]?|kattha[s]?|sq\s*ft|sqft|sq\s*m|sqm)/);
      if (plainArea) {
        const target = toRopani(plainArea[1], plainArea[2]);
        if (target != null) {
          minArea = target * 0.7;
          maxArea = target * 1.3;
        }
      }
    }
  }

  // Storeys extraction
  let storeys: number | null = null;
  const storeyMatch = lower.match(/(\d+(?:\.\d+)?)\s*(?:storey[s]?|story|stories|floor[s]?|tale)/);
  if (storeyMatch) { const v = parseFloat(storeyMatch[1]); if (!isNaN(v)) storeys = v; }

  // Facing extraction
  let facing: string | null = null;
  const facingMatch = lower.match(/(?:facing|face[sd]?)\s*(north|south|east|west)/i) ||
                      lower.match(/(north|south|east|west)\s*(?:facing|face[sd]?)/i);
  if (facingMatch) facing = facingMatch[1].toLowerCase();

  // Furnished extraction
  let furnished: boolean | null = null;
  if (/\b(?:furnished|furnish)\b/.test(lower) && !/\bunfurnished\b/.test(lower)) furnished = true;
  if (/\bunfurnished\b/.test(lower)) furnished = false;

  // Road access extraction
  let roadAccess: boolean | null = null;
  if (/\b(?:road\s*access|road\s*connected|pitched|black\s*top|gravelled|concrete\s*road)\b/.test(lower)) roadAccess = true;

  // Category extraction
  let category: string | null = null;
  if (/\b(?:commercial|business|office)\b/.test(lower)) category = 'commercial';
  else if (/\b(?:agriculture|farm|farming|agricultural)\b/.test(lower)) category = 'agriculture';
  else if (/\b(?:residential|home|living)\b/.test(lower)) category = 'residential';

  return { minNPR, maxNPR, bedrooms, minArea, maxArea, storeys, facing, furnished, roadAccess, category };
}
