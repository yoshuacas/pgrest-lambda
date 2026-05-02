# V-09 — Sanitize PostgreSQL Error Details

Strip raw PostgreSQL error text from REST API responses to
close security finding V-09 (Medium). Preserve SQLSTATE
`code` for supabase-js compatibility.

Reference: `docs/security/findings/V-09-error-leaks.md`
Source: `docs/design/prompts/security-v09-pg-error-sanitize.md`

## Overview

`mapPgError` in `src/rest/errors.mjs:84-93` forwards the PG
driver's `message`, `detail`, and `hint` verbatim to the HTTP
response for every PG error with a recognized SQLSTATE code
(23505, 23503, 23502, 42P01, 42703). Unknown SQLSTATE codes
fall through to a 500 with the raw `message`.

This leaks constraint names, column names, and specific record
values. A 23505 unique-constraint violation produces detail
text like `Key (email)=(alice@example.com) already exists.`,
confirming both column names and record existence — the exact
schema-reconnaissance surface the auditor flagged.

The handler's catch-all for non-PG errors was already fixed in
sec/L-20 (generic message + `errorId`). This design addresses
the remaining `mapPgError` path.

## Current CX / Concepts

### Current error flow

When a PG query fails with a SQLSTATE code:

1. The `pg` driver throws an error with `code`, `message`,
   `detail`, `hint` fields.
2. The handler catch block at `handler.mjs:443-445` detects
   the 5-character `code` pattern and calls `mapPgError(err)`.
3. `mapPgError` looks up the HTTP status from `PG_ERROR_MAP`
   (five entries: 23505 -> 409, 23503 -> 409, 23502 -> 400,
   42P01 -> 404, 42703 -> 400) or falls back to 500.
4. It returns a `PostgRESTError` with the raw `message`,
   `detail`, and `hint` passed through unmodified.

### Current response shape

```json
{
  "code": "23505",
  "message": "duplicate key value violates unique constraint \"users_email_key\"",
  "details": "Key (email)=(alice@example.com) already exists.",
  "hint": null
}
```

This exposes: constraint name (`users_email_key`), column name
(`email`), and exact record value (`alice@example.com`).

### Engine-authored errors are safe

`PostgRESTError` instances thrown directly by the engine
(PGRST100, PGRST106, PGRST116, PGRST200, PGRST201, PGRST202,
PGRST203, PGRST204, PGRST205, PGRST207, PGRST208, PGRST209,
PGRST301, PGRST403, PGRST501, etc.) use developer-authored
messages that do not contain PG driver output. These are not
touched by this change.

## Proposed CX / CX Specification

### Sanitized mode (default)

When `errors.verbose` is `false` (the default), `mapPgError`
replaces the raw PG text with a generic per-SQLSTATE message.
The `details` and `hint` fields are set to `null`.

**Safe-message map:**

| SQLSTATE | HTTP | Safe message |
|----------|------|--------------|
| 23505 | 409 | `"Uniqueness violation."` |
| 23503 | 409 | `"Foreign key violation."` |
| 23502 | 400 | `"Not-null constraint violation."` |
| 42P01 | 404 | `"Undefined table."` |
| 42703 | 400 | `"Undefined column."` |
| (other) | 500 | `"Request failed with a database error."` |

**Sanitized response example (23505):**

```json
{
  "code": "23505",
  "message": "Uniqueness violation.",
  "details": null,
  "hint": null
}
```

**Sanitized response example (unknown code):**

```json
{
  "code": "XX000",
  "message": "Request failed with a database error.",
  "details": null,
  "hint": null
}
```

### Verbose mode

When `errors.verbose` is `true`, `mapPgError` preserves the
current behavior: raw `message`, `detail`, and `hint` pass
through unmodified. This mode is for local development and
debugging.

**Verbose response example (23505):**

```json
{
  "code": "23505",
  "message": "duplicate key value violates unique constraint \"users_email_key\"",
  "details": "Key (email)=(alice@example.com) already exists.",
  "hint": null
}
```

