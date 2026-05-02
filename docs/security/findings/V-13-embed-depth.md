# V-13 — Unbounded resource embedding depth

- **Severity (reported):** Medium
- **Status:** Fixed
- **Affected (reported):** `src/rest/sql-builder.mjs:115-174`, `src/rest/query-parser.mjs:19-90`
- **Backend dependence:** None (query planner characteristics differ but risk is universal)

## Report summary

Logical-operator nesting is capped at 10 but resource embedding has no depth limit. `select=*,a(b(c(d(...))))` becomes deeply nested correlated subqueries with exponential planner time.

## Our analysis

**Status: fixed at HEAD.**

- `src/rest/query-parser.mjs:19-90` — `parseSelectList(input)` recurses into `input.slice(parenStart + 1, i - 1)` (line 68-69) with no depth argument. Unbounded.
- `src/rest/query-parser.mjs:17, 306-311` — `MAX_NESTING_DEPTH = 10` is enforced for logical groups (`parseLogicalGroup`) but not for embeds. Asymmetry.
- `src/rest/sql-builder.mjs:115-174` — `buildEmbedSubquery` (+ many-to-one / one-to-many variants) builds correlated subqueries whose planner cost grows with depth.

**Fix surface:** add `depth` param to `parseSelectList`, increment on embed recursion (line 69), throw PGRST100 at `depth > maxEmbedDepth`. Default 5; configurable via factory.

## Decision

Fixed. Default `maxEmbedDepth = 5`, configurable via factory.

## Evidence

Commit `0e7d775` — adds `depth` parameter to `parseSelectList`
with a default limit of 5, throwing PGRST100 on overflow.

## Residual risk

Even at depth 5, adversarial embed graphs can be expensive on bad schemas. Pair with a statement_timeout on the DB adapter (see V-19 / adapter config).

## Reviewer handoff

`parseSelectList` now tracks recursion depth and throws
PGRST100 when `maxEmbedDepth` (default 5) is exceeded.
Fix is in place and ready for verification.
