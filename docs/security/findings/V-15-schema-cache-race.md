# V-15 — Schema cache TOCTOU race

- **Severity (reported):** Low
- **Status:** Open
- **Affected (reported):** `src/rest/schema-cache.mjs:175-183`
- **Backend dependence:** None

## Report summary

Concurrent requests expiring TTL at once each trigger introspection. Lambda's single-concurrency model usually hides this; high-concurrency deployments waste DB cycles.

## Our analysis

**Status: still open at HEAD. TTL drop amplifies cost.**

- `src/rest/schema-cache.mjs:164-192` — `getSchema(pool)` checks `cache && (now - lastRefreshAt) < ttl`; on miss, awaits `introspect(pool)` and assigns. Two concurrent callers arriving post-TTL both see `cache && (...) < ttl` false and both kick off introspection.
- `src/rest/schema-cache.mjs:165` — default TTL is **30s** (was 5min before commit a1a587f). At Lambda concurrency > 1, the race fires every 30s per container cohort.
- Introspection cost: 2 parallel queries (`COLUMNS_SQL`, `PK_SQL`) + 1 optional (`FK_SQL`); not catastrophic but wasteful.

**Fix surface:** single-flight pattern — stash the in-flight promise on the module instance, subsequent callers `return await inflight`. ~10 lines.

## Decision

_Pending triage._ Likely: in-flight promise memoization so concurrent callers await the same refresh.

## Evidence

_Commit / test / doc link when fixed._

## Residual risk

Refresh still runs serially per-process; acceptable.

## Reviewer handoff

_Two-sentence summary for the reviewer agent._