### Structured logging in sanitized mode

When a mapped PG error is sanitized, the handler logs the
raw error details server-side so operators can still debug
production issues. The log entry uses the same structured
format as the catch-all's `errorId` logging:

```json
{
  "level": "warn",
  "pgCode": "23505",
  "message": "duplicate key value violates unique constraint \"users_email_key\"",
  "detail": "Key (email)=(alice@example.com) already exists.",
  "hint": null
}
```

This is emitted at `warn` level (not `error`) because mapped
PG errors are expected operational events, not bugs.

### Configuration

The `errors.verbose` flag threads through the same config
path as other flags in `createPgrest`:

**Library usage:**

```javascript
const pgrest = createPgrest({
  database: { ... },
  jwtSecret: '...',
  errors: { verbose: true },
});
```

**Environment variable:**

```
PGREST_ERRORS_VERBOSE=true
```

Default: `false`. The dev server (`pgrest-lambda dev`) does
**not** flip this to `true` automatically — developers opt
in explicitly. This ensures the default local experience
matches production behavior so tests catch sanitization-
related regressions early.

### Wire compatibility with supabase-js

The `code` field is preserved exactly. supabase-js branches
on `code` (e.g., checking for `'23505'` to detect duplicate
inserts), not on `message` or `details`. This change is
invisible to client-side branching logic.

PostgREST itself forwards raw PG text, so sanitizing diverges
from upstream. This is intentional and documented.

### What does NOT change

- `PostgRESTError` instances thrown by engine code — messages
  are developer-authored and safe.
- The catch-all at `handler.mjs:451-464` — already emits a
  generic message with `errorId` (sec/L-20).
- The auth handler's error paths — tracked separately under
  V-18.
- The `code` field on all error responses — always preserved.

## Technical Design

### 1. Safe-message map in `errors.mjs`

Add a `PG_SAFE_MESSAGE` map alongside the existing
`PG_ERROR_MAP`:

```javascript
const PG_SAFE_MESSAGE = {
  '23505': 'Uniqueness violation.',
  '23503': 'Foreign key violation.',
  '23502': 'Not-null constraint violation.',
  '42P01': 'Undefined table.',
  '42703': 'Undefined column.',
};

const PG_SAFE_FALLBACK = 'Request failed with a database error.';
```

### 1b. Test-only map-key export in `errors.mjs`

Export a `_getMapKeys()` helper so tests can verify the
two maps stay in sync without exposing the maps directly:

```javascript
export function _getMapKeys() {
  return {
    errorMap: Object.keys(PG_ERROR_MAP).sort(),
    safeMessage: Object.keys(PG_SAFE_MESSAGE).sort(),
  };
}
```

### 2. Updated `mapPgError` signature

`mapPgError` gains a second parameter `{ verbose }`:

```javascript
export function mapPgError(pgError, { verbose = false } = {}) {
  const statusCode = PG_ERROR_MAP[pgError.code] || 500;

  if (verbose) {
    return new PostgRESTError(
      statusCode,
      pgError.code,
      pgError.message,
      pgError.detail || null,
      pgError.hint || null,
    );
  }

  const safeMessage =
    PG_SAFE_MESSAGE[pgError.code] || PG_SAFE_FALLBACK;
  return new PostgRESTError(
    statusCode,
    pgError.code,
    safeMessage,
    null,
    null,
  );
}
```

### 3. Handler call site

In `handler.mjs`, the catch block that calls `mapPgError`
passes the verbose flag from `ctx`:

```javascript
if (err.code && typeof err.code === 'string'
    && /^[0-9A-Z]{5}$/.test(err.code)) {
  if (!ctx.errorsVerbose) {
    console.warn(JSON.stringify({
      level: 'warn',
      pgCode: err.code,
      message: err.message,
      detail: err.detail || null,
      hint: err.hint || null,
    }));
  }
  return error(
    mapPgError(err, { verbose: ctx.errorsVerbose }),
    corsHeaders,
  );
}
```

