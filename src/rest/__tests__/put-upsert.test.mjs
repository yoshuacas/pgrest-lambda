// PUT single-row upsert guards (upstream PGRST105 / PGRST115).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assertPutFilters, pickPutRow } from '../handler.mjs';

const eq = (column, value, extra = {}) => ({
  type: 'filter', column, operator: 'eq', value, negate: false, ...extra,
});

describe('assertPutFilters', () => {
  it('accepts one eq filter on a single-column primary key', () => {
    assert.doesNotThrow(() => assertPutFilters([eq('id', '1')], ['id']));
  });

  it('accepts eq filters covering a composite primary key', () => {
    assert.doesNotThrow(() => assertPutFilters(
      [eq('k1', '1'), eq('k2', '2')], ['k1', 'k2']));
  });

  const rejects = (filters, pk, why) => {
    assert.throws(() => assertPutFilters(filters, pk), (err) => {
      assert.equal(err.statusCode, 405, why);
      assert.equal(err.code, 'PGRST105');
      assert.equal(err.message,
        "Filters must include all and only primary key columns "
        + "with 'eq' operators");
      return true;
    }, why);
  };

  it('rejects no filters at all', () => {
    rejects([], ['id'], 'unfiltered PUT');
  });

  it('rejects a non-primary-key column', () => {
    rejects([eq('name', 'x')], ['id'], 'wrong column');
  });

  it('rejects a partially specified composite key', () => {
    rejects([eq('k1', '1')], ['k1', 'k2'], 'missing key column');
  });

  it('rejects an extra filter alongside the key', () => {
    rejects([eq('id', '1'), eq('name', 'x')], ['id'], 'extra filter');
  });

  it('rejects a non-eq operator', () => {
    rejects([{ ...eq('id', '1'), operator: 'gt' }], ['id'], 'gt');
  });

  it('rejects a negated eq', () => {
    rejects([eq('id', '1', { negate: true })], ['id'], 'not.eq');
  });

  it('rejects a quantified eq', () => {
    rejects([eq('id', '1', { quantifier: 'any' })], ['id'], 'eq(any)');
  });

  it('rejects a logical group', () => {
    rejects([{ type: 'logicalGroup', logicalOp: 'or', conditions: [] }],
      ['id'], 'or()');
  });

  it('rejects a table with no primary key', () => {
    rejects([eq('id', '1')], [], 'no pk');
  });
});

describe('pickPutRow', () => {
  it('returns the single matching row', () => {
    const row = { id: 1, name: 'a' };
    assert.equal(pickPutRow([eq('id', '1')], ['id'], [row]), row);
  });

  it('accepts a bare object payload', () => {
    const row = { id: 1, name: 'a' };
    assert.equal(pickPutRow([eq('id', '1')], ['id'], row), row);
  });

  it('matches on a composite key', () => {
    const row = { k1: 1, k2: 2 };
    assert.equal(
      pickPutRow([eq('k1', '1'), eq('k2', '2')], ['k1', 'k2'], [row]), row);
  });

  const rejects = (filters, pk, body, why) => {
    assert.throws(() => pickPutRow(filters, pk, body), (err) => {
      assert.equal(err.statusCode, 400, why);
      assert.equal(err.code, 'PGRST115');
      assert.equal(err.message,
        'Payload values do not match URL in primary key column(s)');
      return true;
    }, why);
  };

  it('rejects a payload key that differs from the URL', () => {
    rejects([eq('id', '1')], ['id'], [{ id: 2 }], 'mismatched pk');
  });

  it('rejects a payload missing the key column', () => {
    rejects([eq('id', '1')], ['id'], [{ name: 'a' }], 'absent pk');
  });

  it('rejects an empty payload', () => {
    rejects([eq('id', '1')], ['id'], [], 'empty array');
    rejects([eq('id', '1')], ['id'], null, 'null body');
  });

  it('rejects more than one matching row', () => {
    rejects([eq('id', '1')], ['id'],
      [{ id: 1, n: 'a' }, { id: 1, n: 'b' }], 'two matches');
  });

  it('rejects a composite key where only part matches', () => {
    rejects([eq('k1', '1'), eq('k2', '2')], ['k1', 'k2'],
      [{ k1: 1, k2: 9 }], 'half match');
  });
});
