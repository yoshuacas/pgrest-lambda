import { betterAuth } from 'better-auth';
import { jwt as jwtPlugin, magicLink, bearer } from 'better-auth/plugins';
import pg from 'pg';

const BA_ERROR_MAP = {
  USER_ALREADY_EXISTS: 'user_already_exists',
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: 'user_already_exists',
  PASSWORD_TOO_SHORT: 'weak_password',
  PASSWORD_TOO_LONG: 'weak_password',
  INVALID_EMAIL_OR_PASSWORD: 'invalid_grant',
  INVALID_PASSWORD: 'invalid_grant',
  CREDENTIAL_ACCOUNT_NOT_FOUND: 'invalid_grant',
  SESSION_EXPIRED: 'invalid_grant',
  FAILED_TO_GET_SESSION: 'invalid_grant',
  INVALID_TOKEN: 'invalid_grant',
  TOKEN_EXPIRED: 'invalid_grant',
  VALIDATION_ERROR: 'validation_failed',
  INVALID_EMAIL: 'validation_failed',
};

const OUR_CODES = new Set([
  'user_already_exists', 'invalid_grant', 'weak_password',
  'unexpected_failure', 'validation_failed', 'user_not_found',
]);

function mapError(err) {
  const baCode = err?.body?.code || '';
  const code = BA_ERROR_MAP[baCode] || 'unexpected_failure';
  const mapped = new Error(
    err?.body?.message || err?.message || 'Unknown error',
  );
  mapped.code = code;
  throw mapped;
}

function mapBetterAuthUser(baUser) {
  return {
    id: baUser.id,
    email: baUser.email,
    app_metadata: { provider: 'email', providers: ['email'] },
    user_metadata: {},
    created_at: baUser.createdAt || new Date().toISOString(),
  };
}

function extractSessionToken(headers) {
  const cookies = headers?.get?.('set-cookie') || '';
  const match = cookies.match(/better-auth\.session_token=([^;]+)/);
  return match ? match[1] : null;
}

function buildPool(config) {
  const databaseUrl = config.databaseUrl || process.env.DATABASE_URL;
  if (databaseUrl) {
    const url = new URL(databaseUrl);
    url.searchParams.set('options', '-c search_path=better_auth');
    return new pg.Pool({
      connectionString: url.toString(),
      max: 5,
      idleTimeoutMillis: 60000,
    });
  }

  const dsqlEndpoint = config.dsqlEndpoint || process.env.DSQL_ENDPOINT;
  if (dsqlEndpoint) {
    const region = config.regionName || process.env.REGION_NAME;
    return new pg.Pool({
      host: dsqlEndpoint,
      port: 5432,
      user: 'admin',
      password: async () => {
        const { DsqlSigner } = await import('@aws-sdk/dsql-signer');
        const signer = new DsqlSigner({
          hostname: dsqlEndpoint,
          region,
        });
        return signer.getDbConnectAdminAuthToken();
      },
      database: 'postgres',
      ssl: { rejectUnauthorized: true },
      max: 5,
      idleTimeoutMillis: 60000,
      options: '-c search_path=better_auth',
    });
  }

  return new pg.Pool({
    host: config.pgHost || process.env.PG_HOST || 'localhost',
    port: config.pgPort || parseInt(process.env.PG_PORT || '5432', 10),
    user: config.pgUser || process.env.PG_USER || 'postgres',
    password: config.pgPassword || process.env.PG_PASSWORD || '',
    database: config.pgDatabase || process.env.PG_DATABASE || 'postgres',
    max: 5,
    idleTimeoutMillis: 60000,
    options: '-c search_path=better_auth',
  });
}

