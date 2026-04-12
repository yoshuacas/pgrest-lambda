import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createAuthHandler } from '../handler.mjs';
import { createJwt } from '../jwt.mjs';
import { createAuthorizer } from '../../authorizer/index.mjs';

const TEST_SECRET = 'integration-test-secret-key-1234';

// Mock provider for integration tests
function createMockProvider() {
  const users = new Map();
  let nextRefreshToken = 'cognito-refresh-initial';

  return {
    async signUp(email) {
      const id = `user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const user = {
        id,
        email,
        app_metadata: { provider: 'email', providers: ['email'] },
        user_metadata: {},
        created_at: new Date().toISOString(),
      };
      users.set(email, user);
      return user;
    },
    async signIn(email) {
      const user = users.get(email) || {
        id: `user-signin-${Date.now()}`,
        email,
        app_metadata: { provider: 'email', providers: ['email'] },
        user_metadata: {},
        created_at: new Date().toISOString(),
      };
      if (!users.has(email)) users.set(email, user);
      nextRefreshToken = `cognito-refresh-${Date.now()}`;
      return {
        user,
        providerTokens: {
          accessToken: 'cognito-access-token',
          refreshToken: nextRefreshToken,
          idToken: 'cognito-id-token',
        },
      };
    },
    async refreshToken(prt) {
      const newRefresh = `cognito-refresh-new-${Date.now()}`;
      return {
        user: {
          id: 'refreshed-user-id',
          email: 'refresh@example.com',
          app_metadata: { provider: 'email', providers: ['email'] },
          user_metadata: {},
          created_at: new Date().toISOString(),
        },
        providerTokens: {
          accessToken: 'new-cognito-access',
          refreshToken: newRefresh,
          idToken: 'new-cognito-id',
        },
      };
    },
    async signOut() {},
  };
}

// Helper: sign a JWT using HMAC-SHA256 (pure Node.js)
function signJwt(payload, secret = TEST_SECRET) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const fullPayload = { iat: now, ...payload };
  const segments = [
    b64url(JSON.stringify(header)),
    b64url(JSON.stringify(fullPayload)),
  ];
  const sig = createHmac('sha256', secret)
    .update(segments.join('.'))
    .digest('base64url');
  return [...segments, sig].join('.');
}

function b64url(str) {
  return Buffer.from(str).toString('base64url');
}

// Helper: build a Lambda proxy event
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

// Helper: build a REQUEST-type authorizer event
function makeAuthEvent({ apikey, authorization } = {}) {
  const headers = {};
  if (apikey !== undefined) headers.apikey = apikey;
  if (authorization !== undefined)
    headers.Authorization = authorization;
  return {
    type: 'REQUEST',
    methodArn:
      'arn:aws:execute-api:us-east-1:123:api/prod/GET/items',
    headers,
    requestContext: { stage: 'prod' },
  };
}

function parseBody(response) {
  return JSON.parse(response.body);
}

// Pre-build anon and service_role keys
const ANON_KEY = signJwt({
  role: 'anon',
  iss: 'pgrest-lambda',
  exp: Math.floor(Date.now() / 1000) + 3600,
});
const SERVICE_ROLE_KEY = signJwt({
  role: 'service_role',
  iss: 'pgrest-lambda',
  exp: Math.floor(Date.now() / 1000) + 3600,
});

describe('integration tests', () => {
  let authHandler;
  let _setProvider;
  let authorizer;

  beforeEach(() => {
    const jwt = createJwt({ jwtSecret: TEST_SECRET });
    const ctx = { jwt, authProvider: null };
    const authResult = createAuthHandler(
      { auth: { provider: 'cognito' }, jwtSecret: TEST_SECRET },
      ctx,
    );
    authHandler = authResult.handler;
    _setProvider = authResult._setProvider;
    _setProvider(createMockProvider());

    authorizer = createAuthorizer({ jwtSecret: TEST_SECRET }).handler;
  });

  it('full signup flow: signup returns tokens, then GET /user returns same user', async () => {
    // Step 1: Sign up
    const signupRes = await authHandler(
      makeEvent({
        body: {
          email: 'integration@example.com',
          password: 'StrongPass1',
        },
      })
    );

    assert.equal(
      signupRes.statusCode,
      200,
      'signup should return 200'
    );
    const signupBody = parseBody(signupRes);
    assert.ok(
      signupBody.access_token,
      'signup should return access_token'
    );
    assert.ok(signupBody.user, 'signup should return user');

    // Step 2: Get user with the returned access_token
    const getUserRes = await authHandler(
      makeEvent({
        method: 'GET',
        path: '/auth/v1/user',
        headers: {
          Authorization: `Bearer ${signupBody.access_token}`,
        },
      })
    );

    assert.equal(
      getUserRes.statusCode,
      200,
      'GET /user should return 200'
    );
    const userBody = parseBody(getUserRes);
    assert.equal(
      userBody.email,
      signupBody.user.email,
      'GET /user email should match signup user email'
    );
    assert.equal(
      userBody.id,
      signupBody.user.id,
      'GET /user id should match signup user id'
    );
  });

  it('full signin flow: token grant returns tokens, then authorizer allows with role=authenticated', async () => {
    // Step 1: Sign in
    const signinRes = await authHandler(
      makeEvent({
        path: '/auth/v1/token',
        query: { grant_type: 'password' },
        body: {
          email: 'signin@example.com',
          password: 'StrongPass1',
        },
      })
    );

    assert.equal(
      signinRes.statusCode,
      200,
      'signin should return 200'
    );
    const signinBody = parseBody(signinRes);
    assert.ok(
      signinBody.access_token,
      'signin should return access_token'
    );

    // Step 2: Use access_token with authorizer
    const authResult = await authorizer(
      makeAuthEvent({
        apikey: ANON_KEY,
        authorization: `Bearer ${signinBody.access_token}`,
      })
    );

    assert.equal(
      authResult.policyDocument.Statement[0].Effect,
      'Allow',
      'authorizer should Allow'
    );
    assert.equal(
      authResult.context.role,
      'authenticated',
      'authorizer role should be authenticated'
    );
    assert.ok(
      authResult.context.userId,
      'authorizer should have userId'
    );
    assert.ok(
      authResult.context.email,
      'authorizer should have email'
    );
  });

  it('token refresh flow: sign in, then refresh returns new valid tokens', async () => {
    // Step 1: Sign in to get initial tokens
    const signinRes = await authHandler(
      makeEvent({
        path: '/auth/v1/token',
        query: { grant_type: 'password' },
        body: {
          email: 'refresh@example.com',
          password: 'StrongPass1',
        },
      })
    );

    assert.equal(signinRes.statusCode, 200);
    const signinBody = parseBody(signinRes);

    // Step 2: Refresh
    const refreshRes = await authHandler(
      makeEvent({
        path: '/auth/v1/token',
        query: { grant_type: 'refresh_token' },
        body: {
          refresh_token: signinBody.refresh_token,
        },
      })
    );

    assert.equal(
      refreshRes.statusCode,
      200,
      'refresh should return 200'
    );
    const refreshBody = parseBody(refreshRes);
    assert.ok(
      refreshBody.access_token,
      'refresh should return new access_token'
    );
    assert.ok(
      refreshBody.refresh_token,
      'refresh should return new refresh_token'
    );

    // Step 3: Verify new access token works
    const getUserRes = await authHandler(
      makeEvent({
        method: 'GET',
        path: '/auth/v1/user',
        headers: {
          Authorization: `Bearer ${refreshBody.access_token}`,
        },
      })
    );

    assert.equal(
      getUserRes.statusCode,
      200,
      'new access_token should work for GET /user'
    );
  });

  it('anon access flow: authorizer with only anon apikey returns role=anon', async () => {
    const result = await authorizer(
      makeAuthEvent({ apikey: ANON_KEY })
    );

    assert.equal(
      result.policyDocument.Statement[0].Effect,
      'Allow',
      'authorizer should Allow'
    );
    assert.equal(
      result.context.role,
      'anon',
      'role should be anon'
    );
    assert.equal(
      result.context.userId,
      '',
      'userId should be empty for anon'
    );
    assert.equal(
      result.context.email,
      '',
      'email should be empty for anon'
    );
  });

  it('authenticated access flow: authorizer with anon apikey + user Bearer returns role=authenticated', async () => {
    // Create a user access token
    const userToken = signJwt({
      sub: 'integration-user-id',
      email: 'integ@example.com',
      role: 'authenticated',
      aud: 'authenticated',
      iss: 'pgrest-lambda',
      exp: Math.floor(Date.now() / 1000) + 3600,
    });

    const result = await authorizer(
      makeAuthEvent({
        apikey: ANON_KEY,
        authorization: `Bearer ${userToken}`,
      })
    );

    assert.equal(
      result.policyDocument.Statement[0].Effect,
      'Allow',
      'authorizer should Allow'
    );
    assert.equal(
      result.context.role,
      'authenticated',
      'role should be authenticated'
    );
    assert.equal(
      result.context.userId,
      'integration-user-id',
      'userId should match token sub'
    );
    assert.equal(
      result.context.email,
      'integ@example.com',
      'email should match token email'
    );
  });

  it('service role access flow: authorizer with service_role apikey returns role=service_role', async () => {
    const result = await authorizer(
      makeAuthEvent({ apikey: SERVICE_ROLE_KEY })
    );

    assert.equal(
      result.policyDocument.Statement[0].Effect,
      'Allow',
      'authorizer should Allow'
    );
    assert.equal(
      result.context.role,
      'service_role',
      'role should be service_role'
    );
  });

  it('expired token flow: authorizer with valid apikey + expired token throws Unauthorized', async () => {
    const expiredToken = signJwt({
      sub: 'user-expired',
      email: 'expired@example.com',
      role: 'authenticated',
      iss: 'pgrest-lambda',
      exp: Math.floor(Date.now() / 1000) - 3600,
    });

    await assert.rejects(
      () => authorizer(
        makeAuthEvent({
          apikey: ANON_KEY,
          authorization: `Bearer ${expiredToken}`,
        })
      ),
      (err) => err === 'Unauthorized',
      'authorizer should throw Unauthorized for expired token'
    );
  });
});
