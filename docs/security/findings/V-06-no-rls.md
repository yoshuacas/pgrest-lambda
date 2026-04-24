# V-06 — Cedar is the only authorization layer (no RLS)

- **Severity (reported):** High
- **Status:** Open
- **Backend dependence:** **Yes — primary example of heterogeneous backend posture**

## Report summary

Authorization is enforced entirely by Cedar policies compiled to SQL WHERE fragments. There is no PostgreSQL RLS as a secondary enforcement layer. A Cedar translation bug, misconfigured policy, or SQL injection would bypass the only gate.

## Our analysis

**Status: open at HEAD; this is a per-backend posture question, not a single-fix item.**

Code reality:
- `src/rest/cedar.mjs:349-395` — `authorize()` enforces at application layer. For inserts: if Cedar returns `allow`, proceed; else try partial eval; **if partial eval returns any non-trivial residual, treat as allowed** (cedar.mjs:386-388). The report flags this as potentially over-permissive for INSERT. Worth examining in depth during triage.
- `src/rest/cedar.mjs:397-461` — `buildAuthzFilter()` translates residuals to SQL WHERE fragments for read/update/delete paths.
- `src/rest/handler.mjs:167,224-226,248-251,262-265` — every handler path calls Cedar; fail-closed when policies absent (cedar.mjs:350-355).
- No `SET ROLE`, no `CREATE POLICY` anywhere in the codebase. SQL executes as the single pool user. SQL injection or Cedar bypass = full public-schema access.

Backend posture:
- **DSQL:** no RLS / `SET ROLE` — Cedar is structurally the only option. Must harden Cedar (policy lint, fuzz `translateExpr`, observability per V-16). Residual risk is inherent to the backend and documented.
- **Aurora / RDS / standard Postgres:** RLS available; consumer can opt in for DB-layer defense-in-depth on top of Cedar.

Library posture:
- Keep Cedar as the primary, universal gate.
- Provide optional RLS template / SQL for RLS-capable backends.
- Document the per-backend delta in the consumer-facing security docs.
- Revisit the INSERT `nontrivialResiduals.length > 0 → true` branch (cedar.mjs:386-388) — this deserves its own review to confirm it's not a fail-open.

## Decision

_Pending triage._

## Evidence

_Commit / test / doc link when fixed._

## Residual risk

- **DSQL deployments:** any Cedar bypass is a full compromise. Mitigations: lint, test, log.
- **RLS-capable deployments opting out of RLS:** same risk; documented.
- **RLS-capable deployments opting in:** defense-in-depth achieved.

## Reviewer handoff

_Two-sentence summary for the reviewer agent — emphasize that this finding has different dispositions per backend and that documentation is part of the mitigation for DSQL._
