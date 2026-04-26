# pgrest-lambda

A serverless REST API and auth layer for any PostgreSQL database.

Point it at a Postgres schema; get a Supabase-compatible REST API,
user signup/login, OAuth, magic links, and an interactive OpenAPI
explorer. Run it as a CLI, embed it in your own Lambda, or deploy the
reference AWS SAM template.

Works with the `@supabase/supabase-js` client unchanged.

```bash
npm install -g pgrest-lambda
pgrest-lambda dev
```

## Getting started

Two paths depending on whether you want to run pgrest-lambda
standalone or embed it in your own project.

### Path A — Run it locally (most developers start here)

**Prerequisites:** Docker Desktop (or equivalent) running, Node 20+.

Install once, then use `pgrest-lambda` from any directory:

```bash
npm install -g pgrest-lambda
pgrest-lambda dev
```

> Want to skip the install? Run `npx --yes pgrest-lambda dev`
> instead. `npx` downloads the package into a per-machine cache
> (`~/.npm/_npx`) on first use and runs it from there. Useful for
> trying once; global install is tidier for everyday use.

> **Already have Postgres running?** Skip the bundled container and
> point pgrest-lambda at your own database:
>
> ```bash
> DATABASE_URL=postgres://user:pass@host:5432/db \
>   pgrest-lambda dev --skip-docker
> ```
>
> pgrest-lambda will create the `better_auth` schema (tables
> `user`, `session`, `account`, `verification`, `jwks`) in that
> database on first boot — the migration is idempotent, so
> repeated runs are safe. Your `public` schema is untouched.

That's it. No clone, no config, no AWS account. The command:

1. Starts a Postgres container on `localhost:54322` (first run only).
2. Applies the better-auth schema.
3. Starts the API on `http://localhost:3000`.
4. Writes `JWT_SECRET` and `BETTER_AUTH_SECRET` to `.env.local` in
   the current directory (so your apikeys stay stable across
   restarts). `.env.local` is `.gitignore`-ed — don't commit it.
5. Prints a banner with the `DATABASE_URL`, an anon apikey, a
   service-role apikey, and the URL of the interactive docs.

Open `http://localhost:3000/rest/v1/_docs` in a browser. That's the
live Scalar API explorer for your own API.

Use any Supabase client against it:

```javascript
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  'http://localhost:3000',
  '<anon apikey from the banner>',
);

// Signup
const { data: signup } = await supabase.auth.signUp({
  email: 'alice@example.com',
  password: 'Passw0rd!',
});

// Query any table in your `public` schema — endpoints are
// auto-generated from schema introspection.
const { data: rows } = await supabase.from('posts').select();
```

Other commands:

| Command | What it does |
|---|---|
| `pgrest-lambda refresh` | Reload schema cache and Cedar policies without restarting. Run this after you change a `.cedar` file or run a migration. |
| `pgrest-lambda generate-key anon` | Mint an anon apikey JWT (prints to stdout). |
| `pgrest-lambda generate-key service_role` | Mint a service-role apikey JWT. |
| `pgrest-lambda migrate-auth` | Apply the better-auth schema against `DATABASE_URL`. For production bootstraps. |
| `pgrest-lambda help` | Full command reference. |

To stop the API server: `Ctrl-C` in the terminal running `dev`.

The Postgres container (named `pgrest-lambda-dev-postgres`) keeps
running and its data persists across restarts. To stop or wipe it:

```bash
# Stop Postgres, keep data:
docker stop pgrest-lambda-dev-postgres

# Wipe Postgres and its data volume for a clean slate:
docker rm -f pgrest-lambda-dev-postgres
docker volume rm docker_pgrest_lambda_dev_data
```

### Path B — Embed pgrest-lambda in your own project

For a custom deploy (your own Lambda wrapper, Fastify server, Kong
plugin, Cloudflare Worker, etc.):

```bash
npm install pgrest-lambda
```

```javascript
import { createPgrest } from 'pgrest-lambda';

const pgrest = createPgrest({
  database: { connectionString: process.env.DATABASE_URL },
  jwtSecret: process.env.JWT_SECRET,
  auth: {
    provider: 'better-auth',
    betterAuthSecret: process.env.BETTER_AUTH_SECRET,
    betterAuthUrl: process.env.BETTER_AUTH_URL,
  },
});

// pgrest.handler takes an API Gateway-style event and returns a
// { statusCode, headers, body } response. Route HTTP requests into
// it however your platform expects.
export const handler = pgrest.handler;
```

See [docs/configuration.md](docs/configuration.md) for the full config
reference.

If you're deploying to AWS Lambda behind API Gateway, the
[`deploy/aws-sam/`](deploy/aws-sam/) folder ships a reference
template. It also exposes a Lambda authorizer on a subpath export:

