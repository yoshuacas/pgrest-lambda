import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';
import { ensureBetterAuthSchema } from '../../src/index.mjs';

const execFile = promisify(execFileCb);
const HERE = dirname(fileURLToPath(import.meta.url));
const COMPOSE_FILE = join(HERE, '..', 'docker-compose.yml');
const FIXTURES_DIR = join(HERE, '..', 'fixtures');

const DEFAULT_PORT = parseInt(process.env.PGREST_TEST_PG_PORT || '54329', 10);
const USER = 'pgrest_test';
const PASSWORD = 'pgrest_test';
const DATABASE = 'pgrest_test';

async function compose(...args) {
  return execFile('docker', ['compose', '-f', COMPOSE_FILE, ...args], {
    env: { ...process.env, PGREST_TEST_PG_PORT: String(DEFAULT_PORT) },
  });
}

async function waitForHealthy(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const { stdout } = await compose('ps', '--format', 'json', 'postgres');
      const lines = stdout.trim().split('\n').filter(Boolean);
      const row = lines.length ? JSON.parse(lines[0]) : null;
      if (row && row.Health === 'healthy') return;
    } catch {
      // container not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('Postgres container did not become healthy in time');
}

export function connectionInfo() {
  return {
    host: 'localhost',
    port: DEFAULT_PORT,
    user: USER,
    password: PASSWORD,
    database: DATABASE,
    url: `postgres://${USER}:${PASSWORD}@localhost:${DEFAULT_PORT}/${DATABASE}`,
  };
}

export async function startPostgres() {
  try {
    await execFile('docker', ['version'], { timeout: 5000 });
  } catch {
    throw new Error(
      'Docker is not available. Install Docker Desktop or equivalent and retry.'
    );
  }

  // If the container is already up (e.g. a prior test file started it),
  // `compose up -d` reports the conflict as a non-zero exit. Swallow
  // that case and fall through to the health-wait.
  try {
    await compose('up', '-d', 'postgres');
  } catch (err) {
    const msg = err?.stderr || err?.message || '';
    const alreadyRunning =
      msg.includes('already in use') ||
      msg.includes('already exists');
    if (!alreadyRunning) throw err;
  }
  await waitForHealthy();
  return connectionInfo();
}

export async function stopPostgres() {
  await compose('down', '-v', '--remove-orphans');
}

async function execSql(pool, sql) {
  await pool.query(sql);
}

export async function applyBetterAuthSchema(pool) {
  // Delegate to the real library export — the test harness must exercise
  // the same code path production uses. No more fixture-file drift.
  await ensureBetterAuthSchema(pool);
}

export async function applyPublicSchema(pool) {
  const sql = await readFile(join(FIXTURES_DIR, 'public-schema.sql'), 'utf8');
  await execSql(pool, sql);
}

export async function resetDatabase(pool) {
  await pool.query('DROP SCHEMA IF EXISTS better_auth CASCADE');
  await pool.query('DROP SCHEMA IF EXISTS public CASCADE');
  await pool.query('CREATE SCHEMA public');
  await applyBetterAuthSchema(pool);
  await applyPublicSchema(pool);
}

export function createPool(config = connectionInfo()) {
  return new pg.Pool({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    max: 4,
  });
}
