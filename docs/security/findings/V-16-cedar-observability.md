# V-16 — Cedar fail-closed but no observability

- **Severity (reported):** Low
- **Status:** Open
- **Affected (reported):** `src/rest/cedar.mjs:349-395`
- **Backend dependence:** None

## Report summary

Cedar denies on missing/failed policies (good) but emits no logs. Cannot debug authz issues or detect attacks in prod.

## Our analysis

**Status: still open at HEAD.**

- `src/rest/cedar.mjs:349-395` — `authorize()` throws on deny with no log.
- `src/rest/cedar.mjs:397+` — `buildAuthzFilter()` same.
- `src/rest/cedar.mjs:256-259, 281-286, 288-291` — `translateExpr` untranslatable branch throws generic PGRST000 "untranslatable condition" — useful to track rate of these.

No `console.log`, no structured logger, nothing. Pairs with V-23 which is the umbrella logging item.

**Fix surface:** introduce a single `log(event, meta)` entrypoint in `src/shared/logger.mjs` that writes JSON to stdout, configurable level. Cedar calls it on decision (allow/deny/untranslatable). This is part of the V-23 rollout but V-16 is the authz slice specifically.

## Decision

_Pending triage._

## Evidence

_Commit / test / doc link when fixed._

## Residual risk

Log volume for high-QPS reads. Mitigate with sampling or log-level control.

## Reviewer handoff

_Two-sentence summary for the reviewer agent._
