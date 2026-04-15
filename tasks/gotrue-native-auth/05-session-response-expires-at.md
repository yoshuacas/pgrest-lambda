# Task 05: Add `expires_at` to Session Response

**Agent:** implementer
**Design:** docs/design/gotrue-native-auth.md
**Depends on:** None (can run in parallel with Tasks 04, 06-08)

## Objective

Add the `expires_at` field (Unix epoch seconds) to the session
response in `src/auth/gotrue-response.mjs`. This applies to
all providers (GoTrue and Cognito) since it is in the shared
response module. supabase-js v2.39+ uses this field for
proactive token refresh.

## Target Tests

From Task 01, added to `src/auth/__tests__/gotrue-response.test.mjs`:

- `sessionResponse` includes `expires_at` as Unix epoch seconds

## Implementation

**Modified: `src/auth/gotrue-response.mjs`**

In the `sessionResponse` function, add `expires_at` to the
response body object, after `expires_in`:

```javascript
export function sessionResponse(accessToken, refreshToken, user) {
  return {
    statusCode: 200,
    headers: corsHeaders(),
    body: JSON.stringify({
      access_token: accessToken,
      token_type: 'bearer',
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      refresh_token: refreshToken,
      user: formatUser(user),
    }),
  };
}
```

This is a backward-compatible addition — no fields are removed
or renamed. The existing tests assert individual fields
(`body.access_token`, `body.expires_in`, etc.) without using
`deepEqual` on the full body, so the new field does not break
them.

## Test Requirements

No additional tests beyond the one added in Task 01. The
existing `gotrue-response.test.mjs` tests continue to pass
as-is; the new test validates `expires_at`.

## Acceptance Criteria

- `sessionResponse` includes `expires_at` in the response body.
- `expires_at` is `Math.floor(Date.now() / 1000) + 3600`.
- The new test in `gotrue-response.test.mjs` passes.
- All existing `gotrue-response.test.mjs` tests still pass.
- `npm test` passes.

## Conflict Criteria

- If `expires_at` is already present in the session response,
  investigate whether this task was already completed.
- If all target tests already pass before any code changes
  are made, investigate whether the tests are true positives
  before marking the task complete.
