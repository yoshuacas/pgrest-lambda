// query-parser-rpc-args.test.mjs — the GET /rpc/fn argument/filter split.
//
// Mirrors upstream PostgREST.ApiRequest.QueryParams: on a read of a function
// the query string is `pOpExpr pSingleVal <|> pure (NoOpExpr v)`, and Parsec's
// `<|>` only takes the second branch when the first failed *without consuming
// input*. So the split is per value, not per key: `?id=5&id=gt.2` is the
// argument id=5 and the filter id>2 at the same time.
//
//   node --test src/rest/__tests__/query-parser-rpc-args.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseQuery, isRpcArgValue } from '../query-parser.mjs';

const DEPTH = 5;

function rpc(params, multi) {
  return parseQuery(params, 'GET', multi, DEPTH, { rpcRead: true });
}

describe('isRpcArgValue', () => {
  it('takes a bare value as an argument', () => {
    for (const v of ['5', '', 'hi there', 'Hello', '3.14', 'true', '-1']) {
      assert.equal(isRpcArgValue(v), true, JSON.stringify(v));
    }
  });

  it('takes an operator expression as a filter', () => {
    for (const v of [
      'gt.2', 'eq.5', 'not.eq.5', 'in.(1,2)', 'is.null', 'like.*foo*',
    ]) {
      assert.equal(isRpcArgValue(v), false, v);
    }
  });

  it('leaves a half-parsed operator a filter so it stays PGRST100', () => {
    // Upstream: `is.blah` consumed `is.` before failing, so the alternative
    // is never reached and the request is a 400, not a function argument.
    assert.equal(isRpcArgValue('is.blah'), false);
  });

  it('keeps the not_null shorthand a filter', () => {
    assert.equal(isRpcArgValue('not_null'), false);
  });
});

describe('parseQuery with rpcRead', () => {
  it('collects a bare parameter as an argument, not a filter', () => {
    const parsed = rpc({ a: '1', b: '2' });
    assert.deepStrictEqual(parsed.rpcArgs, [['a', '1'], ['b', '2']]);
    assert.deepStrictEqual(parsed.filters, []);
  });

  it('keeps an operator expression a filter', () => {
    const parsed = rpc({ id: 'gt.2' });
    assert.deepStrictEqual(parsed.rpcArgs, []);
    assert.equal(parsed.filters.length, 1);
    assert.equal(parsed.filters[0].column, 'id');
    assert.equal(parsed.filters[0].operator, 'gt');
  });

  it('splits repeats of one key into an argument and a filter', () => {
    const parsed = rpc({ id: 'gt.2' }, { id: ['5', 'gt.2'] });
    assert.deepStrictEqual(parsed.rpcArgs, [['id', '5']]);
    assert.equal(parsed.filters.length, 1);
    assert.equal(parsed.filters[0].operator, 'gt');
  });

  it('keeps every repeat of an argument, in order', () => {
    const parsed = rpc({ v: 'three' }, { v: ['one', 'two', 'three'] });
    assert.deepStrictEqual(parsed.rpcArgs,
      [['v', 'one'], ['v', 'two'], ['v', 'three']]);
  });

  it('never treats select/order/limit/offset as arguments', () => {
    const parsed = rpc({
      select: 'id,name', order: 'id.desc', limit: '2', offset: '1',
    });
    assert.deepStrictEqual(parsed.rpcArgs, []);
    assert.equal(parsed.limit, 2);
    assert.equal(parsed.offset, 1);
    assert.deepStrictEqual(parsed.order,
      [{ column: 'id', direction: 'desc', nulls: null }]);
    assert.deepStrictEqual(parsed.select.map(s => s.name), ['id', 'name']);
  });

  it('still parses a logic tree as a filter', () => {
    const parsed = rpc({ or: '(id.eq.1,id.eq.2)' });
    assert.deepStrictEqual(parsed.rpcArgs, []);
    assert.equal(parsed.filters.length, 1);
    assert.equal(parsed.filters[0].type, 'logicalGroup');
  });

  it('reports no rpcArgs at all when rpcRead is off', () => {
    const parsed = parseQuery({ a: 'eq.1' }, 'GET');
    assert.equal(parsed.rpcArgs, undefined);
    assert.equal(parsed.filters.length, 1);
  });

  it('is still an error to send a bare value on a table read', () => {
    // The relaxation is scoped to function reads: on /table a value that is
    // not an operator expression stays a 400.
    assert.throws(() => parseQuery({ a: '1' }, 'GET'),
      (err) => err.code === 'PGRST100');
  });

  it('is still an error to filter with a bad operator on a function read', () => {
    assert.throws(() => rpc({ id: 'is.blah' }),
      (err) => err.code === 'PGRST100');
  });
});
