import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import jsonwebtoken from 'jsonwebtoken';
import pg from 'pg';
import { createAuthHandler } from '../handler.mjs';
import { createJwt } from '../jwt.mjs';
import { createBetterAuthProvider } from '../providers/better-auth.mjs';
import { createAuthorizer } from '../../../deploy/aws-sam/authorizer.mjs';
import { makeEvent, parseBody } from './helpers/events.mjs';

const DATABASE_URL = process.env.DATABASE_URL;
const BETTER_AUTH_SECRET =
  process.env.BETTER_AUTH_SECRET ||
  'integration-test-secret-that-is-at-least-32-chars-long';
const TEST_JWT_SECRET = 'integration-jwt-secret-key-for-testing-1234';

const TEST_EMAIL = `integ-${Date.now()}@test.example.com`;
const TEST_PASSWORD = 'StrongPass1';

function decodeJwtHeader(token) {
  const [headerB64] = token.split('.');
  return JSON.parse(Buffer.from(headerB64, 'base64url').toString());
}

function isBase64UrlJson(str) {
  try {
    JSON.parse(Buffer.from(str, 'base64url').toString());
    return true;
  } catch {
    return false;
  }
}

describe('better-auth integration (requires PostgreSQL)', {
  skip: !DATABASE_URL && 'DATABASE_URL not set — skipping integration tests',
}, () => {
  let handler;
  let pool;
  let jwksServer;
  let authorizerHandler;

  let signupTokens = null;
  let signinTokens = null;
  let refreshedTokens = null;

  before(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    await pool.query('CREATE SCHEMA IF NOT EXISTS better_auth');

    const provider = createBetterAuthProvider({
      databaseUrl: DATABASE_URL,
      betterAuthSecret: BETTER_AUTH_SECRET,
      betterAuthUrl: 'http://localhost:9999',
    });

    const jwt = createJwt({ jwtSecret: TEST_JWT_SECRET });
    const ctx = {
      jwt,
      authProvider: provider,
      db: { getPool: async () => pool },
    };
    const authResult = createAuthHandler(
      { auth: { provider: 'better-auth' }, jwtSecret: TEST_JWT_SECRET },
      ctx,
    );
    handler = authResult.handler;

    const jwks = await provider.getJwks();
    const jwksBody = JSON.stringify(jwks);
    jwksServer = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(jwksBody);
    });
    await new Promise((resolve) => {
      jwksServer.listen(0, '127.0.0.1', resolve);
    });
    const jwksUrl = `http://127.0.0.1:${jwksServer.address().port}/jwks`;

    authorizerHandler = createAuthorizer({
      jwtSecret: TEST_JWT_SECRET,
      jwksUrl,
    }).handler;
  });

  after(async () => {
    if (jwksServer) jwksServer.close();
    if (pool) {
      try {
        await pool.query(
          `DELETE FROM better_auth."user" WHERE email = $1`,
          [TEST_EMAIL],
        );
      } catch {
        // best-effort cleanup
      }
      await pool.end();
    }
  });

  it('full flow: signup returns GoTrue envelope', async () => {
    const res = await handler(
      makeEvent({
        body: { email: TEST_EMAIL, password: TEST_PASSWORD },
      }),
    );
    assert.equal(res.statusCode, 200, `signup failed: ${res.body}`);
    const body = parseBody(res);

    assert.ok(body.access_token, 'should have access_token');
    assert.ok(body.refresh_token, 'should have refresh_token');
    assert.ok(body.user, 'should have user');
    assert.equal(body.token_type, 'bearer');
    assert.equal(typeof body.expires_in, 'number');
    assert.equal(typeof body.expires_at, 'number');

    signupTokens = body;
  });

  it('access token is asymmetric (alg !== HS256)', async () => {
    assert.ok(signupTokens, 'signup must succeed first');
    const header = decodeJwtHeader(signupTokens.access_token);
    assert.notEqual(header.alg, 'HS256');
  });

  it('refresh token is opaque (not a JWT)', async () => {
    assert.ok(signupTokens, 'signup must succeed first');
    const parts = signupTokens.refresh_token.split('.');
    const looksLikeJwt =
      parts.length === 3 &&
      isBase64UrlJson(parts[0]) &&
      isBase64UrlJson(parts[1]);
    assert.ok(!looksLikeJwt, 'refresh_token should be opaque');
  });

  it('GoTrue envelope has required fields', async () => {
    assert.ok(signupTokens, 'signup must succeed first');
    const { user } = signupTokens;

    assert.equal(typeof user.id, 'string');
    assert.equal(typeof user.email, 'string');
    assert.equal(user.role, 'authenticated');
    assert.equal(user.aud, 'authenticated');
    assert.ok(user.app_metadata);
    assert.ok(user.app_metadata.provider);
    assert.ok(Array.isArray(user.app_metadata.providers));
    assert.ok('user_metadata' in user);
    assert.ok(user.created_at);
  });

  it('signin returns session', async () => {
    const res = await handler(
      makeEvent({
        path: '/auth/v1/token',
        query: { grant_type: 'password' },
        body: { email: TEST_EMAIL, password: TEST_PASSWORD },
      }),
    );
    assert.equal(res.statusCode, 200, `signin failed: ${res.body}`);
    signinTokens = parseBody(res);
    assert.ok(signinTokens.access_token);
    assert.ok(signinTokens.refresh_token);
  });

  it('refresh returns new tokens', async () => {
    assert.ok(signinTokens, 'signin must succeed first');
    const res = await handler(
      makeEvent({
        path: '/auth/v1/token',
        query: { grant_type: 'refresh_token' },
        body: { refresh_token: signinTokens.refresh_token },
      }),
    );
    assert.equal(res.statusCode, 200, `refresh failed: ${res.body}`);
    refreshedTokens = parseBody(res);
    assert.ok(refreshedTokens.access_token);
    assert.ok(refreshedTokens.refresh_token);
  });

  it('getUser returns user profile', async () => {
    const tokens = refreshedTokens || signinTokens || signupTokens;
    assert.ok(tokens, 'previous auth steps must succeed');

    const res = await handler(
      makeEvent({
        method: 'GET',
        path: '/auth/v1/user',
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      }),
    );
    assert.equal(res.statusCode, 200, `getUser failed: ${res.body}`);
    assert.equal(parseBody(res).email, TEST_EMAIL);
  });

  it('authorizer accepts issued access token', async () => {
    const tokens = refreshedTokens || signinTokens || signupTokens;
    assert.ok(tokens, 'previous auth steps must succeed');

    const anonApiKey = jsonwebtoken.sign(
      { role: 'anon', iss: 'pgrest-lambda' },
      TEST_JWT_SECRET,
      { algorithm: 'HS256', expiresIn: '1h' },
    );

    const result = await authorizerHandler({
      type: 'REQUEST',
      methodArn:
        'arn:aws:execute-api:us-east-1:123:api/prod/GET/items',
      headers: {
        apikey: anonApiKey,
        Authorization: `Bearer ${tokens.access_token}`,
      },
      requestContext: { stage: 'prod' },
    });

    assert.equal(
      result.policyDocument.Statement[0].Effect,
      'Allow',
    );
    assert.equal(result.context.role, 'authenticated');
    assert.ok(result.context.userId);
  });

  it('signout returns 204', async () => {
    const tokens = refreshedTokens || signinTokens || signupTokens;
    assert.ok(tokens, 'previous auth steps must succeed');

    const res = await handler(
      makeEvent({
        path: '/auth/v1/logout',
        headers: { Authorization: `Bearer ${tokens.access_token}` },
        body: { refresh_token: tokens.refresh_token },
      }),
    );
    assert.equal(res.statusCode, 204);
  });
});
