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

// Response headers the SDK reads via response.headers.get(...). Must
// be enumerated in Access-Control-Expose-Headers or cross-origin
// readers see null.
export const EXPOSE_HEADERS =
  'Content-Range, X-Relay-Error, X-Total-Count';

export const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': ALLOW_HEADERS,
  'Access-Control-Allow-Methods':
    'GET,POST,PUT,PATCH,DELETE,OPTIONS',
  'Access-Control-Expose-Headers': EXPOSE_HEADERS,
  'Cache-Control': 'no-store',
  'Content-Type': 'application/json',
};

const STATIC_HEADERS = {
  'Access-Control-Allow-Headers': ALLOW_HEADERS,
  'Access-Control-Allow-Methods':
    'GET,POST,PUT,PATCH,DELETE,OPTIONS',
  'Access-Control-Expose-Headers': EXPOSE_HEADERS,
  'Cache-Control': 'no-store',
  'Content-Type': 'application/json',
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
