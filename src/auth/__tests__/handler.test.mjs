import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createAuthHandler } from '../handler.mjs';
import { createJwt } from '../jwt.mjs';
import { makeEvent, parseBody } from './helpers/events.mjs';
const TEST_SECRET = 'test-secret-for-handler-unit-tests';

// Mock provider that responds based on email/password values
function createMockProvider() {
  return {
    async signUp(email, password) {
      if (email === 'existing@example.com') {
        const err = new Error('User already exists');
        err.code = 'user_already_exists';
        throw err;
      }
      if (password === 'weak') {
        const err = new Error('Weak password');
        err.code = 'weak_password';
        throw err;
      }
      if (email === 'error@example.com') {
        const err = new Error('Something went wrong');
        err.code = 'unexpected_failure';
        throw err;
      }
      return {
        id: 'test-user-id-123',
        email,
        app_metadata: { provider: 'email', providers: ['email'] },
        user_metadata: {},
        created_at: '2026-04-11T12:00:00.000Z',
      };
    },
    async signIn(email) {
      if (email === 'badcreds@example.com') {
        const err = new Error('Bad credentials');
        err.code = 'invalid_grant';
        throw err;
      }
      return {
        user: {
          id: 'test-user-id-123',
          email,
          app_metadata: { provider: 'email', providers: ['email'] },
          user_metadata: {},
          created_at: '2026-04-11T12:00:00.000Z',
        },
        providerTokens: {
          accessToken: 'cognito-access-token',
          refreshToken: 'cognito-refresh-token',
          idToken: 'cognito-id-token',
        },
      };
    },
    async refreshToken(prt) {
      return {
        user: {
          id: 'test-user-id-123',
          email: 'test@example.com',
          app_metadata: { provider: 'email', providers: ['email'] },
          user_metadata: {},
          created_at: '2026-04-11T12:00:00.000Z',
        },
        providerTokens: {
          accessToken: 'new-cognito-access',
          refreshToken: prt,
          idToken: 'new-cognito-id',
        },
      };
    },
    async signOut() {},
  };
}

