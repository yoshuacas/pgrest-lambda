# Embedded Resource Filtering

## Overview

Add PostgREST-compatible filtering on embedded resources so
that `?select=*,customers(*)&customers.name=eq.Alice`
correctly filters the embedded customers subquery. Today,
resource embedding works — FK joins produce nested JSON —
but dotted filter keys like `customers.name` are treated as
parent column names, causing PGRST204 ("Column
'customers.name' does not exist in 'orders'").

This is the next gap for supabase-js wire compatibility
after resource embedding itself. Any `.eq()` call with a
dotted column (e.g., `.eq('customers.name', 'Alice')`)
produces a `customers.name=eq.Alice` query parameter that
the server must route to the embed subquery.

The implementation modifies ~140 lines across two existing
files. No new files, no new npm dependencies. Standard
parameterized subqueries work identically on Postgres and
DSQL; no capability flag is needed.

Depends on: resource embedding (shipped), select aliases
(shipped), logical operators (shipped), db-capabilities
(shipped).

## Current CX / Concepts

### Dotted Filter Keys Treated as Column Names

`parseQuery()` in `query-parser.mjs` treats every
non-reserved query parameter key as a column name on the
parent table. When a client sends
`?customers.name=eq.Alice`, the parser calls
`parseFilter('customers.name', 'eq.Alice')`, which
produces `{ column: 'customers.name', operator: 'eq',
value: 'Alice' }`. The sql-builder then calls
`hasColumn(schema, 'orders', 'customers.name')` which
throws PGRST204.

### No Embed Filter Routing

There is no mechanism to route a filter to an embedded
table's subquery. The `parseQuery()` return value has a
single `filters` array for the parent table. Embed
subqueries receive only the join condition and Cedar
authorization filters.

### Embed Subquery WHERE: Join + Authz Only

Today, `buildManyToOneSubquery()` and
`buildOneToManySubquery()` in `sql-builder.mjs` build
WHERE clauses with:

1. The join condition (FK column match)
2. Cedar authorization filters (via `authzFilters`)

There is no injection point for user-specified filters
on the embedded table.

### !inner Without Filters

The `!inner` flag adds a parent WHERE condition to
exclude rows without matching children:

- Many-to-one: `"orders"."customer_id" IS NOT NULL`
- One-to-many: `EXISTS (SELECT 1 FROM "orders" ...)`

These conditions do not include any user-specified
filter on the embedded table.

## Proposed CX / CX Specification

### Dot Notation for Embed Filters

Clients filter on embedded tables using dot-prefixed
query parameters, matching PostgREST:

```
# Filter embedded customers by name
GET /rest/v1/orders?select=*,customers(*)
    &customers.name=eq.Alice

# Multiple filters on same embed (AND-joined)
GET /rest/v1/orders?select=*,customers(*)
    &customers.name=eq.Alice&customers.status=eq.active

# Filter with embed alias
GET /rest/v1/orders?select=*,buyer:customers(*)
    &buyer.name=eq.Alice

# Filter with FK disambiguation alias
GET /rest/v1/orders
    ?select=*,billing:addresses!billing_address_id(*)
    &billing.city=eq.Austin

# !inner + filter: only orders whose customer is Alice
GET /rest/v1/orders?select=*,customers!inner(*)
    &customers.name=eq.Alice

# Logical operators on embedded table
GET /rest/v1/orders?select=*,customers(*)
    &customers.or=(name.eq.Alice,status.eq.active)
```

### supabase-js Mapping

```javascript
// .eq() with dotted column → embed filter
await supabase.from('orders')
  .select('*, customers(*)')
  .eq('customers.name', 'Alice');
// → GET ?select=*,customers(*)&customers.name=eq.Alice

// Alias: .eq() references the alias, not the table
await supabase.from('orders')
  .select('*, buyer:customers(*)')
  .eq('buyer.name', 'Alice');
// → GET ?select=*,buyer:customers(*)&buyer.name=eq.Alice

// FK disambiguation
await supabase.from('orders')
  .select('*, billing:addresses!billing_address_id(*)')
  .eq('billing.city', 'Austin');
// → billing.city=eq.Austin

// !inner + filter
await supabase.from('orders')
  .select('*, customers!inner(*)')
  .eq('customers.name', 'Alice');
// → &customers.name=eq.Alice

// .or() on embed
await supabase.from('orders')
  .select('*, customers(*)')
  .or('name.eq.Alice,status.eq.active',
      { foreignTable: 'customers' });
// → &customers.or=(name.eq.Alice,status.eq.active)
```

### Response Format

Embed filters affect which rows appear in the nested
JSON, not which parent rows are returned (unless
`!inner` is used):

**Many-to-one with filter:**

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

Order ord-2 has a customer (Bob), but Bob does not match
the filter `name=eq.Alice`. The many-to-one subquery
returns no row, producing `null` — the same behavior as
an order with no customer_id.

**One-to-many with filter:**

```json
[
  {
    "id": "cust-1",
    "orders": [
      { "id": "ord-1", "amount": 99.00 }
    ]
  },
  {
    "id": "cust-2",
    "orders": []
  }
]
```

Customer cust-2 has orders, but none match the filter.
The one-to-many subquery returns an empty array.

### !inner + Filter Interaction

When `!inner` is combined with embed filters, parent
rows whose embed produces zero matches are excluded:

```
GET /rest/v1/orders?select=*,customers!inner(*)
    &customers.name=eq.Alice
```

```json
[
  {
    "id": "ord-1",
    "amount": 99.00,
    "customers": { "name": "Alice" }
  }
]
```

Order ord-2 (customer is Bob) is excluded because the
filtered embed produces no match. This matches PostgREST
behavior: `!inner` + filter acts as a join filter on the
parent.

### Alias Resolution

The dotted prefix references the embed's output key
(alias if present, otherwise table name):

| Select | Filter key | Resolves to |
|--------|-----------|-------------|
| `customers(*)` | `customers.name` | `customers.name` |
| `buyer:customers(*)` | `buyer.name` | `customers.name` |
| `billing:addresses!billing_fk(*)` | `billing.city` | `addresses.city` |

The parser builds an alias map from the select tree.
If a filter uses `customers.name` but the select has
`buyer:customers(*)`, the filter is rejected — the
user must use the alias `buyer.name`.

### Logical Operators on Embeds

Logical operators are supported as embed-prefixed
params:

```
# OR on embed columns
&customers.or=(name.eq.Alice,status.eq.active)

# AND on embed columns (explicit)
&customers.and=(age.gte.18,age.lte.65)

# Negated logical operator on embed
&customers.not.or=(status.eq.cancelled,status.eq.refunded)
```

These are parsed the same way as top-level logical
operators (existing `parseLogicalGroup` function) and
attached to the embed node's filter list.

Note: PostgREST documents `embed.or=(...)` syntax but
does not show examples of `embed.not.or=(...)`. The
parser handles it by applying the same `not.` prefix
logic used at the top level. If PostgREST does not
support this, no harm — it is a strict superset.

### Embed Order and Limit (Parser Recognition Only)

The parser recognizes `{embed}.order`,
`{embed}.limit`, and `{embed}.offset` parameters and
stores them on the embed node:

```
&orders.order=amount.desc
&orders.limit=5
&orders.offset=10
```

The SQL builder does **not** implement these in this
loop. They are stored on the embed node for a follow-up.
The parser recognizes them so they are not misrouted as
embed filters (which would fail column validation on
`order`/`limit`/`offset`).

### Validation Rules

1. **The filter prefix must match an embed in the select
   tree.** If `foo.bar=eq.1` is provided but no embed
   named `foo` (or aliased as `foo`) exists in the
   top-level select list, reject with PGRST100.

2. **One level of dot nesting only.** PostgREST supports
   nested embed filtering (e.g.,
   `roles.actors.first_name=like.*Tom*`) but
   pgrest-lambda defers this. After splitting the key
   into prefix and remainder, if the remainder contains
   a dot and is not a recognized directive (`order`,
   `limit`, `offset`, `or`, `and`, `not.or`,
   `not.and`), reject with PGRST100.

3. **Embed filter columns are validated against the
   embedded table's schema.** If `customers.bad_col=eq.1`
   is provided and `bad_col` does not exist in the
   `customers` table, throw PGRST204.

4. **Multiple filters on the same embed are AND-joined.**
   `&customers.name=eq.Alice&customers.status=eq.active`
   produces two conditions in the embed subquery's WHERE
   clause, joined with AND.

5. **Embed filters do not affect parent row count.**
   Parent rows are not excluded by embed filters unless
   `!inner` is used. The `buildCount` query for
   `Prefer: count=exact` reflects parent-level filters
   only (pre-existing limitation for `!inner`).

6. **Embed filter columns are unqualified in the
   subquery.** Since each embed subquery has a single
   table in its FROM clause, unqualified column
   references resolve correctly via SQL scoping.

### Error Messages

| Scenario | HTTP | Code | Message |
|----------|------|------|---------|
| Unknown embed prefix | 400 | PGRST100 | "Cannot filter on '{prefix}.{column}' -- no embed named '{prefix}' in select" |
| Nested embed filter | 400 | PGRST100 | "Filter nesting deeper than one level is not supported: '{key}'" |
| Bad column in embed filter | 400 | PGRST204 | "Column '{col}' does not exist in '{table}'" |

Note: PostgREST uses PGRST108 for the "unknown embed
prefix" error. pgrest-lambda uses PGRST100 because
the existing error catalog groups all parse/validation
errors under PGRST100. A future alignment pass could
add PGRST108 for parity.

### supabase-js Compatibility

These queries must produce correct results:

```javascript
// Basic embed filter
const { data } = await supabase
  .from('orders').select('*, customers(*)')
  .eq('customers.name', 'Alice');
assert(data.every(o =>
  o.customers === null
  || o.customers.name === 'Alice'));

// Aliased embed filter
const { data } = await supabase
  .from('orders')
  .select('*, buyer:customers(*)')
  .eq('buyer.name', 'Alice');
assert(data.every(o =>
  o.buyer === null || o.buyer.name === 'Alice'));

// !inner + filter
const { data } = await supabase
  .from('orders')
  .select('*, customers!inner(*)')
  .eq('customers.name', 'Alice');
assert(data.every(o =>
  o.customers.name === 'Alice'));

// Multiple filters on same embed
const { data } = await supabase
  .from('orders').select('*, customers(*)')
  .eq('customers.name', 'Alice')
  .eq('customers.status', 'active');
assert(data.every(o =>
  o.customers === null
  || (o.customers.name === 'Alice'
      && o.customers.status === 'active')));

// Logical operator on embed
const { data } = await supabase
  .from('orders').select('*, customers(*)')
  .or('name.eq.Alice,status.eq.active',
      { foreignTable: 'customers' });
assert(data.every(o =>
  o.customers === null
  || o.customers.name === 'Alice'
  || o.customers.status === 'active'));

// FK disambiguation + filter
const { data } = await supabase
  .from('orders').select(
    '*, billing:addresses!billing_address_id(*)')
  .eq('billing.city', 'Austin');
assert(data.every(o =>
  o.billing === null
  || o.billing.city === 'Austin'));
```

## Technical Design

### Parsed Embed Node: New Fields

Embed nodes in the select tree gain three new fields,
initialized to defaults by `parseSelectList` and
populated by `parseQuery`:

```javascript
{
  type: 'embed',
  name: 'customers',
  alias: 'buyer',
  hint: null,
  inner: false,
  select: [...],
  filters: [],    // NEW: embed filter conditions
  order: [],      // NEW: embed order (parser only)
  limit: null,    // NEW: embed limit (parser only)
}
```

The `filters` array contains the same `{ type: 'filter',
... }` and `{ type: 'logicalGroup', ... }` objects as the
top-level `parsed.filters`. The existing
`buildFilterConditions()` function processes them.

### Embed Alias Map

After parsing the select tree, `parseQuery` builds a
Map from output key to embed node for the top-level
select list only (nested embeds are not mapped):

```javascript
function buildEmbedAliasMap(selectNodes) {
  const map = new Map();
  for (const node of selectNodes) {
    if (node.type === 'embed') {
      const key = node.alias || node.name;
      map.set(key, node);
    }
  }
  return map;
}
```

This map is used during param iteration to detect
embed-prefixed keys and route them to the correct
embed node.

### Parser: Param Routing Algorithm

In `parseQuery()`, after the existing reserved-param
and logical-operator checks, add embed-prefix detection:

```javascript
// After top-level logical op handling:

const dotIdx = key.indexOf('.');
if (dotIdx !== -1) {
  const prefix = key.slice(0, dotIdx);
  const rest = key.slice(dotIdx + 1);
  const embedNode = embedMap.get(prefix);
  if (embedNode) {
    routeEmbedParam(embedNode, prefix, rest, rawValue);
    continue;
  }
}

// Fall through to regular filter
filters.push(parseFilter(key, rawValue));
```

The `routeEmbedParam` helper classifies the remainder:

```javascript
function routeEmbedParam(
    embedNode, prefix, rest, rawValue
) {
  // Embed order directive
  if (rest === 'order') {
    embedNode.order = parseOrder(rawValue);
    return;
  }

  // Embed limit directive
  if (rest === 'limit') {
    embedNode.limit = parseInt(rawValue, 10);
    return;
  }

  // Embed offset directive
  if (rest === 'offset') {
    embedNode.offset = parseInt(rawValue, 10);
    return;
  }

  // Embed logical operator
  let logicalOp = null;
  let negate = false;
  if (LOGICAL_OPS.has(rest)) {
    logicalOp = rest;
  } else if (rest.startsWith('not.')) {
    const sub = rest.slice(4);
    if (LOGICAL_OPS.has(sub)) {
      logicalOp = sub;
      negate = true;
    }
  }
  if (logicalOp) {
    embedNode.filters.push(
      parseLogicalGroup(logicalOp, negate, rawValue));
    return;
  }

  // Reject nested embed filter (dot in remainder)
  if (rest.includes('.')) {
    throw new PostgRESTError(400, 'PGRST100',
      `Filter nesting deeper than one level is `
      + `not supported: '${prefix}.${rest}'`);
  }

  // Embed filter
  embedNode.filters.push(
    parseFilter(rest, rawValue));
}
```

**Precedence:** Top-level `not.or`/`not.and` are
checked before embed prefix detection. A top-level
`not.or=(...)` is never misrouted as an embed filter
on an embed named `not`. If a table is literally named
`not`, embed filters on it require an alias.

**Unknown prefix:** If a dotted key's prefix does not
match any embed alias and is not a top-level logical
operator, it falls through to `parseFilter`. The full
dotted key (`customers.name`) is treated as a column
name on the parent table, producing PGRST204 — the
same behavior as today. This means we don't throw the
dedicated PGRST100 "no embed named" error unless the
prefix matches zero embeds. To throw the dedicated
error, we check against the full set of embed
table names (not just aliases):

```javascript
if (dotIdx !== -1) {
  const prefix = key.slice(0, dotIdx);
  const rest = key.slice(dotIdx + 1);
  const embedNode = embedMap.get(prefix);
  if (embedNode) {
    routeEmbedParam(embedNode, prefix, rest, rawValue);
    continue;
  }
  // Check if prefix looks like an embed reference
  // but doesn't match any alias
  if (hasAnyEmbed(select) && !LOGICAL_OPS.has(prefix)
      && prefix !== 'not') {
    throw new PostgRESTError(400, 'PGRST100',
      `Cannot filter on '${key}' -- no embed `
      + `named '${prefix}' in select`);
  }
}
```

The `hasAnyEmbed` guard ensures we only throw the
embed-specific error when embeds are present in the
select tree. Without embeds, dotted keys fall through
to the existing PGRST204 path (in case someone has
dotted column names or just a bad filter key).

### SQL Builder: Embed Filter Injection

#### `buildManyToOneSubquery()` Changes

After the join condition and before authz, inject
embed filter conditions:

```javascript
function buildManyToOneSubquery(
    node, rel, parentTable, schema, values,
    authzFilters
) {
  const childTable = rel.toTable;
  const childCols = buildJsonBuildObject(
    node.select, childTable, schema, values,
    authzFilters);
  const joinCond = rel.fromColumns.map((fc, i) =>
    `"${childTable}"."${rel.toColumns[i]}" = `
    + `"${parentTable}"."${fc}"`
  ).join(' AND ');

  let where = joinCond;

  // NEW: embed user filters
  if (node.filters?.length > 0) {
    const childValidator = (col) =>
      validateCol(schema, childTable, col);
    const filterConds = buildFilterConditions(
      node.filters, values, childValidator);
    where += ' AND ' + filterConds.join(' AND ');
  }

  // Existing: authz filters
  const childAuthz = authzFilters?.[childTable];
  if (childAuthz?.conditions?.length > 0) {
    const renumbered = renumberConditions(
      childAuthz.conditions, values.length + 1);
    where += ' AND ' + renumbered.join(' AND ');
    values.push(...childAuthz.values);
  }

  return `(SELECT json_build_object(${childCols})`
    + ` FROM "${childTable}" WHERE ${where})`;
}
```

The same pattern applies to `buildOneToManySubquery()`.

`buildFilterConditions()` pushes values into the shared
`values` array and returns SQL condition strings with
correct `$N` references. No changes to
`buildFilterConditions` are needed — it already handles
both `{ type: 'filter' }` and
`{ type: 'logicalGroup' }` objects.

Embed filter columns are unqualified in the generated
SQL (e.g., `"name" = $1` not `"customers"."name" = $1`).
This is correct because the embed subquery's FROM clause
references only the child table — SQL scoping resolves
the column unambiguously.

#### `buildSelect()`: !inner + Filter

When an embed has both `!inner` and filters, the inner
join condition in the parent WHERE must include the
embed filter to exclude parent rows whose embed produces
zero matches.

**Many-to-one inner + filter:** Replace the
`IS NOT NULL` shortcut with an `EXISTS` subquery that
includes the filter:

```javascript
if (node.inner) {
  if (rel.fromTable === table) {
    if (node.filters?.length > 0) {
      const childTable = rel.toTable;
      const existsCond = rel.fromColumns.map((fc, i) =>
        `"${childTable}"."${rel.toColumns[i]}" = `
        + `"${table}"."${fc}"`
      ).join(' AND ');
      const childValidator = (col) =>
        validateCol(schema, childTable, col);
      const filterConds = buildFilterConditions(
        node.filters, values, childValidator);
      innerJoinConds.push(
        `EXISTS (SELECT 1 FROM "${childTable}"`
        + ` WHERE ${existsCond}`
        + ` AND ${filterConds.join(' AND ')})`);
    } else {
      // No filters: use simpler IS NOT NULL
      innerJoinConds.push(
        rel.fromColumns.map(fc =>
          `"${table}"."${fc}" IS NOT NULL`
        ).join(' AND '));
    }
  } else {
    // one-to-many: include filters in EXISTS
    const existsCond = rel.fromColumns.map((fc, i) =>
      `"${rel.fromTable}"."${fc}" = `
      + `"${table}"."${rel.toColumns[i]}"`
    ).join(' AND ');
    let existsWhere = existsCond;
    if (node.filters?.length > 0) {
      const childValidator = (col) =>
        validateCol(schema, rel.fromTable, col);
      const filterConds = buildFilterConditions(
        node.filters, values, childValidator);
      existsWhere += ' AND '
        + filterConds.join(' AND ');
    }
    innerJoinConds.push(
      `EXISTS (SELECT 1 FROM "${rel.fromTable}"`
      + ` WHERE ${existsWhere})`);
  }
}
```

**Parameter duplication:** The embed filter values are
pushed to the `values` array twice — once in the embed
subquery (via `buildManyToOneSubquery`) and once in the
inner join EXISTS condition. Each gets its own `$N`
references. This is correct standard SQL.

Example for `?select=*,customers!inner(*)
    &customers.name=eq.Alice`:

```sql
SELECT "orders"."id",
  (SELECT json_build_object('name', "customers"."name")
   FROM "customers"
   WHERE "customers"."id" = "orders"."customer_id"
     AND "name" = $1)
  AS "customers"
FROM "orders"
WHERE EXISTS (
  SELECT 1 FROM "customers"
  WHERE "customers"."id" = "orders"."customer_id"
    AND "name" = $2
)
-- values: ['Alice', 'Alice']
```

#### Parameter Numbering

Embed filters use the existing `buildFilterConditions`
function which pushes values to the shared `values`
array and produces sequential `$N` placeholders. The
numbering flows naturally:

1. Embed subquery filter values are pushed first
   (during select expression building)
2. Inner join EXISTS filter values are pushed next
   (still during select expression building, for the
   same embed node)
3. Parent filter values follow
4. Parent authz values last

The `renumberConditions` helper for authz values
continues to work correctly because it reads
`values.length` at the point of injection.

### Cedar Authorization on Embeds

Cedar authorization already applies per-table on
embedded tables. The handler builds `perTableAuthz`
for all tables (parent + embeds) and the sql-builder
injects authz conditions into each subquery.

Embed user filters and Cedar authz filters coexist in
the subquery WHERE clause:

```sql
WHERE "customers"."id" = "orders"."customer_id"
  AND "name" = $1          -- user embed filter
  AND "active" = $2        -- Cedar authz filter
```

No changes to Cedar integration are needed. The user
cannot bypass Cedar restrictions via embed filters
because both sets of conditions are AND-joined in the
subquery's WHERE.

### Embed Order/Limit: Parser Storage Only

When `routeEmbedParam` encounters `order`, `limit`,
or `offset`, it stores the parsed value on the embed
node:

```javascript
if (rest === 'order') {
  embedNode.order = parseOrder(rawValue);
  return;
}
if (rest === 'limit') {
  embedNode.limit = parseInt(rawValue, 10);
  return;
}
if (rest === 'offset') {
  embedNode.offset = parseInt(rawValue, 10);
  return;
}
```

The embed node's `order` and `limit`/`offset` fields
are initialized to `[]`, `null`, and `0` by
`parseSelectList`. The SQL builder ignores these
fields in this loop. A follow-up implements embed
ORDER BY/LIMIT in the subquery.

### SQL Generation Examples

**Basic embed filter (many-to-one):**

```
GET /rest/v1/orders?select=id,customers(name)
    &customers.name=eq.Alice
```

```sql
SELECT "orders"."id",
  (SELECT json_build_object('name', "customers"."name")
   FROM "customers"
   WHERE "customers"."id" = "orders"."customer_id"
     AND "name" = $1)
  AS "customers"
FROM "orders"
-- values: ['Alice']
```

**Multiple embed filters:**

```
GET /rest/v1/orders?select=id,customers(name,status)
    &customers.name=eq.Alice&customers.status=eq.active
```

```sql
SELECT "orders"."id",
  (SELECT json_build_object(
    'name', "customers"."name",
    'status', "customers"."status")
   FROM "customers"
   WHERE "customers"."id" = "orders"."customer_id"
     AND "name" = $1
     AND "status" = $2)
  AS "customers"
FROM "orders"
-- values: ['Alice', 'active']
```

**Embed filter with parent filter:**

```
GET /rest/v1/orders?select=id,customers(name)
    &amount=gt.50&customers.name=eq.Alice
```

```sql
SELECT "orders"."id",
  (SELECT json_build_object('name', "customers"."name")
   FROM "customers"
   WHERE "customers"."id" = "orders"."customer_id"
     AND "name" = $1)
  AS "customers"
FROM "orders"
WHERE "orders"."amount" > $2
-- values: ['Alice', 50]
```

**Embed OR filter:**

```
GET /rest/v1/orders?select=id,customers(name,status)
    &customers.or=(name.eq.Alice,status.eq.active)
```

```sql
SELECT "orders"."id",
  (SELECT json_build_object(
    'name', "customers"."name",
    'status', "customers"."status")
   FROM "customers"
   WHERE "customers"."id" = "orders"."customer_id"
     AND ("name" = $1 OR "status" = $2))
  AS "customers"
FROM "orders"
-- values: ['Alice', 'active']
```

**One-to-many embed filter:**

```
GET /rest/v1/customers?select=id,orders(id,amount)
    &orders.amount=gt.50
```

```sql
SELECT "customers"."id",
  COALESCE(
    (SELECT json_agg(json_build_object(
      'id', "orders"."id",
      'amount', "orders"."amount"))
     FROM "orders"
     WHERE "orders"."customer_id" = "customers"."id"
       AND "amount" > $1),
    '[]'::json) AS "orders"
FROM "customers"
-- values: [50]
```

**!inner + filter (many-to-one):**

```
GET /rest/v1/orders?select=id,customers!inner(name)
    &customers.name=eq.Alice
```

```sql
SELECT "orders"."id",
  (SELECT json_build_object('name', "customers"."name")
   FROM "customers"
   WHERE "customers"."id" = "orders"."customer_id"
     AND "name" = $1)
  AS "customers"
FROM "orders"
WHERE EXISTS (
  SELECT 1 FROM "customers"
  WHERE "customers"."id" = "orders"."customer_id"
    AND "name" = $2
)
-- values: ['Alice', 'Alice']
```

**Authz + embed filter:**

```sql
-- Cedar denies access to inactive customers
SELECT "orders"."id",
  (SELECT json_build_object('name', "customers"."name")
   FROM "customers"
   WHERE "customers"."id" = "orders"."customer_id"
     AND "name" = $1
     AND "active" = $2)
  AS "customers"
FROM "orders"
WHERE "orders"."user_id" = $3
-- values: ['Alice', true, 'user-123']
```

## Code Architecture / File Changes

| File | Action | Lines | Description |
|------|--------|-------|-------------|
| `src/rest/query-parser.mjs` | Modify | ~90 added | `buildEmbedAliasMap()`, `routeEmbedParam()`, embed-prefix detection in `parseQuery()` loop, embed node field initialization, nesting rejection |
| `src/rest/sql-builder.mjs` | Modify | ~50 added | Embed filter injection in `buildManyToOneSubquery()` and `buildOneToManySubquery()`, !inner+filter EXISTS logic in `buildSelect()` |

**Files that do NOT change:**
- `src/rest/handler.mjs` — handler passes parsed query
  as-is; embed filters are on embed nodes
- `src/rest/schema-cache.mjs` — no schema changes
- `src/rest/errors.mjs` — no new error codes (uses
  existing PGRST100, PGRST204)
- `src/rest/router.mjs` — no routing changes
- `src/rest/openapi.mjs` — defer embed filter docs
- `src/rest/response.mjs` — response format unchanged
- `src/rest/db.mjs` — database layer unchanged
- `src/auth/**` — no auth changes
- `src/authorizer/**` — no authorizer changes

**No new files. No new npm dependencies.**

## Testing Strategy

### Unit Tests: query-parser.mjs

**Basic embed filter parsing:**
- `select=*,customers(*)` + `customers.name=eq.Alice`
  -> embed node's `filters` has one entry with
  `column: 'name'`, `operator: 'eq'`, `value: 'Alice'`
- `select=*,customers(*)` + `customers.name=eq.Alice`
  + `customers.status=eq.active` -> embed node's
  `filters` has two entries

**Alias resolution:**
- `select=*,buyer:customers(*)` + `buyer.name=eq.Alice`
  -> `buyer` embed node's `filters` has
  `column: 'name'`
- `select=*,buyer:customers(*)` + `customers.name=eq.Alice`
  -> PGRST100 "no embed named 'customers' in select"
  (user must use alias)

**FK disambiguation + filter:**
- `select=*,billing:addresses!billing_address_id(*)`
  + `billing.city=eq.Austin` -> `billing` embed node's
  `filters` has `column: 'city'`

**Logical operator on embed:**
- `select=*,customers(*)` +
  `customers.or=(name.eq.Alice,status.eq.active)` ->
  embed node's `filters` has one `logicalGroup` with
  `logicalOp: 'or'`, two conditions

**Negated logical operator on embed:**
- `select=*,customers(*)` +
  `customers.not.or=(status.eq.cancelled,status.eq.refunded)`
  -> embed node's `filters` has one `logicalGroup`
  with `negate: true`

**Embed order (parser storage):**
- `select=*,orders(*)` + `orders.order=amount.desc`
  -> embed node's `order` is
  `[{ column: 'amount', direction: 'desc' }]`

**Embed limit (parser storage):**
- `select=*,orders(*)` + `orders.limit=5`
  -> embed node's `limit` is `5`

**Unknown embed prefix:**
- `select=*,customers(*)` + `foo.bar=eq.1`
  -> PGRST100 "no embed named 'foo' in select"

**No embeds in select — dotted key falls through:**
- `select=id,name` + `foo.bar=eq.1`
  -> treated as regular filter on column `foo.bar`
  (fails with PGRST204 at SQL build time)

**Nested embed filter rejected (deviation from PostgREST):**
- `select=*,items(id,products(name))` +
  `items.products.name=eq.Widget`
  -> PGRST100 "Filter nesting deeper than one level
  is not supported"
  (PostgREST supports this; pgrest-lambda defers to
  a follow-up)

**Top-level logical ops unaffected:**
- `select=*,customers(*)` +
  `not.or=(status.eq.a,status.eq.b)`
  -> top-level negated logical group on parent table
  (not routed to any embed)

**Parent filters still work alongside embed filters:**
- `select=*,customers(*)` + `amount=gt.50`
  + `customers.name=eq.Alice`
  -> `parsed.filters` has `amount > 50`;
  embed node's `filters` has `name = Alice`

**Backward compatibility:**
- All existing filter tests pass unchanged
- `select=id,name` + `status=eq.active` -> same as
  before (no embeds, no dot detection)

### Unit Tests: sql-builder.mjs

**Many-to-one embed with filter:**
- Given: orders table with `customer_id` FK to customers
- Input: `select=id,customers(name)` +
  `customers.name=eq.Alice`
- Expected SQL includes embed subquery WHERE with
  both join condition AND `"name" = $1`
- Values: `['Alice']`

**One-to-many embed with filter:**
- Given: customers table, orders has `customer_id` FK
- Input from customers: `select=id,orders(id,amount)` +
  `orders.amount=gt.50`
- Expected: `json_agg` subquery WHERE includes
  `"amount" > $1`
- Values: `[50]`

**Multiple embed filters:**
- Input: `customers.name=eq.Alice&customers.status=eq.active`
- Expected: `"name" = $1 AND "status" = $2` in the
  subquery WHERE
- Values: `['Alice', 'active']`

**Embed OR filter:**
- Input: `customers.or=(name.eq.Alice,status.eq.active)`
- Expected: `("name" = $1 OR "status" = $2)` in the
  subquery WHERE
- Values: `['Alice', 'active']`

**Embed filter + parent filter:**
- Input: `select=id,customers(name)` + `amount=gt.50`
  + `customers.name=eq.Alice`
- Expected: embed subquery has `"name" = $1`; parent
  WHERE has `"orders"."amount" > $2`
- Values: `['Alice', 50]`

**!inner + filter (many-to-one):**
- Input: `select=id,customers!inner(name)` +
  `customers.name=eq.Alice`
- Expected: embed subquery has `"name" = $1`; parent
  WHERE has `EXISTS (SELECT 1 FROM "customers"
  WHERE ... AND "name" = $2)`
- Values: `['Alice', 'Alice']`

**!inner + filter (one-to-many):**
- Input from customers:
  `select=id,orders!inner(id,amount)` +
  `orders.amount=gt.50`
- Expected: embed subquery has `"amount" > $1`; parent
  WHERE has `EXISTS (SELECT 1 FROM "orders"
  WHERE ... AND "amount" > $2)`
- Values: `[50, 50]`

**!inner without filter — unchanged:**
- Input: `select=id,customers!inner(name)` (no embed
  filters)
- Expected: many-to-one uses `IS NOT NULL` (unchanged)
- Expected: one-to-many uses `EXISTS` without extra
  conditions (unchanged)

**Authz + embed filter:**
- Given: parent authz `"user_id" = $1` (value: `'u1'`),
  child authz `"active" = $1` (value: `true`)
- Input: `select=id,customers(name)` +
  `customers.name=eq.Alice` + `amount=gt.50`
- Expected: correct `$N` numbering across embed filter,
  embed authz, parent filter, and parent authz

**No embed filters — backward compatible:**
- Input: `select=id,customers(name)` (no embed filters)
- Expected: same SQL as before (no extra WHERE
  conditions in subquery beyond join + authz)

> Warning: SQL output assertions should normalize
> whitespace before comparison. The exact formatting
> (newlines, indentation) is not significant.

### Integration Tests: PostgreSQL

Setup: create `customers`, `orders`, `addresses` tables
with FK constraints. Seed with varied data (multiple
customers with different names/statuses, orders at
different amounts, multiple addresses).

**Basic embed filter:**
```
GET /rest/v1/orders?select=id,customers(name)
    &customers.name=eq.Alice
```
-> Each order has either `customers: { name: 'Alice' }`
or `customers: null`. No customer with a different name
appears in any embed.

**One-to-many embed filter:**
```
GET /rest/v1/customers?select=id,orders(id,amount)
    &orders.amount=gt.50
```
-> Each customer's orders array contains only orders
with `amount > 50`. Customers with no qualifying orders
have `orders: []`.

**!inner + filter:**
```
GET /rest/v1/orders?select=id,customers!inner(name)
    &customers.name=eq.Alice
```
-> Only orders whose customer is Alice are returned.
Orders with other customers are excluded entirely.

**Multiple filters on same embed:**
```
GET /rest/v1/orders?select=id,customers(name,status)
    &customers.name=eq.Alice
    &customers.status=eq.active
```
-> Embed includes only customers matching both
conditions.

**Alias + filter:**
```
GET /rest/v1/orders
    ?select=id,buyer:customers(name)
    &buyer.name=eq.Alice
```
-> Response has `buyer` key (not `customers`) with
filtered results.

**FK disambiguation + filter:**
```
GET /rest/v1/orders
    ?select=*,billing:addresses!billing_address_id(*)
    &billing.city=eq.Austin
```
-> Only the billing address embed is filtered;
shipping address (if also embedded) is unaffected.

**Embed filter + parent filter:**
```
GET /rest/v1/orders?select=id,amount,customers(name)
    &amount=gt.50&customers.name=eq.Alice
```
-> Only orders with amount > 50 are returned, and each
has either Alice as customer or null.

**Embed OR filter:**
```
GET /rest/v1/orders?select=id,customers(name,status)
    &customers.or=(name.eq.Alice,status.eq.active)
```
-> Embed includes customers matching either condition.

**Error: unknown prefix:**
```
GET /rest/v1/orders?select=id,customers(name)
    &foo.bar=eq.1
```
-> 400 PGRST100 "no embed named 'foo' in select"

**Error: nested filter:**
```
GET /rest/v1/orders?select=id,items(id,products(name))
    &items.products.name=eq.Widget
```
-> 400 PGRST100 "Filter nesting deeper than one level"

**Authz + embed filter:**
- Given: Cedar policies restricting both parent and
  child tables
- Query with embed filter + authz
- Result: parent rows filtered by parent authz; embed
  rows filtered by both embed user filter AND embed
  authz

**DELETE with return=representation + embed filter:**
```
DELETE /rest/v1/orders?select=id,customers(name)
    &id=eq.ord-1
Prefer: return=representation
```
(No embed filter on the DELETE itself, but the
re-SELECT for representation should support embed
filters if present in the original parsed query.)

### Integration Tests: DSQL

Same test cases as PostgreSQL. Convention-based
relationship fallback produces the same relationships;
correlated subqueries with embed filters work
identically on DSQL.

### supabase-js End-to-End Tests

```javascript
// Basic embed filter
const { data } = await supabase
  .from('orders')
  .select('*, customers(*)')
  .eq('customers.name', 'Alice');
assert(data.every(o =>
  o.customers === null
  || o.customers.name === 'Alice'));

// !inner + filter
const { data } = await supabase
  .from('orders')
  .select('*, customers!inner(*)')
  .eq('customers.name', 'Alice');
assert(data.length > 0);
assert(data.every(o =>
  o.customers.name === 'Alice'));

// Alias + filter
const { data } = await supabase
  .from('orders')
  .select('*, buyer:customers(*)')
  .eq('buyer.name', 'Alice');
assert(data[0].buyer !== undefined);
assert(data.every(o =>
  o.buyer === null || o.buyer.name === 'Alice'));

// Logical operator on embed
const { data } = await supabase
  .from('orders')
  .select('*, customers(*)')
  .or('name.eq.Alice,status.eq.active',
      { foreignTable: 'customers' });
assert(data.every(o =>
  o.customers === null
  || o.customers.name === 'Alice'
  || o.customers.status === 'active'));
```

> Warning: supabase-js `.or()` with `{ foreignTable }`
> option generates `customers.or=(...)` as the query
> parameter key. Verify the parser handles this format.

## Implementation Order

### Phase 1: Query Parser (~90 lines)

1. Add `filters: []`, `order: []`, `limit: null` field
   initialization to embed nodes in `parseSelectList()`.
2. Implement `buildEmbedAliasMap(selectNodes)` — returns
   Map from output key to embed node.
3. Implement `routeEmbedParam(embedNode, prefix, rest,
   rawValue)` — classifies remainder as order/limit/
   logical-op/filter/nesting-error.
4. In `parseQuery()`, after select parsing and before the
   param loop, build the embed alias map. During the
   param loop, add embed-prefix detection between
   top-level logical ops and the regular filter
   fallback.
5. Add unknown-prefix rejection: PGRST100 when prefix
   matches no embed but embeds exist in select.
6. Add nesting rejection: PGRST100 when remainder
   contains a dot and is not a recognized directive.
7. Unit tests for all parsing cases.

### Phase 2: SQL Builder (~50 lines)

8. In `buildManyToOneSubquery()` and
   `buildOneToManySubquery()`, add embed filter
   injection via `buildFilterConditions()` after the
   join condition and before authz.
9. In `buildSelect()`, update the !inner condition
   builder:
   - Many-to-one + filter: switch from `IS NOT NULL`
     to `EXISTS` with filter conditions.
   - One-to-many + filter: add filter conditions to
     existing `EXISTS` subquery.
10. Unit tests for SQL generation with embed filters,
    !inner + filter, parameter numbering.

### Phase 3: Integration Testing

11. Integration tests against PostgreSQL.
12. Integration tests against DSQL.
13. supabase-js end-to-end tests.
14. Verify no regressions in existing test suite.

## Open Questions

1. **`buildCount` and !inner.** Today, `buildCount`
   does not include the `!inner` EXISTS condition.
   This means `Prefer: count=exact` with `!inner`
   returns the count of all parent rows matching
   parent filters, not just those with matching
   children. Adding embed filters to `!inner` does
   not change this pre-existing limitation. A follow-up
   could thread inner join conditions into
   `buildCount`. **Recommendation:** Defer. Document
   the limitation.

2. **Embed order and limit SQL generation.** The parser
   stores `order`, `limit`, and `offset` on embed
   nodes but the SQL builder does not implement them.
   The implementation requires wrapping the subquery in
   a derived table for LIMIT/OFFSET inside json_agg.
   **Recommendation:** Immediate follow-up after this
   loop.

3. **Duplicate embed filter keys.** If the user sends
   `customers.name=eq.Alice&customers.name=eq.Bob`,
   API Gateway's `queryStringParameters` deduplicates
   — only the last value (`Bob`) is preserved.
   `multiValueQueryStringParameters` provides all
   values. The current parser receives single values
   from `queryStringParameters`, so this is a
   pre-existing limitation for all filters, not
   specific to embed filters. **Recommendation:**
   No action needed.

4. **Spread embeds and filtering.** PostgREST supports
   spread embeds (`...customers(*)`) which flatten the
   embed into the parent row. Filtering on spread
   embeds uses the same dot notation. Spread embeds
   are out of scope for pgrest-lambda.
   **Recommendation:** No action needed.

5. **Nested embed filtering.** PostgREST supports
   filtering on nested embeds (e.g.,
   `roles.actors.first_name=like.*Tom*`). This design
   explicitly rejects nested embed filters with a
   PGRST100 error. Supporting it requires recursive
   embed alias resolution and threading filters to
   deeply nested subqueries. **Recommendation:** Defer
   to a follow-up after single-level filtering is
   validated.
