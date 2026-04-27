# Select Column Casts

## Overview

Add PostgREST-compatible column casting in the `select`
query parameter so that `?select=id,amount::text` emits
`CAST("amount" AS text)` and returns the value as a
string in JSON. This enables supabase-js queries like
`.select('id, amount::text')` for casting bigints to
strings (avoiding JavaScript Number precision loss),
timestamps to dates, and other safe type conversions.

PostgREST syntax: `select=amount::text,name,age::int`.
The double-colon `::` suffix on a column name triggers a
SQL CAST in the SELECT list. Aliases compose with casts:
`price:amount::text` means "select `amount`, cast it to
`text`, and name the result `price`".

The implementation modifies ~80 lines across two existing
files. No new files, no new npm dependencies. Both
standard PostgreSQL and DSQL support `CAST(x AS type)`;
no capability flag is needed.

Depends on: db-capabilities (shipped), select-aliases
(shipped).

## Current CX / Concepts

### Double-Colon Skipped but Not Parsed

`parseSelectList()` in `query-parser.mjs` already
recognizes `::` when scanning for the alias colon: it
skips any `:` that is immediately followed by another
`:`. This was added by the select-aliases feature to
avoid misinterpreting a cast operator as an alias
separator.

Today, a token like `amount::text` passes through the
colon-scanning loop without finding a single colon. The
result is a column node with `name: 'amount::text'`.
The sql-builder then calls
`hasColumn(schema, table, 'amount::text')` which throws
PGRST204: "Column 'amount::text' does not exist in
'orders'".

### Alias + Cast Token

A token like `price:amount::text` currently finds the
single colon at position 5, producing `alias: 'price'`
and `name: 'amount::text'`. The column name
`amount::text` fails schema validation as above.

### SQL Builder Has No Cast Awareness

`buildSelect()` emits `"col"` or `"col" AS "alias"`.
There is no code path for `CAST("col" AS type)`.

### supabase-js Forwards Raw Select Strings

`@supabase/supabase-js` passes the `select` string
through to the query parameter without parsing. A call
like `.select('amount::text')` produces
`?select=amount::text`. The server must handle the `::`.

## Proposed CX / CX Specification

### Query Parameter Syntax

Column casts use the PostgREST `col::type` syntax. The
double-colon appears after the column name (and after
any alias prefix):

```
# Cast a single column
GET /rest/v1/orders?select=id,amount::text

# Multiple casts
GET /rest/v1/orders?select=id,amount::text,created_at::date

# Alias + cast
GET /rest/v1/orders?select=id,price:amount::text

# Cast inside an embed
GET /rest/v1/orders?select=id,customers(age::int)

# Alias on embed + cast inside embed
GET /rest/v1/orders?select=id,buyer:customers(age::text)
```

### Precedence

The full token grammar for a plain column is:

```
[alias:]column[::type]
```

The alias colon (single `:`) is resolved first; then the
remaining column portion is checked for `::type`. This
matches PostgREST: `alias:column::type` means "alias
applies to the cast result".

### Response Format

Cast columns return the value in the target type's JSON
representation:

```json
[
  {
    "id": "ord-1",
    "amount": "99.00"
  }
]
```

When `amount` is a `numeric` column and cast to `text`,
PostgreSQL returns it as a string. The existing
`JSON.stringify(result.rows)` in `response.mjs` passes
this through unchanged.

With alias + cast:

```json
[
  {
    "id": "ord-1",
    "price": "99.00"
  }
]
```

### Safe Cast Allowlist

Arbitrary type names in the `::` position are a SQL
injection vector. The engine validates the cast type
against a static allowlist at parse time:

```
text, integer, int, int4, int2, bigint, int8,
smallint, numeric, real, float4, float8,
double precision, boolean, bool,
date, timestamp, timestamptz, time, timetz,
uuid, json, jsonb, varchar, char
```

These are standard PostgreSQL built-in types that:

1. Are safe to use in `CAST(x AS type)` — they do not
   invoke user-defined cast functions.
2. Work on both standard PostgreSQL and DSQL.
3. Cover realistic supabase-js use cases (bigint→text,
   timestamp→date, numeric→integer, etc.).

Multi-word types (`double precision`) are matched as a
single string after trimming.

Unknown types are rejected at parse time.

### Validation Rules

1. **Cast type allowlisted.** The type name (after `::`)
   must appear in the allowlist. Reject with PGRST100 if
   the type is not recognized. Error message:
   `"Unsupported cast type 'x'"`. This prevents SQL
   injection — the cast type is never interpolated from
   user input without allowlist validation.

