#!/usr/bin/env node
// pgrest-lambda CLI. Thin wrapper over the library's exported primitives
// (startDevServer, ensureBetterAuthSchema, startBundledPostgres,
// generateApikey). All business logic lives in `src/`; this file just
// parses argv and orchestrates calls.

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import {
  startDevServer,
  ensureBetterAuthSchema,
  startBundledPostgres,
  generateApikey,
} from '../src/index.mjs';

const COMMANDS = {
  dev: cmdDev,
  'migrate-auth': cmdMigrateAuth,
  'generate-key': cmdGenerateKey,
  help: cmdHelp,
  '--help': cmdHelp,
  '-h': cmdHelp,
};

const [, , command, ...args] = process.argv;

if (!command) {
  cmdHelp();
  process.exit(0);
}

const handler = COMMANDS[command];
if (!handler) {
  console.error(`Unknown command: ${command}`);
  cmdHelp();
  process.exit(2);
}

try {
  await handler(args);
} catch (err) {
  console.error(`\n✗ ${err.message}`);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
}

// ---------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------

async function cmdDev(argv) {
  const opts = parseFlags(argv, {
    port: { type: 'number', default: 3000 },
    'skip-docker': { type: 'boolean', default: false },
  });

  await loadDotenv();

  // 1. Resolve database connection. DATABASE_URL wins; otherwise start
  //    the bundled Postgres container.
  let dbUrl = process.env.DATABASE_URL;
  let dbInfo;
  if (!dbUrl && !opts['skip-docker']) {
    log('→ starting bundled Postgres…');
    dbInfo = await startBundledPostgres();
    dbUrl = dbInfo.url;
  } else if (!dbUrl) {
    throw new Error(
      'DATABASE_URL is not set and --skip-docker was passed. Set one or remove the flag.',
    );
  }

  // 2. Apply better-auth migrations.
  log('→ applying better-auth schema…');
  const pool = new pg.Pool({ connectionString: dbUrl });
  try {
    const { applied, skipped } = await ensureBetterAuthSchema(pool);
    if (applied.length) {
      log(`  applied: ${applied.join(', ')}`);
    } else {
      log(`  up to date (${skipped.length} migration${skipped.length === 1 ? '' : 's'} on disk)`);
    }
  } finally {
    await pool.end();
  }

  // 3. Resolve secrets. JWT_SECRET and BETTER_AUTH_SECRET are generated
  //    if absent so the first run is zero-config. They're logged once
  //    so the user can pin them in .env.local if they want stable keys.
  const jwtSecret = ensureSecret('JWT_SECRET');
  const betterAuthSecret = ensureSecret('BETTER_AUTH_SECRET');
  const port = opts.port;
  const baseUrl = process.env.BETTER_AUTH_URL || `http://localhost:${port}`;

  // 4. Mint apikeys for the banner. These are stable across restarts
  //    because JWT_SECRET is stable (once .env is populated).
  const anonKey = generateApikey({ secret: jwtSecret, role: 'anon' });
  const serviceKey = generateApikey({ secret: jwtSecret, role: 'service_role' });

  // 5. Start the HTTP server.
  const { baseUrl: actualUrl, stop } = await startDevServer({
    pgrestConfig: {
      database: { connectionString: dbUrl },
      jwtSecret,
      auth: {
        provider: 'better-auth',
        betterAuthSecret,
        betterAuthUrl: baseUrl,
        databaseUrl: dbUrl,
      },
      cors: { allowedOrigins: '*' },
      production: false,
      docs: true,
    },
    port,
  });

  // 6. Banner.
  console.log('');
  console.log('  pgrest-lambda is running ✓');
  console.log('');
  console.log(`  API:           ${actualUrl}`);
  console.log(`  OpenAPI spec:  ${actualUrl}/rest/v1/`);
  console.log(`  Scalar docs:   ${actualUrl}/rest/v1/_docs`);
  console.log('');
  console.log(`  Anon apikey:     ${anonKey}`);
  console.log(`  Service apikey:  ${serviceKey}`);
  console.log('');
  console.log('  Press Ctrl-C to stop.');
  console.log('');

  // Keep running until SIGINT.
  await new Promise((resolve) => {
    process.on('SIGINT', () => {
      log('\n→ shutting down…');
      stop().then(resolve);
    });
    process.on('SIGTERM', () => {
      stop().then(resolve);
    });
  });
}

