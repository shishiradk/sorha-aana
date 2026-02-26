// src/inspect-db.ts
// Utility to inspect MySQL database schema
// This helps understand the database structure before using it

import { Env } from './index';
import { queryAll } from './db-utils';

export interface TableInfo {
  table_name: string;
  row_count: number;
  columns: ColumnInfo[];
  indexes: IndexInfo[];
  sample_data?: any[];
  statistics?: {
    total_size: string;
    data_free: string;
    auto_increment?: number;
  };
}

export interface ColumnInfo {
  column_name: string;
  data_type: string;
  is_nullable: string;
  column_key: string;
  extra: string;
  column_default: string | null;
  character_maximum_length?: number;
  numeric_precision?: number;
  numeric_scale?: number;
}

export interface IndexInfo {
  index_name: string;
  column_name: string;
  seq_in_index: number;
  is_unique: boolean;
  index_type: string;
}


/**
 * Escape a string value for safe use in SQL queries
 */
function escapeSqlValue(value: string): string {
  if (value === null || value === undefined) {
    return 'NULL';
  }
  // Escape single quotes by doubling them
  const escaped = value.replace(/'/g, "''");
  return `'${escaped}'`;
}

/**
 * Get complete database schema with row counts and statistics efficiently
 */
export async function getDatabaseSchema(env: Env): Promise<TableInfo[]> {
  // 1. Get all tables and their rows/stats in one go
  const tablesSql = `
    SELECT 
      TABLE_NAME, 
      TABLE_ROWS as row_count,
      ROUND(DATA_LENGTH / 1024 / 1024, 2) as total_size,
      ROUND(DATA_FREE / 1024 / 1024, 2) as data_free,
      AUTO_INCREMENT as auto_increment
    FROM INFORMATION_SCHEMA.TABLES 
    WHERE TABLE_SCHEMA = DATABASE()`;

  const { results: tableBasics } = await queryAll(env, tablesSql);

  if (!tableBasics || tableBasics.length === 0) {
    return [];
  }

  // 2. Get all columns for all tables
  const colsSql = `
    SELECT 
      TABLE_NAME as table_name,
      COLUMN_NAME as column_name,
      DATA_TYPE as data_type,
      IS_NULLABLE as is_nullable,
      COLUMN_KEY as column_key,
      EXTRA as extra,
      COLUMN_DEFAULT as column_default
    FROM INFORMATION_SCHEMA.COLUMNS 
    WHERE TABLE_SCHEMA = DATABASE()
    ORDER BY TABLE_NAME, ORDINAL_POSITION`;

  const { results: allColumns } = await queryAll(env, colsSql);

  // 3. Get all indexes for all tables
  const idxSql = `
    SELECT 
      TABLE_NAME as table_name,
      INDEX_NAME as index_name,
      COLUMN_NAME as column_name,
      SEQ_IN_INDEX as seq_in_index,
      NON_UNIQUE = 0 as is_unique,
      INDEX_TYPE as index_type
    FROM INFORMATION_SCHEMA.STATISTICS 
    WHERE TABLE_SCHEMA = DATABASE()
    ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`;

  const { results: allIndexes } = await queryAll(env, idxSql);

  const schema: TableInfo[] = [];

  for (const basic of tableBasics) {
    const tableName = basic.TABLE_NAME;

    // Filter results for this table
    const columns = allColumns.filter((c: any) => c.table_name === tableName);
    const indexes = allIndexes.filter((i: any) => i.table_name === tableName);

    schema.push({
      table_name: tableName,
      row_count: basic.row_count || 0,
      columns: columns as ColumnInfo[],
      indexes: indexes as IndexInfo[],
      statistics: {
        total_size: `${basic.total_size || 0} MB`,
        data_free: `${basic.data_free || 0} MB`,
        auto_increment: basic.auto_increment
      }
    });
  }

  return schema;
}

// These functions are kept for individual table queries if needed, 
// but getDatabaseSchema now uses its own optimized logic above.

/**
 * Get all tables in the database
 */
export async function getAllTables(env: Env): Promise<string[]> {
  const sql = `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE()`;
  const { results } = await queryAll(env, sql);
  return results.map((row: any) => row.TABLE_NAME);
}

/**
 * Get column information for a specific table
 */
export async function getTableStructure(env: Env, tableName: string): Promise<ColumnInfo[]> {
  const sql = `SELECT 
      COLUMN_NAME as column_name,
      DATA_TYPE as data_type,
      IS_NULLABLE as is_nullable,
      COLUMN_KEY as column_key,
      EXTRA as extra,
      COLUMN_DEFAULT as column_default
    FROM INFORMATION_SCHEMA.COLUMNS 
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
    ORDER BY ORDINAL_POSITION`;

  const { results } = await queryAll(env, sql, [tableName]);
  return results;
}

/**
 * Escape identifier (table/column name) using backticks
 */
function escapeIdentifier(identifier: string): string {
  if (!identifier || typeof identifier !== 'string') {
    throw new Error('Invalid identifier');
  }
  // Remove backticks if already present
  const clean = identifier.replace(/`/g, '');
  // Validate only alphanumeric, underscore, and hyphen
  if (!/^[a-zA-Z0-9_-]+$/.test(clean)) {
    throw new Error(`Invalid identifier format: ${identifier}`);
  }
  return `\`${clean}\``;
}

/**
 * Format schema for console output
 */
export function formatSchemaForConsole(tableInfos: TableInfo[]): string {
  let output = '\n' + '='.repeat(100) + '\n';
  output += 'DATABASE SCHEMA INSPECTION\n';
  output += '='.repeat(100) + '\n';

  for (const tableInfo of tableInfos) {
    output += `\n📋 TABLE: ${tableInfo.table_name} (${tableInfo.row_count} rows)\n`;

    if (tableInfo.statistics) {
      output += `   Size: ${tableInfo.statistics.total_size} | Free: ${tableInfo.statistics.data_free}`;
      if (tableInfo.statistics.auto_increment) {
        output += ` | Next AI: ${tableInfo.statistics.auto_increment}`;
      }
      output += '\n';
    }

    output += '-'.repeat(100) + '\n';
    output += 'Column Name                  | Type              | Nullable | Key | Extra                | Default\n';
    output += '-'.repeat(100) + '\n';

    for (const col of tableInfo.columns) {
      const colName = col.column_name.padEnd(30);
      const dataType = (col.data_type || '').padEnd(17);
      const nullable = col.is_nullable.padEnd(8);
      const key = (col.column_key || '-').padEnd(3);
      const extra = col.extra || '-';
      const defaultVal = col.column_default ? col.column_default.toString() : 'NULL';

      output += `${colName} | ${dataType} | ${nullable} | ${key} | ${extra.padEnd(20)} | ${defaultVal}\n`;
    }

    if (tableInfo.indexes && tableInfo.indexes.length > 0) {
      output += '\n📑 INDEXES:\n';
      for (const idx of tableInfo.indexes) {
        output += `   ${idx.index_name}: ${idx.column_name} (${idx.index_type})\n`;
      }
    }

    if (tableInfo.sample_data && tableInfo.sample_data.length > 0) {
      output += '\n📊 SAMPLE DATA (first row):\n';
      const firstRow = tableInfo.sample_data[0];
      for (const [key, value] of Object.entries(firstRow)) {
        const displayValue = typeof value === 'string'
          ? value.substring(0, 50) + (value.length > 50 ? '...' : '')
          : value;
        output += `   ${key}: ${displayValue}\n`;
      }
    }

    output += '\n';
  }

  output += '='.repeat(100) + '\n';
  return output;
}

/**
 * Format schema as JSON
 */
export function formatSchemaAsJson(tableInfos: TableInfo[]): string {
  const simplifiedSchema = tableInfos.map(table => ({
    table: table.table_name,
    row_count: table.row_count,
    columns: table.columns.map(col => ({
      name: col.column_name,
      type: col.data_type,
      nullable: col.is_nullable === 'YES',
      key: col.column_key || null,
      default: col.column_default
    })),
    statistics: table.statistics,
    indexes: table.indexes?.map(idx => ({
      name: idx.index_name,
      column: idx.column_name,
      unique: idx.is_unique
    })) || []
  }));

  return JSON.stringify(simplifiedSchema, null, 2);
}
