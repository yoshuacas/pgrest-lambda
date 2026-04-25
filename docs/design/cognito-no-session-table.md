# Cognito Path Should Not Require `auth.sessions`

## Overview

The auth handler writes a row to `auth.sessions` on every signup and
password grant, regardless of which provider is active. This forces
every deployment that uses the Cognito provider to also provision a
PostgreSQL `auth` schema, which defeats the point of using Cognito as
the backing store for users and refresh tokens.

The fix is to treat server-side session storage as a provider-level
capability, not a handler-level assumption. The Cognito provider does
not need server-side sessions — Cognito already manages refresh tokens
on the AWS side — so the handler should not write session rows when
Cognito is active.

## Current CX / Concepts

### Handler unconditionally writes to `auth.sessions`

`src/auth/handler.mjs` calls `createSession(pool, ...)` on three
paths regardless of provider:

- `handleSignup` (line 117): after the provider's `signUp` + `signIn`
- `handlePasswordGrant` (line 166): after the provider's `signIn`
- `handleRefreshGrant` (line 220): calls `updateSessionPrt` on an
  existing row

The `sid` (session ID) from `createSession` becomes the `sid` claim
in the refresh JWT. The refresh grant later exchanges `sid` for the
stored provider refresh token.

### V-07 introduced server-side sessions to hide provider refresh tokens

Before V-07, the refresh JWT carried the provider refresh token in a
`prt` claim. Since JWTs are base64-encoded, not encrypted, the `prt`
was recoverable by anyone who captured the refresh JWT. V-07 replaced
`prt` with `sid`, an opaque server-side reference to a row in
`auth.sessions` that holds the real provider refresh token.

This closes the leak **only** when the provider issues long-lived
refresh tokens that are themselves sensitive to expose. That is the
case for the GoTrue-native provider, whose refresh tokens are the
database's source of truth. It is **not** the case for Cognito,
where:

- The provider refresh token is already stored server-side by AWS.
- AWS manages revocation, rotation, and expiry.
- The Cognito refresh token is scoped to the app client and can be
  revoked via the AWS API independently of anything BOA stores.

For Cognito, storing the refresh token a second time in
`auth.sessions` is pure duplication with no security benefit. Worse,
it introduces a failure mode where AWS has rotated or revoked a token
that the local row still considers valid.

### Provider interface does not expose a storage capability

`src/auth/providers/interface.mjs` defines five methods: `signUp`,
`signIn`, `refreshToken`, `getUser`, `signOut`. There is no way for
a provider to declare whether it needs server-side session state.

The Cognito provider (`src/auth/providers/cognito.mjs`) never calls
`ensureAuthSchema` and performs no database work — consistent with
the intent that Cognito is self-sufficient. The GoTrue provider
(`src/auth/providers/gotrue.mjs`) calls `ensureAuthSchema` at every
entry point because it owns its schema.

The handler then disregards this separation and writes to
`auth.sessions` either way. This is the bug.

## Problem

### What breaks today

Deploying pgrest-lambda v0.2.0 with `AUTH_PROVIDER=cognito` (the
default) and no bootstrap migration produces this behavior on the
first `POST /auth/v1/signup`:

```
HTTP 500
{"error":"42P01","error_description":"An unexpected error occurred"}
```

PostgreSQL error `42P01` is "undefined table". The Cognito provider
successfully creates the user and issues AWS tokens, but the handler
then tries to `INSERT INTO auth.sessions` into a schema that does
not exist. The user is created in Cognito but the client sees a
500 and has no session.

### Why V-07 went wrong here

V-07's threat model assumed the provider refresh token always needs
to be hidden at rest. That is the right default for GoTrue: the
refresh token IS the credential. For Cognito, the refresh token is
a reference to AWS-managed state, and the caller already holds the
real credentials (AccessKey/IAM for the Lambda). Putting the Cognito
refresh token in the refresh JWT is not ideal, but storing it in a
second database is not a better answer — it is the same exposure
plus an operational liability.

### Why this is a breaking integration

Consumers like BOA provision DSQL + Cognito + Lambda and call it
done. Nothing in the deployment path creates an `auth` schema because
nothing in the deployment path knows pgrest-lambda has internal
tables. The CHANGELOG for v0.2.0 lists this as "breaking: Cognito
deployments now require a PostgreSQL database for session storage
(auth.sessions table)" — but that framing hides the real question:
why does Cognito need this at all?

## Proposed Design

### Make session storage a provider capability

Add an optional capability to the `AuthProvider` shape:

```js
/**
 * @property {boolean} [needsSessionTable] - If true, the handler
 *   stores refresh tokens in auth.sessions and issues refresh JWTs
 *   with an opaque sid. If false or absent, the provider manages
 *   refresh state itself and the handler delegates refresh to
 *   provider.refreshToken directly.
 */
```

- `cognito.mjs`: `needsSessionTable: false` (or simply omit).
- `gotrue.mjs`: `needsSessionTable: true`.

### Two refresh-token shapes, selected per provider

**When `needsSessionTable === true`** (GoTrue):
- Handler creates an `auth.sessions` row on signup and password
  grant, signs the refresh JWT with `{ sub, sid }` — the V-07 design
  as it exists today.
