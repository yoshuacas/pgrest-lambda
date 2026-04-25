import { randomBytes } from 'node:crypto';
import { createPgrest } from '../../src/index.mjs';
import { connectionInfo } from './db.mjs';
import { mintAnonAndService } from './keys.mjs';

// Produce a ready-to-call pgrest instance wired to the test Postgres and
// a fresh better-auth backend. Callers get { handler, anon, service, baseUrl }.
// baseUrl is needed as the better-auth baseURL; integration tests pass a
// placeholder, e2e tests override it with the real bound server URL.
export function createTestPgrest({ baseUrl, betterAuthBasePath = '/auth/v1/ba' } = {}) {
  const db = connectionInfo();
  const jwtSecret = randomBytes(48).toString('base64');
  const betterAuthSecret = randomBytes(48).toString('base64');
  const resolvedBaseUrl = baseUrl || `http://localhost:0/v1`;

  const pgrest = createPgrest({
    database: {
      host: db.host,
      port: db.port,
      user: db.user,
      password: db.password,
      database: db.database,
    },
    jwtSecret,
    auth: {
      provider: 'better-auth',
      betterAuthSecret,
      betterAuthUrl: resolvedBaseUrl,
      pgHost: db.host,
      pgPort: db.port,
      pgUser: db.user,
      pgPassword: db.password,
      pgDatabase: db.database,
      // SES not used — magic link tests skip or stub; Google OAuth left unset
    },
    cors: { allowedOrigins: '*' },
    production: false,
    docs: false,
  });

  const { anon, service } = mintAnonAndService(jwtSecret);

  // Tear down the pg.Pool(s) created inside pgrest so tests don't leak
  // async handles into the next test.
  async function destroy() {
    const errors = [];
    try {
      if (pgrest._db?.close) await pgrest._db.close();
      else if (pgrest._db?.end) await pgrest._db.end();
    } catch (e) { errors.push(e); }

    // The better-auth provider holds its own pool. It lives at
    // pgrest-internal ctx.authProvider once any auth route has been hit.
    try {
      // Accessing via the auth handler's closed-over ctx isn't public,
      // so use the exposed _auth instead. createAuthHandler sets
      // _setProvider but not _getProvider; fall back to best-effort.
      const prov = pgrest._auth?.getProvider
        ? await pgrest._auth.getProvider()
        : null;
      if (prov?.destroy) await prov.destroy();
    } catch (e) { errors.push(e); }

    if (errors.length) {
      // Don't throw — we want afterEach to keep running — but surface
      // the first error so it doesn't hide silently.
      // eslint-disable-next-line no-console
      console.warn('[harness] destroy errors:', errors.map((e) => e.message));
    }
  }

  return {
    handler: pgrest.handler,
    anon,
    service,
    jwtSecret,
    betterAuthSecret,
    baseUrl: resolvedBaseUrl,
    betterAuthBasePath,
    pgrest, // advanced: direct access to subsystems
    destroy,
  };
}

// Build an API Gateway v1 event for in-process invocation.
export function event({
  method = 'GET',
  path = '/',
  headers = {},
  body = null,
  query = null,
  authorizer = null,
} = {}) {
  const queryStringParameters = query
    ? Object.fromEntries(
        Object.entries(query).map(([k, v]) => [k, String(v)])
      )
    : null;

  return {
    httpMethod: method,
    path,
    headers,
    body: body == null ? null : typeof body === 'string' ? body : JSON.stringify(body),
    queryStringParameters,
    multiValueQueryStringParameters: null,
    requestContext: {
      authorizer: authorizer || undefined,
      identity: {},
      httpMethod: method,
      path,
      stage: 'v1',
    },
    isBase64Encoded: false,
  };
}
