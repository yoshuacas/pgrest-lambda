---
title: Configuration reference
description: Every config key accepted by createPgrest and every environment variable read by the CLI, with defaults and required-ness.
---

# Configuration reference

pgrest-lambda reads configuration from two places: arguments passed to `createPgrest(config)`, and environment variables. **Explicit arguments win over env vars; env vars win over defaults.**

For production secret management patterns (SSM, Secrets Manager, rotation), see the existing [configuration guide](../configuration.md), which this reference summarizes.

## Core

| Config key | Env var | Required | Default | Purpose |
|---|---|---|---|---|
| `database.connectionString` | `DATABASE_URL` | prod: yes<br>dev: no | `postgres://postgres:postgres@localhost:54322/postgres` (bundled container) | PostgreSQL URI. |
| `database.dsqlEndpoint` | `DSQL_ENDPOINT` | no | — | Switch to Aurora DSQL with IAM auth. |
| `jwtSecret` | `JWT_SECRET` | yes | generated on first `dev` run | HS256 secret for apikey JWTs. Must be ≥ 32 chars. |
| `production` | — | no | `false` (for `dev`), `true` (when embedded) | When `true`, suppresses verbose error detail and disallows `cors.allowedOrigins: '*'`. |
| `maxEmbedDepth` | `PGREST_MAX_EMBED_DEPTH` | no | `5` | Maximum embed nesting depth in select parameters. |

## PostgREST engine options

