import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createPgrest } from '../index.mjs';

describe('createPgrest secret validation', () => {
  it('throws when jwtSecret is short', () => {
    assert.throws(
      () => createPgrest({
        jwtSecret: 'short',
        database: { host: 'localhost' },
      }),
      (err) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes('too short'));
        return true;
      },
    );
  });

  it('throws when jwtSecret is missing and JWT_SECRET env var is unset', () => {
    const prev = process.env.JWT_SECRET;
    delete process.env.JWT_SECRET;
    try {
      assert.throws(
        () => createPgrest({ database: { host: 'localhost' } }),
        (err) => {
          assert.ok(err instanceof Error);
          assert.ok(err.message.includes('required'));
          return true;
        },
      );
    } finally {
      if (prev === undefined) delete process.env.JWT_SECRET;
      else process.env.JWT_SECRET = prev;
    }
  });

  it('throws when jwtSecret is not a string', () => {
    assert.throws(
      () => createPgrest({
        jwtSecret: 12345,
        database: { host: 'localhost' },
      }),
      (err) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes('must be a string'));
        return true;
      },
    );
  });

  it('throws when JWT_SECRET env var is too short', () => {
    const prev = process.env.JWT_SECRET;
    process.env.JWT_SECRET = 'short';
    try {
      assert.throws(
        () => createPgrest({ database: { host: 'localhost' } }),
        (err) => {
          assert.ok(err instanceof Error);
          assert.ok(err.message.includes('too short'));
          return true;
        },
      );
    } finally {
      if (prev === undefined) delete process.env.JWT_SECRET;
      else process.env.JWT_SECRET = prev;
    }
  });

  it('constructs with valid jwtSecret', () => {
    const pgrest = createPgrest({
      jwtSecret: 'a'.repeat(32),
      database: { host: 'localhost' },
    });
    assert.ok(pgrest.handler);
    assert.ok(pgrest.rest);
    assert.ok(pgrest.auth);
    assert.ok(pgrest.authorizer);
  });
});
