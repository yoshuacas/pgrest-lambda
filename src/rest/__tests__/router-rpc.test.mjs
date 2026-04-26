import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { route } from '../router.mjs';

const mockSchema = {
  tables: {
    users: {
      columns: {
        id: { type: 'text', nullable: false, defaultValue: null },
        name: { type: 'text', nullable: true, defaultValue: null },
      },
      primaryKey: ['id'],
    },
  },
};

describe('router: /rpc/ path matching', () => {
  describe('valid function names', () => {
    it('routes /rest/v1/rpc/my_function to rpc route', () => {
      const result = route('/rest/v1/rpc/my_function', mockSchema);
      assert.deepStrictEqual(result, {
        type: 'rpc',
        functionName: 'my_function',
      });
    });

    it('routes /rest/v1/rpc/_private (leading underscore)', () => {
      const result = route('/rest/v1/rpc/_private', mockSchema);
      assert.deepStrictEqual(result, {
        type: 'rpc',
        functionName: '_private',
      });
    });

    it('routes /rest/v1/rpc/A (single character)', () => {
      const result = route('/rest/v1/rpc/A', mockSchema);
      assert.deepStrictEqual(result, {
        type: 'rpc',
        functionName: 'A',
      });
    });
  });

  describe('invalid function names', () => {
    it('throws PGRST100 for hyphen in name', () => {
      assert.throws(
        () => route('/rest/v1/rpc/my-func', mockSchema),
        (err) => err.code === 'PGRST100',
        'should throw PGRST100 for hyphen in function name',
      );
    });

    it('throws PGRST100 for leading digit', () => {
      assert.throws(
        () => route('/rest/v1/rpc/123abc', mockSchema),
        (err) => err.code === 'PGRST100',
        'should throw PGRST100 for leading digit',
      );
    });

    it('throws PGRST100 for space (URL-encoded)', () => {
      assert.throws(
        () => route('/rest/v1/rpc/my%20func', mockSchema),
        (err) => err.code === 'PGRST100',
        'should throw PGRST100 for space in function name',
      );
    });

    it('throws PGRST100 for empty after /rpc/', () => {
      assert.throws(
        () => route('/rest/v1/rpc/', mockSchema),
        (err) => err.code === 'PGRST100',
        'should throw PGRST100 for empty function name',
      );
    });

    it('throws PGRST100 for nested path /rpc/fn/extra', () => {
      assert.throws(
        () => route('/rest/v1/rpc/fn/extra', mockSchema),
        (err) => err.code === 'PGRST100',
        'should throw PGRST100 for nested path after function name',
      );
    });
  });

  describe('does not interfere with table routing', () => {
    it('routes /rest/v1/users to table route when users exists', () => {
      const result = route('/rest/v1/users', mockSchema);
      assert.deepStrictEqual(result, {
        type: 'table',
        table: 'users',
      });
    });
  });
});
