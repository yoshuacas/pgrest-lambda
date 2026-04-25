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
| `POLICIES_PATH` | Cedar policy source. Accepts a filesystem path (`./policies`), `file:///absolute/path`, or `s3://<bucket>/<prefix>/`. See below. |

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
Lambda or POST `/rest/v1/_refresh`.

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
# docs/deploy/aws-sam/template.yaml (excerpt)
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
> `ssm-secure` references inside Lambda environment variables. Use
> plain `String` parameters, or switch to Secrets Manager if you need
> KMS-at-rest for the deploy artifact.

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
