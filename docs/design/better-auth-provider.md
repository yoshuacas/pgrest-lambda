# Replace GoTrue with better-auth Provider

## Overview

Replace the hand-rolled GoTrue-native auth provider with a
better-auth-backed provider. Cognito remains the default
AWS-managed path (`AUTH_PROVIDER=cognito`); better-auth
becomes the only self-hosted option
(`AUTH_PROVIDER=better-auth`). The GoTrue provider, its
database schema (`auth.*`), its session-table machinery, and
the `bcryptjs` dependency are deleted entirely.

Scope v1 covers email+password sign-up/sign-in/refresh/
sign-out/get-user, magic-link (email OTP via SES),
Google OAuth social login, asymmetric JWT signing via
better-auth's JWT plugin (EdDSA by default) with a JWKS
endpoint, and dual-algorithm verification in the Lambda
authorizer.

Wire compatibility with `@supabase/supabase-js` is
preserved: `/auth/v1/*` returns GoTrue-shaped envelopes.
The signing algorithm change is invisible to supabase-js
because it treats `access_token` as an opaque string.

## Current CX / Concepts

### Two auth providers today

pgrest-lambda ships two providers behind the
`AUTH_PROVIDER` env var:

- **Cognito** (default): AWS-managed user pool. The
  handler mints HS256 access tokens via `jwt.mjs`;
  Cognito manages refresh tokens natively.
  `needsSessionTable: false`.
- **GoTrue**: Hand-rolled PostgreSQL-backed provider in
  `src/auth/providers/gotrue.mjs`. Stores users in
  `auth.users`, refresh tokens in `auth.refresh_tokens`,
  sessions in `auth.sessions`. Uses `bcryptjs` for
  password hashing. `needsSessionTable: true`.

### Auth handler token flow

The handler (`src/auth/handler.mjs`) always mints HS256
access tokens via `ctx.jwt.signAccessToken()`. For
providers with `needsSessionTable: true`, it creates
`auth.sessions` rows, mints refresh JWTs with an opaque
`sid` claim, and resolves sessions on refresh. For
providers with `needsSessionTable: false` (Cognito), it
passes the provider's refresh token through directly.

### Provider interface contract

`src/auth/providers/interface.mjs` defines `AuthProvider`:
`signUp`, `signIn`, `refreshToken`, `getUser`, `signOut`,
and the optional `needsSessionTable` flag. The factory
function `createProvider` dispatches on `config.provider`.

### Existing endpoints

```
POST /auth/v1/signup
POST /auth/v1/token?grant_type=password
POST /auth/v1/token?grant_type=refresh_token
GET  /auth/v1/user
POST /auth/v1/logout
```

All return GoTrue-shaped JSON envelopes via
`src/auth/gotrue-response.mjs`.

### Authorizer

`src/authorizer/index.mjs` verifies both the `apikey`
header and the optional `Authorization: Bearer` token
using HS256 with `JWT_SECRET`. It passes `{role, userId,
email}` downstream via API Gateway context.

## Proposed CX / CX Specification

### Provider selection

```
AUTH_PROVIDER=better-auth   # self-hosted
AUTH_PROVIDER=cognito       # AWS-managed (default)
```

`AUTH_PROVIDER=gotrue` is removed. Deployments currently
on GoTrue must migrate to `better-auth`.

### Existing endpoints (unchanged wire format)

All existing endpoints continue to work identically.
The response envelope is the same GoTrue shape:

```json
{
  "access_token": "eyJ...",
  "token_type": "bearer",
  "expires_in": 3600,
  "expires_at": 1714000000,
  "refresh_token": "...",
  "user": {
    "id": "uuid",
    "email": "user@example.com",
    "role": "authenticated",
    "aud": "authenticated",
    "app_metadata": {"provider":"email","providers":["email"]},
    "user_metadata": {},
    "created_at": "2026-04-24T00:00:00.000Z"
  }
}
```

The `access_token` is now an asymmetrically signed JWT
(EdDSA by default) when `AUTH_PROVIDER=better-auth`.
supabase-js does not inspect the token — it passes it
through as an opaque Bearer string. No client change.

The `refresh_token` is better-auth's opaque session token.
supabase-js passes it back on refresh; the handler
forwards it to better-auth for validation.

### New endpoint: POST /auth/v1/otp

Sends a magic-link email to the user via SES.

**Request:**

```json
{
  "email": "user@example.com"
}
```

**Success response (200):**

```json
{}
```

**Validation errors:**

| Condition | Status | Error |
|-----------|--------|-------|
| Missing email | 400 | `{"error":"validation_failed","error_description":"Email is required"}` |
| Invalid email format | 400 | `{"error":"validation_failed","error_description":"Invalid email format"}` |
| SES delivery failure | 500 | `{"error":"unexpected_failure","error_description":"An unexpected error occurred"}` |

### New endpoint: POST /auth/v1/verify

Verifies a magic-link token and returns a session.

**Request:**

```json
{
  "email": "user@example.com",
  "token": "abc123"
}
```

**Success response (200):** Standard GoTrue session
envelope (same as signup/signin).

**Validation errors:**

