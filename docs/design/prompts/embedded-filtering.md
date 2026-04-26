Add PostgREST-compatible filtering on embedded resources. Today resource embedding (FK joins) works — 'orders?select=*,customers(*)' returns orders with nested customer objects — but filtering on the embedded table fails. 'orders?select=*,customers(*)&customers.name=eq.Alice' is ignored or misapplied.

Depends on: db-capabilities loop. Also pairs well with select-aliases (shared parser work), so if both are in-flight plan the parser changes together.

## Background: what supabase-js sends

  await supabase.from('orders')
    .select('*, customers(*)')
    .eq('customers.name', 'Alice');

becomes:

  GET /rest/v1/orders?select=*,customers(*)&customers.name=eq.Alice

The dot notation 'customers.name' tells the server: apply this predicate to the embedded customers table, not to orders. Reference: node_modules/@supabase/postgrest-js/src/PostgrestFilterBuilder.ts — .eq() with a dotted column just concatenates it into the URL.

PostgREST spec: https://postgrest.org/en/v12/references/api/resource_embedding.html#filtering-on-embedded-tables.

## What to build

1. src/rest/query-parser.mjs, parseFilter() — currently expects the query-string key to be a plain column name. Extend to detect dot notation ('customers.name') and split into { table: 'customers', column: 'name', op, value }. One level deep for now; document that deeper nesting (orders.items.name) is out of scope.

2. src/rest/sql-builder.mjs — the embed subquery builder (buildEmbedSubquery or equivalent) must now receive the filters addressed to its table. Apply them to the subquery's WHERE clause, not to the outer query's.

   Today the builder generates something like:
   SELECT o.*, (SELECT json_agg(...) FROM customers c WHERE c.id = o.customer_id) AS customers FROM orders o

   With filters:
   SELECT o.*, (SELECT json_agg(...) FROM customers c WHERE c.id = o.customer_id AND c.name = $1) AS customers FROM orders o

3. Interaction with !inner joins: when the user writes 'customers!inner(*)' and filters on customers, the inner-join semantics mean 'only return parent rows whose embedded-table filter produces at least one match.' This is already present for !inner without filters; verify filtered-inner works the same.

4. Cedar authorization on embedded rows: today Cedar authorizes the parent table. When the engine produces a subquery for embedded rows, Cedar's row-level filter must also apply to the embed. Check that the existing Cedar integration handles this — if not, extend buildAuthzFilter to be called once per embedded table and its predicates merged into the subquery's WHERE.

5. order and limit on embeds: PostgREST supports ?customers.order=name.asc and ?customers.limit=5 — applied to the embed subquery. Include in this loop if straightforward; otherwise document as a follow-up and keep the parser able to recognize the prefix.

## Specific edge cases

- Embed alias: .select('*, buyer:customers(*)').eq('buyer.name', 'Alice') — the dotted prefix references the alias. The parser must resolve 'buyer' back to the 'customers' table. Store the mapping in the select AST so parseFilter can resolve it.
- FK disambiguation: .select('*, billing:addresses!billing_address_id(*)').eq('billing.city', 'Austin') — works via the same alias resolution.
- Unknown prefix: filter references a table that isn't embedded. Reject with PGRST100 'cannot filter on "foo.bar" — no embed named "foo" in select'.
- Multiple filters on the same embed: customers.name=eq.Alice&customers.status=eq.active — both apply with AND.
- Logical operators in embed: customers.or=(name.eq.Alice,status.eq.active) — supported if the existing or/and parser already handles it at the embed level. Test and document.
- Nested embedding (orders → items → products): 'items.products.name=eq.X' — out of scope; reject with PGRST100 'filter nesting deeper than one level is not supported'. Don't silently apply to the parent.

## DB specialization

None. Correlated subqueries work on DSQL and Postgres identically. No capability flag needed.

## Out of scope

- Deeper-than-one-level filtering (orders.items.status=eq.paid).
- Aggregating embedded results (COUNT, SUM on embeds) — separate feature.
- Filtering on embed row-count (e.g., 'has at least 3 items') — requires HAVING.

## Testing

Unit tests (query-parser):
- Plain filter unchanged: ?name=eq.X parses same as today.
- Dotted filter: ?customers.name=eq.X parses to embed filter.
- Unknown prefix: rejected with PGRST100.
- Embed alias resolution: ?buyer.name=eq.X when select has 'buyer:customers(*)' resolves correctly.

Unit tests (sql-builder):
- Embed subquery includes filter predicates in its WHERE.
- !inner + filter produces the expected semantics.
- Parameter numbering continues past the subquery (counter across all subqueries).

Integration tests:
- Seed customers + orders, filter on an embedded customer field, verify the parent rows returned only include ones with matching customer records.
- Same but with !inner: parents without matching children excluded.

E2E: supabase-js round-trip with .eq('customers.name', 'Alice') pattern.

## Critical rules

- Parameterized SQL throughout — subquery values are bind params, not interpolated.
- Cedar authorization is applied per-table, including embedded tables. A user filtering on an embed still gets Cedar-filtered results for that embed.
- No DSQL-specific SQL.
- supabase-js wire compatibility preserved.