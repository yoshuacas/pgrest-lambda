# PostgREST-Compatible Data API Layer

## Overview

Replace the hardcoded CRUD handler in
`plugin/lambda-templates/crud-api.mjs` with a generic data
API layer that speaks the PostgREST wire protocol. Frontend
developers can use `@supabase/supabase-js` against a BOA
backend with zero code changes. The API dynamically discovers
tables from the database schema, builds parameterized SQL from
PostgREST query parameters, and enforces per-user data
isolation through application-level row filtering.

## Current CX / Concepts

The current Lambda handler (`plugin/lambda-templates/crud-api.mjs`,
149 lines) exports a single `handler` function that routes
four hardcoded endpoints:

- `GET /items` — list items for the authenticated user
- `POST /items` — create an item
- `PUT /items/{id}` — update an item
- `DELETE /items/{id}` — delete an item

Responses are wrapped objects (`{ items: [...] }`,
`{ item: {...} }`). Adding a new table requires manually
writing new route handlers and redeploying.

The handler extracts `userId` from
`event.requestContext.authorizer.claims.sub` and uses it
for row-level isolation. The connection pool uses
`DsqlSigner` from `@aws-sdk/dsql-signer` with a 10-minute
token refresh cycle.

`plugin/lambda-templates/index.mjs` re-exports the handler:
```javascript
export { handler } from "./crud-api.mjs";
```

The SAM template (`plugin/templates/backend.yaml`) routes
all paths via `/{proxy+}` to a single Lambda function. No
API Gateway changes are needed.

## Proposed CX / CX Specification

### Request Format

The API accepts the same HTTP requests that `@supabase/supabase-js`
sends. All data operations target `/rest/v1/{table}`.

```
# Select all rows
GET /rest/v1/todos?select=*

# Select specific columns with filters
GET /rest/v1/todos?select=id,title&status=eq.active&order=created_at.desc&limit=20&offset=0

# Insert a row (supabase-js wraps in array: [{"title":...}])
POST /rest/v1/todos
Content-Type: application/json
Prefer: return=representation
{"title": "Buy milk", "status": "active"}

# Insert multiple rows
POST /rest/v1/todos
Content-Type: application/json
Prefer: return=representation
[{"title": "Buy milk"}, {"title": "Walk dog"}]

# Upsert (requires on_conflict and Prefer header)
POST /rest/v1/todos?on_conflict=id
Content-Type: application/json
Prefer: resolution=merge-duplicates,return=representation
{"id": "abc", "title": "Updated title"}

# Update rows matching filters
PATCH /rest/v1/todos?id=eq.abc
Content-Type: application/json
Prefer: return=representation
{"title": "Updated title"}

# Delete rows matching filters
DELETE /rest/v1/todos?id=eq.abc
Prefer: return=representation
```

### Special Routes

```
# OpenAPI 3.0 spec (auto-generated from schema)
GET /rest/v1/

# Force schema cache refresh (after migrations)
POST /rest/v1/_refresh
```

### Filter Operators

| Operator | Meaning              | Example                     |
|----------|----------------------|-----------------------------|
| eq       | Equals               | `?id=eq.abc`                |
| neq      | Not equals           | `?status=neq.archived`      |
| gt       | Greater than         | `?age=gt.18`                |
| gte      | Greater or equal     | `?age=gte.18`               |
| lt       | Less than            | `?price=lt.100`             |
| lte      | Less or equal        | `?price=lte.100`            |
| like     | LIKE (% wildcards)   | `?name=like.*smith*`        |
| ilike    | ILIKE (case-insens.) | `?name=ilike.*smith*`       |
| in       | In list              | `?status=in.(active,done)`  |
| is       | IS (null/true/false/unknown) | `?deleted_at=is.null`  |

