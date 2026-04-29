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
   - CORS: configure `cors.allowedOrigins` with an explicit array (e.g. `['https://app.example.com']`) in `createPgrest()`. The library emits `Access-Control-Allow-Origin: <request origin>` + `Vary: Origin` on match and nothing on miss. `allowedOrigins: '*'` is rejected in production mode via `assertCorsConfig()`.

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
- **For resource embedding on DSQL:** since DSQL does not support foreign key constraints, pgrest-lambda infers relationships from column naming. Name your foreign key columns as `{table_name_singular}_id` — for example, `customer_id` to reference the `customers` table, `category_id` for `categories`, `address_id` for `addresses`. The convention handles common English plurals (add `s`, add `es`, `y` → `ies`). On standard PostgreSQL with real foreign keys, this naming convention is not required but still recommended for clarity.

pgrest-lambda discovers the schema automatically. No migration files, no schema definitions, no code generation. Add a table to your database and it appears as an API endpoint within 5 minutes (or immediately via `POST /rest/v1/_refresh` with a `service_role` apikey — anon/authenticated requests get 401 PGRST301).

### Writing DDL for DSQL vs standard PostgreSQL

When generating `CREATE TABLE` statements, use DSQL-compatible syntax if the target database might be Aurora DSQL. The main differences:

**Standard PostgreSQL:**
```sql
CREATE TABLE todos (
    id SERIAL PRIMARY KEY,
    user_id TEXT,
    title TEXT NOT NULL,
    done BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT now()
);
```

**DSQL-compatible (also works on standard PostgreSQL):**
```sql
CREATE TABLE categories (
    id BIGINT GENERATED BY DEFAULT AS IDENTITY (CACHE 1) PRIMARY KEY,
    name TEXT NOT NULL
);

CREATE TABLE todos (
    id BIGINT GENERATED BY DEFAULT AS IDENTITY (CACHE 1) PRIMARY KEY,
    user_id TEXT,
    title TEXT NOT NULL,
    done BOOLEAN DEFAULT false,
    category_id BIGINT,  -- names the column {singular}_id so embedding works
    created_at TIMESTAMPTZ DEFAULT now()
);
-- No REFERENCES clause (DSQL doesn't support it), but pgrest-lambda
-- infers the relationship: todos.category_id → categories.id
-- Querying: GET /rest/v1/todos?select=*,categories(name)
```

DSQL constraints to know when generating DDL:
- No `SERIAL` type — use `BIGINT GENERATED BY DEFAULT AS IDENTITY (CACHE 1)`
- Identity columns must be `BIGINT`, not `INTEGER`
- The `CACHE` clause is required — use `1` for sequential IDs, `65536` for high throughput
- No foreign keys (`REFERENCES`) — enforce referential integrity in application logic
- **Name FK columns as `{singular_table}_id`** so pgrest-lambda can infer relationships for resource embedding (e.g., `customer_id` → `customers` table, `category_id` → `categories`, `address_id` → `addresses`)
- Execute one SQL statement at a time (no semicolon-separated batches in a single query)
- No `TRUNCATE ... RESTART IDENTITY` — use `DELETE FROM` to clear tables

When in doubt, use the DSQL-compatible syntax — it works on both.

See `schema-examples/` in the project root for complete DDL examples for both database types.

## Discovering and using the generated API

Once pgrest-lambda is deployed, the API is fully described by the OpenAPI spec. Fetch it to understand what's available.

### Fetch the OpenAPI spec

```
GET /rest/v1/
```

Returns an OpenAPI 3.0.3 JSON document listing every table, column, type, and operation. Use this as your primary reference for the API surface. The spec is auto-generated from the database schema — no manual maintenance.

Example response structure:
```json
{
  "openapi": "3.0.3",
  "info": { "title": "pgrest-lambda API" },
  "paths": {
    "/todos": {
      "get": { "parameters": [...], "responses": {...} },
      "post": { "requestBody": {...} },
      "patch": {...},
      "delete": {...}
    },
    "/users": {...}
  },
  "components": {
    "schemas": {
      "todos": {
        "properties": {
          "id": { "type": "integer" },
          "title": { "type": "string" },
          "done": { "type": "boolean" },
          "user_id": { "type": "string", "format": "uuid" }
        }
      }
    }
  }
}
```

### Recommended agent workflow

1. **Fetch the spec first**: `GET /rest/v1/` to discover tables and columns
2. **Use the spec to generate client code**: the spec has everything needed to build queries
3. **Query syntax**: PostgREST-compatible operators on query string
   - Filter: `?column=operator.value` (e.g., `?status=eq.active`, `?age=gt.18`)
   - Select: `?select=col1,col2` (flat) or `?select=col1,related_table(col2,col3)` (with embedding)
   - Embed related tables: `?select=*,customers(name,email)` — joins via foreign keys
   - Order: `?order=col.desc`
   - Paginate: `?limit=20&offset=40`
