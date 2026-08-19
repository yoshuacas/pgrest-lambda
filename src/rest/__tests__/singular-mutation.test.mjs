// `Accept: application/vnd.pgrst.object+json` on a mutation is a claim about
// the result, not about how it is rendered: upstream runs the mutation, sees a
// row count other than one, answers 406 PGRST116 and rolls the transaction back
// — so the rows stay as they were even with `Prefer: tx=commit, return=minimal`
// (upstream test/spec/Feature/Query/SingularSpec.hs, "the rows should not be
// updated, either"). This engine has no rollback, so it must decide before it
// writes: these tests pin that no write statement is issued.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from '../db/index.mjs';
import { createRestHandler } from '../handler.mjs';
import { createSchemaCache } from '../schema-cache.mjs';
import { createCedar } from '../cedar.mjs';

const SINGULAR = 'application/vnd.pgrst.object+json';

const columnRows = [
  { table_name: 'todos', column_name: 'id',
    data_type: 'text', is_nullable: false, column_default: null },
  { table_name: 'todos', column_name: 'title',
    data_type: 'text', is_nullable: true, column_default: null },
];
const pkRows = [{ table_name: 'todos', column_name: 'id' }];

// `count` is what every COUNT(*) answers, so a test can say "the filters select
// N rows" without modelling a table.
function mockPool(count) {
  const queries = [];
  return {
    queries,
    query: async (text, values) => {
      queries.push({ text: String(text), values });
      const sql = String(text).trimStart();
      if (sql.includes('pg_catalog') && !sql.includes('contype')) {
        return { rows: columnRows };
      }
      if (sql.includes('contype')) return { rows: pkRows };
      if (sql.startsWith('SELECT COUNT')) {
        return { rows: [{ count: String(count) }] };
      }
      if (/^(INSERT|UPDATE|DELETE)/.test(sql)) {
        return { rows: [{ id: '1', title: 'x' }] };
      }
      return { rows: [{ id: '1', title: 'x' }] };
    },
  };
}

function makeHandler(count) {
  const pool = mockPool(count);
  const db = createDb({});
  db._setPool(pool);
  const cedar = createCedar({ policiesPath: './policies' });
  cedar._setPolicies({
    staticPolicies: `
      permit(
          principal is PgrestLambda::ServiceRole,
          action,
          resource
      );
    `,
  });
  const ctx = {
    db,
    schemaCache: createSchemaCache({}),
    cedar,
    errorsVerbose: false,
  };
  return { handler: createRestHandler(ctx).handler, pool };
}

function event({ method, query = {}, headers = {}, body = null }) {
  return {
    httpMethod: method,
    path: '/rest/v1/todos',
    queryStringParameters: Object.keys(query).length ? query : null,
    headers: { 'Content-Type': 'application/json', Accept: SINGULAR, ...headers },
    body: body === null ? null : JSON.stringify(body),
    requestContext: { authorizer: { role: 'service_role', userId: '', email: '' } },
  };
}

const wrote = pool =>
  pool.queries.some(q => /^(INSERT|UPDATE|DELETE)/.test(q.text.trimStart()));

describe('singular media type on a mutation', () => {
  it('refuses a PATCH that would touch 2 rows, without updating', async () => {
    const { handler, pool } = makeHandler(2);
    const res = await handler(event({
      method: 'PATCH',
      query: { title: 'eq.x' },
      headers: { Prefer: 'tx=commit' },
      body: { title: 'zzz' },
    }));
    assert.equal(res.statusCode, 406);
    assert.deepEqual(JSON.parse(res.body), {
      code: 'PGRST116',
      message: 'Cannot coerce the result to a single JSON object',
      details: 'The result contains 2 rows',
      hint: null,
    });
    assert.equal(res.headers['Content-Type'], 'application/json; charset=utf-8');
    assert.equal(wrote(pool), false, 'no UPDATE should have been issued');
  });

  it('refuses a PATCH with return=minimal too', async () => {
    const { handler, pool } = makeHandler(4);
    const res = await handler(event({
      method: 'PATCH',
      query: { title: 'eq.x' },
      headers: { Prefer: 'return=minimal' },
      body: { title: 'zzz' },
    }));
    assert.equal(res.statusCode, 406);
    assert.equal(JSON.parse(res.body).details, 'The result contains 4 rows');
    assert.equal(wrote(pool), false);
  });

  it('refuses a PATCH that would touch no rows', async () => {
    const { handler, pool } = makeHandler(0);
    const res = await handler(event({
      method: 'PATCH', query: { id: 'eq.nope' }, body: { title: 'zzz' },
    }));
    assert.equal(res.statusCode, 406);
    assert.equal(JSON.parse(res.body).details, 'The result contains 0 rows');
    assert.equal(wrote(pool), false);
  });

  it('runs a PATCH that touches exactly one row', async () => {
    const { handler, pool } = makeHandler(1);
    const res = await handler(event({
      method: 'PATCH', query: { id: 'eq.1' },
      headers: { Prefer: 'return=representation' },
      body: { title: 'zzz' },
    }));
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), { id: '1', title: 'x' });
    assert.equal(wrote(pool), true);
  });

  it('refuses a DELETE that would remove 5 rows, without deleting', async () => {
    const { handler, pool } = makeHandler(5);
    const res = await handler(event({ method: 'DELETE', query: { id: 'gt.0' } }));
    assert.equal(res.statusCode, 406);
    assert.equal(JSON.parse(res.body).details, 'The result contains 5 rows');
    assert.equal(wrote(pool), false);
  });

  it('runs a DELETE that removes exactly one row', async () => {
    const { handler, pool } = makeHandler(1);
    const res = await handler(event({ method: 'DELETE', query: { id: 'eq.1' } }));
    assert.equal(res.statusCode, 204);
    assert.equal(wrote(pool), true);
  });

  it('refuses a POST of two rows, without inserting', async () => {
    const { handler, pool } = makeHandler(0);
    const res = await handler(event({
      method: 'POST',
      headers: { Prefer: 'tx=commit' },
      body: [{ id: '1' }, { id: '2' }],
    }));
    assert.equal(res.statusCode, 406);
    assert.equal(JSON.parse(res.body).details, 'The result contains 2 rows');
    assert.equal(wrote(pool), false);
  });

  it('refuses a POST of an empty array', async () => {
    const { handler, pool } = makeHandler(0);
    const res = await handler(event({ method: 'POST', body: [] }));
    assert.equal(res.statusCode, 406);
    assert.equal(JSON.parse(res.body).details, 'The result contains 0 rows');
    assert.equal(wrote(pool), false);
  });

  it('runs a POST of one row', async () => {
    const { handler, pool } = makeHandler(0);
    const res = await handler(event({
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: [{ id: '1', title: 'x' }],
    }));
    assert.equal(res.statusCode, 201);
    assert.deepEqual(JSON.parse(res.body), { id: '1', title: 'x' });
    assert.equal(wrote(pool), true);
  });

  it('leaves a plain JSON mutation alone', async () => {
    const { handler, pool } = makeHandler(4);
    const res = await handler(event({
      method: 'PATCH',
      query: { title: 'eq.x' },
      headers: { Accept: 'application/json' },
      body: { title: 'zzz' },
    }));
    assert.equal(res.statusCode, 204);
    assert.equal(wrote(pool), true);
  });
});
