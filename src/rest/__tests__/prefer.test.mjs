// Prefer request header parsing / validation / Preference-Applied echo.
// Behaviour is pinned to upstream `PostgREST.ApiRequest.Preferences`.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePrefer, assertValidPrefer, shouldCount, preferenceApplied,
} from '../handler.mjs';

describe('parsePrefer', () => {
  it('returns no preferences for a missing header', () => {
    const p = parsePrefer(undefined);
    assert.deepEqual(p.invalid, []);
    assert.equal(p.return, undefined);
    assert.equal(p.count, undefined);
  });

  it('parses the full closed vocabulary', () => {
    const p = parsePrefer(
      'resolution=merge-duplicates, return=representation, count=exact, '
      + 'tx=commit, missing=default, handling=strict');
    assert.equal(p.resolution, 'merge-duplicates');
    assert.equal(p.return, 'representation');
    assert.equal(p.count, 'exact');
    assert.equal(p.tx, 'commit');
    assert.equal(p.missing, 'default');
    assert.equal(p.handling, 'strict');
    assert.deepEqual(p.invalid, []);
  });

  it('tolerates whitespace around tokens', () => {
    const p = parsePrefer('  return=minimal ,   count=exact  ');
    assert.equal(p.return, 'minimal');
    assert.equal(p.count, 'exact');
    assert.deepEqual(p.invalid, []);
  });

  it('keeps the first occurrence of a repeated key', () => {
    const p = parsePrefer('return=minimal, return=representation');
    assert.equal(p.return, 'minimal');
    assert.deepEqual(p.invalid, []);
  });

  it('collects out-of-vocabulary values as invalid', () => {
    const p = parsePrefer('return=nonsense, count=whatever, bogus');
    assert.deepEqual(p.invalid, ['return=nonsense', 'count=whatever', 'bogus']);
    assert.equal(p.return, undefined);
    assert.equal(p.count, undefined);
  });

  it('accepts timezone= with any value', () => {
    const p = parsePrefer('timezone=America/Los_Angeles');
    assert.equal(p.timezone, 'America/Los_Angeles');
    assert.deepEqual(p.invalid, []);
  });

  it('accepts max-affected= and parses integers', () => {
    const p = parsePrefer('max-affected=10, handling=strict');
    assert.equal(p.maxAffected, 10);
    assert.deepEqual(p.invalid, []);
  });

  it('keeps an unparseable max-affected as an accepted no-op', () => {
    const p = parsePrefer('max-affected=abc');
    assert.equal(p.maxAffectedRaw, 'abc');
    assert.equal(p.maxAffected, undefined);
    assert.deepEqual(p.invalid, []);
  });
});

describe('assertValidPrefer', () => {
  it('does nothing without handling=strict', () => {
    assert.doesNotThrow(() => assertValidPrefer(parsePrefer('return=bogus')));
  });

  it('does nothing when handling=strict and everything is valid', () => {
    assert.doesNotThrow(
      () => assertValidPrefer(parsePrefer('handling=strict, count=exact')));
  });

  it('throws PGRST122 for an invalid preference under handling=strict', () => {
    assert.throws(
      () => assertValidPrefer(parsePrefer('handling=strict, foo=bar')),
      (err) => {
        assert.equal(err.statusCode, 400);
        assert.equal(err.code, 'PGRST122');
        assert.equal(err.message,
          'Invalid preferences given with handling=strict');
        assert.equal(err.details, 'Invalid preferences: foo=bar');
        return true;
      });
  });
});

describe('shouldCount', () => {
  it('is true for every count strategy', () => {
    // No usable planner estimate on DSQL, so planned/estimated both run the
    // exact count rather than reporting no total at all.
    assert.equal(shouldCount(parsePrefer('count=exact')), true);
    assert.equal(shouldCount(parsePrefer('count=estimated')), true);
    assert.equal(shouldCount(parsePrefer('count=planned')), true);
  });

  it('is false with no count preference', () => {
    assert.equal(shouldCount(parsePrefer('')), false);
    assert.equal(shouldCount(parsePrefer('return=minimal')), false);
  });
});

describe('preferenceApplied', () => {
  it('returns null when nothing applies', () => {
    assert.equal(preferenceApplied(parsePrefer(''), 'read'), null);
  });

  it('does not echo return= on a read', () => {
    assert.equal(
      preferenceApplied(parsePrefer('return=representation'), 'read'), null);
  });

  it('echoes count= on a read', () => {
    assert.equal(
      preferenceApplied(parsePrefer('count=exact'), 'read'), 'count=exact');
  });

  it('echoes return= on mutations', () => {
    for (const plan of ['create', 'update', 'delete', 'upsert']) {
      assert.equal(
        preferenceApplied(parsePrefer('return=minimal'), plan),
        'return=minimal', plan);
    }
  });

  it('echoes resolution= only on a create that can resolve', () => {
    const p = parsePrefer('resolution=merge-duplicates');
    assert.equal(preferenceApplied(p, 'create', { resolutionApplies: true }),
      'resolution=merge-duplicates');
    assert.equal(preferenceApplied(p, 'create', { resolutionApplies: false }),
      null);
    assert.equal(preferenceApplied(p, 'update'), null);
  });

  it('echoes missing= only on create and update', () => {
    const p = parsePrefer('missing=default');
    assert.equal(preferenceApplied(p, 'create'), 'missing=default');
    assert.equal(preferenceApplied(p, 'update'), 'missing=default');
    assert.equal(preferenceApplied(p, 'delete'), null);
    assert.equal(preferenceApplied(p, 'read'), null);
  });

  // Whichever ending the request asked for. The handler clears `prefer.tx`
  // when `db-tx-end` does not allow the override, so anything still set here
  // was applied — upstream does the same at parse time
  // (`Preferences.fromHeaders configDbTxAllowOverride`).
  it('echoes the transaction ending the request asked for', () => {
    assert.equal(preferenceApplied(parsePrefer('tx=commit'), 'read'),
      'tx=commit');
    assert.equal(preferenceApplied(parsePrefer('tx=rollback'), 'read'),
      'tx=rollback');
    assert.equal(preferenceApplied(parsePrefer(''), 'read'), null);
  });

  it('echoes max-affected only with handling=strict on update/delete/rpc',
    () => {
      const strict = parsePrefer('max-affected=5, handling=strict');
      assert.equal(preferenceApplied(strict, 'update'),
        'handling=strict, max-affected=5');
      assert.equal(preferenceApplied(strict, 'delete'),
        'handling=strict, max-affected=5');
      assert.equal(preferenceApplied(strict, 'rpc'),
        'handling=strict, max-affected=5');
      assert.equal(preferenceApplied(strict, 'create'), 'handling=strict');
      assert.equal(preferenceApplied(parsePrefer('max-affected=5'), 'update'),
        null);
    });

  it('emits the parts in upstream order', () => {
    const p = parsePrefer(
      'count=exact, handling=strict, return=representation, '
      + 'missing=default, resolution=merge-duplicates, tx=commit');
    assert.equal(
      preferenceApplied(p, 'create', { resolutionApplies: true }),
      'resolution=merge-duplicates, missing=default, return=representation, '
      + 'count=exact, tx=commit, handling=strict');
  });
});
