// Range request handling and the Content-Range response header.
// Behaviour is pinned to upstream `PostgREST.RangeQuery`.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  contentRangeH, rangeStatus, parseRangeHeader, effectiveRange,
} from '../handler.mjs';

describe('contentRangeH', () => {
  it('renders a populated window', () => {
    assert.equal(contentRangeH(0, 14, null), '0-14/*');
    assert.equal(contentRangeH(0, 14, 15), '0-14/15');
    assert.equal(contentRangeH(1, 2, 15), '1-2/15');
  });

  it('renders * for an empty result', () => {
    // total 0: no rows exist at all
    assert.equal(contentRangeH(0, -1, 0), '*/0');
    // lower > upper: the window itself is empty
    assert.equal(contentRangeH(1, 0, 15), '*/15');
    assert.equal(contentRangeH(0, -1, null), '*/*');
  });

  it('renders the insert/delete form', () => {
    assert.equal(contentRangeH(1, 0, null), '*/*');
    assert.equal(contentRangeH(1, 0, 3), '*/3');
  });
});

describe('rangeStatus', () => {
  it('is 200 when no count was requested', () => {
    assert.equal(rangeStatus(0, 4, null), 200);
    assert.equal(rangeStatus(10, 14, null), 200);
  });

  it('is 200 when the window covers everything', () => {
    assert.equal(rangeStatus(0, 14, 15), 200);
  });

  it('is 206 for a partial window', () => {
    assert.equal(rangeStatus(0, 1, 15), 206);
    assert.equal(rangeStatus(5, 9, 15), 206);
  });

  it('is 416 when the offset is past the end', () => {
    assert.equal(rangeStatus(16, 20, 15), 416);
  });

  it('is 206, not 416, for an offset exactly at the total', () => {
    // Upstream only 416s on `lower > total`, so an offset equal to the total
    // returns an empty 206 body.
    assert.equal(rangeStatus(15, 14, 15), 206);
  });
});

describe('parseRangeHeader', () => {
  it('returns null for a missing header', () => {
    assert.equal(parseRangeHeader(undefined), null);
    assert.equal(parseRangeHeader(null), null);
  });

  it('parses a bare lower-upper pair', () => {
    assert.deepEqual(parseRangeHeader('0-1'), { lower: 0, upper: 1 });
  });

  it('parses an open-ended range', () => {
    assert.deepEqual(parseRangeHeader('5-'), { lower: 5, upper: null });
  });

  it('accepts a unit prefix', () => {
    assert.deepEqual(parseRangeHeader('items=0-1'), { lower: 0, upper: 1 });
    assert.deepEqual(parseRangeHeader('bytes=2-3'), { lower: 2, upper: 3 });
  });

  it('returns null for anything unparseable', () => {
    assert.equal(parseRangeHeader('nonsense'), null);
    assert.equal(parseRangeHeader('-1'), null);
    assert.equal(parseRangeHeader('0-1, 3-4'), null);
  });
});

describe('effectiveRange', () => {
  it('passes through limit/offset with no Range header', () => {
    assert.deepEqual(effectiveRange({ limit: 5, offset: 10 }, null),
      { limit: 5, offset: 10, lower: 10 });
  });

  it('is unbounded with neither limit nor Range', () => {
    assert.deepEqual(effectiveRange({ limit: null, offset: 0 }, null),
      { limit: null, offset: 0, lower: 0 });
  });

  it('short-circuits limit=0 and drops the offset', () => {
    assert.deepEqual(effectiveRange({ limit: 0, offset: 7 }, null),
      { limit: 0, offset: 0, lower: 0 });
  });

  it('uses the Range header when there is no limit', () => {
    assert.deepEqual(
      effectiveRange({ limit: null, offset: 0 }, { lower: 1, upper: 2 }),
      { limit: 2, offset: 1, lower: 1 });
  });

  it('keeps an open-ended Range header open', () => {
    assert.deepEqual(
      effectiveRange({ limit: null, offset: 0 }, { lower: 3, upper: null }),
      { limit: null, offset: 3, lower: 3 });
  });

  it('intersects the Range header with limit/offset', () => {
    // offset=1,limit=5 -> 1..5 ; header 0..2 -> intersection 1..2
    assert.deepEqual(
      effectiveRange({ limit: 5, offset: 1 }, { lower: 0, upper: 2 }),
      { limit: 2, offset: 1, lower: 1 });
  });

  it('throws PGRST103 for a Range header with upper < lower', () => {
    assert.throws(
      () => effectiveRange({ limit: null, offset: 0 },
        { lower: 2, upper: 1 }),
      (err) => {
        assert.equal(err.statusCode, 416);
        assert.equal(err.code, 'PGRST103');
        assert.equal(err.details,
          'The lower boundary must be lower than or equal to the upper '
          + 'boundary in the Range header.');
        return true;
      });
  });

  // RangeSpec.hs:253 "succeeds if offset is negative as a no-op". Upstream
  // intersects the query-string window with `allRange` (0 to infinity) in
  // `getRanges`, so the lower bound cannot go below 0.
  it('treats a negative offset as a no-op', () => {
    assert.deepEqual(effectiveRange({ limit: null, offset: -4 }, null),
      { limit: null, offset: 0, lower: 0 });
  });

  it('keeps the upper bound a negative offset implied', () => {
    // offset=-4,limit=10 -> -4..5 ; intersected with 0..inf -> 0..5
    assert.deepEqual(effectiveRange({ limit: 10, offset: -4 }, null),
      { limit: 6, offset: 0, lower: 0 });
  });

  it('throws PGRST103 when a negative offset leaves an empty window', () => {
    // offset=-4,limit=3 -> -4..-2 ; intersected with 0..inf -> empty
    assert.throws(
      () => effectiveRange({ limit: 3, offset: -4 }, null),
      (err) => {
        assert.equal(err.statusCode, 416);
        assert.equal(err.code, 'PGRST103');
        return true;
      });
  });

  it('throws PGRST103 for a negative limit', () => {
    assert.throws(
      () => effectiveRange({ limit: -1, offset: 0 }, null),
      (err) => {
        assert.equal(err.statusCode, 416);
        assert.equal(err.code, 'PGRST103');
        assert.equal(err.details,
          'Limit should be greater than or equal to zero.');
        return true;
      });
  });
});
