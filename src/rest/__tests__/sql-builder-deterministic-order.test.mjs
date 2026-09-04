// sql-builder-deterministic-order.test.mjs — the primary-key tiebreak the
// engine appends to every ORDER BY.
//
// Upstream PostgREST emits no implicit order: a read with no `order=` returns
// rows in whatever order PostgreSQL scans them. On a freshly loaded, unmutated
// table that is insertion order, which is stable enough that upstream's own
// test expectations encode it. Aurora DSQL makes no such promise, so the same
// read can come back in a different order twice in a row. The tiebreak buys
// that determinism back; see `tiebreakTerms` in sql-builder.mjs.
//
//   node --test src/rest/__tests__/sql-builder-deterministic-order.test.mjs

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildSelect } from '../sql-builder.mjs';
import { parseQuery } from '../query-parser.mjs';

const schema = {
  tables: {
    todos: {
      columns: {
        id: { type: 'int8' },
        name: { type: 'text' },
        done: { type: 'bool' },
      },
      primaryKey: ['id'],
    },
    compound: {
      columns: {
        k1: { type: 'int8' },
        k2: { type: 'text' },
        v: { type: 'text' },
      },
      primaryKey: ['k1', 'k2'],
    },
    keyless: {
      columns: { a: { type: 'int8' }, b: { type: 'text' } },
      primaryKey: [],
    },
    unsortable: {
      columns: {
        doc: { type: 'json' },
        tags: { type: 'text[]' },
        meta: { type: 'jsonb' },
      },
      primaryKey: [],
    },
    json_only: {
      columns: { doc: { type: 'json' } },
      primaryKey: [],
    },
    children: {
      columns: {
        id: { type: 'int8' },
        todo_id: { type: 'int8' },
        label: { type: 'text' },
      },
      primaryKey: ['id'],
    },
  },
  relationships: [
    {
      constraint: 'children_todo_id_fkey',
      fromTable: 'children',
      fromColumns: ['todo_id'],
      toTable: 'todos',
      toColumns: ['id'],
    },
  ],
};

function sqlFor(table, query) {
  const { text } = buildSelect(table, parseQuery(query, 'GET'), schema);
  return text.replace(/\s+/g, ' ').trim();
}

afterEach(() => {
  delete process.env.PGREST_DETERMINISTIC_ORDER;
});

describe('primary-key order tiebreak', () => {
  it('orders an unordered read by the primary key', () => {
    assert.equal(sqlFor('todos', { select: 'name' }),
      'SELECT "name" FROM "todos" ORDER BY "todos"."id" ASC');
  });

  it('appends every column of a compound key, in key order', () => {
    assert.equal(sqlFor('compound', { select: 'v' }),
      'SELECT "v" FROM "compound"'
      + ' ORDER BY "compound"."k1" ASC, "compound"."k2" ASC');
  });

  it('breaks the ties of an explicit order rather than replacing it', () => {
    // PostgreSQL returns rows that tie on `done` in physical order, which for
    // an unmutated table is key order — so appending the key is what makes the
    // engine agree with upstream, not a divergence from it.
    assert.equal(sqlFor('todos', { select: 'name', order: 'done.desc' }),
      'SELECT "name" FROM "todos"'
      + ' ORDER BY "todos"."done" DESC, "todos"."id" ASC');
  });

  it('does not order by a key column the request already ordered by', () => {
    assert.equal(sqlFor('todos', { select: 'name', order: 'id.desc' }),
      'SELECT "name" FROM "todos" ORDER BY "todos"."id" DESC');
  });

  it('adds only the key columns the request left out', () => {
    assert.equal(sqlFor('compound', { select: 'v', order: 'k2.desc' }),
      'SELECT "v" FROM "compound"'
      + ' ORDER BY "compound"."k2" DESC, "compound"."k1" ASC');
  });

  it('falls back to every orderable column when there is no primary key', () => {
    // No key means row identity cannot be made stable, but the response can:
    // rows that still tie are rows whose every ordered column is equal.
    assert.equal(sqlFor('keyless', { select: 'a' }),
      'SELECT "a" FROM "keyless"'
      + ' ORDER BY "keyless"."a" ASC, "keyless"."b" ASC');
  });

  it('leaves out a keyless column PostgreSQL cannot order by', () => {
    // `json` has no default btree operator class, so ordering by it is
    // `could not identify an ordering operator for type json`. `jsonb` has one.
    assert.equal(sqlFor('unsortable', { select: 'doc' }),
      'SELECT "doc" FROM "unsortable"'
      + ' ORDER BY "unsortable"."tags" ASC, "unsortable"."meta" ASC');
  });

  it('adds nothing when a keyless relation has nothing orderable', () => {
    assert.equal(sqlFor('json_only', { select: 'doc' }),
      'SELECT "doc" FROM "json_only"');
  });

  it('breaks the ties of an explicit order on a keyless relation', () => {
    assert.equal(sqlFor('keyless', { select: 'a', order: 'b.desc' }),
      'SELECT "a" FROM "keyless"'
      + ' ORDER BY "keyless"."b" DESC, "keyless"."a" ASC');
  });

  it('adds nothing to an aggregated read', () => {
    // A key column that is not in the GROUP BY cannot be ordered by at all.
    const sql = sqlFor('todos', { select: 'done,id.count()' });
    assert.equal(sql.includes('ORDER BY'), false, sql);
  });

  it('adds nothing when a selected field could be an aggregate', () => {
    // `?select=count` over a table with no `count` column renders as
    // `"todos"."count"`, which PostgreSQL resolves to the aggregate
    // (upstream's "count as a column" backwards compatibility). The builder
    // cannot see that it aggregates, and an appended key column would be
    // `42803 column "todos"."id" must appear in the GROUP BY clause`.
    const sql = sqlFor('todos', { select: 'count' });
    assert.equal(sql, 'SELECT "todos"."count" FROM "todos"');
  });

  it('adds nothing when a spread embed hoists an aggregate into the root',
    () => {
      // The aggregate is a field of the spread, not a root select node, so it
      // reaches the root select list without `isAggregated` seeing it. The
      // query still aggregates with no GROUP BY.
      const sql = sqlFor('children', { select: '...todos(n:name.max())' });
      assert.equal(sql.includes('ORDER BY "children"."id"'), false, sql);
    });

  it('orders a to-many embed by the child key', () => {
    const sql = sqlFor('todos', { select: 'name,children(label)' });
    assert.ok(sql.includes('ORDER BY "children"."id" ASC'), sql);
    assert.ok(sql.includes('json_agg("pgrst_agg" ORDER BY "pgrst_o1" ASC)'),
      sql);
  });

  it('leaves a to-one embed unordered', () => {
    // At most one row comes back, so an order over it sorts nothing.
    const sql = sqlFor('children', { select: 'label,todos(name)' });
    assert.equal(sql.includes('ORDER BY "todos"."id"'), false, sql);
    assert.ok(sql.endsWith('ORDER BY "children"."id" ASC'), sql);
  });

  it('emits upstream\'s clause when switched off', () => {
    process.env.PGREST_DETERMINISTIC_ORDER = 'false';
    assert.equal(sqlFor('todos', { select: 'name' }),
      'SELECT "name" FROM "todos"');
    assert.equal(sqlFor('todos', { select: 'name', order: 'done.desc' }),
      'SELECT "name" FROM "todos" ORDER BY "todos"."done" DESC');
  });

  it('stays on for any value that is not the string "false"', () => {
    process.env.PGREST_DETERMINISTIC_ORDER = 'true';
    assert.ok(sqlFor('todos', { select: 'name' }).includes('ORDER BY'));
  });
});
