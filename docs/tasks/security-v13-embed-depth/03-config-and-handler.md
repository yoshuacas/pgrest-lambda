# Task 03: Wire maxEmbedDepth Through Config and Handler

**Agent:** implementer
**Design:** docs/design/security-v13-embed-depth.md

## Objective

Add `maxEmbedDepth` to `resolveConfig`, attach it to the
context in `createPgrest`, and pass it through the REST
handler to `parseQuery`.

## Target Tests

From `src/__tests__/index.test.mjs`:
- Default: maxEmbedDepth is 5 (test 14)
- Config overrides default (test 15)
- Env var overrides default (test 16)
- Config wins over env var (test 17)

## Implementation

### src/index.mjs — resolveConfig

Add `maxEmbedDepth` to the `resolveConfig` return object
(around line 109, after the `errorsVerbose` line). Use the
same nullish-coalescing pattern as `errorsVerbose`:

```javascript
maxEmbedDepth: config.maxEmbedDepth
  ?? (process.env.PGREST_MAX_EMBED_DEPTH
    ? parseInt(process.env.PGREST_MAX_EMBED_DEPTH, 10)
    : 5),
```

### src/index.mjs — createPgrest

After the existing `ctx.errorsVerbose` assignment (around
line 147), add:

```javascript
ctx.maxEmbedDepth = resolved.maxEmbedDepth;
```

### src/rest/handler.mjs — parseQuery call sites

The `ctx` object is already available in
`createRestHandler`'s closure scope. Pass
`ctx.maxEmbedDepth` as the fourth argument to all three
`parseQuery` calls:

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
  restParams, method, multiValueParams, ctx.maxEmbedDepth);
```

## Test Requirements

No additional unit tests beyond Task 01. The config tests
verify the full chain.

## Acceptance Criteria

- All config tests (14–17) from Task 01 pass.
- All existing tests continue to pass.
- No new warnings or lint errors.
- `PGREST_MAX_EMBED_DEPTH` env var is respected at runtime.

## Conflict Criteria

- If all target tests already pass before any code changes
  are made, investigate whether `maxEmbedDepth` was already
  wired in a prior task or branch. If so, verify correctness
  and mark as pre-passing.
- If `ctx` does not have a `maxEmbedDepth` property after
  `createPgrest`, the handler will pass `undefined` to
  `parseQuery`, which falls back to the default of 5. This
  is safe but defeats configurability — verify the config
  chain is complete.
