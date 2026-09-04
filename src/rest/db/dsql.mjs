// dsql.mjs — Aurora DSQL provider (IAM token auth)

import pg from 'pg';
import { restPoolTypes } from '../pg-types.mjs';

const { Pool } = pg;
const TOKEN_LIFETIME_MS = 10 * 60 * 1000; // 10 minutes

// DSQL capability research — verified against
// docs.aws.amazon.com/aurora-dsql/ (2025-05):
//
// supportsForeignKeys: true
//   DSQL added foreign key constraints on 2026-08-27
//   (docs.aws.amazon.com/aurora-dsql/latest/userguide/working-with-foreign-key-constraints.html).
//   Measured on a cluster 2026-08-28: inline REFERENCES in CREATE TABLE is
//   accepted in every shape (column list, bare, table-level, composite,
//   self-reference, cross-schema, all five referential actions, MATCH FULL,
//   DEFERRABLE). A key can be added to an existing table only as
//   ALTER TABLE ... ADD CONSTRAINT ... NOT VALID; plain ADD CONSTRAINT and
//   VALIDATE CONSTRAINT both return 0A000. NOT VALID skips the check of
//   existing rows but enforces every later write. pg_constraint contype='f'
//   is fully populated (conkey, confkey, confupdtype, confdeltype,
//   confmatchtype, condeferrable, convalidated), so the engine reads
//   relationships from the catalog on DSQL as it does on PostgreSQL.
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
// supportsPlannedCount: true
//   `count=planned`/`count=estimated` do not read pg_class.reltuples: upstream
//   EXPLAINs the filtered read and takes `[0].Plan."Plan Rows"`
//   (Query/MainTx.hs `decodeExplain`), which is what handler.mjs does.
//   EXPLAIN (FORMAT JSON) works on DSQL; verified against the conformance
//   fixtures (RangeSpec:311/320/329/359/390, QueryLimitedSpec:50/71 pass).
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
  supportsForeignKeys: true,
  supportsFullTextSearch: false,
  supportsRangeTypes: false,
  supportsArrayContainment: true,
  supportsPlannedCount: true,
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
      // REST results only; the auth pool keeps the global registry.
      types: restPoolTypes,
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
