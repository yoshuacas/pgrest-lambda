---
title: CLI reference
description: Every command, flag, and environment variable recognized by the pgrest-lambda CLI entry point.
---

# CLI reference

The `pgrest-lambda` binary is a thin wrapper over the library's exported primitives. It reads `.env.local` and `.env` on each invocation (values already set in the shell environment take precedence).

Install globally with `npm install -g pgrest-lambda`, or invoke without installing via `npx pgrest-lambda`.

## Commands

### `pgrest-lambda dev`

Boot a local development stack: Postgres container + REST API + auth + OpenAPI/Scalar docs.

**Flags**

| Flag | Default | Meaning |
|---|---|---|
| `--port <n>` | `3000` | Port the HTTP server listens on. |
| `--skip-docker` | `false` | Do not start the bundled Postgres container. Requires `DATABASE_URL` to be set. |

**Environment variables read**

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | If set, connect to this database and skip the bundled container. |
| `JWT_SECRET` | Signs apikey JWTs. Generated on first run and written to `.env.local` if absent. |
| `BETTER_AUTH_SECRET` | better-auth internal signing key. Generated on first run if absent. |
| `BETTER_AUTH_URL` | Base URL used for OAuth callbacks and JWKS advertisement. Default: `http://localhost:<port>`. |

**Side effects on first run**

1. Starts a Docker container on `localhost:54322` (unless `--skip-docker`).
2. Applies the `better_auth` schema (tables `user`, `session`, `account`, `verification`, `jwks`) to the target database.
3. Generates 48-byte base64 secrets for `JWT_SECRET` and `BETTER_AUTH_SECRET` if absent, and appends them to `.env.local`.

**Exit codes**

- `0` — received `SIGINT` / `SIGTERM`, shut down cleanly.
- `1` — runtime error (message printed to `stderr`).
- `2` — unknown subcommand.

---

### `pgrest-lambda refresh`

Reload the schema cache and Cedar policies on a running instance without restarting it. Equivalent to `POST /rest/v1/_refresh`.

**Flags**

| Flag | Default | Meaning |
|---|---|---|
| `--url <url>` | `$PGREST_URL` or `http://localhost:3000` | Target pgrest-lambda instance. |

**Environment variables read**

| Variable | Purpose |
|---|---|
| `JWT_SECRET` | Mints a short-lived anon apikey to authenticate the refresh request. Required. |
| `PGREST_URL` | Target URL when `--url` is not passed. |

**Exit codes**

- `0` — server returned 2xx.
- `1` — server returned non-2xx, or the target was unreachable, or `JWT_SECRET` was absent.

---

### `pgrest-lambda generate-key <anon|service_role>`

Print a signed apikey JWT for the given role. Writes to stdout; nothing else happens.

**Arguments**

- `anon` — role `anon`. For client-side usage.
- `service_role` — role `service_role`. For trusted backend code that needs to bypass Cedar.

**Environment variables read**

| Variable | Purpose |
|---|---|
| `JWT_SECRET` | HS256 signing secret. Required. Must be ≥ 32 chars. |

**Example**

```bash
JWT_SECRET="$(openssl rand -base64 48)" \
  pgrest-lambda generate-key service_role
```

---

### `pgrest-lambda migrate-auth`

Apply the `better_auth` schema to the database named by `DATABASE_URL`. Idempotent — already-applied migrations are skipped.

**Environment variables read**

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL URI. Required. |

**Use when**

- Bootstrapping a production database before first deploy (the deployed Lambda does not run migrations at cold start).
- Recovering after rotating `BETTER_AUTH_SECRET` — the re-migration does not rebuild the `jwks` table; delete and re-run `migrate-auth` if that matters.

---

### `pgrest-lambda help`

Print the full command reference to stdout. Equivalent aliases: `--help`, `-h`.

## Dotenv loading

On every run, the CLI loads environment variables in this order:

1. `.env.local` (not committed — per-machine secrets).
2. `.env` (not committed — shared local overrides).
3. The shell environment (always wins over both).

Neither `.env.local` nor `.env` is read in production — AWS Lambda reads from its deployed environment variables. See the existing [configuration guide](../configuration.md) for production secret patterns.

## See also

- [Configuration reference](./configuration) — every config key and env var in one table.
- [HTTP API reference](./http-api) — endpoints the `refresh` command calls under the hood.
- Existing [configuration guide](../configuration.md) — env var shape, secret rotation, production patterns.
