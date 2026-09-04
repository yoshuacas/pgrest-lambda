// `db-tx-end` (upstream `configDbTxRollbackAll` / `configDbTxAllowOverride`).
//
// PostgREST can be told to throw away everything a request wrote. Its own test
// suite runs that way — SpecHelper.hs `baseCfg` sets
// `configDbTxRollbackAll = True` and `configDbTxAllowOverride = True` — so a
// mutating request answers with the rows it would have written and leaves the
// table as it was, unless the request asks for `Prefer: tx=commit`.
//
// What these tests pin is the statement sequence, because that is the whole
// behaviour: which requests open a transaction, and how it ends.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from '../db/index.mjs';
import {
  createRestHandler, txEndPolicy, shouldRollback,
} from '../handler.mjs';
import { createSchemaCache } from '../schema-cache.mjs';
import { createCedar } from '../cedar.mjs';

describe('txEndPolicy (db-tx-end)', () => {
  it('defaults to committing with no override', () => {
    for (const v of [undefined, null, '', 'commit']) {
      assert.deepEqual(txEndPolicy(v),
        { rollbackAll: false, allowOverride: false });
    }
  });

  it('reads the four upstream modes', () => {
    assert.deepEqual(txEndPolicy('commit-allow-override'),
      { rollbackAll: false, allowOverride: true });
    assert.deepEqual(txEndPolicy('rollback'),
      { rollbackAll: true, allowOverride: false });
    assert.deepEqual(txEndPolicy('rollback-allow-override'),
      { rollbackAll: true, allowOverride: true });
  });
});

// Upstream `shouldRollback`: the configured ending decides and an accepted
// `Prefer: tx=` inverts it. An unacceptable preference never reaches here —
// the handler clears it first.
describe('shouldRollback', () => {
  const commit = { rollbackAll: false };
  const rollback = { rollbackAll: true };

  it('commits by default', () => {
    assert.equal(shouldRollback(commit, undefined), false);
  });

  it('rolls back everything when configured to', () => {
    assert.equal(shouldRollback(rollback, undefined), true);
  });

  it('lets tx=commit through a rollback-all configuration', () => {
    assert.equal(shouldRollback(rollback, 'commit'), false);
  });

  it('lets tx=rollback override a committing configuration', () => {
    assert.equal(shouldRollback(commit, 'rollback'), true);
  });
});

const columnRows = [
  { table_name: 'todos', column_name: 'id',
    data_type: 'integer', is_nullable: false, column_default: null },
  { table_name: 'todos', column_name: 'title',
    data_type: 'text', is_nullable: true, column_default: null },
];
const pkRows = [{ table_name: 'todos', column_name: 'id' }];

function mockPool(dataRows = [{ id: 1, title: 'x' }]) {
  const queries = [];
  return {
    queries,
    query: async (text, values) => {
      queries.push({ text: String(text).trimStart(), values });
      const sql = String(text).trimStart();
      if (sql.includes('pg_catalog') && !sql.includes('contype')) {
        return { rows: columnRows };
      }
      if (sql.includes('contype')) return { rows: pkRows };
      if (sql.startsWith('SELECT COUNT')) return { rows: [{ count: '1' }] };
      return { rows: dataRows };
    },
  };
}

function makeHandler(dbTxEnd, dataRows) {
  const pool = mockPool(dataRows);
  const db = createDb({});
  db._setPool(pool);
  const cedar = createCedar({ policiesPath: './policies' });
  cedar._setPolicies({
    staticPolicies: 'permit(principal, action, resource);',
  });
  const ctx = {
    db,
    schemaCache: createSchemaCache({}),
    cedar,
    errorsVerbose: false,
    dbTxEnd,
  };
  return { handler: createRestHandler(ctx).handler, pool };
}

function event({ method, query = {}, headers = {}, body = null }) {
  return {
    httpMethod: method,
    path: '/rest/v1/todos',
    queryStringParameters: Object.keys(query).length ? query : null,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === null ? null : JSON.stringify(body),
    requestContext: {
      authorizer: { role: 'service_role', userId: '', email: '' },
    },
  };
}

