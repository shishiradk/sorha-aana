// src/inspect-db.ts
// Utility to inspect MySQL database schema
// This helps understand the database structure before using it

import { Env } from './index';
import mysql from 'mysql2/promise';

export interface TableInfo {
  table_name: string;
  columns: ColumnInfo[];
}

export interface ColumnInfo {
  column_name: string;
  data_type: string;
  is_nullable: string;
  column_key: string;
  extra: string;
  column_default: string | null;
}

/**
 * Get all tables in the database
 */
export async function getAllTables(env: Env): Promise<string[]> {
  const connection = await mysql.createConnection(env.HYPERDRIVE.connectionString);

  try {
    // Use simple query instead of prepared statement for Hyperdrive compatibility
    const [rows]: any = await connection.query(
      `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE()`
    );
    return rows.map((row: any) => row.TABLE_NAME);
  } finally {
    await connection.end();
  }
}

/**
 * Get column information for a specific table
 */
export async function getTableStructure(env: Env, tableName: string): Promise<ColumnInfo[]> {
  const connection = await mysql.createConnection(env.HYPERDRIVE.connectionString);

  try {
    // Escape table name to prevent SQL injection
    const escapedTableName = escapeSqlValue(tableName);
    const sql = `SELECT 
        COLUMN_NAME as column_name,
        DATA_TYPE as data_type,
        IS_NULLABLE as is_nullable,
        COLUMN_KEY as column_key,
        EXTRA as extra,
        COLUMN_DEFAULT as column_default
      FROM INFORMATION_SCHEMA.COLUMNS 
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${escapedTableName}
      ORDER BY ORDINAL_POSITION`;
    
    const [rows]: any = await connection.query(sql);
    return rows;
  } finally {
    await connection.end();
  }
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
 * Get complete database schema
 */
export async function getDatabaseSchema(env: Env): Promise<TableInfo[]> {
  const tables = await getAllTables(env);
  const schema: TableInfo[] = [];

  for (const table of tables) {
    const columns = await getTableStructure(env, table);
    schema.push({
      table_name: table,
      columns
    });
  }

  return schema;
}

/**
 * Format schema for console output
 */
export function formatSchemaForConsole(tableInfos: TableInfo[]): string {
  let output = '\n' + '='.repeat(80) + '\n';
  output += 'DATABASE SCHEMA\n';
  output += '='.repeat(80) + '\n';

  for (const tableInfo of tableInfos) {
    output += `\n📋 TABLE: ${tableInfo.table_name}\n`;
    output += '-'.repeat(80) + '\n';
    output += 'Column Name                    | Type              | Nullable | Key | Extra\n';
    output += '-'.repeat(80) + '\n';

    for (const col of tableInfo.columns) {
      const colName = col.column_name.padEnd(30);
      const dataType = (col.data_type || '').padEnd(17);
      const nullable = col.is_nullable.padEnd(8);
      const key = (col.column_key || '-').padEnd(3);
      const extra = col.extra || '-';

      output += `${colName} | ${dataType} | ${nullable} | ${key} | ${extra}\n`;
    }
  }

  output += '\n' + '='.repeat(80) + '\n';
  return output;
}

/**
 * Format schema as JSON
 */
export function formatSchemaAsJson(tableInfos: TableInfo[]): string {
  return JSON.stringify(tableInfos, null, 2);
}
