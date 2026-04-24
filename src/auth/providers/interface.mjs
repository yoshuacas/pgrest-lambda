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
 */

/**
 * Returns an AuthProvider based on config.
 * @param {Object} config - Auth configuration with a `provider` key.
 * @param {Object} [db] - Database adapter. Required for GoTrue, ignored by Cognito.
 */
export async function createProvider(config, db) {
  const name = config.provider || 'cognito';
  switch (name) {
    case 'cognito': {
      const { createCognitoProvider } = await import('./cognito.mjs');
      return createCognitoProvider(config);
    }
    case 'gotrue': {
      const { createGoTrueProvider } = await import('./gotrue.mjs');
      return createGoTrueProvider(config, db);
    }
    default:
      throw new Error(`Unknown auth provider: ${name}`);
  }
}
