# RPC Endpoint

## Overview

Add a `/rest/v1/rpc/:function_name` endpoint that calls
PostgreSQL stored functions, matching PostgREST's RPC
surface. This unblocks every supabase-js `.rpc()` call,
which today returns 404. For applications with server-side
business logic in stored functions, this is the largest
single compatibility gap.

The implementation touches seven existing files
(router, schema-cache, sql-builder, handler, cedar,
errors, openapi) and adds new error codes PGRST202,
PGRST203, PGRST207, PGRST208, and PGRST209. It
reads the `supportsRpc` capability flag from the
db-capabilities interface — the first feature to
gate on a capability.

RETURNS TABLE functions — the idiomatic Supabase
pattern for set-returning functions — are fully
supported. The schema cache captures their return
columns, enabling column validation on filters,
select, and order applied to function results. The
filter-building code path is unified with table
reads via a pluggable `columnValidator`, avoiding
a parallel implementation that would drift.

## Current CX / Concepts

### supabase-js .rpc() Returns 404

`supabase.rpc('my_function', { user_id: 'abc' })`
generates `POST /rest/v1/rpc/my_function` with a JSON
body. The router in `src/rest/router.mjs` strips the
`/rest/v1` prefix and tries to match the remainder
(`/rpc/my_function`) as a table name. No table named
`rpc` exists, so the router throws PGRST205:

```json
{
  "code": "PGRST205",
  "message": "Relation 'rpc' does not exist",
  "details": null,
  "hint": "Check the spelling of the table name."
}
```

HTTP 404. The client has no way to call stored
functions.

### Schema Cache Has No Function Data

`src/rest/schema-cache.mjs` queries `pg_catalog` for
tables (`pg_class`, `pg_attribute`), primary keys
(`pg_constraint` with `contype = 'p'`), and foreign
keys (`pg_constraint` with `contype = 'f'`). It does
not query `pg_proc` for functions. The cache shape:

```javascript
{
  tables: {
    [tableName]: {
      columns: { [col]: { type, nullable, defaultValue } },
      primaryKey: string[],
    },
  },
  relationships: [...],
}
```

No `.functions` key exists. There is no `hasFunction()`
or `getFunction()` helper.

### SQL Builder Has No Function Call Support

`src/rest/sql-builder.mjs` exports `buildSelect`,
`buildInsert`, `buildUpdate`, `buildDelete`, and
`buildCount`. All operate on table names. There is no
`buildRpcCall` function and no named-parameter syntax
(`"arg" := $1`).

### Cedar Only Authorizes Tables

`src/rest/cedar.mjs` constructs resource UIDs with
type `PgrestLambda::Table`:

```javascript
{ type: 'PgrestLambda::Table', id: tableName }
```

The `authorize()` method checks table-level access.
The `buildAuthzFilter()` method builds row-level WHERE
conditions. Neither knows about functions. There is no
`PgrestLambda::Function` entity type and no `call`
action in the Cedar entity model.

### supportsRpc Capability Exists but Is Unread

`src/rest/db/interface.mjs` declares `supportsRpc` in
the `DatabaseCapabilities` typedef. Both providers set
it to `true` (`postgres.mjs` for full PL/pgSQL support,
`dsql.mjs` for SQL-language functions only). The
db-capabilities loop added this flag for the RPC
feature to consume. Nothing reads it today.

### Handler Dispatches on Route Type

`src/rest/handler.mjs` checks `routeInfo.type` after
calling `route()`. The switch handles `openapi`, `docs`,
`refresh`, and `table`. There is no `rpc` branch.

## Proposed CX / CX Specification

### Route Matching

`/rest/v1/rpc/:function_name` is matched before table
lookup. The router returns:

```javascript
{ type: 'rpc', functionName: 'my_function' }
```

The function name is validated as a PostgreSQL
identifier: `/^[A-Za-z_][A-Za-z0-9_]*$/`. Invalid
names receive PGRST100:

```json
{
  "code": "PGRST100",
  "message": "'my-func!' is not a valid function name",
  "details": null,
  "hint": "Function names must match [A-Za-z_][A-Za-z0-9_]*."
}
```

The router validates name format only. It does not
check whether the function exists in the schema
cache — that happens in the handler after the
capability gate, so that `supportsRpc=false` returns
PGRST501 before PGRST202.

### HTTP Methods

| Method  | Arguments source | Filters on result | Response        |
|---------|-----------------|-------------------|-----------------|
| POST    | JSON body       | Query params      | Function result |
| GET     | Query params    | Query params†     | Function result |
| HEAD    | Same as GET     | Same as GET       | Headers only    |
| OPTIONS | —               | —                 | CORS preflight  |

† For GET, non-reserved query params are disambiguated
by value syntax: raw values (`?a=5`) are function
args, operator-prefixed values (`?status=eq.active`)
are filters. See GET section below.

Other methods return 405 (PGRST101).

### POST: Arguments from JSON Body

The request body is a JSON object where each key maps
to a named function argument:

```
POST /rest/v1/rpc/calculate_total
Content-Type: application/json

{"order_id": "ord-1", "include_tax": true}
```

JSON types map directly to PostgreSQL types via the
database driver. No JavaScript-side coercion needed.

Query parameters on POST requests are parsed as
standard PostgREST controls: `select`, `order`,
`limit`, `offset` shape the result set. Remaining
query parameters are treated as filters on the
function's result (meaningful only for set-returning
functions).

### GET: Arguments from Query Params

```
GET /rest/v1/rpc/calculate_total?order_id=ord-1&include_tax=true
```

Query parameters are disambiguated by **value syntax**,
not by matching against the function's argument names.
This matches PostgREST's behavior and keeps parameter
classification independent of the schema cache:

1. Reserved params (`select`, `order`, `limit`,
   `offset`, `on_conflict`, `columns`) are parsed
   as PostgREST controls.
2. Remaining params whose value contains an operator
   prefix (e.g., `eq.`, `gt.`, `in.`, `is.`, `like.`,
   `not.`) are treated as filters on the result set.
   The pattern is: if the value matches
   `/^(not\.)?[a-z]+\./` it is a filter.
3. Remaining params (raw values without operator
   prefix) are treated as function arguments.

Examples:
- `?order_id=ord-1` → function arg (raw value)
- `?include_tax=true` → function arg (raw value)
- `?status=eq.active` → filter (operator prefix)
- `?age=gt.18` → filter (operator prefix)
- `?name=not.eq.admin` → filter (negated operator)

This means a param like `?status=active` is always
treated as a function argument, even if the function
does not have a `status` parameter. If the function
lacks that parameter, PGRST207 (unknown argument) is
raised. To filter on result columns via GET, use the
operator syntax: `?status=eq.active`.

All GET argument values are strings. They are passed
as untyped bind parameters (`$N` with type OID 0).
PostgreSQL resolves the target type from the function
signature and performs implicit coercion. If coercion
fails (e.g., `"abc"` for an integer argument),
PostgreSQL returns a type error which is mapped to
HTTP 400 via `mapPgError`.

