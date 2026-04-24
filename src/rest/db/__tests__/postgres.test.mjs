import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

let capturedConfig;

mock.module('pg', {
  defaultExport: {
    Pool: function Pool(config) {
      capturedConfig = config;
      return {
        query: async () => ({ rows: [] }),
        end: async () => {},
      };
    },
  },
});

const { createPostgresProvider } = await import('../postgres.mjs');

describe('Standard Postgres adapter SSL', () => {
  beforeEach(() => {
    capturedConfig = undefined;
  });

  describe('SSL resolution', () => {
    it('P1: ssl undefined yields no TLS', async () => {
      const provider = createPostgresProvider({
        host: 'localhost',
      });
      await provider.getPool();

      assert.ok(capturedConfig, 'Pool constructor should have been called');
      assert.equal(
        capturedConfig.ssl,
        undefined,
        'ssl should be undefined when config.ssl is undefined'
      );
    });

    it('P2: ssl false yields no TLS', async () => {
      const provider = createPostgresProvider({
        host: 'localhost',
        ssl: false,
      });
      await provider.getPool();

      assert.ok(capturedConfig, 'Pool constructor should have been called');
      assert.equal(
        capturedConfig.ssl,
        undefined,
        'ssl should be undefined when config.ssl is false'
      );
    });

    it('P3: ssl true yields TLS with verification', async () => {
      const provider = createPostgresProvider({
        host: 'localhost',
        ssl: true,
      });
      await provider.getPool();

      assert.ok(capturedConfig, 'Pool constructor should have been called');
      assert.deepEqual(
        capturedConfig.ssl,
        { rejectUnauthorized: true },
        'ssl should be { rejectUnauthorized: true } when config.ssl is true'
      );
    });

    it('P4: ssl object with rejectUnauthorized false preserves consumer override', async () => {
      const provider = createPostgresProvider({
        host: 'localhost',
        ssl: { rejectUnauthorized: false },
      });
      await provider.getPool();

      assert.ok(capturedConfig, 'Pool constructor should have been called');
      assert.deepEqual(
        capturedConfig.ssl,
        { rejectUnauthorized: false },
        'ssl should preserve explicit rejectUnauthorized: false'
      );
    });

    it('P5: ssl object without rejectUnauthorized injects secure default', async () => {
      const provider = createPostgresProvider({
        host: 'localhost',
        ssl: { ca: '<pem>' },
      });
      await provider.getPool();

      assert.ok(capturedConfig, 'Pool constructor should have been called');
      assert.equal(
        capturedConfig.ssl.rejectUnauthorized,
        true,
        'rejectUnauthorized should default to true'
      );
      assert.equal(
        capturedConfig.ssl.ca,
        '<pem>',
        'ca should be preserved'
      );
    });

    it('P6: ssl object with explicit rejectUnauthorized false and ca preserves both', async () => {
      const provider = createPostgresProvider({
        host: 'localhost',
        ssl: { ca: '<pem>', rejectUnauthorized: false },
      });
      await provider.getPool();

      assert.ok(capturedConfig, 'Pool constructor should have been called');
      assert.equal(
        capturedConfig.ssl.rejectUnauthorized,
        false,
        'explicit rejectUnauthorized: false should be preserved'
      );
      assert.equal(
        capturedConfig.ssl.ca,
        '<pem>',
        'ca should be preserved'
      );
    });
  });

  describe('Connection-string branch', () => {
    it('P7: connection string ignores config.ssl', async () => {
      const provider = createPostgresProvider({
        connectionString: 'postgresql://localhost/db',
        ssl: true,
      });
      await provider.getPool();

      assert.ok(capturedConfig, 'Pool constructor should have been called');
      assert.ok(
        capturedConfig.connectionString,
        'connectionString should be present to confirm branch was taken'
      );
      assert.equal(
        capturedConfig.ssl,
        undefined,
        'ssl should not be set when using connection string'
      );
    });
  });

  describe('Config passthrough', () => {
    it('P8: host/port/user/password/database preserved alongside ssl', async () => {
      const provider = createPostgresProvider({
        host: 'db.example.com',
        port: 5433,
        user: 'myuser',
        password: 'mypass',
        database: 'mydb',
        ssl: true,
      });
      await provider.getPool();

      assert.ok(capturedConfig, 'Pool constructor should have been called');
      assert.equal(capturedConfig.host, 'db.example.com');
      assert.equal(capturedConfig.port, 5433);
      assert.equal(capturedConfig.user, 'myuser');
      assert.equal(capturedConfig.password, 'mypass');
      assert.equal(capturedConfig.database, 'mydb');
      assert.deepEqual(
        capturedConfig.ssl,
        { rejectUnauthorized: true },
        'ssl should be { rejectUnauthorized: true } alongside other config'
      );
    });
  });
});
