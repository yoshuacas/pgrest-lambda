import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  startPostgres, createPool, resetDatabase, connectionInfo,
} from '../harness/db.mjs';
import { createTestPgrest } from '../harness/pgrest.mjs';
import { createPgrest } from '../../src/index.mjs';

const EXPECTED_PG_CAPS = {
  supportsForeignKeys: true,
  supportsFullTextSearch: true,
  supportsRangeTypes: true,
  supportsArrayContainment: true,
  supportsPlannedCount: true,
  supportsRegex: true,
  supportsRowLevelSecurity: true,
  supportsRpc: true,
  supportsGinIndex: true,
};

const CAP_KEYS = Object.keys(EXPECTED_PG_CAPS);

describe('db capabilities integration', () => {
  let pool;

  before(async () => {
    await startPostgres();
    pool = createPool();
  });

  after(async () => {
    if (pool) await pool.end();
  });

  describe('PostgreSQL provider via createPgrest', () => {
    let ctx;

    afterEach(async () => {
      if (ctx?.destroy) await ctx.destroy();
      ctx = null;
    });

    it('capabilities() returns PostgreSQL flags', async () => {
      await resetDatabase(pool);
      ctx = createTestPgrest();
      const caps = ctx.pgrest._db.capabilities();

      for (const [key, value] of Object.entries(EXPECTED_PG_CAPS)) {
        assert.equal(caps[key], value, `${key} should be ${value}`);
      }
    });
  });

  describe('ctx.dbCapabilities', () => {
    let ctx;

    afterEach(async () => {
      if (ctx?.destroy) await ctx.destroy();
      ctx = null;
    });

    it('is available on the pgrest instance', async () => {
      await resetDatabase(pool);
      ctx = createTestPgrest();
      assert.ok(
        ctx.pgrest._dbCapabilities !== undefined,
        'pgrest should expose _dbCapabilities',
      );
      assert.deepStrictEqual(ctx.pgrest._dbCapabilities, EXPECTED_PG_CAPS);
    });
  });

  describe('boot logging', () => {
    it('logs capabilities in non-production mode', async () => {
      await resetDatabase(pool);
      const logs = [];
      const origInfo = console.info;
      console.info = (...args) => { logs.push(args.join(' ')); };

      let ctx;
      try {
        ctx = createTestPgrest();
        const capLine = logs.find(l => l.includes('db capabilities:'));
        assert.ok(capLine, 'should log db capabilities at boot');

        const jsonPart = capLine.substring(
          capLine.indexOf('db capabilities:') + 'db capabilities:'.length,
        ).trim();
        const parsed = JSON.parse(jsonPart);
        for (const key of CAP_KEYS) {
          assert.ok(key in parsed, `logged capabilities missing key: ${key}`);
        }
      } finally {
        console.info = origInfo;
        if (ctx?.destroy) await ctx.destroy();
      }
    });

    it('does not log capabilities in production mode', async () => {
      const logs = [];
      const origInfo = console.info;
      console.info = (...args) => { logs.push(args.join(' ')); };

      let pgrest;
      try {
        const db = connectionInfo();
        pgrest = createPgrest({
          database: {
            host: db.host,
            port: db.port,
            user: db.user,
            password: db.password,
            database: db.database,
          },
          jwtSecret: randomBytes(48).toString('base64'),
          auth: false,
          cors: { allowedOrigins: ['http://localhost'] },
          production: true,
          docs: false,
        });
        const capLine = logs.find(l => l.includes('db capabilities:'));
        assert.equal(capLine, undefined, 'should NOT log capabilities in production');
      } finally {
        console.info = origInfo;
        if (pgrest?._db?.close) await pgrest._db.close();
      }
    });
  });

  // This suite used to assert the opposite: that a DSQL connection never sent
  // FK_SQL. DSQL added foreign key constraints on 2026-08-27, so it does now,
  // and reading the catalog is the whole point of the change.
  describe('schema cache with DSQL stub', () => {
    /**
     * A pool that answers the introspection queries and records them.
     * @param {object[]} fkRows what `contype = 'f'` returns.
     */
    function stubPool(fkRows) {
      const queries = [];
      return {
        queries,
        query(sql) {
          queries.push(sql);
          if (sql.includes('format_type')) {
            return {
              rows: [
                { table_name: 'users', column_name: 'id', data_type: 'bigint', is_nullable: false, column_default: null },
                { table_name: 'notes', column_name: 'id', data_type: 'bigint', is_nullable: false, column_default: null },
                { table_name: 'notes', column_name: 'user_id', data_type: 'text', is_nullable: false, column_default: null },
                { table_name: 'notes', column_name: 'author', data_type: 'bigint', is_nullable: true, column_default: null },
              ],
            };
          }
          if (sql.includes("contype = 'p'")) {
            return {
              rows: [
                { table_name: 'users', column_name: 'id' },
                { table_name: 'notes', column_name: 'id' },
              ],
            };
          }
          if (sql.includes("contype = 'f'")) return { rows: fkRows };
          return { rows: [] };
        },
        end: () => Promise.resolve(),
      };
    }

    function dsqlPgrest() {
      return createPgrest({
        database: {
          dsqlEndpoint: 'test.dsql.amazonaws.com',
          region: 'us-east-1',
        },
        jwtSecret: randomBytes(48).toString('base64'),
        auth: false,
        cors: { allowedOrigins: '*' },
        production: false,
        docs: false,
      });
    }

    it('reads foreign keys from pg_constraint on DSQL', async () => {
      // On DSQL a key added to an existing table can only be NOT VALID, so
      // convalidated is false for every fixture key. FK_SQL does not filter on
      // it, deliberately — upstream PostgREST does not either.
      const mockPool = stubPool([{
        constraint_name: 'notes_author_fkey',
        from_schema: 'public',
        from_table: 'notes',
        from_columns: ['author'],
        to_schema: 'public',
        to_table: 'users',
        to_columns: ['id'],
      }]);
      const pgrest = dsqlPgrest();

      try {
        pgrest._db._setPool(mockPool);
        const schema = await pgrest._schemaCache.refresh(mockPool);

        assert.equal(
          mockPool.queries.filter(q => q.includes("contype = 'f'")).length, 1,
          'FK_SQL should be sent to DSQL');

        const rel = schema.relationships.find(
          r => r.fromTable === 'notes' && r.fromColumns.includes('author'),
        );
        assert.ok(rel, 'the NOT VALID key should produce a relationship');
        assert.equal(rel.toTable, 'users');
        assert.deepStrictEqual(rel.toColumns, ['id']);
        assert.equal(rel.constraint, 'notes_author_fkey');
      } finally {
        await pgrest._db.close();
      }
    });

    it('falls back to the naming convention when the catalog reports nothing',
      async () => {
        // Not DSQL-specific any more: this is what any database with no keys
        // declared gets. `notes.user_id` has no constraint behind it in the stub.
        const mockPool = stubPool([]);
        const pgrest = dsqlPgrest();

        try {
          pgrest._db._setPool(mockPool);
          const schema = await pgrest._schemaCache.refresh(mockPool);
          const rel = schema.relationships.find(
            r => r.fromTable === 'notes' && r.fromColumns.includes('user_id'),
          );
          assert.ok(rel, 'convention fallback should infer notes.user_id → users');
          assert.equal(rel.toTable, 'users');
          assert.deepStrictEqual(rel.toColumns, ['id']);
        } finally {
          await pgrest._db.close();
        }
      });
  });
});
