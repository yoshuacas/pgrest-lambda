# Task 04 -- Fix ! Operator Snapshot/Restore

**Agent:** implementer
**Design:** docs/design/fix-cedar-translate-bind-mismatch.md
**Depends on:** Task 02

## Objective

Add snapshot/restore logic to the `!` handler in
`translateExpr` so that when the inner expression collapses
to FALSE (meaning `!` returns null), any values the inner
subtree pushed are cleaned up.

## Target Tests

From Task 01:
- Test 5: ! with inner pushed then collapsed

## Implementation

Modify the `!` handler in `src/rest/cedar.mjs` (line 312).

Current code:
```javascript
if ('!' in expr) {
    const inner = translateExpr(expr['!'].arg, values, tableName, schema);
    if (inner === null) return 'FALSE';
    if (inner === 'FALSE') return null;
    return `NOT (${inner})`;
}
```

Replace with:
```javascript
if ('!' in expr) {
    const snap = values.length;
    const inner = translateExpr(expr['!'].arg, values, tableName, schema);
    if (inner === null) return 'FALSE';
    if (inner === 'FALSE') {
        values.length = snap;
        return null;
    }
    return `NOT (${inner})`;
}
```

Behavior:
- `inner === null`: inner pushed nothing (null comes from
  `Value(true)`, `is Row`, or a branch that collapsed to
  unconditional allow). Return 'FALSE' -- no cleanup needed.
- `inner === 'FALSE'`: after the `&&` fix (Task 02), inner
  pushes zero values when returning FALSE. The truncation
  is defensive -- ensures correctness even if a future code
  path introduces a null-returning expression that pushes
  values as a side effect.
- Inner returns SQL: keep values, wrap in NOT.

## Test Requirements

No additional tests beyond Task 01.

## Acceptance Criteria

- Target test (5) from Task 01 passes.
- All existing tests (`npm test`) still pass.

## Conflict Criteria

- If Test 5 already passes before code changes, this is
  expected if Task 02's `&&` fix already cleaned up the
  inner subtree's values. Verify by temporarily reverting
  the Task 02 fix and confirming Test 5 fails -- this
  validates that the `!` defensive guard is still needed
  for correctness against future changes.
- If the `NOT (${inner})` path regresses, verify that
  `snap` captures state before inner translation and that
  no truncation occurs in the SQL-returning path.
