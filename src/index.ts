import { RealEstateRAG } from './rag-engine';
import { vectorizeProperties } from './vectorize';
import { html } from './ui';
import { RealEstateAPI } from './api';
import { openApiSpec, swaggerHtml } from './swagger';
import { getDatabaseSchema, formatSchemaForConsole, formatSchemaAsJson } from './inspect-db';
import { queryAll } from './db-utils';

export interface Env {
  HYPERDRIVE: any; // Hyperdrive MySQL connection
  VECTORIZE: VectorizeIndex;
  AI: any;
  ENVIRONMENT: string;
  MAX_RESULTS: string;
  PRICE_TOLERANCE: string;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Serve UI
    if (path === '/' && request.method === 'GET') {
      return new Response(html, {
        headers: { 'Content-Type': 'text/html' }
      });
    }

    // CORS
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    // Serve Swagger UI
    if (path === '/api-docs' && request.method === 'GET') {
      return new Response(swaggerHtml, {
        headers: { 'Content-Type': 'text/html' }
      });
    }

    // Serve OpenAPI JSON
    if (path === '/swagger.json' && request.method === 'GET') {
      return Response.json(openApiSpec, { headers: corsHeaders });
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      // Test endpoint
      if (path === '/test' && request.method === 'GET') {
        const rag = new RealEstateRAG(env);
        const result = await rag.query("apartments");

        return Response.json(result, { headers: corsHeaders });
      }

      // Search endpoint
      if (path === '/search' && request.method === 'POST') {
        const body = await request.json();
        const { query } = body;

        const rag = new RealEstateRAG(env);
        const result = await rag.query(query);

        return Response.json(result, { headers: corsHeaders });
      }

      // Status check (general)
      if (path === '/status' && request.method === 'GET') {
        try {
          const stats = await env.VECTORIZE.describe();
          return Response.json({
            status: 'ok',
            vectors: stats.vectorsCount,
            dimensions: stats.dimensions
          }, { headers: corsHeaders });
        } catch (error: any) {
          return Response.json({
            error: error.message
          }, { status: 500, headers: corsHeaders });
        }
      }

      // Vectorize admin endpoints
      if (path === '/api/vectorize' && request.method === 'POST') {
        // Run in background to avoid timeout
        ctx.waitUntil(vectorizeProperties(env));
        return Response.json({
          message: "Vectorization started in background. Check status endpoint for progress.",
          status: "started"
        }, { headers: corsHeaders });
      }

      if (path === '/api/vectorize/status' && request.method === 'GET') {
        try {
          const stats = await env.VECTORIZE.describe();
          return Response.json({
            vector_index: {
              vectors_count: stats.vectorsCount,
              dimensions: stats.dimensions
            }
          }, { headers: corsHeaders });
        } catch (error: any) {
          return Response.json(
            { error: error.message },
            { status: 500, headers: corsHeaders }
          );
        }
      }




      // Database schema inspection endpoints
      if (path === '/api/db-schema' && request.method === 'GET') {
        try {
          const schema = await getDatabaseSchema(env);
          const format = url.searchParams.get('format') || 'json'; // json or text
          
          if (format === 'text') {
            const textSchema = formatSchemaForConsole(schema);
            return new Response(textSchema, {
              headers: { 'Content-Type': 'text/plain' }
            });
          } else {
            return Response.json(schema, { headers: corsHeaders });
          }
        } catch (error: any) {
          return Response.json(
            { error: `Failed to fetch database schema: ${error.message}` },
            { status: 500, headers: corsHeaders }
          );
        }
      }

      // Database query endpoint - run any SQL query
      if (path === '/api/query' && request.method === 'POST') {
        try {
          const body = await request.json() as any;
          const { sql } = body;

          if (!sql || typeof sql !== 'string') {
            return Response.json(
              { error: 'Missing or invalid "sql" parameter. Send JSON: {"sql": "SELECT * FROM table"}' },
              { status: 400, headers: corsHeaders }
            );
          }

          const { results } = await queryAll(env, sql);

          return Response.json({
            success: true,
            rows: results.length,
            data: results
          }, { headers: corsHeaders });

        } catch (error: any) {
          return Response.json(
            { error: `Query Error: ${error.message}` },
            { status: 500, headers: corsHeaders }
          );
        }
      }

      // REST API Delegate
      if (path.startsWith('/api/properties')) {
        const api = new RealEstateAPI(env);
        return api.handleRequest(request);
      }

      return new Response('Not found. Try /test, /search, /status, /api/db-schema, /api/vectorize or /api/properties', { status: 404 });

    } catch (error: any) {
      return Response.json({
        error: error.message
      }, { status: 500, headers: corsHeaders });
    }
  }
};
