# Changelog

All notable changes to pgrest-lambda are documented here.

Format: each release lists what was added, changed, or fixed. Unreleased work sits at the top until it ships.

---

## Unreleased

### Added
- **Logical operators** -- `or` and `and` query parameter keys for PostgREST-compatible boolean logic in WHERE clauses. Supports `not.or`, `not.and`, nested groups up to 10 levels, negated conditions inside groups, `in`/`is`/`like`/`ilike` operators inside groups, and duplicate keys via `multiValueQueryStringParameters`. Wire-compatible with supabase-js `.or()` method.
- **Resource embedding** — fetch related data from multiple tables in a single request using PostgREST-compatible nested select syntax: `?select=*,customers(name,email)`. Supports many-to-one (embedded as object), one-to-many (embedded as array), nested embedding (2+ levels), aliased embeds, `!inner` joins, and `!hint` disambiguation. Uses correlated subqueries with `json_build_object`/`json_agg` for single-query execution.
- **Convention-based relationship detection** for Aurora DSQL and databases without foreign key constraints. Infers relationships from column naming: `customer_id` → `customers`, `category_id` → `categories`, `address_id` → `addresses`. Handles `-s`, `-es`, and `-ies` plural patterns.
- **Foreign key introspection** from `pg_catalog` on standard PostgreSQL. Relationships are cached alongside table/column metadata with the same TTL.
- PGRST200 error code: no relationship found between tables.
- PGRST201 error code: ambiguous relationship, use `!hint` to disambiguate.
- Alias validation in select parser — rejects aliases containing quotes or special characters (prevents SQL injection via crafted aliases).
- Parenthesis balancing validation in select parser.
- Composite primary key support in `return=representation` re-SELECT after mutations with embeds.
- Documentation: resource embedding section in README.md and AGENTS.md with examples for both HTTP and supabase-js.

## 0.1.0

Initial release.

### Added
- **PostgREST-compatible REST engine** — auto-generates CRUD endpoints from PostgreSQL schema introspection. Supports `GET`, `POST`, `PATCH`, `DELETE` on any table in the `public` schema.
- **Filter operators**: `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `like`, `ilike`, `in`, `is`, with `not` negation prefix.
- **Query parameters**: `select` (column projection), `order` (multi-column with `asc`/`desc`/`nullsfirst`/`nullslast`), `limit`, `offset`, `on_conflict` (upsert).
- **Prefer headers**: `return=representation`, `count=exact`, `resolution=merge-duplicates`.
- **Singular response mode**: `Accept: application/vnd.pgrst.object+json` returns a single object instead of an array.
- **Content-Range header** on GET responses with optional exact count.
- **OpenAPI 3.0.3 auto-generation** at `GET /rest/v1/` from live schema introspection.
- **Interactive API docs** at `GET /rest/v1/_docs` powered by Scalar. Configurable via `docs` config or `PGREST_DOCS` env var.
- **Schema cache** with configurable TTL (default 5 minutes). Manual refresh via `POST /rest/v1/_refresh`.
- **GoTrue-compatible auth endpoints**: signup, signin, token refresh, get user, logout. Wire-compatible with `@supabase/supabase-js`.
- **Swappable auth providers** — Cognito is the default. Provider interface at `src/auth/providers/interface.mjs`.
- **Lambda authorizer** — REQUEST-type authorizer validates JWTs from `apikey` header and `Authorization: Bearer` token. Passes `role`, `userId`, `email` to downstream handlers.
- **Cedar authorization** — policy-as-code row-level filtering via partial evaluation, translated to SQL WHERE clauses. Policies loaded from filesystem or S3.
- **Database provider pattern** — pluggable database adapters for standard PostgreSQL and Aurora DSQL (IAM token auth). Custom providers implement a 3-method interface.
- **Library-first architecture** — `createPgrest(config)` factory returns `{ rest, auth, authorizer, handler }`. Config-driven with env var fallbacks.
- **Aurora DSQL support** — IAM auth token generation, DSQL-compatible schema introspection via `pg_catalog`.
- **Local dev server** for testing without deploying to AWS.
- PGRST error codes: PGRST000 (generic), PGRST100 (invalid request), PGRST106 (bulk mutation prevention), PGRST116 (singular response mismatch), PGRST204 (column not found), PGRST205 (table not found).
- PostgreSQL error mapping: unique constraint (23505) → 409, foreign key (23503) → 409, not-null (23502) → 400, undefined table (42P01) → 404, undefined column (42703) → 400.
