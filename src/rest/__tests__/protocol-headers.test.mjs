// The pure helpers behind the headers a response carries regardless of its
// rows: the canonical query string (Content-Location), the path check that
// answers PGRST125, the Allow list an OPTIONS reports, and the two pieces of
// the planner-estimate count that ends up in Content-Range.
//
// Behaviour is pinned to upstream `PostgREST.ApiRequest.QueryParams`
// (`qsCanonical`), `PostgREST.ApiRequest` (`getResource`),
// `PostgREST.Response` (`allowH`) and `PostgREST.Query.MainTx`
// (`decodeExplain`).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalQuery, assertValidPath, allowHeaderFor,
  explainCountSql, planRowsFromExplain,
  shouldExactCount, shouldExplainCount,
} from '../handler.mjs';
import { PostgRESTError } from '../errors.mjs';

describe('canonicalQuery', () => {
  it('sorts parameters by name', () => {
    assert.equal(
      canonicalQuery({ b: 'eq.1', a: 'eq.1' }),
      'a=eq.1&b=eq.1',
      'the same read has one canonical spelling whatever order it was sent in');
  });

  it('joins a repeated parameter with commas', () => {
    assert.equal(
      canonicalQuery(
        { id: 'gt.5' },
        { id: ['gt.5', 'lt.10'] },
      ),
      'id=gt.5,lt.10',
      'urlEncodeVars writes a repeated key once, values comma-joined, in the '
      + 'order they were sent');
  });

  it('keeps the = of a parameter with no value', () => {
    assert.equal(canonicalQuery({ select: '' }), 'select=');
  });

  it('percent-encodes what RFC 3986 reserves', () => {
    assert.equal(
      canonicalQuery({ 'name': 'eq.a b&c' }),
      'name=eq.a%20b%26c',
      'the header has to be re-sendable as a URL');
  });

  it('is empty when there were no parameters', () => {
    assert.equal(canonicalQuery(null, null), '');
    assert.equal(canonicalQuery({}), '');
  });
});

describe('assertValidPath', () => {
  const invalid = (path) => assert.throws(
    () => assertValidPath(path),
    (err) => {
      assert.ok(err instanceof PostgRESTError);
      assert.equal(err.statusCode, 404);
      assert.equal(err.code, 'PGRST125');
      assert.equal(err.message, 'Invalid path specified in request URL');
      return true;
    },
    `${path} names no resource`,
  );

  it('accepts the three shapes upstream recognises', () => {
    assert.equal(assertValidPath('/rest/v1'), undefined);
    assert.equal(assertValidPath('/rest/v1/'), undefined);
    assert.equal(assertValidPath('/rest/v1/items'), undefined);
    assert.equal(assertValidPath('/rest/v1/rpc/getallprojects'), undefined);
    assert.equal(assertValidPath('/items'), undefined,
      'the /rest/v1 prefix is optional: it is the stage, not the resource');
  });

  it('refuses a nested path', () => {
    invalid('/rest/v1/items/1');
    invalid('/rest/v1/first/second/third');
    invalid('/rest/v1/rpc/one/two');
  });

  it('reads a trailing slash as the resource without it', () => {
    assert.equal(assertValidPath('/rest/v1/items/'), undefined);
  });
});

describe('allowHeaderFor', () => {
  const schema = {
    tables: {
      items: { insertable: true, updatable: true, deletable: true,
        primaryKey: ['id'] },
      no_pk: { insertable: true, updatable: true, deletable: true,
        primaryKey: [] },
      readonly_view: { insertable: false, updatable: false, deletable: false,
        primaryKey: [] },
      patchable_view: { insertable: false, updatable: true, deletable: false,
        primaryKey: [] },
    },
    routines: {
      writer: [{ volatility: 'v' }],
      reader: [{ volatility: 's' }],
    },
  };

  it('lists every method a plain table takes', () => {
    assert.equal(allowHeaderFor({ type: 'table', table: 'items' }, schema),
      'OPTIONS,GET,HEAD,POST,PUT,PATCH,DELETE');
  });

  it('withholds PUT from a table with no primary key', () => {
    assert.equal(allowHeaderFor({ type: 'table', table: 'no_pk' }, schema),
      'OPTIONS,GET,HEAD,POST,PATCH,DELETE',
      'a single-row upsert has nothing to address the row by');
  });

  it('gives a read-only view the read methods only', () => {
    assert.equal(
      allowHeaderFor({ type: 'table', table: 'readonly_view' }, schema),
      'OPTIONS,GET,HEAD');
  });

  it('lets an updatable view answer PATCH', () => {
    assert.equal(
      allowHeaderFor({ type: 'table', table: 'patchable_view' }, schema),
      'OPTIONS,GET,HEAD,PATCH');
  });

  it('lets only a non-volatile function be read', () => {
    assert.equal(
      allowHeaderFor({ type: 'rpc', functionName: 'writer' }, schema),
      'OPTIONS,POST');
    assert.equal(
      allowHeaderFor({ type: 'rpc', functionName: 'reader' }, schema),
      'OPTIONS,GET,HEAD,POST');
  });

  it('treats the root spec as readable and the cache refresh as a write', () => {
    assert.equal(allowHeaderFor({ type: 'openapi' }, schema),
      'OPTIONS,GET,HEAD');
    assert.equal(allowHeaderFor({ type: 'refresh' }, schema), 'OPTIONS,POST');
  });
});

describe('count strategies', () => {
  it('separates the strategies that count from the ones that estimate', () => {
    assert.equal(shouldExactCount({ count: 'exact' }), true);
    assert.equal(shouldExactCount({ count: 'planned' }), false);
    assert.equal(shouldExactCount({ count: 'estimated' }), true);
    assert.equal(shouldExplainCount({ count: 'exact' }), false);
    assert.equal(shouldExplainCount({ count: 'planned' }), true);
    assert.equal(shouldExplainCount({ count: 'estimated' }), true);
  });

  it('turns a count query into the row-producing form to EXPLAIN', () => {
    assert.equal(
      explainCountSql('SELECT COUNT(*) FROM "items" WHERE "id" > $1'),
      'SELECT 1 FROM "items" WHERE "id" > $1',
      'EXPLAIN of a COUNT reports one row at the top — that is how many rows '
      + 'the aggregate returns, not how many it read');
  });

  it('accepts the aliased spelling', () => {
    assert.equal(
      explainCountSql('SELECT COUNT(*) AS count FROM "items"'),
      'SELECT 1 FROM "items"');
  });

  it('returns null for a shape it does not recognise', () => {
    assert.equal(explainCountSql('SELECT max(id) FROM "items"'), null,
      'the caller falls back to the exact count rather than guess');
  });

  it('reads the estimate off the top plan node', () => {
    const plan = [{ Plan: { 'Node Type': 'Seq Scan', 'Plan Rows': 1234 } }];
    assert.equal(planRowsFromExplain(plan), 1234);
    assert.equal(planRowsFromExplain(JSON.stringify(plan)), 1234,
      'the driver may hand the plan back as text');
  });

  it('returns null when there is no estimate to read', () => {
    assert.equal(planRowsFromExplain(null), null);
    assert.equal(planRowsFromExplain('not json'), null);
    assert.equal(planRowsFromExplain([{}]), null);
  });
});
