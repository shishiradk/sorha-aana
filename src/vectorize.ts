// src/vectorize.ts
import { queryAll, queryOne, queryExecute } from './db-utils';

export interface Env {
  HYPERDRIVE: any; // Hyperdrive MySQL connection
  VECTORIZE: VectorizeIndex;
  AI: any;
}

// Helper function to parse JSON fields safely
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

// Optimized chunking strategy (2-3 chunks per property for better semantic meaning)
export function createPropertyChunks(property: any): Array<{
  id: string;
  text: string;
  type: string;
  metadata: any;
}> {
  const chunks = [];
  const propertyId = property.property_id;

  // Parse all JSON fields
  const amenities = parseJsonField(property.amenities);
  const highlights = parseJsonField(property.highlights);
  const suitableFor = parseJsonField(property.suitable_for);

  // Chunk 1: Core Property Information + Description (Combined for better context)
  const specs = [];
  if (property.bedrooms) specs.push(`${property.bedrooms} bedrooms`);
  if (property.bathrooms) specs.push(`${property.bathrooms} bathrooms`);

  chunks.push({
    id: `${propertyId}_main`,
    text: `
      Property: ${property.title}
      Type: ${property.property_type} for ${property.listing_type}
      Location: ${property.city} - ${property.area}
      Price: ${property.price} NPR (Negotiable: ${property.negotiable ? 'Yes' : 'No'})
      Specifications: ${specs.join(', ')}
      Built-up Area: ${property.built_up_area} sq ft
      Furnishing: ${property.furnishing_status || 'Not specified'}
      
      Description: ${property.description}
      Amenities: ${amenities.join(', ') || 'Standard'}
      Highlights: ${highlights.join(', ') || 'None'}
      Suitable For: ${suitableFor.join(', ') || 'Families and investors'}
      
      Nearby: ${property.nearby_landmarks || 'Central location'}
    `.replace(/\s+/g, ' ').trim(),
    type: 'main',
    metadata: {
      property_id: propertyId,
      property_type: property.property_type,
      listing_type: property.listing_type,
      city: property.city,
      area: property.area,
      price: property.price,
      bedrooms: property.bedrooms || 0,
      bathrooms: property.bathrooms || 0,
      built_up_area: property.built_up_area,
      furnishing_status: property.furnishing_status
    }
  });

  // Chunk 2: Search-optimized Keywords (for semantic search matching)
  const searchKeywords = [
    property.property_type,
    property.listing_type,
    property.city,
    property.area,
    property.furnishing_status,
    ...amenities,
    ...highlights,
    ...suitableFor,
    property.nearby_landmarks
  ].filter(Boolean).join(' ');

  chunks.push({
    id: `${propertyId}_keywords`,
    text: `
      ${searchKeywords}
      ${property.bedrooms}-bedroom ${property.bathrooms}-bathroom ${property.city}
      ${property.price} price range real estate
    `.replace(/\s+/g, ' ').trim(),
    type: 'search',
    metadata: {
      property_id: propertyId,
      searchable_keywords: searchKeywords.split(' ').filter(Boolean)
    }
  });

  return chunks;
}

// Generate embedding using Cloudflare AI
export async function generateEmbedding(text: string, env: Env): Promise<number[]> {
  try {
    const response = await env.AI.run('@cf/baai/bge-large-en-v1.5', {
      text: text.substring(0, 2000) // Limit text length
    });

    if (response && response.data && Array.isArray(response.data) && response.data.length > 0) {
      return response.data[0]; // 1024 dimensions
    }
    throw new Error('Invalid embedding response format');
  } catch (error) {
    console.error('Error generating embedding:', error);
    throw error; // Re-throw to be handled by caller
  }
}

