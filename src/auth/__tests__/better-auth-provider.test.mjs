import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { withCallTracking } from './helpers/tracking.mjs';

const mockUsers = new Map();
const mockSessions = new Map();
let signUpEmailFn, signInEmailFn, getSessionFn, signOutFn;
let signInMagicLinkFn, magicLinkVerifyFn, verifyJWTFn, getJwksFn;
let mockHandler;

function resetState() {
  mockUsers.clear();
  mockSessions.clear();
  mockUsers.set('existing@example.com', {
    id: 'user-existing',
    email: 'existing@example.com',
    name: 'existing',
    createdAt: '2026-01-01T00:00:00.000Z',
  });
  mockUsers.set('user@example.com', {
    id: 'user-abc',
    email: 'user@example.com',
    name: 'user',
    password: 'StrongPass1',
    createdAt: '2026-01-01T00:00:00.000Z',
  });
  mockSessions.set('valid-session-token', {
    userId: 'user-abc',
    user: mockUsers.get('user@example.com'),
  });
}

function makeApiError(status, code, message) {
  const err = new Error(message);
  err.body = { code, message };
  err.statusCode = status;
  return err;
}

function mockSetCookieHeader(token) {
  const h = new Headers();
  h.set('set-cookie', `better-auth.session_token=${token}; Path=/; HttpOnly`);
  h.set('set-auth-jwt', 'mock-jwt-access-token');
  return h;
}

mock.module('better-auth', {
  namedExports: {
    betterAuth: () => {
      signUpEmailFn = mock.fn(async ({ body }) => {
        if (body.password.length < 8) {
          throw makeApiError(400, 'PASSWORD_TOO_SHORT', 'Password too short');
        }
        if (mockUsers.has(body.email)) {
          throw makeApiError(400, 'USER_ALREADY_EXISTS', 'User already exists');
        }
        const user = {
          id: 'user-' + body.email.split('@')[0],
          email: body.email,
          name: body.name,
          createdAt: new Date().toISOString(),
        };
        mockUsers.set(body.email, user);
        const sessionToken = 'session-' + user.id;
        mockSessions.set(sessionToken, { userId: user.id, user });
        return { token: sessionToken, user };
      });

      signInEmailFn = mock.fn(async ({ body }) => {
        const user = mockUsers.get(body.email);
        if (!user || user.password !== body.password) {
          throw makeApiError(
            401,
            'INVALID_EMAIL_OR_PASSWORD',
            'Invalid email or password',
          );
        }
        const sessionToken = 'session-' + user.id;
        mockSessions.set(sessionToken, { userId: user.id, user });
        return { token: sessionToken, user };
      });

      getSessionFn = mock.fn(async ({ headers, returnHeaders }) => {
        // Provider uses Bearer auth (raw token). Also accept the legacy
        // cookie form so older tests that pass cookies still work.
        const auth = headers.get('authorization') || '';
        const bearerMatch = auth.match(/^Bearer (.+)$/);
        const cookie = headers.get('cookie') || '';
        const cookieMatch = cookie.match(/better-auth\.session_token=([^;]+)/);
        const token = bearerMatch?.[1] || cookieMatch?.[1];
        const session = token ? mockSessions.get(token) : null;
        if (!session) {
          if (returnHeaders) return { response: null, headers: new Headers() };
          return null;
        }
        const response = {
          session: { id: 'sess-1', token, userId: session.userId },
          user: session.user,
        };
        if (returnHeaders) {
          return {
            response,
            headers: mockSetCookieHeader(token),
          };
        }
        return response;
      });

      signOutFn = mock.fn(async () => ({ success: true }));

      signInMagicLinkFn = mock.fn(async () => ({ status: true }));

      magicLinkVerifyFn = mock.fn(async ({ query }) => {
        if (query.token === 'invalid-token') {
          throw makeApiError(400, 'INVALID_TOKEN', 'Invalid token');
        }
        const user = mockUsers.get('user@example.com') || {
          id: 'user-magic',
          email: 'user@example.com',
          name: 'user',
          createdAt: new Date().toISOString(),
        };
        const sessionToken = 'session-magic';
        mockSessions.set(sessionToken, { userId: user.id, user });
        return { token: sessionToken, user, session: { id: 'sess-m', token: sessionToken } };
      });

      verifyJWTFn = mock.fn(async ({ body }) => {
        if (body.token !== 'valid-access-token' && body.token !== 'mock-jwt-access-token') {
          throw makeApiError(401, 'INVALID_TOKEN', 'Invalid token');
        }
        return {
          payload: {
            sub: 'user-abc',
            email: 'user@example.com',
            role: 'authenticated',
            aud: 'authenticated',
          },
        };
      });

      getJwksFn = mock.fn(async () => ({
        keys: [{ kty: 'OKP', crv: 'Ed25519', x: 'test-x', kid: 'test-kid' }],
      }));

      mockHandler = mock.fn(async (req) => {
        const url = new URL(req.url);
        if (url.pathname.includes('sign-in/social')) {
          return new Response(null, {
            status: 302,
            headers: { location: 'https://accounts.google.com/authorize?state=test' },
          });
        }
        if (url.pathname.includes('callback')) {
          const resp = new Response(null, { status: 200 });
          resp.headers.set(
            'set-cookie',
            'better-auth.session_token=session-oauth; Path=/; HttpOnly',
          );
          const user = {
            id: 'user-oauth',
            email: 'oauth@example.com',
            name: 'oauth',
            createdAt: new Date().toISOString(),
          };
          mockSessions.set('session-oauth', { userId: user.id, user });
          return resp;
        }
        return new Response(null, { status: 404 });
      });

      return {
        api: {
          signUpEmail: (...a) => signUpEmailFn(...a),
          signInEmail: (...a) => signInEmailFn(...a),
          getSession: (...a) => getSessionFn(...a),
          signOut: (...a) => signOutFn(...a),
          signInMagicLink: (...a) => signInMagicLinkFn(...a),
          magicLinkVerify: (...a) => magicLinkVerifyFn(...a),
          verifyJWT: (...a) => verifyJWTFn(...a),
          getJwks: (...a) => getJwksFn(...a),
        },
        handler: (...a) => mockHandler(...a),
      };
    },
  },
});

