# V-23 — No audit logging system-wide

- **Severity (reported):** Info
- **Status:** Open
- **Affected (reported):** System-wide
- **Backend dependence:** None

## Report summary

No structured logging of auth events, authz decisions, mutations, refreshes, or errors. Repudiation risk; incident investigation is impossible.

## Our analysis

**Status: still open at HEAD.**

Grep confirms no logging infrastructure: no `console.log` in `src/`, no logger import, no observability module. Every handler is silent; errors come back to the client only.

Umbrella item. Pairs with V-16 (authz-decision slice). Scope:
- Auth events (signup, login, refresh, logout, failures)
- Authz decisions (Cedar allow/deny; V-16)
- Mutations (table, row count; not row bodies by default)
- Schema refreshes (actor, trigger, duration)
- Errors (PG code, class, request ID)

**Fix surface:** `src/shared/logger.mjs` exporting `log(event, meta)` that writes single-line JSON to stdout. Configurable level. Correlation ID from `event.requestContext.requestId`. Every subsystem calls it at the appropriate seam. Structural, ~20-line module + ~15-20 call sites.

## Decision

_Pending triage._

## Evidence

_Commit / test / doc link when fixed._

## Residual risk

Log sink is consumer's responsibility; pgrest-lambda writes to stdout (CloudWatch by default on Lambda).

## Reviewer handoff

_Two-sentence summary for the reviewer agent._
