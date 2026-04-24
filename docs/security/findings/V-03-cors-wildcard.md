# V-03 — CORS wildcard origin with header-based auth

- **Severity (reported):** High
- **Status:** Fixed
- **Affected (reported):** `src/shared/cors.mjs:1-10`
- **Backend dependence:** None

## Report summary

`Access-Control-Allow-Origin: *` paired with `apikey` / `Authorization` in `Access-Control-Allow-Headers`. Browsers block cookie-bearing cross-origin requests with a wildcard, but this API authenticates via headers — so any site can read anon-scope data using the public anon key, and can replay a stolen Bearer token cross-origin.

## Our analysis

**Status: fixed at HEAD.**

- `src/shared/cors.mjs` — `buildCorsHeaders(corsConfig, origin)` computes per-request CORS headers. The static `CORS_HEADERS` export is retained for backward compatibility.
- `src/shared/cors.mjs` — `assertCorsConfig(corsConfig, production)` throws at construction when `allowedOrigins` is `'*'` and `production` is `true`.
- `src/index.mjs` — `resolveConfig` resolves `cors.allowedOrigins` (default `'*'`), `cors.allowCredentials` (default `false`), and `production` (default `process.env.NODE_ENV === 'production'`). `createPgrest` calls `assertCorsConfig` after `assertJwtSecret`.
- `src/rest/handler.mjs` and `src/auth/handler.mjs` — both compute CORS headers per-request via `buildCorsHeaders` and pass them through to all response functions.

## Decision

Configurable CORS origin with production guardrail. Default remains wildcard for dev; production requires explicit allowlist.

## Evidence

- `src/shared/cors.mjs` — `buildCorsHeaders` computes per-request origin. `assertCorsConfig` throws at construction when wildcard + production.
- `src/shared/__tests__/cors.test.mjs` — unit tests for `buildCorsHeaders` (wildcard, array, function, credentials) and `assertCorsConfig` (production guardrail).
- `src/index.mjs` — `resolveCors`, `assertCorsConfig` integration, `ctx.cors` plumbing.

## Residual risk

Operators must configure `cors.allowedOrigins` and enable `production: true` for the guardrail to activate. Unconfigured deployments still use wildcard. Even with an origin allowlist, a compromised allowlisted origin (XSS on the consumer's own app) still has full-token reach. Library consumer owns CSP / app-level hardening.

## Reviewer handoff

CORS origin is now configurable via `createPgrest({ cors: { allowedOrigins } })` with a production guardrail that rejects wildcard. Verify `npm test` passes; spot-check that OPTIONS responses reflect configured origins.
