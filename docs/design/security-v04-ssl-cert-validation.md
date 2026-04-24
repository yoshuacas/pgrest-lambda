# V-04 — SSL Certificate Validation

Enforce TLS certificate verification on the DSQL adapter and
make it configurable (with a secure default) on the standard
Postgres adapter to close security finding V-04 (High).

Reference: `docs/security/findings/V-04-ssl-cert-validation.md`
Source: `docs/design/prompts/security-v04-ssl-cert-validation.md`

## Overview

Both database adapters disable TLS certificate verification
(`rejectUnauthorized: false`). The DSQL adapter does this
unconditionally despite carrying IAM auth tokens over the
connection. The standard Postgres adapter offers no code path
that yields "TLS on, verification on" -- a consumer who sets
`config.ssl = true` thinking they are hardening the connection
is actually opting into MITM exposure.

The fix has two shapes, matching the two adapters:

- **DSQL**: hard-set `rejectUnauthorized: true`. No config
  hook, no opt-out. AWS-managed certs chain to public roots.
- **Standard Postgres**: accept `config.ssl` as
  `boolean | object | undefined` with a secure default.
  `true` means TLS with verification; an object is forwarded
  to `pg.Pool` verbatim (with `rejectUnauthorized` defaulting
  to `true` if unspecified). Consumers who knowingly accept
  MITM risk pass `{ rejectUnauthorized: false }`.

The connection-string path (`config.connectionString`) is
unchanged -- `pg` honors `sslmode=...` in the URL.

## Current CX / Concepts

### DSQL Adapter

`src/rest/db/dsql.mjs:42` creates the pool with:

```javascript
ssl: { rejectUnauthorized: false },
```

This is unconditional. There is no config surface to change
it. Every DSQL connection -- carrying an IAM auth token as the
password and all SQL queries -- skips certificate verification.

### Standard Postgres Adapter

`src/rest/db/postgres.mjs:31` resolves SSL as:

```javascript
ssl: config.ssl ? { rejectUnauthorized: false } : undefined,
```

Three postures exist:

| `config.ssl` value | Resulting `ssl` option | TLS | Verify |
|---|---|---|---|
| `undefined` / `false` | `undefined` | Off | N/A |
| `true` | `{ rejectUnauthorized: false }` | On | Off |
| (no other path) | -- | -- | -- |

There is no way to get "TLS on, verify on."

### Connection-String Path

`src/rest/db/postgres.mjs:18-23` -- when
`config.connectionString` is set, the pool config has no `ssl`
key. The `pg` library reads `sslmode=...` from the URL. This
path is unaffected by the fix.

### Config Resolution

`src/index.mjs` `resolveDatabase` has two paths:

1. **Explicit config** (`config.database` present):
   `d.ssl` is passed through verbatim (line 24). The
   consumer controls the type — boolean, object, or
   undefined.
2. **Environment fallback** (no `config.database`):
   `process.env.PG_SSL === 'true'` (line 42) produces a
   boolean `true` or `false`. The strict equality check
   means only the literal string `"true"` enables SSL.

In both cases the resolved value reaches
`createPostgresProvider` as `config.ssl`.

## Proposed CX / CX Specification

### DSQL Adapter: No Consumer-Facing Change