All operators support a `not.` prefix for negation:
```
?id=not.eq.abc          # WHERE "id" != $1
?status=not.in.(a,b)    # WHERE "status" NOT IN ($1, $2)
?deleted_at=not.is.null  # WHERE "deleted_at" IS NOT NULL
```

### Prefer Headers

| Header Value               | Effect                           |
|----------------------------|----------------------------------|
| `return=representation`    | Return affected rows in body     |
| `return=minimal`           | Return empty body (default)      |
| `count=exact`              | Add exact count to Content-Range (PostgREST also supports `count=planned` and `count=estimated`; BOA only supports `exact` in MVP) |
| `resolution=merge-duplicates` | Upsert mode for POST          |

### Ordering and Pagination

```
# Order by column (asc/desc, nullsfirst/nullslast)
?order=created_at.desc.nullslast

# Multiple order columns
?order=status.asc,created_at.desc

# Pagination
?limit=20&offset=40
```

### Response Format

**SELECT (200):** Bare JSON array (not wrapped in an object).
```json
[
  {"id": "abc", "title": "Buy milk", "status": "active"},
  {"id": "def", "title": "Walk dog", "status": "done"}
]
```

**INSERT (201):** With `Prefer: return=representation`, body
is an array of inserted rows. Without it, body is empty.

**UPDATE (200) / DELETE (200):** With
`Prefer: return=representation`, body is an array of affected
rows. Without it, status is 204 with no body.

**Single object mode:** When the request includes
`Accept: application/vnd.pgrst.object+json`, the response is
a single JSON object instead of an array. Returns 406 if the
result set contains zero rows or more than one row. This
supports supabase-js `.single()` calls. (supabase-js
`.maybeSingle()` uses `Accept: application/json` for GET
requests and handles empty results client-side.)

**Content-Range header:** Always present on SELECT responses.
- Without `Prefer: count=exact`: `0-19/*`
- With `Prefer: count=exact`: `0-19/157`
- Empty result: `*/*` or `*/0`

**CORS headers:** Present on all responses.
```
Access-Control-Allow-Origin: *
Access-Control-Allow-Headers: Content-Type,Authorization,Prefer,Accept,apikey,X-Client-Info
Access-Control-Allow-Methods: GET,POST,PATCH,DELETE,OPTIONS
Access-Control-Expose-Headers: Content-Range
```

**supabase-js headers:** The client sends `apikey` and
`X-Client-Info` headers on every request. BOA ignores these
(authentication is handled by the Cognito authorizer on API
Gateway), but they must be listed in `Allow-Headers` for
CORS preflight to succeed.

### Error Responses

All errors return a JSON object with four fields matching
PostgREST conventions:

```json
{
  "code": "PGRST205",
  "message": "Relation 'nonexistent' does not exist",
  "details": null,
  "hint": "Check the spelling of the table name."
}
```

| Scenario                      | HTTP | Code     | Message                                        |
|-------------------------------|------|----------|------------------------------------------------|
| Unknown table                 | 404  | PGRST205 | Relation '{table}' does not exist              |
| Unknown column in filter      | 400  | PGRST204 | Column '{col}' does not exist in '{table}'     |
| Unknown column in select      | 400  | PGRST204 | Column '{col}' does not exist in '{table}'     |
| Unknown column in order       | 400  | PGRST204 | Column '{col}' does not exist in '{table}'     |
| Unknown column in body        | 400  | PGRST204 | Column '{col}' does not exist in '{table}'     |
| Invalid filter syntax         | 400  | PGRST100 | Failed to parse filter: {detail}               |
| PATCH without filters         | 400  | PGRST106 | UPDATE requires filters to prevent bulk change |
| DELETE without filters        | 400  | PGRST106 | DELETE requires filters to prevent bulk change  |
| Unique constraint violation   | 409  | 23505    | (PostgreSQL error message)                     |
| Foreign key violation         | 409  | 23503    | (PostgreSQL error message)                     |
| Not-null violation            | 400  | 23502    | (PostgreSQL error message)                     |
| Single object > 1 row        | 406  | PGRST116 | Singular response expected but more rows found |
| Single object 0 rows         | 406  | PGRST116 | JSON object requested but 0 rows returned      |
| Invalid `is` value            | 400  | PGRST100 | Failed to parse filter: 'is' accepts null, true, false, unknown |
| Missing request body          | 400  | PGRST100 | Missing or invalid request body                |

