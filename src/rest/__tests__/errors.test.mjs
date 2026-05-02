import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PostgRESTError, mapPgError, _getMapKeys } from '../errors.mjs';

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

  describe('mapPgError() sanitization', () => {
    const pgErrors = {
      '23505': {
        code: '23505',
        message: 'duplicate key value violates unique constraint "users_email_key"',
        detail: 'Key (email)=(alice@example.com) already exists.',
      },
      '23503': {
        code: '23503',
        message: 'insert or update on table "orders" violates foreign key constraint "orders_user_id_fkey"',
        detail: 'Key (user_id)=(nonexistent) is not present in table "users".',
      },
      '23502': {
        code: '23502',
        message: 'null value in column "email" of relation "users" violates not-null constraint',
        detail: 'Failing row contains (1, null, ...).',
      },
      '42P01': {
        code: '42P01',
        message: 'relation "secret_table" does not exist',
      },
      '42703': {
        code: '42703',
        message: 'column "secret_col" does not exist',
      },
      '55P03': {
        code: '55P03',
        message: 'could not obtain lock on relation "accounts"',
        detail: 'Process 1234 waits for ...',
        hint: 'See server log for query details.',
      },
    };

    describe('sanitized mode (default)', () => {
      it('23505 sanitized — safe message, null details/hint', () => {
        const result = mapPgError(pgErrors['23505']);
        assert.equal(result.statusCode, 409,
          'statusCode should be 409');
        assert.equal(result.code, '23505',
          'code should be 23505');
        assert.equal(result.message, 'Uniqueness violation.',
          'message should be the safe text');
        assert.equal(result.details, null,
          'details should be null');
        assert.equal(result.hint, null,
          'hint should be null');
      });

      it('23503 sanitized — safe message', () => {
        const result = mapPgError(pgErrors['23503']);
        assert.equal(result.statusCode, 409,
          'statusCode should be 409');
        assert.equal(result.code, '23503',
          'code should be 23503');
        assert.equal(result.message, 'Foreign key violation.',
          'message should be the safe text');
        assert.equal(result.details, null,
          'details should be null');
        assert.equal(result.hint, null,
          'hint should be null');
      });

      it('23502 sanitized — safe message', () => {
        const result = mapPgError(pgErrors['23502']);
        assert.equal(result.statusCode, 400,
          'statusCode should be 400');
        assert.equal(result.code, '23502',
          'code should be 23502');
        assert.equal(result.message, 'Not-null constraint violation.',
          'message should be the safe text');
        assert.equal(result.details, null,
          'details should be null');
        assert.equal(result.hint, null,
          'hint should be null');
      });

      it('42P01 sanitized — safe message', () => {
        const result = mapPgError(pgErrors['42P01']);
        assert.equal(result.statusCode, 404,
          'statusCode should be 404');
        assert.equal(result.code, '42P01',
          'code should be 42P01');
        assert.equal(result.message, 'Undefined table.',
          'message should be the safe text');
        assert.equal(result.details, null,
          'details should be null');
        assert.equal(result.hint, null,
          'hint should be null');
      });

      it('42703 sanitized — safe message', () => {
        const result = mapPgError(pgErrors['42703']);
        assert.equal(result.statusCode, 400,
          'statusCode should be 400');
        assert.equal(result.code, '42703',
          'code should be 42703');
        assert.equal(result.message, 'Undefined column.',
          'message should be the safe text');
        assert.equal(result.details, null,
          'details should be null');
        assert.equal(result.hint, null,
          'hint should be null');
      });

      it('unmapped code sanitized — fallback safe message', () => {
        const result = mapPgError(pgErrors['55P03']);
        assert.equal(result.statusCode, 500,
          'statusCode should be 500');
        assert.equal(result.code, '55P03',
          'code should be 55P03');
        assert.equal(result.message,
          'Request failed with a database error.',
          'message should be the fallback safe text');
        assert.equal(result.details, null,
          'details should be null');
        assert.equal(result.hint, null,
          'hint should be null');
      });

      it('raw PG text never in sanitized output', () => {
        const leakChecks = [
          { code: '23505', substr: 'users_email_key' },
          { code: '23503', substr: 'orders_user_id_fkey' },
          { code: '23502', substr: 'null value in column' },
          { code: '42P01', substr: 'secret_table' },
          { code: '42703', substr: 'secret_col' },
        ];
        for (const { code, substr } of leakChecks) {
          const result = mapPgError(pgErrors[code]);
          assert.ok(
            !result.message.toLowerCase().includes(substr),
            `sanitized message for ${code} must not contain "${substr}"`,
          );
          assert.equal(result.details, null,
            `details for ${code} must be null`);
        }
      });
    });

    describe('verbose mode', () => {
      it('23505 verbose — raw passthrough', () => {
        const err = pgErrors['23505'];
        const result = mapPgError(err, { verbose: true });
        assert.equal(result.statusCode, 409,
          'statusCode should be 409');
        assert.equal(result.message, err.message,
          'message should be the raw PG message');
        assert.equal(result.details, err.detail,
          'details should be the raw PG detail');
        assert.equal(result.hint, null,
          'hint should be null (no hint on source error)');
      });

      it('unmapped code verbose — raw passthrough', () => {
        const err = pgErrors['55P03'];
        const result = mapPgError(err, { verbose: true });
        assert.equal(result.statusCode, 500,
          'statusCode should be 500');
        assert.equal(result.message,
          'could not obtain lock on relation "accounts"',
          'message should be the raw PG message');
        assert.equal(result.details,
          'Process 1234 waits for ...',
          'details should be the raw PG detail');
        assert.equal(result.hint,
          'See server log for query details.',
          'hint should be the raw PG hint');
      });
    });

    describe('code preservation', () => {
      it('SQLSTATE code preserved in sanitized mode', () => {
        for (const code of ['23505', '23503', '23502', '42P01', '42703', '55P03']) {
          const result = mapPgError(pgErrors[code]);
          assert.equal(result.code, code,
            `code ${code} must be preserved in sanitized mode`);
        }
      });

      it('SQLSTATE code preserved in verbose mode', () => {
        for (const code of ['23505', '55P03']) {
          const result = mapPgError(pgErrors[code], { verbose: true });
          assert.equal(result.code, code,
            `code ${code} must be preserved in verbose mode`);
        }
      });
    });
  });

  describe('map sync guard', () => {
    it('PG_SAFE_MESSAGE and PG_ERROR_MAP have identical keys', () => {
      const { errorMap, safeMessage } = _getMapKeys();
      assert.deepStrictEqual(errorMap, safeMessage,
        'PG_ERROR_MAP and PG_SAFE_MESSAGE must cover '
        + 'the same SQLSTATE codes');
    });
  });
});
