import { Env } from './index';
import { queryAll, queryOne } from './db-utils';

export class RealEstateAPI {
    constructor(private env: Env) { }

    async handleRequest(request: Request): Promise<Response> {
        const url = new URL(request.url);
        const path = url.pathname;
        const method = request.method;

        // CORS Headers
        const corsHeaders = {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
        };

        // GET /api/properties
        if (path === '/api/properties' && method === 'GET') {
            try {
                const { results } = await queryAll(this.env, 'SELECT * FROM seller_listings LIMIT 50');
                return Response.json(results, { headers: corsHeaders });
            } catch (e: any) {
                return Response.json({ error: e.message }, { status: 500, headers: corsHeaders });
            }
        }

        // GET /api/properties/:id
        // Simple regex to match /api/properties/123
        const idMatch = path.match(/^\/api\/properties\/([^/]+)$/);
        if (idMatch && method === 'GET') {
            const id = idMatch[1];
            try {
                const property = await queryOne(this.env, 'SELECT * FROM seller_listings WHERE property_id = ?', [id]);

                if (!property) {
                    return Response.json({ error: 'Property not found' }, { status: 404, headers: corsHeaders });
                }
                return Response.json(property, { headers: corsHeaders });
            } catch (e: any) {
                return Response.json({ error: e.message }, { status: 500, headers: corsHeaders });
            }
        }

        return new Response('API Endpoint Not Found', { status: 404, headers: corsHeaders });
    }
}
