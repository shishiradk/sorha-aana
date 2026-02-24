# Build a Real Estate AI Agent (RAG) with Cloudflare Workers

This guide is a complete, step-by-step tutorial on how to build a Retrieval-Augmented Generation (RAG) system for Real Estate. By the end, you will have a working AI agent that can answer questions like *"Find me a 3-bedroom villa in Kathmandu under 5 Crores"* using your own database.

**Technologies Used:**
*   **Cloudflare Workers**: Serverless compute.
*   **D1 Database**: SQL database to store property details.
*   **Vectorize**: Vector database to store semantic embeddings.
*   **Workers AI**:
    *   `@cf/baai/bge-large-en-v1.5` (Embedding Model)
    *   `@cf/meta/llama-3-8b-instruct` (Text Generation Model)

---

## 🚀 Phase 1: Setup & Resources

### 1. Prerequisites
Ensure you have **Node.js** installed. Then install the Cloudflare Wrangler CLI globally:
```bash
npm install -g wrangler
```

Authenticate with your Cloudflare account:
```bash
npx wrangler login
```

### 2. Initialize Project
Create a new project directory and initialize it:
```bash
mkdir real-state
cd real-state
npx wrangler init . 
# Select "Hello World" worker when asked.
# Select "No" for TypeScript (we will add it manually or say Yes if you prefer).
# We are using TypeScript for this tutorial.
```

### 3. Create Cloudflare Resources

**A. Create D1 Database (SQL)**
This stores the readable property data.
```bash
npx wrangler d1 create real-state
```
*Copy the `database_id` output. You will need it later.*

**B. Create Vectorize Index (Vectors)**
This stores the "meaning" of your data for AI search. We use 1024 dimensions because the BGE-Large model produces 1024d vectors.
```bash
npx wrangler vectorize create embeddings-index --dimensions=1024 --metric=cosine
```

---

## 🛠 Phase 2: Configuration & Schema

### 4. Configure `wrangler.json`
Open `wrangler.json` and replace it with this configuration. **Replace `<YOUR_DATABASE_ID>`** with the ID you copied in Step 3A.

```json
{
  "name": "real-state",
  "main": "src/index.ts",
  "compatibility_date": "2024-02-08",
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "real-state",
      "database_id": "<YOUR_DATABASE_ID>"
    }
  ],
  "vectorize": [
    {
      "binding": "VECTOR_INDEX",
      "index_name": "embeddings-index"
    }
  ],
  "ai": {
    "binding": "AI"
  }
}
```

### 5. Create Database Schema
Create a file `migrations/0000_initial_schema.sql`:

```sql
DROP TABLE IF EXISTS seller_listings;
CREATE TABLE seller_listings (
    property_id TEXT PRIMARY KEY,
    title TEXT,
    city TEXT,
    area TEXT,
    price REAL,
    property_type TEXT,
    bedrooms INTEGER,
    bathrooms INTEGER,
    description TEXT,
    -- Add other columns as needed
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Seed Data (Optional)
INSERT INTO seller_listings (property_id, title, city, price, description) VALUES 
('1', 'Luxury Villa', 'Kathmandu', 55000000, 'Beautiful villa with garden'),
('2', 'Cozy Apartment', 'Lalitpur', 25000000, 'Modern apartment in Jhamsikhel');
```

Apply the migration to the remote database:
```bash
npx wrangler d1 migrations apply real-state --remote
```

---

## 💻 Phase 3: The Backend Code

### 6. Vectorization Logic (`src/vectorize.ts`)
Handles fetching data from D1, creating AI embeddings, and indexing them in Vectorize.

### 7. RAG Engine (`src/rag-engine.ts`)
The core reasoning engine that handles semantic search and natural language generation using LLMs.

### 8. API Layer (`src/api.ts`)
A dedicated REST handler for managing property data queries independently of the AI engine.

### 9. Documentation (`src/swagger.ts`)
Contains the OpenAPI 3.0 specification and generates the **Swagger UI** for professional API discovery.

### 10. Worker Entry Point (`src/index.ts`)
The main router connecting all components to HTTP endpoints:
*   `GET /`: Search UI.
*   `GET /api-docs`: Professional Swagger documentation.
*   `GET /api/properties`: List listings.
*   `POST /search`: AI Semantic Search.

---

## 🎨 Phase 4: The Frontend

### 11. Frontend UI (`src/ui.ts`)
A minimalist **Black & White** design with **Green Accents**.
*   Built with vanilla HTML/CSS/JS (no heavy frameworks).
*   Responsive and mobile-friendly.
*   Directly served by the Cloudflare Worker at edge speed.

---

## 🚀 Phase 5: Run and Test

### 12. Start the Server
Since we use Workers AI and Vectorize, run in remote mode:
```bash
npx wrangler dev --remote
```

### 13. Initialize AI Vectors
Trigger the internal vectorization process once to populate your search index:
```bash
curl -X POST http://localhost:8787/api/vectorize
```

### 14. Access Documentation & APIs
*   **Interactive Search**: `http://localhost:8787/`
*   **API Documentation (Swagger)**: `http://localhost:8787/api-docs`
*   **Standard JSON API**: `http://localhost:8787/api/properties`

### 15. Deploy to Production
```bash
npx wrangler deploy
```

---

## ⚠️ Troubleshooting
*   **Build Errors**: Ensure `package.json` dependencies match your `wrangler` version.
*   **Search returns no results**: Verify vectorization status at `/api/vectorize/status`.
*   **Styling issues**: Clear browser cache if UI changes aren't appearing after deploy.
