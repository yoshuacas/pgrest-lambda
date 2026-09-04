// A failing case gets exactly one gap slug, and that slug is what a reader uses
// to decide whether the failure is the engine's, the database's, or the
// assertion's. Attribution therefore has to follow the observed outcome, not the
// first plausible explanation available.
//
// The defect this pins: triage consulted LOG_GAPS — "whatever the database
// complained about in the log" — before looking at how the body actually
// differed. A case whose rows were right and whose order was wrong, but which
// happened to log a line matching one of those patterns, was booked under that
// pattern's gap. Measured on RpcSpec:985 and RpcSpec:997: both logged
// "text search configuration", both returned the correct rows in a different
// order, and both were reported as missing-operator-fts. That inflated the fts
// gap and understated order sensitivity in the same move, and it hid two
// order-luck passes inside a gap labelled as DSQL's fault.
//
// The status is `fail` under either attribution, so nothing here changes the
// pass rate. Only the label does.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { compare, triage } from '../runner/run.mjs';

const ctx = () => ({
  catalog: { relations: new Set(), functions: new Set() },
  dropIndex: new Map(),
});

// Same two rows, opposite order.
const EXPECTED = [{ id: 1, name: 'a' }, { id: 2, name: 'b' }];
const REVERSED = [{ id: 2, name: 'b' }, { id: 1, name: 'a' }];

const testCase = (over = {}) => ({
  id: 'RpcSpec:985',
  category: 'rpc',
  bodyMatch: 'exact',
  request: { method: 'GET', path: '/rpc/search', query: '', headers: {} },
  expected: { status: 200, body: EXPECTED, bodyFormat: 'json', headers: {} },
  ...over,
});

const respond = (body, statusCode = 200) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
  json: body,
});

function gapFor(logs, body = REVERSED, statusCode = 200) {
  const tc = testCase();
  const actual = respond(body, statusCode);
  return triage({
    testCase: tc, actual, comparison: compare(tc, actual), thrown: null, logs, ctx: ctx(),
  });
}

describe('triage: an order-only difference outranks an incidental log line', () => {
  it('books an order-only failure as row-order-unspecified', () => {
    const t = gapFor([]);
    assert.equal(t.status, 'fail');
    assert.equal(t.gap, 'row-order-unspecified');
  });

  it('still books it there when the log names a text search configuration', () => {
    // The RpcSpec:985 shape. The log line is real, but it does not explain a
    // failure whose only defect is ordering.
    const t = gapFor(['{"level":"error","message":"text search configuration '
      + '\\"english\\" does not exist"}']);
    assert.equal(t.gap, 'row-order-unspecified',
      'a log line must not outrank the observed outcome');
  });

  it('still books it there for any other LOG_GAPS pattern', () => {
    for (const line of [
      'unrecognized configuration parameter "role"',
      'language "plpgsql" does not exist',
      'type "tsvector" does not exist',
    ]) {
      assert.equal(gapFor([line]).gap, 'row-order-unspecified', line);
    }
  });

  it('leaves the log attribution in place when the rows are genuinely wrong', () => {
    // Not order-only: a row is missing, so the database's complaint is the
    // explanation and must win.
    const t = gapFor(['text search configuration "english" does not exist'],
      [{ id: 1, name: 'a' }]);
    assert.equal(t.gap, 'missing-operator-fts');
  });

  it('leaves the log attribution in place when the status is also wrong', () => {
    // A 500 with reordered rows is not an ordering problem.
    const t = gapFor(['text search configuration "english" does not exist'],
      REVERSED, 500);
    assert.notEqual(t.gap, 'row-order-unspecified');
  });

  it('does not turn an order-only difference into a pass', () => {
    // The whole point of keeping these visible: they stay failures.
    const t = gapFor([]);
    assert.equal(t.status, 'fail');
  });
});