The structured log is emitted **before** calling `mapPgError`
so the raw details are captured server-side. In verbose mode
the log is skipped because the raw details are already in the
response.

### 4. Config plumbing in `index.mjs`

In `resolveConfig`, add `errors.verbose`:

```javascript
function resolveConfig(config) {
  // ... existing ...
  return {
    // ... existing ...
    errorsVerbose: config.errors?.verbose
      ?? (process.env.PGREST_ERRORS_VERBOSE === 'true'),
  };
}
```

When `config.errors?.verbose` is `undefined` or `null`, the
`??` falls through to the env var check, which evaluates to
`true` or `false` (defaulting to `false` when the env var is
unset, since `undefined === 'true'` is `false`).

In `createPgrest`, attach to context:

```javascript
ctx.errorsVerbose = resolved.errorsVerbose;
```

### 5. Test harness: `createTestContext` default

In `handler.integration.test.mjs`, `createTestContext`
must set `errorsVerbose: false` explicitly in the returned
context object. Currently the property is absent and the
handler relies on `!undefined` being truthy. Adding the
explicit default protects against a future refactor that
uses strict comparison (`ctx.errorsVerbose === false`).

```javascript
return { db, schemaCache, cedar, errorsVerbose: false };
```

### 6. RPC error path

The RPC handler in `handleRpc` shares the same catch block
at the outer `handler` function scope (`handler.mjs:439`).
PG errors from RPC calls flow through the same
`mapPgError(err)` call site, so they are automatically
covered by this change.

## Code Architecture / File Changes

### Modified files

- **`src/rest/errors.mjs`**
  - Add `PG_SAFE_MESSAGE` map and `PG_SAFE_FALLBACK` constant.
  - Update `mapPgError` signature to accept `{ verbose }`.
  - When `verbose` is false, return safe message with null
    `details` and `hint`.
  - Export `_getMapKeys()` returning the key sets of
    `PG_ERROR_MAP` and `PG_SAFE_MESSAGE` for test-only
    map-sync verification.

- **`src/rest/handler.mjs`**
  - At the `mapPgError` call site (line 445), pass
    `{ verbose: ctx.errorsVerbose }`.
  - Add structured `console.warn` log of raw PG error
    details when not in verbose mode.

- **`src/index.mjs`**
  - Add `errorsVerbose` to `resolveConfig` output, reading
    from `config.errors?.verbose` with env var fallback
    `PGREST_ERRORS_VERBOSE`.
  - Attach `ctx.errorsVerbose` in `createPgrest`.

- **`src/rest/__tests__/errors.test.mjs`**
  - Add tests for sanitized mode (all 5 mapped codes +
    unmapped code).
  - Add tests for verbose mode passthrough.
  - Verify `code` is preserved in all cases.
  - Add map-sync guard test via `_getMapKeys()` (test 11).

- **`src/rest/__tests__/handler.integration.test.mjs`**
  - Add a test that triggers a PG error through the handler
    and verifies the response uses the safe message with
    null `details` and `hint`.
  - Add a test with verbose mode on that verifies raw
    passthrough.
  - Add test for verbose mode suppressing structured
    `console.warn` (test 15).
  - Add test for PG error with `hint` round-trip (test 16).
  - Set `errorsVerbose: false` explicitly in
    `createTestContext` return object. No behavior change;
    makes intent explicit and protects against a future
    strict-comparison refactor.

- **`CHANGELOG.md`**
  - Add entry under Unreleased > Security for V-09.

- **`docs/security/findings/V-09-error-leaks.md`**
  - Flip Status to Fixed.
  - Fill Evidence section with commit reference.
  - Update Our analysis to reflect the fix.

- **`docs/security/assessment.md`**
  - Flip V-09 row status from Open to Fixed.

