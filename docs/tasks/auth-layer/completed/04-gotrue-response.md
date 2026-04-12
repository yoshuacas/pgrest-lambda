# Task 04: GoTrue Response Formatter

**Agent:** implementer
**Design:** docs/design/auth-layer.md

## Objective

Create `plugin/lambda-templates/auth/gotrue-response.mjs` to
format Lambda responses matching the GoTrue protocol that
supabase-js expects.

## Target Tests

From `__tests__/gotrue-response.test.mjs`:
- sessionResponse returns 200 with access_token, token_type,
  expires_in, refresh_token, and user
- userResponse returns 200 with formatted user object
- logoutResponse returns 204 with no body
- errorResponse returns specified status with error and
  error_description
- All responses include CORS headers
- formatUser defaults app_metadata to
  `{provider: "email", providers: ["email"]}`
- formatUser defaults created_at to ISO date string

## Implementation

Create `plugin/lambda-templates/auth/gotrue-response.mjs`
as specified in the design's "GoTrue Response Formatter"
section.

Exports:
- `sessionResponse(accessToken, refreshToken, user)` -
  returns 200 with full session body
- `userResponse(user)` - returns 200 with formatted user
- `logoutResponse()` - returns 204, no body
- `errorResponse(statusCode, error, description)` - returns
  error body with specified status

Internal `formatUser(user)` produces:
`{id, email, role: "authenticated", aud: "authenticated",
app_metadata, user_metadata, created_at}`

Internal `corsHeaders()` returns:
- `Access-Control-Allow-Origin: *`
- `Access-Control-Allow-Headers: Content-Type,Authorization,apikey,Prefer,Accept,x-client-info`
- `Access-Control-Allow-Methods: GET,POST,PUT,PATCH,DELETE,OPTIONS`
- `Content-Type: application/json`

## Acceptance Criteria

- All gotrue-response.test.mjs tests pass.
- Existing tests still pass.

## Conflict Criteria

- If all target tests already pass before any code changes
  are made, investigate whether the tests are true positives
  before marking the task complete.