2. **Column validated against schema.** The column name
   (before `::`) is validated against the schema cache by
   the sql-builder, same as today. An invalid column
   throws PGRST204.

3. **Alias + cast composition.** When both alias and cast
   are present, the alias is validated first (existing
   identifier regex), then the column portion is split on
   `::` to extract column name and cast type. The cast
   type is validated against the allowlist.

4. **Cast type is case-insensitive.** `::TEXT`, `::Text`,
   and `::text` all resolve to `text`. The allowlist
   comparison normalizes to lowercase.

5. **Empty cast type rejected.** A trailing `::` with
   no type (e.g., `amount::`) is rejected with PGRST100:
   `"Empty cast type after '::'"`.

6. **Filters reference raw column names, not cast
   results.** `?select=amount::text&amount=gt.50` filters
   on the raw `amount` column. Casts are a SELECT-only
   concept. This matches PostgREST behavior.

7. **Duplicate key detection includes casts.** The output
   key for duplicate detection is the alias if present,
   otherwise the column name (without the cast). Two
   entries `amount::text,amount::int` produce duplicate
   key `amount`.

### Error Messages

| Scenario | HTTP | Code | Message |
|----------|------|------|---------|
| Unknown cast type | 400 | PGRST100 | "Unsupported cast type '{type}'" |
| Empty cast type | 400 | PGRST100 | "Empty cast type after '::'" |
| Cast column not found | 400 | PGRST204 | "Column '{col}' does not exist in '{table}'" |
| Invalid alias + cast | 400 | PGRST100 | "'{alias}' is not a valid identifier for an alias" |

### supabase-js Compatibility

These queries must produce correct results:

```javascript
// Simple cast
supabase.from('orders')
  .select('id, amount::text')
// → [{id, amount: "99.00"}]

// Alias + cast
supabase.from('orders')
  .select('id, price:amount::text')
// → [{id, price: "99.00"}]

// Cast inside embed
supabase.from('orders')
  .select('id, customers(age::text)')
// → [{id, customers: {age: "25"}}]

// Multiple casts
supabase.from('orders')
  .select('id, amount::text, created_at::date')
// → [{id, amount: "99.00", created_at: "2024-01-15"}]

// Mixed aliased, cast, and plain
supabase.from('orders')
  .select('id, total:amount::text, status')
// → [{id, total: "99.00", status: "active"}]
```

## Technical Design

### Parsed Select Node: Cast Field

Column nodes gain an optional `cast` field:

```javascript
// select=id,amount::text
{
  select: [
    { type: 'column', name: 'id' },
    { type: 'column', name: 'amount', cast: 'text' },
  ]
}

// select=price:amount::text
{
  select: [
    { type: 'column', name: 'amount',
      alias: 'price', cast: 'text' },
  ]
}
```

When no cast is present, `cast` is `undefined` (not
`null`) to avoid adding a field to every column node.

### Cast Type Allowlist

Add a constant `Set` in `query-parser.mjs`:

```javascript
const ALLOWED_CAST_TYPES = new Set([
  'text', 'integer', 'int', 'int4', 'int2',
  'bigint', 'int8', 'smallint',
  'numeric', 'real', 'float4', 'float8',
  'double precision',
  'boolean', 'bool',
  'date', 'timestamp', 'timestamptz',
  'time', 'timetz',
  'uuid', 'json', 'jsonb',
  'varchar', 'char',
]);
```

### Parser Changes: `parseSelectList()`

After extracting the column name (and any alias), check
for `::` in the column portion:

```javascript
// column is the text after alias resolution
// (e.g., "amount::text" from "price:amount::text")
const castIdx = column.indexOf('::');
if (castIdx !== -1) {
  const castType = column.slice(castIdx + 2).trim()
    .toLowerCase();
  const colName = column.slice(0, castIdx).trim();
  if (!castType) {
    throw new PostgRESTError(400, 'PGRST100',
      `Empty cast type after '::'`);
  }
  if (!ALLOWED_CAST_TYPES.has(castType)) {
    throw new PostgRESTError(400, 'PGRST100',
      `Unsupported cast type '${castType}'`);
  }
  if (!colName) {
    throw new PostgRESTError(400, 'PGRST100',
      `Empty column name before '::'`);
  }
  nodes.push({
    type: 'column', name: colName,
    ...(alias ? { alias } : {}),
    cast: castType,
  });
} else {
  nodes.push({
    type: 'column', name: column,
    ...(alias ? { alias } : {}),
  });
}
```

