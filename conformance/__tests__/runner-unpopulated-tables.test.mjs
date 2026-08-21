// Runner: the tables the fixtures CREATE and 07-data.sql never populates.
//
// Re-applying 07-data.sql restores only the tables that file writes to. A table
// it never writes to is empty after a fixture load and nothing clears it again,
// so a row a mutating case inserts there outlives the run: InsertSpec:596
// inserts k='棋圍' into simple_pk2 and asserts 201, which passed once and then
// failed 23505 on every later run against the same cluster. The reset paths
// empty those tables, and this file pins the derivation and the sweep.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseCreatedTables, unpopulatedTables, clearUnpopulatedTables,
} from '../runner/run.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(HERE, '..', 'fixtures', 'dsql');

const SCHEMA = `
SET search_path = public, pg_catalog;

CREATE TABLE items (id bigint primary key);
CREATE TABLE simple_pk2 (k text primary key, extra text);
CREATE UNLOGGED TABLE scratch (id int);
CREATE TABLE IF NOT EXISTS maybe (id int);
CREATE VIEW items_view AS SELECT * FROM items;

SET search_path = private, pg_catalog;

CREATE TABLE junction (a int, b int);
CREATE TABLE public.qualified (id int);

SET search_path = "public", pg_catalog;

CREATE TABLE "Foo" (id int);
CREATE INDEX ON items (id);
`;

const DATA = `
SET search_path = public, pg_catalog;

DELETE FROM items;
INSERT INTO items VALUES (1);

SET search_path = private, pg_catalog;

DELETE FROM junction;
INSERT INTO junction VALUES (1, 2);
`;

describe('parseCreatedTables', () => {
  it('names every created table, qualified by the block search_path', () => {
    assert.deepEqual(parseCreatedTables(SCHEMA), [
      'public.items', 'public.simple_pk2', 'public.scratch', 'public.maybe',
      'private.junction', 'public.qualified', 'public.Foo',
    ]);
  });

  it('leaves views, indexes and other objects out', () => {
    const keys = parseCreatedTables(SCHEMA);
    assert.ok(!keys.includes('public.items_view'), 'view');
    assert.equal(parseCreatedTables(
      'CREATE VIEW v AS SELECT 1; CREATE FUNCTION f() RETURNS int AS $$'
      + ' SELECT 1 $$ LANGUAGE sql;').length, 0);
  });

  it('is empty for SQL that creates nothing', () => {
    assert.deepEqual(parseCreatedTables(''), []);
    assert.deepEqual(parseCreatedTables('-- nothing here\n'), []);
  });
});

describe('unpopulatedTables', () => {
  it('is the created tables minus the ones 07-data.sql writes to', () => {
    assert.deepEqual(unpopulatedTables([SCHEMA], DATA), [
      'public.simple_pk2', 'public.scratch', 'public.maybe',
      'public.qualified', 'public.Foo',
    ]);
  });

  it('matches a table across files by schema as well as name', () => {
    // private.junction is populated; a public.junction would not be.
    const keys = unpopulatedTables(
      ['SET search_path = public, pg_catalog;\nCREATE TABLE junction (a int);'],
      DATA);
    assert.deepEqual(keys, ['public.junction']);
  });

  it('reports each table once when several files create it', () => {
    assert.deepEqual(
      unpopulatedTables([
        'CREATE TABLE leak (id int);',
        'CREATE TABLE IF NOT EXISTS leak (id int);',
      ], ''),
      ['public.leak']);
  });

  it('derives the real fixture set from the fixture SQL', () => {
    const files = readdirSync(FIXTURE_DIR).filter(f => f.endsWith('.sql')).sort();
    const keys = unpopulatedTables(
      files.map(f => readFileSync(join(FIXTURE_DIR, f), 'utf8')),
      readFileSync(join(FIXTURE_DIR, '07-data.sql'), 'utf8'));
    // The worked example: 03-schema.sql creates it, 07-data.sql never fills it.
    assert.ok(keys.includes('public.simple_pk2'), 'simple_pk2');
    // A table 07-data.sql fills is restored by the reload, not emptied.
    assert.ok(!keys.includes('public.items'), 'items');
    assert.ok(!keys.includes('public.projects'), 'projects');
    // Non-public schemas are covered too.
    assert.ok(keys.includes('private.junction'), 'private.junction');
    assert.ok(keys.length > 50 && keys.length < 120, `count ${keys.length}`);
  });
});

describe('clearUnpopulatedTables', () => {
  function fakePool(counts) {
    const calls = [];
    return {
      calls,
      query(text, values) {
        calls.push({ text, values });
        if (/^select \(select count/.test(text)) {
          const row = {};
          // One column per probed table, in the order the query built them.
          [...text.matchAll(/as c(\d+)/g)].forEach((m, i) => {
            row[`c${m[1]}`] = String(counts[i] ?? 0);
          });
          return Promise.resolve({ rows: [row] });
        }
        return Promise.resolve({ rows: [] });
      },
    };
  }

  const catalog = {
    tables: new Set(['public.simple_pk2', 'public.leak', 'private.junction']),
  };

  it('probes every table in one query and deletes only the dirty ones',
    async () => {
      const pool = fakePool([0, 3, 0]);
      const out = await clearUnpopulatedTables(pool, catalog,
        ['public.simple_pk2', 'public.leak', 'private.junction']);
      assert.deepEqual(out, { checked: 3, cleared: ['public.leak'], rows: 3 });
      assert.equal(pool.calls.length, 2);
      assert.match(pool.calls[0].text,
        /^select \(select count\(\*\) from "public"\."simple_pk2"\) as c0/);
      assert.equal(pool.calls[1].text, 'DELETE FROM "public"."leak"');
    });

  it('deletes nothing when every table is already empty', async () => {
    const pool = fakePool([0, 0, 0]);
    const out = await clearUnpopulatedTables(pool, catalog,
      ['public.simple_pk2', 'public.leak', 'private.junction']);
    assert.deepEqual(out.cleared, []);
    assert.equal(out.rows, 0);
    assert.equal(pool.calls.length, 1, 'one probe, no deletes');
  });

  it('skips a key the live catalog has no table for', async () => {
    // The fixture SQL creates tables DSQL rejects; a DELETE from one of those
    // would abort the reset with 42P01.
    const pool = fakePool([2]);
    const out = await clearUnpopulatedTables(pool, catalog,
      ['public.dropped_by_dsql', 'public.leak']);
    assert.equal(out.checked, 1);
    assert.deepEqual(out.cleared, ['public.leak']);
    assert.ok(!pool.calls.some(c => /dropped_by_dsql/.test(c.text)));
  });

  it('does nothing at all when nothing is in scope', async () => {
    const pool = fakePool([]);
    const out = await clearUnpopulatedTables(pool, catalog, []);
    assert.deepEqual(out, { checked: 0, cleared: [], rows: 0 });
    assert.equal(pool.calls.length, 0);
  });

  it('quotes identifiers rather than interpolating them raw', async () => {
    const pool = fakePool([1]);
    await clearUnpopulatedTables(
      pool, { tables: new Set(['public.he"re']) }, ['public.he"re']);
    assert.match(pool.calls[0].text, /"public"\."he""re"/);
    assert.equal(pool.calls[1].text, 'DELETE FROM "public"."he""re"');
  });
});
