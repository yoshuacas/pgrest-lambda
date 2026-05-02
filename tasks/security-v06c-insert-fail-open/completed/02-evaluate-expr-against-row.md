# Task 02 -- Add evaluateExprAgainstRow Function

**Agent:** implementer
**Design:** docs/design/security-v06c-insert-fail-open.md

## Objective

Add the `evaluateExprAgainstRow` function to
`src/rest/cedar.mjs`. This function evaluates a Cedar
expression AST against a concrete row object and principal,
returning `true` or `false`.

## Target Tests

None from Task 01 directly -- this is a foundation for
Tasks 03–04. The unit tests below verify correctness.

## Implementation

Add `evaluateExprAgainstRow` as a module-level function in
`src/rest/cedar.mjs`, after the existing `translateExpr`
function (around line 374). Export it for testing.

The function reuses the existing `resolveColumn` (line 251)
and `resolveValue` (line 258) helpers. It mirrors
`translateExpr`'s shape dispatch but produces boolean values
instead of SQL strings.

Supported expression shapes:
- `Value` -- return the boolean value directly
- `null` -- return `true` (no condition)
- `is` -- return `true` if entity_type is `PgrestLambda::Row`
- `has` -- return `true` if `row[attr]` is not null/undefined
- `&&` -- short-circuit AND
- `||` -- short-circuit OR
- `!` -- logical NOT
- Comparison operators (`==`, `!=`, `>`, `>=`, `<`, `<=`) --
  resolve column from `resolveColumn`, resolve value from
  `resolveValue`. If the row value is null/undefined, return
  `false` (fail-closed). Otherwise apply the JS comparator.
  Check both `(left=col, right=val)` and `(left=val, right=col)`
  orderings, matching how `translateExpr` handles both.
- `if-then-else` -- evaluate the condition, then the
  appropriate branch
- Anything else (including `in`, `contains`, `like`, etc.)
  -- return `false` (fail-closed) and log a warning via
  `console.warn` in non-production mode. The warning should
  include the expression shape for debugging (e.g.,
  `Cedar INSERT authz: untranslatable expression 'in'`)

See the design document's `evaluateExprAgainstRow` code block
for the full implementation.

Add `evaluateExprAgainstRow` to the module's exports so it
can be imported in tests:

```javascript
// At the end of cedar.mjs, in the export list
export { evaluateExprAgainstRow };
```

Note: this is a named export at the module level, not part of
the `createCedar()` return object. It's a stateless pure
function.

## Test Requirements

Add a `describe('evaluateExprAgainstRow')` block to
`src/rest/__tests__/cedar.test.mjs`. Import
`evaluateExprAgainstRow` alongside the existing imports.

Use helper functions:
```javascript
function res(attr) {
  return { '.': { left: { Var: 'resource' }, attr } };
}
function val(v) {
  return { Value: v };
}
```

Test cases (one `it()` per row):

| Expression | Row | Expected |
|---|---|---|
| `{ Value: true }` | `{}` | `true` |
| `{ Value: false }` | `{}` | `false` |
| `null` | `{}` | `true` |
| `{ is: { entity_type: 'PgrestLambda::Row' } }` | `{}` | `true` |
| `{ is: { entity_type: 'PgrestLambda::Table' } }` | `{}` | `false` |
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
| `{ '&&': { left: val(true), right: val(true) } }` | `{}` | `true` |
| `{ '&&': { left: val(true), right: val(false) } }` | `{}` | `false` |
| `{ '\|\|': { left: val(false), right: val(true) } }` | `{}` | `true` |
| `{ '\|\|': { left: val(false), right: val(false) } }` | `{}` | `false` |
| `{ '!': { arg: val(true) } }` | `{}` | `false` |
| `{ '!': { arg: val(false) } }` | `{}` | `true` |
| `{ 'if-then-else': { if: val(true), then: val(true), else: val(false) } }` | `{}` | `true` |
| `{ 'if-then-else': { if: val(false), then: val(true), else: val(false) } }` | `{}` | `false` |
| `{ 'in': {} }` | `{}` | `false` |
| Entity UID: `{ '==': { left: res('owner_id'), right: { Value: { __entity: { type: 'PgrestLambda::User', id: 'u1' } } } } }` | `{ owner_id: 'u1' }` | `true` |
| Entity UID mismatch: same as above | `{ owner_id: 'u2' }` | `false` |

## Acceptance Criteria

- `evaluateExprAgainstRow` is exported from `cedar.mjs`.
- All unit tests pass.
- All existing tests (`npm test`) still pass.

## Conflict Criteria

- If `resolveColumn` or `resolveValue` do not exist at the
  expected locations (around lines 251 and 258 of cedar.mjs),
  investigate whether they've been moved or renamed. Do not
  duplicate them.
- If all unit tests pass before any code changes, investigate
  whether the tests are true positives before marking complete.
