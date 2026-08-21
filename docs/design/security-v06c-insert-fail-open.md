# Close the Cedar INSERT Fail-Open (V-06c)

## Overview

The Cedar authorization path for INSERT has a fail-open bug:
when partial evaluation produces non-trivial residuals (any
`permit ... when { resource.<col> == ... }` policy), the
`authorize()` function treats the undecided residual as
"allow" and discards it. The INSERT proceeds without checking
the proposed row against the policy condition. On DSQL
deployments Cedar is the only authorization layer, so this
is a full bypass of row-conditioned INSERT policies.

This design closes the V-06c limb of security finding V-06
(High). It does not address V-06b (optional RLS templates
for RLS-capable backends).

## Current CX / Concepts

### The Vulnerability

`src/rest/cedar.mjs:485-491` — the residual branch in
`authorize()`:

```javascript
if (partial.type === 'residuals') {
  const resp = partial.response;
  if (resp.decision === 'allow') return true;
  if (resp.decision !== 'deny'
      && resp.nontrivialResiduals.length > 0) {
    return true; // ← fail-open
  }
}
```

The caller path for INSERT is `src/rest/handler.mjs:322-324`:

```javascript
cedar.authorize({
  principal, action: 'insert', resource: table, schema,
});
```

The handler has the proposed row in `body` (parsed at
`handler.mjs:198-206`) but never passes it to `authorize()`.
Cedar's partial evaluator cannot evaluate `resource.<col>`
attributes without a concrete resource, so any row-conditioned
policy produces a residual. The residual branch returns `true`
and the INSERT proceeds unchecked.

### Concrete Exploit

Policy:

```cedar
permit (
    principal is PgrestLambda::User,
    action == PgrestLambda::Action::"insert",
    resource == PgrestLambda::Table::"orders"
) when { resource.owner_id == principal };
```

Request (as authenticated user with uid `A`):

```http
POST /rest/v1/orders
Content-Type: application/json

{ "owner_id": "<uid-of-user-B>", "amount": 9999 }
```

Expected: 403 (policy requires `owner_id == caller uid`).
Actual at HEAD: 201. Row inserted with `owner_id = B`.

### How SELECT/UPDATE/DELETE Are Different

For read and mutation paths, the handler calls
`buildAuthzFilter()` instead of `authorize()`.
`buildAuthzFilter()` translates residuals into SQL `WHERE`
fragments via `translateExpr()` and appends them to the
query. The database enforces the predicate at execution
time. This path is correct and unaffected by this fix.

INSERT is different because the row does not exist yet —
there is no `WHERE` clause to append to. The handler must
check the proposed row against the policy before executing
the INSERT.

### How RPC Is Different

RPC calls `authorize()` with `resourceType: 'Function'`
(`handler.mjs:512-515`). RPC policies bind to
`PgrestLambda::Function`, which has no column attributes.
A `when { resource.<col> == ... }` clause on a Function
resource would fail Cedar schema validation, not produce
a residual. RPC is unaffected.

## Proposed CX / CX Specification

### Design Decision: Option A — In-Process Residual Evaluation

Two approaches were considered:

**Option A — In-process residual evaluation.** After partial
eval produces residuals for an INSERT, evaluate each
residual's `when` body against the proposed row (the `body`
already parsed in the handler). `resource.<col>` resolves
to `body[col]`; `principal.<attr>` is already bound. If
every `permit` residual evaluates to `true` and no `forbid`
residual evaluates to `true`, allow; otherwise 403.

**Option B — SQL-side check via `WITH ... WHERE`.** Rewrite
the INSERT to
`WITH candidate AS (SELECT <row>) INSERT INTO <table>
SELECT * FROM candidate WHERE <authz SQL>`, reusing the
existing `buildAuthzFilter` translator. Zero rows inserted
means 403.

**Choice: Option A.**

Justification:

1. **DSQL compatibility.** Option B requires confirming that
   DSQL supports `WITH ... SELECT ... INSERT` — an
   unnecessary risk for a security fix. Option A has no SQL
   dependency.
2. **Determinism.** Option A evaluates in-process with known
   inputs. Option B conflates "zero rows inserted because of
   authz" with "zero rows inserted because of a constraint
   violation" — distinguishing them requires extra SQL or
   heuristic checks.
3. **Bulk insert semantics.** Option A evaluates per-row and
   can report which row failed (by index). Option B would
   need per-row `WITH` wrappers or a single batch that
   gives no row-level feedback.
