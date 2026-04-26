import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createPostgresProvider } from '../postgres.mjs';
import { createDsqlProvider } from '../dsql.mjs';

describe('database capabilities', () => {
  describe('PostgreSQL provider', () => {
    const provider = createPostgresProvider({ host: 'localhost' });

    it('returns the expected capability flags', () => {
      const caps = provider.capabilities();
      assert.deepStrictEqual(caps, {
        supportsForeignKeys: true,
        supportsFullTextSearch: true,
        supportsRangeTypes: true,
        supportsArrayContainment: true,
        supportsPlannedCount: true,
        supportsRegex: true,
        supportsRowLevelSecurity: true,
        supportsRpc: true,
        supportsGinIndex: true,
      });
    });

    it('returns a frozen object', () => {
      const caps = provider.capabilities();
      assert.ok(Object.isFrozen(caps));
    });
  });

  describe('DSQL provider', () => {
    const provider = createDsqlProvider({
      dsqlEndpoint: 'test.dsql.amazonaws.com',
      region: 'us-east-1',
    });

    it('returns the expected capability flags', () => {
      const caps = provider.capabilities();
      assert.deepStrictEqual(caps, {
        supportsForeignKeys: false,
        supportsFullTextSearch: false,
        supportsRangeTypes: false,
        supportsArrayContainment: true,
        supportsPlannedCount: false,
        supportsRegex: true,
        supportsRowLevelSecurity: false,
        supportsRpc: true,
        supportsGinIndex: false,
      });
    });

    it('returns a frozen object', () => {
      const caps = provider.capabilities();
      assert.ok(Object.isFrozen(caps));
    });
  });

  describe('shape consistency', () => {
    it('both providers have identical keys with boolean values', () => {
      const pg = createPostgresProvider({ host: 'localhost' });
      const dsql = createDsqlProvider({
        dsqlEndpoint: 'test.dsql.amazonaws.com',
        region: 'us-east-1',
      });
      const pgCaps = pg.capabilities();
      const dsqlCaps = dsql.capabilities();

      assert.deepStrictEqual(
        Object.keys(pgCaps).sort(),
        Object.keys(dsqlCaps).sort(),
      );

      for (const v of Object.values(pgCaps)) {
        assert.equal(typeof v, 'boolean');
      }
      for (const v of Object.values(dsqlCaps)) {
        assert.equal(typeof v, 'boolean');
      }
    });
  });
});
