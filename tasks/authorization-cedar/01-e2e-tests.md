# Task 01: End-to-End Tests for Cedar Authorization

**Agent:** implementer
**Design:** docs/design/authorization-cedar.md

## Objective

Write all test cases for the Cedar-based authorization feature.
Tests cover the residual-to-SQL translator, policy loading,
table-level authorization, row-level filtering, and full
request pipeline integration. All tests must compile and fail
with clear messages — no implementation code exists yet.

## Test Files

Create two test files:

- `src/rest/__tests__/cedar.test.mjs` — unit tests for
  `src/rest/cedar.mjs` (translator, policy loading, authorize,
  buildAuthzFilter)
- `src/rest/__tests__/cedar.integration.test.mjs` — integration
  tests for the full handler pipeline with Cedar authorization

## Test Cases

### Unit Tests: Residual-to-SQL Translation (`cedar.test.mjs`)

Import `translateExpr` from `../cedar.mjs`. Each test calls
`translateExpr(expr, values, tableName, schema)` with a
hand-crafted AST input and asserts the returned SQL string
and the mutated `values` array.

Use the same `schema` fixture as `sql-builder.test.mjs`:

```javascript
const schema = {
  tables: {
    todos: {
      columns: {
        id: { type: 'text', nullable: false, defaultValue: null },
        user_id: { type: 'text', nullable: false, defaultValue: null },
        title: { type: 'text', nullable: true, defaultValue: null },
        status: { type: 'text', nullable: true, defaultValue: null },
        level: { type: 'integer', nullable: true, defaultValue: null },
        team_id: { type: 'text', nullable: true, defaultValue: null },
        created_at: { type: 'timestamp with time zone', nullable: false, defaultValue: 'now()' },
      },
      primaryKey: ['id'],
    },
    categories: {
      columns: {
        id: { type: 'text', nullable: false, defaultValue: null },
        name: { type: 'text', nullable: false, defaultValue: null },
      },
      primaryKey: ['id'],
    },
    public_posts: {
      columns: {
        id: { type: 'text', nullable: false, defaultValue: null },
        title: { type: 'text', nullable: true, defaultValue: null },
        body: { type: 'text', nullable: true, defaultValue: null },
      },
      primaryKey: ['id'],
    },
  },
};
```

Note: the `todos` table adds `level` (integer) and `team_id`
(text) columns beyond the existing test fixture — these are
needed by Cedar policy test cases (e.g., `resource.level > 5`,
`resource.team_id == principal.team_id`).

#### describe('translateExpr')

1. **'equality comparison translates to "col" = $N'**
   - Input: `{ "==": { left: { ".": { left: { "Var": "resource" }, attr: "user_id" } }, right: { "Value": "alice" } } }`
   - startParam: 1, values: []
   - Expected SQL: `"user_id" = $1`
   - Expected values: `["alice"]`

2. **'inequality comparison translates to "col" != $N'**
   - Input: `{ "!=": { left: { ".": { left: { "Var": "resource" }, attr: "status" } }, right: { "Value": "archived" } } }`
   - startParam: 1, values: []
   - Expected SQL: `"status" != $1`
   - Expected values: `["archived"]`

3. **'greater-than comparison translates to "col" > $N'**
   - Input: `{ ">": { left: { ".": { left: { "Var": "resource" }, attr: "level" } }, right: { "Value": 5 } } }`
   - startParam: 1, values: []
   - Expected SQL: `"level" > $1`
   - Expected values: `[5]`

4. **'greater-or-equal translates to "col" >= $N'**
   - Input: `{ ">=": ... }` with attr "level", value 10
   - Expected SQL: `"level" >= $1`

5. **'less-than translates to "col" < $N'**
   - Input: `{ "<": ... }` with attr "level", value 3
   - Expected SQL: `"level" < $1`

6. **'less-or-equal translates to "col" <= $N'**
   - Input: `{ "<=": ... }` with attr "level", value 7
   - Expected SQL: `"level" <= $1`

7. **'AND conjunction translates to (left AND right)'**
   - Input: `{ "&&": { left: <eq user_id=alice>, right: <gt level>5> } }`
   - Expected SQL: `("user_id" = $1 AND "level" > $2)`
   - Expected values: `["alice", 5]`

8. **'OR disjunction translates to (left OR right)'**
   - Input: `{ "||": { left: <eq user_id=alice>, right: <eq status=active> } }`
   - Expected SQL: `("user_id" = $1 OR "status" = $2)`
   - Expected values: `["alice", "active"]`

9. **'NOT negation translates to NOT (expr)'**
   - Input: `{ "!": { arg: <eq status=archived> } }`
   - Expected SQL: `NOT ("status" = $1)`
   - Expected values: `["archived"]`

