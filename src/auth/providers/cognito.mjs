import {
  CognitoIdentityProviderClient,
  SignUpCommand,
  InitiateAuthCommand,
  GetUserCommand,
} from '@aws-sdk/client-cognito-identity-provider';

const ERROR_MAP = {
  UsernameExistsException: 'user_already_exists',
  NotAuthorizedException: 'invalid_grant',
  UserNotFoundException: 'invalid_grant',
  InvalidPasswordException: 'weak_password',
  InvalidParameterException: 'validation_failed',
  CodeMismatchException: 'invalid_grant',
};

function mapError(err) {
  const code = ERROR_MAP[err.name] || 'unexpected_failure';
  const mapped = new Error(err.message);
  mapped.code = code;
  throw mapped;
}

function parseIdToken(idToken) {
  try {
    const payload = JSON.parse(
      Buffer.from(idToken.split('.')[1], 'base64url').toString()
    );
    return {
      id: payload.sub,
      email: payload.email || '',
      app_metadata: { provider: 'email', providers: ['email'] },
      user_metadata: {},
      created_at: new Date().toISOString(),
    };
  } catch {
    return {
      id: '',
      email: '',
      app_metadata: { provider: 'email', providers: ['email'] },
      user_metadata: {},
      created_at: new Date().toISOString(),
    };
  }
}

export function createCognitoProvider(config) {
  let client;

  function getClient() {
    if (!client) {
      client = new CognitoIdentityProviderClient({
        region: config.region,
      });
    }
    return client;
  }

  function _setClient(c) {
    client = c;
  }

  const provider = {
    needsSessionTable: false,

    async signUp(email, password) {
      try {
        const result = await getClient().send(new SignUpCommand({
          ClientId: config.clientId,
          Username: email,
          Password: password,
        }));
        return {
          id: result.UserSub,
          email,
          app_metadata: { provider: 'email', providers: ['email'] },
          user_metadata: {},
          created_at: new Date().toISOString(),
        };
      } catch (err) {
        return mapError(err);
      }
    },

    async signIn(email, password) {
      try {
        const result = await getClient().send(new InitiateAuthCommand({
          AuthFlow: 'USER_PASSWORD_AUTH',
          ClientId: config.clientId,
          AuthParameters: {
            USERNAME: email,
            PASSWORD: password,
          },
        }));
        const auth = result.AuthenticationResult;
        const user = parseIdToken(auth.IdToken);
        return {
          user,
          providerTokens: {
            accessToken: auth.AccessToken,
            refreshToken: auth.RefreshToken,
            idToken: auth.IdToken,
          },
        };
      } catch (err) {
        return mapError(err);
      }
    },

    async refreshToken(providerRefreshToken) {
      try {
        const result = await getClient().send(new InitiateAuthCommand({
          AuthFlow: 'REFRESH_TOKEN_AUTH',
          ClientId: config.clientId,
          AuthParameters: {
            REFRESH_TOKEN: providerRefreshToken,
          },
        }));
        const auth = result.AuthenticationResult;
        const user = parseIdToken(auth.IdToken);
        return {
          user,
          providerTokens: {
            accessToken: auth.AccessToken,
            refreshToken: providerRefreshToken,
            idToken: auth.IdToken,
          },
        };
      } catch (err) {
        return mapError(err);
      }
    },

    async getUser(providerAccessToken) {
      try {
        const result = await getClient().send(new GetUserCommand({
          AccessToken: providerAccessToken,
        }));
        const attrs = {};
        for (const attr of result.UserAttributes || []) {
          attrs[attr.Name] = attr.Value;
        }
        return {
          id: attrs.sub || result.Username,
          email: attrs.email || '',
          app_metadata: { provider: 'email', providers: ['email'] },
          user_metadata: {},
          created_at: new Date().toISOString(),
        };
      } catch (err) {
        return mapError(err);
      }
    },

    async signOut() {
      // No-op: JWTs expire naturally
    },
  };

  return { provider, _setClient };
}
