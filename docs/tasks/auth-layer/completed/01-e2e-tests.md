# Task 01: End-to-End Tests for Supabase-Compatible Auth

**Agent:** implementer
**Design:** docs/design/auth-layer.md

## Objective

Create comprehensive unit and integration test suites for the
Supabase-compatible authentication layer. All tests should
compile and fail with clear messages indicating missing
implementations.

## Test File Paths

Create the following test files under
`plugin/lambda-templates/auth/`:

- `__tests__/jwt.test.mjs`
- `__tests__/gotrue-response.test.mjs`
- `__tests__/cognito-provider.test.mjs`
- `__tests__/handler.test.mjs`
- `__tests__/authorizer.test.mjs`
- `__tests__/integration.test.mjs`

And under `plugin/scripts/`:

- `__tests__/generate-keys.test.mjs`

Use Node.js built-in `node:test` and `node:assert`. Do not add
new test dependencies. The project uses `"type": "module"`.

## Test Cases

### jwt.test.mjs

- Given sub and email, when signAccessToken, then JWT decodes
  to `{sub, email, role: "authenticated", aud: "authenticated",
  iss: "boa"}` with ~1h expiry
- Given sub and provider refresh token, when signRefreshToken,
  then JWT decodes to `{sub, role: "authenticated", iss: "boa",
  prt: <provider-token>}` with ~30d expiry
- Given valid token, when verifyToken, then returns decoded
  payload with correct claims
- Given expired token, when verifyToken, then throws error
- Given token signed with wrong secret, when verifyToken, then
  throws error
- Given token with wrong issuer, when verifyToken, then throws
  error
- Given malformed string, when verifyToken, then throws error

### gotrue-response.test.mjs

- Given access_token, refresh_token, and user, when
  sessionResponse, then returns 200 with
  `{access_token, token_type: "bearer", expires_in: 3600,
  refresh_token, user}` in body
- Given user object, when userResponse, then returns 200 with
  user object containing id, email, role, aud, app_metadata,
  user_metadata, created_at
- When logoutResponse, then returns 204 with no body
- Given status, error, description, when errorResponse, then
  returns specified status with `{error, error_description}`
- All responses include CORS headers:
  `Access-Control-Allow-Origin: *`,
  `Access-Control-Allow-Headers` includes apikey,
  `Access-Control-Allow-Methods` includes PATCH,
  `Content-Type: application/json`
- Given user with missing app_metadata, when formatUser (via
  sessionResponse), then defaults to
  `{provider: "email", providers: ["email"]}`
- Given user with missing created_at, when formatUser (via
  sessionResponse), then defaults to an ISO date string

### cognito-provider.test.mjs

Mock `@aws-sdk/client-cognito-identity-provider` to avoid
real AWS calls.

- Given email and password, when signUp, then sends
  SignUpCommand with correct ClientId, Username, Password
- Given signUp succeeds, then returns user with id from
  UserSub
- Given Cognito throws UsernameExistsException, when signUp,
  then throws error with code `user_already_exists`
- Given Cognito throws InvalidPasswordException, when signUp,
  then throws error with code `weak_password`
- Given email and password, when signIn, then sends
  InitiateAuthCommand with USER_PASSWORD_AUTH flow
- Given signIn succeeds, then returns user and
  providerTokens with accessToken, refreshToken, idToken
- Given Cognito throws NotAuthorizedException, when signIn,
  then throws error with code `invalid_grant`
- Given Cognito throws UserNotFoundException, when signIn,
  then throws error with code `invalid_grant`
- Given provider refresh token, when refreshToken, then
  sends InitiateAuthCommand with REFRESH_TOKEN_AUTH flow
- Given refreshToken succeeds, then returns user and new
  providerTokens
- Given expired refresh token, when refreshToken, then throws
  error with code `invalid_grant`
- When getUser with access token, then sends GetUserCommand
  and returns user attributes
- When signOut, then returns void without calling Cognito SDK
- Given Cognito throws InvalidParameterException, when
  signUp, then throws error with code `validation_failed`
- Given Cognito throws CodeMismatchException, when signIn,
  then throws error with code `invalid_grant`
