import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

import {
  startPostgres, stopPostgres, createPool, resetDatabase,
} from '../harness/db.mjs';
import { createTestPgrest } from '../harness/pgrest.mjs';
import { startDevServer } from '../harness/server.mjs';

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
`;

describe('e2e: supabase-js .rpc() calls', () => {
  let pool, server, destroyPgrest, baseUrl, service;
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

    const ctx = createTestPgrest({ baseUrl: 'http://127.0.0.1:0/v1' });
    destroyPgrest = ctx.destroy;
    service = ctx.service;

    server = await startDevServer(ctx.handler);
    baseUrl = server.baseUrl;
  });

  afterEach(async () => {
    if (server) await server.stop();
    if (destroyPgrest) await destroyPgrest();
  });

  function makeClient(apikey = service) {
    return createClient(baseUrl, apikey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  it('scalar via supabase-js: rpc("add_numbers", {a:3, b:4}) returns 7', async () => {
    const supabase = makeClient();
    const { data, error } = await supabase.rpc('add_numbers', {
      a: 3, b: 4,
    });
    assert.equal(error, null, error?.message);
    assert.equal(data, 7);
  });

  it('set-returning with chained filters', async () => {
    const supabase = makeClient();
    const { data, error } = await supabase
      .rpc('get_items', { p_user_id: testUserId })
      .order('name')
      .limit(5);
    assert.equal(error, null, error?.message);
    assert.ok(Array.isArray(data), 'should return array');
    assert.ok(data.length <= 5);
  });

  it('error case: rpc("nonexistent") returns PGRST202', async () => {
    const supabase = makeClient();
    const { data, error } = await supabase.rpc('nonexistent');
    assert.ok(error, 'should have error');
    assert.equal(error.code, 'PGRST202');
  });

  it('void function: rpc("do_nothing") returns null or empty', async () => {
    const supabase = makeClient();
    const { data, error } = await supabase.rpc('do_nothing');
    assert.equal(error, null, error?.message);
    assert.ok(data === null || data === '' || data === undefined,
      'void function should return null or empty');
  });

  it('default arguments: rpc("with_default", {x: 5}) returns 15', async () => {
    const supabase = makeClient();
    const { data, error } = await supabase.rpc('with_default', { x: 5 });
    assert.equal(error, null, error?.message);
    assert.equal(data, 15);
  });
});
