import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildSelect } from '../sql-builder.mjs';
import { parseQuery } from '../query-parser.mjs';

function norm(s) {
  return s.replace(/\s+/g, ' ').trim();
}

function cols(...names) {
  return Object.fromEntries(names.map(n => [n, { type: 'bigint' }]));
}

const table = (columns, primaryKey, extra = {}) => ({
  columns: cols(...columns), primaryKey, ...extra,
});

const schema = {
  tables: {
    projects: table(['id', 'name', 'client_id'], ['id']),
    clients: table(['id', 'name'], ['id']),
    // a view has no key of its own, so a constraint or column name must
    // not resolve to it
    clients_view: table(['id', 'name'], ['id'], { isView: true }),
    views_only: table(['id', 'view_id'], ['id']),
    family_tree: table(['id', 'name', 'parent'], ['id']),
    users: table(['id', 'name'], ['id']),
    tasks: table(['id', 'name'], ['id']),
    users_tasks: table(['user_id', 'task_id'], ['user_id', 'task_id']),
  },
  relationships: [
    {
      constraint: 'projects_client_id_fkey',
      fromTable: 'projects', fromColumns: ['client_id'],
      toTable: 'clients', toColumns: ['id'],
    },
    {
      constraint: 'views_only_view_id_fkey',
      fromTable: 'views_only', fromColumns: ['view_id'],
      toTable: 'clients_view', toColumns: ['id'],
    },
    {
      constraint: 'family_tree_parent_fkey',
      fromTable: 'family_tree', fromColumns: ['parent'],
      toTable: 'family_tree', toColumns: ['id'],
    },
    {
      constraint: null,
      cardinality: 'many-to-many',
      fromTable: 'users', fromColumns: ['id'],
      toTable: 'tasks', toColumns: ['id'],
      junctionTable: 'users_tasks',
      junctionFromColumns: ['user_id'],
      junctionToColumns: ['task_id'],
      junctionFromConstraint: 'users_tasks_user_id_fkey',
      junctionToConstraint: 'users_tasks_task_id_fkey',
    },
  ],
};

function sqlFor(from, select, extra = {}) {
  const parsed = parseQuery({ select, ...extra }, 'GET');
  return norm(buildSelect(from, parsed, schema).text);
}

describe('embed target resolution', () => {
  it('resolves the foreign table name (many-to-one)', () => {
    const sql = sqlFor('projects', 'id,clients(name)');
    assert.ok(sql.includes('"clients"."id" = "projects"."client_id"'), sql);
    assert.ok(sql.includes('json_build_object'), sql);
    assert.ok(!sql.includes('json_agg'),
      `many-to-one returns an object, got: ${sql}`);
  });

  it('resolves the foreign table name (one-to-many)', () => {
    const sql = sqlFor('clients', 'id,projects(name)');
    assert.ok(sql.includes('"projects"."client_id" = "clients"."id"'), sql);
    assert.ok(sql.includes('json_agg'),
      `one-to-many returns an array, got: ${sql}`);
  });

  it('resolves a foreign key constraint name as the target', () => {
    const sql = sqlFor('projects', 'id,projects_client_id_fkey(name)');
    assert.ok(sql.includes('"clients"."id" = "projects"."client_id"'), sql);
    assert.ok(sql.includes('AS "projects_client_id_fkey"'),
      `the target names the result key, got: ${sql}`);
  });

  it('resolves a foreign key column name as the target', () => {
    const sql = sqlFor('projects', 'id,client_id(name)');
    assert.ok(sql.includes('"clients"."id" = "projects"."client_id"'), sql);
  });

  it('rejects a constraint or column target when the foreign table is a '
    + 'view', () => {
    // A view has no constraint of its own; upstream only allows this
    // spelling for tables (Plan.hs findRel, `not relFTableIsView`).
    for (const target of ['views_only_view_id_fkey', 'view_id']) {
      assert.throws(
        () => sqlFor('views_only', `id,${target}(name)`),
        (err) => err.code === 'PGRST200',
        `'${target}' must not resolve to a view`);
    }
    // the view's own name still works
    assert.ok(sqlFor('views_only', 'id,clients_view(name)')
      .includes('"clients_view"."id" = "views_only"."view_id"'));
  });

  it('accepts the constraint, either column, or nothing as a hint', () => {
    const expected = '"clients"."id" = "projects"."client_id"';
    for (const hint of ['projects_client_id_fkey', 'client_id', 'id']) {
      assert.ok(
        sqlFor('projects', `id,clients!${hint}(name)`).includes(expected),
        `hint '${hint}' should resolve`);
    }
  });

  it('rejects an unknown hint with PGRST200 and upstream details', () => {
    let thrown;
    try {
      sqlFor('projects', 'id,clients!space(name)');
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown, 'an unknown hint must not silently resolve');
    assert.equal(thrown.statusCode, 400);
    assert.equal(thrown.code, 'PGRST200');
    assert.equal(thrown.message,
      "Could not find a relationship between 'projects' and 'clients' "
      + 'in the schema cache');
    assert.equal(thrown.details,
      "Searched for a foreign key relationship between 'projects' and "
      + "'clients' using the hint 'space' in the schema 'public', but no "
      + 'matches were found.');
    assert.equal(thrown.hint, null);
  });

  it('reports an unknown target without a hint clause', () => {
    let thrown;
    try {
      sqlFor('projects', 'id,nope(name)');
    } catch (err) {
      thrown = err;
    }
    assert.equal(thrown.details,
      "Searched for a foreign key relationship between 'projects' and "
      + "'nope' in the schema 'public', but no matches were found.");
  });
});

