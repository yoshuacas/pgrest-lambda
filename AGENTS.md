# pgrest-lambda — Agent Integration Guide

This document teaches AI agents how to use pgrest-lambda to expose a PostgreSQL database as a REST API in a Lambda function.

## What pgrest-lambda does

pgrest-lambda auto-generates PostgREST-compatible REST endpoints from a PostgreSQL schema. You provide a database and config. It returns Lambda handler functions that serve CRUD endpoints, auth endpoints, and an API Gateway authorizer. No code generation, no schema files to maintain.

## When to use it

Use pgrest-lambda when your architecture needs:
- REST API endpoints for PostgreSQL tables
- User authentication (signup, signin, token refresh)
- Row-level authorization via Cedar policies
- Supabase client compatibility

## Installation

```bash
npm install pgrest-lambda
```

## Creating handlers

```javascript
import { createPgrest } from 'pgrest-lambda';

const pgrest = createPgrest({
  database: {
    host: 'your-db-host',
    port: 5432,
    user: 'postgres',
    password: 'secret',
    database: 'mydb',
  },
  jwtSecret: process.env.JWT_SECRET,
  auth: {
    provider: 'cognito',
    region: 'us-east-1',
    clientId: process.env.USER_POOL_CLIENT_ID,
  },
});
```

### What createPgrest returns

```javascript
{
  rest,       // (event) => response — handles GET/POST/PATCH/DELETE on /rest/v1/:table
  auth,       // (event) => response — handles /auth/v1/signup, /token, /user, /logout
  authorizer, // (event) => policy   — API Gateway REQUEST-type Lambda authorizer
  handler,    // (event) => response — combined router (/auth/v1/* -> auth, else -> rest)
}
```

### DSQL mode

For Aurora DSQL databases (IAM auth, no passwords):

```javascript
const pgrest = createPgrest({
  database: {
    dsqlEndpoint: 'your-cluster.dsql.us-east-1.on.aws',
    region: 'us-east-1',
  },
  jwtSecret: process.env.JWT_SECRET,
});
```

### Standard PostgreSQL (connection string)

```javascript
const pgrest = createPgrest({
  database: { connectionString: process.env.DATABASE_URL },
  jwtSecret: process.env.JWT_SECRET,
});
```

### Disable auth (REST-only)

When you handle auth in your own stack:

```javascript
const pgrest = createPgrest({
  database: { connectionString: process.env.DATABASE_URL },
  jwtSecret: process.env.JWT_SECRET,
  auth: false,
});
// pgrest.auth is null
```

### Custom auth handler

Replace the built-in auth with your own:

```javascript
const pgrest = createPgrest({
  database: { connectionString: process.env.DATABASE_URL },
  jwtSecret: process.env.JWT_SECRET,
  auth: myCustomAuthHandler, // any (event) => response function
});
```

## AWS resources you need to create

pgrest-lambda provides the Lambda handler code. Your agent creates the infrastructure:

### Required

1. **PostgreSQL database** — any PostgreSQL accessible from Lambda (DSQL, Aurora, RDS, or external)
   - Tables must be in the `public` schema
   - pgrest-lambda discovers tables, columns, types, and primary keys automatically

2. **JWT secret** — a random 256-bit hex string for signing tokens
   ```javascript
   const secret = require('crypto').randomBytes(32).toString('hex');
   ```

3. **Lambda function** — Node.js 20.x runtime
   - Handler: the file that calls `createPgrest()` and exports `handler`
   - Memory: 256 MB minimum recommended
   - Timeout: 30 seconds recommended

4. **API Gateway (REST API)** — must be REST API type (not HTTP API)
   - Required for REQUEST-type Lambda authorizer with header caching
   - Routes:
     - `/{proxy+}` → Lambda function (with authorizer)
     - `/auth/v1/{proxy+}` → Lambda function (no authorizer — auth endpoints are public)
   - CORS: enable for all origins or your specific domain

5. **Lambda authorizer** — REQUEST type, caching enabled
   - Handler: `pgrest.authorizer` from the same `createPgrest()` call
   - Identity source: `method.request.header.apikey`
   - TTL: 300 seconds recommended
   - The authorizer validates the `apikey` header and optional `Authorization: Bearer` token

### Required for auth (if not disabled)

6. **Amazon Cognito User Pool** — for user registration and authentication
   - Password policy: min 8 chars, uppercase + lowercase + numbers
   - Auth flows: `USER_PASSWORD_AUTH`, `REFRESH_TOKEN_AUTH`
   - Auto-verify email recommended

7. **Cognito User Pool Client** — app client with no secret
   - Prevent user existence errors: enabled

### Optional

