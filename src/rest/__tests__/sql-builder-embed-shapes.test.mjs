// Shapes of the SQL the embedding core emits: spread embeds, empty embeds,
// embed-null filters, computed relationships and related order.
//
// Every expectation here is taken from upstream behaviour:
//   * spread    — Plan.hs `SpreadRelation`, SpreadQueriesSpec
//   * empty     — Plan.hs `rsEmptyEmbed`, `addNullEmbedFilters`
//   * embedNull — SqlFragment.hs `CoercibleFilterNullEmbed`
//   * computed  — Relationship.hs `allComputedRels`, ComputedRelsSpec
//   * order     — QueryParams.hs `pOrderRelationTerm`, RelatedQueriesSpec

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildSelect, buildCount } from '../sql-builder.mjs';
import { parseQuery } from '../query-parser.mjs';

function norm(s) {
  return s.replace(/\s+/g, ' ').trim();
}

function cols(spec) {
  return Object.fromEntries(
    Object.entries(spec).map(([n, t]) => [n, { type: t }]));
}

const schema = {
  tables: {
    factories: {
      columns: cols({ id: 'bigint', name: 'text' }),
      primaryKey: ['id'],
    },
    processes: {
      columns: cols({
        id: 'bigint', name: 'text', factory_id: 'bigint',
        category_id: 'bigint',
      }),
      primaryKey: ['id'],
    },
    operators: {
      columns: cols({ id: 'bigint', name: 'text' }),
      primaryKey: ['id'],
    },
    process_operator: {
      columns: cols({ process_id: 'bigint', operator_id: 'bigint' }),
      primaryKey: ['process_id', 'operator_id'],
    },
    clients: {
      columns: cols({ id: 'bigint', name: 'text' }),
      primaryKey: ['id'],
    },
    projects: {
      columns: cols({ id: 'bigint', name: 'text', client_id: 'bigint' }),
      primaryKey: ['id'],
    },
  },
  relationships: [
    {
      constraint: 'processes_factory_id_fkey',
      fromTable: 'processes', fromColumns: ['factory_id'],
      toTable: 'factories', toColumns: ['id'],
    },
    {
      constraint: 'projects_client_id_fkey',
      fromTable: 'projects', fromColumns: ['client_id'],
      toTable: 'clients', toColumns: ['id'],
    },
    {
      constraint: null,
      cardinality: 'many-to-many',
      fromTable: 'operators', fromColumns: ['id'],
      toTable: 'processes', toColumns: ['id'],
      junctionTable: 'process_operator',
      junctionFromColumns: ['operator_id'],
      junctionToColumns: ['process_id'],
      junctionFromConstraint: 'process_operator_operator_id_fkey',
      junctionToConstraint: 'process_operator_process_id_fkey',
    },
    {
      computed: true,
      function: 'computed_clients',
      fromTable: 'projects',
      toTable: 'clients',
      toOne: true,
      source: 'computed',
    },
    {
      computed: true,
      function: 'computed_projects',
      fromTable: 'clients',
      toTable: 'projects',
      toOne: false,
      source: 'computed',
    },
  ],
};

function sqlFor(table, params) {
  const parsed = parseQuery(params, 'GET');
  const { text, values } = buildSelect(table, parsed, schema);
  return { sql: norm(text), values };
}

