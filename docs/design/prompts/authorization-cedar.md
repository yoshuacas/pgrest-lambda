Implement Cedar-based authorization for pgrest-lambda's PostgREST-compatible
REST API, replacing the implicit user_id column filtering with explicit
policy-as-code that developers can customize.

Constraint: DSQL does not support PostgreSQL RLS or SET ROLE. Row-level
security must be application-layer. Cedar policies must translate into SQL
WHERE clauses BEFORE the query executes — never post-query row filtering.

## Background

pgrest-lambda currently has a hardcoded function `appendUserId()` in
sql-builder.mjs that silently adds `WHERE user_id = $1` if a table has a
column named `user_id`. This is implicit, binary (own data or all), and
not configurable. Cedar replaces this with explicit, developer-writable
policies.

## Core mechanism: Cedar partial evaluation → SQL WHERE

Use `@cedar-policy/cedar-wasm` `isAuthorizedPartial()` with the resource
left as unknown (null). Cedar returns residual policies — partially
evaluated policy ASTs where resource-dependent conditions remain as
expressions. Walk the residual AST and translate resource attribute
conditions into parameterized SQL WHERE clauses.

Reference: https://cedarland.blog/usage/partial-evaluation/content.html
Reference: cedar-policy/cedar#592 (Cedar team endorses this approach)
Reference: https://github.com/windley/cedar-rag-authz-demo (residual-to-query compiler for OpenSearch)

## Entity model

```cedar
namespace PgrestLambda {
    entity User = {
        "email": String,
        "role": String,
    };
    entity ServiceRole;
    entity AnonRole;
    entity Table;
    entity Row in [Table];

    action "select", "insert", "update", "delete" appliesTo {
        principal: [User, ServiceRole, AnonRole],
        resource: [Table, Row],
    };
}
```

Row entity attributes are derived dynamically from schema introspection —
each table's columns become the Row entity's attributes for that table.

## Default policies (ship with pgrest-lambda)

```cedar
// Authenticated users can read/update/delete rows they own
permit(
    principal is PgrestLambda::User,
    action in [Action::"select", Action::"update", Action::"delete"],
    resource is PgrestLambda::Row
) when {
    resource has user_id && resource.user_id == principal.id
};

// Authenticated users can insert into any table
permit(
    principal is PgrestLambda::User,
    action == Action::"insert",
    resource is PgrestLambda::Table
);

// Service role bypasses all authorization
permit(principal is PgrestLambda::ServiceRole, action, resource);
```

## Authorization flow

1. Extract principal from JWT (role, userId, email)
2. Construct Cedar principal entity (User, ServiceRole, or AnonRole)
3. Table-level check: `isAuthorized(principal, action, Table::"tablename")`
   - DENY → return 403
4. Row-level filter: `isAuthorizedPartial(principal, action, resource: null)`
   - Concrete Allow, no residuals → no WHERE filter (full access)
   - Concrete Deny → return 403
   - Residuals → walk AST → translate to SQL WHERE clauses
5. Append Cedar-derived WHERE clauses to the SQL query
6. Execute query — database returns only authorized rows

## Residual-to-SQL translation

The residual Expr AST is a tagged JSON union. The translator maps:

| Cedar expression | SQL |
|---|---|
| `resource.col == Value` | `"col" = $N` |
| `resource.col != Value` | `"col" != $N` |
| `resource.col > Value` | `"col" > $N` |
| `&&` | `AND` |
| `\|\|` | `OR` |
| `!` | `NOT` |
| `has(resource, "col")` | `"col" IS NOT NULL` |
| `true` (CPE noise) | collapse / skip |
| Multiple permit residuals | Combined with `OR` |
| Forbid residuals | `AND NOT (condition)` |

All values MUST use parameterized placeholders ($1, $2, ...). Never
string-interpolate Cedar values into SQL.

## Module structure

New file: `src/rest/cedar.mjs` (~200 lines)

Exports:
- `loadPolicies()` — load .cedar files from filesystem or S3, compile
- `authorize({ principal, action, resource, context, schema })` — table-level check
- `buildAuthzFilter({ principal, action, context, schema })` — partial eval → SQL conditions
- `refreshPolicies()` — force reload (called from _refresh endpoint)
- `_setPolicies(policies)` — test injection hook

## Policy storage

- `policies/*.cedar` files in the project root
- For Lambda: uploaded to S3, loaded on cold start with 5-min TTL cache
- For local dev: loaded from filesystem
- `POLICIES_PATH` env var for filesystem, `POLICIES_BUCKET` + `POLICIES_PREFIX` for S3

## What gets removed

- `appendUserId()` function in sql-builder.mjs — replaced by Cedar filter
- All `user_id` column convention logic — replaced by explicit policy
- The `role` parameter threading through buildSelect/buildUpdate/buildDelete/buildCount — Cedar handles role-based access

## Integration points

- `src/rest/handler.mjs` — call cedar.authorize() before SQL, call
  cedar.buildAuthzFilter() to get WHERE conditions
- `src/rest/sql-builder.mjs` — accept Cedar-derived conditions alongside
  user-provided filters
- `src/rest/schema-cache.mjs` — provide column metadata for Cedar schema
  generation
- POST /rest/v1/_refresh — also call cedar.refreshPolicies()

## Dependencies

One new npm dependency: `@cedar-policy/cedar-wasm`

## Test strategy

- Unit tests for residual-to-SQL translation (pure function, no DB needed)
- Unit tests for policy loading and caching
- Integration tests: mock Cedar policies → verify correct WHERE clauses
  in generated SQL
- Test that default policies produce same behavior as current appendUserId
- Test custom policies (admin sees all, public tables, team-scoped)
- Test forbid policies (e.g., no deleting archived items)
- Test that tables without a matching policy are denied by default

## References

- Research: docs/research/cedar-authorization.md
- TinyTodo example: https://github.com/cedar-policy/cedar-examples/tree/main/tinytodo
- Partial evaluation guide: https://cedarland.blog/usage/partial-evaluation/content.html
- Cedar GitHub discussion: cedar-policy/cedar#592
