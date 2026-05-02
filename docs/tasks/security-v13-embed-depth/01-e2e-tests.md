# Task 01: Tests for Embed Depth Limit

**Agent:** implementer
**Design:** docs/design/security-v13-embed-depth.md

## Objective

Write all unit tests for the V-13 embed depth limit: depth
enforcement in `parseSelectList`, threading through
`parseQuery`, and config resolution via `createPgrest`. All
tests should compile and fail with clear messages.

## Test File Paths

Add tests to existing files — do not create new test files.

- `src/rest/__tests__/query-parser.test.mjs` — add a
  `describe('embed depth limit', ...)` block.
- `src/__tests__/index.test.mjs` — add a
  `describe('maxEmbedDepth config', ...)` block.

Use `node:test` and `node:assert/strict`, matching the
existing test style in those files.

## Test Cases

### query-parser.test.mjs — embed depth limit

**1. Depth 1 embed passes with default limit.**
Given: `parseSelectList('id,customers(name)')`.
Then: returns two nodes (column `id`, embed `customers`
with child column `name`). No error.

**2. Depth 2 embed passes with default limit.**
Given: `parseSelectList('id,items(id,products(name))')`.
Then: returns column `id` and embed `items` containing
nested embed `products`. No error.

**3. Depth 5 embed passes with default limit.**
Given: `parseSelectList('a(b(c(d(e(id)))))')`.
Then: 5 levels of embed nesting, returns successfully.

**4. Depth 6 embed throws PGRST100 with default limit.**
Given: `parseSelectList('a(b(c(d(e(f(id))))))')`.
Then: throws with `code === 'PGRST100'` and message
`'Embedding depth exceeds maximum of 5'`.

**5. Custom maxEmbedDepth=3 allows depth 3.**
Given: `parseSelectList('a(b(c(id)))', 3)`.
Then: returns successfully.

**6. Custom maxEmbedDepth=3 rejects depth 4.**
Given: `parseSelectList('a(b(c(d(id))))', 3)`.
Then: throws with `code === 'PGRST100'` and message
`'Embedding depth exceeds maximum of 3'`.

**7. maxEmbedDepth=1 allows single embed.**
Given: `parseSelectList('id,customers(name)', 1)`.
Then: returns successfully.

**8. maxEmbedDepth=1 rejects nested embed.**
Given: `parseSelectList('id,items(id,products(name))', 1)`.
Then: throws PGRST100 with message
`'Embedding depth exceeds maximum of 1'`.

**9. Multiple embeds at same depth pass.**
Given: `parseSelectList('id,customers(name),items(id)')`.
Then: returns successfully — multiple embeds at depth 1
are fine, only nesting depth matters.

**10. Depth check does not affect non-embed selects.**
Given: `parseSelectList('id,name,amount')`.
Then: returns three column nodes. No error regardless
of depth limit.

### query-parser.test.mjs — parseQuery threading

**11. parseQuery passes maxEmbedDepth to parser.**
Given: `parseQuery({ select: 'a(b(c(d(id))))' },
'GET', null, 3)`.
Then: throws PGRST100 (depth 4 exceeds limit 3).

**12. parseQuery default maxEmbedDepth is 5.**
Given: `parseQuery({ select: 'a(b(c(d(e(id)))))' },
'GET')`.
Then: returns successfully (depth 5, default limit 5).

**13. parseQuery default rejects depth 6.**
Given: `parseQuery({ select:
'a(b(c(d(e(f(id))))))' }, 'GET')`.
Then: throws PGRST100.

### index.test.mjs — maxEmbedDepth config

Follow the same env-var save/restore pattern used by
the existing `errorsVerbose` tests in that file.

**14. Default: maxEmbedDepth is 5.**
`createPgrest({ jwtSecret, database })._ctx.maxEmbedDepth
=== 5`.

**15. Config overrides default.**
`createPgrest({ jwtSecret, database, maxEmbedDepth: 3
})._ctx.maxEmbedDepth === 3`.

**16. Env var overrides default.**
Set `process.env.PGREST_MAX_EMBED_DEPTH = '8'`,
no `maxEmbedDepth` in config.
`_ctx.maxEmbedDepth === 8`.
Save/restore env var so it does not leak.

**17. Config wins over env var.**
Set `process.env.PGREST_MAX_EMBED_DEPTH = '8'` and
`createPgrest({ maxEmbedDepth: 3 })._ctx.maxEmbedDepth
=== 3`.

## Setup Notes

- `parseSelectList` is already exported from
  `query-parser.mjs`. The new tests call it with optional
  second argument (`maxEmbedDepth`) which does not exist
  yet — the tests should fail because the argument is
  ignored.
- For config tests, use the same `jwtSecret` and minimal
  `database` config as existing tests in `index.test.mjs`.
- For tests 4, 6, 8, 11, 13: use `assert.throws` with a
  predicate checking both `err.code` and `err.message`,
  matching the pattern used for other PGRST100 tests in
  the file.

## Acceptance Criteria

- All test files are syntactically valid and load without
  import errors.
- Tests 1, 2, 3, 5, 7, 9, 10, 12 pass (these exercise
  existing behavior that should not break).
- Tests 4, 6, 8, 11, 13 fail (depth check not yet
  implemented — `parseSelectList` ignores the
  `maxEmbedDepth` argument).
- Tests 14–17 fail (config key not yet wired).
- No existing tests break.

## Conflict Criteria

- If any depth-rejection test (4, 6, 8, 11, 13) passes
  before implementation, diagnose why: investigate the
  code path, verify the assertion targets the right
  behavior, and attempt to rewrite the test to isolate
  the intended path. Only escalate if you cannot
  construct a well-formed test that targets the desired
  behavior.
- If any config test (14–17) passes before implementation,
  check whether `maxEmbedDepth` was already added to
  `resolveConfig`. If so, verify it works correctly and
  mark those tests as pre-passing.
