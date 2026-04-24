# JWT Secret Strength Enforcement

## Overview

Enforce minimum strength requirements on `JWT_SECRET` so that
pgrest-lambda refuses to start with a missing, non-string, or
short secret. This closes security finding V-01 (Critical).

The fix adds a shared validation helper, calls it at two seams
(factory construction and `createJwt`), and surfaces a clear,
actionable error before any tokens are signed or verified.
Correctly-configured deployments (secret >= 32 characters) see
no behavioral change.

**Key threshold:** 32 characters. For ASCII secrets (the
normal case), 32 characters = 32 bytes = 256 bits, which is
the minimum key size for HS256 per RFC 7518 Section 3.2. The
validation checks `string.length`, which counts UTF-16 code
units — for any reasonable secret (ASCII, base64), this equals
the byte count.

## Current CX / Concepts

### No Validation at Any Layer

`src/index.mjs:64` resolves the secret as
`config.jwtSecret || process.env.JWT_SECRET` with no checks.
The value can be `undefined`, `""`, or `"secret"` and the
factory proceeds without error.

`src/auth/jwt.mjs:6-7` reads `config.jwtSecret` and passes
it directly to `jsonwebtoken`'s `sign` and `verify`. The
library accepts any string, including empty strings.

`src/authorizer/index.mjs:8` reads `config.jwtSecret` on
construction and uses it in `jwt.verify`. No validation.

### Consequence

An operator can deploy with `JWT_SECRET=secret` and the system
boots, signs tokens, and verifies them. An attacker can brute-
force the secret offline from any captured token, then forge
`service_role` tokens for full data access.

### Existing Test Behavior

Several existing test files use secrets shorter than 32
characters. All must be updated:

- `src/auth/__tests__/jwt.test.mjs:138` — creates
  `createJwt({ jwtSecret: 'wrong-secret-key' })` (16 chars)
  to test cross-secret verification failure.
- `src/authorizer/__tests__/index.test.mjs:6` — uses
  `SECRET = 'test-secret-key-for-unit-tests'` (30 chars).
  Line 79 creates `createAuthorizer({ jwtSecret: undefined })`
  to verify fail-closed behavior at verify time.
- `src/auth/__tests__/handler.test.mjs:6` — uses
  `TEST_SECRET = 'test-secret-for-handler'` (23 chars).
- `src/auth/__tests__/authorizer.test.mjs:6` — uses
  `TEST_SECRET = 'test-secret-for-authorizer-tests'` (32
  chars — exactly at the boundary, OK).
- `src/auth/__tests__/integration.test.mjs:8` — uses
  `TEST_SECRET = 'integration-test-secret-key-1234'` (31
  chars — one short).

All must be updated to use secrets >= 32 chars. The
undefined-secret test in the authorizer must be updated to
expect the error at construction time rather than at verify
time.

## Proposed CX / CX Specification

### Validation Rules

A JWT secret is valid if and only if ALL hold:

1. Present (not `undefined`, not `null`)
2. Type is `string`
3. Length >= 32 characters (256 bits for ASCII/base64 secrets,
   per RFC 7518 Section 3.2)

### Error on Missing Secret

When `JWT_SECRET` is absent or `undefined`:

```
pgrest-lambda: JWT secret is required. Set the JWT_SECRET
environment variable or pass jwtSecret in the config. Generate
one with: openssl rand -base64 48
```

### Error on Non-String Secret

When the value is not a string (e.g., a number):

```
pgrest-lambda: JWT secret must be a string. Got number.
```

### Error on Short Secret

When the secret is present but shorter than 32 characters:

```
pgrest-lambda: JWT secret is too short (got 6 characters,
minimum is 32). Generate a strong secret with:
openssl rand -base64 48
```

### Error Surface

- Error class: plain `Error`.
- Prefix: `pgrest-lambda:` on every message.
- The secret value is never logged or included in the message.
  Only the length and type are disclosed.
- The error is thrown, not logged-and-continued.

### Where Errors Surface

