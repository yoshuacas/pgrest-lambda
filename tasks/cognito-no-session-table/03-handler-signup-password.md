# Task 03 — Branch Handler Signup and Password Grant on needsSessionTable

Agent: implementer
Design: docs/design/cognito-no-session-table.md
Depends on: Task 02

## Objective

Modify `handleSignup` and `handlePasswordGrant` in
`src/auth/handler.mjs` to skip session creation and return the
provider refresh token directly when `needsSessionTable` is
false.

## Target tests

- Test 1: Cognito signup does not query the database
- Test 2: Cognito signup refresh_token is the provider refresh
  token
- Test 3: Cognito signup access_token is a pgrest-lambda JWT
- Test 4: Cognito password grant does not query the database
- Test 5: Cognito password grant refresh_token is provider token
- Test 9: GoTrue signup creates a session row
- Test 10: GoTrue password grant creates a session row

## Implementation

### src/auth/handler.mjs — handleSignup (around line 111)

Currently:
```js
const pool = await ctx.db.getPool();
const providerName = config.auth?.provider || 'cognito';
const { sid } = await createSession(pool, { ... });
const accessToken = jwt.signAccessToken({ sub: user.id, email });
const refreshToken = jwt.signRefreshToken(user.id, sid);
return sessionResponse(accessToken, refreshToken, user, corsHeaders);
```

Change to:
```js
const accessToken = jwt.signAccessToken({ sub: user.id, email });
if (prov.needsSessionTable) {
  const pool = await ctx.db.getPool();
  const providerName = config.auth?.provider || 'cognito';
  const { sid } = await createSession(pool, {
    userId: user.id,
    provider: providerName,
    prt: providerTokens.refreshToken,
  });
  const refreshToken = jwt.signRefreshToken(user.id, sid);
  return sessionResponse(accessToken, refreshToken, user, corsHeaders);
}
return sessionResponse(
  accessToken, providerTokens.refreshToken, user, corsHeaders
);
```

### src/auth/handler.mjs — handlePasswordGrant (around line 161)

Same pattern: branch on `prov.needsSessionTable`. When false,
return `providerTokens.refreshToken` directly instead of
creating a session and minting a refresh JWT.

## Test requirements

- Existing handler tests in `handler.test.mjs` that test the
  current (session-based) behavior need to continue passing.
  Those tests use a mock provider without `needsSessionTable`
  set. Since the handler checks `prov.needsSessionTable`
  truthily, an undefined value is falsy, which matches the
  Cognito (no-session) path. This means existing tests that
  assert session creation will break. Either:
  (a) Update the existing mock provider in `handler.test.mjs`
      to set `needsSessionTable: true` so existing tests keep
      their GoTrue-like behavior, OR
  (b) Accept that those tests now validate the Cognito path.

  Option (a) is required — add `needsSessionTable: true` to
  the `createMockProvider` function in `handler.test.mjs` so
  the existing tests preserve their session-backed semantics.
  Without this, every existing test that asserts session
  creation or sid-based refresh will break.

## Acceptance criteria

- Tests 1-5 (Cognito signup/password grant) pass.
- Tests 9-10 (GoTrue signup/password grant) pass.
- All existing `handler.test.mjs` tests pass.

## Conflict criteria

- If existing handler tests fail after the change, check whether
  the mock provider needs `needsSessionTable: true`. The current
  mock provider simulates a session-backed flow.
- If all target tests already pass before changes, investigate
  whether the tests are true positives.
