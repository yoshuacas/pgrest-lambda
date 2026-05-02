# Task 06: Add Boundary Tests for maxEmbedDepth Zero and Negative

**Agent:** implementer
**Design:** docs/design/security-v13-embed-depth.md
**Review:** docs/code-review/security-v13-embed-depth.md

## Objective

Add tests that document the behavior of `maxEmbedDepth`
at zero and negative values, and add an explicit boundary
test at an arbitrary non-default limit.

## Problem

The existing tests cover `maxEmbedDepth=1` as the minimum
but not `maxEmbedDepth=0`. Since `0` is a valid integer
that passes through nullish coalescing (`??`), its behavior
should be explicitly documented via tests. The review also
notes the lack of an exact-boundary test at a less common
limit value.

## Target Tests

All tests go in `src/rest/__tests__/query-parser.test.mjs`
inside the existing `embed depth limit` describe block.

### maxEmbedDepth=0 tests

**test_maxEmbedDepth_zero_rejects_all_embeds:**

> Given `parseSelectList('id,customers(name)', 0)`
> When the parser encounters the embed
> Then it throws PGRST100 with message
> `'Embedding depth exceeds maximum of 0'`

**test_maxEmbedDepth_zero_allows_flat_selects:**

> Given `parseSelectList('id,name', 0)`
> When the parser processes the flat select list
> Then it returns two column nodes with no error

### Exact boundary at maxEmbedDepth=2

**test_exact_boundary_maxEmbedDepth_2 (pass):**

> Given `parseSelectList('a(b(id))', 2)`
> When the parser processes depth-2 nesting
> Then it succeeds (depth equals limit)

**test_exact_boundary_maxEmbedDepth_2 (fail):**

> Given `parseSelectList('a(b(c(id)))', 2)`
> When the parser processes depth-3 nesting
> Then it throws PGRST100 with message
> `'Embedding depth exceeds maximum of 2'`

### Negative maxEmbedDepth

**test_negative_maxEmbedDepth_rejects_all_embeds:**

> Given `parseSelectList('id,customers(name)', -1)`
> When the parser encounters the embed
> Then it throws PGRST100 with message
> `'Embedding depth exceeds maximum of -1'`

## Implementation

Add five `it()` blocks to the `embed depth limit` describe
block in `query-parser.test.mjs`. Use `assert.throws` with
a predicate checking `err.code === 'PGRST100'` and
`err.message` for the rejection tests. Use the existing
test style in the file.

No production code changes are needed — these are
documentation tests for existing behavior.

## Acceptance Criteria

- All five new tests pass.
- All existing tests continue to pass.
- No new lint errors.

## Conflict Criteria

- If any test fails unexpectedly, investigate whether
  `parseSelectList` has different boundary semantics than
  expected (e.g., `>=` vs `>` in the depth check) and
  adjust assertions to match the actual intended behavior
  per the design doc (depth check is `depth + 1 >
  maxEmbedDepth`).
