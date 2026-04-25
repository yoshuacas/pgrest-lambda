import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import { createAuthorizer } from '../authorizer.mjs';

const SECRET = 'test-secret-key-for-unit-tests-ok';
const METHOD_ARN =
  'arn:aws:execute-api:us-east-1:123456789:abc123/prod/GET/rest/v1/todos';

function makeEvent({ apikey, authorization } = {}) {
  const headers = {};
  if (apikey !== undefined) headers.apikey = apikey;
  if (authorization !== undefined) headers.Authorization = authorization;
  return { headers, methodArn: METHOD_ARN };
}

function signJwt(payload, secret = SECRET) {
  return jwt.sign(payload, secret, { issuer: 'pgrest-lambda' });
}

describe('authorizer', () => {
  let handler;

  beforeEach(() => {
    handler = createAuthorizer({ jwtSecret: SECRET }).handler;
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

  it('throws Unauthorized for invalid apikey JWT', async () => {
    await assert.rejects(
      () => handler(makeEvent({ apikey: 'not-a-valid-jwt' })),
      (err) => err === 'Unauthorized',
      'should throw Unauthorized for invalid apikey',
    );
  });

  it('throws Unauthorized for expired apikey JWT', async () => {
    const apikey = jwt.sign(
      { role: 'anon', exp: Math.floor(Date.now() / 1000) - 60 },
      SECRET,
      { issuer: 'pgrest-lambda' },
    );
    await assert.rejects(
      () => handler(makeEvent({ apikey })),
      (err) => err === 'Unauthorized',
      'should throw Unauthorized for expired apikey',
    );
  });

  it('throws at construction when jwtSecret is undefined', () => {
    assert.throws(
      () => createAuthorizer({ jwtSecret: undefined }),
      (err) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes('required'));
        return true;
      },
    );
  });

  it('throws at construction when jwtSecret is short', () => {
    assert.throws(
      () => createAuthorizer({ jwtSecret: 'short' }),
      (err) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes('too short'));
        return true;
      },
    );
  });

  it('throws Unauthorized when apikey is missing', async () => {
    await assert.rejects(
      () => handler(makeEvent({})),
      (err) => err === 'Unauthorized',
      'should throw Unauthorized when no apikey header',
    );
  });

  it('throws Unauthorized for apikey with invalid role', async () => {
    const apikey = signJwt({ role: 'admin' });
    await assert.rejects(
      () => handler(makeEvent({ apikey })),
      (err) => err === 'Unauthorized',
      'should throw Unauthorized for invalid role',
    );
  });

  describe('algorithm pinning', () => {
    function forgeToken(alg, payload, signature = 'fakesig') {
      const header = Buffer.from(
        JSON.stringify({ alg, typ: 'JWT' }),
      ).toString('base64url');
      const body = Buffer.from(
        JSON.stringify({
          role: 'anon',
          iss: 'pgrest-lambda',
          iat: Math.floor(Date.now() / 1000),
          exp: Math.floor(Date.now() / 1000) + 3600,
          ...payload,
        }),
      ).toString('base64url');
      return `${header}.${body}.${signature}`;
    }

    it('rejects apikey with alg: none', async () => {
      const apikey = forgeToken('none', { role: 'anon' }, '');
      await assert.rejects(
        () => handler(makeEvent({ apikey })),
        (err) => err === 'Unauthorized',
        'should reject alg:none apikey',
      );
    });

    it('rejects apikey with alg: RS256', async () => {
      const apikey = forgeToken('RS256', { role: 'anon' });
      await assert.rejects(
        () => handler(makeEvent({ apikey })),
        (err) => err === 'Unauthorized',
        'should reject RS256 apikey',
      );
    });

    it('rejects bearer with alg: none', async () => {
      const apikey = signJwt({ role: 'anon' });
      const bearer = forgeToken('none', {
        role: 'authenticated',
        sub: 'attacker',
      }, '');
      await assert.rejects(
        () => handler(makeEvent({
          apikey,
          authorization: `Bearer ${bearer}`,
        })),
        (err) => err === 'Unauthorized',
        'should reject alg:none bearer',
      );
    });

    it('rejects bearer with alg: RS256', async () => {
      const apikey = signJwt({ role: 'anon' });
      const bearer = forgeToken('RS256', {
        role: 'authenticated',
        sub: 'attacker',
      });
      await assert.rejects(
        () => handler(makeEvent({
          apikey,
          authorization: `Bearer ${bearer}`,
        })),
        (err) => err === 'Unauthorized',
        'should reject RS256 bearer',
      );
    });
  });
});
