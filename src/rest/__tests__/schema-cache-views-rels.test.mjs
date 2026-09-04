import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  createSchemaCache,
  normalizeDeclaredRelationships,
  deriveManyToManyRelationships,
  deriveViewRelationships,
  buildUniqueKeyMap,
  markOneToOneRelationships,
} from '../schema-cache.mjs';

// The mock pool answers each introspection statement by matching a marker
// in its text, the same way the other schema-cache tests do.
function createMockPool({
  columnRows = [],
  pkRows = [],
  fkRows = [],
  viewRows = [],
  sourceColumnRows = [],
  sourcePkRows = [],
  uniqueRows = [],
} = {}) {
  const calls = [];
  return {
    calls,
    query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes('pg_rewrite')) return { rows: viewRows };
      if (sql.includes('c.oid = ANY($1::oid[])')) {
        return { rows: sourceColumnRows };
      }
      if (sql.includes('con.conrelid = ANY($1::oid[])')) {
        return { rows: sourcePkRows };
      }
      if (sql.includes("contype IN ('p', 'u')")) {
        return { rows: uniqueRows };
      }
      if (sql.includes("contype = 'f'")) return { rows: fkRows };
      if (sql.includes("contype = 'p'")) return { rows: pkRows };
      if (sql.includes('pg_proc')) return { rows: [] };
      return { rows: columnRows };
    },
  };
}

function col(table, name, attnum, relOid, relkind, bits) {
  return {
    table_name: table,
    rel_oid: relOid,
    relkind,
    updatable_bits: bits,
    column_name: name,
    attnum,
    data_type: 'bigint',
    is_nullable: false,
    column_default: null,
  };
}

const NO_FK_CAPS = { supportsForeignKeys: false, supportsRpc: false };
const FK_CAPS = { supportsForeignKeys: true, supportsRpc: false };

describe('schema cache reads views as relations', () => {
  it('asks the catalog for views, matviews and foreign tables', async () => {
    const pool = createMockPool({ columnRows: [] });
    const cache = createSchemaCache({ capabilities: NO_FK_CAPS });
    await cache.getSchema(pool);
    const columnsSql = pool.calls.find(
      c => c.sql.includes('format_type')).sql;
    for (const kind of ["'r'", "'p'", "'v'", "'m'", "'f'"]) {
      assert.ok(columnsSql.includes(kind),
        `relkind ${kind} must be introspected`);
    }
  });

  it('flags views and carries their updatability bits', async () => {
    const pool = createMockPool({
      // 28 = insert|update|delete, which is what an auto-updatable view
      // and a plain table both report; 0 = read-only view.
      columnRows: [
        col('todos', 'id', 1, 100, 'r', 28),
        col('todos_auto', 'id', 1, 200, 'v', 28),
        col('todos_ro', 'id', 1, 300, 'v', 0),
        col('todos_mat', 'id', 1, 400, 'm', 0),
      ],
    });
    const cache = createSchemaCache({ capabilities: NO_FK_CAPS });
    const schema = await cache.getSchema(pool);

    assert.equal(schema.tables.todos.isView, false);
    assert.equal(schema.tables.todos.insertable, true);

    assert.equal(schema.tables.todos_auto.isView, true);
    assert.equal(schema.tables.todos_auto.kind, 'v');
    assert.deepStrictEqual(
      [
        schema.tables.todos_auto.insertable,
        schema.tables.todos_auto.updatable,
        schema.tables.todos_auto.deletable,
      ],
      [true, true, true],
      'an auto-updatable view accepts writes');

    assert.deepStrictEqual(
      [
        schema.tables.todos_ro.insertable,
        schema.tables.todos_ro.updatable,
        schema.tables.todos_ro.deletable,
      ],
      [false, false, false],
      'a read-only view accepts none');

    assert.equal(schema.tables.todos_mat.isView, true);
  });
});

