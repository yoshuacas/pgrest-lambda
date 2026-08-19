// Boot-time parsing of the engine configuration surface (upstream names:
// db-schemas, db-extra-search-path, db-pre-request, the bulk-mutation guard)
// and the two pieces that make a non-public exposed schema work: the
// relationship manifest view and the introspection pool wrapper.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseList, parsePreRequest, parseBulkMutationGuard, relationshipsForSchema,
  schemaIntrospectionPool,
} from '../index.mjs';

describe('parseList (db-schemas, db-extra-search-path, cors origins)', () => {
  it('falls back when unset', () => {
    assert.deepEqual(parseList(undefined, ['public']), ['public']);
    assert.deepEqual(parseList(null, ['public']), ['public']);
  });

  it('splits on commas and trims', () => {
    assert.deepEqual(parseList(' v1 , v2 ', ['public']), ['v1', 'v2']);
  });

  it('drops empty entries and falls back when nothing is left', () => {
    assert.deepEqual(parseList(' , ', ['public']), ['public']);
    assert.deepEqual(parseList('a,,b', []), ['a', 'b']);
  });

  it('accepts an array as given', () => {
    assert.deepEqual(parseList(['v1', ' v2 '], []), ['v1', 'v2']);
  });

  it('keeps a name that needs quoting intact', () => {
    assert.deepEqual(parseList('SPECIAL "@/\\#~_-', []),
      ['SPECIAL "@/\\#~_-']);
  });
});

describe('parsePreRequest (db-pre-request)', () => {
  it('is null when unset', () => {
    assert.equal(parsePreRequest(undefined), null);
    assert.equal(parsePreRequest(''), null);
  });

  it('parses a bare function name', () => {
    assert.deepEqual(parsePreRequest('custom_headers'),
      { schema: null, name: 'custom_headers' });
  });

  it('parses a schema-qualified name', () => {
    assert.deepEqual(parsePreRequest('test.custom_headers'),
      { schema: 'test', name: 'custom_headers' });
  });

  it('accepts non-ASCII letters', () => {
    assert.deepEqual(parsePreRequest('تست.f'), { schema: 'تست', name: 'f' });
  });

  it('rejects anything that is not one or two identifiers', () => {
    for (const bad of [
      'a.b.c', 'select 1', 'f()', 'f;drop table x', '1f', 'a b', 'sch."f"',
    ]) {
      assert.throws(() => parsePreRequest(bad), /db-pre-request/, bad);
    }
  });
});

describe('parseBulkMutationGuard', () => {
  it('defaults to on', () => {
    assert.equal(parseBulkMutationGuard(undefined), 'on');
    assert.equal(parseBulkMutationGuard(''), 'on');
    assert.equal(parseBulkMutationGuard(null), 'on');
  });

  it('accepts the three modes in any case', () => {
    assert.equal(parseBulkMutationGuard('off'), 'off');
    assert.equal(parseBulkMutationGuard('SafeUpdate'), 'safeupdate');
    assert.equal(parseBulkMutationGuard(' ON '), 'on');
  });

  it('accepts booleans and boolean-ish strings', () => {
    assert.equal(parseBulkMutationGuard(true), 'on');
    assert.equal(parseBulkMutationGuard(false), 'off');
    assert.equal(parseBulkMutationGuard('1'), 'on');
    assert.equal(parseBulkMutationGuard('false'), 'off');
  });

  it('rejects an unknown mode at boot', () => {
    assert.throws(() => parseBulkMutationGuard('maybe'),
      /must be one of on, off, safeupdate/);
  });
});