- **`src/__tests__/index.test.mjs`** (new file)
  - Add `resolveConfig` / `errorsVerbose` tests (17–20)
    exercising `createPgrest` → `_ctx.errorsVerbose`.
  - Env-var tests save/restore
    `process.env.PGREST_ERRORS_VERBOSE` to avoid leakage.

### Not modified

- `src/auth/handler.mjs` — auth error paths are V-18 scope.
- `src/rest/response.mjs` — `error()` formats whatever
  `PostgRESTError.toJSON()` returns; no change needed.
- `PostgRESTError` class — unchanged; it already supports
  null `details` and `hint`.

## Testing Strategy

### Unit tests (`src/rest/__tests__/errors.test.mjs`)

**Sanitized mode (default):**

1. **23505 → safe message, null details/hint.**
   Given a PG error `{ code: '23505', message: 'duplicate key
   value violates unique constraint "users_email_key"',
   detail: 'Key (email)=(alice@example.com) already exists.' }`.
   When `mapPgError(err)` is called without verbose flag.
   Then the result has `code === '23505'`,
   `message === 'Uniqueness violation.'`,
   `details === null`, `hint === null`,
   `statusCode === 409`.

2. **23503 → safe message.**
   Same pattern. `message === 'Foreign key violation.'`,
   `statusCode === 409`.

3. **23502 → safe message.**
   Same pattern. `message === 'Not-null constraint violation.'`,
   `statusCode === 400`.

4. **42P01 → safe message.**
   Same pattern. `message === 'Undefined table.'`,
   `statusCode === 404`.

5. **42703 → safe message.**
   Same pattern. `message === 'Undefined column.'`,
   `statusCode === 400`.

6. **Unmapped code → fallback safe message.**
   Given `{ code: '55P03', message: 'could not obtain lock on relation "accounts"',
   detail: 'Process 1234 ...', hint: 'See server log...' }`.
   When `mapPgError(err)` is called without verbose flag.
   Then `code === '55P03'`,
   `message === 'Request failed with a database error.'`,
   `details === null`, `hint === null`,
   `statusCode === 500`.

7. **Raw PG text never appears in sanitized output.**
   For each of the 5 mapped codes, assert that `message`
   does not contain the original PG `message` substring
   and `details` is `null`.

**Verbose mode:**

8. **23505 verbose → raw passthrough.**
   Given the same 23505 PG error.
   When `mapPgError(err, { verbose: true })` is called.
   Then `message` equals the raw PG `message`,
   `details` equals the raw PG `detail`,
   `hint` equals the raw PG `hint`.

9. **Unmapped code verbose → raw passthrough.**
   Given `{ code: '55P03', message: 'could not obtain lock on relation "accounts"' }`.
   When `mapPgError(err, { verbose: true })` is called.
   Then `message === 'could not obtain lock on relation "accounts"'`,
   `statusCode === 500`.

**Code preservation (both modes):**

10. **SQLSTATE code is never altered.**
    For each test above, assert `result.code` equals the
    input `pgError.code` exactly.

**Map sync guard:**

11. **PG_SAFE_MESSAGE and PG_ERROR_MAP have identical keys.**
    Export `_getMapKeys()` from `errors.mjs` returning the
    key arrays of both maps. Assert they are identical
    sets. This test fails if someone adds a SQLSTATE to
    one map but forgets the other.

### Handler integration test (`handler.integration.test.mjs`)

12. **PG error through handler uses safe message.**
    Install a mock pool that throws
    `{ code: '23505', message: 'duplicate key...', detail: 'Key...' }`.
    Send a POST to `/rest/v1/todos`. Assert:
    - `statusCode === 409`
    - `body.code === '23505'`
    - `body.message === 'Uniqueness violation.'`
    - `body.details === null`
    - `body.hint === null`
    - `body.message` does not contain `'duplicate'`
    - `body.message` does not contain `'email'`

