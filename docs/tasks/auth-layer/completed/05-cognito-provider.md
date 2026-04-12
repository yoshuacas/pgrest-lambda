# Task 05: Auth Provider Interface and Cognito Provider

**Agent:** implementer
**Design:** docs/design/auth-layer.md

## Objective

Create the auth provider interface and Cognito provider that
wraps the Cognito SDK with GoTrue-compatible error mapping.

## Target Tests

From `__tests__/cognito-provider.test.mjs`:
- signUp sends SignUpCommand with correct params
- signUp returns user with id from UserSub
- signUp maps UsernameExistsException to user_already_exists
- signUp maps InvalidPasswordException to weak_password
- signIn sends InitiateAuthCommand with USER_PASSWORD_AUTH
- signIn returns user and providerTokens
- signIn maps NotAuthorizedException to invalid_grant
- signIn maps UserNotFoundException to invalid_grant
- refreshToken sends InitiateAuthCommand with
  REFRESH_TOKEN_AUTH
- refreshToken returns user and new providerTokens
- refreshToken maps expired token to invalid_grant
- getUser sends GetUserCommand and returns user attributes
- signOut returns void without calling Cognito
- signUp maps InvalidParameterException to validation_failed
- signIn maps CodeMismatchException to invalid_grant
- createProvider throws for unknown AUTH_PROVIDER value

## Implementation

### providers/interface.mjs

Create
`plugin/lambda-templates/auth/providers/interface.mjs`
with JSDoc type definitions for `AuthUser` and
`AuthProvider`, plus a `createProvider()` factory that
reads `AUTH_PROVIDER` env var (default: `"cognito"`) and
dynamically imports the provider module.

### providers/cognito.mjs

Create
`plugin/lambda-templates/auth/providers/cognito.mjs`
using `@aws-sdk/client-cognito-identity-provider`.

**Methods:**

| Method | SDK Command | Notes |
|--------|------------|-------|
| `signUp(email, password)` | `SignUpCommand` | Returns `{id: UserSub, email, ...}` |
| `signIn(email, password)` | `InitiateAuthCommand` (USER_PASSWORD_AUTH) | Returns `{user, providerTokens}` |
| `refreshToken(token)` | `InitiateAuthCommand` (REFRESH_TOKEN_AUTH) | Returns `{user, providerTokens}` |
| `getUser(accessToken)` | `GetUserCommand` | Returns user from attributes |
| `signOut(accessToken)` | No-op | Returns void |

**Error mapping:**

| Cognito Exception | GoTrue Error |
|-------------------|-------------|
| UsernameExistsException | user_already_exists |
| NotAuthorizedException | invalid_grant |
| UserNotFoundException | invalid_grant |
| InvalidPasswordException | weak_password |
| InvalidParameterException | validation_failed |
| CodeMismatchException | invalid_grant |
| Other | unexpected_failure |

**Environment variables:**
- `REGION_NAME` - AWS region
- `USER_POOL_CLIENT_ID` - Cognito app client ID

### package.json

Add `@aws-sdk/client-cognito-identity-provider` to
`plugin/lambda-templates/package.json`:
```json
"@aws-sdk/client-cognito-identity-provider": "^3.0.0"
```

## Acceptance Criteria

- All cognito-provider.test.mjs tests pass.
- `@aws-sdk/client-cognito-identity-provider` is in
  package.json.
- Existing tests still pass.

## Conflict Criteria

- If all target tests already pass before any code changes
  are made, investigate whether the tests are true positives
  before marking the task complete.
- If the Cognito SDK API differs from what's described
  (e.g., `InitiateAuthCommand` response shape), escalate
  with details about the mismatch.
