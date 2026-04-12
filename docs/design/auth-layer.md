# Supabase-Compatible Authentication

## Overview

Add GoTrue-compatible auth endpoints to the BOA backend so
that `@supabase/supabase-js` apps can authenticate by
changing only the Project URL and Anon Key. The auth Lambda
authenticates against Cognito but mints BOA-issued JWTs
with `role` and `aud` claims that supabase-js expects. A
custom Lambda authorizer replaces the Cognito authorizer on
API Gateway, passing `{role, userId, email}` to downstream
handlers. No authorization or RLS logic is included — that
comes in a later design.

## Current CX / Concepts

### Authentication Today

The SAM template (`plugin/templates/backend.yaml` lines
96–110) creates a REST API Gateway with a built-in Cognito
authorizer:

```yaml
Auth:
  DefaultAuthorizer: CognitoAuthorizer
  Authorizers:
    CognitoAuthorizer:
      UserPoolArn: !GetAtt UserPool.Arn
```

Frontend apps authenticate directly with Cognito using
`amazon-cognito-identity-js` and pass Cognito JWTs in the
`Authorization` header. The Lambda handler extracts the user
ID from `event.requestContext.authorizer.claims.sub`
(`plugin/lambda-templates/crud-api.mjs` line 72).

### Problems

1. **No supabase-js compatibility.** Cognito JWTs lack
   `role` and `aud` claims. `supabase-js` expects GoTrue
   response shapes and JWT claim structures.
2. **No anon access.** The Cognito authorizer rejects all
   unauthenticated requests — there is no concept of an
   anon key or public access tier.
3. **No service role key.** No way to make admin-level
   requests that bypass row-level filtering.
4. **Tight coupling to Cognito.** Swapping to Clerk or
   Auth0 would require rewriting auth logic throughout the
   stack.

### Bootstrap Today

`plugin/scripts/bootstrap.sh` runs `sam build && sam deploy`
and writes `.boa/config.json` with `apiUrl`, `userPoolId`,
`userPoolClientId`, `bucketName`, and `dsqlEndpoint`. There
is no JWT secret, no anon key, and no service role key.

## Proposed CX / CX Specification

### Developer Experience

After bootstrap, the developer has a `.boa/config.json`
containing `apiUrl`, `anonKey`, and `serviceRoleKey`. They
use supabase-js with zero code changes:

```javascript
import { createClient } from '@supabase/supabase-js'
import config from './.boa/config.json'

const supabase = createClient(config.apiUrl, config.anonKey)
```

All auth operations work identically to Supabase:

```javascript
// Sign up
const { data, error } = await supabase.auth.signUp({
  email: 'user@example.com',
  password: 'securepassword'
})

// Sign in
const { data, error } = await supabase.auth.signInWithPassword({
  email: 'user@example.com',
  password: 'securepassword'
})

// Get user
const { data: { user } } = await supabase.auth.getUser()

// Sign out
await supabase.auth.signOut()
```

### Auth Endpoints

All endpoints live under `/auth/v1/` and are publicly
accessible (no authorizer). The auth Lambda handles them.

#### POST /auth/v1/signup

Create a new user account.

**Request:**
```json
{
  "email": "user@example.com",
  "password": "securepassword"
}
```

**Success response (200):**
```json
{
  "access_token": "eyJhbGciOiJIUzI1NiIs...",
  "token_type": "bearer",
  "expires_in": 3600,
  "refresh_token": "eyJhbGciOiJIUzI1NiIs...",
  "user": {
    "id": "a1b2c3d4-...",
    "email": "user@example.com",
    "role": "authenticated",
    "aud": "authenticated",
    "app_metadata": {
      "provider": "email",
      "providers": ["email"]
    },
    "user_metadata": {},
    "created_at": "2026-04-11T12:00:00.000Z"
  }
}
```

**Validation rules:**
- `email` is required and must be a valid email format.
- `password` is required and must meet Cognito's password
  policy (8+ chars, upper, lower, number).
- If the email already exists, the provider returns an
  error.

**Error responses:**

| Condition | HTTP | Body |
|-----------|------|------|
| Missing email | 400 | `{"error":"validation_failed","error_description":"Email is required"}` |
| Missing password | 400 | `{"error":"validation_failed","error_description":"Password is required"}` |
| Invalid email format | 400 | `{"error":"validation_failed","error_description":"Invalid email format"}` |
| Password too weak | 422 | `{"error":"weak_password","error_description":"Password must be at least 8 characters and include uppercase, lowercase, and numbers","weak_password":{"reasons":["length","characters"]}}` |
| Email already registered | 400 | `{"error":"user_already_exists","error_description":"User already registered"}` |
| Provider error | 500 | `{"error":"unexpected_failure","error_description":"An unexpected error occurred"}` |

**Flow:** provider.signUp → provider.signIn → sign BOA
access token + refresh token → format GoTrue response.

The signup endpoint calls signIn immediately after signUp
because the pre-signup Lambda auto-confirms users. This
returns tokens directly, matching GoTrue's behavior where
a confirmed user receives tokens on signup.

#### POST /auth/v1/token?grant_type=password

Sign in an existing user.

**Request:**
```json
{
  "email": "user@example.com",
  "password": "securepassword"
}
```

**Success response (200):** Same shape as signup response.

**Error responses:**

