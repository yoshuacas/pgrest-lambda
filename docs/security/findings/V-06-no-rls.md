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

## Partial Remediation — V-06a (Policy Linter)

Shipped `pgrest-lambda lint-policies` in e98c5b3.
The linter validates Cedar policies for permissiveness and
correctness at authoring time (4 error rules, 4 warning
rules). This closes the "policy linter/validator" limb of
V-06 but does not address RLS (V-06b) or the INSERT
fail-open branch (V-06c).

## Partial Remediation — V-06c (INSERT Fail-Open)

The fail-open in `authorize()` for INSERT residuals is closed.
When partial evaluation produced non-trivial residuals for an
INSERT, the old code at `cedar.mjs:386-388` returned `true`
(allow) without checking the proposed row against the policy
condition. This was a full bypass of row-conditioned INSERT
policies on DSQL deployments where Cedar is the only
authorization layer.

INSERT now uses `authorizeInsert()`, which evaluates
row-conditioned policies against the proposed row data
in-process (Option A from the design). The fix runs two
phases: a table-level `isAuthorized` check, then partial
evaluation with residual conditions evaluated against the
proposed row via `evaluateExprAgainstRow()`. Missing columns
fail-closed. Bulk inserts are checked per-row.

The fix is DSQL-compatible — it has no SQL dependency. The
authorization decision is made entirely in JavaScript before
the INSERT query is built.

The `authorize()` function itself has been tightened: the
residual branch now returns `false` (deny) instead of `true`
for any undecided residual, closing the theoretical gap for
all callers.

See `docs/design/security-v06c-insert-fail-open.md` for the
full design, threat model, and testing strategy.

## Reviewer handoff

_Two-sentence summary for the reviewer agent — emphasize that this finding has different dispositions per backend and that documentation is part of the mitigation for DSQL._