For common types, JavaScript-side validation before
the database call provides clearer error messages:

| PG type                    | JS validation              |
|----------------------------|----------------------------|
| `int4`, `int2`, `int8`    | `parseInt`, reject NaN     |
| `bool`                     | reject if not `true`/`false` |
| `json`, `jsonb`            | `JSON.parse`, reject error |
| All others                 | Pass as string             |

JavaScript-side validation is a UX optimization, not
a correctness requirement. The database is always the
final authority on type compatibility. Validation
failures produce PGRST208. Skipped validations fall
through to PG errors mapped via `mapPgError`.

### HEAD: Existence Check

HEAD requests follow the GET argument-parsing rules
but add `LIMIT 0` to the generated SQL for
set-returning functions, preventing result computation.
For scalar and void functions, the function is still
executed (the database must run it to complete the
call) but the response body is omitted.

Response includes all standard headers (Content-Type,
CORS) but no body.

### Response Format

#### Set-Returning Functions (proretset = true)

Returns a JSON array of row objects:

```json
[
  {"id": 1, "name": "Alice", "total": 150.00},
  {"id": 2, "name": "Bob", "total": 200.00}
]
```

`Accept: application/vnd.pgrst.object+json` returns
a single object (PGRST116 if 0 or >1 rows).

#### Scalar Functions (proretset = false, base type)

Returns the bare JSON value, not wrapped in an array
or object:

```
HTTP/1.1 200 OK
Content-Type: application/json

42
```

```
HTTP/1.1 200 OK
Content-Type: application/json

"hello world"
```

The scalar value is extracted from the single-column,
single-row result. The column is aliased to the
function name in the SQL:
`SELECT "fn"(args) AS "fn"`.

#### Composite Functions (proretset = false, composite)

Returns a single JSON object:

```json
{"id": 1, "name": "Alice", "total": 150.00}
```

Generated via `SELECT * FROM "fn"(args)` which
returns one row with named columns.

#### Void Functions (return type = void)

Returns HTTP 200 with an empty body. This matches
PostgREST's behavior — void functions return 200,
not 204, because 204 implies "no content by design"
while a void function is a deliberate choice by the
function author. supabase-js expects 200 and
interprets 204 as a non-error empty result.

### Filter/Order/Limit on Results

For set-returning functions, standard PostgREST query
parameters work on the result set:

```
POST /rest/v1/rpc/get_orders?status=eq.active&order=total.desc&limit=10
Body: {"user_id": "u-1"}
```

Generates:

```sql
SELECT *
  FROM "get_orders"("user_id" := $1)
 WHERE "status" = $2
 ORDER BY "total" DESC
 LIMIT $3
```

Values: `['u-1', 'active', 10]`

For scalar, composite, and void functions, filter,
order, limit, and offset parameters are silently
ignored (matches PostgREST behavior).

### Select on Results

For set-returning functions, `?select=id,name` limits
the returned columns:

```sql
SELECT "id", "name"
  FROM "get_orders"("user_id" := $1)
```

Column aliases work: `?select=total:amount` emits
`SELECT "amount" AS "total" FROM "fn"(...)`.

Column names in the select list are validated
against the function's `returnColumns` when the
function uses RETURNS TABLE. For functions without
known return columns (e.g., RETURNS SETOF record),
column names are validated as PostgreSQL identifiers
(`/^[A-Za-z_][A-Za-z0-9_]*$/`) and PostgreSQL
validates existence at query time.

For scalar, composite, and void functions, the
`select` parameter is silently ignored.

### supabase-js Compatibility

```javascript
// Scalar function
const { data } = await supabase.rpc('add_numbers', {
  a: 3, b: 4,
});
// data === 7

// Set-returning function with filters
const { data } = await supabase
  .rpc('get_active_orders', { store_id: 's-1' })
  .eq('status', 'pending')
  .order('created_at', { ascending: false })
  .limit(20);
// data === [{id, status, created_at, ...}, ...]

// Zero-argument function
const { data } = await supabase.rpc(
  'current_settings');
// data === [{key, value}, ...]

// GET-safe call
const { data } = await supabase.rpc(
  'get_count', { table_name: 'orders' },
  { get: true });
// data === 42
```

### Error Codes and Messages

| Scenario | HTTP | Code | Message |
|----------|------|------|---------|
| Invalid function name | 400 | PGRST100 | `'{name}' is not a valid function name` |
| Unsupported method | 405 | PGRST101 | `Only GET, POST, and HEAD are allowed for RPC` |
| Function not found | 404 | PGRST202 | `Could not find the function '{fn}' in the schema cache` |
| Overloaded function | 300 | PGRST203 | `Could not choose the best candidate function between: {fn}(a integer), {fn}(a text)` |
| Unknown argument | 400 | PGRST207 | `Function '{fn}' does not have an argument named '{x}'` |
| Type coercion fail | 400 | PGRST208 | `Argument '{x}' of function '{fn}' expects type '{type}' but received a value that could not be coerced` |
| Missing required arg | 400 | PGRST209 | `Function '{fn}' requires argument '{x}' which was not provided` |
| Cedar forbid | 403 | PGRST403 | `Permission denied for function '{fn}'` |
| RPC not supported | 501 | PGRST501 | `RPC is not supported on this database` |

Notes:
- PGRST202 and PGRST203 match PostgREST's codes and
  semantics: 202 = function not found, 203 = ambiguous
  overloaded function.
- PGRST207, PGRST208, and PGRST209 are
  pgrest-lambda-specific codes. PostgREST does not
  validate extra arguments or do JS-side type coercion;
  it passes everything to PostgreSQL and relies on PG
  errors. Our additional client-side validation
  provides clearer error messages at the cost of
  non-standard codes. These codes are in the 20x range
  and do not conflict with any current PostgREST codes
  (PostgREST uses 200-205 as of v12).
- PGRST101 matches PostgREST's "unsupported HTTP verb"
  code.
- PGRST403 already exists for Cedar denials on tables;
  the same code applies to functions.

### Validation Rules

1. **Function name format.** Must match
   `[A-Za-z_][A-Za-z0-9_]*`. Validated in the router
   before any database access. Always double-quoted
   in generated SQL.

2. **Capability gate.** If
   `ctx.dbCapabilities.supportsRpc` is `false`,
   return PGRST501 immediately. Checked before
   function lookup.

3. **Function exists in cache.** Looked up in
   `schema.functions[fnName]`. If missing → PGRST202.

4. **No overloads.** If the function is marked as
   overloaded in the cache → PGRST203 (HTTP 300).

5. **All required arguments provided.** Function
   arguments without defaults (the first
   `numArgs - numDefaults` arguments, since defaults
   are always trailing in PostgreSQL) must be present
   in the request body (POST) or query params (GET).
   Missing → PGRST209.

6. **No extra arguments.** Every key in the request
   body (POST) or argument-classified query param
   (GET) must match a declared function argument.
   Extra → PGRST207.

