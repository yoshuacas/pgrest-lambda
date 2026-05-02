# Deploy pgrest-lambda with AWS SAM

Live deployment on AWS using the SAM template in this directory. End state: a working REST API behind API Gateway, backed by a PostgreSQL-compatible database with optional Cognito user pool support.

The steps below have been executed against a real AWS account and the template as it ships.

## What gets created

With defaults (`AuthProvider=better-auth`, `DatabaseMode=dsql`):

| Resource | Purpose |
|---|---|
| `AWS::Serverless::Api` | REST API Gateway (stage `v1`) |
| `AWS::Serverless::Function` × 2 | REST handler, authorizer |
| `AWS::Cognito::UserPool` + `UserPoolClient` | Auth backend (Cognito mode only) |
| IAM roles | Execution roles for each Lambda (DSQL mode also grants `dsql:DbConnect`) |
| CloudWatch log groups | Auto-created on first invoke per Lambda |

**Not created by this template:**

- The database (DSQL cluster or RDS instance) — provision separately.
- The `JWT_SECRET` SSM parameter — create before deploy (see below).
- Table schema — apply via `psql` after the database is reachable.

## Prerequisites

- AWS CLI v2 authenticated against the target account (`aws sts get-caller-identity`).
- SAM CLI ≥ 1.100 (`sam --version`).
- Node.js ≥ 20 — the runtime the template pins.
- `psql` for the schema-apply step.
- A PostgreSQL-compatible database:
  - **Aurora DSQL cluster** — create via console or `aws dsql create-cluster`. Note the cluster endpoint.
  - **Standard Postgres** reachable from Lambda — RDS, Aurora Serverless v2, or any Postgres with a public endpoint. You need a connection string.

## One-time bootstrap

### 1. Create the JWT signing secret in SSM

The template reads `/pgrest/jwt-secret` via `{{resolve:ssm:...}}` at deploy time. Create it **as a plain `String` parameter**:

```bash
aws ssm put-parameter \
  --name /pgrest/jwt-secret \
  --type String \
  --value "$(openssl rand -base64 48)" \
  --region us-east-1
```

> **Note:** CloudFormation does not support `SecureString` resolution inside Lambda environment variables. If you need a secret at rest, use Secrets Manager instead and switch the template to `{{resolve:secretsmanager:...}}`. For a test deployment, a plain SSM `String` is fine; the secret still lives in SSM.

The secret must be ≥ 32 characters — `openssl rand -base64 48` produces 64.

### 2. (DSQL only) Create a cluster and capture the endpoint

```bash
aws dsql create-cluster \
  --no-deletion-protection-enabled \
  --region us-east-1
# Returns { identifier, endpoint, status: "CREATING", ... }
```

Wait for `status: ACTIVE`:

```bash
aws dsql get-cluster --identifier <clusterId> --region us-east-1 --query status
```

For a production cluster drop `--no-deletion-protection-enabled` — deletion protection defaults on.

### 3. (Standard Postgres only) Have a `DATABASE_URL` ready

Format: `postgres://user:password@host:5432/dbname?sslmode=require`. The Lambda must be able to reach the host. If it's inside a VPC, you'll need to extend the template with `VpcConfig` — not covered here.

## Deploy

From this directory:

```bash
sam build
```

The build respects the `files` list in `package.json`, so the Lambda package includes `src/`, `deploy/`, `policies/`, and `node_modules/` — roughly 32 MB. If you omit `files` from `package.json` the package balloons to include everything in the repo and `policies/` may be dropped entirely (causing every request to 403).

### Deploy — DSQL + better-auth (defaults)

```bash
sam deploy \
  --stack-name pgrest-lambda \
  --region us-east-1 \
  --capabilities CAPABILITY_IAM \
  --resolve-s3 \
  --no-confirm-changeset \
  --parameter-overrides \
    DsqlEndpoint=<clusterId>.dsql.us-east-1.on.aws
```

### Deploy — standard Postgres + better-auth

```bash
sam deploy \
  --stack-name pgrest-lambda \
  --region us-east-1 \
  --capabilities CAPABILITY_IAM \
  --resolve-s3 \
  --no-confirm-changeset \
  --parameter-overrides \
    DatabaseMode=standard \
    "DatabaseUrl=postgres://user:pass@host:5432/db?sslmode=require"
```

### Deploy — with Cognito auth

```bash
sam deploy \
  --stack-name pgrest-lambda \
  --region us-east-1 \
  --capabilities CAPABILITY_IAM \
  --resolve-s3 \
  --no-confirm-changeset \
  --parameter-overrides \
    AuthProvider=cognito \
    DatabaseMode=standard \
    "DatabaseUrl=postgres://user:pass@host:5432/db?sslmode=require"
```

Outputs after success:

```
ApiUrl             https://<id>.execute-api.us-east-1.amazonaws.com/v1
UserPoolId         us-east-1_XXXXXXXXX   (Cognito only)
UserPoolClientId   XXXXXXXXXXXXXXXXXXXXXXXXXX   (Cognito only)
```

## Apply the schema