describe('declared relationship manifest', () => {
  it('normalises the CONTRACTS.md manifest shape', () => {
    const rels = normalizeDeclaredRelationships({
      relationships: [{
        constraint: 'items_owner_fkey',
        schema: 'public',
        table: 'items',
        columns: ['owner_id'],
        foreignSchema: 'private',
        foreignTable: 'users',
        foreignColumns: ['id'],
      }],
    });
    assert.deepStrictEqual(rels, [{
      constraint: 'items_owner_fkey',
      fromSchema: 'public',
      fromTable: 'items',
      fromColumns: ['owner_id'],
      toSchema: 'private',
      toTable: 'users',
      toColumns: ['id'],
      source: 'declared',
    }]);
  });

  it('drops malformed entries instead of throwing', () => {
    const rels = normalizeDeclaredRelationships({
      relationships: [
        { table: 'a', foreignTable: 'b' },
        { table: 'a', columns: ['x'], foreignColumns: ['y'] },
        // upstream cannot express 4 columns against 1
        {
          table: 'a', columns: ['w', 'x', 'y', 'z'],
          foreignTable: 'b', foreignColumns: ['id'],
        },
        { table: 'a', columns: [], foreignTable: 'b', foreignColumns: [] },
        null,
      ],
    });
    assert.deepStrictEqual(rels, []);
  });

  it('supplies relationships when the catalog has no foreign keys',
    async () => {
      const pool = createMockPool({
        columnRows: [
          col('notes', 'id', 1, 100, 'r', 28),
          col('notes', 'author_id', 2, 100, 'r', 28),
          col('people', 'id', 1, 200, 'r', 28),
        ],
        pkRows: [
          { table_name: 'notes', column_name: 'id' },
          { table_name: 'people', column_name: 'id' },
        ],
      });
      const cache = createSchemaCache({
        capabilities: NO_FK_CAPS,
        relationships: {
          relationships: [{
            constraint: 'notes_author_id_fkey',
            table: 'notes',
            columns: ['author_id'],
            foreignTable: 'people',
            foreignColumns: ['id'],
          }],
        },
      });
      const schema = await cache.getSchema(pool);
      assert.equal(
        pool.calls.filter(c => c.sql.includes("contype = 'f'")).length,
        0, 'the FK query is still skipped when unsupported');
      assert.deepStrictEqual(schema.relationships, [{
        constraint: 'notes_author_id_fkey',
        fromSchema: 'public',
        fromTable: 'notes',
        fromColumns: ['author_id'],
        toSchema: 'public',
        toTable: 'people',
        toColumns: ['id'],
        source: 'declared',
      }]);
    });

  it('adds to the catalog without replacing it, and dedupes overlap',
    async () => {
      const pool = createMockPool({
        columnRows: [
          col('notes', 'id', 1, 100, 'r', 28),
          col('notes', 'author_id', 2, 100, 'r', 28),
          col('people', 'id', 1, 200, 'r', 28),
          col('tags', 'id', 1, 300, 'r', 28),
          col('tags', 'note_id', 2, 300, 'r', 28),
        ],
        pkRows: [
          { table_name: 'notes', column_name: 'id' },
          { table_name: 'people', column_name: 'id' },
          { table_name: 'tags', column_name: 'id' },
        ],
        fkRows: [{
          constraint_name: 'notes_author_id_fkey',
          from_schema: 'public',
          from_table: 'notes',
          from_columns: ['author_id'],
          to_schema: 'public',
          to_table: 'people',
          to_columns: ['id'],
        }],
      });
      const cache = createSchemaCache({
        capabilities: FK_CAPS,
        relationships: {
          relationships: [
            // same key the catalog already reported
            {
              constraint: 'notes_author_id_fkey',
              table: 'notes',
              columns: ['author_id'],
              foreignTable: 'people',
              foreignColumns: ['id'],
            },
            {
              constraint: 'tags_note_id_fkey',
              table: 'tags',
              columns: ['note_id'],
              foreignTable: 'notes',
              foreignColumns: ['id'],
            },
          ],
        },
      });
      const schema = await cache.getSchema(pool);
      assert.equal(schema.relationships.length, 2,
        'the duplicate is collapsed');
      const catalogRel = schema.relationships.find(
        r => r.constraint === 'notes_author_id_fkey');
      assert.equal(catalogRel.source, 'catalog',
        'the catalog wins for a key both sources report');
      const declared = schema.relationships.find(
        r => r.constraint === 'tags_note_id_fkey');
      assert.equal(declared.source, 'declared');
    });

  it('reads the manifest path from PGREST_RELATIONSHIPS_PATH', async () => {
    const previous = process.env.PGREST_RELATIONSHIPS_PATH;
    process.env.PGREST_RELATIONSHIPS_PATH = 'no/such/manifest.json';
    try {
      const cache = createSchemaCache({ capabilities: NO_FK_CAPS });
      await assert.rejects(
        () => cache.getSchema(createMockPool()),
        (err) => err.message.includes('no/such/manifest.json'),
        'a bad path must fail loudly, not silently disable embedding');
    } finally {
      if (previous === undefined) {
        delete process.env.PGREST_RELATIONSHIPS_PATH;
      } else {
        process.env.PGREST_RELATIONSHIPS_PATH = previous;
      }
    }
  });
});

