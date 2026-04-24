# V-20 — XSS vector in `docsHtml` via Host header

- **Severity (reported):** Info
- **Status:** Open
- **Affected (reported):** `src/rest/handler.mjs:47-59, 91-94`
- **Backend dependence:** None

## Report summary

`docsHtml()` template-literal-injects `specUrl` (derived from `Host` header) as `data-url="${specUrl}"`. API Gateway normalizes Host, but dev/proxy scenarios could let attacker-controlled Host land in the HTML.

## Our analysis

**Status: still open at HEAD.**

- `src/rest/handler.mjs:46-59` — `docsHtml(specUrl)` template-literal-injects `specUrl` into `data-url="${specUrl}"` with no escaping.
- `src/rest/handler.mjs:91-94` — `resolveApiUrl(ctx, headers)` pulls from `headers['host'] || 'localhost'` when `apiBaseUrl` is not configured. Host header is attacker-controllable pre-API-Gateway (e.g., local dev, some proxies).
- `ctx.apiBaseUrl` preempts Host (`handler.mjs:92`). Setting `config.apiBaseUrl` in prod mitigates.

**Fix surface:** HTML-attribute-escape `specUrl` (replace `&`, `<`, `>`, `"`, `'`). Also validate that host, if used, matches a simple hostname regex — any `<` or `"` rejected.

## Decision

_Pending triage._

## Evidence

_Commit / test / doc link when fixed._

## Residual risk

None.

## Reviewer handoff

_Two-sentence summary for the reviewer agent._
