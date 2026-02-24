// src/vectorize.ts
import { queryAll } from './db-utils';

export interface Env {
  HYPERDRIVE: any; // Hyperdrive MySQL connection
  VECTORIZE: VectorizeIndex;
  AI: any;
}

// Helper function to parse JSON fields safely
function parseJsonField(field: any): any[] {
  if (!field) return [];
  if (Array.isArray(field)) return field;
  if (typeof field === 'string') {
    try {
      return JSON.parse(field);
    } catch {
      return [field];
    }
  }
  return [];
}

// Create property chunks with optimized text for embeddings
function createPropertyChunks(property: any): Array<{
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

  // Chunk 1: Core Property Information
  chunks.push({
    id: `${propertyId}_core`,
    text: `
      Property: ${property.title}
      Property ID: ${propertyId}
      Listing Code: ${property.listing_code}
      Type: ${property.property_type} for ${property.listing_type}
      Location: ${property.city} - ${property.area}
      Price: ${property.price} NPR
      Negotiable: ${property.negotiable ? 'Yes' : 'No'}
      Built-up Area: ${property.built_up_area} sq ft
    `.replace(/\s+/g, ' ').trim(),
    type: 'core',
    metadata: {
      property_id: propertyId,
      property_type: property.property_type,
      listing_type: property.listing_type,
      city: property.city,
      area: property.area,
      price: property.price,
      built_up_area: property.built_up_area
    }
  });

  // Chunk 2: Description and Location Details
  chunks.push({
    id: `${propertyId}_description`,
    text: `
      Description: ${property.description}
      Location Details: ${property.city}, ${property.area}
      Nearby Landmarks: ${property.nearby_landmarks}
      City: ${property.city}
      Area/Neighborhood: ${property.area}
      Highlights: ${highlights.join(', ')}
      Suitable For: ${suitableFor.join(', ')}
    `.replace(/\s+/g, ' ').trim(),
    type: 'description',
    metadata: {
      property_id: propertyId,
      city: property.city,
      area: property.area,
      nearby_landmarks: property.nearby_landmarks,
      highlights: highlights,
      suitable_for: suitableFor
    }
  });

  // Chunk 3: Specifications and Features
  const specs = [];
  if (property.bedrooms) specs.push(`${property.bedrooms} bedrooms`);
  if (property.bathrooms) specs.push(`${property.bathrooms} bathrooms`);

  chunks.push({
    id: `${propertyId}_specs`,
    text: `
      Specifications: ${specs.join(', ')}
      Built-up Area: ${property.built_up_area} square feet
      Furnishing: ${property.furnishing_status}
      Amenities: ${amenities.join(', ')}
      Property Type: ${property.property_type}
      Listing Type: ${property.listing_type}
    `.replace(/\s+/g, ' ').trim(),
    type: 'specifications',
    metadata: {
      property_id: propertyId,
      bedrooms: property.bedrooms,
      bathrooms: property.bathrooms,
      built_up_area: property.built_up_area,
      furnishing_status: property.furnishing_status,
      amenities: amenities,
      property_type: property.property_type
    }
  });

  // Chunk 4: Search Keywords and Context
  chunks.push({
    id: `${propertyId}_keywords`,
    text: `
      ${property.property_type} ${property.listing_type} ${property.city} ${property.area}
      ${property.bedrooms ? `${property.bedrooms} bedroom` : ''}
      ${property.bathrooms ? `${property.bathrooms} bathroom` : ''}
      ${property.furnishing_status}
      ${amenities.join(' ')}
      ${highlights.join(' ')}
      ${suitableFor.join(' ')}
      ${property.nearby_landmarks}
      Price: ${property.price}
    `.replace(/\s+/g, ' ').trim(),
    type: 'keywords',
    metadata: {
      property_id: propertyId,
      keywords: [
        property.property_type,
        property.listing_type,
        property.city,
        property.area,
        property.furnishing_status,
        ...amenities,
        ...highlights,
        ...suitableFor
      ]
    }
  });

  return chunks;
}

