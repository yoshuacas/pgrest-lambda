Fix V-13: Unbounded resource embedding depth. parseSelectList in src/rest/query-parser.mjs recurses into embeds (e.g. select=*,a(b(c(d(...))))) with no depth limit. Logical operator nesting is capped at MAX_NESTING_DEPTH=10 but embed nesting is wide open. Deep embeds become correlated subqueries with exponential planner cost — this is a DoS vector.

The fix: add a depth parameter to parseSelectList, increment on each embed recursion (line 133 where it calls parseSelectList(innerContent)), and throw PGRST100 when depth exceeds maxEmbedDepth. Default maxEmbedDepth=5, configurable via createPgrest config (config.maxEmbedDepth). Wire through resolveConfig in src/index.mjs and pass to the rest handler context.

Key files:
- src/rest/query-parser.mjs — parseSelectList function (lines 51-176), the recursive call is at line 133
- src/index.mjs — resolveConfig and createPgrest factory, add maxEmbedDepth to resolved config and ctx
- src/rest/handler.mjs — createRestHandler, pass maxEmbedDepth to parseQuery calls
- docs/security/findings/V-13-embed-depth.md — update evidence doc
- docs/security/assessment.md — mark V-13 Fixed
- docs/reference/configuration.md — document the new config key and env var

Tests needed:
- Embed at depth 1-5 passes (normal usage)
- Embed at depth 6 throws PGRST100 with clear message
- Config override (maxEmbedDepth=3) is respected
- Existing embed tests still pass

Follow the project conventions in AGENTS.md: cargo fmt, clippy, build, test before commit. This is a Node.js ESM project though, so the relevant commands are npm test.