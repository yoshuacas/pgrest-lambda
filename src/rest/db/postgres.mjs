// postgres.mjs — Standard PostgreSQL provider

import pg from 'pg';

const { Pool } = pg;

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
        ssl: config.ssl ? { rejectUnauthorized: false } : undefined,
        max: 5,
        idleTimeoutMillis: 60000,
      });
    }

    return pool;
  }

  return { getPool, _setPool };
}