describe('self relationship embedding', () => {
  it('the column name selects the many-to-one side', () => {
    const sql = sqlFor('family_tree', 'id,parent(id,name)');
    assert.ok(sql.includes('FROM "family_tree" AS "family_tree_1"'),
      `the inner relation needs its own name, got: ${sql}`);
    assert.ok(
      sql.includes('"family_tree_1"."id" = "family_tree"."parent"'), sql);
    assert.ok(!sql.includes('json_agg'), sql);
  });

  it('the table name selects the one-to-many side', () => {
    const sql = sqlFor('family_tree', 'id,children:family_tree(id)');
    assert.ok(
      sql.includes('"family_tree_1"."parent" = "family_tree"."id"'), sql);
    assert.ok(sql.includes('json_agg'),
      `the children side is an array, got: ${sql}`);
  });

  it('a hint naming the key column selects the one-to-many side', () => {
    // upstream: /organizations?select=auditees:organizations!auditor(*)
    const sql = sqlFor('family_tree', 'id,children:family_tree!parent(id)');
    assert.ok(
      sql.includes('"family_tree_1"."parent" = "family_tree"."id"'), sql);
    assert.ok(sql.includes('json_agg'), sql);
    assert.throws(
      () => sqlFor('family_tree', 'id,family_tree!id(id)'),
      (err) => err.code === 'PGRST200',
      'only the key column disambiguates a self relationship');
  });

  it('names every level of a nested self embed distinctly', () => {
    const sql = sqlFor('family_tree', 'id,parent(id,parent(id))');
    assert.ok(sql.includes('"family_tree_1"."id" = "family_tree"."parent"'),
      sql);
    assert.ok(
      sql.includes('"family_tree_2"."id" = "family_tree_1"."parent"'),
      `the second level must not reuse the first alias, got: ${sql}`);
  });

  it('aliases the child of an inner self embed too', () => {
    const sql = sqlFor('family_tree', 'id,parent!inner(id)',
      { 'parent.name': 'eq.x' });
    assert.ok(sql.includes('EXISTS (SELECT 1 FROM "family_tree" AS '
      + '"family_tree_1" WHERE "family_tree_1"."id" = '
      + '"family_tree"."parent"'), sql);
  });
});

