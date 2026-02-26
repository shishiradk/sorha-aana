import { Env } from './index';
import { queryAll, queryOne } from './db-utils';

export class RealEstateAPI {
    constructor(private env: Env) {}

    async handleRequest(request: Request): Promise<Response> {
        const url = new URL(request.url);
        const path = url.pathname;
        const method = request.method;

        const corsHeaders = {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
        };

        // GET /api/properties — list sellers + rental_owners
        if (path === '/api/properties' && method === 'GET') {
            const type = url.searchParams.get('type') || 'all'; // sale, rent, all
            try {
                const results: any[] = [];

                if (type === 'all' || type === 'sale') {
                    const { results: sellers } = await queryAll(this.env,
                        `SELECT s.id, 'sale' as listing_type, s.property_type, s.property_category,
                                s.property_address, s.city, s.property_price, s.property_price_unit,
                                s.property_area, s.area_unit, s.layout, s.property_face,
                                s.road_size, s.road_type, s.furnished, s.status,
                                d.name as district_name, m.name as municipality_name
                         FROM sellers s
                         LEFT JOIN districts d ON s.district_id = d.id
                         LEFT JOIN municipalities m ON s.municipal_id = m.id
                         WHERE s.status = 'ACTIVE'
                         ORDER BY s.id DESC LIMIT 50`
                    );
                    results.push(...sellers);
                }

                if (type === 'all' || type === 'rent') {
                    const { results: rentals } = await queryAll(this.env,
                        `SELECT ro.id, 'rent' as listing_type, ro.property_type, ro.category as property_category,
                                ro.address as property_address, ro.city, ro.rent_amount,
                                ro.property_area, ro.area_unit, ro.layout, ro.property_face,
                                ro.road_size, ro.road_type, ro.bedroom, ro.status,
                                d.name as district_name, m.name as municipality_name
                         FROM rental_owners ro
                         LEFT JOIN districts d ON ro.district_id = d.id
                         LEFT JOIN municipalities m ON ro.municipal_id = m.id
                         WHERE ro.status = 'ACTIVE'
                         ORDER BY ro.id DESC LIMIT 50`
                    );
                    results.push(...rentals);
                }

                return Response.json({ results, count: results.length }, { headers: corsHeaders });
            } catch (e: any) {
                return Response.json({ error: e.message }, { status: 500, headers: corsHeaders });
            }
        }

        // GET /api/properties/:id?table=sellers|rental_owners
        const idMatch = path.match(/^\/api\/properties\/([^/]+)$/);
        if (idMatch && method === 'GET') {
            const id = idMatch[1];
            const table = url.searchParams.get('table') || 'sellers';

            try {
                let property: any;

                if (table === 'rental_owners') {
                    property = await queryOne(this.env,
                        `SELECT ro.*, d.name as district_name, m.name as municipality_name,
                                p.name as province_name, c.name as customer_name
                         FROM rental_owners ro
                         LEFT JOIN districts d ON ro.district_id = d.id
                         LEFT JOIN municipalities m ON ro.municipal_id = m.id
                         LEFT JOIN provinces p ON ro.province_id = p.id
                         LEFT JOIN customers c ON ro.customer_id = c.id
                         WHERE ro.id = ?`, [id]
                    );
                } else {
                    property = await queryOne(this.env,
                        `SELECT s.*, d.name as district_name, m.name as municipality_name,
                                p.name as province_name, c.name as customer_name
                         FROM sellers s
                         LEFT JOIN districts d ON s.district_id = d.id
                         LEFT JOIN municipalities m ON s.municipal_id = m.id
                         LEFT JOIN provinces p ON s.province_id = p.id
                         LEFT JOIN customers c ON s.customer_id = c.id
                         WHERE s.id = ?`, [id]
                    );
                }

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
