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
