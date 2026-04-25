import jwt from 'jsonwebtoken';
import { assertJwtSecret, JWT_ALGORITHM } from '../../src/auth/jwt.mjs';
import { createTokenVerifier } from '../../src/auth/verify-token.mjs';

const ISSUER = 'pgrest-lambda';

export function createAuthorizer(config) {
  assertJwtSecret(config.jwtSecret);

  const verifier = createTokenVerifier({
    jwtSecret: config.jwtSecret,
    jwksUrl: config.jwksUrl || null,
  });

  async function handler(event) {
    try {
      const secret = config.jwtSecret;
      const apikey = event.headers?.apikey
        || event.headers?.Apikey || '';
      const authHeader = event.headers?.Authorization
        || event.headers?.authorization || '';

      if (!apikey) throw 'Unauthorized';
      const apikeyPayload = jwt.verify(apikey, secret,
        { algorithms: [JWT_ALGORITHM], issuer: ISSUER });
      if (!['anon', 'service_role'].includes(apikeyPayload.role))
        throw 'Unauthorized';

      let role = apikeyPayload.role;
      let userId = '';
      let email = '';

      if (authHeader.startsWith('Bearer ')) {
        const token = authHeader.slice(7);
        const payload = await verifier.verify(token);
        role = payload.role;
        userId = payload.sub || '';
        email = payload.email || '';
      }

      return allow(event.methodArn, { role, userId, email });
    } catch (err) {
      throw 'Unauthorized';
    }
  }

  return { handler };
}

function allow(methodArn, context) {
  const arnBase = methodArn.split('/').slice(0, 2).join('/');
  return {
    principalId: context.userId || 'anon',
    policyDocument: {
      Version: '2012-10-17',
      Statement: [{
        Action: 'execute-api:Invoke',
        Effect: 'Allow',
        Resource: arnBase + '/*',
      }],
    },
    context,
  };
}
