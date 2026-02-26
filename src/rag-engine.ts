// src/rag-engine.ts
// RAG engine: vector search -> DB fetch -> AI answer generation
// Works with actual tables: sellers + rental_owners with location JOINs
import { queryAll } from './db-utils';
import { formatPrice, priceToNPR } from './vectorize';

export interface Env {
  HYPERDRIVE: any;
  VECTORIZE: VectorizeIndex;
  AI: any;
}

export class RealEstateRAG {
  constructor(private env: Env) {}

  async generateQueryEmbedding(query: string): Promise<number[]> {
    try {
      const response = await this.env.AI.run('@cf/baai/bge-large-en-v1.5', {
        text: query
      });
      return response.data?.[0] || new Array(1024).fill(0.01);
    } catch {
      return new Array(1024).fill(0.01);
    }
  }

  async searchProperties(query: string, intent?: 'sale' | 'rent' | null): Promise<any[]> {
    console.log(`Searching: "${query}" [intent: ${intent || 'any'}]`);

    const queryEmbedding = await this.generateQueryEmbedding(query);

    const vectorResults = await this.env.VECTORIZE.query(queryEmbedding, {
      topK: 30,
      returnMetadata: 'all'
    });

    console.log(`Vector search returned ${vectorResults.matches.length} matches`);
    if (vectorResults.matches.length === 0) return [];

    // Group matches by source table and ID (deduplicate main + keyword chunks)
    const sellerIds: number[] = [];
    const rentalIds: number[] = [];
    const scoreMap = new Map<string, number>(); // "sellers_123" -> best score

    for (const match of vectorResults.matches) {
      const meta = match.metadata || {} as any;
      const table = meta.source_table || 'sellers';
      const id = meta.source_id;
      if (!id) continue;

      // If intent is specified, skip vectors from the wrong table entirely
      if (intent === 'rent' && table !== 'rental_owners') continue;
      if (intent === 'sale' && table !== 'sellers') continue;

      const key = `${table}_${id}`;
      const existing = scoreMap.get(key) || 0;
      if (match.score > existing) scoreMap.set(key, match.score);

      if (table === 'sellers' && !sellerIds.includes(id)) sellerIds.push(id);
      if (table === 'rental_owners' && !rentalIds.includes(id)) rentalIds.push(id);
    }

    // Limit to top 10 unique properties
    const results: any[] = [];

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
        });
      }
    }

    // Sort by similarity score
    return results.sort((a, b) => b.similarity - a.similarity);
  }

  async generateAnswer(question: string, properties: any[], intent?: 'sale' | 'rent' | null): Promise<string> {
    if (properties.length === 0) {
      if (intent === 'rent') return "I couldn't find any rental properties matching your criteria. We may not have rentals in that area yet — try a broader location, or check our sale listings.";
      if (intent === 'sale') return "I couldn't find any properties for sale matching your criteria. Try adjusting your budget, location, or property type.";
      return "I couldn't find any properties matching your criteria in our database. Try adjusting your budget, location, or property type.";
    }

    const context = properties.slice(0, 5).map((p, i) => {
      const parts = [
        `${i + 1}. ${p.title}`,
        `   Location: ${p.location}`,
        `   ${p.listing_type === 'Rent' ? 'Rent' : 'Price'}: ${p.price}`,
        p.area ? `   Area: ${p.area}` : null,
        p.layout ? `   Layout: ${p.layout}` : null,
        p.bedrooms ? `   Bedrooms: ${p.bedrooms}` : null,
        p.house_storey ? `   Storeys: ${p.house_storey}` : null,
        `   Type: ${p.property_type} (${p.property_category})`,
        p.facing ? `   Facing: ${p.facing}` : null,
        p.road_access ? `   Road: ${p.road_access}` : null,
        p.furnished ? `   Furnished: ${p.furnished}` : null,
        p.amenities?.length ? `   Amenities: ${p.amenities.join(', ')}` : null
      ].filter(Boolean);
      return parts.join('\n');
    }).join('\n\n');

    const listingTypeNote = intent === 'rent'
      ? 'The user is looking for RENTAL properties. All results below are for rent.'
      : intent === 'sale'
      ? 'The user is looking to BUY/PURCHASE a property. All results below are for sale.'
      : 'Results include both sale and rental listings — note the listing type for each.';

    const prompt = `You are Sorha Aana, a smart real estate assistant for Nepal.
A user asked: "${question}"

Context: ${listingTypeNote}

Here are the top matching properties from the Sorha Aana database:

${context}

RULES:
1. Use ONLY the data above -- never invent details.
2. Detect the user's language (English, Nepali, or Nenglish mix) and reply in the SAME style.
3. Highlight the 2-3 best matches and explain why they fit.
4. Show prices exactly as listed.
5. Be concise and professional.
6. Never use emojis.
7. At the end cite the source table and record ID for each property mentioned.`;

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
    const properties = await this.searchProperties(question, intent);
    const generatedAnswer = await this.generateAnswer(question, properties, intent);

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
  const match = layout.match(/(\d+)\s*(?:BHK|R)/i);
  return match ? parseInt(match[1]) : null;
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
