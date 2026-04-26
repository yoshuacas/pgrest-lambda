# Select Column Aliases

## Overview

Add PostgREST-compatible column aliasing in the `select`
query parameter so that `?select=firstName:first_name`
emits `SELECT "first_name" AS "firstName"` and returns
JSON keyed by `firstName`. This is the highest-impact
gap for supabase-js compatibility: every codebase that
maps snake_case DB columns to camelCase client-side uses
`alias:column` syntax, and today pgrest-lambda fails
with "column not found" because the parser treats
`firstName:first_name` as a literal column name.

The implementation modifies ~70 lines across two existing
files. No new files, no new npm dependencies. Standard
SQL column aliases work identically on Postgres and DSQL;
no capability flag is needed.

## Current CX / Concepts

### Column Aliases Treated as Column Names

`parseSelectList()` in `query-parser.mjs` already
handles the colon for embed aliases:
`buyer:customers(name)` becomes an embed node with
`alias: 'buyer'` and `name: 'customers'`. The
disambiguation works because the parser checks for `(`
after the colon.

For plain columns, however, `firstName:first_name` has
no parentheses. The parser produces a column node with
`name: 'firstName:first_name'`. The sql-builder then
calls `hasColumn(schema, table, 'firstName:first_name')`
which throws PGRST204: "Column 'firstName:first_name'
does not exist in 'people'".

### Existing Embed Alias Validation

`parseEmbedToken()` already validates aliases against
`/^[a-zA-Z_][a-zA-Z0-9_]*$/` and throws PGRST100 if
an alias contains invalid characters. Column aliases
will reuse the same validation rule. Note: PostgREST
is more permissive — it allows dollar signs, dashes,
and quoted identifiers in aliases. Our stricter regex
is intentional (safer for SQL injection prevention)
and covers all realistic supabase-js usage patterns.

### SQL Builder Generates Unqualified Column Names

In the flat (non-embed) SELECT path, `buildSelect()`
produces:

```sql
SELECT "id", "first_name" FROM "people"
```

Columns are just `"col"`. When embeds are present, they
become `"table"."col"`. Column aliases add a third form:
`"col" AS "alias"` (flat) or `"table"."col" AS "alias"`
(with embeds).

### JSON Response Uses Postgres Column Names

The REST handler runs `pool.query()` and returns
`result.rows` as JSON. Postgres returns rows keyed by
the column name in the SELECT list. If the SELECT says
`"first_name" AS "firstName"`, the row object has key
`firstName`. No extra response-layer work is needed.

## Proposed CX / CX Specification

### Query Parameter Syntax

Column aliases use the same `alias:column` syntax as
PostgREST. The colon has higher precedence than
operators but lower than embed parentheses:

```
# Alias a single column
GET /rest/v1/people?select=id,firstName:first_name

# Multiple aliases
GET /rest/v1/people?select=id,firstName:first_name,lastName:last_name

# Mix aliased and unaliased
GET /rest/v1/people?select=id,displayName:first_name,email

# Alias inside an embed
GET /rest/v1/orders?select=id,customers(displayName:name,mail:email)

# Alias on embed + alias inside embed
GET /rest/v1/orders?select=id,buyer:customers(displayName:name)
```

### Response Format

Aliased columns appear in JSON under their alias name:

```json
[
  {
    "id": "p-1",
    "firstName": "Alice",
    "lastName": "Smith"
  }
]
```

Aliases inside embeds appear under the alias within the
nested object:

```json
[
  {
    "id": "ord-1",
    "buyer": {
      "displayName": "Alice",
      "mail": "a@b.com"
    }
  }
]
```

### Parser Disambiguation

The colon in `select` tokens is ambiguous between column
aliases and embed aliases. The parser disambiguates by
checking whether the text after the colon is followed by
`(`:

- `buyer:customers(name)` — `(` follows `customers` →
  embed alias. Existing behavior, unchanged.
- `firstName:first_name` — no `(` after `first_name` →
  column alias. New behavior.