- Given unknown provider name in AUTH_PROVIDER env, when
  createProvider, then throws error with message containing
  the provider name

### handler.test.mjs

Mock the provider and JWT modules.

**Signup:**
- Given POST /auth/v1/signup with valid email and password,
  when handler, then returns 200 with session (access_token,
  refresh_token, user)
- Given POST /auth/v1/signup with missing email, when handler,
  then returns 400 with
  `{error: "validation_failed", error_description: "Email is required"}`
- Given POST /auth/v1/signup with missing password, when
  handler, then returns 400 with
  `{error: "validation_failed", error_description: "Password is required"}`
- Given POST /auth/v1/signup with invalid email format, when
  handler, then returns 400 with
  `{error: "validation_failed", error_description: "Invalid email format"}`
- Given POST /auth/v1/signup with duplicate email, when
  handler, then returns 400 with
  `{error: "user_already_exists", error_description: "User already registered"}`
- Given POST /auth/v1/signup with weak password, when
  handler, then returns 422 with
  `{error: "weak_password", error_description: "Password must be at least 8 characters and include uppercase, lowercase, and numbers"}`
- Given POST /auth/v1/signup with unexpected provider error,
  when handler, then returns 500 with
  `{error: "unexpected_failure", error_description: "An unexpected error occurred"}`

  > Warning: Handler tests that mock the provider should
  > verify that the mock is exercised (e.g., check call
  > count), not just that the response shape is correct.
  > A response with the right shape could be produced by a
  > hardcoded fallback rather than the actual provider path.

**Token (password grant):**
- Given POST /auth/v1/token?grant_type=password with valid
  credentials, when handler, then returns 200 with session
- Given POST /auth/v1/token?grant_type=password with missing
  email, when handler, then returns 400 with
  `{error: "validation_failed", error_description: "Email is required"}`
- Given POST /auth/v1/token?grant_type=password with missing
  password, when handler, then returns 400 with
  `{error: "validation_failed", error_description: "Password is required"}`
- Given POST /auth/v1/token?grant_type=password with bad
  credentials, when handler, then returns 400 with
  `{error: "invalid_grant", error_description: "Invalid login credentials"}`
- Given POST /auth/v1/token without grant_type, when handler,
  then returns 400 with
  `{error: "unsupported_grant_type", error_description: "Missing or unsupported grant_type"}`
- Given POST /auth/v1/token?grant_type=magic_link, when
  handler, then returns 400 with
  `{error: "unsupported_grant_type", error_description: "Missing or unsupported grant_type"}`

**Token (refresh grant):**
- Given POST /auth/v1/token?grant_type=refresh_token with
  valid refresh_token, when handler, then returns 200 with
  new session
- Given POST /auth/v1/token?grant_type=refresh_token with
  missing refresh_token, when handler, then returns 400 with
  `{error: "validation_failed", error_description: "Refresh token is required"}`
- Given POST /auth/v1/token?grant_type=refresh_token with
  invalid token, when handler, then returns 401 with
  `{error: "invalid_grant", error_description: "Invalid refresh token"}`

**Get user:**
- Given GET /auth/v1/user with valid Bearer token, when
  handler, then returns 200 with user object from JWT claims
- Given GET /auth/v1/user without Authorization header, when
  handler, then returns 401 with
  `{error: "not_authenticated", error_description: "Missing authorization header"}`
- Given GET /auth/v1/user with expired token, when handler,
  then returns 401 with
  `{error: "not_authenticated", error_description: "Invalid or expired token"}`

**Logout:**
- Given POST /auth/v1/logout, when handler, then returns 204

**CORS:**
- Given OPTIONS to any /auth/v1/ path, when handler, then
  returns 200 with CORS headers

**404:**
- Given GET /auth/v1/unknown, when handler, then returns 404
  with `{error: "not_found", error_description: "Endpoint not found"}`

### authorizer.test.mjs

Sign real JWTs with a test secret for these tests.

- Given valid anon apikey only (no Authorization header),
  when authorizer, then returns Allow with role=anon,
  userId="", email=""
- Given anon apikey + anon key as Bearer (supabase-js
  default), when authorizer, then returns Allow with
  role=anon
