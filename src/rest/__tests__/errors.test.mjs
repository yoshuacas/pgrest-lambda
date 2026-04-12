import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PostgRESTError, mapPgError } from '../errors.mjs';

describe('errors', () => {
  describe('PostgRESTError.toJSON()', () => {
    it('returns {code, message, details, hint} when all fields set', () => {
      const err = new PostgRESTError(400, 'PGRST100', 'bad parse', 'some detail', 'try again');
      const json = err.toJSON();
      assert.deepStrictEqual(json, {
        code: 'PGRST100',
        message: 'bad parse',
        details: 'some detail',
        hint: 'try again',
      }, 'toJSON should return all four fields');
    });

    it('includes null for details and hint when not provided', () => {
      const err = new PostgRESTError(400, 'PGRST100', 'bad parse');
      const json = err.toJSON();
      assert.equal(json.details, null, 'details should be null');
      assert.equal(json.hint, null, 'hint should be null');
    });
  });

  describe('mapPgError()', () => {
    it('maps PG code 23505 to HTTP 409', () => {
      const result = mapPgError({ code: '23505', message: 'unique violation' });
      assert.equal(result.statusCode, 409,
        'unique constraint violation should map to 409');
    });

    it('maps PG code 23503 to HTTP 409', () => {
      const result = mapPgError({ code: '23503', message: 'fk violation' });
      assert.equal(result.statusCode, 409,
        'foreign key violation should map to 409');
    });

    it('maps PG code 23502 to HTTP 400', () => {
      const result = mapPgError({ code: '23502', message: 'not null violation' });
      assert.equal(result.statusCode, 400,
        'not-null violation should map to 400');
    });

    it('maps unknown PG code to HTTP 500', () => {
      const result = mapPgError({ code: '99999', message: 'unknown error' });
      assert.equal(result.statusCode, 500,
        'unknown PG error should map to 500');
    });
  });
});
