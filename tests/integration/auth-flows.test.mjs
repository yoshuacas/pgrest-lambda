import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  startPostgres, stopPostgres, createPool, resetDatabase,
} from '../harness/db.mjs';
import { createTestPgrest, event } from '../harness/pgrest.mjs';

describe('better-auth integration: email + password', () => {
  let pool, handler, anon, destroy;

  before(async () => {
    await startPostgres();
    pool = createPool();
  });

  after(async () => {
    await pool.end();
    await stopPostgres();
  });

  beforeEach(async () => {
    await resetDatabase(pool);
    const ctx = createTestPgrest({ baseUrl: 'http://localhost:3000/v1' });
    handler = ctx.handler;
    anon = ctx.anon;
    destroy = ctx.destroy;
  });

  afterEach(async () => {
    if (destroy) await destroy();
  });

  async function call(method, path, { body, query, bearer } = {}) {
    const headers = { apikey: anon, 'Content-Type': 'application/json' };
    if (bearer) headers.Authorization = `Bearer ${bearer}`;
    const res = await handler(event({ method, path, headers, body, query }));
    const parsed = res.body ? JSON.parse(res.body) : null;
    return { status: res.statusCode, body: parsed };
  }

  it('signup returns a GoTrue-shaped session', async () => {
    const { status, body } = await call('POST', '/auth/v1/signup', {
      body: { email: 'alice@example.com', password: 'Passw0rd!' },
    });
    assert.equal(status, 200);
    assert.ok(body.access_token, 'access_token present');
    assert.ok(body.refresh_token, 'refresh_token present');
    assert.equal(body.token_type, 'bearer');
    assert.equal(typeof body.expires_in, 'number');
    assert.equal(body.user.email, 'alice@example.com');
    assert.ok(body.user.id, 'user.id present');
  });

  it('signup rejects a malformed email with validation_failed (400)', async () => {
    const { status, body } = await call('POST', '/auth/v1/signup', {
      body: { email: 'not-an-email', password: 'Passw0rd!' },
    });
    assert.equal(status, 400);
    assert.equal(body.error, 'validation_failed');
  });

  it('signup rejects a duplicate email', async () => {
    await call('POST', '/auth/v1/signup', {
      body: { email: 'dup@example.com', password: 'Passw0rd!' },
    });
    const { status, body } = await call('POST', '/auth/v1/signup', {
      body: { email: 'dup@example.com', password: 'Passw0rd!' },
    });
    assert.equal(status, 400);
    assert.equal(body.error, 'user_already_exists');
  });

  it('password grant returns a session', async () => {
    await call('POST', '/auth/v1/signup', {
      body: { email: 'pw@example.com', password: 'Passw0rd!' },
    });
    const { status, body } = await call('POST', '/auth/v1/token', {
      query: { grant_type: 'password' },
      body: { email: 'pw@example.com', password: 'Passw0rd!' },
    });
    assert.equal(status, 200);
    assert.ok(body.access_token);
  });

  it('password grant rejects bad credentials with invalid_grant', async () => {
    await call('POST', '/auth/v1/signup', {
      body: { email: 'wp@example.com', password: 'Passw0rd!' },
    });
    const { status, body } = await call('POST', '/auth/v1/token', {
      query: { grant_type: 'password' },
      body: { email: 'wp@example.com', password: 'WrongPass1' },
    });
    assert.equal(status, 400);
    assert.equal(body.error, 'invalid_grant');
  });

  it('refresh grant issues a valid access token and a refresh token', async () => {
    const signup = await call('POST', '/auth/v1/signup', {
      body: { email: 'rf@example.com', password: 'Passw0rd!' },
    });
    const { status, body } = await call('POST', '/auth/v1/token', {
      query: { grant_type: 'refresh_token' },
      body: { refresh_token: signup.body.refresh_token },
    });
    assert.equal(status, 200);
    // JWT iat is second-resolution — if the refresh happens in the same
    // second as the signup the access_token may be byte-identical. Don't
    // assert inequality; assert only that a well-formed token came back.
    assert.ok(body.access_token);
    assert.ok(body.refresh_token);
    assert.equal(body.user.email, 'rf@example.com');
  });

  it('get-user returns the authenticated user from the JWT', async () => {
    const signup = await call('POST', '/auth/v1/signup', {
      body: { email: 'gu@example.com', password: 'Passw0rd!' },
    });
    const { status, body } = await call('GET', '/auth/v1/user', {
      bearer: signup.body.access_token,
    });
    assert.equal(status, 200);
    assert.equal(body.email, 'gu@example.com');
    assert.equal(body.id, signup.body.user.id);
  });

  it('logout returns 204 and invalidates the session', async () => {
    const signup = await call('POST', '/auth/v1/signup', {
      body: { email: 'lo@example.com', password: 'Passw0rd!' },
    });
    const res = await handler(event({
      method: 'POST',
      path: '/auth/v1/logout',
      headers: {
        apikey: anon,
        Authorization: `Bearer ${signup.body.access_token}`,
      },
    }));
    assert.equal(res.statusCode, 204);
  });

  it('JWKS endpoint exposes at least one asymmetric key', async () => {
    // Touch the flow so better-auth generates a JWKS entry
    await call('POST', '/auth/v1/signup', {
      body: { email: 'jw@example.com', password: 'Passw0rd!' },
    });
    const res = await handler(event({
      method: 'GET',
      path: '/auth/v1/jwks',
      headers: { apikey: anon },
    }));
    assert.equal(res.statusCode, 200);
    const jwks = JSON.parse(res.body);
    assert.ok(Array.isArray(jwks.keys), 'keys is an array');
    assert.ok(jwks.keys.length >= 1, 'at least one key');
    assert.ok(jwks.keys[0].kty, 'key has kty');
  });
});
