# V-09 — PostgreSQL error details forwarded to client

- **Severity (reported):** Medium
- **Status:** Fixed
- **Affected (reported):** `src/rest/errors.mjs:48-57`, `src/rest/handler.mjs:340-354`
- **Backend dependence:** None (same PG error model across backends)
- **Fix commit:** `63284cb` on `sec/V-09-pg-error-sanitize` (merged via PR #2)

## Report summary

PG error `message`, `detail`, `hint` forwarded verbatim. Constraint names, column names, values (including keys that exist) reach the client. Enables schema reconnaissance and confirms existence of records.

## Our analysis

**Status: fixed at HEAD.**

Two leak surfaces were flagged. Both are now closed:

1. **`mapPgError` in `src/rest/errors.mjs`** — previously forwarded the PG driver's raw `message`, `detail`, and `hint` verbatim for every mapped SQLSTATE (23505, 23503, 23502, 42P01, 42703) and for any unmapped code. **Closed by this finding's fix** (`63284cb`).
2. **REST handler catch-all in `src/rest/handler.mjs`** — previously wrapped `err.message` into a 500. **Closed earlier by sec/L-20** (generic message + `errorId` for server-side correlation, commit `b0b3808`).

`mapPgError` now returns generic per-SQLSTATE messages by default (sanitized mode). Raw `message`, `detail`, and `hint` are replaced with safe text, and `details`/`hint` are forced to `null`. SQLSTATE `code` is preserved in both modes for supabase-js wire compatibility. Verbose mode (`config.errors.verbose` or `PGREST_ERRORS_VERBOSE=true`) restores raw passthrough for local development.

The handler logs raw PG error details server-side via `console.warn` (structured JSON) when sanitized mode is active, so operators retain debuggability without client exposure.

## Decision

Sanitized mode (default) maps common PG codes to generic messages; preserves `code` for client-side branching. Verbose mode opt-in for dev only.

## Evidence

### Commit

- Branch: `sec/V-09-pg-error-sanitize`
- Squashed commit: `63284cb` — *V-09 — Sanitize PostgreSQL Error Details*
- PR: https://github.com/yoshuacas/pgrest-lambda/pull/2
- Test count: **774 → 782 (+8 net; +21 new, -13 removed from stale expectations). All pass.**

### Code changes at HEAD

**`src/rest/errors.mjs:30-39`** — new `PG_SAFE_MESSAGE` map and fallback:

```js
const PG_SAFE_MESSAGE = {
  '23505': 'Uniqueness violation.',
  '23503': 'Foreign key violation.',
  '23502': 'Not-null constraint violation.',
  '42P01': 'Undefined table.',
  '42703': 'Undefined column.',
};
const PG_SAFE_FALLBACK = 'Request failed with a database error.';
```

**`src/rest/errors.mjs:102-124`** — sanitizing `mapPgError`:

```js
export function mapPgError(pgError, { verbose = false } = {}) {
  const statusCode = PG_ERROR_MAP[pgError.code] || 500;
  if (verbose) {
    return new PostgRESTError(statusCode, pgError.code,
      pgError.message, pgError.detail || null, pgError.hint || null);
  }
  const safeMessage = PG_SAFE_MESSAGE[pgError.code] || PG_SAFE_FALLBACK;
  return new PostgRESTError(statusCode, pgError.code, safeMessage,
    null, null);
}
```

**`src/rest/handler.mjs:443-457`** — handler catch block: logs raw PG detail server-side when sanitized, passes `verbose` flag through to `mapPgError`:

```js
if (err.code && typeof err.code === 'string'
    && /^[0-9A-Z]{5}$/.test(err.code)) {
  if (!ctx.errorsVerbose) {
    console.warn(JSON.stringify({
      level: 'warn', pgCode: err.code,
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

**`src/index.mjs`** — `errors.verbose` config + `PGREST_ERRORS_VERBOSE` env var. Uses `??` (nullish coalescing), so an explicit `config.errors.verbose = false` correctly beats `PGREST_ERRORS_VERBOSE=true`.

### Wire impact (before → after)

Unique-constraint violation on `users.email`:

**Before (`b0b3808` and earlier):**
```json
{
  "code": "23505",
  "message": "duplicate key value violates unique constraint \"users_email_key\"",
  "details": "Key (email)=(alice@example.com) already exists.",
  "hint": null
}
```
Exposes: column name (`email`), a specific record value (`alice@example.com`), constraint name (`users_email_key`).

**After (`63284cb`, default):**
```json
{
  "code": "23505",
  "message": "Uniqueness violation.",
  "details": null,
  "hint": null
}
```
`code` preserved for supabase-js `error.code === '23505'` branching.

### Test evidence

**Unit (`src/rest/__tests__/errors.test.mjs`):**
- `mapPgError() sanitization › sanitized mode (default)` — one test per mapped SQLSTATE (23505, 23503, 23502, 42P01, 42703), plus unmapped-code fallback.
- `raw PG text never in sanitized output` — generates a PG error whose `message`/`detail`/`hint` contain distinctive tokens (column names, values), asserts none of those tokens appear in the returned `PostgRESTError`.
- `mapPgError() sanitization › verbose mode` — raw passthrough for mapped and unmapped codes.
- `mapPgError() sanitization › code preservation` — SQLSTATE `code` identical in both modes.
- `map sync guard › PG_SAFE_MESSAGE and PG_ERROR_MAP have identical keys` — drift guard; breaks if a future dev adds a code to one map without the other.

**Integration (`src/rest/__tests__/handler.integration.test.mjs`):**
- `PG error through handler uses safe message` (23505 wire-level sanitization).
- `PG error through handler with verbose ctx uses raw text` (verbose opt-in).
- `PG error with hint sanitized in handler` (55P03-style error with `hint` field → `null`).
- `PG error with hint verbose in handler` (same error + verbose → passthrough).
- `structured log emitted for sanitized PG error` (asserts `console.warn` JSON shape).
- `verbose mode does not emit structured PG log` (asserts `console.warn` is NOT called when operator chose verbose).

**Config (`src/__tests__/index.test.mjs`):**
- `resolveConfig` coverage via `createPgrest(...)._ctx.errorsVerbose`:
  - Default → `false`.
  - `{ errors: { verbose: true } }` → `true`.
  - `PGREST_ERRORS_VERBOSE=true` + no config → `true`.
  - `config.errors.verbose = false` + `PGREST_ERRORS_VERBOSE=true` → `false` (config wins; protects the `??` vs `||` edge case).

### Documentation

- `docs/security/assessment.md` — V-09 row updated to Fixed.
- `CHANGELOG.md` Unreleased → Security — entry added describing sanitization, code preservation, and the `PGREST_ERRORS_VERBOSE` opt-in for local dev.
- `docs/design/security-v09-pg-error-sanitize.md` — full design doc with the 20 test specifications.

## Residual risk

- **Debuggability in prod** is reduced by design. Mitigated by the server-side `console.warn` structured log (CloudWatch-ready: `level: 'warn', pgCode, message, detail, hint`), so operators can still diagnose. Operators who turn on `PGREST_ERRORS_VERBOSE=true` in production re-enable the original leak — CHANGELOG flags this as a dev-only knob.
- **Unmapped SQLSTATE codes** (e.g., 42501 insufficient privilege, 22P02 invalid text representation) now fall through to a generic 500 with the fallback message. Secure default, but clients lose signal. Broadening `PG_ERROR_MAP` / `PG_SAFE_MESSAGE` is a follow-up that can happen without re-opening V-09, since the sanitization surface remains closed.
- **Log format duplication** between the sanitized-PG-error branch (`handler.mjs:446`) and the catch-all from sec/L-20 (`handler.mjs:464`) is slightly different shapes. Noted in the re-review as a future-cleanup item, not a defect.

## Reviewer handoff

V-09 is closed by two coordinated fixes: **sec/L-20** (`b0b3808`) for the handler catch-all, and **this branch** (`63284cb`, PR #2) for `mapPgError`. Default behavior now returns generic SQLSTATE-aware messages with `details` and `hint` forced to `null`; SQLSTATE `code` is preserved in both modes for supabase-js wire compatibility. Verbose mode is explicit dev-only opt-in (`errors.verbose` in config or `PGREST_ERRORS_VERBOSE=true`). Server-side log retains full PG detail for operators. Two `rring review` passes confirmed no correctness issues; 782/782 tests green at HEAD.