The flow in the plain-column branch becomes:

1. Scan for single colon (skip `::`) → extract alias.
2. In the column portion, check for `::` → extract cast
   type and validate against allowlist.
3. Produce `{ type: 'column', name, alias?, cast? }`.

### Duplicate Key Detection

The output key for duplicate detection remains
`alias || name` (the column name without the cast
suffix). This means `amount::text,amount::int` is
rejected as a duplicate key `amount`. This is correct:
two casts of the same column produce the same JSON key
unless one is aliased.

### SQL Builder Changes

#### SQL Form: `CAST()` vs `::`

Use the `CAST(x AS type)` form consistently. While
PostgreSQL also supports the `::` shorthand, `CAST()`
is standard SQL and reads more clearly in generated
queries. Both forms work on PostgreSQL and DSQL.

#### Flat SELECT Path (No Embeds)

In `buildSelect()`, the flat path currently builds:

```javascript
colList = cols.map(n => {
  const name = typeof n === 'string' ? n : n.name;
  const alias = typeof n === 'string'
    ? undefined : n.alias;
  if (alias) return `"${name}" AS "${alias}"`;
  return `"${name}"`;
}).join(', ');
```

Change to handle casts:

```javascript
colList = cols.map(n => {
  const name = typeof n === 'string' ? n : n.name;
  const alias = typeof n === 'string'
    ? undefined : n.alias;
  const cast = typeof n === 'string'
    ? undefined : n.cast;
  let expr = `"${name}"`;
  if (cast) expr = `CAST("${name}" AS ${cast})`;
  if (alias) expr += ` AS "${alias}"`;
  return expr;
}).join(', ');
```

PostgreSQL names the output column of
`CAST("amount" AS text)` as `amount`, preserving the
original column name inside the CAST. This means JSON
keys stay correct without an explicit `AS` in the
unqualified (flat) case:

```sql
SELECT CAST("amount" AS text) FROM orders;
-- column name in result: "amount"
```

With alias: `CAST("col" AS type) AS "alias"` produces
key `alias`. Both correct.

#### Embed Path (With Embeds)

In the embed-aware `buildSelect()` path, column
expressions currently produce:

```javascript
if (node.alias) {
  expressions.push(
    `"${table}"."${node.name}" AS "${node.alias}"`);
} else {
  expressions.push(`"${table}"."${node.name}"`);
}
```

Change to:

```javascript
let expr = `"${table}"."${node.name}"`;
if (node.cast) {
  expr = `CAST("${table}"."${node.name}" AS ${node.cast})`;
}
if (node.alias) {
  expr += ` AS "${node.alias}"`;
} else if (node.cast) {
  expr += ` AS "${node.name}"`;
}
expressions.push(expr);
```

The `AS "${node.name}"` when cast is present but no
alias is needed because
`CAST("orders"."amount" AS text)` would produce a
column named `cast` in some contexts (the full
expression becomes the column name). Adding
`AS "amount"` preserves the expected JSON key.

#### `buildJsonBuildObject()` (Embed Subqueries)

Inside `buildJsonBuildObject()`, column nodes currently
produce:

```javascript
const jsonKey = node.alias || node.name;
pairs.push(
  `'${jsonKey}', "${table}"."${node.name}"`);
```

When a column has a cast, the SQL column reference must
use CAST:

```javascript
const jsonKey = node.alias || node.name;
let colExpr = `"${table}"."${node.name}"`;
if (node.cast) {
  colExpr = `CAST("${table}"."${node.name}" `
    + `AS ${node.cast})`;
}
pairs.push(`'${jsonKey}', ${colExpr}`);
```

The JSON key is the alias (if present) or the column
name (not the cast type).

#### `buildRpcCall()` (RPC Select)

`buildRpcCall()` already handles aliases in the select
list for set-returning functions:

```javascript
selectPart = selectNodes.map(s => {
  const name = typeof s === 'string' ? s : s.name;
  const alias = typeof s === 'string'
    ? undefined : s.alias;
  if (alias) return `"${name}" AS "${alias}"`;
  return `"${name}"`;
}).join(', ');
```

Add cast support:

```javascript
selectPart = selectNodes.map(s => {
  const name = typeof s === 'string' ? s : s.name;
  const alias = typeof s === 'string'
    ? undefined : s.alias;
  const cast = typeof s === 'string'
    ? undefined : s.cast;
  let expr = `"${name}"`;
  if (cast) expr = `CAST("${name}" AS ${cast})`;
  if (alias) expr += ` AS "${alias}"`;
  return expr;
}).join(', ');
```

