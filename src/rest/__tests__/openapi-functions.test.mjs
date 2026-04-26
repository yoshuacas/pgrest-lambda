import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateSpec } from '../openapi.mjs';

const baseSchema = {
  tables: {
    users: {
      columns: {
        id: { type: 'uuid', nullable: false, defaultValue: null },
        name: { type: 'text', nullable: true, defaultValue: null },
      },
      primaryKey: ['id'],
    },
  },
  relationships: [],
};

describe('OpenAPI function endpoints', () => {
  it('scalar function produces /rpc/fnName with arg and response schema', () => {
    const schema = {
      ...baseSchema,
      functions: {
        add_numbers: {
          args: [
            { name: 'a', type: 'integer' },
            { name: 'b', type: 'integer' },
          ],
          returnType: 'int4',
          returnColumns: null,
          returnsSet: false,
          isScalar: true,
          volatility: 'v',
          language: 'sql',
          numDefaults: 0,
        },
      },
    };

    const spec = generateSpec(schema, 'https://example.com');
    const path = spec.paths['/rpc/add_numbers'];
    assert.ok(path, '/rpc/add_numbers path should exist');

    const post = path.post;
    assert.deepEqual(post.tags, ['Functions']);
    assert.equal(post.summary, 'Call add_numbers');

    const argSchema = post.requestBody.content['application/json'].schema;
    assert.equal(argSchema.type, 'object');
    assert.deepEqual(argSchema.properties.a, { type: 'integer' });
    assert.deepEqual(argSchema.properties.b, { type: 'integer' });
    assert.deepEqual(argSchema.required, ['a', 'b']);

    const respSchema = post.responses[200]
      .content['application/json'].schema;
    assert.deepEqual(respSchema, { type: 'integer' });
  });

  it('RETURNS TABLE function produces response schema with typed columns', () => {
    const schema = {
      ...baseSchema,
      functions: {
        get_items: {
          args: [{ name: 'p_user_id', type: 'uuid' }],
          returnType: 'record',
          returnColumns: [
            { name: 'id', type: 'uuid' },
            { name: 'name', type: 'text' },
          ],
          returnsSet: true,
          isScalar: false,
          volatility: 'v',
          language: 'sql',
          numDefaults: 0,
        },
      },
    };

    const spec = generateSpec(schema, 'https://example.com');
    const respSchema = spec.paths['/rpc/get_items']
      .post.responses[200].content['application/json'].schema;
    assert.equal(respSchema.type, 'array');
    assert.equal(respSchema.items.type, 'object');
    assert.deepEqual(respSchema.items.properties.id,
      { type: 'string', format: 'uuid' });
    assert.deepEqual(respSchema.items.properties.name,
      { type: 'string' });
  });

  it('void function produces empty response schema', () => {
    const schema = {
      ...baseSchema,
      functions: {
        do_nothing: {
          args: [],
          returnType: 'void',
          returnColumns: null,
          returnsSet: false,
          isScalar: false,
          volatility: 'v',
          language: 'sql',
          numDefaults: 0,
        },
      },
    };

    const spec = generateSpec(schema, 'https://example.com');
    const respSchema = spec.paths['/rpc/do_nothing']
      .post.responses[200].content['application/json'].schema;
    assert.deepEqual(respSchema, {});
  });

  it('overloaded functions are excluded from paths', () => {
    const schema = {
      ...baseSchema,
      functions: {
        calc: { overloaded: true },
      },
    };

    const spec = generateSpec(schema, 'https://example.com');
    assert.equal(spec.paths['/rpc/calc'], undefined);
  });

  it('schema with no functions produces no /rpc/ paths', () => {
    const spec = generateSpec(baseSchema, 'https://example.com');
    const rpcPaths = Object.keys(spec.paths)
      .filter(p => p.startsWith('/rpc/'));
    assert.equal(rpcPaths.length, 0);
  });

  it('schema with empty functions object produces no /rpc/ paths', () => {
    const schema = { ...baseSchema, functions: {} };
    const spec = generateSpec(schema, 'https://example.com');
    const rpcPaths = Object.keys(spec.paths)
      .filter(p => p.startsWith('/rpc/'));
    assert.equal(rpcPaths.length, 0);
  });

  it('table endpoints still work alongside function endpoints', () => {
    const schema = {
      ...baseSchema,
      functions: {
        my_fn: {
          args: [],
          returnType: 'int4',
          returnColumns: null,
          returnsSet: false,
          isScalar: true,
          volatility: 'v',
          language: 'sql',
          numDefaults: 0,
        },
      },
    };

    const spec = generateSpec(schema, 'https://example.com');
    assert.ok(spec.paths['/users'], 'table path should exist');
    assert.ok(spec.paths['/rpc/my_fn'], 'function path should exist');
    assert.ok(spec.paths['/users'].get, 'table GET should exist');
  });

  it('function with default args marks only required ones', () => {
    const schema = {
      ...baseSchema,
      functions: {
        with_default: {
          args: [
            { name: 'x', type: 'integer' },
            { name: 'y', type: 'integer' },
          ],
          returnType: 'int4',
          returnColumns: null,
          returnsSet: false,
          isScalar: true,
          volatility: 'v',
          language: 'sql',
          numDefaults: 1,
        },
      },
    };

    const spec = generateSpec(schema, 'https://example.com');
    const argSchema = spec.paths['/rpc/with_default']
      .post.requestBody.content['application/json'].schema;
    assert.deepEqual(argSchema.required, ['x']);
    assert.ok(argSchema.properties.y, 'optional arg should still be in properties');
  });

  it('set-returning function without returnColumns uses generic object array', () => {
    const schema = {
      ...baseSchema,
      functions: {
        get_records: {
          args: [],
          returnType: 'record',
          returnColumns: null,
          returnsSet: true,
          isScalar: false,
          volatility: 'v',
          language: 'sql',
          numDefaults: 0,
        },
      },
    };

    const spec = generateSpec(schema, 'https://example.com');
    const respSchema = spec.paths['/rpc/get_records']
      .post.responses[200].content['application/json'].schema;
    assert.deepEqual(respSchema, {
      type: 'array',
      items: { type: 'object' },
    });
  });

  it('composite non-set function returns object schema', () => {
    const schema = {
      ...baseSchema,
      functions: {
        get_record: {
          args: [],
          returnType: 'my_composite',
          returnColumns: null,
          returnsSet: false,
          isScalar: false,
          volatility: 'v',
          language: 'sql',
          numDefaults: 0,
        },
      },
    };

    const spec = generateSpec(schema, 'https://example.com');
    const respSchema = spec.paths['/rpc/get_record']
      .post.responses[200].content['application/json'].schema;
    assert.deepEqual(respSchema, { type: 'object' });
  });

  it('error response references PostgRESTError schema', () => {
    const schema = {
      ...baseSchema,
      functions: {
        my_fn: {
          args: [],
          returnType: 'int4',
          returnColumns: null,
          returnsSet: false,
          isScalar: true,
          volatility: 'v',
          language: 'sql',
          numDefaults: 0,
        },
      },
    };

    const spec = generateSpec(schema, 'https://example.com');
    const errSchema = spec.paths['/rpc/my_fn']
      .post.responses.default.content['application/json'].schema;
    assert.equal(errSchema.$ref, '#/components/schemas/PostgRESTError');
  });
});
