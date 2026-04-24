# V-22 — Auth schema auto-migration runs on cold start

- **Severity (reported):** Info
- **Status:** Open
- **Affected (reported):** `src/auth/schema.mjs:34-46`
- **Backend dependence:** No (DB-agnostic); **GoTrue provider only**

## Report summary

`ensureAuthSchema()` executes `CREATE SCHEMA IF NOT EXISTS auth` + `CREATE TABLE IF NOT EXISTS` on cold start. Idempotent but is runtime DDL. If the DB user lacks CREATE, every auth request fails with an opaque error.

## Our analysis

**Status: still open at HEAD.**

- `src/auth/schema.mjs:1-42` — 5 DDL statements (CREATE SCHEMA, CREATE TABLE, CREATE INDEX × 3) run on every cold start via `ensureAuthSchema(pool)`.
- `src/auth/schema.mjs:34-42` — module-level `initialized` boolean amortizes across invocations within a container, resets on cold start.
- `src/auth/providers/gotrue.mjs:12, 57, 103, 174, 199` — every GoTrue operation calls `ensureAuthSchema(pool)` first. Redundant within a container; harmless but unnecessary per-invocation overhead.

**Fix surface:**
1. Add a CLI `pgrest-lambda migrate auth` command that applies the same DDL once.
2. Replace `ensureAuthSchema` with a validation-only check (`SELECT 1 FROM auth.users LIMIT 0`) that fails fast with a useful error if the schema is missing.
3. Keep the auto-DDL path behind a `config.auth.autoMigrate = true` flag for dev ergonomics.

## Decision

_Pending triage._

## Evidence

_Commit / test / doc link when fixed._

## Residual risk

Consumers using the zero-setup path grant broader DB privileges; documented.

## Reviewer handoff

_Two-sentence summary for the reviewer agent._
