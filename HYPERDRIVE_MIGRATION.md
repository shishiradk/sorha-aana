# D1 to Hyperdrive Migration Guide

## Overview
This project has been migrated from Cloudflare D1 (SQLite) to Hyperdrive (MySQL proxy).

## Changes Made

### 1. **wrangler.json**
- ❌ Removed: `d1_databases` binding configuration
- ✅ Added: `hyperdrive` binding with ID `sorha-aana-db`
- ✅ Updated: Vector index name from `embeddings-index` to `sorha-index`

### 2. **Environment Variables (Env Interface)**
Updated in all TypeScript files:
- ❌ `DB: D1Database` 
- ✅ `HYPERDRIVE: any` (MySQL connection via Hyperdrive)

### 3. **Database Access Pattern**
Created new utility file: [src/db-utils.ts](src/db-utils.ts)

**Old D1 Pattern:**
```typescript
const { results } = await env.DB.prepare(sql).bind(...params).all();
const row = await env.DB.prepare(sql).bind(id).first();
```

**New Hyperdrive Pattern:**
```typescript
import { queryAll, queryOne } from './db-utils';

const { results } = await queryAll(env, sql, params);
const row = await queryOne(env, sql, params);
```

### 4. **Updated Files**
- [src/index.ts](src/index.ts) - Updated Env interface
- [src/rag-engine.ts](src/rag-engine.ts) - Updated queries to use `queryAll()`
- [src/vectorize.ts](src/vectorize.ts) - Updated queries to use `queryAll()`
- [src/api.ts](src/api.ts) - Updated queries to use `queryAll()` and `queryOne()`
- [src/db-utils.ts](src/db-utils.ts) - **NEW** MySQL client utilities

## Required Setup Steps

### Step 1: Install MySQL Client
```bash
npm install mysql2
npm install --save-dev @types/mysql2
```

*Note: The migration uses the `mysql2` library with Promise support. This is compatible with Hyperdrive's MySQL connections.*

### Step 2: Set Up Hyperdrive Database
1. Ensure you have a MySQL database
2. Configure Hyperdrive in Cloudflare Workers:
   - Create a Hyperdrive configuration named `sorha-aana-db`
   - Point it to your MySQL database
   - Ensure your connection credentials are secure

### Step 3: Migrate Your Database Schema
Since you're moving from SQLite (D1) to MySQL (Hyperdrive):
- Export your D1 schema
- Update any SQLite-specific syntax to MySQL
- Create tables in your MySQL database

### Step 4: SQL Syntax Updates
**Key differences between D1 (SQLite) and Hyperdrive (MySQL):**

| Feature | D1 (SQLite) | Hyperdrive (MySQL) |
|---------|-------------|-------------------|
| Parameterized queries | `?` | `?` (same) |
| Data types | LIMITED | INT, VARCHAR, TEXT, JSON, etc. |
| JSON fields | Text/JSON string | JSON type (native) |
| Constraints | LIMITED | FULL support |
| Full-text search | LIMITED | FULLTEXT indexes |
| Transactions | Basic | ACID transactions |

**Good news:** MySQL uses the same `?` placeholder syntax as SQLite, so no placeholder conversion needed!

### Step 5: Query Examples
```typescript
// Simple SELECT
const { results } = await queryAll(env, 'SELECT * FROM seller_listings LIMIT 50');

// With parameters
const { results } = await queryAll(env, 'SELECT * FROM seller_listings WHERE city = ?', ['Kathmandu']);

// Get single row
const property = await queryOne(env, 'SELECT * FROM seller_listings WHERE property_id = ?', [123]);

// Multiple parameters
const { results } = await queryAll(env, 
  'SELECT * FROM seller_listings WHERE city = ? AND price > ?', 
  ['Kathmandu', 5000000]
);
```

## Vector Index Changes
- ✅ Binding name stays: `VECTOR_INDEX`
- ✅ Vector dimensions: Still 1024 (from `@cf/baai/bge-large-en-v1.5` model)
- ✅ Index name updated: `embeddings-index` → `sorha-index`

## Testing the Migration

```bash
# Install dependencies
npm install

# Start development server
npm run dev

# Test endpoints
curl http://localhost:8787/test
curl http://localhost:8787/api/properties
```

## Troubleshooting

### Connection Error: "timeout"
- Ensure Hyperdrive is properly configured
- Check that your MySQL database is accessible
- Verify the `sorha-aana-db` Hyperdrive configuration exists
- Check MySQL server is running and accepting connections

### TypeError: "mysql is not defined"
- Make sure `mysql2` package is installed: `npm install mysql2`
- Clear node_modules and reinstall: `rm -rf node_modules && npm install`

### SQL Error: "Unknown column"
- Check table schema matches your MySQL database
- Verify column names are correct
- MySQL is case-sensitive for column names on some systems

### Vector Index Error
- Verify the index name is `sorha-index`
- Check that embeddings were successfully indexed

## MySQL vs SQLite Differences

### Data Types
```sql
-- SQLite (D1)
CREATE TABLE properties (
  id TEXT PRIMARY KEY,
  price INTEGER,
  data TEXT  -- Stored as text
);

-- MySQL (Hyperdrive)
CREATE TABLE properties (
  id VARCHAR(255) PRIMARY KEY,
  price INT,
  data JSON  -- Native JSON support
);
```

### JSON Handling
```typescript
// SQLite - manual parsing
const data = JSON.parse(property.data);

// MySQL - native JSON support
const data = property.data; // Already parsed if using JSON type
// For JSON fields, you can also use JSON functions:
// SELECT JSON_EXTRACT(data, '$.field') FROM properties;
```

## Additional Resources
- [Cloudflare Hyperdrive Documentation](https://developers.cloudflare.com/hyperdrive/)
- [MySQL Documentation](https://dev.mysql.com/doc/)
- [mysql2 Documentation](https://github.com/sidorares/node-mysql2)

## Rollback (if needed)
To revert to D1:
1. Restore the original wrangler.json
2. Change all `HYPERDRIVE` references back to `DB: D1Database`  
3. Change database utility calls back to `.prepare().bind().all()`
4. Reinstall `pg` instead of `mysql2` package