10. **'has-attribute translates to "col" IS NOT NULL'**
    - Input: `{ "has": { left: { "Var": "resource" }, attr: "user_id" } }`
    - Expected SQL: `"user_id" IS NOT NULL`
    - Expected values: `[]`

11. **'CPE noise collapse: true AND condition reduces to condition'**
    - Input: `{ "&&": { left: { "Value": true }, right: <eq user_id=alice> } }`
    - Expected SQL: `"user_id" = $1` (not `TRUE AND "user_id" = $1`)

12. **'CPE noise collapse: nested true chains reduce to condition'**
    - Input: `{ "&&": { left: { "Value": true }, right: { "&&": { left: { "Value": true }, right: <eq user_id=alice> } } } }`
    - Expected SQL: `"user_id" = $1`

13. **'CPE noise collapse: condition AND true reduces to condition'**
    - Input: `{ "&&": { left: <eq user_id=alice>, right: { "Value": true } } }`
    - Expected SQL: `"user_id" = $1`

14. **'CPE noise collapse: true OR X reduces to true'**
    - Input: `{ "||": { left: { "Value": true }, right: <eq user_id=alice> } }`
    - Expected: returns a truthy/unconditional result (no SQL)

15. **'entity UID value extraction: extracts id from __entity'**
    - Input: `{ "==": { left: { ".": { left: { "Var": "resource" }, attr: "user_id" } }, right: { "Value": { "__entity": { "type": "PgrestLambda::User", "id": "abc-123" } } } } }`
    - Expected SQL: `"user_id" = $1`
    - Expected values: `["abc-123"]`

16. **'type check (is Row) collapses to true'**
    - Input: `{ "is": { left: { "Var": "resource" }, entity_type: "PgrestLambda::Row" } }`
    - Expected: collapsed to true (no SQL fragment emitted)

17. **'type check (non-Row) collapses to false'**
    - Input: `{ "is": { left: { "Var": "resource" }, entity_type: "PgrestLambda::Table" } }`
    - Expected: evaluates to false

18. **'unknown marker treated as resource for attribute access'**
    - Input: `{ ".": { left: { "unknown": [{ "Value": "resource" }] }, attr: "user_id" } }` used in an equality expr
    - Expected: same behavior as `{ ".": { left: { "Var": "resource" }, attr: "user_id" } }`

19. **'untranslatable expression (in) throws PGRST000'**
    - Input: `{ "in": { left: { "Var": "resource" }, right: { "Value": { "__entity": { "type": "PgrestLambda::Table", "id": "todos" } } } } }`
    - Expected: throws with code PGRST000 and message containing "untranslatable"

20. **'untranslatable expression (contains) throws PGRST000'**
    - Input: `{ "contains": { left: ..., right: ... } }`
    - Expected: throws with code PGRST000

21. **'untranslatable expression (like) throws PGRST000'**
    - Input: `{ "like": { left: ..., right: ... } }`
    - Expected: throws with code PGRST000

22. **'parameter numbering respects startParam'**
    - Input: any equality expr with startParam=5
    - Expected: placeholder is `$5`, not `$1`

23. **'if-then-else translates to CASE WHEN'**
    - Input: `{ "if-then-else": { if: <eq status=active>, then: { "Value": true }, else: { "Value": false } } }`
    - Expected SQL: `CASE WHEN ("status" = $N) THEN TRUE ELSE FALSE END`

24. **'Value false translates to FALSE'**
    - Input: `{ "Value": false }`
    - Expected SQL: `FALSE`

### Unit Tests: Cedar Schema Generation (`cedar.test.mjs`)

Import `generateCedarSchema` from `../cedar.mjs`.

#### describe('generateCedarSchema')

25. **'maps text/varchar/uuid PG types to Cedar String'**
    - Input: schema with columns of type text, varchar, uuid
    - Expected: Cedar schema attributes are all `String`

26. **'maps integer/smallint/bigint PG types to Cedar Long'**
    - Input: schema with columns of type integer, smallint,
      bigint
    - Expected: Cedar schema attributes are all `Long`

27. **'maps boolean PG type to Cedar Boolean'**
    - Input: schema with boolean column
    - Expected: Cedar schema attribute is `Boolean`

28. **'defaults unknown PG types to Cedar String'**
    - Input: schema with column of type `timestamp with time zone`
    - Expected: Cedar schema attribute is `String`

29. **'union of all table columns in Row entity'**
    - Input: schema with two tables having different columns
    - Expected: Row entity attrs contain the union of all
      column names across both tables

### Unit Tests: Policy Loading (`cedar.test.mjs`)

#### describe('policy loading')

30. **'loadPolicies loads .cedar files from filesystem'**
    - Given: `POLICIES_PATH` env var points to a temp dir with
      a valid `default.cedar` file
    - When: `loadPolicies()` called
    - Then: resolves without error