| Condition | HTTP | Body |
|-----------|------|------|
| Missing email | 400 | `{"error":"validation_failed","error_description":"Email is required"}` |
| Missing password | 400 | `{"error":"validation_failed","error_description":"Password is required"}` |
| Invalid credentials | 400 | `{"error":"invalid_grant","error_description":"Invalid login credentials"}` |
| Missing grant_type | 400 | `{"error":"unsupported_grant_type","error_description":"Missing or unsupported grant_type"}` |
| Unknown grant_type | 400 | `{"error":"unsupported_grant_type","error_description":"Missing or unsupported grant_type"}` |

**Flow:** provider.signIn → sign BOA tokens → format
GoTrue response.

#### POST /auth/v1/token?grant_type=refresh_token

Refresh an expired session.

**Request:**
```json
{
  "refresh_token": "eyJhbGciOiJIUzI1NiIs..."
}
```

**Success response (200):** Same shape as signup/signin
response, with new tokens.

**Error responses:**

| Condition | HTTP | Body |
|-----------|------|------|
| Missing refresh_token | 400 | `{"error":"validation_failed","error_description":"Refresh token is required"}` |
| Invalid/expired refresh token | 401 | `{"error":"invalid_grant","error_description":"Invalid refresh token"}` |

**Flow:** verify BOA refresh JWT → extract `prt` claim
(Cognito refresh token) → provider.refreshToken → sign
new BOA tokens → format GoTrue response.

#### GET /auth/v1/user

Get the current user from their access token.

**Request headers:**
```
Authorization: Bearer <access_token>
```

**Success response (200):**
```json
{
  "id": "a1b2c3d4-...",
  "email": "user@example.com",
  "role": "authenticated",
  "aud": "authenticated",
  "app_metadata": {
    "provider": "email",
    "providers": ["email"]
  },
  "user_metadata": {},
  "created_at": "2026-04-11T12:00:00.000Z"
}
```

**Error responses:**

| Condition | HTTP | Body |
|-----------|------|------|
| Missing Authorization header | 401 | `{"error":"not_authenticated","error_description":"Missing authorization header"}` |
| Invalid/expired token | 401 | `{"error":"not_authenticated","error_description":"Invalid or expired token"}` |

**Flow:** verify BOA access JWT → return user object from
claims. Does not call the provider — all user info is in
the JWT.

#### POST /auth/v1/logout

Sign out the current user.

**Success response:** HTTP 204, no body.

This is a client-side operation. The auth Lambda returns 204
regardless of whether a valid token was provided. supabase-js
clears the local session. BOA JWTs expire naturally (1 hour
for access tokens). No server-side token revocation in MVP.

#### Unsupported Endpoints

Any other path under `/auth/v1/` returns:

```
HTTP 404
{"error":"not_found","error_description":"Endpoint not found"}
```

### BOA JWT Structure

#### Access Token (1 hour)

```json
{
  "sub": "a1b2c3d4-...",
  "email": "user@example.com",
  "role": "authenticated",
  "aud": "authenticated",
  "iss": "boa",
  "iat": 1712836800,
  "exp": 1712840400
}
```

#### Refresh Token (30 days)

```json
{
  "sub": "a1b2c3d4-...",
  "role": "authenticated",
  "iss": "boa",
  "prt": "<cognito-refresh-token>",
  "iat": 1712836800,
  "exp": 1715428800
}
```

The `prt` (provider refresh token) claim embeds the Cognito
refresh token. When the client sends this refresh token back,
the auth Lambda extracts `prt` and uses it to get new Cognito
tokens.

**Note:** Supabase GoTrue refresh tokens never expire and are
single-use (rotated on each refresh). BOA refresh tokens have
a 30-day expiry to match the Cognito refresh token default
lifetime. BOA does not enforce single-use rotation in MVP —
a refresh token can be reused until it expires or the
underlying Cognito refresh token is revoked. This is a
known simplification.

#### Anon Key (10 years)

```json
{
  "role": "anon",
  "iss": "boa",
  "iat": 1712836800,
  "exp": 2028196800
}
```

#### Service Role Key (10 years)

```json
{
  "role": "service_role",
  "iss": "boa",
  "iat": 1712836800,
  "exp": 2028196800
}
```

All JWTs use HS256 with the `JWT_SECRET` stored in SSM
Parameter Store at `/${stack-name}/jwt-secret` as a
SecureString.

### Custom Lambda Authorizer

The authorizer replaces the Cognito authorizer on API
Gateway. It is a REQUEST-type Lambda authorizer with a
300-second cache per Authorization header value.

**Input headers:**
- `apikey` — contains the anon key or service role key
- `Authorization` — `Bearer <token>` (always present)

**Important: supabase-js header behavior.** supabase-js
sends *both* `apikey` and `Authorization: Bearer` on every
request. When no user is signed in, the Authorization header
contains the anon key itself (same value as `apikey`). When a
user is authenticated, the Authorization header contains the
user's access token. The authorizer must handle all
combinations:

| apikey | Authorization Bearer | Effective Role |
|--------|---------------------|----------------|
| anon key | anon key (same) | anon |
| anon key | user access token | authenticated |
| service_role key | service_role key | service_role |
| anon key | expired/invalid | Deny (401) |
| (missing) | any | Deny (401) |

**Authorization logic:**

1. Extract `apikey` header. If missing or invalid JWT,
   return 401 (Unauthorized).
