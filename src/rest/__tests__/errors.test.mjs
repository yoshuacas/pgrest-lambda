import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  PostgRESTError, mapPgError, _getMapKeys, pgStatusFor,
} from '../errors.mjs';

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

    // Upstream's mapSQLtoHTTP ends in `_ -> HTTP.status400`: an SQLSTATE it
    // does not recognise is the client's fault, because nearly all of them are
    // (invalid input syntax, numeric overflow, check violation, ...). Only the
    // classes it lists explicitly are server errors. This assertion used to
    // expect 500, which turned every data exception into a PGRST000.
    it('maps an unrecognised PG code to HTTP 400, as upstream does', () => {
      const result = mapPgError({ code: '99999', message: 'unknown error' });
      assert.equal(result.statusCode, 400,
        'unrecognised SQLSTATE should fall through to 400');
    });
  });

  describe('pgStatusFor() — ported from upstream mapSQLtoHTTP', () => {
    it('maps data exceptions (class 22) to 400', () => {
      assert.equal(pgStatusFor('22P02',
        'invalid input syntax for type integer: "baz"'), 400);
      assert.equal(pgStatusFor('22003', 'numeric field overflow'), 400);
      assert.equal(pgStatusFor('22001', 'value too long'), 400);
    });

    it('maps integrity violations the way upstream does', () => {
      assert.equal(pgStatusFor('23503', 'fk'), 409);
      assert.equal(pgStatusFor('23505', 'unique'), 409);
      assert.equal(pgStatusFor('23502', 'not null'), 400);
      assert.equal(pgStatusFor('23514', 'check'), 400);
    });

    it('matches whole classes on their two-character prefix', () => {
      assert.equal(pgStatusFor('08006', 'connection failure'), 503);
      assert.equal(pgStatusFor('0LP01', 'invalid grantor'), 403);
      assert.equal(pgStatusFor('28000', 'invalid authorization'), 403);
      assert.equal(pgStatusFor('25001', 'invalid tx state'), 500);
      assert.equal(pgStatusFor('40001', 'serialization failure'), 500);
      assert.equal(pgStatusFor('53200', 'out of memory'), 503);
      assert.equal(pgStatusFor('XX000', 'internal error'), 500);
    });

    it('exact codes win over their class prefix', () => {
      // 53400 is 500 while the rest of class 53 is 503.
      assert.equal(pgStatusFor('53400', 'config limit exceeded'), 500);
      assert.equal(pgStatusFor('53300', 'too many connections'), 503);
      // 57P01 is 503 while the rest of class 57 is 500.
      assert.equal(pgStatusFor('57P01', 'terminating connection'), 503);
      assert.equal(pgStatusFor('57014', 'query canceled'), 500);
      // P0001 (RAISE) is 400 while the rest of class P0 is 500.
      assert.equal(pgStatusFor('P0001', 'raised'), 400);
      assert.equal(pgStatusFor('P0002', 'no data found'), 500);
    });

    it('branches 21000 on the pg-safeupdate message', () => {
      assert.equal(pgStatusFor('21000',
        'DELETE requires a WHERE clause'), 400);
      assert.equal(pgStatusFor('21000',
        'more than one row returned by a subquery'), 500);
    });

    it('branches 22023 on the missing-role message', () => {
      assert.equal(pgStatusFor('22023', 'role "ghost" does not exist'), 401);
      assert.equal(pgStatusFor('22023', 'invalid regular expression'), 400);
    });

    it('branches 42883 on the xmlagg message', () => {
      assert.equal(pgStatusFor('42883',
        'function xmlagg(record) does not exist'), 406);
      assert.equal(pgStatusFor('42883',
        'function nope(integer) does not exist'), 404);
    });

    it('answers 401 for insufficient_privilege only when unauthenticated', () => {
      assert.equal(pgStatusFor('42501', 'permission denied', true), 403);
      assert.equal(pgStatusFor('42501', 'permission denied', false), 401);
    });

    it('reads the status out of a PT<nnn> code', () => {
      assert.equal(pgStatusFor('PT402', 'Payment Required'), 402);
      assert.equal(pgStatusFor('PT301', 'Moved'), 301);
      // Out of the HTTP range: refuse rather than emit a bogus status.
      assert.equal(pgStatusFor('PT999', 'nope'), 500);
    });

    it('treats a missing or empty code as a client error', () => {
      assert.equal(pgStatusFor(undefined, ''), 400);
      assert.equal(pgStatusFor('', ''), 400);
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
    // The status map and the safe-message map no longer have to agree key for
    // key: the status map now mirrors upstream's mapSQLtoHTTP, which assigns a
    // status to codes and whole classes that need no bespoke sanitized wording
    // (they get PG_SAFE_FALLBACK). What must still hold is the property the
    // guard existed for — sanitized mode never leaks a server message.
    it('every mapped SQLSTATE has a sanitized message, without exception', () => {
      const { errorMap, safeMessage } = _getMapKeys();
      const leaky = 'Key (email)=(alice@example.com) already exists';
      for (const code of [...new Set([...errorMap, ...safeMessage,
        '22P02', '99999', 'XX000', 'PT402'])]) {
        const mapped = mapPgError({ code, message: leaky, detail: leaky });
        assert.notEqual(mapped.message, leaky,
          `sanitized mode leaked the server message for ${code}`);
        assert.ok(mapped.message.length > 0,
          `sanitized mode produced no message for ${code}`);
        assert.equal(mapped.details, null,
          `sanitized mode leaked details for ${code}`);
        assert.equal(mapped.hint, null,
          `sanitized mode leaked a hint for ${code}`);
      }
    });

    it('every code with a safe message also has a status', () => {
      const { safeMessage } = _getMapKeys();
      for (const code of safeMessage) {
        assert.equal(typeof pgStatusFor(code, ''), 'number',
          `${code} has a sanitized message but no status`);
      }
    });
  });
});
