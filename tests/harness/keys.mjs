import jwt from 'jsonwebtoken';

const ISSUER = 'pgrest-lambda';
const ALG = 'HS256';

// Mints the HS256 "apikey" JWT that the Lambda authorizer expects
// in the `apikey` request header. This is how supabase-js identifies
// itself as anon or service_role before any user signs in.
export function mintApikey(secret, role) {
  if (!['anon', 'service_role'].includes(role)) {
    throw new Error(`Unknown apikey role: ${role}`);
  }
  return jwt.sign({ role }, secret, { algorithm: ALG, issuer: ISSUER });
}

export function mintAnonAndService(secret) {
  return {
    anon: mintApikey(secret, 'anon'),
    service: mintApikey(secret, 'service_role'),
  };
}
