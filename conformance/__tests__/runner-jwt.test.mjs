// Runner: minting the tokens upstream signed at runtime, and the header
// assertions the case format gained (CONTRACTS.md section 1).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  mintJwt, resolveJwtClaims, buildEvent, authorizerContext, compare, triage,
  buildResults,
} from '../runner/run.mjs';

const SECRET = 'reallyreallyreallyreallyverysafe';

function decode(part) {
  return JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'),
    'base64').toString('utf8'));
}

describe('resolveJwtClaims', () => {
  it('turns $secondsFromNow into an absolute epoch second', () => {
    const claims = resolveJwtClaims({ exp: { $secondsFromNow: -35 } }, 1000);
    assert.deepEqual(claims, { exp: 965 });
  });

  it('leaves everything else alone, at any depth', () => {
    const claims = resolveJwtClaims(
      { role: 'r', a: [{ nbf: { $secondsFromNow: 35 } }, 'x'], n: 1, z: null },
      1000);
    assert.deepEqual(claims, { role: 'r', a: [{ nbf: 1035 }, 'x'], n: 1, z: null });
  });

  it('does not treat a two-key object as a sentinel', () => {
    const claims = resolveJwtClaims({ $secondsFromNow: 1, other: 2 }, 1000);
    assert.deepEqual(claims, { $secondsFromNow: 1, other: 2 });
  });
});

