# Task 07: Custom Lambda Authorizer

**Agent:** implementer
**Design:** docs/design/auth-layer.md
**Depends on:** Task 03

## Objective

Create the REQUEST-type Lambda authorizer that replaces
the Cognito authorizer, validating BOA JWTs and passing
role/userId/email context to downstream handlers.

## Target Tests

From `__tests__/authorizer.test.mjs`:
- Valid anon apikey only -> Allow with role=anon, userId="",
  email=""
- Anon apikey + anon key as Bearer -> Allow with role=anon
- Anon apikey + authenticated user Bearer -> Allow with
  role=authenticated, userId, email set
- Service_role apikey only -> Allow with role=service_role
- Service_role key in both headers -> Allow with
  role=service_role
- Missing apikey -> Deny
- Invalid apikey JWT -> Deny
- Valid apikey + expired Bearer -> Deny
- Valid apikey + malformed Bearer -> Deny
- Apikey with role=authenticated (forged) -> Deny
- Policy ARN is wildcarded for caching
- Context includes role, userId, email keys

From `__tests__/integration.test.mjs`:
- Anon access flow (anon apikey -> Allow with role=anon)
- Authenticated access flow (anon apikey + user Bearer ->
  Allow with role=authenticated, userId, email)
- Service role access flow (service_role apikey -> Allow
  with role=service_role)
- Expired token flow (valid apikey + expired Bearer -> Deny)

## Implementation

Create `plugin/lambda-templates/authorizer/index.mjs` as
specified in the design's "Authorizer" section.

**Authorization logic:**

1. Extract `apikey` header (case-insensitive: `apikey` or
   `Apikey`). If missing, return Deny.
2. Verify apikey JWT with `JWT_SECRET` and `issuer: "boa"`.
   Role must be `anon` or `service_role`. Otherwise Deny.
3. Extract `Authorization: Bearer <token>`:
   a. Verify bearer JWT with same secret.
   b. Use bearer claims for effective identity.
   c. If invalid/expired, return Deny.
4. If no Authorization header, use apikey claims as
   effective identity.
5. Return Allow policy with context `{role, userId, email}`.

**Context values by role:**
| Role | userId | email |
|------|--------|-------|
| anon | `""` | `""` |
| authenticated | `<sub>` | `<email>` |
| service_role | `""` | `""` |

**Policy ARN:** Replace specific method/path with wildcard
(`<stage>/*`) so API Gateway can cache across endpoints.

**Environment:** `JWT_SECRET` from env var.

Uses `jsonwebtoken` (already added in Task 03).

## Acceptance Criteria

- All authorizer.test.mjs tests pass.
- Existing tests still pass.

## Conflict Criteria

- If all target tests already pass before any code changes
  are made, investigate whether the tests are true positives
  before marking the task complete.
