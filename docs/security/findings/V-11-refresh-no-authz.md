# V-11 — Schema refresh endpoint has no authorization check

- **Severity (reported):** Medium
- **Status:** Open
- **Affected (reported):** `src/rest/handler.mjs:151-159`
- **Backend dependence:** None

## Report summary

`POST /rest/v1/_refresh` triggers schema re-introspection and Cedar policy reload without role check. Any caller (including anon) can force it. Abuse vectors: DoS via introspection storm; timed attack to catch a briefly-modified S3 Cedar policy.

## Our analysis

**Status: still open at HEAD.**

`src/rest/handler.mjs:151-160`:
```js
if (routeInfo.type === 'refresh') {
  if (method !== 'POST') { /* 405 */ }
  const newSchema = await schemaCache.refresh(pool);
  await cedar.refreshPolicies();
  // ... return spec
}
```

No role check. The caller must pass the authorizer (valid apikey), but any apikey role — including `anon` — works.

**Fix surface:** one-line guard `if (role !== 'service_role') throw new PostgRESTError(403, 'PGRST403', ...)`. `role` is already bound on handler.mjs:109.

## Decision

_Pending triage._ Trivial fix: require `role === 'service_role'` for `_refresh`.

## Evidence

_Commit / test / doc link when fixed._

## Residual risk

None expected once gated.

## Reviewer handoff

_Two-sentence summary for the reviewer agent._