// A column DSQL refused to create is not measurable, whichever layer noticed it
// was missing. Upstream does not validate filter columns against its schema
// cache — it emits the column and lets PostgreSQL raise 42703 — so the same
// dropped `entities.arr` arrives as the engine's PGRST204 in a `select=` and as
// PostgreSQL's 42703 in an `or=(…)`. Before this rule the first was `blocked`
// and the second `fail`, which read as an engine gap that no engine change could
// close.
describe('triage: a dropped column is blocked however it surfaced', () => {
  const DROPPED = {
    object: 'public.entities.arr',
    kind: 'column',
    reason: 'column type integer[] not supported by DSQL',
  };
  const withDrop = () => ({
    catalog: { relations: new Set(['entities']), functions: new Set() },
    dropIndex: new Map([
      ['public.entities.arr', DROPPED],
      ['entities.arr', DROPPED],
    ]),
  });

  const errCase = (query) => ({
    id: 'AndOrParamsSpec:99',
    category: 'filters',
    bodyMatch: 'exact',
    request: { method: 'GET', path: '/entities', query, headers: {} },
    expected: { status: 200, body: [], bodyFormat: 'json', headers: {} },
  });

  function triageErr(query, body, statusCode = 400, ctxObj = withDrop()) {
    const tc = errCase(query);
    const actual = respond(body, statusCode);
    return triage({
      testCase: tc, actual, comparison: compare(tc, actual), thrown: null,
      logs: [], ctx: ctxObj,
    });
  }

  const pgErr = (message) => ({
    code: '42703', message, details: null, hint: null,
  });

  it('blocks the engine PGRST204 spelling', () => {
    const t = triageErr('select=arr', {
      code: 'PGRST204',
      message: "Could not find the 'arr' column of 'entities' in the schema "
        + 'cache',
      details: null,
      hint: null,
    });
    assert.equal(t.status, 'blocked');
    assert.equal(t.gap, 'no-array-columns');
  });

  it('blocks the qualified 42703 spelling', () => {
    const t = triageErr('or=(arr.cs.{1,2},id.eq.1)',
      pgErr('column entities.arr does not exist'));
    assert.equal(t.status, 'blocked');
    assert.equal(t.gap, 'no-array-columns');
    assert.match(t.reason, /dropped at fixture load/);
  });

  // Unqualified, so the column belongs to the relation under test.
  it('blocks the unquoted and quoted unqualified 42703 spellings', () => {
    for (const message of [
      'column arr does not exist',
      'column "arr" does not exist',
    ]) {
      const t = triageErr('arr=cs.{1,2}', pgErr(message));
      assert.equal(t.status, 'blocked', message);
      assert.equal(t.gap, 'no-array-columns', message);
    }
  });

  it('leaves a 42703 for a column that is not on the drop list a failure', () => {
    const t = triageErr('or=(nope.eq.1)',
      pgErr('column entities.nope does not exist'));
    assert.equal(t.status, 'fail');
    assert.notEqual(t.gap, 'no-array-columns');
  });

  // The drop list is the only evidence that admits a case; with an empty one
  // nothing is excluded.
  it('leaves a 42703 a failure when nothing was dropped', () => {
    const t = triageErr('arr=cs.{1,2}',
      pgErr('column entities.arr does not exist'), 400, ctx());
    assert.equal(t.status, 'fail');
  });

  // A non-42703 error that happens to mention a column is not this rule's
  // business — only PostgreSQL's undefined_column code counts.
  it('needs the 42703 code, not just the wording', () => {
    const t = triageErr('arr=cs.{1,2}', {
      code: '42883',
      message: 'operator does not exist: text @> text',
      details: null,
      hint: null,
    });
    assert.notEqual(t.status, 'blocked');
  });
});

// `harness-supplies-unverified-identity` used to be booked here, for the seven
// cases that assert an invalid JWT is rejected as a JWT (PGRST301) and instead
// got a policy denial (PGRST403): the harness stood in for the API Gateway
// authorizer and built its context from the unverified payload, so the token got
// through. The base engine now verifies the token itself with upstream's own
// secret (baseEngineConfig `restJwt`), so there is no harness gap left to
// attribute and no slug for it. What the runner must not do is quietly stop
// counting these: whatever bucket a surviving failure lands in, it stays a
// failure and stays in the denominator.
describe('triage: a rejected-token assertion is attributed to the engine', () => {
  const jwtCase = (over = {}) => ({
    id: 'AuthSpec:96',
    category: 'auth',
    bodyMatch: 'exact',
    request: { method: 'GET', path: '/authors_only', query: '', headers: {} },
    expected: {
      status: 401,
      body: {
        message: 'Empty JWT is sent in Authorization header',
        code: 'PGRST301', hint: null, details: null,
      },
      bodyFormat: 'json',
      headers: {},
    },
    ...over,
  });

  const denial = { code: 'PGRST403', message: 'Not authorized', details: null, hint: null };

  function triageJwt(logs = [], body = denial, statusCode = 401) {
    const tc = jwtCase();
    const actual = respond(body, statusCode);
    return triage({
      testCase: tc, actual, comparison: compare(tc, actual), thrown: null, logs, ctx: ctx(),
    });
  }

  it('no longer files anything under the retired harness slug', () => {
    for (const t of [triageJwt(), triageJwt(['unrecognized configuration '
      + 'parameter "role"'])]) {
      assert.notEqual(t.gap, 'harness-supplies-unverified-identity');
      assert.notEqual(t.gap, 'harness-no-jwt-verification');
    }
  });

  it('stays a failure and is not excluded from the rate', () => {
    for (const t of [
      triageJwt(),
      triageJwt(['unrecognized configuration parameter "role"']),
      triageJwt([], {
        code: 'PGRST301', message: 'something else', details: null, hint: null,
      }),
    ]) {
      assert.equal(t.status, 'fail',
        'a rejected-token assertion that did not match is still a gap; it must '
        + 'not leave the denominator');
    }
  });
});
