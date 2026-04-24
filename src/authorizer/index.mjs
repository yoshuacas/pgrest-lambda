import jwt from 'jsonwebtoken';
import { assertJwtSecret, JWT_ALGORITHM } from '../auth/jwt.mjs';

const ISSUER = 'pgrest-lambda';

export function createAuthorizer(config) {
  assertJwtSecret(config.jwtSecret);

  async function handler(event) {
    try {
      const secret = config.jwtSecret;
      const apikey = event.headers?.apikey
        || event.headers?.Apikey || '';
      const authHeader = event.headers?.Authorization
        || event.headers?.authorization || '';

      // 1. Validate apikey
      if (!apikey) throw 'Unauthorized';
      const apikeyPayload = jwt.verify(apikey, secret,
        { algorithms: [JWT_ALGORITHM], issuer: ISSUER });
      if (!['anon', 'service_role'].includes(apikeyPayload.role))
        throw 'Unauthorized';

      // 2. Determine effective identity
      let role = apikeyPayload.role;
      let userId = '';
      let email = '';

      if (authHeader.startsWith('Bearer ')) {
        const token = authHeader.slice(7);
        const payload = jwt.verify(token, secret,
          { algorithms: [JWT_ALGORITHM], issuer: ISSUER });
        role = payload.role;
        userId = payload.sub || '';
        email = payload.email || '';
      }

      // 3. Return Allow policy with context
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
