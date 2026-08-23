// Tests for the Cedar equivalence derivation.
//
// The load-bearing test in this file is "derived cases do not weaken the
// upstream expectation": the whole measurement is worthless if the derivation
// can quietly relax a status, a body or a matcher. Everything else here guards
// the bookkeeping around that.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  CASES_PATH,
  CONFIG_FIELDS,
  GROUP_PATH,
  VERBATIM,
  build,
  deriveCases,
  establishesIdentity,
  isWrite,
  loadUpstreamCases,
  readDerived,
} from '../derive.mjs';
import { EQUIVALENCE_MAP } from '../equivalence-map.mjs';

const group = JSON.parse(readFileSync(GROUP_PATH, 'utf8'));
const upstream = loadUpstreamCases();
const doc = readDerived();

describe('establishesIdentity', () => {
  it('is true for a runtime-minted token', () => {
    assert.equal(establishesIdentity({ jwt: { role: 'x' } }), true);
  });

  it('is true for a literal Authorization header, any casing', () => {
    assert.equal(
      establishesIdentity({ headers: { Authorization: 'Bearer x' } }), true);
    assert.equal(
      establishesIdentity({ headers: { authorization: 'Bearer x' } }), true);
    assert.equal(
      establishesIdentity({ headers: { AUTHORIZATION: 'Bearer x' } }), true);
  });

  it('is false when the request carries no identity at all', () => {
    assert.equal(establishesIdentity({ headers: { Accept: '*/*' } }), false);
    assert.equal(establishesIdentity({}), false);
    assert.equal(establishesIdentity(undefined), false);
  });
});

describe('isWrite', () => {
  it('treats reads as reads', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS', 'get']) {
      assert.equal(isWrite({ method, path: '/authors_only' }), false, method);
    }
  });

  it('treats a table mutation as a write', () => {
    assert.equal(isWrite({ method: 'POST', path: '/insertonly' }), true);
    assert.equal(isWrite({ method: 'PATCH', path: '/app_users' }), true);
    assert.equal(isWrite({ method: 'DELETE', path: '/app_users' }), true);
  });

  it('does not treat an RPC call as a write', () => {
    assert.equal(isWrite({ method: 'POST', path: '/rpc/privileged_hello' }),
      false);
  });

  it('defaults a missing method to GET', () => {
    assert.equal(isWrite({ path: '/authors_only' }), false);
  });
});

