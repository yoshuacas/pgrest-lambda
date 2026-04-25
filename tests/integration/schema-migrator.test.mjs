import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  startPostgres, stopPostgres, createPool,
} from '../harness/db.mjs';
import { ensureBetterAuthSchema } from '../../src/index.mjs';

describe('ensureBetterAuthSchema (migration runner)', () => {
  let pool;

  before(async () => {
    await startPostgres();
    pool = createPool();
  });

  after(async () => {
    await pool.end();
    await stopPostgres();
  });

  beforeEach(async () => {
    // Wipe everything so each test starts from an empty DB.
    await pool.query('DROP SCHEMA IF EXISTS better_auth CASCADE');
    await pool.query('DROP SCHEMA IF EXISTS public CASCADE');
    await pool.query('CREATE SCHEMA public');
  });

  it('creates the better_auth schema and all migration tables on first run', async () => {
    const result = await ensureBetterAuthSchema(pool);
    assert.ok(result.applied.length >= 1, 'at least one migration applied');
    assert.equal(result.skipped.length, 0);

    const { rows } = await pool.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'better_auth'
      ORDER BY table_name
    `);
    const tables = rows.map((r) => r.table_name);
    assert.ok(tables.includes('user'));
    assert.ok(tables.includes('session'));
    assert.ok(tables.includes('account'));
    assert.ok(tables.includes('verification'));
    assert.ok(tables.includes('jwks'));
    assert.ok(tables.includes('__migrations'));
  });

  it('is idempotent: second run applies nothing and skips everything', async () => {
    const first = await ensureBetterAuthSchema(pool);
    const second = await ensureBetterAuthSchema(pool);

    assert.equal(second.applied.length, 0);
    assert.equal(second.skipped.length, first.applied.length);
  });

  it('records every applied migration in better_auth.__migrations', async () => {
    const result = await ensureBetterAuthSchema(pool);
    const { rows } = await pool.query(
      'SELECT filename FROM better_auth.__migrations ORDER BY filename',
    );
    const recorded = rows.map((r) => r.filename);
    assert.deepEqual(recorded, [...result.applied].sort());
  });

  it('survives concurrent calls (advisory lock serializes them)', async () => {
    // Fire three migrators in parallel; they race for the lock.
    const results = await Promise.all([
      ensureBetterAuthSchema(pool),
      ensureBetterAuthSchema(pool),
      ensureBetterAuthSchema(pool),
    ]);

    // Exactly one run should have applied migrations; the other two
    // should have seen them already applied.
    const appliedCounts = results.map((r) => r.applied.length).sort();
    assert.ok(appliedCounts[2] >= 1, 'one caller applied migrations');
    assert.equal(appliedCounts[0], 0, 'two callers saw them already applied');
    assert.equal(appliedCounts[1], 0);
  });

  it('invokes the onApply callback for each applied migration', async () => {
    const seen = [];
    const result = await ensureBetterAuthSchema(pool, {
      onApply: (filename) => seen.push(filename),
    });
    assert.deepEqual(seen, result.applied);
  });
});
