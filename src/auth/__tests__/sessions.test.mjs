import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createSession,
  resolveSession,
  updateSessionPrt,
  revokeSession,
  revokeUserSessions,
} from '../sessions.mjs';

function createMockPool(overrides = {}) {
  const queries = [];
  const pool = {
    queries,
    query: async (sql, params) => {
      queries.push({ sql, params });
      for (const [key, handler] of Object.entries(overrides)) {
        if (sql.includes(key)) {
          return handler(sql, params);
        }
      }
      return { rows: [] };
    },
  };
  return pool;
}

describe('sessions.mjs', () => {
  describe('createSession', () => {
    it('inserts row with userId, provider, prt and returns sid', async () => {
      const mockSid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
      const pool = createMockPool({
        'INSERT INTO auth.sessions': () => ({
          rows: [{ id: mockSid }],
        }),
      });

      const result = await createSession(pool, {
        userId: 'user-123',
        provider: 'gotrue',
        prt: 'provider-refresh-token',
      });

      const insertQuery = pool.queries.find(
        (q) => q.sql.includes('INSERT INTO auth.sessions')
      );
      assert.ok(insertQuery, 'should INSERT into auth.sessions');
      assert.deepEqual(
        insertQuery.params,
        ['user-123', 'gotrue', 'provider-refresh-token'],
        'values should be [userId, provider, prt]'
      );
      assert.equal(result.sid, mockSid, 'should return sid');
      assert.equal(typeof result.sid, 'string');
    });
  });

  describe('resolveSession', () => {
    it('returns stored fields for existing session', async () => {
      const pool = createMockPool({
        'FROM auth.sessions WHERE id': () => ({
          rows: [{
            user_id: 'user-123',
            provider: 'gotrue',
            prt: 'stored-prt',
            revoked: false,
          }],
        }),
      });

      const result = await resolveSession(pool, 'some-session-id');

      const selectQuery = pool.queries.find(
        (q) =>
          q.sql.includes('SELECT') &&
          q.sql.includes('auth.sessions WHERE id')
      );
      assert.ok(
        selectQuery,
        'should SELECT from auth.sessions WHERE id = $1'
      );
      assert.deepEqual(result, {
        userId: 'user-123',
        provider: 'gotrue',
        prt: 'stored-prt',
        revoked: false,
      });
    });

    it('returns null for missing UUID', async () => {
      const pool = createMockPool();

      const result = await resolveSession(pool, 'nonexistent-id');

      assert.equal(result, null);
    });
  });

  describe('updateSessionPrt', () => {
    it('changes prt and bumps updated_at', async () => {
      const pool = createMockPool();

      await updateSessionPrt(pool, 'session-id', 'new-prt');

      const updateQuery = pool.queries.find(
        (q) => q.sql.includes('UPDATE auth.sessions SET prt')
      );
      assert.ok(updateQuery, 'should UPDATE auth.sessions');
      assert.ok(
        updateQuery.sql.includes('prt = $1'),
        'SQL should contain prt = $1'
      );
      assert.ok(
        updateQuery.sql.includes('updated_at = now()'),
        'SQL should bump updated_at'
      );
      assert.ok(
        updateQuery.sql.includes('WHERE id = $2'),
        'SQL should have WHERE id = $2'
      );
      assert.deepEqual(
        updateQuery.params,
        ['new-prt', 'session-id']
      );
    });
  });

  describe('revokeSession', () => {
    it('sets revoked = true for session', async () => {
      const pool = createMockPool();

      await revokeSession(pool, 'session-id');

      const updateQuery = pool.queries.find(
        (q) =>
          q.sql.includes(
            'UPDATE auth.sessions SET revoked = true'
          ) && q.sql.includes('WHERE id = $1')
      );
      assert.ok(
        updateQuery,
        'should UPDATE auth.sessions SET revoked = true WHERE id = $1'
      );
      assert.ok(
        updateQuery.params.includes('session-id'),
        'values should include sid'
      );
    });
  });

  describe('revokeUserSessions', () => {
    it('revokes all sessions for a user', async () => {
      const pool = createMockPool();

      await revokeUserSessions(pool, 'user-123');

      const updateQuery = pool.queries.find(
        (q) =>
          q.sql.includes(
            'UPDATE auth.sessions SET revoked = true'
          ) &&
          q.sql.includes(
            'WHERE user_id = $1 AND revoked = false'
          )
      );
      assert.ok(
        updateQuery,
        'should UPDATE auth.sessions SET revoked = true ' +
          'WHERE user_id = $1 AND revoked = false'
      );
      assert.ok(
        updateQuery.params.includes('user-123'),
        'values should include userId'
      );
    });
  });
});
