// src/vectorize.ts
// Vectorization engine for the sorha-aana real estate database
// Works with actual tables: sellers, rental_owners + location lookups
import { queryAll, queryOne, queryExecute } from './db-utils';

export interface Env {
  HYPERDRIVE: any;
  VECTORIZE: VectorizeIndex;
  AI: any;
}

// -- Helpers --

function parseJsonField(field: any): string[] {
  if (!field) return [];
  if (Array.isArray(field)) return field.filter(item => item && typeof item === 'string');
  if (typeof field === 'string') {
    if (field.startsWith('[')) {
      try {
        const parsed = JSON.parse(field);
        return Array.isArray(parsed) ? parsed.filter(item => item && typeof item === 'string') : [field];
      } catch {
        return [field];
      }
    }
    return field.trim() ? [field] : [];
  }
  return [];
}

/** Normalize price: "3" + "CRORE" -> "NPR 3 Crore" */
export function formatPrice(price: string | number | null, unit: string | null): string {
  if (!price) return 'Price not specified';
  const p = String(price).trim();
  const u = (unit || '').trim();
  if (!u) return `NPR ${p}`;
  const unitLabel = u === 'CRORE' ? 'Crore' : u === 'LAKHS' ? 'Lakhs' : u === 'THOUSAND' ? 'Thousand' : u;
  return `NPR ${p} ${unitLabel}`;
}

/** Parse NPR amount to numeric for metadata filtering */
export function priceToNPR(price: string | number | null, unit: string | null): number {
  const p = parseFloat(String(price || '0'));
  if (isNaN(p)) return 0;
  switch ((unit || '').toUpperCase()) {
    case 'CRORE': return p * 10000000;
    case 'LAKHS': return p * 100000;
    case 'THOUSAND': return p * 1000;
    default: return p;
  }
}

/** Build location text from address + lookup names */
function buildLocation(row: any): string {
  const parts = [
    row.property_address || row.address,
    row.city,
    row.municipality_name,
    row.district_name,
    row.province_name,
    row.ward_num ? `Ward ${row.ward_num}` : null
  ].filter(Boolean);
  return parts.join(', ') || 'Location not specified';
}

/** Format area text: "6.5" + "AANA" -> "6.5 Aana" */
function formatArea(area: string | null, unit: string | null): string {
  if (!area || area === '0') return '';
  const u = (unit || '').replace(/_/g, ' ');
  const unitLabel: Record<string, string> = {
    'HAAT': 'Haat', 'AANA': 'Aana', 'ROPANI': 'Ropani',
    'SQUARE METER': 'sq m', 'SQUARE FEET': 'sq ft',
    'BIGHA': 'Bigha', 'KATTHA': 'Kattha', 'DHUR': 'Dhur'
  };
  return `${area} ${unitLabel[u] || u}`.trim();
}

/** Parse layout string like "5BHK" into bedroom count */
function parseBHK(layout: string | null): number | null {
  if (!layout) return null;
  const match = layout.match(/(\d+)\s*(?:BHK|R)/i);
  return match ? parseInt(match[1]) : null;
}

/** Format enum values: "NORTH-EAST" -> "North-East", "SOIL-STABILIZED" -> "Soil-Stabilized" */
function formatEnum(val: string | null): string {
  if (!val) return '';
  return val.split(/[-_]/).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join('-');
}

// -- Chunking --

/** Base query to fetch sellers with location JOINs */
const SELLERS_BASE_QUERY = `
  SELECT s.*,
         d.name as district_name,
         m.name as municipality_name,
         p.name as province_name,
         c.name as customer_name
  FROM sellers s
  LEFT JOIN districts d ON s.district_id = d.id
  LEFT JOIN municipalities m ON s.municipal_id = m.id
  LEFT JOIN provinces p ON s.province_id = p.id
  LEFT JOIN customers c ON s.customer_id = c.id
`;

/** Base query to fetch rental properties with location JOINs */
const RENTALS_BASE_QUERY = `
  SELECT ro.*,
         d.name as district_name,
         m.name as municipality_name,
         p.name as province_name,
         c.name as customer_name
  FROM rental_owners ro
  LEFT JOIN districts d ON ro.district_id = d.id
  LEFT JOIN municipalities m ON ro.municipal_id = m.id
  LEFT JOIN provinces p ON ro.province_id = p.id
  LEFT JOIN customers c ON ro.customer_id = c.id
`;

