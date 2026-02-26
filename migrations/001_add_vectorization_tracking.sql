-- Migration: Add vectorization tracking to sellers + rental_owners
-- Database: sorha-aana
-- Date: 2026-02-26
-- Purpose: Enable incremental vectorization and automatic change detection

-- ============================================================
-- Step 1: Add tracking columns to sellers table
-- ============================================================

ALTER TABLE sellers ADD COLUMN IF NOT EXISTS is_vectorized_complete BOOLEAN DEFAULT FALSE COMMENT 'Is this property fully vectorized';
ALTER TABLE sellers ADD COLUMN IF NOT EXISTS last_vectorized_at TIMESTAMP NULL COMMENT 'When was this property last vectorized';
ALTER TABLE sellers ADD COLUMN IF NOT EXISTS vector_version INT DEFAULT 0 COMMENT 'Vector version counter';
ALTER TABLE sellers ADD COLUMN IF NOT EXISTS vectorization_error_message TEXT NULL COMMENT 'Error message if vectorization failed';

-- Add indexes for vectorization queries
ALTER TABLE sellers
ADD INDEX IF NOT EXISTS idx_vectorization_status (is_vectorized_complete, updated_at),
ADD INDEX IF NOT EXISTS idx_last_vectorized (last_vectorized_at);

-- ============================================================
-- Step 2: Add tracking columns to rental_owners table
-- ============================================================

ALTER TABLE rental_owners ADD COLUMN IF NOT EXISTS is_vectorized_complete BOOLEAN DEFAULT FALSE COMMENT 'Is this property fully vectorized';
ALTER TABLE rental_owners ADD COLUMN IF NOT EXISTS last_vectorized_at TIMESTAMP NULL COMMENT 'When was this property last vectorized';
ALTER TABLE rental_owners ADD COLUMN IF NOT EXISTS vector_version INT DEFAULT 0 COMMENT 'Vector version counter';
ALTER TABLE rental_owners ADD COLUMN IF NOT EXISTS vectorization_error_message TEXT NULL COMMENT 'Error message if vectorization failed';

ALTER TABLE rental_owners
ADD INDEX IF NOT EXISTS idx_vectorization_status (is_vectorized_complete, updated_at),
ADD INDEX IF NOT EXISTS idx_last_vectorized (last_vectorized_at);

-- ============================================================
-- Step 3: Create vectorization queue table
-- ============================================================

CREATE TABLE IF NOT EXISTS vectorization_queue (
    id INT AUTO_INCREMENT PRIMARY KEY,
    property_id BIGINT UNSIGNED NOT NULL COMMENT 'ID from source table (sellers.id or rental_owners.id)',
    source_table ENUM('sellers', 'rental_owners') NOT NULL DEFAULT 'sellers' COMMENT 'Which table this row comes from',
    action ENUM('insert', 'update', 'delete') NOT NULL DEFAULT 'insert' COMMENT 'Type of change',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP COMMENT 'When change was detected',
    processed_at TIMESTAMP NULL COMMENT 'When this change was processed',
    status ENUM('pending', 'processing', 'completed', 'failed') DEFAULT 'pending' COMMENT 'Processing status',
    error_message TEXT NULL COMMENT 'Error details if processing failed',
    retry_count INT DEFAULT 0 COMMENT 'Number of retry attempts',

    INDEX idx_status (status),
    INDEX idx_created_at (created_at),
    INDEX idx_pending (status, created_at),
    UNIQUE KEY unique_pending (property_id, source_table, action, status)
) COMMENT='Queue for tracking property changes needing vectorization' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- Step 4: Create triggers for automatic change detection
-- ============================================================

-- --- SELLERS triggers ---

DROP TRIGGER IF EXISTS sellers_after_insert;
CREATE TRIGGER sellers_after_insert
AFTER INSERT ON sellers
FOR EACH ROW
BEGIN
  INSERT INTO vectorization_queue (property_id, source_table, action, status)
  VALUES (NEW.id, 'sellers', 'insert', 'pending')
  ON DUPLICATE KEY UPDATE
    status = 'pending',
    retry_count = 0,
    error_message = NULL;
END;

