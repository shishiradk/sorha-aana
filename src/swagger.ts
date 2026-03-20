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
                "description": "Search for properties using natural language. Requires owner_id and Authorization header.",
                "security": [{ "BearerAuth": [] }],
                "requestBody": {
                    "required": true,
                    "content": {
                        "application/json": {
                            "schema": {
                                "type": "object",
                                "properties": {
                                    "query": {
                                        "type": "string",
                                        "description": "Natural language search query",
                                        "example": "3 bedroom house in Pokhara under 5 crores"
                                    },
                                    "owner_id": {
                                        "type": "integer",
                                        "description": "Owner ID to scope the search (required)",
                                        "example": 3
                                    },
                                    "limit": {
                                        "type": "integer",
                                        "description": "Max results to return (1-100, default 20)",
                                        "example": 20
                                    },
                                    "offset": {
                                        "type": "integer",
                                        "description": "Pagination offset (default 0)",
                                        "example": 0
                                    }
                                },
                                "required": ["query", "owner_id"]
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
                                        "answer": { "type": "string" },
                                        "properties": { "type": "array", "items": { "type": "object" } },
                                        "total_results": { "type": "integer" },
                                        "listing_intent": { "type": "string" }
                                    }
                                }
                            }
                        }
                    },
                    "400": { "description": "Missing query or invalid owner_id" },
                    "401": { "description": "Unauthorized — missing or invalid API key" }
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
