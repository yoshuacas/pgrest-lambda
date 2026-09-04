// Runner: the targeted restore, now that Aurora DSQL enforces foreign keys
// (2026-08-27 — docs/plans/dsql-foreign-keys.md).
//
// Before enforcement, restoring one table meant re-applying its 07-data.sql
// block in file order. With the keys live, `DELETE FROM parent` fails 23503
// while a child still holds rows, and an INSERT into a child fails 23503 before
// its parent is filled. expandRestoreSet() pulls the children in and orders the
// two passes; restoreTables() splits each fixture block between them. Nothing
// checked either, which is how the plan argument came to be dropped at the call
// site: the ordering was computed and thrown away, and every restore would have
// hit 23503 on the first parent with a child.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  expandRestoreSet, restoreTables, parseFixtureGroups, readForeignKeyGraph,
} from '../runner/run.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_PATH = join(HERE, '..', 'fixtures', 'dsql', '07-data.sql');

/** A graph in readForeignKeyGraph()'s shape from `child -> parent` pairs. */
function graphOf(pairs) {
  const parents = new Map();
  const children = new Map();
  for (const [child, parent] of pairs) {
    if (!parents.has(child)) parents.set(child, new Set());
    parents.get(child).add(parent);
    if (!children.has(parent)) children.set(parent, new Set());
    children.get(parent).add(child);
  }
  return { parents, children, edges: pairs.length, selfEdges: 0 };
}

const TABLES = new Set([
  'public.projects', 'public.tasks', 'public.comments', 'public.users',
  'public.clients', 'public.loose',
]);

// clients <- projects <- tasks <- comments, and comments also references users.
const GRAPH = graphOf([
  ['public.projects', 'public.clients'],
  ['public.tasks', 'public.projects'],
  ['public.comments', 'public.tasks'],
  ['public.comments', 'public.users'],
]);

describe('expandRestoreSet', () => {
  it('pulls in every table that references a touched one, transitively', () => {
    const plan = expandRestoreSet(new Set(['public.clients']), GRAPH, TABLES);
    assert.deepEqual(new Set(plan.refill), new Set([
      'public.clients', 'public.projects', 'public.tasks', 'public.comments',
    ]));
    // users is a parent of comments, not a child of anything touched: filling
    // comments needs the rows users already has, not a reload of users.
    assert.ok(!plan.refill.includes('public.users'), 'users');
  });

  it('refills parents first and clears children first', () => {
    const plan = expandRestoreSet(new Set(['public.clients']), GRAPH, TABLES);
    const at = (k) => plan.refill.indexOf(k);
    assert.ok(at('public.clients') < at('public.projects'), 'clients<projects');
    assert.ok(at('public.projects') < at('public.tasks'), 'projects<tasks');
    assert.ok(at('public.tasks') < at('public.comments'), 'tasks<comments');
    assert.deepEqual(plan.clear, [...plan.refill].reverse());
  });

  it('leaves a table with no keys on its own', () => {
    const plan = expandRestoreSet(new Set(['public.loose']), GRAPH, TABLES);
    assert.deepEqual(plan, { clear: ['public.loose'], refill: ['public.loose'] });
  });

  it('orders the same way whichever order the touched set arrives in', () => {
    const a = expandRestoreSet(
      new Set(['public.comments', 'public.clients']), GRAPH, TABLES);
    const b = expandRestoreSet(
      new Set(['public.clients', 'public.comments']), GRAPH, TABLES);
    assert.deepEqual(a.refill, b.refill);
  });

  it('gives up on a cycle rather than guessing an order', () => {
    // upstream's fixtures hold exactly one: departments <-> agents.
    const cyclic = graphOf([
      ['public.agents', 'public.departments'],
      ['public.departments', 'public.agents'],
    ]);
    assert.equal(
      expandRestoreSet(new Set(['public.agents']), cyclic,
        new Set(['public.agents', 'public.departments'])),
      null);
  });

  it('gives up when the catalog does not cover a table in the set', () => {
    // Its dependents are unknown, so clearing it could hit 23503.
    assert.equal(
      expandRestoreSet(new Set(['public.tasks']), GRAPH,
        new Set(['public.tasks'])),
      null, 'child of the set missing');
    assert.equal(
      expandRestoreSet(new Set(['public.gone']), GRAPH, TABLES), null,
      'touched table missing');
  });

  it('needs a graph, and short-circuits an empty touched set', () => {
    assert.deepEqual(expandRestoreSet(new Set(), null, TABLES),
      { clear: [], refill: [] });
    assert.equal(expandRestoreSet(new Set(['public.tasks']), null, TABLES), null);
  });
});