export function createBetterAuthProvider(config) {
  const pool = buildPool(config);

  const regionName = config.regionName || process.env.REGION_NAME;
  // SES sender: config takes precedence over env var.
  // The handler also checks process.env.SES_FROM_ADDRESS
  // before calling sendOtp — for SAM deployments the env
  // var is always set, so the handler check passes first.
  // For programmatic usage, set config.sesFromAddress.
  const sesFrom = config.sesFromAddress || process.env.SES_FROM_ADDRESS;
  let ses = null;
  let SendEmailCommandCached = null;
  async function getSesClient() {
    if (!ses) {
      const mod = await import('@aws-sdk/client-sesv2');
      SendEmailCommandCached = mod.SendEmailCommand;
      ses = new mod.SESv2Client({ region: regionName });
    }
    return ses;
  }

  const baseURL = config.betterAuthUrl || process.env.BETTER_AUTH_URL;
  const basePath = '/auth/v1/ba';
  const googleConfigured =
    !!(config.googleClientId && config.googleClientSecret);

  const auth = betterAuth({
    baseURL,
    basePath,
    secret: config.betterAuthSecret || process.env.BETTER_AUTH_SECRET,
    database: pool,
    emailAndPassword: { enabled: true, autoSignIn: true },
    ...(googleConfigured && {
      socialProviders: {
        google: {
          clientId:
            config.googleClientId || process.env.GOOGLE_CLIENT_ID,
          clientSecret:
            config.googleClientSecret ||
            process.env.GOOGLE_CLIENT_SECRET,
        },
      },
    }),
    session: { expiresIn: 60 * 60 * 24 * 30 },
    plugins: [
      // bearer() accepts `Authorization: Bearer <session-token>` on
      // server-side API calls. Required by getSessionWithJwt and
      // signOut, which pass raw session tokens (no cookie HMAC).
      bearer(),
      jwtPlugin({
        jwks: { keyPairConfig: { alg: 'EdDSA', crv: 'Ed25519' } },
        jwt: {
          issuer: 'pgrest-lambda',
          audience: 'authenticated',
          expirationTime: '1h',
          definePayload: ({ user }) => ({
            sub: user.id,
            email: user.email,
            role: 'authenticated',
            aud: 'authenticated',
          }),
        },
      }),
      magicLink({
        sendMagicLink: async ({ email, url }) => {
          const client = await getSesClient();
          await client.send(
            new SendEmailCommandCached({
              FromEmailAddress: sesFrom,
              Destination: { ToAddresses: [email] },
              Content: {
                Simple: {
                  Subject: { Data: 'Your sign-in link' },
                  Body: {
                    Html: {
                      Data: `<p>Click <a href="${url}">here</a> to sign in.</p>`,
                    },
                  },
                },
              },
            }),
          );
        },
      }),
    ],
  });

  async function getSessionWithJwt(sessionToken) {
    // Use Bearer auth rather than a cookie header: cookie values are
    // signed (HMAC-suffixed) by better-auth when set, and passing only
    // the raw token in the cookie causes signature verification to fail
    // silently. The bearer plugin accepts the raw token directly.
    const headers = new Headers();
    headers.set('authorization', `Bearer ${sessionToken}`);
    const result = await auth.api.getSession({
      headers,
      returnHeaders: true,
    });
    if (!result?.response) {
      const err = new Error('Session not found');
      err.code = 'invalid_grant';
      throw err;
    }
    const accessToken = result.headers.get('set-auth-jwt');
    const refreshedToken =
      extractSessionToken(result.headers) || sessionToken;
    return {
      user: result.response.user,
      accessToken,
      refreshToken: refreshedToken,
    };
  }

  async function signUp(email, password) {
    try {
      const result = await auth.api.signUpEmail({
        body: { name: email.split('@')[0], email, password },
        headers: new Headers(),
      });
      if (!result?.token) {
        const err = new Error('Signup failed');
        err.code = 'unexpected_failure';
        throw err;
      }
      const { accessToken, refreshToken } = await getSessionWithJwt(
        result.token,
      );
      return {
        user: mapBetterAuthUser(result.user),
        accessToken,
        refreshToken,
        expiresIn: 3600,
      };
    } catch (err) {
      if (OUR_CODES.has(err?.code)) throw err;
      mapError(err);
    }
  }

  async function signIn(email, password) {
    try {
      const result = await auth.api.signInEmail({
        body: { email, password },
        headers: new Headers(),
      });
      if (!result?.token) {
        const err = new Error('Invalid credentials');
        err.code = 'invalid_grant';
        throw err;
      }
      const { accessToken, refreshToken } = await getSessionWithJwt(
        result.token,
      );
      return {
        user: mapBetterAuthUser(result.user),
        accessToken,
        refreshToken,
        expiresIn: 3600,
      };
    } catch (err) {
      if (OUR_CODES.has(err?.code)) throw err;
      mapError(err);
    }
  }

  async function refreshToken(sessionToken) {
    try {
      const { user, accessToken, refreshToken: newToken } =
        await getSessionWithJwt(sessionToken);
      return {
        user: mapBetterAuthUser(user),
        accessToken,
        refreshToken: newToken,
        expiresIn: 3600,
      };
    } catch (err) {
      if (OUR_CODES.has(err?.code)) throw err;
      mapError(err);
    }
  }

  async function getUser(accessToken) {
    try {
      const { payload } = await auth.api.verifyJWT({
        body: { token: accessToken },
      });
      return {
        id: payload.sub,
        email: payload.email,
        app_metadata: { provider: 'email', providers: ['email'] },
        user_metadata: {},
        created_at: new Date().toISOString(),
      };
    } catch (err) {
      if (OUR_CODES.has(err?.code)) throw err;
      mapError(err);
    }
  }

  async function signOut(sessionToken) {
    try {
      // See getSessionWithJwt: use Bearer instead of a cookie header
      // because raw session tokens don't carry the signed-cookie HMAC.
      const headers = new Headers();
      headers.set('authorization', `Bearer ${sessionToken}`);
      await auth.api.signOut({ headers });
    } catch (err) {
      if (OUR_CODES.has(err?.code)) throw err;
      mapError(err);
    }
  }

  async function sendOtp(email) {
    if (!sesFrom) {
      const err = new Error('SES sender address is not configured');
      err.code = 'validation_failed';
      throw err;
    }
    try {
      await auth.api.signInMagicLink({
        body: { email },
        headers: new Headers(),
      });
    } catch (err) {
      if (OUR_CODES.has(err?.code)) throw err;
      mapError(err);
    }
  }

  async function verifyOtp(email, token) {
    try {
      const result = await auth.api.magicLinkVerify({
        query: { token },
        headers: new Headers(),
      });
      if (!result?.token) {
        const err = new Error('Verification failed');
        err.code = 'unexpected_failure';
        throw err;
      }
      const { accessToken, refreshToken } = await getSessionWithJwt(
        result.token,
      );
      return {
        user: mapBetterAuthUser(result.user),
        accessToken,
        refreshToken,
        expiresIn: 3600,
      };
    } catch (err) {
      if (OUR_CODES.has(err?.code)) throw err;
      mapError(err);
    }
  }

  async function getOAuthRedirectUrl(provider, redirectTo) {
    try {
      const url = `${baseURL}${basePath}/sign-in/social`;
      const req = new Request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider,
          callbackURL: redirectTo,
        }),
        redirect: 'manual',
      });
      const response = await auth.handler(req);
      const location = response.headers.get('location');
      if (!location) {
        const err = new Error('No redirect URL');
        err.code = 'unexpected_failure';
        throw err;
      }
      const redirectUrl = new URL(location);
      const originalState = redirectUrl.searchParams.get('state');
      const statePayload = JSON.stringify({
        p: provider,
        r: redirectTo,
        s: originalState || '',
      });
      const encodedState = Buffer.from(statePayload)
        .toString('base64url');
      redirectUrl.searchParams.set('state', encodedState);
      return { url: redirectUrl.toString() };
    } catch (err) {
      if (OUR_CODES.has(err?.code)) throw err;
      mapError(err);
    }
  }

  async function handleOAuthCallback(event) {
    try {
      const { code, state } = event.queryStringParameters || {};
      let provider = 'google';
      let redirectTo = '/';
      let originalState = state || '';

      if (state) {
        try {
          const decoded = JSON.parse(
            Buffer.from(state, 'base64url').toString());
          provider = decoded.p || 'google';
          redirectTo = decoded.r || '/';
          originalState = decoded.s || '';
        } catch {
          if (state.includes(':')) {
            const idx = state.indexOf(':');
            provider = state.substring(0, idx);
            originalState = state.substring(idx + 1);
          }
        }
      }

      const callbackUrl = `${baseURL}${basePath}/callback/${provider}?code=${encodeURIComponent(code || '')}&state=${encodeURIComponent(originalState)}`;
      const req = new Request(callbackUrl);
      const response = await auth.handler(req);
      const sessionToken = extractSessionToken(response.headers);
      if (!sessionToken) {
        const err = new Error('OAuth callback failed');
        err.code = 'unexpected_failure';
        throw err;
      }
      const { user, accessToken, refreshToken } =
        await getSessionWithJwt(sessionToken);
      return {
        user: mapBetterAuthUser(user),
        accessToken,
        refreshToken,
        expiresIn: 3600,
        redirectTo,
      };
    } catch (err) {
      if (OUR_CODES.has(err?.code)) throw err;
      mapError(err);
    }
  }

  async function getJwks() {
    try {
      return await auth.api.getJwks({});
    } catch (err) {
      if (OUR_CODES.has(err?.code)) throw err;
      mapError(err);
    }
  }

  async function destroy() {
    await pool.end();
  }

  return {
    issuesOwnAccessToken: true,
    signUp,
    signIn,
    refreshToken,
    getUser,
    signOut,
    sendOtp,
    verifyOtp,
    getOAuthRedirectUrl,
    handleOAuthCallback,
    getJwks,
    destroy,
  };
}