2. Verify `apikey` JWT with `JWT_SECRET`. The `role` claim
   must be `anon` or `service_role`.
3. Extract `Authorization: Bearer <token>`.
   a. Verify the bearer JWT with `JWT_SECRET`.
   b. Use the bearer token's claims for the effective
      identity (role, sub, email). This handles all cases:
      bearer may be an anon key, a user access token, or a
      service role key.
   c. If the bearer JWT is invalid/expired, return 401.
4. If no Authorization header, use the apikey's claims.
   (This case is unlikely with supabase-js but supported
   for direct API callers.)
5. Return an IAM Allow policy with context:

```json
{
  "principalId": "<userId or 'anon'>",
  "policyDocument": {
    "Version": "2012-10-17",
    "Statement": [{
      "Action": "execute-api:Invoke",
      "Effect": "Allow",
      "Resource": "<methodArn>"
    }]
  },
  "context": {
    "role": "authenticated",
    "userId": "a1b2c3d4-...",
    "email": "user@example.com"
  }
}
```

**Context values by role:**

| Role | userId | email |
|------|--------|-------|
| `anon` | `""` | `""` |
| `authenticated` | `<sub from JWT>` | `<email from JWT>` |
| `service_role` | `""` | `""` |

**Downstream contract:** After auth, any Lambda handler
reads:
```javascript
event.requestContext.authorizer.role     // 'anon' | 'authenticated' | 'service_role'
event.requestContext.authorizer.userId   // string: user UUID or ''
event.requestContext.authorizer.email    // string or ''
```

### Key Generation

`plugin/scripts/generate-keys.mjs` is a pure Node.js script
(no external dependencies) that generates BOA JWTs using
the `crypto` module for HMAC-SHA256 signing.

**Usage:**
```bash
node generate-keys.mjs <jwt-secret>
```

**Output (JSON to stdout):**
```json
{
  "anonKey": "eyJhbGciOiJIUzI1NiIs...",
  "serviceRoleKey": "eyJhbGciOiJIUzI1NiIs..."
}
```

The script must not depend on `jsonwebtoken` because it runs
on the developer's machine during bootstrap, before
`npm install` has been run in the Lambda directory. It uses
`crypto.createHmac('sha256', secret)` with manual JWT
encoding (base64url header + payload + signature).

### Bootstrap Changes

Bootstrap.sh is modified to add JWT secret generation
**before** `sam deploy` (because the SAM template uses
`{{resolve:ssm:...}}` which resolves at deploy time) and
key generation after deploy.

**Before `sam deploy`:**

1. Generate a 32-byte random JWT secret:
   ```bash
   JWT_SECRET=$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64'))")
   ```
2. Store in SSM Parameter Store:
   ```bash
   aws ssm put-parameter \
     --name "/${STACK_NAME}/jwt-secret" \
     --value "$JWT_SECRET" \
     --type SecureString \
     --overwrite \
     --region "$REGION"
   ```

**After `sam deploy`:**

3. Generate anon key and service role key:
   ```bash
   KEYS=$(node "$SCRIPT_DIR/generate-keys.mjs" "$JWT_SECRET")
   ANON_KEY=$(echo "$KEYS" | jq -r '.anonKey')
   SERVICE_ROLE_KEY=$(echo "$KEYS" | jq -r '.serviceRoleKey')
   ```
4. Write extended `.boa/config.json`:
   ```json
   {
     "stackName": "my-app",
     "region": "us-east-1",
     "accountId": "123456789012",
     "apiUrl": "https://xxx.execute-api.us-east-1.amazonaws.com/prod",
     "anonKey": "eyJhbGciOiJIUzI1NiIs...",
     "serviceRoleKey": "eyJhbGciOiJIUzI1NiIs...",
     "userPoolId": "us-east-1_xxxxx",
     "userPoolClientId": "xxxxxxxxx",
     "bucketName": "my-app-storage-123456",
     "dsqlEndpoint": "xxx.dsql.us-east-1.on.aws",
     "deployedAt": "2026-04-11T12:00:00Z"
   }
   ```

### CORS Changes

The API Gateway CORS configuration must be updated to allow
headers that supabase-js sends:

| Setting | Current | New |
|---------|---------|-----|
| AllowMethods | `GET,POST,PUT,DELETE,OPTIONS` | `GET,POST,PUT,PATCH,DELETE,OPTIONS` |
| AllowHeaders | `Content-Type,Authorization` | `Content-Type,Authorization,apikey,Prefer,Accept,x-client-info` |
| AllowOrigin | `*` | `*` (unchanged) |
| ExposeHeaders | (none) | `Content-Range` |

PATCH is needed for PostgREST update operations. `apikey`
is sent by supabase-js on every request. `Prefer` controls
response format (return=representation, count=exact).
`x-client-info` is supabase-js telemetry. `Content-Range`
must be exposed for pagination.

## Technical Design

### Auth Provider Interface

`plugin/lambda-templates/auth/providers/interface.mjs`

Defines the contract that any auth provider must implement.
This is documentation, not runtime enforcement — JavaScript
does not have interfaces. The file exports JSDoc type
definitions and a factory function.

