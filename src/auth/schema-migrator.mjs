// Applies the better-auth schema to a PostgreSQL database. Idempotent:
// tracks applied migrations in `better_auth.__migrations` and skips
// anything already applied. Safe to call concurrently — uses a Postgres
// advisory lock to serialize.
//
// Migration files live in ./migrations/ alongside this module. Each file
// is applied in a single transaction. Filenames sort lexicographically
// (e.g. 001_initial.sql, 002_add_column.sql, ...).

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, 'migrations');

// Arbitrary 64-bit int shared by every pgrest-lambda instance. Prevents
// concurrent migrators from racing. Derived from hash('pgrest-lambda-auth').
const ADVISORY_LOCK_KEY = 7263554091847264503n;

async function listMigrationFiles() {
  const entries = await readdir(MIGRATIONS_DIR);
  return entries
    .filter((f) => f.endsWith('.sql'))
    .sort(); // lexicographic — zero-padded prefixes guarantee order
}

async function ensureMigrationsTable(client) {
  await client.query(`CREATE SCHEMA IF NOT EXISTS better_auth`);
  await client.query(`
    CREATE TABLE IF NOT EXISTS better_auth.__migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function getAppliedFilenames(client) {
  const { rows } = await client.query(
    `SELECT filename FROM better_auth.__migrations`,
  );
  return new Set(rows.map((r) => r.filename));
}

async function applyMigration(client, filename) {
  const sql = await readFile(join(MIGRATIONS_DIR, filename), 'utf8');
  await client.query('BEGIN');
  try {
    await client.query(sql);
    await client.query(
      `INSERT INTO better_auth.__migrations (filename) VALUES ($1)`,
      [filename],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    err.message = `Migration ${filename} failed: ${err.message}`;
    throw err;
  }
}

/**
 * Ensure the better_auth schema is up to date on the given pool.
 * Idempotent: applies only migrations that haven't run yet. Safe to
 * call concurrently.
 *
 * @param {import('pg').Pool} pool  A pg.Pool connected to the target DB
 * @param {{ onApply?: (filename: string) => void }} [options]
 * @returns {Promise<{ applied: string[], skipped: string[] }>}
 */
export async function ensureBetterAuthSchema(pool, options = {}) {
  const onApply = options.onApply || (() => {});
  const client = await pool.connect();
  try {
    // Advisory lock: other processes block here until we're done.
    await client.query(`SELECT pg_advisory_lock($1)`, [ADVISORY_LOCK_KEY]);
    try {
      await ensureMigrationsTable(client);
      const applied = await getAppliedFilenames(client);
      const files = await listMigrationFiles();

      const appliedList = [];
      const skippedList = [];
      for (const file of files) {
        if (applied.has(file)) {
          skippedList.push(file);
          continue;
        }
        await applyMigration(client, file);
        appliedList.push(file);
        onApply(file);
      }
      return { applied: appliedList, skipped: skippedList };
    } finally {
      await client.query(
        `SELECT pg_advisory_unlock($1)`,
        [ADVISORY_LOCK_KEY],
      );
    }
  } finally {
    client.release();
  }
}
