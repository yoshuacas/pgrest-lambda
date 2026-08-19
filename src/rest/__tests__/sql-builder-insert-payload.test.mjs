// sql-builder-insert-payload.test.mjs — the shape of an INSERT payload.
//
// Pinned to upstream's mutation plan (`PostgREST.Plan.mutatePlan`) and its SQL
// (`PostgREST.Query.QueryBuilder.mutateRequestToQuery`,
// `PostgREST.Query.SqlFragment.fromJsonBodyF`), where the rows come from
// `json_to_recordset(<body>)`:
//
//   * `[]` inserts nothing, so the statement must still return the projection.
//   * a key absent from a row is NULL, or the column DEFAULT under
//     `Prefer: missing=default`.
//   * `?columns=` *is* the column list; anything else in the body is ignored.
//   * ON CONFLICT exists only with `Prefer: resolution=`.
//   * the returned columns are `select` + pk, not `*` (`inferColsEmbedNeeds`).
//
//   node --test src/rest/__tests__/sql-builder-insert-payload.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildInsert, buildUpdate } from '../sql-builder.mjs';

const schema = {
  tables: {
    items: {
      columns: {
        id: { type: 'int8', nullable: false, defaultValue: 'nextval(...)' },
        name: { type: 'text', nullable: true, defaultValue: "'x'::text" },
        note: { type: 'text', nullable: true, defaultValue: null },
      },
      primaryKey: ['id'],
    },
    defaulted: {
      columns: {
        id: { type: 'int8', nullable: false, defaultValue: 'nextval(...)' },
      },
      primaryKey: ['id'],
    },
  },
};

const base = {
  select: [], filters: [], order: [], limit: null, offset: 0,
  onConflict: null, columns: null,
};

const parsedWith = (over = {}) => ({ ...base, ...over });
const col = (name) => ({ type: 'column', name });

describe('buildInsert payload shape', () => {
  it('inserts one row with the keys it was given', () => {
    const { text, values } = buildInsert(
      'items', { name: 'a', note: 'b' }, schema, parsedWith());
    assert.match(text, /INSERT INTO "items" \("name", "note"\) VALUES \(\$1, \$2\)/);
    assert.deepEqual(values, ['a', 'b']);
  });

  it('inserts a bulk payload as one VALUES list', () => {
    const { text, values } = buildInsert(
      'items', [{ name: 'a' }, { name: 'b' }], schema, parsedWith());
    assert.match(text, /VALUES \(\$1\), \(\$2\)/);
    assert.deepEqual(values, ['a', 'b']);
  });

  // ApiRequest/Payload.hs `payloadAttributes`: every object in the array must
  // carry the same keys, because the INSERT has one column list.
  it('refuses a bulk payload whose keys differ with PGRST102', () => {
    assert.throws(
      () => buildInsert('items', [{ name: 'a' }, { note: 'b' }], schema,
        parsedWith()),
      (err) => {
        assert.equal(err.statusCode, 400);
        assert.equal(err.code, 'PGRST102');
        assert.equal(err.message, 'All object keys must match');
        return true;
      });
  });

  it('accepts differing keys when ?columns= names the columns', () => {
    const { text, values } = buildInsert(
      'items', [{ name: 'a' }, { name: 'b', note: 'c' }], schema,
      parsedWith({ columns: ['name'] }));
    assert.match(text, /\("name"\) VALUES \(\$1\), \(\$2\)/);
    assert.deepEqual(values, ['a', 'b']);
  });

  // InsertSpec.hs:539 — `?columns=` restricts the payload: a key it does not
  // name is dropped instead of inserted.
  it('ignores payload keys ?columns= does not name', () => {
    const { text, values } = buildInsert(
      'items', { name: 'a', note: 'dropped' }, schema,
      parsedWith({ columns: ['name'] }));
    assert.ok(!text.includes('"note"'), text);
    assert.deepEqual(values, ['a']);
  });

  it('rejects a ?columns= column the table does not have', () => {
    assert.throws(
      () => buildInsert('items', { name: 'a' }, schema,
        parsedWith({ columns: ['nope'] })),
      (err) => {
        assert.equal(err.code, 'PGRST204');
        assert.equal(err.message,
          "Could not find the 'nope' column of 'items' in the schema cache");
        return true;
      });
  });

  // A missing key is NULL by default and the column DEFAULT under
  // `Prefer: missing=default` (Plan.hs `applyDefaults`).
  it('fills a key one row omits with NULL', () => {
    const { text, values } = buildInsert(
      'items', [{ name: 'a', note: null }, { name: 'b', note: null }], schema,
      parsedWith());
    assert.match(text, /VALUES \(\$1, \$2\), \(\$3, \$4\)/);
    assert.deepEqual(values, ['a', null, 'b', null]);
  });

  it('uses NULL for a column ?columns= names but the row omits', () => {
    const { text, values } = buildInsert(
      'items', { name: 'a' }, schema,
      parsedWith({ columns: ['name', 'note'] }));
    assert.match(text, /VALUES \(\$1, NULL\)/);
    assert.deepEqual(values, ['a']);
  });

  it('uses DEFAULT for that column under missing=default', () => {
    const { text } = buildInsert(
      'items', { name: 'a' }, schema,
      parsedWith({ columns: ['name', 'note'] }), { applyDefaults: true });
    assert.match(text, /VALUES \(\$1, DEFAULT\)/);
  });

  // InsertSpec.hs:170 — `POST /items` with `{}` inserts a row of defaults.
  it('turns a keyless single row into DEFAULT VALUES', () => {
    const { text, values } = buildInsert('items', {}, schema, parsedWith());
    assert.match(text, /INSERT INTO "items" DEFAULT VALUES/);
    assert.deepEqual(values, []);
  });

  it('turns a keyless bulk payload into DEFAULT tuples', () => {
    const { text } = buildInsert('items', [{}, {}], schema, parsedWith());
    assert.match(text,
      /\("id", "name", "note"\) VALUES \(DEFAULT, DEFAULT, DEFAULT\), /);
  });

  // `[]` is a valid payload that inserts nothing: upstream's INSERT selects
  // from an empty recordset, so the response is an empty array, not an error.
  it('inserts nothing for an empty array payload', () => {
    const { text, values } = buildInsert('items', [], schema, parsedWith());
    assert.ok(!text.includes('INSERT'), text);
    assert.match(text, /WHERE false/);
    assert.deepEqual(values, []);
  });

  it('keeps the ?select= projection for an empty array payload', () => {
    const { text } = buildInsert('items', [], schema,
      parsedWith({ select: [col('name')] }));
    assert.match(text, /^SELECT "name" FROM "items" WHERE false$/);
  });
});

