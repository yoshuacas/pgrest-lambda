# GoTrue-Native Auth Provider

## Overview

Replace AWS Cognito with a GoTrue-native auth provider as
the default. Store users and refresh tokens directly in
PostgreSQL (DSQL-compatible), eliminating the external
Cognito dependency. Cognito stays available as an optional
provider (`AUTH_PROVIDER=cognito`).

Users live in an `auth` schema in the same database the
REST engine already connects to. The `auth` schema is
invisible to REST introspection, which targets `public`
only. The GoTrue provider shares the existing database pool
via `ctx.db`, requiring no new connection management.

All existing contracts are preserved: endpoints, JWT claims,
authorizer context, and response shapes. The implementation
remains wire-compatible with `@supabase/supabase-js`.

## Current CX / Concepts

### Cognito-Backed Auth

The auth layer delegates all user management to AWS Cognito.
The `createProvider` factory in
`src/auth/providers/interface.mjs` defaults to `'cognito'`
and dynamically imports `./cognito.mjs`. The Cognito
provider:

- Uses `@aws-sdk/client-cognito-identity-provider` for
  `SignUpCommand`, `InitiateAuthCommand`, `GetUserCommand`
- Requires `USER_POOL_ID`, `USER_POOL_CLIENT_ID`, and
  `REGION_NAME` environment variables
- Relies on a Cognito pre-signup Lambda
  (`src/presignup.mjs`) to auto-confirm users
- Maps Cognito exceptions to GoTrue error codes
  (`UsernameExistsException` -> `user_already_exists`, etc.)

The handler (`src/auth/handler.mjs` line 42) creates the
provider with `createProvider(config.auth)` — no database
reference is passed.

### JWT Wrapper for Refresh Tokens

The auth handler wraps provider-specific refresh tokens in
a pgrest-lambda JWT with a `prt` (provider refresh token)
claim (`src/auth/jwt.mjs` line 16). During refresh, the
handler extracts `claims.prt` (`handler.mjs` line 176) and
passes it back to `provider.refreshToken()`. This
indirection means the handler does not care what the
provider stores as a refresh token — it treats `prt` as an
opaque string.

### Dev Server Disables Auth

`dev.mjs` creates pgrest with `auth: false` (line 21),
which disables the auth handler entirely. Local development
has no auth endpoints.

### SAM Template Cognito Resources

`docs/deploy/aws-sam/template.yaml` defines four
unconditional Cognito resources: `UserPool`,
`UserPoolClient`, `PreSignUpFunction`, and
`PreSignUpPermission`. The `ApiFunction` environment
hardcodes `AUTH_PROVIDER: cognito`.

### Session Response Shape

`src/auth/gotrue-response.mjs` `sessionResponse()` returns:

```json
{
  "access_token": "...",
  "token_type": "bearer",
  "expires_in": 3600,
  "refresh_token": "...",
  "user": { ... }
}
```

supabase-js v2.39+ also expects an `expires_at` field
(Unix epoch seconds) in the session response. The current
implementation omits it.

## Proposed CX / CX Specification

### Default Provider Switch

After this change, `AUTH_PROVIDER` defaults to `'gotrue'`.
A fresh deployment uses the GoTrue-native provider with no
Cognito resources. Existing deployments that want Cognito
set `AUTH_PROVIDER=cognito` explicitly.

### Developer Experience

**Library usage — GoTrue (default):**

```javascript
import { createPgrest } from 'pgrest-lambda';

const pgrest = createPgrest({
  database: {
    host: 'localhost',
    port: 5432,
    user: 'postgres',
    password: 'secret',
    database: 'mydb',
  },
  jwtSecret: process.env.JWT_SECRET,
  // auth defaults to { provider: 'gotrue' }
  // no Cognito config needed
});
```

**Library usage — Cognito (opt-in):**

```javascript
const pgrest = createPgrest({
  database: { ... },
  jwtSecret: process.env.JWT_SECRET,
  auth: {
    provider: 'cognito',
    region: 'us-east-1',
    clientId: process.env.USER_POOL_CLIENT_ID,
  },
});
```

**supabase-js works identically — no client changes:**

