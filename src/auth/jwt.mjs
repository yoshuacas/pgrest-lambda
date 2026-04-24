import jwt from 'jsonwebtoken';
import { SESSION_EXPIRY_SECONDS } from './constants.mjs';

const ISSUER = 'pgrest-lambda';

export function assertJwtSecret(secret) {
  if (secret === undefined || secret === null) {
    throw new Error(
      'pgrest-lambda: JWT secret is required. Set the '
      + 'JWT_SECRET environment variable or pass jwtSecret '
      + 'in the config. Generate one with: '
      + 'openssl rand -base64 48'
    );
  }
  if (typeof secret !== 'string') {
    throw new Error(
      'pgrest-lambda: JWT secret must be a string. '
      + `Got ${typeof secret}.`
    );
  }
  if (secret.length < 32) {
    throw new Error(
      'pgrest-lambda: JWT secret is too short '
      + `(got ${secret.length} characters, minimum is 32). `
      + 'Generate a strong secret with: '
      + 'openssl rand -base64 48'
    );
  }
}

export function createJwt(config) {
  const secret = config.jwtSecret;
  assertJwtSecret(secret);

  function signAccessToken({ sub, email }) {
    return jwt.sign(
      { sub, email, role: 'authenticated', aud: 'authenticated' },
      secret,
      { issuer: ISSUER, expiresIn: SESSION_EXPIRY_SECONDS }
    );
  }

  function signRefreshToken(sub, providerRefreshToken) {
    return jwt.sign(
      { sub, role: 'authenticated', prt: providerRefreshToken },
      secret,
      { issuer: ISSUER, expiresIn: '30d' }
    );
  }

  function verifyToken(token) {
    return jwt.verify(token, secret, { issuer: ISSUER });
  }

  return { signAccessToken, signRefreshToken, verifyToken };
}
