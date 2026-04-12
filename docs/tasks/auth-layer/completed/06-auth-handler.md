# Task 06: Auth Handler and Routing

**Agent:** implementer
**Design:** docs/design/auth-layer.md
**Depends on:** Task 03, Task 04, Task 05

## Objective

Create the auth handler that routes GoTrue endpoints to
provider and JWT operations, and wire it into the main
Lambda entry point.

## Target Tests

From `__tests__/handler.test.mjs`:

**Signup:**
- POST /auth/v1/signup with valid body returns session
- POST /auth/v1/signup with missing email returns 400
- POST /auth/v1/signup with missing password returns 400
- POST /auth/v1/signup with invalid email format returns 400
- POST /auth/v1/signup with duplicate email returns 400
- POST /auth/v1/signup with weak password returns 422
- POST /auth/v1/signup with unexpected provider error
  returns 500

**Token (password):**
- POST /auth/v1/token?grant_type=password returns session
- POST /auth/v1/token?grant_type=password with missing
  email returns 400
- POST /auth/v1/token?grant_type=password with missing
  password returns 400
- POST /auth/v1/token?grant_type=password with bad creds
  returns 400
- POST /auth/v1/token without grant_type returns 400
- POST /auth/v1/token with unknown grant_type returns 400

**Token (refresh):**
- POST /auth/v1/token?grant_type=refresh_token returns
  new session
- POST /auth/v1/token?grant_type=refresh_token with missing
  token returns 400
- POST /auth/v1/token?grant_type=refresh_token with invalid
  token returns 401

**Get user:**
- GET /auth/v1/user with valid Bearer returns user
- GET /auth/v1/user without Authorization returns 401
- GET /auth/v1/user with expired token returns 401

**Logout:**
- POST /auth/v1/logout returns 204

**CORS:**
- OPTIONS returns 200 with CORS headers

**404:**
- Unknown path returns 404

From `__tests__/integration.test.mjs`:
- Full signup flow (signup -> get user with returned token)
- Full signin flow (token?grant_type=password -> use token)
- Token refresh flow (sign in -> refresh -> new tokens work)

## Implementation

### auth/handler.mjs

Create `plugin/lambda-templates/auth/handler.mjs` as
described in the design's "Auth Handler" section.

The handler:
1. Returns CORS preflight for OPTIONS requests.
2. Parses the path to extract the action
   (`/auth/v1/{action}`).
3. Parses `grant_type` from query string for token endpoint.
4. Routes to: `handleSignup`, `handleToken`,
   `handleGetUser`, `handleLogout`, or 404.

**handleSignup flow:**
1. Parse body for email and password.
2. Validate email with `/^[^\s@]+@[^\s@]+\.[^\s@]+$/`.
3. Validate password presence.
4. `provider.signUp(email, password)`.
5. `provider.signIn(email, password)` (auto-confirmed).
6. Sign BOA access and refresh tokens.
7. Return sessionResponse.

**Error mapping for signup (and token endpoints):**
Map provider error codes to GoTrue error responses. For
`weak_password`, pass the extra `weak_password` field:
```javascript
errorResponse(422, 'weak_password',
  'Password must be at least 8 characters and include uppercase, lowercase, and numbers',
  { weak_password: { reasons: ['length', 'characters'] } })
```
For `user_already_exists` → 400, `invalid_grant` → 400,
`validation_failed` → 400, `unexpected_failure` → 500.
See the design's error response tables for exact messages.

**handleToken (password) flow:**
1. Validate email and password presence.
2. `provider.signIn(email, password)`.
3. Sign BOA tokens.
4. Return sessionResponse.

**handleToken (refresh_token) flow:**
1. Validate refresh_token presence.
2. `verifyToken(refresh_token)` to extract prt and sub.
3. `provider.refreshToken(prt)`.
4. Sign new BOA tokens.
5. Return sessionResponse.

**handleGetUser flow:**
1. Extract Bearer token from Authorization header.
2. `verifyToken(token)`.
3. Construct user from JWT claims.
4. Return userResponse.

**handleLogout flow:**
1. Return logoutResponse (204).

### index.mjs routing

Modify `plugin/lambda-templates/index.mjs` to route
`/auth/v1/*` paths to the auth handler:

```javascript
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

## Acceptance Criteria

- All handler.test.mjs tests pass.
- index.mjs routes /auth/v1/* to auth handler and other
  paths to crud-api handler.
- Existing tests still pass.

## Conflict Criteria

- If all target tests already pass before any code changes
  are made, investigate whether the tests are true positives
  before marking the task complete.
