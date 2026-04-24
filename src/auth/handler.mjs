import { createProvider } from './providers/interface.mjs';
import {
  sessionResponse,
  userResponse,
  logoutResponse,
  errorResponse,
} from './gotrue-response.mjs';
import { buildCorsHeaders } from '../shared/cors.mjs';
import {
  createSession,
  resolveSession,
  updateSessionPrt,
  revokeUserSessions,
} from './sessions.mjs';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const ERROR_STATUS = {
  user_already_exists: 400,
  invalid_grant: 400,
  weak_password: 422,
  validation_failed: 400,
  user_not_found: 404,
  unexpected_failure: 500,
};

const ERROR_DESCRIPTION = {
  user_already_exists: 'User already registered',
  invalid_grant: 'Invalid login credentials',
  weak_password:
    'Password must be at least 8 characters and include uppercase, lowercase, and numbers',
  user_not_found: 'User not found',
  unexpected_failure: 'An unexpected error occurred',
};

function providerErrorResponse(err, corsHeaders) {
  const code = err.code || 'unexpected_failure';
  const status = ERROR_STATUS[code] || 500;
  const desc = ERROR_DESCRIPTION[code] || 'An unexpected error occurred';
  const extra = code === 'weak_password' && err.reasons
    ? { weak_password: { reasons: err.reasons } }
    : undefined;
  return errorResponse(status, code, desc, extra, corsHeaders);
}

