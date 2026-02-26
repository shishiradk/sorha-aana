// src/db-utils.ts
// Helper functions for Hyperdrive/MySQL queries
// Requires: npm install mysql2
// Note: Uses regular queries (not prepared statements) for Hyperdrive compatibility
// Usage: Import and use queryAll(), queryOne() functions

import mysql from 'mysql';
import { promisify } from 'util';

// Validate connection string format
function validateConnectionString(connectionString: string | undefined): void {
  if (!connectionString) {
    throw new Error('HYPERDRIVE connection string not found. Ensure HYPERDRIVE binding is configured in wrangler.json');
  }

  if (typeof connectionString !== 'string') {
    throw new Error('Invalid connection string type. Expected string, got ' + typeof connectionString);
  }

  if (!connectionString.startsWith('mysql://')) {
    throw new Error('Invalid connection string format. Expected mysql://user:password@host:port/database');
  }
}

// Create connection with retry logic
async function createConnectionWithRetry(
  connectionString: string,
  maxRetries: number = 3,
  initialDelayMs: number = 100
): Promise<any> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      if (attempt > 0) {
        const delayMs = initialDelayMs * Math.pow(2, attempt - 1);
        console.log(`Connection retry attempt ${attempt + 1}/${maxRetries}, waiting ${delayMs}ms...`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }

      const connection = mysql.createConnection(connectionString);

      // Promisify the connect method
      await new Promise((resolve, reject) => {
        connection.connect((err) => {
          if (err) reject(err);
          else resolve(null);
        });
      });

      console.log(`✓ Database connection established successfully (using legacy mysql driver)`);
      return connection;
    } catch (error) {
      lastError = error as Error;
      console.warn(`✗ Connection attempt ${attempt + 1}/${maxRetries} failed: ${lastError.message}`);
    }
  }

  throw new Error(
    `Failed to connect to database after ${maxRetries} attempts. Last error: ${lastError?.message}`
  );
}

/**
 * Execute a query and return all rows
 * @param env Environment with HYPERDRIVE binding
 * @param sql SQL query string with ? placeholders
 * @param params Query parameters
 * @returns Object with results array
 */
export async function queryAll<T = any>(
  env: any,
  sql: string,
  params: any[] = []
): Promise<{ results: T[] }> {
  let connection: any = null;

  try {
    validateConnectionString(env.HYPERDRIVE?.connectionString);
    connection = await createConnectionWithRetry(env.HYPERDRIVE.connectionString, 2, 50);

    return await new Promise((resolve, reject) => {
      (connection as any).query(sql, params, (err: any, results: any) => {
        if (err) reject(err);
        else resolve({ results: results as T[] });
      });
    });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`Query execution error: ${errorMsg}`);
    console.error(`Query: ${sql.substring(0, 200)}`);
    throw new Error(`Database query failed: ${errorMsg}`);
  } finally {
    if (connection) {
      connection.end();
    }
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
  let connection: any = null;

  try {
    validateConnectionString(env.HYPERDRIVE?.connectionString);
    connection = await createConnectionWithRetry(env.HYPERDRIVE.connectionString, 2, 50);

    return await new Promise((resolve, reject) => {
      (connection as any).query(sql, params, (err: any, results: any) => {
        if (err) reject(err);
        else resolve((results[0] as T) || null);
      });
    });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`Query execution error: ${errorMsg}`);
    throw new Error(`Database query failed: ${errorMsg}`);
  } finally {
    if (connection) {
      connection.end();
    }
  }
}

/**
 * Execute a query that doesn't return rows (INSERT, UPDATE, DELETE)
 * @param env Environment with HYPERDRIVE binding
 * @param sql SQL query string with ? placeholders
 * @param params Query parameters
 * @returns Query result with affected rows
 */
export async function queryExecute(
  env: any,
  sql: string,
  params: any[] = []
): Promise<any> {
  let connection: any = null;

  try {
    validateConnectionString(env.HYPERDRIVE?.connectionString);
    connection = await createConnectionWithRetry(env.HYPERDRIVE.connectionString, 2, 50);

    return await new Promise((resolve, reject) => {
      (connection as any).query(sql, params, (err: any, result: any) => {
        if (err) reject(err);
        else resolve(result);
      });
    });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`Query execution error: ${errorMsg}`);
    throw new Error(`Database query failed: ${errorMsg}`);
  } finally {
    if (connection) {
      connection.end();
    }
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
