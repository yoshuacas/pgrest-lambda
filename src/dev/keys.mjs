// Mint the HS256 apikey JWTs the Lambda authorizer expects in the
// `apikey` request header. Anon/service_role tokens are long-lived
// identifiers of the *deployment*, not user sessions — they don't
// expire. User access tokens are separate (EdDSA, issued by
// better-auth).
//
// Mirrors the implementation used by the test harness so there's a
// single blessed way to produce these keys.

import jwt from 'jsonwebtoken';

const ISSUER = 'pgrest-lambda';
const ALG = 'HS256';
const VALID_ROLES = new Set(['anon', 'service_role']);

/**
 * Mint an apikey JWT.
 *
 * @param {object} opts
 * @param {string} opts.secret  JWT_SECRET (>= 32 chars)
 * @param {'anon'|'service_role'} opts.role
 * @returns {string}  signed JWT
 */
export function generateApikey({ secret, role }) {
  if (!secret || typeof secret !== 'string' || secret.length < 32) {
    throw new Error(
      'generateApikey: `secret` must be a string of 32+ characters',
    );
  }
  if (!VALID_ROLES.has(role)) {
    throw new Error(
      `generateApikey: \`role\` must be one of ${[...VALID_ROLES].join(', ')}`,
    );
  }
  return jwt.sign({ role }, secret, { algorithm: ALG, issuer: ISSUER });
}