```javascript
/**
 * @typedef {Object} AuthUser
 * @property {string} id       - Provider user ID (UUID)
 * @property {string} email    - User email
 * @property {Object} app_metadata
 * @property {Object} user_metadata
 * @property {string} created_at
 */

/**
 * @typedef {Object} AuthProvider
 * @property {(email: string, password: string) => Promise<AuthUser>} signUp
 * @property {(email: string, password: string) => Promise<{user: AuthUser, providerTokens: Object}>} signIn
 * @property {(providerRefreshToken: string) => Promise<{user: AuthUser, providerTokens: Object}>} refreshToken
 * @property {(providerAccessToken: string) => Promise<AuthUser>} getUser
 * @property {(providerAccessToken: string) => Promise<void>} signOut
 */

/**
 * Returns an AuthProvider based on AUTH_PROVIDER env var.
 * Default: 'cognito'.
 */
export function createProvider() {
  const name = process.env.AUTH_PROVIDER || 'cognito';
  switch (name) {
    case 'cognito':
      // dynamic import to keep other providers tree-shakeable
      return import('./cognito.mjs').then(m => m.default);
    default:
      throw new Error(`Unknown auth provider: ${name}`);
  }
}
```

### Cognito Provider

`plugin/lambda-templates/auth/providers/cognito.mjs`

Uses `@aws-sdk/client-cognito-identity-provider`. This
package is not guaranteed to be in the Lambda Node.js 20.x
runtime (AWS SDK v3 is modular and only a subset of clients
are pre-installed). It must be added to `package.json` as
an explicit dependency.

| Method | Cognito SDK Command | Notes |
|--------|---------------------|-------|
| `signUp(email, password)` | `SignUpCommand` | Pre-signup Lambda auto-confirms |
| `signIn(email, password)` | `InitiateAuthCommand` (USER_PASSWORD_AUTH) | Returns Cognito tokens |
| `refreshToken(token)` | `InitiateAuthCommand` (REFRESH_TOKEN_AUTH) | Returns new Cognito tokens |
| `getUser(accessToken)` | `GetUserCommand` | Returns user attributes |
| `signOut(accessToken)` | (no-op) | Returns void, JWT expires naturally |

**Environment variables required:**
- `REGION_NAME` — AWS region
- `USER_POOL_CLIENT_ID` — Cognito app client ID

**Error mapping:**

| Cognito Exception | GoTrue Error |
|-------------------|--------------|
| `UsernameExistsException` | `user_already_exists` |
| `NotAuthorizedException` | `invalid_grant` |
| `UserNotFoundException` | `invalid_grant` |
| `InvalidPasswordException` | `weak_password` |
| `InvalidParameterException` | `validation_failed` |
| `CodeMismatchException` | `invalid_grant` |
| Other | `unexpected_failure` |

**Note:** The Cognito UserPoolClient has
`PreventUserExistenceErrors: ENABLED`, so during signIn,
Cognito throws `NotAuthorizedException` instead of
`UserNotFoundException` when the user does not exist. The
`UserNotFoundException` mapping is retained as a defensive
catch for other operations (e.g., `GetUserCommand`) but
will not be triggered during normal signIn flows.

The `signIn` method returns `providerTokens`:
```javascript
{
  accessToken: result.AuthenticationResult.AccessToken,
  refreshToken: result.AuthenticationResult.RefreshToken,
  idToken: result.AuthenticationResult.IdToken
}
```

The Cognito `accessToken` is not used further — BOA mints
its own JWTs. The `refreshToken` is embedded in the BOA
refresh token's `prt` claim. The `idToken` is not used.

The `signUp` method extracts the user's `sub` from the
Cognito SignUp response (`response.UserSub`).

### JWT Module

`plugin/lambda-templates/auth/jwt.mjs`

Uses `jsonwebtoken` (npm dependency) for signing and
verification.

```javascript
import jwt from 'jsonwebtoken';

const SECRET = process.env.JWT_SECRET;
const ISSUER = 'boa';

export function signAccessToken({ sub, email }) {
  return jwt.sign(
    { sub, email, role: 'authenticated', aud: 'authenticated' },
    SECRET,
    { issuer: ISSUER, expiresIn: '1h' }
  );
}

export function signRefreshToken(sub, providerRefreshToken) {
  return jwt.sign(
    { sub, role: 'authenticated', prt: providerRefreshToken },
    SECRET,
    { issuer: ISSUER, expiresIn: '30d' }
  );
}

export function verifyToken(token) {
  return jwt.verify(token, SECRET, { issuer: ISSUER });
}
```

### GoTrue Response Formatter

`plugin/lambda-templates/auth/gotrue-response.mjs`

Formats responses to match the GoTrue protocol that
supabase-js expects.

```javascript
export function sessionResponse(accessToken, refreshToken, user) {
  return {
    statusCode: 200,
    headers: corsHeaders(),
    body: JSON.stringify({
      access_token: accessToken,
      token_type: 'bearer',
      expires_in: 3600,
      refresh_token: refreshToken,
      user: formatUser(user),
    }),
  };
}

export function userResponse(user) {
  return {
    statusCode: 200,
    headers: corsHeaders(),
    body: JSON.stringify(formatUser(user)),
  };
}

export function logoutResponse() {
  return { statusCode: 204, headers: corsHeaders() };
}

export function errorResponse(statusCode, error, description, extra) {
  return {
    statusCode,
    headers: corsHeaders(),
    body: JSON.stringify({
      error,
      error_description: description,
      ...extra,
    }),
  };
}

function formatUser(user) {
  return {
    id: user.id,
    email: user.email,
    role: 'authenticated',
    aud: 'authenticated',
    app_metadata: user.app_metadata || {
      provider: 'email',
      providers: ['email'],
    },
    user_metadata: user.user_metadata || {},
    created_at: user.created_at || new Date().toISOString(),
  };
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers':
      'Content-Type,Authorization,apikey,Prefer,Accept,x-client-info',
    'Access-Control-Allow-Methods':
      'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'Content-Type': 'application/json',
  };
}
```

