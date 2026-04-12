# Code Review: auth-layer

## Correctness

### PostgREST handler reads userId from wrong authorizer context path

**File:** `plugin/lambda-templates/postgrest/handler.mjs` (line 58-59)

The PostgREST handler extracts the user ID via the old Cognito
authorizer path:

```javascript
const userId = event.requestContext?.authorizer?.claims?.sub
  || 'anonymous';
```

The new BOA custom authorizer sets context as flat keys
(`event.requestContext.authorizer.userId`,
`event.requestContext.authorizer.role`, etc.) — there is no
`.claims` intermediate object. This means `userId` will always
resolve to `'anonymous'` for all requests.

Consequence: every query against a table with a `user_id` column
will include `WHERE user_id = 'anonymous'`, returning zero rows.

This is a critical bug that breaks all authenticated data access.

**Proposed test:**

> Given a PostgREST handler event with authorizer context
> `{ role: 'authenticated', userId: 'user-123', email: 'u@ex.com' }`
> (flat keys, no `.claims` nesting)
> When a GET request is made to `/rest/v1/todos`
> Then the SQL query binds `user_id = 'user-123'` (not
> `'anonymous'`)

**Test location:** `plugin/lambda-templates/postgrest/__tests__/handler.integration.test.mjs`
**Function:** `test_handler_reads_userId_from_flat_authorizer_context`

---

### service_role requests are incorrectly filtered by user_id

**File:** `plugin/lambda-templates/postgrest/sql-builder.mjs` (lines 74-79)
**File:** `plugin/lambda-templates/postgrest/handler.mjs` (lines 58-59)

`appendUserId` adds a `WHERE user_id = $N` clause whenever:
1. The table has a `user_id` column, AND
2. `userId != null`

For `service_role` requests, the authorizer returns
`userId: ''` (empty string). Since `'' != null` is `true`,
the filter is applied as `WHERE user_id = ''`, returning zero
rows. The design states that service_role should provide
admin-level access that bypasses row-level filtering.

Even after fixing the userId extraction path (issue above),
service_role requests will be broken because the handler
and SQL builder have no concept of roles.

**Proposed test:**

> Given a request with authorizer context
> `{ role: 'service_role', userId: '', email: '' }`
> When a GET request is made to `/rest/v1/todos`
> Then the SQL query does NOT include a `user_id` WHERE clause
> And all rows are returned regardless of user_id value

**Test location:** `plugin/lambda-templates/postgrest/__tests__/handler.integration.test.mjs`
**Function:** `test_service_role_bypasses_user_id_filter`

**Additional proposed test:**

> Given a request with authorizer context
> `{ role: 'anon', userId: '', email: '' }`
> When a GET request is made to `/rest/v1/todos`
> Then the SQL query does NOT include a `user_id` WHERE clause
> (anon access sees all public rows; RLS comes later with Cedar)

**Test location:** `plugin/lambda-templates/postgrest/__tests__/handler.integration.test.mjs`
**Function:** `test_anon_role_does_not_filter_by_empty_user_id`

---

### Authorizer returns Deny policy instead of 401 for auth failures

**File:** `plugin/lambda-templates/authorizer/index.mjs` (lines 14, 36-38)

The design doc states auth failures should return "401
(Unauthorized)". The implementation returns an explicit Deny
IAM policy. Per AWS documentation, when a Lambda authorizer
returns a Deny policy, API Gateway returns **403 Forbidden**
to the client — not 401. To get 401, the authorizer must
throw the string `"Unauthorized"`.

This matters for supabase-js compatibility: the client library
distinguishes between 401 (re-authenticate) and 403 (access
denied). An incorrect 403 may cause supabase-js to not trigger
its automatic token refresh flow.

**Proposed test (infrastructure-level, not unit-testable):**

> Given a request with a missing apikey header
> When the request reaches API Gateway
> Then the client receives HTTP 401 (not 403)

Since this behavior depends on API Gateway runtime behavior,
it cannot be verified in a unit test. However, the authorizer
code can be changed and the intent can be documented:

