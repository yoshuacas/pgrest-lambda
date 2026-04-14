import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateSpec } from '../openapi.mjs';

const mockSchema = {
  tables: {
    todos: {
      columns: {
        id: { type: 'text', nullable: false, defaultValue: null },
        title: { type: 'text', nullable: true, defaultValue: null },
        count: { type: 'integer', nullable: true, defaultValue: null },
        done: { type: 'boolean', nullable: false, defaultValue: 'false' },
        created_at: { type: 'timestamptz', nullable: false, defaultValue: 'now()' },
        uid: { type: 'uuid', nullable: false, defaultValue: null },
        data: { type: 'jsonb', nullable: true, defaultValue: null },
      },
      primaryKey: ['id'],
    },
    categories: {
      columns: {
        id: { type: 'text', nullable: false, defaultValue: null },
        name: { type: 'text', nullable: false, defaultValue: null },
      },
      primaryKey: ['id'],
    },
  },
};

describe('openapi', () => {
  it('generates spec with openapi version 3.0.3', () => {
    const spec = generateSpec(mockSchema, 'https://api.example.com');
    assert.equal(spec.openapi, '3.0.3',
      'spec should have openapi 3.0.3');
  });

  it('includes paths for /todos and /categories', () => {
    const spec = generateSpec(mockSchema, 'https://api.example.com');
    assert.ok(spec.paths['/todos'],
      'spec should have /todos path');
    assert.ok(spec.paths['/categories'],
      'spec should have /categories path');
  });

  it('includes GET, POST, PATCH, DELETE operations per table', () => {
    const spec = generateSpec(mockSchema, 'https://api.example.com');
    const todosPath = spec.paths['/todos'];
    assert.ok(todosPath.get, '/todos should have GET');
    assert.ok(todosPath.post, '/todos should have POST');
    assert.ok(todosPath.patch, '/todos should have PATCH');
    assert.ok(todosPath.delete, '/todos should have DELETE');
  });

  it('maps column types correctly to JSON Schema', () => {
    const spec = generateSpec(mockSchema, 'https://api.example.com');
    // Find the todos schema in components
    const todosSchema = spec.components?.schemas?.todos?.properties
      || spec.paths['/todos']?.get?.responses?.['200']?.content?.['application/json']?.schema?.items?.properties;
    assert.ok(todosSchema, 'should have todos schema properties');

    // text -> string
    assert.equal(todosSchema.id?.type, 'string',
      'text should map to string');
    // integer -> integer
    assert.equal(todosSchema.count?.type, 'integer',
      'integer should map to integer');
    // boolean -> boolean
    assert.equal(todosSchema.done?.type, 'boolean',
      'boolean should map to boolean');
    // timestamptz -> string with format date-time
    assert.equal(todosSchema.created_at?.type, 'string',
      'timestamptz should map to string');
    assert.equal(todosSchema.created_at?.format, 'date-time',
      'timestamptz should have format date-time');
    // uuid -> string with format uuid
    assert.equal(todosSchema.uid?.type, 'string',
      'uuid should map to string');
    assert.equal(todosSchema.uid?.format, 'uuid',
      'uuid should have format uuid');
    // jsonb -> object
    assert.equal(todosSchema.data?.type, 'object',
      'jsonb should map to object');
  });

  it('includes securitySchemes with Bearer JWT', () => {
    const spec = generateSpec(mockSchema, 'https://api.example.com');
    const securitySchemes = spec.components?.securitySchemes;
    assert.ok(securitySchemes, 'should have securitySchemes');
    const bearerScheme = Object.values(securitySchemes).find(
      s => s.type === 'http' && s.scheme === 'bearer'
    );
    assert.ok(bearerScheme, 'should have a Bearer JWT security scheme');
  });

  it('includes PostgREST error schema in components', () => {
    const spec = generateSpec(mockSchema, 'https://api.example.com');
    const schemas = spec.components?.schemas;
    assert.ok(schemas, 'should have component schemas');
    // Look for an error schema with code, message, details, hint
    const errorSchema = Object.values(schemas).find(
      s => s.properties?.code && s.properties?.message
        && s.properties?.details && s.properties?.hint
    );
    assert.ok(errorSchema,
      'should have a PostgREST error schema with code, message, details, hint');
  });

  describe('contributions', () => {
    it('does not include auth paths without contributions', () => {
      const spec = generateSpec(mockSchema, 'https://api.example.com/rest/v1');
      assert.ok(!spec.paths['/signup'], 'should not have /signup');
      assert.ok(!spec.components.schemas.AuthSession, 'should not have AuthSession');
    });

    it('merges contribution paths into spec', () => {
      const contribution = {
        paths: {
          '/custom': {
            get: { summary: 'Custom endpoint', responses: { 200: { description: 'OK' } } },
          },
        },
      };
      const spec = generateSpec(mockSchema, 'https://api.example.com/rest/v1', [contribution]);
      assert.ok(spec.paths['/custom'], 'should include contributed path');
      assert.equal(spec.paths['/custom'].get.summary, 'Custom endpoint');
    });

    it('merges contribution schemas into components', () => {
      const contribution = {
        paths: {},
        schemas: {
          CustomType: { type: 'object', properties: { id: { type: 'string' } } },
        },
      };
      const spec = generateSpec(mockSchema, 'https://api.example.com/rest/v1', [contribution]);
      assert.ok(spec.components.schemas.CustomType, 'should include contributed schema');
    });

    it('merges multiple contributions in order', () => {
      const c1 = { paths: { '/a': { get: { summary: 'A' } } } };
      const c2 = { paths: { '/b': { get: { summary: 'B' } } } };
      const spec = generateSpec(mockSchema, 'https://api.example.com/rest/v1', [c1, c2]);
      assert.ok(spec.paths['/a'], 'should have /a from first contribution');
      assert.ok(spec.paths['/b'], 'should have /b from second contribution');
    });

    it('preserves table paths alongside contributions', () => {
      const contribution = {
        paths: { '/signup': { post: { summary: 'Sign up' } } },
        schemas: { AuthSession: { type: 'object' } },
      };
      const spec = generateSpec(mockSchema, 'https://api.example.com/rest/v1', [contribution]);
      assert.ok(spec.paths['/todos'], 'should still have /todos');
      assert.ok(spec.paths['/signup'], 'should have contributed /signup');
      assert.ok(spec.components.schemas.todos, 'should still have todos schema');
      assert.ok(spec.components.schemas.AuthSession, 'should have contributed AuthSession');
    });
  });
});
