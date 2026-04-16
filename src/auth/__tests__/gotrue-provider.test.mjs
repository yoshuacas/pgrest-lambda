import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createGoTrueProvider } from '../providers/gotrue.mjs';
import {
  AUTH_SCHEMA_SQL,
  _resetInitialized,
} from '../schema.mjs';

// --- Mock infrastructure ---

const MOCK_USER_ROW = {
  id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  email: 'test@example.com',
  encrypted_password:
    '$2b$10$aXPJVDiEzO4/q1fkZc6MMudMANtvEcLtTWHTQW.tNdPHf0N2beUIu',
  app_metadata: { provider: 'email', providers: ['email'] },
  user_metadata: {},
  created_at: '2026-04-11T12:00:00.000Z',
};

const MOCK_TOKEN_ROW = {
  id: 42,
  token: 'valid-opaque-token',
  user_id: MOCK_USER_ROW.id,
  revoked: false,
};

function createMockPool(overrides = {}) {
  const queries = [];
  const pool = {
    queries,
    query: async (sql, params) => {
      queries.push({ sql, params });

      // Allow per-test overrides keyed by substring
      for (const [key, handler] of Object.entries(overrides)) {
        if (sql.includes(key)) {
          return handler(sql, params);
        }
      }

      // Default responses based on SQL content
      if (sql.includes('INSERT INTO auth.users')) {
        return {
          rows: [{
            id: MOCK_USER_ROW.id,
            email: params?.[0] ?? MOCK_USER_ROW.email,
            app_metadata: MOCK_USER_ROW.app_metadata,
            user_metadata: MOCK_USER_ROW.user_metadata,
            created_at: MOCK_USER_ROW.created_at,
          }],
        };
      }
      if (sql.includes('FROM auth.users') && sql.includes('WHERE email')) {
        return { rows: [{ ...MOCK_USER_ROW }] };
      }
      if (sql.includes('FROM auth.users') && sql.includes('WHERE id')) {
        return { rows: [{ ...MOCK_USER_ROW }] };
      }
      if (
        sql.includes('FROM auth.refresh_tokens') &&
        sql.includes('WHERE token')
      ) {
        return { rows: [{ ...MOCK_TOKEN_ROW }] };
      }
      if (sql.includes('INSERT INTO auth.refresh_tokens')) {
        return { rows: [] };
      }
      if (sql.includes('UPDATE auth.refresh_tokens')) {
        return { rows: [] };
      }

      // DDL (schema init) — just succeed
      return { rows: [] };
    },
  };
  return pool;
}

function createMockDb(pool) {
  return { getPool: async () => pool };
}

