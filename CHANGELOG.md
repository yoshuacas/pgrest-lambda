# Changelog

All notable changes to pgrest-lambda are documented here.

Format: each release lists what was added, changed, or fixed. Unreleased work sits at the top until it ships.

---

## Unreleased

### Added
- **GoTrue-native auth provider** (opt-in via `AUTH_PROVIDER=gotrue`) — users and refresh tokens stored directly in PostgreSQL (DSQL-compatible), for deployments that want to avoid an AWS Cognito dependency
- **Password validation** with configurable policy (min 8 chars, uppercase, lowercase, numbers) — GoTrue provider
- **Refresh token rotation** with family revocation
- `expires_at` field in session responses for supabase-js v2.39+ compatibility
- Auth endpoints in dev server (`dev.mjs`), which opts into the GoTrue-native provider so local development works without AWS credentials

### Changed
- SAM template: Cognito resources now conditional on `AuthProvider=cognito` parameter (default remains `cognito`)
- Dev server routes auth requests through combined handler
- Default auth provider remains `cognito`; `AUTH_PROVIDER=gotrue` is required to use the GoTrue-native provider

### Security
- **V-07**: Refresh JWTs no longer carry the provider refresh token.
  The `prt` claim is replaced by an opaque `sid` referencing a
  server-side session in `auth.sessions`. Closes V-07 (High).
- **V-05**: Validate `on_conflict` column identifiers against the
  schema cache via `validateCol`, closing the last unvalidated
  identifier-interpolation path in `sql-builder.mjs`. Invalid
  column names now produce a 400 (PGRST204) instead of reaching
  the database.
- **V-04**: Enforce TLS certificate verification on DSQL
  adapter; add secure-default SSL resolution to standard
  Postgres adapter. `ssl: true` now means TLS with
  verification. **Breaking:** connections to databases with
  self-signed certificates will fail unless
  `ssl: { rejectUnauthorized: false }` is set explicitly.
- **V-03**: CORS origin is now configurable via
  `config.cors.allowedOrigins`. Wildcard (`'*'`) is rejected
  when `production` mode is enabled.
- **JWT algorithm pinning** — all `jwt.sign` and `jwt.verify` calls
  now explicitly specify `HS256` via a shared `JWT_ALGORITHM` constant,
  closing algorithm-confusion attacks per RFC 8725 §3.1. Closes V-02.
- **JWT secret strength enforcement** — `createPgrest`, `createJwt`,
  and `createAuthorizer` now reject missing, non-string, or short
  (< 32 character) secrets at construction time with actionable
  error messages. Closes V-01.

### Breaking
- Refresh tokens issued before this version are rejected on
  upgrade. Clients must re-authenticate. Cognito deployments
  now require a PostgreSQL database for session storage
  (`auth.sessions` table).

### Fixed
- **Bulk insert with `columns` query parameter** -- supabase-js sends `?columns=col1,col2,...` on array inserts. pgrest-lambda now recognizes `columns` as a reserved parameter instead of misinterpreting it as a filter. The column list controls which columns are populated from the JSON body.
- **`Prefer: return=representation` on POST** -- insert with `.select()` or `.select().single()` now returns the created row(s) instead of null. Also passes `singleObject` mode through for `.single()` responses.

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
