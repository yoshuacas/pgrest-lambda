// postgres.mjs — Standard PostgreSQL provider

import pg from 'pg';

const { Pool } = pg;

function resolveSsl(ssl) {
  if (!ssl) return undefined;
  if (ssl === true) return { rejectUnauthorized: true };
  return { rejectUnauthorized: true, ...ssl };
}

const POSTGRES_CAPABILITIES = Object.freeze({
  supportsForeignKeys: true,
  supportsFullTextSearch: true,
  supportsRangeTypes: true,
  supportsArrayContainment: true,
  supportsPlannedCount: true,
  supportsRegex: true,
  supportsRowLevelSecurity: true,
  supportsRpc: true,
  supportsGinIndex: true,
});

/** @returns {import('./interface.mjs').DatabaseProvider} */
export function createPostgresProvider(config) {
  let pool = null;

  function _setPool(p) {
    pool = p;
  }

  async function getPool() {
    if (pool) return pool;

    if (config.connectionString) {
      pool = new Pool({
        connectionString: config.connectionString,
        max: 5,
        idleTimeoutMillis: 60000,
      });
    } else {
      pool = new Pool({
        host: config.host || 'localhost',
        port: config.port || 5432,
        user: config.user || 'postgres',
        password: config.password || '',
        database: config.database || 'postgres',
        ssl: resolveSsl(config.ssl),
        max: 5,
        idleTimeoutMillis: 60000,
      });
    }

    return pool;
  }

  async function close() {
    if (pool) {
      await pool.end().catch(() => {});
      pool = null;
    }
  }

  return { getPool, _setPool, close, capabilities: () => POSTGRES_CAPABILITIES };
}