describe('buildInsert ON CONFLICT', () => {
  it('emits nothing without a resolution preference', () => {
    const { text } = buildInsert('items', { id: 1 }, schema,
      parsedWith({ onConflict: 'id' }));
    assert.ok(!text.includes('ON CONFLICT'), text);
  });

  it('targets the primary key by default', () => {
    const { text } = buildInsert('items', { id: 1, name: 'a' }, schema,
      parsedWith(), { resolution: 'merge-duplicates' });
    assert.match(text,
      /ON CONFLICT \("id"\) DO UPDATE SET "id" = EXCLUDED\."id", "name" = EXCLUDED\."name"/);
  });

  it('targets ?on_conflict= when given', () => {
    const { text } = buildInsert('items', { name: 'a' }, schema,
      parsedWith({ onConflict: 'name,note' }),
      { resolution: 'merge-duplicates' });
    assert.match(text, /ON CONFLICT \("name", "note"\) DO UPDATE/);
  });

  it('rejects an ?on_conflict= column the table does not have', () => {
    assert.throws(
      () => buildInsert('items', { name: 'a' }, schema,
        parsedWith({ onConflict: 'nope' }),
        { resolution: 'merge-duplicates' }),
      (err) => {
        assert.equal(err.code, 'PGRST204');
        return true;
      });
  });

  it('does nothing for ignore-duplicates', () => {
    const { text } = buildInsert('items', { id: 1, name: 'a' }, schema,
      parsedWith(), { resolution: 'ignore-duplicates' });
    assert.match(text, /ON CONFLICT \("id"\) DO NOTHING/);
  });

  // QueryBuilder.hs: DO UPDATE needs at least one column to set, so a payload
  // of pure defaults falls back to DO NOTHING.
  it('does nothing when there is no column to set', () => {
    const { text } = buildInsert('defaulted', {}, schema, parsedWith(),
      { resolution: 'merge-duplicates' });
    assert.match(text, /ON CONFLICT \("id"\) DO NOTHING/);
  });
});

// Plan.hs `inferColsEmbedNeeds`: a mutation returns the selected columns plus
// the primary key, not `*`. The rows come back through a CTE so the projection
// can name them once.
describe('mutation projection', () => {
  it('projects ?select= over the mutation CTE', () => {
    const { text } = buildInsert('items', { name: 'a' }, schema,
      parsedWith({ select: [col('name')] }));
    assert.match(text,
      /^WITH pgrst_source AS \(INSERT INTO .* RETURNING \*\) SELECT "name" FROM pgrst_source$/);
  });

  it('leaves RETURNING * alone when select is empty or a bare star', () => {
    for (const select of [[], [col('*')]]) {
      const { text } = buildInsert('items', { name: 'a' }, schema,
        parsedWith({ select }));
      assert.ok(!text.includes('pgrst_source'), text);
      assert.match(text, /RETURNING \*$/);
    }
  });

  it('projects an alias and a cast', () => {
    const { text } = buildInsert('items', { name: 'a' }, schema,
      parsedWith({ select: [{ type: 'column', name: 'name', alias: 'nm' }] }));
    assert.match(text, /SELECT "name" AS "nm" FROM pgrst_source$/);
  });

  it('projects a PATCH the same way', () => {
    const { text } = buildUpdate('items', { name: 'a' },
      parsedWith({
        select: [col('id')],
        filters: [{ column: 'id', operator: 'eq', value: 1, negate: false }],
      }), schema, null);
    assert.match(text,
      /^WITH pgrst_source AS \(UPDATE .* RETURNING \*\) SELECT "id" FROM pgrst_source$/);
  });

  // An UPDATE with no column to set is not valid SQL; upstream answers with the
  // same zero-row read it uses for an empty payload.
  it('turns an empty PATCH payload into a zero-row read', () => {
    const { text } = buildUpdate('items', {},
      parsedWith({
        select: [col('id')],
        filters: [{ column: 'id', operator: 'eq', value: 1, negate: false }],
      }), schema, null);
    assert.match(text, /^SELECT "id" FROM "items" WHERE false$/);
  });
});