DSQL connections always verify TLS certificates. There is no
config surface and no opt-out. If a consumer's DSQL endpoint
does not present a valid certificate chaining to a public CA,
the connection fails with the `pg` library's native TLS error
("self signed certificate", "unable to verify the first
certificate", etc.).

This is the only correct posture for DSQL. AWS issues the
serving certificates; they chain to Amazon Trust Services roots
included in the Node.js trust store.

### Standard Postgres Adapter: New `config.ssl` Semantics

`config.ssl` accepts three shapes:

| `config.ssl` value | Resulting `ssl` pool option | TLS | Verify |
|---|---|---|---|
| `undefined` | `undefined` | Off | N/A |
| `false` | `undefined` | Off | N/A |
| `true` | `{ rejectUnauthorized: true }` | On | On |
| `{ ... }` (object) | object, with `rejectUnauthorized` defaulting to `true` | On | Depends on object |

Examples:

```javascript
// No TLS (localhost, same-VPC). Existing behavior, unchanged.
createPgrest({ database: { host: 'localhost' } });

// TLS with verification (new secure default).
createPgrest({ database: { host: 'db.example.com', ssl: true } });

// TLS with a private CA.
createPgrest({
  database: {
    host: 'db.internal',
    ssl: { ca: fs.readFileSync('/path/to/ca.pem', 'utf8') },
  },
});

// TLS without verification (consumer explicitly accepts MITM risk).
createPgrest({
  database: {
    host: 'db.internal',
    ssl: { rejectUnauthorized: false },
  },
});
```

### Connection-String Path

When `config.connectionString` (or `DATABASE_URL`) is set, the
adapter uses the connection string directly and does not apply
`config.ssl`. TLS is controlled by `sslmode=...` in the URL.
This is unchanged.

### Behavior Change Risk

This is a **breaking change** for consumers who currently set
`config.ssl = true` (or `PG_SSL=true`) and connect to a
database with a self-signed or otherwise unverifiable
certificate. They will start seeing TLS verification errors
from the `pg` library:

- `"self signed certificate"`
- `"unable to verify the first certificate"`
- `"self signed certificate in certificate chain"`

These errors are actionable. The escape hatch is explicit:

```javascript
// Before (insecure, implicit):
createPgrest({ database: { ssl: true } });

// After (insecure, explicit):
createPgrest({ database: { ssl: { rejectUnauthorized: false } } });
```

### Validation Rules

| Condition | Result |
|---|---|
| `config.ssl` is `undefined` or `false` | No TLS. Pool gets `ssl: undefined`. |
| `config.ssl` is `true` | TLS with verification. Pool gets `ssl: { rejectUnauthorized: true }`. |
| `config.ssl` is an object with `rejectUnauthorized` set | Object forwarded verbatim. Consumer controls verification. |
| `config.ssl` is an object without `rejectUnauthorized` | Object forwarded with `rejectUnauthorized: true` injected. |
| DSQL adapter, any config | Pool always gets `ssl: { rejectUnauthorized: true }`. No override. |

## Technical Design

### `src/rest/db/dsql.mjs` — Hard-Enable Verification

Change line 42 from:

```javascript
ssl: { rejectUnauthorized: false },
```

to:

```javascript
// AWS-managed certs; always verify
ssl: { rejectUnauthorized: true },
```

No other changes to this file.

### `src/rest/db/postgres.mjs` — SSL Resolution

Replace the existing SSL resolution on line 31:

```javascript
ssl: config.ssl ? { rejectUnauthorized: false } : undefined,
```

with a resolution function that handles the three shapes:

```javascript
function resolveSsl(ssl) {
  if (!ssl) return undefined;
  if (ssl === true) return { rejectUnauthorized: true };
  if (typeof ssl === 'object') {
    return {
      rejectUnauthorized: true,
      ...ssl,
    };
  }
  return undefined;
}
```

Then in `getPool`, the host/port branch becomes:

```javascript
pool = new Pool({
  host: config.host || 'localhost',
  port: config.port || 5432,
  user: config.user || 'postgres',
  password: config.password || '',
  database: config.database || 'postgres',
  ssl: resolveSsl(config.ssl),
  max: 5,
  idleTimeoutMillis: 60000,
});
```

Key details:

- `resolveSsl` is a module-private function, not exported.
  It exists only to keep the pool construction readable.
- The object spread `{ rejectUnauthorized: true, ...ssl }`
  puts the default first, so the consumer's explicit
  `rejectUnauthorized: false` wins via override.
- The connection-string branch (lines 18-23) is unchanged.
  It does not call `resolveSsl` and does not set an `ssl`
  key on the pool config.
- The final `return undefined` catches unexpected types
  (numbers, strings other than truthy evaluation). These
  already fell through to `undefined` in the old ternary.

### `src/index.mjs` — Config Resolution (Unchanged)

The existing `resolveDatabase` in `src/index.mjs` already
handles both paths correctly:

- **Explicit config** (line 24): `ssl: d.ssl` passes the
  consumer's value verbatim. If they pass an object, the
  adapter's `resolveSsl` receives an object. If they pass
  `true`, it receives `true`.
- **Env fallback** (line 42): `ssl: process.env.PG_SSL ===
  'true'` coerces the env var to a boolean. The adapter
  receives `true` or `false`, never a string.

No changes to `src/index.mjs`.

## Code Architecture / File Changes

### Modified Files

| File | Change |
|---|---|
| `src/rest/db/dsql.mjs` | Change `rejectUnauthorized: false` to `true`; add one-line comment |
| `src/rest/db/postgres.mjs` | Add `resolveSsl` function; use it in host/port pool construction |
| `README.md` | Add TLS configuration subsection documenting `config.ssl` options |
| `CHANGELOG.md` | Add Security entry under Unreleased for V-04 |
| `docs/security/findings/V-04-ssl-cert-validation.md` | Status to Fixed; fill Decision, Evidence, Residual risk, Reviewer handoff |
| `docs/security/assessment.md` | V-04 status Open to Fixed |

### New Files

| File | Purpose | ~Lines |
|---|---|---|
| `src/rest/db/__tests__/dsql.test.mjs` | Unit tests for DSQL adapter SSL config | ~30 |
| `src/rest/db/__tests__/postgres.test.mjs` | Unit tests for Postgres adapter SSL resolution | ~80 |

### Files That Do NOT Change

- `src/index.mjs` -- config resolution already passes
  `database.ssl` through. The new `resolveSsl` function is
  adapter-local.
- `src/rest/db/interface.mjs` -- the provider contract is
  unchanged; SSL is a pool-construction detail.
- `src/rest/handler.mjs`, `src/auth/handler.mjs` -- SSL
  configuration is internal to the database provider. Handlers
  call `getPool()` and are unaware of the underlying TLS
  posture.
- `src/shared/cors.mjs`, `src/auth/jwt.mjs`,
  `src/authorizer/index.mjs` -- unrelated.

## Testing Strategy

All tests use `node:test` + `assert/strict`, matching project
convention. Tests spy on `pg.Pool` construction to capture the
config argument without making real database connections.

### Test Directory

`src/rest/db/__tests__/` does not exist yet. Create it as
part of Phase 1.

### Test Approach: Pool Config Spy

Both test files need to intercept the `pg.Pool` constructor
to inspect the `ssl` option passed to it. The adapters
import `pg` at the module level (`import pg from 'pg'`) and
destructure `Pool` from it. The existing `_setPool` hook
on each adapter bypasses `getPool`'s pool-construction
logic entirely, so it **cannot** be used for these tests.

Instead, mock the `pg` module so that `Pool` is a
constructor that captures its config argument:

```javascript
import { mock } from 'node:test';

let capturedConfig;
const MockPool = function(config) {
  capturedConfig = config;
  return {
    query: async () => ({ rows: [] }),
    end: async () => {},
  };
};

// Use node:test's mock.module (requires --experimental-
// vm-modules) or re-export the adapter function with a
// Pool injection seam. The implementing agent should check
// existing test files (e.g., src/auth/__tests__/
// cognito-provider.test.mjs) for the established mocking
// pattern and follow it.
```

The project uses `node:test` with `mock.fn()` for function
mocking (see `src/auth/__tests__/cognito-provider.test.mjs`).
If `mock.module` is not available, an alternative is to
extract `resolveSsl` and test it directly (it is a pure
function), combined with a single integration-style test
that calls `getPool()` with a mocked `pg` to confirm the
wiring.

### DSQL Adapter: `src/rest/db/__tests__/dsql.test.mjs`

| # | Test | Expected |
|---|---|---|
| 1 | `createDsqlProvider` with valid config -- pool config has `ssl.rejectUnauthorized === true` | `capturedConfig.ssl.rejectUnauthorized` is `true` |

This test must mock `@aws-sdk/dsql-signer` to return a fake
token, since `getPool` calls the signer before constructing
the pool. Note that the DSQL adapter uses a **dynamic import**
(`await import('@aws-sdk/dsql-signer')` on line 29), not a
static import — the mocking mechanism must intercept dynamic
`import()` calls, not just static module resolution.

> Warning: This test needs both `pg.Pool` and
> `@aws-sdk/dsql-signer` mocked. The implementing agent
> should verify that the mock setup does not mask the SSL
> config assertion -- ensure `capturedConfig` is checked
> after `getPool()` resolves, not before.

### Standard Postgres Adapter: `src/rest/db/__tests__/postgres.test.mjs`

**Alternative test approach:** The `resolveSsl` function is
pure — it takes a value and returns a value with no side
effects. If mocking `pg.Pool` proves difficult, the
implementing agent may export `resolveSsl` (as a named
export, keeping it undocumented) and test it directly. This
covers tests 1-6 without any mocking. Tests 7-8 would still
need `pg.Pool` mocked to verify the connection-string branch
and config passthrough. Use whichever approach produces
clearer tests.

#### SSL Resolution

| # | `config.ssl` | Expected `capturedConfig.ssl` |
|---|---|---|
| 1 | `undefined` | `undefined` |
| 2 | `false` | `undefined` |
| 3 | `true` | `{ rejectUnauthorized: true }` |
| 4 | `{ rejectUnauthorized: false }` | `{ rejectUnauthorized: false }` |
| 5 | `{ ca: '<pem>' }` | `{ rejectUnauthorized: true, ca: '<pem>' }` |
| 6 | `{ ca: '<pem>', rejectUnauthorized: false }` | `{ rejectUnauthorized: false, ca: '<pem>' }` |

> Warning: Test 5 verifies that `rejectUnauthorized: true`
> is injected as a default. The implementing agent should
> verify the assertion checks both the `ca` value AND the
> `rejectUnauthorized` value, not just one. A test that
> only checks `ca` would pass even if the default injection
> were missing.

#### Connection-String Branch

| # | Config | Expected |
|---|---|---|
| 7 | `{ connectionString: 'postgresql://...', ssl: true }` | `capturedConfig` has `connectionString` key; `capturedConfig.ssl` is `undefined` |

> Warning: This test's expected output (no `ssl` key on the
> pool config) is the same whether the connection-string
> branch correctly ignores `config.ssl` or the adapter
> simply fails to set it for another reason. The
> implementing agent should verify the test also asserts
> that `capturedConfig.connectionString` is present, to
> confirm the connection-string branch was taken.