### Auth Handler

`plugin/lambda-templates/auth/handler.mjs`

Routes GoTrue endpoints to the appropriate provider method
and JWT operations.

```javascript
export async function handler(event) {
  // OPTIONS → CORS preflight
  // Parse path: /auth/v1/{action}
  // Parse query: grant_type
  // Route:
  //   POST /auth/v1/signup         → handleSignup
  //   POST /auth/v1/token          → handleToken (password or refresh)
  //   GET  /auth/v1/user           → handleGetUser
  //   POST /auth/v1/logout         → handleLogout
  //   *                            → 404
}
```

**handleSignup:**
1. Parse body for `email` and `password`.
2. Validate email format (regex: `/^[^\s@]+@[^\s@]+\.[^\s@]+$/`).
3. Validate password presence.
4. Call `provider.signUp(email, password)`.
5. Call `provider.signIn(email, password)` to get tokens.
6. Sign BOA access token with `{sub: user.id, email}`.
7. Sign BOA refresh token with `(user.id, providerTokens.refreshToken)`.
8. Return `sessionResponse(accessToken, refreshToken, user)`.
9. If signUp fails with a known error, return mapped error.

**handleToken (grant_type=password):**
1. Parse body for `email` and `password`.
2. Validate both present.
3. Call `provider.signIn(email, password)`.
4. Sign BOA tokens.
5. Return session response.

**handleToken (grant_type=refresh_token):**
1. Parse body for `refresh_token`.
2. Verify the BOA refresh JWT to extract `prt` and `sub`.
3. Call `provider.refreshToken(prt)` to get new provider tokens.
4. Sign new BOA access and refresh tokens.
5. Return session response.

**handleGetUser:**
1. Extract `Authorization: Bearer <token>` header.
2. Verify the BOA access JWT.
3. Construct user object from JWT claims.
4. Return `userResponse(user)`.

**handleLogout:**
1. Return `logoutResponse()` (HTTP 204).

### Authorizer

`plugin/lambda-templates/authorizer/index.mjs`

REQUEST-type Lambda authorizer. Receives the full request
event including headers.

```javascript
import jwt from 'jsonwebtoken';

const SECRET = process.env.JWT_SECRET;

export async function handler(event) {
  try {
    const apikey = event.headers?.apikey
      || event.headers?.Apikey || '';
    const authHeader = event.headers?.Authorization
      || event.headers?.authorization || '';

    // 1. Validate apikey
    if (!apikey) return deny(event.methodArn);
    const apikeyPayload = jwt.verify(apikey, SECRET,
      { issuer: 'boa' });
    if (!['anon', 'service_role'].includes(apikeyPayload.role))
      return deny(event.methodArn);

    // 2. Determine effective identity
    let role = apikeyPayload.role;
    let userId = '';
    let email = '';

    if (authHeader.startsWith('Bearer ')) {
      const token = authHeader.slice(7);
      const payload = jwt.verify(token, SECRET,
        { issuer: 'boa' });
      role = payload.role;
      userId = payload.sub || '';
      email = payload.email || '';
    }

    // 3. Return Allow policy with context
    return allow(event.methodArn, { role, userId, email });
  } catch (err) {
    return deny(event.methodArn);
  }
}

function allow(methodArn, context) {
  // Replace specific method/path with wildcard for caching
  const arnBase = methodArn.split('/').slice(0, 2).join('/');
  return {
    principalId: context.userId || 'anon',
    policyDocument: {
      Version: '2012-10-17',
      Statement: [{
        Action: 'execute-api:Invoke',
        Effect: 'Allow',
        Resource: arnBase + '/*',
      }],
    },
    context,
  };
}

function deny(methodArn) {
  return {
    principalId: 'unauthorized',
    policyDocument: {
      Version: '2012-10-17',
      Statement: [{
        Action: 'execute-api:Invoke',
        Effect: 'Deny',
        Resource: '*',
      }],
    },
  };
}
```

**Note on method ARN wildcarding:** The authorizer returns
an Allow policy for `<stage>/*` rather than the specific
method ARN. This is required for API Gateway to cache the
policy across different endpoints. The 300-second cache is
keyed on both the `Authorization` and `apikey` header
values (both are listed in the SAM `Identity.Headers`
configuration). This ensures that requests with different
apikeys (e.g., anon vs. service_role) but no Authorization
Bearer token produce separate cache entries.

### Key Generation Script

`plugin/scripts/generate-keys.mjs`

Pure Node.js, no dependencies. Creates JWTs using manual
HMAC-SHA256 signing.

