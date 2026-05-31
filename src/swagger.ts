export const openApiSpec = {
    "openapi": "3.0.0",
    "info": {
        "title": "Nepal Real Estate AI API",
        "version": "1.0.0",
        "description": "API documentation for the Nepal Real Estate RAG System."
    },
    "servers": [
        {
            "url": "/"
        }
    ],
    "components": {
        "securitySchemes": {
            "BearerAuth": {
                "type": "http",
                "scheme": "bearer",
                "description": "Admin API key. Pass as: Authorization: Bearer <your-key>"
            }
        }
    },
    "security": [{ "BearerAuth": [] }],
    "paths": {
        "/status": {
            "get": {
                "summary": "Health Check",
                "description": "Check system health and Vectorize index status.",
                "responses": {
                    "200": {
                        "description": "System is healthy",
                        "content": {
                            "application/json": {
                                "schema": {
                                    "type": "object",
                                    "properties": {
                                        "status": { "type": "string", "example": "ok" },
                                        "vectors": { "type": "integer" },
                                        "dimensions": { "type": "integer" }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        },
        "/search": {
            "post": {
                "summary": "AI Semantic Search",
                "description": "Search for properties or leads using natural language.\n\n**Smart auto-detection** — the system reads your query and decides the mode automatically:\n- `\"3 bedroom house in Pokhara\"` → finds matching properties (buyer mode)\n- `\"who wants to buy land\"` → finds potential buyers/tenants (seller/lead mode)\n\nNo need to specify a role. Just write naturally.\n\nRate limited to **20 requests/minute** per API key.",
                "security": [{ "BearerAuth": [] }],
                "requestBody": {
                    "required": true,
                    "content": {
                        "application/json": {
                            "schema": {
                                "type": "object",
                                "required": ["query", "owner_id"],
                                "properties": {
                                    "query": {
                                        "type": "string",
                                        "description": "Natural language search query. The system auto-detects whether to search for properties or leads.",
                                        "example": "3 bedroom house in Pokhara under 5 crores"
                                    },
                                    "owner_id": {
                                        "type": "integer",
                                        "description": "Owner ID to scope the search",
                                        "example": 3
                                    },
                                    "limit": {
                                        "type": "integer",
                                        "description": "Max results to return (1-50, default 20)",
                                        "example": 20
                                    },
                                    "offset": {
                                        "type": "integer",
                                        "description": "Pagination offset (default 0)",
                                        "example": 0
                                    }
                                },
                                "example": {
                                    "query": "3 bedroom house in Pokhara under 5 crores",
                                    "owner_id": 3
                                }
                            }
                        }
                    }
                },
                "responses": {
                    "200": {
                        "description": "Successful search",
                        "content": {
                            "application/json": {
                                "schema": {
                                    "type": "object",
                                    "properties": {
                                        "query": { "type": "string" },
                                        "answer": { "type": "string", "description": "AI-generated summary of the results" },
                                        "properties": {
                                            "type": "array",
                                            "items": {
                                                "type": "object",
                                                "properties": {
                                                    "id": { "type": "integer" },
                                                    "source_table": { "type": "string", "enum": ["sellers", "rental_owners", "buyers", "tenants", "agents"] },
                                                    "listing_type": { "type": "string", "enum": ["Sale", "Rent", "Buyer", "Tenant", "Agent"] },
                                                    "title": { "type": "string" },
                                                    "location": { "type": "string" },
                                                    "price": { "type": "string" },
                                                    "property_type": { "type": "string" },
                                                    "bedrooms": { "type": "integer" },
                                                    "area": { "type": "string" },
                                                    "name": { "type": "string", "description": "Seller/owner contact name" },
                                                    "phone": { "type": "string", "description": "Seller/owner contact phone" },
                                                    "distance_km": { "type": "number", "description": "Distance from searched location in km" },
                                                    "similarity": { "type": "number", "description": "Vector similarity score (0-1)" }
                                                }
                                            }
                                        },
                                        "total_results": { "type": "integer" },
                                        "listing_intent": { "type": "string", "enum": ["sale", "rent", "any"] },
                                        "role": { "type": "string", "enum": ["buyer", "seller"], "description": "Auto-detected or overridden role used for this search" },
                                        "cached": { "type": "boolean", "description": "true if result was served from KV cache" },
                                        "page_size": { "type": "integer" },
                                        "page_offset": { "type": "integer" }
                                    }
                                }
                            }
                        }
                    },
                    "400": { "description": "Missing query or invalid owner_id" },
                    "401": { "description": "Unauthorized — missing or invalid API key" },
                    "429": { "description": "Rate limit exceeded — max 20 requests/minute per API key" }
                }
            }
        },
        "/cache/clear": {
            "post": {
                "summary": "Clear Cache",
                "description": "Delete all KV cache entries (query cache + AI answer cache). Useful after data updates.",
                "security": [{ "BearerAuth": [] }],
                "responses": {
                    "200": {
                        "description": "Cache cleared",
                        "content": {
                            "application/json": {
                                "schema": {
                                    "type": "object",
                                    "properties": {
                                        "deleted": { "type": "integer" },
                                        "message": { "type": "string" }
                                    }
                                }
                            }
                        }
                    },
                    "401": { "description": "Unauthorized" }
                }
            }
        },
        "/api/properties": {
            "get": {
                "summary": "List Properties",
                "description": "List active properties. Optionally filter by owner_id (requires auth) and type.",
                "parameters": [
                    {
                        "name": "type",
                        "in": "query",
                        "schema": { "type": "string", "enum": ["all", "sale", "rent"], "default": "all" },
                        "description": "Filter by listing type"
                    },
                    {
                        "name": "owner_id",
                        "in": "query",
                        "schema": { "type": "integer" },
                        "description": "Filter by owner ID (requires Authorization header)"
                    }
                ],
                "responses": {
                    "200": {
                        "description": "Property list",
                        "content": {
                            "application/json": {
                                "schema": {
                                    "type": "object",
                                    "properties": {
                                        "results": { "type": "array", "items": { "type": "object" } },
                                        "count": { "type": "integer" }
                                    }
                                }
                            }
                        }
                    },
                    "401": { "description": "Unauthorized when owner_id is provided without valid API key" }
                }
            }
        },
        "/api/properties/{id}": {
            "get": {
                "summary": "Get Property by ID",
                "description": "Fetch a single property by ID.",
                "parameters": [
                    {
                        "name": "id",
                        "in": "path",
                        "required": true,
                        "schema": { "type": "integer" },
                        "description": "Property ID"
                    },
                    {
                        "name": "table",
                        "in": "query",
                        "schema": { "type": "string", "enum": ["sellers", "rental_owners"], "default": "sellers" },
                        "description": "Which table to look up"
                    }
                ],
                "responses": {
                    "200": { "description": "Property details" },
                    "404": { "description": "Property not found" }
                }
            }
        }
    }
};

export const swaggerHtml = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>API Documentation</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5.11.0/swagger-ui.css" />
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5.11.0/swagger-ui-bundle.js" crossorigin></script>
  <script>
    window.onload = () => {
      window.ui = SwaggerUIBundle({
        url: '/swagger.json',
        dom_id: '#swagger-ui',
        deepLinking: true,
        presets: [
          SwaggerUIBundle.presets.apis,
          SwaggerUIBundle.SwaggerUIStandalonePreset
        ],
        layout: "BaseLayout"
      });
    };
  </script>
</body>
</html>
`;
