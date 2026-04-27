// embed-filtering.test.mjs — Integration tests for embedded resource filtering
//
// Skipped unless TEST_DATABASE_URL is set:
//   TEST_DATABASE_URL=postgresql://postgres:pass@localhost:5433/postgres \
//     node --test test/integration/embed-filtering.test.mjs

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { createPgrest } from '../../src/index.mjs';
import { JWT_SECRET, makeEvent } from './helpers.mjs';
import {
  EMBEDDING_SCHEMA_SQL,
  EMBEDDING_SEED_SQL,
  EMBEDDING_DROP_SQL,
} from './embedding.test.mjs';

const DATABASE_URL = process.env.TEST_DATABASE_URL;

const ADD_STATUS_SQL = `
  ALTER TABLE customers ADD COLUMN IF NOT EXISTS
    status TEXT DEFAULT 'active';
  UPDATE customers SET status = 'active'
    WHERE name IN ('Alice', 'Charlie');
  UPDATE customers SET status = 'inactive'
    WHERE name = 'Bob';
`;

describe('embedded resource filtering', { skip: !DATABASE_URL }, () => {
  let pool;
  let pgrest;

  before(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    await pool.query(EMBEDDING_SCHEMA_SQL);
    await pool.query(EMBEDDING_SEED_SQL);
    await pool.query(ADD_STATUS_SQL);
    pgrest = createPgrest({
      database: { connectionString: DATABASE_URL },
      jwtSecret: JWT_SECRET,
      auth: false,
    });
  });

  beforeEach(async () => {
    await pool.query(EMBEDDING_SEED_SQL);
    await pool.query(ADD_STATUS_SQL);
    await pgrest.rest(makeEvent({
      method: 'POST', path: '/rest/v1/_refresh',
    }));
  });

  after(async () => {
    await pool.query(EMBEDDING_DROP_SQL);
    await pool.end();
  });

  describe('Parser: Embed Filter Routing', () => {
    it('1: basic embed filter — many-to-one', async () => {
      const res = await pgrest.rest(makeEvent({
        path: '/rest/v1/orders',
        query: {
          select: '*,customers(*)',
          'customers.name': 'eq.Alice',
        },
      }));
      assert.equal(res.statusCode, 200,
        'should return 200 for embed filter query');
      const rows = JSON.parse(res.body);
      assert.ok(rows.length > 0,
        'should return at least one order');
      for (const row of rows) {
        assert.ok(
          row.customers === null
          || row.customers.name === 'Alice',
          `every order should have customers.name === 'Alice' `
          + `or customers === null, got: `
          + JSON.stringify(row.customers),
        );
      }
    });

    it('2: basic embed filter — one-to-many', async () => {
      const res = await pgrest.rest(makeEvent({
        path: '/rest/v1/customers',
        query: {
          select: 'id,orders(id,amount)',
          'orders.amount': 'gt.50',
        },
      }));
      assert.equal(res.statusCode, 200,
        'should return 200 for one-to-many embed filter');
      const rows = JSON.parse(res.body);
      assert.ok(rows.length > 0,
        'should return customers');
      for (const row of rows) {
        assert.ok(Array.isArray(row.orders),
          'orders should be an array');
        for (const order of row.orders) {
          assert.ok(Number(order.amount) > 50,
            `every embedded order should have amount > 50, `
            + `got ${order.amount}`);
        }
      }
      const charlie = rows.find(r => Number(r.id) === 3);
      if (charlie) {
        assert.deepStrictEqual(charlie.orders, [],
          'Charlie has no orders with amount > 50, '
          + 'should get empty array');
      }
    });

    it('3: multiple filters on same embed (AND)', async () => {
      const res = await pgrest.rest(makeEvent({
        path: '/rest/v1/orders',
        query: {
          select: '*,customers(*)',
          'customers.name': 'eq.Alice',
          'customers.status': 'eq.active',
        },
      }));
      assert.equal(res.statusCode, 200,
        'should return 200 for multiple embed filters');
      const rows = JSON.parse(res.body);
      for (const row of rows) {
        if (row.customers !== null) {
          assert.equal(row.customers.name, 'Alice',
            'non-null embed should have name Alice');
          assert.equal(row.customers.status, 'active',
            'non-null embed should have status active');
        }
      }
    });

    it('4: alias + filter', async () => {
      const res = await pgrest.rest(makeEvent({
        path: '/rest/v1/orders',
        query: {
          select: '*,buyer:customers(*)',
          'buyer.name': 'eq.Alice',
        },
      }));
      assert.equal(res.statusCode, 200,
        'should return 200 for aliased embed filter');
      const rows = JSON.parse(res.body);
      assert.ok(rows.length > 0,
        'should return orders');
      for (const row of rows) {
        assert.ok('buyer' in row,
          'response should use alias "buyer" as key');
        assert.ok(!('customers' in row),
          'response should not have "customers" key');
        assert.ok(
          row.buyer === null || row.buyer.name === 'Alice',
          `aliased embed should be null or have name Alice, `
          + `got: ${JSON.stringify(row.buyer)}`,
        );
      }
    });

    it('5: FK disambiguation + filter', async () => {
      const res = await pgrest.rest(makeEvent({
        path: '/rest/v1/orders',
        query: {
          select: '*,billing:addresses!billing_address_id(*)',
          'billing.city': 'eq.New York',
        },
      }));
      assert.equal(res.statusCode, 200,
        'should return 200 for FK-disambiguated embed filter');
      const rows = JSON.parse(res.body);
      assert.ok(rows.length > 0,
        'should return orders');
      for (const row of rows) {
        if (row.billing !== null) {
          assert.equal(row.billing.city, 'New York',
            'non-null billing embed should have city '
            + '"New York"');
        }
      }
    });

    it('6: embed filter + parent filter', async () => {
      const res = await pgrest.rest(makeEvent({
        path: '/rest/v1/orders',
        query: {
          select: 'id,amount,customers(name)',
          amount: 'gt.50',
          'customers.name': 'eq.Alice',
        },
      }));
      assert.equal(res.statusCode, 200,
        'should return 200 for combined embed + parent filter');
      const rows = JSON.parse(res.body);
      assert.ok(rows.length > 0,
        'should return at least one order');
      for (const row of rows) {
        assert.ok(Number(row.amount) > 50,
          `parent filter: amount should be > 50, `
          + `got ${row.amount}`);
        assert.ok(
          row.customers === null
          || row.customers.name === 'Alice',
          `embed filter: customers should be null or Alice, `
          + `got: ${JSON.stringify(row.customers)}`,
        );
      }
    });

    it('7: embed OR filter', async () => {
      const res = await pgrest.rest(makeEvent({
        path: '/rest/v1/orders',
        query: {
          select: '*,customers(name,status)',
          'customers.or': '(name.eq.Alice,status.eq.active)',
        },
      }));
      assert.equal(res.statusCode, 200,
        'should return 200 for embed OR filter');
      const rows = JSON.parse(res.body);
      for (const row of rows) {
        if (row.customers !== null) {
          assert.ok(
            row.customers.name === 'Alice'
            || row.customers.status === 'active',
            'non-null embed should match at least one OR '
            + `condition, got: ${JSON.stringify(row.customers)}`,
          );
        }
      }
    });

    it('8: embed NOT.OR filter', async () => {
      const res = await pgrest.rest(makeEvent({
        path: '/rest/v1/orders',
        query: {
          select: '*,customers(name,status)',
          'customers.not.or':
            '(status.eq.inactive,name.eq.Charlie)',
        },
      }));
      assert.equal(res.statusCode, 200,
        'should return 200 for embed NOT.OR filter');
      const rows = JSON.parse(res.body);
      for (const row of rows) {
        if (row.customers !== null) {
          assert.ok(
            row.customers.status !== 'inactive'
            && row.customers.name !== 'Charlie',
            'non-null embed should satisfy neither condition '
            + `in NOT(OR(...)), got: `
            + JSON.stringify(row.customers),
          );
        }
      }
    });
  });

  describe('!inner + Filter', () => {
    it('9: !inner + filter (many-to-one)', async () => {
      const res = await pgrest.rest(makeEvent({
        path: '/rest/v1/orders',
        query: {
          select: '*,customers!inner(*)',
          'customers.name': 'eq.Alice',
        },
      }));
      assert.equal(res.statusCode, 200,
        'should return 200 for !inner + embed filter');
      const rows = JSON.parse(res.body);
      assert.ok(rows.length > 0,
        'should return at least one order');
      for (const row of rows) {
        assert.ok(row.customers !== null,
          '!inner should exclude rows with null embed');
        assert.equal(row.customers.name, 'Alice',
          '!inner + filter should only return orders '
          + 'whose customer is Alice');
      }
      const ids = rows.map(r => Number(r.id));
      assert.ok(!ids.includes(3),
        "Bob's order (id=3) should be excluded");
      assert.ok(!ids.includes(4),
        'order with NULL customer_id (id=4) should be '
        + 'excluded');
    });

    it('10: !inner + filter (one-to-many)', async () => {
      const res = await pgrest.rest(makeEvent({
        path: '/rest/v1/customers',
        query: {
          select: 'id,orders!inner(id,amount)',
          'orders.amount': 'gt.50',
        },
      }));
      assert.equal(res.statusCode, 200,
        'should return 200 for !inner one-to-many '
        + '+ embed filter');
      const rows = JSON.parse(res.body);
      assert.ok(rows.length > 0,
        'should return at least one customer');
      for (const row of rows) {
        assert.ok(Array.isArray(row.orders),
          'orders should be an array');
        assert.ok(row.orders.length > 0,
          '!inner should exclude customers with no '
          + 'qualifying orders');
        for (const order of row.orders) {
          assert.ok(Number(order.amount) > 50,
            `every embedded order should have amount > 50, `
            + `got ${order.amount}`);
        }
      }
      const ids = rows.map(r => Number(r.id));
      assert.ok(!ids.includes(3),
        'Charlie (no orders at all) should be excluded');
    });

    it('11: !inner without filter — unchanged behavior',
      async () => {
        const res = await pgrest.rest(makeEvent({
          path: '/rest/v1/orders',
          query: {
            select: '*,customers!inner(name)',
          },
        }));
        assert.equal(res.statusCode, 200,
          'should return 200 for !inner without embed filter');
        const rows = JSON.parse(res.body);
        const ids = rows.map(r => Number(r.id));
        assert.ok(!ids.includes(4),
          'order with NULL customer_id (id=4) should be '
          + 'excluded by !inner');
        for (const row of rows) {
          assert.ok(row.customers !== null,
            'all returned orders should have non-null '
            + 'customers embed');
        }
      },
    );
  });

  describe('Embed Order/Limit (Parser Storage Only)', () => {
    it('12: embed order param is recognized (no error)',
      async () => {
        const res = await pgrest.rest(makeEvent({
          path: '/rest/v1/customers',
          query: {
            select: '*,orders(*)',
            'orders.order': 'amount.desc',
          },
        }));
        assert.ok(
          res.statusCode === 200 || res.statusCode < 400,
          'embed order param should not cause an error, '
          + `got status ${res.statusCode}: `
          + res.body,
        );
      },
    );

    it('13: embed limit param is recognized (no error)',
      async () => {
        const res = await pgrest.rest(makeEvent({
          path: '/rest/v1/customers',
          query: {
            select: '*,orders(*)',
            'orders.limit': '5',
          },
        }));
        assert.ok(
          res.statusCode === 200 || res.statusCode < 400,
          'embed limit param should not cause an error, '
          + `got status ${res.statusCode}: `
          + res.body,
        );
      },
    );

    it('14: embed offset param is recognized (no error)',
      async () => {
        const res = await pgrest.rest(makeEvent({
          path: '/rest/v1/customers',
          query: {
            select: '*,orders(*)',
            'orders.offset': '10',
          },
        }));
        assert.ok(
          res.statusCode === 200 || res.statusCode < 400,
          'embed offset param should not cause an error, '
          + `got status ${res.statusCode}: `
          + res.body,
        );
      },
    );
  });

  describe('Validation Errors', () => {
    it('15: unknown embed prefix → PGRST100', async () => {
      const res = await pgrest.rest(makeEvent({
        path: '/rest/v1/orders',
        query: {
          select: 'id,customers(name)',
          'foo.bar': 'eq.1',
        },
      }));
      assert.equal(res.statusCode, 400,
        'unknown embed prefix should return 400');
      const body = JSON.parse(res.body);
      assert.equal(body.code, 'PGRST100',
        'error code should be PGRST100');
      assert.ok(
        body.message.includes("no embed named 'foo'")
        || body.message.includes('foo'),
        `error message should reference the unknown prefix `
        + `'foo', got: ${body.message}`,
      );
    });

    it('16: nested embed filter → PGRST100', async () => {
      const res = await pgrest.rest(makeEvent({
        path: '/rest/v1/orders',
        query: {
          select: 'id,order_items(id,products(name))',
          'order_items.products.name': 'eq.Widget',
        },
      }));
      assert.equal(res.statusCode, 400,
        'nested embed filter should return 400');
      const body = JSON.parse(res.body);
      assert.equal(body.code, 'PGRST100',
        'error code should be PGRST100');
      assert.ok(
        body.message.toLowerCase().includes(
          'filter nesting deeper than one level')
        || body.message.includes('nesting'),
        'error message should mention nesting depth, '
        + `got: ${body.message}`,
      );
    });

    it('17: bad column in embed filter → PGRST204',
      async () => {
        const res = await pgrest.rest(makeEvent({
          path: '/rest/v1/orders',
          query: {
            select: '*,customers(*)',
            'customers.nonexistent': 'eq.1',
          },
        }));
        assert.equal(res.statusCode, 400,
          'bad column in embed filter should return 400');
        const body = JSON.parse(res.body);
        assert.equal(body.code, 'PGRST204',
          'error code should be PGRST204');
        assert.ok(
          body.message.includes('nonexistent'),
          'error should reference the bad column, '
          + `got: ${body.message}`,
        );
        assert.ok(
          body.message.includes("'customers'"),
          'error should reference the embed table '
          + `"customers", got: ${body.message}`,
        );
      },
    );

    it('18: no embeds — dotted key falls through',
      async () => {
        const res = await pgrest.rest(makeEvent({
          path: '/rest/v1/customers',
          query: {
            select: 'id,name',
            'foo.bar': 'eq.1',
          },
        }));
        assert.equal(res.statusCode, 400,
          'dotted key with no embeds should return 400');
        const body = JSON.parse(res.body);
        assert.equal(body.code, 'PGRST204',
          'with no embeds in select, dotted key should '
          + 'fall through to regular column filter and '
          + `fail as PGRST204, got: ${body.code}`);
      },
    );
  });

  describe('Backward Compatibility', () => {
    it('19: top-level logical ops unaffected by embed '
      + 'detection', async () => {
      const res = await pgrest.rest(makeEvent({
        path: '/rest/v1/orders',
        query: {
          select: '*,customers(*)',
          'not.or': '(amount.eq.99,amount.eq.75)',
        },
      }));
      assert.equal(res.statusCode, 200,
        'should return 200 for top-level not.or '
        + 'with embeds');
      const rows = JSON.parse(res.body);
      for (const row of rows) {
        assert.ok(
          Number(row.amount) !== 99
          && Number(row.amount) !== 75,
          'not.or should exclude orders with amount 99 '
          + `and 75, got amount ${row.amount}`,
        );
      }
    });

    it('20: parent filters with embeds — unchanged',
      async () => {
        const res = await pgrest.rest(makeEvent({
          path: '/rest/v1/orders',
          query: {
            select: '*,customers(name)',
            amount: 'gt.50',
          },
        }));
        assert.equal(res.statusCode, 200,
          'should return 200 for parent filter with embed');
        const rows = JSON.parse(res.body);
        assert.ok(rows.length > 0,
          'should return at least one order');
        for (const row of rows) {
          assert.ok(Number(row.amount) > 50,
            `parent filter should apply, got amount `
            + `${row.amount}`);
          assert.ok('customers' in row,
            'each row should have customers embed key');
        }
      },
    );

    it('21: existing embedding tests still pass', async () => {
      const res = await pgrest.rest(makeEvent({
        path: '/rest/v1/orders',
        query: { select: 'id,amount,customers(name,email)' },
      }));
      assert.equal(res.statusCode, 200,
        'basic embedding should still work');
      const rows = JSON.parse(res.body);
      const order1 = rows.find(r => Number(r.id) === 1);
      assert.ok(order1, 'order 1 should be in results');
      assert.deepStrictEqual(order1.customers, {
        name: 'Alice', email: 'alice@test.com',
      }, 'embedding response format should be unchanged');
    });
  });
});
