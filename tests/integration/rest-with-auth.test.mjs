import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  startPostgres, stopPostgres, createPool, resetDatabase,
} from '../harness/db.mjs';
import { createTestPgrest, event } from '../harness/pgrest.mjs';

describe('REST + auth integration', () => {
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

  async function signUpAndGetUser(email) {
    const r = await handler(event({
      method: 'POST',
      path: '/auth/v1/signup',
      headers: { apikey: anon, 'Content-Type': 'application/json' },
      body: { email, password: 'Passw0rd!' },
    }));
    return JSON.parse(r.body);
  }

  function asUser(s) {
    return { role: 'authenticated', userId: s.user.id, email: s.user.email };
  }

  it('insert then select a row as an authenticated user', async () => {
    const s = await signUpAndGetUser('u1@example.com');
    const ins = await handler(event({
      method: 'POST',
      path: '/rest/v1/notes',
      headers: {
        apikey: anon,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: { user_id: s.user.id, body: 'hello' },
      authorizer: asUser(s),
    }));
    assert.equal(ins.statusCode, 201);
    const inserted = JSON.parse(ins.body);
    assert.equal(inserted[0].body, 'hello');
    assert.equal(inserted[0].user_id, s.user.id);

    const sel = await handler(event({
      method: 'GET',
      path: '/rest/v1/notes',
      headers: { apikey: anon },
      query: { user_id: `eq.${s.user.id}`, select: '*' },
      authorizer: asUser(s),
    }));
    assert.equal(sel.statusCode, 200);
    const rows = JSON.parse(sel.body);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].body, 'hello');
  });

  describe('select column aliases', () => {
    it('aliases a column in the response JSON', async () => {
      const s = await signUpAndGetUser('alias1@example.com');
      await handler(event({
        method: 'POST',
        path: '/rest/v1/notes',
        headers: { apikey: anon, 'Content-Type': 'application/json' },
        body: { user_id: s.user.id, body: 'alias test' },
        authorizer: asUser(s),
      }));

      const sel = await handler(event({
        method: 'GET',
        path: '/rest/v1/notes',
        headers: { apikey: anon },
        query: { select: 'id,content:body', user_id: `eq.${s.user.id}` },
        authorizer: asUser(s),
      }));
      assert.equal(sel.statusCode, 200);
      const rows = JSON.parse(sel.body);
      assert.equal(rows.length, 1);
      assert.ok('content' in rows[0], 'should have aliased key "content"');
      assert.ok(!('body' in rows[0]), 'should not have raw column key "body"');
      assert.equal(rows[0].content, 'alias test');
    });

    it('rejects duplicate select keys', async () => {
      const s = await signUpAndGetUser('alias2@example.com');
      const sel = await handler(event({
        method: 'GET',
        path: '/rest/v1/notes',
        headers: { apikey: anon },
        query: { select: 'a:id,a:user_id' },
        authorizer: asUser(s),
      }));
      assert.equal(sel.statusCode, 400);
      const err = JSON.parse(sel.body);
      assert.equal(err.code, 'PGRST100');
      assert.ok(err.message.includes('Duplicate select key'));
    });

    it('rejects an alias that is not a valid identifier', async () => {
      const s = await signUpAndGetUser('alias3@example.com');
      const sel = await handler(event({
        method: 'GET',
        path: '/rest/v1/notes',
        headers: { apikey: anon },
        query: { select: '123bad:body' },
        authorizer: asUser(s),
      }));
      assert.equal(sel.statusCode, 400);
      const err = JSON.parse(sel.body);
      assert.equal(err.code, 'PGRST100');
      assert.ok(err.message.includes('not a valid identifier'));
    });

    it('rejects an alias referencing a nonexistent column', async () => {
      const s = await signUpAndGetUser('alias4@example.com');
      const sel = await handler(event({
        method: 'GET',
        path: '/rest/v1/notes',
        headers: { apikey: anon },
        query: { select: 'id,firstName:nonexistent' },
        authorizer: asUser(s),
      }));
      assert.equal(sel.statusCode, 400);
      const err = JSON.parse(sel.body);
      assert.equal(err.code, 'PGRST204');
      assert.ok(err.message.includes('does not exist'));
    });
  });

  it('two users do not see each other\'s rows via filter', async () => {
    const alice = await signUpAndGetUser('alice@example.com');
    const bob = await signUpAndGetUser('bob@example.com');

    for (const { s, text } of [
      { s: alice, text: 'alice note' },
      { s: bob, text: 'bob note' },
    ]) {
      await handler(event({
        method: 'POST',
        path: '/rest/v1/notes',
        headers: { apikey: anon, 'Content-Type': 'application/json' },
        body: { user_id: s.user.id, body: text },
        authorizer: asUser(s),
      }));
    }

    const sel = await handler(event({
      method: 'GET',
      path: '/rest/v1/notes',
      headers: { apikey: anon },
      query: { user_id: `eq.${alice.user.id}`, select: '*' },
      authorizer: asUser(alice),
    }));
    const rows = JSON.parse(sel.body);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].body, 'alice note');
  });
});