**Note on PATCH/DELETE without filters:** Real PostgREST
allows unfiltered bulk PATCH and DELETE by default. BOA
intentionally rejects these with PGRST106 as a safety
measure to prevent accidental data loss. This is a deliberate
deviation from PostgREST behavior. supabase-js always sends
filters with `.update()` and `.delete()`, so this does not
affect normal usage.

### Row-Level Data Isolation

Tables that contain a `user_id` column automatically get
per-user filtering. The `user_id` value comes from
`event.requestContext.authorizer.claims.sub` (Cognito JWT).

- **SELECT:** `WHERE "user_id" = $N` is appended to all
  queries.
- **INSERT:** `user_id` is set to the authenticated user's ID,
  overriding any value in the request body.
- **UPDATE/DELETE:** `WHERE "user_id" = $N` is appended to
  the filter conditions.

Tables without a `user_id` column are accessible to all
authenticated users with no row filtering. This is
appropriate for reference/lookup tables.

### Schema Discovery

Tables and columns are discovered dynamically from
PostgreSQL system catalogs at runtime. No per-table
configuration is needed. After running a SQL migration to
add or alter tables, the agent calls
`POST /rest/v1/_refresh` and the new schema is immediately
available.

**DSQL compatibility note:** Aurora DSQL may not support
`information_schema` views. The implementation must use
`pg_catalog` tables (`pg_class`, `pg_attribute`,
`pg_namespace`, `pg_constraint`, `pg_type`) which are
confirmed supported by DSQL. See the schema-cache.mjs
technical design for the exact queries.

Schema discovery occurs:
1. On Lambda cold start (automatic).
2. When the cache TTL expires (default 5 minutes, configurable
   via `SCHEMA_CACHE_TTL_MS` environment variable).
3. On `POST /rest/v1/_refresh` (explicit).

### OpenAPI 3.0 Spec

`GET /rest/v1/` returns a dynamically generated OpenAPI 3.0.3
specification that describes all discovered tables, their
columns, available operations, and query parameters. Agents
use this to discover what tables exist and how to query them.

The spec includes:
- A path entry per table with GET, POST, PATCH, DELETE
- JSON Schema definitions per table (columns as properties)
- PostgreSQL-to-JSON-Schema type mapping
- Filter query parameter documentation
- Cognito Bearer JWT in securitySchemes
- PostgREST error schema

## Technical Design

### Module Structure

Nine new modules in `plugin/lambda-templates/postgrest/`:

```
postgrest/
  db.mjs            # Connection pool (extracted from crud-api.mjs)
  errors.mjs        # PostgREST error format and codes
  schema-cache.mjs  # pg_catalog introspection + TTL cache
  query-parser.mjs  # Parse PostgREST query params to structured objects
  sql-builder.mjs   # Convert parsed queries to parameterized SQL
  response.mjs      # Format responses with headers
  router.mjs        # Extract table name from path, validate
  openapi.mjs       # Generate OpenAPI 3.0 spec from schema cache
  handler.mjs       # Lambda entry point, wire everything together
```

### db.mjs

Extract the connection pool from `crud-api.mjs` lines 1-62
into a standalone module. Exports `getPool()`.

```javascript
// Preserved behavior from crud-api.mjs:
// - DsqlSigner with DSQL_ENDPOINT and REGION_NAME
// - getDbConnectAdminAuthToken() for IAM auth
// - pg.Pool with max: 5, ssl, 10-min token refresh
// - Module-scoped pool and tokenRefreshedAt for reuse
export async function getPool() { ... }
```

