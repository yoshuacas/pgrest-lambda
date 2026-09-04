# V-13 — Cap Resource Embedding Depth

Close security finding V-13 (Medium) by adding a depth
limit to `parseSelectList` in the query parser. Deep
embed nesting produces correlated subqueries with
exponential planner cost, making it a DoS vector.

Reference: `docs/security/findings/V-13-embed-depth.md`
Source: `docs/design/prompts/v13-embed-depth.md`

## Overview

`parseSelectList` in `src/rest/query-parser.mjs` recurses
into embedded resource select lists with no depth limit.
A request like `select=*,a(b(c(d(e(f(g(...)))))))` builds
deeply nested correlated subqueries whose planner cost
grows exponentially with depth.

Logical operator nesting is already capped at
`MAX_NESTING_DEPTH = 10` (line 49 of query-parser.mjs),
but embed nesting has no equivalent guard. This asymmetry
is the vulnerability.

The fix adds a `depth` parameter to `parseSelectList`,
increments it on each embed recursion, and throws
PGRST100 when depth exceeds a configurable
`maxEmbedDepth`. Default is 5, configurable via
`createPgrest({ maxEmbedDepth })` or the
`PGREST_MAX_EMBED_DEPTH` environment variable.

## Current CX / Concepts

### Embed parsing has no depth guard

`parseSelectList(input)` at line 51 of query-parser.mjs
takes a single `input` string parameter. At line 133,
when it encounters an embed token (text followed by
parenthesized content), it recurses:

```javascript
const childNodes = parseSelectList(innerContent);
```

There is no depth argument passed or checked. A client
can nest embeds to arbitrary depth.

### Logical operators are capped

`parseLogicalGroup` (line 465) accepts a `depth`
parameter and throws PGRST100 when `depth >
MAX_NESTING_DEPTH` (10). The recursive call at line 450
passes `depth + 1`. This is the pattern to follow.

### Correlated subqueries grow with depth

Each embed level in `sql-builder.mjs` generates a
correlated subquery (many-to-one) or a `json_agg`
subquery (one-to-many). At depth N, the planner
evaluates N nested correlated subqueries. Cost grows
roughly as O(rows^N) in the worst case for adversarial
schemas.

### Current config has no embed depth key

`resolveConfig` in `src/index.mjs` does not read
`maxEmbedDepth` from config or environment. The context
object (`ctx`) passed to handlers does not carry this
value.

## Proposed CX / CX Specification

### Depth limit behavior

Embed nesting up to and including `maxEmbedDepth` levels
succeeds normally. The top-level select list is depth 0.
Each level of embed parentheses increments depth by 1.

Examples with default `maxEmbedDepth = 5`:

```
# Depth 1 — OK
select=id,customers(name)

# Depth 2 — OK
select=id,items(id,products(name))

# Depth 5 — OK (maximum allowed)
select=a(b(c(d(e(id)))))

# Depth 6 — REJECTED
select=a(b(c(d(e(f(id))))))
```

### Error response

When embed depth exceeds `maxEmbedDepth`, the parser
throws PGRST100:

```json
{
  "code": "PGRST100",
  "message": "Embedding depth exceeds maximum of 5",
  "details": null,
  "hint": null
}
```

HTTP status: 400.

The message includes the configured limit so the client
knows what to reduce to. When a non-default limit is
configured, the number in the message reflects that:

```json
{
  "code": "PGRST100",
  "message": "Embedding depth exceeds maximum of 3",
  "details": null,
  "hint": null
}
```

### Configuration

**Library usage:**

```javascript
const pgrest = createPgrest({
  database: { ... },
  jwtSecret: '...',
  maxEmbedDepth: 3,
});
```

**Environment variable:**

```
PGREST_MAX_EMBED_DEPTH=3
```

**Default:** `5`.

Config key takes precedence over env var. Env var takes
precedence over default. This follows the same precedence
pattern as all other config keys (documented in
`docs/reference/configuration.md`).

### What does NOT change

- Embed parsing logic (alias, hint, inner, column
  validation) is unchanged.
- Queries without embeds are unaffected.
- Logical operator nesting depth remains at 10.
- The `parseQuery` public API signature does not change
  for callers that do not use `maxEmbedDepth` (the
  parameter is optional with a default).

## Technical Design

### 1. Add `maxEmbedDepth` parameter to `parseSelectList`

Change the signature from:

```javascript
export function parseSelectList(input)
```

to:

```javascript
export function parseSelectList(input, maxEmbedDepth = 5, depth = 0)
```

`maxEmbedDepth` is the configured limit. `depth` is the
current recursion depth, starting at 0 for the top-level
call.

### 2. Check depth before recursing

At line 133 (the embed recursion), add a depth check
before the recursive call:

