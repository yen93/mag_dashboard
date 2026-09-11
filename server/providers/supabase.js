// Supabase provider — direct Postgres access via `pg`. This is the primary data
// source; most metrics are aggregation SQL against the MAG public schema.
//
// Uses a single pooled connection. Supabase requires SSL; we accept the managed
// cert without local CA verification (rejectUnauthorized:false), which is the
// standard setup for connecting to Supabase from a container.

import pg from 'pg';
import { config, hasSource } from '../config.js';

let pool = null;

export function supabaseConfigured() {
  return hasSource('supabase');
}

function getPool() {
  if (!supabaseConfigured()) {
    throw new Error('SUPABASE_DB_URL is not set');
  }
  if (!pool) {
    pool = new pg.Pool({
      connectionString: config.supabase.dbUrl,
      ssl: { rejectUnauthorized: false },
      max: 4,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
    pool.on('error', (err) => console.error('[supabase] pool error', err.message));
  }
  return pool;
}

/** Run a read-only SQL query. Returns rows. */
export async function q(sql, params = []) {
  const res = await getPool().query(sql, params);
  return res.rows;
}