### errors.mjs

Defines the `PostgRESTError` class and a helper to map
PostgreSQL error codes:

```javascript
export class PostgRESTError extends Error {
  constructor(statusCode, code, message, details, hint) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details || null;
    this.hint = hint || null;
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      details: this.details,
      hint: this.hint,
    };
  }
}

// Maps PG error codes to HTTP status codes
export function mapPgError(pgError) { ... }
```

PostgreSQL error code mapping:

| PG Code | HTTP | PostgREST Behavior           |
|---------|------|------------------------------|
| 23505   | 409  | Unique constraint violation   |
| 23503   | 409  | Foreign key violation         |
| 23502   | 400  | Not-null violation            |
| 42P01   | 404  | Undefined table               |
| 42703   | 400  | Undefined column              |
| Other   | 500  | Internal server error         |

### schema-cache.mjs

Queries `pg_catalog` tables for table metadata. Uses
`pg_catalog` instead of `information_schema` for Aurora DSQL
compatibility (DSQL documents support for `pg_class`,
`pg_attribute`, `pg_namespace`, `pg_constraint`, `pg_type`,
`pg_index`, and `pg_attrdef` but does not document
`information_schema` support). Caches results in module
scope with configurable TTL.

```javascript
let cache = null;
let lastRefreshAt = 0;
const TTL = parseInt(process.env.SCHEMA_CACHE_TTL_MS || '300000');

// Returns { tables: { [tableName]: { columns, primaryKey } } }
export async function getSchema(pool) { ... }

// Forces immediate re-introspection
export async function refresh(pool) { ... }

// Validates table exists in cache
export function hasTable(schema, table) { ... }

// Validates column exists on table
export function hasColumn(schema, table, column) { ... }

// Returns primary key columns for a table
export function getPrimaryKey(schema, table) { ... }
```

Introspection queries use `pg_catalog` tables for the
`public` schema only:

```sql
-- Columns (pg_catalog equivalent of information_schema.columns)
SELECT c.relname AS table_name,
       a.attname AS column_name,
       pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type,
       NOT a.attnotnull AS is_nullable,
       pg_get_expr(d.adbin, d.adrelid) AS column_default
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid
LEFT JOIN pg_catalog.pg_attrdef d
  ON d.adrelid = a.attrelid AND d.adnum = a.attnum
WHERE n.nspname = 'public'
  AND c.relkind IN ('r', 'p')  -- regular and partitioned tables
  AND a.attnum > 0
  AND NOT a.attisdropped
ORDER BY c.relname, a.attnum;

-- Primary keys
SELECT c.relname AS table_name, a.attname AS column_name
FROM pg_catalog.pg_constraint con
JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
JOIN pg_catalog.pg_attribute a
  ON a.attrelid = con.conrelid AND a.attnum = ANY(con.conkey)
WHERE con.contype = 'p'
  AND n.nspname = 'public';
```

**Foreign keys are not introspected.** Aurora DSQL does not
support foreign key constraints in DDL (`REFERENCES` clause
is not available). The `foreignKeys` field is omitted from
the cache structure. Resource embedding (joins via foreign
keys) is deferred to a future design.

Cache structure:
```javascript
{
  tables: {
    'todos': {
      columns: {
        'id': { type: 'text', nullable: false, defaultValue: null },
        'user_id': { type: 'text', nullable: false, defaultValue: null },
        'title': { type: 'text', nullable: true, defaultValue: null },
        'created_at': { type: 'timestamptz', nullable: false,
                        defaultValue: 'now()' }
      },
      primaryKey: ['id']
    }
  }
}
```

### query-parser.mjs

Parses PostgREST query parameters into a structured object.
Exports `parseQuery(queryStringParameters, method)`.