7. **Type compatibility (input args only).** For GET,
   JavaScript-side validation catches common type
   errors on input arguments (PGRST208). The JS-side
   coercion table (int, bool, json) applies only to
   input argument types from the function signature,
   never to RETURNS TABLE output columns. For all
   methods, PostgreSQL performs final type checking
   at execution time.

8. **Cedar authorization.** Checked before SQL
   generation. Resource type is
   `PgrestLambda::Function`, action is `call`. If
   denied → PGRST403.

9. **Named arguments only.** Functions with unnamed
   arguments (`proargnames` is NULL and
   `pronargs > 0`) are excluded from the schema cache
   during introspection. Attempting to call them
   produces PGRST202 (not found).

10. **IN arguments only (for caller-provided args).**
    Functions with OUT, INOUT, or VARIADIC parameters
    are excluded from the schema cache in v1.
    Functions with TABLE return columns are kept —
    their TABLE columns become queryable result
    columns, not caller-provided arguments. The
    filter is based on `proargmodes`: excluded when
    it contains `o` (OUT), `b` (INOUT), or `v`
    (VARIADIC); kept when it is NULL (all IN) or
    contains only `i` (IN) and `t` (TABLE).

11. **Regular functions only.** Aggregate functions
    (`prokind = 'a'`), window functions
    (`prokind = 'w'`), and procedures
    (`prokind = 'p'`) are excluded. Only regular
    functions (`prokind = 'f'`) are callable via RPC.

12. **Arguments are always parameterized.** Function
    arguments are passed as `$N` bind parameters with
    named-parameter syntax (`"arg" := $N`). No string
    interpolation of argument values.

## Technical Design

### Router: /rpc/ Prefix Matching

`src/rest/router.mjs` gains an `/rpc/` branch inserted
before the table-name lookup:

```javascript
const rpcMatch = remaining.match(
  /^\/rpc\/([A-Za-z_][A-Za-z0-9_]*)$/);
if (remaining.startsWith('/rpc/')) {
  if (!rpcMatch) {
    const raw = remaining.slice(5);
    throw new PostgRESTError(400, 'PGRST100',
      `'${raw}' is not a valid function name`,
      null,
      'Function names must match '
      + '[A-Za-z_][A-Za-z0-9_]*.');
  }
  return { type: 'rpc', functionName: rpcMatch[1] };
}
```

The `/rpc/` path prefix is consumed before the table
regex. A table named `rpc` remains accessible at
`/rest/v1/rpc` (no trailing slash or function name)
because that path does not match `/rpc/<identifier>`.

The `route()` function signature does not change.
The RPC branch uses only the `remaining` string from
path parsing and does not need the schema or
capabilities.

### Schema Cache: pg_proc Introspection

#### New SQL Constant: FUNCTIONS_SQL

```sql
SELECT p.proname AS function_name,
       p.proargnames AS arg_names,
       COALESCE(
         (SELECT array_agg(t.typname ORDER BY a.ord)
            FROM unnest(p.proargtypes)
                 WITH ORDINALITY AS a(oid, ord)
            JOIN pg_catalog.pg_type t
              ON t.oid = a.oid),
         '{}'::text[]
       ) AS arg_types,
       p.proargmodes AS arg_modes,
       p.proallargtypes AS all_arg_types,
       rt.typname AS return_type,
       rt.typtype AS return_type_category,
       p.proretset AS returns_set,
       p.provolatile AS volatility,
       l.lanname AS language,
       p.pronargs AS num_args,
       p.pronargdefaults AS num_defaults
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_namespace n
    ON n.oid = p.pronamespace
  JOIN pg_catalog.pg_type rt
    ON rt.oid = p.prorettype
  JOIN pg_catalog.pg_language l
    ON l.oid = p.prolang
 WHERE n.nspname = 'public'
   AND p.prokind = 'f'
   AND (
     p.proargmodes IS NULL
     OR NOT p.proargmodes && '{o,b,v}'::char[]
   )
 ORDER BY p.proname
```

Key filters:
- `n.nspname = 'public'` — public schema only,
  matching the existing table introspection rule.
- `p.prokind = 'f'` — regular functions only (not
  aggregates, window functions, or procedures).
- `proargmodes IS NULL OR NOT proargmodes &&
  '{o,b,v}'::char[]` — keep functions whose
  arguments are all IN (`proargmodes IS NULL`)
  or contain only IN (`i`) and TABLE (`t`) modes.
  Drop functions with OUT (`o`), INOUT (`b`), or
  VARIADIC (`v`) modes, which complicate the
  argument-binding surface.

Why proargmodes, not proallargtypes: PostgreSQL
populates `proallargtypes` for any function that
has non-IN argument modes, including RETURNS TABLE
functions. RETURNS TABLE columns appear as mode `t`
in `proargmodes`. The old `proallargtypes IS NULL`
filter silently dropped every RETURNS TABLE
function — the idiomatic Supabase pattern for
set-returning functions. The `proargmodes`-based
filter keeps RETURNS TABLE functions visible while
still excluding OUT/INOUT/VARIADIC.

How PostgreSQL represents RETURNS TABLE internally:
a function declared as `RETURNS TABLE(id int, name
text)` has `proargmodes = '{i,...,i,t,t}'` where
the `t` entries correspond to the table columns.
`proargnames` contains the IN arg names at
positions `[0 .. pronargs)` followed by the table
column names at positions `[pronargs .. end]`.
`proallargtypes` contains all type OIDs in the
same positional layout. `proargtypes` contains
only the IN-argument types (positions
`[0 .. pronargs)`).

The correlated subquery for `arg_types` converts the
`proargtypes` oidvector to a text array of type names
via `unnest` with `pg_type` lookup. COALESCE handles
zero-argument functions (where unnest produces no
rows). `proargtypes` always contains only the IN-arg
types regardless of RETURNS TABLE columns.

The `arg_modes` and `all_arg_types` columns are
returned for processing in `buildFunctionsMap`. For
RETURNS TABLE functions, `arg_modes` contains `t`
entries and `all_arg_types` contains the type OIDs
at the corresponding positions. These are used to
build the `returnColumns` field in the cache (see
below).

`return_type_category` is `rt.typtype` from `pg_type`:
`'b'` (base), `'c'` (composite), `'d'` (domain),
`'e'` (enum), `'p'` (pseudo — includes `void` and
`record`).

#### Cache Shape

The schema cache gains a `.functions` map alongside
`.tables` and `.relationships`:

```javascript
{
  tables: { ... },
  relationships: [ ... ],
  functions: {
    calculate_total: {
      args: [
        { name: 'order_id', type: 'uuid' },
        { name: 'include_tax', type: 'bool' },
      ],
      returnType: 'numeric',
      returnColumns: null,
      returnsSet: false,
      isScalar: true,
      volatility: 'v',
      language: 'sql',
      numDefaults: 1,
    },
    get_items: {
      args: [
        { name: 'p_user_id', type: 'uuid' },
      ],
      returnType: 'record',
      returnColumns: [
        { name: 'id', type: 'uuid' },
        { name: 'name', type: 'text' },
      ],
      returnsSet: true,
      isScalar: false,
      volatility: 'v',
      language: 'sql',
      numDefaults: 0,
    },
    get_active_orders: {
      overloaded: true,
    },
  },
}
```