| Condition | Status | Error |
|-----------|--------|-------|
| Missing email | 400 | `{"error":"validation_failed","error_description":"Email is required"}` |
| Missing token | 400 | `{"error":"validation_failed","error_description":"Token is required"}` |
| Invalid/expired token | 400 | `{"error":"invalid_grant","error_description":"Invalid or expired OTP token"}` |
| Invalid email format | 400 | `{"error":"validation_failed","error_description":"Invalid email format"}` |

### New endpoint: GET /auth/v1/authorize

Initiates an OAuth flow. Returns a 302 redirect to the
social provider's consent screen.

**Query parameters:**

| Param | Required | Description |
|-------|----------|-------------|
| `provider` | yes | Social provider ID (e.g., `google`) |
| `redirect_to` | yes | URL to redirect after OAuth completes |

**Success:** 302 redirect to the provider's authorization
URL with `state` containing the `redirect_to` value.

**Validation errors:**

| Condition | Status | Error |
|-----------|--------|-------|
| Missing provider | 400 | `{"error":"validation_failed","error_description":"Provider is required"}` |
| Unsupported provider | 400 | `{"error":"validation_failed","error_description":"Unsupported OAuth provider: <name>"}` |
| Missing redirect_to | 400 | `{"error":"validation_failed","error_description":"redirect_to is required"}` |
| Google OAuth not configured | 400 | `{"error":"validation_failed","error_description":"Google OAuth is not configured"}` |

### New endpoint: GET /auth/v1/callback

OAuth callback handler. Finalizes the social login flow
and redirects the user to the original `redirect_to` URL
with the session in the URL fragment (matching supabase-js
`detectSessionInUrl` behavior).

**Success:** 302 redirect to:
```
{redirect_to}#access_token=eyJ...&token_type=bearer&expires_in=3600&refresh_token=...
```

**Error:** 302 redirect to:
```
{redirect_to}#error=server_error&error_description=...
```

### New endpoint: GET /auth/v1/jwks

Returns the JSON Web Key Set for verifying asymmetric
access tokens issued by the better-auth provider.

**Response (200):**

```json
{
  "keys": [
    {
      "kty": "OKP",
      "crv": "Ed25519",
      "x": "...",
      "kid": "..."
    }
  ]
}
```

Only available when `AUTH_PROVIDER=better-auth`. Returns
404 when Cognito is active (Cognito tokens are HS256,
verified with `JWT_SECRET`).

### Environment variables (better-auth path)

