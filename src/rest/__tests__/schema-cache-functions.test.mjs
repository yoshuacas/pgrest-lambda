import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as sc from '../schema-cache.mjs';

const { createSchemaCache } = sc;
const hasFunction = sc.hasFunction
  || (() => { throw new Error('hasFunction not exported'); });
const getFunction = sc.getFunction
  || (() => { throw new Error('getFunction not exported'); });

const UUID_OID = 2950;
const TEXT_OID = 25;
const INT4_OID = 23;

function baseFunctionRow(overrides = {}) {
  return {
    function_name: 'test_fn',
    arg_names: null,
    arg_types: [],
    arg_modes: null,
    all_arg_types: null,
    return_type: 'int4',
    return_type_category: 'b',
    returns_set: false,
    volatility: 'v',
    language: 'sql',
    num_args: 0,
    num_defaults: 0,
    ...overrides,
  };
}

function createMockPool(fnRows, typeRows = []) {
  const calls = [];
  return {
    calls,
    query: async (sql) => {
      calls.push(sql);
      if (sql.includes('pg_proc')) return { rows: fnRows };
      if (sql.includes('pg_type') && sql.includes('ANY')) {
        return { rows: typeRows };
      }
      if (sql.includes('format_type')) return { rows: [] };
      if (sql.includes("contype = 'p'")) return { rows: [] };
      if (sql.includes("contype = 'f'")) return { rows: [] };
      return { rows: [] };
    },
  };
}

