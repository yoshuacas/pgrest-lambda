# pgrest-lambda

A serverless REST API for any PostgreSQL database.

Introspects your PostgreSQL schema and serves PostgREST-compatible CRUD endpoints with built-in auth. Works as an npm library in your own project or as a standalone deployment.

## Quickstart

Prerequisites: Docker Desktop (or equivalent) running, Node 20+.

```bash
npx pgrest-lambda dev
```

This will:

1. Start a Postgres container on `localhost:54322` (first run only).
2. Apply the better-auth schema.
3. Start the API on `http://localhost:3000`.
4. Print an anon apikey and the URL of the interactive docs.

Open the Scalar UI at `http://localhost:3000/rest/v1/_docs` to browse
the API. Point `@supabase/supabase-js` at `http://localhost:3000` with
the anon apikey and you're off.

On first run the CLI generates `JWT_SECRET` and `BETTER_AUTH_SECRET`
and writes them to `.env.local` so apikeys are stable across restarts.
`.env.local` is gitignored — never commit it. See
[docs/configuration.md](docs/configuration.md) for the full variable
reference and production secret patterns.

Other commands: `pgrest-lambda migrate-auth` (apply better-auth schema
against `DATABASE_URL`), `pgrest-lambda generate-key <anon|service_role>`
(mint apikeys), `pgrest-lambda help`.

## Features

- **PostgREST-compatible query syntax** — filtering, ordering, pagination, upserts, exact counts, resource embedding (joins)
- **GoTrue-compatible auth** — signup, signin, token refresh, user profile (`@supabase/supabase-js` works as a client)
- **Cedar authorization** — policy-as-code row-level filtering via partial evaluation, translated to SQL WHERE clauses
- **OpenAPI 3.0 auto-generation** — hit `GET /rest/v1/` for the full spec
- **Multiple database backends** — Aurora DSQL (IAM auth), Aurora Serverless v2, RDS PostgreSQL, or any PostgreSQL
- **Library-first** — use as an npm package in your own Lambda, or deploy standalone

## Usage

### As a library

```bash
npm install pgrest-lambda
```

```javascript
import { createPgrest } from 'pgrest-lambda';

const pgrest = createPgrest({
  database: {
    host: 'your-db-host.amazonaws.com',
    port: 5432,
    user: 'postgres',
    password: 'secret',
    database: 'mydb',
  },
  jwtSecret: process.env.JWT_SECRET,
  policies: './policies',
  auth: {
    provider: 'cognito',
    region: 'us-east-1',
    clientId: process.env.USER_POOL_CLIENT_ID,
  },
});
// Auth defaults to Cognito. For a DB-only deployment with no
// AWS dependency, opt into the GoTrue-native provider below.
```

To use the GoTrue-native provider (users and refresh tokens
stored in the same PostgreSQL database, no external dependencies):

```javascript
const pgrest = createPgrest({
  database: { ... },
  jwtSecret: process.env.JWT_SECRET,
  auth: { provider: 'better-auth' },
});

// One combined handler that routes /auth/v1/* to auth and /rest/v1/* to REST.
export const handler = pgrest.handler;
```

pgrest-lambda gives you handler functions. How you deploy them (CDK, SAM,
Terraform, SST, Kong, Cloudflare Workers, plain Express) is up to you.
AWS Lambda authorizers are a deploy-target concern — see
[`deploy/aws-sam/`](deploy/aws-sam/) if you're using AWS API Gateway:

```javascript
import { createAuthorizer } from 'pgrest-lambda/aws-sam';
export const authorizer = createAuthorizer({ jwtSecret: process.env.JWT_SECRET }).handler;
```

### Override auth

Bring your own auth handler:

```javascript
const pgrest = createPgrest({
  database: { connectionString: process.env.DATABASE_URL },
  jwtSecret: process.env.JWT_SECRET,
  auth: myCustomAuthHandler,  // any (event) => response function
});
```

### Disable auth

REST-only mode when you handle auth elsewhere:

```javascript
const pgrest = createPgrest({
  database: { connectionString: process.env.DATABASE_URL },
  jwtSecret: process.env.JWT_SECRET,
  auth: false,
});
// pgrest.auth is null, pgrest.handler routes everything to REST
```

### DSQL mode

```javascript
const pgrest = createPgrest({
  database: {
    dsqlEndpoint: 'your-cluster.dsql.us-east-1.on.aws',
    region: 'us-east-1',
  },
  jwtSecret: process.env.JWT_SECRET,
});
```

### CORS Configuration