describe('one-to-one detection', () => {
  const m2o = {
    constraint: 'students_info_student_fkey',
    fromSchema: 'public', fromTable: 'students_info',
    fromColumns: ['code', 'id'],
    toSchema: 'public', toTable: 'students', toColumns: ['code', 'id'],
    source: 'declared',
  };

  it('groups key rows by qualified relation name', () => {
    const map = buildUniqueKeyMap([
      { schema_name: 'public', table_name: 'first',
        constraint_name: 'first_second_id_1_key', columns: ['second_id_1'] },
      { schema_name: 'public', table_name: 'first',
        constraint_name: 'first_second_id_2_key', columns: ['second_id_2'] },
      { schema_name: 'private', table_name: 'first',
        constraint_name: 'first_pkey', columns: ['id'] },
      // a row with no columns is not a key
      { schema_name: 'public', table_name: 'junk', columns: [] },
      { columns: ['x'] },
    ]);
    assert.deepStrictEqual(map.get('public.first'),
      [['second_id_1'], ['second_id_2']]);
    assert.deepStrictEqual(map.get('private.first'), [['id']]);
    assert.equal(map.has('public.junk'), false);
    assert.equal(map.size, 2);
  });

  it('marks a key whose own columns are unique', () => {
    const keys = new Map([
      ['public.students_info', [['code', 'id']]],
    ]);
    assert.equal(
      markOneToOneRelationships([m2o], keys)[0].cardinality, 'one-to-one');
  });

  it('marks a key that covers a narrower unique key', () => {
    // a unique (id) makes the composite (code, id) unique too
    const keys = new Map([['public.students_info', [['id']]]]);
    assert.equal(
      markOneToOneRelationships([m2o], keys)[0].cardinality, 'one-to-one');
  });

  it('leaves a plain many-to-one alone', () => {
    // the unique key is on the referenced side, and a wider key on the
    // referencing side does not make the foreign key columns unique
    const keys = new Map([
      ['public.students', [['code', 'id']]],
      ['public.students_info', [['code', 'id', 'seq']]],
    ]);
    const out = markOneToOneRelationships([m2o], keys);
    assert.equal(out[0].cardinality, undefined);
    assert.equal(out[0], m2o, 'an unchanged relationship is not copied');
  });

  it('does not reclassify a relationship that already has a cardinality',
    () => {
      const m2m = {
        cardinality: 'many-to-many',
        fromSchema: 'public', fromTable: 'students_info',
        fromColumns: ['id'],
        toSchema: 'public', toTable: 'students', toColumns: ['id'],
      };
      const keys = new Map([['public.students_info', [['id']]]]);
      assert.equal(
        markOneToOneRelationships([m2m], keys)[0].cardinality,
        'many-to-many');
    });

  it('is a no-op when the catalog reports no keys', () => {
    const rels = [m2o];
    assert.equal(markOneToOneRelationships(rels, new Map()), rels);
    assert.equal(markOneToOneRelationships(rels, null), rels);
  });

  it('a view inherits the cardinality of the key it exposes', () => {
    const derived = deriveViewRelationships(
      [{ ...m2o, cardinality: 'one-to-one' }],
      new Map([
        ['students_info_view', new Map([
          ['public.students_info.code', ['code']],
          ['public.students_info.id', ['id']],
        ])],
      ]));
    assert.ok(derived.length > 0);
    for (const rel of derived) {
      assert.equal(rel.cardinality, 'one-to-one',
        'a one-to-one key stays one-to-one through a view');
    }
  });

  it('reads unique keys from the catalog end to end', async () => {
    const pool = createMockPool({
      columnRows: [
        col('capital', 'id', 1, 100, 'r', 28),
        col('capital', 'country_id', 2, 100, 'r', 28),
        col('country', 'id', 1, 200, 'r', 28),
      ],
      pkRows: [
        { table_name: 'capital', column_name: 'id' },
        { table_name: 'country', column_name: 'id' },
      ],
      uniqueRows: [
        { schema_name: 'public', table_name: 'capital',
          constraint_name: 'capital_country_id_key',
          columns: ['country_id'] },
      ],
    });
    const cache = createSchemaCache({
      capabilities: NO_FK_CAPS,
      relationships: {
        relationships: [{
          constraint: 'capital_country_id_fkey',
          table: 'capital',
          columns: ['country_id'],
          foreignTable: 'country',
          foreignColumns: ['id'],
        }],
      },
    });
    const schema = await cache.getSchema(pool);
    assert.equal(schema.relationships.length, 1);
    assert.equal(schema.relationships[0].cardinality, 'one-to-one');
  });
});

