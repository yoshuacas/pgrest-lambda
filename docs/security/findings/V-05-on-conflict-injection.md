# V-05 — Identifier injection via `on_conflict` parameter

- **Severity (reported):** High
- **Status:** Open
- **Affected (reported):** `src/rest/sql-builder.mjs:444-460`
- **Backend dependence:** None

## Report summary

`on_conflict` split on comma and interpolated into SQL with double-quoting but no schema validation, unlike column names in SELECT/WHERE. Double-quoting prevents breakout in most cases but is not a substitute for allowlist validation; identifiers with embedded quotes or references to unrelated columns remain a risk surface.

## Our analysis

**Status: still open at HEAD. Report line numbers are slightly off; actual site is `src/rest/sql-builder.mjs:444-460`.**

```js
// sql-builder.mjs:444-448
if (parsed.onConflict) {
  const conflictCols = parsed.onConflict
    .split(',')
    .map((c) => `"${c.trim()}"`)     // ← no validateCol()
    .join(', ');
```

Every other column-interpolating path in this file (`buildJsonBuildObject`, `buildSelect`, `buildInsert` column list, `buildUpdate` SET list, `orderClause`) calls `validateCol()`. This is the only spot that skips it.

Exploitability is mostly limited by PostgreSQL identifier quoting (double quotes are preserved, embedded `"` would need `""` escaping which `map(c => c.trim())` doesn't provide) — so at minimum the double-quote character itself can break quoting. Error messages also leak column names from unrelated tables when a bogus identifier is supplied.

**Fix surface:** one-line insert of `validateCol(schema, table, c.trim())` into the map. No behavior change for valid input.

## Decision

_Pending triage._ Low-risk fix: run conflict columns through the existing `validateCol()`.

## Evidence

_Commit / test / doc link when fixed._

## Residual risk

None expected once validated.

## Reviewer handoff

_Two-sentence summary for the reviewer agent._
