import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildSelect } from '../sql-builder.mjs';
import { parseQuery } from '../query-parser.mjs';

function norm(s) {
  return s.replace(/\s+/g, ' ').trim();
}

const schema = {
  tables: {
    orders: {
      columns: {
        id: { type: 'bigint' },
        customer_id: { type: 'bigint' },
        amount: { type: 'numeric' },
      },
      primaryKey: ['id'],
    },
    customers: {
      columns: {
        id: { type: 'bigint' },
        name: { type: 'text' },
        status: { type: 'text' },
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

describe('sql-builder embed filters', () => {
  it('many-to-one embed with filter', () => {
    const parsed = parseQuery({
      select: 'id,customers(name)',
      'customers.name': 'eq.Alice',
    }, 'GET');
    const { text, values } = buildSelect(
      'orders', parsed, schema);
    assert.deepStrictEqual(values, ['Alice']);
    const sql = norm(text);
    assert.ok(
      sql.includes('"name" = $1'),
      `subquery should have embed filter, got: ${sql}`);
    assert.ok(
      sql.includes('"customers"."id" = "orders"."customer_id"'),
      `subquery should have join condition, got: ${sql}`);
  });

  it('one-to-many embed with filter', () => {
    const parsed = parseQuery({
      select: 'id,orders(id,amount)',
      'orders.amount': 'gt.50',
    }, 'GET');
    const { text, values } = buildSelect(
      'customers', parsed, schema);
    assert.deepStrictEqual(values, ['50']);
    const sql = norm(text);
    assert.ok(
      sql.includes('json_agg'),
      `should use json_agg for one-to-many, got: ${sql}`);
    assert.ok(
      sql.includes('"amount" > $1'),
      `subquery should have embed filter, got: ${sql}`);
  });

  it('multiple embed filters', () => {
    const parsed = parseQuery({
      select: 'id,customers(name,status)',
      'customers.name': 'eq.Alice',
      'customers.status': 'eq.active',
    }, 'GET');
    const { text, values } = buildSelect(
      'orders', parsed, schema);
    assert.deepStrictEqual(values, ['Alice', 'active']);
    const sql = norm(text);
    assert.ok(
      sql.includes('"name" = $1 AND "status" = $2'),
      `subquery should have both embed filters, got: ${sql}`);
  });

  it('embed OR filter', () => {
    const parsed = parseQuery({
      select: 'id,customers(name,status)',
      'customers.or': '(name.eq.Alice,status.eq.active)',
    }, 'GET');
    const { text, values } = buildSelect(
      'orders', parsed, schema);
    assert.deepStrictEqual(values, ['Alice', 'active']);
    const sql = norm(text);
    assert.ok(
      sql.includes('("name" = $1 OR "status" = $2)'),
      `subquery should have OR filter, got: ${sql}`);
  });

  it('embed filter + parent filter', () => {
    const parsed = parseQuery({
      select: 'id,customers(name)',
      amount: 'gt.50',
      'customers.name': 'eq.Alice',
    }, 'GET');
    const { text, values } = buildSelect(
      'orders', parsed, schema);
    assert.deepStrictEqual(values, ['Alice', '50']);
    const sql = norm(text);
    assert.ok(
      sql.includes('"name" = $1'),
      `embed subquery should have $1, got: ${sql}`);
    assert.ok(
      sql.includes('"amount" > $2'),
      `parent WHERE should have $2, got: ${sql}`);
  });

  it('no embed filters — backward compatible', () => {
    const parsed = parseQuery({
      select: 'id,customers(name)',
    }, 'GET');
    const { text, values } = buildSelect(
      'orders', parsed, schema);
    assert.deepStrictEqual(values, []);
    const sql = norm(text);
    assert.ok(
      !sql.includes('AND "name"'),
      `subquery should not have extra filter conditions, `
      + `got: ${sql}`);
  });
});

describe('sql-builder !inner + embed filters', () => {
  it('many-to-one !inner + filter uses EXISTS with filter', () => {
    const parsed = parseQuery({
      select: 'id,customers!inner(name)',
      'customers.name': 'eq.Alice',
    }, 'GET');
    const { text, values } = buildSelect(
      'orders', parsed, schema);
    assert.deepStrictEqual(values, ['Alice', 'Alice']);
    const sql = norm(text);
    assert.ok(
      sql.includes('EXISTS (SELECT 1 FROM "customers"'),
      `parent WHERE should have EXISTS for !inner + filter, `
      + `got: ${sql}`);
    assert.ok(
      sql.includes('"customers"."id" = "orders"."customer_id"'),
      `EXISTS should have join condition, got: ${sql}`);
    assert.ok(
      sql.includes('"name" = $2'),
      `EXISTS should have filter condition with $2, `
      + `got: ${sql}`);
  });

  it('one-to-many !inner + filter uses EXISTS with filter',
    () => {
      const parsed = parseQuery({
        select: 'id,orders!inner(id,amount)',
        'orders.amount': 'gt.50',
      }, 'GET');
      const { text, values } = buildSelect(
        'customers', parsed, schema);
      assert.deepStrictEqual(values, ['50', '50']);
      const sql = norm(text);
      assert.ok(
        sql.includes('EXISTS (SELECT 1 FROM "orders"'),
        `parent WHERE should have EXISTS for one-to-many `
        + `!inner + filter, got: ${sql}`);
      assert.ok(
        sql.includes('"orders"."customer_id" = '
          + '"customers"."id"'),
        `EXISTS should have join condition, got: ${sql}`);
      assert.ok(
        sql.includes('"amount" > $2'),
        `EXISTS should have filter condition with $2, `
        + `got: ${sql}`);
    },
  );

  it('many-to-one !inner without filter uses IS NOT NULL',
    () => {
      const parsed = parseQuery({
        select: 'id,customers!inner(name)',
      }, 'GET');
      const { text, values } = buildSelect(
        'orders', parsed, schema);
      assert.deepStrictEqual(values, []);
      const sql = norm(text);
      assert.ok(
        sql.includes('"orders"."customer_id" IS NOT NULL'),
        `!inner without filter should use IS NOT NULL, `
        + `got: ${sql}`);
      assert.ok(
        !sql.includes('EXISTS'),
        `!inner without filter should not use EXISTS, `
        + `got: ${sql}`);
    },
  );

  it('one-to-many !inner without filter uses EXISTS join only',
    () => {
      const parsed = parseQuery({
        select: 'id,orders!inner(id,amount)',
      }, 'GET');
      const { text, values } = buildSelect(
        'customers', parsed, schema);
      assert.deepStrictEqual(values, []);
      const sql = norm(text);
      assert.ok(
        sql.includes('EXISTS (SELECT 1 FROM "orders"'),
        `!inner one-to-many should use EXISTS, got: ${sql}`);
      assert.ok(
        sql.includes('"orders"."customer_id" = '
          + '"customers"."id"'),
        `EXISTS should have join condition, got: ${sql}`);
      assert.ok(
        !sql.includes('AND "amount"'),
        `EXISTS should not have filter conditions, `
        + `got: ${sql}`);
    },
  );
});
