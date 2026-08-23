// sql-builder-rpc.test.mjs — SQL emission for stored function calls.
//
// Mirrors upstream PostgREST.Query.QueryBuilder (`callPlanToQuery`) and
// PostgREST.Plan (`callReadPlan`): only the supplied parameters are named so
// DEFAULTs survive, every argument carries the parameter's type cast, a
// variadic parameter is passed with VARIADIC, a scalar return comes back under
// one fixed column, and a function that returns a relation takes the same read
// plan a table read takes.
//
//   node --test src/rest/__tests__/sql-builder-rpc.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as sqlBuilder from '../sql-builder.mjs';

const { buildSelect, buildRpcCall, RPC_SCALAR } = sqlBuilder;

function arg(name, type, extra = {}) {
  return {
    name, type, castType: type, required: true, variadic: false, ...extra,
  };
}

const scalarSchema = {
  name: 'add',
  args: [arg('a', 'integer'), arg('b', 'integer')],
  returnType: 'int4',
  returnRelation: 'int4',
  returnColumns: null,
  returnsSet: false,
  returnsComposite: false,
  isScalar: true,
  numDefaults: 0,
};

const voidSchema = {
  name: 'do_thing',
  args: [],
  returnType: 'void',
  returnRelation: 'void',
  returnColumns: null,
  returnsSet: false,
  returnsComposite: false,
  isScalar: false,
  numDefaults: 0,
};

const setReturningSchema = {
  name: 'get_items',
  args: [arg('user_id', 'uuid')],
  returnType: 'record',
  returnRelation: 'record',
  returnColumns: [
    { name: 'id', type: 'uuid' },
    { name: 'name', type: 'text' },
    { name: 'status', type: 'text' },
  ],
  returnsSet: true,
  returnsComposite: true,
  isScalar: false,
  numDefaults: 0,
};

const untypedSetSchema = {
  name: 'generic_fn',
  args: [arg('x', 'integer')],
  returnType: 'record',
  returnRelation: 'record',
  returnColumns: null,
  returnsSet: true,
  returnsComposite: true,
  isScalar: false,
  numDefaults: 0,
};

const optionalArgSchema = {
  name: 'calc',
  args: [
    arg('x', 'integer'),
    arg('y', 'integer'),
    arg('z', 'integer', { required: false }),
  ],
  returnType: 'int4',
  returnRelation: 'int4',
  returnColumns: null,
  returnsSet: false,
  returnsComposite: false,
  isScalar: true,
  numDefaults: 1,
};

function baseParsed(overrides = {}) {
  return {
    select: [{ type: 'column', name: '*' }],
    filters: [],
    order: [],
    limit: null,
    offset: 0,
    ...overrides,
  };
}

function direct(named) {
  return { mode: 'direct', named };
}

