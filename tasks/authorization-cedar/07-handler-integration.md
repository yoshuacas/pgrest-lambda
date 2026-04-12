# Task 07: Handler Integration — Wire Cedar into Request Pipeline

**Agent:** implementer
**Design:** docs/design/authorization-cedar.md
**Depends on:** Task 05, Task 06

## Objective

Modify `src/rest/handler.mjs` to call Cedar authorization
on every request and pass the resulting conditions to the
SQL builder functions. Update integration tests to work with
Cedar authorization.

## Target Tests

From `cedar.integration.test.mjs` (Task 01):

- 'GET /rest/v1/todos returns only owned rows (backward compat)' (#46)
- 'service_role GET returns all rows (no authz WHERE)' (#47)
- 'anon GET denied by default policies returns 403 PGRST403' (#48)
- 'authenticated INSERT allowed without user_id injection' (#49)
- 'DELETE with forbid-archived policy includes NOT condition' (#50)
- 'anon GET on public_posts with custom policy returns 200' (#51)
- 'authenticated GET on table with no matching policy returns 403' (#52)
- 'POST /rest/v1/_refresh reloads Cedar policies' (#53)
- 'PostgREST filters combined with Cedar conditions have correct param numbering' (#54)
- 'same result set as old appendUserId for owned rows' (#55)
- 'service_role still sees all rows' (#56)

## Implementation

### Changes to `src/rest/handler.mjs`

#### Add imports

```javascript
import {
  authorize, buildAuthzFilter, loadPolicies,
  refreshPolicies,
} from './cedar.mjs';
```

#### Remove unused imports

The `hasColumn` import from `schema-cache.mjs` is no longer
needed in handler.mjs (it was used indirectly through
sql-builder). Check if it's still referenced; remove if not.

#### Load policies on cold start

At the top of the `handler()` function, after getting the
pool and schema:

```javascript
await loadPolicies();
```

This ensures policies are loaded (or served from cache) on
every invocation.

#### Construct Cedar principal

After extracting `role`, `userId`, and `email` from the
authorizer context:

```javascript
const principal = { role, userId, email: authorizer.email || '' };
```

#### Modify each HTTP method case

**GET (SELECT):**
```javascript
case 'GET': {
  const authzFilter = buildAuthzFilter({
    principal,
    action: method,
    context: { table },
    schema,
    startParam: 1,  // will be adjusted below
  });

  const parsed = parseQuery(params, method);
  // Build initial query to determine param count
  // Then rebuild with correct startParam
  // OR: build filter conditions first, count params,
  //     then call buildAuthzFilter with correct startParam

  // Simpler approach: build the query without authz first,
  // count its values, then call buildAuthzFilter with
  // values.length + 1 as startParam
  const q = buildSelect(table, parsed, schema);
  // Now get authz conditions with correct param numbering
  const authz = buildAuthzFilter({
    principal,
    action: method,
    context: { table },
    schema,
    startParam: q.values.length + 1,
  });
  // Rebuild with authz conditions
  const qFinal = buildSelect(table, parsed, schema, authz);

  const result = await pool.query(qFinal.text, qFinal.values);
  rows = result.rows;

  if (prefer.count === 'exact') {
    const cq = buildCount(table, parsed, schema, authz);
    const cr = await pool.query(cq.text, cq.values);
    count = parseInt(cr.rows[0].count, 10);
  }
  break;
}
```

**Important optimization:** The above shows calling
`buildSelect` twice. A better approach is to call
`buildFilterConditions` (or `buildSelect` once without
authz), count the resulting values, then call
`buildAuthzFilter` with the correct `startParam`, then call
`buildSelect` with authzConditions. The key point is that
`startParam` must equal the number of values from PostgREST
filters + 1.

Alternatively, since `buildSelect` builds filter conditions
internally and we can't easily peek at the intermediate
value count, a simpler approach:

1. Parse query
2. Call `buildAuthzFilter` with `startParam = 1` — it
   returns conditions with placeholders starting at $1
3. The SQL builder appends these after its own conditions
   and does NOT renumber — but wait, the design says the
   SQL builder trusts the placeholders are correct.

Re-reading the design: "The handler passes `values.length + 1`
as `startParam` to ensure correct numbering." This means:

1. Build the filter-only part to know how many params it uses
2. Pass that count + 1 as startParam to buildAuthzFilter
3. Pass the authz result to the full SQL builder

The cleanest implementation: compute filter values count
by calling `buildFilterConditions` or by building the query
once and reading `q.values.length`. Since `buildSelect` is
cheap (no DB call), calling it twice is acceptable:

```javascript
case 'GET': {
  const parsed = parseQuery(params, method);

  // First pass: determine param count from PostgREST filters
  const preview = buildSelect(table, parsed, schema);
  const startParam = preview.values.length + 1;

  // Get Cedar authorization conditions
  const authz = buildAuthzFilter({
    principal,
    action: method,
    context: { table },
    schema,
    startParam,
  });

  // Second pass: build with authz conditions appended
  const q = buildSelect(table, parsed, schema, authz);
  const result = await pool.query(q.text, q.values);
  rows = result.rows;

  if (prefer.count === 'exact') {
    const cq = buildCount(table, parsed, schema, authz);
    const cr = await pool.query(cq.text, cq.values);
    count = parseInt(cr.rows[0].count, 10);
  }
  break;
}
```

**POST (INSERT):**
```javascript
case 'POST': {
  if (!body) {
    throw new PostgRESTError(
      400, 'PGRST100',
      'Missing or invalid request body',
    );
  }

  // Table-level authorization check
  authorize({
    principal,
    action: method,
    resource: table,
    schema,
  });

  const q =
    parsed.onConflict
      && prefer.resolution === 'merge-duplicates'
      ? buildInsert(table, body, schema, parsed)
      : buildInsert(table, body, schema,
        { ...parsed, onConflict: null });

  const result = await pool.query(q.text, q.values);
  rows = result.rows;
  break;
}
```

Note: `buildInsert` no longer takes `userId` — the
`userId` parameter is removed (Task 06).

**PATCH (UPDATE):**
```javascript
case 'PATCH': {
  if (!body || typeof body !== 'object') {
    throw new PostgRESTError(
      400, 'PGRST100',
      'Missing or invalid request body',
    );
  }

  const parsed2 = parseQuery(params, method);
  const preview = buildUpdate(table, body, parsed2, schema);
  const startParam = preview.values.length + 1;

  const authz = buildAuthzFilter({
    principal,
    action: method,
    context: { table },
    schema,
    startParam,
  });

  const q = buildUpdate(table, body, parsed, schema, authz);
  const result = await pool.query(q.text, q.values);
  rows = result.rows;
  break;
}
```

Wait — `parsed` is already computed above the switch. Use
the existing `parsed` variable. Do not re-parse.

**DELETE:**
Same pattern as PATCH — preview, get startParam, call
buildAuthzFilter, then buildDelete with authz conditions.

#### Modify _refresh handler

Add `await refreshPolicies()` after `refresh(pool)`:

```javascript
if (routeInfo.type === 'refresh') {
  if (method !== 'POST') {
    throw new PostgRESTError(
      405, 'PGRST000',
      'Method not allowed on _refresh',
    );
  }
  const newSchema = await refresh(pool);
  await refreshPolicies();
  const apiUrl = `https://${headers['host']}/rest/v1`;
  return success(200, generateSpec(newSchema, apiUrl));
}
```

### Changes to `src/rest/__tests__/handler.integration.test.mjs`

The existing handler integration tests call `handler()` with
mock events. After this change, the handler calls Cedar
authorization, which requires policies to be loaded.

**Option A (preferred):** Import `_setPolicies` from
`../cedar.mjs` and set default policies in `beforeEach`.
This avoids filesystem dependency in tests.

**Option B:** Set `POLICIES_PATH` env var to `./policies`
and ensure `policies/default.cedar` exists (from Task 02).

Use Option A for test isolation:

```javascript
import { _setPolicies } from '../cedar.mjs';

beforeEach(() => {
  _resetCache();
  _setPool(createMockPool());
  // Load default Cedar policies for all existing tests
  _setPolicies({ staticPolicies: DEFAULT_POLICY_TEXT });
});
```

Where `DEFAULT_POLICY_TEXT` is the content of
`policies/default.cedar` inlined as a string constant.

Update tests that check for `user_id` in SQL WHERE clauses:
- The filter now comes from Cedar (different SQL shape)
- `service_role` tests should verify no authz conditions
- User isolation tests should verify Cedar-derived conditions

Some existing tests will need assertion adjustments:
- Tests checking `values.includes('user1')` may need to
  check for the user ID in a Cedar-derived condition
  instead of in the appendUserId position
- The `service_role bypass` test should verify no Cedar
  WHERE conditions are appended

## Acceptance Criteria

- `handler.mjs` calls `loadPolicies()` on each invocation
- INSERT calls `authorize()` for table-level check
- SELECT/UPDATE/DELETE call `buildAuthzFilter()` for
  row-level conditions
- `_refresh` calls `refreshPolicies()`
- All 11 target Cedar integration tests (#46-#56) pass
- All updated existing `handler.integration.test.mjs` tests
  pass
- `npm test` passes (all test files)

## Conflict Criteria

- If `handler.mjs` already imports from `cedar.mjs`, read
  the current state and extend rather than duplicate.
- If existing handler integration tests fail in unexpected
  ways (not related to the authz changes), investigate
  before fixing.
- If the two-pass approach for startParam is too complex or
  introduces bugs, simplify by having `buildAuthzFilter`
  return conditions with `$1`, `$2` placeholders and having
  the SQL builder renumber them. This deviates from the
  design but may be more maintainable — document the
  deviation.
- If all target tests already pass before changes,
  investigate.