**Proposed test (unit-level intent):**

> Given a request with a missing apikey header
> When the authorizer handler is called
> Then it throws the string "Unauthorized" (not returns a Deny
> policy)

**Test location:** `plugin/lambda-templates/auth/__tests__/authorizer.test.mjs`
**Function:** `test_missing_apikey_throws_unauthorized_string`

---

### PATCH with invalid JSON body causes unhandled TypeError

**File:** `plugin/lambda-templates/postgrest/handler.mjs` (lines 62-69, 142-145)

When `event.body` contains invalid JSON, the catch block sets
`body = null`. For POST, this is handled (line 123 checks
`!body` and throws PGRST100). For PATCH and DELETE, `body` is
passed directly to `buildUpdate` which calls
`Object.entries(body)` — this will throw a `TypeError:
Cannot convert undefined or null to object` which gets caught
by the generic error handler and returns a 500 instead of a
meaningful 400 error.

**Proposed test:**

> Given a PATCH request to `/rest/v1/todos?id=eq.abc`
> with body set to the string `"not json {{{"`
> When the handler processes the request
> Then it returns HTTP 400 with code PGRST100
> (not HTTP 500 with a generic error)

**Test location:** `plugin/lambda-templates/postgrest/__tests__/handler.integration.test.mjs`
**Function:** `test_patch_with_invalid_json_body_returns_400`

---

### errorResponse missing `extra` parameter for weak_password GoTrue field

**File:** `plugin/lambda-templates/auth/gotrue-response.mjs` (line 27)
**File:** `plugin/lambda-templates/auth/handler.mjs` (lines 41-46)

The design specifies that `weak_password` errors include an
extra field:

```json
{
  "error": "weak_password",
  "error_description": "Password must be...",
  "weak_password": { "reasons": ["length", "characters"] }
}
```

The implementation of `errorResponse` takes only 3 parameters
(statusCode, error, description) with no `extra` spread. The
design's code example shows a 4th `extra` parameter. The
`providerErrorResponse` function in the handler also doesn't
pass any extra data.

This means supabase-js clients checking
`error.weak_password.reasons` will get `undefined`.

**Proposed test:**