```javascript
import { createAuthorizer } from 'pgrest-lambda/aws-sam';
export const authorizer = createAuthorizer({
  jwtSecret: process.env.JWT_SECRET,
}).handler;
```

## Features

- **PostgREST-compatible query syntax** — filtering, ordering, pagination, upserts, exact counts, resource embedding (joins).
- **Supabase-compatible auth** — signup, signin, refresh, user profile, magic link, OAuth, JWKS. Works with the `@supabase/supabase-js` client unchanged.
- **Cedar authorization** — policy-as-code row-level filtering, translated into SQL `WHERE` clauses before query execution.
- **OpenAPI 3.0 auto-generation** — live spec at `GET /rest/v1/`, interactive Scalar docs at `GET /rest/v1/_docs`.
- **Multiple database backends** — Aurora DSQL (IAM auth), Aurora Serverless v2, RDS PostgreSQL, or any PostgreSQL.
- **Swappable auth providers** — better-auth (default, DB-only, no AWS) or Cognito (AWS-managed).
- **Deploy-agnostic core** — the library doesn't care whether it's behind API Gateway, Kong, Cloudflare Workers, or plain Express. The `deploy/` folder ships reference integrations.

## Configuration

Everything below can be passed as an argument to `createPgrest()` or
set as an environment variable. Explicit arguments win over env vars,
env vars win over defaults.

### Database

| Config key | Env var | Default |
|---|---|---|
| `database.connectionString` | `DATABASE_URL` | — |
| `database.host` | `PG_HOST` | `localhost` |
| `database.port` | `PG_PORT` | `5432` |
| `database.user` | `PG_USER` | `postgres` |
| `database.password` | `PG_PASSWORD` | `''` |
| `database.database` | `PG_DATABASE` | `postgres` |
| `database.ssl` | `PG_SSL` | `false` (see TLS below) |
| `database.dsqlEndpoint` | `DSQL_ENDPOINT` | — (Aurora DSQL mode) |

### Auth

| Config key | Env var | Default |
|---|---|---|
| `jwtSecret` | `JWT_SECRET` | — (required, ≥ 32 chars) |
| `auth.provider` | `AUTH_PROVIDER` | `better-auth` |
| `auth.betterAuthSecret` | `BETTER_AUTH_SECRET` | — (required when provider is `better-auth`) |
| `auth.betterAuthUrl` | `BETTER_AUTH_URL` | — (required for OAuth callbacks) |
| `auth.googleClientId` | `GOOGLE_CLIENT_ID` | — (enables `/auth/v1/authorize?provider=google`) |
| `auth.googleClientSecret` | `GOOGLE_CLIENT_SECRET` | — |
| `auth.sesFromAddress` | `SES_FROM_ADDRESS` | — (required for magic-link emails) |
| `auth.region` | `REGION_NAME` | — (Cognito and SES) |
| `auth.clientId` | `USER_POOL_CLIENT_ID` | — (Cognito) |

### Other

| Config key | Env var | Default |
|---|---|---|
| `policies` | `POLICIES_PATH` | `./policies` (filesystem path or `s3://<bucket>/<prefix>/`) |
| `cors.allowedOrigins` | — | `'*'` (rejected in production mode; provide a list) |
| `cors.allowCredentials` | — | `false` |
| `schemaCacheTtl` | `SCHEMA_CACHE_TTL_MS` | `30000` (30 sec) |
| `docs` | `PGREST_DOCS` | `true` |
| `production` | — | `process.env.NODE_ENV === 'production'` |

For production deploys and secret-management patterns, see
[docs/configuration.md](docs/configuration.md).

### TLS

The `database.ssl` option controls TLS to the database:

| Value | TLS | Verification |
|---|---|---|
| `undefined` / `false` | Off | — |
| `true` | On | On (secure default) |
| `{ ca: '...' }` | On | On with custom CA |
| `{ rejectUnauthorized: false }` | On | Off (consumer accepts MITM risk) |

DSQL connections always verify TLS. When `DATABASE_URL` is set, TLS is
controlled by `sslmode=...` in the URL and `database.ssl` is ignored.

### Alternative auth setups

**No auth at all.** REST-only mode:

```javascript
createPgrest({ auth: false });
```

**Custom auth handler.** Your function replaces the `/auth/v1/*` path:

```javascript
createPgrest({ auth: (event) => yourHandler(event) });
```

**Cognito.** Use the AWS-managed user pool instead of better-auth:

```javascript
createPgrest({
  auth: {
    provider: 'cognito',
    region: 'us-east-1',
    clientId: process.env.USER_POOL_CLIENT_ID,
  },
});
```

## Authorization

Every REST request runs through a Cedar policy check. The engine
combines all `.cedar` files in `policies/` (or whatever
`POLICIES_PATH` points at), translates each row-level predicate into
a SQL `WHERE` clause, and attaches it to the query before execution.

