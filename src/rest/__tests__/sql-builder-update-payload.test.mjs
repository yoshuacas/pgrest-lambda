// sql-builder-update-payload.test.mjs — the shape of a PATCH payload.
//
// Upstream takes a mutation payload as a list of rows, so `{"a":1}` and
// `[{"a":1}]` are the same update. Reading the array directly would take its
// indices for column names.
//
//   node --test src/rest/__tests__/sql-builder-update-payload.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildUpdate } from '../sql-builder.mjs';

const schema = {
  tables: {
    items: {
      columns: {
        id: { type: 'int8', nullable: false, defaultValue: null },
        name: { type: 'text', nullable: true, defaultValue: null },
      },
      primaryKey: ['id'],
    },
  },
};

const parsed = {
  select: [{ type: 'column', name: '*' }],
  filters: [{ column: 'id', operator: 'eq', value: '1', negate: false }],
  order: [],
  limit: null,
  offset: 0,
};

describe('buildUpdate payload shape', () => {
  it('updates from a plain object', () => {
    const { text, values } = buildUpdate(
      'items', { name: 'updated' }, parsed, schema);
    assert.equal(text,
      'UPDATE "items" SET "name" = $1 WHERE "id" = $2 RETURNING *');
    assert.deepStrictEqual(values, ['updated', '1']);
  });

  it('updates from a one-element array the same way', () => {
    const { text, values } = buildUpdate(
      'items', [{ name: 'updated' }], parsed, schema);
    assert.equal(text,
      'UPDATE "items" SET "name" = $1 WHERE "id" = $2 RETURNING *');
    assert.deepStrictEqual(values, ['updated', '1']);
  });

  it('still rejects an unknown column inside a one-element array', () => {
    assert.throws(
      () => buildUpdate('items', [{ nope: 1 }], parsed, schema),
      (err) => err.code === 'PGRST204');
  });
});
