# Task 05: buildAuthzFilter — Partial Evaluation to SQL

**Agent:** implementer
**Design:** docs/design/authorization-cedar.md
**Depends on:** Task 03, Task 04

## Objective

Implement `buildAuthzFilter()` in `src/rest/cedar.mjs` —
the function that calls Cedar partial evaluation and
combines residuals into parameterized SQL WHERE conditions.

## Target Tests

From `cedar.test.mjs` (Task 01):

- 'default policy for authenticated user produces user_id filter' (#40)
- 'service_role produces no conditions (unconditional access)' (#41)
- 'forbid policy produces NOT condition' (#42)
- 'multiple permit policies combine with OR' (#43)
- 'concrete deny throws PGRST403' (#44)
- 'startParam offsets parameter numbering correctly' (#45)

## Implementation

### Add to `src/rest/cedar.mjs`

Implement and export `buildAuthzFilter()`:

```javascript
export function buildAuthzFilter({
  principal, action, context, schema, startParam
}) {
  // principal: { role, userId, email }
  // action: HTTP method string
  // context: { table: tableName }
  // schema: from schema-cache
  // startParam: first available param number
  //
  // Returns: { conditions: string[], values: any[] }
  // Throws: PostgRESTError PGRST403 for concrete deny
  // Throws: PostgRESTError PGRST000 for policy load failure
}
```

#### Steps

1. **Build Cedar inputs:**
   - `principalUid` via `buildPrincipalUid()`
   - `actionUid` via `buildAction()`
   - Entity store via `buildEntities()`
   - Set resource to `null` (unknown — triggers partial eval)

2. **Call `isAuthorizedPartial()`:**
   ```javascript
   const partial = isAuthorizedPartial({
     principal: principalUid,
     action: actionUid,
     resource: null,
     context: { table: context.table },
     policies: cachedPolicies,
     entities,
   });
   ```

3. **Handle the three outcomes:**

   a. **Concrete Allow** — `partial.response.decision === 'allow'`
      and `partial.response.nontrivialResiduals.length === 0`:
      Return `{ conditions: [], values: [] }`.

   b. **Concrete Deny** — `partial.response.decision === 'deny'`:
      Throw PGRST403 with message
      `Not authorized to ${action} on '${context.table}'`.

   c. **Residuals exist** — `partial.response.decision === null`
      and `partial.response.nontrivialResiduals.length > 0`:
      Walk each residual and translate to SQL.

4. **Walk residuals:**

   `partial.response.residuals` is a `Record<string, PolicyJson>`.
   Each entry has an `effect` ("permit" or "forbid") and
   `conditions` (the residual `when` clause as an Expr AST).

   For each nontrivial residual ID in
   `partial.response.nontrivialResiduals`:
   - Look up the residual in `partial.response.residuals`
   - Extract the condition Expr from the residual's
     `conditions` array
   - Call `translateExpr()` to convert to SQL
   - Group by effect: permit conditions and forbid conditions

5. **Combine conditions:**

   - Multiple `permit` conditions → combined with `OR`
   - `forbid` conditions → each wrapped in `NOT (...)`
   - Final structure:
     ```sql
     (permit1 OR permit2) AND NOT (forbid1) AND NOT (forbid2)
     ```
   - Handle the `true` sentinel from `translateExpr`:
     if a permit residual translates to `true`, the entire
     permit clause is unconditional — skip it
   - Collect all values from both permit and forbid
     translations

6. **Parameter numbering:**
   - Initialize the values array empty
   - When calling `translateExpr`, the values array grows
     incrementally — placeholders are `$startParam`,
     `$startParam+1`, etc.
   - The caller (handler.mjs) passes
     `values.length + 1` as `startParam`

#### Residual structure details

The exact structure of `partial.response.residuals` entries
depends on the cedar-wasm version. The design describes the
Cedar JSON policy format, but the actual residual objects
may differ slightly. Key things to verify during
implementation:

- How to extract the condition Expr from a residual entry
- Whether `conditions` is an array of Expr or a single Expr
- Whether `effect` is at the top level of each residual

**Assumption:** The residual entries follow the Cedar JSON
policy format where each policy has `effect`, `principal`,
`action`, `resource`, and `conditions` fields. The
`conditions` field contains the `when` clause as an Expr
AST. If this does not hold, adapt accordingly.

## Test Requirements

No additional unit tests beyond Task 01.

## Acceptance Criteria

- `buildAuthzFilter` is exported from `src/rest/cedar.mjs`
- All 6 target tests (#40-#45) pass
- Existing tests still pass
- Parameter numbering is correct when combined with
  PostgREST filter params

## Conflict Criteria

- If `buildAuthzFilter` already exists in `cedar.mjs`, read
  it and fix/extend rather than rewriting.
- If Cedar's `isAuthorizedPartial` returns a different
  response structure than described, adapt the implementation
  to the actual API. Document any deviations.
- If all target tests already pass before any code changes,
  investigate whether the tests are true positives.
- If the residual Expr structure does not match what
  `translateExpr` (Task 04) expects, fix the translator to
  match the actual structure rather than changing the test
  expectations.
