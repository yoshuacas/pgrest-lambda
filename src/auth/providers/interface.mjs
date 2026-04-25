/**
 * @typedef {Object} AuthUser
 * @property {string} id       - Provider user ID (UUID)
 * @property {string} email    - User email
 * @property {Object} app_metadata
 * @property {Object} user_metadata
 * @property {string} created_at
 */

/**
 * @typedef {Object} AuthProvider
 * @property {(email: string, password: string) => Promise<AuthUser>} signUp
 * @property {(email: string, password: string) => Promise<{user: AuthUser, providerTokens: Object}>} signIn
 * @property {(providerRefreshToken: string) => Promise<{user: AuthUser, providerTokens: Object}>} refreshToken
 * @property {(identifier: string) => Promise<AuthUser>} getUser - Cognito: access token; GoTrue: user ID
 * @property {(providerAccessToken: string) => Promise<void>} signOut
 * @property {boolean} [issuesOwnAccessToken] - If true,
 *   signUp/signIn/refreshToken return { user,
 *   accessToken, refreshToken, expiresIn } and the
 *   handler uses them directly instead of calling
 *   jwt.signAccessToken. Required for providers that
 *   sign asymmetric JWTs.
 * @property {(email: string) => Promise<void>} [sendOtp]
 * @property {(email: string, token: string) => Promise<Object>} [verifyOtp]
 * @property {(provider: string, redirectTo: string) => Promise<{url: string}>} [getOAuthRedirectUrl]
 * @property {(request: Object) => Promise<Object>} [handleOAuthCallback]
 * @property {() => Promise<Object>} [getJwks]
 * @property {() => Promise<void>} [destroy] - Release resources (e.g., close pg.Pool).
 */

/**
 * Returns an AuthProvider based on config.
 * @param {Object} config - Auth configuration with a `provider` key.
 */
export async function createProvider(config) {
  const name = config.provider || 'better-auth';
  switch (name) {
    case 'cognito': {
      const { createCognitoProvider } = await import('./cognito.mjs');
      return createCognitoProvider(config);
    }
    case 'better-auth': {
      const { createBetterAuthProvider } = await import('./better-auth.mjs');
      const provider = createBetterAuthProvider(config);
      return { provider, _setClient: null };
    }
    default:
      throw new Error(`Unknown auth provider: ${name}`);
  }
}