```javascript
// Input: { select: 'id,title', status: 'eq.active', order: 'created_at.desc', limit: '20' }
// Output:
// {
//   select: ['id', 'title'],
//   filters: [{ column: 'status', operator: 'eq', value: 'active', negate: false }],
//   order: [{ column: 'created_at', direction: 'desc', nulls: null }],
//   limit: 20,
//   offset: 0,
//   onConflict: null
// }
export function parseQuery(params, method) { ... }
```

Reserved parameter names (not treated as filters):
`select`, `order`, `limit`, `offset`, `on_conflict`.

Filter parsing rules:
- Split value on first `.` to get operator.
- If operator is `not`, split again to get real operator
  and set `negate: true`.
- For `in` operator, strip parentheses and split on `,`.
- For `is` operator, validate value is one of: `null`,
  `true`, `false`, `unknown`. PostgREST also accepts
  `not_null` as shorthand for `not.is.null`. Throw
  `PGRST100` otherwise.
- For `like` and `ilike`, replace `*` with `%` in the
  value (PostgREST convention).

Order parsing rules:
- Split on `,` for multiple columns.
- Each entry: `column.direction.nulls` where direction
  is `asc` (default) or `desc`, and nulls is optional
  `nullsfirst` or `nullslast`.

### sql-builder.mjs

Converts parsed query + HTTP method + request body + userId
into parameterized SQL. Exports build functions per method.

```javascript
// All functions return { text: string, values: any[] }
export function buildSelect(table, parsed, schema, userId) { ... }
export function buildInsert(table, body, schema, userId, parsed) { ... }
export function buildUpdate(table, body, parsed, schema, userId) { ... }
export function buildDelete(table, parsed, schema, userId) { ... }
export function buildCount(table, parsed, schema, userId) { ... }
```

SQL injection prevention (two layers):
1. **Column whitelist:** Every column and table name
   referenced in a query is validated against the schema
   cache. Unknown names throw `PGRST204` / `PGRST205`.
2. **Parameterized queries:** All user-provided values
   become `$N` parameters. Column and table names are
   double-quoted identifiers (never interpolated from
   user input — only from the validated schema cache).

User ID injection:
- On tables with a `user_id` column, SELECT/UPDATE/DELETE
  append `AND "user_id" = $N` to the WHERE clause.
- On INSERT, the `user_id` field is forced to the
  authenticated user's ID, overriding the request body.
- On tables without `user_id`, no user filtering is applied.

Update/Delete safety:
- PATCH and DELETE require at least one filter parameter
  (beyond the implicit `user_id` filter). If no filters
  are present, throw `PGRST106`. (This is a BOA safety
  measure; real PostgREST allows unfiltered bulk operations.)

Upsert logic (POST with `on_conflict`):
- Generates `INSERT INTO ... ON CONFLICT ("col") DO UPDATE SET ...`
- The `on_conflict` value names the conflict column(s).
- Requires `Prefer: resolution=merge-duplicates`.

### router.mjs

Extracts the table name from the request path and identifies
special routes.

```javascript
// Returns { type: 'table', table: 'todos' }
//      or { type: 'openapi' }
//      or { type: 'refresh' }
//      or throws PGRST205 for unknown tables
export function route(path, schema) { ... }
```

Path parsing:
- Strip `/rest/v1/` prefix (also handle `/rest/v1` without
  trailing slash for OpenAPI).
- Empty remaining path or `/` → OpenAPI route.
- `_refresh` → refresh route.
- Otherwise → table name, validated against schema cache.

### response.mjs

Formats Lambda proxy integration responses with PostgREST
headers.

```javascript
export function success(statusCode, body, options) { ... }
export function error(err) { ... }
```

Options for `success`:
- `contentRange`: string for the Content-Range header.
- `singleObject`: boolean for
  `application/vnd.pgrst.object+json` handling.

CORS headers are included on every response including
errors and OPTIONS preflight.

### openapi.mjs

