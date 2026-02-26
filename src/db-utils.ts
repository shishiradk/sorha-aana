// src/db-utils.ts
// Hyperdrive/MySQL query helpers using mysql2/promise
// Uses pool.query() (text protocol) — Hyperdrive does not support binary/prepared-statement protocol
import { createPool } from 'mysql2/promise';

export async function queryAll<T = any>(
  env: any,
  sql: string,
  params: any[] = []
): Promise<{ results: T[] }> {
  const pool = createPool(env.HYPERDRIVE.connectionString);
  try {
    const [rows] = await pool.query(sql, params);
    return { results: rows as T[] };
  } finally {
    await pool.end();
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
  const pool = createPool(env.HYPERDRIVE.connectionString);
  try {
    const [result] = await pool.query(sql, params);
    return result;
  } finally {
    await pool.end();
  }
}
