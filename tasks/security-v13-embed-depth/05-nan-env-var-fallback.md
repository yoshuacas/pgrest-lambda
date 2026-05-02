# Task 05: Guard Against NaN from Non-Numeric Env Var

**Agent:** bug-fixer
**Design:** docs/design/security-v13-embed-depth.md
**Review:** docs/code-review/security-v13-embed-depth.md

## Objective

Fix the NaN bypass in `resolveConfig` where a non-numeric
`PGREST_MAX_EMBED_DEPTH` env var silently disables the
embed depth limit.

## Problem

`parseInt('abc', 10)` returns `NaN`. Because the string
`'abc'` is truthy, the ternary in `resolveConfig` takes the
`parseInt` branch and stores `NaN` in `maxEmbedDepth`. The
depth check `depth + 1 > NaN` is always `false`, so the
limit is silently bypassed — the exact vulnerability V-13
is meant to close.

## Target Tests

From `src/__tests__/index.test.mjs` (new tests):
- `test_non_numeric_env_var_falls_back_to_default`

From `src/rest/__tests__/query-parser.test.mjs` (new test):
- `test_nan_maxEmbedDepth_does_not_bypass_limit`

## Implementation

### src/__tests__/index.test.mjs

Add a test inside the `maxEmbedDepth config` describe block:

```javascript
it('non-numeric env var falls back to default', () => {
  const prev = process.env.PGREST_MAX_EMBED_DEPTH;
  process.env.PGREST_MAX_EMBED_DEPTH = 'abc';
  try {
    const pgrest = createPgrest({
      jwtSecret: JWT_SECRET,
      database: { host: 'localhost' },
      auth: false,
    });
    assert.equal(pgrest._ctx.maxEmbedDepth, 5);
  } finally {
    if (prev === undefined) delete process.env.PGREST_MAX_EMBED_DEPTH;
    else process.env.PGREST_MAX_EMBED_DEPTH = prev;
  }
});
```

Use the same `jwtSecret` and `database` config as the
existing tests in that file.

### src/rest/__tests__/query-parser.test.mjs

Add a test inside the `embed depth limit` describe block:

```javascript
it('NaN maxEmbedDepth does not bypass limit', () => {
  assert.throws(
    () => parseSelectList(
      'a(b(c(d(e(f(id))))))', NaN),
    (err) => err.code === 'PGRST100',
  );
});
```

### src/index.mjs — resolveConfig

Change the `maxEmbedDepth` line (line 109-112) from:

```javascript
maxEmbedDepth: config.maxEmbedDepth
  ?? (process.env.PGREST_MAX_EMBED_DEPTH
    ? parseInt(process.env.PGREST_MAX_EMBED_DEPTH, 10)
    : 5),
```

to:

```javascript
maxEmbedDepth: config.maxEmbedDepth
  ?? parseIntOrDefault(
    process.env.PGREST_MAX_EMBED_DEPTH, 5),
```

Add a helper near the top of `src/index.mjs` (before
`resolveConfig`):

```javascript
function parseIntOrDefault(value, fallback) {
  if (!value) return fallback;
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}
```

This helper is local to `index.mjs` — do not export it.
It handles the three cases: undefined/empty string returns
fallback, non-numeric string returns fallback, valid
numeric string returns the parsed integer.

### src/rest/query-parser.mjs — parseSelectList

Add a NaN guard at the top of `parseSelectList`, before
the existing parsing logic:

```javascript
if (Number.isNaN(maxEmbedDepth)) {
  maxEmbedDepth = DEFAULT_MAX_EMBED_DEPTH;
}
```

This is a defense-in-depth measure for direct callers of
`parseSelectList` who may pass `NaN` without going through
`resolveConfig`.

## Acceptance Criteria

- `PGREST_MAX_EMBED_DEPTH='abc'` results in
  `maxEmbedDepth` of `5` (not `NaN`).
- `parseSelectList('a(b(c(d(e(f(id))))))', NaN)` throws
  PGRST100 (falls back to default 5, depth 6 exceeds it).
- All existing tests continue to pass.
- No new lint errors or warnings.

## Conflict Criteria

- If `resolveConfig` already has a NaN guard, verify it
  matches the expected behavior and only add the missing
  tests.
- If `parseSelectList` already guards against NaN
  `maxEmbedDepth`, verify the guard uses
  `DEFAULT_MAX_EMBED_DEPTH` as fallback.
