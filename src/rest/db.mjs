// db.mjs — Connection pool with pluggable database adapters
//
// Supports two modes based on environment variables:
//   1. DSQL (IAM auth)   — set DSQL_ENDPOINT + REGION_NAME
//   2. Standard PostgreSQL — set DATABASE_URL (or PG_HOST, PG_PORT, PG_USER, PG_PASSWORD, PG_DATABASE)

import pg from 'pg';

const { Pool } = pg;

let pool = null;
let tokenRefreshedAt = 0;
const TOKEN_LIFETIME_MS = 10 * 60 * 1000; // 10 minutes

function isDsqlMode() {
  return Boolean(process.env.DSQL_ENDPOINT);
}

async function createDsqlPool() {
  const { DsqlSigner } = await import('@aws-sdk/dsql-signer');
  const signer = new DsqlSigner({
    hostname: process.env.DSQL_ENDPOINT,
    region: process.env.REGION_NAME,
  });
  const token = await signer.getDbConnectAdminAuthToken();

  return new Pool({
    host: process.env.DSQL_ENDPOINT,
    port: 5432,
    user: 'admin',
    password: token,
    database: 'postgres',
    ssl: { rejectUnauthorized: false },
    max: 5,
    idleTimeoutMillis: 60000,
  });
}

function createStandardPool() {
  if (process.env.DATABASE_URL) {
    return new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 5,
      idleTimeoutMillis: 60000,
    });
  }

  return new Pool({
    host: process.env.PG_HOST || 'localhost',
    port: parseInt(process.env.PG_PORT || '5432', 10),
    user: process.env.PG_USER || 'postgres',
    password: process.env.PG_PASSWORD || '',
    database: process.env.PG_DATABASE || 'postgres',
    ssl: process.env.PG_SSL === 'true'
      ? { rejectUnauthorized: false }
      : undefined,
    max: 5,
    idleTimeoutMillis: 60000,
  });
}

/** @internal Test helper — pre-set the pool to skip real connections. */
export function _setPool(p) {
  pool = p;
  tokenRefreshedAt = Date.now();
}

export async function getPool() {
  const now = Date.now();

  if (isDsqlMode()) {
    // DSQL tokens expire — refresh pool when token is stale
    if (pool && now - tokenRefreshedAt < TOKEN_LIFETIME_MS) {
      return pool;
    }
    if (pool) {
      await pool.end().catch(() => {});
    }
    pool = await createDsqlPool();
    tokenRefreshedAt = now;
    return pool;
  }

  // Standard PostgreSQL — pool lives for the Lambda instance lifetime
  if (pool) return pool;
  pool = createStandardPool();
  tokenRefreshedAt = now;
  return pool;
}