4. **No extra SQL round-trip.** The authorization decision
   is made before the INSERT query is built. The happy path
   adds zero latency from database calls.
5. **Auditability.** The evaluation is a pure function of
   the policy, principal, and row. It can be logged, tested,
   and debugged without a database.

The cost is a new evaluator function (`evaluateExprAgainstRow`)
that mirrors the shape dispatch of `translateExpr` but
produces boolean values instead of SQL strings. The
expression shapes are identical (==, !=, <, <=, >, >=, &&,
||, !, has, is, if-then-else) so the two functions share
the same structural contract but different leaf behavior.

### Behavior Specification

#### Single-Row INSERT

1. Handler parses `body` as a JSON object.
2. Handler calls `cedar.authorizeInsert()` (new method)
   with the principal, table, schema, and proposed row.
3. **Phase 1 — table-level check.**
   `authorizeInsert()` calls `isAuthorized()` against the
   concrete `Table` resource (same as today). Records
   whether a table-level permit was granted.
4. **Phase 2 — partial evaluation (always runs).**
   Calls `isAuthorizedPartial()` with `resource = null`.
   This is necessary even when Phase 1 granted, because a
   table-level permit and a row-level forbid can coexist
   (e.g., `permit(... resource == Table::"items")` plus
   `forbid(... resource is Row) when { ... }`). Only
   partial evaluation surfaces row-level forbids.
5. If partial evaluation returns no non-trivial residuals
   and either Phase 1 granted or the partial decision is
   allow, return `true`.
6. If the partial decision is deny and Phase 1 did not
   grant, throw `PGRST403`.
7. For each non-trivial residual, evaluate all its `when`
   conditions against the proposed row using
   `evaluateExprAgainstRow()`. Multiple `when` conditions
   on one policy are AND'd. Collect results by effect:
   - `permit` residuals: all `when` conditions must be
     true for the permit to contribute. At least one
     permit must contribute (either from a residual or
     from Phase 1).
   - `forbid` residuals: if all `when` conditions are
     true, the request is denied regardless of permits.
8. If the combined evaluation allows, return `true`.
   Otherwise throw `PGRST403`.

#### Bulk INSERT (Array Body)

1. Handler parses `body` as a JSON array.
2. Handler calls `cedar.authorizeInsert()` with the
   principal, table, schema, and the array of rows.
3. `authorizeInsert()` checks each row against the
   residuals. If any row fails, the entire request is
   rejected with `PGRST403`.
4. The error detail includes the zero-based index of the
   first failing row as a sanitized string:

```json
{
  "code": "PGRST403",
  "message": "Not authorized to insert on 'orders'",
  "details": "Row 2 of the batch violates the insert policy"
}
```

The detail is a static string template with the row index
interpolated — no user-controlled content, consistent with
V-09 sanitization.

#### Decided Allow (No Row Conditions)

A table-level permit with no `when` clause (e.g.,
`permit(principal, action == "insert",
resource == Table::"posts")`) is granted in Phase 1.
Phase 2 produces no non-trivial residuals (no row-level
conditions), so the method returns `true` at step 5.
Behavior is unchanged from today.

#### Service-Role Bypass

The default policy
`permit(principal is ServiceRole, action, resource)` has
no `when` clause. Phase 1 returns a decided allow. Phase 2
produces no residuals. The method returns `true` at step 5.
Service-role inserts are never evaluated against the row.
Behavior is unchanged.

#### Missing Column on Row

If a policy references `resource.col` but the proposed row
omits `col`, `evaluateExprAgainstRow()` returns `false` for
that comparison (fail-closed). This is equivalent to the
SQL path where a `NULL` column fails an equality check.

#### Untranslatable Expressions

If a residual contains an expression shape that
`evaluateExprAgainstRow()` cannot evaluate (e.g., `in`,
`contains`, `like`), the function returns `false` for that
residual (fail-closed) and logs a warning. This matches
the fail-closed contract: an undecided residual is a deny.

### Error Messages

All error messages from this path use the existing
`denyMessage()` helper, which respects the `production`
flag:

- **Production:** `Not authorized to insert on 'orders'`
- **Development:**
  `Not authorized: role='authenticated' action='insert'`
  `table='orders'.\nNo Cedar policy grants it. Loaded`
  `from ./policies. See docs/authorization.md for the`
  `policy model and recipes.`