#### `resolveSelectCols()` (Legacy Path)

`resolveSelectCols()` is used by `buildInsert` and as a
fallback. It maps column nodes to names via `s.name`.
No change needed — casts are not applied to INSERT
column lists.

### No Response-Layer Changes

PostgreSQL returns rows with column names matching the
`AS` alias or the CAST input column name. The existing
`JSON.stringify(result.rows)` in `response.mjs` uses
these keys directly. No transformation needed.

### Order Clause — No Changes

The order clause validates and emits raw column names.
Ordering by cast result (`?order=amount::int.desc`) is
out of scope for this loop.

### Filter Clause — No Changes

Filters reference raw column names. Casting on
horizontal filtering (`?amount=gt.100::numeric`) is out
of scope for this loop and explicitly excluded by
PostgREST to preserve index usage.

### DB Specialization

Standard SQL `CAST(x AS type)` works on both PostgreSQL
and DSQL. The allowlist contains only built-in types
that both databases support. No capability flag needed.

One narrow concern: DSQL may reject exotic casts (e.g.,
to custom domain types). The engine's conservative
allowlist prevents this.

## Code Architecture / File Changes

| File | Action | Lines | Description |
|------|--------|-------|-------------|
| `src/rest/query-parser.mjs` | Modify | ~35 added | `ALLOWED_CAST_TYPES` set, `::` detection in column portion after alias resolution, cast type validation |
| `src/rest/sql-builder.mjs` | Modify | ~45 changed | Emit `CAST("col" AS type)` in flat path, embed path, `buildJsonBuildObject`, and `buildRpcCall` |

**Files that do NOT change:**
- `src/rest/handler.mjs` — handler passes parsed query
  as-is; cast support is transparent
- `src/rest/schema-cache.mjs` — no schema changes
- `src/rest/errors.mjs` — no new error codes (uses
  existing PGRST100, PGRST204)
- `src/rest/router.mjs` — no routing changes
- `src/rest/openapi.mjs` — defer cast docs
- `src/rest/response.mjs` — PostgreSQL returns cast
  keys; no transformation needed
- `src/rest/db.mjs` — database layer unchanged
- `src/auth/**` — no auth changes
- `src/authorizer/**` — no authorizer changes

**No new files. No new npm dependencies.**

## Testing Strategy

### Unit Tests: query-parser.mjs

**Basic cast parsing:**
- `select=amount::text` → `{ type: 'column',
  name: 'amount', cast: 'text' }`
- `select=id,amount::text,name` → three nodes, one
  with cast, two without
- `select=created_at::date` → `{ type: 'column',
  name: 'created_at', cast: 'date' }`

**All allowed types accepted:**
- `select=col::text` → accepted
- `select=col::integer` → accepted
- `select=col::int` → accepted
- `select=col::int4` → accepted
- `select=col::int2` → accepted
- `select=col::bigint` → accepted
- `select=col::int8` → accepted
- `select=col::smallint` → accepted
- `select=col::numeric` → accepted
- `select=col::real` → accepted
- `select=col::float4` → accepted
- `select=col::float8` → accepted
- `select=col::double precision` → accepted
- `select=col::boolean` → accepted
- `select=col::bool` → accepted
- `select=col::date` → accepted
- `select=col::timestamp` → accepted
- `select=col::timestamptz` → accepted
- `select=col::time` → accepted
- `select=col::timetz` → accepted
- `select=col::uuid` → accepted
- `select=col::json` → accepted
- `select=col::jsonb` → accepted
- `select=col::varchar` → accepted
- `select=col::char` → accepted

**Case insensitivity:**
- `select=col::TEXT` → `{ cast: 'text' }` (normalized
  to lowercase)
- `select=col::Text` → `{ cast: 'text' }`

**Alias + cast:**
- `select=price:amount::text` → `{ type: 'column',
  name: 'amount', alias: 'price', cast: 'text' }`
- `select=d:created_at::date` → `{ type: 'column',
  name: 'created_at', alias: 'd', cast: 'date' }`

**Cast without alias — no alias field:**
- `select=amount::text` → node has `name: 'amount'`,
  `cast: 'text'`, no `alias` property

**Alias without cast — no cast field:**
- `select=price:amount` → node has `name: 'amount'`,
  `alias: 'price'`, no `cast` property

