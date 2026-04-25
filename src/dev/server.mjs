// startDevServer: run pgrest-lambda behind a Node HTTP server.
// Intended for local development and tests — NOT a production runtime.
// In production, pgrest-lambda runs as a Lambda behind API Gateway;
// this server shims the API Gateway event shape so the same handler
// can run under plain Node.

import { createServer } from 'node:http';
import { createPgrest } from '../index.mjs';

/**
 * @typedef {object} StartDevServerOptions
 * @property {object} pgrestConfig         passed straight to createPgrest()
 * @property {number} [port=3000]          HTTP listen port (0 = random)
 * @property {string} [host='127.0.0.1']
 * @property {(line: string) => void} [log]  custom logger (default: console.log)
 */

/**
 * @typedef {object} DevServerHandle
 * @property {string} baseUrl              http://host:port (no trailing slash)
 * @property {import('http').Server} server
 * @property {() => Promise<void>} stop    closes the HTTP server
 * @property {ReturnType<typeof createPgrest>} pgrest  the running pgrest instance
 */

/**
 * Start a local HTTP server that forwards requests to a pgrest-lambda
 * handler. Returns once the socket is listening.
 *
 * @param {StartDevServerOptions} options
 * @returns {Promise<DevServerHandle>}
 */
export async function startDevServer(options) {
  const {
    pgrestConfig,
    port = 3000,
    host = '127.0.0.1',
    log = (line) => console.log(line),
  } = options;

  if (!pgrestConfig) {
    throw new Error('startDevServer: `pgrestConfig` is required');
  }

  const pgrest = createPgrest(pgrestConfig);

  const server = createServer((req, res) => {
    handleRequest(pgrest.handler, req, res).catch((err) => {
      log(`[pgrest-lambda] request error: ${err.message}`);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: 'server_error', message: err.message }));
      } else {
        res.end();
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  const baseUrl = `http://${address.address === '::' ? 'localhost' : address.address}:${address.port}`;

  return {
    baseUrl,
    server,
    pgrest,
    async stop() {
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
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
  for (const [k, v] of new URLSearchParams(url.slice(qIdx + 1)).entries()) {
    query[k] = v;
  }
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

// Mimics the deployed Lambda authorizer without actually verifying the
// JWT. Safe because the dev server is only reachable from localhost.
// The authorizer's flat context (role, userId, email) is what the REST
// engine expects to see on requestContext.authorizer.
// Matches the production Lambda authorizer's logic:
// 1. Start with the role from the apikey JWT (anon or service_role).
// 2. If the request also has `Authorization: Bearer <token>`, that
//    token's role wins — it represents an authenticated user session.
//
// The dev server does NOT verify signatures — trust is delegated to
// the developer running on localhost. Production runs the real
// authorizer (src/authorizer/index.mjs) in front of API Gateway.
function extractAuthorizerContext(headers) {
  const authHeader = headers.authorization || headers.Authorization || '';
  const apikey = headers.apikey || '';
  if (!apikey) return null;

  const apikeyClaims = decodeJwtPayload(apikey) || {};
  let role = apikeyClaims.role || 'anon';
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