The bulk insert detail (`Row N of the batch violates the
insert policy`) is appended as the `details` field of the
`PostgRESTError`, visible in both modes.

## Technical Design

### New Function: `evaluateExprAgainstRow`

Added to `src/rest/cedar.mjs`. Evaluates a Cedar expression
AST against a concrete row object and principal. Returns
`true`, `false`, or `false` for untranslatable expressions
(fail-closed).

```javascript
function evaluateExprAgainstRow(expr, row, principal) {
  if (expr == null) return true;

  if ('Value' in expr) {
    return expr.Value === true;
  }

  if ('is' in expr) {
    return expr.is.entity_type === 'PgrestLambda::Row';
  }

  if ('has' in expr) {
    const attr = expr.has.attr;
    return row[attr] !== undefined && row[attr] !== null;
  }

  if ('&&' in expr) {
    return evaluateExprAgainstRow(
             expr['&&'].left, row, principal)
        && evaluateExprAgainstRow(
             expr['&&'].right, row, principal);
  }

  if ('||' in expr) {
    return evaluateExprAgainstRow(
             expr['||'].left, row, principal)
        || evaluateExprAgainstRow(
             expr['||'].right, row, principal);
  }

  if ('!' in expr) {
    return !evaluateExprAgainstRow(
              expr['!'].arg, row, principal);
  }

  const COMP_OPS = {
    '==': (a, b) => a === b,
    '!=': (a, b) => a !== b,
    '>':  (a, b) => a > b,
    '>=': (a, b) => a >= b,
    '<':  (a, b) => a < b,
    '<=': (a, b) => a <= b,
  };
  for (const [cedarOp, comparator] of
       Object.entries(COMP_OPS)) {
    if (cedarOp in expr) {
      const { left, right } = expr[cedarOp];
      const col = resolveColumn(left);
      const val = resolveValue(right);
      if (col !== null && val !== undefined) {
        const rowVal = row[col];
        if (rowVal === undefined || rowVal === null) {
          return false;
        }
        return comparator(rowVal, val);
      }
      const col2 = resolveColumn(right);
      const val2 = resolveValue(left);
      if (col2 !== null && val2 !== undefined) {
        const rowVal = row[col2];
        if (rowVal === undefined || rowVal === null) {
          return false;
        }
        return comparator(val2, rowVal);
      }
      return false;
    }
  }

  if ('if-then-else' in expr) {
    const ite = expr['if-then-else'];
    const cond = evaluateExprAgainstRow(
      ite.if, row, principal);
    return cond
      ? evaluateExprAgainstRow(ite.then, row, principal)
      : evaluateExprAgainstRow(ite.else, row, principal);
  }

  return false;
}
```

Key design points:

- **Reuses `resolveColumn` and `resolveValue`** from the
  existing translator. These are the same helpers that
  `translateExpr` uses to decompose comparison nodes.
- **Null/undefined row values fail-closed.** If the row
  doesn't have the column the policy references, the
  comparison returns `false`. This mirrors SQL behavior
  where `NULL = <value>` is `NULL` (falsy in a `WHERE`).
- **Unknown expression shapes return `false`.** The
  `UNTRANSLATABLE` operators (`in`, `contains`, etc.)
  and any unrecognized shape fall through to the final
  `return false`. The fix logs a development-mode warning
  for these cases.
- **No `values` array.** Unlike `translateExpr`, this
  function does not build parameterized SQL. It compares
  JavaScript values directly.

### New Method: `authorizeInsert`

Added to the object returned by `createCedar()`. Replaces
the current `authorize()` call for the INSERT path.

The method runs two phases. Phase 1 (`isAuthorized`) checks
whether a table-level permit grants access — this handles
unconditional permits like `permit(... resource ==
Table::"posts")` and service-role bypass. Phase 2
(`isAuthorizedPartial`) always runs, even if Phase 1
granted. This is necessary because a table-level permit
and a row-level forbid can coexist: the permit's resource
constraint matches `Table`, so `isAuthorized` returns
allow, but the forbid's resource constraint matches `Row`,
which `isAuthorized` can't see. Only partial evaluation
with `resource = null` surfaces the forbid residual.

