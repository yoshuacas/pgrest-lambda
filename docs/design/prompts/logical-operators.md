Add PostgREST-compatible `or` and `and` logical operators so that
supabase-js queries like `.or('age.lt.18,age.gt.65')` work.

## Context

pgrest-lambda currently joins all filter conditions with AND at the
top level. There is no way to express OR logic or to group conditions.
The query parser in `query-parser.mjs` treats every non-reserved query
parameter key as a column name and parses the value as
`operator.value`. The `or` and `and` keys are not recognized.

PostgREST supports `or` and `and` as special query parameter keys
whose values are parenthesized, comma-separated lists of conditions.
These can be nested arbitrarily and combined with `not`.

This is the #2 gap for supabase-js wire compatibility. Any app with
non-trivial filtering needs it.

## How PostgREST handles it

Query parameters:
```
# OR at top level
?or=(age.lt.18,age.gt.65)

# AND at top level (explicit — same as default behavior)
?and=(status.eq.active,amount.gt.100)

# Nested: OR containing AND
?or=(status.eq.vip,and(age.gte.18,age.lte.25))

# NOT with logical operators
?not.or=(status.eq.cancelled,status.eq.refunded)

# Multiple top-level conditions are AND-joined (existing behavior)
?status=eq.active&or=(priority.eq.high,assigned_to=is.null)
```

supabase-js maps:
```javascript
supabase.from('people').select().or('age.lt.18,age.gt.65')
// → ?or=(age.lt.18,age.gt.65)

supabase.from('orders').select()
  .eq('status', 'active')
  .or('priority.eq.high,assigned_to.is.null')
// → ?status=eq.active&or=(priority.eq.high,assigned_to.is.null)

supabase.from('orders').select()
  .or('status.eq.vip,and(age.gte.18,age.lte.25)')
// → ?or=(status.eq.vip,and(age.gte.18,age.lte.25))
```

Generated SQL:
```sql
-- ?or=(age.lt.18,age.gt.65)
WHERE ("age" < 18 OR "age" > 65)

-- ?status=eq.active&or=(priority.eq.high,assigned_to.is.null)
WHERE "status" = 'active' AND ("priority" = 'high' OR "assigned_to" IS NULL)

-- ?or=(status.eq.vip,and(age.gte.18,age.lte.25))
WHERE ("status" = 'vip' OR ("age" >= 18 AND "age" <= 25))

-- ?not.or=(status.eq.cancelled,status.eq.refunded)
WHERE NOT ("status" = 'cancelled' OR "status" = 'refunded')
```

## Requirements

1. Parse `or` and `and` as special query parameter keys in
   query-parser.mjs.

   When the parser encounters a key of `or` or `and` (or `not.or`
   or `not.and`), the value is a parenthesized list of conditions:
   `(condition1,condition2,...)`.

   Each condition inside is either:
   - A regular filter: `column.operator.value` (e.g., `age.lt.18`)
   - A nested logical group: `and(...)` or `or(...)` or `not.and(...)`
     or `not.or(...)`

   The parser must handle:
   - Commas inside `in.(val1,val2)` — these are part of the value,
     not condition separators. The parser must respect parenthesis
     depth when splitting.
   - Nested logical operators to arbitrary depth (though 2-3 levels
     covers all practical use)
   - `not.` prefix on both the top-level key and on nested groups

2. Represent logical groups in the parsed filter tree.

   Current filter shape:
   ```javascript
   { column: 'age', operator: 'lt', value: '18', negate: false }
   ```

   Add a new shape for logical groups:
   ```javascript
   {
     logicalOp: 'or',   // 'or' | 'and'
     negate: false,      // true for not.or / not.and
     conditions: [       // array of filters or nested groups
       { column: 'age', operator: 'lt', value: '18', negate: false },
       { column: 'age', operator: 'gt', value: '65', negate: false },
     ]
   }
   ```

   Logical groups sit in the same `filters` array as regular filters.
   The top-level filters array is implicitly AND-joined (existing
   behavior). An `or` group is one entry in that array.

