// db.mjs — Connection pool with pluggable database adapters

import pg from 'pg';

const { Pool } = pg;
const TOKEN_LIFETIME_MS = 10 * 60 * 1000; // 10 minutes

export function createDb(config) {
  let pool = null;
  let tokenRefreshedAt = 0;

  function isDsqlMode() {
    return Boolean(config.dsqlEndpoint);
  }

  async function createDsqlPool() {
    const { DsqlSigner } = await import('@aws-sdk/dsql-signer');
    const signer = new DsqlSigner({
      hostname: config.dsqlEndpoint,
      region: config.region,
    });
    const token = await signer.getDbConnectAdminAuthToken();

    return new Pool({
      host: config.dsqlEndpoint,
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
    if (config.connectionString) {
      return new Pool({
        connectionString: config.connectionString,
        max: 5,
        idleTimeoutMillis: 60000,
      });
    }

    return new Pool({
      host: config.host || 'localhost',
      port: config.port || 5432,
      user: config.user || 'postgres',
      password: config.password || '',
      database: config.database || 'postgres',
      ssl: config.ssl ? { rejectUnauthorized: false } : undefined,
      max: 5,
      idleTimeoutMillis: 60000,
    });
  }

  function _setPool(p) {
    pool = p;
    tokenRefreshedAt = Date.now();
  }

  async function getPool() {
    const now = Date.now();

    if (isDsqlMode()) {
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

    if (pool) return pool;
    pool = createStandardPool();
    tokenRefreshedAt = now;
    return pool;
  }

  return { getPool, _setPool };
}
