# Configuration

Environment variables drive every pgrest-lambda deployment. This page
documents each one, the two files the CLI reads them from, and the rules
for keeping secrets out of version control.

## Files the CLI reads

`pgrest-lambda dev` loads `.env.local` first, then `.env` (values already
set in the shell environment always win over both). Variables set in
`.env.local` override `.env`. Neither file is read in production — AWS
Lambda reads its environment from the deployment template.

| File | Committed to git? | Purpose |
|---|---|---|
| `.env.example` | Yes | Template documenting every variable. Copy when starting. |
| `.env` | **No** | Shared-team overrides a developer wants persisted locally. Add to `.gitignore`. |
| `.env.local` | **No** | Per-machine secrets. The CLI writes generated secrets here on first run. Already in `.gitignore`. |

`.env.local` and `.env` are both in `pgrest-lambda`'s `.gitignore`. If
you're using pgrest-lambda as a library in your own repo, add them to
your `.gitignore` too.

## Variables

### Core

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `DATABASE_URL` | dev: no, prod: yes | bundled Postgres on `localhost:54322` | PostgreSQL connection string. `pgrest-lambda dev` starts a Docker container when unset. |
| `JWT_SECRET` | yes | generated on first `dev` run | HS256 secret signing the `anon` and `service_role` apikey JWTs. Must be ≥ 32 chars. |
| `BETTER_AUTH_SECRET` | yes (better-auth provider) | generated on first `dev` run | better-auth's internal signing secret. Used to encrypt the JWKS private key at rest. Must be ≥ 32 chars. |
| `BETTER_AUTH_URL` | no | `http://localhost:<port>` | Base URL better-auth uses for OAuth callbacks and JWKS advertisements. |
| `PGREST_DOCS` | no | `true` (except `false`) | Set to `false` to disable `/rest/v1/_docs`. |

### Optional features

| Variable | Feature |
|---|---|
| `SES_FROM_ADDRESS` | Sender for magic-link/OTP emails. Required for `/auth/v1/otp` and `/auth/v1/verify`. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google OAuth. Enables `/auth/v1/authorize?provider=google`. |
| `REGION_NAME` | AWS region for SES, DSQL signing, etc. Never use `AWS_REGION` — Lambda reserves it. |
| `DSQL_ENDPOINT` | Enables Aurora DSQL mode with IAM auth. |
| `PG_PASSWORD_SSM_PARAM` | Name of an SSM SecureString parameter holding the Postgres password. Resolved with decryption at connect time instead of reading `PG_PASSWORD`. Lets a managed (e.g. RDS) password stay encrypted at rest without a plaintext env var. |
| `POLICIES_PATH` | Cedar policy source. Accepts a filesystem path (`./policies`), `file:///absolute/path`, or `s3://<bucket>/<prefix>/`. See below. |
| `PGREST_RELATIONSHIPS_PATH` | Path to a declared-relationship manifest. Adds foreign keys the catalog cannot report, so resource embedding works on databases that reject `FOREIGN KEY`. See below. |
| `PGREST_DEFAULT_TS_CONFIG` | Text search configuration for `fts`/`plfts`/`phfts` filters that name none. See below. |
| `PGREST_DB_SCHEMAS`, `PGREST_DB_EXTRA_SEARCH_PATH`, `PGREST_DB_MAX_ROWS`, `PGREST_DB_PRE_REQUEST`, `PGREST_DB_AGGREGATES_ENABLED`, `PGREST_DB_PLAN_ENABLED`, `PGREST_DB_BULK_MUTATION_GUARD`, `PGREST_SERVER_CORS_ALLOWED_ORIGINS`, `PGREST_JWT_*` | PostgREST engine options. See below. |

## PostgREST engine options

These options carry upstream PostgREST's names, so a `postgrest.conf` can be
translated one line at a time: `db-schemas` becomes `PGREST_DB_SCHEMAS`,
`db-max-rows` becomes `PGREST_DB_MAX_ROWS`, and so on. Every one is also a
`createPgrest({ ... })` key. Each default is the behaviour the engine had
before the option existed, which is upstream's default except where noted.