describe('schema cache: function introspection', () => {
  describe('function introspection (mock pg_proc rows)', () => {
    it('caches a scalar function with correct shape', async () => {
      const fnRows = [baseFunctionRow({
        function_name: 'add',
        arg_names: ['a', 'b'],
        arg_types: ['int4', 'int4'],
        num_args: 2,
        return_type: 'int4',
        return_type_category: 'b',
        returns_set: false,
      })];
      const pool = createMockPool(fnRows);
      const sc = createSchemaCache({
        schemaCacheTtl: 300000,
        capabilities: { supportsRpc: true },
      });
      const schema = await sc.getSchema(pool);

      assert.ok(schema.functions.add, 'add function should be in cache');
      assert.deepStrictEqual(schema.functions.add.args, [
        { name: 'a', type: 'int4' },
        { name: 'b', type: 'int4' },
      ]);
      assert.equal(schema.functions.add.returnType, 'int4');
      assert.equal(schema.functions.add.isScalar, true);
      assert.equal(schema.functions.add.returnsSet, false);
      assert.equal(schema.functions.add.returnColumns, null);
    });

    it('caches a set-returning composite function', async () => {
      const fnRows = [baseFunctionRow({
        function_name: 'get_all',
        arg_names: ['x'],
        arg_types: ['int4'],
        num_args: 1,
        return_type: 'record',
        return_type_category: 'c',
        returns_set: true,
      })];
      const pool = createMockPool(fnRows);
      const sc = createSchemaCache({
        schemaCacheTtl: 300000,
        capabilities: { supportsRpc: true },
      });
      const schema = await sc.getSchema(pool);

      assert.ok(schema.functions.get_all);
      assert.equal(schema.functions.get_all.isScalar, false);
      assert.equal(schema.functions.get_all.returnsSet, true);
      assert.equal(schema.functions.get_all.returnColumns, null);
    });

    it('caches a RETURNS TABLE function with returnColumns', async () => {
      const fnRows = [baseFunctionRow({
        function_name: 'get_items',
        arg_names: ['p_user_id', 'id', 'name'],
        arg_types: ['uuid'],
        arg_modes: ['i', 't', 't'],
        all_arg_types: [UUID_OID, UUID_OID, TEXT_OID],
        num_args: 1,
        return_type: 'record',
        return_type_category: 'c',
        returns_set: true,
      })];
      const typeRows = [
        { oid: UUID_OID, typname: 'uuid' },
        { oid: TEXT_OID, typname: 'text' },
      ];
      const pool = createMockPool(fnRows, typeRows);
      const sc = createSchemaCache({
        schemaCacheTtl: 300000,
        capabilities: { supportsRpc: true },
      });
      const schema = await sc.getSchema(pool);

      assert.ok(schema.functions.get_items);
      assert.deepStrictEqual(schema.functions.get_items.args, [
        { name: 'p_user_id', type: 'uuid' },
      ]);
      assert.deepStrictEqual(schema.functions.get_items.returnColumns, [
        { name: 'id', type: 'uuid' },
        { name: 'name', type: 'text' },
      ]);
      assert.equal(schema.functions.get_items.returnsSet, true);
    });

    it('caches a void function', async () => {
      const fnRows = [baseFunctionRow({
        function_name: 'do_nothing',
        return_type: 'void',
        return_type_category: 'p',
      })];
      const pool = createMockPool(fnRows);
      const sc = createSchemaCache({
        schemaCacheTtl: 300000,
        capabilities: { supportsRpc: true },
      });
      const schema = await sc.getSchema(pool);

      assert.ok(schema.functions.do_nothing);
      assert.equal(schema.functions.do_nothing.returnType, 'void');
      assert.equal(schema.functions.do_nothing.returnColumns, null);
    });

    it('caches a zero-argument function', async () => {
      const fnRows = [baseFunctionRow({
        function_name: 'now_utc',
        arg_names: null,
        arg_types: [],
        num_args: 0,
        return_type: 'timestamptz',
        return_type_category: 'b',
      })];
      const pool = createMockPool(fnRows);
      const sc = createSchemaCache({
        schemaCacheTtl: 300000,
        capabilities: { supportsRpc: true },
      });
      const schema = await sc.getSchema(pool);

      assert.ok(schema.functions.now_utc,
        'zero-arg function should be in cache');
      assert.deepStrictEqual(schema.functions.now_utc.args, []);
    });
  });

  describe('excluded functions', () => {
    it('excludes function with NULL proargnames and pronargs > 0', async () => {
      const fnRows = [baseFunctionRow({
        function_name: 'unnamed_args',
        arg_names: null,
        arg_types: ['int4'],
        num_args: 1,
      })];
      const pool = createMockPool(fnRows);
      const sc = createSchemaCache({
        schemaCacheTtl: 300000,
        capabilities: { supportsRpc: true },
      });
      const schema = await sc.getSchema(pool);

      assert.equal(schema.functions.unnamed_args, undefined,
        'function with unnamed args should not be in cache');
    });

    it('excludes function with empty-string arg name', async () => {
      const fnRows = [baseFunctionRow({
        function_name: 'partial_names',
        arg_names: ['', 'b'],
        arg_types: ['int4', 'int4'],
        num_args: 2,
      })];
      const pool = createMockPool(fnRows);
      const sc = createSchemaCache({
        schemaCacheTtl: 300000,
        capabilities: { supportsRpc: true },
      });
      const schema = await sc.getSchema(pool);

      assert.equal(schema.functions.partial_names, undefined,
        'function with empty arg name should not be in cache');
    });

    it('excludes function with OUT arg mode', async () => {
      const fnRows = [baseFunctionRow({
        function_name: 'has_out',
        arg_names: ['a', 'result'],
        arg_types: ['int4'],
        arg_modes: ['i', 'o'],
        num_args: 1,
      })];
      const pool = createMockPool(fnRows);
      const sc = createSchemaCache({
        schemaCacheTtl: 300000,
        capabilities: { supportsRpc: true },
      });
      const schema = await sc.getSchema(pool);

      assert.equal(schema.functions.has_out, undefined,
        'function with OUT mode should not be in cache');
    });

    it('excludes function with INOUT arg mode', async () => {
      const fnRows = [baseFunctionRow({
        function_name: 'has_inout',
        arg_names: ['x'],
        arg_types: ['int4'],
        arg_modes: ['b'],
        num_args: 1,
      })];
      const pool = createMockPool(fnRows);
      const sc = createSchemaCache({
        schemaCacheTtl: 300000,
        capabilities: { supportsRpc: true },
      });
      const schema = await sc.getSchema(pool);

      assert.equal(schema.functions.has_inout, undefined,
        'function with INOUT mode should not be in cache');
    });

    it('excludes function with VARIADIC arg mode', async () => {
      const fnRows = [baseFunctionRow({
        function_name: 'has_variadic',
        arg_names: ['items'],
        arg_types: ['int4'],
        arg_modes: ['v'],
        num_args: 1,
      })];
      const pool = createMockPool(fnRows);
      const sc = createSchemaCache({
        schemaCacheTtl: 300000,
        capabilities: { supportsRpc: true },
      });
      const schema = await sc.getSchema(pool);

      assert.equal(schema.functions.has_variadic, undefined,
        'function with VARIADIC mode should not be in cache');
    });

    it('keeps function with IN + TABLE arg modes (RETURNS TABLE)', async () => {
      const fnRows = [baseFunctionRow({
        function_name: 'returns_table',
        arg_names: ['x', 'col1'],
        arg_types: ['int4'],
        arg_modes: ['i', 't'],
        all_arg_types: [INT4_OID, TEXT_OID],
        num_args: 1,
        returns_set: true,
        return_type_category: 'c',
      })];
      const typeRows = [
        { oid: INT4_OID, typname: 'int4' },
        { oid: TEXT_OID, typname: 'text' },
      ];
      const pool = createMockPool(fnRows, typeRows);
      const sc = createSchemaCache({
        schemaCacheTtl: 300000,
        capabilities: { supportsRpc: true },
      });
      const schema = await sc.getSchema(pool);

      assert.ok(schema.functions.returns_table,
        'RETURNS TABLE function should be in cache');
    });
  });

  describe('excluded by prokind', () => {
    it('excludes aggregate function (prokind=a)', async () => {
      const fnRows = [baseFunctionRow({
        function_name: 'my_agg',
        prokind: 'a',
      })];
      const pool = createMockPool(fnRows);
      const sc = createSchemaCache({
        schemaCacheTtl: 300000,
        capabilities: { supportsRpc: true },
      });
      const schema = await sc.getSchema(pool);

      assert.equal(schema.functions.my_agg, undefined,
        'aggregate function should not be in cache');
    });

    it('excludes window function (prokind=w)', async () => {
      const fnRows = [baseFunctionRow({
        function_name: 'my_window',
        prokind: 'w',
      })];
      const pool = createMockPool(fnRows);
      const sc = createSchemaCache({
        schemaCacheTtl: 300000,
        capabilities: { supportsRpc: true },
      });
      const schema = await sc.getSchema(pool);

      assert.equal(schema.functions.my_window, undefined,
        'window function should not be in cache');
    });

    it('excludes procedure (prokind=p)', async () => {
      const fnRows = [baseFunctionRow({
        function_name: 'my_proc',
        prokind: 'p',
      })];
      const pool = createMockPool(fnRows);
      const sc = createSchemaCache({
        schemaCacheTtl: 300000,
        capabilities: { supportsRpc: true },
      });
      const schema = await sc.getSchema(pool);

      assert.equal(schema.functions.my_proc, undefined,
        'procedure should not be in cache');
    });

    it('includes regular function (prokind=f)', async () => {
      const fnRows = [baseFunctionRow({
        function_name: 'regular_fn',
        prokind: 'f',
      })];
      const pool = createMockPool(fnRows);
      const sc = createSchemaCache({
        schemaCacheTtl: 300000,
        capabilities: { supportsRpc: true },
      });
      const schema = await sc.getSchema(pool);

      assert.ok(schema.functions.regular_fn,
        'regular function should be in cache');
    });
  });

  describe('overloaded functions', () => {
    it('stores overloaded functions as { overloaded: true }', async () => {
      const fnRows = [
        baseFunctionRow({
          function_name: 'calc',
          arg_names: ['a'],
          arg_types: ['int4'],
          num_args: 1,
        }),
        baseFunctionRow({
          function_name: 'calc',
          arg_names: ['a'],
          arg_types: ['text'],
          num_args: 1,
        }),
      ];
      const pool = createMockPool(fnRows);
      const sc = createSchemaCache({
        schemaCacheTtl: 300000,
        capabilities: { supportsRpc: true },
      });
      const schema = await sc.getSchema(pool);

      assert.ok(schema.functions.calc);
      assert.equal(schema.functions.calc.overloaded, true);
    });
  });

  describe('capability gating', () => {
    it('skips FUNCTIONS_SQL when supportsRpc=false', async () => {
      const fnRows = [baseFunctionRow({ function_name: 'should_skip' })];
      const pool = createMockPool(fnRows);
      const sc = createSchemaCache({
        schemaCacheTtl: 300000,
        capabilities: { supportsRpc: false },
      });
      const schema = await sc.getSchema(pool);

      assert.deepStrictEqual(schema.functions, {},
        'functions should be empty when supportsRpc=false');
      const fnCalls = pool.calls.filter(s => s.includes('pg_proc'));
      assert.equal(fnCalls.length, 0,
        'FUNCTIONS_SQL should not have been executed');
    });

    it('executes FUNCTIONS_SQL when supportsRpc=true', async () => {
      const fnRows = [baseFunctionRow({ function_name: 'present' })];
      const pool = createMockPool(fnRows);
      const sc = createSchemaCache({
        schemaCacheTtl: 300000,
        capabilities: { supportsRpc: true },
      });
      const schema = await sc.getSchema(pool);

      assert.ok(schema.functions.present,
        'function should be populated');
    });

    it('populates functions when capabilities=null (backward compat)', async () => {
      const fnRows = [baseFunctionRow({ function_name: 'compat_fn' })];
      const pool = createMockPool(fnRows);
      const sc = createSchemaCache({ schemaCacheTtl: 300000 });
      const schema = await sc.getSchema(pool);

      assert.ok(schema.functions.compat_fn,
        'function should be populated with null capabilities');
    });
  });

  describe('helpers', () => {
    it('hasFunction returns true when function exists', async () => {
      const fnRows = [baseFunctionRow({ function_name: 'add' })];
      const pool = createMockPool(fnRows);
      const sc = createSchemaCache({
        schemaCacheTtl: 300000,
        capabilities: { supportsRpc: true },
      });
      const schema = await sc.getSchema(pool);

      assert.equal(hasFunction(schema, 'add'), true);
    });

    it('hasFunction returns false when function is missing', async () => {
      const pool = createMockPool([]);
      const sc = createSchemaCache({
        schemaCacheTtl: 300000,
        capabilities: { supportsRpc: true },
      });
      const schema = await sc.getSchema(pool);

      assert.equal(hasFunction(schema, 'missing'), false);
    });

    it('getFunction returns function schema when present', async () => {
      const fnRows = [baseFunctionRow({
        function_name: 'add',
        arg_names: ['a'],
        arg_types: ['int4'],
        num_args: 1,
      })];
      const pool = createMockPool(fnRows);
      const sc = createSchemaCache({
        schemaCacheTtl: 300000,
        capabilities: { supportsRpc: true },
      });
      const schema = await sc.getSchema(pool);

      const fn = getFunction(schema, 'add');
      assert.ok(fn, 'getFunction should return the function schema');
      assert.ok(Array.isArray(fn.args));
    });

    it('getFunction returns null when function is missing', async () => {
      const pool = createMockPool([]);
      const sc = createSchemaCache({
        schemaCacheTtl: 300000,
        capabilities: { supportsRpc: true },
      });
      const schema = await sc.getSchema(pool);

      assert.equal(getFunction(schema, 'missing'), null);
    });
  });
});
