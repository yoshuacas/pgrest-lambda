# Task 01 — End-to-End Tests for Cognito No-Session-Table

Agent: implementer
Design: docs/design/cognito-no-session-table.md

## Objective

Write failing end-to-end tests that cover every behavior change
described in the design: the Cognito path must not touch
`auth.sessions`, and the GoTrue path must continue to use it.

## Test file

`src/auth/__tests__/handler-cognito-no-session.test.mjs`

## Test cases

All tests use `node:test` and `node:assert/strict`. Each test
creates its own handler via `createAuthHandler` with a mock
provider and mock DB pool, same pattern as
`src/auth/__tests__/handler.test.mjs`.

### Cognito path — signup

1. **Cognito signup does not query the database**
   - Given: provider is Cognito (needsSessionTable: false)
   - When: POST /auth/v1/signup with valid email and password
   - Then: response is 200 with access_token, refresh_token, user
   - And: zero SQL queries are recorded on the mock pool

2. **Cognito signup refresh_token is the provider refresh token**
   - Given: provider is Cognito (needsSessionTable: false)
   - When: POST /auth/v1/signup with valid email and password
   - Then: response.refresh_token === the provider's
     providerTokens.refreshToken (not a pgrest-lambda JWT)

3. **Cognito signup access_token is a pgrest-lambda JWT**
   - Given: provider is Cognito (needsSessionTable: false)
   - When: POST /auth/v1/signup with valid email and password
   - Then: access_token is a valid JWT with iss=pgrest-lambda,
     role=authenticated, sub=user.id, email=user.email

### Cognito path — password grant

4. **Cognito password grant does not query the database**
   - Given: provider is Cognito (needsSessionTable: false)
   - When: POST /auth/v1/token?grant_type=password
   - Then: response is 200 with session
   - And: zero SQL queries on the mock pool

5. **Cognito password grant refresh_token is provider token**
   - Given: provider is Cognito (needsSessionTable: false)
   - When: POST /auth/v1/token?grant_type=password
   - Then: response.refresh_token === providerTokens.refreshToken

### Cognito path — refresh grant

6. **Cognito refresh grant passes token directly to provider**
   - Given: provider is Cognito (needsSessionTable: false)
   - When: POST /auth/v1/token?grant_type=refresh_token with
     body { refresh_token: "cognito-refresh-token" }
   - Then: provider.refreshToken is called with
     "cognito-refresh-token"
   - And: response is 200 with new access_token, refresh_token
   - And: zero SQL queries on the mock pool

7. **Cognito refresh grant with invalid provider token returns
   error from provider**
   - Given: provider is Cognito, provider.refreshToken throws
     invalid_grant
   - When: POST /auth/v1/token?grant_type=refresh_token with
     body { refresh_token: "bad-token" }
   - Then: response is 401 with invalid_grant

### Cognito path — logout

8. **Cognito logout does not revoke database sessions**
   - Given: provider is Cognito (needsSessionTable: false)
   - When: POST /auth/v1/logout with valid Bearer token
   - Then: response is 204
   - And: zero SQL queries on the mock pool
   - And: provider.signOut is called

### GoTrue path — session table still used

9. **GoTrue signup creates a session row**
   - Given: provider is GoTrue (needsSessionTable: true)
   - When: POST /auth/v1/signup with valid email and password
   - Then: response is 200
   - And: mock pool receives an INSERT INTO auth.sessions query
   - And: refresh_token is a pgrest-lambda JWT with sid claim

10. **GoTrue password grant creates a session row**
    - Given: provider is GoTrue (needsSessionTable: true)
    - When: POST /auth/v1/token?grant_type=password
    - Then: mock pool receives an INSERT INTO auth.sessions query
    - And: refresh_token is a pgrest-lambda JWT with sid claim

11. **GoTrue refresh grant uses session lookup**
    - Given: provider is GoTrue (needsSessionTable: true)
    - When: POST /auth/v1/token?grant_type=refresh_token with a
      pgrest-lambda JWT containing sid
    - Then: mock pool receives SELECT from auth.sessions
    - And: provider.refreshToken is called with the stored prt
    - And: mock pool receives UPDATE auth.sessions

12. **GoTrue logout revokes database sessions**
    - Given: provider is GoTrue (needsSessionTable: true)
    - When: POST /auth/v1/logout with valid Bearer token
    - Then: mock pool receives UPDATE auth.sessions SET revoked

### Provider capability contract

13. **Provider needsSessionTable property is respected**
    - Given: a mock provider with needsSessionTable: false
    - When: handler processes signup
    - Then: no session queries
    - Given: a mock provider with needsSessionTable: true
    - When: handler processes signup
    - Then: session queries are made

## Notes

- The mock provider for Cognito tests must include
  `needsSessionTable: false` on the provider object.
- The mock provider for GoTrue tests must include
  `needsSessionTable: true` on the provider object.
- For Cognito refresh grant tests (test 6, 7), the handler
  should accept the raw provider refresh token directly — it is
  NOT a pgrest-lambda JWT. The handler must detect this and
  route to provider.refreshToken without session lookup.
- For GoTrue refresh grant tests (test 11), the existing
  behavior with sid-based JWT lookup is preserved.
- Mock DB pools must track all queries to assert zero-query or
  specific-query behavior.

## Acceptance criteria

- All tests compile and run with `node --test`.
- All 13 test cases fail with clear assertion messages
  explaining what the handler does wrong (e.g., "expected 0 SQL
  queries but got 1").

## Conflict criteria

- If any test that is expected to fail instead passes, first
  diagnose why by investigating the code path: verify the
  assertion targets the right behavior and attempt to rewrite
  the test to isolate the intended path. Only escalate if you
  cannot construct a well-formed test that targets the desired
  behavior.
