# Resource Embedding

## Overview

Add PostgREST-compatible resource embedding to pgrest-lambda
so that supabase-js nested select queries work. Queries like
`.select('id, amount, customers(name, email)')` generate
correlated subqueries that return parent rows with nested
JSON objects/arrays for related tables, all in a single SQL
statement.

Resource embedding is the #1 gap for supabase-js wire
compatibility. Without it, any `.select()` call that
includes related tables fails with a column-not-found error.

The implementation adds ~350 lines across five existing
files. No new files, no new npm dependencies.

## Current CX / Concepts

### Flat SELECT Only

`query-parser.mjs` splits the `select` parameter on commas
and treats each token as a column name:

```javascript
const select = params.select
  ? params.select.split(',')
  : ['*'];
```

A request like `?select=id,customers(name)` produces
`['id', 'customers(name)']`. The sql-builder then tries to
validate `customers(name)` as a column name and throws
PGRST204 ("Column 'customers(name)' does not exist").

### No Relationship Metadata

`schema-cache.mjs` introspects columns and primary keys but
not foreign keys. The cache structure has no `relationships`
field. The original PostgREST-compatible API design
explicitly deferred resource embedding because Aurora DSQL
does not support FK constraints.

### SQL Builder Generates Flat Queries

`sql-builder.mjs` `buildSelect()` produces:

```sql
SELECT "id", "amount" FROM "orders"
  WHERE ... ORDER BY ... LIMIT ... OFFSET ...
```

Column names are unqualified (no table prefix). There are no
subqueries or JOIN clauses.

### Cedar Authorization Per Table

`handler.mjs` builds Cedar authorization filters for the
primary table only. There is no mechanism to build authz
filters for embedded tables or inject them into subqueries.

## Proposed CX / CX Specification

### Nested Select Syntax

Clients embed related tables using parenthetical syntax
inside the `select` parameter, matching PostgREST:

```
# Many-to-one: embed parent as object
GET /rest/v1/orders?select=id,amount,customers(name,email)

# One-to-many: embed children as array
GET /rest/v1/customers?select=id,orders(id,amount)

# Wildcard on both parent and child
GET /rest/v1/orders?select=*,customers(*)

# Aliased embed
GET /rest/v1/orders?select=id,buyer:customers(name)

# Nested embedding (2+ levels)
GET /rest/v1/orders?select=id,items(id,products(name))

# Inner join — only return parent rows with matches
GET /rest/v1/customers?select=id,orders!inner(id)

# Disambiguation with !hint
GET /rest/v1/orders?select=*,billing:addresses!billing_address_id(*),shipping:addresses!shipping_address_id(*)
```

### Response Format

**Many-to-one embeds** return a JSON object (or null):

```json
[
  {
    "id": "ord-1",
    "amount": 99.00,
    "customers": { "name": "Alice", "email": "a@b.com" }
  },
  {
    "id": "ord-2",
    "amount": 50.00,
    "customers": null
  }
]
```

**One-to-many embeds** return a JSON array (never null):

```json
[
  {
    "id": "cust-1",
    "orders": [
      { "id": "ord-1", "amount": 99.00 },
      { "id": "ord-2", "amount": 50.00 }
    ]
  },
  {
    "id": "cust-2",
    "orders": []
  }
]
```

**Aliased embeds** use the alias as the JSON key:

```json
[
  {
    "id": "ord-1",
    "buyer": { "name": "Alice" }
  }
]
```

**Nested embeds** produce nested JSON:

```json
[
  {
    "id": "ord-1",
    "items": [
      {
        "id": "item-1",
        "products": { "name": "Widget" }
      }
    ]
  }
]
```

### Relationship Discovery

pgrest-lambda discovers relationships via two mechanisms,
tried in order:

1. **pg_catalog foreign keys** — query `pg_constraint` for
   `contype = 'f'` in the `public` schema. Works on
   standard PostgreSQL, Aurora, RDS, Neon, etc.

2. **Convention-based fallback** — when the FK query returns
   zero relationships (DSQL, or a DB without FKs), infer
   relationships from column naming: `{table}_id` or
   `{singular}_id` implies many-to-one to that table.
   Singularization is minimal: strip trailing `s`
   (`customer_id` -> look for `customers` table). Only
   infer if the target table exists in the cache and the
   target has a matching primary key column.

The convention fallback does not run if real FKs were found.
Both mechanisms produce the same `relationships` array in
the schema cache.

### Relationship Types

| Type | FK Location | Embed Shape | Example |
|------|-------------|-------------|---------|
| Many-to-one | On requesting table | JSON object | orders -> customers |
| One-to-many | On target table | JSON array | customers -> orders |

Many-to-many and computed relationships are out of scope.

### Disambiguation (`!hint`)

