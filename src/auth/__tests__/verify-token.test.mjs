import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createHmac } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { SignJWT, exportJWK } from 'jose';
import { createTokenVerifier } from '../verify-token.mjs';
import {
  privateKey, publicKey, makeEdDSAToken, getPubJwk,
} from './helpers/eddsa.mjs';
import {
  startJwksServer, startJwksServerWithKey,
} from './helpers/jwks-server.mjs';

const TEST_SECRET = 'test-secret-for-verify-token-tests';
const ISSUER = 'pgrest-lambda';

function signHS256(payload) {
  return jwt.sign(payload, TEST_SECRET, {
    algorithm: 'HS256',
    issuer: ISSUER,
    expiresIn: 3600,
  });
}

describe('createTokenVerifier', () => {
  describe('test_hs256_token_accepted', () => {
    it('returns the payload for a valid HS256 token', async () => {
      const verifier = createTokenVerifier({
        jwtSecret: TEST_SECRET,
      });
      const token = signHS256({
        sub: 'user-123',
        email: 'test@example.com',
        role: 'authenticated',
      });
      const payload = await verifier.verify(token);
      assert.equal(payload.sub, 'user-123');
      assert.equal(payload.email, 'test@example.com');
      assert.equal(payload.role, 'authenticated');
      assert.equal(payload.iss, ISSUER);
    });

    it('rejects HS256 token with wrong secret', async () => {
      const verifier = createTokenVerifier({
        jwtSecret: TEST_SECRET,
      });
      const token = jwt.sign(
        { sub: 'user-123', role: 'authenticated' },
        'wrong-secret-key-that-is-long-enough',
        { algorithm: 'HS256', issuer: ISSUER, expiresIn: 3600 },
      );
      await assert.rejects(
        () => verifier.verify(token),
        (err) => err.name === 'JsonWebTokenError',
      );
    });

    it('rejects expired HS256 token', async () => {
      const verifier = createTokenVerifier({
        jwtSecret: TEST_SECRET,
      });
      const token = jwt.sign(
        { sub: 'user-123', role: 'authenticated' },
        TEST_SECRET,
        { algorithm: 'HS256', issuer: ISSUER, expiresIn: -10 },
      );
      await assert.rejects(
        () => verifier.verify(token),
        (err) => err.name === 'TokenExpiredError',
      );
    });
  });

  describe('test_asymmetric_token_accepted_via_local_jwks', () => {
    it('accepts EdDSA token via localJwksProvider', async () => {
      let providerCalled = false;
      const verifier = createTokenVerifier({
        jwtSecret: TEST_SECRET,
        localJwksProvider: async () => {
          providerCalled = true;
          return { keys: [await getPubJwk()] };
        },
      });
      const token = await makeEdDSAToken();
      const payload = await verifier.verify(token);

      assert.ok(providerCalled, 'localJwksProvider should be called');
      assert.equal(payload.sub, 'user-id-001');
      assert.equal(payload.email, 'test@example.com');
    });
  });

  describe('test_asymmetric_token_falls_back_to_remote_jwks', () => {
    let jwksServer;

    afterEach(() => {
      if (jwksServer) {
        jwksServer.close();
        jwksServer = null;
      }
    });

    it('falls back to remote JWKS when no localJwksProvider', async () => {
      const pubJwk = await getPubJwk();
      const result = await startJwksServer(pubJwk);
      jwksServer = result.server;

      const verifier = createTokenVerifier({
        jwtSecret: TEST_SECRET,
        jwksUrl: result.url,
      });
      const token = await makeEdDSAToken();
      const payload = await verifier.verify(token);

      assert.equal(payload.sub, 'user-id-001');
      assert.equal(payload.email, 'test@example.com');
    });

    it('falls back to remote JWKS when localJwksProvider returns null', async () => {
      const pubJwk = await getPubJwk();
      const result = await startJwksServer(pubJwk);
      jwksServer = result.server;

      const verifier = createTokenVerifier({
        jwtSecret: TEST_SECRET,
        jwksUrl: result.url,
        localJwksProvider: async () => null,
      });
      const token = await makeEdDSAToken();
      const payload = await verifier.verify(token);

      assert.equal(payload.sub, 'user-id-001');
    });
  });

  describe('test_local_jwks_cache_invalidates_on_kid_mismatch', () => {
    it('invalidates cache and retries when kid does not match', async () => {
      const newKeyPair = generateKeyPairSync('ed25519');
      const newPubJwk = await exportJWK(newKeyPair.publicKey);
      newPubJwk.kid = 'rotated-kid-2';
      newPubJwk.alg = 'EdDSA';
      newPubJwk.use = 'sig';

      const origPubJwk = await getPubJwk();
      let callCount = 0;
      let returnRotated = false;

      const verifier = createTokenVerifier({
        jwtSecret: TEST_SECRET,
        localJwksProvider: async () => {
          callCount++;
          if (returnRotated) {
            return { keys: [origPubJwk, newPubJwk] };
          }
          return { keys: [origPubJwk] };
        },
      });

      const oldToken = await makeEdDSAToken();
      const oldPayload = await verifier.verify(oldToken);
      assert.equal(oldPayload.sub, 'user-id-001');
      assert.equal(callCount, 1);

      returnRotated = true;
      const now = Math.floor(Date.now() / 1000);
      const rotatedToken = await new SignJWT({
        sub: 'user-rotated',
        email: 'rotated@example.com',
        role: 'authenticated',
      })
        .setProtectedHeader({ alg: 'EdDSA', kid: 'rotated-kid-2' })
        .setIssuer(ISSUER)
        .setIssuedAt(now)
        .setExpirationTime(now + 3600)
        .sign(newKeyPair.privateKey);

      const rotatedPayload = await verifier.verify(rotatedToken);
      assert.equal(rotatedPayload.sub, 'user-rotated');
      assert.equal(callCount, 2, 'provider should be called again after kid mismatch');
    });
  });

  describe('test_no_jwks_url_rejects_asymmetric_token', () => {
    it('throws when no jwksUrl and no localJwksProvider', async () => {
      const verifier = createTokenVerifier({
        jwtSecret: TEST_SECRET,
      });
      const token = await makeEdDSAToken();

      await assert.rejects(
        () => verifier.verify(token),
        (err) => {
          assert.ok(err.message.includes('Unauthorized'));
          return true;
        },
      );
    });
  });

  describe('test_verification_consistent_across_handler_and_authorizer', () => {
    let jwksServer;

    afterEach(() => {
      if (jwksServer) {
        jwksServer.close();
        jwksServer = null;
      }
    });

    it('same HS256 token returns same payload from both verifier configs', async () => {
      const handlerVerifier = createTokenVerifier({
        jwtSecret: TEST_SECRET,
        localJwksProvider: async () => null,
      });
      const authorizerVerifier = createTokenVerifier({
        jwtSecret: TEST_SECRET,
      });

      const token = signHS256({
        sub: 'user-123',
        email: 'user@example.com',
        role: 'authenticated',
      });

      const handlerPayload = await handlerVerifier.verify(token);
      const authorizerPayload = await authorizerVerifier.verify(token);

      assert.equal(handlerPayload.sub, authorizerPayload.sub);
      assert.equal(handlerPayload.email, authorizerPayload.email);
      assert.equal(handlerPayload.role, authorizerPayload.role);
      assert.equal(handlerPayload.iss, authorizerPayload.iss);
    });

    it('same EdDSA token returns same payload from both verifier configs', async () => {
      const pubJwk = await getPubJwk();
      const result = await startJwksServer(pubJwk);
      jwksServer = result.server;

      const handlerVerifier = createTokenVerifier({
        jwtSecret: TEST_SECRET,
        jwksUrl: result.url,
        localJwksProvider: async () => ({ keys: [pubJwk] }),
      });
      const authorizerVerifier = createTokenVerifier({
        jwtSecret: TEST_SECRET,
        jwksUrl: result.url,
      });

      const token = await makeEdDSAToken();

      const handlerPayload = await handlerVerifier.verify(token);
      const authorizerPayload = await authorizerVerifier.verify(token);

      assert.equal(handlerPayload.sub, authorizerPayload.sub);
      assert.equal(handlerPayload.email, authorizerPayload.email);
      assert.equal(handlerPayload.role, authorizerPayload.role);
    });

    it('both reject an invalid token consistently', async () => {
      const handlerVerifier = createTokenVerifier({
        jwtSecret: TEST_SECRET,
        localJwksProvider: async () => null,
      });
      const authorizerVerifier = createTokenVerifier({
        jwtSecret: TEST_SECRET,
      });

      const token = jwt.sign(
        { sub: 'attacker', role: 'authenticated' },
        'completely-different-secret-value!!',
        { algorithm: 'HS256', issuer: ISSUER, expiresIn: 3600 },
      );

      let handlerErr;
      let authorizerErr;
      try { await handlerVerifier.verify(token); } catch (e) { handlerErr = e; }
      try { await authorizerVerifier.verify(token); } catch (e) { authorizerErr = e; }

      assert.ok(handlerErr, 'handler verifier should reject');
      assert.ok(authorizerErr, 'authorizer verifier should reject');
    });
  });

  describe('resetCache', () => {
    it('clears all cached JWKS state', async () => {
      let callCount = 0;
      const verifier = createTokenVerifier({
        jwtSecret: TEST_SECRET,
        localJwksProvider: async () => {
          callCount++;
          return { keys: [await getPubJwk()] };
        },
      });

      const token = await makeEdDSAToken();
      await verifier.verify(token);
      assert.equal(callCount, 1);

      await verifier.verify(token);
      assert.equal(callCount, 1, 'should use cache');

      verifier.resetCache();
      await verifier.verify(token);
      assert.equal(callCount, 2, 'should re-fetch after reset');
    });
  });
});