export function createAuthHandler(config, ctx) {
  const jwt = ctx.jwt;
  const corsConfig = ctx.cors;

  async function getProvider() {
    if (!ctx.authProvider) {
      const result = await createProvider(config.auth, ctx.db);
      ctx.authProvider = result.provider;
      ctx.authProviderSetClient = result._setClient;
    }
    return ctx.authProvider;
  }

  function _setProvider(p) {
    ctx.authProvider = p;
  }

  async function handler(event) {
    const method = event.httpMethod;
    const origin =
      (event.headers?.Origin
        || event.headers?.origin
        || '');
    const corsHeaders = buildCorsHeaders(corsConfig, origin);

    if (method === 'OPTIONS') {
      return { statusCode: 200, headers: corsHeaders };
    }

    const path = event.path || '';
    const match = path.match(/^\/auth\/v1\/(\w+)$/);
    if (!match) {
      return errorResponse(404, 'not_found', 'Endpoint not found', undefined, corsHeaders);
    }

    const action = match[1];

    switch (action) {
      case 'signup':
        return handleSignup(event, corsHeaders);
      case 'token':
        return handleToken(event, corsHeaders);
      case 'user':
        return handleGetUser(event, corsHeaders);
      case 'logout':
        return handleLogout(event, corsHeaders);
      default:
        return errorResponse(404, 'not_found', 'Endpoint not found', undefined, corsHeaders);
    }
  }

  async function handleSignup(event, corsHeaders) {
    const body = JSON.parse(event.body || '{}');
    const { email, password } = body;

    if (!email) {
      return errorResponse(400, 'validation_failed', 'Email is required', undefined, corsHeaders);
    }
    if (!password) {
      return errorResponse(400, 'validation_failed', 'Password is required', undefined, corsHeaders);
    }
    if (!EMAIL_RE.test(email)) {
      return errorResponse(400, 'validation_failed', 'Invalid email format', undefined, corsHeaders);
    }

    try {
      const prov = await getProvider();
      const user = await prov.signUp(email, password);
      const { providerTokens } = await prov.signIn(email, password);
      const pool = await ctx.db.getPool();
      const providerName = config.auth?.provider || 'cognito';
      const { sid } = await createSession(pool, {
        userId: user.id,
        provider: providerName,
        prt: providerTokens.refreshToken,
      });
      const accessToken = jwt.signAccessToken({ sub: user.id, email });
      const refreshToken = jwt.signRefreshToken(user.id, sid);
      return sessionResponse(accessToken, refreshToken, user, corsHeaders);
    } catch (err) {
      return providerErrorResponse(err, corsHeaders);
    }
  }

  async function handleToken(event, corsHeaders) {
    const query = event.queryStringParameters || {};
    const grantType = query.grant_type;

    if (!grantType || (grantType !== 'password' && grantType !== 'refresh_token')) {
      return errorResponse(
        400,
        'unsupported_grant_type',
        'Missing or unsupported grant_type',
        undefined,
        corsHeaders
      );
    }

    if (grantType === 'password') {
      return handlePasswordGrant(event, corsHeaders);
    }
    return handleRefreshGrant(event, corsHeaders);
  }

  async function handlePasswordGrant(event, corsHeaders) {
    const body = JSON.parse(event.body || '{}');
    const { email, password } = body;

    if (!email) {
      return errorResponse(400, 'validation_failed', 'Email is required', undefined, corsHeaders);
    }
    if (!password) {
      return errorResponse(400, 'validation_failed', 'Password is required', undefined, corsHeaders);
    }

    try {
      const prov = await getProvider();
      const { user, providerTokens } = await prov.signIn(email, password);
      const pool = await ctx.db.getPool();
      const providerName = config.auth?.provider || 'cognito';
      const { sid } = await createSession(pool, {
        userId: user.id,
        provider: providerName,
        prt: providerTokens.refreshToken,
      });
      const accessToken = jwt.signAccessToken({ sub: user.id, email: user.email });
      const refreshToken = jwt.signRefreshToken(user.id, sid);
      return sessionResponse(accessToken, refreshToken, user, corsHeaders);
    } catch (err) {
      return providerErrorResponse(err, corsHeaders);
    }
  }

  async function handleRefreshGrant(event, corsHeaders) {
    const body = JSON.parse(event.body || '{}');
    const { refresh_token } = body;

    if (!refresh_token) {
      return errorResponse(
        400,
        'validation_failed',
        'Refresh token is required',
        undefined,
        corsHeaders
      );
    }

    let claims;
    try {
      claims = jwt.verifyToken(refresh_token);
    } catch {
      return errorResponse(401, 'invalid_grant', 'Invalid refresh token', undefined, corsHeaders);
    }

    if (!claims.sid) {
      return errorResponse(401, 'invalid_grant', 'Invalid refresh token', undefined, corsHeaders);
    }

    try {
      const pool = await ctx.db.getPool();
      const session = await resolveSession(pool, claims.sid);
      if (!session) {
        return errorResponse(401, 'invalid_grant', 'Invalid refresh token', undefined, corsHeaders);
      }
      if (session.revoked) {
        return errorResponse(401, 'invalid_grant', 'Invalid refresh token', undefined, corsHeaders);
      }
      const providerName = config.auth?.provider || 'cognito';
      if (session.provider !== providerName) {
        return errorResponse(401, 'invalid_grant', 'Invalid refresh token', undefined, corsHeaders);
      }

      const prov = await getProvider();
      const { user, providerTokens } = await prov.refreshToken(session.prt);
      await updateSessionPrt(pool, claims.sid, providerTokens.refreshToken);
      const accessToken = jwt.signAccessToken({
        sub: claims.sub,
        email: user.email,
      });
      const newRefreshToken = jwt.signRefreshToken(claims.sub, claims.sid);
      return sessionResponse(accessToken, newRefreshToken, user, corsHeaders);
    } catch {
      return errorResponse(401, 'invalid_grant', 'Invalid refresh token', undefined, corsHeaders);
    }
  }

  async function handleGetUser(event, corsHeaders) {
    const authHeader =
      event.headers?.Authorization || event.headers?.authorization || '';

    if (!authHeader.startsWith('Bearer ')) {
      return errorResponse(
        401,
        'not_authenticated',
        'Missing authorization header',
        undefined,
        corsHeaders
      );
    }

    const token = authHeader.slice(7);
    let claims;
    try {
      claims = jwt.verifyToken(token);
    } catch {
      return errorResponse(
        401,
        'not_authenticated',
        'Invalid or expired token',
        undefined,
        corsHeaders
      );
    }

    const user = {
      id: claims.sub,
      email: claims.email,
      app_metadata: { provider: 'email', providers: ['email'] },
      user_metadata: {},
      created_at: new Date().toISOString(),
    };
    return userResponse(user, corsHeaders);
  }

  async function handleLogout(event, corsHeaders) {
    const authHeader =
      event.headers?.Authorization || event.headers?.authorization || '';

    if (authHeader.startsWith('Bearer ')) {
      const token = authHeader.slice(7);
      try {
        const claims = jwt.verifyToken(token);
        const pool = await ctx.db.getPool();
        await revokeUserSessions(pool, claims.sub);
        const prov = await getProvider();
        await prov.signOut(claims.sub);
      } catch {
        // Best-effort: if the token is invalid we still return 204
      }
    }

    return logoutResponse(corsHeaders);
  }

  function getOpenApiPaths(baseUrl) {
    const authUrl = baseUrl.replace(/\/rest\/v1\/?$/, '/auth/v1');
    const server = [{ url: authUrl }];
    const sessionRef = '#/components/schemas/AuthSession';
    const userRef = '#/components/schemas/AuthUser';
    const errorRef = '#/components/schemas/AuthError';
    const tag = 'Auth';

    return {
      paths: {
        '/signup': {
          servers: server,
          post: {
            tags: [tag],
            summary: 'Sign up',
            description: 'Create a new user account with email and password.',
            requestBody: {
              required: true,
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['email', 'password'],
                    properties: {
                      email: { type: 'string', format: 'email' },
                      password: { type: 'string', minLength: 8 },
                    },
                  },
                },
              },
            },
            responses: {
              200: { description: 'Account created', content: { 'application/json': { schema: { $ref: sessionRef } } } },
              400: { description: 'Validation error or user exists', content: { 'application/json': { schema: { $ref: errorRef } } } },
            },
            security: [],
          },
        },
        '/token?grant_type=password': {
          servers: server,
          post: {
            tags: [tag],
            summary: 'Sign in',
            description: 'Authenticate with email and password.',
            requestBody: {
              required: true,
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['email', 'password'],
                    properties: {
                      email: { type: 'string', format: 'email' },
                      password: { type: 'string' },
                    },
                  },
                },
              },
            },
            responses: {
              200: { description: 'Authenticated', content: { 'application/json': { schema: { $ref: sessionRef } } } },
              400: { description: 'Invalid credentials', content: { 'application/json': { schema: { $ref: errorRef } } } },
            },
            security: [],
          },
        },
        '/token?grant_type=refresh_token': {
          servers: server,
          post: {
            tags: [tag],
            summary: 'Refresh token',
            description: 'Get a new access token using a refresh token.',
            requestBody: {
              required: true,
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['refresh_token'],
                    properties: {
                      refresh_token: { type: 'string' },
                    },
                  },
                },
              },
            },
            responses: {
              200: { description: 'Token refreshed', content: { 'application/json': { schema: { $ref: sessionRef } } } },
              401: { description: 'Invalid refresh token', content: { 'application/json': { schema: { $ref: errorRef } } } },
            },
            security: [],
          },
        },
        '/user': {
          servers: server,
          get: {
            tags: [tag],
            summary: 'Get current user',
            description: 'Retrieve the authenticated user profile.',
            responses: {
              200: { description: 'User profile', content: { 'application/json': { schema: { $ref: userRef } } } },
              401: { description: 'Not authenticated', content: { 'application/json': { schema: { $ref: errorRef } } } },
            },
          },
        },
        '/logout': {
          servers: server,
          post: {
            tags: [tag],
            summary: 'Sign out',
            description: 'Invalidate the current session.',
            responses: {
              204: { description: 'Signed out' },
            },
          },
        },
      },
      schemas: {
        AuthSession: {
          type: 'object',
          properties: {
            access_token: { type: 'string' },
            token_type: { type: 'string', example: 'bearer' },
            expires_in: { type: 'integer', example: 3600 },
            expires_at: { type: 'integer' },
            refresh_token: { type: 'string' },
            user: { $ref: '#/components/schemas/AuthUser' },
          },
        },
        AuthUser: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            email: { type: 'string', format: 'email' },
            app_metadata: { type: 'object' },
            user_metadata: { type: 'object' },
            created_at: { type: 'string', format: 'date-time' },
          },
        },
        AuthError: {
          type: 'object',
          properties: {
            error: { type: 'string' },
            error_description: { type: 'string' },
          },
        },
      },
    };
  }

  return { handler, getOpenApiPaths, _setProvider };
}