When multiple FKs exist between two tables (e.g., `orders`
has both `billing_address_id` and `shipping_address_id`
pointing to `addresses`), the client disambiguates with
`!hint` syntax:

```
select=*,addresses!billing_address_id(*)
```

The hint can be a constraint name or a column name from
either side of the FK (both `fromColumns` and `toColumns`
are checked). The parser extracts the hint and the
relationship resolver matches it against the `constraint`,
`fromColumns`, or `toColumns` fields.

Note: PostgREST is deprecating column-name hints in favor
of constraint-name-only (planned for a future major
release after v11.1.0). pgrest-lambda supports both for
compatibility with existing client code.

### Inner Joins (`!inner`)

`!inner` filters the parent result set to only include
rows that have at least one matching child:

```
select=id,orders!inner(id)
```

For one-to-many, this adds an EXISTS subquery to the
parent WHERE clause:

```sql
WHERE EXISTS (
  SELECT 1 FROM "orders"
  WHERE "orders"."customer_id" = "customers"."id"
)
```

For many-to-one, this adds IS NOT NULL on the FK column:

```sql
WHERE "orders"."customer_id" IS NOT NULL
```

`!inner` can be combined with `!hint`:
`addresses!billing_address_id!inner(*)`.

### Validation Rules

1. Every embed name must resolve to a known relationship.
   If the embed table name does not match any relationship
   from the parent table, return PGRST200.

2. If multiple relationships match the embed table name and
   no `!hint` is provided, return PGRST201.

3. Column names inside an embed's select list are validated
   against the embedded table's schema, not the parent's.

4. `*` inside an embed expands to all columns of the
   embedded table.

5. Nested embeds (embeds inside embeds) are resolved
   recursively. Each level resolves relationships from its
   own table.

6. Aliases do not affect relationship resolution. In
   `buyer:customers(name)`, the relationship is resolved
   using `customers`, and the alias `buyer` only affects
   the JSON key in the response.

7. `!hint` must match exactly one relationship. If it
   matches zero, return PGRST200. If ambiguity remains
   after the hint, return PGRST201.

### Error Messages

| Scenario | HTTP | Code | Message |
|----------|------|------|---------|
| No relationship found | 400 | PGRST200 | Could not find a relationship between '{parent}' and '{embed}' in the schema cache |
| Ambiguous relationship | 300 | PGRST201 | Could not embed because more than one relationship was found for '{parent}' and '{embed}' |
| Column not found in embed | 400 | PGRST204 | Column '{col}' does not exist in '{table}' |

PGRST200 uses HTTP 400 (matching PostgREST). PGRST201
uses HTTP 300 (matching PostgREST's "multiple choices"
semantics). The PGRST201 response includes a structured
`details` field — a JSON array of matching relationships
with `cardinality`, `embedding`, and `relationship` keys
— and a `hint` field suggesting the `!hint` syntax:

```json
{
  "code": "PGRST201",
  "message": "Could not embed because more than one relationship was found for 'orders' and 'addresses'",
  "details": [
    {
      "cardinality": "many-to-one",
      "embedding": "orders with addresses",
      "relationship": "orders_billing_address_id_fkey using orders(billing_address_id) and addresses(id)"
    },
    {
      "cardinality": "many-to-one",
      "embedding": "orders with addresses",
      "relationship": "orders_shipping_address_id_fkey using orders(shipping_address_id) and addresses(id)"
    }
  ],
  "hint": "Try changing 'addresses' to one of the following: 'addresses!orders_billing_address_id_fkey', 'addresses!orders_shipping_address_id_fkey'. Find the desired relationship in the 'details' key."
}
```

### Authorization on Embeds

Cedar authorization applies to each embedded table
independently. The handler builds authz filters per table
and the sql-builder injects them as additional WHERE
clauses inside the correlated subquery for that table.

A user who can read `orders` but not `customers` gets the
orders with the `customers` embed set to null (many-to-one)
or empty array (one-to-many). The authorization filter on
the child subquery excludes rows the user cannot see,
rather than failing the entire request.

### Prefer: return=representation with Embeds

After INSERT/UPDATE/DELETE with `Prefer: return=representation`,
if the original request included embeds, the handler
re-SELECTs the mutated rows using the same embedding
subqueries. This produces the nested response format
matching what a subsequent GET would return.

### supabase-js Compatibility

These queries must all produce correct results:

```javascript
// Many-to-one
supabase.from('orders').select('id, customers(name)')
// One-to-many
supabase.from('customers').select('id, orders(id, amount)')
// Wildcard
supabase.from('orders').select('*, customers(*)')
// Aliased embed
supabase.from('orders').select('id, buyer:customers(name)')
// Nested
supabase.from('orders').select('id, items(id, products(name))')
// Inner join
supabase.from('customers').select('id, orders!inner(id)')
// Disambiguation
supabase.from('orders').select(
  '*, billing:addresses!billing_address_id(*), '
  + 'shipping:addresses!shipping_address_id(*)')
```