The `returnColumns` field is `null` for functions
that do not use RETURNS TABLE. For RETURNS TABLE
functions, it is an array of `{ name, type }`
objects describing the table columns. It is derived
from `proargnames` and `proallargtypes` at
positions `[pronargs .. end]` where `proargmodes`
has a `t` entry. The type OIDs at those positions
in `proallargtypes` are resolved to type names via
a secondary `pg_type` lookup in `buildFunctionsMap`
(see Processing Logic below).

`returnColumns` enables:
- Column validation on filters, select, and order
  for RETURNS TABLE functions (via
  `columnValidator`, see SQL Builder section).
- Accurate OpenAPI response schemas (see OpenAPI
  section).

The `isScalar` flag: `true` when `return_type_category`
is `'b'` (base), `'d'` (domain), or `'e'` (enum),
AND `returns_set` is `false`. Determines whether the
response is a bare JSON value or a row/array.

Functions marked `{ overloaded: true }` have multiple
definitions in `public` with the same name. They
cannot be called (PGRST203) but appear in the cache
to provide a specific error rather than a confusing
PGRST202 "not found".

#### Processing Logic: buildFunctionsMap

After querying FUNCTIONS_SQL, group rows by
`function_name`:

1. If a name appears more than once → store
   `{ overloaded: true }`.
2. If `num_args > 0` and `arg_names` is NULL →
   skip (unnamed arguments, not callable via RPC).
3. If `num_args > 0` and any of the first `num_args`
   entries in `arg_names` is an empty string → skip
   (partially unnamed).
4. Otherwise, build the function schema object:
   - `args` — array of `{ name, type }` from
     `arg_names[0 .. num_args)` and `arg_types`.
   - `returnType` — `rt.typname` string.
   - `returnColumns` — see step 5.
   - `returnsSet` — boolean from `proretset`.
   - `isScalar` — derived from `return_type_category`
     and `returnsSet`.
   - `volatility` — `'i'` (immutable), `'s'` (stable),
     `'v'` (volatile).
   - `language` — `'sql'`, `'plpgsql'`, etc.
   - `numDefaults` — integer, number of trailing
     arguments with default values.
5. Build `returnColumns` for RETURNS TABLE functions.
   If `arg_modes` is not null and contains `'t'`
   entries:
   - The TABLE column names are in `arg_names` at
     positions where `arg_modes[i] === 't'`.
   - The TABLE column type OIDs are in
     `all_arg_types` at the same positions.
   - Resolve each OID to a type name. Since
     `all_arg_types` is an OID array from pg_proc
     and the type names are not directly available
     in the main query result, `buildFunctionsMap`
     issues a single batch `pg_type` lookup for all
     OIDs found in `all_arg_types` across all
     RETURNS TABLE functions (one query, not per-
     function). The lookup:
     ```sql
     SELECT oid, typname
       FROM pg_catalog.pg_type
      WHERE oid = ANY($1::oid[])
     ```
     This is run once during introspection. The
     result is a map `{ oid → typname }` used to
     resolve TABLE column types.
   - Set `returnColumns` to the array of
     `{ name, type }` objects.
   - If `arg_modes` is null or contains no `'t'`
     entries, set `returnColumns` to `null`.

#### Introspection Integration

`pgIntrospect` runs the function query when
`capabilities.supportsRpc` is `true` (or when
`capabilities` is null for backward compatibility):

```javascript
let functions = {};
if (!capabilities || capabilities.supportsRpc) {
  const fnResult = await pool.query(FUNCTIONS_SQL);
  functions = await buildFunctionsMap(
    fnResult.rows, pool);
}
return { tables, relationships, functions };
```

`buildFunctionsMap` is async because it may issue
a single batch `pg_type` lookup to resolve TABLE
column type OIDs (see Processing Logic step 5).
The batch query runs only when at least one
RETURNS TABLE function is found; otherwise no
additional query is issued.

Functions refresh alongside tables on TTL expiry
and on `POST /rest/v1/_refresh`. No separate refresh
endpoint needed.

#### New Helpers

```javascript
export function hasFunction(schema, fnName) {
  return Boolean(schema.functions?.[fnName]);
}

export function getFunction(schema, fnName) {
  return schema.functions?.[fnName] || null;
}
```

### SQL Builder: buildRpcCall

New export in `src/rest/sql-builder.mjs`:

```javascript
export function buildRpcCall(
    fnName, args, fnSchema, parsed)
```

Returns `{ text, values, resultMode }` where
`resultMode` is `'scalar'`, `'void'`, or `'set'`.

For set-returning functions, `buildRpcCall`
constructs a `columnValidator` via
`makeRpcColumnValidator(fnSchema)` and passes it
to `buildFilterConditions`, `orderClause`, and
select resolution. This is the same pattern that
`buildSelect` uses for table reads — the only
difference is the validator function.

#### Named-Parameter Argument List

Arguments are emitted using PostgreSQL's named-
parameter syntax:

```sql
"arg_name" := $N
```

Arguments present in `args` are included; missing
arguments (those with defaults) are omitted.
PostgreSQL fills in the default values. The argument
list is joined with commas:

```sql
"order_id" := $1, "include_tax" := $2
```

Zero-argument functions produce an empty argument
list: `"fn_name"()`.

#### Scalar Functions

```sql
SELECT "fn_name"("order_id" := $1) AS "fn_name"
```

The alias matches the function name. The handler
extracts `result.rows[0][fnName]` as the scalar
value. `resultMode: 'scalar'`.

#### Void Functions

```sql
SELECT "fn_name"("order_id" := $1)
```

No alias needed. The handler returns 200 with empty
body.
`resultMode: 'void'`.

#### Set-Returning and Composite Functions

```sql
SELECT * FROM "fn_name"("arg" := $1)
```

For set-returning functions with query params,
the result supports WHERE, ORDER BY, LIMIT, and
OFFSET:

```sql
SELECT "id", "name"
  FROM "fn_name"("arg" := $1)
 WHERE "status" = $2
 ORDER BY "name" ASC
 LIMIT $3
 OFFSET $4
```

`resultMode: 'set'`.

#### Unified Column Validation via columnValidator

Filter, order, and select on function results use
the same `buildFilterConditions`, `orderClause`,
and select-resolution code paths as table reads.
There is no parallel implementation. Instead, the
column validation step is parameterized via a
`columnValidator` function.

**Refactoring the existing code.** The current
`buildSingleCondition`, `buildLogicalCondition`,
`buildFilterConditions`, `orderClause`, and
`resolveSelectCols` all call `validateCol(schema,
table, column)` directly. This is replaced with a
`columnValidator(column)` callback that is passed
through the call chain:

```javascript
function buildFilterConditions(
    filters, values, columnValidator) { ... }
function orderClause(
    order, columnValidator) { ... }
function resolveSelectCols(
    selectList, columnValidator) { ... }
```

