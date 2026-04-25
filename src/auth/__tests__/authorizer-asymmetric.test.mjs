import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { SignJWT, exportJWK } from 'jose';
import { createAuthorizer } from '../../authorizer/index.mjs';
import {
  privateKey, publicKey,
  makeEdDSAToken as signEdDSA, getPubJwk,
} from './helpers/eddsa.mjs';
import { startJwksServer as _startJwksServer } from './helpers/jwks-server.mjs';

const TEST_SECRET = 'test-secret-for-authorizer-tests';
const TEST_METHOD_ARN =
  'arn:aws:execute-api:us-east-1:123456:abc123/prod/GET/items';

function b64url(str) {
  return Buffer.from(str).toString('base64url');
}

function signHS256(payload, secret = TEST_SECRET) {
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

const ANON_KEY = signHS256({
  role: 'anon',
  iss: 'pgrest-lambda',
  exp: Math.floor(Date.now() / 1000) + 3600,
});

function makeAuthEvent({ apikey, authorization } = {}) {
  const headers = {};
  if (apikey !== undefined) headers.apikey = apikey;
  if (authorization !== undefined)
    headers.Authorization = authorization;
  return {
    type: 'REQUEST',
    methodArn: TEST_METHOD_ARN,
    headers,
    requestContext: { stage: 'prod' },
  };
}

let jwksServer;
let jwksUrl;

async function startJwksServer() {
  const pubJwk = await getPubJwk();
  return _startJwksServer(pubJwk);
}

describe('authorizer dual-algorithm verification', () => {
  beforeEach(async () => {
    if (jwksServer) jwksServer.close();
    const result = await startJwksServer();
    jwksServer = result.server;
    jwksUrl = result.url;
  });

  afterEach(() => {
    if (jwksServer) {
      jwksServer.close();
      jwksServer = null;
    }
  });

  it('HS256 Bearer token is accepted alongside EdDSA support', async () => {
    const eddsaToken = await signEdDSA();
    const handler = createAuthorizer({
      jwtSecret: TEST_SECRET,
      jwksUrl,
    }).handler;
    const eddsaResult = await handler(makeAuthEvent({
      apikey: ANON_KEY,
      authorization: `Bearer ${eddsaToken}`,
    }));
    assert.equal(
      eddsaResult.policyDocument.Statement[0].Effect,
      'Allow',
      'EdDSA token must be accepted first (verifying dual-alg support exists)',
    );

    const userToken = signHS256({
      sub: 'user-uuid-123',
      email: 'user@example.com',
      role: 'authenticated',
      aud: 'authenticated',
      iss: 'pgrest-lambda',
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const result = await handler(makeAuthEvent({
      apikey: ANON_KEY,
      authorization: `Bearer ${userToken}`,
    }));

    assert.equal(result.policyDocument.Statement[0].Effect, 'Allow');
    assert.equal(result.context.role, 'authenticated');
    assert.equal(result.context.userId, 'user-uuid-123');
  });

  it('EdDSA Bearer token is accepted when JWKS_URL is set', async () => {
    const eddsaToken = await signEdDSA();
    const handler = createAuthorizer({
      jwtSecret: TEST_SECRET,
      jwksUrl,
    }).handler;

    const event = makeAuthEvent({
      apikey: ANON_KEY,
      authorization: `Bearer ${eddsaToken}`,
    });
    const result = await handler(event);

    assert.equal(result.policyDocument.Statement[0].Effect, 'Allow');
    assert.equal(result.context.role, 'authenticated');
    assert.equal(result.context.userId, 'user-id-001');
    assert.equal(result.context.email, 'test@example.com');
  });

  it('EdDSA Bearer token is rejected when JWKS_URL is unset', async () => {
    const eddsaToken = await signEdDSA();
    const handlerWithJwks = createAuthorizer({
      jwtSecret: TEST_SECRET,
      jwksUrl,
    }).handler;
    const acceptResult = await handlerWithJwks(makeAuthEvent({
      apikey: ANON_KEY,
      authorization: `Bearer ${eddsaToken}`,
    }));
    assert.equal(
      acceptResult.policyDocument.Statement[0].Effect,
      'Allow',
      'EdDSA token must be accepted with JWKS_URL (verifying dual-alg exists)',
    );

    const handlerNoJwks = createAuthorizer({
      jwtSecret: TEST_SECRET,
    }).handler;

    const event = makeAuthEvent({
      apikey: ANON_KEY,
      authorization: `Bearer ${eddsaToken}`,
    });

    await assert.rejects(
      () => handlerNoJwks(event),
      (err) => err === 'Unauthorized',
      'should throw Unauthorized for EdDSA token without JWKS_URL',
    );
  });

  it('Apikey always uses HS256 regardless of AUTH_PROVIDER', async () => {
    const handler = createAuthorizer({
      jwtSecret: TEST_SECRET,
      jwksUrl,
    }).handler;

    const eddsaToken = await signEdDSA();
    const eddsaResult = await handler(makeAuthEvent({
      apikey: ANON_KEY,
      authorization: `Bearer ${eddsaToken}`,
    }));
    assert.equal(
      eddsaResult.context.role,
      'authenticated',
      'EdDSA Bearer must be accepted (verifying dual-alg support exists)',
    );

    const result = await handler(makeAuthEvent({ apikey: ANON_KEY }));

    assert.equal(result.policyDocument.Statement[0].Effect, 'Allow');
    assert.equal(result.context.role, 'anon');
  });

  it('expired asymmetric token is rejected', async () => {
    const handler = createAuthorizer({
      jwtSecret: TEST_SECRET,
      jwksUrl,
    }).handler;

    const validToken = await signEdDSA();
    const validResult = await handler(makeAuthEvent({
      apikey: ANON_KEY,
      authorization: `Bearer ${validToken}`,
    }));
    assert.equal(
      validResult.context.role,
      'authenticated',
      'valid EdDSA token must be accepted first',
    );

    const now = Math.floor(Date.now() / 1000);
    const expiredToken = await new SignJWT({
      sub: 'user-id-001',
      email: 'test@example.com',
      role: 'authenticated',
    })
      .setProtectedHeader({ alg: 'EdDSA', kid: 'test-kid-1' })
      .setIssuer('pgrest-lambda')
      .setIssuedAt(now - 7200)
      .setExpirationTime(now - 3600)
      .sign(privateKey);

    const event = makeAuthEvent({
      apikey: ANON_KEY,
      authorization: `Bearer ${expiredToken}`,
    });

    await assert.rejects(
      () => handler(event),
      (err) => err === 'Unauthorized',
      'should throw Unauthorized for expired asymmetric token',
    );
  });

  it('wrong issuer on asymmetric token is rejected', async () => {
    const handler = createAuthorizer({
      jwtSecret: TEST_SECRET,
      jwksUrl,
    }).handler;

    const validToken = await signEdDSA();
    const validResult = await handler(makeAuthEvent({
      apikey: ANON_KEY,
      authorization: `Bearer ${validToken}`,
    }));
    assert.equal(
      validResult.context.role,
      'authenticated',
      'valid EdDSA token must be accepted first',
    );

    const now = Math.floor(Date.now() / 1000);
    const wrongIssuerToken = await new SignJWT({
      sub: 'user-id-001',
      email: 'test@example.com',
      role: 'authenticated',
    })
      .setProtectedHeader({ alg: 'EdDSA', kid: 'test-kid-1' })
      .setIssuer('wrong-issuer')
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(privateKey);

    const event = makeAuthEvent({
      apikey: ANON_KEY,
      authorization: `Bearer ${wrongIssuerToken}`,
    });

    await assert.rejects(
      () => handler(event),
      (err) => err === 'Unauthorized',
      'should throw Unauthorized for wrong issuer',
    );
  });

  it('alg:none token is rejected', async () => {
    const handler = createAuthorizer({
      jwtSecret: TEST_SECRET,
      jwksUrl,
    }).handler;

    const header = b64url(JSON.stringify({ alg: 'none', typ: 'JWT' }));
    const payload = b64url(JSON.stringify({
      sub: 'attacker',
      email: 'evil@example.com',
      role: 'authenticated',
      iss: 'pgrest-lambda',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    }));
    const noneToken = `${header}.${payload}.`;

    const event = makeAuthEvent({
      apikey: ANON_KEY,
      authorization: `Bearer ${noneToken}`,
    });

    await assert.rejects(
      () => handler(event),
      (err) => err === 'Unauthorized',
      'should reject alg:none token',
    );
  });

  it('algorithm confusion attack (public key as HMAC secret) is rejected', async () => {
    const handler = createAuthorizer({
      jwtSecret: TEST_SECRET,
      jwksUrl,
    }).handler;

    const pubJwk = await exportJWK(publicKey);
    const pubKeyBytes = Buffer.from(pubJwk.x, 'base64url');

    const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const payload = b64url(JSON.stringify({
      sub: 'attacker',
      email: 'evil@example.com',
      role: 'authenticated',
      iss: 'pgrest-lambda',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    }));
    const segments = `${header}.${payload}`;
    const sig = createHmac('sha256', pubKeyBytes)
      .update(segments)
      .digest('base64url');
    const confusedToken = `${segments}.${sig}`;

    const event = makeAuthEvent({
      apikey: ANON_KEY,
      authorization: `Bearer ${confusedToken}`,
    });

    await assert.rejects(
      () => handler(event),
      (err) => err === 'Unauthorized',
      'should reject token signed with public key bytes as HMAC secret',
    );
  });

  it('unknown algorithm (RS256) token is rejected', async () => {
    const handler = createAuthorizer({
      jwtSecret: TEST_SECRET,
      jwksUrl,
    }).handler;

    const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const payload = b64url(JSON.stringify({
      sub: 'attacker',
      email: 'evil@example.com',
      role: 'authenticated',
      iss: 'pgrest-lambda',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    }));
    const rs256Token = `${header}.${payload}.fake-signature`;

    const event = makeAuthEvent({
      apikey: ANON_KEY,
      authorization: `Bearer ${rs256Token}`,
    });

    await assert.rejects(
      () => handler(event),
      (err) => err === 'Unauthorized',
      'should reject token with unknown algorithm RS256',
    );
  });

  it('malformed token is rejected with dual-alg support active', async () => {
    const handler = createAuthorizer({
      jwtSecret: TEST_SECRET,
      jwksUrl,
    }).handler;

    const validToken = await signEdDSA();
    const validResult = await handler(makeAuthEvent({
      apikey: ANON_KEY,
      authorization: `Bearer ${validToken}`,
    }));
    assert.equal(
      validResult.context.role,
      'authenticated',
      'valid EdDSA token must be accepted first (verifying dual-alg support)',
    );

    const event = makeAuthEvent({
      apikey: ANON_KEY,
      authorization: 'Bearer not.a.valid.jwt.at-all',
    });

    await assert.rejects(
      () => handler(event),
      (err) => err === 'Unauthorized',
      'should throw Unauthorized for malformed token',
    );
  });
});