export function createSellerChunks(property: any): Array<{
  id: string;
  text: string;
  type: string;
  metadata: any;
}> {
  const chunks = [];
  const id = property.id;
  const location = buildLocation(property);
  const priceText = formatPrice(property.property_price, property.property_price_unit);
  const priceNPR = priceToNPR(property.property_price, property.property_price_unit);
  const area = formatArea(property.property_area, property.area_unit);
  const houseArea = formatArea(property.house_area, null);
  const landArea = formatArea(property.land_area, null);
  const bhk = parseBHK(property.layout);
  const amenities = parseJsonField(property.amenities);
  const face = formatEnum(property.property_face);
  const roadType = formatEnum(property.road_type);
  const category = formatEnum(property.property_category);
  const propType = formatEnum(property.property_type);

  // Construct a descriptive title from type + address
  const title = `${propType} for Sale in ${property.property_address || property.district_name || 'Nepal'}`;

  // Chunk 1: Main property information
  const mainParts = [
    `Property: ${title}`,
    `Type: ${propType} (${category})`,
    `Listing: For Sale`,
    `Location: ${location}`,
    `Price: ${priceText}`,
    area ? `Land Area: ${area}` : null,
    houseArea ? `House Area: ${houseArea}` : null,
    landArea ? `Land Size: ${landArea}` : null,
    property.layout ? `Layout: ${property.layout}` : null,
    bhk ? `Bedrooms: ${bhk}` : null,
    property.house_storey ? `Storeys: ${property.house_storey}` : null,
    face ? `Facing: ${face}` : null,
    property.road_size ? `Road Access: ${property.road_size} feet ${roadType} road` : null,
    property.furnished ? `Furnished: ${property.furnished}` : null,
    property.compound ? `Compound: ${property.compound}` : null,
    property.parking_space ? `Parking: ${property.parking_space}` : null,
    amenities.length ? `Amenities: ${amenities.join(', ')}` : null,
    property.property_remarks ? `Details: ${String(property.property_remarks).substring(0, 300)}` : null,
    property.address_remarks ? `Address Notes: ${String(property.address_remarks).substring(0, 200)}` : null
  ].filter(Boolean);

  chunks.push({
    id: `seller_${id}_main`,
    text: mainParts.join(' | ').substring(0, 2000),
    type: 'main',
    metadata: {
      source_table: 'sellers',
      source_id: id,
      listing_type: 'sale',
      property_type: property.property_type,
      property_category: property.property_category,
      district: property.district_name || null,
      municipality: property.municipality_name || null,
      city: property.city || null,
      price_npr: priceNPR,
      price_unit: property.property_price_unit,
      area_unit: property.area_unit,
      layout: property.layout,
      furnished: property.furnished,
      property_face: property.property_face,
    }
  });

  // Chunk 2: Search keywords
  const keywords = [
    propType, category, 'for sale',
    property.property_address, property.city,
    property.district_name, property.municipality_name,
    property.layout, face, property.furnished,
    property.road_type, property.parking_space,
    ...amenities,
    area, priceText, landArea, houseArea,
    bhk ? `${bhk} bedroom` : null,
    property.house_storey ? `${property.house_storey} storey` : null
  ].filter(Boolean).join(' ');

  chunks.push({
    id: `seller_${id}_keywords`,
    text: keywords.substring(0, 2000),
    type: 'search',
    metadata: {
      source_table: 'sellers',
      source_id: id,
      listing_type: 'sale',
    }
  });

  return chunks;
}