| Env var | PostgREST option | Default | Purpose |
|---|---|---|---|
| `PGREST_DB_SCHEMAS` | `db-schemas` | `public` | Comma-separated list of exposed schemas. The first is the default; a request selects another with `Accept-Profile` (reads) or `Content-Profile` (writes). |
| `PGREST_DB_EXTRA_SEARCH_PATH` | `db-extra-search-path` | `public` | Extra schemas appended to each request's `search_path`, for extensions and helper functions that live outside the exposed schema. |
| `PGREST_DB_MAX_ROWS` | `db-max-rows` | unset | Cap on rows returned per resource, top level and embeds alike. A smaller client `limit` still wins. |
| `PGREST_DB_PRE_REQUEST` | `db-pre-request` | unset | Function run as `SELECT <fn>()` at the start of every request, in the request's transaction. A bare or schema-qualified name; anything else is rejected at boot. |
| `PGREST_DB_AGGREGATES_ENABLED` | `db-aggregates-enabled` | `true` | Set to `false` to refuse `select=col.sum()` and friends with `PGRST123`. Upstream defaults this off; this engine has always served aggregates, so the default stays `true` here. |
| `PGREST_DB_PLAN_ENABLED` | `db-plan-enabled` | `false` | Allow `Accept: application/vnd.pgrst.plan`. Off by default, like upstream: the plan exposes the generated SQL. |
| `PGREST_DB_BULK_MUTATION_GUARD` | — (upstream uses the `pg_safeupdate` extension) | `on` | What a `PATCH`/`DELETE` with no filter does. `on` refuses it; `off` runs it, which is upstream's behaviour with no extension loaded; `safeupdate` refuses it with `pg_safeupdate`'s wire error (400, SQLSTATE `21000`, `UPDATE requires a WHERE clause`). |
| `PGREST_SERVER_CORS_ALLOWED_ORIGINS` | `server-cors-allowed-origins` | unset (`*`, no credentials) | Comma-separated origin allow-list. When set, a request whose `Origin` is on the list gets that origin echoed back plus `Access-Control-Allow-Credentials: true`; one that is not gets no CORS headers. |

### Schema selection

With one exposed schema, nothing changes: no `Content-Profile` is echoed and a
profile header naming any other schema is a `406` with code `PGRST106`
(`Invalid schema: <name>`, hinting the exposed set). With more than one, the
engine echoes `Content-Profile` on every response — upstream's behaviour —
because the client can no longer assume which schema answered.

Each exposed schema gets its own schema cache, introspected independently. A
declared-relationship manifest (`PGREST_RELATIONSHIPS_PATH`) is filtered per
schema: an entry is visible to a schema only when both of its ends live there.

### In-engine JWT verification

The normal deployment verifies tokens in the API Gateway Lambda authorizer,
which hands the engine a role. Set `PGREST_JWT_SECRET` and the REST engine
verifies the bearer token itself and takes the role from the claims — what a
standalone (non-API-Gateway) deployment needs.

| Env var | PostgREST option | Default | Purpose |
|---|---|---|---|
| `PGREST_JWT_SECRET` | `jwt-secret` | unset | HMAC secret, or a JSON JWK / JWK Set for asymmetric verification (`RS256`/`384`/`512`). Setting it turns in-engine verification on. |
| `PGREST_JWT_SECRET_IS_BASE64` | `jwt-secret-is-base64` | `false` | Treat the secret as base64-encoded bytes. |
| `PGREST_JWT_AUD` | `jwt-aud` | unset | Required audience. A token with no `aud` claim, or a null one, is still accepted; any other value must contain this one, or the request is `401` `PGRST303`. |
| `PGREST_DB_ANON_ROLE` | `db-anon-role` | `anon` | Role a request with no token runs as. Set it empty to disable anonymous access (`401` `PGRST302` with `WWW-Authenticate: Bearer`). |
| `PGREST_JWT_VERIFY` | — | on when a secret is set | Force in-engine verification on or off independently of the secret. |

Error codes follow upstream `Error.hs`: `PGRST300` (`500`) when the server has
no secret, `PGRST301` (`401`) when a token fails to decode or verify,
`PGRST302` (`401`) when anonymous access is disabled, `PGRST303` (`401`) for a
rejected claim.

## Text search configuration

`?col=fts.word` builds `to_tsvector(col) @@ to_tsquery($1)` with no explicit
configuration, so PostgreSQL resolves it from the session's
`default_text_search_config`. That is what upstream PostgREST emits, and it is
the default here: leave `PGREST_DEFAULT_TS_CONFIG` unset and the server decides.

