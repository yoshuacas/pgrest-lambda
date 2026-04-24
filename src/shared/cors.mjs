export const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'Accept, Authorization, Content-Type, Prefer, apikey, X-Client-Info',
  'Access-Control-Allow-Methods':
    'GET,POST,PUT,PATCH,DELETE,OPTIONS',
  'Access-Control-Expose-Headers': 'Content-Range',
  'Cache-Control': 'no-store',
  'Content-Type': 'application/json',
};

const STATIC_HEADERS = {
  'Access-Control-Allow-Headers':
    'Accept, Authorization, Content-Type, Prefer, apikey, X-Client-Info',
  'Access-Control-Allow-Methods':
    'GET,POST,PUT,PATCH,DELETE,OPTIONS',
  'Access-Control-Expose-Headers': 'Content-Range',
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