**Unknown cast type rejected:**
- `select=col::xml` → PGRST100 "Unsupported cast type
  'xml'"
- `select=col::money` → PGRST100
- `select=col::custom_type` → PGRST100
- `select=col::int[]` → PGRST100 (array types not
  allowed)

**Empty cast type rejected:**
- `select=amount::` → PGRST100 "Empty cast type
  after '::'"

**Empty column before cast rejected:**
- `select=::text` → PGRST100 "Empty column name
  before '::'"

**Double cast rejected:**
- `select=col::text::int` → PGRST100 "Unsupported
  cast type 'text::int'" (first `::` splits; remainder
  `text::int` is not in the allowlist)

**Duplicate key detection with casts:**
- `select=amount::text,amount::int` → PGRST100
  "Duplicate select key 'amount'" (both produce key
  `amount`)
- `select=a:amount::text,a:col::int` → PGRST100
  "Duplicate select key 'a'"
- `select=amount::text,price:amount::int` → valid
  (keys are `amount` and `price`)

**Cast inside embed:**
- `select=id,customers(age::int)` → embed node's
  `select` has `{ type: 'column', name: 'age',
  cast: 'int' }`
- `select=id,buyer:customers(age::text)` → embed
  alias + cast inside embed

**Existing alias behavior unchanged:**
- `select=firstName:first_name` → `{ type: 'column',
  name: 'first_name', alias: 'firstName' }` (no cast)
- `select=buyer:customers(name)` → embed alias,
  unchanged

**Wildcard ignores casts:**
- `select=*` → wildcard, no cast, unchanged

### Unit Tests: sql-builder.mjs

**Flat select with cast:**
- Input: `select=[{type:'column', name:'amount',
  cast:'text'}]`
- Expected SQL contains: `CAST("amount" AS text)`

**Flat select with cast + alias:**
- Input: `select=[{type:'column', name:'amount',
  alias:'price', cast:'text'}]`
- Expected: `CAST("amount" AS text) AS "price"`

**Mixed cast, alias, and plain:**
- Input: `select=[{type:'column', name:'id'},
  {type:'column', name:'amount', cast:'text'},
  {type:'column', name:'status', alias:'s'}]`
- Expected: `SELECT "id", CAST("amount" AS text),
  "status" AS "s" FROM "orders"`

**No casts — unchanged:**
- Input: `select=[{type:'column', name:'id'},
  {type:'column', name:'title'}]`
- Expected: `SELECT "id", "title" FROM "todos"`
  (same as before)

**Cast in embed path (with embed present):**
- Input: orders table with embed + cast column
- Expected: `CAST("orders"."amount" AS text)
  AS "amount"` in the SELECT list alongside the embed
  subquery

**Cast inside embed (json_build_object):**
- Input: embed with `select=[{type:'column',
  name:'age', cast:'int'}]`
- Expected: json_build_object uses cast:
  `'age', CAST("customers"."age" AS int)`

**Cast + alias inside embed (json_build_object):**
- Input: embed with `select=[{type:'column',
  name:'age', alias:'customerAge', cast:'text'}]`
- Expected:
  `'customerAge', CAST("customers"."age" AS text)`

**Cast in RPC select:**
- Input: set-returning function with
  `select=[{type:'column', name:'salary',
  cast:'text'}]`
- Expected: `SELECT CAST("salary" AS text)
  FROM "fn_name"(...)`

**Wildcard ignores casts:**
- Input: `select=[{type:'column', name:'*'}]`
- Expected: all columns expanded, no casts

### Integration Tests

The existing `notes` table has `id BIGSERIAL` (bigint)
and `created_at TIMESTAMPTZ` — both are useful cast
targets. Tests should use this table plus any tables
added by prior feature loops (e.g., `orders`,
`customers` from the embedded-filtering work).

**Bigint id to text (avoids JS precision loss):**
```
GET /rest/v1/notes?select=id::text,body
```
→ `id` values are strings in JSON (e.g., `"1"` not `1`)

**Timestamp to date:**
```
GET /rest/v1/notes?select=id,created_at::date
```
→ `created_at` values are date strings (e.g.,
`"2024-01-15"`)

**Alias + cast:**
```
GET /rest/v1/notes?select=noteId:id::text,body
```
→ Response has `noteId` key with string value, no `id`
key

**Cast inside embed (if orders/customers tables
available):**
```
GET /rest/v1/orders?select=id,customers(age::text)
```
→ Nested customer object has `age` as string

