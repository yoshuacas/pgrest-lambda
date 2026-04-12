import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

import provider, { _setClient } from '../providers/cognito.mjs';
import { createProvider } from '../providers/interface.mjs';

// Helper to create a fake Cognito SDK error
function cognitoError(name, message) {
  const err = new Error(message || name);
  err.name = name;
  return err;
}

// Fake IdToken payload for mock responses
function fakeIdToken(sub, email) {
  const header = Buffer.from(JSON.stringify({
    alg: 'RS256', typ: 'JWT',
  })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    sub, email,
  })).toString('base64url');
  return `${header}.${payload}.fake-sig`;
}

function createMockClient() {
  return {
    send: mock.fn(async (command) => {
      const name = command.constructor.name;

      if (name === 'SignUpCommand') {
        const { Username, Password } = command.input;
        if (!Username || Username === '') {
          throw cognitoError('InvalidParameterException');
        }
        if (Username === 'existing@example.com') {
          throw cognitoError('UsernameExistsException');
        }
        if (Password === 'weak') {
          throw cognitoError('InvalidPasswordException');
        }
        return { UserSub: 'fake-uuid-' + Username.split('@')[0] };
      }

      if (name === 'InitiateAuthCommand') {
        const { AuthFlow, AuthParameters } = command.input;

        if (AuthFlow === 'USER_PASSWORD_AUTH') {
          const { USERNAME, PASSWORD } = AuthParameters;
          if (USERNAME === 'noone@example.com') {
            throw cognitoError('UserNotFoundException');
          }
          if (USERNAME === 'mismatch@example.com') {
            throw cognitoError('CodeMismatchException');
          }
          if (PASSWORD === 'WrongPassword1') {
            throw cognitoError('NotAuthorizedException');
          }
          return {
            AuthenticationResult: {
              AccessToken: 'mock-access-token',
              RefreshToken: 'mock-refresh-token',
              IdToken: fakeIdToken('uuid-' + USERNAME.split('@')[0], USERNAME),
            },
          };
        }

        if (AuthFlow === 'REFRESH_TOKEN_AUTH') {
          const { REFRESH_TOKEN } = AuthParameters;
          if (REFRESH_TOKEN === 'expired-token') {
            throw cognitoError('NotAuthorizedException');
          }
          return {
            AuthenticationResult: {
              AccessToken: 'mock-new-access-token',
              IdToken: fakeIdToken('uuid-refreshed', 'refreshed@example.com'),
            },
          };
        }
      }

      if (name === 'GetUserCommand') {
        return {
          Username: 'test-user',
          UserAttributes: [
            { Name: 'sub', Value: 'uuid-test-user' },
            { Name: 'email', Value: 'test@example.com' },
          ],
        };
      }

      throw new Error(`Unexpected command: ${name}`);
    }),
  };
}

