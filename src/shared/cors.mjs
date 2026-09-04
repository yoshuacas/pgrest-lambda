// Request headers the @supabase/* SDK family (auth-js, postgrest-js,
// storage-js, functions-js) sends on outbound requests. Any header not
// listed here will cause a browser to fail the CORS preflight and
// block the actual request — even if Access-Control-Allow-Origin is
// correct. Verified against @supabase/supabase-js@2.105 by grepping
// every package's compiled sources for outbound header sets.
export const ALLOW_HEADERS =
  'Accept, Accept-Profile, Authorization, Content-Profile, '
  + 'Content-Type, Prefer, Range, apikey, X-Client-Info, '
  + 'X-Metadata, X-Region, X-Retry-Count, X-Supabase-Api-Version, X-Upsert';

// Response headers a cross-origin reader is allowed to see. This is
// PostgREST's own list, verbatim (`corsExposedHeaders` in
// src/library/PostgREST/Cors.hs), because the browser side of
// @supabase/supabase-js is written against it: `Content-Range` for counts,
// `Content-Location`/`Location` for created rows, `Range-Unit` for the range
// vocabulary. Headers this engine never emits are not listed — enumerating
// them exposed nothing.
export const EXPOSE_HEADERS =
  'Content-Encoding, Content-Location, Content-Range, Content-Type, '
  + 'Date, Location, Server, Transfer-Encoding, Range-Unit';

// The methods a relation or a function can be reached with. PostgREST's
// policy lists GET, POST, PATCH, PUT, DELETE and OPTIONS; the wai-cors
// middleware it hands them to adds the "simple" methods, which is where HEAD
// comes from and why the order is this and not alphabetical.
export const ALLOW_METHODS =
  'GET, POST, PATCH, PUT, DELETE, OPTIONS, HEAD';

// wai-cors always appends the "simple" request headers to the allow-list it
// answers a preflight with (Content-Type is not among them: it is only simple
// for a subset of values, so it has to be asked for).
const SIMPLE_REQUEST_HEADERS = ['Accept', 'Accept-Language', 'Content-Language'];

// One day, as `corsMaxAge = Just $ 60*60*24`.
export const PREFLIGHT_MAX_AGE = '86400';

// The JSON media type the auth layer serves. It lives here only so the auth
// response builders share one spelling; it is deliberately NOT part of the
// CORS header blocks below.
export const JSON_CONTENT_TYPE = 'application/json';

// Content-Type is a property of the payload, not of CORS, so it is not in
// these blocks. Every response builder sets it on the branches that actually
// serialize bytes and leaves it off the bodyless ones (204, OPTIONS
// preflight, HEAD). PostgREST asserts its absence on those — a Content-Type
// on a 204 tells the client to expect bytes that are not coming.
export const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': ALLOW_HEADERS,
  'Access-Control-Allow-Methods': ALLOW_METHODS,
  'Access-Control-Expose-Headers': EXPOSE_HEADERS,
  'Cache-Control': 'no-store',
};

const STATIC_HEADERS = {
  'Access-Control-Allow-Headers': ALLOW_HEADERS,
  'Access-Control-Allow-Methods': ALLOW_METHODS,
  'Access-Control-Expose-Headers': EXPOSE_HEADERS,
  'Cache-Control': 'no-store',
};

export function buildCorsHeaders(corsConfig, origin) {
  if (!corsConfig) {
    return { ...CORS_HEADERS };
  }

  const { allowedOrigins, allowCredentials } = corsConfig;
  const headers = { ...STATIC_HEADERS };

  if (allowedOrigins === '*') {
    headers['Access-Control-Allow-Origin'] = '*';
    return headers;
  }

  headers['Vary'] = 'Origin';

  let allowed = false;
  if (Array.isArray(allowedOrigins)) {
    allowed = allowedOrigins.includes(origin);
  } else if (typeof allowedOrigins === 'function') {
    allowed = allowedOrigins(origin);
  }

  if (allowed && origin) {
    headers['Access-Control-Allow-Origin'] = origin;
    if (allowCredentials) {
      headers['Access-Control-Allow-Credentials'] = 'true';
    }
  }

  return headers;
}

/**
 * The extra headers a CORS preflight answer carries, on top of the origin and
 * method blocks every response gets.
 *
 * A preflight is an OPTIONS request that names the method it is asking about
 * in `Access-Control-Request-Method`. PostgREST answers it out of the wai-cors
 * middleware, before the request ever reaches a table: the allow-list is
 * `Authorization` plus the headers the caller asked for, plus the simple
 * request headers, and the answer is cacheable for a day.
 *
 * Without an `Access-Control-Request-Headers` to echo there is nothing to
 * reflect, so the static allow-list stands — it is a superset of what a
 * browser could be asking about.
 *
 * @param {string} [requestedHeaders] the raw Access-Control-Request-Headers
 * @returns {Object} headers to merge into the preflight response
 */
export function preflightHeaders(requestedHeaders) {
  const asked = String(requestedHeaders || '')
    .split(',')
    .map(h => h.trim())
    .filter(Boolean);

  const allow = asked.length > 0
    ? ['Authorization', ...asked, ...SIMPLE_REQUEST_HEADERS].join(', ')
    : ALLOW_HEADERS;

  return {
    'Access-Control-Allow-Headers': allow,
    'Access-Control-Max-Age': PREFLIGHT_MAX_AGE,
  };
}

export function assertCorsConfig(corsConfig, production) {
  if (production && corsConfig.allowedOrigins === '*') {
    throw new Error(
      'pgrest-lambda: CORS allowedOrigins=\'*\' is not '
      + 'allowed when production mode is enabled. Provide '
      + 'an explicit list of origins in '
      + 'config.cors.allowedOrigins.'
    );
  }
}
