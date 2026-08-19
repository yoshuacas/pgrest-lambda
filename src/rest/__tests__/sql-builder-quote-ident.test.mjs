import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildSelect, buildInsert, buildUpdate, buildDelete } from '../sql-builder.mjs';

// Finding M-7: no identifier may escape into the SQL text as syntax. These
// tests still assert exactly that, but against the mechanism that now provides
// it.
//
// They used to assert that q() *rejected* a name outside
// /^[A-Za-z_][A-Za-z0-9_]*$/ with PGRST204. That guard was wrong for two
// reasons. It was unnecessary — PostgreSQL's double-quoted identifier ends at
// the first unescaped `"`, so doubling every internal quote (upstream's
// `escapeIdent`, SchemaCache/Identifiers.hs:56) makes every possible input a
// single inert token, including the payload below. And it was harmful — a
// PostgreSQL relation may legitimately be called `Escap3e;`, `Server Today`,
// `do$llar$s` or `موارد`, and the character class turned all of those into
// errors (QuerySpec:1262, :1277, :1282, :1296, UnicodeSpec:18-32).
//
// So the assertion changes from "rejected" to "neutralized": the payload must
// appear only inside a quoted identifier, with its quote doubled, and must not
// contribute a single character of SQL syntax.
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

const PAYLOAD = 'todos"; DROP TABLE users; --';
// What the payload must become: one identifier token, internal quote doubled.
const QUOTED = '"todos""; DROP TABLE users; --"';

// A schema that claims the payload is a real relation, simulating a
// schema-cache bug. q() must still make it harmless.
const pwnedSchema = {
  tables: {
    [PAYLOAD]: {
      columns: {
        id: { type: 'text', nullable: false, defaultValue: null },
      },
      primaryKey: ['id'],
    },
  },
};

// The statement must contain the payload only as the quoted token above.
// Removing every quoted identifier from the SQL must leave no trace of it.
function assertNeutralized(sql) {
  assert.ok(sql.includes(QUOTED),
    `payload must appear as a single quoted identifier\n  got: ${sql}`);
  const withoutIdentifiers = sql.replaceAll(/"(?:[^"]|"")*"/g, 'IDENT');
  assert.ok(!withoutIdentifiers.includes('DROP TABLE'),
    `payload leaked outside a quoted identifier\n  got: ${withoutIdentifiers}`);
  // A `"` that is neither the start nor the end of a token and is not doubled
  // would close the identifier early. After stripping well-formed identifiers
  // no quote may remain.
  assert.ok(!withoutIdentifiers.includes('"'),
    `unbalanced quote left in SQL\n  got: ${withoutIdentifiers}`);
}

describe('sql-builder quoteIdent defense-in-depth', () => {
  it('buildSelect neutralizes a malformed table name', () => {
    const parsed = { select: ['*'], filters: [], order: [], limit: null, offset: 0 };
    assertNeutralized(buildSelect(PAYLOAD, parsed, pwnedSchema, null).text);
  });

  it('buildInsert neutralizes a malformed table name', () => {
    const q = buildInsert(PAYLOAD, { id: 'x' }, pwnedSchema,
      { columns: null, onConflict: null });
    assertNeutralized(q.text);
    assert.deepEqual(q.values, ['x'], 'the value is still a bind parameter');
  });

  it('buildUpdate neutralizes a malformed table name', () => {
    const parsed = {
      filters: [{ column: 'id', operator: 'eq', value: 'x', negate: false }],
      select: ['*'], order: [], limit: null, offset: 0,
    };
    assertNeutralized(buildUpdate(PAYLOAD, { id: 'y' }, parsed, pwnedSchema, null).text);
  });

  it('buildDelete neutralizes a malformed table name', () => {
    const parsed = {
      filters: [{ column: 'id', operator: 'eq', value: 'x', negate: false }],
      select: ['*'], order: [], limit: null, offset: 0,
    };
    assertNeutralized(buildDelete(PAYLOAD, parsed, pwnedSchema, null).text);
  });

  it('a column name carrying a quote is neutralized too', () => {
    const colSchema = {
      tables: {
        todos: {
          columns: { 'id"; DROP TABLE users; --': { type: 'text' } },
          primaryKey: [],
        },
      },
    };
    const parsed = {
      select: [{ type: 'column', name: 'id"; DROP TABLE users; --' }],
      filters: [], order: [], limit: null, offset: 0,
    };
    const sql = buildSelect('todos', parsed, colSchema, null).text;
    const withoutIdentifiers = sql.replaceAll(/"(?:[^"]|"")*"/g, 'IDENT');
    assert.ok(!withoutIdentifiers.includes('DROP TABLE'),
      `column payload leaked outside a quoted identifier: ${withoutIdentifiers}`);
  });

  it('an empty or non-string identifier is still refused', () => {
    const parsed = { select: ['*'], filters: [], order: [], limit: null, offset: 0 };
    // '' is not a legal PostgreSQL identifier at all, so there is nothing to
    // quote and nothing sensible to emit.
    assert.throws(
      () => buildSelect('', parsed, { tables: { '': { columns: {}, primaryKey: [] } } }, null),
      (err) => err.code === 'PGRST204');
  });

  it('valid identifiers still produce the expected SQL', () => {
    const parsed = { select: ['*'], filters: [], order: [], limit: null, offset: 0 };
    const q = buildSelect('todos', parsed, schema, null);
    assert.match(q.text, /FROM "todos"/, 'well-formed tables still quoted normally');
  });
});
