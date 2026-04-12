# Task 05: Parameterized SQL Builder

**Agent:** implementer
**Design:** docs/design/postgrest-compatible-api.md
**Depends on:** Task 02 (errors.mjs), Task 03 (schema-cache),
Task 04 (query-parser output structure)

## Objective

Create `postgrest/sql-builder.mjs` that converts parsed query
objects into parameterized SQL with column whitelisting and
user_id injection.

## Target Tests

All tests in `__tests__/sql-builder.test.mjs`:
- SELECT with filters, select list, order, limit/offset
- SELECT with `select=*` produces correct column list
- SELECT user_id injection on tables with user_id column
- SELECT no user_id filter on tables without user_id
- INSERT single row and array body
- INSERT forces user_id to authenticated user
- INSERT on table without user_id (no injection)
- INSERT with unknown column throws PGRST204
- UPSERT with ON CONFLICT
- UPDATE with filters and body
- UPDATE without filters throws PGRST106
- UPDATE user_id filter
- DELETE with filters
- DELETE without filters throws PGRST106
- DELETE user_id filter
- COUNT query
- Double-quoted identifiers throughout

## Implementation

Create `plugin/lambda-templates/postgrest/sql-builder.mjs`.

**Exports:**
```javascript
export function buildSelect(table, parsed, schema, userId)
export function buildInsert(table, body, schema, userId, parsed)
export function buildUpdate(table, body, parsed, schema, userId)
export function buildDelete(table, parsed, schema, userId)
export function buildCount(table, parsed, schema, userId)
```

All functions return `{ text: string, values: any[] }`.

**SQL injection prevention (two layers):**
1. Column/table whitelist: validate every referenced name
   against the schema cache. Use `hasColumn()` from
   schema-cache. Throw `PostgRESTError(400, 'PGRST204', ...)`
   for unknown columns.
2. Parameterized queries: all user values become `$N` params.
   Column and table names are double-quoted identifiers
   sourced from the validated schema cache (never from raw
   user input).

**User ID injection rules:**
- Check if table has a `user_id` column in schema.
- SELECT/UPDATE/DELETE: append `"user_id" = $N` to WHERE.
- INSERT: force `user_id` field to `userId`, overriding
  any value in the request body.
- Tables without `user_id`: no user filtering.

**Safety rules:**
- PATCH (buildUpdate) and DELETE (buildDelete): require at
  least one filter beyond the implicit user_id. If
  `parsed.filters` is empty, throw
  `PostgRESTError(400, 'PGRST106', ...)`.

**Upsert (buildInsert with onConflict):**
- When `parsed.onConflict` is set, generate
  `INSERT INTO ... ON CONFLICT ("col") DO UPDATE SET ...`
  for all non-PK, non-user_id columns.

**Body handling:**
- Accept both single object and array. Normalize to array.
- For INSERT, validate all body keys against schema columns.
- For UPDATE, validate body keys similarly.

Import `PostgRESTError` from `./errors.mjs` and
`hasColumn` from `./schema-cache.mjs`.

## Acceptance Criteria

- All sql-builder.test.mjs tests pass.
- Existing tests still pass.
- SQL output uses `$N` parameterized values (no string
  interpolation of user data).

## Conflict Criteria

- If all target tests already pass before any code changes
  are made, investigate whether the tests are true positives
  before marking the task complete.
- If the schema cache API differs from what Task 03
  implemented (e.g., different function signatures),
  adapt the sql-builder to match the actual API rather
  than escalating.