Set it to a configuration name and every unqualified text-search filter becomes
`to_tsvector('<name>', col)` instead. A filter that names its own configuration
(`?col=fts(english).word`) always wins over this variable.

Aurora DSQL needs it. DSQL reports `pg_catalog.english` as its
`default_text_search_config` but ships only the `simple` configuration in
`pg_ts_config`, so any unqualified filter fails with `text search configuration
"english" does not exist`. On DSQL, set:

```
PGREST_DEFAULT_TS_CONFIG=simple
```

`simple` does no stemming and applies no stopword list, so `plfts`/`phfts`
matching is exact word-for-word rather than linguistic.

## Declared relationships

Resource embedding (`/projects?select=*,clients(*)`) is derived from
foreign keys read out of `pg_constraint`. Aurora DSQL parses
`FOREIGN KEY` but stores nothing, so `pg_constraint` returns no rows for
`contype = 'f'` and every embed would fail with `PGRST200`.

`PGREST_RELATIONSHIPS_PATH` points at a JSON file listing those keys:

```json
{
  "relationships": [
    {
      "constraint": "projects_client_id_fkey",
      "schema": "public",
      "table": "projects",
      "columns": ["client_id"],
      "foreignSchema": "public",
      "foreignTable": "clients",
      "foreignColumns": ["id"]
    }
  ]
}
```

Rules:

- `constraint` names the key. It is what a client passes to disambiguate
  an embed (`/projects?select=clients!projects_client_id_fkey(*)`) and
  what appears in a `PGRST201` error body.
- `columns` and `foreignColumns` are positional and must be the same
  length. An entry that is not is ignored.
- `schema`/`foreignSchema` default to `public`. A key on a relation
  outside the served schema is still useful: a `public` view over that
  relation inherits the relationship, the same way PostgREST propagates
  keys onto views.
- The manifest is **additive**. The catalog is read first and wins on
  conflict, so a standard PostgreSQL deployment behaves identically
  whether or not a manifest is set.
- One-to-many, many-to-one and many-to-many (through a junction whose
  primary key covers two of the declared keys) are all derived from this
  list — the same derivation PostgREST runs over `pg_constraint`.
- An unreadable or malformed file fails the request loudly rather than
  serving an API with embedding silently switched off.

## Policy loading

`POLICIES_PATH` is a single variable that accepts three forms:

| Value | Meaning |
|---|---|
| *(unset)* | Defaults to `./policies` on the filesystem. |
| `./policies` or `/etc/pgrest/policies` | Plain path. Load every `*.cedar` file from that directory. |
| `file:///var/policies` | Explicit filesystem form. Same as a plain absolute path. |
| `s3://my-bucket/policies/` | List every `*.cedar` object under that bucket + key prefix. Requires the Lambda (or dev process) to have `s3:ListBucket` and `s3:GetObject` on that bucket. |

**Local development:** leave `POLICIES_PATH` unset. The default
`./policies` directory is what `pgrest-lambda dev` expects, and setting
an `s3://` URI would try to reach AWS at boot — which fails without
credentials.

**Production:** either bake your policies into the Lambda deployment
package (under `policies/`) or store them in S3 and set
`POLICIES_PATH=s3://<bucket>/<prefix>/`. The S3 form lets you rotate
policies without redeploying code. Policies are cached in-process for
`policiesTtl` (default 5 minutes); to force a refresh, restart the
Lambda or POST `/rest/v1/_refresh` with a `service_role` apikey.

## Local development: secret persistence

On a first `pgrest-lambda dev` run with no `.env.local`, the CLI:

1. Detects that `JWT_SECRET` and `BETTER_AUTH_SECRET` are absent.
2. Generates 48-byte base64 secrets for both.
3. Appends them to `.env.local` in the current directory.
4. Prints `created .env.local — do not commit this file`.

Every subsequent run loads those values from `.env.local`, so:

- Apikeys stay the same across restarts.
- better-auth can decrypt its JWKS private key every boot.
- Users/sessions created in the bundled Postgres remain usable.

