import jwt from 'jsonwebtoken';

const ISSUER = 'pgrest-lambda';

export function signAccessToken({ sub, email }) {
  return jwt.sign(
    { sub, email, role: 'authenticated', aud: 'authenticated' },
    process.env.JWT_SECRET,
    { issuer: ISSUER, expiresIn: '1h' }
  );
}

export function signRefreshToken(sub, providerRefreshToken) {
  return jwt.sign(
    { sub, role: 'authenticated', prt: providerRefreshToken },
    process.env.JWT_SECRET,
    { issuer: ISSUER, expiresIn: '30d' }
  );
}

export function verifyToken(token) {
  return jwt.verify(token, process.env.JWT_SECRET, { issuer: ISSUER });
}
