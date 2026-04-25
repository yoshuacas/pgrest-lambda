import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createAuthHandler } from '../handler.mjs';
import { createJwt } from '../jwt.mjs';
import { createHmac, generateKeyPairSync } from 'node:crypto';
import { exportJWK, SignJWT } from 'jose';
import {
  privateKey, publicKey, makeEdDSAToken as _makeEdDSAToken,
  makeExpiredEdDSAToken as _makeExpiredEdDSAToken, getPubJwk,
} from './helpers/eddsa.mjs';
import { makeEvent, parseBody, decodePayload } from './helpers/events.mjs';
import { withCallTracking } from './helpers/tracking.mjs';

const TEST_SECRET = 'test-secret-for-handler-unit-tests';

const MOCK_USER = {
  id: 'ba-user-id-001',
  email: 'test@example.com',
  app_metadata: { provider: 'email', providers: ['email'] },
  user_metadata: {},
  created_at: '2026-04-24T12:00:00.000Z',
};

async function makeEdDSAToken(claims = {}, key = privateKey) {
  return _makeEdDSAToken(
    { sub: MOCK_USER.id, email: MOCK_USER.email, ...claims },
    key,
  );
}

async function makeExpiredEdDSAToken() {
  return _makeExpiredEdDSAToken(privateKey);
}

function createBetterAuthMockProvider(overrides = {}) {
  let signUpCalls = 0;
  let signInCalls = 0;
  let signOutCalledWith = null;
  const provider = {
    issuesOwnAccessToken: true,
    signUpCalls: () => signUpCalls,
    signInCalls: () => signInCalls,
    signOutCalledWith: () => signOutCalledWith,
    async getJwks() {
      return { keys: [await getPubJwk()] };
    },
    async signUp(email, password) {
      signUpCalls++;
      if (email === 'existing@example.com') {
        const err = new Error('User already exists');
        err.code = 'user_already_exists';
        throw err;
      }
      return {
        user: { ...MOCK_USER, email },
        accessToken: 'ba-issued-access-token',
        refreshToken: 'ba-opaque-session-token',
        expiresIn: 3600,
      };
    },
    async signIn(email, password) {
      signInCalls++;
      if (email === 'badcreds@example.com') {
        const err = new Error('Bad credentials');
        err.code = 'invalid_grant';
        throw err;
      }
      return {
        user: { ...MOCK_USER, email },
        accessToken: 'ba-issued-access-token',
        refreshToken: 'ba-opaque-session-token',
        expiresIn: 3600,
      };
    },
    async refreshToken(sessionToken) {
      if (sessionToken === 'invalid-session-token') {
        const err = new Error('Session expired');
        err.code = 'invalid_grant';
        throw err;
      }
      return {
        user: MOCK_USER,
        accessToken: 'ba-refreshed-access-token',
        refreshToken: 'ba-new-session-token',
        expiresIn: 3600,
      };
    },
    async getUser(accessToken) {
      return MOCK_USER;
    },
    async signOut(sessionToken) {
      signOutCalledWith = sessionToken;
    },
    ...overrides,
  };
  return provider;
}

