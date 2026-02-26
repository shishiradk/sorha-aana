import { RealEstateRAG } from './rag-engine';
import { vectorizeProperties, getVectorizationStatus } from './vectorize';
import { html } from './ui';
import { RealEstateAPI } from './api';
import { openApiSpec, swaggerHtml } from './swagger';
import { getDatabaseSchema, formatSchemaForConsole, formatSchemaAsJson } from './inspect-db';
import { queryAll } from './db-utils';
import { processVectorizationQueue, getQueueStatus } from './vectorization-queue-processor';

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
        const body = await request.json() as any;
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
            dimensions: (stats as any).dimensions
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

      // Enhanced vectorization status with database tracking
      if (path === '/api/vectorize/status' && request.method === 'GET') {
        try {
          const [vectorStats, dbStats] = await Promise.all([
            env.VECTORIZE.describe().catch(() => null),
            getVectorizationStatus(env).catch(() => null)
          ]);

          return Response.json({
            vector_index: vectorStats ? {
              vectors_count: vectorStats.vectorsCount,
              dimensions: (vectorStats as any).dimensions
            } : null,
            database_tracking: dbStats || null,
            timestamp: new Date().toISOString()
          }, { headers: corsHeaders });
        } catch (error: any) {
          return Response.json(
            { error: error.message },
            { status: 500, headers: corsHeaders }
          );
        }
      }

      // Full vectorization statistics
      if (path === '/api/vectorization-stats' && request.method === 'GET') {
        try {
          const dbStats = await getVectorizationStatus(env);
          const queueStats = await getQueueStatus(env);

          return Response.json({
            database_vectorization: dbStats,
            processing_queue: queueStats,
            summary: {
              vectorization_coverage: dbStats.total_properties > 0
                ? ((dbStats.vectorized / dbStats.total_properties) * 100).toFixed(2) + '%'
                : '0%',
              pending_vectorization: dbStats.pending,
              queue_backlog: queueStats.pending,
              failed_count: dbStats.failed + queueStats.failed
            },
            timestamp: new Date().toISOString()
          }, { headers: corsHeaders });
        } catch (error: any) {
          return Response.json(
            { error: error.message },
            { status: 500, headers: corsHeaders }
          );
        }
      }

      // Process vectorization queue (manual trigger)
      if (path === '/api/vectorize/queue/process' && request.method === 'POST') {
        const body = await request.json() as any;
        const maxJobs = body.max_jobs || 50;

        ctx.waitUntil(processVectorizationQueue(env, maxJobs));
        return Response.json({
          message: "Queue processing started in background.",
          status: "started",
          max_jobs: maxJobs
        }, { headers: corsHeaders });
      }

      // Get vectorization queue status
      if (path === '/api/vectorize/queue/status' && request.method === 'GET') {
        try {
          const queueStats = await getQueueStatus(env);
          return Response.json({
            queue: queueStats,
            timestamp: new Date().toISOString()
          }, { headers: corsHeaders });
        } catch (error: any) {
          return Response.json(
            { error: error.message },
            { status: 500, headers: corsHeaders }
          );
        }
      }

      // Full vectorization with optional mode selection
      if (path === '/api/vectorize/full' && request.method === 'POST') {
        const body = await request.json() as any;
        const mode = body.mode || 'incremental'; // 'incremental' or 'full'

        ctx.waitUntil(vectorizeProperties(env, mode === 'incremental'));
        return Response.json({
          message: `Full ${mode} vectorization started in background.`,
          status: "started",
          mode: mode
        }, { headers: corsHeaders });
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

      const endpoints = [
        'POST /api/vectorize - Start incremental vectorization',
        'POST /api/vectorize/full - Start full or incremental vectorization (body: {"mode": "incremental|full"})',
        'GET /api/vectorize/status - Get detailed vectorization status',
        'GET /api/vectorization-stats - Get full statistics',
        'POST /api/vectorize/queue/process - Process vectorization queue',
        'GET /api/vectorize/queue/status - Get queue status',
        'GET /api/db-schema - Get database schema',
        'POST /api/query - Run SQL query',
        'GET /api/properties - List properties',
        'POST /search - Search (RAG)',
        'GET /test - Test endpoint'
      ];

      return new Response('Available endpoints:\n' + endpoints.map(e => '  ' + e).join('\n'), { status: 404 });

    } catch (error: any) {
      return Response.json({
        error: error.message
      }, { status: 500, headers: corsHeaders });
    }
  }
};
