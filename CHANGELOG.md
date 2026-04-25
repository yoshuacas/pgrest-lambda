# Changelog

All notable changes to pgrest-lambda are documented here.

Format: each release lists what was added, changed, or fixed. Unreleased work sits at the top until it ships.

---

## Unreleased

### Added
- better-auth provider (`AUTH_PROVIDER=better-auth`) —
  self-hosted auth backed by PostgreSQL with
  email+password, magic link (OTP via SES), and
  Google OAuth.
- `POST /auth/v1/otp` — Magic-link email request
- `POST /auth/v1/verify` — OTP token verification
- `GET /auth/v1/authorize` — OAuth flow initiation
- `GET /auth/v1/callback` — OAuth callback handler
- `GET /auth/v1/jwks` — Public JWKS endpoint
- Asymmetric JWT signing (EdDSA) for better-auth
  provider. Cognito continues to use HS256.
- Dual-algorithm verification in Lambda authorizer
  (HS256 for Cognito/apikeys, EdDSA for better-auth
  via JWKS).
- Dependencies: `better-auth`, `jose`,
  `@aws-sdk/client-sesv2`.
- New environment variables for better-auth:
  `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `JWKS_URL`,
  `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
  `SES_FROM_ADDRESS`.
- Shared token verification (`verify-token.mjs`) —
  handler and authorizer use the same dual-algorithm
  verification logic.
- Integration + e2e test harness under `tests/` that
  runs against a real PostgreSQL container (via
  docker-compose) and exercises `@supabase/supabase-js`
  end-to-end. New npm scripts: `test:integration`,
  `test:e2e`, `test:all`. See `tests/README.md` for
  the recipe to run on better-auth version bumps.
- **`pgrest-lambda` CLI** (first iteration) with the
  `dev`, `migrate-auth`, and `generate-key` commands.
  `npx pgrest-lambda dev` boots a bundled Postgres
  container, applies the better-auth schema, starts the
  API on `localhost:3000`, and prints the Scalar docs
  URL and apikeys. Zero configuration for first run.
- New library exports for composition (used by the CLI
  and usable directly by consumers like BOA):
  `startDevServer`, `generateApikey`,
  `startBundledPostgres`, `stopBundledPostgres`,
  `resetBundledPostgres`.
- `.env.example` at the repo root documenting every
  environment variable.
- README Quickstart section.
- `docs/configuration.md` — full environment-variable
  reference, local vs. production secret patterns, and
  guidance on what not to commit.
- `close()` method on REST database adapters (postgres
  and dsql) so tests and long-running processes can
  release pool resources explicitly.
- `getProvider()` exposed by `createAuthHandler` so
  callers can reach the auth provider for cleanup.

### Changed
- Provider interface: `issuesOwnAccessToken` replaces
  `needsSessionTable` as the dispatch flag. When true,
  the provider returns fully-baked tokens; when false,
  the handler mints HS256.
- **`POLICIES_PATH` now accepts a URI.** Filesystem paths
  (`./policies`, `/etc/pgrest/policies`), `file:///...`,
  and `s3://<bucket>/<prefix>/` all resolve through a
  single env var. Replaces the previous split between
  `POLICIES_PATH` (filesystem only) and `POLICIES_BUCKET`
  + `POLICIES_PREFIX` (S3). Breaking for any deployment
  using the old env vars — migrate by setting
  `POLICIES_PATH=s3://<bucket>/<prefix>/` and removing
  the two old ones. See `docs/configuration.md`.

### Removed
- GoTrue auth provider (`AUTH_PROVIDER=gotrue`).
  Deployments on GoTrue must migrate to `better-auth`.
- `bcryptjs` dependency (only used by GoTrue).
- `src/auth/schema.mjs` (GoTrue DDL).
- `src/auth/sessions.mjs` (session-table machinery).

### Fixed
- **Cognito path no longer requires `auth.sessions` table** —
  the handler now skips session creation, lookup, and
  revocation for providers that manage their own refresh
  tokens (Cognito). The Cognito refresh token is returned
  directly to the client.
- **SAM Lambda entrypoints use lazy imports** — `lambda.presignup`,
  `lambda.handler`, and `lambda.authorizer` in `lambda.mjs` no
  longer pay the full pgrest boot cost at module load. The
  PreSignUp trigger previously returned `null` to Cognito because
  `createPgrest()` ran at import time and threw; signup now works
  on the Cognito path.
- Open redirect bypass via protocol-relative URLs
  (`//evil.com`) in OAuth callback error path.
- OAuth callback success redirect using `undefined` as
  base URL — `redirect_to` now threaded through the
  state parameter.
- **better-auth signed-cookie auth failure**:
  `getSessionWithJwt` and `signOut` passed raw session
  tokens in a cookie header, but better-auth signs its
  cookies with an HMAC suffix — the unsigned form
  failed verification silently and returned `null`
  sessions. Switched both call sites to
  `Authorization: Bearer` and enabled the `bearer()`
  plugin. Surfaced by the new integration harness;
  previously hidden by the mocked unit tests.
- **better-auth Zod validation errors surfaced as 500**:
  `VALIDATION_ERROR` and `INVALID_EMAIL` codes from
  better-auth now map to `validation_failed` (400),
  matching the GoTrue contract.
- **`pgrest-lambda dev` regenerated secrets on every
  restart**: CLI now persists generated `JWT_SECRET`
  and `BETTER_AUTH_SECRET` to `.env.local` on first run
  so they survive restarts. Prevents better-auth's
  "Failed to decrypt private key" error, keeps apikeys
  equivalent across reboots, and keeps user sessions
  valid. `.env.local` is gitignored.
- **Scalar docs HTML used `https://` even on localhost**,
  causing mixed-content failures when the UI tried to
  fetch the OpenAPI spec. `resolveApiUrl` now honors the
  `X-Forwarded-Proto` header and falls back to `http://`
  for localhost/127.0.0.1.
- **Auth handler swallowed unexpected failures silently**
  in dev mode. When `production=false`, `unexpected_failure`
  errors now log the stack and upstream response body to
  stderr so developers can diagnose provider errors.

### Documentation
- AWS SAM deploy guide (`docs/deploy/aws-sam/README.md`) rewritten
  against a verified end-to-end deployment. Key corrections:
  `JWT_SECRET` must be a plain SSM `String` (CloudFormation does
  not resolve `ssm-secure` in Lambda env vars); the Lambda package
  is shaped by the `files` list in `package.json` (not `.samignore`,
  which SAM ignores); troubleshooting entries for the real deploy
  failures encountered.
- Removed obsolete `.samignore` at repo root and
  `docs/deploy/aws-sam/handler.mjs` (never referenced by the
  template after the lambda entrypoints moved to `lambda.mjs`).

## 0.2.0 — 2026-04-24

Cognito is the default auth provider. This release hardens JWT handling, refresh-token storage, and TLS verification, and introduces the opt-in GoTrue-native auth provider for deployments that want to avoid an AWS Cognito dependency.

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
  upgrade. Clients must re-authenticate.

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
