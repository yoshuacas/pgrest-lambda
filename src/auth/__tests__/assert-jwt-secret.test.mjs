import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assertJwtSecret } from '../jwt.mjs';

describe('assertJwtSecret', () => {
  it('throws when secret is undefined', () => {
    assert.throws(
      () => assertJwtSecret(undefined),
      (err) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes('required'));
        assert.ok(err.message.startsWith('pgrest-lambda:'));
        return true;
      },
    );
  });

  it('throws when secret is null', () => {
    assert.throws(
      () => assertJwtSecret(null),
      (err) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes('required'));
        assert.ok(err.message.startsWith('pgrest-lambda:'));
        return true;
      },
    );
  });

  it('throws when secret is empty string', () => {
    assert.throws(
      () => assertJwtSecret(''),
      (err) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes('too short'));
        assert.ok(err.message.includes('0 characters'));
        return true;
      },
    );
  });

  it('throws when secret is 6 characters', () => {
    assert.throws(
      () => assertJwtSecret('secret'),
      (err) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes('too short'));
        assert.ok(err.message.includes('6 characters'));
        return true;
      },
    );
  });

  it('throws when secret is 31 characters', () => {
    assert.throws(
      () => assertJwtSecret('a'.repeat(31)),
      (err) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes('too short'));
        assert.ok(err.message.includes('31 characters'));
        return true;
      },
    );
  });

  it('does not throw for exactly 32 characters', () => {
    const result = assertJwtSecret('a'.repeat(32));
    assert.equal(result, undefined);
  });

  it('does not throw for 100 characters', () => {
    const result = assertJwtSecret('a'.repeat(100));
    assert.equal(result, undefined);
  });

  it('throws when secret is a number', () => {
    assert.throws(
      () => assertJwtSecret(123),
      (err) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes('must be a string'));
        assert.ok(err.message.includes('number'));
        return true;
      },
    );
  });

  it('throws when secret is a boolean', () => {
    assert.throws(
      () => assertJwtSecret(true),
      (err) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes('must be a string'));
        assert.ok(err.message.includes('boolean'));
        return true;
      },
    );
  });

  it('throws when secret is an object', () => {
    assert.throws(
      () => assertJwtSecret({}),
      (err) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes('must be a string'));
        assert.ok(err.message.includes('object'));
        return true;
      },
    );
  });

  it('never includes secret value in error message', () => {
    let thrown;
    try {
      assertJwtSecret('myshort');
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown, 'expected assertJwtSecret to throw');
    assert.ok(!thrown.message.includes('myshort'));
  });
});