4. **Auth**: pass `apikey` header on every request, plus `Authorization: Bearer <token>` for authenticated users
5. **Mutate**: POST (insert), PATCH (update with filters), DELETE (with filters)
6. **Refresh**: if you create new tables, call `POST /rest/v1/_refresh` with the `service_role` apikey to update the schema cache. Anon and authenticated requests return 401 PGRST301.

### Interactive docs (for humans)

When `docs` is enabled (default), `GET /rest/v1/_docs` serves an interactive API reference powered by Scalar. This is useful for human developers exploring the API in a browser. Agents should use the JSON spec at `/rest/v1/` instead.

To disable the docs page:
```javascript
createPgrest({ docs: false })
```
Or set `PGREST_DOCS=false` in the environment. The OpenAPI spec at `/rest/v1/` is always available regardless.

### Query examples for common operations

```bash
# List all todos
GET /rest/v1/todos

# Filter by status
GET /rest/v1/todos?status=eq.active

# Select specific columns, ordered, paginated
GET /rest/v1/todos?select=id,title,done&order=created_at.desc&limit=10

# Insert a row
POST /rest/v1/todos
Body: {"title": "New task", "done": false}

# Update matching rows
PATCH /rest/v1/todos?id=eq.5
Body: {"done": true}

# Delete matching rows
DELETE /rest/v1/todos?id=eq.5

# Get exact count
GET /rest/v1/todos?limit=10
Header: Prefer: count=exact
Response header: Content-Range: 0-9/42

# Upsert
POST /rest/v1/todos?on_conflict=id
Header: Prefer: resolution=merge-duplicates
Body: {"id": 5, "title": "Updated", "done": true}
```

### Resource embedding (fetching related data)

Embed related tables by nesting table names with parentheses inside the `select` parameter. pgrest-lambda detects relationships from foreign keys (standard PostgreSQL) or column naming convention (DSQL).

```bash
# Many-to-one: each order embeds its customer as an object
GET /rest/v1/orders?select=id,amount,customers(name,email)
# Response: [{"id": 1, "amount": 99.50, "customers": {"name": "Alice", "email": "alice@ex.com"}}]

# One-to-many: each customer embeds their orders as an array
GET /rest/v1/customers?select=id,name,orders(id,amount)
# Response: [{"id": 1, "name": "Alice", "orders": [{"id": 10, "amount": 50}, {"id": 11, "amount": 75}]}]

# Nested embedding (2+ levels)
GET /rest/v1/orders?select=id,items(id,quantity,products(name,price))

# Alias the embed key in the response
GET /rest/v1/orders?select=id,buyer:customers(name)
# Response: [{"id": 1, "buyer": {"name": "Alice"}}]

# Disambiguate when two FKs point to the same table
GET /rest/v1/orders?select=*,billing:addresses!billing_address_id(*),shipping:addresses!shipping_address_id(*)

# Inner join: only return parents that have matching children
GET /rest/v1/customers?select=id,name,orders!inner(id)

# Wildcard on both parent and embedded table
GET /rest/v1/orders?select=*,customers(*)
```

**supabase-js equivalents:**

```javascript
// Many-to-one
const { data } = await supabase.from('orders').select('id, amount, customers(name, email)')

// One-to-many
const { data } = await supabase.from('customers').select('id, name, orders(id, amount)')

// Nested
const { data } = await supabase.from('orders').select('id, items(id, products(name))')

// Aliased
const { data } = await supabase.from('orders').select('id, buyer:customers(name)')

// Disambiguation
const { data } = await supabase.from('orders').select('*, billing:addresses!billing_address_id(*), shipping:addresses!shipping_address_id(*)')

// Inner join
const { data } = await supabase.from('customers').select('id, name, orders!inner(id)')
```

**How relationships are detected:**

1. **Foreign key constraints** (standard PostgreSQL, Aurora, RDS, Neon): pgrest-lambda queries `pg_constraint` for FK relationships in the `public` schema. This is automatic and requires no configuration.

2. **Convention-based fallback** (DSQL or databases without FKs): when no FK constraints are found, pgrest-lambda infers relationships from column names. A column named `customer_id` on the `orders` table links to the `customers` table if that table exists and has a matching primary key. Handles common English plurals:
   - `customer_id` → `customers` (add s)
   - `address_id` → `addresses` (add es)
   - `category_id` → `categories` (y → ies)

The convention fallback only runs when the FK query returns zero relationships. Both mechanisms produce the same result format in the schema cache.

**Embed errors:**

| Code | Meaning |
|------|---------|
| PGRST200 | No relationship found between the two tables |
| PGRST201 | Multiple relationships found — use `!hint` to disambiguate |

**Limitations:**
- Many-to-many joins are not supported (use an explicit join table with two embeds)
- Computed relationships (PostgREST function-based joins) are not supported
- Embed filtering (`&orders.amount=gt.100`) is not yet supported

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
