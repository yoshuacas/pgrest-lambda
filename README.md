# pgrest-lambda

A serverless REST API for any PostgreSQL database.

Introspects your PostgreSQL schema and serves PostgREST-compatible CRUD endpoints with built-in auth. Works as an npm library in your own project or as a standalone deployment.

## Features

- **PostgREST-compatible query syntax** — filtering, ordering, pagination, upserts, exact counts
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
  auth: {
    provider: 'cognito',
    region: 'us-east-1',
    clientId: process.env.USER_POOL_CLIENT_ID,
  },
  policies: './policies',
});

// Three Lambda handlers, one config
export const handler    = pgrest.handler;     // combined: routes /auth/v1/* and /rest/v1/*
export const authorizer = pgrest.authorizer;  // API Gateway Lambda authorizer
```

pgrest-lambda gives you handler functions. How you deploy them (CDK, SAM, Terraform, SST) is up to you.

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
| `jwtSecret` | `JWT_SECRET` | — |
| `auth.provider` | `AUTH_PROVIDER` | `cognito` |
| `auth.region` | `REGION_NAME` | — |
| `auth.clientId` | `USER_POOL_CLIENT_ID` | — |
| `policies` | `POLICIES_PATH` | `./policies` |
| `policiesBucket` | `POLICIES_BUCKET` | — |
| `schemaCacheTtl` | `SCHEMA_CACHE_TTL_MS` | `300000` (5 min) |

If you only set environment variables, `createPgrest()` with no arguments works.

## Architecture

```
Client (supabase-js, fetch, curl)
  |
  v
API Gateway (REST)
  |
  +-- /auth/v1/*  -->  Auth Handler (GoTrue-compatible)
  |                      +-- signup, token, user, logout
  |                      +-- Cognito provider (swappable)
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

## Cedar Authorization

pgrest-lambda uses Cedar policies for access control. Policies are evaluated via partial evaluation and translated into SQL WHERE clauses before the query runs — the database only returns authorized rows.

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
| `select` | `select=id,name,email` | Columns to return |
| `order` | `order=created_at.desc` | Sort order |
| `limit` | `limit=10` | Max rows |
| `offset` | `offset=20` | Skip rows |
| `on_conflict` | `on_conflict=id` | Upsert conflict column |

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

// Query
const { data } = await supabase
  .from('todos')
  .select('*')
  .order('created_at', { ascending: false });

// Insert
await supabase
  .from('todos')
  .insert({ title: 'Ship it', done: false })
  .select();
```

## Deploy Examples

Deployment examples for SAM, CDK, and Terraform are in `docs/deploy/`.

## License

MIT