describe('spread embeds', () => {
  // `...factories(name)` merges the parent-side row's members into the
  // parent object, so the embed cannot be a scalar subquery per field —
  // upstream joins it once as a LATERAL and reads its columns.
  it('to-one spread joins a lateral and lifts each column', () => {
    const { sql } = sqlFor('processes', {
      select: 'name,...factories(factory:name)',
    });
    assert.ok(
      sql.includes('LEFT JOIN LATERAL (SELECT "factories"."name" '
        + 'AS "pgrst_s1" FROM "factories" WHERE "factories"."id" = '
        + '"processes"."factory_id") AS "pgrst_spread_1" ON TRUE'),
      `spread should join a lateral, got: ${sql}`);
    assert.ok(
      sql.includes('"pgrst_spread_1"."pgrst_s1" AS "factory"'),
      `spread column should be aliased, got: ${sql}`);
    assert.ok(
      !sql.includes('json_build_object'),
      `a spread contributes no object, got: ${sql}`);
  });

  // A to-many spread emits one row-aligned array per selected column, which
  // only works if every column is aggregated over the *same* pass over the
  // child rows.
  it('to-many spread aggregates one array per column from one pass', () => {
    const { sql } = sqlFor('factories', {
      select: 'name,...processes(processes:name,categories:category_id)',
    });
    assert.ok(
      sql.includes('COALESCE(json_agg("pgrst_src"."pgrst_s1"), '
        + `'[]'::json) AS "pgrst_s1"`),
      `first column should aggregate, got: ${sql}`);
    assert.ok(
      sql.includes('COALESCE(json_agg("pgrst_src"."pgrst_s2"), '
        + `'[]'::json) AS "pgrst_s2"`),
      `second column should aggregate, got: ${sql}`);
    assert.ok(
      (sql.match(/AS "pgrst_src"/g) || []).length === 1,
      `both arrays must come from one pass, got: ${sql}`);
  });

  it('spread order applies inside the aggregate', () => {
    const { sql } = sqlFor('factories', {
      select: 'name,...processes(processes:name)',
      'processes.order': 'name.desc',
    });
    assert.ok(
      sql.includes('json_agg("pgrst_src"."pgrst_s1" ORDER BY '
        + '"pgrst_src"."pgrst_o1" DESC)'),
      `spread order should order the aggregate, got: ${sql}`);
  });

  // A bare column name in ORDER BY binds to an *output* column first, and the
  // output column of a to-many spread is a json array — `ORDER BY "name"`
  // then fails with 42883 (no ordering operator for json). Qualifying it with
  // the relation is what keeps it pointing at the table's column.
  it('parent order stays qualified when a spread shadows the name', () => {
    const { sql } = sqlFor('factories', {
      select: 'name,...processes(name)',
      order: 'name',
    });
    assert.ok(
      sql.includes('ORDER BY "factories"."name" ASC'),
      `parent order must be relation-qualified, got: ${sql}`);
  });
});

describe('empty embeds', () => {
  it('an empty embed contributes no key', () => {
    const { sql } = sqlFor('factories', { select: 'name,processes()' });
    assert.ok(
      !sql.includes('json_agg'),
      `an empty embed selects nothing, got: ${sql}`);
    assert.ok(
      sql.startsWith('SELECT "factories"."name" FROM "factories"'),
      `only the parent column should be selected, got: ${sql}`);
  });

  it('an empty embed still resolves for a null filter', () => {
    const { sql } = sqlFor('factories', {
      select: 'name,processes()',
      processes: 'not.is.null',
    });
    assert.ok(
      sql.includes('WHERE EXISTS (SELECT 1 FROM "processes" WHERE '
        + '"processes"."factory_id" = "factories"."id")'),
      `not.is.null on an embed is an EXISTS, got: ${sql}`);
  });
});

describe('embed null filters', () => {
  it('is.null on an embed is NOT EXISTS', () => {
    const { sql } = sqlFor('factories', {
      select: 'name,processes(name)',
      processes: 'is.null',
    });
    assert.ok(
      sql.includes('WHERE NOT EXISTS (SELECT 1 FROM "processes"'),
      `is.null on an embed is NOT EXISTS, got: ${sql}`);
  });

  it('an embed null filter honours the embed own filters', () => {
    const { sql, values } = sqlFor('factories', {
      select: 'name,processes(name)',
      processes: 'not.is.null',
      'processes.name': 'eq.Process A1',
    });
    assert.deepStrictEqual(values, ['Process A1', 'Process A1']);
    assert.ok(
      sql.includes('EXISTS (SELECT 1 FROM "processes" WHERE '
        + '"processes"."factory_id" = "factories"."id" AND "name" = $2)'),
      `the EXISTS should carry the embed filter, got: ${sql}`);
  });

  it('an embed null filter resolves through a junction', () => {
    const { sql } = sqlFor('operators', {
      select: 'name,processes()',
      processes: 'is.null',
    });
    assert.ok(
      sql.includes('NOT EXISTS (SELECT 1 FROM "processes" WHERE EXISTS '
        + '(SELECT 1 FROM "process_operator"'),
      `many-to-many null filter goes through the junction, `
      + `got: ${sql}`);
  });
});

