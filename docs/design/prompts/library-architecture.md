Restructure pgrest-lambda from a standalone SAM project into an npm
package that works as both a library and a standalone tool.

## Context

pgrest-lambda is currently deployed via `sam build && sam deploy` using
a template.yaml that creates Cognito, API Gateway, and Lambda functions.
This couples the project to SAM and prevents it from being used as a
component in other projects (like BOA). The SAM template also makes
infrastructure decisions (creates Cognito, API Gateway) that a library
consumer wouldn't want.

Reference: docs/research/library-architecture.md

## Goals

1. A single `createPgrest(config)` factory that returns `{ rest, auth, authorizer }` handler functions
2. Config-driven instead of env-var-coupled — factory accepts a config object, falls back to env vars
3. Composable — consumers can override auth with their own handler, or disable it entirely
4. Standalone CLI for developers who want pgrest-lambda without a parent project
5. SAM template becomes an example, not the primary interface

## createPgrest factory

```javascript
import { createPgrest } from 'pgrest-lambda';

const pgrest = createPgrest({
  database: { host, port, user, password, database },
  // OR: database: { dsqlEndpoint, region },
  // OR: database: { connectionString },
  jwtSecret: process.env.JWT_SECRET,
  auth: {
    provider: 'cognito',
    userPoolId: process.env.USER_POOL_ID,
    clientId: process.env.CLIENT_ID,
  },
  policies: './policies/',
});

pgrest.rest       // (event) => response — handles /rest/v1/*
pgrest.auth       // (event) => response — handles /auth/v1/*
pgrest.authorizer // (event) => policy   — API Gateway authorizer
```

Override auth:
```javascript
const pgrest = createPgrest({
  database: { ... },
  jwtSecret: '...',
  auth: myCustomHandler,  // function replaces built-in auth
});
```

Disable auth:
```javascript
const pgrest = createPgrest({
  database: { ... },
  jwtSecret: '...',
  auth: false,  // pgrest.auth is null
});
```

## Config resolution

The factory resolves config in order: explicit config > env vars > defaults.

```
database:
  explicit config.database object
  OR DSQL_ENDPOINT + REGION_NAME env vars (DSQL mode)
  OR DATABASE_URL env var (standard mode)
  OR PG_HOST/PG_PORT/PG_USER/PG_PASSWORD/PG_DATABASE env vars

jwtSecret:
  explicit config.jwtSecret
  OR JWT_SECRET env var

auth:
  explicit config.auth (object, function, or false)
  OR { provider: AUTH_PROVIDER, userPoolId: USER_POOL_ID, clientId: USER_POOL_CLIENT_ID }

policies:
  explicit config.policies (path string)
  OR POLICIES_PATH env var
  OR './policies' default
```

This means existing deployments that use env vars continue to work
without any code changes. Library consumers pass explicit config.

## Internal changes

### Remove module-scope env reads

Current modules read process.env at import time:
- `src/authorizer/index.mjs`: `const SECRET = process.env.JWT_SECRET` (already fixed to read at call time)
- `src/rest/db.mjs`: reads DSQL_ENDPOINT, DATABASE_URL, PG_* at module scope
- `src/auth/providers/cognito.mjs`: reads USER_POOL_CLIENT_ID, REGION_NAME at module scope

Change: handlers receive config via closure from the factory. No env reads at module scope.

### New entry point: src/index.mjs

Replace the current path router with the createPgrest factory.
The current routing logic (`if path starts with /auth/v1`) moves to
a convenience `pgrest.handler` that combines rest + auth, or consumers
wire it themselves.

### package.json exports

```json
{
  "name": "pgrest-lambda",
  "type": "module",
  "exports": {
    ".": "./src/index.mjs"
  },
  "bin": {
    "pgrest-lambda": "./bin/pgrest-lambda.mjs"
  }
}
```

### Move template.yaml

Move to docs/deploy/aws-sam/ as a working example. Keep it functional
so `sam build && sam deploy` works from that directory.

## Standalone CLI

```bash
npx pgrest-lambda init            # Scaffold config + default Cedar policies
npx pgrest-lambda dev             # Local dev server (express or http)
npx pgrest-lambda generate-keys   # Create anon + service_role JWTs
```

The dev server wraps the handlers in a local HTTP server for testing
without deploying to AWS. It reads config from a local file
(pgrest.config.mjs or similar) or env vars.

## What does NOT change

- REST handler logic (query parsing, SQL building, schema introspection)
- Auth handler logic (signup, signin, refresh, logout)
- Authorizer logic (JWT validation, role extraction)
- Cedar engine and policy format
- Auth provider interface (Cognito default, swappable)
- PostgREST wire compatibility
- supabase-js compatibility
- Test assertions (adapt test setup to use factory, not direct imports)

## Test strategy

- Update existing tests to create handlers via createPgrest() factory
- Test config resolution: explicit > env vars > defaults
- Test auth override: custom function, false (disabled)
- Test that env-var-only config still works (backwards compat)
- Test CLI commands: init scaffolds files, generate-keys produces valid JWTs

## Documentation deliverables

1. Agent integration guide — single file telling agents how to use pgrest-lambda as a library
2. Human quickstart — README with install, init, dev, deploy
3. Deploy examples — SAM, CDK, Terraform, manual
4. Configuration reference — every config option and env var

## References

- Research: docs/research/library-architecture.md
- Current template: template.yaml
- Current entry point: src/index.mjs
