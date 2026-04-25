import { createProvider } from './providers/interface.mjs';
import {
  sessionResponse,
  userResponse,
  logoutResponse,
  errorResponse,
} from './gotrue-response.mjs';
import { buildCorsHeaders } from '../shared/cors.mjs';
import { isSafeRedirect } from '../shared/url.mjs';
import { createTokenVerifier } from './verify-token.mjs';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const SUPPORTED_OAUTH_PROVIDERS = ['google', 'github', 'apple', 'facebook', 'azure'];

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
  const desc = err.code === 'validation_failed'
    ? (err.message || 'An unexpected error occurred')
    : (ERROR_DESCRIPTION[code] || 'An unexpected error occurred');
  const extra = code === 'weak_password' && err.reasons
    ? { weak_password: { reasons: err.reasons } }
    : undefined;
  return errorResponse(status, code, desc, extra, corsHeaders);
}

export function createAuthHandler(config, ctx) {
  const jwt = ctx.jwt;
  const corsConfig = ctx.cors;

  const verifier = createTokenVerifier({
    jwtSecret: config.jwtSecret,
    jwksUrl: config.jwksUrl,
    localJwksProvider: async () => {
      const prov = await getProvider();
      if (prov.issuesOwnAccessToken && prov.getJwks) {
        return prov.getJwks();
      }
      return null;
    },
  });

  async function getProvider() {
    if (!ctx.authProvider) {
      const result = await createProvider(config.auth);
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
    const prov = await getProvider();

    try {
      switch (action) {
        case 'signup':
          return await handleSignup(event, prov, corsHeaders);
        case 'token':
          return await handleToken(event, prov, corsHeaders);
        case 'user':
          return await handleGetUser(event, prov, corsHeaders);
        case 'logout':
          return await handleLogout(event, prov, corsHeaders);
        case 'otp':
          if (!prov.sendOtp) return errorResponse(404, 'not_found', 'Endpoint not found', undefined, corsHeaders);
          return await handleOtp(event, prov, corsHeaders);
        case 'verify':
          if (!prov.verifyOtp) return errorResponse(404, 'not_found', 'Endpoint not found', undefined, corsHeaders);
          return await handleVerify(event, prov, corsHeaders);
        case 'authorize':
          if (!prov.getOAuthRedirectUrl) return errorResponse(404, 'not_found', 'Endpoint not found', undefined, corsHeaders);
          return await handleAuthorize(event, prov, corsHeaders);
        case 'callback':
          if (!prov.handleOAuthCallback) return errorResponse(404, 'not_found', 'Endpoint not found', undefined, corsHeaders);
          return await handleCallback(event, prov, corsHeaders);
        case 'jwks':
          if (!prov.getJwks) return errorResponse(404, 'not_found', 'Endpoint not found', undefined, corsHeaders);
          return await handleJwks(prov, corsHeaders);
        default:
          return errorResponse(404, 'not_found', 'Endpoint not found', undefined, corsHeaders);
      }
    } catch (err) {
      if (err instanceof SyntaxError) {
        return {
          statusCode: 400,
          headers: corsHeaders,
          body: JSON.stringify({
            error: 'validation_failed',
            error_description: 'Invalid JSON in request body',
          }),
        };
      }
      throw err;
    }
  }

  async function handleSignup(event, prov, corsHeaders) {
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
      if (prov.issuesOwnAccessToken) {
        const result = await prov.signUp(email, password);
        return sessionResponse(result.accessToken, result.refreshToken, result.user, corsHeaders);
      }

      const user = await prov.signUp(email, password);
      const { user: signInUser, providerTokens } = await prov.signIn(email, password);
      const accessToken = jwt.signAccessToken({ sub: user.id, email });
      return sessionResponse(accessToken, providerTokens.refreshToken, signInUser, corsHeaders);
    } catch (err) {
      return providerErrorResponse(err, corsHeaders);
    }
  }

  async function handleToken(event, prov, corsHeaders) {
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
      return handlePasswordGrant(event, prov, corsHeaders);
    }
    return handleRefreshGrant(event, prov, corsHeaders);
  }

  async function handlePasswordGrant(event, prov, corsHeaders) {
    const body = JSON.parse(event.body || '{}');
    const { email, password } = body;

    if (!email) {
      return errorResponse(400, 'validation_failed', 'Email is required', undefined, corsHeaders);
    }
    if (!password) {
      return errorResponse(400, 'validation_failed', 'Password is required', undefined, corsHeaders);
    }

    try {
      if (prov.issuesOwnAccessToken) {
        const result = await prov.signIn(email, password);
        return sessionResponse(result.accessToken, result.refreshToken, result.user, corsHeaders);
      }

      const { user, providerTokens } = await prov.signIn(email, password);
      const accessToken = jwt.signAccessToken({ sub: user.id, email: user.email });
      return sessionResponse(accessToken, providerTokens.refreshToken, user, corsHeaders);
    } catch (err) {
      return providerErrorResponse(err, corsHeaders);
    }
  }

  async function handleRefreshGrant(event, prov, corsHeaders) {
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

    if (prov.issuesOwnAccessToken) {
      try {
        const result = await prov.refreshToken(refresh_token);
        return sessionResponse(result.accessToken, result.refreshToken, result.user, corsHeaders);
      } catch {
        return errorResponse(401, 'invalid_grant', 'Invalid refresh token', undefined, corsHeaders);
      }
    }

    try {
      const { user, providerTokens } = await prov.refreshToken(refresh_token);
      const accessToken = jwt.signAccessToken({
        sub: user.id,
        email: user.email,
      });
      return sessionResponse(accessToken, providerTokens.refreshToken, user, corsHeaders);
    } catch {
      return errorResponse(401, 'invalid_grant', 'Invalid refresh token', undefined, corsHeaders);
    }
  }

  async function handleGetUser(event, prov, corsHeaders) {
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
      claims = await verifier.verify(token);
    } catch {
      return errorResponse(
        401,
        'not_authenticated',
        'Invalid or expired token',
        undefined,
        corsHeaders
      );
    }

    if (prov.issuesOwnAccessToken && prov.getUser) {
      try {
        const user = await prov.getUser(token);
        return userResponse(user, corsHeaders);
      } catch {
        return errorResponse(401, 'not_authenticated', 'Invalid or expired token', undefined, corsHeaders);
      }
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

  async function handleLogout(event, prov, corsHeaders) {
    const authHeader =
      event.headers?.Authorization || event.headers?.authorization || '';
    const body = event.body ? JSON.parse(event.body) : {};

    if (authHeader.startsWith('Bearer ')) {
      const token = authHeader.slice(7);
      try {
        const claims = await verifier.verify(token);

        if (prov.issuesOwnAccessToken) {
          const refreshToken = body.refresh_token;
          if (refreshToken) {
            await prov.signOut(refreshToken);
          }
        } else {
          await prov.signOut(claims.sub);
        }
      } catch {
        // Best-effort: if the token is invalid we still return 204
      }
    }

    return logoutResponse(corsHeaders);
  }

  async function handleOtp(event, prov, corsHeaders) {
    const body = JSON.parse(event.body || '{}');
    const { email } = body;

    if (!email) {
      return errorResponse(400, 'validation_failed', 'Email is required', undefined, corsHeaders);
    }
    if (!EMAIL_RE.test(email)) {
      return errorResponse(400, 'validation_failed', 'Invalid email format', undefined, corsHeaders);
    }
    if (!process.env.SES_FROM_ADDRESS) {
      return errorResponse(400, 'validation_failed', 'SES sender address is not configured', undefined, corsHeaders);
    }

    try {
      await prov.sendOtp(email);
      return { statusCode: 200, headers: corsHeaders, body: '{}' };
    } catch (err) {
      if (err.code && ERROR_STATUS[err.code]) {
        return providerErrorResponse(err, corsHeaders);
      }
      return errorResponse(500, 'unexpected_failure', 'An unexpected error occurred', undefined, corsHeaders);
    }
  }

  async function handleVerify(event, prov, corsHeaders) {
    const body = JSON.parse(event.body || '{}');
    const { email, token } = body;

    if (!email) {
      return errorResponse(400, 'validation_failed', 'Email is required', undefined, corsHeaders);
    }
    if (!EMAIL_RE.test(email)) {
      return errorResponse(400, 'validation_failed', 'Invalid email format', undefined, corsHeaders);
    }
    if (!token) {
      return errorResponse(400, 'validation_failed', 'Token is required', undefined, corsHeaders);
    }

    try {
      const result = await prov.verifyOtp(email, token);
      return sessionResponse(result.accessToken, result.refreshToken, result.user, corsHeaders);
    } catch (err) {
      if (err.code === 'invalid_grant') {
        return errorResponse(400, 'invalid_grant', 'Invalid or expired OTP token', undefined, corsHeaders);
      }
      return providerErrorResponse(err, corsHeaders);
    }
  }

  async function handleAuthorize(event, prov, corsHeaders) {
    const query = event.queryStringParameters || {};
    const { provider, redirect_to } = query;

    if (!provider) {
      return errorResponse(400, 'validation_failed', 'Provider is required', undefined, corsHeaders);
    }
    if (!SUPPORTED_OAUTH_PROVIDERS.includes(provider)) {
      return errorResponse(400, 'validation_failed', `Unsupported OAuth provider: ${provider}`, undefined, corsHeaders);
    }
    if (!redirect_to) {
      return errorResponse(400, 'validation_failed', 'redirect_to is required', undefined, corsHeaders);
    }

    try {
      const result = await prov.getOAuthRedirectUrl(provider, redirect_to);
      return {
        statusCode: 302,
        headers: { ...corsHeaders, Location: result.url },
        body: '',
      };
    } catch (err) {
      return providerErrorResponse(err, corsHeaders);
    }
  }

  async function handleCallback(event, prov, corsHeaders) {
    try {
      const result = await prov.handleOAuthCallback(event);
      const fragment = [
        `access_token=${encodeURIComponent(result.accessToken)}`,
        'token_type=bearer',
        `expires_in=${result.expiresIn}`,
        `refresh_token=${encodeURIComponent(result.refreshToken)}`,
      ].join('&');
      return {
        statusCode: 302,
        headers: { ...corsHeaders, Location: `${result.redirectTo || '/'}#${fragment}` },
        body: '',
      };
    } catch (err) {
      const fragment = [
        `error=server_error`,
        `error_description=${encodeURIComponent(err.message || 'OAuth callback failed')}`,
      ].join('&');
      const raw = event.queryStringParameters?.redirect_to || '/';
      const redirectTo = isSafeRedirect(raw, process.env.BETTER_AUTH_URL) ? raw : '/';
      return {
        statusCode: 302,
        headers: { ...corsHeaders, Location: `${redirectTo}#${fragment}` },
        body: '',
      };
    }
  }

  async function handleJwks(prov, corsHeaders) {
    try {
      const jwks = await prov.getJwks();
      return {
        statusCode: 200,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=3600',
        },
        body: JSON.stringify(jwks),
      };
    } catch {
      return errorResponse(500, 'unexpected_failure', 'An unexpected error occurred', undefined, corsHeaders);
    }
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
        '/otp': {
          servers: server,
          post: {
            tags: [tag],
            summary: 'Request magic link',
            description: 'Send a one-time password to the given email address.',
            requestBody: {
              required: true,
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/OtpRequest' },
                },
              },
            },
            responses: {
              200: { description: 'OTP sent' },
              400: { description: 'Validation error', content: { 'application/json': { schema: { $ref: errorRef } } } },
            },
            security: [],
          },
        },
        '/verify': {
          servers: server,
          post: {
            tags: [tag],
            summary: 'Verify OTP',
            description: 'Verify a one-time password and return a session.',
            requestBody: {
              required: true,
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/VerifyRequest' },
                },
              },
            },
            responses: {
              200: { description: 'Verified', content: { 'application/json': { schema: { $ref: sessionRef } } } },
              400: { description: 'Invalid or expired OTP', content: { 'application/json': { schema: { $ref: errorRef } } } },
            },
            security: [],
          },
        },
        '/authorize': {
          servers: server,
          get: {
            tags: [tag],
            summary: 'OAuth initiation',
            description: 'Redirect to the OAuth provider consent screen.',
            parameters: [
              { name: 'provider', in: 'query', required: true, schema: { type: 'string' } },
              { name: 'redirect_to', in: 'query', required: true, schema: { type: 'string', format: 'uri' } },
            ],
            responses: {
              302: { description: 'Redirect to OAuth provider' },
              400: { description: 'Validation error', content: { 'application/json': { schema: { $ref: errorRef } } } },
            },
            security: [],
          },
        },
        '/callback': {
          servers: server,
          get: {
            tags: [tag],
            summary: 'OAuth callback',
            description: 'Handle the OAuth provider callback and redirect with tokens.',
            parameters: [
              { name: 'code', in: 'query', required: true, schema: { type: 'string' } },
              { name: 'state', in: 'query', required: true, schema: { type: 'string' } },
            ],
            responses: {
              302: { description: 'Redirect with tokens in URL fragment' },
            },
            security: [],
          },
        },
        '/jwks': {
          servers: server,
          get: {
            tags: [tag],
            summary: 'Public JWKS',
            description: 'Return the JSON Web Key Set for verifying asymmetric JWTs.',
            responses: {
              200: { description: 'JWKS', content: { 'application/json': { schema: { type: 'object', properties: { keys: { type: 'array' } } } } } },
            },
            security: [],
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
        OtpRequest: {
          type: 'object',
          required: ['email'],
          properties: {
            email: { type: 'string', format: 'email' },
          },
        },
        VerifyRequest: {
          type: 'object',
          required: ['email', 'token'],
          properties: {
            email: { type: 'string', format: 'email' },
            token: { type: 'string' },
          },
        },
      },
    };
  }

  return { handler, getOpenApiPaths, _setProvider, getProvider };
}
