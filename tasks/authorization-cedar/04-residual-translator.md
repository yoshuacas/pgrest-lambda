# Task 04: Residual-to-SQL Translator

**Agent:** implementer
**Design:** docs/design/authorization-cedar.md
**Depends on:** Task 03

## Objective

Implement `translateExpr()` in `src/rest/cedar.mjs` — the
function that converts Cedar residual expression ASTs into
parameterized SQL WHERE fragments.

## Target Tests

From `cedar.test.mjs` (Task 01):

- 'equality comparison translates to "col" = $N' (#1)
- 'inequality comparison translates to "col" != $N' (#2)
- 'greater-than comparison translates to "col" > $N' (#3)
- 'greater-or-equal translates to "col" >= $N' (#4)
- 'less-than translates to "col" < $N' (#5)
- 'less-or-equal translates to "col" <= $N' (#6)
- 'AND conjunction translates to (left AND right)' (#7)
- 'OR disjunction translates to (left OR right)' (#8)
- 'NOT negation translates to NOT (expr)' (#9)
- 'has-attribute translates to "col" IS NOT NULL' (#10)
- 'CPE noise collapse: true AND condition reduces to condition' (#11)
- 'CPE noise collapse: nested true chains reduce to condition' (#12)
- 'CPE noise collapse: condition AND true reduces to condition' (#13)
- 'CPE noise collapse: true OR X reduces to true' (#14)
- 'entity UID value extraction: extracts id from __entity' (#15)
- 'type check (is Row) collapses to true' (#16)
- 'type check (non-Row) collapses to false' (#17)
- 'unknown marker treated as resource for attribute access' (#18)
- 'untranslatable expression (in) throws PGRST000' (#19)
- 'untranslatable expression (contains) throws PGRST000' (#20)
- 'untranslatable expression (like) throws PGRST000' (#21)
- 'parameter numbering respects startParam' (#22)
- 'if-then-else translates to CASE WHEN' (#23)
- 'Value false translates to FALSE' (#24)

## Implementation

### Add to `src/rest/cedar.mjs`

Implement and export `translateExpr(expr, values, tableName, schema)`.
This is a recursive function that walks the Cedar Expr AST
(a tagged JSON union per the Cedar JSON policy format) and
returns a SQL condition string. It mutates `values` by pushing
parameter values as it encounters them.

The function is pure in terms of its SQL output — it does not
call Cedar WASM. It operates on hand-crafted or Cedar-produced
AST objects.

#### Function signature

```javascript
export function translateExpr(expr, values, tableName, schema) {
  // Returns: string (SQL condition fragment)
  // Side effect: pushes values into the values array
  // Throws: PostgRESTError PGRST000 for untranslatable exprs
}
```

The caller controls parameter numbering by pre-populating
`values` — the first placeholder number is `values.length + 1`
after each push.

#### Expression handling

Walk the AST by checking for known keys on the expr object.
The Cedar JSON policy format uses a tagged union where each
expression type is a single-key object.

**Comparison operators (`==`, `!=`, `>`, `>=`, `<`, `<=`):**
- Extract `left` and `right` from `expr[op]`
- Left should resolve to a column name (via attribute access)
- Right should resolve to a literal value
- Push value into `values` array
- Return `"col" op $N`

**Attribute access (`.`):**
- `expr["."]` has `left` and `attr`
- If left is `{ "Var": "resource" }` or
  `{ "unknown": [{ "Value": "resource" }] }`, resolve `attr`
  as a column name
- Validate column exists in `schema.tables[tableName].columns`
- Return the quoted column name `"attr"`

**Boolean logic (`&&`, `||`, `!`):**
- `&&`: translate left and right, return `(left AND right)`
  - CPE noise collapse: if left is `true`, return right only;
    if right is `true`, return left only
- `||`: translate left and right, return `(left OR right)`
  - If either side is `true`, return a truthy sentinel
    (e.g., the string `"TRUE"`)
- `!`: translate arg, return `NOT (arg)`

**Has-attribute (`has`):**
- `expr.has` has `left` and `attr`
- Resolve `attr` as a column name (same as `.`)
- Return `"attr" IS NOT NULL`

**Literal values (`Value`):**
- `true` → return sentinel `true` (for CPE collapse)
- `false` → return `"FALSE"`
- String/number → push to values, return `$N`
- Entity UID (`{ "__entity": { type, id } }`) → extract
  `id`, push to values, return `$N`

**Resource variable (`Var`):**
- `{ "Var": "resource" }` → used for attribute access
  resolution, not directly translated

**Unknown marker (`unknown`):**
- `{ "unknown": [{ "Value": "resource" }] }` → treat as
  `{ "Var": "resource" }` for attribute access

**Type check (`is`):**
- `expr.is` has `left` and `entity_type`
- If `entity_type` is or ends with `"Row"` → return
  sentinel `true`
- Otherwise → return `"FALSE"`

**If-then-else:**
- `expr["if-then-else"]` has `if`, `then`, `else`
- If `if` resolves to a known constant, select the branch
- Otherwise: translate all three, return
  `CASE WHEN (if) THEN (then) ELSE (else) END`

**Untranslatable expressions:**
- `in`, `like`, `contains`, `containsAll`, `containsAny`,
  `isEmpty`, `hasTag`, `getTag`, or any extension function
- Throw `PostgRESTError(500, 'PGRST000', 'Authorization policy produced untranslatable condition')`

#### Sentinel handling

The `true` sentinel (literal boolean `true` in JavaScript,
not the string `"TRUE"`) indicates a condition that is always
true and should be collapsed by the caller. The function
should handle this consistently:

- `&&` with one `true` side → return the other side
- `||` with one `true` side → return `true` sentinel
- When the top-level result is the `true` sentinel, the
  caller should treat it as "no condition needed"

#### Column validation

When resolving a column name from attribute access, validate
it exists in `schema.tables[tableName].columns`. If not
found, throw `PostgRESTError(500, 'PGRST000', ...)` — this
means the policy references a column that does not exist,
which is a policy configuration error.

## Test Requirements

No additional unit tests beyond Task 01. The 24 translator
test cases thoroughly cover the implementation.

## Acceptance Criteria

- `translateExpr` is exported from `src/rest/cedar.mjs`
- All 24 target tests (#1-#24) pass
- Existing tests still pass
- No security vulnerabilities: all column names are validated
  against the schema before being interpolated into SQL

## Conflict Criteria

- If `translateExpr` already exists in `cedar.mjs`, read it
  and fix/extend rather than rewriting.
- If the Cedar residual AST format differs from what the
  design describes (e.g., different key names), adapt the
  translator and document the deviation.
- If all target tests already pass before any code changes,
  investigate whether the tests are true positives before
  marking the task complete.
