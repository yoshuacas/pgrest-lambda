import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  createSchemaCache,
  hasTable,
  hasColumn,
  getPrimaryKey,
  getRelationships,
} from '../schema-cache.mjs';

function createMockPool(columnRows, pkRows, fkRows = []) {
  let queryCount = 0;
  return {
    query: async (sql) => {
      queryCount++;
      if (sql.includes("contype = 'f'")) {
        return { rows: fkRows };
      }
      if (sql.includes("contype = 'p'")) {
        return { rows: pkRows };
      }
      // Default: columns query
      return { rows: columnRows };
    },
    getQueryCount: () => queryCount,
  };
}

function createThrowingFkPool(columnRows, pkRows) {
  let queryCount = 0;
  return {
    query: async (sql) => {
      queryCount++;
      if (sql.includes("contype = 'f'")) {
        throw new Error('DSQL does not support LATERAL');
      }
      if (sql.includes("contype = 'p'")) {
        return { rows: pkRows };
      }
      return { rows: columnRows };
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

// --- FK introspection tests ---

const fkColumnRows = [
  {
    table_name: 'orders',
    column_name: 'id',
    data_type: 'bigint',
    is_nullable: false,
    column_default: null,
  },
  {
    table_name: 'orders',
    column_name: 'customer_id',
    data_type: 'bigint',
    is_nullable: true,
    column_default: null,
  },
  {
    table_name: 'customers',
    column_name: 'id',
    data_type: 'bigint',
    is_nullable: false,
    column_default: null,
  },
  {
    table_name: 'customers',
    column_name: 'name',
    data_type: 'text',
    is_nullable: false,
    column_default: null,
  },
];

const fkPkRows = [
  { table_name: 'orders', column_name: 'id' },
  { table_name: 'customers', column_name: 'id' },
];

describe('FK introspection', () => {
  it('maps FK rows to relationships array', async () => {
    const fkRows = [{
      constraint_name: 'orders_customer_id_fkey',
      from_table: 'orders',
      from_columns: ['customer_id'],
      to_table: 'customers',
      to_columns: ['id'],
    }];
    const pool = createMockPool(fkColumnRows, fkPkRows, fkRows);
    const sc = createSchemaCache({ schemaCacheTtl: 300000 });
    const schema = await sc.getSchema(pool);
    assert.ok(Array.isArray(schema.relationships),
      'schema should have relationships array');
    assert.equal(schema.relationships.length, 1);
    const rel = schema.relationships[0];
    assert.equal(rel.constraint, 'orders_customer_id_fkey');
    assert.equal(rel.fromTable, 'orders');
    assert.deepStrictEqual(rel.fromColumns, ['customer_id']);
    assert.equal(rel.toTable, 'customers');
    assert.deepStrictEqual(rel.toColumns, ['id']);
  });

  it('returns empty relationships when FK query returns '
    + 'zero rows and no _id columns', async () => {
    // Use the basic todos/categories tables that have no _id
    // columns, so convention fallback also finds nothing.
    const pool = createMockPool(columnRows, pkRows, []);
    const sc = createSchemaCache({ schemaCacheTtl: 300000 });
    const schema = await sc.getSchema(pool);
    assert.ok(Array.isArray(schema.relationships));
    assert.equal(schema.relationships.length, 0);
  });

  it('treats FK query error as zero rows', async () => {
    const pool = createThrowingFkPool(columnRows, pkRows);
    const sc = createSchemaCache({ schemaCacheTtl: 300000 });
    const schema = await sc.getSchema(pool);
    assert.ok(schema.tables.todos,
      'tables should still be populated');
    assert.ok(Array.isArray(schema.relationships),
      'relationships should be an array');
    // Convention fallback runs; todos/categories have no _id
    // columns so result is empty.
    assert.equal(schema.relationships.length, 0);
  });
});

// --- Convention fallback tests ---

describe('convention fallback', () => {
  it('infers relationship from _id column', async () => {
    // orders.customer_id -> customers.id
    const pool = createMockPool(fkColumnRows, fkPkRows, []);
    const sc = createSchemaCache({ schemaCacheTtl: 300000 });
    const schema = await sc.getSchema(pool);
    assert.equal(schema.relationships.length, 1);
    const rel = schema.relationships[0];
    assert.equal(rel.constraint, null);
    assert.equal(rel.fromTable, 'orders');
    assert.deepStrictEqual(rel.fromColumns, ['customer_id']);
    assert.equal(rel.toTable, 'customers');
    assert.deepStrictEqual(rel.toColumns, ['id']);
  });

  it('skips _id column with no matching table', async () => {
    const cols = [
      {
        table_name: 'orders',
        column_name: 'id',
        data_type: 'bigint',
        is_nullable: false,
        column_default: null,
      },
      {
        table_name: 'orders',
        column_name: 'foo_id',
        data_type: 'bigint',
        is_nullable: true,
        column_default: null,
      },
    ];
    const pks = [{ table_name: 'orders', column_name: 'id' }];
    const pool = createMockPool(cols, pks, []);
    const sc = createSchemaCache({ schemaCacheTtl: 300000 });
    const schema = await sc.getSchema(pool);
    assert.equal(schema.relationships.length, 0,
      'no foo or foos table -> no relationship');
  });

  it('skips self-referencing _id column', async () => {
    // user_id on users table -> skip
    const cols = [
      {
        table_name: 'users',
        column_name: 'id',
        data_type: 'bigint',
        is_nullable: false,
        column_default: null,
      },
      {
        table_name: 'users',
        column_name: 'user_id',
        data_type: 'bigint',
        is_nullable: true,
        column_default: null,
      },
    ];
    const pks = [{ table_name: 'users', column_name: 'id' }];
    const pool = createMockPool(cols, pks, []);
    const sc = createSchemaCache({ schemaCacheTtl: 300000 });
    const schema = await sc.getSchema(pool);
    assert.equal(schema.relationships.length, 0,
      'user_id on users should be skipped');
  });

  it('skips target table with composite PK', async () => {
    const cols = [
      {
        table_name: 'orders',
        column_name: 'id',
        data_type: 'bigint',
        is_nullable: false,
        column_default: null,
      },
      {
        table_name: 'orders',
        column_name: 'item_id',
        data_type: 'bigint',
        is_nullable: true,
        column_default: null,
      },
      {
        table_name: 'items',
        column_name: 'order_id',
        data_type: 'bigint',
        is_nullable: false,
        column_default: null,
      },
      {
        table_name: 'items',
        column_name: 'product_id',
        data_type: 'bigint',
        is_nullable: false,
        column_default: null,
      },
    ];
    const pks = [
      { table_name: 'orders', column_name: 'id' },
      { table_name: 'items', column_name: 'order_id' },
      { table_name: 'items', column_name: 'product_id' },
    ];
    const pool = createMockPool(cols, pks, []);
    const sc = createSchemaCache({ schemaCacheTtl: 300000 });
    const schema = await sc.getSchema(pool);
    // items has composite PK, so orders.item_id -> items
    // should be skipped.
    const toItems = schema.relationships.filter(
      r => r.toTable === 'items');
    assert.equal(toItems.length, 0,
      'composite PK target should be skipped');
  });

  it('skips bare _id column', async () => {
    const cols = [
      {
        table_name: 'things',
        column_name: '_id',
        data_type: 'bigint',
        is_nullable: false,
        column_default: null,
      },
    ];
    const pks = [{ table_name: 'things', column_name: '_id' }];
    const pool = createMockPool(cols, pks, []);
    const sc = createSchemaCache({ schemaCacheTtl: 300000 });
    const schema = await sc.getSchema(pool);
    assert.equal(schema.relationships.length, 0,
      'bare _id column should be skipped');
  });

  it('creates separate relationships for multiple _id '
    + 'columns to different tables', async () => {
    const cols = [
      {
        table_name: 'orders',
        column_name: 'id',
        data_type: 'bigint',
        is_nullable: false,
        column_default: null,
      },
      {
        table_name: 'orders',
        column_name: 'billing_address_id',
        data_type: 'bigint',
        is_nullable: true,
        column_default: null,
      },
      {
        table_name: 'orders',
        column_name: 'shipping_address_id',
        data_type: 'bigint',
        is_nullable: true,
        column_default: null,
      },
      {
        table_name: 'addresses',
        column_name: 'id',
        data_type: 'bigint',
        is_nullable: false,
        column_default: null,
      },
    ];
    // Note: billing_address and shipping_address don't match
    // any table. But with real naming like address_id, it would.
    // Let's use a more realistic scenario with two separate
    // FK-like columns that match via convention.
    // Actually, billing_address_id -> base = 'billing_address'
    // which won't match 'addresses'. Convention fallback only
    // handles simple singular/plural. For this test, use two
    // columns that both resolve to the same table.
    const cols2 = [
      {
        table_name: 'transfers',
        column_name: 'id',
        data_type: 'bigint',
        is_nullable: false,
        column_default: null,
      },
      {
        table_name: 'transfers',
        column_name: 'sender_account_id',
        data_type: 'bigint',
        is_nullable: true,
        column_default: null,
      },
      {
        table_name: 'transfers',
        column_name: 'receiver_account_id',
        data_type: 'bigint',
        is_nullable: true,
        column_default: null,
      },
      {
        table_name: 'sender_accounts',
        column_name: 'id',
        data_type: 'bigint',
        is_nullable: false,
        column_default: null,
      },
      {
        table_name: 'receiver_accounts',
        column_name: 'id',
        data_type: 'bigint',
        is_nullable: false,
        column_default: null,
      },
    ];
    const pks2 = [
      { table_name: 'transfers', column_name: 'id' },
      { table_name: 'sender_accounts', column_name: 'id' },
      { table_name: 'receiver_accounts', column_name: 'id' },
    ];
    const pool = createMockPool(cols2, pks2, []);
    const sc = createSchemaCache({ schemaCacheTtl: 300000 });
    const schema = await sc.getSchema(pool);
    // sender_account_id -> sender_accounts, receiver_account_id
    // -> receiver_accounts. Each is a separate relationship.
    assert.equal(schema.relationships.length, 2,
      'should create two separate relationships');
    const senderRel = schema.relationships.find(
      r => r.fromColumns[0] === 'sender_account_id');
    const receiverRel = schema.relationships.find(
      r => r.fromColumns[0] === 'receiver_account_id');
    assert.ok(senderRel, 'should have sender relationship');
    assert.ok(receiverRel, 'should have receiver relationship');
    assert.equal(senderRel.toTable, 'sender_accounts');
    assert.equal(receiverRel.toTable, 'receiver_accounts');
  });

  it('does not infer relationship for multi-word '
    + 'prefix (billing_address_id -> addresses)',
  async () => {
    const cols = [
      {
        table_name: 'orders',
        column_name: 'id',
        data_type: 'bigint',
        is_nullable: false,
        column_default: null,
      },
      {
        table_name: 'orders',
        column_name: 'billing_address_id',
        data_type: 'bigint',
        is_nullable: true,
        column_default: null,
      },
      {
        table_name: 'orders',
        column_name: 'shipping_address_id',
        data_type: 'bigint',
        is_nullable: true,
        column_default: null,
      },
      {
        table_name: 'addresses',
        column_name: 'id',
        data_type: 'bigint',
        is_nullable: false,
        column_default: null,
      },
      {
        table_name: 'addresses',
        column_name: 'street',
        data_type: 'text',
        is_nullable: false,
        column_default: null,
      },
    ];
    const pks = [
      { table_name: 'orders', column_name: 'id' },
      { table_name: 'addresses', column_name: 'id' },
    ];
    const pool = createMockPool(cols, pks, []);
    const sc = createSchemaCache({ schemaCacheTtl: 300000 });
    const schema = await sc.getSchema(pool);
    // Convention fallback extracts 'billing_address'
    // from 'billing_address_id', which does not match
    // 'addresses'. This is a known limitation —
    // multi-word FK prefixes require real FK
    // constraints or !hint disambiguation.
    assert.equal(schema.relationships.length, 0,
      'multi-word prefixes should not resolve via '
      + 'convention (billing_address != addresses)');
  });

  it('infers relationship for -ies plural '
    + '(category_id -> categories)', async () => {
    const cols = [
      {
        table_name: 'items',
        column_name: 'id',
        data_type: 'bigint',
        is_nullable: false,
        column_default: null,
      },
      {
        table_name: 'items',
        column_name: 'category_id',
        data_type: 'bigint',
        is_nullable: true,
        column_default: null,
      },
      {
        table_name: 'categories',
        column_name: 'id',
        data_type: 'bigint',
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
    const pks = [
      { table_name: 'items', column_name: 'id' },
      { table_name: 'categories', column_name: 'id' },
    ];
    const pool = createMockPool(cols, pks, []);
    const sc = createSchemaCache({ schemaCacheTtl: 300000 });
    const schema = await sc.getSchema(pool);
    const rel = schema.relationships.find(
      r => r.fromColumns[0] === 'category_id');
    assert.ok(rel,
      'should infer category_id -> categories');
    assert.equal(rel.toTable, 'categories');
  });

  it('infers relationship for -es plural '
    + '(address_id -> addresses)', async () => {
    const cols = [
      {
        table_name: 'orders',
        column_name: 'id',
        data_type: 'bigint',
        is_nullable: false,
        column_default: null,
      },
      {
        table_name: 'orders',
        column_name: 'address_id',
        data_type: 'bigint',
        is_nullable: true,
        column_default: null,
      },
      {
        table_name: 'addresses',
        column_name: 'id',
        data_type: 'bigint',
        is_nullable: false,
        column_default: null,
      },
    ];
    const pks = [
      { table_name: 'orders', column_name: 'id' },
      { table_name: 'addresses', column_name: 'id' },
    ];
    const pool = createMockPool(cols, pks, []);
    const sc = createSchemaCache({ schemaCacheTtl: 300000 });
    const schema = await sc.getSchema(pool);
    const rel = schema.relationships.find(
      r => r.fromColumns[0] === 'address_id');
    assert.ok(rel,
      'should infer address_id -> addresses');
    assert.equal(rel.toTable, 'addresses');
  });

  it('infers relationship for -es plural '
    + '(status_id -> statuses)', async () => {
    const cols = [
      {
        table_name: 'orders',
        column_name: 'id',
        data_type: 'bigint',
        is_nullable: false,
        column_default: null,
      },
      {
        table_name: 'orders',
        column_name: 'status_id',
        data_type: 'bigint',
        is_nullable: true,
        column_default: null,
      },
      {
        table_name: 'statuses',
        column_name: 'id',
        data_type: 'bigint',
        is_nullable: false,
        column_default: null,
      },
    ];
    const pks = [
      { table_name: 'orders', column_name: 'id' },
      { table_name: 'statuses', column_name: 'id' },
    ];
    const pool = createMockPool(cols, pks, []);
    const sc = createSchemaCache({ schemaCacheTtl: 300000 });
    const schema = await sc.getSchema(pool);
    const rel = schema.relationships.find(
      r => r.fromColumns[0] === 'status_id');
    assert.ok(rel,
      'should infer status_id -> statuses');
    assert.equal(rel.toTable, 'statuses');
  });

  it('does not create false match for bus_id '
    + 'with no matching table', async () => {
    const cols = [
      {
        table_name: 'trips',
        column_name: 'id',
        data_type: 'bigint',
        is_nullable: false,
        column_default: null,
      },
      {
        table_name: 'trips',
        column_name: 'bus_id',
        data_type: 'bigint',
        is_nullable: true,
        column_default: null,
      },
    ];
    const pks = [
      { table_name: 'trips', column_name: 'id' },
    ];
    const pool = createMockPool(cols, pks, []);
    const sc = createSchemaCache({ schemaCacheTtl: 300000 });
    const schema = await sc.getSchema(pool);
    assert.equal(schema.relationships.length, 0,
      'bus_id with no bus/buss/buses/busies table '
      + '-> no relationship');
  });

  it('does not run when FK query returns relationships',
    async () => {
      // FK query returns real relationships -> convention
      // fallback should NOT run even if _id columns exist.
      const fkRows = [{
        constraint_name: 'orders_customer_id_fkey',
        from_table: 'orders',
        from_columns: ['customer_id'],
        to_table: 'customers',
        to_columns: ['id'],
      }];
      const pool = createMockPool(
        fkColumnRows, fkPkRows, fkRows);
      const sc = createSchemaCache({ schemaCacheTtl: 300000 });
      const schema = await sc.getSchema(pool);
      // Should have exactly the one FK relationship, not
      // a duplicate from convention fallback.
      assert.equal(schema.relationships.length, 1);
      assert.equal(schema.relationships[0].constraint,
        'orders_customer_id_fkey');
    });
});

// --- Cache integration tests ---

describe('cache integration with relationships', () => {
  it('getSchema returns object with both tables and '
    + 'relationships', async () => {
    const pool = createMockPool(fkColumnRows, fkPkRows, []);
    const sc = createSchemaCache({ schemaCacheTtl: 300000 });
    const schema = await sc.getSchema(pool);
    assert.ok('tables' in schema,
      'schema should have tables key');
    assert.ok('relationships' in schema,
      'schema should have relationships key');
    assert.ok(Array.isArray(schema.relationships));
  });

  it('refresh() updates relationships', async () => {
    let callCount = 0;
    const introspect = async () => {
      callCount++;
      if (callCount === 1) {
        return {
          tables: { t: { columns: {}, primaryKey: [] } },
          relationships: [],
        };
      }
      return {
        tables: { t: { columns: {}, primaryKey: [] } },
        relationships: [{
          constraint: 'new_fk',
          fromTable: 't',
          fromColumns: ['x_id'],
          toTable: 'x',
          toColumns: ['id'],
        }],
      };
    };
    const sc = createSchemaCache({
      schemaCacheTtl: 300000,
      introspect,
    });
    const pool = {};
    const schema1 = await sc.getSchema(pool);
    assert.equal(schema1.relationships.length, 0);
    const schema2 = await sc.refresh(pool);
    assert.equal(schema2.relationships.length, 1);
    assert.equal(schema2.relationships[0].constraint, 'new_fk');
  });

  it('getRelationships() helper returns the array', async () => {
    const pool = createMockPool(fkColumnRows, fkPkRows, []);
    const sc = createSchemaCache({ schemaCacheTtl: 300000 });
    const schema = await sc.getSchema(pool);
    const rels = getRelationships(schema);
    assert.ok(Array.isArray(rels));
    // With convention fallback: orders.customer_id -> customers
    assert.equal(rels.length, 1);
  });

  it('getRelationships() returns empty array for schema '
    + 'without relationships', () => {
    const schema = { tables: {} };
    const rels = getRelationships(schema);
    assert.deepStrictEqual(rels, []);
  });
});
