# V-09 — PostgreSQL error details forwarded to client

- **Severity (reported):** Medium
- **Status:** Fixed
- **Affected (reported):** `src/rest/errors.mjs:48-57`, `src/rest/handler.mjs:340-354`
- **Backend dependence:** None (same PG error model across backends)

## Report summary

PG error `message`, `detail`, `hint` forwarded verbatim. Constraint names, column names, values (including keys that exist) reach the client. Enables schema reconnaissance and confirms existence of records.

## Our analysis

**Status: fixed at HEAD.**

`mapPgError` now returns generic per-SQLSTATE messages
by default (sanitized mode). Raw `message`, `detail`,
and `hint` are replaced with safe text; `code` is
preserved for supabase-js compatibility. Verbose mode
(`config.errors.verbose` or `PGREST_ERRORS_VERBOSE=true`)
restores raw passthrough for local development.

The handler logs raw PG error details server-side at
`warn` level when sanitized mode is active, so operators
retain debuggability without client exposure.

## Decision

Sanitized mode (default) maps common PG codes to generic messages; preserves `code` for client-side branching. Verbose mode opt-in for dev.

## Evidence

See commit on branch `sec/V-09-pg-error-sanitize`.
Tests: `src/rest/__tests__/errors.test.mjs` (sanitized
+ verbose + code preservation),
`src/rest/__tests__/handler.integration.test.mjs`
(handler response shape + structured logging).

## Residual risk

Sanitized mode reduces debuggability in prod; mitigated by V-23 structured logging keeping full detail server-side.

## Reviewer handoff

`mapPgError` sanitizes PG error text by default; verbose
opt-in preserves raw text for dev. SQLSTATE `code` is
always preserved for supabase-js wire compat.
