import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createJwt, JWT_ALGORITHM } from '../jwt.mjs';

const TEST_SECRET = 'test-secret-key-for-jwt-tests-1234567890';

// Helper: decode JWT payload without verification
function decodePayload(token) {
  const parts = token.split('.');
  assert.equal(parts.length, 3, 'JWT should have 3 parts');
  return JSON.parse(Buffer.from(parts[1], 'base64url').toString());
}

describe('jwt.mjs', () => {
  let jwt;

  beforeEach(() => {
    jwt = createJwt({ jwtSecret: TEST_SECRET });
  });

  describe('createJwt secret validation', () => {
    it('throws when jwtSecret is undefined', () => {
      assert.throws(
        () => createJwt({ jwtSecret: undefined }),
        (err) => {
          assert.ok(err instanceof Error);
          assert.ok(err.message.includes('required'));
          return true;
        },
      );
    });

    it('throws when jwtSecret is short', () => {
      assert.throws(
        () => createJwt({ jwtSecret: 'short' }),
        (err) => {
          assert.ok(err instanceof Error);
          assert.ok(err.message.includes('too short'));
          return true;
        },
      );
    });

    it('returns object with expected methods for valid secret', () => {
      const j = createJwt({ jwtSecret: 'a'.repeat(32) });
      assert.equal(typeof j.signAccessToken, 'function');
      assert.equal(typeof j.signRefreshToken, 'function');
      assert.equal(typeof j.verifyToken, 'function');
    });
  });

  describe('signAccessToken', () => {
    it('produces JWT with correct claims for sub and email', () => {
      const token = jwt.signAccessToken({
        sub: 'user-123',
        email: 'test@example.com',
      });

      assert.equal(typeof token, 'string', 'should return a string');

      const payload = decodePayload(token);
      assert.equal(payload.sub, 'user-123', 'sub should match');
      assert.equal(
        payload.email,
        'test@example.com',
        'email should match'
      );
      assert.equal(
        payload.role,
        'authenticated',
        'role should be authenticated'
      );
      assert.equal(
        payload.aud,
        'authenticated',
        'aud should be authenticated'
      );
      assert.equal(payload.iss, 'pgrest-lambda', 'issuer should be pgrest-lambda');

      // ~1h expiry: exp - iat should be approximately 3600
      const diff = payload.exp - payload.iat;
      assert.ok(
        diff >= 3500 && diff <= 3700,
        `expiry should be ~1h (got ${diff}s)`
      );
    });
  });

  describe('signRefreshToken', () => {
    it('produces JWT with sub, role, iss, sid and ~30d expiry', () => {
      const sid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
      const token = jwt.signRefreshToken('user-123', sid);

      assert.equal(typeof token, 'string', 'should return a string');

      const payload = decodePayload(token);
      assert.equal(payload.sub, 'user-123', 'sub should match');
      assert.equal(
        payload.role,
        'authenticated',
        'role should be authenticated'
      );
      assert.equal(payload.iss, 'pgrest-lambda', 'issuer should be pgrest-lambda');
      assert.equal(
        payload.sid,
        sid,
        'sid should contain session ID'
      );
      assert.equal(
        payload.prt,
        undefined,
        'prt should not be present'
      );

      // ~30d expiry: exp - iat should be approximately 2592000
      const diff = payload.exp - payload.iat;
      const thirtyDays = 30 * 24 * 3600;
      assert.ok(
        diff >= thirtyDays - 100 && diff <= thirtyDays + 100,
        `expiry should be ~30d (got ${diff}s)`
      );
    });
  });

  describe('verifyToken', () => {
    it('returns decoded payload for a valid token', () => {
      const token = jwt.signAccessToken({
        sub: 'user-456',
        email: 'verify@example.com',
      });
      const payload = jwt.verifyToken(token);

      assert.equal(payload.sub, 'user-456', 'sub should match');
      assert.equal(
        payload.email,
        'verify@example.com',
        'email should match'
      );
      assert.equal(
        payload.role,
        'authenticated',
        'role should be authenticated'
      );
      assert.equal(payload.iss, 'pgrest-lambda', 'issuer should be pgrest-lambda');
    });

    it('throws for an expired token', () => {
      const expiredToken = 'eyJhbGciOiJIUzI1NiJ9.' +
        Buffer.from(JSON.stringify({
          sub: 'user-789',
          email: 'expired@example.com',
          role: 'authenticated',
          aud: 'authenticated',
          iss: 'boa',
          iat: 1000000000,
          exp: 1000000001,
        })).toString('base64url') +
        '.invalid-sig';

      assert.throws(
        () => jwt.verifyToken(expiredToken),
        (err) => {
          assert.notEqual(
            err.message,
            'not implemented',
            'verifyToken must be implemented to test expiry'
          );
          return true;
        }
      );
    });

    it('throws for token signed with wrong secret', () => {
      // Sign with one secret, verify with another
      const wrongJwt = createJwt({ jwtSecret: 'different-secret-key-for-jwt-tests-999' });
      const token = wrongJwt.signAccessToken({
        sub: 'user-wrong',
        email: 'wrong@example.com',
      });

      assert.throws(
        () => jwt.verifyToken(token),
        (err) => {
          assert.notEqual(
            err.message,
            'not implemented',
            'verifyToken must be implemented to test wrong secret'
          );
          return true;
        }
      );
    });

    it('throws for token with wrong issuer', () => {
      const wrongIssuerToken = 'eyJhbGciOiJIUzI1NiJ9.' +
        Buffer.from(JSON.stringify({
          sub: 'user-iss',
          email: 'issuer@example.com',
          role: 'authenticated',
          iss: 'wrong-issuer',
          iat: Math.floor(Date.now() / 1000),
          exp: Math.floor(Date.now() / 1000) + 3600,
        })).toString('base64url') +
        '.invalid-sig';

      assert.throws(
        () => jwt.verifyToken(wrongIssuerToken),
        (err) => {
          assert.notEqual(
            err.message,
            'not implemented',
            'verifyToken must be implemented to test wrong issuer'
          );
          return true;
        }
      );
    });

    it('throws for malformed string', () => {
      assert.throws(
        () => jwt.verifyToken('not-a-jwt'),
        (err) => {
          assert.notEqual(
            err.message,
            'not implemented',
            'verifyToken must be implemented to test malformed token'
          );
          return true;
        }
      );
    });
  });

  describe('algorithm pinning', () => {
    it('exports JWT_ALGORITHM as HS256', () => {
      assert.equal(JWT_ALGORITHM, 'HS256');
    });

    it('round-trips HS256 tokens successfully', () => {
      const token = jwt.signAccessToken({
        sub: 'user-alg',
        email: 'alg@example.com',
      });
      const payload = jwt.verifyToken(token);
      assert.equal(payload.sub, 'user-alg');
      assert.equal(payload.email, 'alg@example.com');
    });

    it('rejects a token with alg: none', () => {
      const header = Buffer.from(
        JSON.stringify({ alg: 'none', typ: 'JWT' }),
      ).toString('base64url');
      const payload = Buffer.from(
        JSON.stringify({
          sub: 'attacker',
          role: 'authenticated',
          iss: 'pgrest-lambda',
          iat: Math.floor(Date.now() / 1000),
          exp: Math.floor(Date.now() / 1000) + 3600,
        }),
      ).toString('base64url');
      const forgedToken = `${header}.${payload}.`;

      assert.throws(
        () => jwt.verifyToken(forgedToken),
        { name: 'JsonWebTokenError' },
      );
    });

    it('rejects a token with alg: RS256', () => {
      const header = Buffer.from(
        JSON.stringify({ alg: 'RS256', typ: 'JWT' }),
      ).toString('base64url');
      const payload = Buffer.from(
        JSON.stringify({
          sub: 'attacker',
          role: 'authenticated',
          iss: 'pgrest-lambda',
          iat: Math.floor(Date.now() / 1000),
          exp: Math.floor(Date.now() / 1000) + 3600,
        }),
      ).toString('base64url');
      const forgedToken = `${header}.${payload}.fakesignature`;

      assert.throws(
        () => jwt.verifyToken(forgedToken),
        (err) => err.message.includes('invalid algorithm'),
      );
    });
  });
});
