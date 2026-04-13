# Task 02: Select Parser — Parenthesis-Aware Tree Parsing

Agent: implementer
Design: docs/design/resource-embedding.md

## Objective

Replace the comma-split select parsing in `query-parser.mjs`
with a character-level scanner that produces a select tree of
column and embed nodes, supporting aliases, hints, !inner, and
nested embeds.

## Target Tests

From Task 01:
- Many-to-one embed (parser must recognize `customers(name,email)`)
- Wildcard parent and child (`*,customers(*)`)
- Aliased embed (`buyer:customers(name)`)
- Nested embed (`order_items(id,products(name))`)
- Inner join (`orders!inner(id)`)
- Disambiguation (`addresses!billing_address_id(*)`)
- Space handling (`id, customers(name, email)`)
- Backward compatibility: flat select, wildcard, no select param
- Error: column not found in embed (PGRST204) — parser must
  produce embed nodes so downstream can validate against the
  correct table

Note: Not all target tests will pass after this task alone. The
parser produces the tree, but sql-builder and handler changes
(Tasks 04-05) are needed for the full flow. This task's scope
is: parseQuery returns the correct tree structure, and flat
selects still work end-to-end.

## Implementation

### File: `src/rest/query-parser.mjs`

**Replace** the select parsing block (lines 18-20):

```javascript
const select = params.select
  ? params.select.split(',')
  : ['*'];
```

**With** a call to a new `parseSelectList` function:

```javascript
const select = params.select
  ? parseSelectList(params.select)
  : [{ type: 'column', name: '*' }];
```

### parseSelectList(input)

Character-level scanner that respects parenthesis nesting:

1. Scan characters, tracking parenthesis depth.
2. At depth 0, a comma ends the current token.
3. When an opening `(` is found at depth 0, the preceding
   token is an embed name (possibly with alias/hint/inner).
4. Find the matching `)` (respecting nesting depth).
5. Recursively parse the content inside parentheses as
   the embed's select list.
6. Return an array of nodes.

### Node types

Column node:
```javascript
{ type: 'column', name: 'id' }
// or
{ type: 'column', name: '*' }
```

Embed node:
```javascript
{
  type: 'embed',
  name: 'customers',      // table name for resolution
  alias: null,             // or 'buyer' if aliased
  hint: null,              // or 'billing_address_id'
  inner: false,            // or true if !inner
  select: [ /* child nodes */ ],
}
```

### parseEmbedToken(token)

Parse the token before `(` according to this grammar:
```
[alias ":"] table_name ["!" hint] ["!inner"]
```

Logic:
1. If token contains `:`, split on first `:`.
   Left = alias, right = remainder.
2. Split remainder on `!`. First segment = table name.
   Remaining segments: if a segment is `inner`, set
   inner=true. Otherwise it's the hint.
3. Trim all parts.

Examples:
- `customers` -> name=customers, alias=null, hint=null,
  inner=false
- `buyer:customers` -> name=customers, alias=buyer
- `customers!inner` -> name=customers, inner=true
- `addresses!billing_address_id` -> name=addresses,
  hint=billing_address_id
- `buyer:addresses!billing_fk!inner` -> name=addresses,
  alias=buyer, hint=billing_fk, inner=true

### Backward compatibility

When the select string has no parentheses (flat select), the
parser produces only column nodes. The `resolveSelectCols`
function in `sql-builder.mjs` currently expects a flat array
of strings. It must be updated to handle the new tree format.

**Minimal change in `sql-builder.mjs`**: Update
`resolveSelectCols` to extract column names from nodes:

```javascript
function resolveSelectCols(selectList, schema, table) {
  // Support both old string format (if any callers remain)
  // and new node format
  const cols = selectList.map(s =>
    typeof s === 'string' ? s : s.name
  );
  if (cols.length === 1 && cols[0] === '*') {
    return Object.keys(schema.tables[table].columns);
  }
  for (const col of cols) {
    validateCol(schema, table, col);
  }
  return cols;
}
```

This preserves existing behavior for flat selects. Embed
nodes in the select list will be handled by Task 04
(sql-builder changes). For now, if an embed node reaches
`resolveSelectCols`, it should be filtered out or skipped
so existing queries don't break.

**Important**: The `resolveSelectCols` change is a bridging
step. After Task 04 replaces the select-building logic, this
bridge code is no longer needed. But it ensures that flat
SELECT queries work correctly between Task 02 and Task 04.

## Test Requirements

Add unit tests in a new file `src/rest/query-parser.test.mjs`
(matching the project's test pattern `src/**/*.test.mjs`):

- `parseSelectList('id,amount')` returns two column nodes
- `parseSelectList('*')` returns one wildcard column node
- `parseSelectList('id,customers(name)')` returns column +
  embed with one child column
- `parseSelectList('id,customers(name,email)')` returns embed
  with two child columns
- `parseSelectList('*,customers(*)')` returns wildcard +
  embed with wildcard child
- `parseSelectList('id,buyer:customers(name)')` returns
  embed with alias='buyer', name='customers'
- `parseSelectList('*,addresses!billing_address_id(*)')`
  returns embed with hint='billing_address_id'
- `parseSelectList('id,orders!inner(id)')` returns embed
  with inner=true
- `parseSelectList('id,addresses!billing_fk!inner(*)')`
  returns embed with hint='billing_fk' and inner=true
- `parseSelectList('id,items(id,products(name))')` returns
  embed containing nested embed
- `parseSelectList('id, customers(name, email)')` returns
  same as `id,customers(name,email)` (spaces trimmed)
- `parseSelectList('id,customers(name),amount,items(id)')`
  returns intermixed columns and embeds
- `parseQuery({}, 'GET')` returns select with single
  wildcard column node (no select param default)
- `parseQuery({ select: 'id,name' }, 'GET')` returns select
  with two column nodes (backward compat)

## Acceptance Criteria

- All unit tests in `query-parser.test.mjs` pass
- Existing integration tests still pass (flat selects
  produce the same query results as before)
- `parseQuery` now returns `select` as an array of node
  objects instead of strings
- No changes to files other than `query-parser.mjs` and
  `sql-builder.mjs` (minimal bridge change)

## Conflict Criteria

- If all target tests already pass before any code changes
  are made, investigate whether the tests are true positives
  before marking the task complete.
- If the `sql-builder.mjs` bridge change breaks existing
  integration tests, investigate the specific failure before
  proceeding. The bridge must be transparent to flat selects.
