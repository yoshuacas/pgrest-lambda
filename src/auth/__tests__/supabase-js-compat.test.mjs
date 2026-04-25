import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import pg from 'pg';
import { createBetterAuthProvider } from '../providers/better-auth.mjs';
import { createAuthHandler } from '../handler.mjs';
import { createJwt } from '../jwt.mjs';

const DATABASE_URL = process.env.DATABASE_URL;
const BETTER_AUTH_SECRET =
  process.env.BETTER_AUTH_SECRET ||
  'compat-test-secret-that-is-at-least-32-chars-long';
const TEST_JWT_SECRET = 'compat-jwt-secret-key-for-testing-12345';

const TEST_EMAIL = `compat-${Date.now()}@test.example.com`;
const TEST_PASSWORD = 'StrongPass1';

const FAKE_BASE_URL = 'http://pgrest.local';
const ANON_KEY = 'fake-anon-key-for-compat-test';

describe('supabase-js wire compatibility (requires PostgreSQL)', {
  skip: !DATABASE_URL && 'DATABASE_URL not set — skipping compat tests',
}, () => {
  let supabase;
  let handler;
  let pool;
  let server;
  let serverUrl;

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

    server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const queryParams = {};
        for (const [k, v] of url.searchParams) {
          queryParams[k] = v;
        }

        let body = '';
        for await (const chunk of req) body += chunk;

        const event = {
          httpMethod: req.method,
          path: url.pathname,
          queryStringParameters:
            Object.keys(queryParams).length ? queryParams : null,
          headers: { ...req.headers },
          body: body || null,
        };

        const result = await handler(event);

        const headers = { ...result.headers };
        if (result.body) {
          headers['content-type'] =
            headers['content-type'] || 'application/json';
        }
        res.writeHead(result.statusCode, headers);
        res.end(result.body || '');
      } catch (err) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });

    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    serverUrl = `http://127.0.0.1:${server.address().port}`;

    const { createClient } = await import('@supabase/supabase-js');
    supabase = createClient(serverUrl, ANON_KEY, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false,
      },
    });
  });

  after(async () => {
    if (server) server.close();
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

  it('signUp returns session with access_token and refresh_token', async () => {
    const { data, error } = await supabase.auth.signUp({
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
    });

    assert.equal(error, null, `signUp error: ${error?.message}`);
    assert.ok(data.session, 'signUp should return a session');
    assert.ok(
      data.session.access_token,
      'session should have access_token',
    );
    assert.ok(
      data.session.refresh_token,
      'session should have refresh_token',
    );
    assert.ok(data.user || data.session.user, 'should have user');
  });

  it('signInWithPassword returns session', async () => {
    const { data, error } = await supabase.auth.signInWithPassword({
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
    });

    assert.equal(
      error,
      null,
      `signIn error: ${error?.message}`,
    );
    assert.ok(data.session, 'signIn should return a session');
    assert.ok(data.session.access_token);
    assert.ok(data.session.refresh_token);
  });

  it('getUser returns user with matching email', async () => {
    const { data, error } = await supabase.auth.getUser();

    assert.equal(error, null, `getUser error: ${error?.message}`);
    assert.ok(data.user, 'getUser should return a user');
    assert.equal(data.user.email, TEST_EMAIL);
  });

  it('signOut succeeds', async () => {
    const { error } = await supabase.auth.signOut();
    assert.equal(error, null, `signOut error: ${error?.message}`);
  });
});