Control which origins can make cross-origin requests to your API.

```javascript
createPgrest({
  cors: {
    allowedOrigins: ['https://app.example.com'],
    allowCredentials: false,
  },
  production: true,
  // ... other config
});
```

| Config key | Type | Default |
|---|---|---|
| `cors.allowedOrigins` | `'*'`, `string[]`, or `(origin) => boolean` | `'*'` |
| `cors.allowCredentials` | `boolean` | `false` |
| `production` | `boolean` | `process.env.NODE_ENV === 'production'` |

Wildcard origins (`'*'`) are rejected when `production` mode is
enabled — `createPgrest` throws at construction time. In
production, provide an explicit list of allowed origins.

**Security note:** even with `allowedOrigins: '*'`, the anon
`apikey` is public by design. CORS origin restriction limits
which sites can make cross-origin requests, but the anon key is
not a secret. To protect sensitive data, use Cedar policies and
authenticated requests with per-user Bearer tokens.

### Config resolution

The factory resolves config in order: explicit values, then environment variables, then defaults.

| Config key | Env var fallback | Default |
|---|---|---|
| `database.dsqlEndpoint` | `DSQL_ENDPOINT` | — |
| `database.connectionString` | `DATABASE_URL` | — |
| `database.host` | `PG_HOST` | `localhost` |
| `database.port` | `PG_PORT` | `5432` |
| `database.user` | `PG_USER` | `postgres` |
| `database.password` | `PG_PASSWORD` | `''` |
| `database.database` | `PG_DATABASE` | `postgres` |
| `database.ssl` | `PG_SSL` | `false` |
| `jwtSecret` | `JWT_SECRET` | — (required, >= 32 chars; generate with `openssl rand -base64 48`) |
| `auth.provider` | `AUTH_PROVIDER` | `cognito` |
| `auth.region` | `REGION_NAME` | — |
| `auth.clientId` | `USER_POOL_CLIENT_ID` | — |
| `policies` | `POLICIES_PATH` | `./policies` (filesystem path or `s3://<bucket>/<prefix>/`) |
| `schemaCacheTtl` | `SCHEMA_CACHE_TTL_MS` | `30000` (30 sec) |
| `docs` | `PGREST_DOCS` | `true` |

If you only set environment variables, `createPgrest()` with no arguments works.

### TLS Configuration

The `database.ssl` option controls TLS to the database. Four
postures are available:

```javascript
// No TLS (localhost, same-VPC). Default when ssl is unset.
createPgrest({ database: { host: 'localhost' } });

// TLS with certificate verification (secure default).
createPgrest({ database: { host: 'db.example.com', ssl: true } });

// TLS with a private CA (verification on by default).
createPgrest({
  database: {
    host: 'db.internal',
    ssl: { ca: fs.readFileSync('/path/to/ca.pem', 'utf8') },
  },
});

// TLS without verification (consumer explicitly accepts MITM risk).
createPgrest({
  database: {
    host: 'db.internal',
    ssl: { rejectUnauthorized: false },
  },
});
```

| `database.ssl` value | TLS | Certificate verification |
|---|---|---|
| `undefined` / `false` | Off | N/A |
| `true` | On | On |
| `{ ca: '...' }` | On | On (with custom CA) |
| `{ rejectUnauthorized: false }` | On | Off |

DSQL connections always verify TLS certificates. AWS-managed
certificates chain to public roots included in the Node.js trust
store. There is no config surface and no opt-out for DSQL.

When `database.connectionString` (or `DATABASE_URL`) is set, TLS
is controlled by `sslmode=...` in the URL. The `database.ssl`
option is not applied.

**Breaking change:** `ssl: true` now means TLS *with* certificate
verification. Consumers who previously set `ssl: true` and connect
to a database with a self-signed certificate will see TLS errors.
To restore the old behavior, pass
`ssl: { rejectUnauthorized: false }` explicitly.

## Architecture

```
Client (supabase-js, fetch, curl)
  |
  v
API Gateway (REST)
  |
  +-- /auth/v1/*  -->  Auth Handler (GoTrue-compatible)
  |                      +-- signup, token, user, logout
  |                      +-- Cognito (default) or GoTrue-native
  |
  +-- /rest/v1/*  -->  REST Handler (PostgREST-compatible)
  |    |                 +-- schema introspection
  |    |                 +-- query parsing + SQL building
  |    |                 +-- Cedar authorization (partial eval -> SQL WHERE)
  |    |                 +-- OpenAPI generation
  |    v
  |  PostgreSQL (DSQL / Aurora / RDS / any)
  |
  +-- Authorizer  -->  JWT validation (apikey + bearer dual-layer)
```