#### Existing Config Properties Preserved

| # | Test | Expected |
|---|---|---|
| 8 | `config.ssl = true` with host/port/user/password/database set | Pool config includes all five connection properties alongside `ssl: { rejectUnauthorized: true }` |

### Regression

Existing integration tests that exercise the database adapters
indirectly (e.g., `src/rest/__tests__/handler.integration.test.mjs`)
use `_setPool` to inject a mock pool and never hit the pool-
construction code path. These tests are unaffected by the SSL
change.

If any existing test directly constructs a provider with
`config.ssl = true` and then calls `getPool()`, it will now
get `rejectUnauthorized: true` instead of `false`. The
implementing agent should search for such tests and update
them to either:
- Pass `{ rejectUnauthorized: false }` to preserve the old
  behavior (if the test is about something other than SSL), or
- Leave them on the new secure default (if the test is about
  SSL or the change is harmless).

Verification: `npm test`

## Implementation Order

### Phase 1: DSQL Adapter Fix + Test

1. Change `ssl: { rejectUnauthorized: false }` to
   `ssl: { rejectUnauthorized: true }` in
   `src/rest/db/dsql.mjs`. Add one-line comment.
2. Create `src/rest/db/__tests__/dsql.test.mjs` with the
   pool config assertion.
3. Verify: `node --test src/rest/db/__tests__/dsql.test.mjs`

