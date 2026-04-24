# V-01 — No JWT secret strength enforcement

- **Severity (reported):** Critical
- **Status:** Fixed
- **Affected (reported):** `src/auth/jwt.mjs:6-8`, `src/authorizer/index.mjs:8`
- **Backend dependence:** None — applies to all deployments

## Report summary

`JWT_SECRET` is consumed without validating length, entropy, or format. `jsonwebtoken` accepts any string including `""` or `"secret"`. A weak secret allows offline brute force of tokens, leading to `service_role` forgery and full data access.

## Our analysis

Pre-fix state:

- `src/auth/jwt.mjs:6-7` — `createJwt(config)` read `config.jwtSecret` with no validation; all three exported functions (`signAccessToken`, `signRefreshToken`, `verifyToken`) consumed it as-is.
- `src/authorizer/index.mjs:8` — authorizer `handler` read `config.jwtSecret` per-invocation; same no-validation path.
- `src/index.mjs:64` — factory plumbed `config.jwtSecret || process.env.JWT_SECRET` with **no length check**, so both an empty string and env-var-absent (`undefined`) fell through. An `undefined` secret would blow up on first sign/verify; an empty string or short string was the exploitable case.

Post-fix state (HEAD):

- `assertJwtSecret` in `src/auth/jwt.mjs` enforces a 32-character minimum, rejecting missing, non-string, and short secrets with actionable error messages (includes `openssl rand -base64 48` remediation).
- Called from `createPgrest` (`src/index.mjs`), `createJwt` (`src/auth/jwt.mjs`), and `createAuthorizer` (`src/authorizer/index.mjs`) — defense-in-depth across all entry points.
- Test coverage at `src/auth/__tests__/assert-jwt-secret.test.mjs` (unit) and integration paths in `src/__tests__/index.test.mjs`.

## Decision

Add `assertJwtSecret` validation at factory construction
(`createPgrest`, `createJwt`, `createAuthorizer`) requiring
>= 32 character string secret. Throws on violation.
32-character minimum aligns with HS256 256-bit key floor per
RFC 7518 Section 3.2.

## Evidence

Unit tests in `src/auth/__tests__/assert-jwt-secret.test.mjs`
cover all input classes (missing, non-string, short, boundary,
valid). Integration tests verify rejection at `createJwt`,
`createPgrest`, and `createAuthorizer` entry points. All
existing test secrets updated to >= 32 chars.

## Residual risk

Validation checks `string.length` (UTF-16 code units), not
byte length. For ASCII/base64 secrets (the only realistic
inputs), these are identical. A multi-byte UTF-8 secret would
have `string.length <= byte_length`, so the check is
conservative. The validation does not assess entropy — a
32-char repeated string passes. Entropy enforcement is out of
scope per design decision.

## Reviewer handoff

Verify error messages match the design spec. Confirm no test
file uses a secret shorter than 32 characters. Run `npm test`
to confirm green suite.
