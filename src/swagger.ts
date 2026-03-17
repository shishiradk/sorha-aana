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
    "paths": {
        "/search": {
            "post": {
                "summary": "AI Semantic Search",
                "description": "Search for properties using natural language. Returns AI answer and matching listings.",
                "requestBody": {
                    "required": true,
                    "content": {
                        "application/json": {
                            "schema": {
                                "type": "object",
                                "properties": {
                                    "query": {
                                        "type": "string",
                                        "example": "3 bedroom house in Kathmandu under 5 crores"
                                    }
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
                                        "answer": { "type": "string" },
                                        "properties": { "type": "array", "items": { "type": "object" } },
                                        "total_results": { "type": "integer" }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        },
        "/api/properties": {
            "get": {
                "summary": "List All Properties",
                "description": "Retrieve a list of all properties (limit 50).",
                "responses": {
                    "200": {
                        "description": "Array of properties",
                        "content": {
                            "application/json": {
                                "schema": {
                                    "type": "array",
                                    "items": { "type": "object" }
                                }
                            }
                        }
                    }
                }
            }
        },
        "/api/properties/{id}": {
            "get": {
                "summary": "Get Property Details",
                "parameters": [
                    {
                        "name": "id",
                        "in": "path",
                        "required": true,
                        "schema": { "type": "string" }
                    }
                ],
                "responses": {
                    "200": {
                        "description": "Property details",
                        "content": {
                            "application/json": {
                                "schema": { "type": "object" }
                            }
                        }
                    },
                    "404": {
                        "description": "Property not found"
                    }
                }
            }
        },
        "/status": {
            "get": {
                "summary": "System Status",
                "description": "Check Vectorize index status (vector count, dimensions).",
                "responses": {
                    "200": {
                        "description": "Status info",
                        "content": {
                            "application/json": {
                                "schema": {
                                    "type": "object",
                                    "properties": {
                                        "status": { "type": "string" },
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
        "/api/vectorize": {
            "post": {
                "summary": "Run Vectorization",
                "description": "Trigger incremental vectorization of properties. Admin only.",
                "security": [{ "BearerAuth": [] }],
                "requestBody": {
                    "content": {
                        "application/json": {
                            "schema": {
                                "type": "object",
                                "properties": {
                                    "incremental": { "type": "boolean", "default": true, "description": "Only process new/changed properties" }
                                }
                            }
                        }
                    }
                },
                "responses": {
                    "200": { "description": "Vectorization started" },
                    "401": { "description": "Unauthorized" }
                }
            }
        },
        "/api/vectorize/status": {
            "get": {
                "summary": "Vectorization Status",
                "description": "Get vectorization progress (total, vectorized, pending, failed).",
                "responses": {
                    "200": {
                        "description": "Vectorization stats",
                        "content": {
                            "application/json": {
                                "schema": {
                                    "type": "object",
                                    "properties": {
                                        "total_properties": { "type": "integer" },
                                        "vectorized": { "type": "integer" },
                                        "pending": { "type": "integer" },
                                        "failed": { "type": "integer" }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        },
        "/api/vectorize/full": {
            "post": {
                "summary": "Full Re-vectorization",
                "description": "Re-vectorize all properties from scratch. Admin only.",
                "security": [{ "BearerAuth": [] }],
                "responses": {
                    "200": { "description": "Full vectorization started" },
                    "401": { "description": "Unauthorized" }
                }
            }
        },
        "/api/geocode/batch": {
            "post": {
                "summary": "Batch Geocode",
                "description": "Geocode properties that don't have coordinates yet. Admin only.",
                "security": [{ "BearerAuth": [] }],
                "requestBody": {
                    "content": {
                        "application/json": {
                            "schema": {
                                "type": "object",
                                "properties": {
                                    "batch_size": { "type": "integer", "default": 20, "maximum": 25, "description": "Number of properties to geocode (max 25)" }
                                }
                            }
                        }
                    }
                },
                "responses": {
                    "200": { "description": "Geocoding results" },
                    "401": { "description": "Unauthorized" }
                }
            }
        },
        "/api/geocode/update": {
            "post": {
                "summary": "Update Coordinates",
                "description": "Manually update lat/lng for specific properties. Admin only.",
                "security": [{ "BearerAuth": [] }],
                "requestBody": {
                    "required": true,
                    "content": {
                        "application/json": {
                            "schema": {
                                "type": "object",
                                "properties": {
                                    "updates": {
                                        "type": "array",
                                        "items": {
                                            "type": "object",
                                            "properties": {
                                                "table": { "type": "string", "enum": ["sellers", "rental_owners"] },
                                                "id": { "type": "integer" },
                                                "lat": { "type": "number" },
                                                "lng": { "type": "number" }
                                            },
                                            "required": ["table", "id", "lat", "lng"]
                                        }
                                    }
                                }
                            }
                        }
                    }
                },
                "responses": {
                    "200": { "description": "Update results" },
                    "401": { "description": "Unauthorized" }
                }
            }
        },
        "/api/query": {
            "post": {
                "summary": "Run SQL Query",
                "description": "Execute a read-only SQL query against the database. Admin only.",
                "security": [{ "BearerAuth": [] }],
                "requestBody": {
                    "required": true,
                    "content": {
                        "application/json": {
                            "schema": {
                                "type": "object",
                                "properties": {
                                    "sql": { "type": "string", "example": "SELECT COUNT(*) FROM sellers" }
                                },
                                "required": ["sql"]
                            }
                        }
                    }
                },
                "responses": {
                    "200": { "description": "Query results" },
                    "401": { "description": "Unauthorized" },
                    "403": { "description": "Query not allowed (write operations blocked)" }
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
