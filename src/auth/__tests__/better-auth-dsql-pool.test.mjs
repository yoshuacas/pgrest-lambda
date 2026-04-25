import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

let capturedPoolConfig;
let dsqlSignerCalls = [];

mock.module('pg', {
  defaultExport: {
    Pool: function Pool(config) {
      capturedPoolConfig = config;
      return {
        query: async () => ({ rows: [] }),
        end: async () => {},
      };
    },
  },
});

mock.module('@aws-sdk/dsql-signer', {
  namedExports: {
    DsqlSigner: class DsqlSigner {
      constructor(opts) {
        dsqlSignerCalls.push(opts);
        this.opts = opts;
      }
      async getDbConnectAdminAuthToken() {
        return 'mock-iam-token';
      }
    },
  },
});

mock.module('better-auth', {
  namedExports: {
    betterAuth: () => ({
      api: {},
      handler: () => new Response(null, { status: 404 }),
    }),
  },
});

mock.module('better-auth/plugins', {
  namedExports: {
    jwt: () => ({ id: 'jwt-plugin' }),
    magicLink: () => ({ id: 'magic-link-plugin' }),
  },
});

mock.module('@aws-sdk/client-sesv2', {
  namedExports: {
    SESv2Client: class { send() { return Promise.resolve({}); } },
    SendEmailCommand: class { constructor(input) { this.input = input; } },
  },
});

const { createBetterAuthProvider } = await import(
  '../providers/better-auth.mjs'
);

describe('better-auth DSQL pool IAM token', () => {
  beforeEach(() => {
    capturedPoolConfig = undefined;
    dsqlSignerCalls = [];
  });

  it('uses an async password callback for IAM token generation', async () => {
    createBetterAuthProvider({
      dsqlEndpoint: 'test.dsql.us-east-1.on.aws',
      regionName: 'us-east-1',
      betterAuthSecret: 'a'.repeat(32),
      betterAuthUrl: 'https://api.example.com/v1',
    });

    assert.ok(capturedPoolConfig, 'Pool constructor should have been called');
    assert.equal(
      typeof capturedPoolConfig.password,
      'function',
      'password should be an async function for IAM token generation',
    );

    const token = await capturedPoolConfig.password();
    assert.equal(token, 'mock-iam-token', 'password callback should return IAM token');
    assert.equal(dsqlSignerCalls.length, 1, 'DsqlSigner should be instantiated once');
    assert.equal(dsqlSignerCalls[0].hostname, 'test.dsql.us-east-1.on.aws');
    assert.equal(dsqlSignerCalls[0].region, 'us-east-1');
  });

  it('preserves search_path=better_auth for DSQL', async () => {
    createBetterAuthProvider({
      dsqlEndpoint: 'test.dsql.us-east-1.on.aws',
      regionName: 'us-east-1',
      betterAuthSecret: 'a'.repeat(32),
      betterAuthUrl: 'https://api.example.com/v1',
    });

    assert.equal(
      capturedPoolConfig.options,
      '-c search_path=better_auth',
      'DSQL pool must set search_path to better_auth',
    );
  });

  it('sets ssl rejectUnauthorized true for DSQL', async () => {
    createBetterAuthProvider({
      dsqlEndpoint: 'test.dsql.us-east-1.on.aws',
      regionName: 'us-east-1',
      betterAuthSecret: 'a'.repeat(32),
      betterAuthUrl: 'https://api.example.com/v1',
    });

    assert.ok(capturedPoolConfig.ssl, 'ssl option should be present');
    assert.equal(
      capturedPoolConfig.ssl.rejectUnauthorized,
      true,
      'rejectUnauthorized must be true for DSQL',
    );
  });

  it('reads region from REGION_NAME env when not in config', async () => {
    const origRegion = process.env.REGION_NAME;
    process.env.REGION_NAME = 'eu-west-1';

    try {
      createBetterAuthProvider({
        dsqlEndpoint: 'test.dsql.eu-west-1.on.aws',
        betterAuthSecret: 'a'.repeat(32),
        betterAuthUrl: 'https://api.example.com/v1',
      });

      const token = await capturedPoolConfig.password();
      assert.equal(token, 'mock-iam-token');
      assert.equal(dsqlSignerCalls[0].region, 'eu-west-1');
    } finally {
      if (origRegion !== undefined) {
        process.env.REGION_NAME = origRegion;
      } else {
        delete process.env.REGION_NAME;
      }
    }
  });

  it('does not use IAM tokens for DATABASE_URL path', async () => {
    createBetterAuthProvider({
      databaseUrl: 'postgres://user:pass@localhost/test',
      betterAuthSecret: 'a'.repeat(32),
      betterAuthUrl: 'https://api.example.com/v1',
    });

    assert.ok(capturedPoolConfig, 'Pool constructor should have been called');
    assert.ok(
      capturedPoolConfig.connectionString,
      'DATABASE_URL path should use connectionString',
    );
    assert.equal(
      typeof capturedPoolConfig.password,
      'undefined',
      'DATABASE_URL path should not set a password callback',
    );
  });

  it('does not use IAM tokens for PG_* env var path', async () => {
    createBetterAuthProvider({
      pgHost: 'localhost',
      pgUser: 'testuser',
      pgPassword: 'testpass',
      pgDatabase: 'testdb',
      betterAuthSecret: 'a'.repeat(32),
      betterAuthUrl: 'https://api.example.com/v1',
    });

    assert.ok(capturedPoolConfig, 'Pool constructor should have been called');
    assert.equal(
      capturedPoolConfig.password,
      'testpass',
      'PG_* path should use static password string',
    );
  });
});
