# Code Review: security-v13-embed-depth

## Correctness

### NaN bypass when PGREST_MAX_EMBED_DEPTH is non-numeric

**File:** `src/index.mjs` (line 109-112)

`parseInt('abc', 10)` returns `NaN`. Because the env var
string `'abc'` is truthy, the ternary takes the parseInt
branch and stores `NaN` in `maxEmbedDepth`. In
`parseSelectList`, the depth check `depth + 1 > NaN` is
always `false`, so the depth limit is silently bypassed and
embeds nest without bound — the exact vulnerability V-13
is meant to close.

The same class of bug exists for `schemaCacheTtl` and
`PG_PORT`, but those are pre-existing; this review covers
only the new code.

**Proposed test:**

> Given `PGREST_MAX_EMBED_DEPTH` is set to `'abc'`
> When `resolveConfig` is called with no config override
> Then `maxEmbedDepth` is `5` (the default), not `NaN`

**Test location:** `src/__tests__/index.test.mjs`
**Function:** `test_non_numeric_env_var_falls_back_to_default`

---

> Given `PGREST_MAX_EMBED_DEPTH` is set to `'abc'`
> When a request includes `select=a(b(c(d(e(f(id))))))`
> Then the parser throws PGRST100 (depth 6 exceeds default 5)

**Test location:** `src/rest/__tests__/query-parser.test.mjs`
**Function:** `test_nan_maxEmbedDepth_does_not_bypass_limit`

### No validation for zero or negative maxEmbedDepth

**File:** `src/index.mjs` (line 109-112)

`maxEmbedDepth: 0` disables all embeds (including
depth-1), and `maxEmbedDepth: -1` does the same. These are
arguably valid operational choices, but there is no
documented minimum and no guard against accidental
misconfiguration. A `maxEmbedDepth` of `0` passed via
config is preserved by nullish coalescing (`??`), which is
correct for intentional use but surprising if the caller
passes `0` by mistake.