```javascript
import { createHmac } from 'node:crypto';

const secret = process.argv[2];
if (!secret) {
  console.error('Usage: node generate-keys.mjs <jwt-secret>');
  process.exit(1);
}

function sign(payload, secret) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const fullPayload = { ...payload, iat: now };
  const segments = [
    b64url(JSON.stringify(header)),
    b64url(JSON.stringify(fullPayload)),
  ];
  const sig = createHmac('sha256', secret)
    .update(segments.join('.'))
    .digest('base64url');
  return [...segments, sig].join('.');
}

function b64url(str) {
  return Buffer.from(str).toString('base64url');
}

const TEN_YEARS = 10 * 365 * 24 * 3600;
const now = Math.floor(Date.now() / 1000);

const anonKey = sign(
  { role: 'anon', iss: 'boa', exp: now + TEN_YEARS },
  secret
);
const serviceRoleKey = sign(
  { role: 'service_role', iss: 'boa', exp: now + TEN_YEARS },
  secret
);

console.log(JSON.stringify({ anonKey, serviceRoleKey }));
```

## Code Architecture / File Changes

### New Files

| File | Purpose | ~Lines |
|------|---------|--------|
| `plugin/lambda-templates/auth/handler.mjs` | GoTrue endpoint dispatcher | 100 |
| `plugin/lambda-templates/auth/jwt.mjs` | BOA JWT sign/verify | 80 |
| `plugin/lambda-templates/auth/gotrue-response.mjs` | GoTrue response formatting | 60 |
| `plugin/lambda-templates/auth/providers/interface.mjs` | AuthProvider contract + factory | 30 |
| `plugin/lambda-templates/auth/providers/cognito.mjs` | Cognito SDK wrapper | 200 |
| `plugin/lambda-templates/authorizer/index.mjs` | Custom Lambda authorizer | 120 |
| `plugin/scripts/generate-keys.mjs` | JWT key gen (pure Node.js crypto) | 50 |

### Modified Files

| File | Change |
|------|--------|
| `plugin/lambda-templates/index.mjs` | Add routing: `/auth/v1/*` → auth handler, keep existing routes |
| `plugin/lambda-templates/package.json` | No change — `jsonwebtoken` and `@aws-sdk/client-cognito-identity-provider` already present |
| `plugin/templates/backend.yaml` | Replace CognitoAuthorizer with BoaAuthorizer, add AuthorizerFunction, add auth route, add env vars, update CORS |
| `plugin/scripts/bootstrap.sh` | Add JWT secret generation, SSM storage, key generation, extended config output |

### SAM Template Changes (backend.yaml)

**Replace CognitoAuthorizer** (lines 101–105):
```yaml
# Before:
Auth:
  DefaultAuthorizer: CognitoAuthorizer
  Authorizers:
    CognitoAuthorizer:
      UserPoolArn: !GetAtt UserPool.Arn

# After:
Auth:
  DefaultAuthorizer: BoaAuthorizer
  Authorizers:
    BoaAuthorizer:
      FunctionArn: !GetAtt AuthorizerFunction.Arn
      FunctionPayloadType: REQUEST
      Identity:
        Headers:
          - Authorization
          - apikey
        ReauthorizeEvery: 300
```

**Add AuthorizerFunction resource:**
```yaml
AuthorizerFunction:
  Type: AWS::Serverless::Function
  Properties:
    FunctionName: !Sub '${ProjectName}-authorizer'
    Handler: authorizer/index.handler
    CodeUri: ../lambda-templates/
    MemorySize: 128
    Environment:
      Variables:
        JWT_SECRET: !Sub '{{resolve:ssm:/${ProjectName}/jwt-secret}}'
```

Note: No IAM policies are needed beyond the auto-generated
basic execution role. The authorizer only verifies JWTs
locally using `JWT_SECRET` — it makes no AWS SDK calls. The
128 MB memory keeps cold starts fast.

**Add AuthorizerFunctionPermission:**
```yaml
AuthorizerFunctionPermission:
  Type: AWS::Lambda::Permission
  Properties:
    FunctionName: !GetAtt AuthorizerFunction.Arn
    Action: lambda:InvokeFunction
    Principal: apigateway.amazonaws.com
    SourceArn: !Sub 'arn:aws:execute-api:${AWS::Region}:${AWS::AccountId}:${Api}/*'
```

**Add auth route to ApiFunction events** (no authorizer):
```yaml
AuthProxy:
  Type: Api
  Properties:
    RestApiId: !Ref Api
    Path: /auth/v1/{proxy+}
    Method: ANY
    Auth:
      Authorizer: NONE
```

**Add env vars to ApiFunction:**
```yaml
Environment:
  Variables:
    DSQL_ENDPOINT: !GetAtt DsqlCluster.Endpoint
    REGION_NAME: !Ref 'AWS::Region'
    BUCKET_NAME: !Ref StorageBucket
    USER_POOL_ID: !Ref UserPool
    USER_POOL_CLIENT_ID: !Ref UserPoolClient
    JWT_SECRET: !Sub '{{resolve:ssm:/${ProjectName}/jwt-secret}}'
    AUTH_PROVIDER: cognito
```

**Update CORS:**
```yaml
Cors:
  AllowMethods: "'GET,POST,PUT,PATCH,DELETE,OPTIONS'"
  AllowHeaders: "'Content-Type,Authorization,apikey,Prefer,Accept,x-client-info'"
  AllowOrigin: "'*'"
  MaxAge: "'600'"
```