## API Documentation

pgrest-lambda serves interactive API documentation at `GET /rest/v1/_docs`, powered by [Scalar](https://scalar.com). The docs page loads from CDN and fetches the auto-generated OpenAPI spec — no build step, no extra dependencies.

The OpenAPI 3.0 spec itself is at `GET /rest/v1/` and includes all tables, columns, types, and operations discovered from your database.

To disable the docs page (e.g., in production):

```javascript
createPgrest({ docs: false, ... })
```

Or via environment variable:

```
PGREST_DOCS=false
```

The OpenAPI spec at `/rest/v1/` remains available regardless of this setting.

## Cedar Authorization

pgrest-lambda uses Cedar policies for access control. Policies are evaluated via partial evaluation and translated into SQL WHERE clauses before the query runs — the database only returns authorized rows.

See [docs/authorization.md](docs/authorization.md) for a guide with
recipes (public read, team-scoped, admin override, forbid-on-archived)
and an error reference.

Default policies in `policies/default.cedar`:

```cedar
// Authenticated users can read/update/delete their own rows
permit(
    principal is PgrestLambda::User,
    action in [Action::"select", Action::"update", Action::"delete"],
    resource is PgrestLambda::Row
) when {
    resource has user_id && resource.user_id == principal
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

Write custom policies by adding `.cedar` files to the `policies/` directory:

```cedar
// Admins see all rows
permit(
    principal is PgrestLambda::User,
    action == Action::"select",
    resource
) when {
    principal.role == "admin"
};

// Public tables readable by anyone
permit(
    principal,
    action == Action::"select",
    resource is PgrestLambda::Row
) when {
    context.table == "public_posts"
};
```

## API Reference

### REST Endpoints (`/rest/v1/`)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/rest/v1/` | OpenAPI 3.0 spec |
| `POST` | `/rest/v1/_refresh` | Refresh schema cache + policies |
| `GET` | `/rest/v1/:table` | Read rows |
| `POST` | `/rest/v1/:table` | Insert rows |
| `PATCH` | `/rest/v1/:table` | Update rows (filters required) |
| `DELETE` | `/rest/v1/:table` | Delete rows (filters required) |

### Query Parameters

| Parameter | Example | Description |
|-----------|---------|-------------|
| `select` | `select=id,name,email` | Columns to return (supports embedding) |
| `order` | `order=created_at.desc` | Sort order |
| `limit` | `limit=10` | Max rows |
| `offset` | `offset=20` | Skip rows |
| `on_conflict` | `on_conflict=id` | Upsert conflict column |

### Resource Embedding (Joins)

Fetch related data from multiple tables in a single request. pgrest-lambda detects foreign key relationships automatically and generates correlated subqueries.

```javascript
// Many-to-one: order belongs to a customer
const { data } = await supabase
  .from('orders')
  .select('id, amount, customers(name, email)')

// Returns: [{ id: 1, amount: 99.50, customers: { name: "Alice", email: "alice@ex.com" } }]
```

```javascript
// One-to-many: customer has many orders
const { data } = await supabase
  .from('customers')
  .select('id, name, orders(id, amount)')

// Returns: [{ id: 1, name: "Alice", orders: [{ id: 10, amount: 50 }, { id: 11, amount: 75 }] }]
```

```javascript
// Nested: orders → line items → products
const { data } = await supabase
  .from('orders')
  .select('id, items(id, quantity, products(name, price))')
```

```javascript
// Aliased embed: rename the embedded key in the response
const { data } = await supabase
  .from('orders')
  .select('id, buyer:customers(name)')

// Returns: [{ id: 1, buyer: { name: "Alice" } }]
```

```javascript
// Disambiguation: two FKs to the same table
const { data } = await supabase
  .from('orders')
  .select('id, billing:addresses!billing_address_id(*), shipping:addresses!shipping_address_id(*)')
```

```javascript
// Inner join: only parents with matching children
const { data } = await supabase
  .from('customers')
  .select('id, name, orders!inner(id)')
// Only returns customers who have at least one order
```

**URL syntax:**

| Pattern | Meaning |
|---------|---------|
| `select=*,customers(*)` | Embed all columns from related table |
| `select=id,customers(name,email)` | Embed specific columns |
| `select=id,buyer:customers(name)` | Alias the embed key |
| `select=*,addresses!billing_address_id(*)` | Disambiguate when multiple FKs exist |
| `select=*,orders!inner(*)` | Inner join — exclude parents without children |
| `select=id,items(id,products(name))` | Nested embedding (2+ levels) |

**Relationship detection:**

**Relationship detection:**

On standard PostgreSQL, relationships are detected automatically from foreign key constraints — no configuration needed.

On Aurora DSQL (which doesn't support `REFERENCES`), relationships are inferred from a column naming convention. Name your FK columns as `{singular_table}_id` and pgrest-lambda figures out the rest:

| Column name | Target table found |
|---|---|
| `customer_id` | `customers` |
| `category_id` | `categories` |
| `address_id` | `addresses` |
| `status_id` | `statuses` |
| `company_id` | `companies` |

The convention requires: the target table exists in the `public` schema, and it has a primary key that matches. If no match is found, no relationship is created (no error).

### Filter Operators

| Operator | Example | SQL |
|----------|---------|-----|
| `eq` | `name=eq.John` | `name = 'John'` |
| `neq` | `status=neq.done` | `status != 'done'` |
| `gt` / `gte` | `age=gt.21` | `age > 21` |
| `lt` / `lte` | `price=lt.100` | `price < 100` |
| `like` | `name=like.*john*` | `name LIKE '%john%'` |
| `ilike` | `name=ilike.*john*` | `name ILIKE '%john%'` |
| `in` | `id=in.(1,2,3)` | `id IN (1, 2, 3)` |
| `is` | `deleted_at=is.null` | `deleted_at IS NULL` |
| `not.*` | `status=not.eq.done` | `status != 'done'` |

### Headers

| Header | Description |
|--------|-------------|
| `apikey` | API key JWT (anon or service_role) |
| `Authorization: Bearer <token>` | User access token |
| `Prefer: return=representation` | Return modified rows |
| `Prefer: count=exact` | Include exact count in Content-Range |
| `Accept: application/vnd.pgrst.object+json` | Return single object |

### Auth

Cognito is the default auth provider. Set `AUTH_PROVIDER=cognito`
(or omit it) and provide `REGION_NAME`, `USER_POOL_ID`, and
`USER_POOL_CLIENT_ID` at runtime.

A GoTrue-native provider is available for deployments that want
to avoid an AWS Cognito dependency. Opt in with
`AUTH_PROVIDER=gotrue` or `auth: { provider: 'gotrue' }`. Users
and refresh tokens are then stored in the `auth` schema of the
same PostgreSQL database, works with any PostgreSQL backend
including Aurora DSQL.

Password policy (GoTrue-native): minimum 8 characters, at least
one uppercase letter, one lowercase letter, and one number.

Refresh tokens use rotation with family revocation: each refresh
issues a new token and invalidates the old one. If a
previously-used token is replayed, the entire token family is
revoked. This applies to both providers.

Refresh JWTs carry an opaque session ID (`sid`) instead of the
provider token. The actual provider refresh token is stored
server-side in `auth.sessions` and resolved on each refresh
request.

The dev server (`node dev.mjs`) opts into the GoTrue-native
provider so local development works with just a Postgres
container and no AWS credentials.

### Auth Endpoints (`/auth/v1/`)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/auth/v1/signup` | Register new user |
| `POST` | `/auth/v1/token?grant_type=password` | Sign in |
| `POST` | `/auth/v1/token?grant_type=refresh_token` | Refresh token |
| `GET` | `/auth/v1/user` | Get current user |
| `POST` | `/auth/v1/logout` | Sign out (204) |

## Client Example

```javascript
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  'https://YOUR_API_URL/v1',
  'YOUR_ANON_KEY'
);

// Sign up
await supabase.auth.signUp({
  email: 'user@example.com',
  password: 'Password123',
});

// Query with embedding — fetch todos with their project info
const { data } = await supabase
  .from('todos')
  .select('id, title, done, projects(name)')
  .order('created_at', { ascending: false });

// Flat query
const { data: todos } = await supabase
  .from('todos')
  .select('*')
  .eq('done', false);

// Insert
await supabase
  .from('todos')
  .insert({ title: 'Ship it', done: false })
  .select();
```

## Deploy Examples

Deployment examples live in `deploy/` — each subfolder is one way to
run pgrest-lambda in production. Core library code under `src/` stays
deploy-target-agnostic.

- **AWS SAM** — [`deploy/aws-sam/README.md`](deploy/aws-sam/README.md). Provisions API Gateway, Lambda, and (optionally) Cognito. Supports DSQL and standard Postgres.

## License

MIT