The shipped `policies/default.cedar` lets authenticated users read /
write their own rows (`resource.user_id == principal`) and lets
`service_role` bypass everything.

See [docs/authorization.md](docs/authorization.md) for a full guide
with recipes (public read, team-scoped, admin override,
forbid-on-archived), error reference, and a Cedar syntax cheatsheet.

Quick example:

```cedar
// Everyone — including anon — reads the posts table.
permit(
    principal,
    action == PgrestLambda::Action::"select",
    resource is PgrestLambda::Row
) when {
    context.table == "posts"
};
```

## API reference

### REST endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/rest/v1/` | OpenAPI 3.0 spec (auto-generated) |
| `GET` | `/rest/v1/_docs` | Interactive Scalar UI |
| `POST` | `/rest/v1/_refresh` | Reload schema cache + policies |
| `GET` | `/rest/v1/:table` | Read rows |
| `POST` | `/rest/v1/:table` | Insert rows |
| `PATCH` | `/rest/v1/:table` | Update rows (filters required) |
| `DELETE` | `/rest/v1/:table` | Delete rows (filters required) |

### Query parameters

| Parameter | Example | Description |
|---|---|---|
| `select` | `select=id,name,customers(email)` | Columns + resource embedding |
| `order` | `order=created_at.desc` | Sort order |
| `limit` | `limit=10` | Max rows |
| `offset` | `offset=20` | Skip rows |
| `on_conflict` | `on_conflict=id` | Upsert conflict column |

### Filter operators

Apply to any column as `column=<op>.<value>`:

| Operator | Example | SQL |
|---|---|---|
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
|---|---|
| `apikey` | Apikey JWT — anon or service_role |
| `Authorization: Bearer <token>` | User access token (for authenticated requests) |
| `Prefer: return=representation` | Return inserted/updated rows in the response body |
| `Prefer: count=exact` | Include exact row count in `Content-Range` |
| `Accept: application/vnd.pgrst.object+json` | Return a single object instead of an array |

### Auth endpoints

| Method | Path | Description |
|---|---|---|
| `POST` | `/auth/v1/signup` | Register a new user |
| `POST` | `/auth/v1/token?grant_type=password` | Sign in |
| `POST` | `/auth/v1/token?grant_type=refresh_token` | Refresh access token |
| `GET` | `/auth/v1/user` | Get current user profile |
| `POST` | `/auth/v1/logout` | Sign out |
| `POST` | `/auth/v1/otp` | Send a magic-link email |
| `POST` | `/auth/v1/verify` | Verify an OTP / magic-link token |
| `GET` | `/auth/v1/authorize?provider=<name>` | Begin OAuth flow |
| `GET` | `/auth/v1/callback` | OAuth callback |
| `GET` | `/auth/v1/jwks` | Public JWKS for asymmetric JWT verification |

### Resource embedding

Fetch related data from multiple tables in a single request. pgrest-lambda
detects foreign key relationships automatically on standard PostgreSQL and
infers them from column naming (`customer_id` → `customers`) on Aurora DSQL.

```javascript
// Many-to-one
await supabase.from('orders')
  .select('id, amount, customers(name, email)');

// One-to-many
await supabase.from('customers')
  .select('id, name, orders(id, amount)');

// Nested (2+ levels)
await supabase.from('orders')
  .select('id, items(quantity, products(name, price))');

// Alias, disambiguate, inner join
await supabase.from('orders')
  .select('id, buyer:customers(name), billing:addresses!billing_address_id(*)');

await supabase.from('customers')
  .select('id, name, orders!inner(id)');  // only customers with at least one order
```

## Architecture

```
Client (supabase-js, fetch, curl)
  │
  ▼
Your platform (API Gateway, Kong, Cloudflare Workers, Express, …)
  │
  ▼
pgrest-lambda handler
  │
  ├── /auth/v1/*  →  Auth provider (better-auth or Cognito)
  │                     └── signup, signin, refresh, OAuth, magic link, JWKS
  │
  └── /rest/v1/*  →  REST engine
                        ├── Schema introspection (pg_catalog)
                        ├── Query parsing (PostgREST-compatible)
                        ├── Cedar authorization → SQL WHERE
                        ├── OpenAPI generation
                        └── PostgreSQL (DSQL, Aurora, RDS, any)
```

The library exposes `createPgrest(config)`. Everything else — how
requests arrive, how JWTs are verified, how the result is returned to
the client — is a deploy-target concern. See [`deploy/`](deploy/) for
reference integrations.

## Deploy

Each subfolder under `deploy/` is one way to run pgrest-lambda in
production. Core library code stays deploy-agnostic.

- [**AWS SAM**](deploy/aws-sam/) — API Gateway + Lambda + (optional) Cognito. Supports DSQL, Aurora, and standard Postgres.

More targets welcome — the pattern is in
[`deploy/aws-sam/README.md`](deploy/aws-sam/README.md).

## License

MIT.
