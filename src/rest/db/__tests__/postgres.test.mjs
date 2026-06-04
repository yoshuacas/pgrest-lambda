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

// Mock the SSM client so the password-resolution path can be exercised
// without real AWS calls. The captured request lets tests assert that
// WithDecryption and the parameter name are passed correctly.
let capturedSsmInput;
let ssmSendCalls;
let ssmParameterValue;

mock.module('@aws-sdk/client-ssm', {
  namedExports: {
    SSMClient: function SSMClient() {
      return {
        send: async (command) => {
          ssmSendCalls += 1;
          capturedSsmInput = command.input;
          return { Parameter: { Value: ssmParameterValue } };
        },
      };
    },
    GetParameterCommand: function GetParameterCommand(input) {
      this.input = input;
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

  describe('SSM password resolution', () => {
    beforeEach(() => {
      capturedSsmInput = undefined;
      ssmSendCalls = 0;
      ssmParameterValue = 'secret-from-ssm';
    });

    it('P9: resolves password from SSM when only passwordSsmParam is set', async () => {
      const provider = createPostgresProvider({
        host: 'db.example.com',
        user: 'boa_admin',
        passwordSsmParam: '/my-app/db-master-password',
        region: 'us-west-2',
      });
      await provider.getPool();

      assert.ok(capturedConfig, 'Pool constructor should have been called');
      assert.equal(ssmSendCalls, 1, 'SSM should be queried exactly once');
      assert.equal(
        capturedConfig.password,
        'secret-from-ssm',
        'password should come from the resolved SSM value'
      );
      assert.equal(
        capturedSsmInput.Name,
        '/my-app/db-master-password',
        'the SSM parameter name should be requested'
      );
      assert.equal(
        capturedSsmInput.WithDecryption,
        true,
        'SecureString resolution requires WithDecryption'
      );
    });

    it('P10: explicit password takes precedence over SSM', async () => {
      const provider = createPostgresProvider({
        host: 'db.example.com',
        user: 'boa_admin',
        password: 'literal-pass',
        passwordSsmParam: '/my-app/db-master-password',
      });
      await provider.getPool();

      assert.equal(ssmSendCalls, 0, 'SSM should not be queried when a password is given');
      assert.equal(capturedConfig.password, 'literal-pass');
    });

    it('P11: no password and no SSM param yields empty password', async () => {
      const provider = createPostgresProvider({
        host: 'db.example.com',
        user: 'postgres',
      });
      await provider.getPool();

      assert.equal(ssmSendCalls, 0, 'SSM should not be queried without a param name');
      assert.equal(capturedConfig.password, '');
    });

    it('P12: SSM resolution happens lazily inside getPool, not at construction', async () => {
      createPostgresProvider({
        host: 'db.example.com',
        passwordSsmParam: '/my-app/db-master-password',
      });

      assert.equal(
        ssmSendCalls,
        0,
        'constructing the provider must not trigger an SSM call'
      );
    });

    it('P13: an empty SSM value throws a clear error', async () => {
      ssmParameterValue = '';
      const provider = createPostgresProvider({
        host: 'db.example.com',
        passwordSsmParam: '/my-app/db-master-password',
      });

      await assert.rejects(
        () => provider.getPool(),
        /resolved to an empty value/,
        'an empty SecureString should surface a descriptive error'
      );
    });
  });
});
