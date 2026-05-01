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
    // createPgrest no longer bundles an AWS authorizer — that lives
    // in deploy/aws-sam/authorizer.mjs and is only used by the SAM
    // deployment. The core library is deploy-target-agnostic.
    assert.equal(pgrest.authorizer, undefined);
  });
});

describe('createPgrest CORS production guardrail', () => {
  const jwtSecret = 'a'.repeat(32);
  const database = { host: 'localhost' };

  it('throws when production=true and allowedOrigins is wildcard', () => {
    assert.throws(
      () => createPgrest({
        production: true,
        cors: { allowedOrigins: '*' },
        jwtSecret,
        database,
      }),
      (err) => {
        assert.ok(err instanceof Error, 'should be an Error');
        assert.ok(
          err.message.startsWith('pgrest-lambda:'),
          'message should start with pgrest-lambda:',
        );
        assert.ok(
          err.message.includes('production'),
          'message should mention production',
        );
        assert.ok(
          err.message.includes('allowedOrigins'),
          'message should mention allowedOrigins',
        );
        return true;
      },
    );
  });

  it('constructs without error when no cors config and production=false', () => {
    const pgrest = createPgrest({ jwtSecret, database });
    assert.ok(pgrest.handler, 'should construct successfully');
  });

  it('constructs without error when production=true with explicit origins', () => {
    const pgrest = createPgrest({
      production: true,
      cors: { allowedOrigins: ['https://a.com'] },
      jwtSecret,
      database,
    });
    assert.ok(pgrest.handler, 'should construct successfully');
  });

  it('constructs without error when production=false with wildcard', () => {
    const pgrest = createPgrest({
      production: false,
      cors: { allowedOrigins: '*' },
      jwtSecret,
      database,
    });
    assert.ok(pgrest.handler, 'should construct successfully');
  });

  it('throws when NODE_ENV=production and no config.production with wildcard', () => {
    const prev = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'production';
      assert.throws(
        () => createPgrest({
          cors: { allowedOrigins: '*' },
          jwtSecret,
          database,
        }),
        (err) => {
          assert.ok(err instanceof Error, 'should be an Error');
          assert.ok(
            err.message.startsWith('pgrest-lambda:'),
            'message should start with pgrest-lambda:',
          );
          assert.ok(
            err.message.includes('production'),
            'message should mention production',
          );
          assert.ok(
            err.message.includes('allowedOrigins'),
            'message should mention allowedOrigins',
          );
          return true;
        },
      );
    } finally {
      if (prev === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prev;
    }
  });
});

describe('resolveConfig errorsVerbose', () => {
  const jwtSecret = 'a'.repeat(32);
  const database = { host: 'localhost' };

  it('defaults to false when no config and no env var', () => {
    const prev = process.env.PGREST_ERRORS_VERBOSE;
    delete process.env.PGREST_ERRORS_VERBOSE;
    try {
      const pgrest = createPgrest({ jwtSecret, database });
      assert.equal(pgrest._ctx.errorsVerbose, false,
        'errorsVerbose should default to false');
    } finally {
      if (prev === undefined) {
        delete process.env.PGREST_ERRORS_VERBOSE;
      } else {
        process.env.PGREST_ERRORS_VERBOSE = prev;
      }
    }
  });

  it('config.errors.verbose = true enables verbose', () => {
    const pgrest = createPgrest({
      jwtSecret,
      database,
      errors: { verbose: true },
    });
    assert.equal(pgrest._ctx.errorsVerbose, true,
      'errorsVerbose should be true from config');
  });

  it('env var PGREST_ERRORS_VERBOSE=true enables verbose', () => {
    const prev = process.env.PGREST_ERRORS_VERBOSE;
    process.env.PGREST_ERRORS_VERBOSE = 'true';
    try {
      const pgrest = createPgrest({ jwtSecret, database });
      assert.equal(pgrest._ctx.errorsVerbose, true,
        'errorsVerbose should be true from env var');
    } finally {
      if (prev === undefined) {
        delete process.env.PGREST_ERRORS_VERBOSE;
      } else {
        process.env.PGREST_ERRORS_VERBOSE = prev;
      }
    }
  });

  it('config false wins over env var true', () => {
    const prev = process.env.PGREST_ERRORS_VERBOSE;
    process.env.PGREST_ERRORS_VERBOSE = 'true';
    try {
      const pgrest = createPgrest({
        jwtSecret,
        database,
        errors: { verbose: false },
      });
      assert.equal(pgrest._ctx.errorsVerbose, false,
        'config false should override env var true '
        + '(nullish coalescing, not logical OR)');
    } finally {
      if (prev === undefined) {
        delete process.env.PGREST_ERRORS_VERBOSE;
      } else {
        process.env.PGREST_ERRORS_VERBOSE = prev;
      }
    }
  });
});
