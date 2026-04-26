Implement PostgREST-compatible column aliases in the select query parameter. This is the highest-impact gap to supabase-js compatibility: every codebase that maps snake_case DB columns to camelCase client-side uses this syntax, and today pgrest-lambda fails with 'column not found' because the parser treats 'firstName:first_name' as a literal column name.

Depends on: db-capabilities loop. No new capability flags are needed for this feature (standard AS works on both Postgres and DSQL), but the capability interface must already exist so this loop doesn't add it ad hoc.

## Background: what supabase-js sends

Supabase-js does zero parsing of the select string. It whitespace-strips (preserving quoted sections) and sets ?select=<raw> on the URL. Users write:

  .select('id, firstName:first_name, lastName:last_name')

Which becomes: ?select=id,firstName:first_name,lastName:last_name

Reference: node_modules/@supabase/postgrest-js/src/PostgrestTransformBuilder.ts lines 60-95.

PostgREST spec: https://postgrest.org/en/v12/references/api/url_grammar.html#column-aliasing-and-casting — alias syntax is 'alias:column'. The colon has higher precedence than operators but lower than embed parentheses.

## What to build

Parse alias:column in the select list. Emit SQL 'column' AS 'alias'. Return JSON keyed by alias.

Concretely:

1. src/rest/query-parser.mjs, parseSelectList() — today recognizes embed tokens like 'buyer:customers(name)' where the colon precedes an open paren. Extend: also recognize 'alias:column' for plain columns (no paren). Store as { column, alias } in the select AST. Preserve the existing embed behavior — 'buyer:customers(name)' still becomes an embed with alias='buyer'.

2. src/rest/sql-builder.mjs — the SELECT-clause builder, when it sees a select node with .alias set, emits '"column" AS "alias"' (quoted identifier, case-sensitive). When .alias is absent, emits '"column"' as today.

3. The JSON response naturally follows — Postgres returns the row with the aliased column name, and the existing JSON serialization uses Postgres's returned keys.

## Specific edge cases to handle

- Unquoted alias with invalid identifier chars: reject at parse time with PGRST100 'invalid alias'. Allowlist: [A-Za-z_][A-Za-z0-9_]*.
- Aliased column inside an embed: 'customers(displayName:name, email)' — the alias applies inside the embed's subquery. Make sure the nested AS alias emits correctly.
- Alias collides with another alias or a plain column in the same select list: reject with PGRST100 'duplicate select key'. Run this check after the full select list is parsed.
- The existing embed alias syntax 'buyer:customers(...)' must keep working identically. Don't conflate the two cases in the parser — check for '(' after the colon to disambiguate.
- Aliases with SQL-unsafe characters (quotes, backslashes, nulls): reject, don't sanitize.
- Order param referring to an aliased name: ?select=amount:price&order=amount.desc — does PostgREST allow ordering by alias? Check the spec. If yes, the ORDER BY SQL needs to use the alias. If we're out of scope here, document and file a followup.

## Out of scope for this loop

- Type casting in select (col::type) — separate loop.
- Filter operators on aliased columns (col=eq.val) — the filter always references the raw column. Document that aliases don't change filter semantics.
- Computed columns and function-as-column aliases (alias:my_function()) — not supported by our select parser; keep it simple here.

## Testing

Unit tests in src/rest/__tests__/query-parser.test.mjs (parser):
- Plain alias: 'firstName:first_name' parses to { column: 'first_name', alias: 'firstName' }
- Multiple aliases in one select: each parsed correctly
- Mixed aliased and unaliased columns
- Alias with invalid chars: rejected with PGRST100
- Duplicate aliases or alias-column name collision: rejected with PGRST100
- Existing embed alias ('buyer:customers(...)'): still works, still produces an embed node
- Alias inside embed: 'customers(displayName:name)' parses correctly

Unit tests in src/rest/__tests__/sql-builder.test.mjs (SQL):
- Select with aliases produces: SELECT "first_name" AS "firstName", "last_name" AS "lastName" FROM "people"
- Select with no aliases unchanged

Integration tests in tests/integration/ (real Postgres, real HTTP):
- GET /rest/v1/notes?select=id,author:user_id returns [{id, author}] not [{id, user_id}]
- Supabase-js client round-trip: supabase.from('notes').select('id, author:user_id') returns the aliased shape.

E2E (tests/e2e/): add one scenario using supabase-js with aliased select, confirm TypeScript-shaped response matches expectations.

## DB specialization

None. Standard SQL column aliases work identically on Postgres and DSQL. No capability flag needed.

## Critical rules

- All SQL parameterized — aliases are identifiers, not values; they're safe because they're allowlisted, not because they're parameterized. Column identifiers continue to be validated against the schema cache.
- Never reference BOA/Harbor.
- Node.js only.
- Preserve supabase-js wire compatibility.
- No DSQL-specific SQL.
- REGION_NAME not AWS_REGION.