DROP TRIGGER IF EXISTS sellers_after_update;
CREATE TRIGGER sellers_after_update
AFTER UPDATE ON sellers
FOR EACH ROW
BEGIN
  -- Only queue if content columns changed (not vectorization tracking columns)
  IF OLD.property_type <> NEW.property_type OR
     OLD.property_category <> NEW.property_category OR
     OLD.property_address <> NEW.property_address OR
     IFNULL(OLD.city, '') <> IFNULL(NEW.city, '') OR
     OLD.property_price <> NEW.property_price OR
     OLD.property_price_unit <> NEW.property_price_unit OR
     IFNULL(OLD.property_area, '') <> IFNULL(NEW.property_area, '') OR
     IFNULL(OLD.layout, '') <> IFNULL(NEW.layout, '') OR
     IFNULL(OLD.property_face, '') <> IFNULL(NEW.property_face, '') OR
     IFNULL(OLD.furnished, '') <> IFNULL(NEW.furnished, '') OR
     IFNULL(OLD.amenities, '') <> IFNULL(NEW.amenities, '') OR
     IFNULL(OLD.property_remarks, '') <> IFNULL(NEW.property_remarks, '') OR
     OLD.status <> NEW.status
  THEN
    INSERT INTO vectorization_queue (property_id, source_table, action, status)
    VALUES (NEW.id, 'sellers', 'update', 'pending')
    ON DUPLICATE KEY UPDATE
      status = 'pending',
      action = 'update',
      retry_count = 0,
      error_message = NULL;
  END IF;
END;

DROP TRIGGER IF EXISTS sellers_before_delete;
CREATE TRIGGER sellers_before_delete
BEFORE DELETE ON sellers
FOR EACH ROW
BEGIN
  INSERT INTO vectorization_queue (property_id, source_table, action, status)
  VALUES (OLD.id, 'sellers', 'delete', 'pending');
END;

-- --- RENTAL_OWNERS triggers ---

DROP TRIGGER IF EXISTS rental_owners_after_insert;
CREATE TRIGGER rental_owners_after_insert
AFTER INSERT ON rental_owners
FOR EACH ROW
BEGIN
  INSERT INTO vectorization_queue (property_id, source_table, action, status)
  VALUES (NEW.id, 'rental_owners', 'insert', 'pending')
  ON DUPLICATE KEY UPDATE
    status = 'pending',
    retry_count = 0,
    error_message = NULL;
END;

DROP TRIGGER IF EXISTS rental_owners_after_update;
CREATE TRIGGER rental_owners_after_update
AFTER UPDATE ON rental_owners
FOR EACH ROW
BEGIN
  IF OLD.property_type <> NEW.property_type OR
     IFNULL(OLD.category, '') <> IFNULL(NEW.category, '') OR
     OLD.address <> NEW.address OR
     IFNULL(OLD.city, '') <> IFNULL(NEW.city, '') OR
     OLD.rent_amount <> NEW.rent_amount OR
     IFNULL(OLD.property_area, '') <> IFNULL(NEW.property_area, '') OR
     IFNULL(OLD.layout, '') <> IFNULL(NEW.layout, '') OR
     IFNULL(OLD.bedroom, 0) <> IFNULL(NEW.bedroom, 0) OR
     IFNULL(OLD.amenities, '') <> IFNULL(NEW.amenities, '') OR
     IFNULL(OLD.remarks, '') <> IFNULL(NEW.remarks, '') OR
     OLD.status <> NEW.status
  THEN
    INSERT INTO vectorization_queue (property_id, source_table, action, status)
    VALUES (NEW.id, 'rental_owners', 'update', 'pending')
    ON DUPLICATE KEY UPDATE
      status = 'pending',
      action = 'update',
      retry_count = 0,
      error_message = NULL;
  END IF;
END;

DROP TRIGGER IF EXISTS rental_owners_before_delete;
CREATE TRIGGER rental_owners_before_delete
BEFORE DELETE ON rental_owners
FOR EACH ROW
BEGIN
  INSERT INTO vectorization_queue (property_id, source_table, action, status)
  VALUES (OLD.id, 'rental_owners', 'delete', 'pending');
END;

-- ============================================================
-- Step 5: Verification queries
-- ============================================================

SELECT
  'sellers tracking columns' as check_name,
  CASE
    WHEN EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sellers' AND COLUMN_NAME = 'is_vectorized_complete')
    THEN 'PASS'
    ELSE 'MISSING'
  END as result;

SELECT
  'rental_owners tracking columns' as check_name,
  CASE
    WHEN EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'rental_owners' AND COLUMN_NAME = 'is_vectorized_complete')
    THEN 'PASS'
    ELSE 'MISSING'
  END as result;

SELECT
  'vectorization_queue table' as check_name,
  CASE
    WHEN EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'vectorization_queue')
    THEN 'PASS'
    ELSE 'MISSING'
  END as result;