13. **PG error through handler with verbose ctx uses raw.**
    Same setup but with `ctx.errorsVerbose = true`.
    Assert raw `message` and `detail` appear in the response.

14. **Structured log emitted for sanitized PG error.**
    Capture `console.warn` output during test 12.
    Assert the log contains `pgCode`, `message`, `detail`.

    > These handler tests use the existing mock-pool
    > pattern from the handler.integration.test.mjs file,
    > similar to the catch-all 500 test.

15. **Verbose mode suppresses structured `console.warn`.**
    Same PG error pool, but `errCtx.errorsVerbose = true`.
    Spy on `console.warn`. Assert zero calls with the PG-
    error structured log shape (the spy should still
    tolerate other `console.warn` calls if any). This test
    fails if someone removes the `if (!ctx.errorsVerbose)`
    guard in `handler.mjs`.

16. **PG error with `hint` round-trips through handler.**
    Install a mock pool that throws
    `{ code: '55P03', message: 'could not obtain lock...',
    detail: 'Process 1234 waits for...', hint: 'See server
    log for query details.' }`.
    In sanitized mode: assert `body.hint === null` and
    `body.details === null`.
    In verbose mode: assert `body.hint === 'See server log
    for query details.'` and `body.details === 'Process
    1234 waits for...'`.

### `resolveConfig` / `errorsVerbose` tests

Test through the public `createPgrest({ ... })` API and
inspect `_ctx.errorsVerbose`. `resolveConfig` is module-
private; testing via `createPgrest` is less invasive and
already available since `_ctx` is exposed.

17. **Default: `errorsVerbose` is `false`.**
    `createPgrest({})` → `_ctx.errorsVerbose === false`.

18. **Config enables verbose.**
    `createPgrest({ errors: { verbose: true } })` →
    `_ctx.errorsVerbose === true`.

19. **Env var enables verbose.**
    Set `process.env.PGREST_ERRORS_VERBOSE = 'true'`,
    no `errors` in config → `_ctx.errorsVerbose === true`.
    Save/restore env var so it does not leak.

20. **Config `false` wins over env var `'true'`.**
    Set `process.env.PGREST_ERRORS_VERBOSE = 'true'` and
    `createPgrest({ errors: { verbose: false } })` →
    `_ctx.errorsVerbose === false`. This is the critical
    edge case: the `??` nullish coalescing ensures an
    explicit `false` does not fall through to the env var.
    If someone changes `??` to `||`, this test breaks.

### Existing test preservation

All existing `errors.test.mjs` tests continue to pass
unchanged. The four existing `mapPgError` tests only assert
on `statusCode` (not `message`), so the new sanitization
logic does not affect them.

## Implementation Order

1. **`src/rest/errors.mjs`** — Add safe-message map, update
   `mapPgError` signature and logic. Export `_getMapKeys()`.

2. **`src/index.mjs`** — Add `errorsVerbose` to
   `resolveConfig` and `ctx`.

3. **`src/rest/handler.mjs`** — Pass verbose flag to
   `mapPgError` call site, add structured logging.

4. **`src/rest/__tests__/errors.test.mjs`** — Add sanitized
   + verbose + code preservation + map-sync guard tests.

5. **`src/rest/__tests__/handler.integration.test.mjs`** —
   Set `errorsVerbose: false` in `createTestContext`. Add
   PG error sanitization integration tests, verbose-mode
   log-suppression test, and `hint` round-trip test.

6. **`src/__tests__/index.test.mjs`** — Add `resolveConfig`
   / `errorsVerbose` tests via `createPgrest` → `_ctx`.

7. **Tracker files** — Update V-09 finding, assessment.md.

8. **`CHANGELOG.md`** — Add Security entry.

## Open Questions

None. The prompt specifies all decisions:

- Safe messages are generic per-SQLSTATE (not parameterized).
- `code` is preserved exactly.
- Default is sanitized; opt-in verbose via config.
- Dev server does not auto-enable verbose.