describe('sql-builder: buildRpcCall', () => {
  describe('scalar function', () => {
    it('selects the value under the fixed scalar column', () => {
      const result = buildRpcCall('add', direct({ a: 3, b: 4 }),
        scalarSchema, null);
      assert.equal(result.text,
        `SELECT pgrst_call.${RPC_SCALAR} AS ${RPC_SCALAR} FROM `
        + `(SELECT "add"("a" := $1::integer, "b" := $2::integer) `
        + `AS ${RPC_SCALAR}) pgrst_call`);
      assert.deepStrictEqual(result.values, [3, 4]);
      assert.equal(result.resultMode, 'scalar');
    });

    it('renders a record return through to_json', () => {
      const result = buildRpcCall('returns_record', direct({}),
        { ...scalarSchema, name: 'returns_record', returnType: 'record' },
        null);
      assert.ok(result.text.startsWith(
        `SELECT to_json(pgrst_call.${RPC_SCALAR})`), result.text);
      assert.equal(result.resultMode, 'scalar');
    });

    it('windows a set of scalars', () => {
      const result = buildRpcCall('ret_setof_integers', direct({}),
        {
          ...scalarSchema, name: 'ret_setof_integers', args: [],
          returnsSet: true,
        },
        baseParsed({ limit: 2, offset: 1 }));
      assert.equal(result.resultMode, 'setofScalar');
      assert.ok(result.text.endsWith('LIMIT $1 OFFSET $2'), result.text);
      assert.deepStrictEqual(result.values, [2, 1]);
    });
  });

  describe('void function', () => {
    it('generates SELECT with empty arg list', () => {
      const result = buildRpcCall('do_thing', direct({}), voidSchema, null);
      assert.equal(result.text, 'SELECT "do_thing"()');
      assert.deepStrictEqual(result.values, []);
      assert.equal(result.resultMode, 'void');
    });
  });

  describe('set-returning (RETURNS TABLE with returnColumns)', () => {
    it('names the result columns with no read plan', () => {
      const result = buildRpcCall(
        'get_items', direct({ user_id: 'u-1' }), setReturningSchema, null);
      assert.equal(result.text,
        'SELECT "id", "name", "status" FROM "get_items"'
        + '("user_id" := $1::uuid)');
      assert.deepStrictEqual(result.values, ['u-1']);
      assert.equal(result.resultMode, 'set');
    });

    it('appends WHERE for filter on known column', () => {
      const parsed = baseParsed({
        filters: [{
          column: 'name', operator: 'eq',
          value: 'Alice', negate: false,
        }],
      });
      const result = buildRpcCall(
        'get_items', direct({ user_id: 'u-1' }), setReturningSchema, parsed);
      assert.ok(result.text.includes('WHERE'),
        'should have WHERE clause');
      assert.ok(result.text.includes('"name"'),
        'should reference the filter column');
      // The argument keeps $1; the filter value comes after it.
      assert.deepStrictEqual(result.values, ['u-1', 'Alice']);
    });

    it('throws PGRST204 for filter on unknown column', () => {
      const parsed = baseParsed({
        filters: [{
          column: 'nonexistent', operator: 'eq',
          value: 'x', negate: false,
        }],
      });
      assert.throws(
        () => buildRpcCall(
          'get_items', direct({ user_id: 'u-1' }), setReturningSchema, parsed),
        (err) => err.code === 'PGRST204',
        'should throw PGRST204 for unknown column in result',
      );
    });

    it('appends ORDER BY for known column', () => {
      const parsed = baseParsed({
        order: [{ column: 'name', direction: 'asc', nulls: null }],
      });
      const result = buildRpcCall(
        'get_items', direct({ user_id: 'u-1' }), setReturningSchema, parsed);
      assert.ok(result.text.includes('ORDER BY'),
        'should have ORDER BY');
      assert.ok(result.text.includes('"name"'));
    });

    it('appends LIMIT and OFFSET', () => {
      const parsed = baseParsed({ limit: 10, offset: 5 });
      const result = buildRpcCall(
        'get_items', direct({ user_id: 'u-1' }), setReturningSchema, parsed);
      assert.ok(result.text.includes('LIMIT'),
        'should have LIMIT');
      assert.ok(result.text.includes('OFFSET'),
        'should have OFFSET');
    });

    it('uses named columns for select on known columns', () => {
      const parsed = baseParsed({
        select: [
          { type: 'column', name: 'id' },
          { type: 'column', name: 'name' },
        ],
      });
      const result = buildRpcCall(
        'get_items', direct({ user_id: 'u-1' }), setReturningSchema, parsed);
      assert.ok(result.text.includes('"id"'),
        'should have specific column id');
      assert.ok(result.text.includes('"name"'),
        'should have specific column name');
      assert.ok(!result.text.includes('*'),
        'should not have wildcard');
    });

    it('emits AS for column alias in select', () => {
      const parsed = baseParsed({
        select: [
          { type: 'column', name: 'name', alias: 'label' },
        ],
      });
      const result = buildRpcCall(
        'get_items', direct({ user_id: 'u-1' }), setReturningSchema, parsed);
      assert.ok(
        result.text.includes('"name" AS "label"'),
        `expected SQL to contain "name" AS "label", got: ${result.text}`,
      );
    });

    it('emits CAST for column with cast in select', () => {
      const parsed = baseParsed({
        select: [
          { type: 'column', name: 'name', cast: 'text' },
        ],
      });
      const result = buildRpcCall(
        'get_items', direct({ user_id: 'u-1' }), setReturningSchema, parsed);
      assert.ok(
        result.text.includes('CAST("name" AS text)'),
        `expected CAST("name" AS text), got: ${result.text}`,
      );
    });
  });

  describe('set-returning (no returnColumns)', () => {
    it('appends WHERE for filter with valid identifier', () => {
      const parsed = baseParsed({
        filters: [{
          column: 'valid_col', operator: 'eq',
          value: 'x', negate: false,
        }],
      });
      const result = buildRpcCall(
        'generic_fn', direct({ x: 1 }), untypedSetSchema, parsed);
      assert.ok(result.text.includes('WHERE'),
        'should have WHERE clause');
    });

    it('throws PGRST204 for filter on invalid identifier (hyphen)', () => {
      const parsed = baseParsed({
        filters: [{
          column: 'bad-col', operator: 'eq',
          value: 'x', negate: false,
        }],
      });
      assert.throws(
        () => buildRpcCall(
          'generic_fn', direct({ x: 1 }), untypedSetSchema, parsed),
        (err) => err.code === 'PGRST204',
        'should throw PGRST204 for invalid identifier',
      );
    });
  });

  describe('returns a relation the API exposes', () => {
    const schema = {
      tables: {
        projects: {
          columns: {
            id: { type: 'int4' },
            name: { type: 'text' },
            client_id: { type: 'int4' },
          },
          primaryKey: ['id'],
        },
        clients: {
          columns: { id: { type: 'int4' }, name: { type: 'text' } },
          primaryKey: ['id'],
        },
      },
      relationships: [{
        constraint: 'projects_client_id_fkey',
        fromTable: 'projects',
        fromColumns: ['client_id'],
        toTable: 'clients',
        toColumns: ['id'],
        cardinality: 'many-to-one',
      }],
    };
    const getallprojects = {
      name: 'getallprojects',
      args: [],
      returnType: 'projects',
      returnRelation: 'projects',
      returnColumns: null,
      returnsSet: true,
      returnsComposite: true,
      isScalar: false,
      numDefaults: 0,
    };

    it('expands ?select=* to the relation columns', () => {
      const result = buildRpcCall('getallprojects', direct({}),
        getallprojects, baseParsed(), schema);
      assert.equal(result.text,
        'SELECT "id", "name", "client_id" FROM "getallprojects"() '
        + 'AS "projects" ORDER BY "projects"."id" ASC');
      assert.equal(result.resultMode, 'set');
    });

    it('filters on a column that is not selected', () => {
      const parsed = baseParsed({
        select: [{ type: 'column', name: 'id' }],
        filters: [{
          column: 'name', operator: 'like', value: 'OSX', negate: false,
        }],
      });
      const result = buildRpcCall('getallprojects', direct({}),
        getallprojects, parsed, schema);
      assert.ok(result.text.includes('FROM "getallprojects"() AS "projects"'),
        result.text);
      assert.ok(result.text.includes('WHERE'), result.text);
    });

    it('embeds a related table', () => {
      const parsed = baseParsed({
        select: [
          { type: 'column', name: 'id' },
          { type: 'embed', name: 'clients', select: [
            { type: 'column', name: 'id' },
          ] },
        ],
      });
      const result = buildRpcCall('getallprojects', direct({}),
        getallprojects, parsed, schema);
      assert.ok(result.text.includes('FROM "clients"'), result.text);
      assert.ok(
        result.text.includes('"clients"."id" = "projects"."client_id"'),
        result.text);
      assert.ok(result.text.endsWith('FROM "getallprojects"() AS "projects"'
        + ' ORDER BY "projects"."id" ASC'), result.text);
    });

    it('keeps a single-row return single', () => {
      const result = buildRpcCall('getproject', direct({}),
        { ...getallprojects, name: 'getproject', returnsSet: false },
        baseParsed(), schema);
      assert.equal(result.resultMode, 'single');
    });
  });

  describe('argument binding', () => {
    it('casts every argument to its parameter type', () => {
      const result = buildRpcCall(
        'add', direct({ a: '3', b: '4' }), scalarSchema, null);
      assert.ok(result.text.includes('"a" := $1::integer'), result.text);
      assert.ok(result.text.includes('"b" := $2::integer'), result.text);
    });

    it('omits optional args not provided so the DEFAULT applies', () => {
      const result = buildRpcCall(
        'calc', direct({ x: 1, y: 2 }), optionalArgSchema, null);
      assert.ok(result.text.includes('"x" := $1::integer'));
      assert.ok(result.text.includes('"y" := $2::integer'));
      assert.ok(!result.text.includes('"z"'),
        'optional arg z should be omitted');
    });

    it('passes a variadic parameter with VARIADIC', () => {
      const variadic = {
        ...scalarSchema,
        name: 'variadic_param',
        args: [arg('v', 'text[]', { required: false, variadic: true })],
        returnType: 'text',
        returnsSet: true,
      };
      const result = buildRpcCall('variadic_param',
        direct({ v: ['hi', 'there'] }), variadic, baseParsed());
      assert.ok(
        result.text.includes('VARIADIC "v" := $1::text[]'), result.text);
      assert.deepStrictEqual(result.values, [['hi', 'there']]);
    });

    it('binds a raw body positionally for a single unnamed parameter', () => {
      const unnamed = {
        ...scalarSchema,
        name: 'unnamed_json_param',
        args: [arg('', 'json')],
        returnType: 'json',
      };
      const result = buildRpcCall('unnamed_json_param',
        { mode: 'single', raw: '{"A":1}' }, unnamed, null);
      assert.ok(result.text.includes('"unnamed_json_param"($1::json)'),
        result.text);
      assert.deepStrictEqual(result.values, ['{"A":1}']);
    });

    it('keeps a JSON string a JSON string for a json parameter', () => {
      const jsonArg = {
        ...scalarSchema,
        name: 'json_argument',
        args: [arg('arg', 'json')],
        returnType: 'text',
      };
      const result = buildRpcCall('json_argument',
        { mode: 'json', named: { arg: '{ "key": 3 }' } }, jsonArg, null);
      assert.deepStrictEqual(result.values, ['"{ \\"key\\": 3 }"']);
    });

    it('serializes a nested json object for a json parameter', () => {
      const jsonArg = {
        ...scalarSchema,
        name: 'json_argument',
        args: [arg('arg', 'json')],
        returnType: 'text',
      };
      const result = buildRpcCall('json_argument',
        { mode: 'json', named: { arg: { key: 3 } } }, jsonArg, null);
      assert.deepStrictEqual(result.values, ['{"key":3}']);
    });

    it('takes a plain object as json arguments', () => {
      const result = buildRpcCall('add', { a: 1, b: 2 }, scalarSchema, null);
      assert.deepStrictEqual(result.values, [1, 2]);
    });
  });

  describe('SQL safety', () => {
    it('double-quotes the function and argument names', () => {
      const result = buildRpcCall('add', direct({ a: 1, b: 2 }),
        scalarSchema, null);
      assert.ok(result.text.includes('"add"'));
      assert.ok(result.text.includes('"a"'));
      assert.ok(result.text.includes('"b"'));
    });

    it('parameterizes all values', () => {
      const result = buildRpcCall('add', direct({ a: 1, b: 2 }),
        scalarSchema, null);
      assert.ok(result.text.includes('$1'));
      assert.ok(result.text.includes('$2'));
      assert.ok(!result.text.includes(' 1 ') && !result.text.includes(' 2 '),
        'raw values should not appear in SQL text');
    });

    it('drops a cast that is not a plain type name', () => {
      const hostile = {
        ...scalarSchema,
        args: [arg('a', 'integer); DROP TABLE t; --')],
      };
      const result = buildRpcCall('add', direct({ a: 1 }), hostile, null);
      assert.ok(!result.text.includes('DROP TABLE'), result.text);
      assert.ok(result.text.includes('"a" := $1)'), result.text);
    });
  });

  describe('columnValidator refactor (table reads still work)', () => {
    const tableSchema = {
      tables: {
        todos: {
          columns: {
            id: { type: 'text', nullable: false, defaultValue: null },
            title: { type: 'text', nullable: true, defaultValue: null },
            status: { type: 'text', nullable: true, defaultValue: null },
          },
          primaryKey: ['id'],
        },
      },
    };

    it('buildSelect with table schema still validates columns', () => {
      const parsed = baseParsed({
        filters: [{
          column: 'status', operator: 'eq',
          value: 'active', negate: false,
        }],
      });
      const { text, values } = buildSelect('todos', parsed, tableSchema);
      assert.ok(text.includes('"status"'));
      assert.ok(values.includes('active'));
    });

    // A table read leaves an unknown field to PostgreSQL, qualified, the way
    // upstream's `pgFmtField` does: that is what makes a computed column
    // selectable and filterable, and an unknown name still fails, with
    // PostgreSQL's own 42703 -> 400. (An RPC that returns an anonymous record
    // keeps PGRST204 — the two tests above — because its field list is the
    // function's OUT parameters and there is no row type to compute over.)
    it('buildSelect qualifies an unknown table column', () => {
      const parsed = baseParsed({
        filters: [{
          column: 'nonexistent', operator: 'eq',
          value: 'x', negate: false,
        }],
      });
      const { text } = buildSelect('todos', parsed, tableSchema);
      assert.match(text, /"todos"\."nonexistent" = \$\d+/);
    });

    it('orderClause with table schema still validates columns', () => {
      const parsed = baseParsed({
        order: [{ column: 'title', direction: 'asc', nulls: null }],
      });
      const { text } = buildSelect('todos', parsed, tableSchema);
      assert.ok(text.includes('ORDER BY'));
      assert.ok(text.includes('"title"'));
    });
  });
});