describe('relationshipsForSchema', () => {
  const manifest = {
    relationships: [
      { constraint: 'a', schema: 'public', table: 't', foreignTable: 'u' },
      {
        constraint: 'b', schema: 'v1', table: 'child',
        foreignSchema: 'v1', foreignTable: 'parent',
      },
      {
        constraint: 'c', schema: 'v1', table: 'child',
        foreignSchema: 'v2', foreignTable: 'parent',
      },
    ],
  };

  it('passes public through untouched', () => {
    assert.equal(relationshipsForSchema(manifest, 'public'), manifest);
  });

  it('is undefined for public when there is no manifest', () => {
    assert.equal(relationshipsForSchema(null, 'public'), undefined);
  });

  it('keeps only relationships local to the schema and relabels them', () => {
    const out = relationshipsForSchema(manifest, 'v1');
    assert.equal(out.length, 1);
    assert.equal(out[0].constraint, 'b');
    assert.equal(out[0].schema, 'public');
    assert.equal(out[0].foreignSchema, 'public');
    assert.equal(out[0].table, 'child');
  });

  it('treats a missing schema as public', () => {
    const out = relationshipsForSchema(
      [{ constraint: 'a', table: 't', foreignTable: 'u' }], 'v1');
    assert.deepEqual(out, []);
  });

  it('accepts a bare array manifest', () => {
    const out = relationshipsForSchema(manifest.relationships, 'v2');
    assert.deepEqual(out, []);
  });

  it('returns an empty list for an unreadable path', () => {
    assert.deepEqual(relationshipsForSchema('/nope/missing.json', 'v1'), []);
  });
});

describe('schemaIntrospectionPool', () => {
  function fakePool(rows) {
    const calls = [];
    return {
      calls,
      query(text, values) {
        calls.push({ text, values });
        return Promise.resolve({ rows, command: 'SELECT' });
      },
    };
  }

  it('rewrites the public predicate as a bind parameter', async () => {
    const pool = fakePool([]);
    await schemaIntrospectionPool(pool, 'v1')
      .query("select 1 from pg_namespace where nspname = 'public'");
    assert.equal(pool.calls[0].text,
      'select 1 from pg_namespace where nspname = $1');
    assert.deepEqual(pool.calls[0].values, ['v1']);
  });

  it('never interpolates the schema name into SQL', async () => {
    const pool = fakePool([]);
    await schemaIntrospectionPool(pool, "x'; drop table y --")
      .query("where nspname='public'");
    assert.ok(!pool.calls[0].text.includes('drop table'));
    assert.deepEqual(pool.calls[0].values, ["x'; drop table y --"]);
  });

  it('passes a query that already has parameters straight through', async () => {
    const pool = fakePool([]);
    await schemaIntrospectionPool(pool, 'v1')
      .query("select 1 where nspname = 'public' and oid = $1", [42]);
    assert.equal(pool.calls[0].text,
      "select 1 where nspname = 'public' and oid = $1");
    assert.deepEqual(pool.calls[0].values, [42]);
  });

  it('filters rows to the schema and relabels the schema columns', async () => {
    const pool = fakePool([
      { from_schema: 'v1', to_schema: 'v1', name: 'keep' },
      { from_schema: 'v1', to_schema: 'v2', name: 'cross' },
      { from_schema: 'public', to_schema: 'public', name: 'other' },
    ]);
    const result = await schemaIntrospectionPool(pool, 'v1').query('select 1');
    assert.deepEqual(result.rows,
      [{ from_schema: 'public', to_schema: 'public', name: 'keep' }]);
  });

  it('relabels schema_name rows', async () => {
    const pool = fakePool([{ schema_name: 'v1', table_name: 't' }]);
    const result = await schemaIntrospectionPool(pool, 'v1').query('select 1');
    assert.deepEqual(result.rows, [{ schema_name: 'public', table_name: 't' }]);
  });

  it('leaves rows without schema columns alone', async () => {
    const pool = fakePool([{ oid: 1, attname: 'id' }]);
    const result = await schemaIntrospectionPool(pool, 'v1').query('select 1');
    assert.deepEqual(result.rows, [{ oid: 1, attname: 'id' }]);
  });

  it('handles an empty result', async () => {
    const pool = fakePool([]);
    const result = await schemaIntrospectionPool(pool, 'v1').query('select 1');
    assert.deepEqual(result.rows, []);
  });
});
