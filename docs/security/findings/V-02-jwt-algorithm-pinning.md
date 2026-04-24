# V-02 — JWT algorithm not pinned (algorithm confusion risk)

- **Severity (reported):** Critical
- **Status:** Fixed
- **Affected (reported):** `src/auth/jwt.mjs:25-27`, `src/authorizer/index.mjs:16-18, 28-29`
- **Backend dependence:** None

## Report summary

`jwt.verify()` called without `algorithms: ['HS256']`. Defense-in-depth failure per RFC 8725 §3.1 — library downgrade or algorithm-confusion attacks become viable.

## Our analysis

**Status: fixed at HEAD.**

Three verify sites, none pinned:
- `src/auth/jwt.mjs:26` — `jwt.verify(token, secret, { issuer: ISSUER })`
- `src/authorizer/index.mjs:16-17` — `apikey` verify
- `src/authorizer/index.mjs:28-29` — Bearer token verify

`jsonwebtoken@9+` defaults block `none` but the pin is still required per RFC 8725 §3.1. `package.json` pins `jsonwebtoken@^9`, so we're safe today but a transitive downgrade would reintroduce the risk without the pin.

**Fix surface:** shared `JWT_ALGORITHM` constant exported from `src/auth/jwt.mjs`, applied at all sign and verify sites.

## Decision

Fix — pinned HS256 at all sign and verify sites via shared constant. Added `algorithm: JWT_ALGORITHM` to both `jwt.sign` calls and `algorithms: [JWT_ALGORITHM]` to all three `jwt.verify` calls. The constant is exported so `src/authorizer/index.mjs` imports it from the single source of truth.

## Evidence

- Source: `src/auth/jwt.mjs` (constant + sign/verify), `src/authorizer/index.mjs` (verify sites)
- Tests: `src/auth/__tests__/jwt.test.mjs` (HS256 round-trip, alg:none rejection, RS256 rejection), `src/authorizer/__tests__/index.test.mjs` (alg:none and RS256 rejection on both apikey and bearer paths)

## Residual risk

The pin covers HS256 only. If pgrest-lambda later adds asymmetric algorithm support (RS256, EdDSA, etc.), the `JWT_ALGORITHM` constant and all call sites must be revisited. The constant is the single migration point — changing it updates every sign and verify call.

## Reviewer handoff

All `jwt.sign` and `jwt.verify` calls now use an explicit `JWT_ALGORITHM` constant (`HS256`), exported from `src/auth/jwt.mjs` and imported by the authorizer. Tests confirm that tokens with `alg: none` or `alg: RS256` are rejected at every verify site.