31. **'loadPolicies with no .cedar files denies all (fail closed)'**
    - Given: `POLICIES_PATH` points to empty temp dir
    - When: `loadPolicies()` called, then `authorize()` called
    - Then: authorize throws PGRST403 (deny all)

32. **'loadPolicies with syntax error denies all (fail closed)'**
    - Given: temp dir with `bad.cedar` containing invalid syntax
    - When: `loadPolicies()` called, then `authorize()` called
    - Then: authorize throws (error logged, deny all)

33. **'policy caching returns cached within TTL'**
    - Given: policies loaded
    - When: `loadPolicies()` called again immediately
    - Then: returns without re-reading filesystem (mock fs to
      verify no second read)

34. **'refreshPolicies bypasses TTL cache'**
    - Given: policies loaded 1 second ago
    - When: `refreshPolicies()` called
    - Then: policies reloaded from source

35. **'_setPolicies replaces compiled policies'**
    - Given: default policies loaded
    - When: `_setPolicies(customPolicies)` called
    - Then: subsequent `authorize()` uses custom policies

### Unit Tests: authorize() — Table-Level (`cedar.test.mjs`)

#### describe('authorize (table-level)')

36. **'service_role allowed on any table and action'**
    - Given: default policies, principal = service_role
    - When: `authorize({ principal, action: 'select', resource: 'todos', schema })`
    - Then: returns true (no throw)

37. **'authenticated user allowed to insert'**
    - Given: default policies, principal = authenticated user
    - When: `authorize({ principal, action: 'insert', resource: 'todos', schema })`
    - Then: returns true

38. **'anon user denied by default policies'**
    - Given: default policies only, principal = anon
    - When: `authorize({ principal, action: 'select', resource: 'todos', schema })`
    - Then: throws PGRST403 with message containing
      "Not authorized to select on 'todos'"

39. **'custom policy allows anon select on specific table'**
    - Given: default + public_posts policy (permits anon select
      when `context.table == "public_posts"`), principal = anon
    - When: `authorize()` for select on public_posts
    - Then: returns true

### Unit Tests: buildAuthzFilter() — Row-Level (`cedar.test.mjs`)

#### describe('buildAuthzFilter (row-level)')

40. **'default policy for authenticated user produces user_id filter'**
    - Given: default policies, user "alice"
    - When: `buildAuthzFilter({ principal, action: 'select', context: { table: 'todos' }, schema, startParam: 1 })`
    - Then: conditions include a `"user_id" = $N` fragment
      with value "alice", plus `"user_id" IS NOT NULL`

    > Warning: The exact residual shape depends on Cedar CPE.
    > The implementing agent should run actual Cedar partial
    > evaluation and adjust expected SQL to match the actual
    > residual AST rather than assuming a specific structure.

41. **'service_role produces no conditions (unconditional access)'**
    - Given: default policies, service_role principal
    - When: `buildAuthzFilter()` for select
    - Then: `{ conditions: [], values: [] }`

42. **'forbid policy produces NOT condition'**
    - Given: default + forbid-delete-archived policy
      (`forbid ... action == "delete" ... when { resource has status && resource.status == "archived" }`)
    - When: `buildAuthzFilter()` for delete as authenticated user
    - Then: conditions include `NOT ("status" = $N)` with
      value "archived"

    > Warning: This test assumes Cedar produces separate
    > permit/forbid residuals. The implementing agent should
    > verify against actual Cedar output.

43. **'multiple permit policies combine with OR'**
    - Given: owner-access policy (`resource.user_id == principal`)
      + team-access policy (`resource.team_id == principal.team_id`)
    - When: `buildAuthzFilter()` for select as user with team_id
    - Then: conditions combined with OR:
      `("user_id" = $N OR "team_id" = $M)`

    > Warning: Cedar may merge permit residuals. If so, the
    > SQL structure may differ. Verify against actual Cedar
    > output.

44. **'concrete deny throws PGRST403'**
    - Given: policies that deny anon access
    - When: `buildAuthzFilter()` for anon on table with no
      matching permit
    - Then: throws PGRST403

45. **'startParam offsets parameter numbering correctly'**
    - Given: default policies, authenticated user
    - When: `buildAuthzFilter()` with startParam=5
    - Then: placeholder numbers start at $5

### Integration Tests: Full Request Pipeline (`cedar.integration.test.mjs`)

These tests use the same mock pool pattern as
`handler.integration.test.mjs`. They mock the database and
test the full handler → Cedar → sql-builder pipeline.

The mock pool must also be extended to include `public_posts`
and `categories` tables in the schema introspection results.

Use `_setPolicies()` to inject test policies without touching
the filesystem where appropriate.

#### describe('Cedar integration — authenticated GET')

