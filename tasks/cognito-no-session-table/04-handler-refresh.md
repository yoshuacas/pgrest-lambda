# Task 04 — Branch Handler Refresh Grant on needsSessionTable

Agent: implementer
Design: docs/design/cognito-no-session-table.md
Depends on: Task 02, Task 03

## Objective

Modify `handleRefreshGrant` in `src/auth/handler.mjs` to accept
a raw provider refresh token (not a pgrest-lambda JWT) when the
provider has `needsSessionTable: false`, and pass it directly to
`provider.refreshToken`.

## Target tests

- Test 6: Cognito refresh grant passes token directly to
  provider
- Test 7: Cognito refresh grant with invalid provider token
  returns error from provider
- Test 11: GoTrue refresh grant uses session lookup

## Implementation

### src/auth/handler.mjs — handleRefreshGrant (around line 179)

The current flow assumes the refresh_token is always a
pgrest-lambda JWT with a `sid` claim. For the Cognito path, the
refresh_token is a raw Cognito token (opaque string, not a JWT
pgrest-lambda minted).

Strategy: try to detect whether the incoming token is a
pgrest-lambda JWT. If the provider has `needsSessionTable:
false`, skip JWT verification and treat the token as a raw
provider refresh token.

```js
async function handleRefreshGrant(event, corsHeaders) {
  const body = JSON.parse(event.body || '{}');
  const { refresh_token } = body;

  if (!refresh_token) {
    return errorResponse(400, 'validation_failed',
      'Refresh token is required', undefined, corsHeaders);
  }

  const prov = await getProvider();

  if (!prov.needsSessionTable) {
    // Cognito path: refresh_token is a raw provider token
    try {
      const { user, providerTokens } =
        await prov.refreshToken(refresh_token);
      const accessToken = jwt.signAccessToken({
        sub: user.id, email: user.email,
      });
      return sessionResponse(
        accessToken, providerTokens.refreshToken,
        user, corsHeaders,
      );
    } catch {
      return errorResponse(401, 'invalid_grant',
        'Invalid refresh token', undefined, corsHeaders);
    }
  }

  // GoTrue path: existing sid-based flow (unchanged)
  let claims;
  try {
    claims = jwt.verifyToken(refresh_token);
  } catch {
    return errorResponse(401, 'invalid_grant',
      'Invalid refresh token', undefined, corsHeaders);
  }
  // ... rest of existing code unchanged ...
}
```

Note: `getProvider()` is moved before the JWT verification so we
can check `needsSessionTable` first. This is safe — getProvider
is idempotent and cached on `ctx.authProvider`.

## Test requirements

- Existing refresh grant tests in `handler.test.mjs` must still
  pass (they use a mock provider that should have
  `needsSessionTable: true` after Task 03 updates).

## Acceptance criteria

- Tests 6, 7 (Cognito refresh grant) pass.
- Test 11 (GoTrue refresh grant) passes.
- All existing refresh grant tests in `handler.test.mjs` pass.

## Conflict criteria

- If all target tests already pass before changes, investigate
  whether the tests are true positives.
- If existing refresh tests break, verify the mock provider has
  `needsSessionTable: true` (from Task 03).