For table reads, `columnValidator` is:

```javascript
const tableValidator = (col) =>
  validateCol(schema, table, col);
```

This preserves the existing behavior: columns are
checked against the schema cache and PGRST204 is
thrown for unknown columns.

For RPC results, `columnValidator` depends on
whether the function has `returnColumns`:

```javascript
function makeRpcColumnValidator(fnSchema) {
  if (fnSchema.returnColumns) {
    const valid = new Set(
      fnSchema.returnColumns.map(c => c.name));
    return (col) => {
      if (!valid.has(col)) {
        throw new PostgRESTError(400, 'PGRST204',
          `Column '${col}' does not exist `
          + `in function result`);
      }
    };
  }
  // Untyped return (SETOF record, etc.):
  // identifier-shape check only
  const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
  return (col) => {
    if (!IDENT.test(col)) {
      throw new PostgRESTError(400, 'PGRST204',
        `'${col}' is not a valid column name`);
    }
  };
}
```

This gives three validation behaviors from one
code path:
1. **Table reads**: columns checked against the
   schema cache (existing behavior, unchanged).
2. **RETURNS TABLE functions**: columns checked
   against the function's `returnColumns`. Real
   validation — unknown columns produce PGRST204
   before the query hits the database.
3. **Untyped set-returning functions** (RETURNS
   SETOF record, etc.): columns checked only as
   valid PostgreSQL identifiers. The database
   validates column existence at query time.

All filter operators, logical nesting, and
parameterization logic are shared. Future filter
features (fts, range ops) work on both tables and
RPC results automatically.

For non-set functions (scalar, composite, void),
the SQL has no WHERE, ORDER BY, LIMIT, or column
selection. The `parsed` parameter is ignored.

#### HEAD Requests

For HEAD on set-returning functions, `LIMIT 0` is
appended:

```sql
SELECT * FROM "fn_name"("arg" := $1) LIMIT 0
```

### Handler: RPC Branch

`src/rest/handler.mjs` gains a new branch after
routing, before the table `switch` block. The flow:

```
1. routeInfo.type === 'rpc'
2. Capability gate:
   if !ctx.dbCapabilities.supportsRpc → PGRST501
3. Function lookup:
   schema.functions[fnName] → PGRST202 if missing
4. Overload check:
   fnSchema.overloaded → PGRST203
5. Cedar authorize:
   action='call', resource=fnName,
   resourceType='Function' → PGRST403 if denied
6. Argument parsing:
   POST → args = body || {}
   GET/HEAD → extract arg-matching params,
   pass remaining to parseQuery for filters
7. Validate required args → PGRST209
8. Validate no extra args → PGRST207
9. Type coercion (GET) → PGRST208 on failure
10. Build SQL via buildRpcCall(fnName, args,
    fnSchema, parsed)
11. Execute query via pool.query(q.text, q.values)
12. Format response based on q.resultMode
```

#### Argument Parsing: GET

For GET requests, query params are classified by
value syntax — not by matching names against the
function schema. This matches PostgREST's approach
and keeps classification independent of the schema
cache:

```javascript
const RESERVED = new Set([
  'select', 'order', 'limit', 'offset',
  'on_conflict', 'columns',
]);
const OP_PREFIX = /^(not\.)?[a-z]+\./;

const argParams = {};
const restParams = {};
for (const [key, val] of Object.entries(params)) {
  if (RESERVED.has(key)) {
    restParams[key] = val;
  } else if (OP_PREFIX.test(val)) {
    restParams[key] = val;
  } else {
    argParams[key] = val;
  }
}
const parsed = parseQuery(
  restParams, method, multiValueParams);
```

Params with raw values (no operator prefix) become
function arguments. Params with operator-prefixed
values (`eq.`, `gt.`, `in.`, etc.) become filters.
Reserved params go to PostgREST parsing.

#### Argument Parsing: POST

```javascript
const args = body || {};
const parsed = parseQuery(
  params, method, multiValueParams);
```

Body is the function arguments. All query params go
through normal PostgREST parsing.

#### Argument Validation

```javascript
function validateRpcArgs(fnName, args, fnSchema) {
  const required = fnSchema.args.length
    - fnSchema.numDefaults;
  for (let i = 0; i < required; i++) {
    const argDef = fnSchema.args[i];
    if (!(argDef.name in args)) {
      throw new PostgRESTError(400, 'PGRST209',
        `Function '${fnName}' requires argument `
        + `'${argDef.name}' which was not provided`);
    }
  }
  const validNames = new Set(
    fnSchema.args.map(a => a.name));
  for (const key of Object.keys(args)) {
    if (!validNames.has(key)) {
      throw new PostgRESTError(400, 'PGRST207',
        `Function '${fnName}' does not have an `
        + `argument named '${key}'`);
    }
  }
}
```

#### Response Formatting

Based on `resultMode` from `buildRpcCall`:

- **`'void'`**: return `success(200, null, { corsHeaders })`

- **`'scalar'`**: extract the single value from the
  result row and return it as bare JSON:
  ```javascript
  const value = result.rows[0]?.[fnName] ?? null;
  return {
    statusCode: 200,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(value),
  };
  ```

- **`'set'`**: return the rows array through the
  existing `success()` helper with optional
  `singleObject` handling:
  ```javascript
  return success(200, result.rows, {
    singleObject,
    corsHeaders,
  });
  ```

  For `proretset=false` composite functions (single
  row), the result is returned as a single JSON
  object (equivalent to implicit singleObject).

### Cedar: Function Authorization

#### authorize() Resource Type

`src/rest/cedar.mjs` — the `authorize()` method gains
an optional `resourceType` parameter:

```javascript
function authorize({
    principal, action, resource,
    resourceType, schema,
}) {
  const type = resourceType || 'Table';
  const resourceUid = {
    type: `PgrestLambda::${type}`,
    id: resource,
  };
  // ... existing isAuthorized / isAuthorizedPartial
  //     logic unchanged ...
}
```

For RPC, the handler calls:

```javascript
cedar.authorize({
  principal,
  action: 'call',
  resource: fnName,
  resourceType: 'Function',
  schema,
});
```

#### No Row-Level Filtering

`buildAuthzFilter()` is not used for RPC. Function
results cannot be filtered by Cedar policies because
the engine does not know the schema of the returned
rows. Authorization is all-or-nothing: either the
user can call the function, or they cannot.

#### Default Policies

The existing default service_role policy (blanket
permit on all actions and resources) already covers
function calls if written without action constraints.
If the default policy specifies actions explicitly,
a new rule is needed:

```cedar
permit(
  principal == PgrestLambda::ServiceRole::"service",
  action == PgrestLambda::Action::"call",
  resource
);
```

Anon users cannot call functions unless an explicit
policy permits it. Exposing stored functions to
anonymous callers requires deliberate policy
authoring.

Example per-function policy:

```cedar
permit(
  principal is PgrestLambda::User,
  action == PgrestLambda::Action::"call",
  resource == PgrestLambda::Function::"get_public_stats"
);
```

