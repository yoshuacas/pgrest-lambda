# pgrest-lambda Library Architecture — Research

Date: 2026-04-12

## Problem

pgrest-lambda is currently a standalone SAM project. To use it, you clone the repo and run `sam deploy`. This makes it unusable as a component — an agent building a backend (like BOA) can't import pgrest-lambda into its own infrastructure. Developers who use CDK, Terraform, SST, or raw CloudFormation are locked out.

The SAM template also makes infrastructure decisions (creates Cognito, API Gateway) that a library consumer wouldn't want. The deployment tool is an opinion, not part of the product.

## Decision

pgrest-lambda becomes an npm package with two usage modes:

1. **Library** — agents and developers import handlers into their own Lambda functions and deploy with their own tools
2. **Standalone** — developers run a CLI to scaffold, develop locally, and deploy on top of their database

SAM is demoted from primary interface to one example in `docs/deploy/`.

## Design: Single factory, composable handlers

### One entry point

```javascript
import { createPgrest } from 'pgrest-lambda';

const pgrest = createPgrest({
  database: { host, port, user, password, database },
  jwtSecret: process.env.JWT_SECRET,
  auth: {
    provider: 'cognito',
    userPoolId: process.env.USER_POOL_ID,
    clientId: process.env.CLIENT_ID,
  },
  policies: './policies/',
});

pgrest.rest       // Lambda handler for /rest/v1/*
pgrest.auth       // Lambda handler for /auth/v1/*
pgrest.authorizer // Lambda authorizer handler
```

### Override any piece

```javascript
// Bring your own auth handler
const pgrest = createPgrest({
  database: { ... },
  jwtSecret: process.env.JWT_SECRET,
  auth: myCustomAuthHandler,
  policies: './policies/',
});
```

### Disable what you don't need

```javascript
// REST only — no auth endpoints
const pgrest = createPgrest({
  database: { ... },
  jwtSecret: process.env.JWT_SECRET,
  auth: false,
  policies: './policies/',
});
```

### Lambda deployment is the consumer's choice

pgrest-lambda produces handler functions. The consumer decides how to deploy them.

Today the project runs as **two Lambdas**: one authorizer (required by API Gateway) and one main handler that routes `/auth/v1/*` to auth and everything else to REST. This works fine. The consumer can also split them into separate Lambdas if they want isolated scaling or permissions — the factory returns all three functions regardless.

```javascript
// Option A: One Lambda (current model)
export const handler = (event) => {
  if (event.path.startsWith('/auth/v1')) return pgrest.auth(event);
  return pgrest.rest(event);
};
export const authorizer = pgrest.authorizer;

// Option B: Separate Lambdas
// auth.mjs:    export const handler = pgrest.auth;
// rest.mjs:    export const handler = pgrest.rest;
// authz.mjs:   export const handler = pgrest.authorizer;
```

## What changes in the codebase

### Source restructure

```
pgrest-lambda/
├── src/
│   ├── index.mjs              # createPgrest() factory
│   ├── rest/                   # REST engine (unchanged internally)
│   ├── auth/                   # Auth layer (unchanged internally)
│   ├── authorizer/             # Authorizer (unchanged internally)
│   └── shared/
├── bin/
│   └── pgrest-lambda.mjs      # CLI for standalone mode
├── policies/
│   └── default.cedar           # Default Cedar policies
├── package.json                # npm package with exports field
└── docs/
    └── deploy/
        ├── aws-sam.md          # SAM example
        ├── aws-cdk.md          # CDK example
        ├── terraform.md        # Terraform example
        └── manual.md           # Raw CloudFormation / console setup
```

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

### Factory functions instead of environment coupling

Current problem: modules read `process.env` at import time or module scope. The authorizer had `const SECRET = process.env.JWT_SECRET` at the top level, which broke tests. The handlers assume env vars exist.

Fix: the `createPgrest()` factory accepts a config object and passes it down. Handlers receive config via closure, not environment. The standalone CLI and the current `template.yaml` can still set env vars — the factory reads them as defaults when explicit config isn't provided:

```javascript
export function createPgrest(config = {}) {
  const resolvedConfig = {
    database: config.database || parseDatabaseFromEnv(),
    jwtSecret: config.jwtSecret || process.env.JWT_SECRET,
    auth: config.auth !== undefined ? config.auth : parseAuthFromEnv(),
    policies: config.policies || process.env.POLICIES_PATH || './policies',
  };

  return {
    rest: createRestHandler(resolvedConfig),
    auth: resolvedConfig.auth === false
      ? null
      : (typeof resolvedConfig.auth === 'function'
          ? resolvedConfig.auth
          : createAuthHandler(resolvedConfig)),
    authorizer: createAuthorizerHandler(resolvedConfig),
  };
}
```

### What moves where

| Current | After |
|---|---|
| `template.yaml` (primary interface) | `docs/deploy/aws-sam.md` (example) |
| `src/index.mjs` (path router) | `src/index.mjs` (createPgrest factory) |
| `src/presignup.mjs` (Cognito trigger) | Stays, but documented as optional consumer-side setup |
| `process.env.*` reads scattered in modules | Config object passed from factory via closure |
| No CLI | `bin/pgrest-lambda.mjs` for init, dev, generate-keys |

### What gets removed from the project root

- `template.yaml` — moves to docs/deploy/ as an example
- `presignup.mjs` stays but isn't bundled as a core Lambda

### What stays exactly as-is

- All handler logic in `src/rest/`, `src/auth/`, `src/authorizer/`
- Cedar engine and policies
- Schema introspection and SQL building
- Auth provider interface (Cognito default, swappable)
- Test suite

## CLI for standalone mode

For developers who don't use BOA and just want REST APIs on their database:

```bash
npx pgrest-lambda init           # Scaffold config, default Cedar policies
npx pgrest-lambda dev            # Local dev server against their DB
npx pgrest-lambda generate-keys  # Create anon + service_role JWTs
```

The CLI is a convenience wrapper, not a requirement. Library consumers never touch it.

## Documentation structure

### For agents (library mode)

A single file (like SKILL.md or INTEGRATION.md) that tells an agent:
- What npm package to install
- What the `createPgrest()` config object looks like
- What AWS resources need to exist (database, Cognito user pool, API Gateway with Lambda authorizer)
- What IAM permissions the Lambda execution role needs
- What env vars to set (or pass via config)
- Example wiring code

### For humans (standalone mode)

- README quickstart: install, init, dev, deploy
- Architecture overview with diagrams
- Configuration reference (every config option, every env var)
- Cedar policy guide (how to write custom policies)
- Deploy guides per platform (SAM, CDK, Terraform, manual)

## Compatibility

This restructure must not break:
- `@supabase/supabase-js` wire compatibility (HTTP request/response format)
- Existing Cedar policy format
- Existing test suite (adapt tests to use factory instead of direct imports)
- The authorizer contract (role, userId, email in API Gateway context)

## Open questions

1. Should the standalone CLI include a deploy command, or just document deployment? A deploy command adds complexity but reduces friction.
2. Should the template.yaml remain in the repo root as a working example, or strictly live in docs/deploy/? Keeping it in root means `sam build && sam deploy` still works for people who find the repo on GitHub.
3. How to handle the DSQL signer dependency — it's only needed for DSQL mode but adds weight. Make it a peer dependency? Dynamic import?
