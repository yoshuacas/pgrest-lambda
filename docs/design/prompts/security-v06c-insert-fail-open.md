# V-06c — Close the Cedar INSERT fail-open

Close the INSERT fail-open limb of security finding V-06 (High). The
Cedar translation path for INSERT currently treats *any non-trivial
residual* from partial evaluation as "allow", throwing the residual
away. This bypasses any `permit ... when { resource.<col> == ... }`
policy — the most common pattern. On DSQL deployments Cedar is the
only authz layer, so this is a full fail-open against row-conditioned
INSERT policies.

This task is only the INSERT fail-open fix, its tests, and the
paperwork. V-06b (optional RLS templates for RLS-capable backends)
remains a separate track. Do **not** flip the overall V-06 status to
Fixed — only the V-06c limb.

## The vulnerability

`src/rest/cedar.mjs:485-491`:

```js
const partial = isAuthorizedPartial({
  principal: principalUid,
  action: actionUid,
  resource: null,
  context: { table: resource, resource_type: type },
  policies: cachedPolicies,
  entities,
});

if (partial.type === 'residuals') {
  const resp = partial.response;
  if (resp.decision === 'allow') return true;
  if (resp.decision !== 'deny' && resp.nontrivialResiduals.length > 0) {
    return true;                                    // ← fail-open
  }
}
```

Caller path for INSERT is `src/rest/handler.mjs:322-324`:

```js
cedar.authorize({
  principal, action: 'insert', resource: table, schema,
});
```

The handler has the proposed row in `body` but never hands it to
`authorize()`, so Cedar can't evaluate row attributes and falls into
the residual branch. The branch returns `true` and the INSERT proceeds.

### Concrete exploit

Policy:

```cedar
permit (principal, action == PgrestLambda::Action::"insert",
        resource == PgrestLambda::Table::"orders")
when { resource.owner_id == principal.uid };
```

Request (as any authenticated user with uid `A`):

```http
POST /rest/v1/orders
Content-Type: application/json

{ "owner_id": "<uid-of-user-B>", "amount": 9999 }
```

Expected: 403 (policy requires `owner_id == caller uid`).
Actual at HEAD: 201. Row inserted with `owner_id = B`. The `permit`
condition was kept as a residual and silently discarded.

## Fix scope

Evaluate the residual against the proposed row before inserting, and
reject by default when partial eval cannot resolve. Two viable designs
— pick one in the design doc, justify the pick, and implement it.
Both close the bug; the design doc should reason about wire-compat,
DSQL vs. standard-Postgres behavior, and test surface.

### Option A — In-process residual evaluation

After partial eval produces residuals for an INSERT, translate each
residual's `when` body against the *proposed row* (the `body` already
parsed in the handler) rather than against a SQL column reference.
`resource.<col>` becomes the literal `body.<col>`; `principal.<attr>`
is already bound. If every `permit` residual evaluates to `true` and
no `forbid` residual evaluates to `true`, allow; otherwise 403.

Bulk inserts: apply per-row; any row that fails denies the whole
request with a row index in the error detail (sanitized — see V-09 —
so the detail must be a safe string).

Pros: no extra SQL round-trip, works identically on DSQL and standard
PG, behavior is deterministic and reviewable.

Cons: requires a second translator variant (`translateExprAgainstRow`
or similar). The existing `translateExpr` only emits SQL. Shared
expression-shape code can be factored, but it is real new surface.

### Option B — SQL-side check via `WITH ... WHERE`

Rewrite the INSERT to `WITH candidate AS (SELECT <row>) INSERT INTO
<table> SELECT * FROM candidate WHERE <authz SQL>`, reusing the
existing `buildAuthzFilter` translator. Zero rows inserted → 403.

Pros: reuses the existing translator, no parallel evaluator.

Cons: forbid-conditions translate awkwardly (`NOT (...)`); bulk inserts
need per-row status; need to confirm DSQL supports the shape; harder to
distinguish "zero rows inserted" (policy denial) from "client sent
zero rows" (client error → should stay 400-ish).

Design doc MUST compare both options and justify the choice.

## Acceptance