- Refresh grant looks up `sid`, exchanges for `prt`, calls
  `provider.refreshToken(prt)`.

**When `needsSessionTable === false`** (Cognito):
- Handler does not touch `auth.sessions`.
- Refresh JWT carries the provider refresh token directly — **but
  only as an opaque handle**, not as a secret the BOA layer
  holds. Concretely: for Cognito, the provider refresh token IS
  what the client needs to refresh, so the `refresh_token` field of
  the signup/signin response is simply the Cognito refresh token
  itself. No BOA-minted refresh JWT is issued for the Cognito path.
- Refresh grant receives the Cognito refresh token from the client,
  calls `provider.refreshToken(providerRefreshToken)` directly.

This matches how `@supabase/supabase-js` already treats
`refresh_token` as an opaque string it hands back on refresh. The
client does not care whether the string is a BOA JWT or a Cognito
token.

### Alternative considered: keep BOA-minted refresh JWT for Cognito

A BOA-minted refresh JWT could wrap the Cognito refresh token in the
`prt` claim (pre-V-07 behavior) just for the Cognito path. Rejected
because:
- It regresses V-07 unnecessarily on the Cognito path (exposes the
  provider token in base64 even though the provider token is less
  sensitive than a GoTrue one).
- It adds complexity (two refresh shapes to parse) without a
  security gain.
- It does not simplify the problem the design is trying to solve.

Passing the Cognito refresh token through unchanged is simpler,
still consistent with `@supabase/supabase-js` wire format, and does
not require pgrest-lambda to store provider secrets at all.

### Alternative considered: keep sessions, self-bootstrap the schema

pgrest-lambda could call `ensureAuthSchema(pool)` from the handler
path so the table is created on first use, same way the GoTrue
provider does. This makes the Cognito path work, but:
- It still stores the Cognito refresh token in BOA's database for
  no security gain.
- It creates an unused `auth.users` and `auth.refresh_tokens` table
  on Cognito deployments.
- It couples Cognito deployments to DSQL schema management even
  though no user data flows through it.

Rejected. The right answer is not to create tables nobody needs.

## Impact

### Files that need to change

- `src/auth/providers/interface.mjs` — document the new optional
  `needsSessionTable` capability.
- `src/auth/providers/cognito.mjs` — add `needsSessionTable: false`.
- `src/auth/providers/gotrue.mjs` — add `needsSessionTable: true`
  (explicit even though it is the current behavior, so the
  contract is visible).
- `src/auth/handler.mjs` — branch on the capability:
  - `handleSignup`: skip `createSession` when `false`; return the
    provider refresh token as `refresh_token`.
  - `handlePasswordGrant`: same as above.
  - `handleRefreshGrant`: if the incoming token is not a BOA JWT
    (no `sid`), treat it as a provider refresh token and call
    `provider.refreshToken(incoming)` directly.
- `src/auth/jwt.mjs` — no change to `signRefreshToken` semantics,
  just not called on the Cognito path.
- `src/auth/__tests__/handler.test.mjs` — add coverage for Cognito
  path that asserts no database query is made.

### Contract changes

- **Cognito refresh tokens are now Cognito tokens.** Previously the
  client held a BOA JWT with a `sid` claim. After: client holds a
  Cognito refresh token. Wire format is unchanged (`refresh_token`
  field, opaque string); client code does not need to change.
- **No `auth.sessions` table required for Cognito deployments.**
  The CHANGELOG entry that called this out as "breaking" was
  wrong. Revert that line when this change ships.

### CHANGELOG correction

The v0.2.0 entry claims "Cognito deployments now require a
PostgreSQL database for session storage (`auth.sessions` table)."
That claim was introduced by V-07 but never correctly gated on
provider. When this change ships, amend the v0.2.0 line (or add a
v0.2.1 entry correcting it).

### Security impact

- **GoTrue path**: unchanged. V-07's `sid` indirection still
  applies. Provider refresh tokens never appear in JWTs.
- **Cognito path**: the Cognito refresh token is now returned to
  the client in the `refresh_token` field of the auth response. The
  client is expected to treat it as a secret — which is the same
  expectation GoTrue refresh tokens already have. Cognito refresh
  tokens are never stored in pgrest-lambda's database.
- **No regression on V-07**: V-07 was closing a specific leak
  (base64-decoded refresh JWT exposing GoTrue refresh token). That
  leak does not exist when the `refresh_token` is itself a Cognito
  token, because the Cognito token has no inner payload to decode.

## Open Questions

1. **Signout on Cognito**: the current `signOut` is a no-op. Should
   we call Cognito's `GlobalSignOut` to revoke the refresh token
   server-side? Not required by this change, but worth clarifying
   in the same pass.
2. **Access-token signing**: the BOA access token is still a
   pgrest-lambda-minted HS256 JWT with `role` / `sub` / `email` for
   the authorizer to consume. That is correct and should not
   change. Only the refresh token behavior differs.
3. **Migration for existing deployments**: not applicable — no
   production deployments exist yet.

## Status

Proposed 2026-04-24 after BOA end-to-end validation surfaced the
`42P01` failure on `/auth/v1/signup` with a Cognito-backed
deployment. Implementation deferred to a follow-up session.
