# Sorha Aana — Real Estate RAG System

**Platform:** Cloudflare Workers
**Database:** MySQL on `mysql.neptechpal.com.np` via Cloudflare Hyperdrive
**Vector Index:** Cloudflare Vectorize (`sorha-index`, 1024-dim, BGE Large EN)
**LLM:** Cloudflare AI (`@cf/meta/llama-3.1-8b-instruct`)
**Geocoding:** Nominatim (OpenStreetMap) — free, no API key, Kaski district bounded
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
8. [Geocoding & Proximity Search](#8-geocoding--proximity-search)
9. [RAG Search](#9-rag-search)
10. [All API Endpoints](#10-all-api-endpoints)
11. [Running the Migrations](#11-running-the-migrations)
12. [Deployment](#12-deployment)
13. [Troubleshooting](#13-troubleshooting)

---

## 1. Project Overview

Sorha Aana (सोह्र आना) is an AI-powered real estate assistant for Kaski district, Nepal. Users can ask natural language questions about properties in English, Nepali, or Nenglish (mixed) and get intelligent answers backed by real database records — including proximity-aware results ("near Lakeside", "Chipledhunga najik").

**What it does:**
- Extracts location intent from queries ("near X", "X najik", "X tira")
- Geocodes the location via Nominatim and finds properties within 5 km using haversine distance
- Converts the full query into vector embeddings and searches for semantic matches
- Merges proximity + semantic results, ranks by combined score
- Generates a contextual answer using Llama 3.1 8B

**Source files:**

| File | Purpose |
|------|---------|
| `src/index.ts` | Main Worker entry point, all route handling |
| `src/rag-engine.ts` | Core RAG: proximity filter → vector search → merge → AI answer |
| `src/geocoding.ts` | Nominatim geocoding, location extraction from queries, haversine math |
| `src/batch-geocode.ts` | Batch geocoding via Worker API (no direct DB access needed) |
| `src/vectorize.ts` | Vectorization engine for all 5 tables (sellers, rental_owners, buyers, tenants, agents) |
| `src/vectorization-queue-processor.ts` | Queue consumer for auto-vectorization + geocoding on new properties |
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
        ├─── extractLocationFromQuery()
        │         "house near Chipledhunga" → "Chipledhunga"
        │         "Malepatan najik ghar"    → "Malepatan"
        │
        ├─── [If location found] geocodeLocation() via Nominatim
        │         → lat: 28.2345, lng: 83.9831
        │
        ├─── [If location found] haversine SQL → seller/rental IDs within 5 km
        │
        ├─── generateQueryEmbedding()       ← @cf/baai/bge-large-en-v1.5 (1024 dim)
        │
        ├─── VECTORIZE.query(topK=30)       ← sorha-index (all 5 tables)
        │
        ├─── Merge nearby + semantic results
        │         nearby-only → baseline score 0.5
        │         both        → score = 0.6×proximity + 0.4×similarity
        │         semantic-only → score = similarity
        │
        ├─── queryAll() → full property details from MySQL
        │
        └─── generateAnswer()               ← @cf/meta/llama-3.1-8b-instruct


Auto-vectorization (cron every 5 min):
Cron → vectorizeProperties(incremental)
     → finds sellers/rentals where is_vectorized_complete = FALSE
           OR updated_at > last_vectorized_at
     → generates embeddings → VECTORIZE.upsert()
     → geocodes address if latitude IS NULL
     → updates is_vectorized_complete = TRUE, last_vectorized_at = NOW()

Note: DB triggers for auto-queuing are blocked by binary log privilege
restriction on the hosting server. Incremental scan handles this instead.
```

---

## 3. Database Schema

### Active tables (with data)

| Table | Rows | Description |
|-------|------|-------------|
| `sellers` | ~1,600 | **Properties for sale** — main property table |
| `rental_owners` | ~162 | **Properties for rent** |
| `buyers` | ~745 | People looking to buy |
| `tenants` | ~234 | People looking to rent |
| `customers` | ~1,911 | All people (sellers, buyers, owners, tenants) |
| `agents` | ~118 | Real estate agents |
| `vectorization_queue` | — | Change queue for incremental vectorization |
| `municipalities` | 753 | Municipality lookup |
| `districts` | 77 | District lookup |
| `provinces` | 7 | Province lookup |
| `seller_images` | ~548 | Images linked to seller listings |

---

### `sellers` table — Properties for Sale

| Column | Type | Description |
|--------|------|-------------|
| `id` | bigint PK | Listing ID |
| `customer_id` | bigint FK | Links to `customers.id` |
| `property_type` | enum | LAND, HOUSE, APARTMENT, FLAT, HOTEL, OFFICE_SPACE, SHOP, ROOM, BUNGALOW, GODOWN, SHUTTER, RESTAURANT, MART, FANCY |
| `property_category` | enum | TOURISM, COMMERCIAL, SEMI_COMMERCIAL, RESIDENTIAL, AGRICULTURE |
| `property_address` | varchar | Tole / area name |
| `city` | varchar | City name |
| `district_id` | bigint FK | → `districts.id` |
| `municipal_id` | bigint FK | → `municipalities.id` |
| `province_id` | bigint FK | → `provinces.id` |
| `property_price` | varchar | Price value (e.g. "3", "1.5", "160") |
| `property_price_unit` | enum | CRORE, LAKHS, THOUSAND |
| `property_area` | varchar | Area value |
| `area_unit` | enum | HAAT, AANA, ROPANI, SQUARE_METER, SQUARE_FEET, BIGHA, KATTHA, DHUR |
| `layout` | varchar | e.g. "5BHK", "1R", "WHOLE_HOUSE" |
| `property_face` | enum | NORTH, SOUTH, EAST, WEST, NORTH-EAST, NORTH-WEST, SOUTH-EAST, ANY |
| `furnished` | enum | YES, NO |
| `compound` | enum | YES, NO |
| `parking_space` | enum | YES, NO, CAR, BIKE, BOTH |
| `amenities` | text | JSON array of amenities |
| `property_remarks` | longtext | Full description |
| `latitude` | decimal(10,7) | GPS latitude (from Nominatim geocoding) |
| `longitude` | decimal(10,7) | GPS longitude (from Nominatim geocoding) |
| `is_vectorized_complete` | boolean | Has this property been vectorized? |
| `last_vectorized_at` | timestamp | When it was last vectorized |
| `status` | enum | ACTIVE, INACTIVE, COMPLETE |

---

### `rental_owners` table — Properties for Rent

Same structure as `sellers` with these key differences:

| Column | Type | Description |
|--------|------|-------------|
| `rent_amount` | int | Monthly rent in NPR |
| `bedroom` | int | Number of bedrooms |
| `kitchen` | int | Number of kitchens |
| `living_room` | int | Number of living rooms |
| `address` | varchar | Property address (not `property_address`) |
| `remarks` | text | Description |
| `latitude` | decimal(10,7) | GPS latitude |
| `longitude` | decimal(10,7) | GPS longitude |
| `is_vectorized_complete` | boolean | Vectorization tracking |

---

### `customers` table — All People

| Column | Type | Description |
|--------|------|-------------|
| `id` | bigint PK | Customer ID |
| `name` | varchar | Full name |
| `customer_type` | enum | SELLER, BUYER, RENTAL_OWNER, TENANT |
| `primary_phone_num` | varchar | Phone number |
| `email` | varchar | Email address |
| `address` | varchar | Home address |
| `agent_id` | bigint FK | Assigned agent |

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
- Cloudflare account with Hyperdrive, Vectorize, and AI binding configured

### Install dependencies

```bash
npm install
```

### Start local dev with remote Cloudflare bindings

```bash
npx wrangler dev --remote --port 8787
```

> **Note:** Always use `--remote`. Hyperdrive requires a remote connection and does not support local MySQL emulation.

---

## 5. Connecting to the Database

### Via the Worker (recommended — no direct DB access needed)

```
Your App → Cloudflare Worker → Hyperdrive → MySQL (mysql.neptechpal.com.np)
```

Use `POST /api/query` to run any SQL query through the Worker.

### Via direct MySQL (admin tasks, if accessible)

```bash
mysql -h mysql.neptechpal.com.np -u sorhaaana -p sorha-aana
```

---

## 6. Querying the Database

```bash
curl -X POST https://sorha-aana-worker.neptechpal355.workers.dev/api/query \
  -H "Content-Type: application/json" \
  -d '{"sql": "SELECT * FROM sellers LIMIT 5"}'
```

### Common queries

**Properties with coordinates (geocoded):**
```json
{ "sql": "SELECT id, property_address, latitude, longitude FROM sellers WHERE latitude IS NOT NULL AND latitude != 0 LIMIT 10" }
```

**Geocoding coverage:**
```json
{ "sql": "SELECT SUM(CASE WHEN latitude > 0 THEN 1 ELSE 0 END) as geocoded, SUM(CASE WHEN latitude IS NULL THEN 1 ELSE 0 END) as pending, SUM(CASE WHEN latitude = 0 THEN 1 ELSE 0 END) as failed FROM sellers" }
```

**Vectorization status:**
```json
{ "sql": "SELECT COUNT(*) as total, SUM(is_vectorized_complete) as done FROM sellers" }
```

**Active properties for sale with location:**
```json
{ "sql": "SELECT s.id, s.property_type, s.property_address, s.property_price, s.property_price_unit, d.name as district, m.name as municipality FROM sellers s LEFT JOIN districts d ON s.district_id = d.id LEFT JOIN municipalities m ON s.municipal_id = m.id WHERE s.status = 'ACTIVE' ORDER BY s.id DESC LIMIT 20" }
```

**Properties by price range (1–2 crore houses):**
```json
{ "sql": "SELECT s.id, s.property_address, s.property_price, s.property_price_unit, s.layout FROM sellers s WHERE s.property_type = 'HOUSE' AND s.property_price_unit = 'CRORE' AND CAST(s.property_price AS DECIMAL) BETWEEN 1 AND 2 AND s.status = 'ACTIVE'" }
```

**Rental properties:**
```json
{ "sql": "SELECT ro.id, ro.property_type, ro.address, ro.rent_amount, ro.bedroom, d.name as district FROM rental_owners ro LEFT JOIN districts d ON ro.district_id = d.id WHERE ro.status = 'ACTIVE' LIMIT 20" }
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
| `sellers` | ~1,600 | ~3,200 |
| `rental_owners` | ~162 | ~324 |
| `buyers` | ~745 | ~1,490 |
| `tenants` | ~234 | ~468 |
| `agents` | ~118 | ~236 |
| **Total** | **~2,859** | **~5,718** |

### Run vectorization

```bash
# Incremental (only new / changed properties — recommended)
curl -X POST https://sorha-aana-worker.neptechpal355.workers.dev/api/vectorize \
  -H "Content-Type: application/json"

# Full reindex (all properties)
curl -X POST https://sorha-aana-worker.neptechpal355.workers.dev/api/vectorize/full \
  -H "Content-Type: application/json" \
  -d '{"mode": "full"}'
```

Both endpoints start the job in the background and return immediately. Due to the Cloudflare Workers Bundled plan 30-second wall time, each background run processes ~150 properties. Call the endpoint multiple times for large datasets — incremental mode skips already-vectorized rows.

### Check vectorization status

```bash
curl https://sorha-aana-worker.neptechpal355.workers.dev/api/vectorize/status
```

```json
{
  "vector_index": { "dimensions": 1024 },
  "database_tracking": {
    "total_properties": 1586,
    "vectorized": 1586,
    "pending": 0,
    "failed": 0,
    "last_vectorized_property": "1699"
  }
}
```

### How auto-vectorization works

The cron trigger runs **every 5 minutes** and calls `vectorizeProperties(incremental)`:
1. Queries `sellers` and `rental_owners` where `is_vectorized_complete = FALSE OR updated_at > last_vectorized_at`
2. Generates embeddings and upserts to Vectorize
3. Geocodes the property address if `latitude IS NULL`
4. Updates `is_vectorized_complete = TRUE`, `last_vectorized_at = NOW()`

> **Note:** DB triggers (for auto-queuing on INSERT/UPDATE/DELETE) cannot be created on this hosting server due to binary logging + SUPER privilege restriction. The incremental cron scan handles new and updated properties automatically.

---

## 8. Geocoding & Proximity Search

### How it works

Properties have `latitude` and `longitude` columns populated via [Nominatim](https://nominatim.openstreetmap.org/) (OpenStreetMap), scoped to Kaski district:

- **Bounding box:** `83.70,28.61,84.28,28.08` (Kaski district, Nepal)
- **Rate limit:** 1 request/second (Nominatim policy)
- **Coverage:** 1,317 / 1,762 properties geocoded (75%) — 445 failed due to incomplete addresses

### Geocoding status

```bash
curl https://sorha-aana-worker.neptechpal355.workers.dev/api/geocode/status
```

```json
{
  "sellers":  { "total": 1600, "geocoded": 1203, "pending": 0, "failed": 397 },
  "rentals":  { "total": 162,  "geocoded": 114,  "pending": 0, "failed": 48  },
  "total_geocoded": 1317,
  "total_pending": 0
}
```

### Batch geocode new properties

```bash
# Geocode up to 20 properties with NULL lat/lng (max 25 per call)
curl -X POST https://sorha-aana-worker.neptechpal355.workers.dev/api/geocode/batch \
  -H "Content-Type: application/json" \
  -d '{"batch_size": 20}'
```

> Properties that Nominatim cannot find are marked `latitude = 0` to prevent them from blocking the next batch. Auto-geocoding also runs for new properties after vectorization.

### Location detection in queries

The RAG engine detects location intent using these patterns:

| Pattern | Example | Extracted Location |
|---------|---------|-------------------|
| `near X` | `house near Chipledhunga` | `Chipledhunga` |
| `around X` | `land around Sarangkot` | `Sarangkot` |
| `close to X` | `flat close to Lakeside` | `Lakeside` |
| `X najik` | `Malepatan najik ghar` | `Malepatan` |
| `X tira` | `bazar tira flat` | `bazar` |
| `X nera` | `school nera property` | `school` |

When a location is detected:
- Properties within **5 km** are fetched from MySQL using the haversine formula
- Combined score: `0.6 × proximity_score + 0.4 × similarity_score`
- Results include `distance_km` field

---

## 9. RAG Search

### POST /search

```bash
curl -X POST https://sorha-aana-worker.neptechpal355.workers.dev/search \
  -H "Content-Type: application/json" \
  -d '{"query": "house near Lakeside Pokhara under 2 crore"}'
```

### Proximity search examples

```json
{ "query": "house near Chipledhunga" }
{ "query": "land around Sarangkot" }
{ "query": "flat near Lakeside under 40000 per month" }
{ "query": "Malepatan najik ghar bikri" }
{ "query": "Damside tira property" }
{ "query": "room nera school Pokhara" }
```

### Property for Sale queries

```json
{ "query": "house in Pokhara under 2 crore" }
{ "query": "land near Pokhara lake with road access" }
{ "query": "commercial property Kaski district" }
{ "query": "hotel property for sale in tourist area" }
{ "query": "Pokhara ma ghar khojdai chu budget 1.5 crore" }
```

### Rental property queries

The system detects rental intent from keywords like `rent`, `bhadama`, `kiraya`, `monthly`, `per month`:

```json
{ "query": "2 bedroom flat for rent Lakeside under 35000 per month" }
{ "query": "office space bhadama Chipledhunga" }
{ "query": "room kiraya Damside area" }
{ "query": "flat near Sarangkot bhadama" }
```

### Buyer queries

```json
{ "query": "buyers looking for land in Pokhara budget 1 crore" }
{ "query": "who wants to buy a house in Kaski district" }
{ "query": "ghar kinna khojne manche Pokhara ma" }
```

### Tenant queries

```json
{ "query": "tenants seeking 2BHK flat under 15000 per month" }
{ "query": "who is looking to rent near Lakeside" }
{ "query": "bhadama khojne manche" }
```

### Agent queries

```json
{ "query": "real estate agents working in Kaski" }
{ "query": "agent in Pokhara for residential property" }
```

### Response format

```json
{
  "query": "house near Chipledhunga",
  "answer": "AI-generated answer...",
  "properties": [
    {
      "id": 123,
      "source_table": "sellers",
      "listing_type": "Sale",
      "title": "House for Sale in Chipledhunga",
      "property_type": "House",
      "property_category": "Residential",
      "location": "Chipledhunga, Pokhara, Kaski",
      "district": "Kaski",
      "municipality": "Pokhara",
      "price": "NPR 2 Crore",
      "price_npr": 20000000,
      "area": "6 Aana",
      "layout": "4BHK",
      "bedrooms": 4,
      "facing": "East",
      "road_access": "16 ft Black-Topped road",
      "amenities": ["Parking", "Water Tank"],
      "similarity": 0.82,
      "distance_km": 0.35
    }
  ],
  "total_results": 10,
  "listing_intent": "sale"
}
```

| Field | Description |
|-------|-------------|
| `source_table` | `sellers`, `rental_owners`, `buyers`, `tenants`, or `agents` |
| `listing_type` | `Sale`, `Rent`, `Buyer`, `Tenant`, or `Agent` |
| `similarity` | Vector similarity score (0–1) |
| `distance_km` | Physical distance from queried location (null if no proximity search) |

---

## 10. All API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/` | Web UI |
| GET | `/api-docs` | Swagger UI |
| GET | `/swagger.json` | OpenAPI spec |
| GET | `/status` | Vectorize index status |
| POST | `/search` | **RAG semantic + proximity search** |
| GET | `/test` | Quick test (searches "apartments") |
| POST | `/api/vectorize` | Start incremental vectorization (background) |
| POST | `/api/vectorize/full` | Start full or incremental reindex |
| GET | `/api/vectorize/status` | Vectorization progress with DB tracking |
| GET | `/api/vectorization-stats` | Full stats (vectors + queue) |
| POST | `/api/vectorize/queue/process` | Process pending queue jobs manually |
| GET | `/api/vectorize/queue/status` | Queue status |
| POST | `/api/geocode/batch` | Batch geocode properties (`{"batch_size": 20}`) |
| GET | `/api/geocode/status` | Geocoding coverage stats |
| GET | `/api/db-schema` | Full DB schema (JSON or `?format=text`) |
| POST | `/api/query` | Run any SQL query |
| GET | `/api/properties` | List properties (`?type=sale\|rent\|all`) |
| GET | `/api/properties/:id` | Get property (`?table=sellers\|rental_owners`) |

---

## 11. Running the Migrations

Migrations add coordinates and vectorization tracking to the database. Since direct MySQL access may not always be available, all migrations can be run through the Worker's `/api/query` endpoint.

### Migration 002 — Coordinates (lat/lng)

```bash
curl -X POST https://sorha-aana-worker.neptechpal355.workers.dev/api/query \
  -H "Content-Type: application/json" \
  -d '{"sql": "ALTER TABLE sellers ADD COLUMN latitude DECIMAL(10,7) NULL, ADD COLUMN longitude DECIMAL(10,7) NULL, ADD INDEX idx_sellers_coords (latitude, longitude)"}'

curl -X POST https://sorha-aana-worker.neptechpal355.workers.dev/api/query \
  -H "Content-Type: application/json" \
  -d '{"sql": "ALTER TABLE rental_owners ADD COLUMN latitude DECIMAL(10,7) NULL, ADD COLUMN longitude DECIMAL(10,7) NULL, ADD INDEX idx_rental_coords (latitude, longitude)"}'
```

### Migration 001 — Vectorization tracking

```bash
# Tracking columns on sellers
curl -X POST https://sorha-aana-worker.neptechpal355.workers.dev/api/query \
  -H "Content-Type: application/json" \
  -d '{"sql": "ALTER TABLE sellers ADD COLUMN is_vectorized_complete BOOLEAN DEFAULT FALSE, ADD COLUMN last_vectorized_at TIMESTAMP NULL, ADD COLUMN vector_version INT DEFAULT 0, ADD COLUMN vectorization_error_message TEXT NULL"}'

# Same for rental_owners
curl -X POST https://sorha-aana-worker.neptechpal355.workers.dev/api/query \
  -H "Content-Type: application/json" \
  -d '{"sql": "ALTER TABLE rental_owners ADD COLUMN is_vectorized_complete BOOLEAN DEFAULT FALSE, ADD COLUMN last_vectorized_at TIMESTAMP NULL, ADD COLUMN vector_version INT DEFAULT 0, ADD COLUMN vectorization_error_message TEXT NULL"}'

# Create vectorization_queue table
curl -X POST https://sorha-aana-worker.neptechpal355.workers.dev/api/query \
  -H "Content-Type: application/json" \
  -d '{"sql": "CREATE TABLE IF NOT EXISTS vectorization_queue (id INT AUTO_INCREMENT PRIMARY KEY, property_id BIGINT UNSIGNED NOT NULL, source_table ENUM(\"sellers\",\"rental_owners\") NOT NULL, action ENUM(\"insert\",\"update\",\"delete\") NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, processed_at TIMESTAMP NULL, status ENUM(\"pending\",\"processing\",\"completed\",\"failed\") DEFAULT \"pending\", error_message TEXT NULL, retry_count INT DEFAULT 0, INDEX idx_status (status), INDEX idx_pending (status, created_at), UNIQUE KEY unique_pending (property_id, source_table, action, status)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4"}'
```

> **Note:** DB triggers (in `migrations/001_add_vectorization_tracking.sql`) cannot be created if the MySQL user lacks SUPER privilege with binary logging enabled. The incremental cron scan handles new properties automatically without triggers.

### After migration — batch geocode all existing properties

```bash
# Check how many need geocoding
curl https://sorha-aana-worker.neptechpal355.workers.dev/api/geocode/status

# Run batches in a loop (each batch = 20 properties, ~22s)
while true; do
  RESULT=$(curl -s -X POST https://sorha-aana-worker.neptechpal355.workers.dev/api/geocode/batch \
    -H "Content-Type: application/json" -d '{"batch_size": 20}')
  PENDING=$(echo $RESULT | grep -o '"sellers":[0-9]*' | grep -o '[0-9]*')
  echo "Remaining: $PENDING"
  [ "$PENDING" -le 0 ] && break
  sleep 5
done
```

---

## 12. Deployment

```bash
npm run deploy
```

Production URL: `https://sorha-aana-worker.neptechpal355.workers.dev`

### Environment variables (`wrangler.json` → `vars`)

| Variable | Default | Description |
|----------|---------|-------------|
| `ENVIRONMENT` | development | Environment name |
| `MAX_RESULTS` | 10 | Max properties to return per search |
| `PRICE_TOLERANCE` | 0.1 | ±10% price tolerance for matches |

---

## 13. Troubleshooting

### `wrangler dev` fails with Hyperdrive error

Always use `wrangler dev --remote`. Hyperdrive does not support local MySQL emulation.

### `/search` returns 0 results

Vectorize index may be empty. Run full vectorization:
```bash
curl -X POST https://sorha-aana-worker.neptechpal355.workers.dev/api/vectorize/full \
  -H "Content-Type: application/json" -d '{"mode": "full"}'
```
Call it multiple times if needed — each run processes ~150 properties due to the 30s time limit.

### Proximity search returns no nearby results

The queried location may not be in Nominatim's database for Kaski district, or properties in that area may not have been geocoded. Check:
```bash
curl https://sorha-aana-worker.neptechpal355.workers.dev/api/geocode/status
```

### Queue processor returns "Table vectorization_queue doesn't exist"

Run Migration 001 via `/api/query` as shown in section 11. This is a one-time setup.

### `distance_km` is null on results

Only applies when a location is detected in the query (e.g. "near X", "X najik"). Without a location keyword, all results come from vector search and `distance_km` is null.

### AI answer is generic or unhelpful

Check vectorization status — the index may have stale or missing data:
```bash
curl https://sorha-aana-worker.neptechpal355.workers.dev/api/vectorize/status
```

---

## Quick Reference

```bash
# Development server
npx wrangler dev --remote --port 8787

# Proximity search
curl -X POST http://127.0.0.1:8787/search \
  -H "Content-Type: application/json" \
  -d '{"query": "house near Lakeside Pokhara"}'

# Nepali proximity search
curl -X POST http://127.0.0.1:8787/search \
  -H "Content-Type: application/json" \
  -d '{"query": "Malepatan najik ghar bikri"}'

# Price-filtered rental
curl -X POST http://127.0.0.1:8787/search \
  -H "Content-Type: application/json" \
  -d '{"query": "2BHK flat bhadama Chipledhunga under 35000"}'

# Buyer search
curl -X POST http://127.0.0.1:8787/search \
  -H "Content-Type: application/json" \
  -d '{"query": "buyers looking for land in Pokhara budget 1 crore"}'

# Agent search
curl -X POST http://127.0.0.1:8787/search \
  -H "Content-Type: application/json" \
  -d '{"query": "real estate agents working in Kaski"}'

# Geocoding status
curl http://127.0.0.1:8787/api/geocode/status

# Vectorization status
curl http://127.0.0.1:8787/api/vectorize/status

# Run incremental vectorization
curl -X POST http://127.0.0.1:8787/api/vectorize \
  -H "Content-Type: application/json"

# Run any SQL query
curl -X POST http://127.0.0.1:8787/api/query \
  -H "Content-Type: application/json" \
  -d '{"sql": "SELECT COUNT(*) FROM sellers WHERE latitude > 0"}'

# Full DB schema
curl http://127.0.0.1:8787/api-docs

# Deploy to production
npm run deploy
```
