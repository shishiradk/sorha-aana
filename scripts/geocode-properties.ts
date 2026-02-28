// scripts/geocode-properties.ts
// One-time batch geocoding for existing sellers + rental_owners
// Uses Nominatim (OpenStreetMap) — free, no API key needed
// Rate limit: 1 req/sec (Nominatim policy)
//
// Usage:
//   npx tsx scripts/geocode-properties.ts
//
// Requires: Direct MySQL access (not Hyperdrive)
// Set env vars: DB_HOST, DB_USER, DB_PASSWORD, DB_NAME

import { createConnection } from 'mysql2/promise';

// Kaski district bounding box
const KASKI_VIEWBOX = '83.70,28.61,84.28,28.08';

async function geocode(locationText: string): Promise<{ lat: number; lng: number } | null> {
  const query = `${locationText} Kaski Nepal`;
  const url = `https://nominatim.openstreetmap.org/search?` +
    `q=${encodeURIComponent(query)}` +
    `&format=json&limit=1` +
    `&viewbox=${KASKI_VIEWBOX}&bounded=1`;

  const res = await fetch(url, {
    headers: { 'User-Agent': 'sorha-aana-geocoder/1.0' }
  });

  if (!res.ok) return null;

  const data = await res.json() as any[];
  if (!data || data.length === 0) return null;

  const lat = parseFloat(data[0].lat);
  const lng = parseFloat(data[0].lon);
  if (isNaN(lat) || isNaN(lng)) return null;

  return { lat, lng };
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  const host = process.env.DB_HOST || 'mysql.neptechpal.com.np';
  const user = process.env.DB_USER || 'sorhaaana';
  const password = process.env.DB_PASSWORD;
  const database = process.env.DB_NAME || 'sorha-aana';

  if (!password) {
    console.error('ERROR: Set DB_PASSWORD environment variable');
    console.error('Usage: DB_PASSWORD=yourpass npx tsx scripts/geocode-properties.ts');
    process.exit(1);
  }

  const connection = await createConnection({ host, user, password, database });
  console.log('Connected to database\n');

  let geocoded = 0;
  let failed = 0;
  let skipped = 0;
  const failures: { table: string; id: number; address: string }[] = [];

  // Process sellers
  console.log('=== GEOCODING SELLERS ===');
  const [sellers] = await connection.query(
    `SELECT s.id, s.property_address, s.city, d.name as district_name, m.name as municipality_name
     FROM sellers s
     LEFT JOIN districts d ON s.district_id = d.id
     LEFT JOIN municipalities m ON s.municipal_id = m.id
     WHERE s.latitude IS NULL
     ORDER BY s.id`
  ) as any[];

  console.log(`Found ${sellers.length} sellers to geocode\n`);

  for (const row of sellers) {
    const addressParts = [row.property_address, row.municipality_name, row.district_name].filter(Boolean);
    const addressStr = addressParts.join(', ');

    if (!addressStr || addressStr.trim() === '') {
      skipped++;
      continue;
    }

    try {
      const coords = await geocode(addressStr);
      if (coords) {
        await connection.query(
          'UPDATE sellers SET latitude = ?, longitude = ? WHERE id = ?',
          [coords.lat, coords.lng, row.id]
        );
        geocoded++;
        if (geocoded % 50 === 0) console.log(`  Progress: ${geocoded} geocoded, ${failed} failed`);
      } else {
        failed++;
        failures.push({ table: 'sellers', id: row.id, address: addressStr });
      }
    } catch (err: any) {
      failed++;
      failures.push({ table: 'sellers', id: row.id, address: addressStr });
      console.error(`  Error for seller ${row.id}: ${err.message}`);
    }

    // Rate limit: 1 request/second (Nominatim policy)
    await sleep(1100);
  }

  console.log(`\nSellers done: ${geocoded} geocoded, ${failed} failed, ${skipped} skipped\n`);

  // Reset counters for rentals
  const sellerGeocoded = geocoded;
  const sellerFailed = failed;
  geocoded = 0;
  failed = 0;
  skipped = 0;

  // Process rental_owners
  console.log('=== GEOCODING RENTAL OWNERS ===');
  const [rentals] = await connection.query(
    `SELECT ro.id, ro.address, ro.city, d.name as district_name, m.name as municipality_name
     FROM rental_owners ro
     LEFT JOIN districts d ON ro.district_id = d.id
     LEFT JOIN municipalities m ON ro.municipal_id = m.id
     WHERE ro.latitude IS NULL
     ORDER BY ro.id`
  ) as any[];

  console.log(`Found ${rentals.length} rentals to geocode\n`);

  for (const row of rentals) {
    const addressParts = [row.address, row.municipality_name, row.district_name].filter(Boolean);
    const addressStr = addressParts.join(', ');

    if (!addressStr || addressStr.trim() === '') {
      skipped++;
      continue;
    }

    try {
      const coords = await geocode(addressStr);
      if (coords) {
        await connection.query(
          'UPDATE rental_owners SET latitude = ?, longitude = ? WHERE id = ?',
          [coords.lat, coords.lng, row.id]
        );
        geocoded++;
        if (geocoded % 20 === 0) console.log(`  Progress: ${geocoded} geocoded, ${failed} failed`);
      } else {
        failed++;
        failures.push({ table: 'rental_owners', id: row.id, address: addressStr });
      }
    } catch (err: any) {
      failed++;
      failures.push({ table: 'rental_owners', id: row.id, address: addressStr });
      console.error(`  Error for rental ${row.id}: ${err.message}`);
    }

    await sleep(1100);
  }

  console.log(`\nRentals done: ${geocoded} geocoded, ${failed} failed, ${skipped} skipped`);

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('GEOCODING COMPLETE');
  console.log('='.repeat(60));
  console.log(`Sellers:  ${sellerGeocoded} geocoded, ${sellerFailed} failed`);
  console.log(`Rentals:  ${geocoded} geocoded, ${failed} failed`);
  console.log(`Total:    ${sellerGeocoded + geocoded} geocoded, ${sellerFailed + failed} failed`);

  if (failures.length > 0) {
    console.log(`\nFailed addresses (${failures.length}):`);
    failures.slice(0, 20).forEach(f => {
      console.log(`  ${f.table} #${f.id}: "${f.address}"`);
    });
    if (failures.length > 20) {
      console.log(`  ... and ${failures.length - 20} more`);
    }
  }

  // Estimated time
  const totalRows = sellers.length + rentals.length;
  console.log(`\nTime estimate for all: ~${Math.ceil(totalRows * 1.1 / 60)} minutes (1 req/sec Nominatim rate limit)`);

  await connection.end();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
