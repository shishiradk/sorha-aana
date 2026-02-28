// src/batch-geocode.ts
// Batch geocoding for properties via Worker (no direct MySQL access needed)
// Uses Nominatim (OpenStreetMap) — 1 req/sec rate limit

import { geocodeLocation } from './geocoding';
import { queryAll, queryExecute } from './db-utils';

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

interface GeocodeResult {
  table: string;
  id: number;
  address: string;
  lat?: number;
  lng?: number;
  status: 'success' | 'failed' | 'skipped';
}

interface BatchResult {
  processed: number;
  success: number;
  failed: number;
  skipped: number;
  remaining: { sellers: number; rentals: number };
  results: GeocodeResult[];
}

/**
 * Get count of properties that still need geocoding
 */
export async function getGeocodeStatus(env: any): Promise<{
  sellers: { total: number; geocoded: number; pending: number };
  rentals: { total: number; geocoded: number; pending: number };
}> {
  const sellerStats = await queryAll(env, `
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN latitude IS NOT NULL AND latitude != 0 THEN 1 ELSE 0 END) as geocoded,
      SUM(CASE WHEN latitude IS NULL THEN 1 ELSE 0 END) as pending,
      SUM(CASE WHEN latitude = 0 THEN 1 ELSE 0 END) as failed
    FROM sellers
  `);

  const rentalStats = await queryAll(env, `
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN latitude IS NOT NULL AND latitude != 0 THEN 1 ELSE 0 END) as geocoded,
      SUM(CASE WHEN latitude IS NULL THEN 1 ELSE 0 END) as pending,
      SUM(CASE WHEN latitude = 0 THEN 1 ELSE 0 END) as failed
    FROM rental_owners
  `);

  const s = sellerStats.results[0] || { total: 0, geocoded: 0, pending: 0, failed: 0 };
  const r = rentalStats.results[0] || { total: 0, geocoded: 0, pending: 0, failed: 0 };

  return {
    sellers: { total: Number(s.total), geocoded: Number(s.geocoded), pending: Number(s.pending), failed: Number(s.failed) },
    rentals: { total: Number(r.total), geocoded: Number(r.geocoded), pending: Number(r.pending), failed: Number(r.failed) },
  };
}

/**
 * Process a batch of properties: geocode and update lat/lng
 * Processes sellers first, then rental_owners
 * Respects Nominatim 1 req/sec rate limit
 */
export async function batchGeocode(env: any, batchSize: number = 20): Promise<BatchResult> {
  const results: GeocodeResult[] = [];
  let success = 0;
  let failed = 0;
  let skipped = 0;

  // Fetch sellers needing geocoding
  const { results: sellers } = await queryAll(env, `
    SELECT s.id, s.property_address, s.city,
           d.name as district_name, m.name as municipality_name
    FROM sellers s
    LEFT JOIN districts d ON s.district_id = d.id
    LEFT JOIN municipalities m ON s.municipal_id = m.id
    WHERE s.latitude IS NULL
    ORDER BY s.id
    LIMIT ?
  `, [batchSize]);

  for (const row of sellers) {
    const addressParts = [row.property_address, row.municipality_name, row.district_name].filter(Boolean);
    const addressStr = addressParts.join(', ');

    if (!addressStr || addressStr.trim() === '') {
      await queryExecute(env,
        'UPDATE sellers SET latitude = 0, longitude = 0 WHERE id = ?',
        [row.id]
      );
      skipped++;
      results.push({ table: 'sellers', id: row.id, address: '', status: 'skipped' });
      continue;
    }

    try {
      const coords = await geocodeLocation(addressStr);
      if (coords) {
        await queryExecute(env,
          'UPDATE sellers SET latitude = ?, longitude = ? WHERE id = ?',
          [coords.lat, coords.lng, row.id]
        );
        success++;
        results.push({ table: 'sellers', id: row.id, address: addressStr, lat: coords.lat, lng: coords.lng, status: 'success' });
      } else {
        // Mark as attempted (0,0) so it doesn't block the next batch
        await queryExecute(env,
          'UPDATE sellers SET latitude = 0, longitude = 0 WHERE id = ?',
          [row.id]
        );
        failed++;
        results.push({ table: 'sellers', id: row.id, address: addressStr, status: 'failed' });
      }
    } catch (err: any) {
      await queryExecute(env,
        'UPDATE sellers SET latitude = 0, longitude = 0 WHERE id = ?',
        [row.id]
      ).catch(() => {});
      failed++;
      results.push({ table: 'sellers', id: row.id, address: addressStr, status: 'failed' });
    }

    // Nominatim rate limit: 1 req/sec
    await sleep(1100);
  }

  // If we still have room in the batch, process rental_owners
  const remaining = batchSize - sellers.length;
  if (remaining > 0) {
    const { results: rentals } = await queryAll(env, `
      SELECT ro.id, ro.address, ro.city,
             d.name as district_name, m.name as municipality_name
      FROM rental_owners ro
      LEFT JOIN districts d ON ro.district_id = d.id
      LEFT JOIN municipalities m ON ro.municipal_id = m.id
      WHERE ro.latitude IS NULL
      ORDER BY ro.id
      LIMIT ?
    `, [remaining]);

    for (const row of rentals) {
      const addressParts = [row.address, row.municipality_name, row.district_name].filter(Boolean);
      const addressStr = addressParts.join(', ');

      if (!addressStr || addressStr.trim() === '') {
        await queryExecute(env,
          'UPDATE rental_owners SET latitude = 0, longitude = 0 WHERE id = ?',
          [row.id]
        );
        skipped++;
        results.push({ table: 'rental_owners', id: row.id, address: '', status: 'skipped' });
        continue;
      }

      try {
        const coords = await geocodeLocation(addressStr);
        if (coords) {
          await queryExecute(env,
            'UPDATE rental_owners SET latitude = ?, longitude = ? WHERE id = ?',
            [coords.lat, coords.lng, row.id]
          );
          success++;
          results.push({ table: 'rental_owners', id: row.id, address: addressStr, lat: coords.lat, lng: coords.lng, status: 'success' });
        } else {
          await queryExecute(env,
            'UPDATE rental_owners SET latitude = 0, longitude = 0 WHERE id = ?',
            [row.id]
          );
          failed++;
          results.push({ table: 'rental_owners', id: row.id, address: addressStr, status: 'failed' });
        }
      } catch (err: any) {
        await queryExecute(env,
          'UPDATE rental_owners SET latitude = 0, longitude = 0 WHERE id = ?',
          [row.id]
        ).catch(() => {});
        failed++;
        results.push({ table: 'rental_owners', id: row.id, address: addressStr, status: 'failed' });
      }

      await sleep(1100);
    }
  }

  // Get remaining counts
  const status = await getGeocodeStatus(env);

  return {
    processed: results.length,
    success,
    failed,
    skipped,
    remaining: { sellers: status.sellers.pending, rentals: status.rentals.pending },
    results,
  };
}
