# V-18 — JSON body parse failure silently sets `body=null`

- **Severity (reported):** Low
- **Status:** Open
- **Affected (reported):** `src/rest/handler.mjs:114-119`
- **Backend dependence:** None

## Report summary

`JSON.parse` failure swallowed; downstream sees `body=null` and emits a generic "missing/invalid body" error. Clients cannot distinguish "no body" from "malformed body."

## Our analysis

**Status: still open at HEAD.**

`src/rest/handler.mjs:113-120`:
```js
let body = null;
if (event.body) {
  try {
    body = JSON.parse(event.body);
  } catch {
    body = null;
  }
}
```

Also affects auth: `src/auth/handler.mjs:86, 133, 158` — `JSON.parse(event.body || '{}')` with no try/catch. A malformed body throws up the stack; the outer handler has no catch (unlike the REST handler). This is arguably worse than the silent nulling: auth endpoints 500 on malformed JSON with no structured error.

**Fix surface:** replace both sites with a shared `parseJsonBody(event)` helper returning a 400 `PGRST102` (REST) / `validation_failed` (auth) on parse failure.

## Decision

_Pending triage._ Trivial: return a 400 with PostgREST code `PGRST102` ("Invalid request body").

## Evidence

_Commit / test / doc link when fixed._

## Residual risk

None.

## Reviewer handoff

_Two-sentence summary for the reviewer agent._
