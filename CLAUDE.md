# CLAUDE.md

## What Is pgrest-lambda?

**pgrest-lambda** is an open-source serverless REST API engine that turns any PostgreSQL database into a PostgREST-compatible API with built-in auth — deployed as AWS Lambda functions behind API Gateway.

**Tagline:** A serverless REST API for any PostgreSQL database.

**Core value:** Developers get Supabase-equivalent REST and auth APIs on their own AWS account, using any PostgreSQL database, with zero code generation and no framework lock-in.

## Repository Structure

```
pgrest-lambda/
├── src/
│   ├── index.mjs              # Entry point: routes /auth/v1/* vs /rest/v1/*
│   ├── presignup.mjs          # Cognito auto-confirm trigger
│   ├── rest/                   # PostgREST-compatible REST engine
│   │   ├── handler.mjs        # Lambda handler for REST requests
│   │   ├── db.mjs             # Database adapter (DSQL IAM + standard PG)
│   │   ├── schema-cache.mjs   # pg_catalog introspection with TTL cache
│   │   ├── query-parser.mjs   # PostgREST query param parsing
│   │   ├── sql-builder.mjs    # Parameterized SQL generation
│   │   ├── router.mjs         # Path → table routing
│   │   ├── openapi.mjs        # OpenAPI 3.0.3 spec generation
│   │   ├── response.mjs       # HTTP response formatting
│   │   └── errors.mjs         # PostgREST error codes
│   ├── auth/                   # GoTrue-compatible auth layer
│   │   ├── handler.mjs        # Auth endpoint handler
│   │   ├── jwt.mjs            # JWT signing/verification
│   │   ├── gotrue-response.mjs # GoTrue response formatting
│   │   └── providers/         # Swappable auth backends
│   │       ├── interface.mjs  # Provider contract (typedef)
│   │       ├── gotrue.mjs     # GoTrue-native (default)
│   │       └── cognito.mjs    # Amazon Cognito (optional)
│   ├── authorizer/            # API Gateway Lambda authorizer
│   │   └── index.mjs
│   └── shared/
│       └── cors.mjs
├── template.yaml              # SAM template (full deployment)
├── package.json
├── README.md
└── LICENSE
```

## Database Support

pgrest-lambda supports any PostgreSQL database, not just Aurora. The `db.mjs` adapter selects mode based on environment variables:

- **DSQL mode:** `DSQL_ENDPOINT` + `REGION_NAME` → IAM auth token generation
- **Standard mode:** `DATABASE_URL` or `PG_HOST`/`PG_PORT`/`PG_USER`/`PG_PASSWORD`/`PG_DATABASE` → direct connection

When adding new database features, ensure they work with both modes. Do not add DSQL-specific SQL syntax to the engine — stick to standard PostgreSQL.

## Critical Rules

1. **This project is standalone.** Never reference BOA, Harbor, or any parent project in code, docs, or comments. pgrest-lambda has its own identity.
2. **JWT issuer is `pgrest-lambda`** — used in `src/auth/jwt.mjs` and `src/authorizer/index.mjs`. Do not change this without updating both.
3. **Node.js only for Lambda** — never Python (binary dependency failures on Lambda).
4. **`REGION_NAME` env var, never `AWS_REGION`** — `AWS_REGION` is reserved by Lambda runtime.
5. **All SQL must be parameterized** — no string interpolation of user input. The sql-builder uses `$1`, `$2`, etc. exclusively.
6. **REST API Gateway, not HTTP API** — required for REQUEST-type Lambda authorizer with header caching.
7. **`@supabase/supabase-js` compatibility is a hard requirement** — the REST and auth APIs must remain wire-compatible with Supabase client libraries. Test against supabase-js before breaking response formats.
8. **Auth providers are swappable** — GoTrue-native is the default, storing users in the `auth` schema of the same PostgreSQL database. Cognito is available as an optional provider (`AUTH_PROVIDER=cognito`). The provider interface in `src/auth/providers/interface.mjs` defines the contract. Future providers (Auth0, etc.) must implement the same interface.
9. **Schema introspection targets the `public` schema only** — this is intentional and matches PostgREST defaults.
10. **OpenAPI spec is auto-generated** — never hand-write endpoint definitions. The spec comes from live schema introspection.

## Authorizer Contract

The Lambda authorizer passes flat keys in the API Gateway context:
```javascript
event.requestContext.authorizer.role     // 'anon' | 'authenticated' | 'service_role'
event.requestContext.authorizer.userId   // user UUID or '' for anon
event.requestContext.authorizer.email    // user email or ''
```

## Plan Execution with rring

This project uses [rring](https://github.com/yoshuacas/rring) for design-driven development. The agent runtime is **Claude Code**.

**Workflow for executing plans:**
1. `rring start <feature-name> "<description>"` — create a feature prompt
2. `rring design <feature-name>` — generate a design document
3. `rring task <feature-name>` — break into implementation tasks
4. `rring work` — execute tasks via the implementer agent loop
5. `rring review <feature-name>` — code review

**Key commands:**
- `rring status` — show current workflow state
- `rring prompts` / `rring designs` — list prompts and designs
- `rring start <name> --edit` — create prompt and open in editor

Use feature branches: one branch per feature. Finalize by squashing to a single commit on merge.

## Writing Standards

- No AI-sounding language, no buzzwords
- Active voice, concise, plain English
- Every data point needs a source
