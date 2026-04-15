# Task 01: End-to-End Tests for GoTrue-Native Auth

**Agent:** implementer
**Design:** docs/design/gotrue-native-auth.md

## Objective

Write all test files for the GoTrue-native auth feature. Tests
cover the schema initialization module, the GoTrue provider, the
`expires_at` addition to session responses, and the updated
provider interface wiring. All tests must compile and all tests
must fail (since the implementation does not exist yet).

## Test Files

### 1. `src/auth/__tests__/schema.test.mjs`

Uses `node:test` and `node:assert/strict`. Tests the
`ensureAuthSchema` function from `src/auth/schema.mjs`.

**Test cases:**

#### `ensureAuthSchema`

- **executes all DDL statements in order**: Create a mock pool
  with a `query` method that records calls. Call
  `ensureAuthSchema(pool)`. Assert that `pool.query` was called
  once for each element in `AUTH_SCHEMA_SQL`, in order. Verify
  the first call is `CREATE SCHEMA IF NOT EXISTS auth` and that
  table and index creation follows.

- **is a no-op on second call**: Call `ensureAuthSchema(pool)`
  twice. Assert that the second call produces zero additional
  `pool.query` calls. The module-level `initialized` flag
  prevents re-execution.

- **re-executes after _resetInitialized**: Call
  `ensureAuthSchema(pool)`, then call `_resetInitialized()`,
  then call `ensureAuthSchema(pool)` again. Assert that the
  third call executes all DDL statements again (the mock pool
  records a second round of calls).

### 2. `src/auth/__tests__/gotrue-provider.test.mjs`

Uses `node:test` and `node:assert/strict`. Tests the GoTrue
provider created by `createGoTrueProvider` from
`src/auth/providers/gotrue.mjs`.

The test must import `_resetInitialized` from
`src/auth/schema.mjs` and call it in a `beforeEach` hook to
ensure schema initialization runs for each test.

All tests use a mock `db` object with a `getPool()` method
that returns a mock pool. The mock pool's `query` method
returns canned results based on the SQL text received.

**Test cases:**

#### `signUp`

- **returns AuthUser with correct fields**: Mock pool returns
  a RETURNING row with `id` (UUID), `email`, `app_metadata`,
  `user_metadata`, `created_at`. Assert the returned object
  has all five fields with correct values.

- **hashes password with bcrypt before INSERT**: Spy on the
  mock pool's `query` calls. The INSERT params should contain
  a bcrypt hash (starts with `$2a$` or `$2b$`), not the
  plaintext password.

- **throws user_already_exists on duplicate email**: Mock pool
  throws `{ code: '23505' }` on INSERT. Assert the thrown
  error has `code === 'user_already_exists'`.

- **throws weak_password with reasons=['length'] for short
  password**: Call `signUp('a@b.com', 'Short1')` (6 chars).
  Assert thrown error has `code === 'weak_password'` and
  `reasons` includes `'length'`.

- **throws weak_password with reasons=['uppercase'] when
  missing uppercase**: Call `signUp('a@b.com', 'lowercase1')`.
  Assert `reasons` includes `'uppercase'`.

- **throws weak_password with reasons=['lowercase'] when
  missing lowercase**: Call `signUp('a@b.com', 'UPPERCASE1')`.
  Assert `reasons` includes `'lowercase'`.

- **throws weak_password with reasons=['number'] when missing
  number**: Call `signUp('a@b.com', 'NoNumber!')`.
  Assert `reasons` includes `'number'`.

- **throws weak_password with multiple reasons**: Call
  `signUp('a@b.com', 'short')`. Assert `reasons` contains
  both `'length'` and `'uppercase'` and `'number'`.

- **calls ensureAuthSchema before INSERT**: Check the mock
  pool's query log. The DDL statements from `AUTH_SCHEMA_SQL`
  must appear before the INSERT.

  > Warning: A successful signUp could occur without
  > schema init if the test mock does not enforce the
  > schema existence. Check the query log explicitly.

#### `signIn`

- **returns user and providerTokens for valid credentials**:
  Mock pool returns a user row. `bcrypt.compare` succeeds.
  Assert result has `user` with correct fields and
  `providerTokens.refreshToken` as a base64url string.

- **inserts a refresh token row**: After successful signIn,
  assert the mock pool received an INSERT into
  `auth.refresh_tokens` with `token` and `user_id` params.