```javascript
function authorizeInsert({
  principal, resource, schema, rows,
}) {
  if (!cachedPolicies) {
    throw new PostgRESTError(
      403, 'PGRST403',
      denyMessage(principal, 'insert', resource),
    );
  }

  const principalUid = buildPrincipalUid(
    principal.role, principal.userId);
  const entities = buildEntities(
    principalUid, principal, schema);
  const actionUid = {
    type: 'PgrestLambda::Action', id: 'insert',
  };
  const resourceUid = {
    type: 'PgrestLambda::Table', id: resource,
  };

  // Phase 1: table-level check — handles unconditional
  // permits and service-role bypass.
  const tableResult = isAuthorized({
    principal: principalUid,
    action: actionUid,
    resource: resourceUid,
    context: {
      table: resource, resource_type: 'Table',
    },
    policies: cachedPolicies,
    entities,
  });

  const tablePermitGranted =
    tableResult.type === 'success'
    && tableResult.response.decision === 'allow';

  // Phase 2: partial evaluation — always runs, even
  // when Phase 1 granted. Catches row-level forbids
  // and row-conditioned permits.
  const partial = isAuthorizedPartial({
    principal: principalUid,
    action: actionUid,
    resource: null,
    context: {
      table: resource, resource_type: 'Table',
    },
    policies: cachedPolicies,
    entities,
  });

  if (partial.type !== 'residuals') {
    if (tablePermitGranted) return true;
    throw new PostgRESTError(
      403, 'PGRST403',
      denyMessage(principal, 'insert', resource),
    );
  }

  const resp = partial.response;

  // Decided allow with no residuals — unconditional
  if (resp.nontrivialResiduals.length === 0) {
    if (tablePermitGranted
        || resp.decision === 'allow') {
      return true;
    }
    throw new PostgRESTError(
      403, 'PGRST403',
      denyMessage(principal, 'insert', resource),
    );
  }

  if (resp.decision === 'deny'
      && !tablePermitGranted) {
    throw new PostgRESTError(
      403, 'PGRST403',
      denyMessage(principal, 'insert', resource),
    );
  }

  // Evaluate residuals against each row.
  // Pass tablePermitGranted so the evaluator knows
  // a table-level permit already contributed.
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!evaluateResiduals(
      resp, row, principalUid, tablePermitGranted,
    )) {
      const detail = rows.length > 1
        ? `Row ${i} of the batch violates the`
          + ` insert policy`
        : null;
      throw new PostgRESTError(
        403, 'PGRST403',
        denyMessage(principal, 'insert', resource),
        detail,
      );
    }
  }

  return true;
}
```

### New Helper: `evaluateResiduals`

Evaluates all non-trivial residuals from a partial
evaluation response against a single row. Returns `true`
only if at least one `permit` residual evaluates to `true`
and no `forbid` residual evaluates to `true`.

Multiple `when` conditions on a single policy are AND'd
(a Cedar policy with two `when` clauses requires both to
hold). Each policy is evaluated independently: all its
`when` conditions must pass for the policy to "fire."
For `permit` policies, firing means the permit contributes.
For `forbid` policies, firing means the request is denied.

```javascript
function evaluateResiduals(
  response, row, principalUid, tablePermitGranted,
) {
  let anyPermitGranted = tablePermitGranted;

  if (response.decision === 'allow') {
    anyPermitGranted = true;
  }

  for (const policyId of response.nontrivialResiduals) {
    const residual = response.residuals[policyId];
    const effect = residual.effect;

    // Evaluate all when conditions for this policy.
    // All must be true for the policy to fire (AND).
    let allCondsMet = true;
    for (const cond of residual.conditions || []) {
      if (cond.kind !== 'when') continue;
      if (!evaluateExprAgainstRow(
        cond.body, row, principalUid,
      )) {
        allCondsMet = false;
        break;
      }
    }

    if (allCondsMet && effect === 'forbid') {
      return false;
    }
    if (allCondsMet && effect === 'permit') {
      anyPermitGranted = true;
    }
  }

  return anyPermitGranted;
}
```

### Handler Changes

`src/rest/handler.mjs:314-335` — the POST case. Replace
the `cedar.authorize()` call with `cedar.authorizeInsert()`,
passing the parsed body as rows:

```javascript
case 'POST': {
  if (!body) {
    throw new PostgRESTError(
      400, 'PGRST100',
      'Missing or invalid request body',
    );
  }

  const rows = Array.isArray(body) ? body : [body];
  cedar.authorizeInsert({
    principal, resource: table, schema, rows,
  });

  const q = /* ... same as today ... */;
  const result = await pool.query(q.text, q.values);
  rows = result.rows;
  break;
}
```