If you delete `.env.local`, the next run starts fresh and any existing
sessions in the DB become unusable (the new `BETTER_AUTH_SECRET` can't
decrypt the old JWKS entry). Use `pgrest-lambda` with a clean database
if you need a full reset — or run `docker compose down -v` against
`src/dev/docker/compose.yml` to drop the data volume.

## Production configuration

**Never commit secrets.** The library reads env vars the same way Lambda
reads its `Environment.Variables` — both `.env*` files and plain
`process.env` work, but `.env*` files must stay out of git history and
container images.

Two common patterns for deployed stacks:

### Pattern A — SSM Parameter Store

Best for values you rotate rarely. The SAM template already resolves
`/pgrest/jwt-secret` at deploy time:

```yaml
# deploy/aws-sam/template.yaml (excerpt)
Environment:
  Variables:
    JWT_SECRET: !Sub '{{resolve:ssm:/pgrest/jwt-secret}}'
    BETTER_AUTH_SECRET: !Sub '{{resolve:ssm:/pgrest/better-auth-secret}}'
```

Create the parameters before your first deploy:

```bash
aws ssm put-parameter \
  --name /pgrest/jwt-secret \
  --type String \
  --value "$(openssl rand -base64 48)" \
  --region us-east-1

aws ssm put-parameter \
  --name /pgrest/better-auth-secret \
  --type String \
  --value "$(openssl rand -base64 48)" \
  --region us-east-1
```

> **SecureString limitation:** CloudFormation does not resolve
> `ssm-secure` references inside Lambda environment variables. You have
> three options: use plain `String` parameters; switch to Secrets
> Manager (the `secretsmanager` dynamic reference works in any
> property); or — for the database password specifically — keep the
> value in a SecureString and set `PG_PASSWORD_SSM_PARAM` to its name
> instead of `PG_PASSWORD`. The Postgres provider then reads and
> decrypts it at connect time, so the secret never lives in an
> environment variable. This requires `ssm:GetParameter` (plus KMS
> decrypt on the key) on the function role.

### Pattern B — Secrets Manager

When you need automatic rotation or cross-account sharing:

```yaml
Environment:
  Variables:
    JWT_SECRET: !Sub '{{resolve:secretsmanager:pgrest/jwt-secret:SecretString}}'
```

Secrets Manager costs $0.40/secret/month and adds a KMS decrypt on
every deploy — worth it when you actually need rotation.

## Rotating secrets

**`JWT_SECRET`**: rotating invalidates every outstanding apikey. Plan
a redeploy + re-issue window for clients.

**`BETTER_AUTH_SECRET`**: rotating invalidates the encrypted JWKS
private key at rest, so every user session in the DB becomes
unreadable. Rotate by:

1. Clear the `better_auth.jwks` table in the target DB (or drop and
   re-apply the schema via `pgrest-lambda migrate-auth`).
2. Update the secret in SSM / Secrets Manager.
3. Redeploy.

Existing user sessions will need to re-authenticate. Sign-up/sign-in
resumes working as soon as the new key is in place.

## Runtime limits

| Limit | Default | What happens when exceeded |
|---|---|---|
| Request body size | **1 MB** (`MAX_BODY_BYTES = 1_048_576`) | `413 PGRST006 Request body exceeds maximum size of 1048576 bytes`. Checked before `JSON.parse` so oversize payloads never parse. Applies to every `/rest/v1/*` and `/auth/v1/*` endpoint. |
| Admin endpoints | `service_role` apikey required | `401 PGRST301` for anon / authenticated. Currently covers `POST /rest/v1/_refresh`. |

The body-size cap is defined in `src/shared/body-size.mjs` and is not
currently configurable at runtime. If you need larger uploads, use the
presigned-URL pattern (file goes to S3 directly, not through the API).

## What to commit

Commit:

- `.env.example` — template with no values.
- The SAM template (or your deploy manifest) with `{{resolve:...}}`
  references to secret stores, not the secrets themselves.
- Your code.

Do **not** commit:

- `.env`, `.env.local`, `.env.*.local`.
- Any file containing a real `JWT_SECRET`, `BETTER_AUTH_SECRET`, OAuth
  client secret, or database password.
- Built Lambda bundles that inline env values.

If a secret lands in git history, rotate it (see above) and scrub the
history (`git filter-repo` or BFG). Git commit access is not a safe
boundary for secrets.