## Technical Design

### Parsed Select Tree

`parseQuery()` currently returns
`select: ['id', 'customers(name)']` as a flat string array.
After this change, `select` becomes a tree of nodes:

```javascript
// select=id,amount,buyer:customers!cust_fk(name,email)
{
  select: [
    { type: 'column', name: 'id' },
    { type: 'column', name: 'amount' },
    {
      type: 'embed',
      name: 'customers',      // table name for resolution
      alias: 'buyer',         // JSON key (null if no alias)
      hint: 'cust_fk',        // disambiguation (null if none)
      inner: false,            // !inner flag
      select: [
        { type: 'column', name: 'name' },
        { type: 'column', name: 'email' },
      ],
    },
  ],
  // filters, order, limit, offset, onConflict unchanged
}
```

`*` is represented as `{ type: 'column', name: '*' }`.

Nested embeds are recursive: an embed node's `select`
array can contain further embed nodes.

### Select Parser Algorithm

The `select` parameter cannot be split on commas because
commas inside parentheses are part of the embed's column
list. The parser uses a character-level scan:

```
parseSelectList(input):
  nodes = []
  i = 0
  while i < input.length:
    token = scanToken(input, i)  // up to ',' or '(' or end
    if next char is '(':
      // This is an embed: parse alias, hint, inner
      // Recursively parse the parenthesized select list
      embed = parseEmbed(token, input, i)
      nodes.push(embed)
      i = embed.endIndex + 1     // skip past ')'
    else:
      nodes.push({ type: 'column', name: token.trim() })
    skip comma if present
  return nodes
```

Token scanning respects parenthesis nesting depth so that
`items(id,products(name))` is correctly parsed as a single
embed containing a nested embed. Leading/trailing spaces
on tokens are trimmed, since supabase-js may send
`select=id, customers(name)` with spaces after commas.

The alias/hint/inner parsing on the embed token follows
this grammar:

```
embed_token := [alias ":"] table_name ["!" hint] ["!inner"]
```

Examples:
- `customers` -> name=customers, alias=null, hint=null,
  inner=false
- `buyer:customers` -> name=customers, alias=buyer
- `customers!inner` -> name=customers, inner=true
- `addresses!billing_address_id` -> name=addresses,
  hint=billing_address_id
- `buyer:addresses!billing_fk!inner` -> name=addresses,
  alias=buyer, hint=billing_fk, inner=true

### FK Introspection Query

Add `FK_SQL` to `schema-cache.mjs` alongside `COLUMNS_SQL`
and `PK_SQL`:

```sql
SELECT
    con.conname AS constraint_name,
    c.relname AS from_table,
    array_agg(a.attname ORDER BY k.n) AS from_columns,
    fc.relname AS to_table,
    array_agg(fa.attname ORDER BY k.n) AS to_columns
FROM pg_catalog.pg_constraint con
JOIN pg_catalog.pg_class c
    ON c.oid = con.conrelid
JOIN pg_catalog.pg_namespace n
    ON n.oid = c.relnamespace
JOIN pg_catalog.pg_class fc
    ON fc.oid = con.confrelid
CROSS JOIN LATERAL unnest(con.conkey, con.confkey)
    WITH ORDINALITY AS k(col, fcol, n)
JOIN pg_catalog.pg_attribute a
    ON a.attrelid = c.oid AND a.attnum = k.col
JOIN pg_catalog.pg_attribute fa
    ON fa.attrelid = fc.oid AND fa.attnum = k.fcol
WHERE con.contype = 'f'
    AND n.nspname = 'public'
GROUP BY con.conname, c.relname, fc.relname
ORDER BY con.conname
```

This query joins `pg_constraint` (FK constraints) with
`pg_attribute` to resolve column names for both sides of
each foreign key. The `CROSS JOIN LATERAL unnest` with
`WITH ORDINALITY` handles composite FKs (multiple columns)
while preserving column order. Single-column FKs (the
common case) produce one-element arrays.

`pg_catalog` tables used: `pg_constraint`, `pg_class`,
`pg_namespace`, `pg_attribute`. All confirmed supported by
Aurora DSQL for `contype = 'p'` (primary keys) in the
existing `PK_SQL`. The FK query uses `contype = 'f'` on
the same tables. On DSQL, this query returns zero rows
(no FK constraints exist), which triggers the convention
fallback. The `CROSS JOIN LATERAL unnest` with
`WITH ORDINALITY` requires PostgreSQL 9.4+. DSQL support
for `LATERAL` is unconfirmed, but irrelevant since DSQL
has no FK constraints and the query returns zero rows
before reaching the LATERAL unnest. If DSQL rejects the
query syntax entirely, wrap the FK query in a try/catch
and treat any error as "zero relationships found."

