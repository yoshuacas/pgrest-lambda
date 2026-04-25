export function makeEvent({
  method = 'POST',
  path = '/auth/v1/signup',
  query = {},
  headers = {},
  body = null,
} = {}) {
  return {
    httpMethod: method,
    path,
    queryStringParameters: Object.keys(query).length ? query : null,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : null,
  };
}

export function parseBody(response) {
  return JSON.parse(response.body);
}

export function decodePayload(token) {
  const parts = token.split('.');
  return JSON.parse(Buffer.from(parts[1], 'base64url').toString());
}