- `firstName:first_name,id` — comma after `first_name`
  → column alias. New behavior.

The parser looks for a single colon (not `::`) in the
plain-column token. If found:
1. Split on the first single colon (skip `::` pairs).
2. Left side is the alias; right side is the column name.
3. Validate the alias against
   `/^[a-zA-Z_][a-zA-Z0-9_]*$/` (same rule as embed
   aliases).
4. Store as `{ type: 'column', name: column, alias }`.

### Validation Rules

1. **Alias identifier validation.** The alias must match
   `[a-zA-Z_][a-zA-Z0-9_]*`. Reject with PGRST100 if
   the alias contains quotes, spaces, backslashes, null
   bytes, or any other character outside the allowlist.
   Error message: `"'{alias}' is not a valid identifier
   for an alias"`. This prevents SQL injection through
   `AS "${alias}"` since the alias is allowlisted, not
   escaped.

2. **Duplicate select key detection.** After parsing the
   full select list, check for duplicate output keys.
   The output key is the alias if present, otherwise the
   column name. If two entries produce the same output
   key, reject with PGRST100: `"Duplicate select key
   '{key}'"`. This catches:
   - Two aliases with the same name:
     `a:col1,a:col2`
   - An alias colliding with a plain column:
     `email,email:user_email`
   - Two plain columns with the same name (already
     caught by comma splitting, but covered for
     completeness)

3. **Column validated against schema.** The column name
   (right side of the colon) is validated against the
   schema cache by the sql-builder, same as today. An
   alias referencing a non-existent column throws
   PGRST204.

4. **Filters reference raw column names, not aliases.**
   `?select=amount:price&price=gt.50` filters on the
   raw column `price`. Aliases are a SELECT-only
   concept. This matches PostgREST behavior. Document
   this explicitly.

