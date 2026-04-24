# V-17 — Cognito ID token parsed without signature verification

- **Severity (reported):** Low
- **Status:** Open
- **Affected (reported):** `src/auth/providers/cognito.mjs:24-45`
- **Backend dependence:** No (DB-agnostic); **Cognito provider only**

## Report summary

`parseIdToken()` base64-decodes the payload without verifying the JWT signature. Token comes from the Cognito SDK over TLS so risk is limited — but V-04 disables TLS verify on the DB side (not applicable here) and any MITM of the Cognito response would allow identity spoofing.

## Our analysis

**Status: still open at HEAD.**

- `src/auth/providers/cognito.mjs:24-45` — `parseIdToken` does `Buffer.from(idToken.split('.')[1], 'base64url')` and `JSON.parse` with no signature verification.
- Called from `signIn` (line 94) and `refreshToken` (line 118) — both use the result to populate `user.id`, `user.email`, which flow into the access token that the authorizer later trusts.

Risk path: if a Cognito response body were tampered, the ID token `sub`/`email` would be attacker-controlled. In practice the AWS SDK pulls over TLS with SigV4; realistic attack requires SDK compromise. Low severity is correct.

**Fix surface:** validate via Cognito JWKS (`https://cognito-idp.{region}.amazonaws.com/{userPoolId}/.well-known/jwks.json`). Cacheable per-userPool. Adds cold-start latency on first verify. Can live behind `config.auth.verifyCognitoIdToken = true`.

## Decision

_Pending triage._

## Evidence

_Commit / test / doc link when fixed._

## Residual risk

JWKS fetching introduces cold-start latency; mitigated by caching.

## Reviewer handoff

_Two-sentence summary for the reviewer agent — scoped to Cognito provider._