| Consumer entry point | When the error fires |
|---|---|
| `createPgrest(config)` | At construction, before any subsystem is created |
| `createJwt(config)` (direct) | At factory call time, before returning sign/verify functions |
| `createAuthorizer(config)` | At construction, before the handler is returned |

### No Change for Valid Secrets

A deployment with a 32+ character secret sees zero behavioral
change. No new log output, no new latency, no new env vars.

### Documentation Update

The README config table for `jwtSecret` / `JWT_SECRET` gains
a note: "Must be >= 32 characters. Generate with
`openssl rand -base64 48`."

## Technical Design

### Shared Validation Helper

**New export in `src/auth/jwt.mjs`:**

```javascript
export function assertJwtSecret(secret) {
  if (secret === undefined || secret === null) {
    throw new Error(
      'pgrest-lambda: JWT secret is required. Set the '
      + 'JWT_SECRET environment variable or pass jwtSecret '
      + 'in the config. Generate one with: '
      + 'openssl rand -base64 48'
    );
  }
  if (typeof secret !== 'string') {
    throw new Error(
      'pgrest-lambda: JWT secret must be a string. '
      + `Got ${typeof secret}.`
    );
  }
  if (secret.length < 32) {
    throw new Error(
      'pgrest-lambda: JWT secret is too short '
      + `(got ${secret.length} characters, minimum is 32). `
      + 'Generate a strong secret with: '
      + 'openssl rand -base64 48'
    );
  }
}
```

The helper lives in `src/auth/jwt.mjs` alongside `createJwt`
rather than a new file — it is small (< 20 lines) and tightly
coupled to the JWT module. Both `src/index.mjs` and
`src/authorizer/index.mjs` import it from the same location.

### Defense-in-Depth in `createJwt`

`src/auth/jwt.mjs` — call `assertJwtSecret(secret)` once at
factory construction time, before the closures are created:

```javascript
export function createJwt(config) {
  const secret = config.jwtSecret;
  assertJwtSecret(secret);

  function signAccessToken({ sub, email }) { ... }
  function signRefreshToken(sub, providerRefreshToken) { ... }
  function verifyToken(token) { ... }

  return { signAccessToken, signRefreshToken, verifyToken };
}
```

No per-call overhead. The check runs once.

### Factory Validation in `resolveConfig`

`src/index.mjs` — add the assertion inside `createPgrest`
immediately after `resolveConfig` returns, before creating
any subsystem:

```javascript
import { createJwt, assertJwtSecret } from './auth/jwt.mjs';

export function createPgrest(config = {}) {
  const resolved = resolveConfig(config);
  assertJwtSecret(resolved.jwtSecret);

  // ... rest of factory
}
```

The check in `createPgrest` fires first. The check in
`createJwt` is defense-in-depth for consumers who call
`createJwt` directly.

### Authorizer Validation

`src/authorizer/index.mjs` — import `assertJwtSecret` and
call it at the top of `createAuthorizer`:

```javascript
import { assertJwtSecret } from '../auth/jwt.mjs';

export function createAuthorizer(config) {
  assertJwtSecret(config.jwtSecret);

  async function handler(event) { ... }
  return { handler };
}
```

This catches the Lambda authorizer cold-start path. Since the
authorizer is also constructed inside `createPgrest` (which
already validated), the check is redundant for the factory
path — but standalone authorizer consumers get the guarantee.

### Existing Test Updates

**`src/auth/__tests__/jwt.test.mjs`:**

Line 138 creates `createJwt({ jwtSecret: 'wrong-secret-key' })`
(16 chars). Update to use a 32+ char secret that differs from
`TEST_SECRET`:

```javascript
const wrongJwt = createJwt({
  jwtSecret: 'different-secret-key-for-jwt-tests-999',
});
```

**`src/authorizer/__tests__/index.test.mjs`:**

Line 6 uses `SECRET = 'test-secret-key-for-unit-tests'` (30
chars). Update to 32+ chars:

