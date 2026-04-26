import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as sqlBuilder from '../sql-builder.mjs';

const { buildSelect, _buildFilterConditions } = sqlBuilder;
const buildRpcCall = sqlBuilder.buildRpcCall
  || (() => { throw new Error('buildRpcCall not exported from sql-builder.mjs'); });

const scalarSchema = {
  args: [
    { name: 'a', type: 'int4' },
    { name: 'b', type: 'int4' },
  ],
  returnType: 'int4',
  returnColumns: null,
  returnsSet: false,
  isScalar: true,
  numDefaults: 0,
};

const voidSchema = {
  args: [],
  returnType: 'void',
  returnColumns: null,
  returnsSet: false,
  isScalar: false,
  numDefaults: 0,
};

const setReturningSchema = {
  args: [{ name: 'user_id', type: 'uuid' }],
  returnType: 'record',
  returnColumns: [
    { name: 'id', type: 'uuid' },
    { name: 'name', type: 'text' },
    { name: 'status', type: 'text' },
  ],
  returnsSet: true,
  isScalar: false,
  numDefaults: 0,
};

const untypedSetSchema = {
  args: [{ name: 'x', type: 'int4' }],
  returnType: 'record',
  returnColumns: null,
  returnsSet: true,
  isScalar: false,
  numDefaults: 0,
};

const optionalArgSchema = {
  args: [
    { name: 'x', type: 'int4' },
    { name: 'y', type: 'int4' },
    { name: 'z', type: 'int4' },
  ],
  returnType: 'int4',
  returnColumns: null,
  returnsSet: false,
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

describe('sql-builder: buildRpcCall', () => {
  describe('scalar function', () => {
    it('generates SELECT with named-param syntax and alias', () => {
      const result = buildRpcCall('add', { a: 3, b: 4 }, scalarSchema, null);
      assert.equal(result.text,
        'SELECT "add"("a" := $1, "b" := $2) AS "add"');
      assert.deepStrictEqual(result.values, [3, 4]);
      assert.equal(result.resultMode, 'scalar');
    });
  });

  describe('void function', () => {
    it('generates SELECT with empty arg list', () => {
      const result = buildRpcCall('do_thing', {}, voidSchema, null);
      assert.equal(result.text, 'SELECT "do_thing"()');
      assert.deepStrictEqual(result.values, []);
      assert.equal(result.resultMode, 'void');
    });
  });

  describe('set-returning (RETURNS TABLE with returnColumns)', () => {
    it('generates SELECT * FROM with no filters', () => {
      const result = buildRpcCall(
        'get_items', { user_id: 'u-1' }, setReturningSchema, null);
      assert.equal(result.text,
        'SELECT * FROM "get_items"("user_id" := $1)');
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
        'get_items', { user_id: 'u-1' }, setReturningSchema, parsed);
      assert.ok(result.text.includes('WHERE'),
        'should have WHERE clause');
      assert.ok(result.text.includes('"name"'),
        'should reference the filter column');
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
          'get_items', { user_id: 'u-1' }, setReturningSchema, parsed),
        (err) => err.code === 'PGRST204',
        'should throw PGRST204 for unknown column in result',
      );
    });

    it('appends ORDER BY for known column', () => {
      const parsed = baseParsed({
        order: [{ column: 'name', direction: 'asc', nulls: null }],
      });
      const result = buildRpcCall(
        'get_items', { user_id: 'u-1' }, setReturningSchema, parsed);
      assert.ok(result.text.includes('ORDER BY'),
        'should have ORDER BY');
      assert.ok(result.text.includes('"name"'));
    });

    it('appends LIMIT and OFFSET', () => {
      const parsed = baseParsed({ limit: 10, offset: 5 });
      const result = buildRpcCall(
        'get_items', { user_id: 'u-1' }, setReturningSchema, parsed);
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
        'get_items', { user_id: 'u-1' }, setReturningSchema, parsed);
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
        'get_items', { user_id: 'u-1' }, setReturningSchema, parsed);
      assert.ok(
        result.text.includes('"name" AS "label"'),
        `expected SQL to contain "name" AS "label", got: ${result.text}`,
      );
    });

    it('emits AS for multiple column aliases in select', () => {
      const parsed = baseParsed({
        select: [
          { type: 'column', name: 'id', alias: 'item_id' },
          { type: 'column', name: 'name', alias: 'label' },
        ],
      });
      const result = buildRpcCall(
        'get_items', { user_id: 'u-1' }, setReturningSchema, parsed);
      assert.ok(
        result.text.includes('"id" AS "item_id"'),
        `expected "id" AS "item_id", got: ${result.text}`,
      );
      assert.ok(
        result.text.includes('"name" AS "label"'),
        `expected "name" AS "label", got: ${result.text}`,
      );
    });

    it('emits mixed alias and plain columns in select', () => {
      const parsed = baseParsed({
        select: [
          { type: 'column', name: 'id' },
          { type: 'column', name: 'name', alias: 'label' },
        ],
      });
      const result = buildRpcCall(
        'get_items', { user_id: 'u-1' }, setReturningSchema, parsed);
      assert.ok(
        result.text.includes('"id"'),
        `expected "id", got: ${result.text}`,
      );
      assert.ok(
        result.text.includes('"name" AS "label"'),
        `expected "name" AS "label", got: ${result.text}`,
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
        'generic_fn', { x: 1 }, untypedSetSchema, parsed);
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
          'generic_fn', { x: 1 }, untypedSetSchema, parsed),
        (err) => err.code === 'PGRST204',
        'should throw PGRST204 for invalid identifier',
      );
    });
  });

  describe('named-parameter syntax', () => {
    it('emits arguments as "name" := $N', () => {
      const result = buildRpcCall(
        'add', { a: 3, b: 4 }, scalarSchema, null);
      assert.ok(result.text.includes('"a" := $1'));
      assert.ok(result.text.includes('"b" := $2'));
    });

    it('omits optional args not provided', () => {
      const result = buildRpcCall(
        'calc', { x: 1, y: 2 }, optionalArgSchema, null);
      assert.ok(result.text.includes('"x" := $1'));
      assert.ok(result.text.includes('"y" := $2'));
      assert.ok(!result.text.includes('"z"'),
        'optional arg z should be omitted');
    });

    it('produces empty arg list for zero-arg function', () => {
      const result = buildRpcCall('do_thing', {}, voidSchema, null);
      assert.ok(result.text.includes('"do_thing"()'));
    });
  });

  describe('SQL safety', () => {
    it('double-quotes function name', () => {
      const result = buildRpcCall('add', { a: 1, b: 2 }, scalarSchema, null);
      assert.ok(result.text.includes('"add"'));
    });

    it('double-quotes argument names', () => {
      const result = buildRpcCall('add', { a: 1, b: 2 }, scalarSchema, null);
      assert.ok(result.text.includes('"a"'));
      assert.ok(result.text.includes('"b"'));
    });

    it('parameterizes all values', () => {
      const result = buildRpcCall('add', { a: 1, b: 2 }, scalarSchema, null);
      assert.ok(result.text.includes('$1'));
      assert.ok(result.text.includes('$2'));
      assert.ok(!result.text.includes(' 1 ') && !result.text.includes(' 2 '),
        'raw values should not appear in SQL text');
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

    it('buildSelect throws PGRST204 for unknown table column', () => {
      const parsed = baseParsed({
        filters: [{
          column: 'nonexistent', operator: 'eq',
          value: 'x', negate: false,
        }],
      });
      assert.throws(
        () => buildSelect('todos', parsed, tableSchema),
        (err) => err.code === 'PGRST204',
      );
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
