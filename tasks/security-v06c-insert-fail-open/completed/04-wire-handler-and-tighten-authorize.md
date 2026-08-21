# Task 04 -- Wire Handler POST Case and Tighten authorize()

**Agent:** implementer
**Design:** docs/design/security-v06c-insert-fail-open.md
**Depends on:** Task 03

## Objective

Connect the handler's POST (INSERT) path to
`cedar.authorizeInsert()` and close the fail-open branch in
the existing `authorize()` function.

## Target Tests (from Task 01)

All eight tests from Task 01 should now pass:
- Test 1: Exploit Regression -- Owner Mismatch (DENY)
- Test 2: Exploit Regression -- Owner Match (ALLOW)
- Test 3: Bulk Insert -- Mixed Ownership (DENY)
- Test 4: Service-Role Bypass (ALLOW)
- Test 5: Decided Allow -- No Row Conditions (ALLOW)
- Test 6: Forbid Residual -- restricted=true (DENY)
- Test 7: Forbid Residual -- restricted=false (ALLOW)
- Test 8: Missing Column on Row (DENY)

## Implementation

### 1. Update `src/rest/handler.mjs` POST case

At lines 314-335, replace the `cedar.authorize()` call with
`cedar.authorizeInsert()`. The parsed body must be wrapped
into an array:

**Before (lines 322-324):**
```javascript
cedar.authorize({
  principal, action: 'insert', resource: table, schema,
});
```

**After:**
```javascript
const insertRows = Array.isArray(body) ? body : [body];
cedar.authorizeInsert({
  principal, resource: table, schema,
  rows: insertRows,
});
```

Use `insertRows` as the variable name to avoid shadowing the
outer `let rows` at line 269. The rest of the POST case
(query building, result assignment) is unchanged.

### 2. Tighten `authorize()` in `src/rest/cedar.mjs`

At lines 485-491, the residual branch currently returns `true`
when there are non-trivial residuals (the fail-open bug).
Replace the entire block:

**Before (lines 485-491):**
```javascript
if (partial.type === 'residuals') {
  const resp = partial.response;
  if (resp.decision === 'allow') return true;
  if (resp.decision !== 'deny'
      && resp.nontrivialResiduals.length > 0) {
    return true; // ← fail-open
  }
}
```

**After:**
```javascript
if (partial.type === 'residuals') {
  const resp = partial.response;
  if (resp.decision === 'allow'
      && resp.nontrivialResiduals.length === 0) {
    return true;
  }
}
```

This makes `authorize()` fail-closed: allow only when Cedar
reports a decided allow with no undecided residuals. The INSERT
path no longer calls `authorize()`, so this only affects RPC.
RPC policies on `Function` resources don't produce row-level
residuals (no column attributes), so the behavioral change is
a no-op in practice but closes the theoretical gap.

## Test Requirements

No new tests in this task. The E2E tests from Task 01 and
the unit tests from Tasks 02–03 cover the behavior.

Run `npm test` to verify:
- All new tests pass.
- All existing tests pass, including:
  - The existing `Cedar integration -- INSERT` test
    (`cedar.integration.test.mjs` line 293-331) that
    currently calls `cedar.authorize()` for table-level
    INSERT permits. That test uses an unconditional
    `permit ... resource is Table` policy, so
    `authorizeInsert` will grant it in Phase 1
    (the decided-allow path).
  - The existing `authorize (table-level)` unit tests in
    `cedar.test.mjs` -- these exercise `authorize()` for
    RPC-style paths and must continue to pass after the
    residual branch tightening.

## Acceptance Criteria

- `handler.mjs` POST case calls `cedar.authorizeInsert()`
  instead of `cedar.authorize()`.
- `authorize()` residual branch is fail-closed.
- All tests pass (`npm test`).

## Conflict Criteria

- If the existing `Cedar integration -- INSERT` test
  (`cedar.integration.test.mjs` line 293-331) starts failing,
  investigate. That test uses a table-level permit with no
  row conditions, so `authorizeInsert` should handle it via
  Phase 1 decided-allow. If it fails, the phase 1 logic may
  not be recognizing the policy correctly.
- If RPC tests break after tightening `authorize()`,
  investigate. RPC policies on `Function` resources should
  not produce residuals. If they do, the Cedar schema may
  have changed.
- If all target tests already pass before any code changes
  are made, investigate whether the tests are true positives
  before marking the task complete.