describe('many-to-many derivation', () => {
  const tables = {
    users_tasks: { columns: {}, primaryKey: ['user_id', 'task_id'] },
    users: { columns: {}, primaryKey: ['id'] },
    tasks: { columns: {}, primaryKey: ['id'] },
  };
  const rels = [
    {
      constraint: 'users_tasks_user_id_fkey',
      fromTable: 'users_tasks', fromColumns: ['user_id'],
      toTable: 'users', toColumns: ['id'],
    },
    {
      constraint: 'users_tasks_task_id_fkey',
      fromTable: 'users_tasks', fromColumns: ['task_id'],
      toTable: 'tasks', toColumns: ['id'],
    },
  ];

  it('derives one relationship per junction pair', () => {
    const m2m = deriveManyToManyRelationships(tables, rels);
    assert.equal(m2m.length, 1,
      'the pair must not be emitted once per direction, '
      + 'or every m2m embed would be ambiguous');
    assert.deepStrictEqual(m2m[0], {
      constraint: null,
      cardinality: 'many-to-many',
      fromSchema: 'public',
      fromTable: 'users',
      fromColumns: ['id'],
      toSchema: 'public',
      toTable: 'tasks',
      toColumns: ['id'],
      junctionSchema: 'public',
      junctionTable: 'users_tasks',
      junctionFromColumns: ['user_id'],
      junctionToColumns: ['task_id'],
      junctionFromConstraint: 'users_tasks_user_id_fkey',
      junctionToConstraint: 'users_tasks_task_id_fkey',
      source: 'm2m',
    });
  });

  it('requires the foreign keys to be inside the junction primary key',
    () => {
      const notAJunction = {
        ...tables,
        users_tasks: { columns: {}, primaryKey: ['id'] },
      };
      assert.deepStrictEqual(
        deriveManyToManyRelationships(notAJunction, rels), []);
    });

  it('recognises a junction outside the served schema', () => {
    // upstream: /schauspieler?select=filme(*) joins through
    // private.rollen, a relation the engine never serves directly.
    const hidden = [
      {
        constraint: 'rollen_rolle_id_fkey',
        fromSchema: 'private', fromTable: 'rollen',
        fromColumns: ['rolle_id'],
        toSchema: 'public', toTable: 'schauspieler', toColumns: ['id'],
      },
      {
        constraint: 'rollen_film_id_fkey',
        fromSchema: 'private', fromTable: 'rollen',
        fromColumns: ['film_id'],
        toSchema: 'public', toTable: 'filme', toColumns: ['id'],
      },
    ];
    const served = {
      schauspieler: { columns: {}, primaryKey: ['id'] },
      filme: { columns: {}, primaryKey: ['id'] },
    };
    assert.deepStrictEqual(
      deriveManyToManyRelationships(served, hidden), [],
      'without the junction primary key there is nothing to derive');

    const m2m = deriveManyToManyRelationships(served, hidden,
      new Map([['private.rollen', ['rolle_id', 'film_id']]]));
    assert.equal(m2m.length, 1);
    assert.equal(m2m[0].junctionSchema, 'private');
    assert.equal(m2m[0].junctionTable, 'rollen');
    assert.deepStrictEqual(
      [m2m[0].fromTable, m2m[0].toTable], ['schauspieler', 'filme']);
  });

  it('prefers the served primary key, which a view can inherit', () => {
    // a junction view has no constraint of its own, so its inherited key
    // is the only one available
    const viewJunction = {
      ...tables,
      users_tasks: {
        columns: {}, isView: true, primaryKey: ['user_id', 'task_id'],
      },
    };
    assert.equal(
      deriveManyToManyRelationships(viewJunction, rels, new Map()).length,
      1);
  });

  it('ignores a one-to-one key: it cannot be a junction side', () => {
    const o2o = rels.map(r => ({ ...r, cardinality: 'one-to-one' }));
    assert.deepStrictEqual(
      deriveManyToManyRelationships(tables, o2o), []);
  });

  it('ignores a junction with no primary key', () => {
    const noPk = {
      ...tables,
      users_tasks: { columns: {}, primaryKey: [] },
    };
    assert.deepStrictEqual(deriveManyToManyRelationships(noPk, rels), []);
  });
});