describe('handler.mjs', () => {
  let handler;
  let _setProvider;
  let jwt;
  beforeEach(() => {
    jwt = createJwt({ jwtSecret: TEST_SECRET });
    const mockPool = {
      query: async () => ({ rows: [] }),
    };
    const ctx = {
      jwt,
      authProvider: null,
      db: { getPool: async () => mockPool },
    };
    const result = createAuthHandler(
      { auth: { provider: 'cognito' }, jwtSecret: TEST_SECRET },
      ctx,
    );
    handler = result.handler;
    _setProvider = result._setProvider;
    _setProvider(createMockProvider());
  });

  describe('POST /auth/v1/signup', () => {
    it('returns 200 with session for valid email and password', async () => {
      const event = makeEvent({
        body: {
          email: 'new@example.com',
          password: 'StrongPass1',
        },
      });

      const res = await handler(event);

      assert.equal(res.statusCode, 200, 'status should be 200');
      const body = parseBody(res);
      assert.ok(body.access_token, 'should have access_token');
      assert.ok(body.refresh_token, 'should have refresh_token');
      assert.ok(body.user, 'should have user');
      assert.equal(
        body.token_type,
        'bearer',
        'token_type should be bearer'
      );
    });

    it('returns 400 with validation_failed for missing email', async () => {
      const event = makeEvent({
        body: { password: 'StrongPass1' },
      });

      const res = await handler(event);

      assert.equal(res.statusCode, 400, 'status should be 400');
      const body = parseBody(res);
      assert.equal(body.error, 'validation_failed');
      assert.equal(
        body.error_description,
        'Email is required'
      );
    });

    it('returns 400 with validation_failed for missing password', async () => {
      const event = makeEvent({
        body: { email: 'test@example.com' },
      });

      const res = await handler(event);

      assert.equal(res.statusCode, 400, 'status should be 400');
      const body = parseBody(res);
      assert.equal(body.error, 'validation_failed');
      assert.equal(
        body.error_description,
        'Password is required'
      );
    });

    it('returns 400 with validation_failed for invalid email format', async () => {
      const event = makeEvent({
        body: { email: 'not-an-email', password: 'StrongPass1' },
      });

      const res = await handler(event);

      assert.equal(res.statusCode, 400, 'status should be 400');
      const body = parseBody(res);
      assert.equal(body.error, 'validation_failed');
      assert.equal(
        body.error_description,
        'Invalid email format'
      );
    });

    it('returns 400 with user_already_exists for duplicate email', async () => {
      const event = makeEvent({
        body: {
          email: 'existing@example.com',
          password: 'StrongPass1',
        },
      });

      const res = await handler(event);

      assert.equal(res.statusCode, 400, 'status should be 400');
      const body = parseBody(res);
      assert.equal(body.error, 'user_already_exists');
      assert.equal(
        body.error_description,
        'User already registered'
      );
    });

    it('returns 422 with weak_password for weak password', async () => {
      const event = makeEvent({
        body: { email: 'test@example.com', password: 'weak' },
      });

      const res = await handler(event);

      assert.equal(res.statusCode, 422, 'status should be 422');
      const body = parseBody(res);
      assert.equal(body.error, 'weak_password');
      assert.equal(
        body.error_description,
        'Password must be at least 8 characters and include uppercase, lowercase, and numbers'
      );
    });

    it('calls both signUp and signIn during signup flow', async () => {
      let signUpCalls = 0;
      let signInCalls = 0;
      const countingProvider = {
        ...createMockProvider(),
        async signUp(email, password) {
          signUpCalls++;
          return createMockProvider().signUp(email, password);
        },
        async signIn(email, password) {
          signInCalls++;
          return createMockProvider().signIn(email, password);
        },
      };
      _setProvider(countingProvider);

      const event = makeEvent({
        body: { email: 'count@example.com', password: 'StrongPass1' },
      });
      const res = await handler(event);

      assert.equal(res.statusCode, 200);
      assert.equal(signUpCalls, 1, 'signUp should be called exactly once');
      assert.equal(signInCalls, 1, 'signIn should be called exactly once');

      // Reset
      _setProvider(createMockProvider());
    });

    it('returns weak_password with reasons field for weak password', async () => {
      const providerWithReasons = {
        ...createMockProvider(),
        async signUp(email, password) {
          if (password === 'weak') {
            const err = new Error('Weak password');
            err.code = 'weak_password';
            err.reasons = ['length', 'characters'];
            throw err;
          }
          return createMockProvider().signUp(email, password);
        },
      };
      _setProvider(providerWithReasons);

      const event = makeEvent({
        body: { email: 'test@example.com', password: 'weak' },
      });
      const res = await handler(event);

      assert.equal(res.statusCode, 422);
      const body = parseBody(res);
      assert.equal(body.error, 'weak_password');
      assert.ok(body.weak_password, 'should include weak_password field');
      assert.deepEqual(body.weak_password.reasons, ['length', 'characters']);

      // Reset
      _setProvider(createMockProvider());
    });

    it('returns 500 with unexpected_failure for unexpected provider error', async () => {
      const event = makeEvent({
        body: {
          email: 'error@example.com',
          password: 'StrongPass1',
        },
      });

      const res = await handler(event);

      assert.equal(res.statusCode, 500, 'status should be 500');
      const body = parseBody(res);
      assert.equal(body.error, 'unexpected_failure');
      assert.equal(
        body.error_description,
        'An unexpected error occurred'
      );
    });

    it('Signup: refresh token is the raw provider token', async () => {
      const event = makeEvent({
        body: {
          email: 'newsid@example.com',
          password: 'StrongPass1',
        },
      });

      const res = await handler(event);

      assert.equal(res.statusCode, 200, 'status should be 200');
      const body = parseBody(res);
      assert.equal(
        body.refresh_token,
        'cognito-refresh-token',
        'refresh_token should be the raw provider token',
      );
    });
  });

  describe('POST /auth/v1/token?grant_type=password', () => {
    it('returns 200 with session for valid credentials', async () => {
      const event = makeEvent({
        path: '/auth/v1/token',
        query: { grant_type: 'password' },
        body: {
          email: 'test@example.com',
          password: 'StrongPass1',
        },
      });

      const res = await handler(event);

      assert.equal(res.statusCode, 200, 'status should be 200');
      const body = parseBody(res);
      assert.ok(body.access_token, 'should have access_token');
      assert.ok(body.refresh_token, 'should have refresh_token');
      assert.ok(body.user, 'should have user');
    });

    it('returns 400 with validation_failed for missing email', async () => {
      const event = makeEvent({
        path: '/auth/v1/token',
        query: { grant_type: 'password' },
        body: { password: 'StrongPass1' },
      });

      const res = await handler(event);

      assert.equal(res.statusCode, 400, 'status should be 400');
      const body = parseBody(res);
      assert.equal(body.error, 'validation_failed');
      assert.equal(body.error_description, 'Email is required');
    });

    it('returns 400 with validation_failed for missing password', async () => {
      const event = makeEvent({
        path: '/auth/v1/token',
        query: { grant_type: 'password' },
        body: { email: 'test@example.com' },
      });

      const res = await handler(event);

      assert.equal(res.statusCode, 400, 'status should be 400');
      const body = parseBody(res);
      assert.equal(body.error, 'validation_failed');
      assert.equal(
        body.error_description,
        'Password is required'
      );
    });

    it('returns 400 with invalid_grant for bad credentials', async () => {
      const event = makeEvent({
        path: '/auth/v1/token',
        query: { grant_type: 'password' },
        body: {
          email: 'badcreds@example.com',
          password: 'WrongPass1',
        },
      });

      const res = await handler(event);

      assert.equal(res.statusCode, 400, 'status should be 400');
      const body = parseBody(res);
      assert.equal(body.error, 'invalid_grant');
      assert.equal(
        body.error_description,
        'Invalid login credentials'
      );
    });

    it('Password grant: refresh token is the raw provider token', async () => {
      const event = makeEvent({
        path: '/auth/v1/token',
        query: { grant_type: 'password' },
        body: {
          email: 'test@example.com',
          password: 'StrongPass1',
        },
      });

      const res = await handler(event);

      assert.equal(res.statusCode, 200, 'status should be 200');
      const body = parseBody(res);
      assert.equal(
        body.refresh_token,
        'cognito-refresh-token',
        'refresh_token should be the raw provider token',
      );
    });
  });

  describe('POST /auth/v1/token without grant_type', () => {
    it('returns 400 with unsupported_grant_type when grant_type missing', async () => {
      const event = makeEvent({
        path: '/auth/v1/token',
        body: {
          email: 'test@example.com',
          password: 'StrongPass1',
        },
      });

      const res = await handler(event);

      assert.equal(res.statusCode, 400, 'status should be 400');
      const body = parseBody(res);
      assert.equal(body.error, 'unsupported_grant_type');
      assert.equal(
        body.error_description,
        'Missing or unsupported grant_type'
      );
    });

    it('returns 400 with unsupported_grant_type for magic_link', async () => {
      const event = makeEvent({
        path: '/auth/v1/token',
        query: { grant_type: 'magic_link' },
        body: { email: 'test@example.com' },
      });

      const res = await handler(event);

      assert.equal(res.statusCode, 400, 'status should be 400');
      const body = parseBody(res);
      assert.equal(body.error, 'unsupported_grant_type');
      assert.equal(
        body.error_description,
        'Missing or unsupported grant_type'
      );
    });
  });

  describe('POST /auth/v1/token?grant_type=refresh_token', () => {
    it('returns 200 with new session for valid refresh_token', async () => {
      const validRefreshJwt = jwt.signRefreshToken(
        'test-user-id-123',
        'cognito-refresh-token'
      );
      const event = makeEvent({
        path: '/auth/v1/token',
        query: { grant_type: 'refresh_token' },
        body: { refresh_token: validRefreshJwt },
      });

      const res = await handler(event);

      assert.equal(res.statusCode, 200, 'status should be 200');
      const body = parseBody(res);
      assert.ok(body.access_token, 'should have new access_token');
      assert.ok(
        body.refresh_token,
        'should have new refresh_token'
      );
    });

    it('returns 400 with validation_failed for missing refresh_token', async () => {
      const event = makeEvent({
        path: '/auth/v1/token',
        query: { grant_type: 'refresh_token' },
        body: {},
      });

      const res = await handler(event);

      assert.equal(res.statusCode, 400, 'status should be 400');
      const body = parseBody(res);
      assert.equal(body.error, 'validation_failed');
      assert.equal(
        body.error_description,
        'Refresh token is required'
      );
    });

    it('returns 401 with invalid_grant when provider rejects refresh token', async () => {
      _setProvider({
        ...createMockProvider(),
        async refreshToken() {
          const err = new Error('Token expired or revoked');
          err.code = 'invalid_grant';
          throw err;
        },
      });

      const event = makeEvent({
        path: '/auth/v1/token',
        query: { grant_type: 'refresh_token' },
        body: { refresh_token: 'invalid-token' },
      });

      const res = await handler(event);

      assert.equal(res.statusCode, 401, 'status should be 401');
      const body = parseBody(res);
      assert.equal(body.error, 'invalid_grant');
      assert.equal(
        body.error_description,
        'Invalid refresh token'
      );

      _setProvider(createMockProvider());
    });

    it('Refresh grant: passes token directly to provider', async () => {
      let refreshCalledWith;
      const spyProvider = {
        ...createMockProvider(),
        async refreshToken(token) {
          refreshCalledWith = token;
          return {
            user: {
              id: 'test-user-id-123',
              email: 'test@example.com',
              app_metadata: { provider: 'email', providers: ['email'] },
              user_metadata: {},
              created_at: '2026-04-11T12:00:00.000Z',
            },
            providerTokens: {
              accessToken: 'new-access',
              refreshToken: 'new-provider-refresh-token',
              idToken: 'new-id',
            },
          };
        },
      };
      _setProvider(spyProvider);

      const event = makeEvent({
        path: '/auth/v1/token',
        query: { grant_type: 'refresh_token' },
        body: { refresh_token: 'cognito-refresh-token' },
      });

      const res = await handler(event);

      assert.equal(res.statusCode, 200, 'status should be 200');
      const body = parseBody(res);
      assert.ok(body.access_token, 'should have new access_token');
      assert.ok(body.refresh_token, 'should have new refresh_token');

      assert.equal(
        refreshCalledWith,
        'cognito-refresh-token',
        'prov.refreshToken should be called with the raw token',
      );

      _setProvider(createMockProvider());
    });
  });

  describe('GET /auth/v1/user', () => {
    it('returns 200 with user for valid Bearer token', async () => {
      const validAccessJwt = jwt.signAccessToken({
        sub: 'test-user-id-123',
        email: 'test@example.com',
      });
      const event = makeEvent({
        method: 'GET',
        path: '/auth/v1/user',
        headers: { Authorization: `Bearer ${validAccessJwt}` },
      });

      const res = await handler(event);

      assert.equal(res.statusCode, 200, 'status should be 200');
      const body = parseBody(res);
      assert.ok(body.id, 'user should have id');
      assert.ok(body.email, 'user should have email');
      assert.equal(
        body.role,
        'authenticated',
        'role should be authenticated'
      );
    });

    it('returns 401 with not_authenticated for missing Authorization', async () => {
      const event = makeEvent({
        method: 'GET',
        path: '/auth/v1/user',
      });

      const res = await handler(event);

      assert.equal(res.statusCode, 401, 'status should be 401');
      const body = parseBody(res);
      assert.equal(body.error, 'not_authenticated');
      assert.equal(
        body.error_description,
        'Missing authorization header'
      );
    });

    it('returns 401 with not_authenticated for expired token', async () => {
      const event = makeEvent({
        method: 'GET',
        path: '/auth/v1/user',
        headers: { Authorization: 'Bearer expired-token' },
      });

      const res = await handler(event);

      assert.equal(res.statusCode, 401, 'status should be 401');
      const body = parseBody(res);
      assert.equal(body.error, 'not_authenticated');
      assert.equal(
        body.error_description,
        'Invalid or expired token'
      );
    });
  });

  describe('POST /auth/v1/logout', () => {
    it('returns 204', async () => {
      const event = makeEvent({
        path: '/auth/v1/logout',
      });

      const res = await handler(event);

      assert.equal(res.statusCode, 204, 'status should be 204');
    });

    it('Logout: calls provider signOut with user id', async () => {
      let signOutCalledWith = null;
      _setProvider({
        ...createMockProvider(),
        async signOut(userId) {
          signOutCalledWith = userId;
        },
      });

      const accessToken = jwt.signAccessToken({
        sub: 'test-user-id-123',
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
        signOutCalledWith,
        'test-user-id-123',
        'provider.signOut should be called with claims.sub',
      );

      _setProvider(createMockProvider());
    });
  });

  describe('OPTIONS (CORS preflight)', () => {
    it('returns 200 with CORS headers for any /auth/v1/ path', async () => {
      const event = makeEvent({
        method: 'OPTIONS',
        path: '/auth/v1/signup',
      });

      const res = await handler(event);

      assert.equal(res.statusCode, 200, 'status should be 200');
      assert.ok(
        res.headers['Access-Control-Allow-Origin'],
        'should have CORS Allow-Origin'
      );
      assert.ok(
        res.headers['Access-Control-Allow-Methods'],
        'should have CORS Allow-Methods'
      );
    });
  });

  describe('404 for unknown paths', () => {
    it('returns 404 with not_found for unknown endpoint', async () => {
      const event = makeEvent({
        method: 'GET',
        path: '/auth/v1/unknown',
      });

      const res = await handler(event);

      assert.equal(res.statusCode, 404, 'status should be 404');
      const body = parseBody(res);
      assert.equal(body.error, 'not_found');
      assert.equal(
        body.error_description,
        'Endpoint not found'
      );
    });
  });

  describe('CORS headers on auth responses', () => {
    let corsHandler;

    beforeEach(() => {
      const corsCtx = {
        jwt: createJwt({ jwtSecret: TEST_SECRET }),
        authProvider: null,
        cors: {
          allowedOrigins: ['https://app.com'],
          allowCredentials: false,
        },
      };
      const result = createAuthHandler(
        { auth: { provider: 'cognito' }, jwtSecret: TEST_SECRET },
        corsCtx,
      );
      corsHandler = result.handler;
      result._setProvider(createMockProvider());
    });

    it('OPTIONS /auth/v1/signup with matching origin reflects it', async () => {
      const event = makeEvent({
        method: 'OPTIONS',
        path: '/auth/v1/signup',
        headers: { Origin: 'https://app.com' },
      });
      const res = await corsHandler(event);
      assert.equal(res.statusCode, 200, 'OPTIONS should return 200');
      assert.equal(
        res.headers['Access-Control-Allow-Origin'],
        'https://app.com',
        'Allow-Origin should reflect the matching origin',
      );
    });

    it('error response includes CORS headers for matching origin', async () => {
      const event = makeEvent({
        method: 'POST',
        path: '/auth/v1/signup',
        body: { password: 'StrongPass1' },
        headers: { Origin: 'https://app.com' },
      });
      const res = await corsHandler(event);
      assert.equal(res.statusCode, 400, 'missing email should return 400');
      assert.equal(
        res.headers['Access-Control-Allow-Origin'],
        'https://app.com',
        'error response should include Allow-Origin for matching origin',
      );
    });
  });

  describe('getOpenApiPaths', () => {
    it('returns paths for all auth endpoints', () => {
      const ctx = { jwt: createJwt({ jwtSecret: TEST_SECRET }), authProvider: null };
      const result = createAuthHandler(
        { auth: { provider: 'cognito' }, jwtSecret: TEST_SECRET },
        ctx,
      );

      const contribution = result.getOpenApiPaths('https://api.example.com/rest/v1');
      assert.ok(contribution.paths, 'should have paths');
      assert.ok(contribution.paths['/signup'], 'should have /signup');
      assert.ok(contribution.paths['/token?grant_type=password'], 'should have /token password');
      assert.ok(contribution.paths['/token?grant_type=refresh_token'], 'should have /token refresh');
      assert.ok(contribution.paths['/user'], 'should have /user');
      assert.ok(contribution.paths['/logout'], 'should have /logout');
      assert.ok(contribution.paths['/otp'], 'should have /otp');
      assert.ok(contribution.paths['/verify'], 'should have /verify');
      assert.ok(contribution.paths['/authorize'], 'should have /authorize');
      assert.ok(contribution.paths['/callback'], 'should have /callback');
      assert.ok(contribution.paths['/jwks'], 'should have /jwks');
    });

    it('returns auth schemas', () => {
      const ctx = { jwt: createJwt({ jwtSecret: TEST_SECRET }), authProvider: null };
      const result = createAuthHandler(
        { auth: { provider: 'cognito' }, jwtSecret: TEST_SECRET },
        ctx,
      );

      const contribution = result.getOpenApiPaths('https://api.example.com/rest/v1');
      assert.ok(contribution.schemas, 'should have schemas');
      assert.ok(contribution.schemas.AuthSession, 'should have AuthSession');
      assert.ok(contribution.schemas.AuthUser, 'should have AuthUser');
      assert.ok(contribution.schemas.AuthError, 'should have AuthError');
      assert.ok(contribution.schemas.OtpRequest, 'should have OtpRequest');
      assert.ok(contribution.schemas.VerifyRequest, 'should have VerifyRequest');
    });

    it('derives auth URL from base URL', () => {
      const ctx = { jwt: createJwt({ jwtSecret: TEST_SECRET }), authProvider: null };
      const result = createAuthHandler(
        { auth: { provider: 'cognito' }, jwtSecret: TEST_SECRET },
        ctx,
      );

      const contribution = result.getOpenApiPaths('https://api.example.com/rest/v1');
      const signupPath = contribution.paths['/signup'];
      assert.ok(signupPath.servers, 'should have servers override');
      assert.equal(signupPath.servers[0].url, 'https://api.example.com/auth/v1');
    });
  });
});