Generates an OpenAPI 3.0.3 spec from the schema cache.

```javascript
export function generateSpec(schema, apiUrl) { ... }
```

PostgreSQL-to-JSON-Schema type mapping:

| PG Type                       | JSON Schema             |
|-------------------------------|-------------------------|
| text, varchar, char           | `{ type: "string" }`    |
| integer, smallint             | `{ type: "integer" }`   |
| bigint                        | `{ type: "integer" }`   |
| boolean                       | `{ type: "boolean" }`   |
| numeric, real, double         | `{ type: "number" }`    |
| timestamptz, timestamp        | `{ type: "string", format: "date-time" }` |
| date                          | `{ type: "string", format: "date" }` |
| jsonb, json                   | `{ type: "object" }`    |
| uuid                          | `{ type: "string", format: "uuid" }` |
| Other                         | `{ type: "string" }`    |

### handler.mjs

Lambda entry point. Wires all modules together.

```javascript
export async function handler(event) {
  // 1. CORS preflight → 200
  // 2. Extract method, path, userId, headers, body, query params
  // 3. Get pool, get/refresh schema
  // 4. Route: openapi → return spec; refresh → refresh + return spec
  // 5. Parse query params
  // 6. Validate columns in filters, select, order, body
  // 7. Build SQL
  // 8. Execute query (+ parallel COUNT if Prefer: count=exact)
  // 9. Format response with Content-Range
  // 10. Handle single object mode
  // 11. Return formatted response
  // Catch: PostgRESTError → error response; PG error → mapped error
}
```

### index.mjs Change

```javascript
// Before:
export { handler } from "./crud-api.mjs";

// After:
export { handler } from "./postgrest/handler.mjs";
```

`crud-api.mjs` is kept in the repository as reference but
is no longer imported.

## Code Architecture / File Changes

| File | Action | Description |
|------|--------|-------------|
| `plugin/lambda-templates/postgrest/db.mjs` | Create | Connection pool extracted from crud-api.mjs |
| `plugin/lambda-templates/postgrest/errors.mjs` | Create | PostgRESTError class, PG error mapping |
| `plugin/lambda-templates/postgrest/schema-cache.mjs` | Create | pg_catalog introspection + TTL cache |
| `plugin/lambda-templates/postgrest/query-parser.mjs` | Create | Parse PostgREST filter/select/order/pagination params |
| `plugin/lambda-templates/postgrest/sql-builder.mjs` | Create | Parameterized SQL generation for all methods |
| `plugin/lambda-templates/postgrest/response.mjs` | Create | PostgREST-format responses with headers |
| `plugin/lambda-templates/postgrest/router.mjs` | Create | Path parsing, table validation, special routes |
| `plugin/lambda-templates/postgrest/openapi.mjs` | Create | OpenAPI 3.0.3 spec generator |
| `plugin/lambda-templates/postgrest/handler.mjs` | Create | Lambda entry point, orchestration |
| `plugin/lambda-templates/index.mjs` | Modify | Re-export from postgrest/handler.mjs |
| `plugin/lambda-templates/crud-api.mjs` | Keep | Retained as reference, no longer imported |
| `plugin/templates/backend.yaml` | Modify | Update CORS config: add PATCH to AllowMethods, add Prefer/Accept/apikey/X-Client-Info to AllowHeaders, add Content-Range to ExposeHeaders |
| `plugin/lambda-templates/package.json` | No change | No new dependencies |

## Testing Strategy

### Unit Tests

Each module gets unit tests that run without a database
connection (mocking `pg.Pool` where needed).

