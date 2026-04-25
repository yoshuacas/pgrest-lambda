# Deploy pgrest-lambda with AWS SAM

This guide walks through a live deployment on AWS using the SAM template in this directory. End state: a working REST API behind API Gateway, backed by a PostgreSQL-compatible database and (optionally) a Cognito user pool.

## What gets created

With defaults (`AuthProvider=cognito`, `DatabaseMode=dsql`):

| Resource | Purpose |
|---|---|
| `AWS::Serverless::Api` | REST API Gateway (stage `v1`) |
| `AWS::Serverless::Function` × 3 | REST handler, authorizer, Cognito pre-signup |
| `AWS::Cognito::UserPool` + `UserPoolClient` | Auth backend |
| `AWS::Lambda::Permission` | Lets Cognito invoke the pre-signup trigger |
| IAM roles | Execution roles for each Lambda |
| CloudWatch log groups | One per Lambda (auto-created on first invoke) |

**Not created by this template:**
- The database (DSQL cluster or RDS instance) — provision separately.
- The `JWT_SECRET` SSM parameter — create before deploy (see below).
- Table schema — apply via `psql` after the database is reachable.

## Prerequisites

- AWS CLI v2 authenticated against the target account (`aws sts get-caller-identity`).
- SAM CLI ≥ 1.100 (`sam --version`).
- Node.js ≥ 20 (the runtime the template pins).
- A PostgreSQL-compatible database. One of:
  - **Aurora DSQL cluster** — create via console or `aws dsql create-cluster`. Note the cluster endpoint.
  - **Standard Postgres** reachable from Lambda — RDS, Aurora Serverless v2, or any Postgres with a public endpoint. You need a connection string.

## One-time bootstrap

### 1. Create the JWT signing secret in SSM

The template reads `/pgrest/jwt-secret` via `{{resolve:ssm:...}}` at deploy time. Create it before `sam deploy`:

```bash
aws ssm put-parameter \
  --name /pgrest/jwt-secret \
  --type SecureString \
  --value "$(openssl rand -base64 48)" \
  --region us-east-1
```

The secret must be ≥ 32 characters — `openssl rand -base64 48` produces 64. Rotate by updating the parameter and redeploying (Lambdas pick up the new value on cold start).

### 2. (DSQL only) Create a cluster and capture the endpoint

```bash
aws dsql create-cluster \
  --deletion-protection-enabled \
  --region us-east-1
# Returns a clusterId; endpoint is <clusterId>.dsql.<region>.on.aws
```

Wait for `aws dsql get-cluster --identifier <clusterId>` to show `status: ACTIVE`.

### 3. (Standard Postgres only) Have a `DATABASE_URL` ready

Format: `postgres://user:password@host:5432/dbname?sslmode=require`. The Lambda must be able to reach the host — if it's in a VPC, you'll need to extend the template with `VpcConfig` (not covered here).

## Deploy

From the repo root:

```bash
cd docs/deploy/aws-sam
sam build
```

`sam build` copies the repo into `.aws-sam/build/` per function. The `CodeUri: ../../../` in the template points at the repo root, so `node_modules/` and everything else ships with the Lambda zip. For a smaller package, see **Reducing package size** below.

### Deploy — DSQL + Cognito (defaults)

```bash
sam deploy \
  --stack-name pgrest-lambda \
  --region us-east-1 \
  --capabilities CAPABILITY_IAM \
  --resolve-s3 \
  --parameter-overrides \
    DsqlEndpoint=<clusterId>.dsql.us-east-1.on.aws
```

### Deploy — standard Postgres + Cognito

```bash
sam deploy \
  --stack-name pgrest-lambda \
  --region us-east-1 \
  --capabilities CAPABILITY_IAM \
  --resolve-s3 \
  --parameter-overrides \
    DatabaseMode=standard \
    "DatabaseUrl=postgres://user:pass@host:5432/db?sslmode=require"
```

### Deploy — GoTrue-native auth (no Cognito)

