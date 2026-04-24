# V-14 — Order direction and nulls not validated

- **Severity (reported):** Medium (claimed ORDER BY SQL injection)
- **Status:** Open
- **Affected (reported):** `src/rest/query-parser.mjs:328-337`, `src/rest/sql-builder.mjs:290-301`
- **Backend dependence:** None

## Report summary

`parseOrder()` returns `direction` and `nulls` without allowlist. `sql-builder` interpolates `direction.toUpperCase()` directly into SQL. If an attacker supplies `order=col.asc;DROP TABLE x--`, the injection lands after `ORDER BY "col"`.

## Our analysis

**Status: still open at HEAD. Report's exploit claim needs qualification.**

- `src/rest/query-parser.mjs:328-337` — `parseOrder` still returns `direction: parts[1] || 'asc'`, `nulls: parts[2] || null` with no validation.
- `src/rest/sql-builder.mjs:290-301` — `orderClause` validates the column via `validateCol()` (good) and emits `"${col}" ${direction.toUpperCase()}` plus conditional `NULLS FIRST|LAST` based on `o.nulls === 'nullsfirst'` check. The `NULLS` branch is an exact string comparison so even bad input only maps to `LAST`.

**Is the "SQL injection via ORDER BY" exploit real?** Largely no, because API Gateway query-string parsing URL-decodes and the value flows through `parseInt`-adjacent string ops — but `parts[1]` is still untrusted text, and `toUpperCase()` preserves punctuation. A value like `desc,col2` after dot-split is `['col', 'desc', 'col2']` — `direction` becomes `'desc'`, `nulls` becomes `'col2'` which the `nulls === 'nullsfirst'` check rejects. But `order=col.asc;DROP TABLE x` dot-splits to `['col', 'asc;DROP TABLE x']` → `direction = 'asc;DROP TABLE x'` → emits `"col" ASC;DROP TABLE X` into SQL. **That's a real injection.**

API Gateway URL-parses `;` and keeps it in the value — it's a valid query-string character. This is exploitable on the current HEAD.

**Fix surface:** allowlist `{asc, desc}` / `{nullsfirst, nullslast}`, 400 on miss. Same-commit candidate with V-05.

## Decision

_Pending triage._ Allowlist: `{asc, desc}` / `{nullsfirst, nullslast}`; 400 on miss.

## Evidence

_Commit / test / doc link when fixed._

## Residual risk

None expected once allowlisted.

## Reviewer handoff

_Two-sentence summary for the reviewer agent — flag the exploit claim and our reproduction status._