**Note:** API Gateway does not natively support
`ExposeHeaders` in the SAM `Cors` property. The
`Content-Range` expose header must be set by the Lambda
function in its response headers. The PostgREST handler
already does this (see the PostgREST design doc,
`response.mjs`).

### index.mjs Routing Change

```javascript
// Before:
export { handler } from "./crud-api.mjs";

// After:
import { handler as authHandler } from "./auth/handler.mjs";
import { handler as apiHandler } from "./crud-api.mjs";

export async function handler(event) {
  const path = event.path || '';
  if (path.startsWith('/auth/v1/')) {
    return authHandler(event);
  }
  return apiHandler(event);
}
```

When the PostgREST layer is also implemented, the default
branch would route to `postgrest/handler.mjs` instead of
`crud-api.mjs`.

## Testing Strategy

### Unit Tests

**auth/jwt.mjs tests:**
- `signAccessToken` produces JWT with correct claims (sub,
  email, role, aud, iss, exp).
- `signRefreshToken` embeds provider refresh token in `prt`.
- `verifyToken` returns decoded payload for valid token.
- `verifyToken` throws for expired token.
- `verifyToken` throws for wrong secret.
- `verifyToken` throws for wrong issuer.
- `verifyToken` throws for malformed token.

**auth/gotrue-response.mjs tests:**
- `sessionResponse` returns 200 with access_token,
  refresh_token, and user object.
- `userResponse` returns 200 with user object.
- `logoutResponse` returns 204 with no body.
- `errorResponse` returns specified status code with error
  and error_description.
- `errorResponse` with extra `weak_password` field includes
  it in the response body.
- All responses include CORS headers.
- `formatUser` includes id, email, role, aud, app_metadata,
  user_metadata, created_at.

**auth/providers/cognito.mjs tests (mocked SDK):**
- `signUp` calls `SignUpCommand` with correct params.
- `signUp` maps `UsernameExistsException` to
  `user_already_exists`.
- `signUp` maps `InvalidPasswordException` to
  `weak_password`.
- `signIn` calls `InitiateAuthCommand` with
  `USER_PASSWORD_AUTH`.
- `signIn` maps `NotAuthorizedException` to
  `invalid_grant`.
- `signIn` maps `UserNotFoundException` to `invalid_grant`.
- `signIn` returns user and providerTokens.
- `refreshToken` calls `InitiateAuthCommand` with
  `REFRESH_TOKEN_AUTH`.
- `refreshToken` maps expired token error to
  `invalid_grant`.
- `getUser` calls `GetUserCommand` and returns user.
- `signOut` returns void without calling Cognito.

**auth/handler.mjs tests (mocked provider + jwt):**
- POST /auth/v1/signup with valid body returns session.
- POST /auth/v1/signup with missing email returns 400.
- POST /auth/v1/signup with missing password returns 400.
- POST /auth/v1/signup with invalid email format returns 400.
- POST /auth/v1/signup with duplicate email returns 400.
- POST /auth/v1/token?grant_type=password returns session.
- POST /auth/v1/token?grant_type=password with bad creds
  returns 400.
- POST /auth/v1/token?grant_type=refresh_token returns
  new session.
- POST /auth/v1/token?grant_type=refresh_token with
  invalid token returns 401.
- POST /auth/v1/token without grant_type returns 400.
- POST /auth/v1/token with unknown grant_type returns 400.
- GET /auth/v1/user with valid Bearer returns user.
- GET /auth/v1/user without Authorization returns 401.
- GET /auth/v1/user with expired token returns 401.
- POST /auth/v1/logout returns 204.
- OPTIONS returns CORS headers with 200.
- Unknown path returns 404.

  > Warning: Handler tests that mock the provider should
  > verify that the mock is exercised (e.g., check call
  > count), not just that the response shape is correct.
  > A response with the right shape could be produced by a
  > hardcoded fallback rather than the actual provider path.

**authorizer/index.mjs tests:**
- Valid apikey only (no Authorization) → Allow with
  role=anon.
- Anon apikey + anon key as Bearer (supabase-js default)
  → Allow with role=anon.
- Anon apikey + authenticated user Bearer → Allow with
  role=authenticated, userId and email set.
- Valid service_role apikey only → Allow with
  role=service_role.
- Service role key in both apikey and Authorization →
  Allow with role=service_role.
- Missing apikey → Deny.
- Invalid apikey JWT → Deny.
- Valid apikey + expired Bearer → Deny.
- Valid apikey + malformed Bearer → Deny.
- Apikey with role=authenticated (forged) → Deny.
- Policy ARN is wildcarded for caching.
- Context includes role, userId, email.

  > Warning: The SAM Identity.Headers includes both
  > `Authorization` and `apikey` to ensure the API Gateway
  > cache key differentiates requests with different apikeys.
  > Unit tests cannot verify cache behavior directly — this
  > must be verified via integration testing or manual
  > inspection of the SAM template output.

  > Warning: Tests for "valid apikey + valid Bearer" should
  > verify that the bearer token's claims override the
  > apikey's claims, not just that the result is Allow. A
  > test that only checks Allow could pass if the authorizer
  > ignores the Bearer entirely.

**scripts/generate-keys.mjs tests:**
- Outputs valid JSON with anonKey and serviceRoleKey.
- anonKey decodes to `{role:"anon", iss:"boa"}`.
- serviceRoleKey decodes to `{role:"service_role", iss:"boa"}`.
- Both keys have ~10-year expiry.
- Keys are verifiable with the input secret.
- Exits with error if no secret argument provided.

