# Task 03: GoTrue Provider Implementation

**Agent:** implementer
**Design:** docs/design/gotrue-native-auth.md
**Depends on:** Task 02 (schema module)

## Objective

Create `src/auth/providers/gotrue.mjs` — the GoTrue-native auth
provider that stores users and refresh tokens in PostgreSQL.

## Target Tests

From Task 01, `src/auth/__tests__/gotrue-provider.test.mjs`:

- All `signUp` tests (8 tests)
- All `signIn` tests (5 tests)
- All `refreshToken` tests (5 tests)
- `getUser` returns AuthUser by ID
- `signOut` returns undefined (no-op)

## Implementation

### 1. Add bcryptjs dependency

Add `bcryptjs` to `package.json` dependencies:
```json
"bcryptjs": "^2.4.3"
```

Run `npm install` to install it. `bcryptjs` is a pure
JavaScript bcrypt implementation — no native compilation,
Lambda-safe on all architectures.

### 2. Create the provider

**New file: `src/auth/providers/gotrue.mjs`**

**Dependencies:**
- `import bcrypt from 'bcryptjs'` — pure JS bcrypt (CJS module,
  Node handles interop via default export).
- `import crypto from 'node:crypto'`
- `import { ensureAuthSchema } from '../schema.mjs'`

**Module constant — DUMMY_HASH:**
```javascript
// Pre-computed: bcrypt.hashSync('dummy-password', 10)
const DUMMY_HASH = '$2a$10$N9qo8uLOickgx2ZMRZoMye'
  + 'Ih9cvl6j5iHLbWb4Or/JtqKMZBHFwOC';
```
Must be a syntactically valid bcrypt hash so `bcrypt.compare`
performs a full comparison (not an early-exit error path).

**`createGoTrueProvider(config, db)`:**

Returns `{ provider, _setClient: null }` to match the shape
returned by `createCognitoProvider` (handler stores
`result._setClient` at `ctx.authProviderSetClient`).

**provider.signUp(email, password):**

1. `const pool = await db.getPool()`
2. `await ensureAuthSchema(pool)`
3. Validate password:
   ```javascript
   const reasons = [];
   if (password.length < 8) reasons.push('length');
   if (!/[A-Z]/.test(password)) reasons.push('uppercase');
   if (!/[a-z]/.test(password)) reasons.push('lowercase');
   if (!/[0-9]/.test(password)) reasons.push('number');
   if (reasons.length > 0) {
     const err = new Error('Weak password');
     err.code = 'weak_password';
     err.reasons = reasons;
     throw err;
   }
   ```
4. `const hash = await bcrypt.hash(password, 10)`
5. INSERT with RETURNING:
   ```sql
   INSERT INTO auth.users (email, encrypted_password)
   VALUES ($1, $2)
   RETURNING id, email, app_metadata, user_metadata, created_at
   ```
6. Catch PostgreSQL error code `23505` (unique violation) ->
   throw `{ code: 'user_already_exists' }`.
7. Return the AuthUser from the RETURNING row.

**provider.signIn(email, password):**

1. `const pool = await db.getPool()`
2. `await ensureAuthSchema(pool)`
3. SELECT user:
   ```sql
   SELECT id, email, encrypted_password, app_metadata,
          user_metadata, created_at
   FROM auth.users WHERE email = $1
   ```
4. If no row: timing-safe dummy compare:
   ```javascript
   await bcrypt.compare(password, DUMMY_HASH);
   const err = new Error('Invalid credentials');
   err.code = 'invalid_grant';
   throw err;
   ```
5. `const match = await bcrypt.compare(password, row.encrypted_password)`
6. If `!match` -> throw `{ code: 'invalid_grant' }`
7. Generate opaque refresh token:
   `crypto.randomBytes(16).toString('base64url')`
8. INSERT into `auth.refresh_tokens (token, user_id)
   VALUES ($1, $2)`
9. Return:
   ```javascript
   {
     user: { id, email, app_metadata, user_metadata, created_at },
     providerTokens: { refreshToken: opaqueToken },
   }
   ```

**provider.refreshToken(opaqueToken):**

1. `const pool = await db.getPool()`
2. `await ensureAuthSchema(pool)`
3. SELECT token:
   ```sql
   SELECT id, token, user_id, revoked
   FROM auth.refresh_tokens WHERE token = $1
   ```
4. If not found -> throw `{ code: 'invalid_grant' }`
5. If revoked -> family revocation:
   ```sql
   UPDATE auth.refresh_tokens SET revoked = true,
     updated_at = now() WHERE user_id = $1
     AND revoked = false
   ```
   Then throw `{ code: 'invalid_grant' }`
6. Generate new opaque token
7. INSERT new token with parent:
   ```sql
   INSERT INTO auth.refresh_tokens (token, user_id, parent)
   VALUES ($1, $2, $3)
   ```
8. Revoke old token:
   ```sql
   UPDATE auth.refresh_tokens SET revoked = true,
     updated_at = now() WHERE id = $1
   ```
9. Fetch user:
   ```sql
   SELECT id, email, app_metadata, user_metadata, created_at
   FROM auth.users WHERE id = $1
   ```
10. Return `{ user, providerTokens: { refreshToken: newToken } }`

**provider.getUser(userId):**

1. `const pool = await db.getPool()`
2. `await ensureAuthSchema(pool)`
3. SELECT by id, return AuthUser.

**provider.signOut():**

No-op. Return `undefined`.

## Test Requirements

No additional unit tests beyond Task 01. The gotrue-provider
test file covers all behaviors.

## Acceptance Criteria

- `src/auth/providers/gotrue.mjs` exports `createGoTrueProvider`.
- All tests in `src/auth/__tests__/gotrue-provider.test.mjs` pass.
- All tests in `src/auth/__tests__/schema.test.mjs` still pass.
- `npm test` passes (existing tests unaffected).

## Conflict Criteria

- If `src/auth/providers/gotrue.mjs` already exists, escalate.
- If all target tests already pass before any code changes are
  made, investigate whether the tests are true positives before
  marking the task complete.
- If `bcryptjs` is not yet in `package.json`, install it as
  part of this task: `npm install bcryptjs`.