- Given anon apikey + authenticated user Bearer, when
  authorizer, then returns Allow with role=authenticated,
  userId=<sub>, email=<email>

  > Warning: Tests for "valid apikey + valid Bearer" should
  > verify that the bearer token's claims override the
  > apikey's claims, not just that the result is Allow. A
  > test that only checks Allow could pass if the authorizer
  > ignores the Bearer entirely.

- Given service_role apikey only, when authorizer, then
  returns Allow with role=service_role
- Given service_role key in both apikey and Authorization,
  when authorizer, then returns Allow with role=service_role
- Given missing apikey header, when authorizer, then returns
  Deny
- Given invalid JWT as apikey, when authorizer, then returns
  Deny
- Given valid apikey + expired Bearer, when authorizer, then
  returns Deny
- Given valid apikey + malformed Bearer, when authorizer,
  then returns Deny
- Given apikey with role=authenticated (forged key), when
  authorizer, then returns Deny
- Given valid request, when authorizer, then policy ARN is
  wildcarded (`<stage>/*`) for caching
- Given valid request, then context includes role, userId,
  email keys

### generate-keys.test.mjs

- Given a secret, when generate-keys.mjs runs, then outputs
  valid JSON with `anonKey` and `serviceRoleKey` fields
- Given output anonKey, when decoded, then payload has
  `{role: "anon", iss: "boa"}` with ~10-year expiry
- Given output serviceRoleKey, when decoded, then payload
  has `{role: "service_role", iss: "boa"}` with ~10-year
  expiry
- Given both keys and the input secret, when verified with
  HMAC-SHA256, then signatures are valid
- Given no secret argument, when script runs, then exits
  with non-zero code and prints usage to stderr

### integration.test.mjs

Create `plugin/lambda-templates/auth/__tests__/integration.test.mjs`.
These tests exercise the full auth handler with real JWT
signing but a mocked Cognito provider. They verify multi-step
flows end-to-end.

- Full signup flow: POST /auth/v1/signup returns tokens,
  then GET /auth/v1/user with returned access_token returns
  the same user
- Full signin flow: POST /auth/v1/token?grant_type=password
  returns tokens, then access_token can be used as Bearer
  in an authorizer event with role=authenticated
- Token refresh flow: sign in, then POST
  /auth/v1/token?grant_type=refresh_token with the returned
  refresh_token returns new valid tokens
- Anon access flow: authorizer event with only anon apikey
  (no Authorization) returns Allow with role=anon
- Authenticated access flow: authorizer event with anon
  apikey + user Bearer returns Allow with role=authenticated
  and correct userId and email

  > Warning: Integration tests that verify
  > "authorizer returns role=authenticated" should check
  > the authorizer context values (role, userId, email),
  > not just that the request succeeds. A passing request
  > could indicate service_role access if the authorizer
  > has a fallback path.

- Service role access flow: authorizer event with
  service_role apikey returns Allow with role=service_role
- Expired token flow: authorizer event with valid apikey +
  expired access_token returns Deny

## Setup Notes

- Use `node:test` and `node:assert` (built-in Node.js 20).
  Do not add test dependencies.
- Each test file should be independently runnable with
  `node --test <file>`.
- For handler tests, construct Lambda event objects with
  `httpMethod`, `path`, `queryStringParameters`, `headers`,
  and `body` fields.
- For authorizer tests, construct REQUEST-type Lambda
  authorizer events with `headers`, `methodArn`, and
  `requestContext`.
- Create stub modules with the expected exports if needed
  to avoid import failures. Stubs should throw
  "not implemented" when called.
- For generate-keys tests, use `child_process.execFile`
  to run the script as a subprocess.

## Acceptance Criteria

- All test files are syntactically valid and can be loaded
  by Node.js without import errors.
- All tests fail with clear assertion messages.
- No test panics or produces cryptic stack traces.

## Conflict Criteria

- If any test that should fail instead passes, first
  diagnose why by following the "Unexpected test results"
  steps in the implementer prompt: investigate the code
  path, verify the assertion targets the right behavior,
  and attempt to rewrite the test to isolate the intended
  path. Only escalate if you cannot construct a well-formed
  test that targets the desired behavior.
