// Manage a local Postgres container for `pgrest-lambda dev`. The
// container persists its data in a named volume so restarts preserve
// state — different from the test harness, which uses tmpfs for speed.

import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFile = promisify(execFileCb);
const HERE = dirname(fileURLToPath(import.meta.url));
const COMPOSE_FILE = join(HERE, 'docker', 'compose.yml');

// Local-dev defaults match the de-facto community convention
// (postgres/postgres/postgres). They're convenience values for a
// throwaway container bound to localhost — not secrets. Port 54322
// deliberately differs from the standard 5432 so we don't collide
// with a developer's system Postgres.
const DEFAULTS = {
  port: parseInt(process.env.POSTGRES_PORT || '54322', 10),
  user: process.env.POSTGRES_USER || 'postgres',
  password: process.env.POSTGRES_PASSWORD || 'postgres',
  database: process.env.POSTGRES_DB || 'postgres',
};

function connectionInfo() {
  return {
    host: 'localhost',
    port: DEFAULTS.port,
    user: DEFAULTS.user,
    password: DEFAULTS.password,
    database: DEFAULTS.database,
    url: `postgres://${DEFAULTS.user}:${DEFAULTS.password}@localhost:${DEFAULTS.port}/${DEFAULTS.database}`,
  };
}

async function compose(...args) {
  return execFile('docker', ['compose', '-f', COMPOSE_FILE, ...args], {
    env: {
      ...process.env,
      POSTGRES_PORT: String(DEFAULTS.port),
      POSTGRES_USER: DEFAULTS.user,
      POSTGRES_PASSWORD: DEFAULTS.password,
      POSTGRES_DB: DEFAULTS.database,
    },
  });
}

async function waitForHealthy(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const { stdout } = await compose('ps', '--format', 'json', 'postgres');
      const lines = stdout.trim().split('\n').filter(Boolean);
      if (lines.length) {
        const row = JSON.parse(lines[0]);
        if (row.Health === 'healthy') return;
      }
    } catch {
      // container not visible yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('Postgres container did not become healthy in time');
}

/**
 * Ensure a local Postgres container is running. Idempotent: if one is
 * already up, reuses it. Returns connection info.
 *
 * @returns {Promise<{host:string,port:number,user:string,password:string,database:string,url:string}>}
 */
export async function startBundledPostgres() {
  try {
    await execFile('docker', ['version'], { timeout: 5000 });
  } catch {
    throw new Error(
      'Docker is not available. Install Docker Desktop (or equivalent) and ensure the daemon is running.',
    );
  }

  try {
    await compose('up', '-d', 'postgres');
  } catch (err) {
    const msg = err?.stderr || err?.message || '';
    const alreadyRunning =
      msg.includes('already in use') || msg.includes('already exists');
    if (!alreadyRunning) throw err;
  }
  await waitForHealthy();
  return connectionInfo();
}

/**
 * Stop and remove the bundled Postgres container. Leaves the data
 * volume intact so the next `startBundledPostgres()` preserves state.
 */
export async function stopBundledPostgres() {
  await compose('down');
}

/**
 * Stop the container AND remove the data volume. Use this for a fully
 * clean slate — next `startBundledPostgres()` starts from zero.
 */
export async function resetBundledPostgres() {
  await compose('down', '-v');
}
