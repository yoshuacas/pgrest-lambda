# V-02 — JWT Algorithm Pinning

Pin the JWT verification algorithm to `HS256` at all sign and verify
sites to close security finding V-02 (Critical).

Reference: `docs/security/findings/V-02-jwt-algorithm-pinning.md`
Source: `docs/design/prompts/security-v02-jwt-algorithm-pin.md`

## Problem

`jwt.verify()` was called without `algorithms: ['HS256']` at three
verify sites. RFC 8725 §3.1 requires explicit algorithm pinning as
defense-in-depth against algorithm-confusion attacks.
`jsonwebtoken@9+` blocks `alg: none` by default but the explicit pin
is still required; a transitive downgrade would reintroduce the risk.

## Approach

Introduce a single exported constant `JWT_ALGORITHM = 'HS256'` in
`src/auth/jwt.mjs`. Use it in every sign and verify call in that
module, and import it from `src/authorizer/index.mjs` for the two
authorizer verify sites. Producer and verifier are now explicitly
aligned, and a future algorithm migration is one search.

## Changes

### `src/auth/jwt.mjs`

- Add and export `JWT_ALGORITHM = 'HS256'`.
- Pass `algorithm: JWT_ALGORITHM` to `jwt.sign` in
  `signAccessToken` and `signRefreshToken`.
- Pass `algorithms: [JWT_ALGORITHM]` to `jwt.verify` in
  `verifyToken`.

### `src/authorizer/index.mjs`

- Import `JWT_ALGORITHM`.
- Pass `algorithms: [JWT_ALGORITHM]` to `jwt.verify` at both
  verify sites (apikey and Bearer).

## Tests

Unit tests match existing `node:test` + `assert/strict` style.

### `src/auth/__tests__/jwt.test.mjs`

- HS256 round-trip succeeds (regression).
- Token with `alg: 'none'` header is rejected.
- Token with `alg: 'RS256'` header is rejected, even when the
  asymmetric key bytes equal the HMAC secret.
- `JWT_ALGORITHM` is exported and equals `'HS256'`.

### `src/authorizer/__tests__/index.test.mjs`

- Apikey verify rejects `alg: 'none'`.
- Apikey verify rejects `alg: 'RS256'`.
- Bearer verify rejects `alg: 'none'`.
- Bearer verify rejects `alg: 'RS256'`.

## Non-goals

- No asymmetric algorithm support (RS256, EdDSA, etc.) — if added
  later, this constant and its call sites must be revisited. The
  constant is the single migration point.
- No changes to V-01's `assertJwtSecret` or its callers.
- No README change — algorithm choice is not documented today and
  does not need to be surfaced to consumers.

## Constraints satisfied

- Every existing HS256 session continues to verify.
- All three verify sites are covered (a miss defeats the fix).
- Single constant eliminates typo risk across files.
- All existing tests remain green. `npm test` passes.