### Convention-Based Fallback

When the FK query returns zero relationships, infer them
from column naming conventions. For each table A and each
column ending in `_id`:

1. Extract the base name: `customer_id` -> `customer`
2. Look for a table matching `base` or `base + 's'`:
   `customer` or `customers`
3. If a matching table B exists and has a primary key,
   check that B's PK column count is 1 (single-column PK)
4. Create a relationship:
   ```javascript
   {
     constraint: null,  // convention-based, no constraint
     fromTable: A,
     fromColumns: ['customer_id'],
     toTable: B,
     toColumns: [B's primary key column],
   }
   ```

Edge cases handled:
- `foo_id` with no `foo` or `foos` table: skip, no
  relationship created
- `id` column (no prefix before `_id`): skip
- `user_id` on a table that IS `users`: skip self-
  referencing convention matches (would need real FK
  or explicit hint)
- Table with composite PK: skip (convention only handles
  single-column PKs)
- Multiple `_id` columns pointing to the same table:
  each becomes a separate relationship (disambiguation
  required by the client)

### Cache Structure Addition

`pgIntrospect()` returns:

```javascript
{
  tables: { /* existing */ },
  relationships: [
    {
      constraint: 'orders_customer_id_fkey', // or null
      fromTable: 'orders',
      fromColumns: ['customer_id'],
      toTable: 'customers',
      toColumns: ['id'],
    },
    // ...
  ],
}
```

### Relationship Resolution

When the handler encounters embed nodes in the parsed
select tree, it resolves each embed to a relationship:

