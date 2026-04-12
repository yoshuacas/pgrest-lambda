// dsql.mjs — Aurora DSQL provider (IAM token auth)

import pg from 'pg';

const { Pool } = pg;
const TOKEN_LIFETIME_MS = 10 * 60 * 1000; // 10 minutes

/** @returns {import('./interface.mjs').DatabaseProvider} */
export function createDsqlProvider(config) {
  let pool = null;
  let tokenRefreshedAt = 0;

  function _setPool(p) {
    pool = p;
    tokenRefreshedAt = Date.now();
  }

  async function getPool() {
    const now = Date.now();

    if (pool && now - tokenRefreshedAt < TOKEN_LIFETIME_MS) {
      return pool;
    }

    if (pool) {
      await pool.end().catch(() => {});
    }

    const { DsqlSigner } = await import('@aws-sdk/dsql-signer');
    const signer = new DsqlSigner({
      hostname: config.dsqlEndpoint,
      region: config.region,
    });
    const token = await signer.getDbConnectAdminAuthToken();

    pool = new Pool({
      host: config.dsqlEndpoint,
      port: 5432,
      user: 'admin',
      password: token,
      database: 'postgres',
      ssl: { rejectUnauthorized: false },
      max: 5,
      idleTimeoutMillis: 60000,
    });

    tokenRefreshedAt = now;
    return pool;
  }

  return { getPool, _setPool };
}
