# Task 04: SQL Generation — Correlated Subqueries for Embeds

Agent: implementer
Design: docs/design/resource-embedding.md
Depends on: Task 02, Task 03

## Objective

Modify `sql-builder.mjs` to generate correlated subqueries
for embed nodes in the select tree. Add relationship resolution,
`json_build_object` / `json_agg` generation, inner join
conditions, and table-qualified column names.

## Target Tests

From Task 01:
- Many-to-one embed (correlated scalar subquery with
  `json_build_object`)
- One-to-many embed (`COALESCE(json_agg(...), '[]'::json)`)
- Many-to-one null FK (subquery returns NULL naturally)
- One-to-many empty array (COALESCE handles this)
- Wildcard expansion in parent and child
- Aliased embed (AS uses alias, not table name)
- Nested embed (recursive json_build_object)
- Inner join one-to-many (EXISTS in parent WHERE)
- Inner join many-to-one (IS NOT NULL in parent WHERE)
- Disambiguation with !hint (relationship resolution)
- Filters alongside embeds (parent WHERE still works)
- Backward compatibility (flat select generates same SQL)

## Implementation

### File: `src/rest/sql-builder.mjs`

#### 1. Add resolveRelationship function

```javascript
function resolveRelationship(
    schema, parentTable, embedName, hint
) {
  const rels = (schema.relationships || []).filter(r =>
    (r.fromTable === parentTable && r.toTable === embedName)
    || (r.toTable === parentTable && r.fromTable === embedName)
  );

  if (rels.length === 0) {
    throw new PostgRESTError(400, 'PGRST200',
      `Could not find a relationship between `
      + `'${parentTable}' and '${embedName}' `
      + `in the schema cache`);
  }

  if (hint) {
    const hinted = rels.filter(r =>
      r.constraint === hint
      || r.fromColumns.includes(hint)
      || r.toColumns.includes(hint)
    );
    if (hinted.length === 0) {
      throw new PostgRESTError(400, 'PGRST200',
        `Could not find a relationship between `
        + `'${parentTable}' and '${embedName}' `
        + `in the schema cache`);
    }
    if (hinted.length > 1) {
      throw ambiguousError(parentTable, embedName, hinted);
    }
    return hinted[0];
  }

  if (rels.length > 1) {
    throw ambiguousError(parentTable, embedName, rels);
  }

  return rels[0];
}
```

#### 2. Add ambiguousError helper

```javascript
function ambiguousError(parentTable, embedName, rels) {
  const details = rels.map(r => {
    const cardinality =
      r.fromTable === parentTable
        ? 'many-to-one' : 'one-to-many';
    return {
      cardinality,
      embedding: `${parentTable} with ${embedName}`,
      relationship: `${r.constraint || '(convention)'} `
        + `using ${r.fromTable}(${r.fromColumns.join(',')})`
        + ` and ${r.toTable}(${r.toColumns.join(',')})`,
    };
  });
  const hint = `Try changing '${embedName}' to one of the `
    + `following: ${rels.map(r =>
        `'${embedName}!${r.constraint || r.fromColumns[0]}'`
      ).join(', ')}. Find the desired relationship in the `
    + `'details' key.`;
  return new PostgRESTError(300, 'PGRST201',
    `Could not embed because more than one relationship `
    + `was found for '${parentTable}' and '${embedName}'`,
    details, hint);
}
```

#### 3. Add buildEmbedSubquery dispatcher

```javascript
function buildEmbedSubquery(
    node, rel, parentTable, schema, values, authzFilters
) {
  if (rel.fromTable === parentTable) {
    // Many-to-one: FK is on parent
    return buildManyToOneSubquery(
      node, rel, parentTable, schema, values, authzFilters);
  } else {
    // One-to-many: FK is on child
    return buildOneToManySubquery(
      node, rel, parentTable, schema, values, authzFilters);
  }
}
```

#### 4. Add buildManyToOneSubquery

```javascript
function buildManyToOneSubquery(
    node, rel, parentTable, schema, values, authzFilters
) {
  const childTable = rel.toTable;
  const childCols = buildJsonBuildObject(
    node.select, childTable, schema, values, authzFilters);
  const joinCond = rel.fromColumns.map((fc, i) =>
    `"${childTable}"."${rel.toColumns[i]}" = `
    + `"${parentTable}"."${fc}"`
  ).join(' AND ');

  let where = joinCond;
  const childAuthz = authzFilters?.[childTable];
  if (childAuthz?.conditions?.length > 0) {
    where += ' AND ' + childAuthz.conditions.join(' AND ');
    values.push(...childAuthz.values);
  }

  return `(SELECT json_build_object(${childCols})`
    + ` FROM "${childTable}" WHERE ${where})`;
}
```

