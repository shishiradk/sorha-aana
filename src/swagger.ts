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
                                },
                                "required": ["query"]
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
