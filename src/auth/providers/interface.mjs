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
 * @property {(providerAccessToken: string) => Promise<AuthUser>} getUser
 * @property {(providerAccessToken: string) => Promise<void>} signOut
 */

/**
 * Returns an AuthProvider based on config.
 */
export async function createProvider(config) {
  const name = config.provider || 'cognito';
  switch (name) {
    case 'cognito': {
      const { createCognitoProvider } = await import('./cognito.mjs');
      return createCognitoProvider(config);
    }
    default:
      throw new Error(`Unknown auth provider: ${name}`);
  }
}
