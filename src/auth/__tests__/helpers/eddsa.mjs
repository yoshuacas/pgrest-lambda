import { generateKeyPairSync } from 'node:crypto';
import { SignJWT, exportJWK } from 'jose';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');

export { privateKey, publicKey };

export async function makeEdDSAToken(claims = {}, key = privateKey) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    sub: 'user-id-001',
    email: 'test@example.com',
    role: 'authenticated',
    aud: 'authenticated',
    ...claims,
  })
    .setProtectedHeader({ alg: 'EdDSA', kid: 'test-kid-1' })
    .setIssuer('pgrest-lambda')
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(key);
}

export async function makeExpiredEdDSAToken(key = privateKey) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    sub: 'user-id-001',
    email: 'test@example.com',
    role: 'authenticated',
    aud: 'authenticated',
  })
    .setProtectedHeader({ alg: 'EdDSA', kid: 'test-kid-1' })
    .setIssuer('pgrest-lambda')
    .setIssuedAt(now - 7200)
    .setExpirationTime(now - 3600)
    .sign(key);
}

let pubJwkCache = null;
export async function getPubJwk() {
  if (!pubJwkCache) {
    const jwk = await exportJWK(publicKey);
    jwk.kid = 'test-kid-1';
    jwk.alg = 'EdDSA';
    jwk.use = 'sig';
    pubJwkCache = jwk;
  }
  return pubJwkCache;
}