This is speculative — `0` may be intentional ("no embeds
allowed"). But the design doc does not specify behavior for
`maxEmbedDepth <= 0`, and the configuration reference does
not document whether `0` is valid.

**Proposed test:**

> Given `maxEmbedDepth` is `0` in config
> When a request includes `select=id,customers(name)`
> Then the parser throws PGRST100 with message
> `'Embedding depth exceeds maximum of 0'`

**Test location:** `src/rest/__tests__/query-parser.test.mjs`
**Function:** `test_maxEmbedDepth_zero_rejects_all_embeds`

---

> Given `maxEmbedDepth` is `0` in config
> When a request includes `select=id,name` (no embeds)
> Then the request succeeds normally

**Test location:** `src/rest/__tests__/query-parser.test.mjs`
**Function:** `test_maxEmbedDepth_zero_allows_flat_selects`

### V-13 evidence references commit hash that may not be on main

**File:** `docs/security/findings/V-13-embed-depth.md` (line 28)

The evidence section references commit `0e7d775`. This is a
feature-branch commit. If the branch is squash-merged (as
CLAUDE.md recommends), this hash will not exist on main and
the evidence link becomes a dead reference. This is a
documentation accuracy concern, not a code bug.

**Proposed test:** N/A (documentation-only; verify after merge)

## Sustainability

### `DEFAULT_MAX_EMBED_DEPTH` duplicated as magic number in resolveConfig

**File:** `src/index.mjs` (line 112) and
`src/rest/query-parser.mjs` (line 50)

The default of `5` appears in two places: as the
`DEFAULT_MAX_EMBED_DEPTH` constant in `query-parser.mjs`
and as the literal `5` in `resolveConfig`. If the default
changes, both must be updated. The design doc acknowledges
this ("the magic number 5 appears in exactly one place")
but the implementation does not follow through —
`resolveConfig` uses its own literal `5` rather than
importing the constant.

This is low-risk since `resolveConfig` is the canonical
source and `query-parser.mjs` defaults are only fallbacks
for direct callers. No test proposed — this is a
maintenance observation, not a behavioral concern.

## Idiomatic Usage

No non-idiomatic patterns found. The implementation follows
established conventions in the codebase:

- Nullish coalescing (`??`) for config precedence matches
  the `errorsVerbose` pattern.
- `parseInt(envVar, 10)` matches `PG_PORT` and
  `schemaCacheTtl`.
- Default parameters in exported functions match the
  `parseLogicalGroup` depth pattern.
- The `parenDepth` rename correctly disambiguates the local
  parenthesis-tracking variable from the new recursion
  `depth` parameter.

## Test Quality

### Missing: non-numeric env var handling

The config tests verify valid numeric values and precedence
but do not cover invalid input from the environment
variable. Since `parseInt` returns `NaN` for non-numeric
strings and `NaN` silently bypasses the depth check, this
is the highest-priority missing test.

**Proposed test:**

> Given `PGREST_MAX_EMBED_DEPTH` is set to `'not-a-number'`
> When `createPgrest` is called with no `maxEmbedDepth` in config
> Then `_ctx.maxEmbedDepth` is `5` (default) or an error is thrown

**Test location:** `src/__tests__/index.test.mjs`
**Function:** `test_non_numeric_env_var_maxEmbedDepth`

### Missing: maxEmbedDepth=0 boundary test

The tests cover `maxEmbedDepth=1` as the minimum but not
`maxEmbedDepth=0`. Since `0` is a valid integer that passes
the truthiness check in `resolveConfig` and is preserved by
`??`, its behavior should be explicitly tested even if only
to document the intended semantics.

**Proposed test:**

> Given `parseSelectList('id,customers(name)', 0)`
> When the parser encounters the embed
> Then it throws PGRST100 with message
> `'Embedding depth exceeds maximum of 0'`

**Test location:** `src/rest/__tests__/query-parser.test.mjs`
**Function:** `test_maxEmbedDepth_zero_rejects_depth_1`

### Missing: exact-boundary test at maxEmbedDepth

The existing tests check depth 5 (pass) and depth 6 (fail)
with default limit 5, and depth 3/4 with limit 3. But
there is no explicit test confirming that depth exactly
equal to `maxEmbedDepth` passes while `maxEmbedDepth + 1`
fails for an arbitrary non-default limit. The existing
tests do cover this implicitly (depth 3 with limit 3
passes), but a dedicated boundary test with a less common
limit value (e.g., limit 2) would strengthen confidence.

This is a minor gap. The existing tests are adequate but
could be more explicit about the boundary condition.

**Proposed test:**

> Given `parseSelectList('a(b(id))', 2)`
> When the parser processes depth-2 nesting
> Then it succeeds (depth equals limit)

> Given `parseSelectList('a(b(c(id)))', 2)`
> When the parser processes depth-3 nesting
> Then it throws PGRST100 with message
> `'Embedding depth exceeds maximum of 2'`

**Test location:** `src/rest/__tests__/query-parser.test.mjs`
**Function:** `test_exact_boundary_maxEmbedDepth_2`

### Missing: handler integration test for depth rejection

All depth-enforcement tests call `parseSelectList` or
`parseQuery` directly. There is no test confirming that
the handler correctly threads `ctx.maxEmbedDepth` to
`parseQuery` and returns a 400 response to the client.
The handler wiring is straightforward (three call sites,
all identical), but an integration-level test would catch
a regression if a new `parseQuery` call site is added
without the fourth argument.

**Proposed test:**

> Given a pgrest instance with `maxEmbedDepth: 2`
> When a GET request includes `select=a(b(c(id)))`
> Then the response is HTTP 400 with code PGRST100

**Test location:** integration test file (e.g.,
`test/integration/embedding.test.mjs` or a new
`test/integration/embed-depth.test.mjs`)
**Function:** `test_handler_rejects_deep_embed`

## Test Harness Gaps

### No harness support for custom maxEmbedDepth in integration tests

**Needed by:** `test_handler_rejects_deep_embed`
**Description:** The integration test harness creates a
pgrest instance via `createPgrest`. To test handler-level
depth rejection, the harness needs to create an instance
with a non-default `maxEmbedDepth` (e.g., 2) and issue a
request with deeper nesting. This requires either a
dedicated test fixture or the ability to pass
`maxEmbedDepth` to the existing integration test setup
helper. Check whether the current integration setup already
accepts arbitrary config overrides — if so, no new harness
code is needed.

## Documentation

### configuration.md row placement

**File:** `docs/reference/configuration.md`

The `maxEmbedDepth` row is placed after `production` in the
Core table. This is fine positionally, but the `required`
column uses lowercase `no` while existing rows use `no` or
`yes` — consistent. No issue.

### V-13 finding analysis section is stale

**File:** `docs/security/findings/V-13-embed-depth.md`
(lines 16-20)

The "Our analysis" section says "fixed at HEAD" but still
describes the vulnerability in present tense
("`parseSelectList(input)` recurses ... with no depth
argument. Unbounded."). The description should be updated
to past tense or annotated to clarify this was the
pre-fix state, since the status is now Fixed.

### No `.kiro/skills/` or `.kiro/steering/` updates needed

The diff does not introduce new patterns or conventions
that would require skill or steering file updates. The
cedar-policy-author skill is unaffected. No AGENTS.md
changes needed.
