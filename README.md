# Sorha Aana — Real Estate RAG System

**Platform:** Cloudflare Workers
**Database:** MySQL on `mysql.neptechpal.com.np` via Cloudflare Hyperdrive
**Vector Index:** Cloudflare Vectorize (`sorha-index`, 1024-dim, BGE Large EN)
**LLM:** Cloudflare AI (`@cf/meta/llama-3.1-8b-instruct`)
**Languages:** English, Nepali, Nenglish (mixed)

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Architecture](#2-architecture)
3. [Database Schema](#3-database-schema)
4. [Local Development Setup](#4-local-development-setup)
5. [Connecting to the Database](#5-connecting-to-the-database)
6. [Querying the Database](#6-querying-the-database)
7. [Vectorization](#7-vectorization)
8. [RAG Search](#8-rag-search)
9. [All API Endpoints](#9-all-api-endpoints)
10. [Running the Migration](#10-running-the-migration)
11. [Deployment](#11-deployment)
12. [Troubleshooting](#12-troubleshooting)

---

## 1. Project Overview

Sorha Aana (सोह्र आना) is an AI-powered real estate assistant for Nepal. Users can ask natural language questions about properties in English, Nepali, or Nenglish (mixed) and get intelligent answers backed by real database records.

**What it does:**
- Converts user queries into vector embeddings
- Finds the most semantically similar property listings in Vectorize
- Fetches full property details from MySQL via Hyperdrive
- Generates a contextual answer using Llama 3.1 8B

**Source files:**

| File | Purpose |
|------|---------|
| `src/index.ts` | Main Worker entry point, all route handling |
| `src/rag-engine.ts` | Core RAG: embed query → vector search → AI answer |
| `src/vectorize.ts` | Vectorization engine for all 5 tables (sellers, rental_owners, buyers, tenants, agents) |
| `src/vectorization-queue-processor.ts` | Queue consumer for auto-vectorization on DB changes |
| `src/db-utils.ts` | MySQL connection helpers (queryAll, queryOne, queryExecute) |
| `src/inspect-db.ts` | Schema inspection utilities |
| `src/api.ts` | Property listing REST endpoints |
| `src/ui.ts` | Web UI served at `/` |
| `src/swagger.ts` | OpenAPI docs served at `/api-docs` |

---

## 2. Architecture

```
User Query (English / Nepali / Nenglish)
        │
        ▼
[POST /search]
        │
        ▼
generateQueryEmbedding()          ← @cf/baai/bge-large-en-v1.5  (1024 dim)
        │
        ▼
VECTORIZE.query(embedding, topK=20)   ← Cloudflare Vectorize (sorha-index)
        │
        ▼ metadata: { source_table, source_id, listing_type, ... }
        │
        ▼
queryAll() → sellers       JOIN districts, municipalities, provinces, customers
           → rental_owners JOIN districts, municipalities, provinces, customers
           → buyers        JOIN districts, municipalities, customers
           → tenants       JOIN districts, municipalities, customers
           → agents
        │
        ▼
generateAnswer()                  ← @cf/meta/llama-3.1-8b-instruct
        │
        ▼
Response: { answer, properties[], total_results }


Auto-vectorization (when DB changes):
MySQL Trigger (sellers / rental_owners)
        │ INSERT INTO vectorization_queue
        ▼
[POST /api/vectorize/queue/process]
        │
        ▼
vectorizeSingleProperty() → VECTORIZE.upsert()
```

---

## 3. Database Schema

### Active tables (with data)

| Table | Rows | Description |
|-------|------|-------------|
| `sellers` | ~1582 | **Properties for sale** — main property table |
| `rental_owners` | ~160 | **Properties for rent** |
| `buyers` | ~745 | People looking to buy |
| `tenants` | ~234 | People looking to rent |
| `customers` | ~1911 | All people (sellers, buyers, owners, tenants) |
| `agents` | ~118 | Real estate agents |
| `municipalities` | 753 | Municipality lookup |
| `districts` | 77 | District lookup |
| `provinces` | 7 | Province lookup |
| `seller_images` | ~548 | Images linked to seller listings |

---

### `sellers` table — Properties for Sale

| Column | Type | Description |
|--------|------|-------------|
| `id` | bigint PK | Listing ID |
| `customer_id` | bigint FK | Links to `customers.id` (the seller/owner) |
| `property_type` | enum | LAND, HOUSE, APARTMENT, FLAT, HOTEL, OFFICE_SPACE, SHOP, ROOM, BUNGALOW, GODOWN, SHUTTER, RESTAURANT, MART, FANCY |
| `property_category` | enum | TOURISM, COMMERCIAL, SEMI_COMMERCIAL, RESIDENTIAL, AGRICULTURE |
| `property_address` | varchar | Tole / area name |
| `city` | varchar | City name (often null — use district JOIN) |
| `district_id` | bigint FK | → `districts.id` |
| `municipal_id` | bigint FK | → `municipalities.id` |
| `province_id` | bigint FK | → `provinces.id` |
| `ward_num` | varchar | Ward number |
| `property_price` | varchar | Price value (e.g. "3", "1.5", "160") |
| `property_price_unit` | enum | CRORE, LAKHS, THOUSAND |
| `property_area` | varchar | Area value (e.g. "6.5", "15/40") |
| `area_unit` | enum | HAAT, AANA, ROPANI, SQUARE_METER, SQUARE_FEET, BIGHA, KATTHA, DHUR |
| `layout` | varchar | Layout string e.g. "5BHK", "1R", "WHOLE_HOUSE" |
| `property_face` | enum | NORTH, SOUTH, EAST, WEST, NORTH-EAST, NORTH-WEST, SOUTH-EAST, ANY |
| `road_size` | varchar | Road width in feet |
| `road_type` | enum | BLACK-TOPPED, CONCRETE, PAVED, GRAVELLED, SOIL-STABILIZED, ALLEY |
| `furnished` | enum | YES, NO |
| `compound` | enum | YES, NO |
| `parking_space` | enum | YES, NO, CAR, BIKE, BOTH |
| `house_storey` | varchar | Number of storeys |
| `house_area` | varchar | Built-up area |
| `land_area` | varchar | Land area |
| `build_date` | varchar | Construction year (Nepali BS e.g. "2075") |
| `amenities` | text | JSON array of amenities |
| `property_remarks` | longtext | Full description |
| `address_remarks` | longtext | Location notes |
| `status` | enum | ACTIVE, INACTIVE, COMPLETE |
| `verification_status` | varchar | pending / verified |

---

### `rental_owners` table — Properties for Rent

Same structure as `sellers` with these key differences:

| Column | Type | Description |
|--------|------|-------------|
| `rent_amount` | int | Monthly rent in NPR |
| `bedroom` | int | Number of bedrooms |
| `kitchen` | int | Number of kitchens |
| `living_room` | int | Number of living rooms |
| `service_amount` | double | Service charge |
| `stay_period` | int | Minimum stay in months |
| `rental_purpose` | text | Intended use |
| `remarks` | text | Description |
| `category` | enum | (same values as property_category) |
| `address` | varchar | Property address (not `property_address`) |

---

### `customers` table — All People

| Column | Type | Description |
|--------|------|-------------|
| `id` | bigint PK | Customer ID |
| `name` | varchar | Full name |
| `customer_type` | enum | SELLER, BUYER, RENTAL_OWNER, TENANT |
| `primary_phone_num` | varchar | Phone number |
| `secondary_phone_num` | varchar | Alternate phone |
| `email` | varchar | Email address |
| `address` | varchar | Home address |
| `agent_id` | bigint FK | Assigned agent |
| `occupation` | varchar | Job/occupation |

---

### Location lookup tables

```
provinces (7 rows)
  id, name (e.g. "Bagmati Pradesh", "Gandaki Pradesh")

districts (77 rows)
  id, name (e.g. "Kaski", "Lalitpur"), province_id → provinces.id

municipalities (753 rows)
  id, name (e.g. "Pokhara"), district_id → districts.id
```

---

### Nepali unit conversions

| Unit | Equivalent |
|------|-----------|
| 1 Ropani | 16 Aana = 5476 sq ft |
| 1 Aana | 342.25 sq ft |
| 1 Dhur | 182.25 sq ft (Terai) |
| 1 Bigha | 72,900 sq ft (Terai) |
| 1 Kattha | 3645 sq ft |

---

## 4. Local Development Setup

### Prerequisites

- Node.js 18+
- Wrangler CLI (`npm install -g wrangler`)
- Cloudflare account with:
  - Hyperdrive configured (ID in `wrangler.json`)
  - Vectorize index `sorha-index` created
  - AI binding enabled

### Install dependencies

```bash
npm install
```

### Start local dev with remote Cloudflare bindings

```bash
npx wrangler dev --remote --port 8787
```

This uses the real Hyperdrive connection, real Vectorize index, and real AI — same as production but running locally.

Your worker is now live at `http://127.0.0.1:8787`

> **Note:** `wrangler dev` (without `--remote`) will not work because Hyperdrive
> requires a local Postgres string for emulation, but this project uses MySQL.
> Always use `--remote` for local development.

---

## 5. Connecting to the Database

### Via the Worker (recommended)

All database access goes through the Worker. The Worker connects via **Cloudflare Hyperdrive** which pools and accelerates MySQL connections.

```
Your App → Cloudflare Worker → Hyperdrive → MySQL (mysql.neptechpal.com.np)
```

The Hyperdrive binding ID is in `wrangler.json`:
```json
"hyperdrive": [{ "binding": "HYPERDRIVE", "id": "397481d18f19453494a365d966e758ef" }]
```

### Via direct MySQL (for admin tasks only)

```bash
mysql -h mysql.neptechpal.com.np -u sorhaaana -p sorha-aana
```

Enter your password when prompted. Use this only for:
- Running migrations
- Direct data inspection
- Admin tasks

---

## 6. Querying the Database

The worker exposes a live SQL query endpoint at `POST /api/query`. This lets you run any SELECT query directly against the real database through Hyperdrive.

### Basic usage

```bash
curl -s http://127.0.0.1:8787/api/query \
  -H "Content-Type: application/json" \
  -d '{"sql": "SELECT * FROM sellers LIMIT 5"}'
```

---

### Common queries

**All tables with row counts:**
```json
{
  "sql": "SELECT TABLE_NAME, TABLE_ROWS FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_ROWS DESC"
}
```

**Schema of a specific table:**
```json
{ "sql": "DESCRIBE sellers" }
```

**All active properties for sale (with location names):**
```json
{
  "sql": "SELECT s.id, s.property_type, s.property_category, s.property_address, s.city, s.property_price, s.property_price_unit, s.property_area, s.area_unit, s.layout, d.name as district, m.name as municipality FROM sellers s LEFT JOIN districts d ON s.district_id = d.id LEFT JOIN municipalities m ON s.municipal_id = m.id WHERE s.status = 'ACTIVE' ORDER BY s.id DESC LIMIT 20"
}
```

**Properties by type:**
```json
{
  "sql": "SELECT property_type, COUNT(*) as count FROM sellers WHERE status = 'ACTIVE' GROUP BY property_type ORDER BY count DESC"
}
```

**Properties in a specific district:**
```json
{
  "sql": "SELECT s.id, s.property_type, s.property_address, s.property_price, s.property_price_unit, c.name as seller_name FROM sellers s LEFT JOIN customers c ON s.customer_id = c.id LEFT JOIN districts d ON s.district_id = d.id WHERE d.name = 'Kaski' AND s.status = 'ACTIVE' LIMIT 20"
}
```

**All seller names with listing counts:**
```json
{
  "sql": "SELECT c.name, c.primary_phone_num, COUNT(s.id) as listings FROM sellers s LEFT JOIN customers c ON s.customer_id = c.id WHERE s.status = 'ACTIVE' GROUP BY c.id, c.name, c.primary_phone_num ORDER BY listings DESC LIMIT 50"
}
```

**Rental properties:**
```json
{
  "sql": "SELECT ro.id, ro.property_type, ro.address, ro.rent_amount, ro.bedroom, d.name as district FROM rental_owners ro LEFT JOIN districts d ON ro.district_id = d.id WHERE ro.status = 'ACTIVE' ORDER BY ro.id DESC LIMIT 20"
}
```

**Buyers looking for property:**
```json
{
  "sql": "SELECT b.id, b.property_type, b.seeking_address, b.minimum_budget, b.minimum_budget_unit, b.maximum_budget, b.maximum_budget_unit, c.name as buyer_name, c.primary_phone_num FROM buyers b LEFT JOIN customers c ON b.customer_id = c.id WHERE b.status = 'ACTIVE' LIMIT 20"
}
```

**Find seller by name:**
```json
{
  "sql": "SELECT s.id, s.property_type, s.property_address, s.property_price, s.property_price_unit, c.name FROM sellers s JOIN customers c ON s.customer_id = c.id WHERE c.name LIKE '%Rudra%'"
}
```

**Price range filter (e.g. houses 1-2 crore):**
```json
{
  "sql": "SELECT s.id, s.property_address, s.property_price, s.property_price_unit, s.layout, d.name as district FROM sellers s LEFT JOIN districts d ON s.district_id = d.id WHERE s.property_type = 'HOUSE' AND s.property_price_unit = 'CRORE' AND CAST(s.property_price AS DECIMAL) BETWEEN 1 AND 2 AND s.status = 'ACTIVE'"
}
```

**Properties with images:**
```json
{
  "sql": "SELECT s.id, s.property_address, si.url FROM sellers s JOIN seller_images si ON si.seller_id = s.id LIMIT 10"
}
```

---

## 7. Vectorization

Vectorization converts property text into 1024-dimensional embeddings stored in Cloudflare Vectorize (`sorha-index`). This powers semantic search.

### Vector ID format

Each entity gets 2 vectors (main + keywords):

| Source Table | Vector IDs | Content |
|-------------|-----------|---------|
| `sellers` | `seller_{id}_main`, `seller_{id}_keywords` | Property description, price, area, location, amenities |
| `rental_owners` | `rental_{id}_main`, `rental_{id}_keywords` | Rental description, rent amount, bedroom count, location |
| `buyers` | `buyer_{id}_main`, `buyer_{id}_keywords` | Budget range, property type sought, preferred location |
| `tenants` | `tenant_{id}_main`, `tenant_{id}_keywords` | Rent budget, bedroom needs, preferred area |
| `agents` | `agent_{id}_main`, `agent_{id}_keywords` | Name, working area, contact info |

### Total vectors

| Table | Rows | Vectors |
|-------|------|---------|
| `sellers` | ~1,582 | ~3,164 |
| `rental_owners` | ~160 | ~320 |
| `buyers` | ~745 | ~1,490 |
| `tenants` | ~234 | ~468 |
| `agents` | ~118 | ~236 |
| **Total** | **~2,839** | **~5,678** |

### Run initial full vectorization

```bash
curl -X POST http://127.0.0.1:8787/api/vectorize/full \
  -H "Content-Type: application/json" \
  -d '{"mode": "full"}'
```

This runs in the background across all 5 tables. With ~2,839 entities = **~5,678 vectors** to create.

### Run incremental vectorization (only new/changed)

```bash
curl -X POST http://127.0.0.1:8787/api/vectorize \
  -H "Content-Type: application/json"
```

### Check vectorization status

```bash
curl http://127.0.0.1:8787/api/vectorize/status
```

Response:
```json
{
  "vector_index": { "dimensions": 1024 },
  "database_tracking": {
    "total_properties": 1582,
    "vectorized": 1520,
    "pending": 62,
    "failed": 0
  }
}
```

### Full statistics

```bash
curl http://127.0.0.1:8787/api/vectorization-stats
```

### Process the change queue manually

```bash
curl -X POST http://127.0.0.1:8787/api/vectorize/queue/process \
  -H "Content-Type: application/json" \
  -d '{"max_jobs": 100}'
```

### Queue status

```bash
curl http://127.0.0.1:8787/api/vectorize/queue/status
```

### How auto-vectorization works

Once you run the migration (`migrations/001_add_vectorization_tracking.sql`), MySQL triggers automatically add entries to `vectorization_queue` whenever a seller or rental listing is created, updated, or deleted. The worker then processes this queue on demand or via cron (every 5 minutes).

> **Note:** Auto-triggers are set up for `sellers` and `rental_owners` only.
> `buyers`, `tenants`, and `agents` are re-vectorized by running full vectorization manually after bulk data changes.

---

## 8. RAG Search

### POST /search — Natural language search across all tables

This is the main endpoint. It:
1. Embeds your query with BGE Large EN
2. Searches the Vectorize index across **all 5 tables** (sellers, rental_owners, buyers, tenants, agents)
3. Detects listing intent (rent vs sale) and filters results accordingly
4. Fetches full details from MySQL
5. Generates an AI answer with Llama 3.1 8B

```bash
curl -X POST http://127.0.0.1:8787/search \
  -H "Content-Type: application/json" \
  -d '{"query": "house in Pokhara under 2 crore"}'
```

---

### Property for Sale queries

**English:**
```json
{ "query": "Find me a 3 bedroom house in Kathmandu under 2 crore" }
```

**Nepali:**
```json
{ "query": "काठमाडौंमा २ करोडभन्दा कम मूल्यमा ३ कोठाको घर देखाउनुस्" }
```

**Nenglish (most common):**
```json
{ "query": "Pokhara ma ghar khojdai chu, budget 1.5 crore NPR cha" }
```

**More sale examples:**
```json
{ "query": "land near Pokhara lake with road access" }
{ "query": "commercial property Kaski district" }
{ "query": "agricultural land Terai area 2 bigha" }
{ "query": "hotel property for sale in Pokhara tourist area" }
```

---

### Rental property queries

The system detects rental intent from keywords like `rent`, `bhadama`, `kiraya`, `monthly`, `per month` and returns only rental listings.

```json
{ "query": "flat for rent in Kathmandu under 15000 per month" }
{ "query": "2 bedroom apartment bhadama Pokhara" }
{ "query": "office space for rent Lalitpur" }
{ "query": "room kiraya Thamel area" }
{ "query": "house bhadama in Kaski 3BHK" }
```

---

### Buyer queries

Find people who are actively looking to buy a property:

```json
{ "query": "buyers looking for land in Pokhara with budget 1 crore" }
{ "query": "who wants to buy a house in Kaski district" }
{ "query": "buyer looking for commercial property in Kathmandu" }
{ "query": "ghar kinna khojne manche Pokhara ma" }
```

---

### Tenant queries

Find people who are looking to rent:

```json
{ "query": "tenants seeking 2BHK flat in Kathmandu under 15000 per month" }
{ "query": "who is looking to rent in Pokhara" }
{ "query": "tenant looking for office space bhadama" }
{ "query": "bhadama khojne manche Lalitpur ma" }
```

---

### Agent queries

Find real estate agents by area or specialty:

```json
{ "query": "agents working in Kaski district" }
{ "query": "real estate agent in Pokhara" }
{ "query": "Gandaki Pradesh ko agent" }
{ "query": "agent for residential property in Kathmandu" }
```

---

### Mixed / general queries

These return relevant results from whichever tables match:

```json
{ "query": "who is interested in agricultural land in Chitwan" }
{ "query": "show me everything available in Pokhara-17" }
{ "query": "3 storey house Damside" }
```

### Response format

```json
{
  "query": "house in Pokhara under 2 crore",
  "answer": "AI-generated answer in user's language...",
  "properties": [
    {
      "id": 1234,
      "source_table": "sellers",
      "listing_type": "Sale",
      "title": "House for Sale in Damside",
      "property_type": "House",
      "property_category": "Residential",
      "location": "Damside, Pokhara, Kaski",
      "district": "Kaski",
      "municipality": "Pokhara",
      "province": "Gandaki Pradesh",
      "price": "NPR 1.8 Crore",
      "price_npr": 18000000,
      "area": "5 Aana",
      "layout": "4BHK",
      "bedrooms": 4,
      "facing": "East",
      "road_access": "16 ft Black-Topped road",
      "furnished": "YES",
      "amenities": ["Parking", "Water Tank"],
      "similarity": 0.89
    }
  ],
  "total_results": 5
}
```

The `source_table` field tells you which entity type was returned:

| `source_table` | `listing_type` | Key fields |
|---------------|---------------|-----------|
| `sellers` | `Sale` | price, area, layout, property_type |
| `rental_owners` | `Rent` | price (monthly rent), bedroom, layout |
| `buyers` | `Buyer` | budget_min, budget_max, property_type sought |
| `tenants` | `Tenant` | price (rent budget), bedrooms_needed |
| `agents` | `Agent` | name, working_area, phone, email |

---

## 9. All API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/` | Web UI |
| GET | `/api-docs` | Swagger UI |
| GET | `/swagger.json` | OpenAPI spec |
| GET | `/status` | Vectorize index status |
| POST | `/search` | **RAG semantic search** |
| GET | `/test` | Quick test (searches "apartments") |
| POST | `/api/vectorize` | Start incremental vectorization |
| POST | `/api/vectorize/full` | Start full or incremental reindex |
| GET | `/api/vectorize/status` | Vectorization progress |
| GET | `/api/vectorization-stats` | Full stats (vectors + queue) |
| POST | `/api/vectorize/queue/process` | Process pending queue jobs |
| GET | `/api/vectorize/queue/status` | Queue status |
| GET | `/api/db-schema` | Full DB schema (JSON or text) |
| POST | `/api/query` | Run any SQL query |
| GET | `/api/properties` | List properties (`?type=sale\|rent\|all`) |
| GET | `/api/properties/:id` | Get property (`?table=sellers\|rental_owners`) |

---

## 10. Running the Migration

The migration adds vectorization tracking columns and triggers to `sellers` and `rental_owners`.

**Run once on your MySQL database:**

```bash
mysql -h mysql.neptechpal.com.np -u sorhaaana -p sorha-aana \
  < migrations/001_add_vectorization_tracking.sql
```

**What it does:**
- Adds `is_vectorized_complete`, `last_vectorized_at`, `vector_version`, `vectorization_error_message` to `sellers` and `rental_owners`
- Creates `vectorization_queue` table
- Creates AFTER INSERT / AFTER UPDATE / BEFORE DELETE triggers on both tables
- Triggers automatically queue rows for vectorization when data changes

**After migration — run full vectorization:**
```bash
curl -X POST http://127.0.0.1:8787/api/vectorize/full \
  -H "Content-Type: application/json" \
  -d '{"mode": "full"}'
```

---

## 11. Deployment

### Deploy to Cloudflare

```bash
npm run deploy
```

This runs `wrangler deploy` and pushes the Worker to Cloudflare's global edge network. Your Hyperdrive, Vectorize, and AI bindings are automatically available in production.

### Check production status

After deploy, your worker is available at:
`https://sorha-aana-worker.<your-subdomain>.workers.dev`

### Environment variables

Set in `wrangler.json` under `vars`:

| Variable | Default | Description |
|----------|---------|-------------|
| `ENVIRONMENT` | development | Environment name |
| `MAX_RESULTS` | 10 | Max properties to return |
| `PRICE_TOLERANCE` | 0.1 | ±10% price tolerance for matches |

---

## 12. Troubleshooting

### `wrangler dev` fails with Hyperdrive error

```
Error: When developing locally, you should use a local Postgres connection string...
```

**Fix:** Always use `wrangler dev --remote` for this project. Hyperdrive does not support local MySQL emulation.

### `/search` returns 0 results

Vectorize index is empty. Run full vectorization first:
```bash
curl -X POST http://127.0.0.1:8787/api/vectorize/full \
  -H "Content-Type: application/json" \
  -d '{"mode": "full"}'
```

### `seller_listings` table not found error

This table does not exist. The actual table is `sellers`. If you see this error anywhere in the code, it means old code is still referenced. All source files have been updated to use `sellers`.

### Database query failed: connect ETIMEDOUT

The database is not accessible from localhost. Always query through the Worker endpoints (`/api/query`) which use Hyperdrive.

### Queue processor returns "Table vectorization_queue doesn't exist"

The migration has not been run yet. Execute `migrations/001_add_vectorization_tracking.sql` on the MySQL server.

### AI answer is generic or unhelpful

The vector index may have stale or no data. Check:
1. `GET /api/vectorize/status` — confirm vectors exist
2. `GET /status` — confirm Vectorize index has entries
3. Re-run full vectorization if needed

---

## Quick Reference

```bash
# Start dev server
npx wrangler dev --remote --port 8787

# Search for a property for sale
curl -X POST http://127.0.0.1:8787/search \
  -H "Content-Type: application/json" \
  -d '{"query": "house in Pokhara under 2 crore"}'

# Search for a rental
curl -X POST http://127.0.0.1:8787/search \
  -H "Content-Type: application/json" \
  -d '{"query": "2BHK flat bhadama Kathmandu under 15000"}'

# Find buyers looking to purchase in an area
curl -X POST http://127.0.0.1:8787/search \
  -H "Content-Type: application/json" \
  -d '{"query": "buyers looking for land in Pokhara budget 1 crore"}'

# Find agents in a district
curl -X POST http://127.0.0.1:8787/search \
  -H "Content-Type: application/json" \
  -d '{"query": "real estate agents working in Kaski"}'

# List all properties
curl http://127.0.0.1:8787/api/properties?type=all

# Run any SQL
curl -X POST http://127.0.0.1:8787/api/query \
  -H "Content-Type: application/json" \
  -d '{"sql": "SELECT * FROM sellers LIMIT 5"}'

# Full schema inspection
curl http://127.0.0.1:8787/api/db-schema?format=text

# Start full vectorization (all 5 tables: sellers, rental_owners, buyers, tenants, agents)
curl -X POST http://127.0.0.1:8787/api/vectorize/full \
  -H "Content-Type: application/json" \
  -d '{"mode": "full"}'

# Check progress
curl http://127.0.0.1:8787/api/vectorize/status

# Deploy to production
npm run deploy
```