```javascript
const SECRET =
  'test-secret-key-for-unit-tests-ok';
```

Line 79-87 tests `createAuthorizer({ jwtSecret: undefined })`
expecting `'Unauthorized'` at verify time. After this change,
`createAuthorizer` throws at construction. Update the test to
assert the throw at construction time:

```javascript
it('throws at construction when jwtSecret is missing', () => {
  assert.throws(
    () => createAuthorizer({ jwtSecret: undefined }),
    (err) => err.message.includes('JWT secret is required'),
  );
});
```

**`src/auth/__tests__/handler.test.mjs`:**

Line 6 uses `TEST_SECRET = 'test-secret-for-handler'` (23
chars). Update to 32+ chars:

```javascript
const TEST_SECRET =
  'test-secret-for-handler-unit-tests';
```

**`src/auth/__tests__/integration.test.mjs`:**

Line 8 uses
`TEST_SECRET = 'integration-test-secret-key-1234'` (31
chars — one short). Update to 32+ chars:

```javascript
const TEST_SECRET =
  'integration-test-secret-key-12345';
```

## Code Architecture / File Changes

### Modified Files

| File | Change |
|---|---|
| `src/auth/jwt.mjs` | Add `assertJwtSecret` export; call it in `createJwt` |
| `src/index.mjs` | Import `assertJwtSecret`; call after `resolveConfig` |
| `src/authorizer/index.mjs` | Import `assertJwtSecret`; call in `createAuthorizer` |
| `src/auth/__tests__/jwt.test.mjs` | Update test secret to 32+ chars |
| `src/authorizer/__tests__/index.test.mjs` | Update `SECRET` to 32+ chars; update undefined-secret test |
| `src/auth/__tests__/handler.test.mjs` | Update `TEST_SECRET` to 32+ chars |
| `src/auth/__tests__/integration.test.mjs` | Update `TEST_SECRET` to 32+ chars |
| `README.md` | Add minimum-length note to config table |
| `docs/security/findings/V-01-jwt-secret-strength.md` | Status -> Fixed; fill Decision, Evidence, Residual risk, Reviewer handoff |
| `docs/security/assessment.md` | V-01 status Open -> Fixed |

### New Files

| File | Purpose | ~Lines |
|---|---|---|
| `src/auth/__tests__/assert-jwt-secret.test.mjs` | Unit tests for `assertJwtSecret` | 60 |

### Files That Do NOT Change

- `src/auth/jwt.mjs` internal signing/verification logic —
  unchanged beyond adding the assertion at the top of
  `createJwt`.
- `src/auth/handler.mjs` — no change; it receives the jwt
  object from the factory.
- `src/auth/providers/*` — no change; providers do not
  interact with the secret directly.
- `src/rest/**` — no change.

## Testing Strategy

### Unit Tests: `src/auth/__tests__/assert-jwt-secret.test.mjs`

Tests for `assertJwtSecret` directly:

| Input | Expected |
|---|---|
| `undefined` | Throws, message includes "required" |
| `null` | Throws, message includes "required" |
| `''` | Throws, message includes "too short" and "0 characters" |
| `'secret'` | Throws, message includes "too short" and "6 characters" |
| `'a'.repeat(31)` | Throws, message includes "too short" and "31 characters" |
| `'a'.repeat(32)` | Does not throw |
| `'a'.repeat(100)` | Does not throw |
| `123` | Throws, message includes "must be a string" and "number" |
| `true` | Throws, message includes "must be a string" and "boolean" |
| `{}` | Throws, message includes "must be a string" and "object" |

All error messages must start with `pgrest-lambda:`. No error
message may contain the secret value itself.

> Warning: The "does not throw" assertions are trivially
> satisfiable. The implementing agent should verify that the
> function actually returns (or returns undefined) rather than
> simply not throwing a different error.

### Integration: `createJwt` Rejects Weak Secrets

Test in `src/auth/__tests__/jwt.test.mjs` (new describe block):