- **throws invalid_grant for wrong password**: Mock pool
  returns a user row but `bcrypt.compare` fails (the mock
  pool returns a row with a hash that doesn't match).
  Assert thrown error has `code === 'invalid_grant'`.

- **throws invalid_grant for nonexistent user and performs
  dummy bcrypt compare**: Mock pool returns zero rows for
  the SELECT. Assert thrown error has
  `code === 'invalid_grant'`. Verify that `bcrypt.compare`
  was still called (via spy/mock) to ensure timing safety.

  > Warning: The timing-safe test is inherently
  > non-deterministic. Verify `bcrypt.compare` was called
  > via mock/spy rather than measuring wall-clock timing.

- **calls ensureAuthSchema before SELECT**: Check query log
  ordering.

#### `refreshToken`

- **returns new user and providerTokens with rotated token**:
  Mock pool returns a non-revoked token row, then a user row.
  Assert result has `user` with correct fields and
  `providerTokens.refreshToken` that differs from the input
  token. Assert the new token INSERT has
  `parent = oldToken`.

- **revokes old token on successful refresh**: After
  successful refresh, assert mock pool received an UPDATE
  setting `revoked = true` on the old token's `id`.

- **triggers family revocation and throws invalid_grant on
  revoked token reuse**: Mock pool returns a token row with
  `revoked = true`. Assert an UPDATE sets `revoked = true`
  for ALL tokens belonging to that `user_id`. Assert thrown
  error has `code === 'invalid_grant'`.

- **throws invalid_grant for nonexistent token**: Mock pool
  returns zero rows for the token SELECT. Assert thrown error
  has `code === 'invalid_grant'`.

- **calls ensureAuthSchema before token lookup**: Check query
  log ordering.

#### `getUser`

- **returns AuthUser by ID**: Mock pool returns a user row
  for `SELECT ... WHERE id = $1`. Assert the returned object
  has `id`, `email`, `app_metadata`, `user_metadata`,
  `created_at`.

#### `signOut`

- **returns undefined (no-op)**: Call `signOut()`. Assert
  the return value is `undefined`.

### 3. Update `src/auth/__tests__/gotrue-response.test.mjs`

Add a test to the existing `sessionResponse` describe block:

- **includes expires_at as Unix epoch seconds**: Call
  `sessionResponse('at', 'rt', user)`. Parse the body.
  Assert `body.expires_at` is a number. Assert it is within
  2 seconds of `Math.floor(Date.now() / 1000) + 3600`.

  > Warning: The `expires_at` value depends on
  > `Date.now()`. Assert within a tolerance range
  > (e.g., within 2 seconds of expected).

## Test Infrastructure Notes

- All test files use `node:test` (describe/it/beforeEach)
  and `node:assert/strict`. No external test frameworks.
- Mock pool pattern: `{ query: async (sql, params) => ... }`
  that returns `{ rows: [...] }`.
- Mock db pattern: `{ getPool: async () => mockPool }`.
- For bcrypt spy in signIn timing-safe tests, use a mock
  module or intercept the call. Since bcryptjs is a
  dependency, one approach is to verify the query log shows
  no SELECT returned rows but the response time is not
  suspiciously fast. A better approach: mock `bcrypt.compare`
  and assert it was called with the password and `DUMMY_HASH`.

## Acceptance Criteria

- All three test files parse and compile:
  `node --check src/auth/__tests__/schema.test.mjs`
  `node --check src/auth/__tests__/gotrue-provider.test.mjs`
- All new tests fail with clear error messages (module not
  found or assertion failures), since the implementation
  does not exist yet.
- The `expires_at` test in `gotrue-response.test.mjs` also
  fails (field not yet added to the response).
- Existing tests that do not depend on new code still pass:
  `node --test src/auth/__tests__/handler.test.mjs`

## Conflict Criteria

- If any test that is expected to fail instead passes, first
  diagnose why by following the "Unexpected test results"
  guidance: investigate the code path, verify the assertion
  targets the right behavior, and attempt to rewrite the
  test to isolate the intended path. Only escalate if you
  cannot construct a well-formed test that targets the
  desired behavior.
- If `src/auth/schema.mjs` or `src/auth/providers/gotrue.mjs`
  already exist, escalate — the design assumes they do not.