Named after upstream PostgREST's configuration keys. Defaults keep the
behaviour the engine had before the option existed. See the
[configuration guide](../configuration.md#postgrest-engine-options) for the
long form.

| Config key | Env var | PostgREST option | Default | Purpose |
|---|---|---|---|---|
| `dbSchemas` | `PGREST_DB_SCHEMAS` | `db-schemas` | `public` | Exposed schemas, comma-separated. First is the default; `Accept-Profile` / `Content-Profile` select another. An unexposed one is `406` `PGRST106`. |
| `dbExtraSearchPath` | `PGREST_DB_EXTRA_SEARCH_PATH` | `db-extra-search-path` | `public` | Schemas appended to each request's `search_path`. |
| `dbMaxRows` | `PGREST_DB_MAX_ROWS` | `db-max-rows` | unset | Row cap per resource, embeds included. A smaller client `limit` wins. |
| `dbPreRequest` | `PGREST_DB_PRE_REQUEST` | `db-pre-request` | unset | Function run as `SELECT <fn>()` before every request. Bare or schema-qualified name; validated at boot. |
| `dbAggregatesEnabled` | `PGREST_DB_AGGREGATES_ENABLED` | `db-aggregates-enabled` | `true` | `false` refuses aggregate selects with `PGRST123`. Upstream defaults to `false`. |
| `dbPlanEnabled` | `PGREST_DB_PLAN_ENABLED` | `db-plan-enabled` | `false` | Allow `Accept: application/vnd.pgrst.plan`. |
| `bulkMutationGuard` | `PGREST_DB_BULK_MUTATION_GUARD` | — (`pg_safeupdate` upstream) | `on` | Filterless `PATCH`/`DELETE`: `on` refuses, `off` allows, `safeupdate` refuses with SQLSTATE `21000`. |
| `restJwt.secret` | `PGREST_JWT_SECRET` | `jwt-secret` | unset | HMAC secret or JSON JWK/JWK Set. Turns on in-engine JWT verification. |
| `restJwt.secretIsBase64` | `PGREST_JWT_SECRET_IS_BASE64` | `jwt-secret-is-base64` | `false` | Decode the secret as base64. |
| `restJwt.audience` | `PGREST_JWT_AUD` | `jwt-aud` | unset | Required `aud`. Mismatch is `401` `PGRST303`. |
| `restJwt.anonRole` | `PGREST_DB_ANON_ROLE` | `db-anon-role` | `anon` | Role for a tokenless request. Empty disables anonymous access (`PGRST302`). |
| `restJwt.verify` | `PGREST_JWT_VERIFY` | — | on when a secret is set | Force in-engine verification on/off. |

## Auth

| Config key | Env var | Required | Default | Purpose |
|---|---|---|---|---|
| `auth` | — | no | `{ provider: 'better-auth' }` | `false` disables `/auth/v1/*`. A function replaces the handler. Otherwise an object selects the provider. |
| `auth.provider` | `AUTH_PROVIDER` | when `auth` is an object | `better-auth` | `better-auth` (DB-only) or `cognito`. |
| `auth.betterAuthSecret` | `BETTER_AUTH_SECRET` | with `better-auth` provider | generated on first `dev` run | better-auth internal signing key. Must be ≥ 32 chars. |
| `auth.betterAuthUrl` | `BETTER_AUTH_URL` | with `better-auth` provider | `http://localhost:<port>` | Base URL for OAuth callbacks and JWKS. |
| `auth.region` | `REGION_NAME` | with `cognito` provider | — | AWS region. Never use `AWS_REGION` — Lambda reserves it. |
| `auth.clientId` | `USER_POOL_CLIENT_ID` | with `cognito` provider | — | Cognito user-pool client ID. |

## Authorization

| Config key | Env var | Required | Default | Purpose |
|---|---|---|---|---|
| `policies` | `POLICIES_PATH` | no | `./policies` | Cedar policy source. Accepts a filesystem path, `file:///…`, or `s3://bucket/prefix/`. |
| `policiesTtl` | — | no | `300` | Seconds to cache policies in-process before re-reading from disk/S3. |

### `POLICIES_PATH` forms

| Value | Meaning |
|---|---|
| *(unset)* | Load every `*.cedar` file under `./policies/`. |
| `./policies`, `/etc/pgrest/policies` | Load from that filesystem directory. |
| `file:///var/policies` | Explicit filesystem form. Same as a plain absolute path. |
| `s3://my-bucket/prefix/` | List every `*.cedar` object under that bucket + key prefix. Requires `s3:ListBucket` and `s3:GetObject` on the bucket. |

## CORS

| Config key | Env var | Required | Default | Purpose |
|---|---|---|---|---|
| `cors.allowedOrigins` | `PGREST_SERVER_CORS_ALLOWED_ORIGINS` | no | `'*'` in dev; required in prod | Comma-separated origin list or `'*'`. `'*'` is rejected when `production=true`. A list echoes a matching `Origin` and adds `Access-Control-Allow-Credentials: true`; a non-matching one gets no CORS headers (upstream `server-cors-allowed-origins`). |
| `cors.allowedHeaders` | — | no | `apikey, authorization, content-type, prefer, range` | Exposed `Access-Control-Allow-Headers`. |

## Email and OAuth

| Env var | Purpose |
|---|---|
| `SES_FROM_ADDRESS` | Sender for magic-link / OTP emails. Required to use `/auth/v1/otp` and `/auth/v1/verify`. |
| `GOOGLE_CLIENT_ID` | Google OAuth client ID. Enables `/auth/v1/authorize?provider=google`. |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret. Pairs with `GOOGLE_CLIENT_ID`. |
| `REGION_NAME` | AWS region used for SES, DSQL signing, and other AWS SDK calls. |

## Docs

| Env var | Default | Purpose |
|---|---|---|
| `PGREST_DOCS` | `true` | Set to `false` to disable the `/rest/v1/_docs` Scalar explorer. |
| `PGREST_URL` | `http://localhost:3000` | Default target for `pgrest-lambda refresh` when `--url` is not passed. |

## Precedence

For every key:

1. Explicit argument to `createPgrest(config)`.
2. Environment variable.
3. Built-in default.

Secrets (`JWT_SECRET`, `BETTER_AUTH_SECRET`) follow one extra rule: if `pgrest-lambda dev` doesn't find them in any of those places, it generates fresh values and appends them to `.env.local`, so the next run has stable apikeys.

## See also

- Existing [configuration guide](../configuration.md) — the same material plus secret rotation, SSM / Secrets Manager patterns, and the `.env*` file rules.
- [CLI reference](./cli) — which commands read which env vars.
- [HTTP API reference](./http-api) — what each endpoint expects from the config.
