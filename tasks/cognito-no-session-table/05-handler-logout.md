# Task 05 — Branch Handler Logout on needsSessionTable

Agent: implementer
Design: docs/design/cognito-no-session-table.md
Depends on: Task 02

## Objective

Modify `handleLogout` in `src/auth/handler.mjs` to skip
database session revocation when the provider has
`needsSessionTable: false`. The provider's `signOut` method
should still be called.

## Target tests

- Test 8: Cognito logout does not revoke database sessions
- Test 12: GoTrue logout revokes database sessions

## Implementation

### src/auth/handler.mjs — handleLogout (around line 270)

Currently the logout handler always calls `revokeUserSessions`
on the database pool. When `needsSessionTable` is false, skip
the database call but still call `prov.signOut`.

```js
async function handleLogout(event, corsHeaders) {
  const authHeader =
    event.headers?.Authorization
    || event.headers?.authorization || '';

  if (authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    try {
      const claims = jwt.verifyToken(token);
      const prov = await getProvider();
      if (prov.needsSessionTable) {
        const pool = await ctx.db.getPool();
        await revokeUserSessions(pool, claims.sub);
      }
      await prov.signOut(claims.sub);
    } catch {
      // Best-effort
    }
  }

  return logoutResponse(corsHeaders);
}
```

## Test requirements

- Existing logout tests in `handler.test.mjs` must still pass.
  The existing test "Logout: revokes all user sessions" uses a
  mock provider that (after Task 03) has
  `needsSessionTable: true`, so it should continue to assert
  session revocation.

## Acceptance criteria

- Test 8 (Cognito logout no DB queries) passes.
- Test 12 (GoTrue logout revokes sessions) passes.
- All existing logout tests in `handler.test.mjs` pass.

## Conflict criteria

- If all target tests already pass before changes, investigate
  whether the tests are true positives.
