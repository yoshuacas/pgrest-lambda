# V-04 — SSL certificate validation disabled

- **Severity (reported):** High
- **Status:** Fixed
- **Affected (reported):** `src/rest/db/postgres.mjs:31`, `src/rest/db/dsql.mjs:42`
- **Backend dependence:** Yes — per-adapter decision

## Report summary

Both DB adapters set `ssl: { rejectUnauthorized: false }`. DSQL IAM tokens traverse this connection — MITM at network layer could intercept credentials and every query.

## Our analysis

**Status: still open at HEAD — and worse than reported for standard Postgres.**

- `src/rest/db/dsql.mjs:42` — `ssl: { rejectUnauthorized: false }`, unconditional. DSQL has AWS-issued certs; no legitimate reason to skip.
- `src/rest/db/postgres.mjs:31` — `ssl: config.ssl ? { rejectUnauthorized: false } : undefined`. When SSL is enabled it's enabled **insecurely**; when disabled, there's no SSL at all. There is no path to "SSL on, verify on" — that's a strictly worse posture than the report suggests, because a consumer who opts in to TLS gets MITM exposure without knowing it.
- `src/rest/db/postgres.mjs:18-23` — `connectionString` path has **no `ssl` key at all**; relies on `sslmode=...` in the URL (pg library honors it). Acceptable, but means the `config.ssl` boolean is only exercised on the host/port path.

**Fix surface:**
- `dsql.mjs`: hard-set `rejectUnauthorized: true`.
- `postgres.mjs`: accept `ssl` as `boolean | { rejectUnauthorized?, ca?, ... }`; default `true` on the object path; document the override story per backend.

## Decision

DSQL adapter hard-sets `rejectUnauthorized: true` with no
consumer override — AWS-managed certs chain to public roots.
Standard Postgres adapter resolves `config.ssl` via a new
`resolveSsl` function: `true` → `{ rejectUnauthorized: true }`,
object → forwarded with `rejectUnauthorized: true` as default
(consumer can override to `false`), falsy → no TLS. The
connection-string path is unchanged (`sslmode=...` in the URL).

## Evidence

- DSQL fix: `57e0e02` (`src/rest/db/dsql.mjs`)
- Postgres fix: `5f73553` (`src/rest/db/postgres.mjs`)
- Tests: `src/rest/db/__tests__/dsql.test.mjs`,
  `src/rest/db/__tests__/postgres.test.mjs`
- README TLS configuration subsection documents all four
  postures and the breaking change.

## Residual risk

A consumer who passes `ssl: { rejectUnauthorized: false }` to
the standard Postgres adapter explicitly accepts MITM risk.
This is an opt-in override, not a default, and is documented
in the README with a clear warning.

## Reviewer handoff

V-04 is fixed: DSQL always verifies TLS certificates; the
standard Postgres adapter now defaults to verification-on,
with an explicit object override for consumers who need to
disable it. The breaking change (self-signed certs now fail
with `ssl: true`) is documented in the README and CHANGELOG.
