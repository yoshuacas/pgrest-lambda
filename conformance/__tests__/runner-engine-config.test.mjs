// Runner: per-case engine configuration (a needs-engine-config case is run
// under the configuration upstream boots that spec with) and the targeted
// fixture restore that replaces a full 07-data.sql reload.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ENGINE_CONFIGS, requiredConfigKeys, engineConfigFor, parseFixtureGroups,
  functionWriteTargets, touchedTables, restoreTables,
} from '../runner/run.mjs';

const mkCase = (over = {}) => ({
  id: 'Spec:1', source: 'test/spec/Feature/Query/Spec.hs', line: 1,
  request: { method: 'GET', path: '/rest/v1/items' }, ...over,
});

describe('requiredConfigKeys', () => {
  it('reads the config keys out of a skipReason', () => {
    assert.deepEqual(
      requiredConfigKeys({
        skipReason: 'needs non-default engine configuration (configDbMaxRows)',
      }),
      ['configDbMaxRows']);
  });

  it('splits several keys', () => {
    assert.deepEqual(
      requiredConfigKeys({
        skipReason:
          'needs config (configServerTimingEnabled, configJwtCacheMaxEntries)',
      }),
      ['configServerTimingEnabled', 'configJwtCacheMaxEntries']);
  });

  it('is empty with no parenthesised group and with no reason', () => {
    assert.deepEqual(requiredConfigKeys({ skipReason: 'needs config' }), []);
    assert.deepEqual(requiredConfigKeys({}), []);
  });
});

describe('ENGINE_CONFIGS', () => {
  it('names a spec, a label and the keys each entry provides', () => {
    for (const entry of ENGINE_CONFIGS) {
      assert.equal(typeof entry.spec, 'string', 'spec');
      assert.ok(entry.spec.length, 'spec non-empty');
      assert.equal(typeof entry.label, 'string', `${entry.spec} label`);
      assert.ok(Array.isArray(entry.provides), `${entry.spec} provides`);
      assert.ok(entry.provides.length, `${entry.spec} provides non-empty`);
      assert.equal(typeof entry.config, 'object', `${entry.spec} config`);
    }
  });

  it('gives every entry a distinct label', () => {
    const labels = ENGINE_CONFIGS.map(e => e.label);
    assert.equal(new Set(labels).size, labels.length);
  });
});

describe('engineConfigFor', () => {
  it('matches a whole-spec entry', () => {
    const entry = engineConfigFor(mkCase({
      source: 'test/spec/Feature/Query/QueryLimitedSpec.hs',
      line: 12,
      skipClass: 'needs-engine-config',
      skipReason: 'needs non-default engine configuration (configDbMaxRows)',
    }));
    assert.ok(entry, 'entry found');
    assert.equal(entry.config.dbMaxRows, 2);
  });

  it('respects a from/to line range', () => {
    const asymmetric = (line) => engineConfigFor(mkCase({
      source: 'test/spec/Feature/Auth/AsymmetricJwtSpec.hs',
      line,
      skipClass: 'needs-engine-config',
      skipReason: 'needs non-default engine configuration (configJwtSecret)',
    }));
    const first = asymmetric(10);
    const second = asymmetric(40);
    assert.ok(first && second);
    assert.notEqual(first.label, second.label);
  });

  it('returns null for a spec with no configuration entry', () => {
    assert.equal(engineConfigFor(mkCase({
      source: 'test/spec/Feature/Query/RangeSpec.hs',
      skipClass: 'needs-engine-config',
      skipReason: 'needs non-default engine configuration (configDbRootSpec)',
    })), null);
  });

  it('refuses an entry that does not provide the key the case needs', () => {
    // MultipleSchemaSpec has an entry, but it provides db-schemas only.
    assert.equal(engineConfigFor(mkCase({
      source: 'test/spec/Feature/Query/MultipleSchemaSpec.hs',
      line: 5,
      skipClass: 'needs-engine-config',
      skipReason: 'needs non-default engine configuration (configDbRootSpec)',
    })), null);
  });

  it('covers a case in the range that is not needs-config', () => {
    const entry = engineConfigFor(mkCase({
      source: 'test/spec/Feature/Query/MultipleSchemaSpec.hs', line: 5,
    }));
    assert.ok(entry);
    assert.ok(entry.config.dbSchemas.includes('v1'));
  });
});

// --- targeted fixture restore ----------------------------------------------