The `rows` variable for the authorization call is distinct
from the `rows` variable that receives query results. The
authorization `rows` is a `const` scoped to the POST case
block; the result `rows` is the outer `let` at line 269.
Rename the result assignment to avoid shadowing:

```javascript
const insertRows = Array.isArray(body) ? body : [body];
cedar.authorizeInsert({
  principal, resource: table, schema,
  rows: insertRows,
});
```

### Removal of the Fail-Open Branch

The existing `authorize()` function at
`src/rest/cedar.mjs:445-497` retains its current behavior
for the `call` action (RPC). The fail-open branch at lines
485-491 is tightened: the
`resp.decision !== 'deny' && resp.nontrivialResiduals.length > 0`
case now returns `false` (deny) instead of `true`. This
makes `authorize()` fail-closed for any caller. The INSERT
path no longer calls `authorize()` at all, so the change
affects only RPC — and RPC policies on `Function` resources
don't produce row-level residuals (no column attributes on
`Function`), so the behavioral change is a no-op for RPC
in practice but closes the theoretical gap.

Updated `authorize()`:

```javascript
if (partial.type === 'residuals') {
  const resp = partial.response;
  if (resp.decision === 'allow'
      && resp.nontrivialResiduals.length === 0) {
    return true;
  }
}
```

The previous three-line block collapses to: allow only when
Cedar reports a decided allow with no undecided residuals.
Any other residual state is a deny.

### Module Export

The `createCedar()` return object gains `authorizeInsert`:

```javascript
return {
  loadPolicies,
  refreshPolicies,
  _setPolicies,
  authorize,
  authorizeInsert,
  buildAuthzFilter,
  generateCedarSchema,
};
```

### Principal Attribute Resolution in `evaluateExprAgainstRow`

The `resolveValue` helper already handles `__entity`
references, which is how Cedar encodes `principal` in
residual expressions. When a comparison is
`resource.col == principal`, the right side resolves to
the principal entity's id (the user's uid). This works
unchanged.

When a comparison is
`resource.col == principal.custom_claim`, the right side
is a `.` accessor on the principal entity. The existing
`resolveValue` does not handle this — it only handles
`Value` nodes and `__entity` references. However, in
practice Cedar's partial evaluator resolves
`principal.<attr>` to a concrete value before producing
the residual (because the principal is fully specified in
the evaluation context). The residual AST contains the
resolved literal, not the `principal.<attr>` accessor. No
change to `resolveValue` is needed.

## Code Architecture / File Changes

### Modified Files

| File | Change |
|---|---|
| `src/rest/cedar.mjs` | Add `evaluateExprAgainstRow`, `evaluateResiduals`, `authorizeInsert`; tighten `authorize()` residual branch; export `authorizeInsert` and `evaluateExprAgainstRow` |
| `src/rest/handler.mjs` | Replace `cedar.authorize()` with `cedar.authorizeInsert()` in POST case; pass parsed body as rows |
| `docs/security/findings/V-06-no-rls.md` | Add V-06c partial remediation section |
| `docs/security/assessment.md` | Update V-06 notes to cite V-06c as closed limb |
| `docs/reference/authorization.md` | Document INSERT residual evaluation behavior |
| `docs/guide/write-cedar-policies.md` | Note that row-conditioned INSERTs now enforce at application layer |
| `CHANGELOG.md` | V-06c entry under Unreleased → Security |

### New Files

| File | Purpose | ~Lines |
|---|---|---|
| `src/rest/__tests__/cedar-insert-authz.integration.test.mjs` | Integration tests for INSERT authorization | 300 |

### Files That Do NOT Change

- `src/rest/sql-builder.mjs` — INSERT SQL generation is
  unchanged; authorization happens before the query is built.
- `src/rest/query-parser.mjs` — no change.
- `src/rest/errors.mjs` — no new error codes; uses existing
  `PGRST403` and `PostgRESTError`.
- `src/rest/router.mjs` — no change.
- `src/auth/**` — no change.

## Testing Strategy

### Integration Tests

New test file:
`src/rest/__tests__/cedar-insert-authz.integration.test.mjs`

Uses the same mock-pool / test-context pattern as the
existing `cedar.integration.test.mjs`. Each test sets up
Cedar policies via `cedar._setPolicies()`, builds a Lambda
API Gateway proxy event, and calls the handler.

#### Test 1: Exploit Regression — Owner Mismatch