describe('computed relationships', () => {
  it('a computed embed calls the function with the parent row', () => {
    const { sql } = sqlFor('projects', {
      select: 'name,computed_clients(name)',
    });
    assert.ok(
      sql.includes('FROM "computed_clients"("projects"::"projects") '
        + 'AS "clients"'),
      `a computed embed calls the function, got: ${sql}`);
  });

  // `ROWS 1` is a promise the function makes, not one the database enforces,
  // and a scalar subquery raises 21000 on the second row (ComputedRelsSpec:180
  // has a `SETOF ... ROWS 1` function that returns two).
  it('a to-one computed embed caps itself at one row', () => {
    const { sql } = sqlFor('projects', {
      select: 'name,computed_clients(name)',
    });
    assert.ok(
      sql.includes('LIMIT 1)'),
      `a to-one computed embed needs LIMIT 1, got: ${sql}`);
  });

  it('a to-many computed embed aggregates', () => {
    const { sql } = sqlFor('clients', {
      select: 'name,computed_projects(name)',
    });
    assert.ok(
      sql.includes('json_agg(json_build_object')
      && sql.includes('FROM "computed_projects"("clients"::"clients") '
        + 'AS "projects"'),
      `a to-many computed embed aggregates, got: ${sql}`);
  });

  // Upstream unions the computed relationships over the foreign-key ones
  // (`getOverrideRelationshipsMap`), so a computed relationship wins a name
  // clash.
  it('a computed relationship overrides a foreign key of the same name',
    () => {
      const withClash = {
        ...schema,
        relationships: [
          ...schema.relationships,
          {
            computed: true,
            function: 'clients',
            fromTable: 'projects',
            toTable: 'clients',
            toOne: true,
            source: 'computed',
          },
        ],
      };
      const parsed = parseQuery({ select: 'name,clients(name)' }, 'GET');
      const { text } = buildSelect('projects', parsed, withClash);
      assert.ok(
        norm(text).includes('FROM "clients"("projects"::"projects")'),
        `the computed relationship should win, got: ${norm(text)}`);
    },
  );
});

describe('related order', () => {
  it('orders the parent by a to-one embed column', () => {
    const { sql } = sqlFor('projects', {
      select: 'name,clients(name)',
      order: 'clients(name).desc',
    });
    assert.ok(
      sql.includes('ORDER BY (SELECT "clients"."name" FROM "clients" '
        + 'WHERE "clients"."id" = "projects"."client_id") DESC'),
      `related order should be a scalar subquery, got: ${sql}`);
  });

  it('rejects a related order on a relation that is not embedded', () => {
    assert.throws(
      () => sqlFor('projects', {
        select: 'name',
        order: 'clients(name)',
      }),
      (err) => err.statusCode === 400 && err.code === 'PGRST108'
        && err.message
          === `'clients' is not an embedded resource in this request`
        && err.hint === `Verify that 'clients' is included in the `
          + `'select' query parameter.`,
      'a non-embedded relation should raise PGRST108',
    );
  });

  it('rejects a related order on a to-many embed', () => {
    assert.throws(
      () => sqlFor('factories', {
        select: 'name,processes(name)',
        order: 'processes(name)',
      }),
      (err) => err.statusCode === 400 && err.code === 'PGRST118'
        && err.message === `A related order on 'processes' is not possible`
        && err.details === `'factories' and 'processes' do not form a `
          + `many-to-one or one-to-one relationship`,
      'a to-many related order should raise PGRST118',
    );
  });
});

describe('buildCount with embeds', () => {
  // The count runs over the same plan as the read, so an `!inner` embed that
  // drops parent rows has to drop them from the count too, or Content-Range
  // claims more rows than the body holds.
  it('folds an !inner embed into the count', () => {
    const parsed = parseQuery(
      { select: 'name,factories!inner(name)' }, 'GET');
    const { text } = buildCount('processes', parsed, schema);
    assert.ok(
      norm(text).includes('SELECT COUNT(*) FROM "processes" '
        + 'WHERE EXISTS (SELECT 1 FROM "factories"'),
      `count should see the inner join, got: ${norm(text)}`);
  });

  it('folds an embed null filter into the count', () => {
    const parsed = parseQuery(
      { select: 'name,processes()', processes: 'is.null' }, 'GET');
    const { text } = buildCount('factories', parsed, schema);
    assert.ok(
      norm(text).includes('WHERE NOT EXISTS (SELECT 1 FROM "processes"'),
      `count should see the null embed filter, got: ${norm(text)}`);
  });
});

describe('nested embeds', () => {
  it('routes a filter to the level that owns it', () => {
    const { sql, values } = sqlFor('factories', {
      select: 'name,processes(name,operators(name))',
      'processes.operators.name': 'eq.Alfred',
    });
    assert.deepStrictEqual(values, ['Alfred']);
    // The filter belongs to the innermost subquery, which is the one that
    // reads `process_operator`.
    const inner = sql.slice(sql.indexOf('"operators"'));
    assert.ok(
      inner.includes('"name" = $1'),
      `the filter should land on the nested embed, got: ${sql}`);
  });

  it('an !inner nested embed also filters the parent', () => {
    const { sql } = sqlFor('factories', {
      select: 'name,processes!inner(name,operators!inner(name))',
    });
    assert.ok(
      sql.includes('WHERE EXISTS (SELECT 1 FROM "processes" WHERE '
        + '"processes"."factory_id" = "factories"."id" AND EXISTS '
        + '(SELECT 1 FROM "operators"'),
      `a nested !inner should nest into the parent EXISTS, got: ${sql}`);
  });
});
