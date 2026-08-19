import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import {
  startPostgres, stopPostgres, createPool, resetDatabase,
} from '../harness/db.mjs';
import { createTestPgrest, event, captureConsole } from '../harness/pgrest.mjs';

const SETUP_SQL = `
CREATE TABLE IF NOT EXISTS items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  name text NOT NULL
);

CREATE FUNCTION add_numbers(a integer, b integer)
RETURNS integer LANGUAGE sql AS $$
  SELECT a + b;
$$;

CREATE FUNCTION get_items(p_user_id uuid)
RETURNS TABLE(id uuid, name text) LANGUAGE sql AS $$
  SELECT id, name FROM items
   WHERE user_id = p_user_id;
$$;

CREATE FUNCTION do_nothing()
RETURNS void LANGUAGE sql AS $$
$$;

CREATE FUNCTION with_default(
  x integer, y integer DEFAULT 10)
RETURNS integer LANGUAGE sql AS $$
  SELECT x + y;
$$;

CREATE FUNCTION greet(name text)
RETURNS text LANGUAGE sql AS $$
  SELECT 'Hello, ' || name;
$$;

CREATE FUNCTION get_first_item()
RETURNS items LANGUAGE sql AS $$
  SELECT * FROM items LIMIT 1;
$$;
`;

