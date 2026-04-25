import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createAuthHandler } from '../handler.mjs';
import { createJwt } from '../jwt.mjs';

const TEST_SECRET = 'test-secret-for-handler-unit-tests';

function makeEvent({
  method = 'POST',
  path = '/auth/v1/signup',
  query = {},
  headers = {},
  body = null,
} = {}) {
  return {
    httpMethod: method,
    path,
    queryStringParameters: Object.keys(query).length ? query : null,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : null,
  };
}

function parseBody(response) {
  return JSON.parse(response.body);
}

function decodePayload(token) {
  const parts = token.split('.');
  return JSON.parse(Buffer.from(parts[1], 'base64url').toString());
}

function createCognitoMockProvider(overrides = {}) {
  return {
    needsSessionTable: false,
    async signUp(email) {
      return {
        id: 'cognito-user-id',
        email,
        app_metadata: { provider: 'email', providers: ['email'] },
        user_metadata: {},
        created_at: '2026-04-24T12:00:00.000Z',
      };
    },
    async signIn(email) {
      return {
        user: {
          id: 'cognito-user-id',
          email,
          app_metadata: { provider: 'email', providers: ['email'] },
          user_metadata: {},
          created_at: '2026-04-24T12:00:00.000Z',
        },
        providerTokens: {
          accessToken: 'cognito-access-token',
          refreshToken: 'cognito-refresh-token',
          idToken: 'cognito-id-token',
        },
      };
    },
    async refreshToken(token) {
      return {
        user: {
          id: 'cognito-user-id',
          email: 'test@example.com',
          app_metadata: { provider: 'email', providers: ['email'] },
          user_metadata: {},
          created_at: '2026-04-24T12:00:00.000Z',
        },
        providerTokens: {
          accessToken: 'new-cognito-access',
          refreshToken: 'new-cognito-refresh-token',
          idToken: 'new-cognito-id',
        },
      };
    },
    async signOut() {},
    ...overrides,
  };
}

function createGoTrueMockProvider(overrides = {}) {
  return {
    needsSessionTable: true,
    async signUp(email) {
      return {
        id: 'gotrue-user-id',
        email,
        app_metadata: { provider: 'email', providers: ['email'] },
        user_metadata: {},
        created_at: '2026-04-24T12:00:00.000Z',
      };
    },
    async signIn(email) {
      return {
        user: {
          id: 'gotrue-user-id',
          email,
          app_metadata: { provider: 'email', providers: ['email'] },
          user_metadata: {},
          created_at: '2026-04-24T12:00:00.000Z',
        },
        providerTokens: {
          accessToken: 'gotrue-access-token',
          refreshToken: 'gotrue-provider-refresh-token',
          idToken: 'gotrue-id-token',
        },
      };
    },
    async refreshToken(prt) {
      return {
        user: {
          id: 'gotrue-user-id',
          email: 'test@example.com',
          app_metadata: { provider: 'email', providers: ['email'] },
          user_metadata: {},
          created_at: '2026-04-24T12:00:00.000Z',
        },
        providerTokens: {
          accessToken: 'new-gotrue-access',
          refreshToken: 'new-gotrue-refresh-token',
          idToken: 'new-gotrue-id',
        },
      };
    },
    async signOut() {},
    ...overrides,
  };
}

