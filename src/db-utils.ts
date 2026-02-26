// src/db-utils.ts
// Hyperdrive/MySQL query helpers
// Uses createConnection (NOT createPool) — Hyperdrive IS the connection pool
// Uses connection.query() (NOT execute) — Hyperdrive doesn't support prepared statements
// Uses disableEval: true — required for Cloudflare Workers compatibility
import { createConnection } from 'mysql2/promise';

async function getConnection(env: any) {
  return createConnection({
    host: env.HYPERDRIVE.host,
    user: env.HYPERDRIVE.user,
    password: env.HYPERDRIVE.password,
    database: env.HYPERDRIVE.database,
    port: env.HYPERDRIVE.port,
    disableEval: true,
  });
}

export async function queryAll<T = any>(
  env: any,
  sql: string,
  params: any[] = []
): Promise<{ results: T[] }> {
  const connection = await getConnection(env);
  try {
    const [rows] = await connection.query(sql, params);
    return { results: rows as T[] };
  } finally {
    await connection.end();
  }
}

export async function queryOne<T = any>(
  env: any,
  sql: string,
  params: any[] = []
): Promise<T | null> {
  const { results } = await queryAll<T>(env, sql, params);
  return results[0] ?? null;
}

export async function queryExecute(
  env: any,
  sql: string,
  params: any[] = []
): Promise<any> {
  const connection = await getConnection(env);
  try {
    const [result] = await connection.query(sql, params);
    return result;
  } finally {
    await connection.end();
  }
}
