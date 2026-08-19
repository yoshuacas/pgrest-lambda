// Standard-Postgres embedding, resolved from real foreign keys.
//
// The conformance target (Aurora DSQL) cannot store foreign keys, so every
// conformance measurement feeds the engine a declared-relationship manifest
// (PGREST_RELATIONSHIPS_PATH). That leaves the catalog path — pg_constraint
// with contype='f' — measured by nothing. This file measures it: no manifest
// is configured anywhere below, so every embed here can only work if
// FK_SQL introspection and relationship resolution are intact.
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { startPostgres, stopPostgres, createPool, resetDatabase } from '../harness/db.mjs';
import { createTestPgrest, event } from '../harness/pgrest.mjs';

const SCHEMA = `
CREATE TABLE authors (
  id BIGINT PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE books (
  id BIGINT PRIMARY KEY,
  title TEXT NOT NULL,
  author_id BIGINT REFERENCES authors(id),
  editor_id BIGINT REFERENCES authors(id)
);

CREATE TABLE tags (
  id BIGINT PRIMARY KEY,
  label TEXT NOT NULL
);

-- Junction: two FKs and a composite primary key make this a many-to-many
-- between books and tags.
CREATE TABLE book_tags (
  book_id BIGINT NOT NULL REFERENCES books(id),
  tag_id BIGINT NOT NULL REFERENCES tags(id),
  PRIMARY KEY (book_id, tag_id)
);

INSERT INTO authors (id, name) VALUES (1, 'Borges'), (2, 'Calvino');
INSERT INTO books (id, title, author_id, editor_id) VALUES
  (10, 'Ficciones', 1, 2),
  (11, 'Invisible Cities', 2, NULL);
INSERT INTO tags (id, label) VALUES (100, 'fiction'), (101, 'essays');
INSERT INTO book_tags (book_id, tag_id) VALUES (10, 100), (10, 101), (11, 100);
`;

