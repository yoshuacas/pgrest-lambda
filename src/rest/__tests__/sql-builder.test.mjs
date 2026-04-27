import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSelect,
  buildInsert,
  buildUpdate,
  buildDelete,
  buildCount,
} from '../sql-builder.mjs';

const schema = {
  tables: {
    todos: {
      columns: {
        id: { type: 'text', nullable: false, defaultValue: null },
        user_id: { type: 'text', nullable: false, defaultValue: null },
        title: { type: 'text', nullable: true, defaultValue: null },
        status: { type: 'text', nullable: true, defaultValue: null },
        created_at: { type: 'timestamptz', nullable: false, defaultValue: 'now()' },
      },
      primaryKey: ['id'],
    },
    categories: {
      columns: {
        id: { type: 'text', nullable: false, defaultValue: null },
        name: { type: 'text', nullable: false, defaultValue: null },
      },
      primaryKey: ['id'],
    },
    people: {
      columns: {
        id: { type: 'text', nullable: false, defaultValue: null },
        first_name: { type: 'text', nullable: true, defaultValue: null },
        last_name: { type: 'text', nullable: true, defaultValue: null },
        email: { type: 'text', nullable: true, defaultValue: null },
      },
      primaryKey: ['id'],
    },
  },
};

describe('sql-builder', () => {
  describe('buildSelect', () => {
    it('generates WHERE with "id" = $1 for filter id=eq.abc', () => {
      const parsed = {
        select: [{ type: 'column', name: '*' }],
        filters: [{ column: 'id', operator: 'eq', value: 'abc', negate: false }],
        order: [],
        limit: null,
        offset: 0,
        onConflict: null,
      };
      const { text, values } = buildSelect('todos', parsed, schema);
      assert.ok(text.includes('"id"'), 'SQL should reference "id" quoted');
      assert.ok(text.includes('$'), 'SQL should use parameterized values');
      assert.ok(values.includes('abc'), 'values should include abc');
    });

    it('selects specific columns for select=id,title', () => {
      const parsed = {
        select: [{ type: 'column', name: 'id' }, { type: 'column', name: 'title' }],
        filters: [],
        order: [],
        limit: null,
        offset: 0,
        onConflict: null,
      };
      const { text } = buildSelect('todos', parsed, schema);
      assert.ok(text.includes('"id"'), 'SQL should include "id"');
      assert.ok(text.includes('"title"'), 'SQL should include "title"');
      assert.ok(!text.includes('"status"'),
        'SQL should not include unselected columns');
    });

    it('includes ORDER BY for order=created_at.desc', () => {
      const parsed = {
        select: [{ type: 'column', name: '*' }],
        filters: [],
        order: [{ column: 'created_at', direction: 'desc', nulls: null }],
        limit: null,
        offset: 0,
        onConflict: null,
      };
      const { text } = buildSelect('todos', parsed, schema);
      assert.ok(text.includes('ORDER BY'),
        'SQL should include ORDER BY');
      assert.ok(text.includes('"created_at"'),
        'SQL should include quoted column name');
      assert.ok(text.toUpperCase().includes('DESC'),
        'SQL should include DESC');
    });

    it('includes LIMIT and OFFSET for limit=20&offset=10', () => {
      const parsed = {
        select: [{ type: 'column', name: '*' }],
        filters: [],
        order: [],
        limit: 20,
        offset: 10,
        onConflict: null,
      };
      const { text, values } = buildSelect('todos', parsed, schema);
      assert.ok(text.includes('LIMIT'),
        'SQL should include LIMIT');
      assert.ok(text.includes('OFFSET'),
        'SQL should include OFFSET');
    });

    it('throws PGRST204 for unknown column in filter', () => {
      const parsed = {
        select: [{ type: 'column', name: '*' }],
        filters: [{ column: 'nonexistent', operator: 'eq', value: 'x', negate: false }],
        order: [],
        limit: null,
        offset: 0,
        onConflict: null,
      };
      assert.throws(
        () => buildSelect('todos', parsed, schema),
        (err) => err.code === 'PGRST204',
        'should throw PGRST204 for unknown column'
      );
    });

    it('appends authzConditions to WHERE clause', () => {
      const parsed = {
        select: [{ type: 'column', name: '*' }],
        filters: [{ column: 'status', operator: 'eq', value: 'active', negate: false }],
        order: [],
        limit: null,
        offset: 0,
        onConflict: null,
      };
      const authz = {
        conditions: ['"user_id" = $2'],
        values: ['alice'],
      };
      const { text, values } = buildSelect('todos', parsed, schema, authz);
      assert.ok(text.includes('"status"'),
        'SQL should include filter column');
      assert.ok(text.includes('"user_id" = $2'),
        'SQL should include authz condition');
      assert.deepEqual(values, ['active', 'alice']);
    });

    it('works unchanged with no authzConditions', () => {
      const parsed = {
        select: [{ type: 'column', name: '*' }],
        filters: [{ column: 'status', operator: 'eq', value: 'active', negate: false }],
        order: [],
        limit: null,
        offset: 0,
        onConflict: null,
      };
      const { text, values } = buildSelect('todos', parsed, schema);
      assert.ok(text.includes('"status"'),
        'SQL should include filter column');
      assert.deepEqual(values, ['active'],
        'values should only contain filter values, no authz values');
    });
  });

  describe('buildInsert', () => {
    it('generates INSERT with RETURNING * for single object body', () => {
      const body = { title: 'Buy milk' };
      const parsed = {
        select: [{ type: 'column', name: '*' }],
        filters: [],
        order: [],
        limit: null,
        offset: 0,
        onConflict: null,
      };
      const { text, values } = buildInsert('todos', body, schema, parsed);
      assert.ok(text.includes('INSERT INTO'),
        'SQL should contain INSERT INTO');
      assert.ok(text.includes('"todos"'),
        'SQL should reference quoted table name');
      assert.ok(text.includes('"title"'),
        'SQL should include title column');
      assert.ok(text.includes('RETURNING'),
        'SQL should include RETURNING');
    });

    it('generates multiple VALUES tuples for array body', () => {
      const body = [{ title: 'a' }, { title: 'b' }];
      const parsed = {
        select: [{ type: 'column', name: '*' }],
        filters: [],
        order: [],
        limit: null,
        offset: 0,
        onConflict: null,
      };
      const { text, values } = buildInsert('todos', body, schema, parsed);
      // Should have at least 2 parameter groups
      const dollarMatches = text.match(/\$/g);
      assert.ok(dollarMatches && dollarMatches.length >= 2,
        'SQL should have multiple parameter placeholders for bulk insert');
    });

    it('throws PGRST204 for body with unknown column', () => {
      const body = { nonexistent: 'value' };
      const parsed = {
        select: [{ type: 'column', name: '*' }],
        filters: [],
        order: [],
        limit: null,
        offset: 0,
        onConflict: null,
      };
      assert.throws(
        () => buildInsert('todos', body, schema, parsed),
        (err) => err.code === 'PGRST204',
        'should throw PGRST204 for unknown column in body'
      );
    });
  });

  describe('buildInsert (upsert)', () => {
    it('generates ON CONFLICT ... DO UPDATE SET for upsert', () => {
      const body = { id: 'abc', title: 'Updated' };
      const parsed = {
        select: [{ type: 'column', name: '*' }],
        filters: [],
        order: [],
        limit: null,
        offset: 0,
        onConflict: 'id',
      };
      const { text } = buildInsert('todos', body, schema, parsed);
      assert.ok(text.includes('ON CONFLICT'),
        'SQL should contain ON CONFLICT');
      assert.ok(text.includes('"id"'),
        'SQL should reference conflict column');
      assert.ok(text.includes('DO UPDATE SET'),
        'SQL should contain DO UPDATE SET');
    });
  });

  describe('buildInsert (on_conflict validation)', () => {
    it('validates single on_conflict column against schema', () => {
      const body = { id: 'abc', title: 'Hello' };
      const parsed = {
        select: [{ type: 'column', name: '*' }],
        filters: [],
        order: [],
        limit: null,
        offset: 0,
        onConflict: 'id',
      };
      const { text } = buildInsert('todos', body, schema, parsed);
      assert.ok(text.includes('ON CONFLICT ("id")'),
        'should produce ON CONFLICT with validated column');
    });

    it('validates multiple on_conflict columns', () => {
      const body = { id: 'abc', user_id: 'u1', title: 'Hello' };
      const parsed = {
        select: [{ type: 'column', name: '*' }],
        filters: [],
        order: [],
        limit: null,
        offset: 0,
        onConflict: 'id,user_id',
      };
      const { text } = buildInsert('todos', body, schema, parsed);
      assert.ok(text.includes('ON CONFLICT ("id", "user_id")'),
        'should produce ON CONFLICT with both validated columns');
    });

    it('throws PGRST204 for unknown on_conflict column', () => {
      const body = { id: 'abc', title: 'Hello' };
      const parsed = {
        select: [{ type: 'column', name: '*' }],
        filters: [],
        order: [],
        limit: null,
        offset: 0,
        onConflict: 'does_not_exist',
      };
      assert.throws(
        () => buildInsert('todos', body, schema, parsed),
        (err) => err.code === 'PGRST204',
        'should throw PGRST204 for unknown on_conflict column',
      );
    });

    it('throws PGRST204 for SQL injection payload in on_conflict', () => {
      const body = { id: 'abc', title: 'Hello' };
      const parsed = {
        select: [{ type: 'column', name: '*' }],
        filters: [],
        order: [],
        limit: null,
        offset: 0,
        onConflict: 'id"; DROP TABLE x; --',
      };
      assert.throws(
        () => buildInsert('todos', body, schema, parsed),
        (err) => err.code === 'PGRST204',
        'should throw PGRST204 for injection payload',
      );
    });

    it('trims whitespace from on_conflict columns before validation', () => {
      const body = { id: 'abc', user_id: 'u1', title: 'Hello' };
      const parsed = {
        select: [{ type: 'column', name: '*' }],
        filters: [],
        order: [],
        limit: null,
        offset: 0,
        onConflict: ' id , user_id ',
      };
      const { text } = buildInsert('todos', body, schema, parsed);
      assert.ok(text.includes('ON CONFLICT ("id", "user_id")'),
        'should trim and validate columns with surrounding whitespace');
    });
  });

  describe('buildInsert (upsert edge cases)', () => {
    it('produces DO NOTHING when all columns are in on_conflict', () => {
      const body = { id: 'abc' };
      const parsed = {
        select: [{ type: 'column', name: '*' }],
        filters: [],
        order: [],
        limit: null,
        offset: 0,
        onConflict: 'id',
      };
      const { text } = buildInsert('todos', body, schema, parsed);
      assert.ok(text.includes('ON CONFLICT'),
        'SQL should contain ON CONFLICT');
      assert.ok(text.includes('DO NOTHING'),
        'SQL should fall back to DO NOTHING when SET would be empty');
      assert.ok(!text.includes('DO UPDATE SET'),
        'SQL should NOT contain DO UPDATE SET');
    });
  });

  describe('is filter guard', () => {
    it('throws PGRST100 for invalid IS value', () => {
      const parsed = {
        select: [{ type: 'column', name: '*' }],
        filters: [{ column: 'title', operator: 'is', value: 'invalid', negate: false }],
        order: [],
        limit: null,
        offset: 0,
        onConflict: null,
      };
      assert.throws(
        () => buildSelect('todos', parsed, schema),
        (err) => err.code === 'PGRST100',
        'should throw PGRST100 for invalid IS value',
      );
    });

    it('accepts valid IS values (null, true, false, unknown)', () => {
      for (const value of ['null', 'true', 'false', 'unknown']) {
        const parsed = {
          select: [{ type: 'column', name: '*' }],
          filters: [{ column: 'title', operator: 'is', value, negate: false }],
          order: [],
          limit: null,
          offset: 0,
          onConflict: null,
        };
        assert.doesNotThrow(
          () => buildSelect('todos', parsed, schema),
          `should not throw for IS ${value}`,
        );
      }
    });
  });

  describe('buildUpdate', () => {
    it('generates UPDATE ... SET ... WHERE for filters and body', () => {
      const body = { title: 'Updated title' };
      const parsed = {
        select: [{ type: 'column', name: '*' }],
        filters: [{ column: 'id', operator: 'eq', value: 'abc', negate: false }],
        order: [],
        limit: null,
        offset: 0,
        onConflict: null,
      };
      const { text } = buildUpdate('todos', body, parsed, schema);
      assert.ok(text.includes('UPDATE'),
        'SQL should contain UPDATE');
      assert.ok(text.includes('"todos"'),
        'SQL should reference quoted table name');
      assert.ok(text.includes('SET'),
        'SQL should contain SET');
      assert.ok(text.includes('WHERE'),
        'SQL should contain WHERE');
    });

    it('throws PGRST106 when no filters', () => {
      const body = { title: 'Updated title' };
      const parsed = {
        select: [{ type: 'column', name: '*' }],
        filters: [],
        order: [],
        limit: null,
        offset: 0,
        onConflict: null,
      };
      assert.throws(
        () => buildUpdate('todos', body, parsed, schema),
        (err) => err.code === 'PGRST106',
        'should throw PGRST106 for UPDATE without filters'
      );
    });

    it('appends authzConditions to WHERE clause', () => {
      const body = { title: 'Updated' };
      const parsed = {
        select: [{ type: 'column', name: '*' }],
        filters: [{ column: 'id', operator: 'eq', value: 'abc', negate: false }],
        order: [],
        limit: null,
        offset: 0,
        onConflict: null,
      };
      const authz = {
        conditions: ['"user_id" = $3'],
        values: ['alice'],
      };
      const { text, values } = buildUpdate(
        'todos', body, parsed, schema, authz,
      );
      assert.ok(text.includes('"user_id" = $3'),
        'SQL should include authz condition');
      assert.ok(values.includes('alice'),
        'values should include authz value');
    });
  });

  describe('buildDelete', () => {
    it('generates DELETE FROM ... WHERE for filters', () => {
      const parsed = {
        select: [{ type: 'column', name: '*' }],
        filters: [{ column: 'id', operator: 'eq', value: 'abc', negate: false }],
        order: [],
        limit: null,
        offset: 0,
        onConflict: null,
      };
      const { text } = buildDelete('todos', parsed, schema);
      assert.ok(text.includes('DELETE FROM'),
        'SQL should contain DELETE FROM');
      assert.ok(text.includes('"todos"'),
        'SQL should reference quoted table name');
      assert.ok(text.includes('WHERE'),
        'SQL should contain WHERE');
    });

    it('throws PGRST106 when no filters', () => {
      const parsed = {
        select: [{ type: 'column', name: '*' }],
        filters: [],
        order: [],
        limit: null,
        offset: 0,
        onConflict: null,
      };
      assert.throws(
        () => buildDelete('todos', parsed, schema),
        (err) => err.code === 'PGRST106',
        'should throw PGRST106 for DELETE without filters'
      );
    });

    it('appends authzConditions to WHERE clause', () => {
      const parsed = {
        select: [{ type: 'column', name: '*' }],
        filters: [{ column: 'id', operator: 'eq', value: 'abc', negate: false }],
        order: [],
        limit: null,
        offset: 0,
        onConflict: null,
      };
      const authz = {
        conditions: ['"user_id" = $2'],
        values: ['alice'],
      };
      const { text, values } = buildDelete(
        'todos', parsed, schema, authz,
      );
      assert.ok(text.includes('"user_id" = $2'),
        'SQL should include authz condition');
      assert.ok(values.includes('alice'),
        'values should include authz value');
    });
  });

  describe('buildCount', () => {
    it('generates SELECT COUNT(*) with matching WHERE', () => {
      const parsed = {
        select: [{ type: 'column', name: '*' }],
        filters: [{ column: 'status', operator: 'eq', value: 'active', negate: false }],
        order: [],
        limit: null,
        offset: 0,
        onConflict: null,
      };
      const { text, values } = buildCount('todos', parsed, schema);
      assert.ok(text.includes('COUNT(*)'),
        'SQL should contain COUNT(*)');
      assert.ok(text.includes('WHERE'),
        'SQL should contain WHERE');
      assert.ok(values.includes('active'),
        'values should include filter value');
    });

    it('appends authzConditions to WHERE clause', () => {
      const parsed = {
        select: [{ type: 'column', name: '*' }],
        filters: [{ column: 'status', operator: 'eq', value: 'active', negate: false }],
        order: [],
        limit: null,
        offset: 0,
        onConflict: null,
      };
      const authz = {
        conditions: ['"user_id" = $2'],
        values: ['alice'],
      };
      const { text, values } = buildCount(
        'todos', parsed, schema, authz,
      );
      assert.ok(text.includes('"user_id" = $2'),
        'SQL should include authz condition');
      assert.deepEqual(values, ['active', 'alice']);
    });
  });

  describe('resource embedding', () => {
    // Schema for embedding tests: orders -> customers (many-to-one),
    // customers -> orders (one-to-many), orders -> addresses (ambiguous)
    const embedSchema = {
      tables: {
        orders: {
          columns: {
            id: { type: 'bigint', nullable: false, defaultValue: null },
            customer_id: { type: 'bigint', nullable: true, defaultValue: null },
            billing_address_id: { type: 'bigint', nullable: true, defaultValue: null },
            shipping_address_id: { type: 'bigint', nullable: true, defaultValue: null },
            amount: { type: 'numeric', nullable: false, defaultValue: null },
          },
          primaryKey: ['id'],
        },
        customers: {
          columns: {
            id: { type: 'bigint', nullable: false, defaultValue: null },
            name: { type: 'text', nullable: false, defaultValue: null },
            email: { type: 'text', nullable: true, defaultValue: null },
          },
          primaryKey: ['id'],
        },
        addresses: {
          columns: {
            id: { type: 'bigint', nullable: false, defaultValue: null },
            street: { type: 'text', nullable: false, defaultValue: null },
            city: { type: 'text', nullable: false, defaultValue: null },
          },
          primaryKey: ['id'],
        },
        order_items: {
          columns: {
            id: { type: 'bigint', nullable: false, defaultValue: null },
            order_id: { type: 'bigint', nullable: true, defaultValue: null },
            product_id: { type: 'bigint', nullable: true, defaultValue: null },
            quantity: { type: 'integer', nullable: false, defaultValue: '1' },
          },
          primaryKey: ['id'],
        },
        products: {
          columns: {
            id: { type: 'bigint', nullable: false, defaultValue: null },
            name: { type: 'text', nullable: false, defaultValue: null },
            price: { type: 'numeric', nullable: false, defaultValue: null },
          },
          primaryKey: ['id'],
        },
      },
      relationships: [
        {
          constraint: 'orders_customer_id_fkey',
          fromTable: 'orders',
          fromColumns: ['customer_id'],
          toTable: 'customers',
          toColumns: ['id'],
        },
        {
          constraint: 'orders_billing_address_id_fkey',
          fromTable: 'orders',
          fromColumns: ['billing_address_id'],
          toTable: 'addresses',
          toColumns: ['id'],
        },
        {
          constraint: 'orders_shipping_address_id_fkey',
          fromTable: 'orders',
          fromColumns: ['shipping_address_id'],
          toTable: 'addresses',
          toColumns: ['id'],
        },
        {
          constraint: 'order_items_order_id_fkey',
          fromTable: 'order_items',
          fromColumns: ['order_id'],
          toTable: 'orders',
          toColumns: ['id'],
        },
        {
          constraint: 'order_items_product_id_fkey',
          fromTable: 'order_items',
          fromColumns: ['product_id'],
          toTable: 'products',
          toColumns: ['id'],
        },
      ],
    };

    function norm(s) {
      return s.replace(/\s+/g, ' ').trim();
    }

    function baseParsed(select) {
      return {
        select,
        filters: [],
        order: [],
        limit: null,
        offset: 0,
        onConflict: null,
      };
    }

    it('generates many-to-one correlated subquery', () => {
      const parsed = baseParsed([
        { type: 'column', name: 'id' },
        {
          type: 'embed', name: 'customers', alias: null,
          hint: null, inner: false,
          select: [{ type: 'column', name: 'name' }],
        },
      ]);
      const { text } = buildSelect('orders', parsed, embedSchema);
      const expected = norm(
        `SELECT "orders"."id", `
        + `(SELECT json_build_object('name', "customers"."name") `
        + `FROM "customers" WHERE "customers"."id" = "orders"."customer_id") `
        + `AS "customers" FROM "orders"`
      );
      assert.equal(norm(text), expected);
    });

    it('generates one-to-many correlated subquery', () => {
      const parsed = baseParsed([
        { type: 'column', name: 'id' },
        {
          type: 'embed', name: 'orders', alias: null,
          hint: null, inner: false,
          select: [
            { type: 'column', name: 'id' },
            { type: 'column', name: 'amount' },
          ],
        },
      ]);
      const { text } = buildSelect('customers', parsed, embedSchema);
      const expected = norm(
        `SELECT "customers"."id", `
        + `COALESCE((SELECT json_agg(json_build_object(`
        + `'id', "orders"."id", 'amount', "orders"."amount")) `
        + `FROM "orders" WHERE "orders"."customer_id" = "customers"."id"), `
        + `'[]'::json) AS "orders" FROM "customers"`
      );
      assert.equal(norm(text), expected);
    });

    it('uses alias as SQL AS name', () => {
      const parsed = baseParsed([
        { type: 'column', name: 'id' },
        {
          type: 'embed', name: 'customers', alias: 'buyer',
          hint: null, inner: false,
          select: [{ type: 'column', name: 'name' }],
        },
      ]);
      const { text } = buildSelect('orders', parsed, embedSchema);
      assert.ok(norm(text).includes('AS "buyer"'),
        'should use alias "buyer" not "customers"');
      assert.ok(!norm(text).includes('AS "customers"'),
        'should not use table name when aliased');
    });

    it('generates nested embed subqueries', () => {
      const parsed = baseParsed([
        { type: 'column', name: 'id' },
        {
          type: 'embed', name: 'order_items', alias: null,
          hint: null, inner: false,
          select: [
            { type: 'column', name: 'id' },
            {
              type: 'embed', name: 'products', alias: null,
              hint: null, inner: false,
              select: [{ type: 'column', name: 'name' }],
            },
          ],
        },
      ]);
      const { text } = buildSelect('orders', parsed, embedSchema);
      const n = norm(text);
      // Should have nested json_build_object
      assert.ok(n.includes('json_build_object('),
        'should contain json_build_object');
      assert.ok(n.includes('"products"."name"'),
        'should reference products.name');
      assert.ok(n.includes('AS "order_items"'),
        'should have AS "order_items"');
    });

    it('adds EXISTS to parent WHERE for one-to-many inner join', () => {
      const parsed = baseParsed([
        { type: 'column', name: 'id' },
        {
          type: 'embed', name: 'orders', alias: null,
          hint: null, inner: true,
          select: [{ type: 'column', name: 'id' }],
        },
      ]);
      const { text } = buildSelect('customers', parsed, embedSchema);
      const n = norm(text);
      assert.ok(
        n.includes('EXISTS (SELECT 1 FROM "orders" WHERE "orders"."customer_id" = "customers"."id")'),
        'should have EXISTS subquery in WHERE for one-to-many inner',
      );
    });

    it('adds IS NOT NULL to parent WHERE for many-to-one inner join', () => {
      const parsed = baseParsed([
        { type: 'column', name: 'id' },
        {
          type: 'embed', name: 'customers', alias: null,
          hint: null, inner: true,
          select: [{ type: 'column', name: 'name' }],
        },
      ]);
      const { text } = buildSelect('orders', parsed, embedSchema);
      const n = norm(text);
      assert.ok(
        n.includes('"orders"."customer_id" IS NOT NULL'),
        'should have IS NOT NULL in WHERE for many-to-one inner',
      );
    });

    it('resolves ambiguous FK with !hint', () => {
      const parsed = baseParsed([
        { type: 'column', name: 'id' },
        {
          type: 'embed', name: 'addresses',
          alias: 'billing', hint: 'billing_address_id',
          inner: false,
          select: [{ type: 'column', name: 'street' }],
        },
      ]);
      const { text } = buildSelect('orders', parsed, embedSchema);
      const n = norm(text);
      assert.ok(n.includes('"addresses"."id" = "orders"."billing_address_id"'),
        'should use billing_address_id FK');
      assert.ok(n.includes('AS "billing"'),
        'should use alias "billing"');
    });

    it('throws PGRST200 for unknown embed', () => {
      const parsed = baseParsed([
        { type: 'column', name: 'id' },
        {
          type: 'embed', name: 'nonexistent', alias: null,
          hint: null, inner: false,
          select: [{ type: 'column', name: 'name' }],
        },
      ]);
      assert.throws(
        () => buildSelect('orders', parsed, embedSchema),
        (err) => err.code === 'PGRST200'
          && err.message.includes('orders')
          && err.message.includes('nonexistent'),
        'should throw PGRST200 for unknown relationship',
      );
    });

    it('throws PGRST201 for ambiguous embed without hint', () => {
      const parsed = baseParsed([
        { type: 'column', name: 'id' },
        {
          type: 'embed', name: 'addresses', alias: null,
          hint: null, inner: false,
          select: [{ type: 'column', name: 'street' }],
        },
      ]);
      assert.throws(
        () => buildSelect('orders', parsed, embedSchema),
        (err) => {
          return err.code === 'PGRST201'
            && err.statusCode === 300
            && Array.isArray(err.details)
            && err.details.length === 2
            && typeof err.hint === 'string'
            && err.hint.includes('billing_address_id');
        },
        'should throw PGRST201 with details and hint',
      );
    });

    it('backward compatible: flat select generates same SQL', () => {
      const parsed = baseParsed([
        { type: 'column', name: 'id' },
        { type: 'column', name: 'amount' },
      ]);
      const { text } = buildSelect('orders', parsed, embedSchema);
      const n = norm(text);
      // Should use unqualified column names (no table prefix)
      assert.equal(n, norm('SELECT "id", "amount" FROM "orders"'));
    });

    it('filters work alongside embed subqueries', () => {
      const parsed = {
        select: [
          { type: 'column', name: 'id' },
          {
            type: 'embed', name: 'customers', alias: null,
            hint: null, inner: false,
            select: [{ type: 'column', name: 'name' }],
          },
        ],
        filters: [{ column: 'amount', operator: 'gt', value: 50, negate: false }],
        order: [],
        limit: null,
        offset: 0,
        onConflict: null,
      };
      const { text, values } = buildSelect('orders', parsed, embedSchema);
      const n = norm(text);
      assert.ok(n.includes('WHERE'), 'should have WHERE clause');
      assert.ok(n.includes('"amount"'), 'should reference filter column');
      assert.ok(n.includes('json_build_object'), 'should have embed subquery');
      assert.ok(values.includes(50), 'values should include filter value');
    });

    it('handles wildcard expansion in parent and child', () => {
      const parsed = baseParsed([
        { type: 'column', name: '*' },
        {
          type: 'embed', name: 'customers', alias: null,
          hint: null, inner: false,
          select: [{ type: 'column', name: '*' }],
        },
      ]);
      const { text } = buildSelect('orders', parsed, embedSchema);
      const n = norm(text);
      // Parent columns should be table-qualified
      assert.ok(n.includes('"orders"."id"'), 'parent id qualified');
      assert.ok(n.includes('"orders"."amount"'), 'parent amount qualified');
      // Child columns in json_build_object
      assert.ok(n.includes("'id', \"customers\".\"id\""),
        'child id in json_build_object');
      assert.ok(n.includes("'name', \"customers\".\"name\""),
        'child name in json_build_object');
      assert.ok(n.includes("'email', \"customers\".\"email\""),
        'child email in json_build_object');
    });

    it('handles authzConditions with parent key (new shape)', () => {
      const parsed = baseParsed([
        { type: 'column', name: 'id' },
        {
          type: 'embed', name: 'customers', alias: null,
          hint: null, inner: false,
          select: [{ type: 'column', name: 'name' }],
        },
      ]);
      const authz = {
        parent: { conditions: ['"amount" > $1'], values: [100] },
        embeds: {},
      };
      const { text, values } = buildSelect(
        'orders', parsed, embedSchema, authz);
      const n = norm(text);
      assert.ok(n.includes('"amount" > $1'),
        'parent authz condition applied');
      assert.ok(values.includes(100),
        'parent authz value included');
    });

    it('handles authzConditions without parent key (old shape)', () => {
      const parsed = baseParsed([
        { type: 'column', name: 'id' },
        { type: 'column', name: 'amount' },
      ]);
      const authz = {
        conditions: ['"user_id" = $1'],
        values: ['alice'],
      };
      const { text, values } = buildSelect(
        'orders', parsed, embedSchema, authz);
      assert.ok(text.includes('"user_id" = $1'),
        'old-shape authz still works');
      assert.deepEqual(values, ['alice']);
    });

    describe('authz parameter renumbering', () => {
      it('all $N references match values positions', () => {
        const parsed = {
          select: [
            { type: 'column', name: 'id' },
            {
              type: 'embed', name: 'customers', alias: null,
              hint: null, inner: false,
              select: [{ type: 'column', name: 'name' }],
            },
          ],
          filters: [{
            column: 'amount', operator: 'gt',
            value: '50', negate: false,
          }],
          order: [],
          limit: null,
          offset: 0,
          onConflict: null,
        };
        const authzConditions = {
          parent: {
            conditions: ['"user_id" = $1'],
            values: ['alice'],
          },
          embeds: {
            customers: {
              conditions: ['"active" = $1'],
              values: [true],
            },
          },
        };
        const { text, values } = buildSelect(
          'orders', parsed, embedSchema, authzConditions);

        // Extract all $N references from the SQL
        const paramRefs = [...text.matchAll(/\$(\d+)/g)]
          .map(m => parseInt(m[1], 10));

        // Every $N should have a corresponding value
        for (const n of paramRefs) {
          assert.ok(n >= 1 && n <= values.length,
            `$${n} should be within values range 1..${values.length}`);
        }

        // Verify specific mappings: find which $N is
        // associated with each condition
        const amountMatch = text.match(/"amount" > \$(\d+)/);
        assert.ok(amountMatch, 'should have amount filter');
        assert.equal(values[parseInt(amountMatch[1], 10) - 1],
          '50', 'amount filter $N should point to 50');

        const activeMatch = text.match(/"active" = \$(\d+)/);
        assert.ok(activeMatch, 'should have child authz condition');
        assert.equal(values[parseInt(activeMatch[1], 10) - 1],
          true, 'child authz $N should point to true');

        const userIdMatch = text.match(/"user_id" = \$(\d+)/);
        assert.ok(userIdMatch, 'should have parent authz condition');
        assert.equal(values[parseInt(userIdMatch[1], 10) - 1],
          'alice', 'parent authz $N should point to alice');
      });

      it('child authz appears inside subquery WHERE', () => {
        const parsed = baseParsed([
          { type: 'column', name: 'id' },
          {
            type: 'embed', name: 'customers', alias: null,
            hint: null, inner: false,
            select: [{ type: 'column', name: 'name' }],
          },
        ]);
        const authzConditions = {
          parent: { conditions: [], values: [] },
          embeds: {
            customers: {
              conditions: ['"active" = $1'],
              values: [true],
            },
          },
        };
        const { text } = buildSelect(
          'orders', parsed, embedSchema, authzConditions);
        const n = norm(text);

        // Child authz should be inside the subquery
        // (between FROM "customers" WHERE and the closing
        // paren of the subquery)
        const subqueryMatch = n.match(
          /FROM "customers" WHERE (.+?)\) AS "customers"/);
        assert.ok(subqueryMatch,
          'should have customers subquery');
        assert.ok(subqueryMatch[1].includes('"active"'),
          'child authz should be inside the subquery WHERE');

        // Should NOT appear in the outer WHERE
        const outerWhere = n.match(
          /FROM "orders"(?: WHERE (.+))?$/);
        if (outerWhere && outerWhere[1]) {
          assert.ok(!outerWhere[1].includes('"active"'),
            'child authz should not be in the outer WHERE');
        }
      });

      it('renumbers authz from startParam:1 correctly', () => {
        // Simulates the single-pass approach: Cedar returns
        // conditions with $1-based numbering, and
        // buildSelect renumbers them to the correct position.
        // Build order: child authz (during subquery), then
        // filters, then parent authz.
        const parsed = {
          select: [
            { type: 'column', name: 'id' },
            {
              type: 'embed', name: 'customers', alias: null,
              hint: null, inner: false,
              select: [{ type: 'column', name: 'name' }],
            },
          ],
          filters: [{
            column: 'amount', operator: 'gt',
            value: '50', negate: false,
          }],
          order: [],
          limit: null,
          offset: 0,
          onConflict: null,
        };
        const authzConditions = {
          parent: {
            conditions: ['"user_id" = $1'],
            values: ['alice'],
          },
          embeds: {
            customers: {
              conditions: ['"active" = $1'],
              values: [true],
            },
          },
        };
        const { text, values } = buildSelect(
          'orders', parsed, embedSchema, authzConditions);

        // Child authz is built first (during subquery
        // generation), so it gets $1
        const activeMatch = text.match(/"active" = \$(\d+)/);
        assert.ok(activeMatch, 'should have child authz');
        const activeIdx = parseInt(activeMatch[1], 10);
        assert.equal(activeIdx, 1,
          'child authz should be $1 (first value pushed)');
        assert.equal(values[activeIdx - 1], true,
          'child authz value should match its $N position');

        // Filter is built next
        const amountMatch = text.match(/"amount" > \$(\d+)/);
        assert.ok(amountMatch, 'should have filter');
        const amountIdx = parseInt(amountMatch[1], 10);
        assert.equal(amountIdx, 2,
          'filter should be $2 (second value pushed)');
        assert.equal(values[amountIdx - 1], '50',
          'filter value should match its $N position');

        // Parent authz is built last
        const userMatch = text.match(/"user_id" = \$(\d+)/);
        assert.ok(userMatch, 'should have parent authz');
        const userIdx = parseInt(userMatch[1], 10);
        assert.equal(userIdx, 3,
          'parent authz should be $3 (third value pushed)');
        assert.equal(values[userIdx - 1], 'alice',
          'parent authz value should match its $N position');
      });

      it('buildCount includes parent authz conditions', () => {
        const parsed = baseParsed([
          { type: 'column', name: 'id' },
          { type: 'column', name: 'amount' },
        ]);
        parsed.filters = [{
          column: 'amount', operator: 'gt',
          value: '50', negate: false,
        }];
        const authz = {
          conditions: ['"user_id" = $1'],
          values: ['alice'],
        };
        const { text, values } = buildCount(
          'orders', parsed, embedSchema, authz);
        assert.ok(text.includes('COUNT(*)'),
          'should be a count query');
        assert.ok(text.includes('"user_id"'),
          'should include parent authz condition');
        assert.ok(values.includes('alice'),
          'values should include authz value');

        // Verify parameter numbering is correct
        const userMatch = text.match(/"user_id" = \$(\d+)/);
        assert.ok(userMatch, 'should have parameterized authz');
        assert.equal(values[parseInt(userMatch[1], 10) - 1],
          'alice', 'authz $N should point to alice');
      });
    });
  });

  describe('column alias SQL generation', () => {
    function norm(s) {
      return s.replace(/\s+/g, ' ').trim();
    }

    function baseParsed(select) {
      return {
        select,
        filters: [],
        order: [],
        limit: null,
        offset: 0,
        onConflict: null,
      };
    }

    it('generates AS clauses for aliased columns (flat)', () => {
      const parsed = baseParsed([
        { type: 'column', name: 'first_name', alias: 'firstName' },
        { type: 'column', name: 'last_name', alias: 'lastName' },
      ]);
      const { text } = buildSelect('people', parsed, schema);
      assert.ok(
        norm(text).includes(
          '"first_name" AS "firstName", "last_name" AS "lastName"'),
        'should generate AS clauses for aliased columns',
      );
    });

    it('generates AS only for aliased columns (mixed)', () => {
      const parsed = baseParsed([
        { type: 'column', name: 'id' },
        { type: 'column', name: 'first_name', alias: 'firstName' },
      ]);
      const { text } = buildSelect('people', parsed, schema);
      const expected = norm(
        'SELECT "id", "first_name" AS "firstName" FROM "people"');
      assert.equal(norm(text), expected);
    });

    it('no aliases produces unchanged SQL (regression)', () => {
      const parsed = baseParsed([
        { type: 'column', name: 'id' },
        { type: 'column', name: 'title' },
      ]);
      const { text } = buildSelect('todos', parsed, schema);
      assert.equal(norm(text),
        norm('SELECT "id", "title" FROM "todos"'));
    });

    it('generates AS in embed path for aliased column', () => {
      const embedSchema = {
        tables: {
          orders: {
            columns: {
              id: { type: 'bigint', nullable: false, defaultValue: null },
              customer_id: { type: 'bigint', nullable: true, defaultValue: null },
              amount: { type: 'numeric', nullable: false, defaultValue: null },
            },
            primaryKey: ['id'],
          },
          customers: {
            columns: {
              id: { type: 'bigint', nullable: false, defaultValue: null },
              name: { type: 'text', nullable: false, defaultValue: null },
              email: { type: 'text', nullable: true, defaultValue: null },
            },
            primaryKey: ['id'],
          },
        },
        relationships: [
          {
            constraint: 'orders_customer_id_fkey',
            fromTable: 'orders',
            fromColumns: ['customer_id'],
            toTable: 'customers',
            toColumns: ['id'],
          },
        ],
      };

      const parsed = baseParsed([
        { type: 'column', name: 'id' },
        { type: 'column', name: 'amount', alias: 'total' },
        {
          type: 'embed', name: 'customers', alias: null,
          hint: null, inner: false,
          select: [{ type: 'column', name: 'name' }],
        },
      ]);
      const { text } = buildSelect(
        'orders', parsed, embedSchema);
      const n = norm(text);
      assert.ok(n.includes('"orders"."amount" AS "total"'),
        'aliased column in embed path should have AS clause');
    });

    it('uses alias as JSON key in json_build_object', () => {
      const embedSchema = {
        tables: {
          orders: {
            columns: {
              id: { type: 'bigint', nullable: false, defaultValue: null },
              customer_id: { type: 'bigint', nullable: true, defaultValue: null },
              amount: { type: 'numeric', nullable: false, defaultValue: null },
            },
            primaryKey: ['id'],
          },
          customers: {
            columns: {
              id: { type: 'bigint', nullable: false, defaultValue: null },
              name: { type: 'text', nullable: false, defaultValue: null },
              email: { type: 'text', nullable: true, defaultValue: null },
            },
            primaryKey: ['id'],
          },
        },
        relationships: [
          {
            constraint: 'orders_customer_id_fkey',
            fromTable: 'orders',
            fromColumns: ['customer_id'],
            toTable: 'customers',
            toColumns: ['id'],
          },
        ],
      };

      const parsed = baseParsed([
        { type: 'column', name: 'id' },
        {
          type: 'embed', name: 'customers', alias: null,
          hint: null, inner: false,
          select: [
            { type: 'column', name: 'name', alias: 'displayName' },
          ],
        },
      ]);
      const { text } = buildSelect(
        'orders', parsed, embedSchema);
      const n = norm(text);
      assert.ok(
        n.includes("'displayName', \"customers\".\"name\""),
        'json_build_object should use alias as JSON key',
      );
    });

    it('wildcard expansion has no AS clauses', () => {
      const parsed = baseParsed([
        { type: 'column', name: '*' },
      ]);
      const { text } = buildSelect('todos', parsed, schema);
      const n = norm(text);
      assert.ok(!n.includes(' AS '),
        'wildcard expansion should not have AS clauses');
    });
  });

  describe('column cast SQL generation', () => {
    function norm(s) {
      return s.replace(/\s+/g, ' ').trim();
    }

    function baseParsed(select) {
      return {
        select,
        filters: [],
        order: [],
        limit: null,
        offset: 0,
        onConflict: null,
      };
    }

    it('emits CAST for flat select with cast', () => {
      const parsed = baseParsed([
        { type: 'column', name: 'status', cast: 'text' },
      ]);
      const { text } = buildSelect('todos', parsed, schema);
      assert.ok(norm(text).includes('CAST("status" AS text)'),
        `expected CAST("status" AS text), got: ${text}`);
    });

    it('emits CAST with AS for cast + alias', () => {
      const parsed = baseParsed([
        { type: 'column', name: 'status', alias: 's',
          cast: 'text' },
      ]);
      const { text } = buildSelect('todos', parsed, schema);
      assert.ok(
        norm(text).includes('CAST("status" AS text) AS "s"'),
        `expected CAST with alias, got: ${text}`);
    });

    it('handles mixed cast, alias, and plain columns', () => {
      const parsed = baseParsed([
        { type: 'column', name: 'id' },
        { type: 'column', name: 'status', cast: 'text' },
        { type: 'column', name: 'title', alias: 't' },
      ]);
      const { text } = buildSelect('todos', parsed, schema);
      const n = norm(text);
      assert.equal(n, norm(
        'SELECT "id", CAST("status" AS text),'
        + ' "title" AS "t" FROM "todos"'));
    });

    it('no casts produces unchanged SQL (regression)', () => {
      const parsed = baseParsed([
        { type: 'column', name: 'id' },
        { type: 'column', name: 'title' },
      ]);
      const { text } = buildSelect('todos', parsed, schema);
      assert.equal(norm(text),
        norm('SELECT "id", "title" FROM "todos"'));
    });

    it('emits CAST in embed path for column alongside embed', () => {
      const embedSchema = {
        tables: {
          orders: {
            columns: {
              id: { type: 'bigint', nullable: false,
                defaultValue: null },
              customer_id: { type: 'bigint', nullable: true,
                defaultValue: null },
              amount: { type: 'numeric', nullable: false,
                defaultValue: null },
            },
            primaryKey: ['id'],
          },
          customers: {
            columns: {
              id: { type: 'bigint', nullable: false,
                defaultValue: null },
              name: { type: 'text', nullable: false,
                defaultValue: null },
            },
            primaryKey: ['id'],
          },
        },
        relationships: [
          {
            constraint: 'orders_customer_id_fkey',
            fromTable: 'orders',
            fromColumns: ['customer_id'],
            toTable: 'customers',
            toColumns: ['id'],
          },
        ],
      };

      const parsed = baseParsed([
        { type: 'column', name: 'id' },
        { type: 'column', name: 'amount', cast: 'text' },
        {
          type: 'embed', name: 'customers', alias: null,
          hint: null, inner: false,
          select: [{ type: 'column', name: 'name' }],
        },
      ]);
      const { text } = buildSelect(
        'orders', parsed, embedSchema);
      const n = norm(text);
      assert.ok(
        n.includes(
          'CAST("orders"."amount" AS text) AS "amount"'),
        `expected table-qualified CAST with AS, got: ${text}`);
    });

    it('emits CAST inside embed json_build_object', () => {
      const embedSchema = {
        tables: {
          orders: {
            columns: {
              id: { type: 'bigint', nullable: false,
                defaultValue: null },
              customer_id: { type: 'bigint', nullable: true,
                defaultValue: null },
            },
            primaryKey: ['id'],
          },
          customers: {
            columns: {
              id: { type: 'bigint', nullable: false,
                defaultValue: null },
              name: { type: 'text', nullable: false,
                defaultValue: null },
            },
            primaryKey: ['id'],
          },
        },
        relationships: [
          {
            constraint: 'orders_customer_id_fkey',
            fromTable: 'orders',
            fromColumns: ['customer_id'],
            toTable: 'customers',
            toColumns: ['id'],
          },
        ],
      };

      const parsed = baseParsed([
        { type: 'column', name: 'id' },
        {
          type: 'embed', name: 'customers', alias: null,
          hint: null, inner: false,
          select: [
            { type: 'column', name: 'name', cast: 'text' },
          ],
        },
      ]);
      const { text } = buildSelect(
        'orders', parsed, embedSchema);
      const n = norm(text);
      assert.ok(
        n.includes(
          "'name', CAST(\"customers\".\"name\" AS text)"),
        `expected cast in json_build_object, got: ${text}`);
    });

    it('emits CAST + alias inside embed json_build_object', () => {
      const embedSchema = {
        tables: {
          orders: {
            columns: {
              id: { type: 'bigint', nullable: false,
                defaultValue: null },
              customer_id: { type: 'bigint', nullable: true,
                defaultValue: null },
            },
            primaryKey: ['id'],
          },
          customers: {
            columns: {
              id: { type: 'bigint', nullable: false,
                defaultValue: null },
              name: { type: 'text', nullable: false,
                defaultValue: null },
            },
            primaryKey: ['id'],
          },
        },
        relationships: [
          {
            constraint: 'orders_customer_id_fkey',
            fromTable: 'orders',
            fromColumns: ['customer_id'],
            toTable: 'customers',
            toColumns: ['id'],
          },
        ],
      };

      const parsed = baseParsed([
        { type: 'column', name: 'id' },
        {
          type: 'embed', name: 'customers', alias: null,
          hint: null, inner: false,
          select: [
            { type: 'column', name: 'name',
              alias: 'displayName', cast: 'text' },
          ],
        },
      ]);
      const { text } = buildSelect(
        'orders', parsed, embedSchema);
      const n = norm(text);
      assert.ok(
        n.includes(
          "'displayName', CAST(\"customers\".\"name\" AS text)"),
        `expected aliased cast in json_build_object, got: ${text}`);
    });

    it('wildcard ignores casts (regression)', () => {
      const parsed = baseParsed([
        { type: 'column', name: '*' },
      ]);
      const { text } = buildSelect('todos', parsed, schema);
      const n = norm(text);
      assert.ok(!n.includes('CAST'),
        'wildcard expansion should not have CAST');
    });
  });

  describe('general', () => {
    it('double-quotes all table and column names in output SQL', () => {
      const parsed = {
        select: [{ type: 'column', name: 'id' }, { type: 'column', name: 'title' }],
        filters: [{ column: 'status', operator: 'eq', value: 'active', negate: false }],
        order: [{ column: 'created_at', direction: 'desc', nulls: null }],
        limit: null,
        offset: 0,
        onConflict: null,
      };
      const { text } = buildSelect('todos', parsed, schema);
      assert.ok(text.includes('"todos"'),
        'table name should be double-quoted');
      assert.ok(text.includes('"id"'),
        'column id should be double-quoted');
      assert.ok(text.includes('"title"'),
        'column title should be double-quoted');
      assert.ok(text.includes('"status"'),
        'column status should be double-quoted');
      assert.ok(text.includes('"created_at"'),
        'column created_at should be double-quoted');
    });
  });
});
