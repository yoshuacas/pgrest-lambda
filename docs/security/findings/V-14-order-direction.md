# V-14 — Order direction and nulls not validated

- **Severity (reported):** Medium (SQL injection via ORDER BY)
- **Status:** Fixed
- **Affected (reported):** `src/rest/query-parser.mjs:328-337`, `src/rest/sql-builder.mjs:290-301`
- **Backend dependence:** None

## Report summary

`parseOrder()` returns `direction` and `nulls` without allowlist validation. `sql-builder` interpolates `direction.toUpperCase()` directly into SQL. An attacker supplying `order=col.asc;DROP TABLE x--` achieves SQL injection after `ORDER BY "col"`.

## Our analysis

**Status: fixed at HEAD.**

The vulnerability was real and exploitable. The attack path:

1. Attacker sends `GET /rest/v1/tasks?order=title.asc;DROP TABLE tasks--`
2. `parseOrder()` splits on `.` → `{ column: "title", direction: "asc;DROP TABLE tasks--" }`
3. `orderClause()` validates the column via schema cache (safe), but passes `direction` through `.toUpperCase()` verbatim
4. Emitted SQL: `ORDER BY "title" ASC;DROP TABLE TASKS--`
5. Semicolon starts a new statement; `--` comments out trailing SQL

API Gateway preserves `;` in query string values — this was exploitable on production deployments.

The `nulls` field had a partial mitigation: `o.nulls === 'nullsfirst'` is an exact match, so bad input only maps to `NULLS LAST` (not injectable, but incorrect behavior for garbage input — should reject).

**Fix surface:** two allowlists in `parseOrder()` at the parse boundary, rejecting invalid values with a 400 before they ever reach the SQL builder.

### Changes

1. **`src/rest/query-parser.mjs`** — Added `VALID_ORDER_DIRECTIONS = {'asc', 'desc'}` and `VALID_ORDER_NULLS = {'nullsfirst', 'nullslast'}` allowlists. `parseOrder()` now validates both fields and throws `PostgRESTError(400, 'PGRST100')` on mismatch. Follows the existing pattern used by `VALID_OPERATORS` and `VALID_IS_VALUES` in the same file.

2. **`src/rest/__tests__/query-parser.test.mjs`** — Five new tests:
   - `rejects SQL injection via order direction (V-14)` — `col.asc;DROP TABLE x--`
   - `rejects unknown direction value` — `col.ascending`
   - `rejects SQL injection via nulls option` — `col.asc.nullsfirst;DROP TABLE x`
   - `rejects unknown nulls value` — `col.desc.first`
   - `accepts valid nullsfirst option` — positive case

3. **No changes to `sql-builder.mjs`** — the fix is at the parse boundary. The SQL builder's `orderClause()` is now defense-in-depth only; it can never receive invalid direction/nulls values from the parser.

## Decision

Fixed. Allowlist validation at the parse boundary. Consistent with how operators (`VALID_OPERATORS`) and IS values (`VALID_IS_VALUES`) are already validated in the same file.

## Evidence

- Allowlist added to `src/rest/query-parser.mjs:parseOrder()` — `VALID_ORDER_DIRECTIONS` and `VALID_ORDER_NULLS`
- 5 new tests in `src/rest/__tests__/query-parser.test.mjs` covering injection payloads, unknown values, and valid inputs
- 825 tests passing (820 existing + 5 new), 0 failures
- Existing tests for `?order=created_at.desc.nullslast`, multi-column ordering, and default direction continue to pass

## Residual risk

None. The allowlist is exhaustive — only `asc`, `desc`, `nullsfirst`, and `nullslast` can reach the SQL builder. The column is already validated against the schema cache by `validateCol()`.

## Reviewer handoff

`parseOrder()` now validates `direction` against `{asc, desc}` and `nulls` against `{nullsfirst, nullslast}`, returning 400 PGRST100 for any other value. This closes the SQL injection path where `order=col.asc;DROP TABLE x--` produced `ORDER BY "col" ASC;DROP TABLE X--`. The fix mirrors the existing allowlist pattern for operators and IS values in the same file.