Policy:
```cedar
permit(
    principal is PgrestLambda::User,
    action == PgrestLambda::Action::"insert",
    resource is PgrestLambda::Row
) when {
    context.table == "orders"
    && resource.owner_id == principal
};
permit(
    principal is PgrestLambda::ServiceRole,
    action, resource
);
```

- **Given:** authenticated user with uid `user-A`.
- **When:** POST `/rest/v1/orders` with body
  `{ "owner_id": "user-B", "amount": 100 }`.
- **Then:** 403, code `PGRST403`.

- **Given:** authenticated user with uid `user-A`.
- **When:** POST `/rest/v1/orders` with body
  `{ "owner_id": "user-A", "amount": 100 }`.
- **Then:** 201. The INSERT query is executed.

> Warning: This is the primary regression test for the
> vulnerability. Verify that at HEAD (before the fix) the
> mismatch case returns 201 (the bug), and after the fix
> it returns 403. If the mismatch case already returns 403
> before the fix, investigate whether the test is
> exercising the right code path.

#### Test 2: Bulk Insert Rejection

Same policy as Test 1.

- **Given:** authenticated user with uid `user-A`.
- **When:** POST `/rest/v1/orders` with body
  `[{ "owner_id": "user-A", "amount": 50 },
    { "owner_id": "user-B", "amount": 75 }]`.
- **Then:** 403. Details string includes `Row 1`.
  No INSERT query is executed.

#### Test 3: Service-Role Bypass

Same policy as Test 1.

- **Given:** service_role principal.
- **When:** POST `/rest/v1/orders` with body
  `{ "owner_id": "anyone", "amount": 999 }`.
- **Then:** 201. The INSERT query is executed.

#### Test 4: Decided Allow (No Row Conditions)

Policy:
```cedar
permit(
    principal is PgrestLambda::User,
    action == PgrestLambda::Action::"insert",
    resource == PgrestLambda::Table::"posts"
);
permit(
    principal is PgrestLambda::ServiceRole,
    action, resource
);
```

- **Given:** authenticated user.
- **When:** POST `/rest/v1/posts` with body
  `{ "title": "Hello" }`.
- **Then:** 201. The INSERT query is executed.

#### Test 5: Forbid Residual

Policy:
```cedar
permit(
    principal is PgrestLambda::User,
    action == PgrestLambda::Action::"insert",
    resource == PgrestLambda::Table::"items"
);
forbid(
    principal,
    action == PgrestLambda::Action::"insert",
    resource is PgrestLambda::Row
) when {
    context.table == "items"
    && resource.restricted == true
};
```

- **Given:** authenticated user.
- **When:** POST `/rest/v1/items` with body
  `{ "name": "ok", "restricted": true }`.
- **Then:** 403.

- **Given:** authenticated user.
- **When:** POST `/rest/v1/items` with body
  `{ "name": "ok", "restricted": false }`.
- **Then:** 201.

> Warning: This test exercises the Phase 1/Phase 2
> interaction. The `permit` matches `Table`, so Phase 1
> grants the table-level permit. The `forbid` matches `Row`,
> so it only appears as a residual in Phase 2. If the
> `restricted: true` case returns 201 instead of 403,
> verify that Phase 2 (partial evaluation) is actually
> running and that `evaluateResiduals` is receiving the
> forbid residual.

#### Test 6: Missing Column on Row

Policy same as Test 1 (references `resource.owner_id`).

- **Given:** authenticated user with uid `user-A`.
- **When:** POST `/rest/v1/orders` with body
  `{ "amount": 100 }` (no `owner_id` field).
- **Then:** 403 (fail-closed).

### Unit Tests

Added to `src/rest/__tests__/cedar.test.mjs` in a new
`describe('evaluateExprAgainstRow')` block. One test per
expression shape:

