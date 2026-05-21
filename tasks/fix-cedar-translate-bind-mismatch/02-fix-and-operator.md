# Task 02 -- Fix && Operator Snapshot/Restore

**Agent:** implementer
**Design:** docs/design/fix-cedar-translate-bind-mismatch.md

## Objective

Add snapshot/restore logic to the `&&` handler in
`translateExpr` so that discarded sub-expressions do not
leave orphaned values in the array.

## Target Tests

From Task 01:
- Test 1: && with right pushed but left is FALSE
- Test 2: && with left pushed but right is FALSE
- Test 8: Issue #4 exact scenario (nested)
- Test 9: && right is null does not discard left values

## Implementation

Modify the `&&` handler in `src/rest/cedar.mjs` (line 291).

Current code:
```javascript
if ('&&' in expr) {
    const left = translateExpr(expr['&&'].left, values, tableName, schema);
    const right = translateExpr(expr['&&'].right, values, tableName, schema);
    if (left === null && right === null) return null;
    if (left === null) return right;
    if (right === null) return left;
    if (left === 'FALSE' || right === 'FALSE') return 'FALSE';
    return `(${left} AND ${right})`;
}
```

Replace with:
```javascript
if ('&&' in expr) {
    const snap0 = values.length;
    const left = translateExpr(expr['&&'].left, values, tableName, schema);
    const snap1 = values.length;
    const right = translateExpr(expr['&&'].right, values, tableName, schema);
    if (left === null && right === null) return null;
    if (left === null) return right;
    if (right === null) {
        values.length = snap1;
        return left;
    }
    if (left === 'FALSE' || right === 'FALSE') {
        values.length = snap0;
        return 'FALSE';
    }
    return `(${left} AND ${right})`;
}
```

Behavior:
- `snap0`: array length before either side is translated.
- `snap1`: array length after left is translated.
- `right === null`: right pushed nothing (null comes from
  no-push expressions). Truncate to snap1 defensively to
  keep only left's values.
- Either is `'FALSE'`: both sides' values are discarded.
  Truncate to snap0.
- Both survive: no truncation, values from both sides are
  used in the SQL.

## Test Requirements

No additional tests beyond Task 01. The target tests
validate this change.

## Acceptance Criteria

- Target tests (1, 2, 8, 9) from Task 01 pass.
- All existing tests (`npm test`) still pass.
- No other operators are modified in this task.

## Conflict Criteria

- If target tests already pass before code changes,
  investigate whether the tests are false positives
  (e.g., testing a code path that doesn't actually
  trigger the discard).
- If existing tests break after the change, the
  snapshot/restore boundaries may be incorrect -- verify
  that `snap0` captures state before left translation and
  `snap1` captures state before right translation.