function createCognitoLikeMockProvider(overrides = {}) {
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

describe('handler with issuesOwnAccessToken provider (better-auth)', () => {
  let handler;
  let _setProvider;
  let jwt;
  let mockProvider;

  beforeEach(() => {
    jwt = createJwt({ jwtSecret: TEST_SECRET });
    const ctx = {
      jwt,
      authProvider: null,
      db: { getPool: async () => ({ query: async () => ({ rows: [] }) }) },
    };
    const result = createAuthHandler(
      { auth: { provider: 'better-auth' }, jwtSecret: TEST_SECRET },
      ctx,
    );
    handler = result.handler;
    _setProvider = result._setProvider;
    mockProvider = createBetterAuthMockProvider();
    _setProvider(mockProvider);
  });

  describe('POST /auth/v1/signup', () => {
    it('returns 200 with GoTrue envelope for valid signup', async () => {
      const event = makeEvent({
        body: { email: 'new@example.com', password: 'StrongPass1' },
      });
      const res = await handler(event);

      assert.equal(res.statusCode, 200);
      const body = parseBody(res);
      assert.ok(body.access_token, 'should have access_token');
      assert.ok(body.refresh_token, 'should have refresh_token');
      assert.ok(body.user, 'should have user');
      assert.equal(body.token_type, 'bearer');
    });

    it('uses provider-issued accessToken, not pgrest-lambda HS256 JWT', async () => {
      const event = makeEvent({
        body: { email: 'new@example.com', password: 'StrongPass1' },
      });
      const res = await handler(event);
      const body = parseBody(res);

      assert.equal(
        body.access_token,
        'ba-issued-access-token',
        'access_token should be the provider-issued token, not an HS256 JWT',
      );
    });

    it('calls signUp once and does NOT call signIn', async () => {
      const event = makeEvent({
        body: { email: 'new@example.com', password: 'StrongPass1' },
      });
      await handler(event);

      assert.equal(mockProvider.signUpCalls(), 1, 'signUp should be called once');
      assert.equal(mockProvider.signInCalls(), 0, 'signIn should NOT be called');
    });
  });

  describe('POST /auth/v1/token?grant_type=password', () => {
    it('returns 200 with GoTrue envelope using provider accessToken', async () => {
      const event = makeEvent({
        path: '/auth/v1/token',
        query: { grant_type: 'password' },
        body: { email: 'test@example.com', password: 'StrongPass1' },
      });
      const res = await handler(event);

      assert.equal(res.statusCode, 200);
      const body = parseBody(res);
      assert.equal(
        body.access_token,
        'ba-issued-access-token',
        'should use provider-issued access token',
      );
    });

    it('returns 400 with invalid_grant for bad credentials', async () => {
      const goodRes = await handler(makeEvent({
        path: '/auth/v1/token',
        query: { grant_type: 'password' },
        body: { email: 'test@example.com', password: 'StrongPass1' },
      }));
      const goodBody = parseBody(goodRes);
      assert.equal(
        goodBody.access_token,
        'ba-issued-access-token',
        'success path must use provider-issued token (issuesOwnAccessToken)',
      );

      const event = makeEvent({
        path: '/auth/v1/token',
        query: { grant_type: 'password' },
        body: { email: 'badcreds@example.com', password: 'WrongPass1' },
      });
      const res = await handler(event);

      assert.equal(res.statusCode, 400);
      const body = parseBody(res);
      assert.equal(body.error, 'invalid_grant');
    });
  });

  describe('POST /auth/v1/token?grant_type=refresh_token', () => {
    it('returns 200 with fresh tokens from provider', async () => {
      const event = makeEvent({
        path: '/auth/v1/token',
        query: { grant_type: 'refresh_token' },
        body: { refresh_token: 'ba-opaque-session-token' },
      });
      const res = await handler(event);

      assert.equal(res.statusCode, 200);
      const body = parseBody(res);
      assert.equal(
        body.access_token,
        'ba-refreshed-access-token',
        'should return fresh provider access token',
      );
      assert.equal(
        body.refresh_token,
        'ba-new-session-token',
        'should return fresh provider session token',
      );
    });

    it('returns 401 with invalid_grant for invalid refresh token', async () => {
      const goodRes = await handler(makeEvent({
        path: '/auth/v1/token',
        query: { grant_type: 'refresh_token' },
        body: { refresh_token: 'ba-opaque-session-token' },
      }));
      const goodBody = parseBody(goodRes);
      assert.equal(
        goodBody.access_token,
        'ba-refreshed-access-token',
        'success path must use provider-issued token (issuesOwnAccessToken)',
      );

      const event = makeEvent({
        path: '/auth/v1/token',
        query: { grant_type: 'refresh_token' },
        body: { refresh_token: 'invalid-session-token' },
      });
      const res = await handler(event);

      assert.equal(res.statusCode, 401);
      const body = parseBody(res);
      assert.equal(body.error, 'invalid_grant');
    });

    it('does not make auth.sessions queries and uses provider tokens directly', async () => {
      const queries = [];
      const trackingPool = {
        query: async (sql, params) => {
          queries.push({ sql, params });
          return { rows: [] };
        },
      };
      const ctx = {
        jwt: createJwt({ jwtSecret: TEST_SECRET }),
        authProvider: null,
        db: { getPool: async () => trackingPool },
      };
      const result = createAuthHandler(
        { auth: { provider: 'better-auth' }, jwtSecret: TEST_SECRET },
        ctx,
      );
      result._setProvider(createBetterAuthMockProvider());

      const event = makeEvent({
        path: '/auth/v1/token',
        query: { grant_type: 'refresh_token' },
        body: { refresh_token: 'ba-opaque-session-token' },
      });
      const res = await result.handler(event);

      assert.equal(res.statusCode, 200, 'should succeed');
      const body = parseBody(res);
      assert.equal(
        body.access_token,
        'ba-refreshed-access-token',
        'should use the provider-issued access token directly (issuesOwnAccessToken path)',
      );

      const sessionQueries = queries.filter(
        (q) => q.sql?.includes('auth.sessions'),
      );
      assert.equal(
        sessionQueries.length,
        0,
        'should not make any auth.sessions queries',
      );
    });
  });

  describe('POST /auth/v1/otp', () => {
    it('returns 200 with empty body when provider has sendOtp', async () => {
      const origSes = process.env.SES_FROM_ADDRESS;
      process.env.SES_FROM_ADDRESS = 'noreply@example.com';

      const otpProvider = createBetterAuthMockProvider({
        async sendOtp(email) {},
      });
      _setProvider(otpProvider);

      const event = makeEvent({
        path: '/auth/v1/otp',
        body: { email: 'user@example.com' },
      });
      const res = await handler(event);

      if (origSes !== undefined) process.env.SES_FROM_ADDRESS = origSes;
      else delete process.env.SES_FROM_ADDRESS;

      assert.equal(res.statusCode, 200);
      const body = parseBody(res);
      assert.deepEqual(body, {});
    });

    it('returns 400 with Email is required for missing email', async () => {
      const otpProvider = createBetterAuthMockProvider({
        async sendOtp(email) {},
      });
      _setProvider(otpProvider);

      const event = makeEvent({
        path: '/auth/v1/otp',
        body: {},
      });
      const res = await handler(event);

      assert.equal(res.statusCode, 400);
      const body = parseBody(res);
      assert.equal(body.error, 'validation_failed');
      assert.equal(body.error_description, 'Email is required');
    });

    it('returns 400 with Invalid email format for bad email', async () => {
      const otpProvider = createBetterAuthMockProvider({
        async sendOtp(email) {},
      });
      _setProvider(otpProvider);

      const event = makeEvent({
        path: '/auth/v1/otp',
        body: { email: 'not-valid' },
      });
      const res = await handler(event);

      assert.equal(res.statusCode, 400);
      const body = parseBody(res);
      assert.equal(body.error, 'validation_failed');
      assert.equal(body.error_description, 'Invalid email format');
    });

    it('returns 500 when sendOtp throws (SES failure)', async () => {
      const origSes = process.env.SES_FROM_ADDRESS;
      process.env.SES_FROM_ADDRESS = 'noreply@example.com';

      const otpProvider = createBetterAuthMockProvider({
        async sendOtp(email) {
          throw new Error('SES delivery failed');
        },
      });
      _setProvider(otpProvider);

      const event = makeEvent({
        path: '/auth/v1/otp',
        body: { email: 'user@example.com' },
      });
      const res = await handler(event);

      if (origSes !== undefined) process.env.SES_FROM_ADDRESS = origSes;
      else delete process.env.SES_FROM_ADDRESS;

      assert.equal(res.statusCode, 500);
      const body = parseBody(res);
      assert.equal(body.error, 'unexpected_failure');
      assert.equal(body.error_description, 'An unexpected error occurred');
    });

    it('returns 400 when SES_FROM_ADDRESS is not configured', async () => {
      const otpProvider = createCognitoLikeMockProvider({
        async sendOtp(email) {},
      });
      _setProvider(otpProvider);

      const origSes = process.env.SES_FROM_ADDRESS;
      delete process.env.SES_FROM_ADDRESS;

      const event = makeEvent({
        path: '/auth/v1/otp',
        body: { email: 'user@example.com' },
      });
      const res = await handler(event);

      if (origSes !== undefined) process.env.SES_FROM_ADDRESS = origSes;

      assert.equal(res.statusCode, 400);
      const body = parseBody(res);
      assert.equal(body.error, 'validation_failed');
      assert.equal(
        body.error_description,
        'SES sender address is not configured',
      );
    });

    it('returns 404 when provider has no sendOtp (Cognito)', async () => {
      const capableProvider = createBetterAuthMockProvider({
        async sendOtp(email) {},
      });
      _setProvider(capableProvider);
      const capableRes = await handler(makeEvent({
        path: '/auth/v1/otp',
        body: { email: 'user@example.com' },
      }));
      assert.notEqual(
        capableRes.statusCode,
        404,
        'otp route should be recognized when provider has sendOtp',
      );

      _setProvider(createCognitoLikeMockProvider());
      const event = makeEvent({
        path: '/auth/v1/otp',
        body: { email: 'user@example.com' },
      });
      const res = await handler(event);

      assert.equal(res.statusCode, 404);
    });
  });

  describe('POST /auth/v1/verify', () => {
    it('returns 200 with session envelope for valid email and token', async () => {
      const verifyProvider = createBetterAuthMockProvider({
        async verifyOtp(email, token) {
          return {
            user: MOCK_USER,
            accessToken: 'ba-verify-access-token',
            refreshToken: 'ba-verify-session-token',
            expiresIn: 3600,
          };
        },
      });
      _setProvider(verifyProvider);

      const event = makeEvent({
        path: '/auth/v1/verify',
        body: { email: 'test@example.com', token: 'valid-otp-token' },
      });
      const res = await handler(event);

      assert.equal(res.statusCode, 200);
      const body = parseBody(res);
      assert.ok(body.access_token, 'should have access_token');
      assert.ok(body.refresh_token, 'should have refresh_token');
      assert.ok(body.user, 'should have user');
      assert.equal(body.token_type, 'bearer');
    });

    it('returns 400 with Email is required for missing email', async () => {
      const verifyProvider = createBetterAuthMockProvider({
        async verifyOtp(email, token) {
          return { user: MOCK_USER, accessToken: 'a', refreshToken: 'b', expiresIn: 3600 };
        },
      });
      _setProvider(verifyProvider);

      const event = makeEvent({
        path: '/auth/v1/verify',
        body: { token: 'valid-token' },
      });
      const res = await handler(event);

      assert.equal(res.statusCode, 400);
      const body = parseBody(res);
      assert.equal(body.error_description, 'Email is required');
    });

    it('returns 400 with Token is required for missing token', async () => {
      const verifyProvider = createBetterAuthMockProvider({
        async verifyOtp(email, token) {
          return { user: MOCK_USER, accessToken: 'a', refreshToken: 'b', expiresIn: 3600 };
        },
      });
      _setProvider(verifyProvider);

      const event = makeEvent({
        path: '/auth/v1/verify',
        body: { email: 'test@example.com' },
      });
      const res = await handler(event);

      assert.equal(res.statusCode, 400);
      const body = parseBody(res);
      assert.equal(body.error_description, 'Token is required');
    });

    it('returns 400 with invalid_grant for invalid OTP token', async () => {
      const verifyProvider = createBetterAuthMockProvider({
        async verifyOtp(email, token) {
          const err = new Error('Invalid token');
          err.code = 'invalid_grant';
          throw err;
        },
      });
      _setProvider(verifyProvider);

      const event = makeEvent({
        path: '/auth/v1/verify',
        body: { email: 'test@example.com', token: 'expired-token' },
      });
      const res = await handler(event);

      assert.equal(res.statusCode, 400);
      const body = parseBody(res);
      assert.equal(body.error, 'invalid_grant');
      assert.equal(body.error_description, 'Invalid or expired OTP token');
    });

    it('returns 400 with Invalid email format for bad email', async () => {
      const verifyProvider = createBetterAuthMockProvider({
        async verifyOtp(email, token) {
          return { user: MOCK_USER, accessToken: 'a', refreshToken: 'b', expiresIn: 3600 };
        },
      });
      _setProvider(verifyProvider);

      const event = makeEvent({
        path: '/auth/v1/verify',
        body: { email: 'bad-email', token: 'valid-token' },
      });
      const res = await handler(event);

      assert.equal(res.statusCode, 400);
      const body = parseBody(res);
      assert.equal(body.error_description, 'Invalid email format');
    });

    it('test_verify_passes_email_and_token_to_provider', async () => {
      let capturedArgs = null;
      const verifyProvider = createBetterAuthMockProvider({
        async verifyOtp(email, token) {
          capturedArgs = { email, token };
          return {
            user: MOCK_USER,
            accessToken: 'mock-at',
            refreshToken: 'mock-rt',
            expiresIn: 3600,
          };
        },
      });
      _setProvider(verifyProvider);

      const event = makeEvent({
        path: '/auth/v1/verify',
        body: { email: 'user@test.com', token: 'abc123' },
      });
      const res = await handler(event);

      assert.equal(res.statusCode, 200);
      assert.strictEqual(capturedArgs.email, 'user@test.com');
      assert.strictEqual(capturedArgs.token, 'abc123');
    });

    it('returns 404 when provider has no verifyOtp (Cognito)', async () => {
      const capableProvider = createBetterAuthMockProvider({
        async verifyOtp(email, token) {
          return {
            user: MOCK_USER,
            accessToken: 'a',
            refreshToken: 'b',
            expiresIn: 3600,
          };
        },
      });
      _setProvider(capableProvider);
      const capableRes = await handler(makeEvent({
        path: '/auth/v1/verify',
        body: { email: 'test@example.com', token: 'abc' },
      }));
      assert.notEqual(
        capableRes.statusCode,
        404,
        'verify route should be recognized when provider has verifyOtp',
      );

      _setProvider(createCognitoLikeMockProvider());
      const event = makeEvent({
        path: '/auth/v1/verify',
        body: { email: 'test@example.com', token: 'abc' },
      });
      const res = await handler(event);

      assert.equal(res.statusCode, 404);
    });
  });

  describe('GET /auth/v1/authorize', () => {
    it('returns 302 redirect to OAuth consent URL', async () => {
      const oauthProvider = createBetterAuthMockProvider({
        async getOAuthRedirectUrl(provider, redirectTo) {
          return { url: 'https://accounts.google.com/o/oauth2/auth?state=xyz' };
        },
      });
      _setProvider(oauthProvider);

      const event = makeEvent({
        method: 'GET',
        path: '/auth/v1/authorize',
        query: { provider: 'google', redirect_to: 'https://app.com/callback' },
      });
      const res = await handler(event);

      assert.equal(res.statusCode, 302);
      assert.equal(
        res.headers.Location,
        'https://accounts.google.com/o/oauth2/auth?state=xyz',
      );
    });

    it('returns 400 with Provider is required for missing provider', async () => {
      const oauthProvider = createBetterAuthMockProvider({
        async getOAuthRedirectUrl(provider, redirectTo) {
          return { url: 'https://accounts.google.com/o/oauth2/auth' };
        },
      });
      _setProvider(oauthProvider);

      const event = makeEvent({
        method: 'GET',
        path: '/auth/v1/authorize',
        query: { redirect_to: 'https://app.com/callback' },
      });
      const res = await handler(event);

      assert.equal(res.statusCode, 400);
      const body = parseBody(res);
      assert.equal(body.error_description, 'Provider is required');
    });

    it('returns 400 for unsupported provider', async () => {
      const oauthProvider = createBetterAuthMockProvider({
        async getOAuthRedirectUrl(provider, redirectTo) {
          return { url: 'https://oauth.example.com' };
        },
      });
      _setProvider(oauthProvider);

      const event = makeEvent({
        method: 'GET',
        path: '/auth/v1/authorize',
        query: { provider: 'twitter', redirect_to: 'https://app.com' },
      });
      const res = await handler(event);

      assert.equal(res.statusCode, 400);
      const body = parseBody(res);
      assert.equal(body.error_description, 'Unsupported OAuth provider: twitter');
    });

    it('returns 400 with redirect_to is required when missing', async () => {
      const oauthProvider = createBetterAuthMockProvider({
        async getOAuthRedirectUrl(provider, redirectTo) {
          return { url: 'https://oauth.example.com' };
        },
      });
      _setProvider(oauthProvider);

      const event = makeEvent({
        method: 'GET',
        path: '/auth/v1/authorize',
        query: { provider: 'google' },
      });
      const res = await handler(event);

      assert.equal(res.statusCode, 400);
      const body = parseBody(res);
      assert.equal(body.error_description, 'redirect_to is required');
    });

    it('returns 400 when Google OAuth is not configured', async () => {
      const oauthProvider = createBetterAuthMockProvider({
        async getOAuthRedirectUrl(provider, redirectTo) {
          const err = new Error('Google OAuth is not configured');
          err.code = 'validation_failed';
          throw err;
        },
      });
      _setProvider(oauthProvider);

      const event = makeEvent({
        method: 'GET',
        path: '/auth/v1/authorize',
        query: { provider: 'google', redirect_to: 'https://app.com' },
      });
      const res = await handler(event);

      assert.equal(res.statusCode, 400);
      const body = parseBody(res);
      assert.equal(body.error, 'validation_failed');
      assert.equal(body.error_description, 'Google OAuth is not configured');
    });

    it('returns 404 when provider has no getOAuthRedirectUrl (Cognito)', async () => {
      const capableProvider = createBetterAuthMockProvider({
        async getOAuthRedirectUrl(provider, redirectTo) {
          return { url: 'https://oauth.example.com' };
        },
      });
      _setProvider(capableProvider);
      const capableRes = await handler(makeEvent({
        method: 'GET',
        path: '/auth/v1/authorize',
        query: { provider: 'google', redirect_to: 'https://app.com' },
      }));
      assert.notEqual(
        capableRes.statusCode,
        404,
        'authorize route should be recognized when provider has getOAuthRedirectUrl',
      );

      _setProvider(createCognitoLikeMockProvider());
      const event = makeEvent({
        method: 'GET',
        path: '/auth/v1/authorize',
        query: { provider: 'google', redirect_to: 'https://app.com' },
      });
      const res = await handler(event);

      assert.equal(res.statusCode, 404);
    });
  });

  describe('GET /auth/v1/callback', () => {
    it('returns 302 redirect with tokens in URL fragment', async () => {
      const callbackProvider = createBetterAuthMockProvider({
        async handleOAuthCallback(event) {
          return {
            user: MOCK_USER,
            accessToken: 'oauth-access-token',
            refreshToken: 'oauth-session-token',
            expiresIn: 3600,
            redirectTo: 'https://app.com/cb',
          };
        },
      });
      _setProvider(callbackProvider);

      const event = makeEvent({
        method: 'GET',
        path: '/auth/v1/callback',
        query: { code: 'oauth-code', state: 'encoded-state' },
      });
      const res = await handler(event);

      assert.equal(res.statusCode, 302);
      const location = res.headers.Location || res.headers.location;
      assert.ok(location, 'should have Location header');
      assert.ok(
        location.startsWith('https://app.com/cb#access_token='),
        `Location should start with redirectTo#access_token=, got: ${location}`,
      );
      assert.ok(location.includes('token_type=bearer'), 'fragment should contain token_type');
      assert.ok(location.includes('expires_in='), 'fragment should contain expires_in');
      assert.ok(location.includes('refresh_token='), 'fragment should contain refresh_token');
    });

    it('falls back to / when provider returns no redirectTo', async () => {
      const callbackProvider = createBetterAuthMockProvider({
        async handleOAuthCallback(event) {
          return {
            user: MOCK_USER,
            accessToken: 'oauth-access-token',
            refreshToken: 'oauth-session-token',
            expiresIn: 3600,
          };
        },
      });
      _setProvider(callbackProvider);

      const event = makeEvent({
        method: 'GET',
        path: '/auth/v1/callback',
        query: { code: 'oauth-code', state: 'encoded-state' },
      });
      const res = await handler(event);

      assert.equal(res.statusCode, 302);
      const location = res.headers.Location || res.headers.location;
      assert.ok(
        location.startsWith('/#access_token='),
        `Location should fall back to /#access_token=, got: ${location}`,
      );
    });

    it('returns 302 redirect with error in fragment on failure', async () => {
      const callbackProvider = createBetterAuthMockProvider({
        async handleOAuthCallback(event) {
          throw new Error('OAuth exchange failed');
        },
      });
      _setProvider(callbackProvider);

      const event = makeEvent({
        method: 'GET',
        path: '/auth/v1/callback',
        query: { code: 'bad-code', state: 'encoded-state' },
      });
      const res = await handler(event);

      assert.equal(res.statusCode, 302);
      const location = res.headers.Location || res.headers.location;
      assert.ok(location, 'should have Location header');
      assert.ok(location.includes('error='), 'fragment should contain error');
      assert.ok(
        location.includes('error_description='),
        'fragment should contain error_description',
      );
    });

    it('test_callback_success_redirect_contains_all_token_fields', async () => {
      const callbackProvider = createBetterAuthMockProvider({
        async handleOAuthCallback(event) {
          return {
            user: MOCK_USER,
            accessToken: 'cb-access-tok',
            refreshToken: 'cb-refresh-tok',
            expiresIn: 7200,
            redirectTo: 'https://app.com/done',
          };
        },
      });
      _setProvider(callbackProvider);

      const event = makeEvent({
        method: 'GET',
        path: '/auth/v1/callback',
        query: { code: 'oauth-code', state: 'encoded-state' },
      });
      const res = await handler(event);

      assert.equal(res.statusCode, 302);
      const location = res.headers.Location || res.headers.location;
      const [base, fragment] = location.split('#');
      assert.equal(base, 'https://app.com/done');
      assert.ok(fragment, 'should have a URL fragment');

      const pairs = fragment.split('&');
      const params = Object.fromEntries(pairs.map((p) => {
        const [k, ...rest] = p.split('=');
        return [k, rest.join('=')];
      }));

      assert.equal(
        params.access_token,
        encodeURIComponent('cb-access-tok'),
        'access_token should be URL-encoded provider token',
      );
      assert.equal(params.token_type, 'bearer');
      assert.equal(params.expires_in, '7200');
      assert.equal(
        params.refresh_token,
        encodeURIComponent('cb-refresh-tok'),
        'refresh_token should be URL-encoded provider token',
      );
      assert.ok(
        fragment.startsWith('access_token='),
        'fragment should start with access_token=',
      );
      assert.equal(
        Object.keys(params).length,
        4,
        'fragment should contain exactly 4 fields',
      );
    });

    it('returns 404 when provider has no handleOAuthCallback (Cognito)', async () => {
      const capableProvider = createBetterAuthMockProvider({
        async handleOAuthCallback(event) {
          return {
            user: MOCK_USER,
            accessToken: 'a',
            refreshToken: 'b',
            expiresIn: 3600,
            redirectTo: 'https://app.com/callback',
          };
        },
      });
      _setProvider(capableProvider);
      const capableRes = await handler(makeEvent({
        method: 'GET',
        path: '/auth/v1/callback',
        query: { code: 'code', state: 'state' },
      }));
      assert.notEqual(
        capableRes.statusCode,
        404,
        'callback route should be recognized when provider has handleOAuthCallback',
      );

      _setProvider(createCognitoLikeMockProvider());
      const event = makeEvent({
        method: 'GET',
        path: '/auth/v1/callback',
        query: { code: 'code', state: 'state' },
      });
      const res = await handler(event);

      assert.equal(res.statusCode, 404);
    });
  });

  describe('GET /auth/v1/jwks', () => {
    it('returns 200 with JWKS keys array', async () => {
      const pubJwk = await exportJWK(publicKey);
      const jwksProvider = createBetterAuthMockProvider({
        async getJwks() {
          return { keys: [{ ...pubJwk, kid: 'test-kid' }] };
        },
      });
      _setProvider(jwksProvider);

      const event = makeEvent({
        method: 'GET',
        path: '/auth/v1/jwks',
      });
      const res = await handler(event);

      assert.equal(res.statusCode, 200);
      const body = parseBody(res);
      assert.ok(body.keys, 'should have keys array');
      assert.ok(Array.isArray(body.keys), 'keys should be an array');
    });

    it('returns 404 when provider has no getJwks (Cognito)', async () => {
      const pubJwk = await exportJWK(publicKey);
      const jwksProvider = createBetterAuthMockProvider({
        async getJwks() {
          return { keys: [{ ...pubJwk, kid: 'test-kid' }] };
        },
      });
      _setProvider(jwksProvider);
      const capableRes = await handler(makeEvent({
        method: 'GET',
        path: '/auth/v1/jwks',
      }));
      assert.notEqual(
        capableRes.statusCode,
        404,
        'jwks route should be recognized when provider has getJwks',
      );

      _setProvider(createCognitoLikeMockProvider());
      const event = makeEvent({
        method: 'GET',
        path: '/auth/v1/jwks',
      });
      const res = await handler(event);

      assert.equal(res.statusCode, 404);
    });
  });

  describe('GET /auth/v1/user with asymmetric token', () => {
    it('returns 200 with user for valid asymmetric Bearer token', async () => {
      const token = await makeEdDSAToken();
      const event = makeEvent({
        method: 'GET',
        path: '/auth/v1/user',
        headers: { Authorization: `Bearer ${token}` },
      });
      const res = await handler(event);

      assert.equal(res.statusCode, 200);
      const body = parseBody(res);
      assert.ok(body.id, 'should have user id');
      assert.ok(body.email, 'should have user email');
    });

    it('returns 401 for expired asymmetric token', async () => {
      const validToken = await makeEdDSAToken();
      const validRes = await handler(makeEvent({
        method: 'GET',
        path: '/auth/v1/user',
        headers: { Authorization: `Bearer ${validToken}` },
      }));
      assert.equal(
        validRes.statusCode,
        200,
        'valid asymmetric token must be accepted first (requires dual-alg support)',
      );

      const expiredToken = await makeExpiredEdDSAToken();
      const event = makeEvent({
        method: 'GET',
        path: '/auth/v1/user',
        headers: { Authorization: `Bearer ${expiredToken}` },
      });
      const res = await handler(event);

      assert.equal(res.statusCode, 401);
    });
  });

  describe('POST /auth/v1/logout', () => {
    it('calls signOut with refresh token from body', async () => {
      const token = await makeEdDSAToken();
      const event = makeEvent({
        path: '/auth/v1/logout',
        headers: { Authorization: `Bearer ${token}` },
        body: { refresh_token: 'ba-session-token-to-revoke' },
      });
      const res = await handler(event);

      assert.equal(res.statusCode, 204);
      assert.equal(
        mockProvider.signOutCalledWith(),
        'ba-session-token-to-revoke',
        'signOut should be called with the refresh token from the body',
      );
    });

    it('does not make revokeUserSessions database call', async () => {
      let signOutCalled = false;
      const queries = [];
      const trackingPool = {
        query: async (sql, params) => {
          queries.push({ sql, params });
          return { rows: [] };
        },
      };
      const ctx = {
        jwt: createJwt({ jwtSecret: TEST_SECRET }),
        authProvider: null,
        db: { getPool: async () => trackingPool },
      };
      const result = createAuthHandler(
        { auth: { provider: 'better-auth' }, jwtSecret: TEST_SECRET },
        ctx,
      );
      result._setProvider(createBetterAuthMockProvider({
        async signOut(sessionToken) {
          signOutCalled = true;
        },
      }));

      const token = await makeEdDSAToken();
      const event = makeEvent({
        path: '/auth/v1/logout',
        headers: { Authorization: `Bearer ${token}` },
        body: { refresh_token: 'ba-session-token' },
      });
      await result.handler(event);

      assert.ok(
        signOutCalled,
        'provider.signOut must be called (requires asymmetric token verification)',
      );

      const revokeQueries = queries.filter(
        (q) => q.sql?.includes('revoked'),
      );
      assert.equal(
        revokeQueries.length,
        0,
        'should not make any revokeUserSessions queries',
      );
    });
  });

  describe('POST /auth/v1/logout — token verification', () => {
    it('test_logout_cognito_path_verifies_token_and_calls_signout', async () => {
      let signOutCalledWith = null;
      const cognitoProvider = createCognitoLikeMockProvider({
        async signOut(userId) {
          signOutCalledWith = userId;
        },
      });
      _setProvider(cognitoProvider);

      const hsToken = jwt.signAccessToken({ sub: 'cognito-user-id', email: 'test@example.com' });
      const event = makeEvent({
        path: '/auth/v1/logout',
        headers: { Authorization: `Bearer ${hsToken}` },
      });
      const res = await handler(event);

      assert.equal(res.statusCode, 204);
      assert.equal(
        signOutCalledWith,
        'cognito-user-id',
        'signOut should be called with the sub from the verified token',
      );
    });
  });

  describe('POST /auth/v1/otp — CORS origin', () => {
    it('test_otp_success_returns_correct_cors_origin', async () => {
      const origSes = process.env.SES_FROM_ADDRESS;
      process.env.SES_FROM_ADDRESS = 'noreply@example.com';

      const corsCtx = {
        jwt,
        cors: {
          allowedOrigins: ['https://app.com'],
          allowCredentials: true,
        },
        authProvider: null,
        db: { getPool: async () => ({ query: async () => ({ rows: [] }) }) },
      };
      const corsResult = createAuthHandler(
        { auth: { provider: 'better-auth' }, jwtSecret: TEST_SECRET },
        corsCtx,
      );
      const corsHandler = corsResult.handler;
      const otpProvider = createBetterAuthMockProvider({
        async sendOtp(email) {},
      });
      corsResult._setProvider(otpProvider);

      const event = makeEvent({
        path: '/auth/v1/otp',
        headers: { Origin: 'https://app.com' },
        body: { email: 'user@example.com' },
      });
      const res = await corsHandler(event);

      if (origSes !== undefined) {
        process.env.SES_FROM_ADDRESS = origSes;
      } else {
        delete process.env.SES_FROM_ADDRESS;
      }

      assert.equal(res.statusCode, 200);
      assert.equal(
        res.headers['Access-Control-Allow-Origin'],
        'https://app.com',
        'OTP success should reflect the request Origin, not a wildcard',
      );
    });
  });

  describe('CORS origin — authorize and callback', () => {
    let corsHandler;
    let corsSetProvider;

    beforeEach(() => {
      const corsCtx = {
        jwt,
        cors: {
          allowedOrigins: ['https://app.com'],
          allowCredentials: true,
        },
        authProvider: null,
        db: { getPool: async () => ({ query: async () => ({ rows: [] }) }) },
      };
      const corsResult = createAuthHandler(
        { auth: { provider: 'better-auth' }, jwtSecret: TEST_SECRET },
        corsCtx,
      );
      corsHandler = corsResult.handler;
      corsSetProvider = corsResult._setProvider;
    });

    it('test_authorize_redirect_includes_correct_cors', async () => {
      corsSetProvider(createBetterAuthMockProvider({
        async getOAuthRedirectUrl(provider, redirectTo) {
          return { url: 'https://accounts.google.com/o/oauth2/auth?state=xyz' };
        },
      }));

      const event = makeEvent({
        method: 'GET',
        path: '/auth/v1/authorize',
        headers: { Origin: 'https://app.com' },
        query: { provider: 'google', redirect_to: 'https://app.com/callback' },
      });
      const res = await corsHandler(event);

      assert.equal(res.statusCode, 302);
      assert.equal(
        res.headers['Access-Control-Allow-Origin'],
        'https://app.com',
        'authorize redirect should reflect the request Origin',
      );
    });

    it('test_callback_success_includes_correct_cors', async () => {
      corsSetProvider(createBetterAuthMockProvider({
        async handleOAuthCallback(event) {
          return {
            user: MOCK_USER,
            accessToken: 'oauth-access-token',
            refreshToken: 'oauth-session-token',
            expiresIn: 3600,
            redirectTo: 'https://app.com/callback',
          };
        },
      }));

      const event = makeEvent({
        method: 'GET',
        path: '/auth/v1/callback',
        headers: { Origin: 'https://app.com' },
        query: { code: 'oauth-code', state: 'encoded-state' },
      });
      const res = await corsHandler(event);

      assert.equal(res.statusCode, 302);
      assert.equal(
        res.headers['Access-Control-Allow-Origin'],
        'https://app.com',
        'callback success redirect should reflect the request Origin',
      );
    });

    it('test_callback_error_includes_correct_cors', async () => {
      corsSetProvider(createBetterAuthMockProvider({
        async handleOAuthCallback(event) {
          throw new Error('OAuth exchange failed');
        },
      }));

      const event = makeEvent({
        method: 'GET',
        path: '/auth/v1/callback',
        headers: { Origin: 'https://app.com' },
        query: { code: 'bad-code', state: 'encoded-state' },
      });
      const res = await corsHandler(event);

      assert.equal(res.statusCode, 302);
      assert.equal(
        res.headers['Access-Control-Allow-Origin'],
        'https://app.com',
        'callback error redirect should reflect the request Origin',
      );
    });
  });

  describe('malformed JSON body', () => {
    it('returns 400 for invalid JSON in request body', async () => {
      const event = {
        httpMethod: 'POST',
        path: '/auth/v1/signup',
        queryStringParameters: null,
        headers: { 'Content-Type': 'application/json' },
        body: 'not valid json',
      };
      const res = await handler(event);

      assert.equal(res.statusCode, 400);
      const body = parseBody(res);
      assert.equal(body.error, 'validation_failed');
      assert.equal(body.error_description, 'Invalid JSON in request body');
    });
  });

  describe('JWKS Cache-Control header', () => {
    it('returns Cache-Control header in JWKS response', async () => {
      const pubJwk = await exportJWK(publicKey);
      const jwksProvider = createBetterAuthMockProvider({
        async getJwks() {
          return { keys: [{ ...pubJwk, kid: 'test-kid' }] };
        },
      });
      _setProvider(jwksProvider);

      const event = makeEvent({
        method: 'GET',
        path: '/auth/v1/jwks',
      });
      const res = await handler(event);

      assert.equal(res.statusCode, 200);
      assert.equal(
        res.headers['Cache-Control'],
        'public, max-age=3600',
        'JWKS response should include Cache-Control header',
      );
    });
  });

  describe('OAuth callback error redirect fallback', () => {
    it('redirects to / when queryStringParameters has no redirect_to', async () => {
      const callbackProvider = createBetterAuthMockProvider({
        async handleOAuthCallback() {
          throw new Error('OAuth exchange failed');
        },
      });
      _setProvider(callbackProvider);

      const event = makeEvent({
        method: 'GET',
        path: '/auth/v1/callback',
        query: { code: 'bad-code', state: 'encoded-state' },
      });
      const res = await handler(event);

      assert.equal(res.statusCode, 302);
      const location = res.headers.Location || res.headers.location;
      assert.ok(
        location.startsWith('/#'),
        `error redirect should fall back to "/" but got: ${location}`,
      );
    });

    it('rejects external redirect_to on callback error', async () => {
      const origUrl = process.env.BETTER_AUTH_URL;
      process.env.BETTER_AUTH_URL = 'https://app.example.com';

      const callbackProvider = createBetterAuthMockProvider({
        async handleOAuthCallback() {
          throw new Error('OAuth exchange failed');
        },
      });
      _setProvider(callbackProvider);

      const event = makeEvent({
        method: 'GET',
        path: '/auth/v1/callback',
        query: { code: 'bad-code', state: 'encoded-state', redirect_to: 'https://evil.com/phish' },
      });
      const res = await handler(event);

      if (origUrl !== undefined) process.env.BETTER_AUTH_URL = origUrl;
      else delete process.env.BETTER_AUTH_URL;

      assert.equal(res.statusCode, 302);
      const location = res.headers.Location || res.headers.location;
      assert.ok(
        !location.includes('evil.com'),
        `redirect must not go to attacker-controlled URL, got: ${location}`,
      );
      assert.ok(
        location.startsWith('/#'),
        `should fall back to "/" for external redirect_to, got: ${location}`,
      );
    });

    it('allows same-origin redirect_to on callback error', async () => {
      const origUrl = process.env.BETTER_AUTH_URL;
      process.env.BETTER_AUTH_URL = 'https://app.example.com';

      const callbackProvider = createBetterAuthMockProvider({
        async handleOAuthCallback() {
          throw new Error('OAuth exchange failed');
        },
      });
      _setProvider(callbackProvider);

      const event = makeEvent({
        method: 'GET',
        path: '/auth/v1/callback',
        query: { code: 'bad-code', state: 'encoded-state', redirect_to: 'https://app.example.com/settings' },
      });
      const res = await handler(event);

      if (origUrl !== undefined) process.env.BETTER_AUTH_URL = origUrl;
      else delete process.env.BETTER_AUTH_URL;

      assert.equal(res.statusCode, 302);
      const location = res.headers.Location || res.headers.location;
      assert.ok(
        location.startsWith('https://app.example.com/settings#'),
        `should redirect to same-origin URL, got: ${location}`,
      );
    });

    it('test_callback_error_rejects_protocol_relative_redirect', async () => {
      const origUrl = process.env.BETTER_AUTH_URL;
      process.env.BETTER_AUTH_URL = 'https://app.example.com';

      const callbackProvider = createBetterAuthMockProvider({
        async handleOAuthCallback() {
          throw new Error('OAuth exchange failed');
        },
      });
      _setProvider(callbackProvider);

      const event = makeEvent({
        method: 'GET',
        path: '/auth/v1/callback',
        query: { code: 'bad-code', state: 'encoded-state', redirect_to: '//evil.com/phish' },
      });
      const res = await handler(event);

      if (origUrl !== undefined) process.env.BETTER_AUTH_URL = origUrl;
      else delete process.env.BETTER_AUTH_URL;

      assert.equal(res.statusCode, 302);
      const location = res.headers.Location || res.headers.location;
      assert.ok(
        !location.includes('evil.com'),
        `protocol-relative redirect must not go to attacker-controlled URL, got: ${location}`,
      );
      assert.ok(
        location.startsWith('/#'),
        `should fall back to "/" for protocol-relative redirect_to, got: ${location}`,
      );
    });

    it('allows relative redirect_to on callback error', async () => {
      const origUrl = process.env.BETTER_AUTH_URL;
      process.env.BETTER_AUTH_URL = 'https://app.example.com';

      const callbackProvider = createBetterAuthMockProvider({
        async handleOAuthCallback() {
          throw new Error('OAuth exchange failed');
        },
      });
      _setProvider(callbackProvider);

      const event = makeEvent({
        method: 'GET',
        path: '/auth/v1/callback',
        query: { code: 'bad-code', state: 'encoded-state', redirect_to: '/dashboard' },
      });
      const res = await handler(event);

      if (origUrl !== undefined) process.env.BETTER_AUTH_URL = origUrl;
      else delete process.env.BETTER_AUTH_URL;

      assert.equal(res.statusCode, 302);
      const location = res.headers.Location || res.headers.location;
      assert.ok(
        location.startsWith('/dashboard#'),
        `should redirect to relative path, got: ${location}`,
      );
    });
  });

  describe('Cognito path regression', () => {
    it('Cognito signup mints HS256 access token via jwt.signAccessToken', async () => {
      _setProvider(mockProvider);
      const baRes = await handler(makeEvent({
        body: { email: 'new@example.com', password: 'StrongPass1' },
      }));
      const baBody = parseBody(baRes);
      assert.equal(
        baBody.access_token,
        'ba-issued-access-token',
        'better-auth path must use provider-issued token (verifying dispatch exists)',
      );

      let signInCalled = false;
      _setProvider({
        ...createCognitoLikeMockProvider(),
        async signIn(email) {
          signInCalled = true;
          return createCognitoLikeMockProvider().signIn(email);
        },
      });

      const event = makeEvent({
        body: { email: 'new@example.com', password: 'StrongPass1' },
      });
      const res = await handler(event);

      assert.equal(res.statusCode, 200);
      const body = parseBody(res);
      const payload = decodePayload(body.access_token);
      assert.equal(payload.iss, 'pgrest-lambda');
      assert.equal(payload.role, 'authenticated');
      assert.notEqual(
        body.access_token,
        'cognito-access-token',
        'access_token should be a pgrest-lambda HS256 JWT, not the provider token',
      );
      assert.ok(
        signInCalled,
        'signIn should be called (non-issuesOwnAccessToken path uses signUp+signIn)',
      );
    });

    it('Cognito refresh passes token directly to provider', async () => {
      let refreshCalledWith = null;
      _setProvider(createCognitoLikeMockProvider({
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
              refreshToken: 'new-cognito-refresh',
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

      assert.equal(res.statusCode, 200);
      assert.equal(
        refreshCalledWith,
        'cognito-refresh-token',
        'provider.refreshToken should be called with the raw token',
      );
    });
  });

  describe('OTP provider error propagation', () => {
    it('test_otp_provider_error_not_swallowed_as_500', async () => {
      const origSes = process.env.SES_FROM_ADDRESS;
      process.env.SES_FROM_ADDRESS = 'noreply@example.com';

      const otpProvider = createBetterAuthMockProvider({
        async sendOtp(email) {
          const err = new Error('User not found');
          err.code = 'user_not_found';
          throw err;
        },
      });
      _setProvider(otpProvider);

      const event = makeEvent({
        path: '/auth/v1/otp',
        body: { email: 'missing@example.com' },
      });
      const res = await handler(event);

      if (origSes !== undefined) process.env.SES_FROM_ADDRESS = origSes;
      else delete process.env.SES_FROM_ADDRESS;

      assert.equal(res.statusCode, 404);
      const body = parseBody(res);
      assert.equal(body.error, 'user_not_found');
      assert.equal(body.error_description, 'User not found');
    });
  });

  describe('JWKS error detail leaking', () => {
    it('test_jwks_error_does_not_leak_details', async () => {
      const jwksProvider = createBetterAuthMockProvider({
        async getJwks() {
          throw new Error('Database connection failed: password=secret123');
        },
      });
      _setProvider(jwksProvider);

      const event = makeEvent({
        method: 'GET',
        path: '/auth/v1/jwks',
      });
      const res = await handler(event);

      assert.equal(res.statusCode, 500);
      const body = parseBody(res);
      assert.equal(body.error, 'unexpected_failure');
      assert.equal(body.error_description, 'An unexpected error occurred');
      assert.ok(
        !res.body.includes('secret123'),
        'response must not leak sensitive error details',
      );
      assert.ok(
        !res.body.includes('password'),
        'response must not leak password references',
      );
    });
  });

  describe('callback event passthrough', () => {
    it('test_callback_passes_full_event_to_provider', async () => {
      let capturedEvent = null;
      const callbackProvider = createBetterAuthMockProvider({
        async handleOAuthCallback(event) {
          capturedEvent = event;
          return {
            user: MOCK_USER,
            accessToken: 'oauth-access-token',
            refreshToken: 'oauth-session-token',
            expiresIn: 3600,
            redirectTo: 'https://app.com/callback',
          };
        },
      });
      const { calls } = withCallTracking(callbackProvider, 'handleOAuthCallback');
      _setProvider(callbackProvider);

      const event = makeEvent({
        method: 'GET',
        path: '/auth/v1/callback',
        query: { code: 'xyz', state: 'abc' },
      });
      const res = await handler(event);

      assert.equal(res.statusCode, 302);
      assert.equal(calls.length, 1, 'handleOAuthCallback should be called once');
      assert.ok(capturedEvent, 'provider should receive the event');
      assert.equal(
        capturedEvent.queryStringParameters.code,
        'xyz',
        'provider should receive code from queryStringParameters',
      );
      assert.equal(
        capturedEvent.queryStringParameters.state,
        'abc',
        'provider should receive state from queryStringParameters',
      );
    });
  });

  describe('verifyBearerToken JWKS caching', () => {
    it('caches local JWKS across multiple verifications', async () => {
      let getJwksCalls = 0;
      const cachedProvider = createBetterAuthMockProvider({
        async getJwks() {
          getJwksCalls++;
          return { keys: [await getPubJwk()] };
        },
      });
      _setProvider(cachedProvider);

      for (let i = 0; i < 10; i++) {
        const token = await makeEdDSAToken();
        const event = makeEvent({
          method: 'GET',
          path: '/auth/v1/user',
          headers: { Authorization: `Bearer ${token}` },
        });
        const res = await handler(event);
        assert.equal(res.statusCode, 200, `request ${i} should succeed`);
      }

      assert.ok(
        getJwksCalls <= 1,
        `getJwks should be called at most once, was called ${getJwksCalls} times`,
      );
    });

    it('refreshes cache on kid mismatch (key rotation)', async () => {
      const newKeyPair = generateKeyPairSync('ed25519');
      const newPubJwk = await exportJWK(newKeyPair.publicKey);
      newPubJwk.kid = 'rotated-kid-2';
      newPubJwk.alg = 'EdDSA';
      newPubJwk.use = 'sig';

      const origPubJwk = await getPubJwk();
      let getJwksCalls = 0;
      let returnRotatedKeys = false;

      const rotatingProvider = createBetterAuthMockProvider({
        async getJwks() {
          getJwksCalls++;
          if (returnRotatedKeys) {
            return { keys: [origPubJwk, newPubJwk] };
          }
          return { keys: [origPubJwk] };
        },
      });
      _setProvider(rotatingProvider);

      const oldToken = await makeEdDSAToken();
      const oldRes = await handler(makeEvent({
        method: 'GET',
        path: '/auth/v1/user',
        headers: { Authorization: `Bearer ${oldToken}` },
      }));
      assert.equal(oldRes.statusCode, 200, 'old key token should succeed');
      assert.equal(getJwksCalls, 1, 'initial call fetches JWKS');

      returnRotatedKeys = true;
      const now = Math.floor(Date.now() / 1000);
      const rotatedToken = await new SignJWT({
        sub: 'ba-user-id-001',
        email: 'test@example.com',
        role: 'authenticated',
        aud: 'authenticated',
      })
        .setProtectedHeader({ alg: 'EdDSA', kid: 'rotated-kid-2' })
        .setIssuer('pgrest-lambda')
        .setIssuedAt(now)
        .setExpirationTime(now + 3600)
        .sign(newKeyPair.privateKey);

      const rotatedRes = await handler(makeEvent({
        method: 'GET',
        path: '/auth/v1/user',
        headers: { Authorization: `Bearer ${rotatedToken}` },
      }));
      assert.equal(rotatedRes.statusCode, 200, 'rotated key token should succeed after cache refresh');
      assert.equal(
        getJwksCalls,
        2,
        'getJwks should be called again after kid mismatch',
      );
    });

    it('documents getJwks call frequency (two calls, one fetch)', async () => {
      let getJwksCalls = 0;
      const countingProvider = createBetterAuthMockProvider({
        async getJwks() {
          getJwksCalls++;
          return { keys: [await getPubJwk()] };
        },
      });
      _setProvider(countingProvider);

      for (let i = 0; i < 2; i++) {
        const token = await makeEdDSAToken();
        const event = makeEvent({
          method: 'GET',
          path: '/auth/v1/user',
          headers: { Authorization: `Bearer ${token}` },
        });
        const res = await handler(event);
        assert.equal(res.statusCode, 200, `request ${i} should succeed`);
      }

      assert.equal(
        getJwksCalls,
        1,
        'getJwks should be called exactly once for two verifications',
      );
    });
  });
});
