# V-07 — Session-ID Indirection for Refresh Tokens

Replace the provider-refresh-token-in-JWT design with session-ID
indirection so the JWT never carries a provider secret. Closes
security finding V-07 (High).

Reference: `docs/security/findings/V-07-provider-refresh-in-jwt.md`
Source: `docs/design/prompts/security-v07-session-id-indirection.md`

## Overview

`signRefreshToken()` in `src/auth/jwt.mjs` embeds the provider's
refresh token in the JWT payload as the `prt` claim. JWTs are
base64-encoded, not encrypted, so the `prt` value is trivially
recoverable by anyone who captures the refresh JWT. This design
replaces `prt` with an opaque server-side session ID (`sid`) that
the refresh path exchanges for the provider token at use time.

## Current CX / Concepts

The auth handler issues refresh JWTs at three points: signup,
password grant, and refresh grant. Each path calls
`jwt.signRefreshToken(sub, providerTokens.refreshToken)`, which
produces a JWT containing:

```json
{
  "sub": "<user-uuid>",
  "role": "authenticated",
  "prt": "<provider-refresh-token>",
  "iss": "pgrest-lambda",
  "exp": "<30d>"
}
```

The `prt` claim carries a different secret depending on the
provider:

- **Cognito** (`src/auth/providers/cognito.mjs:99`): `prt` is
  the actual Cognito `RefreshToken` returned by
  `InitiateAuthCommand`. An attacker who base64-decodes the JWT
  can call `InitiateAuthCommand(REFRESH_TOKEN_AUTH)` directly
  against AWS Cognito, bypassing pgrest-lambda entirely. **High
  impact.**
- **GoTrue** (`src/auth/providers/gotrue.mjs:81`): `prt` is a
  16-byte base64url opaque key mapping to a row in
  `auth.refresh_tokens`. The key is already server-side and
  revocable, but there is no reason it needs client exposure.
  **Medium impact.**

On refresh (`handler.mjs:186-198`), the handler decodes
`claims.prt` from the JWT and passes it directly to
`prov.refreshToken(claims.prt)`.

On logout (`handler.mjs:241-257`), the handler calls
`prov.signOut(claims.sub)` using only the `sub` claim. The
`prt` claim is not used for logout.

## Proposed CX / CX Specification

### Client-visible change

The refresh JWT payload changes from:

```json
{ "sub": "...", "role": "authenticated", "prt": "..." }
```

to:

```json
{ "sub": "...", "role": "authenticated", "sid": "<uuid>" }
```

Clients never inspect JWT claims directly (supabase-js treats
tokens as opaque strings), so this is transparent to conforming
clients. The `sid` is a UUID referencing a row in
`auth.sessions`.

### Migration: hard cut

Refresh JWTs issued before this change contain `prt` but no
`sid`. On refresh, if `claims.sid` is absent, the handler
returns `invalid_grant` (HTTP 401). Clients must re-login.

This is acceptable: V-01 through V-04 already changed
user-facing auth behavior in this release cycle. A forced
re-login on upgrade is expected for a security fix.

No fallback path to `prt` is implemented.

### Error responses

| Condition | HTTP | Error code | Description |
|---|---|---|---|
| Refresh JWT has `prt` but no `sid` (pre-upgrade token) | 401 | `invalid_grant` | `Invalid refresh token` |
| `sid` not found in `auth.sessions` | 401 | `invalid_grant` | `Invalid refresh token` |
| Session is revoked (`revoked = true`) | 401 | `invalid_grant` | `Invalid refresh token` |
| Session provider mismatches active provider | 401 | `invalid_grant` | `Invalid refresh token` |

All four cases produce the same error shape so that the
response does not leak internal state to an attacker.

### Provider contract

No change. The provider interface
(`src/auth/providers/interface.mjs`) still returns
`providerTokens.refreshToken`. Providers still produce a
provider token; the handler stores it server-side instead of
putting it in a JWT. Only caller handling changes.

## Technical Design

### 1. `auth.sessions` table

Add to `src/auth/schema.mjs` alongside existing DDL in
`AUTH_SCHEMA_SQL`:

```sql
CREATE TABLE IF NOT EXISTS auth.sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL,
  provider    text NOT NULL,
  prt         text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  revoked     boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS sessions_user_id_idx
  ON auth.sessions (user_id);
```

- `provider` stores `'gotrue'` or `'cognito'` so the handler
  can verify the session matches the active provider on refresh
  (defense-in-depth).
- `prt` stores the provider's opaque refresh token. For GoTrue,
  this is the 16-byte base64url key; for Cognito, the Cognito
  refresh token.
- Both providers share the same table. The `provider` column
  prevents cross-provider session reuse if a deployment
  switches providers.