describe('many-to-many embedding', () => {
  it('joins through the junction from either end', () => {
    const forward = sqlFor('users', 'id,tasks(id)');
    assert.ok(forward.includes('FROM "tasks"'), forward);
    assert.ok(forward.includes(
      '"users_tasks"."task_id" = "tasks"."id"'), forward);
    assert.ok(forward.includes(
      '"users_tasks"."user_id" = "users"."id"'), forward);

    const reverse = sqlFor('tasks', 'id,users(id)');
    assert.ok(reverse.includes('FROM "users"'), reverse);
    assert.ok(reverse.includes(
      '"users_tasks"."user_id" = "users"."id"'), reverse);
    assert.ok(reverse.includes(
      '"users_tasks"."task_id" = "tasks"."id"'), reverse);
  });

  it('accepts the junction table as a hint', () => {
    const sql = sqlFor('users', 'id,tasks!users_tasks(id)');
    assert.ok(sql.includes('FROM "users_tasks"'), sql);
  });

  it('rejects a hint that is not the junction', () => {
    assert.throws(
      () => sqlFor('users', 'id,tasks!nope(id)'),
      (err) => err.code === 'PGRST200');
  });

  it('qualifies a junction that lives outside the served schema', () => {
    const hidden = {
      tables: schema.tables,
      relationships: [{
        constraint: null,
        cardinality: 'many-to-many',
        fromTable: 'users', fromColumns: ['id'],
        toTable: 'tasks', toColumns: ['id'],
        junctionSchema: 'private',
        junctionTable: 'users_tasks',
        junctionFromColumns: ['user_id'],
        junctionToColumns: ['task_id'],
      }],
    };
    const sql = norm(buildSelect('users',
      parseQuery({ select: 'id,tasks(id)' }, 'GET'), hidden).text);
    assert.ok(sql.includes('FROM "private"."users_tasks"'), sql);
    // the unqualified name still refers to it inside the subquery
    assert.ok(sql.includes('"users_tasks"."task_id" = "tasks"."id"'), sql);
  });

  it('turns !inner into an EXISTS filter on the parent', () => {
    const sql = sqlFor('users', 'id,tasks!inner(id)');
    const conds = sql.slice(sql.indexOf('WHERE'));
    assert.ok(conds.includes('EXISTS (SELECT 1 FROM "tasks"'), sql);
    assert.ok(conds.includes('EXISTS (SELECT 1 FROM "users_tasks"'), sql);
  });
});

describe('one-to-one embedding', () => {
  const o2o = {
    tables: {
      country: table(['id', 'name'], ['id']),
      capital: table(['id', 'name', 'country_id'], ['id']),
      country_view: table(['id', 'name'], ['id'], { isView: true }),
    },
    relationships: [
      {
        constraint: 'capital_country_id_fkey',
        cardinality: 'one-to-one',
        fromTable: 'capital', fromColumns: ['country_id'],
        toTable: 'country', toColumns: ['id'],
      },
      {
        constraint: 'capital_country_id_fkey',
        cardinality: 'one-to-one',
        fromTable: 'capital', fromColumns: ['country_id'],
        toTable: 'country_view', toColumns: ['id'],
      },
    ],
  };

  const sql = (from, select) => norm(
    buildSelect(from, parseQuery({ select }, 'GET'), o2o).text);

  it('returns an object from the key side', () => {
    const out = sql('capital', 'name,country(name)');
    assert.ok(out.includes('"country"."id" = "capital"."country_id"'), out);
    assert.ok(!out.includes('json_agg'), out);
  });

  it('returns an object from the referenced side too', () => {
    // /country?select=name,capital(name) — the FK is on the child, but a
    // unique key on it means at most one row, so PostgREST returns an
    // object rather than an array.
    const out = sql('country', 'name,capital(name)');
    assert.ok(out.includes('"capital"."country_id" = "country"."id"'), out);
    assert.ok(!out.includes('json_agg'),
      `a one-to-one embed must not be aggregated: ${out}`);
    assert.ok(!out.includes("'[]'::json"),
      `a missing row is null, not an empty array: ${out}`);
  });

  it('accepts either side\'s key column as a hint', () => {
    for (const hint of ['id', 'country_id', 'capital_country_id_fkey']) {
      const out = sql('country', `name,capital!${hint}(name)`);
      assert.ok(out.includes('"capital"."country_id" = "country"."id"'),
        `hint '${hint}': ${out}`);
      assert.ok(!out.includes('json_agg'), `hint '${hint}': ${out}`);
    }
  });

  it('keeps working through a view over the referenced side', () => {
    const out = sql('capital', 'name,country_view(name)');
    assert.ok(
      out.includes('"country_view"."id" = "capital"."country_id"'), out);
    assert.ok(!out.includes('json_agg'), out);
  });

  it('filters the parent on the child row with !inner', () => {
    const out = norm(buildSelect('country',
      parseQuery({ select: 'name,capital!inner(name)' }, 'GET'), o2o).text);
    assert.ok(out.includes('EXISTS (SELECT 1 FROM "capital"'), out);
  });

  it('reports the one-to-one cardinality in PGRST201 details', () => {
    // upstream EmbedDisambiguationSpec: /first?select=second(*)
    const ambiguous = {
      tables: {
        first: table(['id', 'second_id_1', 'second_id_2'], ['id']),
        second: table(['id', 'name'], ['id']),
      },
      relationships: [
        {
          constraint: 'first_second_id_1_fkey',
          cardinality: 'one-to-one',
          fromTable: 'first', fromColumns: ['second_id_1'],
          toTable: 'second', toColumns: ['id'],
        },
        {
          constraint: 'first_second_id_2_fkey',
          cardinality: 'one-to-one',
          fromTable: 'first', fromColumns: ['second_id_2'],
          toTable: 'second', toColumns: ['id'],
        },
      ],
    };
    let thrown;
    try {
      buildSelect('first', parseQuery({ select: 'second(*)' }, 'GET'),
        ambiguous);
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown);
    assert.deepStrictEqual(thrown.toJSON(), {
      code: 'PGRST201',
      message: 'Could not embed because more than one relationship was '
        + "found for 'first' and 'second'",
      details: [
        {
          cardinality: 'one-to-one',
          embedding: 'first with second',
          relationship: 'first_second_id_1_fkey using first(second_id_1) '
            + 'and second(id)',
        },
        {
          cardinality: 'one-to-one',
          embedding: 'first with second',
          relationship: 'first_second_id_2_fkey using first(second_id_2) '
            + 'and second(id)',
        },
      ],
      hint: "Try changing 'second' to one of the following: "
        + "'second!first_second_id_1_fkey', "
        + "'second!first_second_id_2_fkey'. Find the desired relationship "
        + "in the 'details' key.",
    });
  });
});

