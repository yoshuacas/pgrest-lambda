import { CORS_HEADERS, JSON_CONTENT_TYPE } from '../shared/cors.mjs';
import { SESSION_EXPIRY_SECONDS } from './constants.mjs';

export function sessionResponse(accessToken, refreshToken, user, corsH) {
  return {
    statusCode: 200,
    headers: jsonHeaders(corsH),
    body: JSON.stringify({
      access_token: accessToken,
      token_type: 'bearer',
      expires_in: SESSION_EXPIRY_SECONDS,
      expires_at: Math.floor(Date.now() / 1000) + SESSION_EXPIRY_SECONDS,
      refresh_token: refreshToken,
      user: formatUser(user),
    }),
  };
}

export function userResponse(user, corsH) {
  return {
    statusCode: 200,
    headers: jsonHeaders(corsH),
    body: JSON.stringify(formatUser(user)),
  };
}

export function logoutResponse(corsH) {
  return { statusCode: 204, headers: resolveCors(corsH) };
}

export function errorResponse(statusCode, error, description, extra, corsH) {
  return {
    statusCode,
    headers: jsonHeaders(corsH),
    body: JSON.stringify({
      error,
      error_description: description,
      ...extra,
    }),
  };
}

function formatUser(user) {
  return {
    id: user.id,
    email: user.email,
    role: 'authenticated',
    aud: 'authenticated',
    app_metadata: user.app_metadata || {
      provider: 'email',
      providers: ['email'],
    },
    user_metadata: user.user_metadata || {},
    created_at: user.created_at || new Date().toISOString(),
  };
}

function resolveCors(corsH) {
  return corsH ? { ...corsH } : { ...CORS_HEADERS };
}

// Headers for a response that carries a JSON body. The CORS blocks no longer
// include Content-Type (see src/shared/cors.mjs), so the builders that
// serialize bytes add it and the bodyless ones (logoutResponse, 204) do not.
function jsonHeaders(corsH) {
  return { ...resolveCors(corsH), 'Content-Type': JSON_CONTENT_TYPE };
}
