import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { route } from '../router.mjs';

const mockSchema = {
  tables: {
    todos: {
      columns: {
        id: { type: 'text', nullable: false, defaultValue: null },
        title: { type: 'text', nullable: true, defaultValue: null },
      },
      primaryKey: ['id'],
    },
  },
};

describe('router', () => {
  it('routes /rest/v1/todos to table route', () => {
    const result = route('/rest/v1/todos', mockSchema);
    assert.deepStrictEqual(result, { type: 'table', table: 'todos' },
      'should return table route for todos');
  });

  it('routes /rest/v1/ to openapi route', () => {
    const result = route('/rest/v1/', mockSchema);
    assert.deepStrictEqual(result, { type: 'openapi' },
      'trailing slash should return openapi route');
  });

  it('routes /rest/v1 (no trailing slash) to openapi route', () => {
    const result = route('/rest/v1', mockSchema);
    assert.deepStrictEqual(result, { type: 'openapi' },
      'no trailing slash should return openapi route');
  });

  it('routes /rest/v1/_refresh to refresh route', () => {
    const result = route('/rest/v1/_refresh', mockSchema);
    assert.deepStrictEqual(result, { type: 'refresh' },
      'should return refresh route');
  });

  it('throws PGRST205 for /rest/v1/nonexistent', () => {
    assert.throws(
      () => route('/rest/v1/nonexistent', mockSchema),
      (err) => err.code === 'PGRST205',
      'should throw PGRST205 for unknown table'
    );
  });

  it('returns refresh route for _refresh even with GET method', () => {
    // Reserved route takes precedence over any table named _refresh
    const result = route('/rest/v1/_refresh', mockSchema);
    assert.deepStrictEqual(result, { type: 'refresh' },
      '_refresh reserved route should take precedence');
  });

  it('rejects table name with a dash (PGRST205)', () => {
    assert.throws(
      () => route('/rest/v1/bad-name', mockSchema),
      (err) => err.code === 'PGRST205',
      'identifier with dash must not reach schema lookup'
    );
  });

  it('rejects table name starting with a digit (PGRST205)', () => {
    assert.throws(
      () => route('/rest/v1/1todos', mockSchema),
      (err) => err.code === 'PGRST205',
      'identifier starting with digit must not reach schema lookup'
    );
  });

  it('rejects table name with a quote (PGRST205)', () => {
    assert.throws(
      () => route('/rest/v1/todos"', mockSchema),
      (err) => err.code === 'PGRST205',
      'identifier with quote must not reach schema lookup'
    );
  });
});

describe('router: openapi-mode', () => {
  it('serves the root spec under follow-privileges and ignore-privileges', () => {
    for (const mode of ['follow-privileges', 'ignore-privileges']) {
      assert.deepStrictEqual(
        route('/rest/v1/', mockSchema, 'public', { openApiMode: mode }),
        { type: 'openapi' }, mode);
    }
  });

  it('answers the root with 404 PGRST126 when disabled', () => {
    for (const path of ['/rest/v1', '/rest/v1/', '/', '']) {
      assert.throws(
        () => route(path, mockSchema, 'public', { openApiMode: 'disabled' }),
        (err) => err.statusCode === 404 && err.code === 'PGRST126'
          && err.message === 'Root endpoint metadata is disabled',
        path);
    }
  });

  it('leaves every other route alone when disabled', () => {
    const opts = { openApiMode: 'disabled' };
    assert.deepStrictEqual(route('/rest/v1/todos', mockSchema, 'public', opts),
      { type: 'table', table: 'todos' });
    assert.deepStrictEqual(
      route('/rest/v1/rpc/add', mockSchema, 'public', opts),
      { type: 'rpc', functionName: 'add' });
    assert.deepStrictEqual(
      route('/rest/v1/_refresh', mockSchema, 'public', opts),
      { type: 'refresh' });
  });
});