const FIXTURE = `
SET search_path = public, pg_catalog;

DELETE FROM items;
INSERT INTO items (id) VALUES (1), (2);
SELECT setval('items_id_seq', 2, true);

TRUNCATE TABLE nothing_matching CASCADE;

SET search_path = private, pg_catalog;
DELETE FROM player;
INSERT INTO player (id) VALUES (1);

SET search_path = "SPECIAL ""@/#~_-", pg_catalog;
DELETE FROM "Just A Table";
INSERT INTO "Just A Table" ("Ready") VALUES (true);

SET search_path = public, pg_catalog;
INSERT INTO items (id) VALUES (3);
UPDATE other SET a = 1;
`;

describe('parseFixtureGroups', () => {
  const { groups, order } = parseFixtureGroups(FIXTURE);

  it('keys groups by schema.table using the block search_path', () => {
    assert.deepEqual(order, [
      'public.items', 'private.player', 'SPECIAL "@/#~_-.Just A Table',
      'public.other',
    ]);
  });

  it('collects every statement for a table, in file order', () => {
    const g = groups.get('public.items');
    assert.equal(g.schema, 'public');
    assert.equal(g.table, 'items');
    assert.equal(g.statements.length, 4);
    assert.match(g.statements[0], /^DELETE FROM items/);
    assert.match(g.statements[2], /setval/);
    assert.match(g.statements[3], /VALUES \(3\)/);
  });

  it('attaches setval to the table the preceding statement named', () => {
    assert.ok(groups.get('public.items').statements.some(s => /setval/.test(s)));
    assert.ok(!groups.get('private.player').statements
      .some(s => /setval/.test(s)));
  });

  it('ignores statements that name no write target', () => {
    assert.equal(groups.has('public.nothing_matching'), false);
  });

  it('unquotes a schema and table that need quoting', () => {
    const g = groups.get('SPECIAL "@/#~_-.Just A Table');
    assert.equal(g.schema, 'SPECIAL "@/#~_-');
    assert.equal(g.table, 'Just A Table');
  });

  it('returns nothing for an empty file', () => {
    const empty = parseFixtureGroups('');
    assert.equal(empty.groups.size, 0);
    assert.deepEqual(empty.order, []);
  });
});

describe('functionWriteTargets', () => {
  it('finds insert, update and delete targets', () => {
    const src = `
      insert into items (id) values (1);
      UPDATE public.other SET a = 1;
      delete from private.player where id = 1;
      select * from untouched;
    `;
    assert.deepEqual([...functionWriteTargets(src)].sort(),
      ['private.player', 'public.items', 'public.other']);
  });

  it('qualifies bare names with the function schema', () => {
    assert.deepEqual([...functionWriteTargets('insert into t values (1)', 'v1')],
      ['v1.t']);
  });

  it('unquotes and case-folds correctly', () => {
    assert.deepEqual([...functionWriteTargets('INSERT INTO "MiXeD" values (1)')],
      ['public.MiXeD']);
    assert.deepEqual([...functionWriteTargets('INSERT INTO MiXeD values (1)')],
      ['public.mixed']);
  });

  it('is empty for a read-only body and for no body', () => {
    assert.equal(functionWriteTargets('select 1').size, 0);
    assert.equal(functionWriteTargets(null).size, 0);
  });
});

describe('touchedTables', () => {
  const groups = parseFixtureGroups(FIXTURE);
  const ctx = {
    catalog: {
      relations: new Map([
        ['items', ['public']],
        ['player', ['private']],
        ['a_view', ['public']],
        ['unpopulated', ['public']],
        ['elsewhere', ['v1']],
      ]),
      viewsInPublic: new Set(['a_view']),
      tablesInPublic: new Set(['items', 'unpopulated', 'absent']),
      functions: new Map([
        ['writes_items', ['public']],
        ['writes_elsewhere', ['public']],
        ['reads_only', ['public']],
        ['body_unknown', ['public']],
      ]),
      functionWrites: new Map([
        ['writes_items', new Set(['public.items'])],
        ['writes_elsewhere', new Set(['public.absent'])],
        ['reads_only', new Set()],
      ]),
    },
  };
  const touched = (path, method = 'POST') =>
    touchedTables(mkCase({ request: { method, path } }), ctx, groups);

  it('maps a table path to its fixture group', () => {
    assert.deepEqual([...touched('/rest/v1/items')], ['public.items']);
  });

  it('finds a table that lives in a non-public schema', () => {
    assert.deepEqual([...touched('/rest/v1/player')], ['private.player']);
  });

  it('is unknown (null) for a write through a view', () => {
    assert.equal(touched('/rest/v1/a_view'), null);
  });

  it('is unknown (null) for a path with no relation', () => {
    assert.equal(touched('/rest/v1/'), null);
  });

  it('empties a table the fixture never populates', () => {
    assert.deepEqual([...touched('/rest/v1/unpopulated')],
      ['public.unpopulated']);
  });

  it('leaves a table outside the default schema alone', () => {
    // Not in a fixture group and not a public table: emptying `v1.elsewhere`
    // is not what the request reached.
    assert.equal(touched('/rest/v1/elsewhere').size, 0);
  });

  it('maps an RPC to the tables its body writes', () => {
    assert.deepEqual([...touched('/rest/v1/rpc/writes_items')],
      ['public.items']);
  });

  it('empties an RPC write target the fixture never populates', () => {
    assert.deepEqual([...touched('/rest/v1/rpc/writes_elsewhere')],
      ['public.absent']);
  });

  it('is empty for a read-only RPC', () => {
    assert.equal(touched('/rest/v1/rpc/reads_only').size, 0);
  });

  it('is unknown (null) for a catalogued RPC with no body on record', () => {
    assert.equal(touched('/rest/v1/rpc/body_unknown'), null);
  });

  it('is empty for an RPC the catalog does not have at all', () => {
    // The request was a 404, so nothing was written.
    assert.equal(touched('/rest/v1/rpc/mystery').size, 0);
  });

  it('ignores the query string when naming the relation', () => {
    assert.deepEqual([...touched('/rest/v1/items?id=eq.1', 'PATCH')],
      ['public.items']);
  });
});

