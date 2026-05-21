Fix off-by-one Postgres bind-parameter mismatch in PATCH/DELETE under Cedar row-level authorization.

## Bug

Reported in https://github.com/yoshuacas/pgrest-lambda/issues/4. User-role PATCH (and DELETE) requests fail with:

  {"code":"08P01","message":"bind message supplies N parameters, but prepared statement requires N-1"}

against pgrest-lambda 0.1.1, when per-table Cedar policies are loaded. Service-role works; only the path that splices Cedar authz residuals into the WHERE clause is broken.

## Root cause

In src/rest/cedar.mjs, translateExpr walks a Cedar partial-evaluation residual and emits SQL while pushing parameter values into a shared array as a side effect. For operators that may DISCARD a translated subexpression — '&&' (when a side collapses to 'FALSE'), '||' (when a side returns null/'FALSE'), '!' (when inner returns null/'FALSE'), and 'if-then-else' (when only one branch survives) — the discarded child's SQL is dropped but any values it pushed remain in the array. The result is more entries in 'values' than '$N' placeholders in the returned SQL.

Concrete trigger: a policy with 'resource has feature_id && resource has user_id && resource.user_id == principal' applied to a table that has user_id but no feature_id. 'has feature_id' on a column-less table returns 'FALSE'. The outer && collapses to 'FALSE', but the '==' on the right already pushed the principal id. Net: one extra value, no placeholder.

## Files

- src/rest/cedar.mjs:269-374 — translateExpr (the bug site, all four operators)
- src/rest/sql-builder.mjs:543-578 — buildUpdate (consumes authzConditions.values)
- src/rest/handler.mjs:340-358 — PATCH branch
- src/rest/__tests__/cedar.test.mjs — unit tests for translateExpr

## Fix approach

Save/restore values.length per branch in translateExpr. In every operator that may discard a translated branch (&&, ||, !, if-then-else), snapshot values.length before translating each side and truncate the array back to that snapshot if that branch's SQL is dropped. Surgical change that preserves the existing recursive shape and the exported translateExpr signature.

## Acceptance criteria

- New unit tests in cedar.test.mjs reproduce the off-by-one for each affected operator (&&, ||, !, if-then-else) and pass after the fix.
- A new test exercises buildAuthzFilter end-to-end with the issue-4 policy shape (default.cedar + per-table policy referencing a missing column) and asserts placeholder count == values count.
- All existing cedar.test.mjs and sql-builder.test.mjs cases still pass.
- CHANGELOG.md Unreleased section gets a 'Fixed' bullet referencing issue #4.

## Out of scope

- Larger refactor of translateExpr to return {sql, values} tuples (logged but deferred).
- DSQL- or Aurora-specific reproduction; the fix is purely in the SQL builder layer.