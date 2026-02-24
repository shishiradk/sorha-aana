# Database Schema Inspection Guide

## Overview
This guide helps you discover your MySQL database structure through Hyperdrive. There are two methods:

1. **Standalone Script** - Run locally with Node.js
2. **API Endpoint** - Query via HTTP after deploying the worker

---

## Method 1: Standalone Script (Recommended for local inspection)

### Usage

Run the inspection script:
```bash
node inspect-database.js
```

### Setting Connection String

**Option A: Environment Variable**
```bash
# Windows PowerShell
$env:HYPERDRIVE_CONNECTION_STRING = "mysql://user:password@hostname:3306/dbname"
node inspect-database.js

# Linux/Mac
export HYPERDRIVE_CONNECTION_STRING="mysql://user:password@hostname:3306/dbname"
node inspect-database.js
```

**Option B: Hardcoded in Script**
Edit `inspect-database.js` and update:
```javascript
const CONNECTION_STRING = 'mysql://root:password123@localhost:3306/database_name';
```

### Connection String Format
```
mysql://username:password@hostname:port/database_name
```

**Examples:**
```
mysql://root:password@localhost:3306/sorha_db
mysql://user:pass@192.168.1.100:3306/real_estate
mysql://admin:secure123@db.example.com:3306/nepal_properties
```

### Output Example

```
100 =======================================================================================================
DATABASE SCHEMA INSPECTION
====================================================================================================

📋 TABLE: seller_listings (125 rows)
----------------------------------------------------------------------------------------------------
Column Name                  | Type              | Nullable | Key | Extra                | Default
----------------------------------------------------------------------------------------------------
property_id                  | varchar(255)      | NO       | PRI | auto_increment       | NULL
title                        | varchar(500)      | NO       |     |                      | NULL
city                         | varchar(100)      | YES      |     |                      | NULL
area                         | varchar(100)      | YES      |     |                      | NULL
price                        | int(11)           | YES      |     |                      | NULL
description                 | text              | YES      |     |                      | NULL
property_type               | varchar(50)       | YES      |     |                      | NULL
listing_type                | varchar(50)       | YES      |     |                      | NULL
bedrooms                    | int(11)           | YES      |     |                      | NULL
bathrooms                   | int(11)           | YES      |     |                      | NULL
...
```

---

## Method 2: API Endpoint (After deploying worker)

### Prerequisites
- Deploy your worker to Cloudflare: `npm run deploy`
- Hyperdrive must be properly configured

### Endpoints

**JSON Format (detailed):**
```bash
curl http://localhost:8787/api/db-schema
```

**Plain Text Format (human-readable):**
```bash
curl "http://localhost:8787/api/db-schema?format=text"
```

### JSON Response Example
```json
[
  {
    "table_name": "seller_listings",
    "columns": [
      {
        "column_name": "property_id",
        "data_type": "varchar",
        "is_nullable": "NO",
        "column_key": "PRI",
        "extra": "auto_increment",
        "column_default": null
      },
      {
        "column_name": "title",
        "data_type": "varchar",
        "is_nullable": "NO",
        "column_key": "",
        "extra": "",
        "column_default": null
      }
    ]
  }
]
```

---

## Next Steps After Inspection

Once you know your table structure:

1. **Update TypeScript interfaces** - Create types matching your MySQL schema
   ```typescript
   export interface Property {
     property_id: string;
     title: string;
     city: string;
     price: number;
     bedrooms: number;
     // ... other fields
   }
   ```

2. **Verify queries work** - Test the RAG engine and API endpoints
   ```bash
   npm run dev
   curl http://localhost:8787/test
   ```

3. **Configure vectorize** - Update the vectorization script with correct column names

---

## Troubleshooting

### "Error: connect ECONNREFUSED"
- Database is not accessible at the specified host:port
- Check MySQL is running
- Verify firewall allows connection

### "Error: Access denied for user"
- Wrong username or password
- User doesn't have permissions on that database
- Try with a different user account

### "Error: Unknown database"
- Database name is incorrect
- Database doesn't exist
- User doesn't have access to that database

### Script hangs after "Connected to database"
- Might be loading table information
- Wait a few seconds
- Check MySQL logs for errors

---

## Common Table Structures

### Expected for Real Estate App

```
seller_listings (main properties table)
├── property_id (VARCHAR, Primary Key)
├── title (VARCHAR)
├── city (VARCHAR)
├── area (VARCHAR)
├── price (INT or DECIMAL)
├── bedrooms (INT)
├── bathrooms (INT)
├── description (TEXT)
├── property_type (VARCHAR)
├── listing_type (VARCHAR)
├── furnishing_status (VARCHAR)
├── built_up_area (INT or DECIMAL)
├── amenities (JSON or TEXT)
├── highlights (JSON or TEXT)
├── suitable_for (JSON or TEXT)
├── nearby_landmarks (TEXT)
├── negotiable (BOOLEAN or TINYINT)
├── listing_code (VARCHAR)
└── created_at (DATETIME)
```

If your structure differs, update the code accordingly!

---

## Quick Commands

```bash
# Run inspection script with environment variable
$env:HYPERDRIVE_CONNECTION_STRING = "mysql://root:password@localhost:3306/db"; node inspect-database.js

# Save output to file (PowerShell)
$env:HYPERDRIVE_CONNECTION_STRING = "mysql://root:password@localhost:3306/db"; node inspect-database.js | Out-File schema.txt

# View only table names
node inspect-database.js | Select-String "TABLE:" 
```
