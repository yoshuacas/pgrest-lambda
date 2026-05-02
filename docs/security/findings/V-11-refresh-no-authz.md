# V-11 — Schema refresh endpoint has no authorization check

- **Severity (reported):** Medium
- **Status:** Fixed
- **Affected (reported):** `src/rest/handler.mjs:151-159`
- **Backend dependence:** None

## Report summary

`POST /rest/v1/_refresh` triggers schema re-introspection and Cedar policy reload without role check. Any caller (including anon) can force it. Abuse vectors: DoS via introspection storm; timed attack to catch a briefly-modified S3 Cedar policy.

## Our analysis

**Status: Fixed at HEAD** (commit `620442a`, merged via `819c46a`).

`src/rest/handler.mjs:237-249` now gates the refresh on `service_role`:

```js
if (routeInfo.type === 'refresh') {
  if (method !== 'POST') {
    throw new PostgRESTError(405, 'PGRST000', 'Method not allowed on _refresh');
  }
  if (role !== 'service_role') {
    throw new PostgRESTError(401, 'PGRST301', 'Refresh requires service_role');
  }
  const newSchema = await schemaCache.refresh(pool);
  await cedar.refreshPolicies();
  // ...
}
```

`role` is populated by the Lambda authorizer from the presented apikey, so `anon` and `authenticated` callers are rejected before any refresh work runs. Method check (405 on GET) is preserved.

## Decision

Fixed. One-line guard matches the originally proposed fix surface; the chosen status code is 401 / `PGRST301` rather than 403, consistent with other apikey-based rejections in the codebase.

## Evidence

- **Fix commit:** `620442a` — *sec(H-6): gate POST /rest/v1/_refresh on service_role*
- **Merge commit:** `819c46a` — *Merge sec/H-6-refresh-endpoint-auth*
- **Code:** `src/rest/handler.mjs:241-243`
- **Tests:** `src/rest/__tests__/handler.integration.test.mjs:1009-1046` — four cases covering `anon` (rejected), `authenticated` (rejected), `service_role` (200), and `GET` (405 even for service_role)

## Residual risk

None. `service_role` is the narrowest caller set in the role model; any compromise of a service_role key is a broader incident than this endpoint.

## Reviewer handoff

`/_refresh` is gated on `role === 'service_role'` at `src/rest/handler.mjs:241-243`; integration tests at `handler.integration.test.mjs:1009-1046` cover all three roles plus method restriction. Closed by commit `620442a`.
