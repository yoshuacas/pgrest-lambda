import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import { handler } from '../index.mjs';

const SECRET = 'test-secret-key-for-unit-tests';
const METHOD_ARN =
  'arn:aws:execute-api:us-east-1:123456789:abc123/prod/GET/rest/v1/todos';

function makeEvent({ apikey, authorization } = {}) {
  const headers = {};
  if (apikey !== undefined) headers.apikey = apikey;
  if (authorization !== undefined) headers.Authorization = authorization;
  return { headers, methodArn: METHOD_ARN };
}

function signJwt(payload, secret = SECRET) {
  return jwt.sign(payload, secret, { issuer: 'boa' });
}

describe('authorizer', () => {
  let origSecret;

  beforeEach(() => {
    origSecret = process.env.JWT_SECRET;
    process.env.JWT_SECRET = SECRET;
  });

  afterEach(() => {
    if (origSecret !== undefined) {
      process.env.JWT_SECRET = origSecret;
    } else {
      delete process.env.JWT_SECRET;
    }
  });

  it('allows with role anon and empty userId for valid apikey, no bearer', async () => {
    const apikey = signJwt({ role: 'anon' });
    const result = await handler(makeEvent({ apikey }));
    assert.equal(
      result.policyDocument.Statement[0].Effect, 'Allow',
      'should return Allow policy',
    );
    assert.equal(result.context.role, 'anon');
    assert.equal(result.context.userId, '');
  });

  it('allows with role and userId from bearer when both apikey and bearer are valid', async () => {
    const apikey = signJwt({ role: 'anon' });
    const bearer = signJwt({
      role: 'authenticated',
      sub: 'user-123',
      email: 'user@example.com',
    });
    const result = await handler(
      makeEvent({ apikey, authorization: `Bearer ${bearer}` }),
    );
    assert.equal(
      result.policyDocument.Statement[0].Effect, 'Allow',
      'should return Allow policy',
    );
    assert.equal(result.context.role, 'authenticated');
    assert.equal(result.context.userId, 'user-123');
    assert.equal(result.context.email, 'user@example.com');
  });

  it('denies for invalid apikey JWT', async () => {
    const result = await handler(
      makeEvent({ apikey: 'not-a-valid-jwt' }),
    );
    assert.equal(
      result.policyDocument.Statement[0].Effect, 'Deny',
      'should return Deny policy for invalid apikey',
    );
  });

  it('denies for expired apikey JWT', async () => {
    const apikey = jwt.sign(
      { role: 'anon', exp: Math.floor(Date.now() / 1000) - 60 },
      SECRET,
      { issuer: 'boa' },
    );
    const result = await handler(makeEvent({ apikey }));
    assert.equal(
      result.policyDocument.Statement[0].Effect, 'Deny',
      'should return Deny policy for expired apikey',
    );
  });

  it('denies when JWT_SECRET env var is missing (fail-closed)', async () => {
    delete process.env.JWT_SECRET;
    const apikey = signJwt({ role: 'anon' });
    const result = await handler(makeEvent({ apikey }));
    assert.equal(
      result.policyDocument.Statement[0].Effect, 'Deny',
      'should return Deny when JWT_SECRET is missing',
    );
  });

  it('denies when apikey is missing', async () => {
    const result = await handler(makeEvent({}));
    assert.equal(
      result.policyDocument.Statement[0].Effect, 'Deny',
      'should return Deny when no apikey header',
    );
  });

  it('denies for apikey with invalid role', async () => {
    const apikey = signJwt({ role: 'admin' });
    const result = await handler(makeEvent({ apikey }));
    assert.equal(
      result.policyDocument.Statement[0].Effect, 'Deny',
      'should return Deny for invalid role',
    );
  });
});
