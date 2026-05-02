# V-06 — Cedar is the only authorization layer (no RLS)

- **Severity (reported):** High
- **Status:** Open (partial) — V-06a Fixed, V-06c Fixed, V-06b remains
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

V-06 remains **Open** overall. Evidence below is per closed limb.

### V-06a — Cedar policy linter (closed)

- **Fix commits:** `2bec1e5` (linter), `5af5efc` (merge, PR #3).
- **CLI:** `pgrest-lambda lint-policies` — see `docs/reference/cli.md` and `docs/guide/lint-cedar-policies.md`.
- **Linter source:** `src/policies/linter.mjs` (4 error rules + 4 warning rules).
- **Agent skill:** `.kiro/skills/cedar-policy-author/SKILL.md` mandates running the linter before finishing a policy edit.

### V-06c — INSERT fail-open (closed)

- **Fix commits (on branch `sec/V-06c-insert-fail-open`):**
  - `28cc3e7` test(V-06c): add INSERT authorization integration tests
  - `079a542` feat(V-06c): add evaluateExprAgainstRow for INSERT authz
  - `1871828` feat(V-06c): add evaluateResiduals and authorizeInsert tests
  - `aad080b` feat(V-06c): tighten authorize() and wire handler POST
  - `63ff979` docs(V-06c): update security findings, reference, and changelog
- **Design:** `docs/design/security-v06c-insert-fail-open.md` — two-phase authorization model, threat model, and explicit trade-off analysis between in-process residual evaluation (Option A, chosen) and SQL-side WITH...WHERE (Option B, rejected).
- **Before:** `src/rest/cedar.mjs:486-491` returned `true` on any non-trivial residual with `decision !== 'deny'`. INSERT handler at `src/rest/handler.mjs` called `authorize()` without passing `body`, so row-conditioned `permit ... when { resource.<col> == ... }` policies were silently bypassed.
- **After:**
  - `src/rest/cedar.mjs:378-452` — `evaluateExprAgainstRow(expr, row, principal)` evaluates Cedar residual expressions against a concrete row object. Missing columns fail closed.
  - `src/rest/cedar.mjs:454-505` — `evaluateResiduals(response, row, principal, tablePermitGranted)` AND-s all `when` conditions on each policy, requires at least one permit (table-level or row-conditioned), and honors any matching forbid.
  - `src/rest/cedar.mjs:612-705` — `authorizeInsert({ principal, resource, rows, ... })` runs phase 1 (`isAuthorized` against `Table`) and phase 2 (partial eval + row evaluation). Bulk inserts checked per row; the failing row's index is included in the 403 detail (sanitized, consistent with V-09).
  - `src/rest/cedar.mjs:486-497` — `authorize()` fail-open branch is deleted. Undecided residuals now deny.
  - `src/rest/handler.mjs:323` — POST path calls `cedar.authorizeInsert({ principal, resource: table, rows: body, schema })` instead of `cedar.authorize(...)`.
- **Tests:**
  - `src/rest/__tests__/cedar-insert-authz.integration.test.mjs` (408 lines, 8 scenarios): owner-mismatch 403 / owner-match 201 / bulk mixed-ownership 403 with row index / service_role bypass / decided-allow unchanged / forbid residual true → 403 / forbid residual false → 201 / missing column → 403 fail-closed.
  - `src/rest/__tests__/cedar.test.mjs` — expanded by ~500 lines with unit coverage for every `evaluateExprAgainstRow` shape (==, !=, <, <=, >, >=, &&, ||, !, `has`, `if/then/else`, principal attribute access) and `evaluateResiduals` permit/forbid combinations.
  - Full suite: 891 pass / 0 fail at branch HEAD (was 847 at `main`; +44 tests from this work).
- **Scope of fix:** INSERT only. SELECT / UPDATE / DELETE continue to translate residuals into SQL WHERE via `buildAuthzFilter()` — unchanged. RPC `call` remains `authorize()` (table-level decision only; row context does not apply).
- **DSQL posture:** Pure JavaScript evaluation, no SQL dependency — works identically on DSQL and Aurora/standard PG.

### V-06b — Optional RLS templates (remains open)

No code change planned at this time. Library consumers on Aurora/RDS/standard Postgres are encouraged to enable RLS as defense-in-depth on top of Cedar; a templated `policies/` SQL set is a future deliverable. Documented in the backend matrix of `docs/security/assessment.md`.

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

V-06 is a multi-limb finding: V-06a (policy linter) and V-06c (INSERT fail-open) are Fixed; V-06b (optional RLS templates) remains Open and is intentionally deferred because the primary universal gate is application-layer Cedar — RLS is documented defense-in-depth for RLS-capable backends only, not the fix.

For V-06c specifically, verify: (1) `authorize()` no longer has a branch that returns `true` on a non-decided residual — see the deletion at `src/rest/cedar.mjs:486-497`; (2) INSERT requests exercise `authorizeInsert()` with the proposed row data — `src/rest/handler.mjs:323`; (3) the exploit regression at `src/rest/__tests__/cedar-insert-authz.integration.test.mjs:165` (owner-mismatch INSERT under an `owner_id == principal.uid` policy) returns 403, which it does on this branch and did not at the prior HEAD. Pay attention to missing-column fail-closed behavior (Test 8 at line 274) since that is the trap most likely to regress under future translator work.
