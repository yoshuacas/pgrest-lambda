// sql-builder-json-aggregates.test.mjs — SQL emission for the `->` / `->>`
// json path operators and the aggregate functions.
//
// Mirrors upstream PostgREST.Query.SqlFragment (`pgFmtJsonPath`,
// `pgFmtField`, `pgFmtSelectItem`, `groupF`): every json key and index is a
// bound parameter, indices carry `::int`, a non-json column is wrapped in
// `to_jsonb()` first, and the operator order is
// json path -> cast -> aggregate -> aggregate cast -> alias.
//
//   node --test src/rest/__tests__/sql-builder-json-aggregates.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildSelect, buildRpcCall } from '../sql-builder.mjs';
import { parseQuery } from '../query-parser.mjs';

function norm(s) {
  return s.replace(/\s+/g, ' ').trim();
}

const schema = {
  tables: {
    docs: {
      columns: {
        id: { type: 'int8' },
        kind: { type: 'text' },
        name: { type: 'text' },
        total: { type: 'numeric' },
        data: { type: 'jsonb' },
      },
      primaryKey: ['id'],
    },
    orders: {
      columns: {
        id: { type: 'bigint' },
        customer_id: { type: 'bigint' },
        amount: { type: 'numeric' },
        meta: { type: 'jsonb' },
      },
      primaryKey: ['id'],
    },
    customers: {
      columns: {
        id: { type: 'bigint' },
        name: { type: 'text' },
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

function build(table, query) {
  const { text, values } = buildSelect(table, parseQuery(query, 'GET'), schema);
  return { sql: norm(text), values };
}

describe('json path SQL', () => {
  it('binds the key and aliases with the last key', () => {
    const { sql, values } = build('docs', { select: 'data->>id' });
    assert.equal(sql, 'SELECT "data"->>$1 AS "id" FROM "docs" ORDER BY "docs"."id" ASC');
    assert.deepStrictEqual(values, ['id']);
  });

  it('binds every key of a chain in order', () => {
    const { sql, values } = build('docs', { select: 'x:data->foo->>bar::int' });
    assert.equal(sql, 'SELECT CAST("data"->$1->>$2 AS int) AS "x" FROM "docs"'
      + ' ORDER BY "docs"."id" ASC');
    assert.deepStrictEqual(values, ['foo', 'bar']);
  });

  it('binds an index as a number and casts it to int', () => {
    // Upstream `pgFmtJsonPath`: `-> $1::int`. The cast is what makes the
    // integer form pick the array overload of the operator.
    const { sql, values } = build('docs', { select: 'data->>0' });
    assert.equal(sql, 'SELECT "data"->>$1::int AS "data" FROM "docs"'
      + ' ORDER BY "docs"."id" ASC');
    assert.deepStrictEqual(values, [0]);
  });

  it('binds a negative index', () => {
    const { sql, values } = build('docs', { select: 'data->-1->>b' });
    assert.equal(sql, 'SELECT "data"->$1::int->>$2 AS "b" FROM "docs"'
      + ' ORDER BY "docs"."id" ASC');
    assert.deepStrictEqual(values, [-1, 'b']);
  });

  it('never interpolates a key, however hostile', () => {
    const key = 'a\';DROP TABLE docs;';
    const { sql, values } = build('docs', { select: `data->>${key}` });
    assert.equal(sql, 'SELECT "data"->>$1 AS "a\';DROP TABLE docs;" FROM "docs"'
      + ' ORDER BY "docs"."id" ASC');
    assert.deepStrictEqual(values, [key]);
  });

  it('quotes a derived alias that is not an identifier', () => {
    const { sql, values } = build('docs',
      { select: 'data->!@#$%^&*_d->>!@#$%^&*_e' });
    assert.equal(sql,
      'SELECT "data"->$1->>$2 AS "!@#$%^&*_e" FROM "docs"'
      + ' ORDER BY "docs"."id" ASC');
    assert.deepStrictEqual(values, ['!@#$%^&*_d', '!@#$%^&*_e']);
  });

  it('wraps a non-json column in to_jsonb() first', () => {
    // Plan.hs `cfToJson`: json and jsonb are the only types left alone.
    const { sql, values } = build('docs', { select: 'to:name->>k' });
    assert.equal(sql, 'SELECT to_jsonb("name")->>$1 AS "to" FROM "docs"'
      + ' ORDER BY "docs"."id" ASC');
    assert.deepStrictEqual(values, ['k']);
  });

  it('applies a path in a filter with the value after the keys', () => {
    const { sql, values } = build('docs',
      { select: 'id', 'data->foo->>bar': 'eq.baz' });
    assert.equal(sql,
      'SELECT "id" FROM "docs" WHERE "data"->$1->>$2 = $3'
      + ' ORDER BY "docs"."id" ASC');
    assert.deepStrictEqual(values, ['foo', 'bar', 'baz']);
  });

  it('applies a path in a filter inside a logic tree', () => {
    const { sql, values } = build('docs',
      { select: 'id', or: '(data->>a.eq.1,data->>b.gt.2)' });
    assert.equal(sql, 'SELECT "id" FROM "docs" WHERE'
      + ' ("data"->>$1 = $2 OR "data"->>$3 > $4)'
      + ' ORDER BY "docs"."id" ASC');
    assert.deepStrictEqual(values, ['a', '1', 'b', '2']);
  });

  // ORDER BY columns are table-qualified: a bare name would bind to an
  // output column of the select list before it bound to the table's own.
  it('applies a path in ORDER BY', () => {
    const { sql, values } = build('docs',
      { select: 'id', order: 'data->>id.desc.nullslast' });
    assert.equal(sql,
      'SELECT "id" FROM "docs" '
      + 'ORDER BY "docs"."data"->>$1 DESC NULLS LAST, "docs"."id" ASC');
    assert.deepStrictEqual(values, ['id']);
  });

  it('applies a path with an index in ORDER BY', () => {
    const { sql, values } = build('docs',
      { select: 'id', order: 'data->0->>x' });
    assert.equal(sql,
      'SELECT "id" FROM "docs" '
      + 'ORDER BY "docs"."data"->$1::int->>$2 ASC, "docs"."id" ASC');
    assert.deepStrictEqual(values, [0, 'x']);
  });

  it('applies a path inside an embedded resource', () => {
    const { sql, values } = build('customers',
      { select: 'name,orders(meta->>tag)' });
    assert.ok(sql.includes('\'tag\', "orders"."meta"->>$1'), sql);
    assert.deepStrictEqual(values, ['tag']);
  });
});

describe('aggregate SQL', () => {
  it('emits COUNT(*) with no GROUP BY', () => {
    const { sql, values } = build('docs', { select: 'count()' });
    assert.equal(sql, 'SELECT COUNT(*) AS "count" FROM "docs"');
    assert.deepStrictEqual(values, []);
  });

  it('groups by every non-aggregated column', () => {
    const { sql } = build('docs', { select: 'kind,total.sum()' });
    assert.equal(sql,
      'SELECT "kind", SUM("total") AS "sum" FROM "docs" GROUP BY "kind"');
  });

  it('expands * into the group list', () => {
    const { sql } = build('docs', { select: '*,count()' });
    assert.equal(sql, 'SELECT "id", "kind", "name", "total", "data",'
      + ' COUNT(*) AS "count" FROM "docs"'
      + ' GROUP BY "id", "kind", "name", "total", "data"');
  });

  it('adds no GROUP BY when nothing is aggregated', () => {
    const { sql } = build('docs', { select: 'kind,total' });
    assert.equal(sql.includes('GROUP BY'), false, sql);
  });

  it('casts inside the aggregate and outside it', () => {
    const { sql, values } = build('docs',
      { select: 'kind,c:count()::text,total.avg()' });
    assert.equal(sql, 'SELECT "kind", CAST(COUNT(*) AS text) AS "c",'
      + ' AVG("total") AS "avg" FROM "docs" GROUP BY "kind"');
    assert.deepStrictEqual(values, []);
  });

  it('aggregates over a json path with a cast', () => {
    const { sql, values } = build('docs',
      { select: 'data->>k::integer.sum()' });
    assert.equal(sql,
      'SELECT SUM(CAST("data"->>$1 AS integer)) AS "sum" FROM "docs"');
    assert.deepStrictEqual(values, ['k']);
  });

  it('groups by the json path expression, not the alias', () => {
    const { sql, values } = build('docs',
      { select: 'data->>kind,total.sum()' });
    assert.equal(sql, 'SELECT "data"->>$1 AS "kind", SUM("total") AS "sum"'
      + ' FROM "docs" GROUP BY "data"->>$1');
    assert.deepStrictEqual(values, ['kind']);
  });

  it('reads ?select=count as a functional-notation whole-row count', () => {
    // Upstream never checks select fields against the schema cache, so
    // `count` with no parentheses is `count("docs")` in PostgreSQL
    // functional notation. Kept for backwards compatibility.
    //
    // No primary-key tiebreak: the aggregate is invisible to the builder, and
    // appending `ORDER BY "docs"."id"` to it is `42803 column "docs"."id" must
    // appear in the GROUP BY clause`. See `selectsOpaqueField`.
    const { sql } = build('docs', { select: 'count' });
    assert.equal(sql, 'SELECT "docs"."count" FROM "docs"');
  });

  it('aggregates a to-many embed inside a derived table', () => {
    const { sql } = build('customers', { select: 'name,orders(amount.sum())' });
    assert.ok(sql.includes('json_agg("pgrst_agg")'), sql);
    assert.ok(sql.includes('SUM("orders"."amount")'), sql);
    assert.ok(sql.includes('AS "pgrst_grouped"'), sql);
    assert.equal(sql.includes('GROUP BY'), false, sql);
  });

  it('groups inside the derived table when a column is selected too', () => {
    const { sql } = build('customers',
      { select: 'name,orders(customer_id,amount.sum())' });
    assert.ok(sql.includes('GROUP BY "orders"."customer_id"'), sql);
  });

  it('keeps a top-level aggregate next to a many-to-one embed', () => {
    const { sql } = build('orders',
      { select: 'customer_id,amount.sum(),customers(name)' });
    assert.ok(sql.includes('SUM("orders"."amount") AS "sum"'), sql);
    assert.ok(sql.endsWith('GROUP BY "orders"."customer_id"'), sql);
  });
});

describe('json paths and aggregates on set-returning functions', () => {
  const fnSchema = {
    name: 'get_docs',
    args: [],
    returnType: 'record',
    returnRelation: 'record',
    returnsSet: true,
    returnsComposite: true,
    isScalar: false,
    numDefaults: 0,
    returnColumns: [
      { name: 'id', type: 'int8' },
      { name: 'data', type: 'jsonb' },
      { name: 'total', type: 'numeric' },
    ],
  };

  it('binds a json key in an rpc select', () => {
    const { text, values } = buildRpcCall(
      'get_docs', {}, fnSchema, parseQuery({ select: 'data->>k' }, 'GET'));
    assert.ok(norm(text).includes('"data"->>$1 AS "k"'), text);
    assert.deepStrictEqual(values, ['k']);
  });

  it('groups an rpc aggregate', () => {
    const { text } = buildRpcCall(
      'get_docs', {}, fnSchema, parseQuery({ select: 'id,total.sum()' }, 'GET'));
    const sql = norm(text);
    assert.ok(sql.includes('SUM("total") AS "sum"'), sql);
    assert.ok(sql.includes('GROUP BY "id"'), sql);
  });
});
