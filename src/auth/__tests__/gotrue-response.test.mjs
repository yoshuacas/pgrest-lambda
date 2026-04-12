import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  sessionResponse,
  userResponse,
  logoutResponse,
  errorResponse,
} from '../gotrue-response.mjs';

const EXPECTED_CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
  'Content-Type': 'application/json',
};

function assertCorsHeaders(headers) {
  assert.equal(
    headers['Access-Control-Allow-Origin'],
    '*',
    'should have Allow-Origin: *'
  );
  assert.ok(
    headers['Access-Control-Allow-Headers'].includes('apikey'),
    'Allow-Headers should include apikey'
  );
  assert.ok(
    headers['Access-Control-Allow-Methods'].includes('PATCH'),
    'Allow-Methods should include PATCH'
  );
  assert.equal(
    headers['Content-Type'],
    'application/json',
    'Content-Type should be application/json'
  );
}

describe('gotrue-response.mjs', () => {
  describe('sessionResponse', () => {
    it('returns 200 with access_token, token_type, expires_in, refresh_token, user', () => {
      const user = {
        id: 'user-123',
        email: 'test@example.com',
        app_metadata: { provider: 'email', providers: ['email'] },
        user_metadata: {},
        created_at: '2026-04-11T12:00:00.000Z',
      };

      const res = sessionResponse('at-token', 'rt-token', user);

      assert.equal(res.statusCode, 200, 'status should be 200');
      const body = JSON.parse(res.body);
      assert.equal(
        body.access_token,
        'at-token',
        'access_token should match'
      );
      assert.equal(
        body.token_type,
        'bearer',
        'token_type should be bearer'
      );
      assert.equal(
        body.expires_in,
        3600,
        'expires_in should be 3600'
      );
      assert.equal(
        body.refresh_token,
        'rt-token',
        'refresh_token should match'
      );
      assert.ok(body.user, 'should include user object');
      assert.equal(body.user.id, 'user-123', 'user.id should match');
      assert.equal(
        body.user.email,
        'test@example.com',
        'user.email should match'
      );
    });
  });

  describe('userResponse', () => {
    it('returns 200 with user containing id, email, role, aud, app_metadata, user_metadata, created_at', () => {
      const user = {
        id: 'user-456',
        email: 'user@example.com',
        app_metadata: { provider: 'email', providers: ['email'] },
        user_metadata: { name: 'Test' },
        created_at: '2026-04-11T12:00:00.000Z',
      };

      const res = userResponse(user);

      assert.equal(res.statusCode, 200, 'status should be 200');
      const body = JSON.parse(res.body);
      assert.equal(body.id, 'user-456', 'id should match');
      assert.equal(
        body.email,
        'user@example.com',
        'email should match'
      );
      assert.equal(
        body.role,
        'authenticated',
        'role should be authenticated'
      );
      assert.equal(
        body.aud,
        'authenticated',
        'aud should be authenticated'
      );
      assert.ok(body.app_metadata, 'should have app_metadata');
      assert.ok(
        body.user_metadata !== undefined,
        'should have user_metadata'
      );
      assert.ok(body.created_at, 'should have created_at');
    });
  });

  describe('logoutResponse', () => {
    it('returns 204 with no body', () => {
      const res = logoutResponse();

      assert.equal(res.statusCode, 204, 'status should be 204');
      assert.equal(res.body, undefined, 'body should be undefined');
    });
  });

  describe('errorResponse', () => {
    it('returns specified status with error and error_description', () => {
      const res = errorResponse(
        400,
        'validation_failed',
        'Email is required'
      );

      assert.equal(res.statusCode, 400, 'status should be 400');
      const body = JSON.parse(res.body);
      assert.equal(
        body.error,
        'validation_failed',
        'error should match'
      );
      assert.equal(
        body.error_description,
        'Email is required',
        'error_description should match'
      );
    });
  });

  describe('CORS headers', () => {
    it('sessionResponse includes CORS headers', () => {
      const user = {
        id: 'u1',
        email: 'e@e.com',
        created_at: '2026-01-01T00:00:00Z',
      };
      const res = sessionResponse('at', 'rt', user);
      assertCorsHeaders(res.headers);
    });

    it('userResponse includes CORS headers', () => {
      const user = {
        id: 'u1',
        email: 'e@e.com',
        created_at: '2026-01-01T00:00:00Z',
      };
      const res = userResponse(user);
      assertCorsHeaders(res.headers);
    });

    it('logoutResponse includes CORS headers', () => {
      const res = logoutResponse();
      assertCorsHeaders(res.headers);
    });

    it('errorResponse includes CORS headers', () => {
      const res = errorResponse(400, 'err', 'desc');
      assertCorsHeaders(res.headers);
    });
  });

  describe('formatUser defaults', () => {
    it('defaults app_metadata to {provider: "email", providers: ["email"]} when missing', () => {
      const user = {
        id: 'u-no-meta',
        email: 'no-meta@example.com',
        created_at: '2026-01-01T00:00:00Z',
      };
      const res = sessionResponse('at', 'rt', user);
      const body = JSON.parse(res.body);

      assert.deepEqual(
        body.user.app_metadata,
        { provider: 'email', providers: ['email'] },
        'app_metadata should default to email provider'
      );
    });

    it('defaults created_at to an ISO date string when missing', () => {
      const user = {
        id: 'u-no-date',
        email: 'no-date@example.com',
      };
      const res = sessionResponse('at', 'rt', user);
      const body = JSON.parse(res.body);

      assert.ok(
        body.user.created_at,
        'created_at should be present'
      );
      // Verify it's a valid ISO date string
      const parsed = new Date(body.user.created_at);
      assert.ok(
        !isNaN(parsed.getTime()),
        'created_at should be a valid ISO date string'
      );
    });
  });
});
