// sql-builder-mutation-order.test.mjs — `?order=` on a mutation's returned
// representation.
//
// A RETURNING list has no ORDER BY, so a mutation whose representation comes
// straight out of RETURNING returns rows in whatever order the statement
// touched them. Upstream plans every mutation's representation over the source
// CTE (Plan.hs `mutateReadPlan` + `addRels`), which is where the ORDER BY goes;
// UpdateSpec.hs:444 "with ordering on top-level resource" and
// QueryLimitedSpec.hs:97/:108 assert exactly that.
//
//   node --test src/rest/__tests__/sql-builder-mutation-order.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDelete, buildMutationRead, buildUpdate, mutationNeedsReadPlan,
} from '../sql-builder.mjs';
import { parseQuery } from '../query-parser.mjs';

const schema = {
  tables: {
    no_pk: {
      columns: { a: { type: 'text' }, b: { type: 'text' } },
      primaryKey: [],
    },
    employees: {
      columns: {
        first_name: { type: 'text' },
        last_name: { type: 'text' },
        occupation: { type: 'text' },
      },
      primaryKey: ['first_name', 'last_name'],
    },
    children: {
      columns: {
        id: { type: 'int8' },
        emp: { type: 'text' },
        label: { type: 'text' },
      },
      primaryKey: ['id'],
    },
  },
  relationships: [],
};

const parse = (query, method) => ({
  ...parseQuery(query, method),
  allowBulkMutation: true,
});

const flat = (sql) => sql.replace(/\s+/g, ' ').trim();

describe('mutationNeedsReadPlan', () => {
  it('is false for a mutation with neither an order nor an embed', () => {
    assert.equal(
      mutationNeedsReadPlan(parseQuery({ select: 'a,b' }, 'PATCH')), false);
  });

  it('is true when the request orders the representation', () => {
    assert.equal(
      mutationNeedsReadPlan(parseQuery({ order: 'a.desc' }, 'PATCH')), true);
  });

  it('is true when the select list embeds', () => {
    assert.equal(
      mutationNeedsReadPlan(parseQuery({ select: 'a,children(label)' },
        'PATCH')), true);
  });

  it('tolerates a parsed request with no select or order at all', () => {
    assert.equal(mutationNeedsReadPlan({}), false);
    assert.equal(mutationNeedsReadPlan(undefined), false);
  });
});

describe('an ordered PATCH representation', () => {
  it('keeps the whole row in RETURNING so the read plan can order it', () => {
    const parsed = parse({ order: 'a.desc' }, 'PATCH');
    const q = buildUpdate('no_pk', { b: '1' }, parsed, schema, null,
      { readPlan: true });
    assert.equal(flat(q.text),
      'UPDATE "no_pk" SET "b" = $1 RETURNING *');
  });

  it('orders the representation over the mutation\'s source CTE', () => {
    const parsed = parse({ order: 'a.desc' }, 'PATCH');
    const q = buildUpdate('no_pk', { b: '1' }, parsed, schema, null,
      { readPlan: true });
    const read = buildMutationRead(q, 'no_pk', parsed, schema, null);
    assert.equal(flat(read.text),
      'WITH pgrst_source AS (UPDATE "no_pk" SET "b" = $1 RETURNING *)'
      + ' SELECT "a", "b" FROM pgrst_source AS "no_pk"'
      + ' ORDER BY "no_pk"."a" DESC, "no_pk"."b" ASC');
    assert.deepEqual(read.values, ['1']);
  });

  it('projects ?select= over the CTE, not in RETURNING', () => {
    // The order may name a column the select list leaves out, so RETURNING
    // cannot narrow — the outer read plan does.
    const parsed = parse(
      { select: 'first_name,last_name,occupation', order: 'last_name' },
      'PATCH');
    const q = buildUpdate('employees', { occupation: 'Barista' }, parsed,
      schema, null, { readPlan: true });
    const read = buildMutationRead(q, 'employees', parsed, schema, null);
    assert.equal(flat(read.text),
      'WITH pgrst_source AS'
      + ' (UPDATE "employees" SET "occupation" = $1 RETURNING *)'
      + ' SELECT "first_name", "last_name", "occupation"'
      + ' FROM pgrst_source AS "employees"'
      + ' ORDER BY "employees"."last_name" ASC, "employees"."first_name" ASC');
  });

  it('still narrows in RETURNING when nothing orders the representation',
    () => {
      // The cheaper path, one query level less. `readPlan` is what the handler
      // passes when it is going to wrap the statement, and it does not here.
      const parsed = parse({ select: 'a' }, 'PATCH');
      const q = buildUpdate('no_pk', { b: '1' }, parsed, schema, null, {});
      assert.equal(flat(q.text), 'UPDATE "no_pk" SET "b" = $1 RETURNING "a"');
    });
});

describe('an ordered DELETE representation', () => {
  it('keeps the whole row in RETURNING and orders over the CTE', () => {
    const parsed = parse(
      { select: 'first_name,last_name', order: 'last_name' }, 'DELETE');
    const q = buildDelete('employees', parsed, schema, null,
      { readPlan: true });
    assert.equal(flat(q.text), 'DELETE FROM "employees" RETURNING *');
    const read = buildMutationRead(q, 'employees', parsed, schema, null);
    assert.equal(flat(read.text),
      'WITH pgrst_source AS (DELETE FROM "employees" RETURNING *)'
      + ' SELECT "first_name", "last_name" FROM pgrst_source AS "employees"'
      + ' ORDER BY "employees"."last_name" ASC, "employees"."first_name" ASC');
  });

  it('narrows in RETURNING when the request does not order', () => {
    const parsed = parse({ select: 'first_name' }, 'DELETE');
    const q = buildDelete('employees', parsed, schema, null, {});
    assert.equal(flat(q.text),
      'DELETE FROM "employees" RETURNING "first_name"');
  });
});