- For Cognito deployments this is a new table (Cognito
  deployments currently have no `auth.*`). The existing
  `ensureAuthSchema` cold-start path runs the DDL. V-22
  (runtime DDL concern) is tracked separately and out of scope.
- Uses `gen_random_uuid()`, already used by `auth.users` in the
  GoTrue DDL.

### 2. Sessions module — `src/auth/sessions.mjs`

New module with five functions:

```javascript
createSession(pool, { userId, provider, prt })
  → { sid }        // UUID string

resolveSession(pool, sid)
  → { userId, provider, prt, revoked } | null

updateSessionPrt(pool, sid, newPrt)
  → void

revokeSession(pool, sid)
  → void

revokeUserSessions(pool, userId)
  → void
```

All SQL parameterized with `$1`, `$2`, etc. No string
interpolation.

`createSession` inserts a row into `auth.sessions` and returns
the generated `id` as `sid`.

`resolveSession` selects by primary key. Returns `null` (not
throws) when no row matches, so the caller can produce the
appropriate error response.

`updateSessionPrt` updates the `prt` column and sets
`updated_at = now()`. Called after a successful provider refresh
to store the (potentially new) provider token.

`revokeSession` sets `revoked = true` and updates `updated_at`
for a single session by `id`.

`revokeUserSessions` sets `revoked = true` and updates
`updated_at` on all non-revoked sessions for a given `user_id`.
Called on logout, because the logout path receives an access
token (which contains `sub` but not `sid`).

### 3. JWT claim change — `src/auth/jwt.mjs`

Update `signRefreshToken`:

```javascript
// Before
function signRefreshToken(sub, providerRefreshToken) {
  return jwt.sign(
    { sub, role: 'authenticated', prt: providerRefreshToken },
    secret,
    { algorithm: JWT_ALGORITHM, issuer: ISSUER, expiresIn: '30d' }
  );
}

// After
function signRefreshToken(sub, sid) {
  return jwt.sign(
    { sub, role: 'authenticated', sid },
    secret,
    { algorithm: JWT_ALGORITHM, issuer: ISSUER, expiresIn: '30d' }
  );
}
```

Parameter name changes from `providerRefreshToken` to `sid`.
The claim changes from `prt` to `sid`. No other changes to the
JWT module.

### 4. Handler wiring — `src/auth/handler.mjs`

Import sessions module at the top:

```javascript
import {
  createSession,
  resolveSession,
  updateSessionPrt,
  revokeUserSessions,
} from './sessions.mjs';
```

The handler needs access to the database pool. `ctx.db` is
set in `src/index.mjs:121` and available inside
`createAuthHandler` — the existing `getProvider()` function
already accesses it (`createProvider(config.auth, ctx.db)` at
line 46). The session functions use the same pool.

**Note for handler tests:** The current test setup
(`src/auth/__tests__/handler.test.mjs`) constructs `ctx` as
`{ jwt, authProvider: null }` without a `db` property. After
this change, tests that exercise signup, password grant,
refresh grant, or logout must add a mock `db` to the context:

```javascript
const mockDb = {
  getPool: async () => mockPool,
};
const ctx = { jwt, authProvider: null, db: mockDb };
```

The mock pool intercepts `query` calls to `auth.sessions`
and returns canned rows. This matches the pattern in
`src/auth/__tests__/gotrue-provider.test.mjs`.

#### Signup path (`handleSignup`, lines 91-118)

```javascript
// Before
const refreshToken = jwt.signRefreshToken(
  user.id,
  providerTokens.refreshToken
);

// After
const pool = await ctx.db.getPool();
const { sid } = await createSession(pool, {
  userId: user.id,
  provider: config.auth.provider || 'gotrue',
  prt: providerTokens.refreshToken,
});
const refreshToken = jwt.signRefreshToken(user.id, sid);
```

#### Password grant (`handlePasswordGrant`, lines 140-163)

Same pattern as signup: create session, then sign refresh token
with `sid`.

#### Refresh grant (`handleRefreshGrant`, lines 165-201)

```javascript
// Before
const { user, providerTokens } =
  await prov.refreshToken(claims.prt);

// After
if (!claims.sid) {
  return errorResponse(
    401, 'invalid_grant',
    'Invalid refresh token',
    undefined, corsHeaders
  );
}

const pool = await ctx.db.getPool();
const session = await resolveSession(pool, claims.sid);

if (!session) {
  return errorResponse(
    401, 'invalid_grant',
    'Invalid refresh token',
    undefined, corsHeaders
  );
}

if (session.revoked) {
  return errorResponse(
    401, 'invalid_grant',
    'Invalid refresh token',
    undefined, corsHeaders
  );
}

const activeProvider = config.auth.provider || 'gotrue';
if (session.provider !== activeProvider) {
  return errorResponse(
    401, 'invalid_grant',
    'Invalid refresh token',
    undefined, corsHeaders
  );
}

const { user, providerTokens } =
  await prov.refreshToken(session.prt);

await updateSessionPrt(
  pool,
  claims.sid,
  providerTokens.refreshToken
);

const newRefreshToken = jwt.signRefreshToken(
  claims.sub,
  claims.sid   // reuse same session ID
);
```

