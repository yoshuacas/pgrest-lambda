# Task 05: Handler Integration — Relationship Resolution + Per-Table Authz

Agent: implementer
Design: docs/design/resource-embedding.md
Depends on: Task 02, Task 03, Task 04

## Objective

Wire the select parser, relationship discovery, and SQL
generation together in `handler.mjs`. After this task, the
full embedding flow works end-to-end for GET requests, and
return=representation for mutations includes embeds.

## Target Tests

From Task 01 — all embedding tests should now pass:
- Many-to-one embed
- Many-to-one null FK
- One-to-many embed
- One-to-many empty array
- Wildcard parent and child
- Aliased embed
- Nested embed (2 levels)
- Inner join (one-to-many)
- Inner join (many-to-one)
- Disambiguation with !hint
- Error: no relationship (PGRST200)
- Error: ambiguous relationship (PGRST201)
- Error: column not found in embed (PGRST204)
- Space handling in select
- Backward compatibility (flat, wildcard, no param)
- Filters alongside embeds
- return=representation with embeds (POST)
- return=representation with embeds (PATCH)
- Authorization on embeds (silent exclusion)

## Implementation

### File: `src/rest/handler.mjs`

#### 1. Detect embeds in parsed select

After `parseQuery(params, method)`, check for embed nodes:

```javascript
const parsed = parseQuery(params, method);
const hasEmbeds = parsed.select.some(
  n => n.type === 'embed');
```

#### 2. Build per-table authz filters for GET

Replace the existing GET case's authz logic. Currently it
builds authz for the parent table only:

```javascript
// Current:
const preview = buildSelect(table, parsed, schema);
const authz = cedar.buildAuthzFilter({
  principal, action: 'select', context: { table }, schema,
  startParam: preview.values.length + 1,
});
const q = buildSelect(table, parsed, schema, authz);
```

When embeds are present, build authz for each table:

```javascript
case 'GET': {
  if (hasEmbeds) {
    // Collect all unique table names from the select tree
    const tables = collectTables(parsed.select, table);
    const authzFilters = { parent: null, embeds: {} };

    // Build authz for parent table
    // Use a preview build to find the starting param index
    const preview = buildSelect(table, parsed, schema);
    let nextParam = preview.values.length + 1;

    const parentAuthz = cedar.buildAuthzFilter({
      principal, action: 'select',
      context: { table }, schema,
      startParam: nextParam,
    });
    authzFilters.parent = parentAuthz;
    nextParam += parentAuthz.values.length;

    // Build authz for each embedded table
    for (const t of tables) {
      if (t === table) continue;
      const embedAuthz = cedar.buildAuthzFilter({
        principal, action: 'select',
        context: { table: t }, schema,
        startParam: nextParam,
      });
      authzFilters.embeds[t] = embedAuthz;
      nextParam += embedAuthz.values.length;
    }

    const q = buildSelect(
      table, parsed, schema, authzFilters);
    const result = await pool.query(q.text, q.values);
    rows = result.rows;
  } else {
    // Existing flat select path — unchanged
    const preview = buildSelect(table, parsed, schema);
    const authz = cedar.buildAuthzFilter({
      principal, action: 'select',
      context: { table }, schema,
      startParam: preview.values.length + 1,
    });
    const q = buildSelect(table, parsed, schema, authz);
    const result = await pool.query(q.text, q.values);
    rows = result.rows;
  }

  if (prefer.count === 'exact') {
    const cq = buildCount(table, parsed, schema);
    const cr = await pool.query(cq.text, cq.values);
    count = parseInt(cr.rows[0].count, 10);
  }
  break;
}
```

#### 3. Add collectTables helper

Recursively walk the select tree to find all referenced
table names:

```javascript
function collectTables(selectNodes, parentTable) {
  const tables = new Set([parentTable]);
  for (const node of selectNodes) {
    if (node.type === 'embed') {
      tables.add(node.name);
      // Recurse into the embed's own select list to find
      // nested embeds (e.g., items(id,products(name)))
      const nested = collectTables(node.select, node.name);
      for (const t of nested) tables.add(t);
    }
  }
  return tables;
}
```

