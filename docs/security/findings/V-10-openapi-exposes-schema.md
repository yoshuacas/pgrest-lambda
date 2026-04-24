# V-10 — OpenAPI spec exposes full schema to unauthenticated users

- **Severity (reported):** Medium
- **Status:** Open
- **Affected (reported):** `src/rest/handler.mjs:133-137`, `src/rest/openapi.mjs`
- **Backend dependence:** None

## Report summary

`GET /rest/v1/` returns the full introspected schema (tables, columns, types, nullability) with no role filtering. Anon key holders see the entire `public` schema.

## Our analysis

**Status: still open at HEAD.**

- `src/rest/router.mjs:9-10` — `/rest/v1/` routes to `{type: 'openapi'}` with no role check.
- `src/rest/handler.mjs:133-137` — returns `generateSpec(schema, ...)` unconditionally (the authorizer still runs, so the caller must at least present the anon apikey).

Tables prefixed `_` are excluded at introspection (`schema-cache.mjs:16,31`) — a small cushion but not role-based filtering.

PostgREST itself behaves similarly (spec served to any caller that passes auth). Wire-compat argues for keeping the default and making filtering/gating opt-in.

**Options at triage:**
1. Default unchanged; add config flag `openapi.requireRole = 'authenticated' | 'service_role'` for consumers who want to gate.
2. Role-aware filtering — compute per-role spec from Cedar. Higher complexity; deferred.
3. Document as a deliberate choice; tell consumers to put sensitive table names behind the `_` prefix or a separate schema (schema-switching is P2 in the gap analysis, out of scope here).

## Decision

_Pending triage._

## Evidence

_Commit / test / doc link when fixed._

## Residual risk

If kept as-is: schema is reconnaissance-visible. Consumer owns whether sensitive table/column names leak intent (e.g., `gdpr_deletion_queue`).

## Reviewer handoff

_Two-sentence summary for the reviewer agent — note PostgREST convention and wire-compat constraint._
