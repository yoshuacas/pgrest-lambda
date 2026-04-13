# Logical Operators

## Overview

Add PostgREST-compatible `or` and `and` logical operators to
pgrest-lambda so that supabase-js queries with non-trivial
filtering work. Queries like `.or('age.lt.18,age.gt.65')`
generate `WHERE ("age" < 18 OR "age" > 65)` with full
parameterization.

Logical operators are the #2 gap for supabase-js wire
compatibility. Any application with non-trivial filtering
(dashboard filters, search pages, conditional business logic)
needs them.

The implementation adds ~125 lines across two existing files.
No new files, no new npm dependencies.

## Current CX / Concepts

### All Filters Are AND-Joined

`query-parser.mjs` treats every non-reserved query parameter
key as a column name. The value is parsed as
`operator.value` (e.g., `age=gt.18`). All filters are
collected into a flat array:

```javascript
const filters = [];
for (const [key, rawValue] of Object.entries(params)) {
  if (RESERVED_PARAMS.has(key)) continue;
  filters.push(parseFilter(key, rawValue));
}
```

Each filter has the shape:

```javascript
{ column: 'age', operator: 'lt', value: '18', negate: false }
```

### SQL Builder Joins Filters with AND

`buildFilterConditions()` in `sql-builder.mjs` iterates
the filters array and produces SQL conditions. These are
joined with ` AND ` in the WHERE clause:

```javascript
function whereClause(conditions) {
  return conditions.length > 0
    ? ` WHERE ${conditions.join(' AND ')}`
    : '';
}
```

There is no way to express OR logic or to group conditions.

### `not.` Prefix Negates Individual Filters

The parser handles `not.` as a prefix on the operator:
`age=not.eq.18` produces `{ ..., negate: true }`. The
sql-builder flips the operator (e.g., `=` becomes `!=`).
This only applies to individual filters, not groups.

### Reserved Params Skip Filter Parsing