describe('mintJwt', () => {
  it('signs HS256 over the spec secret, the way SpecHelper.hs does', () => {
    const token = mintJwt({ alg: 'HS256', secret: SECRET, claims: { role: 'r' } });
    const [h, p, s] = token.split('.');
    assert.deepEqual(decode(h), { alg: 'HS256', typ: 'JWT' });
    assert.deepEqual(decode(p), { role: 'r' });
    const expected = createHmac('sha256', SECRET).update(`${h}.${p}`)
      .digest('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    assert.equal(s, expected);
  });

  it('emits base64url with no padding', () => {
    const token = mintJwt({ alg: 'HS256', secret: SECRET, claims: { role: 'abcd' } });
    assert.doesNotMatch(token, /[+/=]/);
  });

  it('resolves relative claims at mint time', () => {
    const token = mintJwt(
      { alg: 'HS256', secret: SECRET, claims: { exp: { $secondsFromNow: -35 } } },
      2000);
    assert.deepEqual(decode(token.split('.')[1]), { exp: 1965 });
  });

  it('uses a different signature for a different secret', () => {
    const a = mintJwt({ alg: 'HS256', secret: SECRET, claims: { role: 'r' } });
    const b = mintJwt({ alg: 'HS256', secret: 'other', claims: { role: 'r' } });
    assert.notEqual(a.split('.')[2], b.split('.')[2]);
    assert.equal(a.split('.')[1], b.split('.')[1]);
  });

  it('refuses an algorithm it cannot reproduce', () => {
    assert.throws(
      () => mintJwt({ alg: 'RS256', secret: SECRET, claims: {} }),
      /unsupported JWT alg RS256/);
  });
});

describe('buildEvent with request.jwt', () => {
  const testCase = {
    id: 'AuthSpec:91',
    request: {
      method: 'GET',
      path: '/authors_only',
      query: '',
      headers: {},
      body: null,
      bodyFormat: 'none',
      jwt: { alg: 'HS256', secret: SECRET, claims: { role: 'postgrest_test_author' } },
    },
    expected: { status: 200 },
  };

  it('sets an Authorization: Bearer header the handler can read', () => {
    const ev = buildEvent(testCase, { nowSeconds: 1000 });
    assert.match(ev.headers.Authorization, /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    assert.deepEqual(ev.multiValueHeaders.Authorization,
      [ev.headers.Authorization]);
  });

  it('derives the authorizer role from the minted claims, not the default', () => {
    const ev = buildEvent(testCase, { role: 'anon', nowSeconds: 1000 });
    assert.equal(ev.requestContext.authorizer.role, 'postgrest_test_author');
  });

  it('leaves the default role in place when there is no jwt', () => {
    const plain = { id: 'x', request: { method: 'GET', path: '/items', headers: {} } };
    const ev = buildEvent(plain, { role: 'service_role' });
    assert.equal(ev.requestContext.authorizer.role, 'service_role');
    assert.equal('Authorization' in ev.headers, false);
  });

  it('an explicit Authorization header still wins for a case without a jwt', () => {
    const token = mintJwt({ alg: 'HS256', secret: SECRET, claims: { role: 'literal_role' } });
    const plain = {
      id: 'x',
      request: { method: 'GET', path: '/items', headers: { Authorization: `Bearer ${token}` } },
    };
    assert.equal(
      buildEvent(plain, { role: 'anon' }).requestContext.authorizer.role,
      'literal_role');
  });

  it('authorizerContext reads the claims of a minted token', () => {
    const token = mintJwt({
      alg: 'HS256',
      secret: SECRET,
      claims: { role: 'postgrest_test_author', sub: 'u-1', email: 'a@b.c' },
    });
    assert.deepEqual(
      authorizerContext({ Authorization: `Bearer ${token}` }, 'anon'),
      { role: 'postgrest_test_author', userId: 'u-1', email: 'a@b.c' });
  });
});

describe('compare: expected.headersAbsent', () => {
  const base = {
    id: 'x',
    bodyMatch: 'ignore',
    expected: { status: 204, bodyFormat: 'ignore', headers: {}, headersAbsent: ['Content-Length'] },
  };

  it('passes when the header is not there', () => {
    const c = compare(base, { statusCode: 204, headers: {}, body: '' });
    assert.equal(c.ok, true, c.diff);
    assert.deepEqual(c.headersPresentUnexpectedly, []);
  });

  it('fails when the header is present, even if empty', () => {
    const c = compare(base, { statusCode: 204, headers: { 'Content-Length': '' }, body: '' });
    assert.equal(c.ok, false);
    assert.deepEqual(c.headersPresentUnexpectedly, ['Content-Length']);
    assert.match(c.diff, /expected absent/);
  });

  it('matches the header name case-insensitively', () => {
    const c = compare(base, { statusCode: 204, headers: { 'content-length': '0' }, body: '' });
    assert.equal(c.ok, false);
    assert.deepEqual(c.headersPresentUnexpectedly, ['Content-Length']);
  });

  it('books the failure under its own gap slug', () => {
    const actual = { statusCode: 204, headers: { 'Content-Length': '0' }, body: '', json: null };
    const t = triage({
      testCase: { ...base, category: 'preferences' },
      actual,
      comparison: compare(base, actual),
      thrown: null,
      logs: [],
      ctx: { catalog: { relations: new Set(), functions: new Set() }, dropIndex: new Map() },
    });
    assert.equal(t.status, 'fail');
    assert.equal(t.gap, 'header-sent-unexpectedly-content-length');
  });
});

describe('compare: expected.headersContain', () => {
  const base = {
    id: 'x',
    bodyMatch: 'ignore',
    expected: {
      status: 200,
      bodyFormat: 'ignore',
      headers: {},
      headersContain: [{ name: 'Access-Control-Allow-Methods', value: 'POST' }],
    },
  };

  it('passes on a substring, not just equality', () => {
    const c = compare(base, {
      statusCode: 200,
      headers: { 'Access-Control-Allow-Methods': 'GET, POST, PATCH' },
      body: '',
    });
    assert.equal(c.ok, true, c.diff);
  });

  it('fails when the substring is missing', () => {
    const c = compare(base, {
      statusCode: 200,
      headers: { 'Access-Control-Allow-Methods': 'GET, PATCH' },
      body: '',
    });
    assert.equal(c.ok, false);
    assert.deepEqual(c.headerMismatches, ['Access-Control-Allow-Methods']);
  });

  it('fails when the header is absent', () => {
    const c = compare(base, { statusCode: 200, headers: {}, body: '' });
    assert.equal(c.ok, false);
    assert.match(c.diff, /<absent>/);
  });
});

describe('compare: expected.headersMatch', () => {
  const base = {
    id: 'x',
    bodyMatch: 'ignore',
    expected: {
      status: 200,
      bodyFormat: 'ignore',
      headers: {},
      headersMatch: [{ name: 'Server-Timing', pattern: 'parse;dur=[0-9]+.[0-9]+' }],
    },
  };

  it('passes when the value matches the regex', () => {
    const c = compare(base, {
      statusCode: 200,
      headers: { 'Server-Timing': 'jwt;dur=0.1, parse;dur=12.345' },
      body: '',
    });
    assert.equal(c.ok, true, c.diff);
  });

  it('fails when the metric is not reported', () => {
    const c = compare(base, {
      statusCode: 200,
      headers: { 'Server-Timing': 'jwt;dur=0.1' },
      body: '',
    });
    assert.equal(c.ok, false);
    assert.match(c.diff, /expected to match/);
  });

  it('fails when the header is absent entirely', () => {
    const c = compare(base, { statusCode: 200, headers: {}, body: '' });
    assert.equal(c.ok, false);
    assert.deepEqual(c.headerMismatches, ['Server-Timing']);
  });
});

describe('triage: needs-config is not a skip', () => {
  const ctx = {
    catalog: { relations: new Set(), functions: new Set() },
    dropIndex: new Map(),
  };
  const stub = {
    actual: { statusCode: null, headers: {}, body: null, json: null },
    comparison: { ok: false, statusOk: false, headerMismatches: [], bodyOk: false, diff: '' },
    thrown: null,
    logs: [],
    ctx,
  };

  it('reports needs-config for skipClass needs-engine-config', () => {
    const t = triage({
      ...stub,
      testCase: {
        id: 'QueryLimitedSpec:12',
        category: 'select',
        skip: true,
        skipClass: 'needs-engine-config',
        skipReason: 'requires non-default PostgREST config (configDbMaxRows)',
      },
    });
    assert.equal(t.status, 'needs-config');
    assert.equal(t.gap, 'needs-engine-config');
    assert.match(t.reason, /configDbMaxRows/);
  });

  it('still reports skip for a harness limitation', () => {
    const t = triage({
      ...stub,
      testCase: {
        id: 'RollbackSpec:49',
        category: 'rollback',
        skip: true,
        skipClass: 'not-representable',
        skipReason: 'request headers not representable',
      },
    });
    assert.equal(t.status, 'skip');
    assert.equal(t.gap, 'extraction-skipped');
  });
});

describe('buildResults: needsConfig is counted apart from skipped', () => {
  it('keeps needs-config out of skipped, errored and the pass rate', () => {
    const cases = [
      { id: 'a', category: 'select' },
      { id: 'b', category: 'select' },
      { id: 'c', category: 'select' },
      { id: 'd', category: 'select' },
    ];
    const outcomes = [
      { status: 'pass', gap: null, reason: null, actual: {} },
      { status: 'fail', gap: 'g', reason: 'r', actual: {} },
      { status: 'needs-config', gap: 'needs-engine-config', reason: 'r', actual: {} },
      { status: 'skip', gap: 'extraction-skipped', reason: 'r', actual: {} },
    ];
    const r = buildResults({ target: 'dsql', cases, outcomes, occ: null });
    assert.equal(r.totals.total, 4);
    assert.equal(r.totals.passed, 1);
    assert.equal(r.totals.failed, 1);
    assert.equal(r.totals.needsConfig, 1);
    assert.equal(r.totals.skipped, 1);
    assert.equal(r.totals.errored, 0);
    assert.equal(r.byCategory.select.needsConfig, 1);
    assert.equal(
      r.totals.passed + r.totals.failed + r.totals.skipped
      + r.totals.needsConfig + r.totals.blocked + r.totals.outOfScope
      + r.totals.errored,
      r.totals.total);
  });
});