### OpenAPI: Function Endpoints

`src/rest/openapi.mjs` — `generateSpec()` adds paths
for each non-overloaded function in
`schema.functions`:

```javascript
paths[`/rpc/${fnName}`] = {
  post: {
    summary: `Call ${fnName}`,
    tags: ['Functions'],
    requestBody: {
      content: {
        'application/json': {
          schema: buildFnArgSchema(fnSchema),
        },
      },
    },
    responses: { 200: { ... } },
  },
};
```

`buildFnArgSchema(fnSchema)` builds a JSON Schema
object from the function's argument list, reusing the
existing `pgTypeToJsonSchema()` for type mapping.
Required arguments (those without defaults) are listed
in the `required` array.

`buildFnResponseSchema(fnSchema)` builds the response
schema:

- **Scalar functions** (`isScalar: true`): response
  schema is the `pgTypeToJsonSchema()` of
  `fnSchema.returnType` (e.g., `{ type: 'integer' }`
  for `int4`).
- **Void functions** (`returnType === 'void'`):
  response schema is `{}` (empty schema, no body).
- **RETURNS TABLE functions** (`returnColumns` is
  not null): response schema is:
  ```json
  {
    "type": "array",
    "items": {
      "type": "object",
      "properties": {
        "id": { "type": "string", "format": "uuid" },
        "name": { "type": "string" }
      }
    }
  }
  ```
  Each column in `returnColumns` maps to a property
  via `pgTypeToJsonSchema()`.
- **Other set-returning / composite functions**
  (`returnColumns` is null, `returnsSet` is true):
  response schema is:
  ```json
  { "type": "array", "items": { "type": "object" } }
  ```
  (Generic object — no column information available.)
- **Composite non-set functions**: response schema
  is `{ "type": "object" }`.

The full path entry becomes:

```javascript
paths[`/rpc/${fnName}`] = {
  post: {
    summary: `Call ${fnName}`,
    tags: ['Functions'],
    requestBody: {
      content: {
        'application/json': {
          schema: buildFnArgSchema(fnSchema),
        },
      },
    },
    responses: {
      200: {
        description: 'Function result',
        content: {
          'application/json': {
            schema: buildFnResponseSchema(fnSchema),
          },
        },
      },
    },
  },
};
```

Function endpoints are tagged `'Functions'` to
separate them from table endpoints (tagged `'Data'`).

### Capability Gating

The handler checks `ctx.dbCapabilities.supportsRpc`
before any function-specific logic:

```javascript
if (!ctx.dbCapabilities.supportsRpc) {
  throw new PostgRESTError(501, 'PGRST501',
    'RPC is not supported on this database',
    null,
    'Deploy on standard PostgreSQL to use stored '
    + 'function calls.');
}
```

This check fires before function lookup, Cedar
authorization, or argument parsing. The schema cache
also skips the FUNCTIONS_SQL query when
`supportsRpc` is false, so `schema.functions` is an
empty object.

Both providers currently set `supportsRpc: true`.
The gating exists for future providers that may not
support functions, and for deployments that want to
disable function calls via configuration override.

### Error Code Registration

Add to `src/rest/errors.mjs` as documentation
alongside existing PGRST codes:

```javascript
// PGRST101 — Unsupported HTTP method for RPC.
//            HTTP 405. Only GET, POST, HEAD allowed.
//            Matches PostgREST's code for verb errors.
//
// PGRST202 — Function not found in the schema cache.
//            HTTP 404. Function may not exist, may
//            have unnamed arguments, or may use
//            OUT/INOUT/VARIADIC params (excluded in
//            v1). Matches PostgREST PGRST202.
//
// PGRST203 — Overloaded function. HTTP 300. Multiple
//            functions with the same name exist in
//            the public schema. Overload resolution
//            is not supported in v1. Matches
//            PostgREST PGRST203 semantics.
//
// PGRST207 — Unknown function argument. HTTP 400.
//            pgrest-lambda-specific. Request included
//            an argument name that does not match any
//            parameter in the function signature.
//            PostgREST passes unknown args to PG and
//            lets the DB error propagate.
//
// PGRST208 — Type coercion failure. HTTP 400.
//            pgrest-lambda-specific. A GET query
//            parameter value could not be converted
//            to the expected PG type. PostgREST does
//            not do JS-side type coercion.
//
// PGRST209 — Missing required function argument.
//            HTTP 400. pgrest-lambda-specific. The
//            first N args (where N = pronargs -
//            pronargdefaults) must be provided.
```

### Dev-Mode Logging

In non-production mode (`ctx.production === false`),
log function calls following the existing auth-handler
pattern:

```javascript
if (!ctx.production) {
  console.info(
    `[pgrest-lambda] rpc: ${fnName}(`
    + `${Object.keys(args).join(', ')})`);
}
```

Log on call attempt (before execution). Error logging
is handled by the existing catch block in the handler.

## Code Architecture / File Changes

| File | Action | ~Lines | Description |
|------|--------|--------|-------------|
| `src/rest/router.mjs` | Modify | +15 | `/rpc/` prefix matching with name validation |
| `src/rest/schema-cache.mjs` | Modify | +100 | FUNCTIONS_SQL (proargmodes filter), buildFunctionsMap with returnColumns, batch pg_type lookup, hasFunction, getFunction |
| `src/rest/sql-builder.mjs` | Modify | +80 | buildRpcCall with named-param syntax; refactor buildFilterConditions/orderClause/resolveSelectCols to accept columnValidator callback; makeRpcColumnValidator |
| `src/rest/handler.mjs` | Modify | +90 | RPC branch: capability gate, function lookup, arg parsing/validation, execute, response |
| `src/rest/cedar.mjs` | Modify | +5 | resourceType parameter in authorize() |
| `src/rest/errors.mjs` | Modify | +30 | Document PGRST101, 202, 203, 207, 208, 209 |
| `src/rest/openapi.mjs` | Modify | +60 | Function endpoint paths, buildFnArgSchema, buildFnResponseSchema (typed response for RETURNS TABLE) |

**Files that do NOT change:**
- `src/rest/query-parser.mjs` — existing parsing
  handles RPC filter params without modification
- `src/rest/response.mjs` — scalar responses use
  direct JSON.stringify; set-returning responses use
  success() as-is
- `src/rest/db/*.mjs` — providers already declare
  supportsRpc; no database-layer changes
- `src/index.mjs` — ctx.dbCapabilities already wired
- `src/auth/**` — no auth changes
- `src/authorizer/**` — no authorizer changes

**No new files. No new npm dependencies.**

## Testing Strategy

### Unit Tests: Router

Test file: `tests/unit/router-rpc.test.mjs`

**Valid function names:**
- `/rest/v1/rpc/my_function` → `{ type: 'rpc',
  functionName: 'my_function' }`
- `/rest/v1/rpc/_private` → valid (leading underscore)
- `/rest/v1/rpc/A` → valid (single character)

