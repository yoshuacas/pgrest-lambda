import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createAuthHandler } from '../handler.mjs';
import { createJwt } from '../jwt.mjs';
import { makeEvent, parseBody, decodePayload } from './helpers/events.mjs';

const TEST_SECRET = 'test-secret-for-handler-unit-tests';

function createCognitoMockProvider(overrides = {}) {
  return {
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

function createMockPool() {
  const queries = [];
  const pool = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      return { rows: [] };
    },
  };
  return { pool, queries };
}

describe('Cognito no-session-table', () => {

  describe('Cognito path (does not issue own access token)', () => {
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

});