describe('CognitoProvider', () => {
  beforeEach(() => {
    process.env.REGION_NAME = 'us-east-1';
    process.env.USER_POOL_CLIENT_ID = 'test-client-id';
    _setClient(createMockClient());
  });

  afterEach(() => {
    _setClient(null);
  });

  describe('signUp', () => {
    it('sends SignUpCommand with correct ClientId, Username, Password', async () => {
      const result = await provider.signUp(
        'test@example.com',
        'Password123'
      );

      assert.ok(result, 'should return a result');
      assert.ok(result.id, 'should return user with id from UserSub');
    });

    it('returns user with id from UserSub on success', async () => {
      const result = await provider.signUp(
        'new@example.com',
        'StrongPass1'
      );

      assert.equal(typeof result.id, 'string', 'id should be a string');
      assert.ok(result.id.length > 0, 'id should not be empty');
    });

    it('throws error with code user_already_exists for UsernameExistsException', async () => {
      await assert.rejects(
        () => provider.signUp('existing@example.com', 'Password123'),
        (err) => {
          assert.equal(
            err.code,
            'user_already_exists',
            'error code should be user_already_exists'
          );
          return true;
        }
      );
    });

    it('throws error with code weak_password for InvalidPasswordException', async () => {
      await assert.rejects(
        () => provider.signUp('test@example.com', 'weak'),
        (err) => {
          assert.equal(
            err.code,
            'weak_password',
            'error code should be weak_password'
          );
          return true;
        }
      );
    });

    it('throws error with code validation_failed for InvalidParameterException', async () => {
      await assert.rejects(
        () => provider.signUp('', 'Password123'),
        (err) => {
          assert.equal(
            err.code,
            'validation_failed',
            'error code should be validation_failed'
          );
          return true;
        }
      );
    });
  });

  describe('signIn', () => {
    it('sends InitiateAuthCommand with USER_PASSWORD_AUTH flow', async () => {
      const result = await provider.signIn(
        'test@example.com',
        'Password123'
      );

      assert.ok(result, 'should return a result');
      assert.ok(result.user, 'should return user');
      assert.ok(
        result.providerTokens,
        'should return providerTokens'
      );
    });

    it('returns user and providerTokens with accessToken, refreshToken, idToken', async () => {
      const result = await provider.signIn(
        'test@example.com',
        'Password123'
      );

      assert.ok(
        result.providerTokens.accessToken,
        'should have accessToken'
      );
      assert.ok(
        result.providerTokens.refreshToken,
        'should have refreshToken'
      );
      assert.ok(
        result.providerTokens.idToken,
        'should have idToken'
      );
    });

    it('throws error with code invalid_grant for NotAuthorizedException', async () => {
      await assert.rejects(
        () => provider.signIn('test@example.com', 'WrongPassword1'),
        (err) => {
          assert.equal(
            err.code,
            'invalid_grant',
            'error code should be invalid_grant'
          );
          return true;
        }
      );
    });

    it('throws error with code invalid_grant for UserNotFoundException', async () => {
      await assert.rejects(
        () => provider.signIn('noone@example.com', 'Password123'),
        (err) => {
          assert.equal(
            err.code,
            'invalid_grant',
            'error code should be invalid_grant'
          );
          return true;
        }
      );
    });

    it('throws error with code invalid_grant for CodeMismatchException', async () => {
      await assert.rejects(
        () => provider.signIn('mismatch@example.com', 'Password123'),
        (err) => {
          assert.equal(
            err.code,
            'invalid_grant',
            'error code should be invalid_grant'
          );
          return true;
        }
      );
    });
  });

  describe('refreshToken', () => {
    it('sends InitiateAuthCommand with REFRESH_TOKEN_AUTH flow', async () => {
      const result = await provider.refreshToken(
        'valid-cognito-refresh-token'
      );

      assert.ok(result, 'should return a result');
      assert.ok(result.user, 'should return user');
      assert.ok(
        result.providerTokens,
        'should return new providerTokens'
      );
    });

    it('returns user and new providerTokens on success', async () => {
      const result = await provider.refreshToken(
        'valid-cognito-refresh-token'
      );

      assert.ok(
        result.providerTokens.accessToken,
        'should have new accessToken'
      );
      assert.ok(result.user.id, 'should have user id');
    });

    it('throws error with code invalid_grant for expired refresh token', async () => {
      await assert.rejects(
        () => provider.refreshToken('expired-token'),
        (err) => {
          assert.equal(
            err.code,
            'invalid_grant',
            'error code should be invalid_grant'
          );
          return true;
        }
      );
    });
  });

  describe('getUser', () => {
    it('sends GetUserCommand and returns user attributes', async () => {
      const user = await provider.getUser(
        'valid-cognito-access-token'
      );

      assert.ok(user, 'should return a user');
      assert.ok(user.id, 'user should have id');
      assert.ok(user.email, 'user should have email');
    });
  });

  describe('signOut', () => {
    it('returns void without calling Cognito SDK', async () => {
      const result = await provider.signOut(
        'valid-cognito-access-token'
      );

      assert.equal(
        result,
        undefined,
        'signOut should return undefined'
      );
    });
  });

  describe('createProvider', () => {
    it('throws error for unknown provider name in AUTH_PROVIDER', () => {
      process.env.AUTH_PROVIDER = 'unknown-provider';

      assert.throws(
        () => createProvider(),
        (err) => {
          assert.ok(
            err.message.includes('unknown-provider'),
            'error message should contain the provider name'
          );
          return true;
        }
      );

      delete process.env.AUTH_PROVIDER;
    });
  });
});