**Unknown cast type returns error:**
```
GET /rest/v1/notes?select=id::xml
```
→ 400 PGRST100 "Unsupported cast type 'xml'"

**Cast + filter on raw column:**
```
GET /rest/v1/notes?select=id::text,body
    &id=gt.0
```
→ Filtered on numeric `id`, returned as text

**Cast preserves correct JSON key name:**
```
GET /rest/v1/notes?select=id::text
```
→ JSON key is `id` (not `cast` or any other name)

### E2E: supabase-js

```javascript
// Simple cast — bigint id to text
const { data } = await supabase
  .from('notes')
  .select('id::text, body');
assert.equal(typeof data[0].id, 'string',
  'bigint id should be a string after cast');

// Alias + cast
const { data: d2 } = await supabase
  .from('notes')
  .select('noteId:id::text, body');
assert.ok(d2[0].noteId !== undefined,
  'should have aliased key');
assert.ok(d2[0].id === undefined,
  'should not have raw column key');
assert.equal(typeof d2[0].noteId, 'string');

// Timestamp to date
const { data: d3 } = await supabase
  .from('notes')
  .select('id, created_at::date');
assert.ok(
  /^\d{4}-\d{2}-\d{2}$/.test(d3[0].created_at),
  'should be a date string');
```

## Implementation Order

### Phase 1: Parser (~35 lines)

1. Add `ALLOWED_CAST_TYPES` set constant to
   `query-parser.mjs`.
2. In `parseSelectList()`, after alias resolution in the
   plain-column branch, check the column portion for
   `::`. Split into column name and cast type. Validate
   the cast type against the allowlist.
3. Produce `{ type: 'column', name, alias?, cast? }`.
4. Unit tests for all cast parsing and validation cases.

### Phase 2: SQL Builder (~45 lines)

5. In `buildSelect()` flat path, emit
   `CAST("col" AS type)` when cast is present. Add
   `AS "col"` when cast is present without alias (to
   preserve JSON key).
6. In `buildSelect()` embed path, emit
   `CAST("table"."col" AS type) AS "col"` when cast is
   present.
7. In `buildJsonBuildObject()`, use
   `CAST("table"."col" AS type)` when cast is present.
8. In `buildRpcCall()`, emit `CAST("col" AS type)` when
   cast is present in the select list.
9. Unit tests for SQL generation with casts.

### Phase 3: Integration & E2E

10. Integration test: cast select against real
    PostgreSQL (numeric→text, timestamp→date).
11. Integration test: alias + cast.
12. Integration test: cast inside embed.
13. Integration test: unknown cast type error.
14. E2E: supabase-js round-trip with cast select.

## Open Questions

1. **Custom cast types (via config).** PostgREST allows
   any type the database supports, including custom
   domain types. pgrest-lambda restricts to a safe
   allowlist. A follow-up could add a config option
   (e.g., `ADDITIONAL_CAST_TYPES=my_enum,my_domain`)
   to extend the allowlist. **Recommendation:** Defer.
   Document as a known limitation.

2. **Cast on filter values.** PostgREST supports
   `?amount=gt.100::numeric` to cast the filter value.
   This is a separate feature loop.
   **Recommendation:** Defer.

3. **Cast in order clause.** PostgREST supports
   `?order=amount::int.desc`. This is a separate
   feature loop. **Recommendation:** Defer.

4. **Array type casts.** Types like `int[]` or
   `text[]` are not in the allowlist. PostgREST
   supports them. Adding array casts requires
   validating the base type and appending `[]`.
   **Recommendation:** Defer. If needed, add as a
   follow-up.

5. **`varchar(N)` and `char(N)` with length.** The
   allowlist includes `varchar` and `char` without
   length specifiers. `CAST(x AS varchar)` is valid
   PostgreSQL (equivalent to `text`). Parameterized
   lengths like `varchar(255)` are not supported by
   the parser — the parentheses would conflict with
   embed syntax. **Recommendation:** No action needed.
   `varchar` without length covers the use case.

6. **`double precision` as a multi-word type.** The
   token `col::double precision` contains a space. The
   parser splits on commas at depth 0, so
   `amount::double precision` is a single token. The
   column portion after alias resolution is
   `amount::double precision`. Splitting on `::` yields
   `double precision` which is in the allowlist.
   API Gateway URL-decodes `queryStringParameters`, so
   `amount::double+precision` or
   `amount::double%20precision` in the URL both arrive
   as the correct string. No special handling needed.
   supabase-js sends the raw select string and encodes
   spaces in the URL automatically.
