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

// The same discipline applied to a second misattribution, found by watching the
// gap histogram move after an unrelated change. Seven cases assert that an
// invalid JWT is rejected as a JWT (PGRST301). The harness stands in for the API
// Gateway authorizer and builds its context from the unverified payload, so the
// token gets through and Cedar denies it (PGRST403) instead. They were booked
// under `no-set-role` — the DSQL privilege gap — and when Cedar denials began
// answering 401 they scattered into three response-shape gaps, none of which
// names the cause. One slug now does.
describe('triage: an unverified-identity denial is not a privilege gap', () => {
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

  it('books a PGRST301 expectation answered PGRST403 under its own slug', () => {
    const t = triageJwt();
    assert.equal(t.status, 'fail');
    assert.equal(t.gap, 'harness-supplies-unverified-identity');
  });

  it('does so even when the log still carries a role-shaped complaint', () => {
    // This is what used to make it `no-set-role`.
    const t = triageJwt(['unrecognized configuration parameter "role"']);
    assert.equal(t.gap, 'harness-supplies-unverified-identity');
  });

  it('leaves a genuine PGRST301 mismatch alone', () => {
    // Right code, wrong message: that is a real response-shape difference and
    // must keep whatever gap the body comparison gives it.
    const t = triageJwt([], {
      code: 'PGRST301', message: 'something else', details: null, hint: null,
    });
    assert.notEqual(t.gap, 'harness-supplies-unverified-identity');
  });

  it('stays a failure and is not excluded from the rate', () => {
    const t = triageJwt();
    assert.equal(t.status, 'fail',
      'a harness gap is still a gap; it must not leave the denominator');
  });
});
