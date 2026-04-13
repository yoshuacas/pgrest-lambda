# Task 03: Relationship Discovery — FK Introspection + Convention Fallback

Agent: implementer
Design: docs/design/resource-embedding.md
Depends on: Task 02

## Objective

Add foreign key introspection and convention-based relationship
inference to `schema-cache.mjs` so that the schema cache includes
a `relationships` array alongside the existing `tables` object.

## Target Tests

From Task 01:
- Many-to-one embed (requires relationship between orders and
  customers)
- One-to-many embed (requires reverse relationship)
- Disambiguation (requires two relationships between orders and
  addresses)
- Nested embed (requires relationships: orders->order_items,
  order_items->products)
- Error: no relationship found (PGRST200) — requires the
  relationship resolution to confirm no match exists

These tests won't pass from this task alone (sql-builder and
handler changes still needed), but the relationship data this
task produces is a prerequisite.

## Implementation

### File: `src/rest/schema-cache.mjs`

#### 1. Add FK_SQL constant

Add after the existing `PK_SQL` constant:

```sql
SELECT
    con.conname AS constraint_name,
    c.relname AS from_table,
    array_agg(a.attname ORDER BY k.n) AS from_columns,
    fc.relname AS to_table,
    array_agg(fa.attname ORDER BY k.n) AS to_columns
FROM pg_catalog.pg_constraint con
JOIN pg_catalog.pg_class c
    ON c.oid = con.conrelid
JOIN pg_catalog.pg_namespace n
    ON n.oid = c.relnamespace
JOIN pg_catalog.pg_class fc
    ON fc.oid = con.confrelid
CROSS JOIN LATERAL unnest(con.conkey, con.confkey)
    WITH ORDINALITY AS k(col, fcol, n)
JOIN pg_catalog.pg_attribute a
    ON a.attrelid = c.oid AND a.attnum = k.col
JOIN pg_catalog.pg_attribute fa
    ON fa.attrelid = fc.oid AND fa.attnum = k.fcol
WHERE con.contype = 'f'
    AND n.nspname = 'public'
GROUP BY con.conname, c.relname, fc.relname
ORDER BY con.conname
```

#### 2. Modify pgIntrospect()

Add FK query to the `Promise.all` call. Wrap the FK query
in try/catch — if it fails (e.g., DSQL rejects the LATERAL
syntax), treat it as zero rows returned.

```javascript
async function pgIntrospect(pool) {
  const [colResult, pkResult] = await Promise.all([
    pool.query(COLUMNS_SQL),
    pool.query(PK_SQL),
  ]);

  // ... existing table/PK processing ...

  // FK introspection (may fail on DSQL)
  let fkRows = [];
  try {
    const fkResult = await pool.query(FK_SQL);
    fkRows = fkResult.rows;
  } catch {
    // DSQL or other DB that rejects the FK query
    fkRows = [];
  }

  let relationships = fkRows.map(row => ({
    constraint: row.constraint_name,
    fromTable: row.from_table,
    fromColumns: row.from_columns,
    toTable: row.to_table,
    toColumns: row.to_columns,
  }));

  // Convention fallback when no real FKs found
  if (relationships.length === 0) {
    relationships = inferConventionRelationships(tables);
  }

  return { tables, relationships };
}
```

Note: The FK query runs as a separate await after the initial
Promise.all, not inside it. This is because on DSQL the FK
query may fail, and we don't want to abort the columns/PK
queries. Alternatively, add it to the Promise.all with
individual `.catch(() => ({ rows: [] }))`.

#### 3. Implement inferConventionRelationships(tables)

```javascript
function inferConventionRelationships(tables) {
  const relationships = [];
  const tableNames = Object.keys(tables);

  for (const tableName of tableNames) {
    const columns = Object.keys(tables[tableName].columns);
    for (const col of columns) {
      if (!col.endsWith('_id')) continue;

      const base = col.slice(0, -3); // strip '_id'
      if (!base) continue; // bare 'id' column

      // Find target table: exact match or pluralized.
      // Skip self-references: both 'base === tableName' and
      // 'base + "s" === tableName' are excluded. This prevents
      // e.g. 'user_id' on 'users' from self-referencing, and
      // also 'user_id' on 'user' from self-referencing.
      let targetTable = null;
      if (tableNames.includes(base)
          && base !== tableName) {
        targetTable = base;
      } else if (tableNames.includes(base + 's')
          && base + 's' !== tableName) {
        targetTable = base + 's';
      }
      if (!targetTable) continue;

      // Target must have single-column PK
      const targetPK = tables[targetTable].primaryKey;
      if (targetPK.length !== 1) continue;

      relationships.push({
        constraint: null,
        fromTable: tableName,
        fromColumns: [col],
        toTable: targetTable,
        toColumns: [targetPK[0]],
      });
    }
  }

  return relationships;
}
```

Edge cases handled:
- `id` column (no prefix before `_id`): `base` is empty,
  skipped
- Self-referencing (`user_id` on `users`): `base + 's' !==
  tableName` check
- Composite PK on target: `targetPK.length !== 1` check
- No matching table: `targetTable` stays null, skipped
- Multiple `_id` columns to same table: each becomes a
  separate relationship (client must disambiguate)

#### 4. Export getRelationships helper

Add alongside existing helpers:

```javascript
export function getRelationships(schema) {
  return schema.relationships || [];
}
```

## Test Requirements

Add unit tests in `src/rest/schema-cache.test.mjs`:

### FK introspection tests (mock pool.query)

- Mock pool returns FK rows -> `relationships` array has
  correct structure (constraint, fromTable, fromColumns,
  toTable, toColumns)
- Mock pool FK query returns zero rows -> relationships
  is empty (fallback does not run if tables have no `_id`
  columns)
- Mock pool FK query throws error -> treated as zero rows,
  no crash

### Convention fallback tests

Create a schema cache with mock introspect function that
returns tables but no FK rows, then verify:

- Table `orders` with column `customer_id`, table `customers`
  with PK `id` -> infers relationship
  `{fromTable: 'orders', fromColumns: ['customer_id'],
  toTable: 'customers', toColumns: ['id']}`
- `foo_id` column but no `foo` or `foos` table -> no
  relationship created
- `user_id` on `users` table -> skipped (self-reference)
- Target table `items` with composite PK `[order_id, product_id]`
  -> skipped
- Column `id` (no prefix) -> skipped
- Multiple `_id` columns pointing to same table: both become
  separate relationships

### Cache integration tests

- `getSchema()` returns object with both `tables` and
  `relationships` keys
- After `refresh()`, relationships are updated
- `getRelationships()` helper returns the array

## Acceptance Criteria

- `pgIntrospect()` returns `{ tables, relationships }`
- FK introspection query correctly extracts relationships on
  standard PostgreSQL
- Convention fallback runs when FK query returns zero rows
- Convention fallback produces correct relationships for
  `_id` columns
- All unit tests pass
- Existing integration tests still pass (the `tables` object
  is unchanged; new `relationships` field is additive)

## Conflict Criteria

- If all target tests already pass before any code changes
  are made, investigate whether the tests are true positives
  before marking the task complete.
- If the FK query syntax is rejected by the test PostgreSQL
  instance, investigate the PostgreSQL version. The query
  requires PostgreSQL 9.4+ for `CROSS JOIN LATERAL unnest
  WITH ORDINALITY`.
- If convention fallback creates incorrect relationships
  (e.g., matching tables that shouldn't be related),
  investigate the table naming and add exclusion logic
  before proceeding.
