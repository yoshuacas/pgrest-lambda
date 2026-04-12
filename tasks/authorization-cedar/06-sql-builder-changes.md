# Task 06: SQL Builder Changes — Remove appendUserId, Add authzConditions

**Agent:** implementer
**Design:** docs/design/authorization-cedar.md
**Depends on:** Task 05

## Objective

Modify `src/rest/sql-builder.mjs` to remove the implicit
`user_id` filtering and accept Cedar-derived authorization
conditions as an external parameter.

## Target Tests

This task does not directly target tests from Task 01 (those
are integration tests that require handler wiring in Task 07).
Instead, this task must:

1. Update **existing** `sql-builder.test.mjs` tests to match
   the new function signatures (no `userId`/`role` params)
2. Ensure all existing tests pass with the new signatures

The existing tests that need signature updates:

- All `buildSelect` calls: remove `userId` and `role` params
- All `buildInsert` calls: remove `userId` param
- All `buildUpdate` calls: remove `userId` and `role` params
- All `buildDelete` calls: remove `userId` and `role` params
- All `buildCount` calls: remove `userId` and `role` params

Tests that verify `appendUserId` behavior must be updated or
removed:

- 'appends user_id filter on table with user_id column' —
  **remove** (this behavior moves to Cedar)
- 'does NOT include user_id filter on table without user_id' —
  **remove** (no longer relevant)
- 'forces user_id to authenticated user, overriding body' —
  **remove** (INSERT no longer injects user_id)
- 'does not inject user_id on table without user_id column' —
  **remove** (no longer relevant)
- 'includes user_id in WHERE on table with user_id' (update
  and delete tests) — **remove**

Tests that verify `authzConditions` are appended:

- **Add** new test: 'buildSelect appends authzConditions to
  WHERE clause'
- **Add** new test: 'buildUpdate appends authzConditions to
  WHERE clause'
- **Add** new test: 'buildDelete appends authzConditions to
  WHERE clause'
- **Add** new test: 'buildCount appends authzConditions to
  WHERE clause'
- **Add** new test: 'buildSelect with no authzConditions
  works unchanged'

## Implementation

### Changes to `src/rest/sql-builder.mjs`

#### Remove

1. Delete the `appendUserId()` function (lines 80-86)
2. Remove the `import { hasColumn } from './schema-cache.mjs'`
   line — `hasColumn` is still used in `validateCol`, so only
   remove if it becomes unused. Check: `validateCol` also
   uses `hasColumn`, so keep the import.

   Actually, re-check: `hasColumn` is used in `validateCol`
   and `appendUserId`. After removing `appendUserId`, it is
   still used in `validateCol`. Keep the import.

#### Modify function signatures

3. `buildSelect(table, parsed, schema, authzConditions)` —
   remove `userId` and `role`, add optional `authzConditions`
4. `buildInsert(table, body, schema, parsed)` — remove
   `userId` parameter
5. `buildUpdate(table, body, parsed, schema, authzConditions)`
   — remove `userId` and `role`, add optional `authzConditions`
6. `buildDelete(table, parsed, schema, authzConditions)` —
   remove `userId` and `role`, add optional `authzConditions`
7. `buildCount(table, parsed, schema, authzConditions)` —
   remove `userId` and `role`, add optional `authzConditions`

#### Modify buildInsert

8. Remove all `user_id` force-injection logic:
   - Remove the `tableHasUserId` check
   - Remove the `if (key === 'user_id' && tableHasUserId) continue` skip
   - Remove the `if (tableHasUserId) columns.push('user_id')` addition
   - Remove the `if (col === 'user_id' && tableHasUserId)` branch
     in the values mapping

   After removal, `buildInsert` should simply validate all
   body keys against the schema and build INSERT with exactly
   the columns provided in the request body.

#### Add authzConditions handling

9. In `buildSelect`, `buildUpdate`, `buildDelete`, and
   `buildCount`, after `buildFilterConditions()`, append
   Cedar conditions:

   ```javascript
   if (authzConditions?.conditions?.length > 0) {
     for (const cond of authzConditions.conditions) {
       conditions.push(cond);
     }
     values.push(...authzConditions.values);
   }
   ```

   Note: `buildAuthzFilter` (Task 05) returns conditions
   with placeholder numbers already correct — the SQL builder
   does not renumber them. It trusts that the caller passed
   the right `startParam`.

### Changes to `src/rest/__tests__/sql-builder.test.mjs`

10. Update all function call signatures as described above
11. Remove tests that verify `appendUserId` behavior
12. Add new tests for `authzConditions` parameter:

    ```javascript
    it('buildSelect appends authzConditions to WHERE', () => {
      const parsed = {
        select: ['*'],
        filters: [{ column: 'status', operator: 'eq',
                     value: 'active', negate: false }],
        order: [], limit: null, offset: 0, onConflict: null,
      };
      const authz = {
        conditions: ['"user_id" = $2'],
        values: ['alice'],
      };
      const { text, values } = buildSelect(
        'todos', parsed, schema, authz
      );
      assert.ok(text.includes('"status"'));
      assert.ok(text.includes('"user_id" = $2'));
      assert.deepEqual(values, ['active', 'alice']);
    });
    ```

## Acceptance Criteria

- `appendUserId` function is deleted from `sql-builder.mjs`
- `userId` and `role` parameters are removed from all
  build functions
- `buildInsert` no longer force-injects `user_id`
- `authzConditions` parameter is accepted and appended by
  `buildSelect`, `buildUpdate`, `buildDelete`, `buildCount`
- All updated `sql-builder.test.mjs` tests pass
- Existing tests in other files may break (handler integration
  tests) — that is expected and fixed in Task 07

## Conflict Criteria

- If the function signatures in `sql-builder.mjs` have already
  been modified (e.g., by a prior partial attempt), read the
  current state and adjust accordingly.
- If `handler.integration.test.mjs` tests fail after this
  change, that is expected — Task 07 updates the handler to
  pass authzConditions. Do not modify handler.mjs in this task.
- If all target tests pass before changes, investigate.