```bash
sam deploy \
  --stack-name pgrest-lambda \
  --region us-east-1 \
  --capabilities CAPABILITY_IAM \
  --resolve-s3 \
  --parameter-overrides \
    AuthProvider=gotrue \
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
DSQL_TOKEN=$(aws dsql generate-db-connect-admin-auth-token \
  --hostname <clusterId>.dsql.us-east-1.on.aws \
  --region us-east-1)

PGPASSWORD="$DSQL_TOKEN" psql \
  "host=<clusterId>.dsql.us-east-1.on.aws port=5432 dbname=postgres user=admin sslmode=require" \
  -f ../../../schema-examples/dsql-compatible.sql

# Standard Postgres
psql "$DATABASE_URL" -f ../../../schema-examples/standard-postgres.sql
```

## Smoke test

Grab the outputs and exercise auth + REST:

```bash
API_URL=$(aws cloudformation describe-stacks \
  --stack-name pgrest-lambda \
  --query "Stacks[0].Outputs[?OutputKey=='ApiUrl'].OutputValue" --output text)

# Mint an anon API key from the JWT secret (same secret that's in SSM)
JWT_SECRET=$(aws ssm get-parameter --name /pgrest/jwt-secret \
  --with-decryption --query Parameter.Value --output text)

ANON_KEY=$(node -e "
  const jwt = require('jsonwebtoken');
  console.log(jwt.sign({ role: 'anon' }, '$JWT_SECRET',
    { issuer: 'pgrest-lambda', algorithm: 'HS256' }));
")

# Signup
curl -s -X POST "$API_URL/auth/v1/signup" \
  -H "apikey: $ANON_KEY" -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"Password1"}' | jq

# Check OpenAPI spec
curl -s "$API_URL/rest/v1/" -H "apikey: $ANON_KEY" | jq '.paths | keys'
```

## Reducing package size

The template's `CodeUri: ../../../` ships the whole repo — including `node_modules/`, `docs/`, `research/`, `tasks/`. Lambda's 250 MB unzipped limit is easy to hit.

Two options:

**A. Add a `.samignore` at repo root:**

```
docs
research
tasks
test
.git
.maintainer-last-run
CHANGELOG.md
CLAUDE.md
POSTGREST_GAP_ANALYSIS.md
schema-examples
```

**B. Use a dedicated build step.** Before `sam build`, stage only `src/`, `lambda.mjs`, `package.json`, and run `npm ci --omit=dev` in a scratch directory referenced by `CodeUri`.

Production deployments should do one or both.

## Tear down

```bash
sam delete --stack-name pgrest-lambda --region us-east-1
```

Cognito user pools with users cannot be deleted via CloudFormation by default — delete users first via the console or `aws cognito-idp admin-delete-user`, or set `DeletionPolicy: Retain` (not currently in the template).

DSQL clusters with `--deletion-protection-enabled` must have protection disabled before deletion:

```bash
aws dsql update-cluster --identifier <clusterId> --no-deletion-protection-enabled
aws dsql delete-cluster --identifier <clusterId>
```

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `sam deploy` fails on `JWT_SECRET` resolution | SSM parameter `/pgrest/jwt-secret` missing or in a different region |
| `500 {"error":"42P01"}` on `/rest/v1/<table>` | Schema not applied to the database yet |
| `500 {"error":"42P01"}` on `/auth/v1/signup` with `AUTH_PROVIDER=gotrue` | `auth` schema not auto-created — fixed in v0.2.0+. Redeploy from `main`. |
| `401 invalid_grant` on every signin | JWT secret mismatch between what Lambda sees and what the client signed with |
| Lambda times out hitting DSQL | IAM role missing `dsql:DbConnect*` (template handles this for DSQL mode only) |
| Client can't reach the API from a browser | CORS — template uses `AllowOrigin: '*'`, but if you hit the `/rest/v1/` endpoint through `createPgrest` with `production: true` and a list of origins, the library enforces that |

## Cost estimate

Idle stack (no traffic, no DSQL cluster): < $1/month (Cognito free tier, Lambda/API Gateway have no idle cost, CloudWatch log retention).

DSQL cluster: billed per vCPU-hour once active. Tear it down when not in use.

Standard Postgres on RDS: billed continuously by the RDS instance, independent of this stack.