On refresh, the `sid` stays the same — the session row is
updated with the new provider token. The refresh JWT gets a
fresh expiry (30d from now) but references the same session.

#### Logout path (`handleLogout`, lines 241-257)

The logout endpoint receives an **access token** (via
`Authorization: Bearer`), not a refresh token. Access tokens
contain `sub` but not `sid`. Therefore, logout revokes all
sessions for the user by `user_id`, not by individual `sid`:

```javascript
// After (inside the try block)
const claims = jwt.verifyToken(token);
const pool = await ctx.db.getPool();
await revokeUserSessions(pool, claims.sub);
const prov = await getProvider();
await prov.signOut(claims.sub);
```

Both the session-level and provider-level revocation run.
For GoTrue, `prov.signOut` revokes `auth.refresh_tokens`
rows; `revokeUserSessions` revokes all `auth.sessions` rows
for the user. These are independent layers.

### 5. Relationship between `auth.sessions` and `auth.refresh_tokens`

The two tables are not redundant:

- `auth.refresh_tokens` (GoTrue-only) handles per-rotation
  token tracking and family revocation within the GoTrue
  provider.
- `auth.sessions` (provider-agnostic) decouples the client-
  facing JWT from the provider secret. It stores a single row
  per login session.

GoTrue's `refreshToken()` method continues to rotate its own
`auth.refresh_tokens` internally. The `prt` stored in
`auth.sessions` gets updated to the new GoTrue opaque key
after each successful rotation via `updateSessionPrt`.

For Cognito, `auth.sessions` is the only session state table.
Cognito does not rotate refresh tokens (the same token is
returned), so `updateSessionPrt` writes the same value — this
is safe and consistent.

## Code Architecture / File Changes

```
src/auth/schema.mjs                    — add auth.sessions DDL
                                         to AUTH_SCHEMA_SQL
src/auth/sessions.mjs                  — NEW: createSession,
                                         resolveSession,
                                         updateSessionPrt,
                                         revokeSession,
                                         revokeUserSessions
src/auth/jwt.mjs                       — signRefreshToken: rename
                                         param, change prt→sid
src/auth/handler.mjs                   — wire sessions through
                                         signup, password grant,
                                         refresh grant, logout;
                                         import sessions module
src/auth/providers/interface.mjs       — no change
src/auth/__tests__/sessions.test.mjs   — NEW: unit tests for
                                         sessions module
src/auth/__tests__/handler.test.mjs    — update: add mock db to
                                         ctx; prt→sid assertions;
                                         new refresh grant
                                         scenarios
src/auth/__tests__/jwt.test.mjs        — update: prt→sid claim
                                         assertions
src/auth/__tests__/integration.test.mjs
                                       — update: add mock db to
                                         ctx; refresh flow needs
                                         session mocking
src/auth/__tests__/schema.test.mjs     — update: assert sessions
                                         DDL in AUTH_SCHEMA_SQL
docs/security/findings/V-07-provider-refresh-in-jwt.md
                                       — Status: Fixed
docs/security/assessment.md            — flip V-07 to Fixed
CHANGELOG.md                           — Security + Breaking
README.md                              — informational note
```

No new npm dependencies.

## Testing Strategy

### `src/auth/__tests__/sessions.test.mjs` (new)

Unit tests for the sessions module. Mock the pool's `query`
method and assert on `query.text` + `query.values`. This
matches the testing style used by
`src/auth/__tests__/gotrue-provider.test.mjs` (mock pool).

| Test | Assertion |
|---|---|
| `createSession` inserts row with userId, provider, prt | SQL text contains `INSERT INTO auth.sessions`; values array matches `[userId, provider, prt]`; returns `{ sid }` where `sid` is a UUID string |
| `resolveSession` returns stored fields | SQL text contains `SELECT ... FROM auth.sessions WHERE id = $1`; returns `{ userId, provider, prt, revoked }` |
| `resolveSession` for nonexistent UUID returns `null` | Mock returns `{ rows: [] }`; function returns `null` |
| `updateSessionPrt` changes prt and bumps `updated_at` | SQL text contains `UPDATE auth.sessions SET prt = $1, updated_at = now() WHERE id = $2`; values match `[newPrt, sid]` |
| `revokeSession` sets `revoked = true` | SQL text contains `UPDATE auth.sessions SET revoked = true ... WHERE id = $1`; values include `sid` |
| `revokeUserSessions` revokes all sessions for a user | SQL text contains `UPDATE auth.sessions SET revoked = true ... WHERE user_id = $1 AND revoked = false`; values include `userId` |

