# V-02 — JWT algorithm not pinned (algorithm confusion risk)

- **Severity (reported):** Critical
- **Status:** Open
- **Affected (reported):** `src/auth/jwt.mjs:25-27`, `src/authorizer/index.mjs:16-18, 28-29`
- **Backend dependence:** None

## Report summary

`jwt.verify()` called without `algorithms: ['HS256']`. Defense-in-depth failure per RFC 8725 §3.1 — library downgrade or algorithm-confusion attacks become viable.

## Our analysis

**Status: still open at HEAD.**

Three verify sites, none pinned:
- `src/auth/jwt.mjs:26` — `jwt.verify(token, secret, { issuer: ISSUER })`
- `src/authorizer/index.mjs:16-17` — `apikey` verify
- `src/authorizer/index.mjs:28-29` — Bearer token verify

`jsonwebtoken@9+` defaults block `none` but the pin is still required per RFC 8725 §3.1. `package.json` pins `jsonwebtoken@^9` (need to confirm), so we're safe today but a transitive downgrade would reintroduce the risk.

**Fix surface:** three-line change; pair with V-01 in a single JWT-hardening commit.

## Decision

_Pending triage._

## Evidence

_Commit / test / doc link when fixed._

## Residual risk

_Pin covers HS256 today; revisit if asymmetric (RS256/EdDSA) support is added._

## Reviewer handoff

_Two-sentence summary for the reviewer agent._
