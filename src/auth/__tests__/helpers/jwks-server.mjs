import http from 'node:http';
import { exportJWK } from 'jose';

export async function startJwksServer(pubJwk) {
  const jwksBody = JSON.stringify({ keys: [pubJwk] });
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(jwksBody);
    });
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        server,
        url: `http://127.0.0.1:${port}/.well-known/jwks.json`,
      });
    });
  });
}

export async function startJwksServerWithKey(pubKey, kid) {
  const pubJwk = await exportJWK(pubKey);
  pubJwk.kid = kid;
  pubJwk.alg = 'EdDSA';
  pubJwk.use = 'sig';
  return startJwksServer(pubJwk);
}
