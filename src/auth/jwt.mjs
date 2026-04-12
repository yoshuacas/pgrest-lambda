import jwt from 'jsonwebtoken';

const ISSUER = 'pgrest-lambda';

export function createJwt(config) {
  const secret = config.jwtSecret;

  function signAccessToken({ sub, email }) {
    return jwt.sign(
      { sub, email, role: 'authenticated', aud: 'authenticated' },
      secret,
      { issuer: ISSUER, expiresIn: '1h' }
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