5. **Order by alias — out of scope.** PostgREST does not
   currently support ordering by select alias (a PR to
   add this, postgrest#3931, was abandoned April 2025).
   pgrest-lambda matches this: ordering references raw
   column names only. If a user tries
   `?order=firstName.desc` and `firstName` is not a real
   column, they get PGRST204.

### Error Messages

| Scenario | HTTP | Code | Message |
|----------|------|------|---------|
| Invalid alias chars | 400 | PGRST100 | "'{alias}' is not a valid identifier for an alias" |
| Duplicate select key | 400 | PGRST100 | "Duplicate select key '{key}'" |
| Aliased column not found | 400 | PGRST204 | "Column '{col}' does not exist in '{table}'" |

### supabase-js Compatibility

These queries must produce correct results:

```javascript
// Simple column alias
supabase.from('people')
  .select('id, firstName:first_name, lastName:last_name')
// → [{id, firstName, lastName}]

// Alias inside embed
supabase.from('orders')
  .select('id, customers(displayName:name, mail:email)')
// → [{id, customers: {displayName, mail}}]

// Alias on embed + alias inside embed
supabase.from('orders')
  .select('id, buyer:customers(displayName:name)')
// → [{id, buyer: {displayName}}]

// Mixed aliased and unaliased
supabase.from('people')
  .select('id, displayName:first_name, email')
// → [{id, displayName, email}]
```

## Technical Design

### Parsed Select Node: Column Alias Field

Column nodes gain an optional `alias` field:

```javascript
// select=id,firstName:first_name
{
  select: [
    { type: 'column', name: 'id' },
    { type: 'column', name: 'first_name', alias: 'firstName' },
  ]
}
```

When no alias is present, `alias` is `undefined` (not
`null`) to avoid adding a field to every column node.
Embed nodes already have `alias: null | string`.

### Parser Changes: `parseSelectList()`

In the plain-column branch (where `parenStart === -1`),
after extracting the token text and trimming it, check
for a colon:

```javascript
if (parenStart === -1) {
  const name = input.slice(tokenStart, i).trim();
  if (name) {
    // Find alias colon: first ':' not followed by ':'
    // (skips '::' cast operator)
    let colonIdx = -1;
    for (let j = 0; j < name.length; j++) {
      if (name[j] === ':') {
        if (j + 1 < name.length && name[j + 1] === ':') {
          j++; // skip '::'
        } else {
          colonIdx = j;
          break;
        }
      }
    }
    if (colonIdx !== -1) {
      const alias = name.slice(0, colonIdx).trim();
      const column = name.slice(colonIdx + 1).trim();
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(alias)) {
        throw new PostgRESTError(400, 'PGRST100',
          `'${alias}' is not a valid identifier`
          + ` for an alias`);
      }
      if (!column) {
        throw new PostgRESTError(400, 'PGRST100',
          `Empty column name after alias '${alias}'`);
      }
      nodes.push({ type: 'column', name: column, alias });
    } else {
      nodes.push({ type: 'column', name });
    }
  }
}
```

This only runs for plain-column tokens (no parentheses).
Embed tokens with colons (e.g., `buyer:customers(name)`)
go through the embed branch and `parseEmbedToken()` as
before.

### Duplicate Key Detection: `parseSelectList()`

PostgREST does not reject duplicate select keys at parse
time. pgrest-lambda adds this as a stricter validation
to catch mistakes early. After the main parsing loop,
before returning `nodes`, scan for duplicate output keys:

```javascript
const keys = new Set();
for (const node of nodes) {
  if (node.type === 'column' && node.name !== '*') {
    const key = node.alias || node.name;
    if (keys.has(key)) {
      throw new PostgRESTError(400, 'PGRST100',
        `Duplicate select key '${key}'`);
    }
    keys.add(key);
  } else if (node.type === 'embed') {
    const key = node.alias || node.name;
    if (keys.has(key)) {
      throw new PostgRESTError(400, 'PGRST100',
        `Duplicate select key '${key}'`);
    }
    keys.add(key);
  }
}
```

Duplicate detection runs per-level (once in the
top-level select list, once recursively inside each
embed's select list, since `parseSelectList` is called
recursively for embed contents).

### SQL Builder Changes

#### Flat SELECT Path (No Embeds)

In `buildSelect()`, the flat path currently builds:

```javascript
colList = cols.map(c => `"${c}"`).join(', ');
```

Change to handle aliases:

```javascript
const cols = parsed.select.filter(
  n => n.type === 'column');
if (cols.length === 1 && cols[0].name === '*') {
  colList = Object.keys(schema.tables[table].columns)
    .map(c => `"${c}"`).join(', ');
} else {
  for (const c of cols) {
    validateCol(schema, table, c.name);
  }
  colList = cols.map(c => {
    if (c.alias) return `"${c.name}" AS "${c.alias}"`;
    return `"${c.name}"`;
  }).join(', ');
}
```

#### Embed Path (With Embeds)

In the embed-aware `buildSelect()` path, the column
expression builder currently produces:

```javascript
expressions.push(`"${table}"."${node.name}"`);
```

Change to:

```javascript
if (node.alias) {
  expressions.push(
    `"${table}"."${node.name}" AS "${node.alias}"`);
} else {
  expressions.push(`"${table}"."${node.name}"`);
}
```

#### `buildJsonBuildObject()` (Embed Subqueries)

Inside `buildJsonBuildObject()`, column nodes currently
produce:

```javascript
pairs.push(
  `'${node.name}', "${table}"."${node.name}"`);
```

When a column has an alias, the JSON key must be the
alias and the SQL column reference is the real column:

```javascript
const jsonKey = node.alias || node.name;
pairs.push(
  `'${jsonKey}', "${table}"."${node.name}"`);
```

#### `resolveSelectCols()` (Legacy Path)

`resolveSelectCols()` is used by `buildInsert` and as
a fallback. It maps column nodes to names. Update to
read `node.name` regardless of alias presence. No
change needed here since it already reads `s.name`.

### No Response-Layer Changes

Postgres returns rows with column names matching the
`AS` alias. The existing `JSON.stringify(result.rows)`
in `response.mjs` uses these keys directly. No
transformation needed.

### Order Clause — No Changes

The order clause currently validates and emits:

```javascript
validateCol(schema, table, o.column);
let sql = `"${o.column}" ${o.direction.toUpperCase()}`;
```

This references raw column names. Ordering by alias is
out of scope for this loop. The existing behavior
(PGRST204 if the order column doesn't exist) is correct.

## Code Architecture / File Changes

| File | Action | Lines | Description |
|------|--------|-------|-------------|
| `src/rest/query-parser.mjs` | Modify | ~35 added | Parse `alias:column` in plain-column branch (with `::` skip), validate alias, duplicate key detection |
| `src/rest/sql-builder.mjs` | Modify | ~15 added | Emit `AS "alias"` in flat path, embed path, and `buildJsonBuildObject` |

**Files that do NOT change:**
- `src/rest/handler.mjs` — handler passes parsed query
  as-is; alias support is transparent
- `src/rest/schema-cache.mjs` — no schema changes
- `src/rest/errors.mjs` — no new error codes needed
- `src/rest/router.mjs` — no routing changes
- `src/rest/openapi.mjs` — defer alias docs
- `src/rest/response.mjs` — Postgres returns aliased
  keys; no transformation needed
- `src/rest/db.mjs` — database layer unchanged
- `src/auth/**` — no auth changes
- `src/authorizer/**` — no authorizer changes

**No new files. No new npm dependencies.**

## Testing Strategy

### Unit Tests: query-parser.mjs

**Basic alias parsing:**
- `select=firstName:first_name` → `{ type: 'column',
  name: 'first_name', alias: 'firstName' }`
- `select=id,firstName:first_name,lastName:last_name`
  → three nodes, two with aliases, one without
- `select=id,displayName:first_name,email` → mixed
  aliased and unaliased columns

**Alias-less columns unchanged:**
- `select=id,first_name` → `{ type: 'column',
  name: 'id' }` and `{ type: 'column',
  name: 'first_name' }` — no `alias` property

**Alias validation (same rules as embed aliases):**
- `select=x'injection:first_name` → PGRST100 (single
  quote)
- `select=x"injection:first_name` → PGRST100 (double
  quote)
- `select=x injection:first_name` → PGRST100 (space)
- `select=123bad:first_name` → PGRST100 (leading digit)
- `select=_valid:first_name` → valid
- `select=camelCase123:first_name` → valid

**Duplicate select key detection:**
- `select=a:col1,a:col2` → PGRST100 "Duplicate select
  key 'a'"
- `select=email,email:user_email` → PGRST100 "Duplicate
  select key 'email'"
- `select=id,name,id` → PGRST100 "Duplicate select
  key 'id'"

**Existing embed alias still works:**
- `select=id,buyer:customers(name)` → embed node with
  `name: 'customers'`, `alias: 'buyer'`. No change.

**Alias inside embed:**
- `select=id,customers(displayName:name,mail:email)`
  → embed node's `select` has two column nodes with
  aliases
- `select=id,buyer:customers(displayName:name)` →
  embed alias + column alias inside embed

**Edge cases:**
- `select=alias:` → PGRST100 (empty column name after
  alias)
- `select=*` → wildcard, no alias, unchanged

**Double-colon (`::`) is not mistaken for alias colon:**
- `select=col::text` → `::` skipped, no single colon
  found → no alias, column name is `col::text` (fails
  schema validation today; will work when casting is
  added)
- `select=alias:col::text` → single colon at position
  5 found before `::` → alias is `alias`, column is
  `col::text`
- `select=a::b:c` → `::` skipped, single colon found
  after `b` → alias is `a::b`, which fails alias
  validation regex → PGRST100 (correct rejection)

### Unit Tests: sql-builder.mjs

**Flat select with aliases:**
- Input: `select=[{type:'column', name:'first_name',
  alias:'firstName'}, {type:'column',
  name:'last_name', alias:'lastName'}]`
- Expected: `SELECT "first_name" AS "firstName",
  "last_name" AS "lastName" FROM "people"`

**Mixed aliased and unaliased:**
- Input: `select=[{type:'column', name:'id'},
  {type:'column', name:'first_name',
  alias:'firstName'}]`
- Expected: `SELECT "id", "first_name" AS "firstName"
  FROM "people"`

**No aliases — unchanged:**
- Input: `select=[{type:'column', name:'id'},
  {type:'column', name:'title'}]`
- Expected: `SELECT "id", "title" FROM "todos"`
  (same as before)

**Alias in embed path (with embed present):**
- Input: orders table with embed + aliased column
- Expected: `"orders"."first_name" AS "firstName"` in
  the SELECT list alongside the embed subquery

**Alias inside embed (json_build_object):**
- Input: embed with `select=[{type:'column',
  name:'name', alias:'displayName'}]`
- Expected: json_build_object uses alias as JSON key:
  `'displayName', "customers"."name"`

**Wildcard ignores aliases:**
- Input: `select=[{type:'column', name:'*'}]`
- Expected: all columns expanded, no aliases

### Integration Tests

- `GET /rest/v1/people?select=id,firstName:first_name`
  → `[{id, firstName}]`, no `first_name` key
- `GET /rest/v1/orders?select=id,customers(displayName:name)`
  → `[{id, customers: {displayName}}]`
- supabase-js:
  `supabase.from('people').select('id, firstName:first_name')`
  → response has `firstName` key

### E2E Tests

Add one scenario to `tests/e2e/supabase-js.test.mjs`:

```javascript
const { data } = await supabase
  .from('notes')
  .select('id, author:user_id');
assert.ok(data[0].author !== undefined,
  'should have aliased key');
assert.ok(data[0].user_id === undefined,
  'should not have raw column key');
```

## Implementation Order

### Phase 1: Parser (~35 lines)

1. In `parseSelectList()`, add colon detection in the
   plain-column branch. Scan for the first single colon
   (skip `::` pairs), validate alias, produce
   `{ type: 'column', name, alias }`.
2. Add duplicate select key detection after the
   parsing loop.
3. Unit tests for all alias parsing and validation
   cases.

### Phase 2: SQL Builder (~15 lines)

4. In `buildSelect()` flat path, emit
   `"col" AS "alias"` when alias is present.
5. In `buildSelect()` embed path, emit
   `"table"."col" AS "alias"` when alias is present.
6. In `buildJsonBuildObject()`, use alias as JSON key
   when present.
7. Unit tests for SQL generation with aliases.

### Phase 3: Integration & E2E

8. Integration test: aliased select against real
   Postgres.
9. Integration test: alias inside embed.
10. E2E: supabase-js round-trip with aliased select.

## Open Questions

1. **Order by alias.** PostgREST does not support ordering
   by select alias (PR postgrest#3931 was abandoned
   April 2025). pgrest-lambda matches this — ordering
   uses raw column names. No follow-up needed unless
   PostgREST adds the feature upstream.

2. **Aliases on wildcard columns.** PostgREST does not
   support `alias:*`. Neither will we. The wildcard
   expands to all columns without aliases. No validation
   needed — `*` cannot appear after a colon because the
   parser only checks for colons in non-wildcard tokens.

3. **Type casting in select.** PostgREST supports
   `col::type` and `alias:col::type`. Type casting is
   a separate feature loop. The colon for aliases
   (`alias:col`) uses a single colon; the cast uses a
   double colon (`col::type`). There is a potential
   conflict: `indexOf(':')` on a cast-only token like
   `col::text` would match the first `:` of `::`,
   incorrectly treating `col` as an alias and `:text`
   as the column name. PostgREST avoids this with
   `notFollowedBy (char ':')`. The column alias parser
   must skip `::` when scanning for the alias colon:
   find the first `:` that is not immediately followed
   by another `:`. This prevents misparse now and
   aligns with PostgREST when casting is added later.
