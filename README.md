# pgrest-lambda

A serverless REST API for any PostgreSQL database.

Deploys as a single AWS Lambda function behind API Gateway. Introspects your PostgreSQL schema and serves PostgREST-compatible CRUD endpoints with GoTrue-compatible auth — no code generation, no framework lock-in.

## Features

- **PostgREST-compatible query syntax** — filtering, ordering, pagination, upserts, exact counts
- **GoTrue-compatible auth** — signup, signin, token refresh, user profile (`@supabase/supabase-js` works as a client)
- **OpenAPI 3.0 auto-generation** — hit `GET /rest/v1/` for the full spec
- **Multiple database backends** — Aurora DSQL (IAM auth), Aurora Serverless v2, RDS PostgreSQL, or any PostgreSQL
- **Lambda authorizer** — JWT-based with apikey + bearer token dual-layer auth
- **Row-level user isolation** — automatic `user_id` filtering on tables that have the column
- **Zero code generation** — your schema is your API

## Architecture

```
Client (supabase-js, fetch, curl)
  │
  ▼
API Gateway (REST)
  │
  ├── /auth/v1/*  →  Auth Handler (GoTrue-compatible)
  │                    ├── signup, token, user, logout
  │                    └── Cognito provider (swappable)
  │
  └── /rest/v1/*  →  REST Handler (PostgREST-compatible)
       │               ├── schema introspection
       │               ├── query parsing
       │               ├── SQL building (parameterized)
       │               └── OpenAPI generation
       │
       ▼
  PostgreSQL (DSQL / Aurora Sv2 / RDS / any)
```

## Quick Start

### Prerequisites

- AWS CLI configured
- AWS SAM CLI installed
- A PostgreSQL database (Aurora DSQL, Aurora Serverless v2, RDS, or any accessible PostgreSQL)

### 1. Clone and install

```bash
git clone https://github.com/yoshuacas/pgrest-lambda.git
cd pgrest-lambda
npm install
```

### 2. Create JWT secret

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# Store it in SSM Parameter Store:
aws ssm put-parameter \
  --name /pgrest/jwt-secret \
  --value "YOUR_SECRET_HERE" \
  --type SecureString
```

### 3. Deploy

**With Aurora DSQL:**
```bash
sam build && sam deploy --guided \
  --parameter-overrides \
    DatabaseMode=dsql \
    DsqlEndpoint=YOUR_CLUSTER.dsql.us-east-1.on.aws
```

**With standard PostgreSQL (Aurora Sv2, RDS, or any):**
```bash
sam build && sam deploy --guided \
  --parameter-overrides \
    DatabaseMode=standard \
    DatabaseUrl=postgresql://user:pass@host:5432/dbname
```

### 4. Use it

```javascript
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  'https://YOUR_API_ID.execute-api.us-east-1.amazonaws.com/v1',
  'YOUR_ANON_KEY'
);

// Sign up
const { data: auth } = await supabase.auth.signUp({
  email: 'user@example.com',
  password: 'Password123',
});

// Query data
const { data: todos } = await supabase
  .from('todos')
  .select('*')
  .order('created_at', { ascending: false });

// Insert
const { data: todo } = await supabase
  .from('todos')
  .insert({ title: 'Ship it', done: false })
  .select();
