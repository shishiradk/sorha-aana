-- migrations/002_add_coordinates.sql
-- Adds lat/lng coordinates to sellers and rental_owners for proximity search
-- Uses Nominatim (OpenStreetMap) geocoding — no API key needed

-- Add coordinates to sellers
ALTER TABLE sellers
  ADD COLUMN latitude  DECIMAL(10, 7) NULL,
  ADD COLUMN longitude DECIMAL(10, 7) NULL,
  ADD INDEX idx_sellers_coords (latitude, longitude);

-- Add coordinates to rental_owners
ALTER TABLE rental_owners
  ADD COLUMN latitude  DECIMAL(10, 7) NULL,
  ADD COLUMN longitude DECIMAL(10, 7) NULL,
  ADD INDEX idx_rental_coords (latitude, longitude);
