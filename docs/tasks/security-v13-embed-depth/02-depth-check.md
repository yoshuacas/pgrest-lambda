# Task 02: Add Depth Check to parseSelectList

**Agent:** implementer
**Design:** docs/design/security-v13-embed-depth.md

## Objective

Add a `depth` parameter to `parseSelectList` that throws
PGRST100 when embed nesting exceeds `maxEmbedDepth`, and
thread `maxEmbedDepth` through `parseQuery`.

## Target Tests

From `src/rest/__tests__/query-parser.test.mjs`:
- Depth 6 embed throws PGRST100 with default limit (test 4)
- Custom maxEmbedDepth=3 allows depth 3 (test 5)
- Custom maxEmbedDepth=3 rejects depth 4 (test 6)
- maxEmbedDepth=1 allows single embed (test 7)
- maxEmbedDepth=1 rejects nested embed (test 8)
- Multiple embeds at same depth pass (test 9)
- Depth check does not affect non-embed selects (test 10)
- parseQuery passes maxEmbedDepth to parser (test 11)
- parseQuery default maxEmbedDepth is 5 (test 12)
- parseQuery default rejects depth 6 (test 13)

## Implementation

### src/rest/query-parser.mjs

**Add constant** next to the existing `MAX_NESTING_DEPTH = 10`
on line 49:

```javascript
const DEFAULT_MAX_EMBED_DEPTH = 5;
```

**Change `parseSelectList` signature** (line 51) from:

```javascript
export function parseSelectList(input)
```

to:

```javascript
export function parseSelectList(
    input, maxEmbedDepth = DEFAULT_MAX_EMBED_DEPTH, depth = 0)
```

**Add depth check before the recursive call** at line 133.
The current code is:

```javascript
const childNodes = parseSelectList(innerContent);
```

Replace with:

```javascript
if (depth + 1 > maxEmbedDepth) {
  throw new PostgRESTError(400, 'PGRST100',
    `Embedding depth exceeds maximum of ${maxEmbedDepth}`);
}
const childNodes = parseSelectList(
  innerContent, maxEmbedDepth, depth + 1);
```

The check is `depth + 1 > maxEmbedDepth` because `depth + 1`
is the depth that the child would be parsed at. With
`maxEmbedDepth = 5`, the deepest allowed child is at depth 5.

**Change `parseQuery` signature** (line 267) from:

```javascript
export function parseQuery(params, method, multiValueParams)
```

to:

```javascript
export function parseQuery(
    params, method, multiValueParams,
    maxEmbedDepth = DEFAULT_MAX_EMBED_DEPTH)
```

**Pass `maxEmbedDepth`** to the `parseSelectList` call inside
`parseQuery` (around line 271):

```javascript
// Before:
const select = params.select
  ? parseSelectList(params.select)
  : [{ type: 'column', name: '*' }];

// After:
const select = params.select
  ? parseSelectList(params.select, maxEmbedDepth)
  : [{ type: 'column', name: '*' }];
```

## Test Requirements

No additional unit tests beyond Task 01. The depth
enforcement tests cover all edge cases.

## Acceptance Criteria

- All target tests from Task 01 pass.
- All existing `parseSelectList` and `parseQuery` tests
  continue to pass (the signature change uses defaults).
- No new warnings or lint errors.

## Conflict Criteria

- If all target tests already pass before any code changes
  are made, investigate whether the tests are false
  positives before marking the task complete.
- If `parseSelectList` already has a depth parameter, verify
  it matches the design (default 5, PGRST100 error code,
  correct message format) and adjust only what differs.
