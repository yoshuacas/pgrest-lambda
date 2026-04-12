import { CORS_HEADERS } from '../shared/cors.mjs';

export function sessionResponse(accessToken, refreshToken, user) {
  return {
    statusCode: 200,
    headers: corsHeaders(),
    body: JSON.stringify({
      access_token: accessToken,
      token_type: 'bearer',
      expires_in: 3600,
      refresh_token: refreshToken,
      user: formatUser(user),
    }),
  };
}

export function userResponse(user) {
  return {
    statusCode: 200,
    headers: corsHeaders(),
    body: JSON.stringify(formatUser(user)),
  };
}

export function logoutResponse() {
  return { statusCode: 204, headers: corsHeaders() };
}

export function errorResponse(statusCode, error, description, extra) {
  return {
    statusCode,
    headers: corsHeaders(),
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

function corsHeaders() {
  return { ...CORS_HEADERS };
}