export function createRentalChunks(rental: any): Array<{
  id: string;
  text: string;
  type: string;
  metadata: any;
}> {
  const chunks = [];
  const id = rental.id;
  const location = buildLocation(rental);
  const area = formatArea(rental.property_area, rental.area_unit);
  const face = formatEnum(rental.property_face);
  const roadType = formatEnum(rental.road_type);
  const category = formatEnum(rental.category);
  const propType = formatEnum(rental.property_type);
  const amenities = parseJsonField(rental.amenities);
  const rentAmount = rental.rent_amount ? `NPR ${Number(rental.rent_amount).toLocaleString()}/month` : 'Rent negotiable';

  const title = `${propType} for Rent in ${rental.address || rental.district_name || 'Nepal'}`;

  const mainParts = [
    `Property: ${title}`,
    `Type: ${propType} (${category})`,
    `Listing: For Rent`,
    `Location: ${location}`,
    `Rent: ${rentAmount}`,
    area ? `Area: ${area}` : null,
    rental.layout ? `Layout: ${rental.layout}` : null,
    rental.bedroom ? `Bedrooms: ${rental.bedroom}` : null,
    rental.kitchen ? `Kitchen: ${rental.kitchen}` : null,
    rental.living_room ? `Living Room: ${rental.living_room}` : null,
    face ? `Facing: ${face}` : null,
    rental.road_size ? `Road: ${rental.road_size} feet ${roadType}` : null,
    rental.rental_purpose ? `Purpose: ${rental.rental_purpose}` : null,
    rental.stay_period ? `Stay Period: ${rental.stay_period} months` : null,
    amenities.length ? `Amenities: ${amenities.join(', ')}` : null,
    rental.remarks ? `Details: ${String(rental.remarks).substring(0, 300)}` : null
  ].filter(Boolean);

  chunks.push({
    id: `rental_${id}_main`,
    text: mainParts.join(' | ').substring(0, 2000),
    type: 'main',
    metadata: {
      source_table: 'rental_owners',
      source_id: id,
      listing_type: 'rent',
      property_type: rental.property_type,
      property_category: rental.category,
      district: rental.district_name || null,
      city: rental.city || null,
      rent_amount: rental.rent_amount || 0,
      bedroom: rental.bedroom || 0,
      area_unit: rental.area_unit,
      property_face: rental.property_face,
    }
  });

  // Search keywords chunk
  const keywords = [
    propType, category, 'for rent', 'rental',
    rental.address, rental.city,
    rental.district_name, rental.municipality_name,
    rental.layout, face,
    rental.road_type, rental.parking_space,
    ...amenities,
    area, rentAmount,
    rental.bedroom ? `${rental.bedroom} bedroom` : null,
    rental.rental_purpose
  ].filter(Boolean).join(' ');

  chunks.push({
    id: `rental_${id}_keywords`,
    text: keywords.substring(0, 2000),
    type: 'search',
    metadata: {
      source_table: 'rental_owners',
      source_id: id,
      listing_type: 'rent',
    }
  });

  return chunks;
}

// -- Embedding --

export async function generateEmbedding(text: string, env: Env): Promise<number[]> {
  try {
    const response = await env.AI.run('@cf/baai/bge-large-en-v1.5', {
      text: text.substring(0, 2000)
    });
    if (response?.data?.[0]) return response.data[0];
    throw new Error('Invalid embedding response format');
  } catch (error) {
    console.error('Error generating embedding:', error);
    throw error;
  }
}

// -- Main vectorization --