### Integration Tests

End-to-end tests that exercise the full handler with real
JWT signing but mocked Cognito provider:

- Full signup flow: POST /auth/v1/signup → receive tokens
  → GET /auth/v1/user with token → receive user.
- Full signin flow: POST /auth/v1/token?grant_type=password
  → receive tokens → use access_token for data request.
- Token refresh flow: sign in → use refresh_token to get
  new tokens → new tokens work.
- Anon access flow: data request with apikey only →
  authorizer returns role=anon.
- Authenticated access flow: data request with apikey +
  Bearer → authorizer returns role=authenticated with
  userId.
- Service role access flow: data request with service_role
  apikey → authorizer returns role=service_role.
- Expired token flow: use an expired access_token →
  authorizer denies → refresh → new token works.

  > Warning: Integration tests that verify "authorizer
  > returns role=authenticated" should check the
  > authorizer context values (role, userId, email), not
  > just that the request succeeds. A passing request
  > could indicate service_role access if the authorizer
  > has a fallback path.

## Implementation Order

### Phase 1: Key Generation and JWT Module

1. Create `plugin/scripts/generate-keys.mjs` — pure
   Node.js JWT generation. No dependencies, testable
   standalone.
2. Create `plugin/lambda-templates/auth/jwt.mjs` — BOA JWT
   sign/verify using jsonwebtoken. Testable standalone.
3. Verify `jsonwebtoken` and
   `@aws-sdk/client-cognito-identity-provider` are in
   `plugin/lambda-templates/package.json` (already present).

### Phase 2: Auth Provider

4. Create
   `plugin/lambda-templates/auth/providers/interface.mjs` —
   type definitions and provider factory.
5. Create
   `plugin/lambda-templates/auth/providers/cognito.mjs` —
   Cognito SDK wrapper with error mapping.

### Phase 3: GoTrue Response Layer

6. Create
   `plugin/lambda-templates/auth/gotrue-response.mjs` —
   response formatting for all endpoint types.

### Phase 4: Auth Handler

7. Create `plugin/lambda-templates/auth/handler.mjs` —
   route GoTrue endpoints to provider and JWT operations.
8. Modify `plugin/lambda-templates/index.mjs` — add path
   routing for `/auth/v1/*`.

### Phase 5: Custom Authorizer

9. Create `plugin/lambda-templates/authorizer/index.mjs` —
    REQUEST-type Lambda authorizer.

### Phase 6: SAM Template and Bootstrap

10. Modify `plugin/templates/backend.yaml` — replace
    authorizer, add resources, add env vars, update CORS.
11. Modify `plugin/scripts/bootstrap.sh` — add JWT secret
    generation, SSM storage, key gen, extended config.

### Phase 7: Documentation

12. Update plugin docs to document the auth system, JWT
    structure, and authorizer contract.

## Open Questions

1. **Token revocation.** The MVP has no server-side token
   revocation. Access tokens expire in 1 hour, and there
   is no blocklist. If a user's account is compromised,
   their tokens remain valid until expiry. A future design
   could add a token blocklist in DynamoDB or DSQL, checked
   by the authorizer. This is a known trade-off for
   simplicity.

2. **Password reset flow.** GoTrue supports
   `POST /auth/v1/recover` for password reset emails.
   Cognito has `ForgotPassword` and `ConfirmForgotPassword`
   commands. This is not included in the MVP but is a
   natural extension. supabase-js `auth.resetPasswordForEmail()`
   would need this endpoint.

3. **OAuth/social login.** GoTrue supports
   `GET /auth/v1/authorize?provider=google` for OAuth
   flows. Cognito supports hosted UI with social identity
   providers. This is significantly more complex and
   deferred to a future design.

4. **Email confirmation flow.** The pre-signup Lambda
   auto-confirms all users. In production, some apps want
   email verification before account activation. This would
   require removing the auto-confirm trigger and adding
   `POST /auth/v1/verify` and `POST /auth/v1/resend`
   endpoints.

5. **Authorizer cold start impact.** The REQUEST-type
   Lambda authorizer adds latency on cold starts. The
   300-second cache mitigates this for subsequent requests.
   If cold start latency is a problem, the authorizer
   Lambda should have minimal dependencies (just
   `jsonwebtoken`) and low memory allocation to minimize
   init time.

6. **SSM dynamic reference vs. environment variable.** The
   design uses `{{resolve:ssm:...}}` in the SAM template to
   inject `JWT_SECRET` into Lambda environment variables.
   This resolves at deploy time, so changing the secret
   requires redeployment. An alternative is reading from SSM
   at runtime using the SDK, which allows rotation without
   redeployment but adds latency. The deploy-time approach
   is chosen for simplicity and performance. **Ordering
   constraint:** The SSM parameter must exist before
   `sam deploy` runs, or CloudFormation will fail to resolve
   it. The bootstrap script creates the SSM parameter first.

7. **Cognito SDK in Lambda runtime.** The Node.js 20.x
   Lambda runtime includes a subset of AWS SDK v3 clients,
   but `@aws-sdk/client-cognito-identity-provider` is not
   guaranteed to be among them. The design adds it as an
   explicit dependency in `package.json` to avoid runtime
   import failures. This adds ~2 MB to the deployment
   package but ensures reliability.
