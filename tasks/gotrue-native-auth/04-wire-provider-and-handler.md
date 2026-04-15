# Task 04: Wire Up Provider Interface and Handler

**Agent:** implementer
**Design:** docs/design/gotrue-native-auth.md
**Depends on:** Task 03 (GoTrue provider)

## Objective

Modify `src/auth/providers/interface.mjs` and
`src/auth/handler.mjs` to support the GoTrue provider and
pass the database reference through the provider factory.

## Target Tests

From Task 01 and existing tests:

- Existing `src/auth/__tests__/handler.test.mjs` tests
  continue to pass (mock provider is provider-agnostic).
- Existing `src/auth/__tests__/integration.test.mjs` tests
  continue to pass (uses explicit `provider: 'cognito'`
  config with mock provider).

## Implementation

### 1. `src/auth/providers/interface.mjs`

Three changes to `createProvider`:

**a. Add `db` parameter:**
```javascript
export async function createProvider(config, db) {
```

**b. Change default from `'cognito'` to `'gotrue'`:**
```javascript
const name = config.provider || 'gotrue';
```

**c. Add `case 'gotrue'`:**
```javascript
case 'gotrue': {
  const { createGoTrueProvider } =
    await import('./gotrue.mjs');
  return createGoTrueProvider(config, db);
}
```

The existing `case 'cognito'` is unchanged — it ignores the
`db` parameter.

**d. Update JSDoc:** Document that `getUser` parameter
semantics are provider-specific: Cognito treats it as an
access token, GoTrue treats it as a user ID.

### 2. `src/auth/handler.mjs`

One-line change at line 42. Change:

```javascript
const result = await createProvider(config.auth);
```

to:

```javascript
const result = await createProvider(config.auth, ctx.db);
```

The handler already has `ctx.db` in scope (set by
`src/index.mjs` line 103). The Cognito provider's
`createCognitoProvider` ignores the `db` parameter, so
existing Cognito behavior is unchanged.

### 3. `src/index.mjs`

One-line change at line 51. Change:

```javascript
provider: process.env.AUTH_PROVIDER || 'cognito',
```

to:

```javascript
provider: process.env.AUTH_PROVIDER || 'gotrue',
```

## Test Requirements

No new tests. The existing handler and integration tests
validate that the wiring works. The handler tests use a mock
provider injected via `_setProvider`, so the default provider
name change does not affect them. The integration tests pass
explicit `provider: 'cognito'` config.

**Verification that existing tests are unaffected:**

- `handler.test.mjs` — injects mock provider via
  `_setProvider`, bypassing `createProvider` entirely.
  The `config.auth.provider` value does not matter.
- `integration.test.mjs` — injects mock provider via
  `_setProvider`. The config specifies
  `{ provider: 'cognito' }` but the mock overrides it.
- `cognito-provider.test.mjs` — tests `createCognitoProvider`
  directly. No interface.mjs involvement.

## Acceptance Criteria

- `createProvider` accepts `(config, db)` and defaults to
  `'gotrue'`.
- `createProvider({ provider: 'gotrue' }, db)` returns a
  GoTrue provider.
- `createProvider({ provider: 'cognito' })` still returns a
  Cognito provider.
- Handler passes `ctx.db` to `createProvider`.
- Default auth provider in `src/index.mjs` is `'gotrue'`.
- All existing tests pass: `npm test`.

## Conflict Criteria

- If `createProvider` already accepts a `db` parameter,
  escalate — the design assumes it does not.
- If the default provider in `interface.mjs` is already
  `'gotrue'`, investigate whether this task was already
  completed.
- If all target tests already pass before any code changes
  are made, investigate whether the tests are true positives
  before marking the task complete.