describe('readForeignKeyGraph', () => {
  it('binds the schema list and drops self-references', async () => {
    const calls = [];
    const pool = {
      query(text, values) {
        calls.push({ text, values });
        return Promise.resolve({ rows: [
          { child_schema: 'public', child_table: 'tasks',
            parent_schema: 'public', parent_table: 'projects' },
          { child_schema: 'public', child_table: 'tree',
            parent_schema: 'public', parent_table: 'tree' },
        ] });
      },
    };
    const graph = await readForeignKeyGraph(pool, ['public', 'private']);
    assert.deepEqual(calls[0].values, [['public', 'private']]);
    assert.ok(!/'public'/.test(calls[0].text), 'schema is bound, not inlined');
    assert.equal(graph.edges, 1);
    assert.equal(graph.selfEdges, 1);
    assert.deepEqual([...graph.parents.get('public.tasks')],
      ['public.projects']);
    assert.equal(graph.parents.has('public.tree'), false);
  });
});

/** A pool that records every statement and answers `show search_path`. */
function fakePool() {
  const sql = [];
  return {
    sql,
    query(text, values) {
      if (/^show search_path$/.test(text)) {
        return Promise.resolve({ rows: [{ search_path: '"$user", public' }] });
      }
      if (/set_config/.test(text)) {
        sql.push(`search_path=${values[1]}`);
        return Promise.resolve({ rows: [] });
      }
      sql.push(text.replace(/\s+/g, ' ').trim());
      return Promise.resolve({ rows: [] });
    },
  };
}

const GROUP_SQL = `
SET search_path = public, pg_catalog;

DELETE FROM projects;
DELETE FROM tasks;
INSERT INTO projects VALUES (1);
INSERT INTO tasks VALUES (1, 1);
`;

describe('restoreTables', () => {
  const groups = parseFixtureGroups(GROUP_SQL);

  it('clears children first and refills parents first, given a plan',
    async () => {
      const pool = fakePool();
      const plan = {
        clear: ['public.tasks', 'public.projects'],
        refill: ['public.projects', 'public.tasks'],
      };
      const applied = await restoreTables(
        pool, new Set(['public.projects', 'public.tasks']), groups, plan);
      assert.equal(applied, 4);
      assert.deepEqual(pool.sql.filter(s => !s.startsWith('search_path=')), [
        'DELETE FROM tasks;',
        'DELETE FROM projects;',
        'INSERT INTO projects VALUES (1);',
        'INSERT INTO tasks VALUES (1, 1);',
      ]);
    });

  it('runs a fixture block in file order when there is no plan', async () => {
    const pool = fakePool();
    const applied = await restoreTables(
      pool, new Set(['public.projects', 'public.tasks']), groups);
    assert.equal(applied, 4);
    assert.deepEqual(pool.sql.filter(s => !s.startsWith('search_path=')), [
      'DELETE FROM projects;',
      'INSERT INTO projects VALUES (1);',
      'DELETE FROM tasks;',
      'INSERT INTO tasks VALUES (1, 1);',
    ]);
  });

  it('empties a planned table 07-data.sql never populates', async () => {
    const pool = fakePool();
    const plan = { clear: ['public.simple_pk2'], refill: ['public.simple_pk2'] };
    const applied = await restoreTables(
      pool, new Set(['public.simple_pk2']), groups, plan);
    assert.equal(applied, 1);
    assert.deepEqual(pool.sql, ['DELETE FROM "public"."simple_pk2"']);
  });

  it('puts the connection search_path back', async () => {
    const pool = fakePool();
    await restoreTables(pool, new Set(['public.projects']), groups,
      { clear: ['public.projects'], refill: ['public.projects'] });
    assert.equal(pool.sql.at(-1), 'search_path="$user", public');
  });

  it('does nothing for an empty set', async () => {
    const pool = fakePool();
    assert.equal(await restoreTables(pool, new Set(), groups), 0);
    assert.deepEqual(pool.sql, []);
  });
});

describe('the real 07-data.sql, against the plan path', () => {
  const groups = parseFixtureGroups(readFileSync(DATA_PATH, 'utf8'));

  it('opens with one leading block that empties every table it writes to',
    () => {
      // The transformer hoists the deletes so the file can be re-applied on its
      // own with the keys enforced. Every group must carry its own DELETE, or
      // the clearing pass has nothing to run for it.
      assert.equal(groups.order.length, groups.groups.size);
      const missing = [...groups.groups.entries()]
        .filter(([, g]) => !g.statements.some(
          s => /^\s*(--[^\n]*\n\s*)*delete\s+from\b/i.test(s)))
        .map(([k]) => k);
      assert.deepEqual(missing, []);
    });

  it('carries the cycle-breaking UPDATE ahead of its own DELETE', () => {
    // public.departments <-> public.agents cannot be ordered, so the
    // transformer clears the reference first. It parses into the agents group,
    // which is why restoreTables() splits a group by statement kind and not by
    // position.
    const agents = groups.groups.get('public.agents');
    assert.ok(agents, 'public.agents group');
    assert.match(agents.statements[0],
      /UPDATE "public"\."agents" SET "department_id" = NULL;/);
    const del = agents.statements.findIndex(s => /^\s*DELETE\s+FROM/i.test(s));
    assert.equal(del, 1, 'the DELETE follows it');
  });
});