describe('REST embedding over real foreign keys (standard Postgres)', () => {
  let pool, handler, anon, service, destroy;

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
    await pool.query(SCHEMA);
    // pgrest is built after the DDL so the first introspection sees the FKs.
    const ctx = createTestPgrest({ baseUrl: 'http://localhost:3000/v1' });
    handler = ctx.handler;
    anon = ctx.anon;
    service = ctx.service;
    destroy = ctx.destroy;
  });

  afterEach(async () => {
    if (destroy) await destroy();
  });

  async function get(path, query) {
    const res = await handler(event({
      method: 'GET',
      path: `/rest/v1/${path}`,
      headers: { apikey: service, Authorization: `Bearer ${service}` },
      query,
      authorizer: { role: 'service_role', userId: '', email: '' },
    }));
    return { status: res.statusCode, headers: res.headers, body: JSON.parse(res.body) };
  }

  it('introspects foreign keys from pg_constraint', async () => {
    const ctx = createTestPgrest({ baseUrl: 'http://localhost:3000/v1' });
    try {
      const pool = await ctx.pgrest._db.getPool();
      const schema = await ctx.pgrest._schemaCache.getSchema(pool);
      const rels = schema.relationships;
      assert.ok(Array.isArray(rels) && rels.length >= 4,
        `expected >= 4 catalog relationships, got ${rels?.length}`);
      assert.ok(rels.some((r) => r.source === 'catalog'),
        'relationships must come from pg_constraint, not a manifest');
      assert.ok(rels.some((r) => r.fromTable === 'books' && r.toTable === 'authors'
        && r.fromColumns[0] === 'author_id'),
        'books.author_id -> authors.id recovered from the catalog');
      assert.ok(rels.some((r) => r.fromTable === 'books' && r.toTable === 'authors'
        && r.fromColumns[0] === 'editor_id'),
        'books.editor_id -> authors.id kept as a distinct relationship');
    } finally {
      await ctx.destroy();
    }
  });

  it('embeds many-to-one by constraint hint', async () => {
    const r = await get('books', {
      select: 'title,authors!books_author_id_fkey(name)',
      order: 'id',
    });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, [
      { title: 'Ficciones', authors: { name: 'Borges' } },
      { title: 'Invisible Cities', authors: { name: 'Calvino' } },
    ]);
  });

  it('embeds one-to-many as an array', async () => {
    const r = await get('authors', {
      select: 'name,books!books_author_id_fkey(title)',
      order: 'id',
    });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, [
      { name: 'Borges', books: [{ title: 'Ficciones' }] },
      { name: 'Calvino', books: [{ title: 'Invisible Cities' }] },
    ]);
  });

  it('disambiguates two foreign keys to the same table by column hint', async () => {
    const r = await get('books', {
      select: 'title,editor:authors!books_editor_id_fkey(name)',
      order: 'id',
    });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, [
      { title: 'Ficciones', editor: { name: 'Calvino' } },
      { title: 'Invisible Cities', editor: null },
    ]);
  });

  it('reports PGRST201 when two foreign keys make the embed ambiguous', async () => {
    // books has two FKs to authors (author_id, editor_id), so a bare
    // `authors(...)` is ambiguous. Upstream answers 300 PGRST201 and lists the
    // candidates in `details` (Error.hs:227,238,245,258,277).
    const r = await get('books', { select: 'title,authors(name)' });
    assert.equal(r.status, 300);
    assert.equal(r.body.code, 'PGRST201');
    assert.equal(r.body.message,
      "Could not embed because more than one relationship was found for 'books' and 'authors'");
    assert.ok(Array.isArray(r.body.details) && r.body.details.length >= 2,
      'details lists every candidate relationship');
    const constraints = r.body.details.map((d) => d.relationship).join(' ');
    assert.match(constraints, /books_author_id_fkey/);
    assert.match(constraints, /books_editor_id_fkey/);
    assert.match(r.body.hint, /Try changing 'authors' to one of the following/);
  });

  it('reports PGRST200 for a relation with no foreign key path', async () => {
    const r = await get('authors', { select: 'name,tags(label)' });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'PGRST200');
    assert.match(r.body.message, /Could not find a relationship/);
  });

  it('embeds many-to-many through a junction table', async () => {
    const r = await get('books', { select: 'title,tags(label)', order: 'id' });
    assert.equal(r.status, 200);
    const ficciones = r.body.find((b) => b.title === 'Ficciones');
    assert.ok(ficciones, 'Ficciones present');
    const labels = ficciones.tags.map((t) => t.label).sort();
    assert.deepEqual(labels, ['essays', 'fiction']);
  });

  it('!inner drops parent rows with no match and Content-Range agrees', async () => {
    const r = await handler(event({
      method: 'GET',
      path: '/rest/v1/books',
      headers: {
        apikey: service,
        Authorization: `Bearer ${service}`,
        Prefer: 'count=exact',
      },
      query: { select: 'title,editor:authors!books_editor_id_fkey!inner(name)' },
      authorizer: { role: 'service_role', userId: '', email: '' },
    }));
    assert.equal(r.statusCode, 200);
    const body = JSON.parse(r.body);
    assert.equal(body.length, 1, 'only the book with an editor survives !inner');
    assert.equal(body[0].title, 'Ficciones');
    assert.match(r.headers['Content-Range'] || r.headers['content-range'], /\/1$/);
  });

  it('spread embed lifts the child columns into the parent object', async () => {
    const r = await get('books', {
      select: 'title,...authors!books_author_id_fkey(name)',
      order: 'id',
    });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, [
      { title: 'Ficciones', name: 'Borges' },
      { title: 'Invisible Cities', name: 'Calvino' },
    ]);
  });

  it('filters on an embedded column', async () => {
    const r = await get('books', {
      select: 'title,authors!books_author_id_fkey!inner(name)',
      'authors.name': 'eq.Borges',
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.length, 1);
    assert.equal(r.body[0].title, 'Ficciones');
  });

  it('orders the parent by an embedded column', async () => {
    const r = await get('books', {
      select: 'title,authors!books_author_id_fkey(name)',
      order: 'authors(name).desc',
    });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.map((b) => b.title), ['Invisible Cities', 'Ficciones']);
  });

  it('mutation with return=representation projects an embed', async () => {
    const res = await handler(event({
      method: 'POST',
      path: '/rest/v1/books',
      headers: {
        apikey: service,
        Authorization: `Bearer ${service}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      query: { select: 'title,authors!books_author_id_fkey(name)' },
      body: { id: 12, title: 'Labyrinths', author_id: 1 },
      authorizer: { role: 'service_role', userId: '', email: '' },
    }));
    assert.equal(res.statusCode, 201);
    assert.deepEqual(JSON.parse(res.body), [
      { title: 'Labyrinths', authors: { name: 'Borges' } },
    ]);
  });

  it('anon reads are still governed by the policy layer', async () => {
    const res = await handler(event({
      method: 'GET',
      path: '/rest/v1/books',
      headers: { apikey: anon },
      query: { select: 'title' },
      authorizer: { role: 'anon', userId: '', email: '' },
    }));
    // Whatever the default policy decides, it must decide — not crash.
    assert.ok([200, 401, 403].includes(res.statusCode),
      `unexpected status ${res.statusCode}: ${res.body}`);
  });
});