### `src/auth/__tests__/jwt.test.mjs` (update)

| Test | Change |
|---|---|
| `signRefreshToken` produces JWT with `sid` claim | Rename `providerToken` to `sid`; assert `payload.sid === sid`; assert `payload.prt === undefined` |
| Existing expiry/issuer tests | Update variable names, keep assertions on expiry and issuer |

### `src/auth/__tests__/handler.test.mjs` (update)

| Test | Change |
|---|---|
| Signup: refresh token payload contains `sid` not `prt` | Decode refresh JWT from response; assert `claims.sid` is a UUID; assert `claims.prt` is undefined |
| Password grant: same as signup | Same assertion pattern |
| Refresh grant: JWT with `sid` is accepted | Create a refresh JWT with `sid`; mock `resolveSession` to return a valid session; assert `prov.refreshToken` is called with the stored `prt`; assert `updateSessionPrt` is called with the new provider token |
| Refresh grant: JWT with `prt` but no `sid` rejected | Create a refresh JWT using old `prt` format; assert 401 `invalid_grant` |
| Refresh grant: revoked `sid` returns `invalid_grant` | Mock `resolveSession` to return `{ revoked: true }`; assert 401 |
| Refresh grant: nonexistent `sid` returns `invalid_grant` | Mock `resolveSession` to return `null`; assert 401 |
| Refresh grant: provider mismatch returns `invalid_grant` | Mock `resolveSession` with `provider: 'cognito'` when active provider is `'gotrue'`; assert 401 |
| Logout: revokes all user sessions | Assert `revokeUserSessions` called with `claims.sub` (logout uses access token, which has `sub` but not `sid`) |

### `src/auth/__tests__/integration.test.mjs` (update)

The integration test (`token refresh flow` at line 258)
exercises the full signup → signin → refresh path. After this
change, the test context must include a mock `db` with a pool
that handles `auth.sessions` queries:

| Test | Change |
|---|---|
| Context setup | Add `db: { getPool: async () => mockPool }` to `ctx` in `beforeEach` |
| Token refresh flow | Mock pool must handle `INSERT INTO auth.sessions` (on signin) and `SELECT/UPDATE` on `auth.sessions` (on refresh) |
| Full signup flow | Mock pool must handle `INSERT INTO auth.sessions` (on signup) |

The mock pool should route `auth.sessions` queries to canned
responses while ignoring queries it does not recognize (to
avoid interfering with provider-level mocking).

### `src/auth/__tests__/schema.test.mjs` (update)

| Test | Change |
|---|---|
| `AUTH_SCHEMA_SQL` includes sessions DDL | Assert `AUTH_SCHEMA_SQL` contains a string matching `auth.sessions` |

## Implementation Order

1. **Schema** — Add `auth.sessions` DDL to `AUTH_SCHEMA_SQL` in
   `src/auth/schema.mjs`. Update schema tests.

2. **Sessions module** — Create `src/auth/sessions.mjs` with the
   five functions (`createSession`, `resolveSession`,
   `updateSessionPrt`, `revokeSession`, `revokeUserSessions`).
   Create `src/auth/__tests__/sessions.test.mjs` with unit
   tests. Verify all pass.

3. **JWT** — Update `signRefreshToken` in `src/auth/jwt.mjs` to
   accept `sid` instead of `providerRefreshToken`, emit `sid`
   claim instead of `prt`. Update `src/auth/__tests__/jwt.test.mjs`.
   Verify tests pass.

4. **Handler** — Wire sessions through all four handler paths
   (signup, password grant, refresh grant, logout) in
   `src/auth/handler.mjs`. Update
   `src/auth/__tests__/handler.test.mjs` and
   `src/auth/__tests__/integration.test.mjs` — both need a
   mock `db` on the context. Add new test cases for session-
   based refresh and the hard-cut rejection of `prt`-only
   tokens. Verify all tests pass including existing tests.

5. **Documentation** — Update
   `docs/security/findings/V-07-provider-refresh-in-jwt.md`
   (Status: Fixed), `docs/security/assessment.md` (flip V-07),
   `CHANGELOG.md` (Security + Breaking entries), `README.md`
   (informational note about opaque session IDs).

## Open Questions

None. All design decisions are resolved:

- **Hard cut vs soft migrate:** hard cut (option 1).
- **Session ID reuse on refresh:** yes, same `sid` persists
  across refreshes; the `prt` column is updated.
- **Cognito DB dependency:** accepted; documented in CHANGELOG
  as a breaking change for Cognito deployments.
- **V-22 interaction:** out of scope; `ensureAuthSchema` handles
  the new DDL the same way it handles existing tables.