describe('deriveCases', () => {
  it('has a verdict for every upstream case in the group', () => {
    const withoutVerdict = group.upstreamCases
      .map((c) => c.id).filter((id) => !EQUIVALENCE_MAP[id]);
    assert.deepEqual(withoutVerdict, []);
  });

  it('throws rather than silently dropping a case with no verdict', () => {
    assert.throws(
      () => deriveCases(upstream, group, {}),
      /no equivalence verdict or no upstream case for/);
  });

  it('throws when the upstream case behind a verdict has vanished', () => {
    const id = group.upstreamCases[0].id;
    const pruned = new Map(upstream);
    pruned.delete(id);
    assert.throws(() => deriveCases(pruned, group), new RegExp(id));
  });

  it('accounts for every upstream case exactly once', () => {
    assert.equal(doc.counts.upstreamCases, group.upstreamCases.length);
    assert.equal(
      doc.counts.derived + doc.counts.noFairEquivalent,
      doc.counts.upstreamCases);
    assert.equal(doc.cases.length, doc.counts.derived);
    assert.equal(doc.noFairEquivalent.length, doc.counts.noFairEquivalent);

    const seen = new Set([
      ...doc.cases.map((c) => c.upstreamId),
      ...doc.noFairEquivalent.map((n) => n.upstreamId),
    ]);
    assert.equal(seen.size, group.upstreamCases.length);
  });

  it('the committed cases.json matches what derive.mjs builds', () => {
    // Same assertion `derive.mjs --check` makes, so a stale file fails the
    // unit suite too and not only the generator.
    assert.equal(
      readFileSync(CASES_PATH, 'utf8'),
      `${JSON.stringify(build(), null, 2)}\n`);
  });

  it('every derived id is unique and namespaced', () => {
    const ids = doc.cases.map((c) => c.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const c of doc.cases) {
      assert.equal(c.id, `Cedar:${c.upstreamId}`);
    }
  });

  it('carries the four disclosures every derived case must have', () => {
    for (const c of doc.cases) {
      assert.equal(typeof c.upstreamId, 'string', c.id);
      assert.ok(c.upstreamMechanism && c.upstreamMechanism.length > 20, c.id);
      assert.ok(c.cedarMechanism && c.cedarMechanism.length > 20, c.id);
      assert.ok(c.doNotRead && c.doNotRead.length > 20, c.id);
    }
  });

  it('records a class, a reason and a caveat for every non-equivalence', () => {
    const classes = new Set(['jwt-verification', 'session-identity-guc',
      'column-level-privilege', 'extraction-defect']);
    for (const n of doc.noFairEquivalent) {
      assert.ok(classes.has(n.class), `${n.upstreamId}: ${n.class}`);
      assert.ok(n.reason && n.reason.length > 40, n.upstreamId);
      assert.ok(n.doNotRead && n.doNotRead.length > 20, n.upstreamId);
      assert.ok(n.upstreamMechanism, n.upstreamId);
    }
  });

  it('derived cases do not weaken the upstream expectation', () => {
    // The anti-inflation assertion. Every field that decides pass or fail must
    // be identical to the extracted upstream case; only the mechanism differs.
    for (const c of doc.cases) {
      const src = upstream.get(c.upstreamId);
      assert.ok(src, c.upstreamId);
      for (const field of VERBATIM) {
        assert.deepEqual(c[field], src[field],
          `${c.id}: field "${field}" differs from the upstream case`);
      }
    }
  });

  it('copies the per-case engine-config fields so the same server settings '
     + 'apply', () => {
    for (const c of doc.cases) {
      const src = upstream.get(c.upstreamId);
      for (const field of CONFIG_FIELDS) {
        assert.deepEqual(field in c ? c[field] : undefined,
          field in src ? src[field] : undefined, `${c.id}: ${field}`);
      }
    }
  });

  it('no derived case is marked skipped', () => {
    // A skip is how a second measurement would start flattering itself.
    for (const c of doc.cases) assert.equal(c.skip, false, c.id);
  });

  it('no derived case writes to the shared fixtures', () => {
    for (const c of doc.cases) assert.equal(c.write, false, c.id);
  });

  it('runs an identity-less request as anon, not as the runner default', () => {
    for (const c of doc.cases) {
      const expected = establishesIdentity(c.request) ? null : 'anon';
      assert.equal(c.defaultRole, expected, c.id);
    }
    // At least one case has to exercise the anonymous path, or the deny
    // equivalences are not measuring the anonymous grant at all.
    assert.ok(doc.cases.some((c) => c.defaultRole === 'anon'));
  });

  it('names the equivalence policy set, never the shipped one', () => {
    assert.equal(doc.policySet, 'conformance/cedar/policies');
    for (const c of doc.cases) {
      assert.equal(c.policySet, 'conformance/cedar/policies', c.id);
      if (c.policyFile) {
        assert.match(c.policyFile, /^conformance\/cedar\/policies\//);
      }
    }
  });

  it('states in the document itself that this is not the PostgREST rate', () => {
    assert.match(doc.description, /SECOND measurement/);
    assert.match(doc.description, /never added to the PostgREST pass/);
    // The old wording asserted here — "the upstream cases stay failures in the
    // PostgREST rate" — stopped being true when the conformance runner started
    // loading its own port of the same GRANTs. What must stay pinned is the rule
    // that survived the change: a holding equivalence is never added to the rate.
    assert.match(doc.doNotReadOverall, /never an addition to it/);
    assert.doesNotMatch(doc.doNotReadOverall, /stay failures/);
  });
});
