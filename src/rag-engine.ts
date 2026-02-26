// Minimal rag-engine.ts
import { queryAll } from './db-utils';

export interface Env {
  HYPERDRIVE: any; // Hyperdrive MySQL connection
  VECTORIZE: VectorizeIndex;
  AI: any;
}

export class RealEstateRAG {
  constructor(private env: Env) { }

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

  async searchProperties(query: string): Promise<any[]> {
    console.log(`Searching: "${query}"`);

    // Generate embedding
    const queryEmbedding = await this.generateQueryEmbedding(query);

    // SIMPLEST Vectorize query - minimal options
    const vectorResults = await this.env.VECTORIZE.query(queryEmbedding, {
      topK: 20,
      returnMetadata: true
    });

    console.log(`Vector search returned ${vectorResults.matches.length} matches`);

    if (vectorResults.matches.length === 0) {
      return [];
    }

    // Get property IDs
    const propertyIds = vectorResults.matches
      .map(m => m.metadata?.property_id)
      .filter(Boolean)
      .slice(0, 10);

    if (propertyIds.length === 0) {
      return [];
    }

    // Get from database using Hyperdrive
    const sql = `SELECT * FROM seller_listings WHERE property_id IN (${propertyIds.map(() => '?').join(',')})`;
    const { results } = await queryAll(this.env, sql, propertyIds);

    // Map results
    return results.map((property: any) => {
      const match = vectorResults.matches.find(m => m.metadata?.property_id === property.property_id);

      return {
        property_id: property.property_id,
        title: property.title,
        city: property.city,
        area: property.area,
        price: property.price,
        property_type: property.property_type,
        listing_type: property.listing_type,
        bedrooms: property.bedrooms,
        bathrooms: property.bathrooms,
        built_up_area: property.built_up_area,
        furnishing: property.furnishing_status || 'Not specified',
        amenities: this.parseJsonField(property.amenities),
        highlights: this.parseJsonField(property.highlights),
        similarity: match?.score || 0,
        formatted_price: this.formatPrice(property.price)
      };
    }).sort((a, b) => b.similarity - a.similarity);
  }

  private parseJsonField(field: any): string[] {
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

  private formatPrice(price: number): string {
    if (price >= 10000000) return `NRs ${(price / 10000000).toFixed(2)} crores`;
    if (price >= 100000) return `NRs ${(price / 100000).toFixed(1)} lakhs`;
    return `NRs ${price.toLocaleString()}`;
  }

  async generateAnswer(question: string, properties: any[]): Promise<string> {
    if (properties.length === 0) {
      return "I couldn't find any properties matching your criteria in our database.";
    }

    const context = properties.map((p, i) =>
      `${i + 1}. **${p.title}**
      - Location: ${p.city} (${p.area})
      - Price: ${p.formatted_price}
      - Details: ${p.bedrooms} beds, ${p.bathrooms} baths, ${p.built_up_area} sqft
      - Type: ${p.property_type} for ${p.listing_type}
      - Furnishing: ${p.furnishing}
      - Amenities: ${p.amenities.join(', ') || 'N/A'}`
    ).join('\n\n');

    const prompt = `You are a helpful and knowledgeable real estate assistant for Nepal. 
    A user has asked: "${question}"
    
    Here are the top matching properties found in our database based on their request:
    
    ${context}
    
    Please assume the role of an expert real estate agent and provide a helpful, structured response addressing the user's specific request. 
    
    Rules for your response:
    1. Acknowledge what they are looking for.
    2. Highlight 2-3 of the BEST matches from the provided list, explaining WHY they fit.
    3. Use bullet points and bold text for readability.
    4. Mention the prices exactly as provided in the context (often in Crores/Lakhs).
    5. Be concise, encouraging, and professional.
    6. If no properties perfectly match, suggest the closest alternatives from the list.`;

    try {
      const response = await this.env.AI.run('@cf/meta/llama-3-8b-instruct', {
        messages: [{ role: 'user', content: prompt }]
      });
      return response.response;
    } catch (e) {
      console.error("AI generation failed:", e);
      return "I found some matching properties shown below, but I'm having trouble analyzing them right now.";
    }
  }

  async query(question: string): Promise<any> {
    const properties = await this.searchProperties(question);
    const generatedAnswer = await this.generateAnswer(question, properties);

    return {
      query: question,
      answer: generatedAnswer,
      properties,
      total_results: properties.length
    };
  }
}
