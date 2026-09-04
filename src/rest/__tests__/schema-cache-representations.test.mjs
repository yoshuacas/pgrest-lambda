// Data-representation introspection: the catalog's implicit domain <-> json /
// text cast functions (upstream SchemaCache.hs `dataRepresentations`) plus the
// declared manifest that stands in for them on a database which rejects
// CREATE CAST.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeDeclaredRepresentations,
  buildRepresentations,
} from '../schema-cache.mjs';

describe('normalizeDeclaredRepresentations', () => {
  it('keys an entry source|target', () => {
    const out = normalizeDeclaredRepresentations({
      representations: [
        { sourceType: 'color', targetType: 'json', function: 'public.json' },
      ],
    });
    assert.equal(out.length, 1);
    assert.equal(out[0].key, 'color|json');
    assert.equal(out[0].function, 'public.json');
  });

  it('accepts a bare array', () => {
    const out = normalizeDeclaredRepresentations([
      { sourceType: 'text', targetType: 'color', function: 'public.color' },
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0].key, 'text|color');
  });

  it('accepts a quoted function name, which is what regproc prints', () => {
    const out = normalizeDeclaredRepresentations([
      { sourceType: 'color', targetType: 'json', function: '"json"' },
    ]);
    assert.equal(out[0].function, '"json"');
  });

  it('skips an incomplete entry', () => {
    const out = normalizeDeclaredRepresentations([
      { sourceType: 'color', targetType: 'json' },
      { targetType: 'json', function: 'public.json' },
      null,
      'nope',
    ]);
    assert.deepEqual(out, []);
  });

  it('rejects a function name that is not an identifier', () => {
    // The name is emitted as SQL, so nothing but an identifier may pass.
    for (const fn of [
      'json(x); DROP TABLE t; --',
      'a.b.c',
      'json ',
      '1json',
    ]) {
      assert.throws(
        () => normalizeDeclaredRepresentations([
          { sourceType: 'color', targetType: 'json', function: fn },
        ]),
        /is not an identifier/,
        fn);
    }
  });

  it('returns nothing for an absent manifest', () => {
    assert.deepEqual(normalizeDeclaredRepresentations(null), []);
    assert.deepEqual(normalizeDeclaredRepresentations({}), []);
  });
});

describe('buildRepresentations', () => {
  const castRow = {
    source_type: 'color',
    target_type: 'json',
    cast_function: 'public.json',
  };

  it('keys the catalog rows source|target', () => {
    const out = buildRepresentations([castRow], null);
    assert.deepEqual(Object.keys(out), ['color|json']);
    assert.equal(out['color|json'].function, 'public.json');
    assert.equal(out['color|json'].source, 'catalog');
  });

  it('is empty when the database has no such cast', () => {
    assert.deepEqual(buildRepresentations([], null), {});
  });

  it('adds only the pairs the catalog did not report', () => {
    const out = buildRepresentations([castRow], {
      representations: [
        // Same pair: the catalog wins.
        { sourceType: 'color', targetType: 'json', function: 'other.json' },
        { sourceType: 'text', targetType: 'color', function: 'public.color' },
      ],
    });
    assert.equal(out['color|json'].function, 'public.json');
    assert.equal(out['text|color'].function, 'public.color');
    assert.equal(out['text|color'].source, 'declared');
  });

  it('drops a catalog row whose function name is not an identifier', () => {
    assert.deepEqual(
      buildRepresentations([{ ...castRow, cast_function: 'a.b.c' }], null),
      {});
  });
});
