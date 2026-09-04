// int8/numeric wire fidelity: PostgREST returns bigint as a JSON number.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { parseExactNumber, installPgTypeParsers } from '../pg-types.mjs';

describe('parseExactNumber', () => {
  it('passes null through', () => {
    assert.equal(parseExactNumber(null), null);
    assert.equal(parseExactNumber(undefined), undefined);
  });

  it('converts small integers to numbers', () => {
    assert.equal(parseExactNumber('1'), 1);
    assert.equal(parseExactNumber('-42'), -42);
    assert.equal(parseExactNumber('0'), 0);
  });

  it('converts up to the safe integer boundary', () => {
    assert.equal(parseExactNumber('9007199254740991'), 9007199254740991);
  });

  it('keeps int8 beyond 2^53 as the exact digits', () => {
    // Number('9007199254740993') is 9007199254740992, so converting would
    // corrupt the value. PostgREST emits raw JSON digits; a string is the
    // closest lossless thing JSON.stringify can produce.
    assert.equal(parseExactNumber('9007199254740993'), '9007199254740993');
  });

  it('converts numeric values that round-trip', () => {
    assert.equal(parseExactNumber('1.5'), 1.5);
    assert.equal(parseExactNumber('-0.25'), -0.25);
  });

  // Trailing zeros state the column's declared scale, not a different value.
  // `sum` over numeric(19,6) prints "8800.000000" and `avg` prints
  // "1100.0000000000000000"; both are exactly the integers upstream emits as
  // JSON numbers (AggregateFunctionsSpec:39, :42), so the conversion is
  // lossless and must happen.
  it('drops trailing zeros that only state the numeric scale', () => {
    assert.equal(parseExactNumber('0.50'), 0.5);
    assert.equal(parseExactNumber('1.000'), 1);
    assert.equal(parseExactNumber('8800.000000'), 8800);
    assert.equal(parseExactNumber('1100.0000000000000000'), 1100);
    assert.equal(parseExactNumber('100.500'), 100.5);
    assert.equal(parseExactNumber('0.000000'), 0);
    assert.equal(parseExactNumber('-2.50'), -2.5);
  });

  it('does not touch zeros that carry value', () => {
    // No decimal point, so the zeros are significant digits.
    assert.equal(parseExactNumber('1000'), 1000);
    assert.equal(parseExactNumber('9007199254740000'), 9007199254740000);
  });

  it('keeps a numeric that needs more precision than a double has', () => {
    // Normalising the scale does not make these representable.
    assert.equal(parseExactNumber('1.234567890123456789'),
      '1.234567890123456789');
    assert.equal(parseExactNumber('0.100000000000000000000001'),
      '0.100000000000000000000001');
  });

  it('keeps NaN and Infinity as text', () => {
    assert.equal(parseExactNumber('NaN'), 'NaN');
    assert.equal(parseExactNumber('Infinity'), 'Infinity');
  });
});

describe('installPgTypeParsers', () => {
  it('registers int8 and numeric parsers and is idempotent', () => {
    installPgTypeParsers();
    installPgTypeParsers();

    assert.equal(pg.types.getTypeParser(20, 'text')('7'), 7);
    assert.equal(pg.types.getTypeParser(1700, 'text')('7.5'), 7.5);
  });

  it('maps int8[] elements through the same conversion', () => {
    installPgTypeParsers();
    assert.deepEqual(pg.types.getTypeParser(1016, 'text')('{1,2,3}'),
      [1, 2, 3]);
    assert.deepEqual(
      pg.types.getTypeParser(1016, 'text')('{9007199254740993}'),
      ['9007199254740993']);
  });
});
