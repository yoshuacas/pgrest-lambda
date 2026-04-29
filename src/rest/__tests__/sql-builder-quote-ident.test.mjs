import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildSelect, buildInsert, buildUpdate, buildDelete } from '../sql-builder.mjs';

// Schema intentionally contains a valid-looking column. The malicious
// name is passed *around* the schema cache by faking it into parsed
// state, to prove q() rejects it independent of schema-cache
// validation — the defense-in-depth guarantee.
const schema = {
  tables: {
    todos: {
      columns: {
        id: { type: 'text', nullable: false, defaultValue: null },
        title: { type: 'text', nullable: true, defaultValue: null },
      },
      primaryKey: ['id'],
    },
  },
};

// Inject a malformed key into the schema to simulate a schema-cache
// bug that lets a bad identifier through. The whole point of M-7 is
// that q() catches this at SQL construction time.
const pwnedSchema = {
  tables: {
    'todos"; DROP TABLE users; --': {
      columns: {
        id: { type: 'text', nullable: false, defaultValue: null },
      },
      primaryKey: ['id'],
    },
  },
};

describe('sql-builder quoteIdent defense-in-depth', () => {
  it('buildSelect rejects a malformed table name with PGRST204', () => {
    const parsed = { select: ['*'], filters: [], order: [], limit: null, offset: 0 };
    assert.throws(
      () => buildSelect('todos"; DROP TABLE users; --', parsed, pwnedSchema, null),
      (err) => err.code === 'PGRST204',
      'table name with embedded quote must not reach the SQL text'
    );
  });

  it('buildInsert rejects a malformed table name with PGRST204', () => {
    assert.throws(
      () => buildInsert('todos"; DROP TABLE users; --', { id: 'x' }, pwnedSchema, { columns: null, onConflict: null }),
      (err) => err.code === 'PGRST204'
    );
  });

  it('buildUpdate rejects a malformed table name with PGRST204', () => {
    const parsed = { filters: [{ column: 'id', operator: 'eq', value: 'x', negate: false }], select: ['*'], order: [], limit: null, offset: 0 };
    assert.throws(
      () => buildUpdate('todos"; DROP TABLE users; --', { id: 'y' }, parsed, pwnedSchema, null),
      (err) => err.code === 'PGRST204'
    );
  });

  it('buildDelete rejects a malformed table name with PGRST204', () => {
    const parsed = { filters: [{ column: 'id', operator: 'eq', value: 'x', negate: false }], select: ['*'], order: [], limit: null, offset: 0 };
    assert.throws(
      () => buildDelete('todos"; DROP TABLE users; --', parsed, pwnedSchema, null),
      (err) => err.code === 'PGRST204'
    );
  });

  it('valid identifiers still produce the expected SQL', () => {
    const parsed = { select: ['*'], filters: [], order: [], limit: null, offset: 0 };
    const q = buildSelect('todos', parsed, schema, null);
    assert.match(q.text, /FROM "todos"/, 'well-formed tables still quoted normally');
  });
});