**Invalid function names:**
- `/rest/v1/rpc/my-func` → PGRST100 (hyphen)
- `/rest/v1/rpc/123abc` → PGRST100 (leading digit)
- `/rest/v1/rpc/my func` → PGRST100 (space)
- `/rest/v1/rpc/` → PGRST100 (empty after prefix)
- `/rest/v1/rpc/fn/extra` → PGRST100 (nested path)

**Does not interfere with table routing:**
- `/rest/v1/users` → `{ type: 'table' }` (unchanged)

### Unit Tests: Schema Cache Functions

Test file: `tests/unit/schema-cache-functions.test.mjs`

**Function introspection:**
- Mock pool returns pg_proc rows for a scalar function
  (pronargs=2, named args, returns int4,
  proretset=false, proargmodes=NULL). Assert
  `schema.functions.fn` has correct args array,
  returnType, isScalar=true, returnColumns=null.
- Set-returning function (proretset=true, composite
  return, proargmodes=NULL). Assert isScalar=false,
  returnsSet=true, returnColumns=null.
- RETURNS TABLE function (proretset=true,
  proargmodes='{i,t,t}', proargnames=
  '{p_user_id,id,name}', proallargtypes=
  '{uuid_oid,uuid_oid,text_oid}'). Assert args has
  one entry (p_user_id), returnColumns has two
  entries ({name:'id',type:'uuid'},
  {name:'name',type:'text'}), returnsSet=true.
- Void function (return type 'void'). Assert
  returnType='void', returnColumns=null.
- Zero-argument function (pronargs=0,
  proargnames=NULL). Assert args is empty array,
  function IS included in cache.

**Excluded functions:**
- Function with NULL proargnames and pronargs > 0 →
  not in cache.
- Function with empty-string arg name → not in cache.
- Function with proargmodes containing 'o' (OUT) →
  not in cache.
- Function with proargmodes containing 'b' (INOUT) →
  not in cache.
- Function with proargmodes containing 'v' (VARIADIC)
  → not in cache.
- Function with proargmodes='{i,t}' (IN + TABLE) →
  IS in cache (RETURNS TABLE kept).

**Overloaded functions:**
- Two rows with same function_name → stored as
  `{ overloaded: true }`.

**Capability gating:**
- `supportsRpc = false` → FUNCTIONS_SQL not executed,
  functions map is empty.
- `supportsRpc = true` → functions map populated.
- `capabilities = null` → functions map populated
  (backward compat).

**Helpers:**
- `hasFunction(schema, 'fn')` returns true/false.
- `getFunction(schema, 'fn')` returns schema or null.

### Unit Tests: SQL Builder RPC

Test file: `tests/unit/sql-builder-rpc.test.mjs`

**Scalar function:**
- `buildRpcCall('add', {a:3, b:4}, scalarSchema, null)`
  → text: `SELECT "add"("a" := $1, "b" := $2) AS "add"`,
  values: [3, 4], resultMode: 'scalar'.

**Void function:**
- `buildRpcCall('do_thing', {}, voidSchema, null)`
  → text: `SELECT "do_thing"()`,
  values: [], resultMode: 'void'.

**Set-returning function (RETURNS TABLE with
returnColumns):**
- No filters →
  `SELECT * FROM "get_items"("user_id" := $1)`,
  resultMode: 'set'.
- With filter on known column (in returnColumns) →
  WHERE clause appended, no error.
- With filter on unknown column (not in
  returnColumns) → PGRST204 thrown.
- With order on known column → ORDER BY appended.
- With limit/offset → LIMIT/OFFSET appended.
- With select on known columns → named columns
  instead of `*`.

**Set-returning function (no returnColumns, e.g.,
RETURNS SETOF record):**
- With filter on valid identifier → WHERE clause
  appended (identifier-only validation).
- With filter on invalid identifier (e.g., contains
  hyphen) → PGRST204 thrown.
- Database validates column existence at query time.

**Named-parameter syntax:**
- Arguments emitted as `"name" := $N`.
- Missing optional args omitted from SQL.
- Empty args → `"fn_name"()`.

**SQL safety:**
- Function name always double-quoted.
- Argument names always double-quoted.
- Values always parameterized (`$N`).

### Unit Tests: Argument Validation

Test file: `tests/unit/rpc-validation.test.mjs`

**Required arguments:**
- Function with 3 args, 1 default. Provide 2 →
  passes.
- Provide 1 → PGRST209 naming the missing arg.
- Provide 0 → PGRST209 naming first missing arg.

**Extra arguments:**
- Function with args (a, b). Provide {a, b, c} →
  PGRST207 naming 'c'.

**Type coercion (GET):**
- int4 arg, value "42" → coerced to 42.
- int4 arg, value "abc" → PGRST208.
- bool arg, value "true" → coerced to true.
- bool arg, value "yes" → PGRST208.

### Unit Tests: Error Codes

Test file: `tests/unit/rpc-errors.test.mjs`

- PGRST101 has statusCode 405.
- PGRST202 has statusCode 404.
- PGRST203 has statusCode 300.
- PGRST207 has statusCode 400.
- PGRST208 has statusCode 400.
- PGRST209 has statusCode 400.
- All produce correct JSON shape through error()
  response formatter.

### Integration Tests

Test file: `tests/integration/rpc.test.mjs`

Setup: create test functions in the bundled PostgreSQL:

```sql
CREATE FUNCTION add_numbers(a integer, b integer)
RETURNS integer LANGUAGE sql AS $$
  SELECT a + b;
$$;

CREATE FUNCTION get_items(p_user_id uuid)
RETURNS TABLE(id uuid, name text) LANGUAGE sql AS $$
  SELECT id, name FROM items
   WHERE user_id = p_user_id;
$$;

CREATE FUNCTION do_nothing()
RETURNS void LANGUAGE sql AS $$
$$;

CREATE FUNCTION with_default(
  x integer, y integer DEFAULT 10)
RETURNS integer LANGUAGE sql AS $$
  SELECT x + y;
$$;
```

**Scalar function via POST:**
- POST /rest/v1/rpc/add_numbers `{a: 3, b: 4}`.
- Assert status 200, body is `7`.

**Scalar function via GET:**
- GET /rest/v1/rpc/add_numbers?a=3&b=4.
- Assert status 200, body is `7`.

**Set-returning RETURNS TABLE function with filters:**
- Insert test rows into items table.
- POST /rest/v1/rpc/get_items `{p_user_id: 'u-1'}`
  with `?order=name.asc&limit=5`.
- Assert status 200, body is sorted array.
- POST /rest/v1/rpc/get_items `{p_user_id: 'u-1'}`
  with `?name=eq.Alice`.
- Assert status 200, body filtered to matching rows.
- POST /rest/v1/rpc/get_items `{p_user_id: 'u-1'}`
  with `?select=name`.
- Assert status 200, body contains only 'name' column.
- POST /rest/v1/rpc/get_items `{p_user_id: 'u-1'}`
  with `?nonexistent=eq.x`.
- Assert status 400, PGRST204 (column not found in
  function result — validated from returnColumns).