```
createJwt({ jwtSecret: undefined })  -> throws "required"
createJwt({ jwtSecret: 'short' })    -> throws "too short"
createJwt({ jwtSecret: 'a'.repeat(32) })
                                     -> returns object with
                                        signAccessToken,
                                        signRefreshToken,
                                        verifyToken
```

### Integration: `createPgrest` Rejects Weak Secrets

Test in existing or new test file:

```
createPgrest({ jwtSecret: 'short' })  -> throws "too short"
createPgrest({ jwtSecret: 'a'.repeat(32), ... })
                                      -> constructs (with a
                                         valid db config)
```

> Warning: `createPgrest` with a valid secret also needs a
> valid database config to avoid unrelated errors. The test
> should provide minimal database config
> (`database: { host: 'localhost' }`) or mock the db layer.
> The implementing agent should verify that the test isolates
> the JWT secret validation from database connection errors.

### Integration: `createAuthorizer` Rejects Weak Secrets

Update `src/authorizer/__tests__/index.test.mjs`:

```
createAuthorizer({ jwtSecret: undefined })
  -> throws at construction, message includes "required"
createAuthorizer({ jwtSecret: 'short' })
  -> throws at construction, message includes "too short"
```

### Existing Tests Must Still Pass

All existing tests in the following files must continue to
pass after updating their test secrets to 32+ characters:

- `src/auth/__tests__/jwt.test.mjs`
- `src/authorizer/__tests__/index.test.mjs`
- `src/auth/__tests__/handler.test.mjs`
- `src/auth/__tests__/authorizer.test.mjs`
- `src/auth/__tests__/integration.test.mjs`

Verification: `npm test`

## Implementation Order

### Phase 1: Validation Helper + Tests

1. Add `assertJwtSecret` to `src/auth/jwt.mjs` (exported).
2. Call `assertJwtSecret` inside `createJwt` at the top.
3. Create `src/auth/__tests__/assert-jwt-secret.test.mjs`
   with all helper test cases.
4. Add `createJwt` rejection tests to
   `src/auth/__tests__/jwt.test.mjs`.
5. Update `TEST_SECRET` in `jwt.test.mjs` to 32+ chars (it
   already is: 41 chars). Update `'wrong-secret-key'` on
   line 138 to a 32+ char alternative.
6. Verify: `node --test src/auth/__tests__/assert-jwt-secret.test.mjs src/auth/__tests__/jwt.test.mjs`

### Phase 2: Factory + Authorizer

7. Import `assertJwtSecret` in `src/index.mjs`; call it
   after `resolveConfig`.
8. Import `assertJwtSecret` in `src/authorizer/index.mjs`;
   call it in `createAuthorizer`.
9. Update `SECRET` in
   `src/authorizer/__tests__/index.test.mjs` to 32+ chars.
10. Update the undefined-secret test to assert construction-
    time throw.
11. Add short-secret construction test.
12. Update `TEST_SECRET` in
    `src/auth/__tests__/handler.test.mjs` to 32+ chars.
13. Update `TEST_SECRET` in
    `src/auth/__tests__/integration.test.mjs` to 32+ chars.
14. Verify: `npm test`

### Phase 3: Documentation

15. Update `README.md` config table — add minimum-length
    note for `jwtSecret` / `JWT_SECRET`.
16. Update `docs/security/findings/V-01-jwt-secret-strength.md`
    — Status, Decision, Evidence, Residual risk, Reviewer
    handoff.
17. Update `docs/security/assessment.md` — V-01 status to
    Fixed.

## Open Questions

None. The validation rules, error messages, and enforcement
points are fully specified. The 32-character minimum is
aligned with the audit recommendation and the HS256 security
floor (256-bit key per RFC 7518 Section 3.2).

**Resolved during design:** The validation uses
`string.length` (UTF-16 code units), not byte length. For
ASCII and base64 secrets — the only realistic inputs — these
are identical. A multi-byte UTF-8 secret would have
`string.length <= byte_length`, so the check is conservative
(never weaker than 256 bits). No special handling needed.
