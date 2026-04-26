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

const PG_ERROR_MAP = {
  '23505': 409, // unique constraint violation
  '23503': 409, // foreign key violation
  '23502': 400, // not-null violation
  '42P01': 404, // undefined table
  '42703': 400, // undefined column
};

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

export function mapPgError(pgError) {
  const statusCode = PG_ERROR_MAP[pgError.code] || 500;
  return new PostgRESTError(
    statusCode,
    pgError.code,
    pgError.message,
    pgError.detail || null,
    pgError.hint || null,
  );
}