#### 5. Add buildOneToManySubquery

```javascript
function buildOneToManySubquery(
    node, rel, parentTable, schema, values, authzFilters
) {
  const childTable = rel.fromTable;
  const childCols = buildJsonBuildObject(
    node.select, childTable, schema, values, authzFilters);
  const joinCond = rel.fromColumns.map((fc, i) =>
    `"${childTable}"."${fc}" = `
    + `"${parentTable}"."${rel.toColumns[i]}"`
  ).join(' AND ');

  let where = joinCond;
  const childAuthz = authzFilters?.[childTable];
  if (childAuthz?.conditions?.length > 0) {
    where += ' AND ' + childAuthz.conditions.join(' AND ');
    values.push(...childAuthz.values);
  }

  return `COALESCE((SELECT json_agg(json_build_object(`
    + `${childCols})) FROM "${childTable}" WHERE ${where})`
    + `, '[]'::json)`;
}
```

#### 6. Add buildJsonBuildObject

Recursively builds `json_build_object` arguments, handling
nested embeds:

```javascript
function buildJsonBuildObject(
    selectNodes, table, schema, values, authzFilters
) {
  const pairs = [];
  for (const node of selectNodes) {
    if (node.type === 'column') {
      if (node.name === '*') {
        for (const c of Object.keys(
            schema.tables[table].columns)) {
          pairs.push(`'${c}', "${table}"."${c}"`);
        }
      } else {
        validateCol(schema, table, node.name);
        pairs.push(
          `'${node.name}', "${table}"."${node.name}"`);
      }
    } else if (node.type === 'embed') {
      const rel = resolveRelationship(
        schema, table, node.name, node.hint);
      const alias = node.alias || node.name;
      const subquery = buildEmbedSubquery(
        node, rel, table, schema, values, authzFilters);
      pairs.push(`'${alias}', ${subquery}`);
    }
  }
  return pairs.join(', ');
}
```

#### 7. Modify buildSelect

Replace the existing `buildSelect` function to handle both
flat selects (backward compatible) and embedded selects:

```javascript
export function buildSelect(
    table, parsed, schema, authzConditions
) {
  const values = [];
  const hasEmbeds = parsed.select.some(
    n => n.type === 'embed');

  let colList;
  const innerJoinConds = [];

  if (hasEmbeds) {
    // Build select expressions from tree
    const expressions = [];
    for (const node of parsed.select) {
      if (node.type === 'column') {
        if (node.name === '*') {
          for (const c of Object.keys(
              schema.tables[table].columns)) {
            expressions.push(`"${table}"."${c}"`);
          }
        } else {
          validateCol(schema, table, node.name);
          expressions.push(`"${table}"."${node.name}"`);
        }
      } else if (node.type === 'embed') {
        const rel = resolveRelationship(
          schema, table, node.name, node.hint);
        const alias = node.alias || node.name;
        const subquery = buildEmbedSubquery(
          node, rel, table, schema, values,
          authzConditions?.embeds);
        expressions.push(`${subquery} AS "${alias}"`);

        // Inner join conditions
        if (node.inner) {
          if (rel.fromTable === table) {
            // Many-to-one inner: FK column IS NOT NULL
            innerJoinConds.push(
              rel.fromColumns.map(fc =>
                `"${table}"."${fc}" IS NOT NULL`
              ).join(' AND '));
          } else {
            // One-to-many inner: EXISTS subquery
            const existsCond = rel.fromColumns.map((fc, i) =>
              `"${rel.fromTable}"."${fc}" = `
              + `"${table}"."${rel.toColumns[i]}"`
            ).join(' AND ');
            innerJoinConds.push(
              `EXISTS (SELECT 1 FROM "${rel.fromTable}"`
              + ` WHERE ${existsCond})`);
          }
        }
      }
    }
    colList = expressions.join(', ');
  } else {
    // Flat select — backward compatible path
    const cols = parsed.select.map(n =>
      typeof n === 'string' ? n : n.name);
    if (cols.length === 1 && cols[0] === '*') {
      colList = Object.keys(schema.tables[table].columns)
        .map(c => `"${c}"`).join(', ');
    } else {
      for (const c of cols) validateCol(schema, table, c);
      colList = cols.map(c => `"${c}"`).join(', ');
    }
  }

  // Build WHERE conditions
  const conds = buildFilterConditions(
    parsed.filters, schema, table, values);

  // Add inner join conditions
  for (const ijc of innerJoinConds) {
    conds.push(ijc);
  }

  // Add parent authz conditions
  const parentAuthz = authzConditions?.parent
    || authzConditions;
  if (parentAuthz?.conditions?.length > 0) {
    for (const cond of parentAuthz.conditions) {
      conds.push(cond);
    }
    values.push(...parentAuthz.values);
  }

  let sql = `SELECT ${colList} FROM "${table}"`;
  sql += whereClause(conds);
  sql += orderClause(parsed.order, schema, table);
  sql += limitOffsetClause(parsed.limit, parsed.offset, values);

  return { text: sql, values };
}
```

