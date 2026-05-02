# Task 03 — Add evaluateResiduals and authorizeInsert

**Agent:** implementer
**Design:** docs/design/security-v06c-insert-fail-open.md
**Depends on:** Task 02

## Objective

Add the `evaluateResiduals` helper and the `authorizeInsert`
method to `src/rest/cedar.mjs`. These implement the two-phase
INSERT authorization logic that evaluates row-conditioned
policies against the proposed INSERT data.

## Target Tests (from Task 01)

- Test 1: Exploit Regression — Owner Mismatch (DENY)
- Test 2: Exploit Regression — Owner Match (ALLOW)
- Test 3: Bulk Insert — Mixed Ownership (DENY)
- Test 4: Service-Role Bypass (ALLOW)
- Test 5: Decided Allow — No Row Conditions (ALLOW)
- Test 6: Forbid Residual — restricted=true (DENY)
- Test 7: Forbid Residual — restricted=false (ALLOW)
- Test 8: Missing Column on Row (DENY)

Note: These tests won't fully pass until Task 04 wires the
handler to call `authorizeInsert`. But the `authorizeInsert`
unit tests below verify the method in isolation.

## Implementation

### `evaluateResiduals` (module-level function)

Add after `evaluateExprAgainstRow`. This function takes a
partial evaluation response, a single row, the principal UID,
and a boolean indicating whether a table-level permit was
already granted. It returns `true` only if:
- At least one permit is active (from a residual or table-level)
- No forbid residual fires

For each non-trivial residual:
1. Evaluate all `when` conditions using
   `evaluateExprAgainstRow`. Multiple `when` conditions on
   one policy are AND'd.
2. If all conditions are met and effect is `forbid`, return
   `false` immediately.
3. If all conditions are met and effect is `permit`, mark
   `anyPermitGranted = true`.

If the partial response's `decision` is `allow`, that counts
as a permit. Return `anyPermitGranted` at the end.

See the design's `evaluateResiduals` code block for the
reference implementation.

### `authorizeInsert` (method on createCedar return object)

Add inside `createCedar()`, after the existing `authorize()`
function. The method signature:

```javascript
function authorizeInsert({
  principal, resource, schema, rows,
})
```

Two-phase logic:

**Phase 1** — `isAuthorized()` against the concrete
`PgrestLambda::Table` resource. Records whether a table-level
permit was granted.

**Phase 2** — `isAuthorizedPartial()` with `resource: null`.
Always runs, even when Phase 1 granted. This catches
row-level forbids that `isAuthorized` cannot see.

Decision flow:
1. If partial eval returns no residuals type, check
   `tablePermitGranted`; allow if granted, 403 otherwise.
2. If no non-trivial residuals and either table permit or
   partial decision is allow, return `true`.
3. If partial decision is deny and no table permit, throw
   `PGRST403`.
4. For each row in `rows`, call `evaluateResiduals`. If any
   row fails, throw `PGRST403` with row index detail for
   bulk inserts.

The `PostgRESTError` constructor accepts a 4th argument
(`details`) — see `src/rest/errors.mjs:4`. For bulk inserts,
pass `Row N of the batch violates the insert policy` where
N is the zero-based index. For single-row inserts, pass
`null` as details.

Add `authorizeInsert` to the `createCedar()` return object:

```javascript
return {
  loadPolicies,
  refreshPolicies,
  _setPolicies,
  authorize,
  authorizeInsert,
  buildAuthzFilter,
  generateCedarSchema,
};
```

See the design's `authorizeInsert` code block for the full
reference implementation.

## Test Requirements

Add a `describe('authorizeInsert')` block to
`src/rest/__tests__/cedar.test.mjs`. Use the existing
`makeCedar` helper and `schema` object.

Add `orders` and `items` tables to the test `schema` object
(if not already present):

```javascript
orders: {
  columns: {
    id: { type: 'text', nullable: false, defaultValue: null },
    owner_id: { type: 'text', nullable: false, defaultValue: null },
    amount: { type: 'integer', nullable: true, defaultValue: null },
  },
  primaryKey: ['id'],
},
items: {
  columns: {
    id: { type: 'text', nullable: false, defaultValue: null },
    name: { type: 'text', nullable: true, defaultValue: null },
    restricted: { type: 'boolean', nullable: true, defaultValue: null },
  },
  primaryKey: ['id'],
},
```

### Unit test cases

1. **Decided allow** — Use the unconditional INSERT policy
   (`permit ... resource == Table::"posts"`). Call
   `authorizeInsert` with `{ title: 'Hello' }` as
   authenticated user. Expect `true`.

2. **Residual evaluated — matching row** — Use the
   owner-conditioned policy. Call with
   `{ owner_id: 'user-A' }` as user `user-A`.
   Expect `true`.

3. **Residual evaluated — non-matching row** — Same policy.
   Call with `{ owner_id: 'user-B' }` as user `user-A`.
   Expect `PGRST403` thrown.

4. **Bulk: all rows match** — Same policy. Call with
   `[{ owner_id: 'user-A' }, { owner_id: 'user-A' }]`.
   Expect `true`.

5. **Bulk: one row fails** — Same policy. Call with
   `[{ owner_id: 'user-A' }, { owner_id: 'user-B' }]`.
   Expect `PGRST403`. Verify `details` includes `Row 1`.

6. **No policies loaded** — Create a fresh cedar instance
   without calling `_setPolicies`. Call `authorizeInsert`.
   Expect `PGRST403`.

7. **Forbid residual fires** — Use the table-permit +
   row-forbid policy. Call with `{ restricted: true }`.
   Expect `PGRST403`.

8. **Forbid residual does not fire** — Same policy. Call
   with `{ restricted: false }`. Expect `true`.

## Acceptance Criteria

- `evaluateResiduals` exists as a module-level function.
- `authorizeInsert` is returned by `createCedar()`.
- All new unit tests pass.
- All existing tests (`npm test`) still pass.

## Conflict Criteria

- If `isAuthorized` or `isAuthorizedPartial` are not
  imported from `@cedar-policy/cedar-wasm/nodejs` at the
  top of cedar.mjs, do not add them — they should already
  exist (line 4-6). If missing, escalate.
- If the `createCedar()` return object has changed from what
  is shown at line 610-618, adapt the new entry accordingly.
- If all target unit tests pass before any code changes,
  investigate whether the tests are true positives.
