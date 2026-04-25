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
// The two failure modes have different fixes: one needs an install,
// the other just needs the daemon started. `docker version` exits with
// "command not found" in the first case; in the second it connects to
// the CLI but fails to reach the engine, producing a stderr message
// that mentions "Cannot connect to the Docker daemon" (or "docker daemon
// is not running" on Windows).
function formatDockerError(err) {
  const stderr = err?.stderr || '';
  const message = err?.message || '';
  const combined = `${stderr}\n${message}`;

  // Order matters: check for daemon-specific phrasing FIRST, because
  // those stderrs sometimes contain "no such file" (referring to a
  // socket path), which would otherwise trigger the "not installed"
  // branch.
  const daemonNotRunning = /Cannot connect to the Docker daemon|daemon is not running|docker daemon is not running|Is the docker daemon running|failed to connect to the docker API|if the daemon is running/i.test(combined);

  const dockerNotInstalled =
    !daemonNotRunning && (
      err?.code === 'ENOENT' ||
      /docker: command not found|spawn docker ENOENT/i.test(combined)
    );

  const alreadyHavePostgresHint =
    '\n\n' +
    'Already have a Postgres running locally (or on a reachable host)?\n' +
    'Skip the Docker container and point pgrest-lambda at it:\n' +
    '  DATABASE_URL=postgres://user:pass@host:5432/db pgrest-lambda dev --skip-docker';

  if (dockerNotInstalled) {
    return new Error(
      'Docker is not installed. Install Docker Desktop (or an equivalent runtime like Colima or OrbStack) and try again.' +
      alreadyHavePostgresHint,
    );
  }
  if (daemonNotRunning) {
    return new Error(
      'The Docker daemon is not running. Start Docker Desktop (or your runtime) and try again.' +
      alreadyHavePostgresHint,
    );
  }
  return new Error(
    `Docker is not available: ${stderr || message}` +
    alreadyHavePostgresHint,
  );
}

export async function startBundledPostgres() {
  try {
    await execFile('docker', ['version'], { timeout: 5000 });
  } catch (err) {
    throw formatDockerError(err);
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