```javascript
function resolveRelationship(
    schema, parentTable, embedName, hint
) {
  const rels = schema.relationships.filter(r =>
    (r.fromTable === parentTable && r.toTable === embedName)
    || (r.toTable === parentTable && r.fromTable === embedName)
  );

  if (rels.length === 0) {
    throw new PostgRESTError(400, 'PGRST200',
      `Could not find a relationship between `
      + `'${parentTable}' and '${embedName}' `
      + `in the schema cache`);
  }

  if (hint) {
    const hinted = rels.filter(r =>
      r.constraint === hint
      || r.fromColumns.includes(hint)
      || r.toColumns.includes(hint)
    );
    if (hinted.length === 0) {
      throw new PostgRESTError(400, 'PGRST200',
        `Could not find a relationship between `
        + `'${parentTable}' and '${embedName}' `
        + `in the schema cache`);
    }
    if (hinted.length > 1) {
      throw new PostgRESTError(300, 'PGRST201',
        `Could not embed because more than one relationship `
        + `was found for '${parentTable}' and '${embedName}'`,
        hinted.map(r =>
          formatRelDetails(r, parentTable, embedName)),
        `Try using a more specific hint`);
    }
    return hinted[0];
  }

  if (rels.length > 1) {
    throw new PostgRESTError(300, 'PGRST201',
      `Could not embed because more than one relationship `
      + `was found for '${parentTable}' and '${embedName}'`,
      rels.map(r =>
        formatRelDetails(r, parentTable, embedName)),
      `Try changing '${embedName}' to one of the following: `
      + rels.map(r => `'${embedName}!${r.constraint
        || r.fromColumns[0]}'`).join(', ')
      + `. Find the desired relationship in the `
      + `'details' key.`);
  }

  return rels[0];
}
```

The `formatRelDetails` helper produces the structured
details matching PostgREST's PGRST201 format:

```javascript
function formatRelDetails(rel, parentTable, embedName) {
  const cardinality =
    rel.fromTable === parentTable
      ? 'many-to-one' : 'one-to-many';
  return {
    cardinality,
    embedding: `${parentTable} with ${embedName}`,
    relationship: `${rel.constraint || '(convention)'} `
      + `using ${rel.fromTable}(${rel.fromColumns.join(',')})`
      + ` and ${rel.toTable}(${rel.toColumns.join(',')})`,
  };
}
```

The relationship direction determines the embed type:
- `fromTable === parentTable` -> many-to-one (FK is on the
  parent, embed as object)
- `toTable === parentTable` -> one-to-many (FK is on the
  child, embed as array)

### SQL Generation: Correlated Subqueries

PostgREST itself uses `LEFT JOIN LATERAL` with
`row_to_json` (to-one) and `json_agg` (to-many) for
embedding. pgrest-lambda uses correlated scalar subqueries
instead, which produce identical results with simpler SQL
generation. The correlated subquery approach avoids the
complexity of managing LATERAL join aliases and ON TRUE
clauses, and PostgreSQL's query planner optimizes both
patterns similarly for the common single-FK case.

`buildSelect()` in `sql-builder.mjs` gains a new code path
when the parsed select tree contains embed nodes.

**Column list generation** changes from:

```javascript
const colList = cols.map(c => `"${c}"`).join(', ');
```

to a function that walks the select tree and produces both
column expressions and embed subquery expressions:

```javascript
function buildSelectExpressions(
    selectNodes, table, schema, relationships, values,
    authzFilters
) {
  const expressions = [];
  for (const node of selectNodes) {
    if (node.type === 'column') {
      if (node.name === '*') {
        const cols = Object.keys(
          schema.tables[table].columns);
        for (const c of cols) {
          expressions.push(`"${table}"."${c}"`);
        }
      } else {
        validateCol(schema, table, node.name);
        expressions.push(`"${table}"."${node.name}"`);
      }
    } else if (node.type === 'embed') {
      const rel = resolveRelationship(
        schema, table, node.name, node.hint);
      const alias = node.alias || node.name;
      const subquery = buildEmbedSubquery(
        node, rel, table, schema, relationships,
        values, authzFilters);
      expressions.push(`${subquery} AS "${alias}"`);
    }
  }
  return expressions;
}
```

**Many-to-one subquery** (FK on parent table):

```javascript
function buildManyToOneSubquery(
    embedNode, rel, parentTable, schema,
    relationships, values, authzFilters
) {
  const childTable = rel.toTable;
  const childCols = buildJsonBuildObject(
    embedNode.select, childTable, schema,
    relationships, values, authzFilters);
  const joinCond = rel.fromColumns.map((fc, i) =>
    `"${childTable}"."${rel.toColumns[i]}" = `
    + `"${parentTable}"."${fc}"`
  ).join(' AND ');

  let where = joinCond;
  const childAuthz = authzFilters?.[childTable];
  if (childAuthz?.conditions?.length > 0) {
    where += ' AND ' + childAuthz.conditions.join(' AND ');
    values.push(...childAuthz.values);
  }

  return `(SELECT json_build_object(${childCols})`
    + ` FROM "${childTable}" WHERE ${where})`;
}
```

**One-to-many subquery** (FK on child table):

```javascript
function buildOneToManySubquery(
    embedNode, rel, parentTable, schema,
    relationships, values, authzFilters
) {
  const childTable = rel.fromTable;
  const childCols = buildJsonBuildObject(
    embedNode.select, childTable, schema,
    relationships, values, authzFilters);
  const joinCond = rel.fromColumns.map((fc, i) =>
    `"${childTable}"."${fc}" = `
    + `"${parentTable}"."${rel.toColumns[i]}"`
  ).join(' AND ');

  let where = joinCond;
  const childAuthz = authzFilters?.[childTable];
  if (childAuthz?.conditions?.length > 0) {
    where += ' AND ' + childAuthz.conditions.join(' AND ');
    values.push(...childAuthz.values);
  }

  return `COALESCE((SELECT json_agg(json_build_object(`
    + `${childCols})) FROM "${childTable}" WHERE ${where})`
    + `, '[]'::json)`;
}
```

**json_build_object generation** walks the embed's select
list recursively:

```javascript
function buildJsonBuildObject(
    selectNodes, table, schema, relationships, values,
    authzFilters
) {
  const pairs = [];
  for (const node of selectNodes) {
    if (node.type === 'column') {
      if (node.name === '*') {
        for (const c of Object.keys(
          schema.tables[table].columns)) {
          pairs.push(
            `'${c}', "${table}"."${c}"`);
        }
      } else {
        validateCol(schema, table, node.name);
        pairs.push(
          `'${node.name}', "${table}"."${node.name}"`);
      }
    } else if (node.type === 'embed') {
      const rel = resolveRelationship(
        schema, table, node.name, node.hint);
      const alias = node.alias || node.name;
      const subquery = buildEmbedSubquery(
        node, rel, table, schema, relationships,
        values, authzFilters);
      pairs.push(`'${alias}', ${subquery}`);
    }
  }
  return pairs.join(', ');
}
```

This recursion handles nested embeds naturally: a
`json_build_object` pair can be another correlated subquery.

### Inner Join SQL Generation

When `node.inner` is true, the sql-builder adds an
additional condition to the parent WHERE clause:

**One-to-many inner:**
```sql
EXISTS (SELECT 1 FROM "orders"
  WHERE "orders"."customer_id" = "customers"."id")
```

**Many-to-one inner:**
```sql
"orders"."customer_id" IS NOT NULL
```

These conditions are collected during select expression
building and appended to the parent WHERE clause alongside
user filters and Cedar authz conditions.

### Table-Qualified Column Names

To avoid ambiguity between parent column names and
subquery column names, `buildSelect()` table-qualifies
all parent columns:

```sql
-- Before (flat query):
SELECT "id", "amount" FROM "orders"

