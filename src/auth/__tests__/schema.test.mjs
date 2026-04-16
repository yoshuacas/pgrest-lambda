import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  ensureAuthSchema,
  AUTH_SCHEMA_SQL,
  _resetInitialized,
} from '../schema.mjs';

function createMockPool() {
  const queries = [];
  return {
    queries,
    query: async (sql) => {
      queries.push(sql);
      return { rows: [] };
    },
  };
}

describe('ensureAuthSchema', () => {
  beforeEach(() => {
    _resetInitialized();
  });

  it('executes all DDL statements in order', async () => {
    const pool = createMockPool();
    await ensureAuthSchema(pool);

    assert.equal(
      pool.queries.length,
      AUTH_SCHEMA_SQL.length,
      `should execute ${AUTH_SCHEMA_SQL.length} queries`
    );
    for (let i = 0; i < AUTH_SCHEMA_SQL.length; i++) {
      assert.equal(
        pool.queries[i],
        AUTH_SCHEMA_SQL[i],
        `query ${i} should match AUTH_SCHEMA_SQL[${i}]`
      );
    }
    assert.ok(
      pool.queries[0].includes('CREATE SCHEMA IF NOT EXISTS auth'),
      'first statement should create auth schema'
    );
    assert.ok(
      pool.queries.some((q) => q.includes('auth.users')),
      'should include users table creation'
    );
    assert.ok(
      pool.queries.some((q) => q.includes('INDEX')),
      'should include index creation'
    );
  });

  it('is a no-op on second call', async () => {
    const pool = createMockPool();
    await ensureAuthSchema(pool);
    const countAfterFirst = pool.queries.length;

    await ensureAuthSchema(pool);

    assert.equal(
      pool.queries.length,
      countAfterFirst,
      'second call should not produce additional queries'
    );
  });

  it('re-executes after _resetInitialized', async () => {
    const pool = createMockPool();
    await ensureAuthSchema(pool);
    const countAfterFirst = pool.queries.length;

    _resetInitialized();
    await ensureAuthSchema(pool);

    assert.equal(
      pool.queries.length,
      countAfterFirst * 2,
      'should execute all DDL statements again after reset'
    );
  });
});