```javascript
// Before:
const childNodes = parseSelectList(innerContent);

// After:
if (depth + 1 > maxEmbedDepth) {
  throw new PostgRESTError(400, 'PGRST100',
    `Embedding depth exceeds maximum of ${maxEmbedDepth}`);
}
const childNodes = parseSelectList(
  innerContent, maxEmbedDepth, depth + 1);
```

The check is `depth + 1 > maxEmbedDepth` because
`depth + 1` is the depth that the child would be parsed
at. With `maxEmbedDepth = 5`, the deepest allowed child
is at depth 5, which means 5 levels of nesting from the
root.

### 3. Thread `maxEmbedDepth` through `parseQuery`

`parseQuery` at line 267 calls `parseSelectList` at
line 271. Add `maxEmbedDepth` as an optional fourth
parameter to `parseQuery`:

```javascript
export function parseQuery(
    params, method, multiValueParams, maxEmbedDepth = 5,
) {
  // ...
  const select = params.select
    ? parseSelectList(params.select, maxEmbedDepth)
    : [{ type: 'column', name: '*' }];
  // ...
}
```

The default of 5 matches the `parseSelectList` default,
so callers that do not pass `maxEmbedDepth` get the same
behavior.

### 4. Add `maxEmbedDepth` to `resolveConfig`

In `src/index.mjs`, add to the `resolveConfig` return
object:

```javascript
maxEmbedDepth: config.maxEmbedDepth
  ?? (process.env.PGREST_MAX_EMBED_DEPTH
    ? parseInt(process.env.PGREST_MAX_EMBED_DEPTH, 10)
    : 5),
```

Uses nullish coalescing (`??`) so an explicit `0` or
other falsy value from config is respected, consistent
with the `errorsVerbose` pattern.

### 5. Attach to context in `createPgrest`

In `createPgrest`, after the existing context
assignments:

```javascript
ctx.maxEmbedDepth = resolved.maxEmbedDepth;
```

### 6. Pass through handler to `parseQuery`

In `src/rest/handler.mjs`, the three `parseQuery` call
sites pass `ctx.maxEmbedDepth` as the fourth argument:

**Line 261 (table route):**
```javascript
const parsed = parseQuery(
  params, method, multiValueParams, ctx.maxEmbedDepth);
```

**Line 522 (RPC POST):**
```javascript
parsed = parseQuery(
  params, method, multiValueParams, ctx.maxEmbedDepth);
```

**Line 534 (RPC GET):**
```javascript
parsed = parseQuery(
  restParams, method, multiValueParams,
  ctx.maxEmbedDepth);
```

Note: the `ctx` object is already available in
`createRestHandler`'s closure scope — it is the first
argument to the factory. `maxEmbedDepth` is read from it
directly, no additional parameter threading needed.

### 7. Default constant

Define a module-level constant in `query-parser.mjs`
alongside the existing `MAX_NESTING_DEPTH`:

```javascript
const DEFAULT_MAX_EMBED_DEPTH = 5;
```

Use this as the default for both `parseSelectList` and
`parseQuery` parameter defaults, so the magic number 5
appears in exactly one place.

## Code Architecture / File Changes

### Modified files

- **`src/rest/query-parser.mjs`**
  - Add `DEFAULT_MAX_EMBED_DEPTH = 5` constant.
  - Change `parseSelectList(input)` signature to
    `parseSelectList(input, maxEmbedDepth =
    DEFAULT_MAX_EMBED_DEPTH, depth = 0)`.
  - Add depth check before recursive call at line 133.
  - Pass `maxEmbedDepth` and `depth + 1` to recursive
    call.
  - Add `maxEmbedDepth` parameter to `parseQuery`,
    default `DEFAULT_MAX_EMBED_DEPTH`.
  - Pass `maxEmbedDepth` to `parseSelectList` call.

- **`src/index.mjs`**
  - Add `maxEmbedDepth` to `resolveConfig` return
    object, reading from `config.maxEmbedDepth` with
    env var fallback `PGREST_MAX_EMBED_DEPTH`, default
    5.
  - Attach `ctx.maxEmbedDepth = resolved.maxEmbedDepth`
    in `createPgrest`.

- **`src/rest/handler.mjs`**
  - Pass `ctx.maxEmbedDepth` as fourth argument to all
    three `parseQuery` call sites.

- **`docs/security/findings/V-13-embed-depth.md`**
  - Flip Status to Fixed.
  - Fill Evidence section with commit reference.
  - Update Reviewer handoff.

- **`docs/security/assessment.md`**
  - Flip V-13 row status from Open to Fixed.

- **`docs/reference/configuration.md`**
  - Add `maxEmbedDepth` / `PGREST_MAX_EMBED_DEPTH` row
    to the Core table.

### Not modified

- `src/rest/sql-builder.mjs` — SQL generation is
  unchanged; depth is enforced at parse time before any
  SQL is built.