46. **'GET /rest/v1/todos returns only owned rows (backward compat)'**
    - Setup: default Cedar policies loaded, table "todos"
      with user_id column
    - Given: authenticated user "alice"
    - When: GET /rest/v1/todos
    - Then: captured SQL includes a WHERE clause filtering
      on user_id with value "alice"

    > Warning: The exact SQL may differ from old appendUserId
    > (Cedar adds IS NOT NULL for the `has` check). Verify the
    > query returns equivalent filtering, not character-identical SQL.

47. **'service_role GET returns all rows (no authz WHERE)'**
    - Given: service_role principal
    - When: GET /rest/v1/todos
    - Then: captured SQL has no authorization WHERE clause

48. **'anon GET denied by default policies returns 403 PGRST403'**
    - Given: anon principal, only default policies
    - When: GET /rest/v1/todos
    - Then: response status 403, body.code === 'PGRST403'

#### describe('Cedar integration — INSERT')

49. **'authenticated INSERT allowed without user_id injection'**
    - Given: authenticated user, default policies
    - When: POST /rest/v1/todos with body `{"title": "test"}`
    - Then: captured INSERT SQL includes only columns from
      request body (no forced user_id column)

#### describe('Cedar integration — DELETE with forbid')

50. **'DELETE with forbid-archived policy includes NOT condition'**
    - Setup: default + forbid-delete-archived policy
    - Given: authenticated user
    - When: DELETE /rest/v1/todos?id=eq.123
    - Then: captured SQL includes `NOT` clause for status
      alongside user_id filter

#### describe('Cedar integration — custom public table')

51. **'anon GET on public_posts with custom policy returns 200'**
    - Setup: policy granting anon select on "public_posts"
    - Given: anon principal
    - When: GET /rest/v1/public_posts
    - Then: response status 200, no authorization filter in SQL

#### describe('Cedar integration — default deny')

52. **'authenticated GET on table with no matching policy returns 403'**
    - Setup: default policies only, table "categories" exists
      (no user_id column, no policy granting access)
    - Given: authenticated user
    - When: GET /rest/v1/categories
    - Then: response status 403

    > Warning: This is a breaking change from old behavior
    > where tables without user_id were open to authenticated
    > users. The default Cedar policies only permit access to
    > rows with `resource has user_id && resource.user_id ==
    > principal`. Tables without user_id have no matching policy.

#### describe('Cedar integration — policy refresh')

53. **'POST /rest/v1/_refresh reloads Cedar policies'**
    - Setup: initial policies loaded
    - Given: policies updated via `_setPolicies()` after
      initial load
    - When: POST /rest/v1/_refresh
    - Then: subsequent requests use the updated policy behavior

#### describe('Cedar integration — combined filters')

54. **'PostgREST filters combined with Cedar conditions have correct param numbering'**
    - Given: authenticated user, table with user_id
    - When: GET /rest/v1/todos?status=eq.active
    - Then: captured SQL WHERE includes both `"status" = $1`
      (PostgREST filter) AND Cedar conditions with correctly
      numbered params (e.g., $2, $3)

    > Warning: Parameter numbering is critical. PostgREST
    > filters use $1, $2, etc. Cedar conditions must continue
    > from the next available number.

#### describe('Cedar integration — backward compatibility')

55. **'same result set as old appendUserId for owned rows'**
    - Setup: table "todos" with user_id column, rows for
      user A and user B in mock
    - Given: user A with default Cedar policies
    - When: GET /rest/v1/todos
    - Then: captured SQL filters on user_id = user A's ID

56. **'service_role still sees all rows'**
    - Given: service_role
    - When: GET /rest/v1/todos
    - Then: no user_id filter in captured SQL

## Notes

- Use `node:test` (`describe`, `it`) and `node:assert/strict`
  matching the existing test conventions in the project.
- The integration test file should follow the pattern in
  `handler.integration.test.mjs`: use `_setPool()` for mock
  pools, `_resetCache()` for schema cache, and `makeEvent()`
  helper for Lambda events.
- For unit tests that need actual Cedar WASM evaluation (policy
  loading, authorize, buildAuthzFilter), `@cedar-policy/cedar-wasm`
  must be installed first (Task 02).
- For pure translator unit tests, no external dependency is
  needed — `translateExpr` is a pure function over AST objects.
- Tests that use `_setPolicies()` depend on Task 03 exporting
  that function.

## Acceptance Criteria

- All test files compile without syntax errors
- All tests fail with clear, descriptive messages
- Test names match the names listed above (subsequent tasks
  reference them by name)
- No implementation code is written in this task

## Conflict Criteria

- If any test that is expected to fail instead passes, first
  diagnose why by following the "Unexpected test results" steps
  in the implementer prompt: investigate the code path, verify
  the assertion targets the right behavior, and attempt to
  rewrite the test to isolate the intended path. Only escalate
  if you cannot construct a well-formed test that targets the
  desired behavior.
- If `src/rest/cedar.mjs` already exists, escalate — this task
  assumes it does not.