**Void function:**
- POST /rest/v1/rpc/do_nothing.
- Assert status 200, body is empty.

**Default arguments:**
- POST /rest/v1/rpc/with_default `{x: 5}`.
- Assert result is 15 (5 + default 10).

**Missing required argument:**
- POST /rest/v1/rpc/add_numbers `{a: 3}`.
- Assert status 400, code PGRST209, message mentions
  'b'.

**Unknown argument:**
- POST /rest/v1/rpc/add_numbers `{a:3, b:4, c:5}`.
- Assert status 400, code PGRST207, message mentions
  'c'.

**Function not found:**
- POST /rest/v1/rpc/nonexistent.
- Assert status 404, code PGRST202.

**Capability gate (mock provider):**
- Create pgrest with mock provider where
  `supportsRpc = false`.
- POST /rest/v1/rpc/anything.
- Assert status 501, code PGRST501.

**GET and POST produce same result:**
- Call add_numbers via GET and POST with same args.
- Assert both return 7.

**HEAD request:**
- HEAD /rest/v1/rpc/get_items?p_user_id=u-1.
- Assert status 200, no body, Content-Type header
  present.

**Cedar permit/forbid:**
- Cedar policy permits authenticated users to call
  add_numbers but not do_nothing.
- Call add_numbers as authenticated → 200.
- Call do_nothing as authenticated → 403, PGRST403.
- Call add_numbers as service_role → 200.

### E2E Tests

Test file: `tests/e2e/supabase-js-rpc.test.mjs`

**Scalar via supabase-js:**

```javascript
const { data, error } = await supabase.rpc(
  'add_numbers', { a: 3, b: 4 });
assert.strictEqual(data, 7);
assert.strictEqual(error, null);
```

**Set-returning with chained filters:**

```javascript
const { data } = await supabase
  .rpc('get_items', { p_user_id: testUserId })
  .order('name')
  .limit(5);
assert.ok(Array.isArray(data));
assert.ok(data.length <= 5);
```

**Error case:**

```javascript
const { data, error } = await supabase.rpc(
  'nonexistent_fn');
assert.strictEqual(data, null);
assert.strictEqual(error.code, 'PGRST202');
```

## Implementation Order

### Phase 1: Router + Schema Cache

1. Add `/rpc/` prefix matching to
   `src/rest/router.mjs`.
2. Add FUNCTIONS_SQL, `buildFunctionsMap`,
   `hasFunction`, `getFunction` to
   `src/rest/schema-cache.mjs`.
3. Integrate function query into `pgIntrospect` with
   capability gating.
4. Unit tests: router RPC matching and schema cache
   function introspection.

### Phase 2: SQL Builder + columnValidator Refactor

5. Refactor `buildFilterConditions`, `orderClause`,
   and `resolveSelectCols` in `src/rest/sql-builder.mjs`
   to accept a `columnValidator` callback instead of
   calling `validateCol` directly. Update `buildSelect`
   and all other callers to pass
   `(col) => validateCol(schema, table, col)`.
   Existing table-read tests must still pass — this
   is a signature change, not a behavior change.
6. Add `buildRpcCall` and `makeRpcColumnValidator`
   to `src/rest/sql-builder.mjs` with named-parameter
   syntax, scalar/void/set modes, and filter/order/
   limit for set-returning functions.
7. Unit tests: SQL generation for all modes,
   columnValidator dispatch (RETURNS TABLE vs.
   untyped), and edge cases.

### Phase 3: Handler + Cedar + Errors

8. Add `resourceType` parameter to
   `cedar.authorize()`.
9. Add error code documentation to
   `src/rest/errors.mjs`.
10. Add RPC branch to `src/rest/handler.mjs`:
    capability gate, function lookup, Cedar authorize,
    arg parsing, validation, type coercion, execute,
    response formatting.
11. Unit tests: argument validation, error codes.

### Phase 4: OpenAPI + Integration

12. Add function endpoint generation to
    `src/rest/openapi.mjs` with `buildFnArgSchema`
    and `buildFnResponseSchema` (typed responses for
    RETURNS TABLE functions).
13. Add dev-mode logging for RPC calls.
14. Integration tests: full RPC flows against real
    PostgreSQL, including RETURNS TABLE with filters
    and column validation.

### Phase 5: E2E

15. E2E tests with supabase-js `.rpc()` calls.
16. Verify Cedar permit/forbid integration tests.
17. Verify capability gate with mock provider.

## Open Questions

1. **Prefer: count=exact for set-returning functions.**
   Table reads support `Prefer: count=exact` via a
   separate COUNT(*) query. PostgREST supports this
   for RPC via CTE wrapping, with the restriction
   that it fails on functions returning a single row
   (`funcReturnsSingle`). For pgrest-lambda v1,
   deferred — the feature works without it, and
   adding it later is backward-compatible. When
   added, wrap the function call in a CTE:
   `WITH _rpc AS (SELECT * FROM fn(...))
   SELECT *, (SELECT count(*) FROM _rpc) FROM _rpc`.

2. **Prefer: params=single-object.** PostgREST supports
   passing the entire request body as a single JSONB
   argument for functions like `fn(payload jsonb)`.
   PostgREST itself has deprecated this feature.
   Not needed for v1 — standard named-argument
   passing covers the common case.

3. **DSQL PL/pgSQL limitation.** Both providers set
   `supportsRpc: true`, but DSQL only supports
   SQL-language functions (`LANGUAGE sql`). PL/pgSQL
   functions fail at `CREATE FUNCTION` time on DSQL,
   not at RPC call time. The `language` field in the
   schema cache could power a warning, but this is a
   deployment concern, not a runtime concern. No
   action needed.

4. **Function overload resolution.** PostgREST supports
   overloaded functions by matching argument count to
   select the correct signature. pgrest-lambda v1
   rejects all overloaded functions with PGRST203
   (HTTP 300), which is stricter than PostgREST.
   This is a known supabase-js compatibility gap:
   clients calling overloaded functions will get
   errors from pgrest-lambda but work with PostgREST/
   Supabase. Adding overload resolution requires
   matching the provided argument set against multiple
   signatures. Deferred until a user reports it as a
   blocker.

5. **Immutable function caching.** Functions marked
   `provolatile = 'i'` (immutable) produce the same
   result for the same arguments. The engine could
   send `Cache-Control: public, max-age=...` headers
   for these calls. The `volatility` field is already
   in the schema cache for this purpose. Deferred.

6. **Row-level Cedar filtering on function results.**
   Authorization is all-or-nothing: either the user
   can call the function, or they cannot. Cedar
   row-level filtering on function results is not
   supported. Deferred.

7. **Composite return type introspection.** RETURNS
   TABLE functions get full column introspection
   via `proargmodes` / `proallargtypes`. Functions
   that return named composite types (via
   `pg_type` + `pg_attribute`) do not — their
   columns are validated by PostgreSQL at query
   time. Adding composite-type introspection is a
   backward-compatible enhancement. Deferred.
