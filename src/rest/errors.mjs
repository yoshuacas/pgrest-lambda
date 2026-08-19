// errors.mjs — PostgRESTError class and PG error mapping

export class PostgRESTError extends Error {
  constructor(statusCode, code, message, details = null, hint = null) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.hint = hint;
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      details: this.details,
      hint: this.hint,
    };
  }
}

// SQLSTATE -> HTTP status, ported from upstream PostgREST's `mapSQLtoHTTP`
// (src/library/PostgREST/Error.hs). Two things about that function matter and
// were previously inverted here:
//
//  1. The fall-through is **400**, not 500. An unrecognised SQLSTATE is treated
//     as the client's fault, because the overwhelming majority of them are
//     (`22P02` invalid input syntax, `22003` numeric out of range, `23514`
//     check violation, ...). Only the classes explicitly listed below are
//     server errors. Defaulting to 500 turned every data exception into
//     "PGRST000 Request failed with a database error".
//  2. Whole classes are matched on their two-character prefix, not on exact
//     five-character codes, so the table has to be consulted prefix-first.
//
// Exact codes win over class prefixes, which is why they are separate maps.
const PG_STATUS_BY_CODE = {
  '23503': 409, // foreign_key_violation
  '23505': 409, // unique_violation
  '25006': 405, // read_only_sql_transaction
  '53400': 500, // configuration_limit_exceeded
  '57P01': 503, // admin_shutdown
  '42P01': 404, // undefined_table
  '42P17': 500, // infinite_recursion
  '42501': 403, // insufficient_privilege (401 when unauthenticated)
};

// Two-character SQLSTATE class prefixes. Anything not listed falls through to
// 400, matching upstream's final `_ -> HTTP.status400`.
const PG_STATUS_BY_CLASS = {
  '08': 503, // connection exception
  '09': 500, // triggered action exception
  '0L': 403, // invalid grantor
  '0P': 403, // invalid role specification
  25: 500, // invalid transaction state
  28: 403, // invalid authorization specification
  '2D': 500, // invalid transaction termination
  38: 500, // external routine exception
  39: 500, // external routine invocation exception
  '3B': 500, // savepoint exception
  40: 500, // transaction rollback
  53: 503, // insufficient resources
  54: 500, // program limit exceeded ("too complex")
  55: 500, // object not in prerequisite state
  57: 500, // operator intervention
  58: 500, // system error
  F0: 500, // configuration file error
  HV: 500, // foreign data wrapper error
  P0: 500, // PL/pgSQL error (P0001 "raise" is 400, handled below)
  XX: 500, // internal error
};

/**
 * HTTP status for a PostgreSQL SQLSTATE, following upstream exactly.
 *
 * @param {string} code five-character SQLSTATE
 * @param {string} message server message; a few codes branch on it
 * @param {boolean} authed whether the request carried an identity — upstream
 *        answers 401 rather than 403 for `insufficient_privilege` when it did
 *        not, so an anonymous caller is told to authenticate
 */
export function pgStatusFor(code, message = '', authed = true) {
  const c = String(code || '');
  const m = String(message || '');

  // Message-dependent cases first; upstream orders them before its class
  // prefixes for the same reason.
  if (c === '21000') {
    // cardinality_violation. pg-safeupdate's "requires a WHERE clause" is a
    // client error; anything else here is a function or view returning more
    // rows than the caller's expression allows, which is a server error.
    return m.endsWith('requires a WHERE clause') ? 400 : 500;
  }
  if (c === '22023') {
    // invalid_parameter_value. A JWT naming a role that does not exist must be
    // 401, not 400 (upstream issue #3601).
    return /^role\b/.test(m) && m.endsWith('does not exist') ? 401 : 400;
  }
  if (c === '42883') {
    // undefined_function; the xmlagg case is a media-type negotiation failure.
    return m.startsWith('function xmlagg(') ? 406 : 404;
  }
  if (c === 'P0001') return 400; // default code for RAISE
  if (c === '42501') return authed ? 403 : 401;

  // `PT<nnn>` lets a function pick the status directly, e.g. PT402 -> 402.
  const pt = /^PT(\d{3})$/.exec(c);
  if (pt) {
    const n = parseInt(pt[1], 10);
    if (n >= 100 && n <= 599) return n;
    return 500;
  }

  if (Object.hasOwn(PG_STATUS_BY_CODE, c)) return PG_STATUS_BY_CODE[c];
  const byClass = PG_STATUS_BY_CLASS[c.slice(0, 2)];
  if (byClass) return byClass;

  return 400; // upstream's fall-through
}

const PG_SAFE_MESSAGE = {
  '23505': 'Uniqueness violation.',
  '23503': 'Foreign key violation.',
  '23502': 'Not-null constraint violation.',
  '42P01': 'Undefined table.',
  '42703': 'Undefined column.',
};

const PG_SAFE_FALLBACK =
  'Request failed with a database error.';

// PostgREST-compatible error codes used by resource embedding
// (thrown directly via PostgRESTError, not mapped from PG):
//
// PGRST200 — Could not find a relationship between tables
//            HTTP 400. Thrown when an embed name doesn't match
//            any FK relationship, or when a !hint matches zero
//            relationships.
//
// PGRST201 — Ambiguous relationship (multiple matches)
//            HTTP 300. Thrown when multiple FK relationships
//            exist between two tables and no !hint is provided,
//            or the hint still matches multiple. Response
//            includes details array and hint suggestion.
//
// PGRST204 — Column not found (already used by sql-builder
//            for flat selects; also applies to columns inside
//            embed select lists)
//
// PGRST501 — Feature requires unsupported database
//            capability. HTTP 501. Thrown when a REST
//            request uses a feature (FTS, range ops,
//            etc.) that the current database provider
//            does not support. Response includes a
//            message naming the feature and provider,
//            and a hint suggesting alternatives.
//
// Usage pattern (for future feature loops):
//
//   throw new PostgRESTError(
//     501, 'PGRST501',
//     `operator '${op}' requires full-text search `
//     + `support, which Aurora DSQL does not provide`,
//     null,
//     `use 'ilike' or a separate search index, `
//     + `or deploy on standard PostgreSQL`,
//   );
//
// PGRST101 — Unsupported HTTP method for RPC.
//            HTTP 405. Only GET, POST, HEAD allowed.
//
// PGRST202 — Function not found in schema cache.
//            HTTP 404.
//
// PGRST203 — Overloaded function. HTTP 300.
//
// PGRST207 — Unknown function argument. HTTP 400.
//            pgrest-lambda-specific.
//
// PGRST208 — Type coercion failure. HTTP 400.
//            pgrest-lambda-specific.
//
// PGRST209 — Missing required function argument.
//            HTTP 400. pgrest-lambda-specific.

export function _getMapKeys() {
  return {
    errorMap: Object.keys(PG_STATUS_BY_CODE).sort(),
    safeMessage: Object.keys(PG_SAFE_MESSAGE).sort(),
  };
}

export function mapPgError(pgError, { verbose = false, authed = true } = {}) {
  const statusCode = pgStatusFor(pgError.code, pgError.message, authed);

  if (verbose) {
    return new PostgRESTError(
      statusCode,
      pgError.code,
      pgError.message,
      pgError.detail || null,
      pgError.hint || null,
    );
  }

  const safeMessage =
    PG_SAFE_MESSAGE[pgError.code] || PG_SAFE_FALLBACK;
  return new PostgRESTError(
    statusCode,
    pgError.code,
    safeMessage,
    null,
    null,
  );
}
