// Tests for the Cedar equivalence runner's own logic.
//
// The runner delegates the comparison to conformance/runner/run.mjs's
// `compare()` on purpose, so what is left to test here is argument handling,
// selection, the verdict vocabulary, and the rule that the summary never
// produces a number combining this score with the PostgREST pass rate.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  divergenceKind,
  parseArgs,
  recordBody,
  selectDerived,
  summarize,
  verdictFor,
  withContentLength,
} from '../run.mjs';

describe('parseArgs', () => {
  it('defaults to the DSQL target and the repo results directory', () => {
    const opts = parseArgs([]);
    assert.equal(opts.target, 'dsql');
    assert.deepEqual(opts.ids, []);
    assert.equal(opts.timeout, 30000);
    assert.match(opts.outDir, /conformance\/cedar\/results$/);
    assert.equal(opts.list, false);
    assert.equal(opts.help, false);
  });

  it('collects repeated --id flags', () => {
    const opts = parseArgs(['--id', 'Cedar:AuthSpec:73', '--id', 'Cedar:Auth']);
    assert.deepEqual(opts.ids, ['Cedar:AuthSpec:73', 'Cedar:Auth']);
  });

  it('parses the remaining options', () => {
    const opts = parseArgs(['--target', 'postgres', '--timeout', '5000',
      '--out-dir', '/tmp/x', '--list']);
    assert.equal(opts.target, 'postgres');
    assert.equal(opts.timeout, 5000);
    assert.equal(opts.outDir, '/tmp/x');
    assert.equal(opts.list, true);
  });

  it('rejects an unknown option rather than ignoring it', () => {
    assert.throws(() => parseArgs(['--skip-failures']), /unknown option/);
  });
});

describe('selectDerived', () => {
  const cases = [
    { id: 'Cedar:AuthSpec:16', upstreamId: 'AuthSpec:16' },
    { id: 'Cedar:AuthSpec:73', upstreamId: 'AuthSpec:73' },
    { id: 'Cedar:ErrorSpec:123', upstreamId: 'ErrorSpec:123' },
  ];

  it('selects everything when no id is given', () => {
    assert.equal(selectDerived(cases, []).length, 3);
  });

  it('selects by exact derived id', () => {
    assert.deepEqual(selectDerived(cases, ['Cedar:AuthSpec:73'])
      .map((c) => c.id), ['Cedar:AuthSpec:73']);
  });

  it('selects by prefix', () => {
    assert.equal(selectDerived(cases, ['Cedar:AuthSpec']).length, 2);
  });

  it('selects by the upstream id it mirrors', () => {
    assert.deepEqual(selectDerived(cases, ['ErrorSpec:123'])
      .map((c) => c.id), ['Cedar:ErrorSpec:123']);
  });

  it('selects nothing for an unknown id', () => {
    assert.deepEqual(selectDerived(cases, ['Nope']), []);
  });
});

describe('verdictFor', () => {
  it('has exactly two verdicts', () => {
    assert.equal(verdictFor({ ok: true }), 'hold');
    assert.equal(verdictFor({ ok: false }), 'diverges');
    // No skip, no blocked, no needs-config: a derived case cannot leave the
    // denominator at run time.
    assert.equal(verdictFor({ ok: false, orderOnly: true }), 'diverges');
    assert.equal(verdictFor({ ok: false, bytesOnly: true }), 'diverges');
    assert.equal(verdictFor({ ok: false, numericAsString: true }), 'diverges');
  });
});

describe('divergenceKind', () => {
  const derived = (status) => ({ expected: { status } });

  it('names the 401-vs-403 denial shape specifically', () => {
    assert.equal(
      divergenceKind(derived(401), 403, { statusOk: false }),
      'deny-status-401-vs-403');
  });

  it('reports any other status mismatch as a plain status divergence', () => {
    assert.equal(divergenceKind(derived(200), 403, { statusOk: false }),
      'status');
    assert.equal(divergenceKind(derived(401), 500, { statusOk: false }),
      'status');
    assert.equal(divergenceKind(derived(403), 401, { statusOk: false }),
      'status');
  });

  it('reports a body divergence', () => {
    assert.equal(
      divergenceKind(derived(200), 200, { statusOk: true, bodyOk: false }),
      'body');
  });

  it('reports header divergences, both missing and unexpected', () => {
    assert.equal(divergenceKind(derived(401), 401, {
      statusOk: true, bodyOk: true, headerMismatches: ['WWW-Authenticate'],
    }), 'headers');
    assert.equal(divergenceKind(derived(200), 200, {
      statusOk: true, bodyOk: true, headersPresentUnexpectedly: ['X-Thing'],
    }), 'headers');
  });

  it('falls back to unknown rather than guessing', () => {
    assert.equal(
      divergenceKind(derived(200), 200, { statusOk: true, bodyOk: true }),
      'unknown');
  });

  it('does not need an expected status to classify', () => {
    assert.equal(divergenceKind({}, 403, { statusOk: false }), 'status');
  });
});

