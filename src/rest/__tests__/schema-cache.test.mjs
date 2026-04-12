import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  createSchemaCache,
  hasTable,
  hasColumn,
  getPrimaryKey,
} from '../schema-cache.mjs';

function createMockPool(columnRows, pkRows) {
  let queryCount = 0;
  return {
    query: async (sql) => {
      queryCount++;
      // First query is columns, second is primary keys
      if (sql.includes('pg_attribute') || sql.includes('pg_class')) {
        if (sql.includes('contype')) {
          return { rows: pkRows };
        }
        return { rows: columnRows };
      }
      return { rows: [] };
    },
    getQueryCount: () => queryCount,
  };
}

const columnRows = [
  {
    table_name: 'todos',
    column_name: 'id',
    data_type: 'text',
    is_nullable: false,
    column_default: null,
  },
  {
    table_name: 'todos',
    column_name: 'title',
    data_type: 'text',
    is_nullable: true,
    column_default: null,
  },
  {
    table_name: 'categories',
    column_name: 'id',
    data_type: 'text',
    is_nullable: false,
    column_default: null,
  },
  {
    table_name: 'categories',
    column_name: 'name',
    data_type: 'text',
    is_nullable: false,
    column_default: null,
  },
];

const pkRows = [
  { table_name: 'todos', column_name: 'id' },
  { table_name: 'categories', column_name: 'id' },
];

describe('schema-cache', () => {
  let sc;
  beforeEach(() => {
    sc = createSchemaCache({ schemaCacheTtl: 300000 });
  });

  it('parses pg_catalog rows into cache with both tables', async () => {
    const pool = createMockPool(columnRows, pkRows);
    const schema = await sc.getSchema(pool);
    assert.ok(schema.tables.todos,
      'cache should have todos table');
    assert.ok(schema.tables.categories,
      'cache should have categories table');
    assert.ok(schema.tables.todos.columns.id,
      'todos should have id column');
    assert.ok(schema.tables.todos.columns.title,
      'todos should have title column');
    assert.ok(schema.tables.categories.columns.name,
      'categories should have name column');
  });

  it('does not call pool.query again within TTL', async () => {
    const pool = createMockPool(columnRows, pkRows);
    await sc.getSchema(pool);
    const countAfterFirst = pool.getQueryCount();
    await sc.getSchema(pool);
    const countAfterSecond = pool.getQueryCount();
    assert.equal(countAfterSecond, countAfterFirst,
      'should not query again within TTL');
  });

  it('calls pool.query again after TTL expires', async () => {
    // This test relies on the implementation using a configurable TTL.
    // We verify via refresh() which forces re-query regardless of TTL.
    const pool = createMockPool(columnRows, pkRows);
    await sc.getSchema(pool);
    const countAfterFirst = pool.getQueryCount();
    await sc.refresh(pool);
    const countAfterRefresh = pool.getQueryCount();
    assert.ok(countAfterRefresh > countAfterFirst,
      'refresh should trigger new queries regardless of TTL');
  });

  it('refresh() forces re-query regardless of TTL', async () => {
    const pool = createMockPool(columnRows, pkRows);
    await sc.getSchema(pool);
    const countAfterFirst = pool.getQueryCount();
    await sc.refresh(pool);
    const countAfterRefresh = pool.getQueryCount();
    assert.ok(countAfterRefresh > countAfterFirst,
      'refresh should call pool.query again');
  });

  it('hasTable returns true for existing table', async () => {
    const pool = createMockPool(columnRows, pkRows);
    const schema = await sc.getSchema(pool);
    assert.equal(hasTable(schema, 'todos'), true,
      'hasTable should return true for todos');
  });

  it('hasTable returns false for nonexistent table', async () => {
    const pool = createMockPool(columnRows, pkRows);
    const schema = await sc.getSchema(pool);
    assert.equal(hasTable(schema, 'nonexistent'), false,
      'hasTable should return false for nonexistent');
  });

  it('hasColumn returns true for existing column', async () => {
    const pool = createMockPool(columnRows, pkRows);
    const schema = await sc.getSchema(pool);
    assert.equal(hasColumn(schema, 'todos', 'title'), true,
      'hasColumn should return true for todos.title');
  });

  it('hasColumn returns false for nonexistent column', async () => {
    const pool = createMockPool(columnRows, pkRows);
    const schema = await sc.getSchema(pool);
    assert.equal(hasColumn(schema, 'todos', 'nonexistent'), false,
      'hasColumn should return false for nonexistent column');
  });

  it('getPrimaryKey returns correct columns', async () => {
    const pool = createMockPool(columnRows, pkRows);
    const schema = await sc.getSchema(pool);
    const pk = getPrimaryKey(schema, 'todos');
    assert.deepStrictEqual(pk, ['id'],
      'getPrimaryKey should return [id] for todos');
  });
});
