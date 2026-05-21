# Task 03 -- Fix || Operator Snapshot/Restore

**Agent:** implementer
**Design:** docs/design/fix-cedar-translate-bind-mismatch.md
**Depends on:** Task 02

## Objective

Add snapshot/restore logic to the `||` handler in
`translateExpr` so that discarded sub-expressions do not
leave orphaned values in the array.

## Target Tests

From Task 01:
- Test 3: || with left pushed but right is null (TRUE)
- Test 4: || both sides survive -- values correctly numbered

## Implementation

Modify the `||` handler in `src/rest/cedar.mjs` (line 301).

Current code:
```javascript
if ('||' in expr) {
    const left = translateExpr(expr['||'].left, values, tableName, schema);
    if (left === null) return null;
    const right = translateExpr(expr['||'].right, values, tableName, schema);
    if (right === null) return null;
    if (left === 'FALSE' && right === 'FALSE') return 'FALSE';
    if (left === 'FALSE') return right;
    if (right === 'FALSE') return left;
    return `(${left} OR ${right})`;
}
```

Replace with:
```javascript
if ('||' in expr) {
    const snap0 = values.length;
    const left = translateExpr(expr['||'].left, values, tableName, schema);
    if (left === null) {
        values.length = snap0;
        return null;
    }
    const snap1 = values.length;
    const right = translateExpr(expr['||'].right, values, tableName, schema);
    if (right === null) {
        values.length = snap0;
        return null;
    }
    if (left === 'FALSE' && right === 'FALSE') {
        values.length = snap0;
        return 'FALSE';
    }
    if (left === 'FALSE') return right;
    if (right === 'FALSE') {
        values.length = snap1;
        return left;
    }
    return `(${left} OR ${right})`;
}
```

Behavior:
- `left === null`: unconditional allow -- discard any values
  left may have pushed (defensive, currently a no-op).
- `right === null`: unconditional allow -- discard left's
  orphaned values by truncating to snap0.
- Both `'FALSE'`: after recursive fix, FALSE pushes zero
  values. Truncate defensively.
- `left === 'FALSE'`: left pushed nothing (snap0 === snap1).
  Right's values start at snap0 and are correctly numbered.
- `right === 'FALSE'`: right pushed nothing. Truncate to
  snap1 defensively. Return left.
- Both survive: no truncation needed.

## Test Requirements

No additional tests beyond Task 01.

## Acceptance Criteria

- Target tests (3, 4) from Task 01 pass.
- All existing tests (`npm test`) still pass.

## Conflict Criteria

- If Test 3 already passes before code changes, investigate
  whether the current `||` short-circuit on `left === null`
  (line 303) masks the issue by never reaching the right
  side. The test specifically exercises the case where left
  is NOT null but right IS null -- verify the expression
  ordering triggers this path.
- If Test 4 regresses after the change, check that both
  branches' values are retained when neither is discarded.
