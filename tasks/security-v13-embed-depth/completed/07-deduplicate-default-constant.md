# Task 07: Import DEFAULT_MAX_EMBED_DEPTH in resolveConfig

**Agent:** maintainer
**Design:** docs/design/security-v13-embed-depth.md
**Review:** docs/code-review/security-v13-embed-depth.md

## Objective

Eliminate the duplicated magic number `5` by importing
`DEFAULT_MAX_EMBED_DEPTH` from `query-parser.mjs` into
`src/index.mjs`.

## Problem

The default of `5` appears in two places:
`DEFAULT_MAX_EMBED_DEPTH` in `query-parser.mjs` (line 50)
and as the literal `5` in `resolveConfig` (line 112 of
`index.mjs`). The design doc says "the magic number 5
appears in exactly one place" but the implementation does
not follow through. If the default changes, both files
must be updated.

**Depends on:** Task 05 (which may restructure the
`maxEmbedDepth` line in `resolveConfig`).

## Implementation

### src/rest/query-parser.mjs

Export the constant:

```javascript
export const DEFAULT_MAX_EMBED_DEPTH = 5;
```

It is currently `const` (not exported). Change it to
`export const`.

### src/index.mjs

Add to the existing import from `query-parser.mjs`:

```javascript
import { DEFAULT_MAX_EMBED_DEPTH } from './rest/query-parser.mjs';
```

If there is no existing import from `query-parser.mjs`,
add a new import line.

Replace the literal `5` in the `maxEmbedDepth` fallback
with `DEFAULT_MAX_EMBED_DEPTH`. After Task 05, the
fallback may use a `parseIntOrDefault` helper -- replace
the `5` argument to that helper:

```javascript
maxEmbedDepth: config.maxEmbedDepth
  ?? parseIntOrDefault(
    process.env.PGREST_MAX_EMBED_DEPTH,
    DEFAULT_MAX_EMBED_DEPTH),
```

## Test Requirements

No new tests. The existing config tests (14–17) verify
that the default is 5. If those pass after this change,
the constant is correctly wired.

## Acceptance Criteria

- The literal `5` no longer appears as a default for
  `maxEmbedDepth` in `src/index.mjs`.
- `DEFAULT_MAX_EMBED_DEPTH` is exported from
  `query-parser.mjs` and imported in `index.mjs`.
- All existing tests pass.
- No circular import issues.

## Conflict Criteria

- If `DEFAULT_MAX_EMBED_DEPTH` is already exported,
  skip that step and only update `index.mjs`.
- If `index.mjs` already imports from `query-parser.mjs`,
  add to the existing import statement rather than creating
  a duplicate.
- If a circular dependency is detected (unlikely since
  `index.mjs` already depends on `query-parser.mjs`
  indirectly through `handler.mjs`), escalate rather than
  introducing a circular import.