| Variable | Required | Description |
|----------|----------|-------------|
| `AUTH_PROVIDER` | yes | Must be `better-auth` |
| `BETTER_AUTH_SECRET` | yes | Signing secret for better-auth (min 32 chars). Generate with `openssl rand -base64 32`. |
| `BETTER_AUTH_URL` | yes | Public API Gateway stage URL (e.g., `https://xxx.execute-api.us-east-1.amazonaws.com/v1`) |
| `JWT_SECRET` | yes | Still required for apikey verification in the authorizer (anon/service_role keys remain HS256) |
| `DATABASE_URL` or `PG_*` | yes | PostgreSQL connection for better-auth tables |
| `GOOGLE_CLIENT_ID` | no | Google OAuth client ID (enables OAuth) |
| `GOOGLE_CLIENT_SECRET` | no | Google OAuth client secret |
| `SES_FROM_ADDRESS` | no | Verified SES sender for magic-link emails |
| `REGION_NAME` | yes | AWS region (not `AWS_REGION` per CLAUDE.md rule #4) |

### Error codes

All existing error codes are preserved. The better-auth
provider maps better-auth errors to the same standardized
set used today:

| Provider error | Mapped code | HTTP |
|----------------|-------------|------|
| User already exists | `user_already_exists` | 400 |
| Invalid credentials | `invalid_grant` | 400 |
| Weak password | `weak_password` | 422 |
| Session expired/invalid | `invalid_grant` | 401 |
| General failure | `unexpected_failure` | 500 |

## Technical Design

### 1. New provider: `src/auth/providers/better-auth.mjs`

Creates a better-auth instance at module scope (once per
Lambda cold start) and exposes it through the
`AuthProvider` interface.

**better-auth configuration:**

```js
import { betterAuth } from 'better-auth';
import { jwt } from 'better-auth/plugins';
import { magicLink } from 'better-auth/plugins';

const auth = betterAuth({
  baseURL: process.env.BETTER_AUTH_URL,
  basePath: '/auth/v1/ba',
  secret: process.env.BETTER_AUTH_SECRET,
  database: pool,  // pg.Pool from ctx.db.getPool()
  emailAndPassword: { enabled: true, autoSignIn: true },
  socialProviders: googleConfigured ? {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    },
  } : undefined,
  session: { expiresIn: 60 * 60 * 24 * 30 },
  plugins: [
    jwt({
      jwks: {
        keyPairConfig: { alg: 'EdDSA', crv: 'Ed25519' },
      },
      jwt: {
        issuer: 'pgrest-lambda',
        audience: 'authenticated',
        expirationTime: '1h',
        definePayload: ({ user }) => ({
          sub: user.id,
          email: user.email,
          role: 'authenticated',
          aud: 'authenticated',
        }),
      },
    }),
    magicLink({
      sendMagicLink: async ({ email, url, token }) => {
        // SES email delivery (see §3 below)
      },
    }),
  ],
});
```

**Database schema isolation:** The better-auth provider
creates a **separate** `pg.Pool` dedicated to better-auth,
distinct from the REST engine's pool (`ctx.db.getPool()`).
The separate pool appends `options=-c search_path=
better_auth` to the connection string (or passes it via
Pool `options`). This pins all better-auth tables (`user`,
`session`, `account`, `verification`, `jwks`) to the
`better_auth` schema, invisible to REST introspection
which targets `public` only (CLAUDE.md rule #9). The REST
pool's default `search_path=public` is unaffected.

The `better_auth` schema and grants must be created before
first use via bootstrap DDL or `npx auth@latest migrate`.
The provider builds the connection config from the same
env vars the REST engine uses (`DATABASE_URL` or `PG_*`
or `DSQL_ENDPOINT`), but with the search_path override.
For DSQL, the IAM token callback is replicated on the
separate pool.

**basePath:** Set to `/auth/v1/ba` to namespace
better-auth's internal routes under a sub-path that does
not collide with our handler's `/auth/v1/*` routes. The
handler proxies specific operations to better-auth's
`auth.handler` when needed (OAuth callback, JWKS).

**Provider contract — `issuesOwnAccessToken: true`:**
Because better-auth signs asymmetric JWTs via its JWT
plugin, this provider returns fully-baked tokens. The
handler does not call `jwt.signAccessToken` for the
better-auth path.

**Interface methods:**

- `signUp(email, password)`: Calls
  `auth.api.signUpEmail({ body: { email, password, name:
  email.split('@')[0] } })`. The `name` field is required
  by better-auth's signUpEmail; we derive it from the
  email prefix since the GoTrue signup body does not
  include `name`. When `autoSignIn: true` is configured,
  the signUpEmail response includes session cookies. We
  then call `auth.api.getSession({ headers })` with those
  cookies, followed by `authClient.token()` (or the
  server equivalent) to obtain the JWT access token.
  Returns `{ user, accessToken, refreshToken, expiresIn }`.
  The `refreshToken` is the opaque session token extracted
  from the `set-cookie` header
  (`better-auth.session_token=...`).
- `signIn(email, password)`: Calls
  `auth.api.signInEmail({ body: { email, password },
  returnHeaders: true })`. Extracts the session token from
  `set-cookie` headers and the JWT from the `set-auth-jwt`
  response header (when the JWT plugin is active, the JWT
  is attached to session-returning responses). Returns
  `{ user, accessToken, refreshToken, expiresIn }`.
- `refreshToken(sessionToken)`: better-auth's session
  token IS the refresh token. Calls
  `auth.api.getSession({ headers: { cookie:
  'better-auth.session_token=' + sessionToken } })` to
  validate the session and refresh it if needed. Then
  extracts the JWT from the response's `set-auth-jwt`
  header. Returns `{ user, accessToken, refreshToken,
  expiresIn }`. The `refreshToken` may be the same
  session token or a rotated one from `set-cookie`.
- `getUser(accessToken)`: Verifies the JWT against the
  local JWKS using `jose.jwtVerify` and extracts user
  claims. Alternatively calls `auth.api.getSession(...)`
  with a Bearer header for a full user object.
- `signOut(sessionToken)`: Calls
  `auth.api.signOut({ headers: { cookie:
  'better-auth.session_token=' + sessionToken } })`.
- `sendOtp(email)`: Calls
  `auth.api.signInMagicLink({ body: { email } })`.
  Returns `{}`.
- `verifyOtp(email, token)`: Calls
  `auth.api.magicLinkVerify({ query: { token } })`.
  Returns `{ user, accessToken, refreshToken, expiresIn }`.
- `getOAuthRedirectUrl(provider, redirectTo)`: Builds a
  fetch `Request` to better-auth's social sign-in
  endpoint, captures the 302 redirect URL. Returns
  `{ url }`.
- `handleOAuthCallback(request)`: Forwards the callback
  request to `auth.handler(request)`, extracts the
  resulting session, mints tokens. Returns `{ user,
  accessToken, refreshToken, expiresIn }`.
- `getJwks()`: Reads from better-auth's JWKS endpoint or
  directly from `auth.api.jwks()`. Returns the JWKS
  object.

**Error mapping:** Catches better-auth errors and throws
objects with `{ code }` matching the handler's existing
`ERROR_STATUS` / `ERROR_DESCRIPTION` maps. Known
mappings:

| better-auth condition | Thrown code |
|----------------------|-------------|
| `USER_ALREADY_EXISTS` / duplicate email | `user_already_exists` |
| Invalid email/password on sign-in | `invalid_grant` |
| Password too short / weak | `weak_password` |
| Session not found / expired | `invalid_grant` |
| Any unhandled error | `unexpected_failure` |

### 2. Provider contract extension

Add to the `AuthProvider` typedef in
`src/auth/providers/interface.mjs`:

```js
/**
 * @property {boolean} [issuesOwnAccessToken] - If true,
 *   signUp/signIn/refreshToken return { user,
 *   accessToken, refreshToken, expiresIn } and the
 *   handler uses them directly instead of calling
 *   jwt.signAccessToken. Required for providers that
 *   sign asymmetric JWTs.
 */
```

And optional methods for new flows:

```js
/**
 * @property {(email: string) => Promise<void>} [sendOtp]
 * @property {(email: string, token: string) => Promise<Object>} [verifyOtp]
 * @property {(provider: string, redirectTo: string) => Promise<{url: string}>} [getOAuthRedirectUrl]
 * @property {(request: Request) => Promise<Object>} [handleOAuthCallback]
 * @property {() => Promise<Object>} [getJwks]
 */
```

Factory update: replace `case 'gotrue'` with
`case 'better-auth'`, lazy-importing
`./better-auth.mjs`.

### 3. SES email delivery for magic links

The `sendMagicLink` callback in the better-auth magic-link
plugin uses `@aws-sdk/client-sesv2` to send emails:

```js
import { SESv2Client, SendEmailCommand } from
  '@aws-sdk/client-sesv2';

const ses = new SESv2Client({
  region: process.env.REGION_NAME
});

async function sendMagicLink({ email, url, token }) {
  await ses.send(new SendEmailCommand({
    FromEmailAddress: process.env.SES_FROM_ADDRESS,
    Destination: { ToAddresses: [email] },
    Content: {
      Simple: {
        Subject: { Data: 'Your sign-in link' },
        Body: {
          Html: {
            Data: `<p>Click <a href="${url}">here</a>
                   to sign in.</p>`,
          },
        },
      },
    },
  }));
}
```

`REGION_NAME` is used per CLAUDE.md rule #4.

### 4. Handler changes: `src/auth/handler.mjs`

**`issuesOwnAccessToken` branch:** In `handleSignup`,
`handlePasswordGrant`, and `handleRefreshGrant`, when
`prov.issuesOwnAccessToken === true`, use the provider's
returned `accessToken`, `refreshToken`, and `expiresIn`
directly:

```js
if (prov.issuesOwnAccessToken) {
  const result = await prov.signUp(email, password);
  return sessionResponse(
    result.accessToken,
    result.refreshToken,
    result.user,
    corsHeaders,
  );
}
```

Note: the current handler calls `prov.signUp()` then
`prov.signIn()` separately for the GoTrue path (because
GoTrue's signUp does not return tokens). For providers
with `issuesOwnAccessToken`, the `signUp` method handles
auto-sign-in internally (better-auth's `autoSignIn: true`)
and returns tokens directly, so the separate `signIn`
call is skipped.

**New route handlers:**

Add to the switch statement in `handler()`. The existing
path regex `/^\/auth\/v1\/(\w+)$/` already matches these
route names since they are all alphanumeric:

```js
case 'otp':
  return handleOtp(event, corsHeaders);
case 'verify':
  return handleVerify(event, corsHeaders);
case 'authorize':
  return handleAuthorize(event, corsHeaders);
case 'callback':
  return handleCallback(event, corsHeaders);
case 'jwks':
  return handleJwks(event, corsHeaders);
```

The `authorize`, `callback`, and `jwks` routes accept
GET requests. The existing handler dispatches on `action`
without checking `method` (except for OPTIONS). New
handlers must validate the HTTP method internally and
return 404 for unexpected methods.

**`handleOtp`:** Validates email, calls
`prov.sendOtp(email)`. Returns `{ statusCode: 200, body:
'{}' }`. Returns 404 if provider has no `sendOtp` method
(Cognito does not implement magic link). Also returns 400
if `SES_FROM_ADDRESS` is not configured (magic link
requires SES).

**`handleVerify`:** Validates email + token, calls
`prov.verifyOtp(email, token)`. Returns standard session
response. Returns 400 on invalid token.

**`handleAuthorize`:** Validates `provider` and
`redirect_to` query params. Calls
`prov.getOAuthRedirectUrl(provider, redirectTo)`. Returns
302 with `Location` header.

**`handleCallback`:** Calls
`prov.handleOAuthCallback(event)`. On success, redirects
to `redirect_to` with tokens in the URL fragment. On
error, redirects with error in the fragment.

**`handleJwks`:** Calls `prov.getJwks()`. Returns the
JWKS JSON. Returns 404 if provider has no `getJwks`
method.

**Remove session-table code:** Delete the import of
`createSession`, `resolveSession`, `updateSessionPrt`,
`revokeUserSessions` from `./sessions.mjs`. Remove all
`needsSessionTable` branches and the `needsSessionTable`
concept entirely. The handler now has two paths,
dispatched by `prov.issuesOwnAccessToken`:

**When `issuesOwnAccessToken === true`** (better-auth):
The provider returns `{ user, accessToken, refreshToken,
expiresIn }` fully baked. The handler wraps them in a
GoTrue envelope via `sessionResponse(...)` and returns.
No HS256 minting, no session table.

**When `issuesOwnAccessToken` is false/absent** (Cognito):
The handler calls the provider methods as before — for
signup: `prov.signUp(email, password)` then
`prov.signIn(email, password)` to get `providerTokens`.
The handler mints an HS256 access token via
`jwt.signAccessToken(...)`, passes the provider's refresh
token through as `refresh_token`, and returns the GoTrue
envelope. This is the existing Cognito path with the
session-table branches stripped.

Specifically remove:
- All `if (prov.needsSessionTable)` branches
- The `createSession` / `resolveSession` /
  `updateSessionPrt` / `revokeUserSessions` calls
- The refresh-grant path that verifies a pgrest-lambda-
  minted refresh JWT with `sid` claim
- The import of `./sessions.mjs`

The Cognito refresh path simplifies to: receive opaque
Cognito refresh token from client body, call
`prov.refreshToken(token)`, mint HS256 access token,
return GoTrue envelope.

**Updated handleGetUser:** When
`prov.issuesOwnAccessToken`, the access token is
asymmetric. The handler must verify it using the
provider's JWKS instead of `jwt.verifyToken` (which uses
HS256). Add a branch: if `jwt.verifyToken` throws and
the provider has `getJwks`, try asymmetric verification
using `jose.jwtVerify` with the JWKS. Extract claims
and return user response.

**Updated handleLogout:** The current handler verifies
the Bearer token via HS256, extracts `claims.sub`, and
calls `prov.signOut(claims.sub)`. For better-auth, the
`signOut` interface changes:

- When `prov.issuesOwnAccessToken`: verify the Bearer
  token using asymmetric verification (try HS256 first,
  fall back to JWKS). Then check for a `refresh_token`
  in the request body — this is the better-auth session
  token needed to revoke the session. Call
  `prov.signOut(refreshToken)`.
- When `!prov.issuesOwnAccessToken` (Cognito): existing
  behavior unchanged — `prov.signOut(claims.sub)`.

The `signOut` method signature varies by provider:
Cognito accepts a user ID, better-auth accepts a session
token. This is already provider-internal behavior (the
interface typedef says `identifier: string`).

### 5. JWT module changes: `src/auth/jwt.mjs`

Add asymmetric verification support:

```js
import { createRemoteJWKSet, jwtVerify } from 'jose';

let cachedJwks = null;

export function createAsymmetricVerifier(jwksUrl) {
  if (!cachedJwks) {
    cachedJwks = createRemoteJWKSet(new URL(jwksUrl));
  }
  return cachedJwks;
}

export async function verifyAsymmetricToken(
  token, jwksUrl
) {
  const jwks = createAsymmetricVerifier(jwksUrl);
  const { payload } = await jwtVerify(token, jwks, {
    issuer: 'pgrest-lambda',
  });
  return payload;
}
```

`jose` arrives as a transitive dependency of
`better-auth`. No new direct dependency needed.

The existing `signAccessToken`, `signRefreshToken`, and
`verifyToken` functions are unchanged — they continue to
serve the Cognito path and apikey verification.

### 6. Authorizer changes: `src/authorizer/index.mjs`

The authorizer must verify both HS256 (Cognito, apikeys)
and asymmetric (better-auth) access tokens. Strategy:
read the token's `alg` header to dispatch.

```js
import { createRemoteJWKSet, jwtVerify, decodeJwt,
  decodeProtectedHeader } from 'jose';

const JWKS_URL = process.env.JWKS_URL;
let remoteJwks = null;

function getRemoteJwks() {
  if (!remoteJwks && JWKS_URL) {
    remoteJwks = createRemoteJWKSet(new URL(JWKS_URL));
  }
  return remoteJwks;
}

async function verifyBearerToken(token, secret) {
  const header = decodeProtectedHeader(token);
  if (header.alg === 'HS256') {
    return jwt.verify(token, secret,
      { algorithms: ['HS256'], issuer: ISSUER });
  }
  const jwks = getRemoteJwks();
  if (!jwks) throw 'Unauthorized';
  const { payload } = await jwtVerify(token, jwks,
    { issuer: ISSUER });
  return payload;
}
```

**Apikey verification stays HS256.** Apikeys are
pgrest-lambda-issued with `JWT_SECRET`; they always use
HS256. Only the Bearer token (user access token) may be
asymmetric.

**JWKS caching:** `jose.createRemoteJWKSet` caches keys
internally with automatic refresh on `kid` miss. The
`remoteJwks` object is created once per Lambda cold start
in module scope.

**New env var:** `JWKS_URL` — defaults to
`${BETTER_AUTH_URL}/auth/v1/jwks`. Only set when
`AUTH_PROVIDER=better-auth`. When absent (Cognito path),
the authorizer skips asymmetric verification entirely.

### 7. Files to delete

| File | Reason |
|------|--------|
| `src/auth/providers/gotrue.mjs` | Replaced by better-auth |
| `src/auth/schema.mjs` | GoTrue schema DDL; better-auth manages its own |
| `src/auth/sessions.mjs` | No remaining provider uses session-table storage |

### 8. Dependency changes in `package.json`

| Action | Package | Reason |
|--------|---------|--------|
| Add | `better-auth` | Core auth framework |
| Add | `@aws-sdk/client-sesv2` | SES for magic-link email |
| Remove | `bcryptjs` | Only used by GoTrue; better-auth handles hashing internally |
| Keep | `jsonwebtoken` | Cognito path + apikey signing (HS256) |
| Keep | `pg` | Database connectivity |

`jose` is a transitive dependency of `better-auth` — no
explicit install needed.

### 9. SAM template changes

In `docs/deploy/aws-sam/template.yaml`:

**Parameters:**

```yaml
AuthProvider:
  Type: String
  Default: cognito
  AllowedValues: [better-auth, cognito]
BetterAuthSecret:
  Type: String
  Default: ''
  NoEcho: true
BetterAuthUrl:
  Type: String
  Default: ''
GoogleClientId:
  Type: String
  Default: ''
GoogleClientSecret:
  Type: String
  Default: ''
  NoEcho: true
SesFromAddress:
  Type: String
  Default: ''
```

**Conditions:**

```yaml
IsBetterAuth: !Equals [!Ref AuthProvider, better-auth]
```

**Lambda environment variables (conditional):**

```yaml
BETTER_AUTH_SECRET: !If
  [IsBetterAuth, !Ref BetterAuthSecret, !Ref 'AWS::NoValue']
BETTER_AUTH_URL: !If
  [IsBetterAuth, !Sub 'https://${Api}.execute-api.${AWS::Region}.amazonaws.com/v1', !Ref 'AWS::NoValue']
GOOGLE_CLIENT_ID: !If
  [IsBetterAuth, !Ref GoogleClientId, !Ref 'AWS::NoValue']
GOOGLE_CLIENT_SECRET: !If
  [IsBetterAuth, !Ref GoogleClientSecret, !Ref 'AWS::NoValue']
SES_FROM_ADDRESS: !If
  [IsBetterAuth, !Ref SesFromAddress, !Ref 'AWS::NoValue']
JWKS_URL: !If
  [IsBetterAuth, !Sub 'https://${Api}.execute-api.${AWS::Region}.amazonaws.com/v1/auth/v1/jwks', !Ref 'AWS::NoValue']
```

**IAM policy for SES (conditional):**

```yaml
- !If
  - IsBetterAuth
  - Version: '2012-10-17'
    Statement:
      - Effect: Allow
        Action: [ses:SendEmail]
        Resource: '*'
  - !Ref 'AWS::NoValue'
```

Remove GoTrue-specific parameter descriptions and
`gotrue` from `AllowedValues`.

### 10. Bootstrap DDL for better-auth schema

Before first deployment with `AUTH_PROVIDER=better-auth`,
the operator must create the `better_auth` schema:

```sql
CREATE SCHEMA IF NOT EXISTS better_auth;
GRANT ALL PRIVILEGES ON SCHEMA better_auth TO <db_user>;
ALTER DEFAULT PRIVILEGES IN SCHEMA better_auth
  GRANT ALL ON TABLES TO <db_user>;
```

Then run better-auth's CLI migration:

```bash
DATABASE_URL="postgres://...?options=-c search_path=better_auth" \
  npx auth@latest migrate
```

This creates tables: `user`, `session`, `account`,
`verification`, `jwks` — all within the `better_auth`
schema. REST introspection (targeting `public` only)
never sees them.

### 11. OpenAPI updates

Add new endpoints to `getOpenApiPaths` in `handler.mjs`:

- `POST /otp` — Magic-link request
- `POST /verify` — OTP verification
- `GET /authorize` — OAuth initiation
- `GET /callback` — OAuth callback
- `GET /jwks` — Public JWKS endpoint

Schemas added: `OtpRequest`, `VerifyRequest`.

### 12. handleGetUser asymmetric token support

The current `handleGetUser` verifies the Bearer token
with `jwt.verifyToken` (HS256). With better-auth, access
tokens are asymmetric. The handler needs a dual-path
verification:

```js
let claims;
try {
  claims = jwt.verifyToken(token);
} catch {
  if (!prov.issuesOwnAccessToken) {
    return errorResponse(401, ...);
  }
  try {
    claims = await verifyAsymmetricToken(
      token, process.env.JWKS_URL);
  } catch {
    return errorResponse(401, ...);
  }
}
```

## Code Architecture / File Changes

### Files to create

| File | Description |
|------|-------------|
| `src/auth/providers/better-auth.mjs` | better-auth provider implementation |

### Files to modify

| File | Changes |
|------|---------|
| `src/auth/providers/interface.mjs` | Add `issuesOwnAccessToken` typedef, optional `sendOtp`/`verifyOtp`/`getOAuthRedirectUrl`/`handleOAuthCallback`/`getJwks` methods. Replace `gotrue` case with `better-auth`. |
| `src/auth/handler.mjs` | Add `issuesOwnAccessToken` branch in signup/signin/refresh handlers. Add `otp`, `verify`, `authorize`, `callback`, `jwks` route handlers. Remove `needsSessionTable` branches and session imports. Update path regex to allow hyphenated route names. Update `handleGetUser` and `handleLogout` for asymmetric tokens. |
| `src/auth/jwt.mjs` | Add `verifyAsymmetricToken` and `createAsymmetricVerifier` exports using `jose`. |
| `src/authorizer/index.mjs` | Add dual-algorithm Bearer token verification. Import `jose` for asymmetric path. Add `JWKS_URL` env var handling. Make handler async. |
| `src/index.mjs` | Pass `BETTER_AUTH_URL`, `BETTER_AUTH_SECRET`, `JWKS_URL` through `resolveAuth`. |
| `docs/deploy/aws-sam/template.yaml` | New parameters, conditions, env vars, IAM policy. Remove `gotrue` from `AllowedValues`. |
| `package.json` | Add `better-auth`, `@aws-sdk/client-sesv2`. Remove `bcryptjs`. |
| `CLAUDE.md` | Update §8 to reference `better-auth` instead of GoTrue. |
| `CHANGELOG.md` | Add entry to Unreleased section. |

### Files to delete

| File | Reason |
|------|--------|
| `src/auth/providers/gotrue.mjs` | Replaced by better-auth provider |
| `src/auth/schema.mjs` | GoTrue schema DDL (better-auth manages its own schema) |
| `src/auth/sessions.mjs` | No remaining provider uses session-table storage |

### Test files to create

| File | Description |
|------|-------------|
| `src/auth/__tests__/better-auth-provider.test.mjs` | Unit tests for better-auth provider (mocked better-auth API) |
| `src/auth/__tests__/better-auth-integration.test.mjs` | Integration tests with real PostgreSQL |
| `src/auth/__tests__/supabase-js-compat.test.mjs` | supabase-js wire compatibility smoke test |
| `src/auth/__tests__/authorizer-asymmetric.test.mjs` | Authorizer tests for dual-algorithm verification |

### Test files to delete

| File | Reason |
|------|--------|
| `src/auth/__tests__/gotrue-provider.test.mjs` | Tests the deleted GoTrue provider |
| `src/auth/__tests__/schema.test.mjs` | Tests the deleted auth schema DDL |
| `src/auth/__tests__/sessions.test.mjs` | Tests the deleted session functions |

### Test files to modify

| File | Changes |
|------|---------|
| `src/auth/__tests__/handler.test.mjs` | Update for `issuesOwnAccessToken` flow, remove `needsSessionTable` tests, add tests for new endpoints |
| `src/auth/__tests__/handler-cognito-no-session.test.mjs` | Remove `needsSessionTable` references; Cognito path is now the `!issuesOwnAccessToken` path |
| `src/auth/__tests__/jwt.test.mjs` | Add tests for `verifyAsymmetricToken` |
| `src/auth/__tests__/authorizer.test.mjs` | Add tests for asymmetric Bearer token verification |

## Testing Strategy

### Unit tests: better-auth provider

Mock `betterAuth` and its API methods. Verify:

- `signUp` returns `{ user, accessToken, refreshToken,
  expiresIn }` with correct user shape
- `signIn` returns same shape on valid credentials
- `signIn` throws `{ code: 'invalid_grant' }` on bad
  credentials
- `signUp` throws `{ code: 'user_already_exists' }` on
  duplicate email
- `signUp` throws `{ code: 'weak_password' }` on short
  password
- `refreshToken` returns fresh tokens on valid session
- `refreshToken` throws `{ code: 'invalid_grant' }` on
  expired session
- `getUser` returns user object from valid access token
- `signOut` calls better-auth revocation
- `sendOtp` calls `auth.api.signInMagicLink`
- `verifyOtp` returns session on valid token
- `verifyOtp` throws `{ code: 'invalid_grant' }` on
  invalid token
- `getOAuthRedirectUrl` returns authorization URL
- `handleOAuthCallback` returns session on success
- `getJwks` returns JWKS object
- `issuesOwnAccessToken` is `true`
- `needsSessionTable` is absent or `false`

### Unit tests: handler with better-auth

- `POST /auth/v1/signup` with `issuesOwnAccessToken`
  provider: returns GoTrue envelope using provider's
  access token (not `jwt.signAccessToken`)
- `POST /auth/v1/token?grant_type=password` same
- `POST /auth/v1/token?grant_type=refresh_token` same
- `POST /auth/v1/otp` validates email, calls `sendOtp`
- `POST /auth/v1/verify` validates email+token, returns
  session
- `GET /auth/v1/authorize?provider=google&redirect_to=x`
  returns 302
- `GET /auth/v1/callback` redirects with tokens in
  fragment
- `GET /auth/v1/jwks` returns JWKS
- Endpoints return 404 when provider does not support them
  (e.g., `/otp` on Cognito)
- Cognito path unchanged: handler still mints HS256

### Unit tests: authorizer dual-algorithm

- HS256 Bearer token: accepted (Cognito path)
- EdDSA Bearer token: accepted (better-auth path) when
  `JWKS_URL` is set
- EdDSA Bearer token: rejected when `JWKS_URL` is unset
- Apikey always HS256: accepted regardless of
  `AUTH_PROVIDER`
- Expired asymmetric token: rejected
- Wrong issuer: rejected
- Malformed token: rejected

### Unit tests: jwt.mjs asymmetric verification

- `verifyAsymmetricToken` accepts valid EdDSA token
  against a test JWKS
- `verifyAsymmetricToken` rejects expired token
- `verifyAsymmetricToken` rejects wrong-issuer token
- `createAsymmetricVerifier` caches JWKS across calls

### Integration tests

Require a running PostgreSQL instance with the
`better_auth` schema bootstrapped.

- Full signup → signin → refresh → getUser → signout flow
  using the better-auth provider end-to-end
- Verify access tokens are asymmetric (decode header,
  check `alg !== 'HS256'`)
- Verify refresh tokens are opaque strings (not JWTs)
- Verify GoTrue envelope shape matches
  `src/auth/gotrue-response.mjs` format
- Verify authorizer accepts the issued access tokens

### supabase-js compatibility smoke test

Import `@supabase/supabase-js`, point at handler via
fetch shim:

```js
const { data, error } = await supabase.auth.signUp({
  email: 'test@example.com',
  password: 'StrongPass1',
});
assert(data.session.access_token);

const { data: signIn } =
  await supabase.auth.signInWithPassword({...});
assert(signIn.session);

const { data: user } = await supabase.auth.getUser();
assert(user.user.email === 'test@example.com');

await supabase.auth.signOut();
```

This is the hard compatibility gate (CLAUDE.md rule #7).

### Regression: Cognito path

Run all existing Cognito tests unchanged. Verify:
- HS256 access tokens still issued
- Cognito refresh tokens passed through
- Authorizer accepts HS256 tokens
- No database schema required

## Implementation Order

### Phase 1: Provider and contract

1. Add `better-auth` and `@aws-sdk/client-sesv2` to
   `package.json`. Remove `bcryptjs`.
2. Extend `AuthProvider` typedef with
   `issuesOwnAccessToken` and optional methods in
   `interface.mjs`. Replace `gotrue` case with
   `better-auth`.
3. Implement `src/auth/providers/better-auth.mjs` with
   all interface methods.
4. Unit test the provider (mocked better-auth).

### Phase 2: Handler updates

5. Add `issuesOwnAccessToken` branch to `handleSignup`,
   `handlePasswordGrant`, `handleRefreshGrant`.
6. Add new route handlers: `otp`, `verify`, `authorize`,
   `callback`, `jwks`.
7. Update path regex to support new route names.
8. Update `handleGetUser` for asymmetric token
   verification.
9. Update `handleLogout` for asymmetric tokens.
10. Remove `needsSessionTable` branches and
    `sessions.mjs` import.
11. Unit test all handler changes.

### Phase 3: Authorizer and JWT

12. Add `verifyAsymmetricToken` to `jwt.mjs`.
13. Update authorizer for dual-algorithm verification.
14. Unit test authorizer with both HS256 and EdDSA tokens.

### Phase 4: Cleanup and deployment

15. Delete `gotrue.mjs`, `schema.mjs`, `sessions.mjs`.
16. Delete GoTrue test files.
17. Update SAM template.
18. Update `src/index.mjs` to pass new env vars.
19. Update `CLAUDE.md` §8, `CHANGELOG.md`.

### Phase 5: Integration and compatibility

20. Write integration tests against real PostgreSQL.
21. Write supabase-js compatibility smoke test.
22. Verify Cognito regression suite passes.
23. Update OpenAPI spec generation.

## Open Questions

1. **better-auth's `name` field requirement:** The
   `signUpEmail` API requires a `name` parameter. The
   current GoTrue-shaped signup body only has `email` and
   `password`. Plan: derive name from email
   (`email.split('@')[0]`) as a default. Alternatively,
   accept an optional `name` field in the signup body and
   pass it through.

2. **Magic-link verification redirect vs JSON:** The
   better-auth magic-link plugin's `magicLinkVerify`
   endpoint returns a redirect by default. Our
   `POST /auth/v1/verify` should return a JSON session
   instead. Need to verify that
   `auth.api.magicLinkVerify` with `asResponse: false`
   returns the session object rather than a redirect
   response.

3. **OAuth state persistence:** The OAuth flow requires
   state to persist between `/authorize` (which generates
   the state) and `/callback` (which validates it).
   better-auth manages this via its `verification` table.
   Confirm that the stateless Lambda handler does not
   need additional session affinity — the database-backed
   verification token should suffice.

4. **better-auth cold start cost:** better-auth
   initializes at module scope. Measure the cold start
   impact on Lambda. If significant, consider lazy
   initialization on first auth request.

5. **DSQL compatibility:** better-auth's auto-migration
   generates standard PostgreSQL DDL. Verify that the
   generated DDL (particularly `CREATE TABLE` statements)
   works on Aurora DSQL without modification (no foreign
   keys, no unsupported types). If not, run migrations
   against standard PostgreSQL only and document the DSQL
   limitation.

6. **Token refresh semantics:** better-auth's session
   token is a cookie-based opaque value. When we return
   it as `refresh_token` in the GoTrue envelope,
   supabase-js stores it and sends it back on refresh.
   Verify that better-auth accepts its session token via
   `Authorization: Bearer` header or cookie, since the
   client will send it in the request body (which the
   handler then needs to translate into the appropriate
   header/cookie for better-auth's API).

7. **Migration path from GoTrue:** Operators on
   `AUTH_PROVIDER=gotrue` need a data migration. A
   one-shot SQL script to copy `auth.users` rows into
   `better_auth.user` and `better_auth.account` is out
   of scope for this design but should ship as a
   follow-on migration guide.
