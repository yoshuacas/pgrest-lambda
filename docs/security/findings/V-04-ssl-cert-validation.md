# V-04 — SSL certificate validation disabled

- **Severity (reported):** High
- **Status:** Open
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

_Pending triage._ Per-adapter: DSQL hard-enforces verify; Postgres adapter gets explicit config with secure default.

## Evidence

_Commit / test / doc link when fixed._

## Residual risk

Self-managed-Postgres consumer who disables verification explicitly accepts MITM risk; documented in adapter README.

## Reviewer handoff

_Two-sentence summary for the reviewer agent._
