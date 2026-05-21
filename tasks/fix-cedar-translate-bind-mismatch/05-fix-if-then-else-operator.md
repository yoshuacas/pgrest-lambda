# Task 05 -- Rewrite if-then-else to Lazy Translation

**Agent:** implementer
**Design:** docs/design/fix-cedar-translate-bind-mismatch.md
**Depends on:** Task 02

## Objective

Rewrite the `if-then-else` handler in `translateExpr` to
translate branches lazily -- only translate the surviving
branch when the condition resolves to null or FALSE. This
eliminates orphaned values from discarded branches without
complex placeholder renumbering.

## Target Tests

From Task 01:
- Test 6: if-then-else discards else branch
- Test 7: if-then-else discards then branch

## Implementation

Modify the `if-then-else` handler in `src/rest/cedar.mjs`
(line 345).

Current code:
```javascript
if ('if-then-else' in expr) {
    const ite = expr['if-then-else'];
    const ifSql = translateExpr(ite.if, values, tableName, schema);
    const thenSql = translateExpr(ite.then, values, tableName, schema);
    const elseSql = translateExpr(ite.else, values, tableName, schema);
    if (ifSql === null) return thenSql;
    if (ifSql === 'FALSE') return elseSql;
    const thenStr = thenSql === null ? 'TRUE' : thenSql;
    const elseStr = elseSql === null ? 'TRUE' : elseSql;
    return `CASE WHEN ${ifSql} THEN ${thenStr} ELSE ${elseStr} END`;
}
```

Replace with:
```javascript
if ('if-then-else' in expr) {
    const ite = expr['if-then-else'];
    const snap0 = values.length;
    const ifSql = translateExpr(ite.if, values, tableName, schema);
    if (ifSql === null) {
        values.length = snap0;
        return translateExpr(ite.then, values, tableName, schema);
    }
    if (ifSql === 'FALSE') {
        values.length = snap0;
        return translateExpr(ite.else, values, tableName, schema);
    }
    const thenSql = translateExpr(ite.then, values, tableName, schema);
    const elseSql = translateExpr(ite.else, values, tableName, schema);
    const thenStr = thenSql === null ? 'TRUE' : thenSql;
    const elseStr = elseSql === null ? 'TRUE' : elseSql;
    return `CASE WHEN ${ifSql} THEN ${thenStr} ELSE ${elseStr} END`;
}
```

Behavior:
- `ifSql === null`: condition is unconditionally true (e.g.,
  `Value(true)`). Pushed zero values. Truncate to snap0
  defensively, then translate only the `then` branch.
- `ifSql === 'FALSE'`: condition is unconditionally false
  (e.g., `Value(false)`). Pushed zero values. Truncate to
  snap0 defensively, then translate only the `else` branch.
- Neither: condition is a real SQL expression. Translate
  both branches -- all three are used in the CASE WHEN, so
  no values are orphaned.

The key insight is that lazy translation avoids the need for
placeholder renumbering. When only the surviving branch is
translated, its `$N` values naturally start at the correct
offset.

## Test Requirements

No additional tests beyond Task 01.

## Acceptance Criteria

- Target tests (6, 7) from Task 01 pass.
- All existing tests (`npm test`) still pass.
- The CASE WHEN path (both branches used) continues to
  produce correct SQL with matching placeholder numbers.

## Conflict Criteria

- If Tests 6 and 7 already pass before code changes, the
  eager translation may coincidentally produce correct
  `values` arrays for the specific test inputs. Verify by
  checking that both test expressions use `eqExpr` (which
  pushes values) -- if they don't push, the test isn't
  exercising the bug.
- If the CASE WHEN path regresses (e.g., existing
  if-then-else tests fail), verify that the `thenSql` and
  `elseSql` translations still occur after the two
  early-return guards.
