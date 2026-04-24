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

mock.module('@aws-sdk/dsql-signer', {
  namedExports: {
    DsqlSigner: class DsqlSigner {
      constructor() {}
      async getDbConnectAdminAuthToken() {
        return 'fake-iam-token';
      }
    },
  },
});

const { createDsqlProvider } = await import('../dsql.mjs');

describe('DSQL adapter SSL', () => {
  beforeEach(() => {
    capturedConfig = undefined;
  });

  it('DSQL pool always sets rejectUnauthorized true', async () => {
    const provider = createDsqlProvider({
      dsqlEndpoint: 'test.dsql.us-east-1.on.aws',
      region: 'us-east-1',
    });
    await provider.getPool();

    assert.ok(capturedConfig, 'Pool constructor should have been called');
    assert.ok(capturedConfig.ssl, 'ssl option should be present');
    assert.equal(
      capturedConfig.ssl.rejectUnauthorized,
      true,
      'rejectUnauthorized must be true for DSQL connections'
    );
  });
});
