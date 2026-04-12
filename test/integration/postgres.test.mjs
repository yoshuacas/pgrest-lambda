// postgres.test.mjs — Integration tests against a real PostgreSQL database.
//
// Skipped unless TEST_DATABASE_URL is set:
//   TEST_DATABASE_URL=postgresql://postgres:pass@localhost:5433/postgres \
//     node --test test/integration/postgres.test.mjs

import { describe, before, after, beforeEach } from 'node:test';
import pg from 'pg';
import { createPgrest } from '../../src/index.mjs';
import {
  JWT_SECRET, SCHEMA_SQL, SEED_SQL, DROP_SQL, makeEvent, sharedTests,
} from './helpers.mjs';

const DATABASE_URL = process.env.TEST_DATABASE_URL;

describe('postgres integration', { skip: !DATABASE_URL }, () => {
  let pool;
  let pgrest;

  before(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    await pool.query(SCHEMA_SQL);

    pgrest = createPgrest({
      database: { connectionString: DATABASE_URL },
      jwtSecret: JWT_SECRET,
      auth: false,
    });
  });

  beforeEach(async () => {
    await pool.query(SEED_SQL);
    await pgrest.rest(makeEvent({ method: 'POST', path: '/rest/v1/_refresh' }));
  });

  after(async () => {
    await pool.query(DROP_SQL);
    await pool.end();
  });

  sharedTests(() => pgrest, () => pool);
});