The set `RESERVED_PARAMS` contains `select`, `order`,
`limit`, `offset`, `on_conflict`. Keys in this set are
skipped during filter parsing. The keys `or` and `and`
are not in this set, so they would currently be treated
as column names — producing a PGRST204 error ("Column
'or' does not exist") or silently matching a column
literally named `or` (unlikely but possible).

## Proposed CX / CX Specification

### Query Parameter Syntax

`or` and `and` are special query parameter keys whose
values are parenthesized, comma-separated lists of
conditions:

```
# OR at top level
?or=(age.lt.18,age.gt.65)

# AND at top level (explicit — same as default behavior)
?and=(status.eq.active,amount.gt.100)

# Nested: OR containing AND
?or=(status.eq.vip,and(age.gte.18,age.lte.25))

# NOT with logical operators
?not.or=(status.eq.cancelled,status.eq.refunded)

# NOT with nested logical operators
?not.and=(status.eq.active,amount.gt.100)

# Combined with regular filters (AND-joined at top level)
?status=eq.active&or=(priority.eq.high,assigned_to.is.null)
```

Top-level `or`/`and` params sit alongside regular filters
in the filters array and are AND-joined at the top level.
This matches PostgREST semantics.

### Condition Syntax Inside Logical Groups

Each condition inside the parenthesized list is either:

1. **A regular filter:** `column.operator.value`
   (e.g., `age.lt.18`, `status.eq.active`,
   `assigned_to.is.null`, `status.in.(a,b,c)`)

2. **A nested logical group:** `and(...)` or `or(...)`
   or `not.and(...)` or `not.or(...)`

The condition format inside logical groups differs from
top-level filters. At the top level, the column name is
the query parameter key and the value is `operator.value`.
Inside a logical group, the condition is a single string
`column.operator.value` where the first dot separates the
column name from the operator.

### Comma Splitting Respects Parenthesis Depth

Commas inside nested parentheses are not condition
separators. The parser tracks parenthesis depth and only
splits on commas at depth 0:

```
# Two conditions (comma at depth 0):
status.in.(a,b,c),priority.eq.high

# Depth tracking:
# s t a t u s . i n . ( a , b , c ) , p r i ...
# 0 0 0 0 0 0 0 0 0 0 1 1 1 1 1 0 0 0 0 0 ...
#                                    ^ split here
```

This handles the `in` operator's parenthesized value list
correctly.

### Nesting Depth

Logical operators can nest up to 10 levels deep:

```
?or=(a.eq.1,and(b.eq.2,or(c.eq.3,d.eq.4)))
```

This produces:

```sql
WHERE ("a" = 1 OR ("b" = 2 AND ("c" = 3 OR "d" = 4)))
```

In practice, 2-3 levels covers all realistic use cases.
A `MAX_NESTING_DEPTH` of 10 is enforced to prevent stack
overflow from crafted deeply-nested queries. Exceeding the
limit throws PGRST100 with `"Logical operator nesting
exceeds maximum depth of 10"`.

### supabase-js Mapping

supabase-js methods map to query parameters as follows:

```javascript
// .or() method → ?or= query parameter
// Source: .or() wraps filters in parens: append('or', `(${filters})`)
supabase.from('people').select().or('age.lt.18,age.gt.65')
// → ?or=(age.lt.18,age.gt.65)

// Combined with regular filters
supabase.from('orders').select()
  .eq('status', 'active')
  .or('priority.eq.high,assigned_to.is.null')
// → ?status=eq.active&or=(priority.eq.high,assigned_to.is.null)

// Nested logical operators
supabase.from('orders').select()
  .or('status.eq.vip,and(age.gte.18,age.lte.25)')
// → ?or=(status.eq.vip,and(age.gte.18,age.lte.25))

// .or() with in operator
supabase.from('items').select()
  .or('status.in.(a,b,c),priority.eq.high')
// → ?or=(status.in.(a,b,c),priority.eq.high)
```

**Negated logical operators (`not.or`, `not.and`) and
supabase-js:** supabase-js has no built-in method that
generates `?not.or=(...)` or `?not.and=(...)`. The
`.not()` method signature is `not(column, operator, value)`
and it generates `column=not.operator.value` — it does
not produce a `not.` prefix on the query param key.
The `.filter()` method signature is
`filter(column, operator, value)` and it generates
`column=operator.value` — also no key prefix.

To produce `?not.or=(cond1,cond2)`, the client must
manually set the query parameter:

```javascript
// No clean supabase-js method for not.or/not.and.
// Manual approach via URL manipulation:
const url = new URL(baseUrl);
url.searchParams.append(
  'not.or', '(status.eq.cancelled,status.eq.refunded)');
// → ?not.or=(status.eq.cancelled,status.eq.refunded)
```

This is a supabase-js limitation, not a PostgREST one.
pgrest-lambda still supports `not.or` and `not.and` as
query param keys because PostgREST does. Applications
that need negated logical groups can use raw HTTP
requests or URL manipulation.

The parser must handle values that already include
the outer parentheses (e.g., `(status.eq.cancelled,...)`)
since `.or()` always wraps filters in parens.

### SQL Generation Examples

```sql
-- ?or=(age.lt.18,age.gt.65)
WHERE ("age" < $1 OR "age" > $2)
-- values: [18, 65]

-- ?status=eq.active&or=(priority.eq.high,assigned_to.is.null)
WHERE "status" = $1
  AND ("priority" = $2 OR "assigned_to" IS NULL)
-- values: ['active', 'high']

-- ?or=(status.eq.vip,and(age.gte.18,age.lte.25))
WHERE ("status" = $1 OR ("age" >= $2 AND "age" <= $3))
-- values: ['vip', 18, 25]

-- ?not.or=(status.eq.cancelled,status.eq.refunded)
WHERE NOT ("status" = $1 OR "status" = $2)
-- values: ['cancelled', 'refunded']

-- ?or=(status.in.(a,b,c),priority.eq.high)
WHERE ("status" IN ($1, $2, $3) OR "priority" = $4)
-- values: ['a', 'b', 'c', 'high']

-- PostgREST canonical complex example:
-- ?grade=gte.90&student=is.true&or=(age.eq.14,not.and(age.gte.11,age.lte.17))
WHERE "grade" >= $1 AND "student" IS TRUE
  AND ("age" = $2 OR NOT ("age" >= $3 AND "age" <= $4))
-- values: [90, 14, 11, 17]
```

All values are parameterized. Logical operators only affect
the structure of the WHERE clause (parentheses, OR/AND/NOT
keywords), never how values are handled.

### Validation Rules

1. **Column validation applies at every leaf.** Each
   regular filter condition inside a logical group is
   validated against the table's schema. If
   `or=(bad_col.eq.1,age.gt.18)`, throw PGRST204 for
   `bad_col` — same as a top-level filter would.

2. **Operators inside logical groups follow the same
   rules.** All operators from `VALID_OPERATORS` are
   supported. The `is` operator requires values from
   `VALID_IS_VALUES`. The `in` operator accepts a
   parenthesized value list. The `not.` prefix works
   on individual conditions inside groups using the
   `column.not.operator.value` format:
   `or=(status.not.eq.cancelled,age.gt.18)`.

3. **Parentheses must be balanced.** Unbalanced
   parentheses in the logical group value throw PGRST100:
   `"Unbalanced parentheses in logical operator value"`.

4. **Empty logical groups are rejected.** `or=()` throws
   PGRST100: `"Empty condition list in 'or' operator"`.
   This applies to nested empty groups too:
   `or=(and(),age.gt.18)` throws PGRST100 with
   `"Empty condition list in 'and' operator"`.

5. **Unknown operators in conditions throw PGRST100.**
   `or=(age.bad_op.18)` throws the standard operator
   validation error.

6. **Nesting depth is limited.** Logical operators can
   nest to a maximum depth of 10. Queries exceeding this
   throw PGRST100: `"Logical operator nesting exceeds
   maximum depth of 10"`. This prevents stack overflow
   from crafted deeply-nested queries.

### Error Messages

| Scenario | HTTP | Code | Message |
|----------|------|------|---------|
| Unbalanced parens in logical group | 400 | PGRST100 | "Unbalanced parentheses in logical operator value" |
| Empty logical group | 400 | PGRST100 | "Empty condition list in '{op}' operator" |
| Bad column in logical group | 400 | PGRST204 | "Column '{col}' does not exist in '{table}'" |
| Bad operator in condition | 400 | PGRST100 | "'{op}' is not a valid filter operator" |
| Bad filter syntax in condition | 400 | PGRST100 | "'{raw}' is not a valid filter condition" |
| Nested empty group | 400 | PGRST100 | "Empty condition list in '{op}' operator" |
| Excessive nesting depth | 400 | PGRST100 | "Logical operator nesting exceeds maximum depth of 10" |

No new error codes are needed. PGRST100 covers parse
errors, PGRST204 covers bad columns.

### Multiple `or`/`and` Params

PostgREST allows multiple `or` params in the same
request. Each becomes a separate entry in the top-level
AND-joined filters:

```
?or=(a.eq.1,b.eq.2)&or=(c.eq.3,d.eq.4)
```

Produces:

```sql
WHERE (a = $1 OR b = $2) AND (c = $3 OR d = $4)
```

URL query strings don't natively support duplicate keys
in all frameworks. API Gateway's `queryStringParameters`
deduplicates — only the last value for a duplicate key
is preserved. However, `multiValueQueryStringParameters`
provides all values as an array. The parser should check
`multiValueQueryStringParameters` for `or` and `and`
keys when present, falling back to
`queryStringParameters`. If neither provides array
values, document the limitation.

### Existing Behavior Unchanged

- Top-level filters remain AND-joined
- `not.` prefix on regular filters still works
- All existing operators work inside logical groups
- Embedding, ordering, pagination are unaffected
- Authz conditions from Cedar are AND-joined to the
  top-level WHERE clause and are not affected by
  user-provided logical operators

## Technical Design

### Parsed Filter Tree: New Logical Group Shape

The current filter shape for regular filters gains an
explicit `type` discriminant:

```javascript
{
  type: 'filter',
  column: 'age', operator: 'lt', value: '18', negate: false
}
```

A new shape represents logical groups:

```javascript
{
  type: 'logicalGroup',
  logicalOp: 'or',   // 'or' | 'and'
  negate: false,      // true for not.or / not.and
  conditions: [       // array of filters or nested groups
    { type: 'filter', column: 'age', operator: 'lt',
      value: '18', negate: false },
    { type: 'filter', column: 'age', operator: 'gt',
      value: '65', negate: false },
  ]
}
```

Both shapes have an explicit `type` field (`'filter'` or
`'logicalGroup'`) to distinguish them. This replaces
duck-typing on the presence of `logicalOp` vs `column`
and prevents silent misrouting if either shape gains new
properties in the future.

Logical groups sit in the same `filters` array as regular
filters.

Nested groups are recursive: a logical group's
`conditions` array can contain further logical groups.

### Query Parser Changes

#### Recognizing `or`/`and` Keys

In `parseQuery()`, before the filter loop, add `or` and
`and` to the set of keys that receive special handling.
When the parser encounters a key of `or`, `and`,
`not.or`, or `not.and`:

1. Strip the outer parentheses from the value (if
   present — `.or()` always wraps in parens).
2. Parse the condition list recursively.
3. Push the logical group into the `filters` array.

```javascript
const LOGICAL_OPS = new Set(['or', 'and']);

// In parseQuery():
for (const [key, rawValue] of Object.entries(params)) {
  if (RESERVED_PARAMS.has(key)) continue;

  let logicalOp = null;
  let negate = false;

  if (LOGICAL_OPS.has(key)) {
    logicalOp = key;
  } else if (key.startsWith('not.')) {
    const rest = key.slice(4);
    if (LOGICAL_OPS.has(rest)) {
      logicalOp = rest;
      negate = true;
    }
  }

  if (logicalOp) {
    filters.push(
      parseLogicalGroup(logicalOp, negate, rawValue, 0));
  } else {
    filters.push(parseFilter(key, rawValue));
  }
}
```

#### `parseLogicalGroup(op, negate, raw, depth)`

1. Check depth: if `depth > MAX_NESTING_DEPTH`, throw
   PGRST100 with `"Logical operator nesting exceeds
   maximum depth of 10"`.

2. Strip outer parentheses: if `raw` starts with `(`
   and ends with `)`, remove them. If only one is
   present, throw PGRST100 (unbalanced).

3. Split the inner string into conditions at commas
   at parenthesis depth 0.

4. For each condition string:
   - If it matches `and(...)`, `or(...)`, `not.and(...)`,
     or `not.or(...)`, recursively parse as a nested
     logical group (passing `depth` through).
   - Otherwise, parse as a regular filter condition
     `column.operator.value`.

5. Return the logical group object with
   `type: 'logicalGroup'`.

Top-level calls from `parseQuery` pass `depth = 0`.
Each nested call increments `depth` via
`parseCondition(str, depth)` →
`parseLogicalGroup(op, negate, inner, depth + 1)`.

#### Depth-Aware Comma Splitting: `splitConditions(str)`

This is the critical parsing function. It scans the
string character by character, tracking parenthesis
depth, and splits on commas at depth 0:

```javascript
function splitConditions(str) {
  const conditions = [];
  let start = 0;
  let depth = 0;

  for (let i = 0; i < str.length; i++) {
    if (str[i] === '(') depth++;
    else if (str[i] === ')') {
      depth--;
      if (depth < 0) {
        throw new PostgRESTError(400, 'PGRST100',
          'Unbalanced parentheses in logical operator value');
      }
    } else if (str[i] === ',' && depth === 0) {
      conditions.push(str.slice(start, i));
      start = i + 1;
    }
  }

  if (depth !== 0) {
    throw new PostgRESTError(400, 'PGRST100',
      'Unbalanced parentheses in logical operator value');
  }

  const last = str.slice(start);
  if (last) conditions.push(last);

  return conditions;
}
```

This correctly handles:
- `in.(a,b,c)` — commas at depth 1 are skipped
- `and(x.eq.1,y.eq.2)` — commas inside nested group
  are skipped
- Regular commas at depth 0 split conditions

#### Parsing Individual Conditions: `parseCondition(str, depth)`

Each condition string inside a logical group has the
format `column.operator.value`. Unlike top-level
filters where the column is the query param key, here
everything is in a single string.

The `depth` parameter tracks nesting level (starting
at 0 for top-level logical groups). It is passed through
to `parseLogicalGroup` on recursive calls.

```javascript
const MAX_NESTING_DEPTH = 10;

function parseCondition(str, depth) {
  // Check for nested logical operators first
  const nestedMatch = str.match(
    /^(not\.)?(or|and)\((.*)?\)$/);
  if (nestedMatch) {
    const negate = !!nestedMatch[1];
    const op = nestedMatch[2];
    const inner = nestedMatch[3];
    if (!inner) {
      throw new PostgRESTError(400, 'PGRST100',
        `Empty condition list in '${op}' operator`);
    }
    return parseLogicalGroup(
      op, negate, inner, depth + 1);
  }

  // Regular condition: column.operator.value
  const dotIdx = str.indexOf('.');
  if (dotIdx === -1) {
    throw new PostgRESTError(400, 'PGRST100',
      `"${str}" is not a valid filter condition`);
  }

  const column = str.slice(0, dotIdx);
  const remainder = str.slice(dotIdx + 1);

  // Delegate to existing parseFilter logic
  return parseFilter(column, remainder);
}
```

Key changes from the initial implementation:

- The regex uses `(.*)` instead of `(.+)` so it matches
  empty nested groups like `and()`. The empty check is
  done explicitly after the match, producing the correct
  `"Empty condition list in 'and' operator"` error
  instead of the misleading `"and()" is not a valid
  filter condition"`.
- The `depth` counter is incremented on each recursive
  call and checked in `parseLogicalGroup`.

This reuses the existing `parseFilter` function for
operator parsing, `not.` handling, `is` validation,
`in` value splitting, and `like`/`ilike` wildcard
conversion. `parseFilter` returns objects with
`type: 'filter'`.

#### Handling `multiValueQueryStringParameters`

For duplicate `or`/`and` keys, the parser accepts an
array of values for a single key. In `parseQuery()`,
before iterating params, merge
`multiValueQueryStringParameters` for logical operator
keys:

```javascript
// In parseQuery(), before the main loop:
const multiParams =
  event?.multiValueQueryStringParameters || {};
for (const key of ['or', 'and', 'not.or', 'not.and']) {
  const values = multiParams[key];
  if (Array.isArray(values) && values.length > 1) {
    // Process each value as a separate logical group
    // (handled in main loop by checking for array)
  }
}
```

The `parseQuery` function currently receives `params`
(a plain object). To support multi-value params, the
handler should pass `multiValueQueryStringParameters`
as an optional second parameter, or pre-merge them.
The simplest approach: if the handler detects array
values for `or`/`and`, it converts each into a separate
call. This keeps `parseQuery` simple.

**Implementation approach:** In `parseQuery()`, accept
an optional `multiValueParams` argument. For `or`,
`and`, `not.or`, `not.and` keys, check
`multiValueParams[key]` first. If it's an array with
multiple values, create a logical group for each value.

### SQL Builder Changes

#### Extending `buildFilterConditions()`

The function currently iterates filters and assumes
each has a `column` property. Add a branch for logical
groups using the `type` discriminant:

```javascript
function buildFilterConditions(
    filters, schema, table, values
) {
  const conditions = [];
  for (const f of filters) {
    if (f.type === 'logicalGroup') {
      conditions.push(
        buildLogicalCondition(f, schema, table, values));
    } else {
      // Existing code for regular filters
      conditions.push(
        buildSingleCondition(f, schema, table, values));
    }
  }
  return conditions;
}
```

The check uses `f.type === 'logicalGroup'` instead of
duck-typing on `f.logicalOp`, making the contract
between parser and builder explicit.

#### `buildLogicalCondition(group, schema, table, values, depth)`

Recursively builds SQL for a logical group. The `depth`
parameter provides defense-in-depth against excessive
nesting (the parser should catch this first, but the
builder enforces the same limit as a safety net).
`MAX_NESTING_DEPTH` is defined as a constant in both
`query-parser.mjs` and `sql-builder.mjs` (same value:
10):

```javascript
function buildLogicalCondition(
    group, schema, table, values, depth = 0
) {
  if (depth > MAX_NESTING_DEPTH) {
    throw new PostgRESTError(400, 'PGRST100',
      'Logical operator nesting exceeds maximum '
      + `depth of ${MAX_NESTING_DEPTH}`);
  }

  const parts = [];
  for (const cond of group.conditions) {
    if (cond.type === 'logicalGroup') {
      parts.push(buildLogicalCondition(
        cond, schema, table, values, depth + 1));
    } else {
      parts.push(
        buildSingleCondition(cond, schema, table, values));
    }
  }

  const joiner =
    group.logicalOp === 'or' ? ' OR ' : ' AND ';
  const inner = parts.join(joiner);
  const wrapped = `(${inner})`;

  return group.negate ? `NOT ${wrapped}` : wrapped;
}
```

Uses `cond.type === 'logicalGroup'` for the recursive
branch check, matching the type discriminant convention.

#### Extracting `buildSingleCondition()`

The existing per-filter logic in `buildFilterConditions`
(the `is`, `in`, and default operator branches) is
extracted into a helper `buildSingleCondition(f, schema,
table, values)` that returns a single SQL condition
string. Both the regular filter loop and
`buildLogicalCondition` call this helper.

This avoids duplicating the `is`/`in`/default operator
SQL generation logic.

```javascript
function buildSingleCondition(f, schema, table, values) {
  validateCol(schema, table, f.column);
  if (f.operator === 'is') {
    const keyword = f.value.toLowerCase();
    const not = f.negate ? ' NOT' : '';
    return `"${f.column}" IS${not} ${keyword.toUpperCase()}`;
  } else if (f.operator === 'in') {
    const placeholders = f.value.map((v) => {
      values.push(v);
      return `$${values.length}`;
    });
    const not = f.negate ? 'NOT ' : '';
    return `"${f.column}" ${not}IN (${placeholders.join(', ')})`;
  } else {
    values.push(f.value);
    const base = OP_SQL[f.operator];
    const op = f.negate ? NEGATE_OP[base] : base;
    return `"${f.column}" ${op} $${values.length}`;
  }
}
```

### Parameter Numbering

Logical groups do not change the parameter numbering
approach. Each leaf condition pushes its value(s) into
the shared `values` array and gets sequential `$N`
placeholders. The recursion naturally produces correct
numbering because the `values` array is shared across
all recursive calls.

Example for `?or=(status.in.(a,b,c),priority.eq.high)`:

```javascript
// Start: values = []
// Processing status.in.(a,b,c):
//   values.push('a') → values = ['a'], $1
//   values.push('b') → values = ['a','b'], $2
//   values.push('c') → values = ['a','b','c'], $3
// Processing priority.eq.high:
//   values.push('high') → values = ['a','b','c','high'], $4
// Result: ("status" IN ($1, $2, $3) OR "priority" = $4)
```

### Interaction with Cedar Authorization

Cedar authorization conditions are AND-joined to the
top-level WHERE clause by `buildSelect()`, `buildUpdate()`,
`buildDelete()`, and `buildCount()`. They are appended
after `buildFilterConditions()` returns.

User-provided logical operators only affect the structure
within `buildFilterConditions`. The Cedar conditions are
outside that scope — a user cannot use `or` to bypass
authorization filters. The generated SQL looks like:

```sql
WHERE (user_cond1 OR user_cond2) AND cedar_authz_cond
```

No changes to Cedar integration are needed.

### Interaction with Resource Embedding

Logical operators apply to the parent table's WHERE
clause only. They do not affect embedded table
subqueries (which have their own join conditions and
authz filters). This matches PostgREST behavior — to
filter on embedded table columns, you use the
`table.column=op.value` syntax (deferred, see Open
Questions in the resource-embedding design).

## Code Architecture / File Changes

| File | Action | Lines | Description |
|------|--------|-------|-------------|
| `src/rest/query-parser.mjs` | Modify | ~90 added | Recognize `or`/`and`/`not.or`/`not.and` keys, `parseLogicalGroup()` with depth limit, `splitConditions()` with depth tracking, `parseCondition()` with empty group detection, `type: 'filter'` discriminant on filter objects |
| `src/rest/sql-builder.mjs` | Modify | ~35 added | `buildLogicalCondition()` recursive SQL generation with defense-in-depth depth counter, extract `buildSingleCondition()` helper, `type === 'logicalGroup'` discriminant checks |

**Files that do NOT change:**
- `src/rest/errors.mjs` — no new error codes
- `src/rest/handler.mjs` — handler passes filters as-is
- `src/rest/schema-cache.mjs` — no schema changes
- `src/rest/router.mjs` — no routing changes
- `src/rest/openapi.mjs` — defer OpenAPI filter docs
- `src/rest/response.mjs` — response format unchanged
- `src/rest/db.mjs` — database layer unchanged
- `src/auth/**` — no auth changes
- `src/authorizer/**` — no authorizer changes

**No new files. No new npm dependencies.**

## Testing Strategy

### Unit Tests: query-parser.mjs

**Basic or parsing:**
- `or=(age.lt.18,age.gt.65)` → logical group with
  `logicalOp: 'or'`, two conditions
- `and=(status.eq.active,amount.gt.100)` → logical
  group with `logicalOp: 'and'`, two conditions

**not. prefix:**
- `not.or=(status.eq.cancelled,status.eq.refunded)` →
  logical group with `negate: true`
- `not.and=(a.eq.1,b.eq.2)` → logical group with
  `logicalOp: 'and'`, `negate: true`

**Nested logical operators:**
- `or=(status.eq.vip,and(age.gte.18,age.lte.25))` →
  or-group containing one regular filter and one nested
  and-group
- `and=(a.eq.1,or(b.eq.2,c.eq.3))` → and-group
  containing one regular filter and one nested or-group
- `or=(a.eq.1,and(b.eq.2,or(c.eq.3,d.eq.4)))` → three
  levels of nesting

**not. on nested groups:**
- `or=(a.eq.1,not.and(b.eq.2,c.eq.3))` → or-group
  with nested negated and-group

**in operator inside logical groups (comma handling):**
- `or=(status.in.(a,b,c),priority.eq.high)` → two
  conditions, first has `operator: 'in'` with value
  `['a','b','c']`
- `and=(x.in.(1,2),y.in.(3,4))` → both conditions
  are `in` operators with correct value arrays

**is operator inside logical groups:**
- `or=(status.is.null,priority.eq.high)` → first
  condition has `operator: 'is'`, `value: 'null'`
- `or=(active.is.true,role.eq.admin)` → is with
  boolean value

**not. prefix on conditions inside groups:**
- `or=(status.not.eq.cancelled,age.gt.18)` → first
  condition has `negate: true`

  PostgREST uses `column.not.operator.value` format
  inside logical groups — the `not` comes after the
  column name, same positionally as top-level filters
  where the column is the query param key and the
  value is `not.operator.value`. The format
  `not.column.operator.value` (not-first) is NOT valid
  for regular conditions inside groups; PostgREST's
  parser expects `not` or an operator keyword after the
  column name. The `not.` prefix at the start of a
  condition string is reserved for nested logical groups
  (`not.and(...)`, `not.or(...)`).

**Combined with regular filters:**
- `status=eq.active` + `or=(priority.eq.high,assigned_to.is.null)`
  → filters array has one regular filter and one logical
  group

**Parenthesis handling:**
- Value without outer parens: `or=age.lt.18,age.gt.65`
  → parser should still handle gracefully (PostgREST
  requires parens, but defensive parsing is fine)
- Value with outer parens:
  `or=(age.lt.18,age.gt.65)` → standard case

**Single-condition logical group:**
- `or=(age.gt.65)` → logical group with `logicalOp: 'or'`,
  one condition. Valid degenerate case.

**Error cases:**
- `or=()` → PGRST100 "Empty condition list in 'or'
  operator"
- `and=()` → PGRST100 "Empty condition list in 'and'
  operator"
- `or=(and(),age.gt.18)` → PGRST100 "Empty condition
  list in 'and' operator" (nested empty group)
- `or=(age.lt.18` → PGRST100 (unbalanced parens)
- `or=(age.bad_op.18,x.eq.1)` → PGRST100 (bad operator)
- `or=(novalue)` → PGRST100 (no dot separator)
- 50-level deep nesting → PGRST100 "Logical operator
  nesting exceeds maximum depth of 10"

**Backward compatibility:**
- Regular filters gain `type: 'filter'`: `age=gt.18`
  produces `{ type: 'filter', column: 'age',
  operator: 'gt', value: '18' }`
- `not.` prefix on regular filters still works
- All existing reserved params still skipped
- A table that literally has a column named `or` or
  `and` cannot be filtered at the top level (PostgREST
  has the same limitation — these are reserved keys)

### Unit Tests: sql-builder.mjs

**Basic or SQL:**
- `or=(age.lt.18,age.gt.65)` → `("age" < $1 OR "age" > $2)`
  with values `[18, 65]`

**Basic and SQL:**
- `and=(status.eq.active,amount.gt.100)` →
  `("status" = $1 AND "amount" > $2)` with values
  `['active', 100]`

**not.or SQL:**
- `not.or=(status.eq.cancelled,status.eq.refunded)` →
  `NOT ("status" = $1 OR "status" = $2)`

**not.and SQL:**
- `not.and=(a.eq.1,b.eq.2)` →
  `NOT ("a" = $1 AND "b" = $2)`

**Nested SQL:**
- `or=(status.eq.vip,and(age.gte.18,age.lte.25))` →
  `("status" = $1 OR ("age" >= $2 AND "age" <= $3))`
  with values `['vip', 18, 25]`

**in operator inside or:**
- `or=(status.in.(a,b,c),priority.eq.high)` →
  `("status" IN ($1, $2, $3) OR "priority" = $4)`
  with values `['a', 'b', 'c', 'high']`

**is operator inside or:**
- `or=(assigned_to.is.null,priority.eq.high)` →
  `("assigned_to" IS NULL OR "priority" = $1)`
  with values `['high']`

**Combined with regular filters:**
- `status=eq.active` + `or=(priority.eq.high,x.is.null)`
  → `"status" = $1 AND ("priority" = $2 OR "x" IS NULL)`
  with values `['active', 'high']`

**Parameter numbering across groups:**
- `age=gt.18` + `or=(status.eq.a,status.eq.b)` +
  `name=eq.foo` → `"age" > $1 AND ("status" = $2 OR
  "status" = $3) AND "name" = $4`

**Column validation in logical groups:**
- `or=(bad_col.eq.1,age.gt.18)` → PGRST204 for
  `bad_col`

**Three levels of nesting:**
- `or=(a.eq.1,and(b.eq.2,or(c.eq.3,d.eq.4)))` →
  `("a" = $1 OR ("b" = $2 AND ("c" = $3 OR "d" = $4)))`

**PostgREST canonical complex example:**
- `grade=gte.90` + `student=is.true` +
  `or=(age.eq.14,not.and(age.gte.11,age.lte.17))` →
  `"grade" >= $1 AND "student" IS TRUE AND
  ("age" = $2 OR NOT ("age" >= $3 AND "age" <= $4))`
  with values `[90, 14, 11, 17]`

**No logical groups — backward compatible:**
- `age=gt.18&name=eq.foo` → generates same SQL as
  before

### Integration Tests: PostgreSQL

Setup: create a `people` table with columns `id`,
`name`, `age`, `status`, `priority`, `assigned_to`,
`featured`. Seed with enough data to verify filtering.

**Simple or:**
```
GET /rest/v1/people?or=(age.lt.18,age.gt.65)
```
Returns only people younger than 18 or older than 65.

**Or combined with regular filter:**
```
GET /rest/v1/people?status=eq.active
  &or=(priority.eq.high,assigned_to.is.null)
```
Returns active people who are either high priority or
unassigned.

**Nested and inside or:**
```
GET /rest/v1/people?or=(status.eq.vip,and(age.gte.18,age.lte.25))
```
Returns VIPs or people aged 18-25.

**Not or:**
```
GET /rest/v1/people?not.or=(status.eq.cancelled,status.eq.refunded)
```
Returns people whose status is neither cancelled nor
refunded.

**Or with in operator:**
```
GET /rest/v1/people?or=(status.in.(a,b,c),priority.eq.high)
```
Returns people with status a, b, or c, or high priority.

**Logical operators with embedding:**
```
GET /rest/v1/orders?select=id,customers(name)
  &or=(amount.gt.100,status.eq.rush)
```
Returns orders matching the or-condition, each with
embedded customer data. Verifies no interaction between
logical operators and embed subqueries.

**like/ilike inside logical groups:**
```
GET /rest/v1/people?or=(name.like.A*,name.like.B*)
```
Returns Alice and Bob only. Verifies wildcard operators
work correctly inside logical groups (the `*` to `%`
conversion applies).

**not.in inside logical groups:**
```
GET /rest/v1/people?or=(status.not.in.(active,vip),age.gt.65)
```
Returns people whose status is neither active nor vip,
or whose age exceeds 65. Verifies negated `in` operator
inside a logical group.

**Single-condition logical group:**
```
GET /rest/v1/people?or=(age.gt.65)
```
Returns Charlie (age 70) only. A valid degenerate case
— one condition wrapped in a logical group produces
`("age" > $1)`.

**count=exact with logical operators:**
```
GET /rest/v1/people?or=(age.lt.18,age.gt.65)&limit=1
Prefer: count=exact
```
Content-Range header shows the correct total count of
matching rows (3: Alice, Frank, Charlie), even when
`limit` restricts the returned rows to 1.

**Nested empty group error message:**
```
GET /rest/v1/people?or=(and(),age.gt.18)
```
Returns 400 PGRST100 with `"Empty condition list in
'and' operator"`. Verifies that nested empty groups
produce a targeted error instead of the generic
`"and()" is not a valid filter condition"`.

**Excessive nesting depth:**
```
GET /rest/v1/people?or=(and(or(and(...))))  # 50 levels
```
Returns 400 PGRST100 with `"Logical operator nesting
exceeds maximum depth of 10"`.

**PATCH with or filter:**
```
PATCH /rest/v1/people?or=(status.eq.cancelled,status.eq.refunded)
Body: { status: 'archived' }
Prefer: return=representation
```
Returns Charlie and Eve with `status: 'archived'`.
Verifies logical operators work with UPDATE statements.

**DELETE with or filter:**
```
DELETE /rest/v1/people?or=(status.eq.cancelled,status.eq.refunded)
Prefer: return=representation
```
Returns Charlie and Eve (the deleted rows). A
subsequent GET returns only Alice, Bob, Diana, Frank.

**Verify existing tests still pass** — run the full
existing test suite to confirm no regressions in
regular filter handling, embedding, pagination, etc.

### supabase-js End-to-End Tests

Run against a real PostgreSQL instance with supabase-js
client:

```javascript
// Simple or
const { data } = await supabase
  .from('people').select()
  .or('age.lt.18,age.gt.65');
assert(data.every(
  p => p.age < 18 || p.age > 65));

// Or combined with regular filter
const { data } = await supabase
  .from('people').select()
  .eq('status', 'active')
  .or('priority.eq.high,assigned_to.is.null');
assert(data.every(
  p => p.status === 'active'
    && (p.priority === 'high'
        || p.assigned_to === null)));

// Nested and inside or
const { data } = await supabase
  .from('people').select()
  .or('status.eq.vip,and(age.gte.18,age.lte.25)');
assert(data.every(
  p => p.status === 'vip'
    || (p.age >= 18 && p.age <= 25)));

// Not or — supabase-js has no built-in method for not.or.
// Use raw HTTP request with ?not.or=(...)
const resp = await fetch(
  `${baseUrl}/rest/v1/people`
  + `?not.or=(status.eq.cancelled,status.eq.refunded)`,
  { headers });
const data = await resp.json();
assert(data.every(
  p => p.status !== 'cancelled'
    && p.status !== 'refunded'));

// Or with in operator
const { data } = await supabase
  .from('items').select()
  .or('status.in.(a,b,c),priority.eq.high');
assert(data.every(
  i => ['a','b','c'].includes(i.status)
    || i.priority === 'high'));
```

## Implementation Order

### Phase 1: Query Parser (~90 lines)

1. Add `type: 'filter'` to `parseFilter` return object.
2. Add `LOGICAL_OPS` set, `MAX_NESTING_DEPTH` constant,
   and recognition logic in `parseQuery()` for `or`,
   `and`, `not.or`, `not.and` keys.
3. Implement `splitConditions(str)` — depth-aware
   comma splitting.
4. Implement `parseCondition(str, depth)` — parse
   individual conditions inside logical groups, with
   nested group detection. Use `(.*)` regex to catch
   empty nested groups. Pass `depth` through recursive
   calls.
5. Implement `parseLogicalGroup(op, negate, raw, depth)`
   — check depth limit, strip outer parens, split,
   parse each condition. Return with
   `type: 'logicalGroup'`.
6. Unit tests for all parsing cases.

### Phase 2: SQL Builder (~30 lines)

7. Extract `buildSingleCondition()` from existing
   `buildFilterConditions()` loop body.
8. Add `buildLogicalCondition()` — recursive SQL
   generation with parentheses, NOT wrapping, and
   defense-in-depth depth counter. Use
   `cond.type === 'logicalGroup'` check.
9. Update `buildFilterConditions()` to use
   `f.type === 'logicalGroup'` instead of
   `f.logicalOp`.
10. Unit tests for generated SQL including parameter
    numbering.

### Phase 3: Multi-Value Params (optional)

11. If needed, update `parseQuery()` signature to
    accept `multiValueQueryStringParameters`.
12. Process array values for `or`/`and` keys.
13. Update handler to pass multi-value params.

### Phase 4: Integration Testing

14. Integration tests against PostgreSQL.
15. supabase-js end-to-end tests.
16. Verify no regressions in existing test suite.

## Open Questions

1. **Duplicate query parameter support.** API Gateway's
   `queryStringParameters` deduplicates keys. Supporting
   `?or=(...)&or=(...)` requires using
   `multiValueQueryStringParameters`. This is a minor
   edge case — most apps use a single `or` per request.
   Consider deferring multi-value support to a follow-up
   if the initial implementation complexity is too high.

2. **Column named `or` or `and`.** If a table literally
   has a column named `or` or `and`, it cannot be
   filtered at the top level using the standard syntax.
   PostgREST has the same limitation. This is unlikely
   in practice and not worth adding escape syntax for.
