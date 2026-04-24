# V-09 — PostgreSQL error details forwarded to client

- **Severity (reported):** Medium
- **Status:** Open
- **Affected (reported):** `src/rest/errors.mjs:48-57`, `src/rest/handler.mjs:340-354`
- **Backend dependence:** None (same PG error model across backends)

## Report summary

PG error `message`, `detail`, `hint` forwarded verbatim. Constraint names, column names, values (including keys that exist) reach the client. Enables schema reconnaissance and confirms existence of records.

## Our analysis

**Status: still open at HEAD.**

- `src/rest/errors.mjs:48-57` — `mapPgError(pgError)` forwards `pgError.message`, `pgError.detail`, `pgError.hint` verbatim.
- `src/rest/handler.mjs:348-353` — catch-all wraps `err.message` into a 500. Arbitrary internal error text can reach clients.
- PG error code map (`errors.mjs:22-28`) covers 5 codes only; anything else produces a 500 with the raw message.

Wire-compat note: PostgREST itself forwards `message`/`detail`/`hint` for these error codes, so sanitizing changes supabase-js-observable behavior. This isn't a blocker — supabase-js reads `code` for branching, not `message`/`detail` — but worth capturing in tests.

**Fix surface:** extend `mapPgError` with a safe-message map per code (falling back to a generic string for unknown codes); gate verbose mode behind `config.errors.verbose = true` for dev. Keep `code` intact in all cases. The handler catch-all (`handler.mjs:348-353`) also needs to swallow `err.message` for non-PostgREST errors in prod mode.

## Decision

_Pending triage._ Likely: allow verbose-mode (dev) vs. sanitized-mode (default / prod). Sanitized mode maps common PG codes to generic messages; preserves `code` for client-side branching.

## Evidence

_Commit / test / doc link when fixed._

## Residual risk

Sanitized mode reduces debuggability in prod; mitigated by V-23 structured logging keeping full detail server-side.

## Reviewer handoff

_Two-sentence summary for the reviewer agent — note the wire-compat consideration with supabase-js._
