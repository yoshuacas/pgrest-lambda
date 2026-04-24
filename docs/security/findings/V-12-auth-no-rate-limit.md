# V-12 — No rate limiting on auth endpoints

- **Severity (reported):** Medium
- **Status:** Open
- **Affected (reported):** `src/auth/handler.mjs`
- **Backend dependence:** None

## Report summary

Signup, password-grant, and refresh-grant endpoints have no app-layer throttling. bcrypt cost 10 provides ~100ms floor per attempt but doesn't stop credential stuffing at scale or account enumeration.

## Our analysis

**Status: still open at HEAD.**

- `src/auth/handler.mjs:85-191` — `handleSignup`, `handlePasswordGrant`, `handleRefreshGrant` have no counters, no lockout, no throttling.
- `src/auth/providers/gotrue.mjs:74` — bcrypt cost 10 (~100ms). This is ~10 QPS per Lambda instance per attacker — not a defense at Lambda scale-out.
- `src/auth/providers/gotrue.mjs:66-71` — dummy-hash timing-safe comparison prevents enumeration via timing, but not via error-response enumeration (`invalid_grant` vs any other response), which is identical here — good.

**Library posture options:**
1. Document infra-layer throttling (API Gateway usage plans, WAF rules) in the consumer security docs.
2. Add optional in-auth counters — per-email attempts with lockout window + per-IP burst. Backed by the same DB. Gated behind `config.auth.rateLimit = { ... }`. Non-trivial: needs a DB table and a sliding-window algorithm.

Recommend (1) now, (2) as a deferred item.

## Decision

_Pending triage._

## Evidence

_Commit / test / doc link when fixed._

## Residual risk

Distributed brute force (slow, many IPs) remains unless WAF is configured. Documented.

## Reviewer handoff

_Two-sentence summary for the reviewer agent._
