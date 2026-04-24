# V-07 — Provider refresh token embedded in JWT `prt` claim

- **Severity (reported):** High
- **Status:** Open
- **Affected (reported):** `src/auth/jwt.mjs:17-20`, `src/auth/handler.mjs:104-107, 147-150`
- **Backend dependence:** None (auth-provider dependent, not DB-dependent)

## Report summary

`signRefreshToken()` embeds the provider's refresh token (Cognito refresh token or GoTrue opaque key) in the JWT `prt` claim. JWTs are base64, not encrypted. An attacker with the refresh JWT can base64-decode and extract the provider token. For Cognito this allows direct calls to AWS Cognito API, bypassing pgrest-lambda entirely.

## Our analysis

**Status: still open at HEAD.**

- `src/auth/jwt.mjs:17-22` — `signRefreshToken(sub, providerRefreshToken)` puts `prt: providerRefreshToken` directly in the JWT payload, 30-day expiry.
- `src/auth/handler.mjs:104-107, 147-150, 183-186` — all three paths (signup, password grant, refresh grant) feed the provider token in.
- `src/auth/handler.mjs:178` — on refresh, `claims.prt` is decoded from the JWT and passed to `prov.refreshToken(...)`. This is the decode-and-replay path described in the report.
- `src/auth/providers/gotrue.mjs:81` — GoTrue `prt` is a 16-byte base64url opaque key that maps to `auth.refresh_tokens.token`. Exposure risk is medium: the key is already stored server-side and revocable, but there's no reason it needs client exposure.
- `src/auth/providers/cognito.mjs:99` — Cognito `prt` is the **actual Cognito refresh token**. Decoding it grants direct Cognito API access, completely bypassing pgrest-lambda. This is the higher-impact case.

**Fix surface:** session-ID indirection. GoTrue already has `auth.refresh_tokens` — JWT carries the row ID instead of the opaque token. Cognito needs a new `auth.sessions` row (or equivalent) storing the provider token server-side keyed by session ID. `jwt.verifyToken(refresh_token)` returns `sid`; `handleRefreshGrant` looks up `sid → provider token` before calling `prov.refreshToken`.

## Decision

_Pending triage._

## Evidence

_Commit / test / doc link when fixed._

## Residual risk

Session-ID model introduces a DB lookup on every refresh (small cost). Token storage becomes a revocation surface (good) and a sensitive table (needs protection at rest).

## Reviewer handoff

_Two-sentence summary for the reviewer agent._