mock.module('better-auth/plugins', {
  namedExports: {
    jwt: (opts) => ({ id: 'jwt-plugin', ...opts }),
    magicLink: (opts) => ({ id: 'magic-link-plugin', ...opts }),
    bearer: () => ({ id: 'bearer-plugin' }),
  },
});

class MockPool {
  query() { return { rows: [] }; }
  end() { return Promise.resolve(); }
}

mock.module('pg', {
  defaultExport: { Pool: MockPool },
  namedExports: { Pool: MockPool },
});

mock.module('@aws-sdk/client-sesv2', {
  namedExports: {
    SESv2Client: class MockSESClient {
      send() { return Promise.resolve({}); }
    },
    SendEmailCommand: class MockSendEmailCommand {
      constructor(input) { this.input = input; }
    },
  },
});

describe('better-auth provider', () => {
  let createBetterAuthProvider;

  beforeEach(async () => {
    resetState();
    const mod = await import('../providers/better-auth.mjs');
    createBetterAuthProvider = mod.createBetterAuthProvider;
  });

  describe('signUp', () => {
    it('returns { user, accessToken, refreshToken, expiresIn } with correct shape', async () => {
      const provider = createBetterAuthProvider({
        betterAuthSecret: 'a'.repeat(32),
        betterAuthUrl: 'https://api.example.com/v1',
        databaseUrl: 'postgres://localhost/test',
      });
      const result = await provider.signUp('new@example.com', 'StrongPass1');

      assert.ok(result.user, 'should have user');
      assert.ok(result.user.id, 'user should have id');
      assert.ok(result.user.email, 'user should have email');
      assert.ok(result.accessToken, 'should have accessToken');
      assert.ok(result.refreshToken, 'should have refreshToken');
      assert.equal(typeof result.expiresIn, 'number', 'expiresIn should be a number');
    });

    it('throws { code: "user_already_exists" } on duplicate email', async () => {
      const provider = createBetterAuthProvider({
        betterAuthSecret: 'a'.repeat(32),
        betterAuthUrl: 'https://api.example.com/v1',
        databaseUrl: 'postgres://localhost/test',
      });

      await assert.rejects(
        () => provider.signUp('existing@example.com', 'StrongPass1'),
        (err) => {
          assert.equal(err.code, 'user_already_exists');
          return true;
        },
      );
    });

    it('throws { code: "weak_password" } on short password', async () => {
      const provider = createBetterAuthProvider({
        betterAuthSecret: 'a'.repeat(32),
        betterAuthUrl: 'https://api.example.com/v1',
        databaseUrl: 'postgres://localhost/test',
      });

      await assert.rejects(
        () => provider.signUp('new@example.com', 'weak'),
        (err) => {
          assert.equal(err.code, 'weak_password');
          return true;
        },
      );
    });
  });

  describe('signIn', () => {
    it('returns { user, accessToken, refreshToken, expiresIn } on valid credentials', async () => {
      const provider = createBetterAuthProvider({
        betterAuthSecret: 'a'.repeat(32),
        betterAuthUrl: 'https://api.example.com/v1',
        databaseUrl: 'postgres://localhost/test',
      });
      const result = await provider.signIn('user@example.com', 'StrongPass1');

      assert.ok(result.user, 'should have user');
      assert.ok(result.accessToken, 'should have accessToken');
      assert.ok(result.refreshToken, 'should have refreshToken');
      assert.equal(typeof result.expiresIn, 'number', 'expiresIn should be a number');
    });

    it('throws { code: "invalid_grant" } on bad credentials', async () => {
      const provider = createBetterAuthProvider({
        betterAuthSecret: 'a'.repeat(32),
        betterAuthUrl: 'https://api.example.com/v1',
        databaseUrl: 'postgres://localhost/test',
      });

      await assert.rejects(
        () => provider.signIn('user@example.com', 'WrongPassword'),
        (err) => {
          assert.equal(err.code, 'invalid_grant');
          return true;
        },
      );
    });
  });

  describe('refreshToken', () => {
    it('returns fresh tokens on valid session', async () => {
      const provider = createBetterAuthProvider({
        betterAuthSecret: 'a'.repeat(32),
        betterAuthUrl: 'https://api.example.com/v1',
        databaseUrl: 'postgres://localhost/test',
      });
      const result = await provider.refreshToken('valid-session-token');

      assert.ok(result.user, 'should have user');
      assert.ok(result.accessToken, 'should have accessToken');
      assert.ok(result.refreshToken, 'should have refreshToken');
      assert.equal(typeof result.expiresIn, 'number');
    });

    it('throws { code: "invalid_grant" } on expired session', async () => {
      const provider = createBetterAuthProvider({
        betterAuthSecret: 'a'.repeat(32),
        betterAuthUrl: 'https://api.example.com/v1',
        databaseUrl: 'postgres://localhost/test',
      });

      await assert.rejects(
        () => provider.refreshToken('expired-session-token'),
        (err) => {
          assert.equal(err.code, 'invalid_grant');
          return true;
        },
      );
    });
  });

  describe('getUser', () => {
    it('returns user object from valid access token', async () => {
      const provider = createBetterAuthProvider({
        betterAuthSecret: 'a'.repeat(32),
        betterAuthUrl: 'https://api.example.com/v1',
        databaseUrl: 'postgres://localhost/test',
      });
      const user = await provider.getUser('valid-access-token');

      assert.ok(user.id, 'user should have id');
      assert.ok(user.email, 'user should have email');
    });
  });

  describe('signOut', () => {
    it('calls better-auth session revocation', async () => {
      const provider = createBetterAuthProvider({
        betterAuthSecret: 'a'.repeat(32),
        betterAuthUrl: 'https://api.example.com/v1',
        databaseUrl: 'postgres://localhost/test',
      });
      await assert.doesNotReject(
        () => provider.signOut('session-token-to-revoke'),
      );
    });
  });

  describe('sendOtp', () => {
    it('calls auth.api.signInMagicLink', async () => {
      const provider = createBetterAuthProvider({
        betterAuthSecret: 'a'.repeat(32),
        betterAuthUrl: 'https://api.example.com/v1',
        databaseUrl: 'postgres://localhost/test',
        sesFromAddress: 'noreply@example.com',
      });
      await assert.doesNotReject(
        () => provider.sendOtp('user@example.com'),
      );
    });

    it('test_sendOtp_throws_config_error_without_ses_from_address', async () => {
      const origSes = process.env.SES_FROM_ADDRESS;
      delete process.env.SES_FROM_ADDRESS;

      const provider = createBetterAuthProvider({
        betterAuthSecret: 'a'.repeat(32),
        betterAuthUrl: 'https://api.example.com/v1',
        databaseUrl: 'postgres://localhost/test',
      });

      await assert.rejects(
        () => provider.sendOtp('user@example.com'),
        (err) => {
          assert.equal(err.code, 'validation_failed');
          assert.match(err.message, /SES/i);
          return true;
        },
      );

      if (origSes !== undefined) process.env.SES_FROM_ADDRESS = origSes;
    });
  });

  describe('verifyOtp', () => {
    it('returns session on valid token', async () => {
      const provider = createBetterAuthProvider({
        betterAuthSecret: 'a'.repeat(32),
        betterAuthUrl: 'https://api.example.com/v1',
        databaseUrl: 'postgres://localhost/test',
      });
      const result = await provider.verifyOtp('user@example.com', 'valid-token');

      assert.ok(result.user, 'should have user');
      assert.ok(result.accessToken, 'should have accessToken');
      assert.ok(result.refreshToken, 'should have refreshToken');
    });

    it('throws { code: "invalid_grant" } on invalid token', async () => {
      const provider = createBetterAuthProvider({
        betterAuthSecret: 'a'.repeat(32),
        betterAuthUrl: 'https://api.example.com/v1',
        databaseUrl: 'postgres://localhost/test',
      });

      await assert.rejects(
        () => provider.verifyOtp('user@example.com', 'invalid-token'),
        (err) => {
          assert.equal(err.code, 'invalid_grant');
          return true;
        },
      );
    });
  });

  describe('getOAuthRedirectUrl', () => {
    it('returns authorization URL', async () => {
      const provider = createBetterAuthProvider({
        betterAuthSecret: 'a'.repeat(32),
        betterAuthUrl: 'https://api.example.com/v1',
        databaseUrl: 'postgres://localhost/test',
        googleClientId: 'test-client-id',
        googleClientSecret: 'test-client-secret',
      });
      const result = await provider.getOAuthRedirectUrl(
        'google',
        'https://app.com/callback',
      );

      assert.ok(result.url, 'should have url');
      assert.equal(typeof result.url, 'string');
    });

    it('encodes state as base64url JSON with provider, redirectTo, and originalState', async () => {
      const provider = createBetterAuthProvider({
        betterAuthSecret: 'a'.repeat(32),
        betterAuthUrl: 'https://api.example.com/v1',
        databaseUrl: 'postgres://localhost/test',
        googleClientId: 'test-client-id',
        googleClientSecret: 'test-client-secret',
      });
      const result = await provider.getOAuthRedirectUrl(
        'google',
        'https://app.com/cb',
      );

      const redirectUrl = new URL(result.url);
      const state = redirectUrl.searchParams.get('state');
      assert.ok(state, 'redirect URL should have state parameter');
      const decoded = JSON.parse(
        Buffer.from(state, 'base64url').toString(),
      );
      assert.equal(decoded.p, 'google');
      assert.equal(decoded.r, 'https://app.com/cb');
      assert.ok(typeof decoded.s === 'string', 'should have originalState');
    });
  });

  describe('handleOAuthCallback', () => {
    it('returns session on success', async () => {
      const state = Buffer.from(JSON.stringify({
        p: 'google', r: '/', s: 'valid-state',
      })).toString('base64url');
      const provider = createBetterAuthProvider({
        betterAuthSecret: 'a'.repeat(32),
        betterAuthUrl: 'https://api.example.com/v1',
        databaseUrl: 'postgres://localhost/test',
        googleClientId: 'test-client-id',
        googleClientSecret: 'test-client-secret',
      });
      const result = await provider.handleOAuthCallback({
        queryStringParameters: { code: 'valid-code', state },
      });

      assert.ok(result.user, 'should have user');
      assert.ok(result.accessToken, 'should have accessToken');
      assert.ok(result.refreshToken, 'should have refreshToken');
    });

    it('routes callback to correct provider from state', async () => {
      const state = Buffer.from(JSON.stringify({
        p: 'github', r: '/', s: 'abc123',
      })).toString('base64url');
      const provider = createBetterAuthProvider({
        betterAuthSecret: 'a'.repeat(32),
        betterAuthUrl: 'https://api.example.com/v1',
        databaseUrl: 'postgres://localhost/test',
        googleClientId: 'test-client-id',
        googleClientSecret: 'test-client-secret',
      });
      await provider.handleOAuthCallback({
        queryStringParameters: { code: 'valid-code', state },
      });
      const callbackUrl = mockHandler.mock.calls.at(-1).arguments[0].url;
      assert.ok(
        callbackUrl.includes('/callback/github?'),
        `callback URL should route to /callback/github, got: ${callbackUrl}`,
      );
      assert.ok(
        !callbackUrl.includes('/callback/google'),
        `callback URL should NOT contain /callback/google, got: ${callbackUrl}`,
      );
    });

    it('forwards originalState to better-auth', async () => {
      const state = Buffer.from(JSON.stringify({
        p: 'github', r: '/', s: 'original-state-value',
      })).toString('base64url');
      const provider = createBetterAuthProvider({
        betterAuthSecret: 'a'.repeat(32),
        betterAuthUrl: 'https://api.example.com/v1',
        databaseUrl: 'postgres://localhost/test',
        googleClientId: 'test-client-id',
        googleClientSecret: 'test-client-secret',
      });
      await provider.handleOAuthCallback({
        queryStringParameters: { code: 'valid-code', state },
      });
      const callbackUrl = new URL(mockHandler.mock.calls.at(-1).arguments[0].url);
      assert.equal(
        decodeURIComponent(callbackUrl.searchParams.get('state')),
        'original-state-value',
        'originalState should be forwarded to better-auth',
      );
    });

    it('falls back to old delimiter format for in-flight OAuth flows', async () => {
      const provider = createBetterAuthProvider({
        betterAuthSecret: 'a'.repeat(32),
        betterAuthUrl: 'https://api.example.com/v1',
        databaseUrl: 'postgres://localhost/test',
        googleClientId: 'test-client-id',
        googleClientSecret: 'test-client-secret',
      });
      await provider.handleOAuthCallback({
        queryStringParameters: { code: 'valid-code', state: 'github:old-state-value' },
      });
      const callbackUrl = mockHandler.mock.calls.at(-1).arguments[0].url;
      assert.ok(
        callbackUrl.includes('/callback/github?'),
        `old delimiter state should still route to correct provider, got: ${callbackUrl}`,
      );
    });

    it('falls back to google when state has no provider info', async () => {
      const provider = createBetterAuthProvider({
        betterAuthSecret: 'a'.repeat(32),
        betterAuthUrl: 'https://api.example.com/v1',
        databaseUrl: 'postgres://localhost/test',
        googleClientId: 'test-client-id',
        googleClientSecret: 'test-client-secret',
      });
      await provider.handleOAuthCallback({
        queryStringParameters: { code: 'valid-code', state: 'no-prefix-state' },
      });
      const callbackUrl = mockHandler.mock.calls.at(-1).arguments[0].url;
      assert.ok(
        callbackUrl.includes('/callback/google?'),
        `callback URL should fall back to /callback/google for unprefixed state, got: ${callbackUrl}`,
      );
    });

    it('returns redirectTo from state round-trip', async () => {
      const provider = createBetterAuthProvider({
        betterAuthSecret: 'a'.repeat(32),
        betterAuthUrl: 'https://api.example.com/v1',
        databaseUrl: 'postgres://localhost/test',
        googleClientId: 'test-client-id',
        googleClientSecret: 'test-client-secret',
      });
      const redirectResult = await provider.getOAuthRedirectUrl(
        'google',
        'https://app.com/dashboard',
      );
      const redirectUrl = new URL(redirectResult.url);
      const state = redirectUrl.searchParams.get('state');

      const result = await provider.handleOAuthCallback({
        queryStringParameters: { code: 'valid-code', state },
      });
      assert.equal(
        result.redirectTo,
        'https://app.com/dashboard',
        'redirectTo should survive the encode → decode round-trip',
      );
    });

    it('uses queryStringParameters not event.query', async () => {
      const state = Buffer.from(JSON.stringify({
        p: 'google', r: '/', s: 'valid-state',
      })).toString('base64url');
      const provider = createBetterAuthProvider({
        betterAuthSecret: 'a'.repeat(32),
        betterAuthUrl: 'https://api.example.com/v1',
        databaseUrl: 'postgres://localhost/test',
        googleClientId: 'test-client-id',
        googleClientSecret: 'test-client-secret',
      });

      const result = await provider.handleOAuthCallback({
        queryStringParameters: { code: 'valid-code', state },
      });
      assert.ok(result.user, 'should extract params from queryStringParameters');
      assert.ok(result.accessToken, 'should return accessToken');

      const badResult = await provider.handleOAuthCallback({
        query: { code: 'valid-code', state },
      });
      assert.ok(badResult.user, 'should still return user (callback is lenient)');
      const callbackUrl = mockHandler.mock.calls.at(-1).arguments[0].url;
      assert.ok(
        callbackUrl.includes('code=&') || callbackUrl.includes('code=undefined'),
        'event.query should NOT be read — code should be empty in the callback URL',
      );
    });
  });

  describe('getJwks', () => {
    it('returns JWKS object', async () => {
      const provider = createBetterAuthProvider({
        betterAuthSecret: 'a'.repeat(32),
        betterAuthUrl: 'https://api.example.com/v1',
        databaseUrl: 'postgres://localhost/test',
      });
      const jwks = await provider.getJwks();

      assert.ok(jwks.keys, 'should have keys');
      assert.ok(Array.isArray(jwks.keys), 'keys should be an array');
    });
  });

  describe('destroy (pool cleanup)', () => {
    it('exposes destroy() that calls pool.end()', async () => {
      const provider = createBetterAuthProvider({
        betterAuthSecret: 'a'.repeat(32),
        betterAuthUrl: 'https://api.example.com/v1',
        databaseUrl: 'postgres://localhost/test',
      });

      assert.equal(typeof provider.destroy, 'function', 'should expose destroy()');
      await assert.doesNotReject(
        () => provider.destroy(),
        'destroy() should resolve without error',
      );
    });
  });

  describe('provider flags', () => {
    it('issuesOwnAccessToken is true', async () => {
      const provider = createBetterAuthProvider({
        betterAuthSecret: 'a'.repeat(32),
        betterAuthUrl: 'https://api.example.com/v1',
        databaseUrl: 'postgres://localhost/test',
      });

      assert.equal(provider.issuesOwnAccessToken, true);
    });

    it('needsSessionTable is absent or false', async () => {
      const provider = createBetterAuthProvider({
        betterAuthSecret: 'a'.repeat(32),
        betterAuthUrl: 'https://api.example.com/v1',
        databaseUrl: 'postgres://localhost/test',
      });

      assert.ok(
        !provider.needsSessionTable,
        'needsSessionTable should be absent or false',
      );
    });
  });

  describe('signUp partial failure', () => {
    it('test_signup_partial_failure_when_session_unavailable', async () => {
      // Partial state: signUpEmail succeeds (user created in DB) but
      // getSession returns null, so the client never receives tokens.
      // The user exists in the database but the client does not
      // receive tokens — a partial state that requires manual recovery.
      const provider = createBetterAuthProvider({
        betterAuthSecret: 'a'.repeat(32),
        betterAuthUrl: 'https://api.example.com/v1',
        databaseUrl: 'postgres://localhost/test',
      });

      getSessionFn.mock.mockImplementation(async () => null);

      await assert.rejects(
        () => provider.signUp('partial@example.com', 'StrongPass1'),
        (err) => {
          assert.equal(err.code, 'invalid_grant');
          return true;
        },
      );
    });
  });

  describe('verifyOtp email mismatch', () => {
    it('test_verifyOtp_email_mismatch_behavior', async () => {
      // The provider's verifyOtp ignores the email parameter — it only
      // passes { query: { token } } to auth.api.magicLinkVerify. The
      // token itself is bound to a specific email inside better-auth,
      // so email mismatch is handled at the token level, not by the
      // provider code. This test documents that the email param is not
      // forwarded to the underlying API call.
      const provider = createBetterAuthProvider({
        betterAuthSecret: 'a'.repeat(32),
        betterAuthUrl: 'https://api.example.com/v1',
        databaseUrl: 'postgres://localhost/test',
      });

      let capturedArgs = null;
      magicLinkVerifyFn.mock.mockImplementation(async (opts) => {
        capturedArgs = opts;
        const user = {
          id: 'user-a',
          email: 'user-a@example.com',
          name: 'user-a',
          createdAt: new Date().toISOString(),
        };
        const sessionToken = 'session-mismatch';
        mockSessions.set(sessionToken, { userId: user.id, user });
        return { token: sessionToken, user, session: { id: 'sess-mm', token: sessionToken } };
      });

      const result = await provider.verifyOtp('user-b@example.com', 'valid-token');

      assert.ok(capturedArgs, 'magicLinkVerify should have been called');
      assert.equal(
        capturedArgs.query.token,
        'valid-token',
        'token should be forwarded',
      );
      assert.ok(
        !capturedArgs.query.email && !capturedArgs.body?.email,
        'email parameter is not forwarded to magicLinkVerify — ' +
        'security relies on the token being bound to the original email',
      );
      assert.ok(result.user, 'verification succeeds regardless of email mismatch');
    });
  });

  describe('concurrent signup race condition', () => {
    it('test_concurrent_signup_same_email', async () => {
      const provider = createBetterAuthProvider({
        betterAuthSecret: 'a'.repeat(32),
        betterAuthUrl: 'https://api.example.com/v1',
        databaseUrl: 'postgres://localhost/test',
      });

      let callCount = 0;
      signUpEmailFn.mock.mockImplementation(async ({ body }) => {
        callCount++;
        if (callCount > 1) {
          throw makeApiError(400, 'USER_ALREADY_EXISTS', 'User already exists');
        }
        const user = {
          id: 'user-race',
          email: body.email,
          name: body.name,
          createdAt: new Date().toISOString(),
        };
        const sessionToken = 'session-race';
        mockSessions.set(sessionToken, { userId: user.id, user });
        return { token: sessionToken, user };
      });

      const results = await Promise.allSettled([
        provider.signUp('race@example.com', 'StrongPass1'),
        provider.signUp('race@example.com', 'StrongPass1'),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      assert.equal(fulfilled.length, 1, 'exactly one signup should succeed');
      assert.equal(rejected.length, 1, 'exactly one signup should fail');
      assert.equal(
        rejected[0].reason.code,
        'user_already_exists',
        'the failing signup should report user_already_exists',
      );
    });
  });
});