-- After (with embeds):
SELECT "orders"."id", "orders"."amount",
  (SELECT ...) AS "customers"
FROM "orders"
```

When embeds are present in the select tree, all column
references in the parent SELECT list and WHERE/ORDER BY
clauses are prefixed with `"tableName".`. When no embeds
are present, the existing unqualified format is preserved
for backward compatibility.

### Handler Changes

`handler.mjs` changes for embed support:

1. **Detect embeds**: After `parseQuery()`, check if the
   select tree contains any embed nodes.

2. **Build authz per table**: For each unique table
   referenced in the select tree (parent + all embedded
   tables), build Cedar authz filters:
   ```javascript
   const authzFilters = {};
   const tables = collectTables(parsed.select, table);
   for (const t of tables) {
     authzFilters[t] = cedar.buildAuthzFilter({
       principal, action: 'select',
       context: { table: t }, schema,
       startParam: nextParam,
     });
     nextParam += authzFilters[t].values.length;
   }
   ```

3. **Pass to sql-builder**: The authz filters map is
   passed to `buildSelect()` which distributes conditions
   to the correct subquery scope.

4. **return=representation with embeds**: For POST, PATCH,
   DELETE with `Prefer: return=representation` and embeds
   in the select, execute the mutation first (INSERT,
   UPDATE, DELETE with RETURNING *), then re-SELECT the
   returned rows with embedding subqueries. Use the
   primary key values from the mutation result to filter
   the re-SELECT.

### Error Codes Addition

Add to `errors.mjs`:

No new error class needed. `PostgRESTError` already
supports arbitrary codes. The new codes:

- `PGRST200` — relationship not found (HTTP 400)
- `PGRST201` — ambiguous relationship (HTTP 300)

These are used by the relationship resolver in the handler
and sql-builder, not as constants in errors.mjs. However,
for discoverability, add comments documenting them.

## Code Architecture / File Changes

| File | Action | Lines | Description |
|------|--------|-------|-------------|
| `src/rest/query-parser.mjs` | Modify | ~80 added | Replace comma-split with parenthesis-aware parser; produce select tree |
| `src/rest/schema-cache.mjs` | Modify | ~60 added | FK_SQL query, convention fallback, relationships in cache |
| `src/rest/sql-builder.mjs` | Modify | ~150 added | Correlated subqueries for embeds, json_build_object/json_agg, inner join conditions, table-qualified columns |
| `src/rest/handler.mjs` | Modify | ~60 added | Resolve relationships, build per-table authz, return=representation re-SELECT |
| `src/rest/errors.mjs` | Modify | ~5 added | Document PGRST200, PGRST201 error codes |

**Files that do NOT change:**
- `src/rest/db.mjs` — database layer unchanged
- `src/rest/router.mjs` — no new routes
- `src/rest/openapi.mjs` — OpenAPI embed docs deferred
- `src/rest/response.mjs` — response formatting unchanged
- `src/auth/**` — no auth changes
- `src/authorizer/**` — no authorizer changes

**No new files. No new npm dependencies.**

## Testing Strategy

### Unit Tests: query-parser.mjs

**Basic embed parsing:**
- `select=id,customers(name)` -> column `id` + embed
  `customers` with column `name`
- `select=*,customers(*)` -> wildcard column + embed
  `customers` with wildcard
- `select=id,amount,customers(name,email)` -> two columns
  + embed with two columns

**Alias parsing:**
- `select=id,buyer:customers(name)` -> embed with
  name=customers, alias=buyer

**Hint parsing:**
- `select=*,addresses!billing_address_id(*)` -> embed
  with name=addresses, hint=billing_address_id

**Inner parsing:**
- `select=id,orders!inner(id)` -> embed with inner=true
- `select=id,addresses!billing_fk!inner(*)` -> hint +
  inner

**Nested embeds:**
- `select=id,items(id,products(name))` -> embed `items`
  containing nested embed `products`
- `select=*,films(title,actors(*))` -> wildcard parent,
  embed with nested wildcard embed

**Mixed columns and embeds:**
- `select=id,customers(name),amount,items(id)` -> columns
  and embeds intermixed

**Backward compatibility:**
- `select=id,name` -> flat column list (no embeds),
  same behavior as before
- `select=*` -> wildcard, same behavior as before
- No `select` param -> defaults to `['*']`

**Space handling:**
- `select=id, customers(name, email)` -> same result as
  `select=id,customers(name,email)` (spaces trimmed)

**Edge cases:**
- `select=id,customers(name,addresses(city,zip))`
  -> 3-level nesting
- Empty embed: `select=id,customers()` -> embed with
  empty select list (should error or default to `*`;
  follow PostgREST behavior of erroring)

### Unit Tests: schema-cache.mjs

**FK introspection:**
- Mock `pool.query` to return FK rows; verify
  `relationships` array has correct structure
- FK query returns zero rows -> relationships is empty
  array

**Convention fallback:**
- Tables: `orders` (has `customer_id`), `customers`
  (PK: `id`) -> infer relationship
- `foo_id` column but no `foo` or `foos` table -> no
  relationship created
- `user_id` on `users` table -> skip self-reference
- Table with composite PK -> skip
- Column `id` (no prefix) -> skip
- Fallback only runs when FK query returns zero
  relationships

**Cache integration:**
- Relationships are included in cached schema
- Refresh reloads relationships
- TTL applies to relationships same as tables

### Unit Tests: sql-builder.mjs

**Many-to-one subquery:**
- Given: orders table with customer_id FK to customers
- Input: `select=id,customers(name)`
- Expected SQL:
  ```sql
  SELECT "orders"."id",
    (SELECT json_build_object('name', "customers"."name")
     FROM "customers"
     WHERE "customers"."id" = "orders"."customer_id")
    AS "customers"
  FROM "orders"
  ```

**One-to-many subquery:**
- Given: customers table, orders has customer_id FK
- Input from customers: `select=id,orders(id,amount)`
- Expected SQL:
  ```sql
  SELECT "customers"."id",
    COALESCE(
      (SELECT json_agg(json_build_object(
        'id', "orders"."id",
        'amount', "orders"."amount"))
       FROM "orders"
       WHERE "orders"."customer_id" = "customers"."id"),
      '[]'::json) AS "orders"
  FROM "customers"
  ```

**Wildcard expansion:**
- `select=*,customers(*)` expands both parent and child
  wildcards to their respective table columns

**Aliased embed:**
- `select=id,buyer:customers(name)` -> subquery uses
  `AS "buyer"` not `AS "customers"`

**Nested embed:**
- `select=id,items(id,products(name))` -> nested
  correlated subquery inside json_build_object

**Inner join — one-to-many:**
- `select=id,orders!inner(id)` from customers ->
  parent WHERE includes EXISTS subquery

**Inner join — many-to-one:**
- `select=id,customers!inner(name)` from orders ->
  parent WHERE includes `"orders"."customer_id" IS NOT NULL`

**Table-qualified columns:**
- When embeds are present, parent columns are
  `"table"."col"` not just `"col"`

**Filters still work:**
- `select=id,customers(name)&amount=gt.50` -> parent
  WHERE includes filter condition alongside any inner
  join conditions

**Authz integration:**
- Authz conditions for child table are injected into
  the child subquery's WHERE clause
- Authz conditions for parent table remain in the
  parent WHERE clause

**No embeds — backward compatible:**
- `select=id,name` -> generates same SQL as before
  (unqualified columns, no subqueries)

> Warning: SQL output assertions should normalize
> whitespace before comparison. The exact formatting
> (newlines, indentation) is not significant.

### Integration Tests: PostgreSQL with Real FKs

Setup: create `customers`, `orders`, `items`, `products`,
`addresses` tables with proper FK constraints. Seed data.

- Many-to-one: GET /rest/v1/orders?select=id,customers(name)
  -> each order has customer object
- One-to-many: GET /rest/v1/customers?select=id,orders(id)
  -> each customer has orders array
- Empty array: customer with no orders -> `orders: []`
- Null object: order with null customer_id -> `customers: null`
- Nested: GET /rest/v1/orders?select=id,items(id,products(name))
- Aliased: GET /rest/v1/orders?select=id,buyer:customers(name)
- Inner join: GET /rest/v1/customers?select=id,orders!inner(id)
  -> only customers with orders
- Disambiguation: two FKs to addresses, use !hint
- Error: unknown embed -> PGRST200
- Error: ambiguous embed without hint -> PGRST201

### Integration Tests: DSQL with Convention Fallback

Same test cases as above, but on DSQL (no FK constraints).
Verify the convention-based fallback produces correct
relationships and the queries return identical results.

Key DSQL-specific checks:
- FK query returns zero rows
- Convention fallback creates relationships
- `json_build_object` and `json_agg` work on DSQL
- `COALESCE(..., '[]'::json)` works on DSQL

### supabase-js End-to-End Tests

Run against a real PostgreSQL instance with supabase-js
client:

```javascript
// Many-to-one
const { data } = await supabase
  .from('orders').select('id, customers(name)');
assert(data[0].customers.name === 'Alice');

// One-to-many
const { data } = await supabase
  .from('customers').select('id, orders(id, amount)');
assert(Array.isArray(data[0].orders));

// Wildcard
const { data } = await supabase
  .from('orders').select('*, customers(*)');
assert(data[0].customers !== undefined);

// Aliased embed
const { data } = await supabase
  .from('orders').select('id, buyer:customers(name)');
assert(data[0].buyer.name === 'Alice');

// Nested
const { data } = await supabase
  .from('orders').select('id, items(id, products(name))');
assert(data[0].items[0].products.name === 'Widget');

// Inner join
const { data } = await supabase
  .from('customers').select('id, orders!inner(id)');
assert(data.every(c => c.orders.length > 0));

// Disambiguation
const { data } = await supabase
  .from('orders').select(
    '*, billing:addresses!billing_address_id(*), '
    + 'shipping:addresses!shipping_address_id(*)');
assert(data[0].billing !== undefined);
assert(data[0].shipping !== undefined);
```

> Warning: supabase-js sends `select` as a query
> parameter with spaces stripped. Verify the parser
> handles both `select=id,customers(name)` and
> `select=id, customers(name)` (with spaces).

## Implementation Order

### Phase 1: Select Parser

1. Rewrite `parseQuery()` select parsing in
   `query-parser.mjs` to produce a select tree instead
   of a flat string array.
2. Ensure backward compatibility: when no parentheses
   are present, the select tree contains only column
   nodes, and downstream code works unchanged.
3. Unit tests for all parsing cases.

### Phase 2: Relationship Discovery

4. Add `FK_SQL` to `schema-cache.mjs` and include it in
   `pgIntrospect()`.
5. Implement convention-based fallback in `pgIntrospect()`.
6. Add `relationships` field to cache structure.
7. Export `getRelationships()` helper.
8. Unit tests for FK introspection and convention fallback.

### Phase 3: SQL Generation

9. Add `buildEmbedSubquery()`,
   `buildManyToOneSubquery()`,
   `buildOneToManySubquery()`, and
   `buildJsonBuildObject()` to `sql-builder.mjs`.
10. Modify `buildSelectExpressions()` to walk the select
    tree and produce subqueries for embed nodes.
11. Add inner join condition collection and injection
    into parent WHERE.
12. Table-qualify parent columns when embeds are present.
13. Unit tests for generated SQL.

### Phase 4: Handler Integration

14. Add relationship resolution to `handler.mjs`.
15. Build Cedar authz filters per embedded table.
16. Pass authz filters map and relationships to
    `buildSelect()`.
17. Implement return=representation re-SELECT for
    mutations with embeds.
18. Add PGRST200 and PGRST201 error documentation to
    `errors.mjs`.
19. Integration tests against PostgreSQL.

### Phase 5: DSQL Validation

20. Run integration tests against DSQL.
21. Verify convention fallback produces correct
    relationships.
22. Verify `json_build_object` and `json_agg` work
    on DSQL.

### Phase 6: supabase-js Compatibility

23. Run all 7 supabase-js test cases.
24. Fix any wire-format discrepancies.

## Open Questions

1. **Filters on embedded resources.** PostgREST supports
   `&orders.amount=gt.100` to filter rows inside an embed.
   This requires parsing dot-prefixed filter keys and
   injecting WHERE conditions into the child subquery.
   **Recommendation:** Defer to a follow-up. The core
   embedding (relationship resolution + subquery
   generation) is self-contained without embed filters.

2. **Ordering on embedded resources.** PostgREST supports
   `&orders.order=amount.desc` to order rows inside a
   one-to-many embed. This adds ORDER BY inside the
   `json_agg` subquery. **Recommendation:** Defer to the
   same follow-up as embed filters.

3. **Spread embeds.** PostgREST supports
   `select=id,...customers(name)` (spread operator) to
   flatten the embed's columns into the parent. This is
   less commonly used. **Recommendation:** Defer.

4. **Authorization deny behavior.** When a user cannot
   read an embedded table, should the embed be null/empty
   (silent exclusion) or should the request fail with 403?
   PostgREST uses database-level RLS which silently
   excludes rows. The current design follows this pattern
   (silent exclusion via Cedar WHERE filters). This is
   the safer default for supabase-js compatibility.

5. **Convention fallback ambiguity.** If a table has both
   `customer_id` and `customers_id` columns, the
   convention fallback would create two relationships to
   `customers`. This is unlikely but possible.
   **Recommendation:** Document it as a known limitation.
   Users should use `!hint` to disambiguate or add real
   FK constraints.

6. **Performance with deeply nested embeds.** Three or
   more levels of nesting produce deeply nested correlated
   subqueries. PostgreSQL's query planner handles this but
   performance degrades with depth. **Recommendation:** No
   artificial depth limit. Document that performance
   degrades with nesting depth and recommend keeping
   embeds to 1-2 levels for latency-sensitive queries.
