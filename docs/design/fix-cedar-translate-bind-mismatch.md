# Fix Cedar translateExpr Bind-Parameter Mismatch

## Overview

`translateExpr` in `src/rest/cedar.mjs` pushes values into a
shared array as a side effect while recursively translating
Cedar residual expressions to SQL. When a branch operator
(&&, ||, !, if-then-else) discards a sub-expression's SQL,
the values that sub-expression already pushed remain in the
array. The result: more bind parameters than `$N` placeholders
in the SQL. Postgres rejects the query with `08P01`.

This affects PATCH and DELETE under Cedar row-level policies
when a policy references a column the target table lacks
(triggering `has <col>` → FALSE collapse). Service-role
requests bypass Cedar entirely and are unaffected.

Reported as [issue #4](https://github.com/yoshuacas/pgrest-lambda/issues/4).

## Current CX / Concepts

### The Bug

A user with an `authenticated` role attempts a PATCH on a
table governed by a Cedar policy like:

```cedar
permit(
    principal is PgrestLambda::User,
    action in [
        PgrestLambda::Action::"select",
        PgrestLambda::Action::"update",
        PgrestLambda::Action::"delete"
    ],
    resource is PgrestLambda::Row
) when {
    resource has feature_id
    && resource has user_id
    && resource.user_id == principal
};
```

When applied to a table that has `user_id` but no
`feature_id`:

1. `has feature_id` translates to `'FALSE'` (column absent).
2. `resource.user_id == principal` pushes the user's ID into
   the values array and returns `"user_id" = $N`.
3. The outer `&&` sees `left === 'FALSE'`, returns `'FALSE'`,
   and discards the right-side SQL.
4. But the value pushed in step 2 remains in the array.

In this exact scenario the entire expression collapses to
FALSE, so `buildAuthzFilter` throws PGRST403 before
reaching Postgres (masking the orphaned value). The bug
manifests in production when a second permit policy
survives — e.g. a disjunction where one branch collapses
and the other doesn't:

```cedar
resource has feature_id && resource.feature_id == "x"
    || resource.user_id == principal
```

Here the left `&&` collapses to FALSE (orphaning "x" in
the values array), the right side survives as
`"user_id" = $2`, but `authzValues` is `["x", "alice"]`
— two values for one placeholder. Postgres returns:

```json
{"code":"08P01","message":"bind message supplies 2 parameters, but prepared statement requires 1"}
```

### Affected Operators

Four operator handlers in `translateExpr` (lines 291-317
and 345-355) may discard translated sub-expressions:

| Operator | Discards when |
|---|---|
| `&&` | Either side is `'FALSE'` — the other side's SQL is dropped |
| `\|\|` | Right is `null` (unconditional true) — left already pushed values but the returned `null` discards left's SQL, orphaning them |
| `!` | Inner returns `'FALSE'` (result is `null`) — inner could be a complex subtree that pushed values |
| `if-then-else` | Condition is `null` — else branch's values are orphaned; condition is `'FALSE'` — then branch's values are orphaned |

### Why Service-Role Is Unaffected

`buildAuthzFilter` returns `{ conditions: [], values: [] }`
for service-role principals because Cedar produces a decided
allow with no residuals. The `translateExpr` path is never
entered.

### Why SELECT Works (Mostly)

SELECT uses the same `buildAuthzFilter` → `translateExpr`
path, so it has the same latent bug. However, the common
trigger — a policy referencing a non-existent column —
causes the entire expression to collapse to FALSE, which
means `buildAuthzFilter` throws `PGRST403` (no permit
conditions survive). The query is never sent to Postgres.
The bug only manifests when some conditions survive AND
others are discarded. The PATCH/DELETE path is more exposed
because the handler calls `buildUpdate`/`buildDelete` which
splice authz values into a query that already has its own
SET/WHERE parameters.

## Proposed CX / CX Specification

### Fix Behavior

After the fix, `translateExpr` guarantees:

> The number of values pushed to the array equals the number
> of `$N` placeholders in the returned SQL string. If the
> returned SQL is `null` or `'FALSE'`, zero values were
> pushed (relative to the array state on entry).

### Mechanism: Snapshot/Restore

Before translating each sub-expression that may be discarded,
snapshot `values.length`. If the sub-expression's SQL is
discarded, truncate `values` back to the snapshot:

```javascript
if ('&&' in expr) {
    const snap0 = values.length;
    const left = translateExpr(expr['&&'].left, values, tableName, schema);
    const snap1 = values.length;
    const right = translateExpr(expr['&&'].right, values, tableName, schema);
    if (left === null && right === null) return null;
    if (left === null) return right;
    if (right === null) { values.length = snap1; return left; }
    if (left === 'FALSE' || right === 'FALSE') {
        values.length = snap0;
        return 'FALSE';
    }
    return `(${left} AND ${right})`;
}
```

This preserves the existing recursive shape, the exported
`translateExpr` signature, and the left-to-right evaluation
order. The only observable change is that orphaned values
are no longer left in the array.

### Error Messages

No new error messages. The fix is invisible to users — the
queries that previously failed with `08P01` now execute
correctly.

### Validation Rules

None. The fix is internal to the SQL translation layer.

## Technical Design

### `&&` Operator (line 291)

Current code translates both sides unconditionally, then
checks for discard conditions. The fix:

```javascript
if ('&&' in expr) {
    const snap0 = values.length;
    const left = translateExpr(
        expr['&&'].left, values, tableName, schema);
    const snap1 = values.length;
    const right = translateExpr(
        expr['&&'].right, values, tableName, schema);
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

Discard cases:
- `left === null, right !== null` — left pushed nothing
  (null comes from `Value(true)`, `is Row`, or a branch
  operator that collapsed to unconditional-allow — none
  push values). Keep right's values. No truncation needed.
- `right === null` — right pushed nothing, but left's
  values must be kept. Truncate to snap1 defensively in
  case a future change introduces a null-returning path
  that pushes values as a side effect.
- Either is `'FALSE'` — discard everything both sides
  pushed. Truncate to snap0.

### `||` Operator (line 301)

Current code translates left first, short-circuits if left
is null (unconditionally true), then translates right. The
bug: when `right === null`, left's values are already in
the array but the returned `null` discards left's SQL.

The fix adds snapshot/restore:

```javascript
if ('||' in expr) {
    const snap0 = values.length;
    const left = translateExpr(
        expr['||'].left, values, tableName, schema);
    if (left === null) {
        values.length = snap0;
        return null;
    }
    const snap1 = values.length;
    const right = translateExpr(
        expr['||'].right, values, tableName, schema);
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

Discard cases:
- `left === null` — left pushed nothing (null comes from
  `Value(true)`, `is Row`, or a branch operator that
  collapsed to unconditional-allow). Truncation to snap0
  is defensive.
- `right === null` — right pushed nothing, but left may
  have pushed values. Truncate to snap0 to discard left's
  orphaned values.
- Both `'FALSE'` — after the recursive fix, FALSE
  sub-expressions push zero values. Truncate to snap0
  defensively.
- `left === 'FALSE'` — left pushed nothing (snap0 ===
  snap1), right's values start at snap0 and are correctly
  numbered. Return right directly.
- `right === 'FALSE'` — right pushed nothing, so
  `values.length` already equals snap1. Truncation is
  defensive. Return left.

### `!` Operator (line 312)

```javascript
if ('!' in expr) {
    const snap = values.length;
    const inner = translateExpr(
        expr['!'].arg, values, tableName, schema);
    if (inner === null) return 'FALSE';
    if (inner === 'FALSE') {
        values.length = snap;
        return null;
    }
    return `NOT (${inner})`;
}
```

When `inner === null`: inner pushed nothing (null → no
placeholders). Return 'FALSE' with no values — correct.

When `inner === 'FALSE'`: after the recursive fix, inner
pushed nothing. But defensively truncate to snap anyway.

### `if-then-else` Operator (line 345)

Current code eagerly translates all three branches (if,
then, else), then selects which result to return. When
the condition resolves to null or FALSE, the discarded
branch's values are orphaned.

An eager approach would require value shuffling and
placeholder renumbering when discarding branches — complex
and fragile. Instead, **translate lazily**: only translate
branches that will be kept.

```javascript
if ('if-then-else' in expr) {
    const ite = expr['if-then-else'];
    const snap0 = values.length;
    const ifSql = translateExpr(
        ite.if, values, tableName, schema);
    if (ifSql === null) {
        values.length = snap0;
        return translateExpr(
            ite.then, values, tableName, schema);
    }
    if (ifSql === 'FALSE') {
        values.length = snap0;
        return translateExpr(
            ite.else, values, tableName, schema);
    }
    const thenSql = translateExpr(
        ite.then, values, tableName, schema);
    const elseSql = translateExpr(
        ite.else, values, tableName, schema);
    const thenStr = thenSql === null ? 'TRUE' : thenSql;
    const elseStr = elseSql === null ? 'TRUE' : elseSql;
    return `CASE WHEN ${ifSql} THEN ${thenStr} ELSE ${elseStr} END`;
}
```

When `ifSql` is null or FALSE, it pushed zero values (both
come from no-push expressions after the recursive fix), so
the snap0 truncation is a no-op but stays as a defensive
guard. Only the surviving branch is then translated — its
values are appended cleanly starting at snap0.

For the full CASE WHEN path, both branches are used so no
values are orphaned. The `null` to 'TRUE' replacement is
purely SQL-level (no placeholder).

### Invariant After Fix

After the fix is applied to all four operators recursively:

- If `translateExpr` returns `null`, it pushed **zero**
  values (relative to entry).
- If `translateExpr` returns `'FALSE'`, it pushed **zero**
  values (relative to entry).
- If `translateExpr` returns an SQL string, it pushed
  exactly as many values as there are `$N` placeholders in
  that string (relative to entry).

This invariant holds inductively: leaf expressions (`Value`,
`is`, `has`) never push values when returning null/FALSE.
Comparison operators always push exactly one value and
return one `$N`. Branch operators now clean up after
discarded children.

### Impact on `buildAuthzFilter`

`buildAuthzFilter` (line 708) uses a `tempValues` array
pre-seeded to `startParam - 1` length, passes it to
`translateExpr`, then slices off the pre-seed:

```javascript
const tempValues = new Array(startParam - 1);
// ... translateExpr(cond.body, tempValues, ...) ...
const authzValues = tempValues.slice(startParam - 1);
```

After the fix, `authzValues` will always have exactly as
many entries as there are `$N` placeholders in the
combined conditions SQL. No change to `buildAuthzFilter`
is needed.

### Impact on `buildUpdate` / `buildDelete`

These functions (lines 543-578, 580+) receive
`authzConditions.values` and append them to their own
parameter array. After the fix, the count will always
match. No change to these functions is needed.

## Code Architecture / File Changes

### Modified Files

| File | Change |
|---|---|
| `src/rest/cedar.mjs` | Add snapshot/restore logic to `&&`, `\|\|`, `!`, and `if-then-else` handlers in `translateExpr` |
| `src/rest/__tests__/cedar.test.mjs` | Add tests for bind-parameter correctness under discarded branches |
| `CHANGELOG.md` | Add Fixed bullet under Unreleased |

### Files That Do NOT Change

- `src/rest/sql-builder.mjs` — consumes authzConditions
  unchanged.
- `src/rest/handler.mjs` — calls buildAuthzFilter unchanged.
- `src/rest/query-parser.mjs` — no involvement.
- `src/auth/**` — no involvement.

## Testing Strategy

### Unit Tests: translateExpr Bind Correctness

Added to `src/rest/__tests__/cedar.test.mjs` in a new
`describe('translateExpr bind-parameter correctness')`
block.

Each test constructs an expression tree that triggers the
specific discard path, calls `translateExpr`, and asserts
that `values.length` matches the count of `$N` placeholders
in the returned SQL (or is zero for null/FALSE returns).

#### Test 1: && with right pushed but left is FALSE

```javascript
// resource has feature_id && resource.user_id == principal
// orders table lacks feature_id → left is FALSE
// Right pushes 'alice' → discarded
const expr = {
    '&&': {
        left: { has: { left: { Var: 'resource' }, attr: 'feature_id' } },
        right: eqExpr('user_id', 'alice'),
    },
};
const values = [];
const sql = translateExpr(expr, values, 'orders', schema);
assert.equal(sql, 'FALSE');
assert.deepEqual(values, []);
```

Uses the existing `schema` fixture — `orders` table has
`id`, `owner_id`, `amount` but no `feature_id`.
Note: `eqExpr` does not validate column existence against
the schema (only `has` does), so the comparison pushes a
value regardless.

#### Test 2: && with left pushed but right is FALSE

```javascript
// resource.user_id == principal && resource has feature_id
const expr = {
    '&&': {
        left: eqExpr('user_id', 'alice'),
        right: { has: { left: { Var: 'resource' }, attr: 'feature_id' } },
    },
};
const values = [];
const sql = translateExpr(expr, values, 'orders', schema);
assert.equal(sql, 'FALSE');
assert.deepEqual(values, []);
```

#### Test 3: || with left pushed but right is null (TRUE)

```javascript
// resource.user_id == principal || Value(true)
const expr = {
    '||': {
        left: eqExpr('user_id', 'alice'),
        right: { Value: true },
    },
};
const values = [];
const sql = translateExpr(expr, values, 'todos', schema);
assert.equal(sql, null);
assert.deepEqual(values, []);
```

#### Test 4: || with right pushed but left survives

```javascript
// resource.user_id == principal || resource.status == "x"
// where status exists — both push, both kept
const expr = {
    '||': {
        left: eqExpr('user_id', 'alice'),
        right: eqExpr('status', 'active'),
    },
};
const values = [];
const sql = translateExpr(expr, values, 'todos', schema);
assert.equal(sql, '("user_id" = $1 OR "status" = $2)');
assert.deepEqual(values, ['alice', 'active']);
```

#### Test 5: ! with inner pushed then collapsed

```javascript
// !(has feature_id && resource.user_id == principal)
// Inner && collapses to FALSE (feature_id missing in orders),
// ! of FALSE is null. Values must be empty.
const expr = {
    '!': {
        arg: {
            '&&': {
                left: { has: { left: { Var: 'resource' }, attr: 'feature_id' } },
                right: eqExpr('user_id', 'alice'),
            },
        },
    },
};
const values = [];
const sql = translateExpr(expr, values, 'orders', schema);
assert.equal(sql, null);
assert.deepEqual(values, []);
```

#### Test 6: if-then-else discards else branch

```javascript
// if (Value true) then (resource.user_id == 'a') else (resource.status == 'x')
// Condition is null → take then. Else never translated.
const expr = {
    'if-then-else': {
        if: { Value: true },
        then: eqExpr('user_id', 'alice'),
        else: eqExpr('status', 'archived'),
    },
};
const values = [];
const sql = translateExpr(expr, values, 'todos', schema);
assert.equal(sql, '"user_id" = $1');
assert.deepEqual(values, ['alice']);
```

#### Test 7: if-then-else discards then branch

```javascript
// if (Value false) then (resource.user_id == 'a') else (resource.status == 'x')
// Condition is FALSE → take else. Then never translated.
const expr = {
    'if-then-else': {
        if: { Value: false },
        then: eqExpr('user_id', 'alice'),
        else: eqExpr('status', 'archived'),
    },
};
const values = [];
const sql = translateExpr(expr, values, 'todos', schema);
assert.equal(sql, '"status" = $1');
assert.deepEqual(values, ['archived']);
```

#### Test 8: Issue #4 exact scenario (nested)

```javascript
// resource has feature_id && resource has owner_id
//   && resource.owner_id == principal
// Table: orders (has owner_id, lacks feature_id)
// Nested right (has owner_id && eq) would push a value,
// but outer && sees left is FALSE and discards everything.
const expr = {
    '&&': {
        left: { has: { left: { Var: 'resource' }, attr: 'feature_id' } },
        right: {
            '&&': {
                left: { has: { left: { Var: 'resource' }, attr: 'owner_id' } },
                right: eqExpr('owner_id', 'alice'),
            },
        },
    },
};
const values = [];
const sql = translateExpr(expr, values, 'orders', schema);
assert.equal(sql, 'FALSE');
assert.deepEqual(values, []);
```

#### Test 9: && right is null does not discard left values

```javascript
// resource.user_id == 'alice' && Value(true)
// Right is null → return left. Left's values must remain.
const expr = {
    '&&': {
        left: eqExpr('user_id', 'alice'),
        right: { Value: true },
    },
};
const values = [];
const sql = translateExpr(expr, values, 'todos', schema);
assert.equal(sql, '"user_id" = $1');
assert.deepEqual(values, ['alice']);
```

### Integration Test: buildAuthzFilter End-to-End

Added to the existing `describe('buildAuthzFilter')` block.

#### Test: Issue #4 policy shape — placeholder == values

```javascript
// Policy: permit when { resource has feature_id
//   && resource has user_id && resource.user_id == principal }
// Table: todos (has user_id, no feature_id)
// Expected: PGRST403 (all conditions collapse to FALSE)
// The key assertion is that if we reach buildUpdate,
// placeholder count == values count. But since the whole
// condition collapses, buildAuthzFilter should throw 403.
```

This tests the real-world scenario: the policy produces a
residual that collapses entirely when the table lacks a
referenced column. After the fix, `buildAuthzFilter` either:
- Throws PGRST403 (no permit conditions survive), or
- Returns conditions/values with matching counts.

A second variant uses a policy where only part of the
expression collapses:

```javascript
// Policy: permit when {
//     (resource has feature_id && resource.feature_id == "x")
//     || resource.user_id == principal
// }
// Table: todos (has user_id, no feature_id)
// Left branch of || collapses to FALSE (feature_id missing).
// Right branch survives: "user_id" = $N.
// Expected: conditions has one entry with $N, values has one
// entry. placeholder count == values.length.
```

### Existing Test Regression

All existing tests in `cedar.test.mjs` and
`sql-builder.test.mjs` must continue to pass. The fix
only removes orphaned values; it does not change the SQL
output for expressions where both branches are kept.

## Implementation Order

### Phase 1: Fix translateExpr

1. Add snapshot/restore to the `&&` handler.
2. Add snapshot/restore to the `||` handler.
3. Add snapshot/restore to the `!` handler.
4. Rewrite `if-then-else` to translate lazily (only
   translate the surviving branch when condition is
   null/FALSE).
5. Run existing tests — all must pass.

### Phase 2: Add Tests

6. Add the `describe('translateExpr bind-parameter
   correctness')` block with tests 1-9.
7. Add the buildAuthzFilter end-to-end test for the
   issue #4 policy shape.
8. Run full test suite — all pass.

### Phase 3: Changelog

9. Add a Fixed bullet to CHANGELOG.md Unreleased section
   referencing issue #4.

## Open Questions

None. The fix is mechanical and fully specified. The larger
refactor to return `{sql, values}` tuples from translateExpr
(which would prevent this class of bug structurally) is
logged but out of scope for this change.
