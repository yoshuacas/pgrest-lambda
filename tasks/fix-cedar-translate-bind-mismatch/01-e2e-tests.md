# Task 01 -- End-to-End Tests for translateExpr Bind Correctness

**Agent:** implementer
**Design:** docs/design/fix-cedar-translate-bind-mismatch.md

## Objective

Write unit and integration tests covering every bind-parameter
discard scenario specified in the design. All tests must compile
and all tests must fail (since the fix is not yet implemented).

## Test File

`src/rest/__tests__/cedar.test.mjs`

Add a new `describe('translateExpr bind-parameter correctness')`
block after the existing `translateExpr` tests. Use the existing
`schema` fixture which already includes `todos` (has `user_id`,
`status`, `level`, `team_id` -- no `feature_id`) and `orders`
(has `id`, `owner_id`, `amount` -- no `feature_id`).

## Helpers

Add a local helper to the new describe block:

```javascript
function eqExpr(col, val) {
  return {
    '==': {
      left: { '.': { left: { Var: 'resource' }, attr: col } },
      right: { Value: val },
    },
  };
}
```

This constructs a comparison expression that pushes `val`
into the values array and returns `"<col>" = $N`.

## Test Cases

### Test 1: && with right pushed but left is FALSE

- **Given:** expression `has feature_id && user_id == 'alice'`,
  table `orders` (lacks `feature_id`).
- **When:** `translateExpr(expr, values, 'orders', schema)`.
- **Then:** returns `'FALSE'`, `values` is `[]`.

```javascript
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

### Test 2: && with left pushed but right is FALSE

- **Given:** expression `user_id == 'alice' && has feature_id`,
  table `orders` (lacks `feature_id`).
- **When:** `translateExpr(expr, values, 'orders', schema)`.
- **Then:** returns `'FALSE'`, `values` is `[]`.

```javascript
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

### Test 3: || with left pushed but right is null (TRUE)

- **Given:** expression `user_id == 'alice' || Value(true)`,
  table `todos`.
- **When:** `translateExpr(expr, values, 'todos', schema)`.
- **Then:** returns `null`, `values` is `[]`.

```javascript
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

### Test 4: || both sides survive -- values correctly numbered

- **Given:** expression `user_id == 'alice' || status == 'active'`,
  table `todos`.
- **When:** `translateExpr(expr, values, 'todos', schema)`.
- **Then:** returns `'("user_id" = $1 OR "status" = $2)'`,
  `values` is `['alice', 'active']`.

```javascript
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

### Test 5: ! with inner pushed then collapsed

- **Given:** expression `!(has feature_id && user_id == 'alice')`,
  table `orders` (lacks `feature_id`).
- **When:** `translateExpr(expr, values, 'orders', schema)`.
- **Then:** returns `null`, `values` is `[]`.

```javascript
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

### Test 6: if-then-else discards else branch

- **Given:** expression `if Value(true) then user_id == 'alice'
  else status == 'archived'`, table `todos`.
- **When:** `translateExpr(expr, values, 'todos', schema)`.
- **Then:** returns `'"user_id" = $1'`, `values` is `['alice']`.

```javascript
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

### Test 7: if-then-else discards then branch

- **Given:** expression `if Value(false) then user_id == 'alice'
  else status == 'archived'`, table `todos`.
- **When:** `translateExpr(expr, values, 'todos', schema)`.
- **Then:** returns `'"status" = $1'`, `values` is `['archived']`.

```javascript
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

### Test 8: Issue #4 exact scenario (nested)

- **Given:** expression `has feature_id && (has owner_id
  && owner_id == 'alice')`, table `orders` (has `owner_id`,
  lacks `feature_id`).
- **When:** `translateExpr(expr, values, 'orders', schema)`.
- **Then:** returns `'FALSE'`, `values` is `[]`.

```javascript
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

### Test 9: && right is null does not discard left values

- **Given:** expression `user_id == 'alice' && Value(true)`,
  table `todos`.
- **When:** `translateExpr(expr, values, 'todos', schema)`.
- **Then:** returns `'"user_id" = $1'`, `values` is `['alice']`.

```javascript
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

## Integration Test: buildAuthzFilter End-to-End

Add to the existing `describe('buildAuthzFilter')` block in
`cedar.test.mjs` (or the integration test file if one exists
for buildAuthzFilter).

### Test 10: Issue #4 policy -- partial collapse, placeholder count matches values

This test verifies the real-world scenario where one branch of
a disjunction collapses and the other survives.

- **Given:** A Cedar policy:
  ```cedar
  permit(
      principal is PgrestLambda::User,
      action == PgrestLambda::Action::"select",
      resource is PgrestLambda::Row
  ) when {
      (resource has feature_id && resource.feature_id == "x")
      || resource.user_id == principal
  };
  ```
  Table: `todos` (has `user_id`, no `feature_id`).
- **When:** `buildAuthzFilter` is called for authenticated user
  `alice` on table `todos` with action `select`.
- **Then:** The returned `conditions` contains one entry with
  `"user_id" = $N` and `values` has exactly one entry (`'alice'`).
  The number of `$N` placeholders in the conditions SQL equals
  `values.length`.

## Acceptance Criteria

- All tests compile and run without errors.
- Tests 1, 2, 3, 5, 6, 7, 8 fail with assertion errors (the
  current code leaves orphaned values in the array).
- Tests 4 and 9 pass (no discard occurs, current code is correct).
- Test 10 fails (bind mismatch or incorrect values array).
- No changes to production code.

## Conflict Criteria

- If any test that is expected to fail instead passes (Tests 1,
  2, 3, 5, 6, 7, 8, 10), first diagnose why by following the
  "Unexpected test results" guidance: investigate the code path,
  verify the assertion targets the right behavior, and attempt
  to rewrite the test to isolate the intended code path. Only
  escalate if you cannot construct a well-formed test that
  targets the desired behavior.
- If tests 4 or 9 unexpectedly fail, the `eqExpr` helper or
  schema fixture may be incorrectly constructed -- verify
  against the existing test patterns in the file.
