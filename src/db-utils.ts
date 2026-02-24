// src/db-utils.ts
// Helper functions for Hyperdrive/MySQL queries
// Requires: npm install mysql2
// Note: Uses regular queries (not prepared statements) for Hyperdrive compatibility
// Usage: Import and use queryAll(), queryOne() functions

import mysql from 'mysql2/promise';

/**
 * Execute a query and return all rows
 * Hyperdrive doesn't support prepared statements, so use simple queries
 * @param env Environment with HYPERDRIVE binding
 * @param sql SQL query string with ? placeholders
 * @param params Query parameters (will be escaped and inserted into SQL)
 * @returns Object with results array
 */
export async function queryAll<T = any>(
  env: any,
  sql: string,
  params: any[] = []
): Promise<{ results: T[] }> {
  const connection = await mysql.createConnection(env.HYPERDRIVE.connectionString);

  try {
    // Build the query by escaping and interpolating parameters
    const escapedSql = buildQuery(sql, params);
    const [rows] = await connection.query(escapedSql);
    return { results: rows as T[] };
  } finally {
    await connection.end();
  }
}

/**
 * Execute a query and return the first row
 * @param env Environment with HYPERDRIVE binding
 * @param sql SQL query string with ? placeholders
 * @param params Query parameters
 * @returns First row or null
 */
export async function queryOne<T = any>(
  env: any,
  sql: string,
  params: any[] = []
): Promise<T | null> {
  const connection = await mysql.createConnection(env.HYPERDRIVE.connectionString);

  try {
    // Build the query by escaping and interpolating parameters
    const escapedSql = buildQuery(sql, params);
    const [rows] = await connection.query(escapedSql);
    return (rows[0] as T) || null;
  } finally {
    await connection.end();
  }
}

/**
 * Execute a query that doesn't return rows (INSERT, UPDATE, DELETE)
 * @param env Environment with HYPERDRIVE binding
 * @param sql SQL query string with ? placeholders
 * @param params Query parameters
 * @returns Query result
 */
export async function queryExecute(
  env: any,
  sql: string,
  params: any[] = []
): Promise<any> {
  const connection = await mysql.createConnection(env.HYPERDRIVE.connectionString);

  try {
    // Build the query by escaping and interpolating parameters
    const escapedSql = buildQuery(sql, params);
    const result = await connection.query(escapedSql);
    return result;
  } finally {
    await connection.end();
  }
}

/**
 * Build a query by escaping parameters and replacing ? placeholders
 * This is necessary because Hyperdrive doesn't support prepared statements
 * @param sql SQL query with ? placeholders
 * @param params Array of parameters
 * @returns Escaped SQL query ready to execute
 */
function buildQuery(sql: string, params: any[]): string {
  if (!params || params.length === 0) {
    return sql;
  }

  // Simple loop-based replacement to avoid callback functions
  let result = sql;
  for (let i = 0; i < params.length; i++) {
    const placeholder = '?';
    const index = result.indexOf(placeholder);
    if (index === -1) break;
    
    const escapedValue = escapeSqlValue(params[i]);
    result = result.substring(0, index) + escapedValue + result.substring(index + 1);
  }
  
  return result;
}

/**
 * Escape a value for safe use in SQL queries
 * Replaces special characters with their escaped versions
 * @param value The value to escape
 * @returns Escaped SQL value
 */
function escapeSqlValue(value: any): string {
  if (value === null || value === undefined) {
    return 'NULL';
  }

  if (typeof value === 'number') {
    return value.toString();
  }

  if (typeof value === 'boolean') {
    return value ? '1' : '0';
  }

  if (typeof value === 'string') {
    // Escape single quotes by doubling them
    const escaped = value.replace(/'/g, "''");
    return `'${escaped}'`;
  }

  // For objects and arrays, convert to JSON string
  const escaped = JSON.stringify(value).replace(/'/g, "''");
  return `'${escaped}'`;
}