### Phase 2: Postgres Adapter Fix + Tests

4. Add `resolveSsl` function to `src/rest/db/postgres.mjs`.
5. Replace the existing `ssl` ternary in the host/port
   branch with `ssl: resolveSsl(config.ssl)`.
6. Create `src/rest/db/__tests__/postgres.test.mjs` with
   all SSL resolution test cases.
7. Verify:
   `node --test src/rest/db/__tests__/postgres.test.mjs`

### Phase 3: Regression Check

8. Run full test suite: `npm test`. Fix any tests that
   break due to the new secure default.

### Phase 4: Documentation

9. Update `README.md` -- add TLS configuration subsection.
10. Update `CHANGELOG.md` -- Security entry under Unreleased.
11. Update `docs/security/findings/V-04-ssl-cert-validation.md`
    -- Status to Fixed; fill Decision, Evidence, Residual
    risk, Reviewer handoff.
12. Update `docs/security/assessment.md` -- V-04 status to
    Fixed.

## Open Questions

None. The fix surface is well-defined: two adapter files, each
with a clear posture. The DSQL adapter has no config surface.
The Postgres adapter's `resolveSsl` handles the three input
shapes (`undefined`/`false`, `true`, object) with a secure
default. The connection-string path is explicitly excluded.

**Resolved during design:** The `PG_SSL` environment variable
is coerced to a boolean by `resolveDatabase` in
`src/index.mjs:42` via `process.env.PG_SSL === 'true'`. The
adapter always receives a boolean `true` or `false` on the
env-fallback path, never a raw string. The explicit-config
path (`config.database.ssl`) passes the consumer's value
verbatim — the consumer controls the type. No additional
coercion is needed in the adapter or in `resolveConfig`.