describe('RPC integration tests', () => {
  let pool, handler, service, anon, destroy;
  let testUserId;

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
    await pool.query(SETUP_SQL);

    testUserId = randomUUID();
    await pool.query(
      `INSERT INTO items (user_id, name) VALUES ($1, $2), ($1, $3), ($1, $4)`,
      [testUserId, 'Alice', 'Bob', 'Charlie'],
    );

    const ctx = createTestPgrest({ baseUrl: 'http://localhost:3000/v1' });
    handler = ctx.handler;
    service = ctx.service;
    anon = ctx.anon;
    destroy = ctx.destroy;
  });

  afterEach(async () => {
    if (destroy) await destroy();
  });

  it('scalar POST: returns function result', async () => {
    const res = await handler(event({
      method: 'POST',
      path: '/rest/v1/rpc/add_numbers',
      headers: { apikey: service, 'Content-Type': 'application/json' },
      body: { a: 3, b: 4 },
      authorizer: { role: 'service_role' },
    }));
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body, 7);
  });

  it('scalar GET: returns function result via query params', async () => {
    const res = await handler(event({
      method: 'GET',
      path: '/rest/v1/rpc/add_numbers',
      headers: { apikey: service },
      query: { a: '3', b: '4' },
      authorizer: { role: 'service_role' },
    }));
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body, 7);
  });

  it('GET and POST produce the same result', async () => {
    const postRes = await handler(event({
      method: 'POST',
      path: '/rest/v1/rpc/add_numbers',
      headers: { apikey: service, 'Content-Type': 'application/json' },
      body: { a: 3, b: 4 },
      authorizer: { role: 'service_role' },
    }));
    const getRes = await handler(event({
      method: 'GET',
      path: '/rest/v1/rpc/add_numbers',
      headers: { apikey: service },
      query: { a: '3', b: '4' },
      authorizer: { role: 'service_role' },
    }));
    assert.equal(JSON.parse(postRes.body), JSON.parse(getRes.body));
  });

  it('set-returning RETURNS TABLE with order and limit', async () => {
    const res = await handler(event({
      method: 'POST',
      path: '/rest/v1/rpc/get_items',
      headers: { apikey: service, 'Content-Type': 'application/json' },
      body: { p_user_id: testUserId },
      query: { order: 'name.asc', limit: '5' },
      authorizer: { role: 'service_role' },
    }));
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(Array.isArray(body), 'should return array');
    assert.ok(body.length <= 5);
    for (let i = 1; i < body.length; i++) {
      assert.ok(body[i].name >= body[i - 1].name,
        'should be sorted ascending by name');
    }
  });

  it('set-returning RETURNS TABLE with filter', async () => {
    const res = await handler(event({
      method: 'POST',
      path: '/rest/v1/rpc/get_items',
      headers: { apikey: service, 'Content-Type': 'application/json' },
      body: { p_user_id: testUserId },
      query: { name: 'eq.Alice' },
      authorizer: { role: 'service_role' },
    }));
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(body.length > 0, 'should have matching rows');
    for (const row of body) {
      assert.equal(row.name, 'Alice');
    }
  });

  it('set-returning RETURNS TABLE with select', async () => {
    const res = await handler(event({
      method: 'POST',
      path: '/rest/v1/rpc/get_items',
      headers: { apikey: service, 'Content-Type': 'application/json' },
      body: { p_user_id: testUserId },
      query: { select: 'name' },
      authorizer: { role: 'service_role' },
    }));
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(body.length > 0);
    for (const row of body) {
      assert.ok('name' in row, 'should have name column');
      assert.ok(!('id' in row), 'should not have id column');
    }
  });

  it('RETURNS TABLE with invalid column filter returns PGRST204', async () => {
    const res = await handler(event({
      method: 'POST',
      path: '/rest/v1/rpc/get_items',
      headers: { apikey: service, 'Content-Type': 'application/json' },
      body: { p_user_id: testUserId },
      query: { nonexistent: 'eq.x' },
      authorizer: { role: 'service_role' },
    }));
    assert.equal(res.statusCode, 400);
    const body = JSON.parse(res.body);
    assert.equal(body.code, 'PGRST204');
  });

  // Upstream PostgREST asserts 204 with no Content-Type and no Content-Length
  // for a function returning void (test/spec/Feature/Query/RpcSpec.hs:470,
  // "returns 204, no Content-Type header and no content for void"). This test
  // previously asserted 200; that was the engine's own behaviour, not
  // PostgREST's, and it was corrected when the RPC result modes were aligned
  // with the upstream spec.
  it('void function returns 204 with no body and no Content-Type', async () => {
    const res = await handler(event({
      method: 'POST',
      path: '/rest/v1/rpc/do_nothing',
      headers: { apikey: service, 'Content-Type': 'application/json' },
      body: {},
      authorizer: { role: 'service_role' },
    }));
    assert.equal(res.statusCode, 204);
    assert.ok(!res.body || res.body === '',
      'void function should return empty body');
    assert.equal(res.headers['Content-Type'], undefined,
      'void function must not send Content-Type');
    assert.equal(res.headers['Content-Length'], undefined,
      'void function must not send Content-Length');
  });

  it('default arguments: omitted arg uses default value', async () => {
    const res = await handler(event({
      method: 'POST',
      path: '/rest/v1/rpc/with_default',
      headers: { apikey: service, 'Content-Type': 'application/json' },
      body: { x: 5 },
      authorizer: { role: 'service_role' },
    }));
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body, 15, '5 + default 10 = 15');
  });

  // Argument names are what select the function, so a call whose argument
  // names do not fit any overload has not found a function at all: upstream
  // answers 404 PGRST202 for both a missing and an extra argument (Plan.hs
  // `findProc` returns `NoRpc`), and hints the closest parameter list. The
  // earlier pgrest-lambda-only PGRST207/PGRST209 400s were not upstream codes.
  it('missing required argument returns 404 PGRST202', async () => {
    const res = await handler(event({
      method: 'POST',
      path: '/rest/v1/rpc/add_numbers',
      headers: { apikey: service, 'Content-Type': 'application/json' },
      body: { a: 3 },
      authorizer: { role: 'service_role' },
    }));
    assert.equal(res.statusCode, 404);
    const body = JSON.parse(res.body);
    assert.equal(body.code, 'PGRST202');
    assert.equal(body.message,
      'Could not find the function public.add_numbers(a) in the schema cache');
    assert.equal(body.details,
      'Searched for the function public.add_numbers with parameter a or with '
      + 'a single unnamed json/jsonb parameter, but no matches were found in '
      + 'the schema cache.');
    // No hint: "a" is too far from "a, b" for upstream's 0.33 similarity
    // threshold on the parameter list. Dropping an argument gets no
    // suggestion; adding a stray one does (see RpcSpec:239).
    assert.equal(body.hint, null);
  });

  it('unknown argument returns 404 PGRST202', async () => {
    const res = await handler(event({
      method: 'POST',
      path: '/rest/v1/rpc/add_numbers',
      headers: { apikey: service, 'Content-Type': 'application/json' },
      body: { a: 3, b: 4, c: 5 },
      authorizer: { role: 'service_role' },
    }));
    assert.equal(res.statusCode, 404);
    const body = JSON.parse(res.body);
    assert.equal(body.code, 'PGRST202');
    assert.equal(body.message,
      'Could not find the function public.add_numbers(a, b, c) '
      + 'in the schema cache');
    assert.equal(body.details,
      'Searched for the function public.add_numbers with parameters a, b, c '
      + 'or with a single unnamed json/jsonb parameter, but no matches were '
      + 'found in the schema cache.');
  });

  it('function not found returns PGRST202', async () => {
    const res = await handler(event({
      method: 'POST',
      path: '/rest/v1/rpc/nonexistent',
      headers: { apikey: service, 'Content-Type': 'application/json' },
      body: {},
      authorizer: { role: 'service_role' },
    }));
    assert.equal(res.statusCode, 404);
    const body = JSON.parse(res.body);
    assert.equal(body.code, 'PGRST202');
  });

  it('HEAD on set-returning function returns 200 with no body', async () => {
    const res = await handler(event({
      method: 'HEAD',
      path: '/rest/v1/rpc/get_items',
      headers: { apikey: service },
      query: { p_user_id: testUserId },
      authorizer: { role: 'service_role' },
    }));
    assert.equal(res.statusCode, 200);
    assert.ok(!res.body || res.body === '',
      'HEAD should return no body');
    assert.ok(res.headers['Content-Type'],
      'Content-Type header should be present');
  });

  it('HEAD on scalar function returns 200 with no body', async () => {
    const res = await handler(event({
      method: 'HEAD',
      path: '/rest/v1/rpc/add_numbers',
      headers: { apikey: service },
      query: { a: '3', b: '4' },
      authorizer: { role: 'service_role' },
    }));
    assert.equal(res.statusCode, 200);
    assert.ok(!res.body || res.body === '',
      'HEAD should return no body');
  });

  it('single object mode with Accept header and 1 row', async () => {
    const uniqueName = 'UniqueItem_' + randomUUID().slice(0, 8);
    await pool.query(
      'INSERT INTO items (user_id, name) VALUES ($1, $2)',
      [testUserId, uniqueName],
    );
    const res = await handler(event({
      method: 'POST',
      path: '/rest/v1/rpc/get_items',
      headers: {
        apikey: service,
        'Content-Type': 'application/json',
        Accept: 'application/vnd.pgrst.object+json',
      },
      body: { p_user_id: testUserId },
      query: { name: `eq.${uniqueName}` },
      authorizer: { role: 'service_role' },
    }));
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(!Array.isArray(body),
      'should return a single object, not array');
    assert.equal(body.name, uniqueName);
  });

  it('single object mode with 0 rows returns PGRST116', async () => {
    const res = await handler(event({
      method: 'POST',
      path: '/rest/v1/rpc/get_items',
      headers: {
        apikey: service,
        'Content-Type': 'application/json',
        Accept: 'application/vnd.pgrst.object+json',
      },
      body: { p_user_id: randomUUID() },
      query: { name: 'eq.NoSuchItem' },
      authorizer: { role: 'service_role' },
    }));
    const body = JSON.parse(res.body);
    assert.equal(body.code, 'PGRST116');
  });

  it('single object mode with >1 rows returns PGRST116', async () => {
    const res = await handler(event({
      method: 'POST',
      path: '/rest/v1/rpc/get_items',
      headers: {
        apikey: service,
        'Content-Type': 'application/json',
        Accept: 'application/vnd.pgrst.object+json',
      },
      body: { p_user_id: testUserId },
      authorizer: { role: 'service_role' },
    }));
    const body = JSON.parse(res.body);
    assert.equal(body.code, 'PGRST116');
  });

  it('GET param disambiguation: raw values as args, operator-prefixed as filters', async () => {
    const getRes = await handler(event({
      method: 'GET',
      path: '/rest/v1/rpc/add_numbers',
      headers: { apikey: service },
      query: { a: '3', b: '4' },
      authorizer: { role: 'service_role' },
    }));
    assert.equal(getRes.statusCode, 200);
    assert.equal(JSON.parse(getRes.body), 7);

    const filterRes = await handler(event({
      method: 'GET',
      path: '/rest/v1/rpc/get_items',
      headers: { apikey: service },
      query: { p_user_id: testUserId, name: 'eq.Alice' },
      authorizer: { role: 'service_role' },
    }));
    assert.equal(filterRes.statusCode, 200);
    const rows = JSON.parse(filterRes.body);
    assert.ok(rows.length > 0);
    for (const row of rows) {
      assert.equal(row.name, 'Alice');
    }
  });

  it('capability gate: supportsRpc=false returns PGRST501', async () => {
    const gated = createTestPgrest({
      capabilities: { supportsRpc: false },
    });
    try {
      const res = await gated.handler(event({
        method: 'POST',
        path: '/rest/v1/rpc/add_numbers',
        headers: {
          apikey: service,
          'Content-Type': 'application/json',
        },
        body: { a: 3, b: 4 },
        authorizer: { role: 'service_role' },
      }));
      assert.equal(res.statusCode, 501);
      const body = JSON.parse(res.body);
      assert.equal(body.code, 'PGRST501');
    } finally {
      await gated.destroy?.();
    }
  });

  it('unsupported method PATCH returns PGRST101', async () => {
    const res = await handler(event({
      method: 'PATCH',
      path: '/rest/v1/rpc/add_numbers',
      headers: { apikey: service, 'Content-Type': 'application/json' },
      body: { a: 3, b: 4 },
      authorizer: { role: 'service_role' },
    }));
    assert.equal(res.statusCode, 405);
    const body = JSON.parse(res.body);
    assert.equal(body.code, 'PGRST101');
  });

  // A PostgreSQL function name is an arbitrary identifier, so upstream's router
  // takes the path segment verbatim (`["rpc", pName] -> TargetProc`) and lets
  // routine resolution decide whether it exists. `my-func!` is a legal name for
  // a function that simply is not there, so the answer is 404 PGRST202, not 400
  // from a router character class. (That class also made real upstream cases
  // unreachable: CustomMediaSpec:75 GET /rpc/welcome.html, :110 /rpc/welcome.xml.)
  it('unknown function name returns PGRST202, whatever characters it uses', async () => {
    const res = await handler(event({
      method: 'POST',
      path: '/rest/v1/rpc/my-func!',
      headers: { apikey: service, 'Content-Type': 'application/json' },
      body: {},
      authorizer: { role: 'service_role' },
    }));
    assert.equal(res.statusCode, 404);
    const body = JSON.parse(res.body);
    assert.equal(body.code, 'PGRST202');
  });

  // The router still refuses a path it cannot decode, because there is no
  // identifier to look up at all.
  it('malformed percent escape in the function name returns PGRST100', async () => {
    const res = await handler(event({
      method: 'POST',
      path: '/rest/v1/rpc/%zz',
      headers: { apikey: service, 'Content-Type': 'application/json' },
      body: {},
      authorizer: { role: 'service_role' },
    }));
    assert.equal(res.statusCode, 400);
    const body = JSON.parse(res.body);
    assert.equal(body.code, 'PGRST100');
  });

  // Same upstream rule as the POST case above: void means 204 and no
  // Content-Type. HEAD behaves as GET with the body dropped, so it inherits
  // the void status rather than forcing a 200.
  it('HEAD on void function returns 204 with empty body', async () => {
    const res = await handler(event({
      method: 'HEAD',
      path: '/rest/v1/rpc/do_nothing',
      headers: { apikey: service },
      authorizer: { role: 'service_role' },
    }));
    assert.equal(res.statusCode, 204);
    assert.ok(!res.body || res.body === '',
      'HEAD on void should return empty body');
    assert.equal(res.headers['Content-Type'], undefined,
      'void function must not send Content-Type');
  });

  it('single object mode on non-set composite function', async () => {
    const res = await handler(event({
      method: 'POST',
      path: '/rest/v1/rpc/get_first_item',
      headers: {
        apikey: service,
        'Content-Type': 'application/json',
        Accept: 'application/vnd.pgrst.object+json',
      },
      body: {},
      authorizer: { role: 'service_role' },
    }));
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(!Array.isArray(body),
      'non-set composite with singleObject should return object');
    assert.ok(body && typeof body === 'object',
      'body should be a JSON object');
  });

  it('GET with dotted value classified as arg', async () => {
    const res = await handler(event({
      method: 'GET',
      path: '/rest/v1/rpc/greet',
      headers: { apikey: service },
      query: { name: 'john.doe' },
      authorizer: { role: 'service_role' },
    }));
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body, 'Hello, john.doe',
      '"john.doe" should be treated as a function argument, '
      + 'not misclassified as a filter operator prefix');
  });

  it('dev-mode log emitted before execution', async () => {
    const spy = captureConsole('info');
    try {
      await handler(event({
        method: 'POST',
        path: '/rest/v1/rpc/add_numbers',
        headers: { apikey: service, 'Content-Type': 'application/json' },
        body: { a: 1, b: 2 },
        authorizer: { role: 'service_role' },
      }));
      const match = spy.calls.find(
        (c) => typeof c[0] === 'string' && c[0].includes('rpc: add_numbers('),
      );
      assert.ok(match, 'console.info should log the RPC call');
    } finally {
      spy.restore();
    }
  });

  describe('Cedar permit/forbid', () => {
    // Cedar integration tests are more complex because they require
    // custom policy files. We verify the basic authorization path:
    // service_role should be permitted on all functions.
    it('service_role can call any function', async () => {
      const res = await handler(event({
        method: 'POST',
        path: '/rest/v1/rpc/add_numbers',
        headers: { apikey: service, 'Content-Type': 'application/json' },
        body: { a: 3, b: 4 },
        authorizer: { role: 'service_role' },
      }));
      assert.equal(res.statusCode, 200);
    });

    it('service_role can call void function', async () => {
      const res = await handler(event({
        method: 'POST',
        path: '/rest/v1/rpc/do_nothing',
        headers: { apikey: service, 'Content-Type': 'application/json' },
        body: {},
        authorizer: { role: 'service_role' },
      }));
      // 204 is the authorized outcome for a void function (see the void test
      // above and upstream RpcSpec.hs:470); the point of this case is that the
      // call is permitted, i.e. not 401/403.
      assert.equal(res.statusCode, 204);
    });
  });
});
