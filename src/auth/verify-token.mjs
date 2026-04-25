import jwt from 'jsonwebtoken';
import {
  createRemoteJWKSet, createLocalJWKSet,
  jwtVerify, decodeProtectedHeader,
} from 'jose';

const ISSUER = 'pgrest-lambda';

export function createTokenVerifier({
  jwtSecret,
  jwksUrl,
  localJwksProvider,
}) {
  let remoteJwks = null;
  let cachedLocalJwks = null;
  let cachedLocalJwksAt = 0;
  const LOCAL_JWKS_TTL_MS = 5 * 60 * 1000;

  function getRemoteJwks() {
    if (!remoteJwks && jwksUrl) {
      remoteJwks = createRemoteJWKSet(new URL(jwksUrl));
    }
    return remoteJwks;
  }

  async function getLocalJwks() {
    if (!localJwksProvider) return null;
    const now = Date.now();
    if (cachedLocalJwks
        && now - cachedLocalJwksAt < LOCAL_JWKS_TTL_MS) {
      return cachedLocalJwks;
    }
    const jwksData = await localJwksProvider();
    if (!jwksData) return null;
    cachedLocalJwks = createLocalJWKSet(jwksData);
    cachedLocalJwksAt = now;
    return cachedLocalJwks;
  }

  async function verify(token) {
    const header = decodeProtectedHeader(token);

    if (header.alg === 'HS256') {
      return jwt.verify(token, jwtSecret, {
        algorithms: ['HS256'],
        issuer: ISSUER,
      });
    }

    const localJwks = await getLocalJwks();
    if (localJwks) {
      try {
        const { payload } = await jwtVerify(
          token, localJwks, { issuer: ISSUER });
        return payload;
      } catch (err) {
        if (err?.code === 'ERR_JWKS_NO_MATCHING_KEY') {
          cachedLocalJwks = null;
          cachedLocalJwksAt = 0;
          const refreshedJwksData = await localJwksProvider();
          if (refreshedJwksData) {
            cachedLocalJwks = createLocalJWKSet(refreshedJwksData);
            cachedLocalJwksAt = Date.now();
            try {
              const { payload } = await jwtVerify(
                token, cachedLocalJwks, { issuer: ISSUER });
              return payload;
            } catch {
              // Fall through to remote JWKS
            }
          }
        } else {
          throw err;
        }
      }
    }

    const remote = getRemoteJwks();
    if (!remote) throw new Error('Unauthorized');
    const { payload } = await jwtVerify(
      token, remote, { issuer: ISSUER });
    return payload;
  }

  function resetCache() {
    cachedLocalJwks = null;
    cachedLocalJwksAt = 0;
    remoteJwks = null;
  }

  return { verify, resetCache };
}