The database has no tables yet. Apply one of the example schemas:

```bash
# DSQL — generate an IAM auth token and use it as the password
DSQL_HOST=<clusterId>.dsql.us-east-1.on.aws
DSQL_TOKEN=$(aws dsql generate-db-connect-admin-auth-token \
  --hostname "$DSQL_HOST" --region us-east-1)

PGPASSWORD="$DSQL_TOKEN" psql \
  "host=$DSQL_HOST port=5432 dbname=postgres user=admin sslmode=require" \
  -f ../../schema-examples/dsql-compatible.sql

# Standard Postgres
psql "$DATABASE_URL" -f ../../schema-examples/standard-postgres.sql
```

The DSQL auth token has a short TTL (~15 min) — regenerate if you need to re-run.

## Smoke test

Grab the outputs and exercise auth + REST:

```bash
API_URL=$(aws cloudformation describe-stacks \
  --stack-name pgrest-lambda \
  --region us-east-1 \
  --query "Stacks[0].Outputs[?OutputKey=='ApiUrl'].OutputValue" --output text)

# Load the JWT secret and mint an anon key
JWT_SECRET=$(aws ssm get-parameter --name /pgrest/jwt-secret \
  --region us-east-1 --query Parameter.Value --output text)

ANON_KEY=$(S="$JWT_SECRET" node -e "
  const jwt = require('jsonwebtoken');
  console.log(jwt.sign({ role: 'anon' }, process.env.S,
    { issuer: 'pgrest-lambda', algorithm: 'HS256' }));
")

# Signup
EMAIL="test-$(date +%s)@example.com"
SIGNUP=$(curl -s -X POST "$API_URL/auth/v1/signup" \
  -H "apikey: $ANON_KEY" -H "Content-Type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"TestPass123\"}")
echo "$SIGNUP" | jq
ACCESS=$(echo "$SIGNUP" | jq -r '.access_token')

# Authenticated REST — insert a task, then select it back
curl -s -X POST "$API_URL/rest/v1/tasks" \
  -H "apikey: $ANON_KEY" -H "Authorization: Bearer $ACCESS" \
  -H "Content-Type: application/json" \
  -H "Prefer: return=representation" \
  -d "{\"title\":\"hello\"}"

curl -s "$API_URL/rest/v1/tasks" \
  -H "apikey: $ANON_KEY" -H "Authorization: Bearer $ACCESS" | jq
```

A successful signup returns `access_token` (pgrest-lambda HS256 JWT) and `refresh_token` (a session-ID JWT).

## Tear down

```bash
sam delete --stack-name pgrest-lambda --region us-east-1

# DSQL cluster — only if you created one just for this stack
aws dsql delete-cluster --identifier <clusterId> --region us-east-1

# SSM parameter — only if nothing else uses it
aws ssm delete-parameter --name /pgrest/jwt-secret --region us-east-1
```

DSQL clusters with deletion protection on must have it disabled first:

```bash
aws dsql update-cluster --identifier <clusterId> --no-deletion-protection-enabled --region us-east-1
aws dsql delete-cluster --identifier <clusterId> --region us-east-1
```

## Troubleshooting

| Symptom | Cause |
|---|---|
| `sam deploy` fails: `Non-secure ssm prefix was used for secure parameter` | SSM parameter is a `SecureString`. Recreate as plain `String` (CloudFormation does not support `ssm-secure` in Lambda env vars) |
| Every REST request returns `403 PGRST403` | `policies/` directory not shipped with the Lambda. The `files` list in `package.json` must include `"policies"` |
| `500 {"code":"42P01"}` on `/rest/v1/<table>` | Schema not applied to the database. Re-run the schema-apply step |
| `401 Unauthorized` on every REST request with `apikey` set | API Gateway CORS adds an `OPTIONS` method with no auth, but `ANY` requires the Bearer token too. Pass `Authorization: Bearer <anon_key>` alongside `apikey` for anon traffic, or use supabase-js which handles this automatically |
| Lambda times out hitting DSQL | Template grants `dsql:DbConnect` only when `DatabaseMode=dsql`. Verify the parameter |

## Cost estimate

| Resource | Idle cost |
|---|---|
| API Gateway | $0 (per-request pricing) |
| Lambda | $0 (per-invocation pricing) |
| CloudWatch logs | ~pennies/month with default retention |
| Cognito | $0 up to 50k MAU (free tier) |
| DSQL cluster (active) | ~$0.28/vCPU-hour — **tear down when not in use** |
| RDS / Aurora | Billed continuously; independent of this stack |

## What was verified

This guide reflects a verified end-to-end deployment (better-auth + DSQL + us-east-1). The following were exercised against the live stack:

- `POST /auth/v1/signup` — returns access_token + session-ID refresh_token.
- `POST /auth/v1/token?grant_type=refresh_token` — exchanges refresh token for new access token.
- `GET /auth/v1/user` — returns the authenticated profile.
- `POST /rest/v1/tasks` with Bearer token — Cedar allows when `user_id == principal`.
- `GET /rest/v1/tasks` — returns the authenticated user's row.