**query-parser tests:**
- Parse `?select=id,title` → `['id', 'title']`
- Parse `?select=*` → `['*']`
- Parse `?id=eq.abc` → filter with op `eq`, value `abc`
- Parse `?status=not.eq.archived` → negate: true
- Parse `?status=in.(active,done)` → in operator with array
- Parse `?deleted_at=is.null` → is operator with null
- Parse `?name=like.*smith*` → like with `%smith%`
- Parse `?order=created_at.desc.nullslast` → full order spec
- Parse `?order=a.asc,b.desc` → multiple order columns
- Parse `?limit=20&offset=10` → numeric limit/offset
- Ignore reserved params as filters
- Throw PGRST100 for `?col=is.invalid`
- Throw PGRST100 for malformed filter value (no operator)

**sql-builder tests:**
- SELECT with filters produces correct WHERE clause and $N params
- SELECT with select list produces correct column list
- SELECT with order produces ORDER BY clause
- SELECT with limit/offset produces LIMIT/OFFSET
- SELECT on table with user_id appends user_id filter
- SELECT on table without user_id has no user_id filter
- INSERT single row produces INSERT ... VALUES ... RETURNING *
- INSERT accepts both object and array body (supabase-js
  always sends an array, even for single rows)
- INSERT forces user_id to authenticated user
- INSERT bulk produces multiple VALUES tuples
- UPSERT produces ON CONFLICT ... DO UPDATE SET
- UPDATE produces UPDATE ... SET ... WHERE
- UPDATE rejects when no filters (PGRST106)
- DELETE produces DELETE ... WHERE
- DELETE rejects when no filters (PGRST106)
- All column/table names are double-quoted
- Unknown column throws PGRST204

  > Warning: tests asserting user_id injection should verify the
  > specific parameter position in the SQL, not just the result,
  > to ensure the user_id filter comes from the auth token path
  > rather than being passed through from the request body.

**schema-cache tests (with mocked pool):**
- Parses pg_catalog query rows into cache structure
- Respects TTL (returns cached data within TTL)
- refresh() forces re-query regardless of TTL
- hasTable/hasColumn return correct booleans
- getPrimaryKey returns correct columns

**router tests:**
- `/rest/v1/todos` → table route for `todos`
- `/rest/v1/` → openapi route
- `/rest/v1/_refresh` → refresh route
- `/rest/v1/nonexistent` → PGRST205 error
- Handles paths with and without trailing slashes

**response tests:**
- SELECT → 200 with bare JSON array
- INSERT with return=representation → 201 with array body
- INSERT without return=representation → 201 with empty body
- UPDATE with return=representation → 200 with array body
- UPDATE without return=representation → 204
- DELETE with return=representation → 200 with array body
- DELETE without return=representation → 204
- Content-Range header format with and without count
- Single object mode returns object, not array
- Single object with 0 rows → 406
- Single object with > 1 row → 406
- Error responses include code, message, details, hint
- CORS headers present on all responses

**errors tests:**
- PostgRESTError.toJSON() produces correct format
- mapPgError maps 23505 → 409
- mapPgError maps 23503 → 409
- mapPgError maps 23502 → 400
- mapPgError maps unknown → 500

**openapi tests (with mocked schema):**
- Produces valid OpenAPI 3.0.3 structure
- Includes a path per table
- Maps PG types to JSON Schema types correctly
- Includes security scheme for Bearer JWT

### Integration Tests

Integration tests run against a real or mocked Lambda event
and verify end-to-end request/response behavior through the
handler.

- GET /rest/v1/{table} returns bare JSON array
- POST /rest/v1/{table} with body returns 201
- PATCH /rest/v1/{table}?filters returns updated rows
- DELETE /rest/v1/{table}?filters returns deleted rows
- GET /rest/v1/ returns valid OpenAPI spec
- POST /rest/v1/_refresh returns updated spec
- Unknown table returns 404 with PGRST205 error
- Unknown column in filter returns 400 with PGRST204
- PATCH without filters returns 400 with PGRST106
- DELETE without filters returns 400 with PGRST106
- User A cannot see User B's rows (user_id isolation)
- OPTIONS returns CORS headers with 200
- Prefer: count=exact includes count in Content-Range
- Accept: application/vnd.pgrst.object+json returns object

  > Warning: integration tests for user_id isolation should
  > use two distinct user IDs in the test setup and verify
  > that rows inserted by one user are not returned by queries
  > from the other. If the test table lacks a user_id column,
  > this test would pass vacuously — ensure the test table
  > definition includes user_id.

