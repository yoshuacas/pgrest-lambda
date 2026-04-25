import { createServer } from 'node:http';

// Minimal HTTP server that translates requests into API Gateway REST v1
// events and passes them to a pgrest `handler(event)`. Intended only for
// e2e tests — not a production runtime.
export function startDevServer(handler, { host = '127.0.0.1' } = {}) {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      handleRequest(handler, req, res).catch((err) => {
        res.statusCode = 500;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: 'server_error', message: err.message }));
      });
    });

    server.on('error', reject);
    server.listen(0, host, () => {
      const { address, port } = server.address();
      const baseUrl = `http://${address}:${port}`;
      resolve({
        baseUrl,
        async stop() {
          await new Promise((r) => server.close(r));
        },
      });
    });
  });
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return null;
  return Buffer.concat(chunks).toString('utf8');
}

function parseQuery(url) {
  const qIdx = url.indexOf('?');
  if (qIdx === -1) return { path: url, query: null };
  const path = url.slice(0, qIdx);
  const query = {};
  const params = new URLSearchParams(url.slice(qIdx + 1));
  for (const [k, v] of params.entries()) query[k] = v;
  return { path, query };
}

async function handleRequest(handler, req, res) {
  const { path, query } = parseQuery(req.url);
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    headers[k] = Array.isArray(v) ? v.join(', ') : v;
  }
  const body = await readBody(req);

  const event = {
    httpMethod: req.method,
    path,
    headers,
    body,
    queryStringParameters: query,
    multiValueQueryStringParameters: null,
    requestContext: {
      // In a deployed stack the Lambda authorizer populates this.
      // For e2e tests, we verify the apikey but mirror the existing
      // in-process test pattern: no user context unless a test fixture
      // injects one via headers the authorizer understands.
      authorizer: extractAuthorizerContext(headers),
      identity: {},
      httpMethod: req.method,
      path,
      stage: 'v1',
    },
    isBase64Encoded: false,
  };

  const result = await handler(event);
  res.statusCode = result.statusCode || 200;
  for (const [k, v] of Object.entries(result.headers || {})) {
    res.setHeader(k, v);
  }
  res.end(result.body || '');
}

// The real Lambda authorizer verifies the apikey and Bearer, then
// attaches { role, userId, email } to requestContext.authorizer. For
// e2e we bypass the authorizer — the handler trusts the authorizer
// context supplied on the event. This is fine because the dev server
// is only reachable from the test process.
//
// To model "anon" vs "authenticated" requests, tests can send either:
//   - apikey only (anon)
//   - apikey + Authorization: Bearer <access_token> (authenticated)
// and the dev server decodes the Bearer JWT to populate userId/email.
function extractAuthorizerContext(headers) {
  const authHeader = headers.authorization || headers.Authorization || '';
  const apikey = headers.apikey || '';
  if (!apikey) return null;

  let role = 'anon';
  let userId = '';
  let email = '';

  if (authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    const claims = decodeJwtPayload(token);
    if (claims) {
      role = claims.role || 'authenticated';
      userId = claims.sub || '';
      email = claims.email || '';
    }
  }

  return { role, userId, email };
}

function decodeJwtPayload(token) {
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const payload = Buffer.from(parts[1], 'base64url').toString('utf8');
    return JSON.parse(payload);
  } catch {
    return null;
  }
}