// Main vectorization function - now with incremental updates
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

    // Fetch properties that need vectorization
    let sqlQuery = `SELECT * FROM seller_listings`;
    if (incrementalOnly) {
      sqlQuery += ` WHERE is_vectorized_complete = FALSE OR last_modified_at > last_vectorized_at`;
    }
    sqlQuery += ` ORDER BY property_id ASC`;

    const { results: properties } = await queryAll<any>(env, sqlQuery);

    if (!properties || properties.length === 0) {
      console.log('ℹ️  No properties need vectorization at this time.');
      return {
        success: true,
        indexed: 0,
        errors: [],
        properties_processed: 0,
        properties_skipped: 0,
        vectorization_mode: incrementalOnly ? 'incremental' : 'full'
      };
    }

    console.log(`Found ${properties.length} properties to vectorize\n`);

    // Process properties in batches (better than sequential)
    const BATCH_SIZE = 10;
    for (let batchStart = 0; batchStart < properties.length; batchStart += BATCH_SIZE) {
      const batchEnd = Math.min(batchStart + BATCH_SIZE, properties.length);
      const batch = properties.slice(batchStart, batchEnd);

      console.log(`\nProcessing batch ${Math.floor(batchStart / BATCH_SIZE) + 1}/${Math.ceil(properties.length / BATCH_SIZE)} (${batch.length} properties)`);

      for (const property of batch) {
        const propertyId = property.property_id;

        try {
          // Create chunks for this property
          const chunks = createPropertyChunks(property);
          console.log(`  ✓ ${propertyId} (${property.title.substring(0, 40)}...)`);

          // Prepare vectors for upsert
          const vectors = [];

          for (const chunk of chunks) {
            try {
              // Generate embedding for chunk text
              const embedding = await generateEmbedding(chunk.text, env);

              vectors.push({
                id: `${chunk.id}`,
                values: embedding,
                metadata: {
                  ...chunk.metadata,
                  chunk_type: chunk.type,
                  title: property.title,
                  listing_code: property.listing_code,
                  vector_version: (property.vector_version || 0) + 1,
                  vectorized_at: new Date().toISOString()
                }
              });

            } catch (chunkError: any) {
              const errorMsg = `Error generating embedding for ${chunk.type} chunk of ${propertyId}: ${chunkError.message}`;
              errors.push(errorMsg);
              console.error(`    ✗ ${errorMsg}`);
            }
          }

          // Upsert vectors to Vectorize index
          if (vectors.length > 0) {
            try {
              await env.VECTORIZE.upsert(vectors);

              // Update database tracking
              await queryExecute(
                env,
                `UPDATE seller_listings 
                 SET is_vectorized_complete = TRUE, 
                     last_vectorized_at = NOW(),
                     vectorization_error_message = NULL,
                     vector_version = vector_version + 1
                 WHERE property_id = ?`,
                [propertyId]
              );

              indexedCount += vectors.length;
              propertiesProcessed++;
              console.log(`      → Indexed ${vectors.length} vectors`);

            } catch (upsertError: any) {
              const errorMsg = `Error upserting vectors for ${propertyId}: ${upsertError.message}`;
              errors.push(errorMsg);

              // Store error in database
              await queryExecute(
                env,
                `UPDATE seller_listings 
                 SET vectorization_error_message = ?
                 WHERE property_id = ?`,
                [errorMsg.substring(0, 255), propertyId]
              ).catch(e => console.warn(`Failed to log error: ${e.message}`));

              console.error(`    ✗ ${errorMsg}`);
            }
          } else {
            console.log(`    ⚠️  No chunks created for ${propertyId}`);
            propertiesSkipped++;
          }

          // Rate limiting: small delay between properties
          await new Promise(resolve => setTimeout(resolve, 100));

        } catch (propertyError: any) {
          const errorMsg = `Error processing property ${propertyId}: ${propertyError.message}`;
          errors.push(errorMsg);
          console.error(`  ✗ ${errorMsg}`);
          propertiesSkipped++;
        }
      }

      // Batch delay (more generous between batches)
      if (batchEnd < properties.length) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);

    console.log('\n' + '='.repeat(80));
    console.log('VECTORIZATION COMPLETE');
    console.log('='.repeat(80));
    console.log(`✓ Properties processed: ${propertiesProcessed}`);
    console.log(`⊘ Properties skipped: ${propertiesSkipped}`);
    console.log(`✓ Total vectors indexed: ${indexedCount}`);
    console.log(`✗ Errors: ${errors.length}`);
    console.log(`⏱️  Duration: ${duration}s`);

    if (errors.length > 0) {
      console.log('\n❌ ERRORS ENCOUNTERED:');
      errors.slice(0, 10).forEach((error, index) => {
        console.log(`${index + 1}. ${error.substring(0, 100)}`);
      });
      if (errors.length > 10) {
        console.log(`... and ${errors.length - 10} more errors`);
      }
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
    console.error('\n❌ FATAL VECTORIZATION ERROR:', error.message);
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

/**
 * Vectorize a single property by ID
 */
export async function vectorizeSingleProperty(env: Env, propertyId: string): Promise<{
  success: boolean;
  vectors_indexed: number;
  error?: string;
}> {
  try {
    const property = await queryOne<any>(
      env,
      `SELECT * FROM seller_listings WHERE property_id = ?`,
      [propertyId]
    );

    if (!property) {
      return { success: false, vectors_indexed: 0, error: `Property ${propertyId} not found` };
    }

    const chunks = createPropertyChunks(property);
    const vectors = [];

    for (const chunk of chunks) {
      const embedding = await generateEmbedding(chunk.text, env);
      vectors.push({
        id: chunk.id,
        values: embedding,
        metadata: {
          ...chunk.metadata,
          chunk_type: chunk.type,
          title: property.title,
          listing_code: property.listing_code,
          vector_version: (property.vector_version || 0) + 1,
          vectorized_at: new Date().toISOString()
        }
      });
    }

    if (vectors.length > 0) {
      await env.VECTORIZE.upsert(vectors);

      await queryExecute(
        env,
        `UPDATE seller_listings 
         SET is_vectorized_complete = TRUE, 
             last_vectorized_at = NOW(),
             vectorization_error_message = NULL,
             vector_version = vector_version + 1
         WHERE property_id = ?`,
        [propertyId]
      );
    }

    return { success: true, vectors_indexed: vectors.length };
  } catch (error: any) {
    const errorMsg = error.message || String(error);

    await queryExecute(
      env,
      `UPDATE seller_listings 
       SET vectorization_error_message = ?
       WHERE property_id = ?`,
      [errorMsg.substring(0, 255), propertyId]
    ).catch(() => { });

    return { success: false, vectors_indexed: 0, error: errorMsg };
  }
}


// Check vectorization status
export async function getVectorizationStatus(env: Env): Promise<{
  total_properties: number;
  vectorized: number;
  pending: number;
  failed: number;
  last_vectorized_property?: string;
}> {
  try {
    const stats = await queryAll<any>(
      env,
      `SELECT 
         COUNT(*) as total,
         SUM(CASE WHEN is_vectorized_complete = TRUE THEN 1 ELSE 0 END) as vectorized,
         SUM(CASE WHEN is_vectorized_complete = FALSE THEN 1 ELSE 0 END) as pending,
         SUM(CASE WHEN vectorization_error_message IS NOT NULL THEN 1 ELSE 0 END) as failed
       FROM seller_listings`
    );

    const statusRow = stats.results[0] as any;
    const lastVectorized = await queryOne<any>(
      env,
      `SELECT property_id FROM seller_listings 
       WHERE is_vectorized_complete = TRUE 
       ORDER BY last_vectorized_at DESC LIMIT 1`
    );

    return {
      total_properties: statusRow.total || 0,
      vectorized: statusRow.vectorized || 0,
      pending: statusRow.pending || 0,
      failed: statusRow.failed || 0,
      last_vectorized_property: lastVectorized?.property_id
    };
  } catch (error: any) {
    console.error('Error getting vectorization status:', error);
    throw error;
  }
}