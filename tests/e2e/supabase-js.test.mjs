import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';

import {
  startPostgres, stopPostgres, createPool, resetDatabase,
} from '../harness/db.mjs';
import { createTestPgrest } from '../harness/pgrest.mjs';
import { startDevServer } from '../harness/server.mjs';

describe('e2e: supabase-js against dev-server', () => {
  let pool, server, destroyPgrest, baseUrl, anon;

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

    // Start a dev server first to get a real port, then build pgrest
    // with that URL as the better-auth baseURL. We have a chicken/egg
    // problem because we need the handler to pass to the server and
    // the server's port to pass to the handler. Resolve by starting the
    // server with a placeholder handler, then re-creating pgrest.
    const placeholder = () => ({ statusCode: 503, body: '' });
    const tmp = await startDevServer(placeholder);
    baseUrl = tmp.baseUrl;
    await tmp.stop();

    const ctx = createTestPgrest({ baseUrl: `${baseUrl}/v1` });
    destroyPgrest = ctx.destroy;
    anon = ctx.anon;

    server = await startDevServer(ctx.handler);
    baseUrl = server.baseUrl;
  });

  afterEach(async () => {
    if (server) await server.stop();
    if (destroyPgrest) await destroyPgrest();
  });

  function makeClient(apikey = anon) {
    return createClient(baseUrl, apikey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  it('signUp returns a session with matching user', async () => {
    const supabase = makeClient();
    const { data, error } = await supabase.auth.signUp({
      email: 'sb1@example.com',
      password: 'Passw0rd!',
    });
    assert.equal(error, null, error?.message);
    assert.ok(data.session?.access_token, 'access_token returned');
    assert.equal(data.user.email, 'sb1@example.com');
  });

  it('signInWithPassword returns a session after prior signup', async () => {
    const supabase = makeClient();
    await supabase.auth.signUp({
      email: 'sb2@example.com', password: 'Passw0rd!',
    });
    const { data, error } = await supabase.auth.signInWithPassword({
      email: 'sb2@example.com', password: 'Passw0rd!',
    });
    assert.equal(error, null, error?.message);
    assert.ok(data.session?.access_token);
    assert.equal(data.user.email, 'sb2@example.com');
  });

  it('getUser returns the authenticated user profile', async () => {
    const supabase = makeClient();
    const { data: signup } = await supabase.auth.signUp({
      email: 'sb3@example.com', password: 'Passw0rd!',
    });
    await supabase.auth.setSession({
      access_token: signup.session.access_token,
      refresh_token: signup.session.refresh_token,
    });
    const { data, error } = await supabase.auth.getUser();
    assert.equal(error, null, error?.message);
    assert.equal(data.user.email, 'sb3@example.com');
  });

  it('from(notes).insert() then select() returns the inserted row', async () => {
    const supabase = makeClient();
    const { data: signup } = await supabase.auth.signUp({
      email: 'sb4@example.com', password: 'Passw0rd!',
    });
    await supabase.auth.setSession({
      access_token: signup.session.access_token,
      refresh_token: signup.session.refresh_token,
    });

    const { data: inserted, error: insertErr } = await supabase
      .from('notes')
      .insert({ user_id: signup.user.id, body: 'hello from supabase-js' })
      .select()
      .single();
    assert.equal(insertErr, null, insertErr?.message);
    assert.equal(inserted.body, 'hello from supabase-js');

    const { data: rows, error: selErr } = await supabase
      .from('notes')
      .select('*')
      .eq('user_id', signup.user.id);
    assert.equal(selErr, null, selErr?.message);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].body, 'hello from supabase-js');
  });

  it('select with column alias returns aliased keys', async () => {
    const supabase = makeClient();
    const { data: signup } = await supabase.auth.signUp({
      email: 'sb-alias@example.com', password: 'Passw0rd!',
    });
    await supabase.auth.setSession({
      access_token: signup.session.access_token,
      refresh_token: signup.session.refresh_token,
    });

    await supabase
      .from('notes')
      .insert({ user_id: signup.user.id, body: 'alias e2e' });

    const { data, error } = await supabase
      .from('notes')
      .select('id, author:user_id')
      .eq('user_id', signup.user.id);
    assert.equal(error, null, error?.message);
    assert.ok(data.length > 0, 'should have at least one row');
    assert.ok(data[0].author !== undefined, 'should have aliased key');
    assert.ok(data[0].user_id === undefined, 'should not have raw column key');
  });

  it('select with cast: bigint id to text', async () => {
    const supabase = makeClient();
    const { data: signup } = await supabase.auth.signUp({
      email: 'sb-cast1@example.com', password: 'Passw0rd!',
    });
    await supabase.auth.setSession({
      access_token: signup.session.access_token,
      refresh_token: signup.session.refresh_token,
    });

    await supabase
      .from('notes')
      .insert({ user_id: signup.user.id, body: 'cast test' });

    const { data, error } = await supabase
      .from('notes')
      .select('id::text, body')
      .eq('user_id', signup.user.id);
    assert.equal(error, null, error?.message);
    assert.ok(data.length > 0, 'should have rows');
    assert.equal(typeof data[0].id, 'string',
      'bigint id should be a string after cast');
  });

  it('select with alias + cast', async () => {
    const supabase = makeClient();
    const { data: signup } = await supabase.auth.signUp({
      email: 'sb-cast2@example.com', password: 'Passw0rd!',
    });
    await supabase.auth.setSession({
      access_token: signup.session.access_token,
      refresh_token: signup.session.refresh_token,
    });

    await supabase
      .from('notes')
      .insert({ user_id: signup.user.id, body: 'alias cast' });

    const { data, error } = await supabase
      .from('notes')
      .select('noteId:id::text, body')
      .eq('user_id', signup.user.id);
    assert.equal(error, null, error?.message);
    assert.ok(data.length > 0, 'should have rows');
    assert.ok(data[0].noteId !== undefined,
      'should have aliased key');
    assert.ok(data[0].id === undefined,
      'should not have raw column key');
    assert.equal(typeof data[0].noteId, 'string',
      'noteId should be a string');
  });

  it('select with timestamp to date cast', async () => {
    const supabase = makeClient();
    const { data: signup } = await supabase.auth.signUp({
      email: 'sb-cast3@example.com', password: 'Passw0rd!',
    });
    await supabase.auth.setSession({
      access_token: signup.session.access_token,
      refresh_token: signup.session.refresh_token,
    });

    await supabase
      .from('notes')
      .insert({ user_id: signup.user.id, body: 'date cast' });

    const { data, error } = await supabase
      .from('notes')
      .select('id, created_at::date')
      .eq('user_id', signup.user.id);
    assert.equal(error, null, error?.message);
    assert.ok(data.length > 0, 'should have rows');
    // The cast ran server-side: `created_at::date` produces a
    // `date` value. The pg driver parses Postgres `date` into a
    // JS Date at local midnight, which ISO-serializes with the
    // local TZ offset (e.g., 00:00 PT → 07:00Z). Verify the
    // cast produced a midnight-in-some-tz value rather than
    // matching an exact string shape.
    const parsed = new Date(data[0].created_at);
    const isUtcMidnight = parsed.getUTCHours() === 0
      && parsed.getUTCMinutes() === 0
      && parsed.getUTCSeconds() === 0;
    const isLocalMidnight = parsed.getHours() === 0
      && parsed.getMinutes() === 0
      && parsed.getSeconds() === 0;
    assert.ok(isUtcMidnight || isLocalMidnight,
      `expected midnight in UTC or local TZ; got ${data[0].created_at}`);
  });

  it('signOut ends the session', async () => {
    const supabase = makeClient();
    const { data: signup } = await supabase.auth.signUp({
      email: 'sb5@example.com', password: 'Passw0rd!',
    });
    await supabase.auth.setSession({
      access_token: signup.session.access_token,
      refresh_token: signup.session.refresh_token,
    });
    const { error } = await supabase.auth.signOut();
    assert.equal(error, null, error?.message);
  });
});