function createMockPool() {
  const queries = [];
  const pool = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (sql.includes('INSERT INTO auth.sessions')) {
        return { rows: [{ id: 'mock-session-id' }] };
      }
      if (sql.includes('FROM auth.sessions WHERE id')) {
        return {
          rows: [{
            user_id: 'gotrue-user-id',
            provider: 'gotrue',
            prt: 'stored-provider-token',
            revoked: false,
          }],
        };
      }
      if (sql.includes('UPDATE auth.sessions')) {
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
  return { pool, queries };
}

describe('Cognito no-session-table', () => {

  describe('Cognito path (needsSessionTable: false)', () => {
    let handler;
    let _setProvider;
    let jwt;
    let poolQueries;

    beforeEach(() => {
      jwt = createJwt({ jwtSecret: TEST_SECRET });
      const { pool, queries } = createMockPool();
      poolQueries = queries;
      const ctx = {
        jwt,
        authProvider: null,
        db: { getPool: async () => pool },
      };
      const result = createAuthHandler(
        { auth: { provider: 'cognito' }, jwtSecret: TEST_SECRET },
        ctx,
      );
      handler = result.handler;
      _setProvider = result._setProvider;
      _setProvider(createCognitoMockProvider());
    });

    describe('signup', () => {
      it('Cognito signup does not query the database', async () => {
        const event = makeEvent({
          body: { email: 'new@example.com', password: 'StrongPass1' },
        });
        const res = await handler(event);

        assert.equal(res.statusCode, 200, 'status should be 200');
        const body = parseBody(res);
        assert.ok(body.access_token, 'should have access_token');
        assert.ok(body.refresh_token, 'should have refresh_token');
        assert.ok(body.user, 'should have user');
        assert.equal(
          poolQueries.length, 0,
          `expected 0 SQL queries but got ${poolQueries.length}: `
          + poolQueries.map(q => q.sql).join('; '),
        );
      });

      it('Cognito signup refresh_token is the provider refresh token', async () => {
        const event = makeEvent({
          body: { email: 'new@example.com', password: 'StrongPass1' },
        });
        const res = await handler(event);
        const body = parseBody(res);

        assert.equal(
          body.refresh_token, 'cognito-refresh-token',
          'expected refresh_token to be the raw Cognito token '
          + `"cognito-refresh-token" but got "${body.refresh_token}"`,
        );
      });

      it('Cognito signup access_token is a pgrest-lambda JWT', async () => {
        const event = makeEvent({
          body: { email: 'new@example.com', password: 'StrongPass1' },
        });
        const res = await handler(event);
        const body = parseBody(res);
        const payload = decodePayload(body.access_token);

        assert.equal(payload.iss, 'pgrest-lambda',
          'access_token issuer should be pgrest-lambda');
        assert.equal(payload.role, 'authenticated',
          'access_token role should be authenticated');
        assert.equal(payload.sub, 'cognito-user-id',
          'access_token sub should be user id');
        assert.equal(payload.email, 'new@example.com',
          'access_token email should match');
      });
    });

    describe('password grant', () => {
      it('Cognito password grant does not query the database', async () => {
        const event = makeEvent({
          path: '/auth/v1/token',
          query: { grant_type: 'password' },
          body: { email: 'test@example.com', password: 'StrongPass1' },
        });
        const res = await handler(event);

        assert.equal(res.statusCode, 200, 'status should be 200');
        const body = parseBody(res);
        assert.ok(body.access_token, 'should have access_token');
        assert.ok(body.refresh_token, 'should have refresh_token');
        assert.equal(
          poolQueries.length, 0,
          `expected 0 SQL queries but got ${poolQueries.length}: `
          + poolQueries.map(q => q.sql).join('; '),
        );
      });

      it('Cognito password grant refresh_token is provider token', async () => {
        const event = makeEvent({
          path: '/auth/v1/token',
          query: { grant_type: 'password' },
          body: { email: 'test@example.com', password: 'StrongPass1' },
        });
        const res = await handler(event);
        const body = parseBody(res);

        assert.equal(
          body.refresh_token, 'cognito-refresh-token',
          'expected refresh_token to be the raw Cognito token '
          + `but got "${body.refresh_token}"`,
        );
      });
    });

    describe('refresh grant', () => {
      it('Cognito refresh grant passes token directly to provider', async () => {
        let refreshCalledWith = null;
        _setProvider(createCognitoMockProvider({
          async refreshToken(token) {
            refreshCalledWith = token;
            return {
              user: {
                id: 'cognito-user-id',
                email: 'test@example.com',
                app_metadata: { provider: 'email', providers: ['email'] },
                user_metadata: {},
                created_at: '2026-04-24T12:00:00.000Z',
              },
              providerTokens: {
                accessToken: 'new-cognito-access',
                refreshToken: 'new-cognito-refresh-token',
                idToken: 'new-cognito-id',
              },
            };
          },
        }));

        const event = makeEvent({
          path: '/auth/v1/token',
          query: { grant_type: 'refresh_token' },
          body: { refresh_token: 'cognito-refresh-token' },
        });
        const res = await handler(event);

        assert.equal(res.statusCode, 200,
          `expected 200 but got ${res.statusCode}: ${res.body}`);
        const body = parseBody(res);
        assert.ok(body.access_token, 'should have new access_token');
        assert.ok(body.refresh_token, 'should have new refresh_token');
        assert.equal(
          refreshCalledWith, 'cognito-refresh-token',
          'provider.refreshToken should be called with '
          + '"cognito-refresh-token" but was called with '
          + `"${refreshCalledWith}"`,
        );
        assert.equal(
          poolQueries.length, 0,
          `expected 0 SQL queries but got ${poolQueries.length}`,
        );
      });

      it('Cognito refresh grant with invalid provider token returns error', async () => {
        let refreshCalledWith = null;
        _setProvider(createCognitoMockProvider({
          async refreshToken(token) {
            refreshCalledWith = token;
            const err = new Error('Token expired or revoked');
            err.code = 'invalid_grant';
            throw err;
          },
        }));

        const event = makeEvent({
          path: '/auth/v1/token',
          query: { grant_type: 'refresh_token' },
          body: { refresh_token: 'bad-token' },
        });
        const res = await handler(event);

        assert.equal(
          refreshCalledWith, 'bad-token',
          'provider.refreshToken should be called with "bad-token" but was '
          + (refreshCalledWith === null
            ? 'never called'
            : `called with "${refreshCalledWith}"`),
        );
        assert.equal(res.statusCode, 401, 'status should be 401');
        const body = parseBody(res);
        assert.equal(body.error, 'invalid_grant');
      });
    });

    describe('logout', () => {
      it('Cognito logout does not revoke database sessions', async () => {
        let signOutCalledWith = null;
        _setProvider(createCognitoMockProvider({
          async signOut(userId) {
            signOutCalledWith = userId;
          },
        }));

        const accessToken = jwt.signAccessToken({
          sub: 'cognito-user-id',
          email: 'test@example.com',
        });
        const event = makeEvent({
          method: 'POST',
          path: '/auth/v1/logout',
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        const res = await handler(event);

        assert.equal(res.statusCode, 204, 'status should be 204');
        assert.equal(
          poolQueries.length, 0,
          `expected 0 SQL queries but got ${poolQueries.length}: `
          + poolQueries.map(q => q.sql).join('; '),
        );
        assert.equal(
          signOutCalledWith, 'cognito-user-id',
          'provider.signOut should be called with user id but was '
          + (signOutCalledWith === null
            ? 'never called'
            : `called with "${signOutCalledWith}"`),
        );
      });
    });
  });

  describe('GoTrue path (needsSessionTable: true)', () => {
    let handler;
    let _setProvider;
    let jwt;
    let poolQueries;

    beforeEach(() => {
      jwt = createJwt({ jwtSecret: TEST_SECRET });
      const { pool, queries } = createMockPool();
      poolQueries = queries;
      const ctx = {
        jwt,
        authProvider: null,
        db: { getPool: async () => pool },
      };
      const result = createAuthHandler(
        { auth: { provider: 'gotrue' }, jwtSecret: TEST_SECRET },
        ctx,
      );
      handler = result.handler;
      _setProvider = result._setProvider;
      _setProvider(createGoTrueMockProvider());
    });

    it('GoTrue signup creates a session row', async () => {
      const event = makeEvent({
        body: { email: 'new@example.com', password: 'StrongPass1' },
      });
      const res = await handler(event);

      assert.equal(res.statusCode, 200, 'status should be 200');
      const insertQuery = poolQueries.find(
        q => q.sql?.includes('INSERT INTO auth.sessions'),
      );
      assert.ok(insertQuery,
        'should INSERT INTO auth.sessions');
      const body = parseBody(res);
      const refreshPayload = decodePayload(body.refresh_token);
      assert.equal(typeof refreshPayload.sid, 'string',
        'refresh_token should be a pgrest-lambda JWT with sid claim');
    });

    it('GoTrue password grant creates a session row', async () => {
      const event = makeEvent({
        path: '/auth/v1/token',
        query: { grant_type: 'password' },
        body: { email: 'test@example.com', password: 'StrongPass1' },
      });
      const res = await handler(event);

      assert.equal(res.statusCode, 200, 'status should be 200');
      const insertQuery = poolQueries.find(
        q => q.sql?.includes('INSERT INTO auth.sessions'),
      );
      assert.ok(insertQuery,
        'should INSERT INTO auth.sessions');
      const body = parseBody(res);
      const refreshPayload = decodePayload(body.refresh_token);
      assert.equal(typeof refreshPayload.sid, 'string',
        'refresh_token should be a pgrest-lambda JWT with sid claim');
    });

    it('GoTrue refresh grant uses session lookup', async () => {
      let refreshCalledWith = null;
      _setProvider(createGoTrueMockProvider({
        async refreshToken(prt) {
          refreshCalledWith = prt;
          return {
            user: {
              id: 'gotrue-user-id',
              email: 'test@example.com',
              app_metadata: { provider: 'email', providers: ['email'] },
              user_metadata: {},
              created_at: '2026-04-24T12:00:00.000Z',
            },
            providerTokens: {
              accessToken: 'new-gotrue-access',
              refreshToken: 'new-gotrue-refresh-token',
              idToken: 'new-gotrue-id',
            },
          };
        },
      }));

      const refreshJwt = jwt.signRefreshToken(
        'gotrue-user-id', 'mock-session-id',
      );
      const event = makeEvent({
        path: '/auth/v1/token',
        query: { grant_type: 'refresh_token' },
        body: { refresh_token: refreshJwt },
      });
      const res = await handler(event);

      assert.equal(res.statusCode, 200,
        `status should be 200 but got ${res.statusCode}: ${res.body}`);
      const selectQuery = poolQueries.find(
        q => q.sql?.includes('FROM auth.sessions'),
      );
      assert.ok(selectQuery, 'should SELECT from auth.sessions');
      assert.equal(refreshCalledWith, 'stored-provider-token',
        'provider.refreshToken should be called with stored prt');
      const updateQuery = poolQueries.find(
        q => q.sql?.includes('UPDATE auth.sessions'),
      );
      assert.ok(updateQuery, 'should UPDATE auth.sessions');
    });

    it('GoTrue logout revokes database sessions', async () => {
      const accessToken = jwt.signAccessToken({
        sub: 'gotrue-user-id',
        email: 'test@example.com',
      });
      const event = makeEvent({
        method: 'POST',
        path: '/auth/v1/logout',
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const res = await handler(event);

      assert.equal(res.statusCode, 204, 'status should be 204');
      const revokeQuery = poolQueries.find(
        q => q.sql?.includes('UPDATE auth.sessions SET revoked'),
      );
      assert.ok(revokeQuery,
        'should UPDATE auth.sessions SET revoked');
    });
  });

  describe('Provider capability contract', () => {
    it('needsSessionTable property is respected', async () => {
      const jwtHelper = createJwt({ jwtSecret: TEST_SECRET });

      // needsSessionTable: true → session queries made
      const { pool: pool1, queries: queries1 } = createMockPool();
      const ctx1 = {
        jwt: jwtHelper,
        authProvider: null,
        db: { getPool: async () => pool1 },
      };
      const r1 = createAuthHandler(
        { auth: { provider: 'gotrue' }, jwtSecret: TEST_SECRET },
        ctx1,
      );
      r1._setProvider(createGoTrueMockProvider());
      await r1.handler(makeEvent({
        body: { email: 'new@example.com', password: 'StrongPass1' },
      }));
      const hasSessionQuery1 = queries1.some(
        q => q.sql?.includes('auth.sessions'),
      );
      assert.ok(hasSessionQuery1,
        'with needsSessionTable: true, should make session queries');

      // needsSessionTable: false → no session queries
      const { pool: pool2, queries: queries2 } = createMockPool();
      const ctx2 = {
        jwt: jwtHelper,
        authProvider: null,
        db: { getPool: async () => pool2 },
      };
      const r2 = createAuthHandler(
        { auth: { provider: 'cognito' }, jwtSecret: TEST_SECRET },
        ctx2,
      );
      r2._setProvider(createCognitoMockProvider());
      await r2.handler(makeEvent({
        body: { email: 'new@example.com', password: 'StrongPass1' },
      }));
      assert.equal(
        queries2.length, 0,
        'with needsSessionTable: false, expected 0 SQL queries but got '
        + `${queries2.length}: `
        + queries2.map(q => q.sql).join('; '),
      );
    });
  });
});
