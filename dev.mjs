#!/usr/bin/env node
// Local dev server — wraps pgrest-lambda handlers in an HTTP server.

import http from 'node:http';
import { createPgrest } from './src/index.mjs';
import jwt from 'jsonwebtoken';

const JWT_SECRET = 'dev-secret-do-not-use-in-production';
const PORT = process.env.PORT || 3000;

const pgrest = createPgrest({
  database: {
    host: 'localhost',
    port: 5433,
    user: 'postgres',
    password: 'mySecurePassword123',
    database: 'postgres',
  },
  jwtSecret: JWT_SECRET,
  // auth defaults to { provider: 'gotrue' }
});

// Generate dev API keys
const anonKey = jwt.sign({ role: 'anon' }, JWT_SECRET, { issuer: 'pgrest-lambda' });
const serviceKey = jwt.sign({ role: 'service_role' }, JWT_SECRET, { issuer: 'pgrest-lambda' });

function parseUrl(raw) {
  const url = new URL(raw, 'http://localhost');
  const params = {};
  for (const [k, v] of url.searchParams) {
    params[k] = v;
  }
  return { path: url.pathname, query: params };
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? Buffer.concat(chunks).toString() : null;
}

function translateRequest(req, body) {
  const { path, query } = parseUrl(req.url);
  const headers = { 'x-forwarded-proto': 'http' };
  for (const [k, v] of Object.entries(req.headers)) {
    headers[k] = v;
  }

  // Simulate API Gateway authorizer from apikey + Authorization headers
  let role = 'anon';
  let userId = '';
  let email = '';

  const apikey = headers['apikey'];
  if (apikey) {
    try {
      const payload = jwt.verify(apikey, JWT_SECRET, { issuer: 'pgrest-lambda' });
      role = payload.role;
    } catch { /* invalid key, stay anon */ }
  }

  const authHeader = headers['authorization'] || '';
  if (authHeader.startsWith('Bearer ')) {
    try {
      const payload = jwt.verify(authHeader.slice(7), JWT_SECRET, { issuer: 'pgrest-lambda' });
      role = payload.role || role;
      userId = payload.sub || '';
      email = payload.email || '';
    } catch { /* invalid bearer */ }
  }

  return {
    httpMethod: req.method,
    path,
    queryStringParameters: Object.keys(query).length ? query : null,
    headers,
    body,
    requestContext: {
      authorizer: { role, userId, email },
    },
  };
}

const server = http.createServer(async (req, res) => {
  const body = await readBody(req);
  const { path } = parseUrl(req.url);

  // Docs and OpenAPI spec served without auth for browser access
  if (path === '/rest/v1/_docs' || path === '/rest/v1/' || path === '/rest/v1') {
    const event = translateRequest(req, body);
    event.requestContext.authorizer = { role: 'service_role', userId: '', email: '' };
    try {
      const result = await pgrest.rest(event);
      res.writeHead(result.statusCode, result.headers || {});
      res.end(result.body || '');
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  const event = translateRequest(req, body);

  try {
    const result = await pgrest.handler(event);
    res.writeHead(result.statusCode, result.headers || {});
    res.end(result.body || '');
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
});

server.listen(PORT, () => {
  console.log(`pgrest-lambda dev server running at http://localhost:${PORT}`);
  console.log();
  console.log('API keys (pass as "apikey" header):');
  console.log(`  anon:         ${anonKey}`);
  console.log(`  service_role: ${serviceKey}`);
  console.log();
  console.log('Auth endpoints:');
  console.log(`  POST http://localhost:${PORT}/auth/v1/signup`);
  console.log(`  POST http://localhost:${PORT}/auth/v1/token?grant_type=password`);
  console.log(`  POST http://localhost:${PORT}/auth/v1/token?grant_type=refresh_token`);
  console.log(`  GET  http://localhost:${PORT}/auth/v1/user`);
  console.log(`  POST http://localhost:${PORT}/auth/v1/logout`);
  console.log();
  console.log('Try:');
  console.log(`  curl http://localhost:${PORT}/rest/v1/todos -H "apikey: ${anonKey}"`);
});