describe('ambiguous embed error body', () => {
  const ambiguous = {
    tables: {
      agents: table(['id', 'name', 'department_id'], ['id']),
      departments: table(['id', 'name', 'head_id'], ['id']),
    },
    relationships: [
      {
        constraint: 'agents_department_id_fkey',
        fromTable: 'agents', fromColumns: ['department_id'],
        toTable: 'departments', toColumns: ['id'],
      },
      {
        constraint: 'departments_head_id_fkey',
        fromTable: 'departments', fromColumns: ['head_id'],
        toTable: 'agents', toColumns: ['id'],
      },
    ],
  };

  it('matches upstream PGRST201 exactly', () => {
    const parsed = parseQuery({ select: '*,departments(*)' }, 'GET');
    let thrown;
    try {
      buildSelect('agents', parsed, ambiguous);
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown, 'two candidate relationships must not be guessed');
    assert.equal(thrown.statusCode, 300);
    assert.deepStrictEqual(thrown.toJSON(), {
      code: 'PGRST201',
      message: 'Could not embed because more than one relationship was '
        + "found for 'agents' and 'departments'",
      details: [
        {
          cardinality: 'one-to-many',
          embedding: 'agents with departments',
          relationship: 'departments_head_id_fkey using agents(id) and '
            + 'departments(head_id)',
        },
        {
          cardinality: 'many-to-one',
          embedding: 'agents with departments',
          relationship: 'agents_department_id_fkey using '
            + 'agents(department_id) and departments(id)',
        },
      ],
      hint: "Try changing 'departments' to one of the following: "
        + "'departments!departments_head_id_fkey', "
        + "'departments!agents_department_id_fkey'. Find the desired "
        + "relationship in the 'details' key.",
    });
  });

  it('a hint disambiguates both directions', () => {
    const m2o = norm(buildSelect('agents',
      parseQuery({ select: 'id,departments!agents_department_id_fkey(id)' },
        'GET'), ambiguous).text);
    assert.ok(m2o.includes('"departments"."id" = "agents"."department_id"'),
      m2o);
    const o2m = norm(buildSelect('agents',
      parseQuery({ select: 'id,departments!departments_head_id_fkey(id)' },
        'GET'), ambiguous).text);
    assert.ok(o2m.includes('"departments"."head_id" = "agents"."id"'), o2m);
  });

  it('reports a many-to-many candidate with its junction columns', () => {
    const both = {
      tables: schema.tables,
      relationships: [
        ...schema.relationships,
        {
          constraint: 'users_favourite_task_fkey',
          fromTable: 'users', fromColumns: ['id'],
          toTable: 'tasks', toColumns: ['id'],
        },
      ],
    };
    let thrown;
    try {
      buildSelect('users', parseQuery({ select: 'id,tasks(id)' }, 'GET'),
        both);
    } catch (err) {
      thrown = err;
    }
    assert.equal(thrown.code, 'PGRST201');
    const m2m = thrown.details.find(
      d => d.cardinality === 'many-to-many');
    assert.equal(m2m.relationship,
      'users_tasks using users_tasks_user_id_fkey(user_id) and '
      + 'users_tasks_task_id_fkey(task_id)');
    assert.ok(thrown.hint.includes("'tasks!users_tasks'"), thrown.hint);
  });
});
