# Task 02 — Add needsSessionTable Capability to Providers

Agent: implementer
Design: docs/design/cognito-no-session-table.md

## Objective

Add the `needsSessionTable` boolean property to the provider
interface and both provider implementations so the handler can
branch on it.

## Target tests

- Test 13: Provider needsSessionTable property is respected

## Implementation

### src/auth/providers/interface.mjs

Add a JSDoc property to the `AuthProvider` typedef:

```js
/**
 * @property {boolean} [needsSessionTable] - If true, the handler
 *   stores refresh tokens in auth.sessions and issues refresh JWTs
 *   with an opaque sid. If false or absent, the provider manages
 *   refresh state itself and the handler delegates refresh to
 *   provider.refreshToken directly.
 */
```

No runtime changes needed — this is a typedef-only file.

### src/auth/providers/cognito.mjs

Add `needsSessionTable: false` to the `provider` object literal
in `createCognitoProvider` (around line 63).

### src/auth/providers/gotrue.mjs

Add `needsSessionTable: true` to the `provider` object literal
in `createGoTrueProvider` (around line 209).

## Test requirements

- Existing tests in `cognito-provider.test.mjs` and
  `gotrue-provider.test.mjs` must still pass.
- Verify the property is present on provider objects returned
  by `createCognitoProvider` and `createGoTrueProvider`.

## Acceptance criteria

- `cognito.mjs` provider object has `needsSessionTable: false`.
- `gotrue.mjs` provider object has `needsSessionTable: true`.
- `interface.mjs` documents the property in the typedef.
- All existing provider tests pass.
- Test 13 from Task 01 passes.

## Conflict criteria

- If the provider objects already have a `needsSessionTable`
  property, investigate — the design assumes they do not.
