# V-03 — CORS wildcard origin with header-based auth

- **Severity (reported):** High
- **Status:** Open
- **Affected (reported):** `src/shared/cors.mjs:1-10`
- **Backend dependence:** None

## Report summary

`Access-Control-Allow-Origin: *` paired with `apikey` / `Authorization` in `Access-Control-Allow-Headers`. Browsers block cookie-bearing cross-origin requests with a wildcard, but this API authenticates via headers — so any site can read anon-scope data using the public anon key, and can replay a stolen Bearer token cross-origin.

## Our analysis

**Status: still open at HEAD.**

- `src/shared/cors.mjs:1-10` — `CORS_HEADERS` is a static export with `Access-Control-Allow-Origin: '*'`. No factory-injected config; any consumer gets wildcard.
- `src/index.mjs` — `createPgrest` has no `cors` config hook; wildcard propagates unconditionally.
- Headers list includes `apikey`, `Authorization` — the attack path described in the report (any site reaches the API with a stolen Bearer token) is live.

Note: `Access-Control-Allow-Credentials` is **not** set, so cookie-bearing cross-origin fetches are still blocked by browsers. The real risk is header-based auth replay.

**Fix surface:** turn `CORS_HEADERS` into a factory-returned helper; plumb `cors: { allowedOrigins, allowCredentials }` through `createPgrest`. Default to wildcard for dev, require explicit list when a `production` flag (or any non-`*` value) is set.

## Decision

_Pending triage._ Likely: make CORS origin configurable via `createPgrest({ cors: { allowedOrigins } })`, keep wildcard as the dev default but refuse it when `NODE_ENV=production` or equivalent, and document the anon-key-as-public caveat.

## Evidence

_Commit / test / doc link when fixed._

## Residual risk

Even with origin allowlist, a compromised allowlisted origin (XSS on the consumer's own app) still has full-token reach. Library consumer owns CSP / app-level hardening.

## Reviewer handoff

_Two-sentence summary for the reviewer agent._