- `src/rest/errors.mjs` — PGRST100 is already used for
  parse errors; no new error code needed.
- `src/rest/schema-cache.mjs` — no change.
- `src/auth/**` — no auth changes.
- `src/rest/response.mjs` — unchanged.
- `src/rest/router.mjs` — unchanged.

### No new files. No new npm dependencies.

## Testing Strategy

### Unit tests: `parseSelectList` depth enforcement

Tests call `parseSelectList` directly to verify depth
behavior in isolation from config plumbing.

**1. Depth 1 embed passes with default limit.**
Given: `parseSelectList('id,customers(name)')`.
Then: returns two nodes (column `id`, embed `customers`
with column `name`). No error.

**2. Depth 2 embed passes with default limit.**
Given: `parseSelectList('id,items(id,products(name))')`.
Then: returns column `id` and embed `items` containing
nested embed `products`. No error.

**3. Depth 5 embed passes with default limit.**
Given: `parseSelectList('a(b(c(d(e(id)))))')`.
Then: 5 levels of embed nesting, returns successfully.

**4. Depth 6 embed throws PGRST100 with default limit.**
Given: `parseSelectList('a(b(c(d(e(f(id))))))')`.
Then: throws `PostgRESTError` with code `PGRST100` and
message `'Embedding depth exceeds maximum of 5'`.

**5. Custom maxEmbedDepth=3 allows depth 3.**
Given: `parseSelectList('a(b(c(id)))', 3)`.
Then: returns successfully (3 levels of nesting).

**6. Custom maxEmbedDepth=3 rejects depth 4.**
Given: `parseSelectList('a(b(c(d(id))))', 3)`.
Then: throws `PostgRESTError` with code `PGRST100` and
message `'Embedding depth exceeds maximum of 3'`.

**7. maxEmbedDepth=1 allows single embed.**
Given: `parseSelectList('id,customers(name)', 1)`.
Then: returns successfully.

**8. maxEmbedDepth=1 rejects nested embed.**
Given: `parseSelectList('id,items(id,products(name))',
1)`.
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

### Unit tests: `parseQuery` threading

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

### Config tests via `createPgrest`

Test through the public `createPgrest({ ... })` API
and inspect `_ctx.maxEmbedDepth`, following the same
pattern used by the `errorsVerbose` config tests in
`src/__tests__/index.test.mjs`.

**14. Default: maxEmbedDepth is 5.**
`createPgrest({})` -> `_ctx.maxEmbedDepth === 5`.

**15. Config overrides default.**
`createPgrest({ maxEmbedDepth: 3 })` ->
`_ctx.maxEmbedDepth === 3`.

**16. Env var overrides default.**
Set `process.env.PGREST_MAX_EMBED_DEPTH = '8'`,
no `maxEmbedDepth` in config ->
`_ctx.maxEmbedDepth === 8`.
Save/restore env var so it does not leak.

**17. Config wins over env var.**
Set `process.env.PGREST_MAX_EMBED_DEPTH = '8'` and
`createPgrest({ maxEmbedDepth: 3 })` ->
`_ctx.maxEmbedDepth === 3`.

### Integration tests

**18. Existing embed integration tests pass.**
All tests in `test/integration/embedding.test.mjs`
continue to pass unchanged. Normal embed depths (1-2
levels) are well within the default limit of 5.

### Existing test preservation

All existing `parseSelectList` tests in
`query-parser.test.mjs` continue to pass unchanged.
None of them nest embeds deeper than 3 levels, and the
function signature change uses default parameters.

## Implementation Order

1. **`src/rest/query-parser.mjs`** — Add
   `DEFAULT_MAX_EMBED_DEPTH` constant, update
   `parseSelectList` and `parseQuery` signatures, add
   depth check before recursive call.

2. **`src/index.mjs`** — Add `maxEmbedDepth` to
   `resolveConfig` and attach to `ctx` in
   `createPgrest`.

3. **`src/rest/handler.mjs`** — Pass
   `ctx.maxEmbedDepth` to all three `parseQuery` call
   sites.

4. **Unit tests** — Add depth enforcement tests for
   `parseSelectList` and `parseQuery` threading.

5. **Config tests** — Add `maxEmbedDepth` config tests
   via `createPgrest` -> `_ctx`.

6. **Run existing tests** — Verify all existing
   query-parser, embedding, and integration tests pass.

7. **Tracker files** — Update V-13 finding,
   assessment.md, configuration.md.

## Open Questions

None. The prompt specifies all decisions:

- Default depth limit is 5.
- Config key is `maxEmbedDepth`.
- Env var is `PGREST_MAX_EMBED_DEPTH`.
- Error code is PGRST100 (existing parse error code).
- Depth is checked at parse time, before SQL generation.
