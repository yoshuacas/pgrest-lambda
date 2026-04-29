<p align="center">
  <em>A serverless REST API and auth layer for any PostgreSQL database.</em>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/pgrest-lambda"><img src="https://img.shields.io/npm/v/pgrest-lambda.svg" alt="npm" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/npm/l/pgrest-lambda.svg" alt="License: MIT" /></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/node/v/pgrest-lambda.svg" alt="Node.js" /></a>
</p>

<p align="center">
  <a href="#quickstart">Quickstart</a> &middot;
  <a href="#use-as-a-library">Library</a> &middot;
  <a href="./docs/configuration.md">Configuration</a> &middot;
  <a href="./docs/authorization.md">Authorization</a> &middot;
  <a href="./docs/rpc.md">RPC</a> &middot;
  <a href="./deploy/aws-sam">Deploy</a>
</p>

---

## What is pgrest-lambda?

Point it at a Postgres schema and get a Supabase-compatible REST API, user
signup/login, OAuth, magic links, and an interactive OpenAPI explorer. Run it
as a CLI for local development, embed it in your own server, or deploy the
reference AWS SAM template.

Works with the [`@supabase/supabase-js`](https://github.com/supabase/supabase-js)
client unchanged. If you've been using Supabase but want your own stack on
your own account, pgrest-lambda drops into the same client code.

## Key features

- **PostgREST-compatible query syntax** &mdash; filtering, ordering, pagination, upserts, exact counts, and resource embedding (joins).
- **Supabase-wire-compatible auth** &mdash; signup, signin, refresh, user profile, magic link, OAuth, and JWKS.
- **Cedar authorization** &mdash; policy-as-code row-level filters, translated into SQL `WHERE` clauses before each query runs.
- **OpenAPI 3.0 auto-generation** &mdash; live spec and an interactive Scalar explorer on every running instance.
- **Multiple database backends** &mdash; Aurora DSQL (IAM auth), Aurora Serverless v2, RDS PostgreSQL, or any reachable Postgres.
- **Swappable auth providers** &mdash; `better-auth` (default, DB-only, no AWS) or Amazon Cognito.
- **Deploy-agnostic core** &mdash; the library doesn't care whether it's behind API Gateway, Kong, Cloudflare Workers, or plain Express.

## Quickstart

Get to a working REST API in under 60 seconds. Requires Node.js 20+ and a
running Docker daemon.

```bash
npx --yes pgrest-lambda dev
```

That's it. No clone, no config, no AWS account. The command:

1. Starts a Postgres container on `localhost:54322` (first run only).
2. Applies the `better_auth` schema.
3. Starts the API on `http://localhost:3000`.
4. Writes `JWT_SECRET` and `BETTER_AUTH_SECRET` to `.env.local` so apikeys stay stable across restarts.
5. Prints a banner with the `DATABASE_URL`, an anon apikey, a service-role apikey, and the docs URL.

Open `http://localhost:3000/rest/v1/_docs` for the live Scalar API explorer on
your own schema. Then point any Supabase client at it:

```javascript
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  'http://localhost:3000',
  '<anon apikey from the banner>',
);

// Signup
await supabase.auth.signUp({
  email: 'alice@example.com',
  password: 'Passw0rd!',
});

// Query any table in your `public` schema — endpoints are
// auto-generated from schema introspection.
const { data: posts } = await supabase.from('posts').select();
```

<details>
<summary>Already have Postgres running? Skip the bundled container.</summary>

```bash
DATABASE_URL=postgres://user:pass@host:5432/db \
  npx pgrest-lambda dev --skip-docker
```

pgrest-lambda creates the `better_auth` schema (tables `user`, `session`,
`account`, `verification`, `jwks`) on first boot. The migration is
idempotent, and your `public` schema is untouched.

</details>

## Installation

For everyday use, install globally:

```bash
npm install -g pgrest-lambda
```

Or as a dependency, if you want to embed it in your own server or Lambda:

```bash
npm install pgrest-lambda
```

**Requirements**

- Node.js 20+
- A Docker daemon (only for `pgrest-lambda dev` with the bundled Postgres container &mdash; not needed if you pass your own `DATABASE_URL`)

## Use as a library

`createPgrest(config)` returns a handler you can route requests into. It
accepts an API Gateway-style event and returns a
`{ statusCode, headers, body }` response, so it works on AWS Lambda, Fastify,
Express, Cloudflare Workers, or any platform you can translate to that shape.

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

export const handler = pgrest.handler;
```

All configuration can be passed as an argument or read from environment
variables &mdash; explicit arguments win over env vars, env vars win over
defaults. The full reference lives in
[docs/configuration.md](./docs/configuration.md); the most common keys are:

| Config key | Env var | Notes |
|---|---|---|
| `database.connectionString` | `DATABASE_URL` | Standard Postgres URI. |
| `database.dsqlEndpoint` | `DSQL_ENDPOINT` | Switches to Aurora DSQL IAM auth. |
| `jwtSecret` | `JWT_SECRET` | HS256 secret for apikeys, &ge; 32 chars. |
| `auth.provider` | `AUTH_PROVIDER` | `better-auth` (default) or `cognito`. |
| `policies` | `POLICIES_PATH` | Path or `s3://bucket/prefix/` for `.cedar` files. Defaults to `./policies`. |
| `cors.allowedOrigins` | &mdash; | `'*'` rejected in production; provide a list. |

<details>
<summary>Alternative auth setups</summary>

**REST-only, no auth:**

```javascript
createPgrest({ auth: false });
```

**Custom auth handler &mdash; your function replaces `/auth/v1/*`:**

```javascript
createPgrest({ auth: (event) => yourHandler(event) });
```

**Amazon Cognito instead of better-auth:**

```javascript
createPgrest({
  auth: {
    provider: 'cognito',
    region: 'us-east-1',
    clientId: process.env.USER_POOL_CLIENT_ID,
  },
});
```

</details>

## Authorization

Every REST request runs through a [Cedar](https://www.cedarpolicy.com/) policy
check. The engine combines all `.cedar` files in `policies/` (or wherever
`POLICIES_PATH` points), translates each row-level predicate into a SQL
`WHERE` clause, and attaches it to the query before execution.

The shipped `policies/default.cedar` lets authenticated users read and write
their own rows (`resource.user_id == principal`) and lets `service_role`
bypass all checks.

```cedar
// Everyone — including anon — can read the posts table.
permit(
    principal,
    action == PgrestLambda::Action::"select",
    resource is PgrestLambda::Row
) when {
    context.table == "posts"
};
```

See [docs/authorization.md](./docs/authorization.md) for a full guide with
recipes (public read, team-scoped, admin override, forbid-on-archived), an
error reference, and a Cedar syntax cheatsheet.

## How it works

```text
Client (supabase-js, fetch, curl)
  |
  v
Your platform (API Gateway, Kong, Cloudflare Workers, Express, ...)
  |
  v
pgrest-lambda handler
  |
  +--- /auth/v1/*  -->  Auth provider (better-auth or Cognito)
  |                        signup, signin, refresh, OAuth, magic link, JWKS
  |
  +--- /rest/v1/*  -->  REST engine
                           schema introspection (pg_catalog)
                           query parsing (PostgREST-compatible)
                           Cedar authorization (compiled to SQL WHERE)
                           OpenAPI generation
                           PostgreSQL (DSQL, Aurora, RDS, any)
```

The library exposes `createPgrest(config)`. Everything else &mdash; how
requests arrive, how the result is returned to the client &mdash; is a
deploy-target concern. See [`deploy/`](./deploy/) for reference integrations.

## API surface

A running instance exposes its own OpenAPI 3.0 spec at `GET /rest/v1/` and an
interactive explorer at `GET /rest/v1/_docs`. The high-level shape:

| Method | Path | Purpose |
|---|---|---|
| `GET` / `POST` / `PATCH` / `DELETE` | `/rest/v1/:table` | CRUD on any table in the `public` schema |
| `POST` | `/rest/v1/_refresh` | Reload schema cache and Cedar policies (requires `role=service_role`; 401 PGRST301 otherwise) |
| `POST` | `/auth/v1/signup` | Register a new user |
| `POST` | `/auth/v1/token` | Password or refresh-token grant |
| `GET` | `/auth/v1/user` | Current user profile |
| `POST` | `/auth/v1/otp` &middot; `/verify` | Magic-link email flow |
| `GET` | `/auth/v1/authorize` &middot; `/callback` | OAuth flow |
| `GET` | `/auth/v1/jwks` | Public JWKS for asymmetric verification |

The query syntax is PostgREST-compatible: filters like `status=eq.published`,
ordering (`order=created_at.desc`), pagination (`limit`, `offset`), upserts
(`on_conflict`), exact counts (`Prefer: count=exact`), and resource embedding
(`select=id,customers(name,email)`). Browse the live `_docs` UI for the full,
schema-specific reference.

## CLI commands

| Command | What it does |
|---|---|
| `pgrest-lambda dev` | Boot a local dev stack (Postgres + API + auth + docs). |
| `pgrest-lambda refresh` | Reload schema cache and Cedar policies without restarting. |
| `pgrest-lambda generate-key <anon\|service_role>` | Mint an apikey JWT. |
| `pgrest-lambda migrate-auth` | Apply the `better_auth` schema against `DATABASE_URL`. For production bootstraps. |
| `pgrest-lambda help` | Full reference. |

`pgrest-lambda dev` accepts `--port N` and `--skip-docker`. `refresh` accepts
`--url` (or set `PGREST_URL`).

## Deploy

Each subfolder under `deploy/` is one way to run pgrest-lambda in production.
The core library stays deploy-agnostic.

- [**AWS SAM**](./deploy/aws-sam/) &mdash; API Gateway + Lambda + (optional) Cognito. Supports DSQL, Aurora, and standard Postgres. Ships a Lambda authorizer on the `pgrest-lambda/aws-sam` subpath export:

  ```javascript
  import { createAuthorizer } from 'pgrest-lambda/aws-sam';
  export const authorizer = createAuthorizer({
    jwtSecret: process.env.JWT_SECRET,
  }).handler;
  ```

More targets are welcome &mdash; the pattern is in
[`deploy/aws-sam/README.md`](./deploy/aws-sam/README.md).

## Documentation

- [Configuration reference](./docs/configuration.md) &mdash; every config key and env var, plus secret-management patterns.
- [Authorization guide](./docs/authorization.md) &mdash; Cedar policies with recipes and a syntax cheatsheet.
- [RPC guide](./docs/rpc.md) &mdash; calling PostgreSQL functions from clients, with a section on how to do the same work on Aurora DSQL (which doesn't support RPC).
- [AWS SAM deploy runbook](./deploy/aws-sam/README.md) &mdash; end-to-end live-on-AWS walkthrough.
- [Changelog](./CHANGELOG.md) &mdash; what's shipped and what's coming.
- [Agent integration guide](./AGENTS.md) &mdash; notes for AI coding agents working in this repo.

## License

MIT. See [LICENSE](./LICENSE).