Regardless of the option chosen, the following must hold at the end:

1. The fail-open branch at `src/rest/cedar.mjs:488-489` is gone.
   `authorize()` returns `true` only when Cedar reports a *decided*
   allow, or when residuals have been evaluated against the proposed
   row and all evaluate to a decided allow. A residual the fix cannot
   evaluate against the row is a deny, not an allow.
2. No regression on SELECT / UPDATE / DELETE — those continue to use
   `buildAuthzFilter` to translate residuals into `WHERE` fragments.
3. Service-role bypass still works — `PgrestLambda::ServiceRole` gets
   unconditional allow, matching the documented default policy.
4. RPC `call` authz continues to use `authorize()` and its behavior is
   unchanged (RPCs don't carry a "row" the way INSERTs do — either
   accept the existing decided-path behavior, or document why RPC is
   unaffected by the fix).

## Tests

New integration tests under
`src/rest/__tests__/handler.integration.test.mjs` (or a dedicated
`cedar-insert-authz.test.mjs` if the suite gets noisy):

- **Exploit regression** — policy with
  `when { resource.owner_id == principal.uid }`, user inserts with
  `owner_id` set to someone else's uid → 403. Same user inserting with
  their own uid → 201.
- **Bulk insert rejection** — mixed batch where one row matches the
  policy and one doesn't. Expect whole request rejected with a 403 and
  a row-index in the error detail (sanitized string, not raw detail).
- **Service-role bypass** — service_role can insert any row regardless
  of row-conditioned permits.
- **Decided-allow (no row conditions)** — existing table-level permits
  (e.g., `permit(principal, action == "insert", resource == Table::"X")`
  with no `when`) keep working; the fix must not break unconditional
  permits.
- **Forbid residual** — `forbid ... when { resource.flag == true }`
  policy: inserting with `flag: true` → 403; inserting with
  `flag: false` → 201.
- **Missing column on row** — policy references `resource.col` but the
  body omits `col`. Must be a deny (fail-closed), not an allow.

Unit tests for the new evaluator (if Option A): one per expression
shape already supported by `translateExpr` (==, !=, <, <=, >, >=,
&&, ||, !, `has`, membership). Mirror the existing translator tests
for parity.

## Documentation

1. **`docs/security/findings/V-06-no-rls.md`** — extend the "Partial
   Remediation" section: add a V-06c entry pointing at the fix commit
   and the regression tests. Call out that V-06b (RLS templates)
   remains. Do **not** change the top-level `Status: Open` line —
   V-06 stays Open until V-06b is addressed.
2. **`docs/security/assessment.md`** — keep V-06 as Open, but update
   its Notes column to cite V-06a (linter) and V-06c (this fix) as
   closed limbs, with V-06b (RLS) remaining.
3. **`docs/reference/authorization.md`** — under the translation /
   partial-evaluation section, document what happens on INSERT when a
   `permit ... when { resource.<col> == ... }` policy is in play:
   residuals are evaluated against the proposed row; any undecided
   residual denies. Add a short worked example.
4. **`docs/guide/write-cedar-policies.md`** — if there's a "Common
   patterns" or "Pitfalls" section, note that row-conditioned INSERTs
   now enforce at the application layer (previously a silent gap).
5. **`CHANGELOG.md`** — under Unreleased → Security, note V-06c is
   closed with a short before/after summary.

## Out of scope

- V-06b — RLS template or backend-matrix documentation for
  RLS-capable deployments. Separate task.
- Refactoring `translateExpr` beyond what's needed to support the
  new row-evaluation path. If Option A, factor out the shared shape
  dispatch; don't rewrite the translator.
- Runtime policy hot-reload changes. Reuse the existing policy cache.

## Success criteria

- The exploit regression test is red at HEAD and green after the fix.
- No change in behavior for SELECT / UPDATE / DELETE paths.
- `authorize()` has no path that silently allows an undecided residual.
- Full test suite green (`npm test`).
- V-06 finding file updated to reflect V-06c closure without flipping
  V-06 overall to Fixed.
- CHANGELOG, authorization reference, and write-cedar-policies guide
  updated.