**Important note on authzConditions shape**: The existing
handler passes `authzConditions` as a single object with
`{ conditions, values }` for the parent table. With embeds,
the handler (Task 05) will pass a structured object:
```javascript
{
  parent: { conditions, values },
  embeds: { customers: { conditions, values }, ... }
}
```

The `buildSelect` function must handle both shapes for
backward compatibility. When `authzConditions` has no
`parent` key, treat the whole object as parent conditions
(existing behavior).

### Table-qualified column names

When embeds are present, all parent columns are prefixed
with `"table"."col"` instead of just `"col"`. When no
embeds are present, the existing unqualified format is
preserved. This avoids ambiguity with subquery column names.

Note: The `buildFilterConditions` and `orderClause` functions
currently produce unqualified column names (`"col"`). When
embeds are present, these should also be table-qualified.
However, since filters and ORDER BY reference the parent table
only (embed filters are deferred per the design's Open
Questions), and there's no FROM-level join that would create
ambiguity, unqualified names still work. If this causes issues
in testing, add table qualification to filter/order clauses.

## Test Requirements

Add unit tests in `src/rest/sql-builder.test.mjs`:

All SQL assertions should normalize whitespace before
comparing (collapse multiple spaces/newlines to single space,
trim).

### Many-to-one subquery

Given schema with orders.customer_id -> customers.id:
- Input: `select=[{type:'column',name:'id'}, {type:'embed',
  name:'customers', select:[{type:'column',name:'name'}]}]`
- Expected SQL contains:
  `SELECT "orders"."id", (SELECT json_build_object('name',
  "customers"."name") FROM "customers" WHERE
  "customers"."id" = "orders"."customer_id") AS "customers"
  FROM "orders"`

### One-to-many subquery

Given schema with orders.customer_id -> customers.id:
- Input from customers: embeds orders(id,amount)
- Expected SQL contains:
  `COALESCE((SELECT json_agg(json_build_object('id',
  "orders"."id", 'amount', "orders"."amount")) FROM "orders"
  WHERE "orders"."customer_id" = "customers"."id"),
  '[]'::json) AS "orders"`

### Aliased embed

- `buyer:customers(name)` -> subquery AS "buyer"

### Nested embed

- `items(id,products(name))` -> nested json_build_object
  with inner subquery

### Inner join one-to-many

- `orders!inner(id)` from customers -> parent WHERE includes
  `EXISTS (SELECT 1 FROM "orders" WHERE ...)`

### Inner join many-to-one

- `customers!inner(name)` from orders -> parent WHERE includes
  `"orders"."customer_id" IS NOT NULL`

### Disambiguation

- Two relationships between orders and addresses ->
  `!billing_address_id` hint selects correct one

### Error: PGRST200

- Embed name with no matching relationship -> throws
  PostgRESTError with code PGRST200

### Error: PGRST201

- Two relationships, no hint -> throws PostgRESTError with
  code PGRST201, details array, hint string

### Backward compatibility

- Flat select `[{type:'column',name:'id'},
  {type:'column',name:'amount'}]` -> generates same SQL as
  before (unqualified columns, no subqueries)

### Filters with embeds

- Filters on parent table work alongside embed subqueries

## Acceptance Criteria

- `buildSelect` generates correct correlated subqueries for
  many-to-one and one-to-many embeds
- `json_build_object` and `json_agg` are used correctly
- Inner join conditions are added to parent WHERE
- Table-qualified columns when embeds are present
- Relationship resolution with PGRST200/PGRST201 errors
- All unit tests pass
- Existing integration tests still pass

## Conflict Criteria

- If all target tests already pass before any code changes
  are made, investigate whether the tests are true positives
  before marking the task complete.
- If the authzConditions shape change breaks the existing
  handler flow, the backward-compatible check
  (`authzConditions?.parent || authzConditions`) must handle
  both old and new shapes. Verify with existing integration
  tests.