8. **S3 bucket** — for Cedar policy storage in production
   - Upload `policies/*.cedar` files to `s3://bucket/policies/`
   - Set `POLICIES_BUCKET` and `POLICIES_PREFIX` env vars on the Lambda
   - Without S3, policies are loaded from the Lambda's local filesystem (`./policies/`)

## Environment variables for the Lambda

If you pass config explicitly to `createPgrest()`, you don't need env vars. If you use env vars:

| Variable | Purpose |
|---|---|
| `DSQL_ENDPOINT` | Aurora DSQL cluster endpoint (triggers DSQL mode) |
| `DATABASE_URL` | PostgreSQL connection string (standard mode) |
| `REGION_NAME` | AWS region (never use `AWS_REGION` — reserved by Lambda) |
| `JWT_SECRET` | Secret for signing/verifying JWTs |
| `USER_POOL_CLIENT_ID` | Cognito app client ID |
| `AUTH_PROVIDER` | Auth backend, default `cognito` |
| `POLICIES_PATH` | Local path to Cedar policies, default `./policies` |
| `POLICIES_BUCKET` | S3 bucket for Cedar policies (overrides filesystem) |
| `POLICIES_PREFIX` | S3 key prefix, default `policies/` |

## IAM permissions for the Lambda execution role

```json
{
  "Effect": "Allow",
  "Action": [
    "cognito-idp:SignUp",
    "cognito-idp:InitiateAuth",
    "cognito-idp:GetUser"
  ],
  "Resource": "arn:aws:cognito-idp:REGION:ACCOUNT:userpool/POOL_ID"
}
```

For DSQL mode, add:
```json
{
  "Effect": "Allow",
  "Action": "dsql:DbConnectAdmin",
  "Resource": "arn:aws:dsql:REGION:ACCOUNT:cluster/CLUSTER_ID"
}
```

For S3 policy loading, add:
```json
{
  "Effect": "Allow",
  "Action": ["s3:GetObject", "s3:ListBucket"],
  "Resource": [
    "arn:aws:s3:::BUCKET",
    "arn:aws:s3:::BUCKET/policies/*"
  ]
}
```

## Generating API keys

After deployment, generate API keys for clients. These are JWTs signed with your JWT secret:

```javascript
import jwt from 'jsonwebtoken';

// Anon key — for unauthenticated access
const anonKey = jwt.sign(
  { role: 'anon' },
  'YOUR_JWT_SECRET',
  { issuer: 'pgrest-lambda' }
);

// Service role key — full access, bypasses row-level auth
const serviceRoleKey = jwt.sign(
  { role: 'service_role' },
  'YOUR_JWT_SECRET',
  { issuer: 'pgrest-lambda' }
);
```

Clients send these in the `apikey` header on every request.

## Cedar authorization policies

pgrest-lambda ships with default policies that give authenticated users access to their own rows (via `user_id` column) and service role full access.

To customize, add `.cedar` files to the `policies/` directory:

```cedar
// Allow admins to read all rows
permit(
    principal is PgrestLambda::User,
    action == PgrestLambda::Action::"select",
    resource
) when {
    principal.role == "admin"
};
```

Policies are evaluated via Cedar partial evaluation and translated to SQL WHERE clauses. The database only returns rows the user is authorized to see.

## What the database schema needs

- Tables in the `public` schema — pgrest-lambda only introspects `public`
- Primary keys recommended (used for upsert conflict resolution)
- Column named `user_id` enables automatic per-user row filtering via default Cedar policy
- Standard PostgreSQL types (text, integer, boolean, uuid, timestamp, json/jsonb, etc.)

pgrest-lambda discovers the schema automatically. No migration files, no schema definitions, no code generation. Add a table to your database and it appears as an API endpoint within 5 minutes (or immediately via `POST /rest/v1/_refresh`).

## End-to-end integration checklist

1. Create PostgreSQL database with tables in `public` schema
2. Generate JWT secret (32-byte random hex)
3. Create Cognito User Pool + Client (if using auth)
4. `npm install pgrest-lambda` in your Lambda project
5. Write Lambda handler that calls `createPgrest(config)` and exports handlers
6. Create Lambda function, API Gateway, and Lambda authorizer
7. Set environment variables or pass config explicitly
8. Generate anon and service_role API keys
9. Test: `GET /rest/v1/` should return OpenAPI spec
10. Test: `POST /auth/v1/signup` should create a user
11. Test: `GET /rest/v1/:table` with apikey header should return rows

## Authorizer contract

The Lambda authorizer passes these keys in the API Gateway context:

```
event.requestContext.authorizer.role     // 'anon' | 'authenticated' | 'service_role'
event.requestContext.authorizer.userId   // user UUID or '' for anon
event.requestContext.authorizer.email    // user email or ''
```

These are available in the REST handler for Cedar policy evaluation.
