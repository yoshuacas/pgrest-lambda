# V-19 — No request size / bulk row limits

- **Severity (reported):** Low
- **Status:** Open
- **Affected (reported):** `src/rest/handler.mjs` (system-wide)
- **Backend dependence:** None (limits differ but posture should be universal)

## Report summary

API Gateway caps payload at 10 MB. At that size, bulk inserts generate proportionally large SQL and parameter arrays, consuming Lambda memory.

## Our analysis

**Status: still open at HEAD.**

- `src/rest/sql-builder.mjs:411-440` — `buildInsert` iterates `rows` and generates one tuple per row. No cap. At API Gateway's 10 MB payload limit, this is thousands of rows and a SQL string / values array proportional to the payload.
- `src/rest/db/postgres.mjs:18-35`, `src/rest/db/dsql.mjs:36-45` — neither adapter sets `statement_timeout` on the pool. A slow query holds a connection until Lambda times out (default 3s, configurable).
- Pool sizing: `max: 5` on both adapters — modest; ties into V-19 DoS characterization.

**Three distinct limits to add:**
1. `maxBulkRows` (default 1000) checked at `buildInsert` entry.
2. `statement_timeout` set on pool connect (both adapters; pg `options: '-c statement_timeout=NNN'` or per-query).
3. Embedding depth — tracked separately in V-13.

## Decision

_Pending triage._

## Evidence

_Commit / test / doc link when fixed._

## Residual risk

Single large row (e.g., big JSONB column) can still consume memory. Documented as consumer responsibility.

## Reviewer handoff

_Two-sentence summary for the reviewer agent._
