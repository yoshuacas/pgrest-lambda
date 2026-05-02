# Task 01 — End-to-End Tests for INSERT Authorization

**Agent:** implementer
**Design:** docs/design/security-v06c-insert-fail-open.md

## Objective

Write integration tests covering every INSERT authorization
behavior specified in the design. All tests must compile and
all tests must fail (since the fix is not yet implemented).

## Test File

`src/rest/__tests__/cedar-insert-authz.integration.test.mjs`

Use the same mock-pool / test-context pattern as
`src/rest/__tests__/cedar.integration.test.mjs`. Each test
sets up Cedar policies via `cedar._setPolicies()`, builds a
Lambda API Gateway proxy event, and calls the handler.

Reuse the `createMockPool`, `createTestContext`, `makeEvent`,
and `findDataQuery` helpers from the existing integration test
file — extract them into a shared helper or duplicate them as
appropriate.

## Policies

### Owner-conditioned INSERT policy

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

### Unconditional INSERT policy

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

### Table-level permit + row-level forbid policy

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

## Mock Schema

Add `orders`, `posts`, and `items` tables to the mock
schema/column rows alongside the existing tables:

- `orders`: `id` (text), `owner_id` (text), `amount` (integer)
- `posts`: `id` (text), `title` (text)
- `items`: `id` (text), `name` (text), `restricted` (boolean)

## Test Cases

### Test 1: Exploit Regression — Owner Mismatch (DENY)

- **Given:** authenticated user with uid `user-A`.
- **When:** POST `/rest/v1/orders` with body
  `{ "owner_id": "user-B", "amount": 100 }`.
- **Then:** 403, code `PGRST403`.

> ⚠ This is the primary regression test for the
> vulnerability. At HEAD (before the fix), this case
> returns 201. After the fix it must return 403. If the
> mismatch case already returns 403 before any code
> changes, investigate whether the test is exercising
> the right code path — the design expects the current
> code to fail-open here.

### Test 2: Exploit Regression — Owner Match (ALLOW)

- **Given:** authenticated user with uid `user-A`.
- **When:** POST `/rest/v1/orders` with body
  `{ "owner_id": "user-A", "amount": 100 }`.
- **Then:** 201. The INSERT query is executed.

### Test 3: Bulk Insert — Mixed Ownership (DENY)

- **Given:** authenticated user with uid `user-A`.
- **When:** POST `/rest/v1/orders` with body
  `[{ "owner_id": "user-A", "amount": 50 },
    { "owner_id": "user-B", "amount": 75 }]`.
- **Then:** 403, code `PGRST403`. Response body `details`
  field includes the string `Row 1`. No INSERT query is
  executed (verify via captured queries).

### Test 4: Service-Role Bypass (ALLOW)

- **Given:** service_role principal.
- **When:** POST `/rest/v1/orders` with body
  `{ "owner_id": "anyone", "amount": 999 }`.
- **Then:** 201. The INSERT query is executed.

### Test 5: Decided Allow — No Row Conditions (ALLOW)

- **Given:** authenticated user.
- **When:** POST `/rest/v1/posts` with body
  `{ "title": "Hello" }`.
- **Then:** 201. The INSERT query is executed.

### Test 6: Forbid Residual — restricted=true (DENY)

- **Given:** authenticated user.
- **When:** POST `/rest/v1/items` with body
  `{ "name": "ok", "restricted": true }`.
- **Then:** 403.

> ⚠ This test exercises the Phase 1/Phase 2 interaction.
> The `permit` matches `Table`, so Phase 1 grants. The
> `forbid` matches `Row`, so it only appears as a residual
> in Phase 2. If the `restricted: true` case returns 201
> instead of 403, verify that Phase 2 partial evaluation
> is running and `evaluateResiduals` receives the forbid.

### Test 7: Forbid Residual — restricted=false (ALLOW)

- **Given:** authenticated user.
- **When:** POST `/rest/v1/items` with body
  `{ "name": "ok", "restricted": false }`.
- **Then:** 201.

### Test 8: Missing Column on Row (DENY)

- **Given:** authenticated user with uid `user-A`.
- **When:** POST `/rest/v1/orders` with body
  `{ "amount": 100 }` (no `owner_id` field).
- **Then:** 403 (fail-closed).

## Acceptance Criteria

- All tests compile and run without errors.
- All tests that exercise the new `authorizeInsert` behavior
  fail with clear assertion messages (since the method does
  not exist yet). Tests 2, 4, 5, 7 may pass or fail depending
  on the current `authorize()` behavior — either outcome is
  acceptable at this stage.
- No changes to production code.

## Conflict Criteria

- If any test that is expected to fail instead passes (in
  particular Tests 1, 3, 6, 8 — the DENY cases), first
  diagnose why by following the "Unexpected test results"
  guidance: investigate the code path, verify the assertion
  targets the right behavior, and attempt to rewrite the test
  to isolate the intended code path. Only escalate if you
  cannot construct a well-formed test that targets the
  desired behavior.