```

## Configuration

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DSQL_ENDPOINT` | If DSQL mode | Aurora DSQL cluster endpoint |
| `DATABASE_URL` | If standard mode | PostgreSQL connection string |
| `PG_HOST`, `PG_PORT`, `PG_USER`, `PG_PASSWORD`, `PG_DATABASE` | Alternative to DATABASE_URL | Individual connection parameters |
| `PG_SSL` | No | Set to `"true"` to enable SSL for standard connections |
| `REGION_NAME` | Yes | AWS region (do not use `AWS_REGION` — it's reserved) |
| `JWT_SECRET` | Yes | Secret for signing/verifying JWTs |
| `USER_POOL_ID` | Yes | Cognito User Pool ID |
| `USER_POOL_CLIENT_ID` | Yes | Cognito User Pool Client ID |
| `AUTH_PROVIDER` | No | Auth backend (default: `cognito`) |
| `SCHEMA_CACHE_TTL_MS` | No | Schema cache TTL in ms (default: `300000` / 5 min) |

### Database Modes

**DSQL mode** (`DSQL_ENDPOINT` is set):
- Uses IAM authentication — no passwords stored
- Tokens auto-refresh every 10 minutes
- Best for: Aurora DSQL clusters

**Standard mode** (`DATABASE_URL` or `PG_*` vars):
- Uses connection string or individual parameters
- Pool persists across Lambda invocations
- Best for: Aurora Serverless v2, RDS PostgreSQL, self-hosted PostgreSQL

## API Reference

### REST Endpoints (`/rest/v1/`)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/rest/v1/` | OpenAPI 3.0 spec |
| `POST` | `/rest/v1/_refresh` | Refresh schema cache |
| `GET` | `/rest/v1/:table` | Read rows (with filters) |
| `POST` | `/rest/v1/:table` | Insert rows |
| `PATCH` | `/rest/v1/:table` | Update rows (filters required) |
| `DELETE` | `/rest/v1/:table` | Delete rows (filters required) |

### Query Parameters

| Parameter | Example | Description |
|-----------|---------|-------------|
| `select` | `select=id,name,email` | Columns to return |
| `order` | `order=created_at.desc` | Sort order |
| `limit` | `limit=10` | Max rows |
| `offset` | `offset=20` | Skip rows |
| `on_conflict` | `on_conflict=id` | Upsert conflict column |

### Filter Operators

| Operator | Example | SQL |
|----------|---------|-----|
| `eq` | `name=eq.John` | `name = 'John'` |
| `neq` | `status=neq.done` | `status != 'done'` |
| `gt` | `age=gt.21` | `age > 21` |
| `gte` | `age=gte.21` | `age >= 21` |
| `lt` | `price=lt.100` | `price < 100` |
| `lte` | `price=lte.100` | `price <= 100` |
| `like` | `name=like.*john*` | `name LIKE '%john%'` |
| `ilike` | `name=ilike.*john*` | `name ILIKE '%john%'` |
| `in` | `id=in.(1,2,3)` | `id IN (1, 2, 3)` |
| `is` | `deleted_at=is.null` | `deleted_at IS NULL` |
| `not.*` | `status=not.eq.done` | `status != 'done'` |

### Headers

| Header | Description |
|--------|-------------|
| `Prefer: return=representation` | Return the modified rows |
| `Prefer: count=exact` | Include exact count in Content-Range |
| `Accept: application/vnd.pgrst.object+json` | Return single object instead of array |
| `apikey` | API key JWT (anon or service_role) |
| `Authorization: Bearer <token>` | User access token |

### Auth Endpoints (`/auth/v1/`)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/auth/v1/signup` | Register new user |
| `POST` | `/auth/v1/token?grant_type=password` | Sign in |
| `POST` | `/auth/v1/token?grant_type=refresh_token` | Refresh token |
| `GET` | `/auth/v1/user` | Get current user profile |
| `POST` | `/auth/v1/logout` | Sign out (204) |

## How It Works

1. **Schema introspection** — On first request (and every 5 minutes), queries `pg_catalog` to discover all tables, columns, types, and primary keys in the `public` schema.

2. **Request routing** — Incoming requests are routed by path: `/auth/v1/*` goes to the auth handler, `/rest/v1/:table` goes to the REST handler.

3. **Query building** — PostgREST-style query parameters are parsed and converted to parameterized SQL. All user input is parameterized — no string interpolation.

4. **User isolation** — If a table has a `user_id` column, queries are automatically filtered to the authenticated user. `service_role` bypasses this.

5. **Auth flow** — GoTrue-compatible endpoints wrap Amazon Cognito (swappable). The auth handler issues its own JWTs that the Lambda authorizer validates.

## Comparison with PostgREST

| | PostgREST | pgrest-lambda |
|---|-----------|---------------|
| Runtime | Standalone Haskell binary | AWS Lambda (Node.js) |
| Scaling | Manual / container | Automatic (serverless) |
| Cost at zero traffic | Server running 24/7 | $0 |
| Auth | External (bring your own) | Built-in GoTrue-compatible |
| Database | Any PostgreSQL | Any PostgreSQL |
| Client library | Any HTTP client | `@supabase/supabase-js` works |
| Deploy | Docker / binary | `sam deploy` |

## License

MIT