describe('withContentLength', () => {
  it('fills in the byte length API Gateway would add', () => {
    const headers = withContentLength({ headers: {}, body: 'hello' });
    assert.equal(headers['Content-Length'], '5');
  });

  it('counts bytes, not characters', () => {
    const headers = withContentLength({ headers: {}, body: '¡olé!' });
    assert.equal(headers['Content-Length'], '7');
  });

  it('counts decoded bytes for a base64 body', () => {
    const headers = withContentLength({
      headers: {},
      body: Buffer.from([1, 2, 3, 4]).toString('base64'),
      isBase64Encoded: true,
    });
    assert.equal(headers['Content-Length'], '4');
  });

  it('leaves an existing Content-Length alone, whatever its casing', () => {
    const headers = withContentLength({
      headers: { 'content-length': '99' }, body: 'hello',
    });
    assert.equal(headers['content-length'], '99');
    assert.equal(headers['Content-Length'], undefined);
  });

  it('adds nothing for an empty or absent body', () => {
    assert.deepEqual(withContentLength({ headers: {}, body: '' }), {});
    assert.deepEqual(withContentLength({ headers: {}, body: null }), {});
    assert.deepEqual(withContentLength({}), {});
  });

  it('does not mutate the response headers', () => {
    const response = { headers: {}, body: 'hello' };
    withContentLength(response);
    assert.deepEqual(response.headers, {});
  });
});

describe('recordBody', () => {
  it('records a short body verbatim', () => {
    assert.equal(recordBody('{"a":1}'), '{"a":1}');
  });

  it('records an empty body as null', () => {
    assert.equal(recordBody(''), null);
    assert.equal(recordBody(null), null);
    assert.equal(recordBody(undefined), null);
  });

  it('truncates a long body and says how long it was', () => {
    const out = recordBody('x'.repeat(5000));
    assert.match(out, /…\[5000 chars\]$/);
    assert.ok(out.length < 5000);
  });
});

describe('summarize', () => {
  const doc = {
    counts: { upstreamCases: 54 },
    noFairEquivalent: [
      { class: 'jwt-verification' },
      { class: 'jwt-verification' },
      { class: 'column-level-privilege' },
    ],
  };
  const outcomes = [
    { verdict: 'hold', divergence: null },
    { verdict: 'hold', divergence: null },
    { verdict: 'diverges', divergence: 'deny-status-401-vs-403' },
    { verdict: 'diverges', divergence: 'body' },
  ];

  it('counts holds, divergences and their kinds', () => {
    const s = summarize(doc, outcomes);
    assert.equal(s.measurement, 'cedar-equivalence');
    assert.equal(s.equivalencesRan, 4);
    assert.equal(s.equivalencesHold, 2);
    assert.equal(s.equivalencesDiverge, 2);
    assert.deepEqual(s.divergenceKinds,
      { 'deny-status-401-vs-403': 1, body: 1 });
  });

  it('reports the non-equivalences outside the denominator', () => {
    const s = summarize(doc, outcomes);
    assert.equal(s.noFairEquivalent, 3);
    assert.deepEqual(s.noFairEquivalentByClass,
      { 'jwt-verification': 2, 'column-level-privilege': 1 });
    // The denominator is the derived cases only; the 26 cases with no fair
    // equivalent are reported beside it, never folded into it.
    assert.equal(s.equivalencesRan, outcomes.length);
    assert.equal(s.upstreamCasesCovered, 54);
  });

  it('emits no number combining this score with the PostgREST rate', () => {
    const s = summarize(doc, outcomes);
    // The only key allowed to mention PostgREST is the disclaimer itself.
    const keys = Object.keys(s).filter((k) => k !== 'notThePostgrestRate');
    for (const k of keys) {
      assert.doesNotMatch(k, /postgrest/i,
        `summary key "${k}" must not mix the two measurements`);
      assert.doesNotMatch(String(s[k]), /pass rate/i,
        `summary value "${k}" must not present itself as a pass rate`);
    }
    assert.equal(s.percent, undefined);
    assert.equal(s.combined, undefined);
    assert.equal(s.total, undefined);
    assert.equal(s.rate, undefined);
    // The one PostgREST mention is the disclaimer, and it disclaims.
    assert.match(s.notThePostgrestRate, /never added to one/);
    assert.match(s.notThePostgrestRate, /remain failures/);
  });

  it('holds + diverges is the whole denominator', () => {
    const s = summarize(doc, outcomes);
    assert.equal(s.equivalencesHold + s.equivalencesDiverge, s.equivalencesRan);
  });
});