```javascript
const { data, error } = await supabase.auth.signUp({
  email: 'user@example.com',
  password: 'SecurePass1',
});
```

### Local Development

The dev server (`dev.mjs`) enables auth by default.
Developers get working auth endpoints against their local
PostgreSQL:

```
$ node dev.mjs
pgrest-lambda dev server running at http://localhost:3000

API keys (pass as "apikey" header):
  anon:         eyJhbGci...
  service_role: eyJhbGci...

Auth endpoints:
  POST http://localhost:3000/auth/v1/signup
  POST http://localhost:3000/auth/v1/token?grant_type=password
  POST http://localhost:3000/auth/v1/token?grant_type=refresh_token
  GET  http://localhost:3000/auth/v1/user
  POST http://localhost:3000/auth/v1/logout
```

### Schema Auto-Initialization

On the first auth request after a cold start, the GoTrue
provider creates the `auth` schema and tables if they do
not exist. Each DDL statement runs individually (DSQL
single-statement constraint). Subsequent requests skip
initialization (module-level flag).

### Password Validation

The GoTrue provider enforces password policy locally:

- Minimum 8 characters
- At least one uppercase letter
- At least one lowercase letter
- At least one number

This matches Cognito's default password policy, so the
same passwords work with both providers.

**Error on weak password (HTTP 422):**

```json
{
  "error": "weak_password",
  "error_description": "Password must be at least 8 characters and include uppercase, lowercase, and numbers",
  "weak_password": {
    "reasons": ["length"]
  }
}
```

The `reasons` array contains one or more of: `"length"`,
`"uppercase"`, `"lowercase"`, `"number"`.

### Refresh Token Rotation

The GoTrue provider implements single-use refresh token
rotation with family revocation:

1. Each refresh produces a new opaque token. The old token
   is revoked.
2. New tokens record `parent = oldToken` for lineage
   tracking.
3. If a revoked token is reused (replay attack), ALL
   tokens for that user are revoked (family revocation).

This is stricter than the current Cognito behavior (which
allows reuse of refresh tokens) and matches GoTrue's
security model.

### Timing-Safe Sign-In

When a user does not exist, the provider performs a dummy
bcrypt comparison before throwing `invalid_grant`. This
prevents timing attacks that could enumerate valid email
addresses by measuring response time.

### Session Response — `expires_at` Addition

The session response gains an `expires_at` field:

```json
{
  "access_token": "...",
  "token_type": "bearer",
  "expires_in": 3600,
  "expires_at": 1712840400,
  "refresh_token": "...",
  "user": { ... }
}
```

`expires_at` is the Unix epoch second when the access token
expires (`Math.floor(Date.now() / 1000) + 3600`).
supabase-js v2.39+ uses this for proactive token refresh.
This applies to all providers (GoTrue and Cognito), since
it is added in the shared `gotrue-response.mjs`.

### Endpoints Unchanged

All auth endpoints remain identical:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/auth/v1/signup` | POST | Create account |
| `/auth/v1/token?grant_type=password` | POST | Sign in |
| `/auth/v1/token?grant_type=refresh_token` | POST | Refresh |
| `/auth/v1/user` | GET | Get user |
| `/auth/v1/logout` | POST | Sign out |

Request bodies, response shapes, error codes, and HTTP
status codes are identical to the existing Cognito-backed
implementation. The handler (`src/auth/handler.mjs`) needs
only a one-line change to pass `ctx.db` to the provider
factory.

### Error Responses (Unchanged)

| Condition | HTTP | Body |
|-----------|------|------|
| Missing email | 400 | `{"error":"validation_failed","error_description":"Email is required"}` |
| Missing password | 400 | `{"error":"validation_failed","error_description":"Password is required"}` |
| Invalid email format | 400 | `{"error":"validation_failed","error_description":"Invalid email format"}` |
| Password too weak | 422 | `{"error":"weak_password","error_description":"...","weak_password":{"reasons":[...]}}` |
| Email already registered | 400 | `{"error":"user_already_exists","error_description":"User already registered"}` |
| Invalid credentials | 400 | `{"error":"invalid_grant","error_description":"Invalid login credentials"}` |
| Invalid refresh token | 401 | `{"error":"invalid_grant","error_description":"Invalid refresh token"}` |
| Provider error | 500 | `{"error":"unexpected_failure","error_description":"An unexpected error occurred"}` |

## Technical Design

### Database Schema (DSQL-Compatible)

The schema uses an `auth` namespace to stay invisible to
REST introspection (which targets `public` only). All DDL
follows DSQL constraints: no foreign keys, no SERIAL, no
multi-statement transactions, no enums.

```sql
CREATE SCHEMA IF NOT EXISTS auth;

