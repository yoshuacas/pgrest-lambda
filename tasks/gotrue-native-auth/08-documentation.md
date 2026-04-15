# Task 08: Documentation Updates

**Agent:** implementer
**Design:** docs/design/gotrue-native-auth.md
**Depends on:** Task 04 (provider wiring, default change)

## Objective

Update project documentation to reflect the GoTrue-native
auth provider as the default, with Cognito as optional.

## Target Tests

No automated tests. Documentation changes are verified by
reading.

## Implementation

### 1. `README.md`

Update the auth section to document:
- GoTrue is the default auth provider — no external
  dependencies needed.
- Users and refresh tokens are stored in the same
  PostgreSQL database.
- Cognito is available as an optional provider by setting
  `AUTH_PROVIDER=cognito`.
- Password policy: minimum 8 characters, uppercase,
  lowercase, and numbers.
- Refresh token rotation with family revocation.
- Dev server now includes working auth endpoints.

Keep the existing structure and tone. Do not rewrite
unrelated sections.

### 2. `CLAUDE.md`

Update rule 8. Current text:

> **Auth providers are swappable** — Cognito is the default.

Change to reflect GoTrue as the default:

> **Auth providers are swappable** — GoTrue-native is the
> default, storing users in the `auth` schema of the same
> PostgreSQL database. Cognito is available as an optional
> provider (`AUTH_PROVIDER=cognito`).

### 3. `CHANGELOG.md`

Add an entry under the `[Unreleased]` section:

```markdown
### Added
- GoTrue-native auth provider as default — users and refresh
  tokens stored directly in PostgreSQL (DSQL-compatible)
- Password validation with configurable policy (min 8 chars,
  uppercase, lowercase, numbers)
- Refresh token rotation with family revocation
- `expires_at` field in session responses for supabase-js
  v2.39+ compatibility
- Auth endpoints in dev server (`dev.mjs`)

### Changed
- Default auth provider changed from `cognito` to `gotrue`
- SAM template: Cognito resources now conditional on
  `AuthProvider=cognito` parameter
- Dev server routes auth requests through combined handler
```

## Acceptance Criteria

- `README.md` auth section accurately describes GoTrue as
  default with Cognito as opt-in.
- `CLAUDE.md` rule 8 updated.
- `CHANGELOG.md` has an Unreleased entry covering all
  changes.
- No unrelated content is modified.
- `npm test` still passes.

## Conflict Criteria

- If `CHANGELOG.md` already has a GoTrue-native auth entry,
  investigate whether this task was already completed.
- If rule 8 in `CLAUDE.md` already mentions GoTrue as
  default, skip that change.