describe('view relationship derivation', () => {
  it('maps a base key onto the views that expose its columns', () => {
    const baseRels = [{
      constraint: 'books_author_fkey',
      fromSchema: 'private', fromTable: 'books',
      fromColumns: ['author_id'],
      toSchema: 'private', toTable: 'authors', toColumns: ['id'],
      source: 'declared',
    }];
    const viewColumnMap = new Map([
      ['books_view', new Map([
        ['private.books.author_id', ['authorId']],
      ])],
      ['authors_view', new Map([
        ['private.authors.id', ['authorId']],
      ])],
    ]);
    const derived = deriveViewRelationships(baseRels, viewColumnMap);
    const shapes = derived.map(r =>
      `${r.fromSchema}.${r.fromTable}(${r.fromColumns})`
      + `->${r.toSchema}.${r.toTable}(${r.toColumns})`);
    assert.ok(shapes.includes(
      'public.books_view(authorId)->private.authors(id)'),
      `view→table missing from ${JSON.stringify(shapes)}`);
    assert.ok(shapes.includes(
      'private.books(author_id)->public.authors_view(authorId)'),
      `table→view missing from ${JSON.stringify(shapes)}`);
    assert.ok(shapes.includes(
      'public.books_view(authorId)->public.authors_view(authorId)'),
      `view→view missing from ${JSON.stringify(shapes)}`);
    for (const rel of derived) {
      assert.equal(rel.constraint, 'books_author_fkey',
        'the derived relationship keeps the base constraint name');
    }
  });

  it('end to end: views over a hidden schema embed each other', async () => {
    // books/authors are public views over private.books/private.authors.
    // Their rewrite rules are the only place the column provenance lives.
    const viewDef = (viewOid, srcOid, cols) => ({
      view_oid: viewOid,
      view_name: 'v',
      view_definition: '({QUERY :targetList ('
        + cols.map(([resno, srcAttnum]) =>
            `{TARGETENTRY :expr {VAR :varno 1} :resno ${resno} `
            + `:resorigtbl ${srcOid} :resorigcol ${srcAttnum} `
            + `:resjunk false}`).join(' ')
        + ')})',
    });

    const pool = createMockPool({
      columnRows: [
        col('books', 'id', 1, 100, 'v', 28),
        col('books', 'title', 2, 100, 'v', 28),
        col('books', 'authorId', 3, 100, 'v', 28),
        col('authors', 'id', 1, 200, 'v', 28),
        col('authors', 'name', 2, 200, 'v', 28),
      ],
      pkRows: [],
      viewRows: [
        viewDef(100, 900, [[1, 1], [2, 2], [3, 3]]),
        viewDef(200, 901, [[1, 1], [2, 2]]),
      ],
      sourceColumnRows: [
        { rel_oid: 900, schema_name: 'private', rel_name: 'books_base', attnum: 1, column_name: 'id' },
        { rel_oid: 900, schema_name: 'private', rel_name: 'books_base', attnum: 2, column_name: 'title' },
        { rel_oid: 900, schema_name: 'private', rel_name: 'books_base', attnum: 3, column_name: 'author_id' },
        { rel_oid: 901, schema_name: 'private', rel_name: 'authors_base', attnum: 1, column_name: 'id' },
        { rel_oid: 901, schema_name: 'private', rel_name: 'authors_base', attnum: 2, column_name: 'name' },
      ],
      sourcePkRows: [
        { rel_oid: 900, column_name: 'id' },
        { rel_oid: 901, column_name: 'id' },
      ],
    });

    const cache = createSchemaCache({
      capabilities: NO_FK_CAPS,
      relationships: {
        relationships: [{
          constraint: 'books_author_fkey',
          schema: 'private',
          table: 'books_base',
          columns: ['author_id'],
          foreignSchema: 'private',
          foreignTable: 'authors_base',
          foreignColumns: ['id'],
        }],
      },
    });
    const schema = await cache.getSchema(pool);

    assert.deepStrictEqual(schema.relationships, [{
      constraint: 'books_author_fkey',
      fromSchema: 'public',
      fromTable: 'books',
      fromColumns: ['authorId'],
      toSchema: 'public',
      toTable: 'authors',
      toColumns: ['id'],
      source: 'view',
    }], 'only the public view↔view relationship is served');

    assert.deepStrictEqual(schema.tables.books.primaryKey, ['id'],
      'a view inherits the primary key of its base relation');
    assert.deepStrictEqual(schema.tables.authors.primaryKey, ['id']);
  });
});