// Generate embedding using Cloudflare AI
async function generateEmbedding(text: string, env: Env): Promise<number[]> {
  try {
    // Use @cf/baai/bge-large-en-v1.5 for 1024 dimensions
    const response = await env.AI.run('@cf/baai/bge-large-en-v1.5', {
      text: text
    });

    if (response && response.data && Array.isArray(response.data) && response.data.length > 0) {
      return response.data[0]; // This will be 1024 dimensions
    }
    throw new Error('Invalid embedding response');
  } catch (error) {
    console.error('Error generating embedding:', error);
    // Return zero vector as fallback (1024 dimensions for large model)
    return new Array(1024).fill(0);
  }
}
// Main vectorization function
export async function vectorizeProperties(env: Env): Promise<{
  success: boolean;
  indexed: number;
  errors: string[];
  properties_processed: number;
}> {
  const errors: string[] = [];
  let indexedCount = 0;
  let propertiesProcessed = 0;

  try {
    console.log('Fetching properties from Hyperdrive database...');

    // Fetch all properties from Hyperdrive
    const { results: properties } = await queryAll<any>(
      env,
      `SELECT * FROM seller_listings ORDER BY property_id`
    );

    if (!properties || properties.length === 0) {
      throw new Error('No properties found in database');
    }

    console.log(`Found ${properties.length} properties to vectorize`);

    // Process properties sequentially to avoid rate limits
    for (let i = 0; i < properties.length; i++) {
      const property = properties[i];
      const propertyId = property.property_id;

      try {
        console.log(`\nProcessing property ${i + 1}/${properties.length}: ${propertyId} - ${property.title}`);

        // Create chunks for this property
        const chunks = createPropertyChunks(property);
        console.log(`   Created ${chunks.length} chunks`);

        // Prepare vectors for batch upsert
        const vectors = [];

        for (const chunk of chunks) {
          try {
            // Generate embedding for chunk text
            const embedding = await generateEmbedding(chunk.text, env);

            vectors.push({
              id: chunk.id,
              values: embedding,
              metadata: {
                ...chunk.metadata,
                chunk_type: chunk.type,
                title: property.title,
                listing_code: property.listing_code,
                text_preview: chunk.text.substring(0, 100) + '...'
              }
            });

            console.log(`   Generated embedding for ${chunk.type} chunk`);

          } catch (chunkError: any) {
            const errorMsg = `Error generating embedding for chunk ${chunk.type} of property ${propertyId}: ${chunkError.message}`;
            errors.push(errorMsg);
            console.error(`   Error: ${errorMsg}`);
          }
        }

        // Upsert vectors to Vectorize index
        if (vectors.length > 0) {
          try {
            await env.VECTORIZE.upsert(vectors);
            indexedCount += vectors.length;
            propertiesProcessed++;
            console.log(`   Successfully indexed ${vectors.length} chunks for property ${propertyId}`);
          } catch (upsertError: any) {
            const errorMsg = `Error upserting vectors for property ${propertyId}: ${upsertError.message}`;
            errors.push(errorMsg);
            console.error(`   Error: ${errorMsg}`);
          }
        }

        // Small delay to avoid rate limiting
        if (i < properties.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 200));
        }

      } catch (propertyError: any) {
        const errorMsg = `Error processing property ${propertyId}: ${propertyError.message}`;
        errors.push(errorMsg);
        console.error(`   Error: ${errorMsg}`);
      }
    }

    console.log('\n' + '='.repeat(50));
    console.log('VECTORIZATION COMPLETE');
    console.log('='.repeat(50));
    console.log(`Properties processed: ${propertiesProcessed}/${properties.length}`);
    console.log(`Total chunks indexed: ${indexedCount}`);
    console.log(`Errors: ${errors.length}`);

    if (errors.length > 0) {
      console.log('\nErrors encountered:');
      errors.forEach((error, index) => {
        console.log(`${index + 1}. ${error}`);
      });
    }

    return {
      success: errors.length === 0,
      indexed: indexedCount,
      errors,
      properties_processed: propertiesProcessed
    };

  } catch (error: any) {
    console.error('Vectorization failed:', error);
    return {
      success: false,
      indexed: indexedCount,
      errors: [...errors, `Fatal error: ${error.message}`],
      properties_processed: propertiesProcessed
    };
  }
}