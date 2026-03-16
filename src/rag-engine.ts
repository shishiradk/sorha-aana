// src/rag-engine.ts
// RAG engine: vector search -> DB fetch -> AI answer generation
// Works with actual tables: sellers + rental_owners with location JOINs
// Supports proximity search via Nominatim geocoding + haversine distance
import { queryAll } from './db-utils';
import { formatPrice, priceToNPR } from './vectorize';
import { geocodeLocation, extractLocationFromQuery, haversineKm, haversineSQL } from './geocoding';

export interface Env {
  HYPERDRIVE: any;
  VECTORIZE: VectorizeIndex;
  AI: any;
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

  async searchProperties(query: string, intent?: 'sale' | 'rent' | null, parsed?: ParsedIntent): Promise<{ results: any[]; locationPhrase: string | null; geocodeFailed: boolean; outsideCoverage: boolean }> {
    console.log(`Searching: "${query}" [intent: ${intent || 'any'}]`);

    // Detect location intent and geocode
    const locationPhrase = extractLocationFromQuery(query);
    let searchCoords: { lat: number; lng: number } | null = null;
    let geocodeFailed = false;
    let outsideCoverage = false;
    if (locationPhrase) {
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
              `SELECT MIN(${distExpr}) as min_dist FROM sellers WHERE latitude IS NOT NULL AND latitude != 0`,
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
      return { results: [], locationPhrase, geocodeFailed, outsideCoverage: outsideCoverage };
    }

    // If we have coordinates, also get nearby property IDs from DB
    let nearbySellerIds: number[] = [];
    let nearbyRentalIds: number[] = [];
    const nearbyDistances = new Map<string, number>(); // key -> distance in km

    if (searchCoords) {
      const radiusKm = 5; // 5km radius
      const { lat, lng } = searchCoords;
      const distExpr = haversineSQL('latitude', 'longitude');

      // Query nearby sellers
      if (intent !== 'rent') {
        try {
          const { results: nearby } = await queryAll(this.env,
            `SELECT id, ${distExpr} as distance_km
             FROM sellers
             WHERE latitude IS NOT NULL AND longitude IS NOT NULL
             AND ${distExpr} < ?
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
            `SELECT id, ${distExpr} as distance_km
             FROM rental_owners
             WHERE latitude IS NOT NULL AND longitude IS NOT NULL
             AND ${distExpr} < ?
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
    const queryEmbedding = await this.generateQueryEmbedding(query);

    const vectorResults = queryEmbedding
      ? await this.env.VECTORIZE.query(queryEmbedding, { topK: 30, returnMetadata: 'all' })
      : { matches: [] };

    console.log(`Vector search returned ${vectorResults.matches.length} matches`);

    // Group matches by source table and ID (deduplicate main + keyword chunks)
    const sellerIds: number[] = [];
    const rentalIds: number[] = [];
    const buyerIds: number[] = [];
    const tenantIds: number[] = [];
    const agentIds: number[] = [];
    const scoreMap = new Map<string, number>();

    // Store vector scores but DON'T add to ID lists yet if location search is active
    // — vector-only results from unrelated locations will be filtered out
    for (const match of vectorResults.matches) {
      const meta = match.metadata || {} as any;
      const table = meta.source_table || 'sellers';
      const id = meta.source_id;
      if (!id) continue;

      if (intent === 'rent' && table !== 'rental_owners') continue;
      if (intent === 'sale' && table !== 'sellers') continue;
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

      if (table === 'sellers' && !sellerIds.includes(id)) sellerIds.push(id);
      if (table === 'rental_owners' && !rentalIds.includes(id)) rentalIds.push(id);
      if (table === 'buyers' && !buyerIds.includes(id)) buyerIds.push(id);
      if (table === 'tenants' && !tenantIds.includes(id)) tenantIds.push(id);
      if (table === 'agents' && !agentIds.includes(id)) agentIds.push(id);
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

      if (intent !== 'rent') {
        try {
          const fuzzy = buildFuzzySQL('property_address');
          const { results: textRows } = await queryAll(this.env,
            `SELECT id FROM sellers ${fuzzy.sql} LIMIT 20`,
            fuzzy.params
          );
          for (const r of textRows as any[]) {
            if (!sellerIds.includes(r.id)) sellerIds.push(r.id);
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
            `SELECT id FROM rental_owners ${fuzzy.sql} LIMIT 20`,
            fuzzy.params
          );
          for (const r of textRows as any[]) {
            if (!rentalIds.includes(r.id)) rentalIds.push(r.id);
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
    }

    // Step 2: Geocoding fallback — only run if text search returned few results (< 3)
    // Finds physically nearby properties even if their address name differs
    if (locationPhrase && textMatchCount < 3 && searchCoords) {
      console.log(`Text matched only ${textMatchCount} — expanding with geocoding radius`);
      for (const id of nearbySellerIds) {
        if (!sellerIds.includes(id)) sellerIds.push(id);
        const key = `sellers_${id}`;
        if (!scoreMap.has(key)) scoreMap.set(key, 0.5);
      }
      for (const id of nearbyRentalIds) {
        if (!rentalIds.includes(id)) rentalIds.push(id);
        const key = `rental_owners_${id}`;
        if (!scoreMap.has(key)) scoreMap.set(key, 0.5);
      }
    } else if (searchCoords) {
      // Even with text results, still include nearby properties for distance display
      for (const id of nearbySellerIds) {
        if (!sellerIds.includes(id)) {
          sellerIds.push(id);
          if (!scoreMap.has(`sellers_${id}`)) scoreMap.set(`sellers_${id}`, 0.5);
        }
      }
      for (const id of nearbyRentalIds) {
        if (!rentalIds.includes(id)) {
          rentalIds.push(id);
          if (!scoreMap.has(`rental_owners_${id}`)) scoreMap.set(`rental_owners_${id}`, 0.5);
        }
      }
    }

    const hasProximitySearch = searchCoords !== null;

    // Limit to top 10 unique properties
    let results: any[] = [];

    // Fetch sellers
    if (sellerIds.length > 0) {
      const ids = sellerIds.slice(0, 10);
      const placeholders = ids.map(() => '?').join(',');
      const { results: rows } = await queryAll(this.env,
        `SELECT s.*, d.name as district_name, m.name as municipality_name,
                p.name as province_name, c.name as customer_name
         FROM sellers s
         LEFT JOIN districts d ON s.district_id = d.id
         LEFT JOIN municipalities m ON s.municipal_id = m.id
         LEFT JOIN provinces p ON s.province_id = p.id
         LEFT JOIN customers c ON s.customer_id = c.id
         WHERE s.id IN (${placeholders})`,
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
          distance_km: distKm != null ? Math.round(distKm * 100) / 100 : null,
        });
      }
    }

    // Fetch rentals
    if (rentalIds.length > 0) {
      const ids = rentalIds.slice(0, 10);
      const placeholders = ids.map(() => '?').join(',');
      const { results: rows } = await queryAll(this.env,
        `SELECT ro.*, d.name as district_name, m.name as municipality_name,
                p.name as province_name, c.name as customer_name
         FROM rental_owners ro
         LEFT JOIN districts d ON ro.district_id = d.id
         LEFT JOIN municipalities m ON ro.municipal_id = m.id
         LEFT JOIN provinces p ON ro.province_id = p.id
         LEFT JOIN customers c ON ro.customer_id = c.id
         WHERE ro.id IN (${placeholders})`,
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
          similarity: scoreMap.get(`rental_owners_${row.id}`) || 0,
          distance_km: distKm != null ? Math.round(distKm * 100) / 100 : null,
        });
      }
    }

    // Fetch buyers
    if (buyerIds.length > 0) {
      const ids = buyerIds.slice(0, 10);
      const placeholders = ids.map(() => '?').join(',');
      try {
        const { results: rows } = await queryAll(this.env,
          `SELECT b.*, d.name as district_name, m.name as municipality_name,
                  c.name as customer_name, c.phone as customer_phone
           FROM buyers b
           LEFT JOIN districts d ON b.district_id = d.id
           LEFT JOIN municipalities m ON b.municipal_id = m.id
           LEFT JOIN customers c ON b.customer_id = c.id
           WHERE b.id IN (${placeholders})`, ids);
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
      } catch { /* buyers table may not exist */ }
    }

    // Fetch tenants
    if (tenantIds.length > 0) {
      const ids = tenantIds.slice(0, 10);
      const placeholders = ids.map(() => '?').join(',');
      try {
        const { results: rows } = await queryAll(this.env,
          `SELECT t.*, d.name as district_name, m.name as municipality_name,
                  c.name as customer_name, c.phone as customer_phone
           FROM tenants t
           LEFT JOIN districts d ON t.district_id = d.id
           LEFT JOIN municipalities m ON t.municipal_id = m.id
           LEFT JOIN customers c ON t.customer_id = c.id
           WHERE t.id IN (${placeholders})`, ids);
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
      } catch { /* tenants table may not exist */ }
    }

    // Fetch agents
    if (agentIds.length > 0) {
      const ids = agentIds.slice(0, 10);
      const placeholders = ids.map(() => '?').join(',');
      try {
        const { results: rows } = await queryAll(this.env,
          `SELECT * FROM agents WHERE id IN (${placeholders})`, ids);
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
      } catch { /* agents table may not exist */ }
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
      if (!s) return 0.7;
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

    // If we have text-matched results for a specific location, filter out
    // proximity-only results that don't actually match the location name
    // (prevents "properties in tanahun" from showing random Kaski nearby results)
    if (locationPhrase && textMatchedIds.size > 0) {
      results = results.filter(p => {
        const key = `${p.source_table}_${p.id}`;
        if (textMatchedIds.has(key)) return true; // text-matched — keep
        // Keep proximity results only if their address contains the location word
        const addr = (p.location || '').toLowerCase();
        const locWords = locationPhrase.toLowerCase().split(/\s+/);
        return locWords.some(w => w.length >= 3 && addr.includes(w));
      });
    }

    // Sort results based on what filters are active
    const hasPrice = !!(parsed?.minNPR || parsed?.maxNPR);
    const hasFeatureFilters = !!(parsed?.minArea || parsed?.maxArea || parsed?.storeys || parsed?.facing || parsed?.furnished !== null && parsed?.furnished !== undefined || parsed?.roadAccess || parsed?.category);

    if (hasProximitySearch && (hasPrice || hasFeatureFilters)) {
      // Location + filters: filters are top priority within location
      results.sort((a, b) => {
        const aScore = 0.1 * a.similarity + 0.2 * proxScore(a) + 0.1 * typeScore(a) + 0.25 * priceScore(a) + 0.1 * bedroomScore(a) + 0.25 * featureScore(a);
        const bScore = 0.1 * b.similarity + 0.2 * proxScore(b) + 0.1 * typeScore(b) + 0.25 * priceScore(b) + 0.1 * bedroomScore(b) + 0.25 * featureScore(b);
        return bScore - aScore;
      });
    } else if (hasProximitySearch) {
      // Location only: proximity + similarity
      results.sort((a, b) => {
        const aScore = 0.2 * a.similarity + 0.3 * proxScore(a) + 0.2 * typeScore(a) + 0.1 * priceScore(a) + 0.1 * bedroomScore(a) + 0.1 * featureScore(a);
        const bScore = 0.2 * b.similarity + 0.3 * proxScore(b) + 0.2 * typeScore(b) + 0.1 * priceScore(b) + 0.1 * bedroomScore(b) + 0.1 * featureScore(b);
        return bScore - aScore;
      });
    } else if (hasPrice || hasFeatureFilters) {
      // Filters only: filters are top priority
      results.sort((a, b) => {
        const aScore = 0.15 * a.similarity + 0.1 * typeScore(a) + 0.3 * priceScore(a) + 0.15 * bedroomScore(a) + 0.3 * featureScore(a);
        const bScore = 0.15 * b.similarity + 0.1 * typeScore(b) + 0.3 * priceScore(b) + 0.15 * bedroomScore(b) + 0.3 * featureScore(b);
        return bScore - aScore;
      });
    } else {
      // Default: sort by similarity + type + price/bedroom fit
      results.sort((a, b) => {
        const aScore = 0.5 * a.similarity + 0.2 * typeScore(a) + 0.1 * priceScore(a) + 0.1 * bedroomScore(a) + 0.1 * featureScore(a);
        const bScore = 0.5 * b.similarity + 0.2 * typeScore(b) + 0.1 * priceScore(b) + 0.1 * bedroomScore(b) + 0.1 * featureScore(b);
        return bScore - aScore;
      });
    }

    return { results, locationPhrase, geocodeFailed, outsideCoverage };
  }

  async generateAnswer(question: string, properties: any[], intent?: 'sale' | 'rent' | null, parsed?: ParsedIntent, locationCtx?: { locationPhrase: string | null; geocodeFailed: boolean; outsideCoverage: boolean }): Promise<string> {
    if (properties.length === 0) {
      // Location is outside Kaski district — we only cover Kaski
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
        `${i + 1}. ${p.title}`,
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
        p.phone ? `   Contact: ${p.phone}` : null,
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

    const prompt = `You are Sorha Aana, a real estate assistant for Kaski district, Nepal.

User query: "${question}"
${listingTypeNote}
${parsedNote}

Matching properties from the database:
${context}

INSTRUCTIONS:
- Use ONLY the property data above. Never invent or assume any details.
- Reply in English only.
${locationOnly ? `- The user searched by LOCATION ONLY. List ALL the properties shown above — give a brief summary of each (type, price, area). Do not skip any.
- Group by property type if there are many (e.g., "Houses:", "Land:", "Rentals:").
- At the end, mention the total count (e.g., "Found 12 properties in Kaukhola").` : hasFilters && locationCtx?.locationPhrase ? `- The user searched by LOCATION + FILTERS (price/area/bedrooms/features). Prioritize properties that match the filters.
- Highlight the best filter matches first, then mention others that are in the location but don't match.
- Clearly state each property's price, area, bedrooms, and other relevant details.` : hasFilters ? `- The user searched with FILTERS (price/area/bedrooms/features). Show properties that best match.
- Prioritize filter-matched properties. Clearly state relevant details for each.` : `- Highlight the 2-3 best matches and briefly explain why each fits the user's request (location, price, type, size).`}
- If price or bedroom filters were parsed above, explicitly state whether each property fits.
- If distance data is available, mention how far each property is from the searched location.
- If a property is within 1 km, note it as "very close".
- Show prices exactly as listed. Do not convert or estimate.
- If the user asked for rentals but a property is for sale (or vice versa), mention that clearly.
- If no properties are a good fit, say so and suggest how to adjust the search.
- Be concise. Do not repeat the same property details twice.
- Never use emojis.
- End with a short list: source table and ID for each property mentioned.`;

    try {
      const response = await this.env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
        messages: [{ role: 'user', content: prompt }]
      });
      return response.response;
    } catch (e) {
      console.error('AI generation failed:', e);
      return 'I found matching properties shown below, but I am having trouble generating a detailed analysis right now.';
    }
  }

  async query(question: string): Promise<any> {
    const intent = detectListingIntent(question);
    const parsed = extractParsedIntent(question);
    const { results: properties, locationPhrase, geocodeFailed, outsideCoverage } = await this.searchProperties(question, intent, parsed);
    const generatedAnswer = await this.generateAnswer(question, properties, intent, parsed, { locationPhrase, geocodeFailed, outsideCoverage });

    return {
      query: question,
      answer: generatedAnswer,
      properties,
      total_results: properties.length,
      listing_intent: intent || 'any'
    };
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

function detectListingIntent(query: string): 'sale' | 'rent' | null {
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

  // Price range extraction
  const unitMult: Record<string, number> = {
    lakh: 100000, lakhs: 100000,
    crore: 10000000, crores: 10000000,
    thousand: 1000, k: 1000,
  };
  const toNPR = (num: string, unit: string) => parseFloat(num) * (unitMult[unit.toLowerCase()] ?? 1);

  let minNPR: number | null = null;
  let maxNPR: number | null = null;

  const rangeMatch = lower.match(/(\d+(?:\.\d+)?)\s*(lakhs?|crores?|thousand|k)\s*(?:to|and|-)\s*(\d+(?:\.\d+)?)\s*(lakhs?|crores?|thousand|k)/);
  if (rangeMatch) {
    minNPR = toNPR(rangeMatch[1], rangeMatch[2]);
    maxNPR = toNPR(rangeMatch[3], rangeMatch[4]);
  } else {
    const underMatch = lower.match(/(?:under|below|less than|upto|up to|max|maximum)\s*(?:npr\s*)?(\d+(?:\.\d+)?)\s*(lakhs?|crores?|thousand|k)/);
    if (underMatch) maxNPR = toNPR(underMatch[1], underMatch[2]);

    const overMatch = lower.match(/(?:above|over|more than|minimum|min|at least)\s*(?:npr\s*)?(\d+(?:\.\d+)?)\s*(lakhs?|crores?|thousand|k)/);
    if (overMatch) minNPR = toNPR(overMatch[1], overMatch[2]);
  }

  // Bedroom extraction
  let bedrooms: number | null = null;
  const bedMatch = lower.match(/(\d+)\s*(?:bhk|bedroom[s]?|bed\s*room[s]?)/);
  if (bedMatch) {
    bedrooms = parseInt(bedMatch[1]);
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
  const toRopani = (num: string, unit: string): number => parseFloat(num) * (areaUnits[unit.toLowerCase()] ?? 1);

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
        minArea = target * 0.7;
        maxArea = target * 1.3;
      }
    }
  }

  // Storeys extraction
  let storeys: number | null = null;
  const storeyMatch = lower.match(/(\d+(?:\.\d+)?)\s*(?:storey[s]?|story|stories|floor[s]?|tale)/);
  if (storeyMatch) storeys = parseFloat(storeyMatch[1]);

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
