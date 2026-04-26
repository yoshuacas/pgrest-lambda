Parse col::type syntax in the select query parameter and emit SQL CAST. Enables supabase-js queries like .select('id, amount::text') for casting bigints to strings (avoiding JavaScript Number precision loss), timestamps to dates, etc.

Depends on: db-capabilities, select-aliases (this loop should not conflict with the alias parser work — coordinate if in-flight).

## Background

PostgREST syntax: select=amount::text,name,age::int

supabase-js forwards the raw string; reference PostgrestTransformBuilder.ts.

PostgREST spec: https://postgrest.org/en/v12/references/api/tables_views.html#casting-columns.

## What to build

1. src/rest/query-parser.mjs, parseSelectList() — detect '::' in column tokens. Split into { column, cast, alias? }. Precedence: alias:column::type (alias applies to the result of the cast).

2. src/rest/sql-builder.mjs — when select node has .cast, emit CAST("column" AS "type") (or column::type — pick one form consistently). With .alias: CAST("column" AS type) AS "alias".

3. Safe cast allowlist. Do not allow arbitrary type names — that's a SQL-injection vector via column spec. Start with:
     text, integer, int, bigint, smallint, numeric, real, double precision,
     boolean, date, timestamp, timestamptz, time, uuid, json, jsonb

Reject unknown types at parse time with PGRST100 'unsupported cast type "x"'. Users can extend the allowlist via config (out of scope for this loop — document as followup).

## Edge cases

- Alias + cast: 'price:amount::text' → CAST("amount" AS text) AS "price".
- Cast inside embed: 'customers(age::int)' → the CAST lives in the subquery SELECT.
- Cast on aliased column's source (not the alias): 'firstName:first_name::text' is valid; 'foo::bar' where foo is an alias, not a column, is invalid. Resolve aliases only at filter time — at select time the left side of alias: is always the alias.

## DB specialization

Standard SQL. Both Postgres and DSQL support CAST() and :: syntax. No capability flag.

One narrow concern: DSQL may reject some exotic casts (e.g., to custom types). The engine's cast allowlist is conservative enough that this won't bite us.

## Out of scope

- Custom cast types (via config).
- Cast on filter values (?amount=gt.100::numeric) — PostgREST supports this; defer.
- Cast in order (?order=amount::int.desc) — defer.

## Testing

Unit tests in query-parser.test.mjs:
- 'name::text' → { column: 'name', cast: 'text' }
- 'price:amount::numeric' → { column: 'amount', cast: 'numeric', alias: 'price' }
- Invalid cast type: rejected with PGRST100
- Cast in embed: nested correctly

Unit tests in sql-builder.test.mjs:
- CAST("col" AS text) emitted
- CAST + AS alias combined correctly

Integration tests:
- GET with ?select=id,amount::text against a numeric column returns strings in JSON
- Unknown cast type returns PGRST100

E2E: supabase-js .select('amount::text') round-trip.

## Critical rules

- Cast types are allowlisted at parse time — never interpolated from user input.
- Parameterized SQL.
- No DSQL-specific code.
- supabase-js compat preserved.