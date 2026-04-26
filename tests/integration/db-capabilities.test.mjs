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

  describe('schema cache with DSQL stub', () => {
    it('skips FK query when provider lacks FK support', async () => {
      const queries = [];
      const mockPool = {
        query(sql) {
          queries.push(sql);
          if (sql.includes('format_type')) {
            return {
              rows: [
                { table_name: 'users', column_name: 'id', data_type: 'bigint', is_nullable: false, column_default: null },
                { table_name: 'notes', column_name: 'id', data_type: 'bigint', is_nullable: false, column_default: null },
                { table_name: 'notes', column_name: 'user_id', data_type: 'text', is_nullable: false, column_default: null },
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
          if (sql.includes("contype = 'f'")) return { rows: [] };
          return { rows: [] };
        },
        end: () => Promise.resolve(),
      };

      const pgrest = createPgrest({
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

      try {
        pgrest._db._setPool(mockPool);
        const schema = await pgrest._schemaCache.refresh(mockPool);

        const fkCalls = queries.filter(q => q.includes("contype = 'f'"));
        assert.equal(fkCalls.length, 0, 'FK_SQL should not be sent to DSQL');

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
