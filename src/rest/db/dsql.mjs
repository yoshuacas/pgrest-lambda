// dsql.mjs — Aurora DSQL provider (IAM token auth)

import pg from 'pg';

const { Pool } = pg;
const TOKEN_LIFETIME_MS = 10 * 60 * 1000; // 10 minutes

// DSQL capability research — verified against
// docs.aws.amazon.com/aurora-dsql/ (2025-05):
//
// supportsForeignKeys: false
//   DSQL drops FK constraints for distributed consistency.
//   pg_constraint has no contype='f' rows.
//
// supportsFullTextSearch: false
//   tsvector/tsquery not in supported data types list.
//
// supportsRangeTypes: false
//   Range types not in supported data types list.
//
// supportsArrayContainment: true
//   Array types supported; @>, <@, && expected to work.
//
// supportsPlannedCount: false
//   pg_class.reltuples accuracy undocumented on DSQL.
//
// supportsRegex: true
//   LIKE/ILIKE confirmed; POSIX ~ assumed (text type supported).
//
// supportsRowLevelSecurity: false
//   CREATE POLICY / SET ROLE not in supported SQL commands.
//
// supportsRpc: true
//   SQL-language functions only, no PL/pgSQL.
//
// supportsGinIndex: false
//   B-tree only; GIN/GiST/HASH/BRIN not supported.
const DSQL_CAPABILITIES = Object.freeze({
  supportsForeignKeys: false,
  supportsFullTextSearch: false,
  supportsRangeTypes: false,
  supportsArrayContainment: true,
  supportsPlannedCount: false,
  supportsRegex: true,
  supportsRowLevelSecurity: false,
  supportsRpc: true,
  supportsGinIndex: false,
});

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
      ssl: { rejectUnauthorized: true },
      max: 5,
      idleTimeoutMillis: 60000,
    });

    tokenRefreshedAt = now;
    return pool;
  }

  async function close() {
    if (pool) {
      await pool.end().catch(() => {});
      pool = null;
    }
  }

  return { getPool, _setPool, close, capabilities: () => DSQL_CAPABILITIES };
}