async function cmdMigrateAuth(argv) {
  parseFlags(argv, {});
  await loadDotenv();

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    throw new Error('DATABASE_URL must be set for `migrate-auth`.');
  }

  log(`→ applying better-auth migrations against ${redact(dbUrl)}…`);
  const pool = new pg.Pool({ connectionString: dbUrl });
  try {
    const { applied, skipped } = await ensureBetterAuthSchema(pool, {
      onApply: (f) => log(`  applied ${f}`),
    });
    if (!applied.length) {
      log(`  up to date (${skipped.length} migration${skipped.length === 1 ? '' : 's'} on disk)`);
    }
  } finally {
    await pool.end();
  }
  console.log('✓ done');
}

async function cmdGenerateKey(argv) {
  const role = argv[0];
  if (role !== 'anon' && role !== 'service_role') {
    console.error('usage: pgrest-lambda generate-key <anon|service_role>');
    process.exit(2);
  }
  await loadDotenv();
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET must be set.');
  console.log(generateApikey({ secret, role }));
}

function cmdHelp() {
  console.log(`pgrest-lambda — serverless REST API for PostgreSQL

Usage:
  pgrest-lambda <command> [options]

Commands:
  dev [--port N] [--skip-docker]
      Boot a local dev stack. Starts Postgres (Docker), applies the
      better-auth schema, starts the HTTP server, prints an anon
      apikey and the Scalar docs URL. Generates JWT_SECRET and
      BETTER_AUTH_SECRET into memory if absent — pin them in .env for
      stable keys.

  migrate-auth
      Apply the better-auth schema against DATABASE_URL. Idempotent.
      For production bootstraps.

  generate-key <anon|service_role>
      Mint an HS256 apikey JWT using JWT_SECRET. Prints to stdout.

  help
      Show this message.

Environment variables (loaded from .env automatically):
  DATABASE_URL         Postgres connection string
  JWT_SECRET           HS256 secret for apikeys (>= 32 chars)
  BETTER_AUTH_SECRET   better-auth secret (>= 32 chars)
  BETTER_AUTH_URL      override the baseURL better-auth uses for OAuth
  PGREST_DOCS          set to "false" to disable /rest/v1/_docs
`);
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

function log(line) { console.log(line); }

function parseFlags(argv, spec) {
  const out = {};
  for (const [name, cfg] of Object.entries(spec)) {
    out[name] = cfg.default;
  }
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (!tok.startsWith('--')) continue;
    const name = tok.slice(2);
    if (!spec[name]) continue;
    if (spec[name].type === 'boolean') {
      out[name] = true;
    } else if (spec[name].type === 'number') {
      out[name] = parseInt(argv[++i], 10);
    } else {
      out[name] = argv[++i];
    }
  }
  return out;
}

async function loadDotenv() {
  for (const filename of ['.env.local', '.env']) {
    try {
      const contents = await readFile(resolve(process.cwd(), filename), 'utf8');
      for (const line of contents.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq === -1) continue;
        const key = trimmed.slice(0, eq).trim();
        let value = trimmed.slice(eq + 1).trim();
        // Strip surrounding quotes
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        if (process.env[key] === undefined) process.env[key] = value;
      }
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
}

function ensureSecret(name) {
  if (process.env[name]) return process.env[name];
  const generated = randomBytes(48).toString('base64');
  process.env[name] = generated;
  console.log(`  generated ephemeral ${name} (pin in .env for stable apikeys)`);
  return generated;
}

function redact(url) {
  return url.replace(/:[^:@/]+@/, ':***@');
}
