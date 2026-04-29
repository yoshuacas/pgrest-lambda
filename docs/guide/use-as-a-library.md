---
title: How to use pgrest-lambda as a library
description: Embed createPgrest(config) in your own server or Lambda function, wire it up to a Postgres database, and route API Gateway events through it.
---

# How to use pgrest-lambda as a library

Embed `createPgrest(config)` in your own server when you already have a Lambda handler, a Fastify or Express app, or anything else that can translate HTTP into an API-Gateway-shaped event (`{ httpMethod, path, headers, body, … }`) and a `{ statusCode, headers, body }` response.

**Prerequisites**

- Node.js 20+.
- A reachable PostgreSQL database (`DATABASE_URL`).
- An HS256 secret of at least 32 characters for signing apikey JWTs.

## Install

```bash
npm install pgrest-lambda
```

## Minimal setup

The library's single entry point is `createPgrest(config)`. It returns an object whose `.handler` is an async function that accepts an API-Gateway-shaped event.

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

Every config key also reads from an environment variable of the same name (e.g. `DATABASE_URL`, `JWT_SECRET`). Explicit arguments win over env vars; env vars win over defaults. See the [Configuration reference](../reference/configuration) for every key.

## Hosting patterns

### As an AWS Lambda handler

The handler already returns an API-Gateway-shaped response, so you can export it directly:

```javascript
// lambda.mjs
import { createPgrest } from 'pgrest-lambda';

export const handler = createPgrest({
  database: { connectionString: process.env.DATABASE_URL },
  jwtSecret: process.env.JWT_SECRET,
  auth: {
    provider: 'better-auth',
    betterAuthSecret: process.env.BETTER_AUTH_SECRET,
    betterAuthUrl: process.env.BETTER_AUTH_URL,
  },
}).handler;
```

Wire this up to an API Gateway proxy integration with `/{proxy+}` as the resource path. The reference AWS SAM template does exactly this — see [How to deploy to AWS Lambda with SAM](./deploy-aws-sam).

### Behind Express or Fastify

Bridge any Node HTTP framework to the API-Gateway event shape with a thin adapter:

```javascript
import express from 'express';
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

const app = express();
app.use(express.text({ type: '*/*' }));

app.all('/{*any}', async (req, res) => {
  const response = await pgrest.handler({
    httpMethod: req.method,
    path: req.path,
    headers: req.headers,
    queryStringParameters: req.query,
    body: req.body || null,
  });
  res.status(response.statusCode);
  for (const [k, v] of Object.entries(response.headers || {})) res.setHeader(k, v);
  res.send(response.body);
});

app.listen(3000);
```

Cloudflare Workers and other edge runtimes follow the same adapter pattern — translate the incoming request into the API-Gateway shape and the outgoing response back.

## Disable auth

If you only want the REST surface and plan to guard it with something upstream (e.g., an existing API gateway authorizer), pass `auth: false`:

```javascript
const pgrest = createPgrest({
  database: { connectionString: process.env.DATABASE_URL },
  jwtSecret: process.env.JWT_SECRET,
  auth: false,
});
```

`/auth/v1/*` paths return `404`; `/rest/v1/*` still runs through Cedar authorization. You are responsible for minting and validating JWTs yourself.

## Use a custom auth handler

If you have an existing auth system, replace the built-in one:

```javascript
import { createPgrest } from 'pgrest-lambda';
import { myCustomAuthHandler } from './my-auth.mjs';

const pgrest = createPgrest({
  database: { connectionString: process.env.DATABASE_URL },
  jwtSecret: process.env.JWT_SECRET,
  auth: (event) => myCustomAuthHandler(event),
});
```

Your function receives the same API-Gateway event shape and must return the same response shape. It is invoked for every request with a path starting with `/auth/v1/`.

## Load Cedar policies

By default, pgrest-lambda loads `*.cedar` files from `./policies/` at startup. To load from S3 instead:

```javascript
const pgrest = createPgrest({
  database: { connectionString: process.env.DATABASE_URL },
  jwtSecret: process.env.JWT_SECRET,
  auth: { /* … */ },
  policies: 's3://my-bucket/pgrest-policies/',
});
```

Or set `POLICIES_PATH=s3://…` in the environment. See [Configuration reference — POLICIES_PATH](../reference/configuration) for the accepted forms and the S3 IAM requirements, and the existing [authorization guide](../authorization.md) for how the policies interact with requests.

## Refresh the schema cache at runtime

pgrest-lambda introspects `pg_catalog` on boot and caches the result. When you add or drop tables, reload the cache by calling the built-in endpoint:

```bash
curl -X POST http://localhost:3000/rest/v1/_refresh \
  -H "apikey: $SERVICE_ROLE_KEY"
```

The endpoint requires `role=service_role` on the apikey (see [authorization — admin endpoints](../authorization.md#admin-endpoints)); anon and authenticated requests return 401 PGRST301.

Or programmatically, from inside your own process, reuse the CLI's `refresh` command — it mints a service-role apikey from `JWT_SECRET` automatically. See the [CLI reference](../reference/cli).

## Related

- [CLI reference](../reference/cli) — every command and flag.
- [Configuration reference](../reference/configuration) — every config key and env var.
- [HTTP API reference](../reference/http-api) — paths, methods, request shapes.
- Existing [authorization guide](../authorization.md) — Cedar policy model and recipes.
- Existing [configuration guide](../configuration.md) — env var patterns and secret management.