/** The transaction control statements, in the order they were issued. */
const txSteps = pool => pool.queries
  .map(q => q.text.split(/[\s(]/)[0].toUpperCase())
  .filter(w => ['BEGIN', 'COMMIT', 'ROLLBACK'].includes(w));

const wrote = pool =>
  pool.queries.some(q => /^(INSERT|UPDATE|DELETE)/.test(q.text));

const patch = (handler, headers = {}) => handler(event({
  method: 'PATCH',
  query: { id: 'eq.1' },
  headers,
  body: { title: 'zzz' },
}));

describe('db-tx-end: what a mutating request does to its transaction',
  () => {
    // A write always gets a transaction, even when it ends with COMMIT: the
    // ending cannot be decided until the response has been built, because a
    // request that fails after writing must not leave the write behind.
    it('commits its own transaction by default', async () => {
      const { handler, pool } = makeHandler(undefined);
      const res = await patch(handler);
      assert.equal(res.statusCode, 204);
      assert.deepEqual(txSteps(pool), ['BEGIN', 'COMMIT']);
      assert.equal(wrote(pool), true);
    });

    it('runs the write and rolls it back under db-tx-end=rollback',
      async () => {
        const { handler, pool } = makeHandler('rollback');
        const res = await patch(handler);
        // The response is the one the write earned; only the rows are undone.
        assert.equal(res.statusCode, 204);
        assert.equal(wrote(pool), true);
        assert.deepEqual(txSteps(pool), ['BEGIN', 'ROLLBACK']);
        const order = pool.queries.map(q => q.text);
        assert.ok(order.indexOf('BEGIN') < order.findIndex(t => /^UPDATE/.test(t)),
          'the write must be inside the transaction');
      });

    it('ignores Prefer: tx=commit when the override is not allowed',
      async () => {
        const { handler, pool } = makeHandler('rollback');
        const res = await patch(handler, { Prefer: 'tx=commit' });
        assert.deepEqual(txSteps(pool), ['BEGIN', 'ROLLBACK']);
        // Not applied, so not echoed.
        assert.equal(res.headers['Preference-Applied'], undefined);
      });

    it('honours Prefer: tx=commit under rollback-allow-override',
      async () => {
        const { handler, pool } = makeHandler('rollback-allow-override');
        const res = await patch(handler, { Prefer: 'tx=commit' });
        assert.equal(wrote(pool), true);
        assert.deepEqual(txSteps(pool), ['BEGIN', 'COMMIT']);
        assert.equal(res.headers['Preference-Applied'], 'tx=commit');
      });

    it('honours Prefer: tx=rollback under commit-allow-override',
      async () => {
        const { handler, pool } = makeHandler('commit-allow-override');
        const res = await patch(handler, { Prefer: 'tx=rollback' });
        assert.deepEqual(txSteps(pool), ['BEGIN', 'ROLLBACK']);
        assert.equal(res.headers['Preference-Applied'], 'tx=rollback');
      });

    // A read has nothing to undo, so it stays on the pool.
    it('leaves a GET out of the transaction', async () => {
      const { handler, pool } = makeHandler('rollback');
      const res = await handler(event({ method: 'GET' }));
      assert.equal(res.statusCode, 200);
      assert.deepEqual(txSteps(pool), []);
    });

    it('rolls back a POST as well', async () => {
      const { handler, pool } = makeHandler('rollback');
      const res = await handler(event({
        method: 'POST', body: { id: 2, title: 'a' },
      }));
      assert.equal(res.statusCode, 201);
      assert.deepEqual(txSteps(pool), ['BEGIN', 'ROLLBACK']);
    });

    // Upstream SingularSpec.hs:301 ("fails for multiple rows with rolled back
    // changes"): the failing request asks for `tx=commit`, and the row it
    // changed still has to read back unchanged afterwards. The write is real
    // and the error comes from the engine, not the database, so only the
    // request's own transaction can undo it.
    it('rolls back a write the response then failed on, tx=commit and all',
      async () => {
        const { handler, pool } = makeHandler('rollback-allow-override',
          [{ id: 1, title: 'a' }, { id: 2, title: 'b' }]);
        const res = await patch(handler, {
          Prefer: 'tx=commit, return=representation',
          Accept: 'application/vnd.pgrst.object+json',
        });
        assert.equal(res.statusCode, 406);
        assert.equal(JSON.parse(res.body).code, 'PGRST116');
        assert.equal(wrote(pool), true);
        assert.deepEqual(txSteps(pool), ['BEGIN', 'ROLLBACK']);
      });

    it('rolls back a DELETE as well', async () => {
      const { handler, pool } = makeHandler('rollback');
      const res = await handler(event({
        method: 'DELETE', query: { id: 'eq.1' },
      }));
      assert.equal(res.statusCode, 204);
      assert.deepEqual(txSteps(pool), ['BEGIN', 'ROLLBACK']);
    });
  });