export async function vectorizeProperties(env: Env, incrementalOnly: boolean = true): Promise<{
  success: boolean;
  indexed: number;
  errors: string[];
  properties_processed: number;
  properties_skipped: number;
  vectorization_mode: string;
}> {
  const errors: string[] = [];
  let indexedCount = 0;
  let propertiesProcessed = 0;
  let propertiesSkipped = 0;
  const startTime = Date.now();

  try {
    console.log(`\n${'='.repeat(80)}`);
    console.log(`VECTORIZATION STARTED - Mode: ${incrementalOnly ? 'INCREMENTAL' : 'FULL REINDEX'}`);
    console.log(`${'='.repeat(80)}\n`);

    // ── Sellers (properties for sale) ──
    let sellerQuery = SELLERS_BASE_QUERY + ` WHERE s.status = 'ACTIVE'`;
    if (incrementalOnly) {
      sellerQuery += ` AND (s.is_vectorized_complete IS NULL OR s.is_vectorized_complete = FALSE
                        OR s.updated_at > s.last_vectorized_at)`;
    }
    sellerQuery += ` ORDER BY s.id ASC`;

    let sellers: any[] = [];
    try {
      const res = await queryAll<any>(env, sellerQuery);
      sellers = res.results || [];
    } catch (e: any) {
      // If tracking columns don't exist yet, fall back to simple query
      if (e.message.includes('Unknown column')) {
        console.log('Tracking columns not found, falling back to full query...');
        const fallback = SELLERS_BASE_QUERY + ` WHERE s.status = 'ACTIVE' ORDER BY s.id ASC`;
        const res = await queryAll<any>(env, fallback);
        sellers = res.results || [];
      } else throw e;
    }

    // ── Rental owners ──
    let rentalQuery = RENTALS_BASE_QUERY + ` WHERE ro.status = 'ACTIVE'`;
    if (incrementalOnly) {
      rentalQuery += ` AND (ro.is_vectorized_complete IS NULL OR ro.is_vectorized_complete = FALSE
                        OR ro.updated_at > ro.last_vectorized_at)`;
    }
    rentalQuery += ` ORDER BY ro.id ASC`;

    let rentals: any[] = [];
    try {
      const res = await queryAll<any>(env, rentalQuery);
      rentals = res.results || [];
    } catch (e: any) {
      if (e.message.includes('Unknown column')) {
        const fallback = RENTALS_BASE_QUERY + ` WHERE ro.status = 'ACTIVE' ORDER BY ro.id ASC`;
        const res = await queryAll<any>(env, fallback);
        rentals = res.results || [];
      } else throw e;
    }

    const totalItems = sellers.length + rentals.length;
    if (totalItems === 0) {
      console.log('No properties need vectorization at this time.');
      return { success: true, indexed: 0, errors: [], properties_processed: 0, properties_skipped: 0, vectorization_mode: incrementalOnly ? 'incremental' : 'full' };
    }

    console.log(`Found ${sellers.length} sellers + ${rentals.length} rentals to vectorize\n`);

    // Process sellers
    await processBatch(sellers, 'sellers', (row: any) => createSellerChunks(row), env, errors, (counts) => {
      indexedCount += counts.indexed;
      propertiesProcessed += counts.processed;
      propertiesSkipped += counts.skipped;
    });

    // Process rentals
    await processBatch(rentals, 'rental_owners', (row: any) => createRentalChunks(row), env, errors, (counts) => {
      indexedCount += counts.indexed;
      propertiesProcessed += counts.processed;
      propertiesSkipped += counts.skipped;
    });

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log('\n' + '='.repeat(80));
    console.log('VECTORIZATION COMPLETE');
    console.log('='.repeat(80));
    console.log(`Properties processed: ${propertiesProcessed}`);
    console.log(`Properties skipped: ${propertiesSkipped}`);
    console.log(`Total vectors indexed: ${indexedCount}`);
    console.log(`Errors: ${errors.length}`);
    console.log(`Duration: ${duration}s`);

    if (errors.length > 0) {
      console.log('\nERRORS:');
      errors.slice(0, 10).forEach((err, i) => console.log(`${i + 1}. ${err.substring(0, 100)}`));
    }

    return {
      success: errors.length === 0,
      indexed: indexedCount,
      errors,
      properties_processed: propertiesProcessed,
      properties_skipped: propertiesSkipped,
      vectorization_mode: incrementalOnly ? 'incremental' : 'full'
    };

  } catch (error: any) {
    console.error('FATAL VECTORIZATION ERROR:', error.message);
    return {
      success: false,
      indexed: indexedCount,
      errors: [...errors, `Fatal error: ${error.message}`],
      properties_processed: propertiesProcessed,
      properties_skipped: propertiesSkipped,
      vectorization_mode: incrementalOnly ? 'incremental' : 'full'
    };
  }
}

