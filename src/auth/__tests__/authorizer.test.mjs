import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createAuthorizer } from '../../authorizer/index.mjs';

const TEST_SECRET = 'test-secret-for-authorizer-tests';
const TEST_METHOD_ARN =
  'arn:aws:execute-api:us-east-1:123456:abc123/prod/GET/items';

// Helper: sign a JWT using HMAC-SHA256 (pure Node.js, no deps)
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

// Helper: build a REQUEST-type authorizer event
function makeAuthEvent({ apikey, authorization } = {}) {
  const headers = {};
  if (apikey !== undefined) headers.apikey = apikey;
  if (authorization !== undefined)
    headers.Authorization = authorization;
  return {
    type: 'REQUEST',
    methodArn: TEST_METHOD_ARN,
    headers,
    requestContext: {
      stage: 'prod',
    },
  };
}

// Pre-built keys for tests
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
const USER_TOKEN = signJwt({
  sub: 'user-uuid-123',
  email: 'user@example.com',
  role: 'authenticated',
  aud: 'authenticated',
  iss: 'pgrest-lambda',
  exp: Math.floor(Date.now() / 1000) + 3600,
});
const EXPIRED_TOKEN = signJwt({
  sub: 'user-expired',
  email: 'expired@example.com',
  role: 'authenticated',
  iss: 'pgrest-lambda',
  exp: Math.floor(Date.now() / 1000) - 3600,
});

describe('authorizer', () => {
  let handler;

  beforeEach(() => {
    handler = createAuthorizer({ jwtSecret: TEST_SECRET }).handler;
  });

  it('allows anon apikey only (no Authorization) with role=anon', async () => {
    const event = makeAuthEvent({ apikey: ANON_KEY });
    const result = await handler(event);

    assert.equal(
      result.policyDocument.Statement[0].Effect,
      'Allow',
      'should Allow'
    );
    assert.equal(
      result.context.role,
      'anon',
      'role should be anon'
    );
    assert.equal(
      result.context.userId,
      '',
      'userId should be empty'
    );
    assert.equal(
      result.context.email,
      '',
      'email should be empty'
    );
  });

  it('allows anon apikey + anon key as Bearer (supabase-js default) with role=anon', async () => {
    const event = makeAuthEvent({
      apikey: ANON_KEY,
      authorization: `Bearer ${ANON_KEY}`,
    });
    const result = await handler(event);

    assert.equal(
      result.policyDocument.Statement[0].Effect,
      'Allow',
      'should Allow'
    );
    assert.equal(
      result.context.role,
      'anon',
      'role should be anon when bearer is also anon key'
    );
  });

  it('allows anon apikey + authenticated user Bearer with role=authenticated', async () => {
    const event = makeAuthEvent({
      apikey: ANON_KEY,
      authorization: `Bearer ${USER_TOKEN}`,
    });
    const result = await handler(event);

    assert.equal(
      result.policyDocument.Statement[0].Effect,
      'Allow',
      'should Allow'
    );
    // Verify bearer claims override apikey claims
    assert.equal(
      result.context.role,
      'authenticated',
      'role should be authenticated from bearer, not anon from apikey'
    );
    assert.equal(
      result.context.userId,
      'user-uuid-123',
      'userId should come from bearer token sub'
    );
    assert.equal(
      result.context.email,
      'user@example.com',
      'email should come from bearer token'
    );
  });

  it('allows service_role apikey only with role=service_role', async () => {
    const event = makeAuthEvent({ apikey: SERVICE_ROLE_KEY });
    const result = await handler(event);

    assert.equal(
      result.policyDocument.Statement[0].Effect,
      'Allow',
      'should Allow'
    );
    assert.equal(
      result.context.role,
      'service_role',
      'role should be service_role'
    );
  });

  it('allows service_role key in both apikey and Authorization with role=service_role', async () => {
    const event = makeAuthEvent({
      apikey: SERVICE_ROLE_KEY,
      authorization: `Bearer ${SERVICE_ROLE_KEY}`,
    });
    const result = await handler(event);

    assert.equal(
      result.policyDocument.Statement[0].Effect,
      'Allow',
      'should Allow'
    );
    assert.equal(
      result.context.role,
      'service_role',
      'role should be service_role'
    );
  });

  it('throws Unauthorized when apikey header is missing', async () => {
    const event = makeAuthEvent({});
    await assert.rejects(
      () => handler(event),
      (err) => err === 'Unauthorized',
      'should throw "Unauthorized" when apikey is missing'
    );
  });

  it('throws Unauthorized when apikey is an invalid JWT', async () => {
    const event = makeAuthEvent({ apikey: 'not-a-valid-jwt' });
    await assert.rejects(
      () => handler(event),
      (err) => err === 'Unauthorized',
      'should throw "Unauthorized" for invalid apikey JWT'
    );
  });

  it('throws Unauthorized when apikey is signed with wrong secret', async () => {
    const wrongSecretKey = signJwt({
      role: 'anon',
      iss: 'pgrest-lambda',
      exp: Math.floor(Date.now() / 1000) + 3600,
    }, 'completely-different-secret');
    const event = makeAuthEvent({ apikey: wrongSecretKey });
    await assert.rejects(
      () => handler(event),
      (err) => err === 'Unauthorized',
      'should throw "Unauthorized" for apikey signed with wrong secret'
    );
  });

  it('throws Unauthorized when apikey is valid but Bearer is expired', async () => {
    const event = makeAuthEvent({
      apikey: ANON_KEY,
      authorization: `Bearer ${EXPIRED_TOKEN}`,
    });
    await assert.rejects(
      () => handler(event),
      (err) => err === 'Unauthorized',
      'should throw "Unauthorized" for expired Bearer token'
    );
  });

  it('throws Unauthorized when apikey is valid but Bearer is malformed', async () => {
    const event = makeAuthEvent({
      apikey: ANON_KEY,
      authorization: 'Bearer garbage-not-jwt',
    });
    await assert.rejects(
      () => handler(event),
      (err) => err === 'Unauthorized',
      'should throw "Unauthorized" for malformed Bearer token'
    );
  });

  it('throws Unauthorized when apikey has role=authenticated (forged key)', async () => {
    const forgedKey = signJwt({
      role: 'authenticated',
      iss: 'pgrest-lambda',
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const event = makeAuthEvent({ apikey: forgedKey });
    await assert.rejects(
      () => handler(event),
      (err) => err === 'Unauthorized',
      'should throw "Unauthorized" for apikey with role=authenticated'
    );
  });

  it('returns wildcarded policy ARN for caching', async () => {
    const event = makeAuthEvent({ apikey: ANON_KEY });
    const result = await handler(event);

    assert.equal(
      result.policyDocument.Statement[0].Effect,
      'Allow',
      'should Allow'
    );
    const resource =
      result.policyDocument.Statement[0].Resource;
    // ARN should end with /* for wildcard caching
    assert.ok(
      resource.endsWith('/*'),
      `policy ARN should be wildcarded (got ${resource})`
    );
    // Should contain the stage but not the specific path
    assert.ok(
      resource.includes('/prod/'),
      'ARN should include stage'
    );
  });

  it('context includes role, userId, email keys', async () => {
    const event = makeAuthEvent({
      apikey: ANON_KEY,
      authorization: `Bearer ${USER_TOKEN}`,
    });
    const result = await handler(event);

    assert.ok(
      'role' in result.context,
      'context should include role'
    );
    assert.ok(
      'userId' in result.context,
      'context should include userId'
    );
    assert.ok(
      'email' in result.context,
      'context should include email'
    );
  });
});
