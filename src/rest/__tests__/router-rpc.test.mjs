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

  // A PostgreSQL function name is an arbitrary identifier. Upstream's router
  // takes the path segment as that identifier and lets the schema cache decide
  // whether it exists (`["rpc", pName] -> TargetProc`), so a function really
  // called `welcome.html` or `my-func` is reachable and an unknown one answers
  // 404 PGRST202 from routine resolution — not 400 from the router.
  //
  // These cases replace three that asserted PGRST100 for a hyphen, a leading
  // digit and an encoded space. That rule made two upstream cases unreachable
  // (CustomMediaSpec:75 GET /rpc/welcome.html, :110 GET /rpc/welcome.xml) and
  // bought no safety: the name never reaches SQL as text — routines.mjs
  // resolves it against pg_proc and the call is built from the catalog row.
  describe('names that are identifiers but not bare words', () => {
    it('routes a dotted name (a function literally called welcome.html)', () => {
      assert.deepStrictEqual(route('/rest/v1/rpc/welcome.html', mockSchema), {
        type: 'rpc',
        functionName: 'welcome.html',
      });
    });

    it('routes a hyphenated name and leaves existence to the schema cache', () => {
      assert.deepStrictEqual(route('/rest/v1/rpc/my-func', mockSchema), {
        type: 'rpc',
        functionName: 'my-func',
      });
    });

    it('routes a leading-digit name', () => {
      assert.deepStrictEqual(route('/rest/v1/rpc/123abc', mockSchema), {
        type: 'rpc',
        functionName: '123abc',
      });
    });

    it('percent-decodes the segment', () => {
      assert.deepStrictEqual(route('/rest/v1/rpc/my%20func', mockSchema), {
        type: 'rpc',
        functionName: 'my func',
      });
    });
  });

  describe('invalid function names', () => {
    it('throws PGRST100 for empty after /rpc/', () => {
      assert.throws(
        () => route('/rest/v1/rpc/', mockSchema),
        (err) => err.code === 'PGRST100',
        'should throw PGRST100 for empty function name',
      );
    });

    it('throws PGRST100 for a malformed percent escape', () => {
      assert.throws(
        () => route('/rest/v1/rpc/%zz', mockSchema),
        (err) => err.code === 'PGRST100' && err.statusCode === 400,
      );
    });

    it('takes only the first segment of /rpc/fn/extra', () => {
      // Upstream has no route for a three-segment path at all; taking the
      // function name and letting resolution 404 is the same visible outcome
      // for any real request, and never routes to a different function.
      assert.deepStrictEqual(route('/rest/v1/rpc/fn/extra', mockSchema), {
        type: 'rpc',
        functionName: 'fn',
      });
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