describe('restoreTables', () => {
  function fakePool() {
    const calls = [];
    let released = 0;
    return {
      calls,
      get released() { return released; },
      connect: () => Promise.resolve({
        query(text, values) {
          calls.push({ text, values });
          if (/show search_path/i.test(text)) {
            return Promise.resolve({ rows: [{ search_path: '"$user", public' }] });
          }
          return Promise.resolve({ rows: [] });
        },
        release() { released += 1; },
      }),
    };
  }

  it('replays only the requested groups, in file order', async () => {
    const groups = parseFixtureGroups(FIXTURE);
    const pool = fakePool();
    const applied = await restoreTables(
      pool, new Set(['public.other', 'public.items']), groups);
    assert.equal(applied, 5); // 4 items statements + 1 other
    const sql = pool.calls.map(c => c.text);
    // One set_config per group before that group's statements, plus the one
    // that puts the connection's own search_path back.
    const setConfigs = pool.calls.filter(c => /set_config/.test(c.text));
    assert.equal(setConfigs.length, 3);
    assert.deepEqual(setConfigs.at(-1).values,
      ['search_path', '"$user", public']);
    assert.ok(sql.findIndex(s => /DELETE FROM items/.test(s))
      < sql.findIndex(s => /UPDATE other/.test(s)));
    assert.ok(!sql.some(s => /player/.test(s)));
    assert.equal(pool.released, 1);
  });

  it('leaves the connection on the search_path it borrowed it with', async () => {
    const groups = parseFixtureGroups(FIXTURE);
    const pool = fakePool();
    await restoreTables(pool, new Set(['private.player']), groups);
    // `show search_path` runs before the first change, and its value is the
    // last thing written back: the engine reuses this connection.
    const texts = pool.calls.map(c => c.text);
    assert.ok(/show search_path/i.test(texts[0]), texts[0]);
    const last = pool.calls.at(-1);
    assert.match(last.text, /set_config/);
    assert.deepEqual(last.values, ['search_path', '"$user", public']);
  });

  it('touches no search_path when it only empties tables', async () => {
    const groups = parseFixtureGroups(FIXTURE);
    const pool = fakePool();
    await restoreTables(pool, new Set(['public.simple_pk2']), groups);
    assert.equal(pool.calls.filter(c => /search_path/i.test(c.text)).length, 0);
  });

  it('binds the search_path value rather than interpolating it', async () => {
    const groups = parseFixtureGroups(FIXTURE);
    const pool = fakePool();
    await restoreTables(pool, new Set(['SPECIAL "@/#~_-.Just A Table']), groups);
    const setConfig = pool.calls.find(c => /set_config/.test(c.text));
    assert.equal(setConfig.text, 'select set_config($1, $2, false)');
    assert.deepEqual(setConfig.values,
      ['search_path', '"SPECIAL ""@/#~_-", pg_catalog']);
  });

  it('empties a table the fixture has no statements for', async () => {
    const groups = parseFixtureGroups(FIXTURE);
    const pool = fakePool();
    const applied = await restoreTables(
      pool, new Set(['public.simple_pk2']), groups);
    assert.equal(applied, 1);
    assert.deepEqual(pool.calls.map(c => c.text),
      ['DELETE FROM "public"."simple_pk2"']);
  });

  it('does nothing for an empty or null key set', async () => {
    const groups = parseFixtureGroups(FIXTURE);
    const pool = fakePool();
    assert.equal(await restoreTables(pool, new Set(), groups), 0);
    assert.equal(await restoreTables(pool, null, groups), 0);
    assert.equal(pool.calls.length, 0);
  });
});
