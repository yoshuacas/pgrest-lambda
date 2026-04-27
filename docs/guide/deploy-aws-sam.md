---
title: How to deploy to AWS Lambda with SAM
description: Deploy the reference AWS SAM template — API Gateway, Lambda, and optional Cognito — against DSQL, Aurora Serverless v2, or RDS.
---

# How to deploy to AWS Lambda with SAM

The `deploy/aws-sam/` directory ships a working SAM template that provisions API Gateway, three Lambda functions (REST handler, authorizer, Cognito pre-signup trigger), and an optional Cognito user pool. This guide covers the happy path.

**Prerequisites**

- AWS CLI v2 authenticated against the target account — confirm with `aws sts get-caller-identity`.
- SAM CLI 1.100 or newer — confirm with `sam --version`.
- Node.js 20 — the runtime the template pins.
- A provisioned database (DSQL cluster, Aurora Serverless v2 cluster, or an RDS PostgreSQL instance).

The template does **not** provision the database or the `JWT_SECRET` parameter — those are expected to exist before deploy.

## Step 1 — Clone and enter the repo

```bash
git clone https://github.com/yoshuacas/pgrest-lambda.git
cd pgrest-lambda
```

The SAM template lives at `deploy/aws-sam/template.yaml`. Everything below runs from the repo root.

## Step 2 — Create the secrets in SSM

Mint the two secrets pgrest-lambda needs at runtime:

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

The template resolves these at deploy time via <code v-pre>{{resolve:ssm:/pgrest/jwt-secret}}</code>. See the existing [configuration guide](../configuration.md) for the full rotation procedure and the `SecureString` caveat.

## Step 3 — Build

```bash
sam build --template deploy/aws-sam/template.yaml
```

This transpiles and bundles the Lambda code into `.aws-sam/build/`. Rerun after every change to `src/` or `deploy/aws-sam/`.

## Step 4 — Deploy

First deploy is interactive — SAM prompts for stack name, region, and the template parameters:

```bash
sam deploy --guided
```

Key parameters the template exposes:

| Parameter | Values | Meaning |
|---|---|---|
| `AuthProvider` | `cognito` (default), `better-auth` | Which auth backend Lambdas use. |
| `DatabaseMode` | `dsql` (default), `aurora`, `rds`, `direct` | Where the REST handler connects. |
| `DatabaseUrl` | Postgres URI | Required when `DatabaseMode` is `aurora`, `rds`, or `direct`. |
| `DsqlEndpoint` | `<cluster>.dsql.<region>.on.aws` | Required when `DatabaseMode=dsql`. |
| `AllowedOrigins` | Comma-separated origins | CORS whitelist. `*` is rejected in production. |

SAM saves the chosen values to `samconfig.toml`. Subsequent deploys are non-interactive:

```bash
sam deploy
```

Deploy finishes in 2–4 minutes. The `Outputs` section prints the API Gateway invoke URL.

## Step 5 — Apply the `better_auth` schema to the database

The deployed Lambda does not run migrations at cold start. Apply the `better_auth` schema from your workstation once, against the same database:

```bash
DATABASE_URL=postgres://app:pw@db.example.com:5432/postgres \
  npx pgrest-lambda migrate-auth
```

This creates the `better_auth` tables (`user`, `session`, `account`, `verification`, `jwks`) in the target database. The `public` schema is untouched.

## Step 6 — Smoke test

Use the SAM output URL to issue a request. First grab the anon apikey:

```bash
JWT_SECRET="$(aws ssm get-parameter --name /pgrest/jwt-secret \
  --query Parameter.Value --output text --region us-east-1)" \
  npx pgrest-lambda generate-key anon
```

Then hit the API:

```bash
export ANON_KEY='eyJhbGciOiJIUzI1NiIs…'
export INVOKE_URL='https://abc123.execute-api.us-east-1.amazonaws.com/v1'

curl -s "$INVOKE_URL/rest/v1/" -H "apikey: $ANON_KEY" | jq '.info'
```

Expected response (the OpenAPI spec's `info` block):

```json
{
  "title": "pgrest-lambda",
  "description": "Auto-generated REST API over PostgreSQL",
  "version": "0.1.0"
}
```

If you get a `401`, the apikey was minted with a different `JWT_SECRET` than the one SSM holds — regenerate with the matching secret.

## Step 7 — (Optional) Use Cognito as the auth provider

The default `AuthProvider=cognito` wires up:

- A `Cognito::UserPool` with email sign-in.
- A `UserPoolClient` for the SAM-generated frontend flow.
- A pre-signup trigger Lambda that enforces the Cedar `PreSignUp` policy, if present.

Clients use `@supabase/supabase-js` unchanged; the pgrest-lambda auth layer translates `/auth/v1/*` calls to Cognito API calls.

Switch the auth provider at deploy time:

```bash
sam deploy --parameter-overrides AuthProvider=better-auth
```

`better-auth` runs entirely in Postgres — no Cognito user pool — at the cost of managing the signing key yourself.

## Cleaning up

```bash
sam delete
```

Deletes the API Gateway, the Lambdas, the user pool (if Cognito was used), the execution roles, and the CloudWatch log groups. The database and the SSM parameters are independent and stay behind.

## Related

- [CLI reference](../reference/cli) — `pgrest-lambda migrate-auth`, `generate-key`, and friends.
- [Configuration reference](../reference/configuration) — every env var the deployed Lambdas read.
- Existing [configuration guide](../configuration.md) — `.env` patterns and secret rotation.
- `deploy/aws-sam/README.md` in the repo — parameter-by-parameter walkthrough of the template.