3. Generate SQL for logical groups in sql-builder.mjs.

   Extend `buildFilterConditions` to handle the new shape. When it
   encounters a filter with `logicalOp`:
   - Recursively build each condition in `conditions`
   - Join them with the logical operator (` OR ` or ` AND `)
   - Wrap in parentheses: `(cond1 OR cond2 OR cond3)`
   - If `negate` is true, wrap with NOT: `NOT (cond1 OR cond2)`

   Parameterization works the same — each leaf condition pushes
   values into the shared `values` array and gets a `$N` placeholder.

   Example for `?or=(age.lt.18,age.gt.65)`:
   ```javascript
   // values = [18, 65]
   // condition = '("age" < $1 OR "age" > $2)'
   ```

   Example for nested `?or=(status.eq.vip,and(age.gte.18,age.lte.25))`:
   ```javascript
   // values = ['vip', 18, 25]
   // condition = '("status" = $1 OR ("age" >= $2 AND "age" <= $3))'
   ```

4. Column validation applies to every leaf condition inside logical
   groups. If `or=(bad_col.eq.1,age.gt.18)`, throw PGRST204 for
   `bad_col` just like a top-level filter would.

5. The existing behavior is unchanged:
   - Top-level filters remain AND-joined
   - `not.` prefix on regular filters still works
   - All existing operators work inside logical groups
   - Embedding, ordering, pagination are unaffected

6. Multiple `or` or `and` params in the same request:
   PostgREST allows multiple `or` params. Each becomes a separate
   entry in the top-level AND-joined filters. For example:
   `?or=(a.eq.1,b.eq.2)&or=(c.eq.3,d.eq.4)` produces
   `WHERE (a=1 OR b=2) AND (c=3 OR d=4)`.

   However, URL query strings don't natively support duplicate keys
   in all frameworks. If the Lambda event provides them as an array,
   handle it. If not, document the limitation — this is an edge case.

7. supabase-js compatibility test cases (must all pass):
   ```javascript
   // Simple or
   supabase.from('people').select().or('age.lt.18,age.gt.65')

   // Or combined with regular filter
   supabase.from('orders').select()
     .eq('status', 'active')
     .or('priority.eq.high,assigned_to.is.null')

   // Nested and inside or
   supabase.from('orders').select()
     .or('status.eq.vip,and(age.gte.18,age.lte.25)')

   // Not or
   supabase.from('orders').select()
     .not('or', '(status.eq.cancelled,status.eq.refunded)')

   // Or with in operator (commas inside in() must not split)
   supabase.from('items').select()
     .or('status.in.(a,b,c),priority.eq.high')

   // Nested or inside and
   supabase.from('items').select()
     .filter('and', 'in', '(price.gt.100,or(status.eq.sale,featured.eq.true))')
   ```

Files to modify:
  src/rest/query-parser.mjs   — parse or/and keys, recursive condition splitting (~80 lines added)
  src/rest/sql-builder.mjs    — recursive SQL generation for logical groups (~30 lines added)
  src/rest/errors.mjs         — no new error codes needed (PGRST100 covers parse errors, PGRST204 covers bad columns)

No new files to create.
No new npm dependencies.

Files that should NOT change:
  src/rest/schema-cache.mjs   — no schema changes
  src/rest/handler.mjs        — handler passes filters through as-is
  src/rest/router.mjs         — no routing changes
  src/rest/openapi.mjs        — defer OpenAPI filter docs
  src/auth/**                 — no auth changes
  src/authorizer/**           — no authorizer changes

## Design constraints

- All values remain parameterized ($1, $2, ...). Logical operators
  only affect the structure of the WHERE clause, not how values are
  handled.
- Column validation via `validateCol` applies at every leaf.
- Parenthesis depth tracking during condition splitting is critical.
  The string `in.(a,b),age.gt.1` has 3 commas but only 2 conditions.
  Split on commas at depth 0 only.
- Authz conditions from Cedar are AND-joined to the top-level WHERE
  clause. They are not affected by user-provided logical operators.

## Test strategy

- Unit tests for query-parser: or/and parsing, nesting, not prefix,
  in-operator commas, unbalanced parens inside logical groups
- Unit tests for sql-builder: SQL generation for or/and groups,
  nested groups, parameter numbering across groups
- Integration tests against PostgreSQL with the 6 supabase-js cases
- Verify existing filter tests still pass (no regressions)

Reference: POSTGREST_GAP_ANALYSIS.md (gap #2)