> Given a signup request with password "weak"
> When the provider throws a weak_password error
> Then the response body includes a `weak_password` key with
> `reasons` array (matching GoTrue's format)

**Test location:** `plugin/lambda-templates/auth/__tests__/handler.test.mjs`
**Function:** `test_signup_weak_password_includes_reasons_field`

**Additional test for the response module:**

> Given a call to `errorResponse(422, 'weak_password', '...', { weak_password: { reasons: ['length'] } })`
> When the response is built
> Then the JSON body includes the `weak_password` key at the
> top level

**Test location:** `plugin/lambda-templates/auth/__tests__/gotrue-response.test.mjs`
**Function:** `test_errorResponse_with_extra_fields`

---

### Router accepts paths with trailing slashes or extra segments

**File:** `plugin/lambda-templates/postgrest/router.mjs` (line 17)

The table name extraction uses `remaining.replace(/^\//, '')`
which does not strip trailing slashes. A request to
`/rest/v1/todos/` would result in `tableName = 'todos/'`,
which fails the `hasTable` check. While this returns a 404
(safe), the error message `"Relation 'todos/' does not exist"`
is confusing.

More critically, a path like `/rest/v1/todos/some-id` would
resolve to `tableName = 'todos/some-id'`, also returning a
confusing 404. PostgREST uses query parameters for filtering,
not path segments, so this is functionally correct but the
error message could mislead developers.

This is a minor usability concern, not a security issue.

**Proposed test:**

> Given a GET request to `/rest/v1/todos/`
> When the router processes the path
> Then it returns 404 with a clear error message
> (or alternatively, strips the trailing slash and routes to
> the `todos` table)

**Test location:** `plugin/lambda-templates/postgrest/__tests__/router.test.mjs`
**Function:** `test_route_trailing_slash_behavior`

## Sustainability

### PostgREST handler has no concept of roles

**File:** `plugin/lambda-templates/postgrest/handler.mjs`
**File:** `plugin/lambda-templates/postgrest/sql-builder.mjs`

The auth layer introduces three roles (`anon`, `authenticated`,
`service_role`) passed through the authorizer context, but the
PostgREST handler ignores them entirely. It only extracts
`userId` and applies user_id filtering uniformly. This means:

- `service_role` cannot perform admin queries (filtered by
  empty user_id)
- `anon` cannot read any data in tables with `user_id`
  (filtered by empty user_id)
- There is no extension point for the upcoming Cedar
  authorization layer to hook into

The handler should extract `role` from the authorizer context
and pass it to the SQL builder, which should skip the user_id
filter when `role === 'service_role'`.

**Proposed test (boundary exercise):**

> Given a service_role request to GET `/rest/v1/todos`
> When the handler builds the SQL
> Then the generated SQL has no `user_id` WHERE clause

**Test location:** `plugin/lambda-templates/postgrest/__tests__/sql-builder.test.mjs`
**Function:** `test_buildSelect_service_role_skips_user_id_filter`

---

### Duplicate CORS header definitions across three files

**Files:**
- `plugin/lambda-templates/postgrest/response.mjs` (lines 5-12)
- `plugin/lambda-templates/auth/gotrue-response.mjs` (lines 53-62)
- `plugin/lambda-templates/auth/handler.mjs` (lines 54-62)

CORS configuration is defined independently in three locations.
The PostgREST response includes `Access-Control-Expose-Headers:
Content-Range`, but the auth GoTrue response and auth handler
OPTIONS do not. If CORS requirements change (e.g., adding new
allowed headers), all three must be updated independently.

Consider extracting a shared `cors.mjs` module that both the
PostgREST and auth layers import.

---

### index.mjs routing coupled to path prefix strings

**File:** `plugin/lambda-templates/index.mjs` (line 6)

The main router uses `path.startsWith('/auth/v1/')` as a
literal string check. If a future design adds additional
top-level path prefixes (e.g., `/storage/v1/`, `/realtime/`),
each addition requires modifying this file. This is acceptable
for now but worth noting as the number of services grows.

## Idiomatic Usage

### API Gateway authorizer should throw "Unauthorized" for 401

**File:** `plugin/lambda-templates/authorizer/index.mjs`

Per the [AWS documentation on Lambda authorizers](https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-use-lambda-authorizer.html),
returning an explicit Deny policy results in a **403 Forbidden**
response to the client. To return **401 Unauthorized**, the
authorizer function should throw the literal string
`"Unauthorized"` (or use a callback with that value).

The idiomatic pattern for API Gateway REQUEST authorizers is:

- **Valid credentials** → return Allow policy with context
- **Invalid/missing credentials** → `throw "Unauthorized"`
  (yields 401)
- **Valid credentials, insufficient permissions** → return
  Deny policy (yields 403)

For the BOA authorizer, all current denial cases (missing
apikey, invalid JWT, expired bearer) are authentication
failures, not authorization failures. They should produce 401.

---

### JWT secret read on every invocation vs module-level constant

**File:** `plugin/lambda-templates/authorizer/index.mjs` (line 7)

The authorizer reads `process.env.JWT_SECRET` on every
invocation inside the handler function. The idiomatic Lambda
pattern is to read environment variables at module scope
(outside the handler) since they don't change between
invocations. The design doc's code example and the
`auth/jwt.mjs` module both use `process.env.JWT_SECRET`
at call time, so this is consistent across the codebase,
but initializing at module scope would be marginally faster
and more conventional:

```javascript
const SECRET = process.env.JWT_SECRET;
```

Note: `auth/jwt.mjs` already does this correctly with
module-level scope for ISSUER but reads SECRET at call time.
This is a minor consistency point, not a bug.

## Test Quality

### Missing: handler test doesn't verify provider.signIn called during signup

**File:** `plugin/lambda-templates/auth/__tests__/handler.test.mjs` (lines 103-123)

The design specifies the signup flow as: "provider.signUp →
provider.signIn → sign BOA tokens". The test verifies the
response shape but never asserts that `signIn` was called
after `signUp`. A mock provider that only implements `signUp`
(and throws on `signIn`) would produce a different error but
the current test doesn't cover this contract.

**Proposed test:**

> Given a mock provider with call-counting on signUp and signIn
> When a valid signup request is processed
> Then signUp was called exactly once
> And signIn was called exactly once (to get provider tokens)

**Test location:** `plugin/lambda-templates/auth/__tests__/handler.test.mjs`
**Function:** `test_signup_calls_both_signUp_and_signIn`

---

### Missing: user isolation test doesn't verify SQL parameter binding

**File:** `plugin/lambda-templates/postgrest/__tests__/handler.integration.test.mjs` (lines 282-311)

The test comment acknowledges: "we rely on the mock pool
capturing query params" but the mock pool does not actually
capture or assert the `user_id` parameter. Both user-A and
user-B queries return the same mock data regardless of the
userId parameter, so this test passes vacuously.

**Proposed test:**

> Given a mock pool that records the `values` array from each
> query call
> When user-A sends GET /rest/v1/todos
> Then the SQL values array contains 'user-A'
> When user-B sends GET /rest/v1/todos
> Then the SQL values array contains 'user-B'

**Test location:** `plugin/lambda-templates/postgrest/__tests__/handler.integration.test.mjs`
**Function:** `test_user_isolation_binds_correct_user_id_in_sql`

---

### Missing: PATCH/DELETE with null body (malformed JSON)

**File:** `plugin/lambda-templates/postgrest/__tests__/handler.integration.test.mjs`

The test suite covers POST with null body (line 265-279) but
not PATCH or DELETE with a malformed JSON body. PATCH with
null body hits `Object.entries(null)` which throws TypeError.

**Proposed test:**

> Given a PATCH request to `/rest/v1/todos?id=eq.abc`
> with `event.body = '{{invalid json'`
> When the handler processes the request
> Then it returns HTTP 400 (not 500)

**Test location:** `plugin/lambda-templates/postgrest/__tests__/handler.integration.test.mjs`
**Function:** `test_patch_with_malformed_json_returns_400`

---

### Missing: authorizer with apikey signed by wrong secret

**File:** `plugin/lambda-templates/auth/__tests__/authorizer.test.mjs`

The test for "invalid apikey JWT" uses a non-JWT string
(`'not-a-valid-jwt'`). There is no test for an apikey that
is a structurally valid JWT but signed with a different secret.
This is an important security boundary.

**Proposed test:**

> Given an apikey JWT with role=anon signed with a different
> secret than JWT_SECRET
> When the authorizer processes the request
> Then it returns Deny (or throws "Unauthorized")

**Test location:** `plugin/lambda-templates/auth/__tests__/authorizer.test.mjs`
**Function:** `test_apikey_signed_with_wrong_secret_is_denied`

---

### Missing: generate-keys.mjs output verification

**File:** `plugin/scripts/generate-keys.mjs`

There are no automated tests for the key generation script.
The design's testing strategy specifies 6 test cases for this
script. Since it uses manual JWT encoding (not jsonwebtoken),
it's important to verify that the output is compatible with
the authorizer which uses `jsonwebtoken` to verify.

**Proposed test:**

> Given a known JWT secret
> When generate-keys.mjs is executed with that secret
> Then the output is valid JSON with `anonKey` and
> `serviceRoleKey` fields
> And both keys are verifiable by `jsonwebtoken.verify()`
> with the same secret
> And the anonKey decodes to `{role: "anon", iss: "boa"}`
> And the serviceRoleKey decodes to
> `{role: "service_role", iss: "boa"}`
> And both have approximately 10-year expiry

**Test location:** `plugin/scripts/__tests__/generate-keys.test.mjs`
**Function:** `test_generate_keys_produces_valid_jwts`

---

### Missing: end-to-end expired-then-refresh flow

**File:** `plugin/lambda-templates/auth/__tests__/integration.test.mjs` (lines 391-412)

The test verifies that the authorizer denies an expired token,
but does not complete the flow by refreshing and verifying the
new token works. The design's integration test plan specifies:
"Expired token flow: use expired access_token → authorizer
denies → refresh → new token works."

**Proposed test:**

> Given a user who has signed in and received tokens
> And the access_token has expired
> When the authorizer is called with the expired access_token
> Then it returns Deny
> When the refresh_token is used to get new tokens
> Then the new access_token is accepted by the authorizer
> And the authorizer context contains the correct userId

**Test location:** `plugin/lambda-templates/auth/__tests__/integration.test.mjs`
**Function:** `test_expired_token_then_refresh_produces_valid_tokens`

## Test Harness Gaps

### Mock pool needs query parameter capture

**Needed by:** `test_user_isolation_binds_correct_user_id_in_sql`,
`test_service_role_bypasses_user_id_filter`,
`test_handler_reads_userId_from_flat_authorizer_context`
**Description:** The `createMockPool()` in
`handler.integration.test.mjs` routes queries by SQL prefix
but does not record the `values` array passed to `pool.query`.
Add a `capturedQueries` array to the mock pool that stores
`{ text, values }` for each call. Tests can then assert that
specific parameter values (like user_id) appear in the correct
positions.

---

### makeEvent helper needs authorizer context structure

**Needed by:** `test_handler_reads_userId_from_flat_authorizer_context`,
`test_service_role_bypasses_user_id_filter`,
`test_anon_role_does_not_filter_by_empty_user_id`
**Description:** The `makeEvent` helper in
`handler.integration.test.mjs` builds the authorizer context
as `event.requestContext.authorizer.claims.sub` (Cognito
format). After the auth layer, it should use the flat
`event.requestContext.authorizer.{role, userId, email}`
structure. Update the helper to accept `role`, `userId`, and
`email` parameters and place them at the correct path:

```javascript
function makeEvent({ ..., role = 'authenticated',
    userId = 'user-1', email = '' } = {}) {
  return {
    ...
    requestContext: {
      authorizer: { role, userId, email },
    },
  };
}
```

---

### Test runner for generate-keys.mjs script

**Needed by:** `test_generate_keys_produces_valid_jwts`
**Description:** The generate-keys script is a standalone
CLI tool, not a module. Tests need to either:
(a) extract the `sign` and `b64url` functions into a testable
module and import them, or
(b) run the script as a child process with `execFile` and
parse stdout. Option (b) is more realistic since it tests
the actual CLI interface. The test file should be at
`plugin/scripts/__tests__/generate-keys.test.mjs`.

---

### Authorizer test helper for wrong-secret JWTs

**Needed by:** `test_apikey_signed_with_wrong_secret_is_denied`
**Description:** The `signJwt` helper in `authorizer.test.mjs`
already accepts a `secret` parameter (defaulting to
`TEST_SECRET`). No new harness is needed — the existing helper
is sufficient. Just call `signJwt(payload, 'different-secret')`.

## Documentation

### Plugin CLAUDE.md should document the authorizer contract

The plugin's `CLAUDE.md` still references the Cognito
authorizer pattern. After the auth layer, the downstream
contract changes from:

```javascript
event.requestContext.authorizer.claims.sub
```

to:

```javascript
event.requestContext.authorizer.role
event.requestContext.authorizer.userId
event.requestContext.authorizer.email
```

This should be documented in `plugin/CLAUDE.md` or
`plugin/docs/` so that agents building on top of BOA know the
correct way to extract identity from handler events.

---

### Critical Rule 3 may need updating

`CLAUDE.md` rule 3 states: "Always use REST API Gateway (not
HTTP API) — required for Cognito authorizers". Since the auth
layer replaces the Cognito authorizer with a custom Lambda
authorizer (which works with both REST and HTTP APIs), the
rationale should be updated. REST API Gateway is still required
for REQUEST-type Lambda authorizers with header-based caching,
but the reason is no longer "Cognito authorizers".