## Implementation Order

### Phase 1: Foundation (db, errors, schema-cache)

1. Create `postgrest/db.mjs` — extract connection pool from
   `crud-api.mjs`. Verify it works by importing in a test.
2. Create `postgrest/errors.mjs` — PostgRESTError class and
   PG error code mapping.
3. Create `postgrest/schema-cache.mjs` — introspection queries,
   caching, refresh, validation helpers.

### Phase 2: Query Pipeline (parser, builder)

4. Create `postgrest/query-parser.mjs` — parse all PostgREST
   query parameter formats.
5. Create `postgrest/sql-builder.mjs` — generate parameterized
   SQL for SELECT, INSERT, UPDATE, DELETE, UPSERT, COUNT.

### Phase 3: Response and Routing

6. Create `postgrest/response.mjs` — format responses with
   status codes, Content-Range, CORS, single-object mode.
7. Create `postgrest/router.mjs` — path parsing and validation.

### Phase 4: OpenAPI and Handler

8. Create `postgrest/openapi.mjs` — generate OpenAPI 3.0.3
   spec from schema cache.
9. Create `postgrest/handler.mjs` — wire all modules, handle
   all routes and error cases.
10. Modify `plugin/lambda-templates/index.mjs` — re-export
    from `postgrest/handler.mjs`.

### Phase 5: Documentation

11. Update `plugin/skills/boa/SKILL.md` — document PostgREST
    compatibility and supabase-js usage.
12. Update `plugin/docs/` — add PostgREST query syntax
    reference for agents.

## Open Questions

1. **RPC support:** PostgREST supports `POST /rest/v1/rpc/{function}`
   for calling database functions. Should this be included in
   the MVP or deferred? The plan identifies the route but does
   not spec the behavior. **Recommendation:** Defer to a follow-up
   design. RPC requires additional security considerations around
   which functions are callable.

2. **Resource embedding:** PostgREST supports
   `?select=*,comments(*)` for joining related tables via
   foreign keys. This is used by supabase-js `.select('*, comments(*)')`.
   **Recommendation:** Defer. Aurora DSQL does not support
   foreign key constraints, so embedding would need to rely
   on a convention (e.g., `{table}_id` column naming) or
   explicit configuration rather than introspected FKs.

3. **Horizontal filtering on columns (column-level permissions):**
   Some PostgREST deployments restrict which columns are visible.
   **Recommendation:** Not needed for MVP. All columns on
   discovered tables are accessible to authenticated users.

4. **SAM template CORS update required:** The current SAM
   template (`backend.yaml` line 107) configures API Gateway
   CORS with `AllowMethods: GET,POST,PUT,DELETE,OPTIONS` and
   `AllowHeaders: Content-Type,Authorization`. PostgREST uses
   PATCH for updates, and supabase-js sends `Prefer`, `Accept`,
   `apikey`, and `X-Client-Info` headers. API Gateway handles
   CORS preflight (OPTIONS) before the request reaches Lambda,
   so the Lambda-level CORS headers alone are insufficient.
   The SAM template must be updated to add PATCH to methods and
   additional headers. This is a minimal, backwards-compatible
   change (adding allowed values, not removing any). The
   original requirement to avoid SAM changes cannot be met
   without breaking CORS for PATCH requests from browsers.

5. **Table name conflicts with reserved routes:** If a user creates
   a table named `_refresh`, it would conflict with the refresh
   endpoint. **Recommendation:** Reserve `_refresh` as a special
   name and return a clear error if a table with that name is
   queried, directing the user to rename the table.
