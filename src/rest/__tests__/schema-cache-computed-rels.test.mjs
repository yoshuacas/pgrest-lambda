// Computed relationships, ported from upstream `allComputedRels`
// (src/library/PostgREST/SchemaCache.hs): a one-argument function whose
// argument type is the row type of a served relation and whose return type is
// the row type of another. `SETOF ... ROWS 1` or a plain composite return is a
// to-one embed; anything else is to-many.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildComputedRelationships } from '../schema-cache.mjs';

const tables = {
  projects: { columns: {}, primaryKey: ['id'] },
  clients: { columns: {}, primaryKey: ['id'] },
};

describe('buildComputedRelationships', () => {
  it('turns a row into a computed relationship', () => {
    const rels = buildComputedRelationships([
      {
        function_name: 'computed_clients',
        from_table: 'projects',
        to_table: 'clients',
        single_row: true,
      },
    ], tables);

    assert.deepStrictEqual(rels, [{
      computed: true,
      function: 'computed_clients',
      fromSchema: 'public',
      fromTable: 'projects',
      toSchema: 'public',
      toTable: 'clients',
      toOne: true,
      source: 'computed',
    }]);
  });

  it('marks a set-returning function as to-many', () => {
    const [rel] = buildComputedRelationships([
      {
        function_name: 'computed_projects',
        from_table: 'clients',
        to_table: 'projects',
        single_row: false,
      },
    ], tables);
    assert.equal(rel.toOne, false);
  });

  // The engine only serves the `public` schema, and a function over a relation
  // it does not serve can never be embedded, so it must not reach the cache
  // and offer a name that resolves to nothing.
  it('drops a relationship whose end is not served', () => {
    const rels = buildComputedRelationships([
      {
        function_name: 'computed_private',
        from_table: 'projects',
        to_table: 'private_thing',
        single_row: true,
      },
      {
        function_name: 'computed_from_private',
        from_table: 'private_thing',
        to_table: 'projects',
        single_row: true,
      },
    ], tables);
    assert.deepStrictEqual(rels, []);
  });

  it('returns nothing for no rows', () => {
    assert.deepStrictEqual(buildComputedRelationships([], tables), []);
  });
});