| Expression | Row | Expected |
|---|---|---|
| `{ Value: true }` | any | `true` |
| `{ Value: false }` | any | `false` |
| `null` | any | `true` |
| `{ is: { entity_type: 'PgrestLambda::Row' } }` | any | `true` |
| `{ is: { entity_type: 'PgrestLambda::Table' } }` | any | `false` |
| `{ has: { attr: 'x' } }` | `{ x: 1 }` | `true` |
| `{ has: { attr: 'x' } }` | `{ y: 1 }` | `false` |
| `{ has: { attr: 'x' } }` | `{ x: null }` | `false` |
| `{ '==': { left: res('a'), right: val(5) } }` | `{ a: 5 }` | `true` |
| `{ '==': { left: res('a'), right: val(5) } }` | `{ a: 6 }` | `false` |
| `{ '==': { left: res('a'), right: val('x') } }` | `{}` | `false` |
| `{ '!=': { left: res('a'), right: val(5) } }` | `{ a: 6 }` | `true` |
| `{ '>': { left: res('a'), right: val(5) } }` | `{ a: 6 }` | `true` |
| `{ '>': { left: res('a'), right: val(5) } }` | `{ a: 5 }` | `false` |
| `{ '>=': { left: res('a'), right: val(5) } }` | `{ a: 5 }` | `true` |
| `{ '<': { left: res('a'), right: val(5) } }` | `{ a: 4 }` | `true` |
| `{ '<=': { left: res('a'), right: val(5) } }` | `{ a: 5 }` | `true` |
| `{ '&&': { left: { Value: true }, right: { Value: true } } }` | any | `true` |
| `{ '&&': { left: { Value: true }, right: { Value: false } } }` | any | `false` |
| `{ '\|\|': { left: { Value: false }, right: { Value: true } } }` | any | `true` |
| `{ '\|\|': { left: { Value: false }, right: { Value: false } } }` | any | `false` |
| `{ '!': { arg: { Value: true } } }` | any | `false` |
| `{ '!': { arg: { Value: false } } }` | any | `true` |
| `{ 'if-then-else': { if: { Value: true }, then: { Value: true }, else: { Value: false } } }` | any | `true` |
| `{ 'if-then-else': { if: { Value: false }, then: { Value: true }, else: { Value: false } } }` | any | `false` |
| `{ 'in': { ... } }` | any | `false` (untranslatable) |

Where `res('a')` is shorthand for
`{ '.': { left: { Var: 'resource' }, attr: 'a' } }` and
`val(v)` is shorthand for `{ Value: v }`.

### `authorizeInsert` Unit Tests

Added to `src/rest/__tests__/cedar.test.mjs` in a new
`describe('authorizeInsert')` block:

- **Decided allow** — table-level permit with no `when`.
  `authorizeInsert` returns `true`.
- **Residual evaluated against matching row** — row-
  conditioned permit, row satisfies condition. Returns
  `true`.
- **Residual evaluated against non-matching row** —
  row-conditioned permit, row fails condition. Throws
  `PGRST403`.
- **Bulk: all rows match** — returns `true`.
- **Bulk: one row fails** — throws `PGRST403` with
  row index detail.
- **No policies loaded** — throws `PGRST403`.

### Existing Test Regression

All existing tests must pass unchanged. The
`authorize()` tightening is a no-op for RPC (no
row-level residuals on Function resources) and
INSERT no longer calls `authorize()`. Run `npm test`
to verify.

## Implementation Order

### Phase 1: Core Fix

1. Add `evaluateExprAgainstRow` to `src/rest/cedar.mjs`
   as a module-internal function. Export it for testing.
2. Add `evaluateResiduals` as a module-internal function.
3. Add `authorizeInsert` method to the `createCedar()`
   return object.
4. Tighten the residual branch in `authorize()` — remove
   the `nontrivialResiduals.length > 0 → true` path.
5. Update `src/rest/handler.mjs` POST case to call
   `cedar.authorizeInsert()` with parsed body as rows.

### Phase 2: Tests

6. Add `evaluateExprAgainstRow` unit tests to
   `src/rest/__tests__/cedar.test.mjs`.
7. Add `authorizeInsert` unit tests to
   `src/rest/__tests__/cedar.test.mjs`.
8. Create
   `src/rest/__tests__/cedar-insert-authz.integration.test.mjs`
   with all six integration test scenarios.
9. Run `npm test` — all existing tests plus new tests
   pass.

### Phase 3: Documentation

10. Update `docs/security/findings/V-06-no-rls.md` with
    V-06c partial remediation section.
11. Update `docs/security/assessment.md` V-06 notes.
12. Update `docs/reference/authorization.md` with INSERT
    residual evaluation documentation.
13. Update `docs/guide/write-cedar-policies.md` with note
    about row-conditioned INSERTs.
14. Update `CHANGELOG.md` with V-06c entry.

## Open Questions

None. The design is fully specified. The choice of Option A
over Option B is justified above. All edge cases (bulk
insert, missing columns, untranslatable expressions,
service-role bypass, RPC unchanged) are addressed.