describe('GoTrueProvider', () => {
  beforeEach(() => {
    _resetInitialized();
  });

  // ----- signUp -----

  describe('signUp', () => {
    it('returns AuthUser with correct fields', async () => {
      const pool = createMockPool();
      const db = createMockDb(pool);
      const { provider } = createGoTrueProvider({}, db);

      const user = await provider.signUp(
        'test@example.com',
        'StrongPass1'
      );

      assert.equal(user.id, MOCK_USER_ROW.id);
      assert.equal(user.email, 'test@example.com');
      assert.deepEqual(
        user.app_metadata,
        MOCK_USER_ROW.app_metadata
      );
      assert.deepEqual(
        user.user_metadata,
        MOCK_USER_ROW.user_metadata
      );
      assert.ok(user.created_at, 'should have created_at');
    });

    it('hashes password with bcrypt before INSERT', async () => {
      const pool = createMockPool();
      const db = createMockDb(pool);
      const { provider } = createGoTrueProvider({}, db);

      await provider.signUp('test@example.com', 'StrongPass1');

      const insertQuery = pool.queries.find(
        (q) => q.sql.includes('INSERT INTO auth.users')
      );
      assert.ok(insertQuery, 'should have an INSERT query');
      const passwordParam = insertQuery.params[1];
      assert.ok(
        passwordParam.startsWith('$2a$') ||
          passwordParam.startsWith('$2b$'),
        `password should be bcrypt-hashed, got: ${passwordParam}`
      );
      assert.notEqual(
        passwordParam,
        'StrongPass1',
        'should not store plaintext password'
      );
    });

    it('throws user_already_exists on duplicate email', async () => {
      const pool = createMockPool({
        'INSERT INTO auth.users': () => {
          const err = new Error('duplicate key');
          err.code = '23505';
          throw err;
        },
      });
      const db = createMockDb(pool);
      const { provider } = createGoTrueProvider({}, db);

      await assert.rejects(
        () => provider.signUp('dup@example.com', 'StrongPass1'),
        (err) => {
          assert.equal(err.code, 'user_already_exists');
          return true;
        }
      );
    });

    it("throws weak_password with reasons=['length'] for short password", async () => {
      const pool = createMockPool();
      const db = createMockDb(pool);
      const { provider } = createGoTrueProvider({}, db);

      await assert.rejects(
        () => provider.signUp('a@b.com', 'Short1'),
        (err) => {
          assert.equal(err.code, 'weak_password');
          assert.ok(
            err.reasons.includes('length'),
            'reasons should include length'
          );
          return true;
        }
      );
    });

    it("throws weak_password with reasons=['uppercase'] when missing uppercase", async () => {
      const pool = createMockPool();
      const db = createMockDb(pool);
      const { provider } = createGoTrueProvider({}, db);

      await assert.rejects(
        () => provider.signUp('a@b.com', 'lowercase1'),
        (err) => {
          assert.equal(err.code, 'weak_password');
          assert.ok(
            err.reasons.includes('uppercase'),
            'reasons should include uppercase'
          );
          return true;
        }
      );
    });

    it("throws weak_password with reasons=['lowercase'] when missing lowercase", async () => {
      const pool = createMockPool();
      const db = createMockDb(pool);
      const { provider } = createGoTrueProvider({}, db);

      await assert.rejects(
        () => provider.signUp('a@b.com', 'UPPERCASE1'),
        (err) => {
          assert.equal(err.code, 'weak_password');
          assert.ok(
            err.reasons.includes('lowercase'),
            'reasons should include lowercase'
          );
          return true;
        }
      );
    });

    it("throws weak_password with reasons=['number'] when missing number", async () => {
      const pool = createMockPool();
      const db = createMockDb(pool);
      const { provider } = createGoTrueProvider({}, db);

      await assert.rejects(
        () => provider.signUp('a@b.com', 'NoNumber!'),
        (err) => {
          assert.equal(err.code, 'weak_password');
          assert.ok(
            err.reasons.includes('number'),
            'reasons should include number'
          );
          return true;
        }
      );
    });

    it('throws weak_password with multiple reasons', async () => {
      const pool = createMockPool();
      const db = createMockDb(pool);
      const { provider } = createGoTrueProvider({}, db);

      await assert.rejects(
        () => provider.signUp('a@b.com', 'short'),
        (err) => {
          assert.equal(err.code, 'weak_password');
          assert.ok(
            err.reasons.includes('length'),
            'reasons should include length'
          );
          assert.ok(
            err.reasons.includes('uppercase'),
            'reasons should include uppercase'
          );
          assert.ok(
            err.reasons.includes('number'),
            'reasons should include number'
          );
          return true;
        }
      );
    });

    it('accepts password that is exactly 8 characters', async () => {
      const pool = createMockPool();
      const db = createMockDb(pool);
      const { provider } = createGoTrueProvider({}, db);

      const user = await provider.signUp(
        'test@example.com',
        'Abcdef1x'
      );

      assert.equal(user.id, MOCK_USER_ROW.id);
    });

    it('calls ensureAuthSchema before INSERT', async () => {
      const pool = createMockPool();
      const db = createMockDb(pool);
      const { provider } = createGoTrueProvider({}, db);

      await provider.signUp('test@example.com', 'StrongPass1');

      const insertIdx = pool.queries.findIndex(
        (q) => q.sql.includes('INSERT INTO auth.users')
      );
      const ddlQueries = pool.queries
        .slice(0, insertIdx)
        .filter((q) =>
          AUTH_SCHEMA_SQL.some((ddl) => q.sql === ddl)
        );
      assert.equal(
        ddlQueries.length,
        AUTH_SCHEMA_SQL.length,
        'all DDL statements should appear before INSERT'
      );
    });
  });

  // ----- signIn -----

  describe('signIn', () => {
    it('returns user and providerTokens for valid credentials', async () => {
      const pool = createMockPool();
      const db = createMockDb(pool);
      const { provider } = createGoTrueProvider({}, db);

      const result = await provider.signIn(
        'test@example.com',
        'dummy-password'
      );

      assert.ok(result.user, 'should return user');
      assert.equal(result.user.id, MOCK_USER_ROW.id);
      assert.equal(result.user.email, MOCK_USER_ROW.email);
      assert.ok(
        result.providerTokens.refreshToken,
        'should have refreshToken'
      );
      // base64url: only contains [A-Za-z0-9_-]
      assert.ok(
        /^[A-Za-z0-9_-]+$/.test(
          result.providerTokens.refreshToken
        ),
        'refreshToken should be base64url'
      );
    });

    it('inserts a refresh token row', async () => {
      const pool = createMockPool();
      const db = createMockDb(pool);
      const { provider } = createGoTrueProvider({}, db);

      await provider.signIn('test@example.com', 'dummy-password');

      const insertToken = pool.queries.find(
        (q) => q.sql.includes('INSERT INTO auth.refresh_tokens')
      );
      assert.ok(
        insertToken,
        'should INSERT into auth.refresh_tokens'
      );
      assert.ok(
        insertToken.params.some(
          (p) => p === MOCK_USER_ROW.id
        ),
        'INSERT should include user_id'
      );
    });

    it('throws invalid_grant for wrong password', async () => {
      // Return a user row with a hash that won't match
      // the password. bcrypt.compare will genuinely fail.
      const pool = createMockPool({
        'FROM auth.users': () => ({
          rows: [{
            ...MOCK_USER_ROW,
            // This hash is for "dummy-password", not the
            // password we'll provide
            encrypted_password:
              '$2a$10$N9qo8uLOickgx2ZMRZoMyeIh9cvl6j5iHLbWb4Or/JtqKMZBHFwOC',
          }],
        }),
      });
      const db = createMockDb(pool);
      const { provider } = createGoTrueProvider({}, db);

      await assert.rejects(
        () =>
          provider.signIn(
            'test@example.com',
            'WrongPassword999'
          ),
        (err) => {
          assert.equal(err.code, 'invalid_grant');
          return true;
        }
      );
    });

    it('throws invalid_grant for nonexistent user and performs dummy bcrypt compare', async () => {
      let bcryptCompareCallCount = 0;
      const pool = createMockPool({
        'FROM auth.users': () => ({ rows: [] }),
      });
      const db = createMockDb(pool);
      const { provider } = createGoTrueProvider({}, db);

      // We cannot directly spy on bcrypt.compare inside
      // the module, but we can verify the error is thrown
      // and the response is not suspiciously fast (the
      // implementation should call bcrypt.compare with
      // DUMMY_HASH for timing safety).
      const start = Date.now();
      await assert.rejects(
        () =>
          provider.signIn(
            'nobody@example.com',
            'SomePass1'
          ),
        (err) => {
          assert.equal(err.code, 'invalid_grant');
          return true;
        }
      );
      // bcrypt with cost 10 takes at least ~50ms; if the
      // code skips it, this would return in <5ms. This is
      // a soft heuristic — the real guarantee is the code
      // review of the implementation.
      const elapsed = Date.now() - start;
      assert.ok(
        elapsed >= 10,
        `response should not be instant (took ${elapsed}ms), ` +
          'indicating a bcrypt compare was performed'
      );
    });

    it('calls ensureAuthSchema before SELECT', async () => {
      const pool = createMockPool();
      const db = createMockDb(pool);
      const { provider } = createGoTrueProvider({}, db);

      await provider.signIn('test@example.com', 'dummy-password');

      const selectIdx = pool.queries.findIndex(
        (q) => q.sql.includes('FROM auth.users')
      );
      const ddlQueries = pool.queries
        .slice(0, selectIdx)
        .filter((q) =>
          AUTH_SCHEMA_SQL.some((ddl) => q.sql === ddl)
        );
      assert.equal(
        ddlQueries.length,
        AUTH_SCHEMA_SQL.length,
        'all DDL statements should appear before SELECT'
      );
    });
  });

  // ----- refreshToken -----

  describe('refreshToken', () => {
    it('returns new user and providerTokens with rotated token', async () => {
      const oldToken = 'valid-opaque-token';
      const pool = createMockPool();
      const db = createMockDb(pool);
      const { provider } = createGoTrueProvider({}, db);

      const result = await provider.refreshToken(oldToken);

      assert.ok(result.user, 'should return user');
      assert.equal(result.user.id, MOCK_USER_ROW.id);
      assert.ok(
        result.providerTokens.refreshToken,
        'should have new refreshToken'
      );
      assert.notEqual(
        result.providerTokens.refreshToken,
        oldToken,
        'new token should differ from old token'
      );

      // Verify new token INSERT has parent = oldToken
      const insertToken = pool.queries.find(
        (q) =>
          q.sql.includes('INSERT INTO auth.refresh_tokens') &&
          q.params?.includes(oldToken)
      );
      assert.ok(
        insertToken,
        'should INSERT new token with parent = oldToken'
      );
    });

    it('revokes old token on successful refresh', async () => {
      const pool = createMockPool();
      const db = createMockDb(pool);
      const { provider } = createGoTrueProvider({}, db);

      await provider.refreshToken('valid-opaque-token');

      const revokeQuery = pool.queries.find(
        (q) =>
          q.sql.includes('UPDATE auth.refresh_tokens') &&
          q.sql.includes('revoked') &&
          q.params?.includes(MOCK_TOKEN_ROW.id)
      );
      assert.ok(
        revokeQuery,
        'should UPDATE to revoke the old token by id'
      );
    });

    it('triggers family revocation and throws invalid_grant on revoked token reuse', async () => {
      const pool = createMockPool({
        'FROM auth.refresh_tokens': () => ({
          rows: [{ ...MOCK_TOKEN_ROW, revoked: true }],
        }),
      });
      const db = createMockDb(pool);
      const { provider } = createGoTrueProvider({}, db);

      await assert.rejects(
        () => provider.refreshToken('valid-opaque-token'),
        (err) => {
          assert.equal(err.code, 'invalid_grant');
          return true;
        }
      );

      // Verify family revocation: UPDATE all tokens for
      // this user_id
      const familyRevoke = pool.queries.find(
        (q) =>
          q.sql.includes('UPDATE auth.refresh_tokens') &&
          q.sql.includes('revoked') &&
          q.params?.includes(MOCK_USER_ROW.id)
      );
      assert.ok(
        familyRevoke,
        'should revoke all tokens for the user (family revocation)'
      );
    });

    it('throws invalid_grant for nonexistent token', async () => {
      const pool = createMockPool({
        'FROM auth.refresh_tokens': () => ({ rows: [] }),
      });
      const db = createMockDb(pool);
      const { provider } = createGoTrueProvider({}, db);

      await assert.rejects(
        () => provider.refreshToken('nonexistent-token'),
        (err) => {
          assert.equal(err.code, 'invalid_grant');
          return true;
        }
      );
    });

    it('calls ensureAuthSchema before token lookup', async () => {
      const pool = createMockPool();
      const db = createMockDb(pool);
      const { provider } = createGoTrueProvider({}, db);

      await provider.refreshToken('valid-opaque-token');

      const tokenSelectIdx = pool.queries.findIndex(
        (q) => q.sql.includes('FROM auth.refresh_tokens')
      );
      const ddlQueries = pool.queries
        .slice(0, tokenSelectIdx)
        .filter((q) =>
          AUTH_SCHEMA_SQL.some((ddl) => q.sql === ddl)
        );
      assert.equal(
        ddlQueries.length,
        AUTH_SCHEMA_SQL.length,
        'all DDL statements should appear before token lookup'
      );
    });

    it('throws user_not_found when user is deleted after token rotation', async () => {
      const pool = createMockPool({
        'FROM auth.users': () => ({ rows: [] }),
      });
      const db = createMockDb(pool);
      const { provider } = createGoTrueProvider({}, db);

      await assert.rejects(
        () => provider.refreshToken('valid-opaque-token'),
        (err) => {
          assert.equal(err.code, 'user_not_found');
          return true;
        }
      );
    });
  });

  // ----- getUser -----

  describe('getUser', () => {
    it('returns AuthUser by ID', async () => {
      const pool = createMockPool();
      const db = createMockDb(pool);
      const { provider } = createGoTrueProvider({}, db);

      const user = await provider.getUser(MOCK_USER_ROW.id);

      assert.equal(user.id, MOCK_USER_ROW.id);
      assert.equal(user.email, MOCK_USER_ROW.email);
      assert.deepEqual(
        user.app_metadata,
        MOCK_USER_ROW.app_metadata
      );
      assert.deepEqual(
        user.user_metadata,
        MOCK_USER_ROW.user_metadata
      );
      assert.ok(user.created_at, 'should have created_at');
    });

    it('throws user_not_found for nonexistent user ID', async () => {
      const pool = createMockPool({
        'FROM auth.users': () => ({ rows: [] }),
      });
      const db = createMockDb(pool);
      const { provider } = createGoTrueProvider({}, db);

      await assert.rejects(
        () => provider.getUser('nonexistent-id'),
        (err) => {
          assert.equal(err.code, 'user_not_found');
          return true;
        }
      );
    });
  });

  // ----- signOut -----

  describe('signOut', () => {
    it('revokes all refresh tokens for the user', async () => {
      const pool = createMockPool();
      const db = createMockDb(pool);
      const { provider } = createGoTrueProvider({}, db);

      await provider.signOut(MOCK_USER_ROW.id);

      const revokeQuery = pool.queries.find(
        (q) =>
          q.sql.includes('UPDATE auth.refresh_tokens') &&
          q.sql.includes('revoked') &&
          q.params?.includes(MOCK_USER_ROW.id)
      );
      assert.ok(
        revokeQuery,
        'should UPDATE to revoke all tokens for the user'
      );
    });
  });
});