CREATE TABLE IF NOT EXISTS auth.users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT NOT NULL,
    encrypted_password TEXT NOT NULL,
    email_confirmed_at TIMESTAMPTZ DEFAULT now(),
    role TEXT NOT NULL DEFAULT 'authenticated',
    aud TEXT NOT NULL DEFAULT 'authenticated',
    app_metadata JSONB NOT NULL
      DEFAULT '{"provider":"email","providers":["email"]}'::jsonb,
    user_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS auth_users_email_idx
  ON auth.users (email);

CREATE TABLE IF NOT EXISTS auth.refresh_tokens (
    id BIGINT GENERATED BY DEFAULT AS IDENTITY
      (CACHE 1) PRIMARY KEY,
    token TEXT NOT NULL,
    user_id UUID NOT NULL,
    parent TEXT,
    revoked BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS
  auth_refresh_tokens_token_idx
  ON auth.refresh_tokens (token);
CREATE INDEX IF NOT EXISTS
  auth_refresh_tokens_user_id_idx
  ON auth.refresh_tokens (user_id);
```

**Design notes:**

- No FK between `refresh_tokens.user_id` and `users.id`
  — DSQL does not support foreign keys.
- `BIGINT GENERATED BY DEFAULT AS IDENTITY (CACHE 1)`
  replaces `SERIAL` — DSQL-compatible identity column.
- `gen_random_uuid()` is supported by both DSQL and
  standard PostgreSQL 13+.
- Each `CREATE` statement is a separate element in the
  `AUTH_SCHEMA_SQL` array, executed individually.

### Schema Initialization Module

**New file: `src/auth/schema.mjs`**

```javascript
export const AUTH_SCHEMA_SQL = [
  'CREATE SCHEMA IF NOT EXISTS auth',
  'CREATE TABLE IF NOT EXISTS auth.users ( ... )',
  'CREATE UNIQUE INDEX IF NOT EXISTS auth_users_email_idx ...',
  'CREATE TABLE IF NOT EXISTS auth.refresh_tokens ( ... )',
  'CREATE UNIQUE INDEX IF NOT EXISTS auth_refresh_tokens_token_idx ...',
  'CREATE INDEX IF NOT EXISTS auth_refresh_tokens_user_id_idx ...',
];

let initialized = false;

export async function ensureAuthSchema(pool) {
  if (initialized) return;
  for (const sql of AUTH_SCHEMA_SQL) {
    await pool.query(sql);
  }
  initialized = true;
}

export function _resetInitialized() {
  initialized = false;
}
```

The `initialized` flag is module-level — it persists across
requests within a single Lambda cold start. This means DDL
runs at most once per cold start. The `IF NOT EXISTS`
guards make it safe for concurrent Lambda instances to
initialize simultaneously.

`_resetInitialized()` is exported for tests only.

### GoTrue Provider

**New file: `src/auth/providers/gotrue.mjs`**

Implements the `AuthProvider` interface from
`src/auth/providers/interface.mjs`.

**Constructor:**

```javascript
export function createGoTrueProvider(config, db) {
  // db has getPool() from src/rest/db/postgres.mjs
  // or src/rest/db/dsql.mjs
  const provider = { signUp, signIn, refreshToken,
                     getUser, signOut };
  return { provider, _setClient: null };
}
```

Returns `{ provider, _setClient: null }` to match the
shape returned by `createCognitoProvider`, which the
handler stores at `ctx.authProviderSetClient`
(`handler.mjs` line 44).

**signUp(email, password):**

1. `const pool = await db.getPool()`
2. `await ensureAuthSchema(pool)`
3. Validate password:
   ```javascript
   const reasons = [];
   if (password.length < 8) reasons.push('length');
   if (!/[A-Z]/.test(password)) reasons.push('uppercase');
   if (!/[a-z]/.test(password)) reasons.push('lowercase');
   if (!/[0-9]/.test(password)) reasons.push('number');
   if (reasons.length > 0) {
     const err = new Error('Weak password');
     err.code = 'weak_password';
     err.reasons = reasons;
     throw err;
   }
   ```
4. Hash: `const hash = await bcrypt.hash(password, 10)`
5. INSERT:
   ```sql
   INSERT INTO auth.users (email, encrypted_password)
   VALUES ($1, $2)
   RETURNING id, email, app_metadata, user_metadata,
             created_at
   ```
6. Catch PostgreSQL error code `23505` (unique violation on
   email) -> throw `{ code: 'user_already_exists' }`
7. Return `AuthUser` from the RETURNING row.

**signIn(email, password):**

1. `const pool = await db.getPool()`
2. `await ensureAuthSchema(pool)`
3. SELECT:
   ```sql
   SELECT id, email, encrypted_password, app_metadata,
          user_metadata, created_at
   FROM auth.users WHERE email = $1
   ```
4. If no row:
   ```javascript
   // Timing-safe: run a dummy bcrypt compare so the
   // response time does not reveal whether the email
   // exists. Use a fixed dummy hash.
   await bcrypt.compare(password, DUMMY_HASH);
   const err = new Error('Invalid credentials');
   err.code = 'invalid_grant';
   throw err;
   ```
   `DUMMY_HASH` is a pre-computed valid bcrypt hash stored
   as a module constant. Generate it once at module load:
   ```javascript
   // Pre-computed: bcrypt.hashSync('dummy-password', 10)
   const DUMMY_HASH = '$2a$10$N9qo8uLOickgx2ZMRZoMye'
     + 'Ih9cvl6j5iHLbWb4Or/JtqKMZBHFwOC';
   ```
   The hash must be a syntactically valid bcrypt hash so
   that `bcrypt.compare` performs a full comparison (not
   an early-exit error path), ensuring the response time
   matches the valid-user case.
5. `const match = await bcrypt.compare(password, row.encrypted_password)`
6. If `!match` -> throw `{ code: 'invalid_grant' }`
7. Generate opaque refresh token:
   ```javascript
   const opaqueToken = crypto.randomBytes(16)
     .toString('base64url');
   ```
8. INSERT refresh token:
   ```sql
   INSERT INTO auth.refresh_tokens (token, user_id)
   VALUES ($1, $2)
   ```
9. Return:
   ```javascript
   {
     user: { id, email, app_metadata, user_metadata,
             created_at },
     providerTokens: { refreshToken: opaqueToken },
   }
   ```

**refreshToken(opaqueToken):**

1. `const pool = await db.getPool()`
2. `await ensureAuthSchema(pool)` (no-op after first
   call, but guards against cold starts that receive a
   refresh request before any signUp/signIn)
3. SELECT token row:
   ```sql
   SELECT id, token, user_id, revoked
   FROM auth.refresh_tokens WHERE token = $1
   ```
4. If not found -> throw `{ code: 'invalid_grant' }`
5. If revoked -> family revocation:
   ```sql
   UPDATE auth.refresh_tokens SET revoked = true,
     updated_at = now() WHERE user_id = $1
     AND revoked = false
   ```
   Then throw `{ code: 'invalid_grant' }`
6. Generate new opaque token:
   `crypto.randomBytes(16).toString('base64url')`
7. INSERT new token with parent:
   ```sql
   INSERT INTO auth.refresh_tokens
     (token, user_id, parent)
   VALUES ($1, $2, $3)
   ```
8. Revoke old token:
   ```sql
   UPDATE auth.refresh_tokens SET revoked = true,
     updated_at = now() WHERE id = $1
   ```
9. Fetch user:
   ```sql
   SELECT id, email, app_metadata, user_metadata,
          created_at
   FROM auth.users WHERE id = $1
   ```
10. Return:
   ```javascript
   {
     user: { id, email, app_metadata, user_metadata,
             created_at },
     providerTokens: { refreshToken: newToken },
   }
   ```

**getUser(userId):**

1. `const pool = await db.getPool()`
2. `await ensureAuthSchema(pool)`
3. SELECT:
   ```sql
   SELECT id, email, app_metadata, user_metadata,
          created_at
   FROM auth.users WHERE id = $1
   ```

**Interface note:** The `AuthProvider` typedef in
`interface.mjs` declares `getUser(providerAccessToken)`.
The Cognito provider interprets this as a Cognito access
token; the GoTrue provider interprets it as a user UUID.
The handler currently does not call `getUser` — it
reconstructs the user from JWT claims (`handler.mjs`
lines 215-220). Update the JSDoc typedef comment to
document that the parameter semantics are
provider-specific: Cognito treats it as an access token,
GoTrue treats it as a user ID.

**signOut():**

No-op. Same as Cognito. JWTs expire naturally.

### Provider Interface Changes

**Modified: `src/auth/providers/interface.mjs`**

```javascript
export async function createProvider(config, db) {
  const name = config.provider || 'gotrue';
  switch (name) {
    case 'gotrue': {
      const { createGoTrueProvider } =
        await import('./gotrue.mjs');
      return createGoTrueProvider(config, db);
    }
    case 'cognito': {
      const { createCognitoProvider } =
        await import('./cognito.mjs');
      return createCognitoProvider(config);
    }
    default:
      throw new Error(
        `Unknown auth provider: ${name}`);
  }
}
```

Changes:
1. Signature: `createProvider(config)` ->
   `createProvider(config, db)`
2. Default: `'cognito'` -> `'gotrue'`
3. New `case 'gotrue'` with dynamic import
4. Cognito case unchanged — ignores `db` param

### Handler Change

**Modified: `src/auth/handler.mjs`**

Line 42 changes from:

```javascript
const result = await createProvider(config.auth);
```

to:

```javascript
const result = await createProvider(config.auth, ctx.db);
```

One-line change. The handler already has `ctx.db` in scope.
Cognito's `createCognitoProvider` ignores the `db`
parameter.

### Config Default Change

**Modified: `src/index.mjs`**

Line 51 changes from:

```javascript
provider: process.env.AUTH_PROVIDER || 'cognito',
```

to:

```javascript
provider: process.env.AUTH_PROVIDER || 'gotrue',
```

### Session Response Change

**Modified: `src/auth/gotrue-response.mjs`**

In `sessionResponse()`, add `expires_at` to the response
body:

```javascript
export function sessionResponse(
    accessToken, refreshToken, user) {
  return {
    statusCode: 200,
    headers: corsHeaders(),
    body: JSON.stringify({
      access_token: accessToken,
      token_type: 'bearer',
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      refresh_token: refreshToken,
      user: formatUser(user),
    }),
  };
}
```

This is a backward-compatible addition — no fields are
removed or renamed.

### Dev Server Changes

**Modified: `dev.mjs`**

1. Remove `auth: false` from the `createPgrest` config.
   The default provider becomes GoTrue, which connects
   to the same local PostgreSQL as the REST engine.

2. Route `/auth/v1/*` paths through `pgrest.handler`
   instead of `pgrest.rest`, so auth requests reach the
   auth handler.

3. Print auth endpoints on startup alongside the existing
   API key output.

```javascript
const pgrest = createPgrest({
  database: {
    host: 'localhost',
    port: 5433,
    user: 'postgres',
    password: 'mySecurePassword123',
    database: 'postgres',
  },
  jwtSecret: JWT_SECRET,
  // auth defaults to { provider: 'gotrue' }
});
```

In the request handler, change `pgrest.rest(event)` to
`pgrest.handler(event)` for non-docs paths, so the
combined handler routes `/auth/v1/*` to auth and
everything else to REST.

### SAM Template Changes

**Modified: `docs/deploy/aws-sam/template.yaml`**

1. Add `AuthProvider` parameter:
   ```yaml
   AuthProvider:
     Type: String
     Default: gotrue
     AllowedValues: [gotrue, cognito]
   ```

2. Add `IsCognito` condition:
   ```yaml
   IsCognito: !Equals [!Ref AuthProvider, cognito]
   ```

3. Make Cognito resources conditional on `IsCognito`:
   - `UserPool` — add `Condition: IsCognito`
   - `UserPoolClient` — add `Condition: IsCognito`
   - `PreSignUpFunction` — add `Condition: IsCognito`
   - `PreSignUpPermission` — add `Condition: IsCognito`

4. Use `!If` for Cognito-specific environment variables
   on `ApiFunction`:
   ```yaml
   USER_POOL_ID: !If
     [IsCognito, !Ref UserPool, !Ref 'AWS::NoValue']
   USER_POOL_CLIENT_ID: !If
     [IsCognito, !Ref UserPoolClient, !Ref 'AWS::NoValue']
   AUTH_PROVIDER: !Ref AuthProvider
   ```

5. Make Cognito-specific outputs conditional:
   ```yaml
   UserPoolId:
     Condition: IsCognito
     Value: !Ref UserPool
   UserPoolClientId:
     Condition: IsCognito
     Value: !Ref UserPoolClient
   ```

### bcryptjs Dependency

**Modified: `package.json`**

Add `bcryptjs` to dependencies:

```json
"bcryptjs": "^2.4.3"
```

`bcryptjs` is a pure JavaScript bcrypt implementation with
zero native compilation. Lambda-safe on all architectures
(x86_64 and arm64). The `bcrypt` npm package requires
native compilation and fails on Lambda unless pre-built
for the target architecture — `bcryptjs` avoids this.

Performance: `bcryptjs` is ~3x slower than native `bcrypt`
for hashing (cost factor 10 takes ~100ms vs ~30ms). This
is acceptable for auth operations, which are infrequent
compared to REST queries.

**ESM import:** The project uses `"type": "module"`.
`bcryptjs` ships a CommonJS module, so import it as:
```javascript
import bcrypt from 'bcryptjs';
```
Node.js handles the CJS-to-ESM interop via the default
export.

## Code Architecture / File Changes

### New Files

| File | Purpose | ~Lines |
|------|---------|--------|
| `src/auth/schema.mjs` | DDL array + `ensureAuthSchema()` | 50 |
| `src/auth/providers/gotrue.mjs` | GoTrue-native AuthProvider | 150 |
| `src/auth/__tests__/gotrue-provider.test.mjs` | GoTrue provider unit tests | 200 |
| `src/auth/__tests__/schema.test.mjs` | Schema init unit tests | 40 |

### Modified Files

| File | Change |
|------|--------|
| `package.json` | Add `bcryptjs` dependency |
| `src/auth/providers/interface.mjs` | Add `db` param, default to `'gotrue'`, add `case 'gotrue'` |
| `src/auth/handler.mjs` | Pass `ctx.db` to `createProvider` (one-line change) |
| `src/index.mjs` | Default provider `'cognito'` -> `'gotrue'` |
| `src/auth/gotrue-response.mjs` | Add `expires_at` to session response |
| `dev.mjs` | Remove `auth: false`, route through `handler`, print auth endpoints |
| `docs/deploy/aws-sam/template.yaml` | Add `AuthProvider` param, `IsCognito` condition, conditional Cognito resources |
| `README.md` | Update auth section: GoTrue default, Cognito optional |
| `CLAUDE.md` | Update rule 8 to mention GoTrue as default |
| `CHANGELOG.md` | Add entry under Unreleased |

### Files That Do NOT Change

- `src/auth/providers/cognito.mjs` — unchanged
- `src/auth/jwt.mjs` — unchanged (the `prt` claim
  pattern works for both opaque DB tokens and Cognito
  refresh tokens)
- `src/authorizer/index.mjs` — unchanged
- `src/rest/**` — no REST changes
- `src/presignup.mjs` — unchanged (still needed for
  Cognito deployments)

## Testing Strategy

### Unit Tests: `src/auth/__tests__/schema.test.mjs`

- `ensureAuthSchema` executes all SQL statements in
  `AUTH_SCHEMA_SQL` order, using a mock pool that records
  calls.
- Second call to `ensureAuthSchema` is a no-op (mock
  pool receives zero additional calls).
- After `_resetInitialized()`, the next call executes
  all statements again.

### Unit Tests: `src/auth/__tests__/gotrue-provider.test.mjs`

All tests use a mock pool that returns canned query
results. No real database.

**signUp:**

- Returns `AuthUser` with UUID `id`, `email`,
  `app_metadata`, `user_metadata`, `created_at` from the
  RETURNING row.
- With duplicate email (mock pool throws error with
  `code: '23505'`), throws `{ code: 'user_already_exists' }`.
- With weak password (too short), throws
  `{ code: 'weak_password', reasons: ['length'] }`.
- With weak password (missing uppercase), throws
  `{ code: 'weak_password', reasons: ['uppercase'] }`.
- With weak password (missing lowercase), throws
  `{ code: 'weak_password', reasons: ['lowercase'] }`.
- With weak password (missing number), throws
  `{ code: 'weak_password', reasons: ['number'] }`.
- With weak password (multiple violations), throws with
  multiple reasons.
- Calls `ensureAuthSchema` before INSERT.

  > Warning: Tests that verify `ensureAuthSchema` was
  > called should check the mock pool's query log for
  > the DDL statements, not just that the signUp
  > succeeded. A successful signUp could occur without
  > schema init if the test mock does not enforce the
  > schema existence.

**signIn:**

- With valid credentials (mock pool returns user row,
  bcrypt compare succeeds), returns
  `{ user, providerTokens: { refreshToken } }`.
  `refreshToken` is a base64url string.
- With wrong password (bcrypt compare fails), throws
  `{ code: 'invalid_grant' }`.
- With nonexistent user (mock pool returns zero rows),
  throws `{ code: 'invalid_grant' }`. Verify the
  response time is comparable to the valid-user case
  (dummy bcrypt compare was performed).

  > Warning: The timing-safe test is inherently
  > non-deterministic. The test should verify that
  > `bcrypt.compare` was called even when the user
  > does not exist (via mock/spy), rather than trying
  > to measure wall-clock timing differences.

- Inserts a row into `auth.refresh_tokens`.

**refreshToken:**

- With valid token (mock pool returns non-revoked token
  row), returns new `{ user, providerTokens }` with a
  different `refreshToken`. The old token is revoked
  (UPDATE query issued). The new token has
  `parent = oldToken`.
- With revoked token (mock pool returns revoked row),
  triggers family revocation (UPDATE all user tokens)
  and throws `{ code: 'invalid_grant' }`.
- With nonexistent token (mock pool returns zero rows),
  throws `{ code: 'invalid_grant' }`.

**getUser:**

- Returns `AuthUser` by ID from mock pool.

**signOut:**

- Returns `undefined` (no-op).

### Existing Tests Must Still Pass

- `src/auth/__tests__/handler.test.mjs` — uses a mock
  provider, so it is provider-agnostic. The handler
  changes (passing `ctx.db`) should not affect these
  tests since the mock provider ignores the `db` param.
- `src/auth/__tests__/jwt.test.mjs` — no changes to JWT
  module.
- `src/auth/__tests__/gotrue-response.test.mjs` — the
  `expires_at` addition is backward-compatible. The
  existing `sessionResponse` test asserts individual
  fields (`body.access_token`, `body.expires_in`, etc.)
  without using `deepEqual` on the full body, so the
  new `expires_at` field does not break existing
  assertions. However, it is good practice to add an
  assertion for `expires_at` in the existing test.

  > Warning: The `expires_at` value depends on
  > `Date.now()`. Tests that assert the exact value
  > should either mock `Date.now()` or assert within
  > a tolerance range (e.g., `expires_at` is within
  > 2 seconds of expected).

- `src/auth/__tests__/cognito-provider.test.mjs` —
  Cognito provider unchanged.
- `src/auth/__tests__/integration.test.mjs` — if this
  test creates pgrest with explicit `auth.provider`
  config, it continues to work. If it relies on the
  default provider, it now gets GoTrue instead of
  Cognito — check and update if needed.

### Verification Commands

```bash
# New tests
node --test src/auth/__tests__/gotrue-provider.test.mjs \
            src/auth/__tests__/schema.test.mjs

# Existing auth tests
node --test src/auth/__tests__/handler.test.mjs \
            src/auth/__tests__/jwt.test.mjs \
            src/auth/__tests__/gotrue-response.test.mjs

# All tests
npm test
```

## Implementation Order

### Phase 1: Schema Module

1. Create `src/auth/schema.mjs` with `AUTH_SCHEMA_SQL`,
   `ensureAuthSchema()`, and `_resetInitialized()`.
2. Create `src/auth/__tests__/schema.test.mjs`.
3. Verify: `node --test src/auth/__tests__/schema.test.mjs`

### Phase 2: GoTrue Provider

4. Add `bcryptjs` to `package.json` and `npm install`.
5. Create `src/auth/providers/gotrue.mjs` implementing the
   full `AuthProvider` interface.
6. Create `src/auth/__tests__/gotrue-provider.test.mjs`.
7. Verify: `node --test src/auth/__tests__/gotrue-provider.test.mjs`

### Phase 3: Wire Up

8. Modify `src/auth/providers/interface.mjs` — add `db`
   param, default to `'gotrue'`, add `case 'gotrue'`.
9. Modify `src/auth/handler.mjs` — pass `ctx.db` to
   `createProvider`.
10. Modify `src/index.mjs` — default `'cognito'` ->
    `'gotrue'`.
11. Modify `src/auth/gotrue-response.mjs` — add
    `expires_at`.
12. Verify existing tests: `npm test`

### Phase 4: Dev Server

13. Modify `dev.mjs` — enable auth, route through
    `handler`, print auth endpoints.
14. Manual verification: `node dev.mjs`, test signup and
    signin against local PostgreSQL.

### Phase 5: SAM Template

15. Modify `docs/deploy/aws-sam/template.yaml` — add
    `AuthProvider` param, `IsCognito` condition,
    conditional resources.

### Phase 6: Documentation

16. Update `README.md` auth section.
17. Update `CLAUDE.md` rule 8.
18. Update `CHANGELOG.md` Unreleased section.

## Open Questions

1. **Refresh token cleanup.** The `auth.refresh_tokens`
   table grows indefinitely as tokens are rotated. Revoked
   and expired tokens accumulate. A future design should
   add a cleanup mechanism — either a TTL-based sweep
   (e.g., delete revoked tokens older than 30 days) or a
   scheduled Lambda. Not included in this implementation
   to keep scope tight.

2. **Password reset flow.** GoTrue supports
   `POST /auth/v1/recover` for password reset. This
   requires email sending (SES or similar). Deferred to
   a future design. The GoTrue provider stores
   `encrypted_password` so password updates are
   straightforward once the email flow exists.

3. **DSQL `BIGINT GENERATED BY DEFAULT AS IDENTITY`
   behavior.** DSQL's identity column implementation may
   differ from standard PostgreSQL in edge cases
   (concurrent inserts, cache exhaustion). The
   `refresh_tokens.id` column uses this for the primary
   key. If DSQL issues arise, switch to
   `UUID DEFAULT gen_random_uuid()` as the PK instead.

4. **Concurrent schema initialization.** Multiple Lambda
   instances may call `ensureAuthSchema` simultaneously
   on first deploy. The `IF NOT EXISTS` guards prevent
   errors, but there is a brief window where multiple
   instances execute the same DDL. This is benign —
   PostgreSQL handles concurrent `CREATE IF NOT EXISTS`
   gracefully. On DSQL, concurrent DDL behavior is less
   documented; if issues arise, add a distributed lock
   or accept the brief DDL duplication.

5. **Database user privileges.** `ensureAuthSchema` runs
   `CREATE SCHEMA IF NOT EXISTS auth`, which requires the
   `CREATE` privilege on the database. The database user
   configured in the connection (e.g., `postgres` in
   dev, the IAM-authenticated user for DSQL) must have
   this privilege. For DSQL, the `admin` role used with
   `dsql:DbConnectAdmin` has sufficient privileges. For
   standard PostgreSQL, the `postgres` superuser or a
   user granted `CREATE` on the database suffices. If
   the user lacks this privilege, every cold start will
   fail on the first auth request. A future improvement
   could separate schema migration from runtime
   initialization.