/** Process a batch of rows (sellers or rentals) through vectorization */
async function processBatch(
  rows: any[],
  tableName: string,
  chunkFn: (row: any) => Array<{ id: string; text: string; type: string; metadata: any }>,
  env: Env,
  errors: string[],
  onCounts: (counts: { indexed: number; processed: number; skipped: number }) => void
) {
  const BATCH_SIZE = 10;
  let indexed = 0, processed = 0, skipped = 0;

  for (let batchStart = 0; batchStart < rows.length; batchStart += BATCH_SIZE) {
    const batchEnd = Math.min(batchStart + BATCH_SIZE, rows.length);
    const batch = rows.slice(batchStart, batchEnd);
    console.log(`\n[${tableName}] Batch ${Math.floor(batchStart / BATCH_SIZE) + 1}/${Math.ceil(rows.length / BATCH_SIZE)} (${batch.length} rows)`);

    for (const row of batch) {
      const rowId = row.id;
      try {
        const chunks = chunkFn(row);
        const vectors = [];

        for (const chunk of chunks) {
          try {
            const embedding = await generateEmbedding(chunk.text, env);
            vectors.push({
              id: chunk.id,
              values: embedding,
              metadata: {
                ...chunk.metadata,
                chunk_type: chunk.type,
                vectorized_at: new Date().toISOString()
              }
            });
          } catch (chunkErr: any) {
            errors.push(`Embedding error for ${chunk.id}: ${chunkErr.message}`);
          }
        }

        if (vectors.length > 0) {
          await env.VECTORIZE.upsert(vectors);

          // Try to update tracking columns (may not exist yet)
          try {
            await queryExecute(env,
              `UPDATE ${tableName}
               SET is_vectorized_complete = TRUE,
                   last_vectorized_at = NOW(),
                   vectorization_error_message = NULL
               WHERE id = ?`,
              [rowId]
            );
          } catch {
            // Tracking columns may not exist yet — that's OK
          }

          indexed += vectors.length;
          processed++;
          console.log(`  ${rowId} -> ${vectors.length} vectors`);
        } else {
          skipped++;
        }

        await new Promise(resolve => setTimeout(resolve, 100));
      } catch (err: any) {
        errors.push(`Error processing ${tableName} #${rowId}: ${err.message}`);
        skipped++;
      }
    }

    if (batchEnd < rows.length) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  onCounts({ indexed, processed, skipped });
}

// -- Single property vectorization --

export async function vectorizeSingleProperty(
  env: Env,
  propertyId: string,
  table: 'sellers' | 'rental_owners' = 'sellers'
): Promise<{ success: boolean; vectors_indexed: number; error?: string }> {
  try {
    const baseQuery = table === 'sellers' ? SELLERS_BASE_QUERY : RENTALS_BASE_QUERY;
    const alias = table === 'sellers' ? 's' : 'ro';
    const property = await queryOne<any>(env, `${baseQuery} WHERE ${alias}.id = ?`, [propertyId]);

    if (!property) {
      return { success: false, vectors_indexed: 0, error: `${table} #${propertyId} not found` };
    }

    const chunks = table === 'sellers'
      ? createSellerChunks(property)
      : createRentalChunks(property);

    const vectors = [];
    for (const chunk of chunks) {
      const embedding = await generateEmbedding(chunk.text, env);
      vectors.push({
        id: chunk.id,
        values: embedding,
        metadata: {
          ...chunk.metadata,
          chunk_type: chunk.type,
          vectorized_at: new Date().toISOString()
        }
      });
    }

    if (vectors.length > 0) {
      await env.VECTORIZE.upsert(vectors);
      try {
        await queryExecute(env,
          `UPDATE ${table} SET is_vectorized_complete = TRUE, last_vectorized_at = NOW(), vectorization_error_message = NULL WHERE id = ?`,
          [propertyId]
        );
      } catch { /* tracking columns may not exist */ }
    }

    return { success: true, vectors_indexed: vectors.length };
  } catch (error: any) {
    const errorMsg = error.message || String(error);
    try {
      await queryExecute(env, `UPDATE ${table} SET vectorization_error_message = ? WHERE id = ?`, [errorMsg.substring(0, 255), propertyId]);
    } catch { /* ignore */ }
    return { success: false, vectors_indexed: 0, error: errorMsg };
  }
}

// -- Status --

export async function getVectorizationStatus(env: Env): Promise<{
  total_properties: number;
  vectorized: number;
  pending: number;
  failed: number;
  last_vectorized_property?: string;
}> {
  try {
    // Try with tracking columns first
    try {
      const stats = await queryAll<any>(env,
        `SELECT
           COUNT(*) as total,
           SUM(CASE WHEN is_vectorized_complete = TRUE THEN 1 ELSE 0 END) as vectorized,
           SUM(CASE WHEN is_vectorized_complete IS NULL OR is_vectorized_complete = FALSE THEN 1 ELSE 0 END) as pending,
           SUM(CASE WHEN vectorization_error_message IS NOT NULL THEN 1 ELSE 0 END) as failed
         FROM sellers WHERE status = 'ACTIVE'`
      );
      const row = stats.results[0] as any;
      const last = await queryOne<any>(env,
        `SELECT id FROM sellers WHERE is_vectorized_complete = TRUE ORDER BY last_vectorized_at DESC LIMIT 1`
      );
      return {
        total_properties: Number(row.total) || 0,
        vectorized: Number(row.vectorized) || 0,
        pending: Number(row.pending) || 0,
        failed: Number(row.failed) || 0,
        last_vectorized_property: last ? String(last.id) : undefined
      };
    } catch {
      // Tracking columns don't exist — return basic count
      const stats = await queryAll<any>(env,
        `SELECT COUNT(*) as total FROM sellers WHERE status = 'ACTIVE'`
      );
      const total = Number(stats.results[0]?.total) || 0;
      return {
        total_properties: total,
        vectorized: 0,
        pending: total,
        failed: 0,
        last_vectorized_property: undefined
      };
    }
  } catch (error: any) {
    console.error('Error getting vectorization status:', error);
    throw error;
  }
}