#### 4. Handle return=representation with embeds

For POST, PATCH, DELETE with `Prefer: return=representation`
and embeds in the select, the mutation returns flat rows
(RETURNING *). To produce embedded response, re-SELECT:

```javascript
// After mutation returns rows:
if (returnRep && hasEmbeds && rows.length > 0) {
  const pk = schema.tables[table]?.primaryKey;
  if (pk && pk.length > 0) {
    const pkValues = rows.map(r => r[pk[0]]);
    const reSelectParsed = {
      ...parsed,
      filters: [{
        column: pk[0],
        operator: 'in',
        value: pkValues.map(String),
        negate: false,
      }],
    };
    // Build authz for re-SELECT
    const tables = collectTables(parsed.select, table);
    const authzFilters = { parent: null, embeds: {} };
    let nextParam = 1;
    const parentAuthz = cedar.buildAuthzFilter({
      principal, action: 'select',
      context: { table }, schema,
      startParam: nextParam,
    });
    authzFilters.parent = parentAuthz;
    nextParam += parentAuthz.values.length;
    for (const t of tables) {
      if (t === table) continue;
      const embedAuthz = cedar.buildAuthzFilter({
        principal, action: 'select',
        context: { table: t }, schema,
        startParam: nextParam,
      });
      authzFilters.embeds[t] = embedAuthz;
      nextParam += embedAuthz.values.length;
    }
    const reQ = buildSelect(
      table, reSelectParsed, schema, authzFilters);
    const reResult = await pool.query(reQ.text, reQ.values);
    rows = reResult.rows;
  }
}
```

This goes after the mutation switch cases but before the
response formatting. It only runs when all three conditions
are true: `return=representation`, embeds present, and rows
were returned.

**Assumption**: The table has a primary key. If not (unlikely
for a table used with embeds), the re-SELECT is skipped and
the flat mutation result is returned. The implementing agent
should verify this assumption against the test schema.

#### 5. Parameter numbering coordination

The main challenge is that `buildSelect` assigns `$N`
parameter placeholders internally, and the authz filters
also use `$N` placeholders that must not collide. The
existing code handles this with `startParam` for a single
authz call. With multiple embedded table authz filters,
the parameter numbers must be sequential and non-overlapping.

The approach above uses a preview `buildSelect` to determine
how many value parameters the base query uses, then starts
authz parameter numbering after that. This matches the
existing pattern.

**Important**: The preview build and the actual build must
produce the same number of base parameters. The authz
filters are passed to the actual build, which adds them
to the values array. Verify this by checking that the
actual query's `values` array length equals the expected
parameter count.

## Test Requirements

No new unit test file for handler (it's integration-tested).
The Task 01 E2E tests are the acceptance tests for this task.

Optionally add a focused integration test for authz on embeds:

- Authenticated user queries `orders?select=id,customers(name)`
  where the user can read orders but Cedar policy restricts
  customers -> customer embed should be null/empty based on
  authz, not a 403 error

## Acceptance Criteria

- All Task 01 E2E tests pass
- Existing integration tests still pass (flat queries,
  auth, CRUD operations)
- Embeds work with `service_role` (no authz restrictions)
- Error responses match the design's PGRST200/PGRST201
  format exactly

## Conflict Criteria

- If all target tests already pass before any code changes
  are made, investigate whether the tests are true positives
  before marking the task complete.
- If parameter numbering produces SQL errors (e.g., "bind
  message supplies X parameters, but prepared statement
  requires Y"), the preview/actual build mismatch must be
  debugged. Check that the authz values are appended in the
  correct order.
- If Cedar's `buildAuthzFilter` does not support being
  called multiple times with different `startParam` values,
  investigate the Cedar integration code and adjust.
