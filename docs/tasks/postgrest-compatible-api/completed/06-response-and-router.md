# Task 06: Response Formatter and Router

**Agent:** implementer
**Design:** docs/design/postgrest-compatible-api.md
**Depends on:** Task 02 (errors.mjs), Task 03 (schema-cache
for hasTable)

## Objective

Create `postgrest/response.mjs` (PostgREST-format responses
with CORS, Content-Range, single-object mode) and
`postgrest/router.mjs` (path parsing and table validation).

## Target Tests

From `__tests__/response.test.mjs`:
- SELECT -> 200 with bare JSON array
- INSERT with return=representation -> 201 with array body
- INSERT without representation -> 201 with empty body
- UPDATE with representation -> 200 with array body
- UPDATE without representation -> 204
- DELETE with representation -> 200 with array body
- DELETE without representation -> 204
- Content-Range header format (with/without count, empty)
- Single object mode with 1 row returns object
- Single object mode with 0 rows -> 406 PGRST116
- Single object mode with >1 rows -> 406 PGRST116
- Error responses include code, message, details, hint
- CORS headers on all responses

From `__tests__/router.test.mjs`:
- `/rest/v1/todos` -> table route
- `/rest/v1/` -> openapi route
- `/rest/v1` (no slash) -> openapi route
- `/rest/v1/_refresh` -> refresh route
- `/rest/v1/nonexistent` -> PGRST205 error
- `/rest/v1/_refresh` with GET -> refresh route (reserved
  route takes precedence over any table named `_refresh`)

## Implementation

### postgrest/response.mjs

Create `plugin/lambda-templates/postgrest/response.mjs`.

**CORS headers constant:**
```javascript
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'Content-Type,Authorization,Prefer,Accept,apikey,X-Client-Info',
  'Access-Control-Allow-Methods':
    'GET,POST,PATCH,DELETE,OPTIONS',
  'Access-Control-Expose-Headers': 'Content-Range'
};
```

**Exports:**

`success(statusCode, body, options)`:
- `options.contentRange` — string for Content-Range header.
- `options.singleObject` — boolean; if true, unwrap array
  to single object. Throw PGRST116 if 0 or >1 rows.
- Returns Lambda proxy response object with `statusCode`,
  `headers` (CORS + Content-Type + Content-Range),
  `body` (JSON stringified).
- If body is null/undefined (no representation), return
  the given statusCode with empty body string.

`error(err)`:
- If `err` is a `PostgRESTError`, use its statusCode and
  toJSON().
- Otherwise, return 500 with generic error.
- Always include CORS headers.

### postgrest/router.mjs

Create `plugin/lambda-templates/postgrest/router.mjs`.

**Export:**
```javascript
export function route(path, schema) { ... }
```

**Logic:**
1. Strip `/rest/v1` prefix from path.
2. Remaining is empty or `/` -> return `{ type: 'openapi' }`.
3. Remaining is `/_refresh` -> return `{ type: 'refresh' }`.
4. Otherwise, extract table name (strip leading `/`).
5. Validate table exists in schema using `hasTable()`.
6. If not found, throw `PostgRESTError(404, 'PGRST205',
   "Relation '{table}' does not exist", null,
   "Check the spelling of the table name.")`.
7. Return `{ type: 'table', table: tableName }`.

Import `PostgRESTError` from `./errors.mjs` and `hasTable`
from `./schema-cache.mjs`.

## Acceptance Criteria

- All response.test.mjs tests pass.
- All router.test.mjs tests pass.
- Existing tests still pass.

## Conflict Criteria

- If all target tests already pass before any code changes
  are made, investigate whether the tests are true positives
  before marking the task complete.
