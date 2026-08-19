// Related order: `?order=<relation>(<column>)[.dir][.nulls]` orders the parent
// rows by a column of a to-one embed. Upstream parses it in
// `pOrderRelationTerm` (src/library/PostgREST/ApiRequest/QueryParams.hs) and
// the wire behaviour is covered by RelatedQueriesSpec.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseQuery } from '../query-parser.mjs';

function order(raw) {
  return parseQuery({ select: '*', order: raw }, 'GET').order;
}

describe('related order parsing', () => {
  it('reads relation, column, direction and nulls', () => {
    assert.deepStrictEqual(order('clients(name).desc.nullsfirst'), [{
      relation: 'clients',
      column: 'name',
      direction: 'desc',
      nulls: 'nullsfirst',
    }]);
  });

  it('defaults the direction like a plain order term', () => {
    assert.deepStrictEqual(order('clients(name)'), [{
      relation: 'clients', column: 'name', direction: 'asc', nulls: null,
    }]);
  });

  // A related term carries its own parentheses, so the comma split that
  // separates order terms has to ignore commas inside them.
  it('separates terms without breaking on the parentheses', () => {
    assert.deepStrictEqual(order('name.asc,clients(name).desc'), [
      { column: 'name', direction: 'asc', nulls: null },
      { relation: 'clients', column: 'name', direction: 'desc', nulls: null },
    ]);
  });

  it('keeps a json path inside a related term', () => {
    assert.deepStrictEqual(order('clients(data->>x)'), [{
      relation: 'clients',
      column: 'data',
      direction: 'asc',
      nulls: null,
      jsonPath: [{ op: '->>', kind: 'key', value: 'x' }],
    }]);
  });

  it('leaves a plain term alone', () => {
    assert.deepStrictEqual(order('id.desc'), [
      { column: 'id', direction: 'desc', nulls: null },
    ]);
  });

  it('rejects an unknown modifier on a related term', () => {
    assert.throws(
      () => order('clients(name).sideways'),
      (err) => err.code === 'PGRST100',
      'an unknown direction should raise PGRST100',
    );
  });
});
