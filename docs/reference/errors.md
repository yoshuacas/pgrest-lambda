---
title: Error codes
description: Complete reference for every error code returned by pgrest-lambda — REST, auth, PostgreSQL, and Cedar authorization errors with HTTP status codes, shapes, and handling guidance.
---

# Error codes

pgrest-lambda returns structured JSON errors with predictable shapes. This page documents every error code, when it fires, and how to handle it in client code.

## Error response shapes

The REST and auth surfaces use **different JSON envelopes**.

### REST errors (`/rest/v1/*`)

```json
{
  "code": "PGRST100",
  "message": "\"eq\" is not a valid filter operator",
  "details": null,
  "hint": null
}
```

| Field     | Type              | Always present | Description                                    |
|-----------|-------------------|----------------|------------------------------------------------|
| `code`    | `string`          | ✓              | Error code — `PGRSTnnn` or a PG 5-char code.  |
| `message` | `string`          | ✓              | Human-readable explanation.                    |
| `details` | `string \| null`  | ✓              | Extra detail (e.g. constraint name, columns).  |
| `hint`    | `string \| null`  | ✓              | Suggested fix when available.                  |

The HTTP status code is on the response itself, not in the body.

### Auth errors (`/auth/v1/*`)

```json
{
  "error": "validation_failed",
  "error_description": "Email is required"
}
```

| Field               | Type     | Always present | Description                                |
|---------------------|----------|----------------|--------------------------------------------|
| `error`             | `string` | ✓              | Machine-readable error code.               |
| `error_description` | `string` | ✓              | Human-readable explanation.                |

Some auth errors include extra fields — e.g. `weak_password` adds a `weak_password.reasons` array.

---

## REST error codes (PGRST)

### PGRST000 — Internal / catch-all

Returned when no more specific code applies.

| HTTP | Message | When |
|------|---------|------|
| 405 | `Method {method} not allowed` | Unsupported HTTP method on a table endpoint. |
| 405 | `Method not allowed on _refresh` | Non-POST request to `/_refresh`. |
| 500 | `Internal server error (errorId: {id})` | Unhandled exception. The `errorId` correlates with the server-side log entry. The raw error is **never** exposed to the client. |

**Client handling:** for 405, check your HTTP method. For 500, report the `errorId` to the operator — the server log has the full stack trace.

---

### PGRST006 — Request body too large

| HTTP | Message |
|------|---------|
| 413 | `Request body exceeds maximum size of {limit} bytes` |

The limit is **1 MB** (1048576 bytes), from `MAX_BODY_BYTES` in `src/shared/body-size.mjs`. This fires before any parsing occurs.

---

### PGRST100 — Parse / validation error

The most common client-facing code. Returned for any malformed query-string parameter, filter, select expression, or request body.

| HTTP | Message pattern | Cause |
|------|----------------|-------|
| 400 | `"failed to parse {what} ({raw})" (line 1, column {n})` | The scanner could not parse a `select`, `columns`, `order`, filter or logic-tree value. `details` names what it found and what it expected, as upstream prints it: `unexpected "x" expecting …`. |
| 400 | `Empty column name before '::'` | Cast syntax `::type` without a column name. |
| 400 | `Empty cast type after '::'` | Column `col::` without a type. |
| 400 | `Unsupported cast type '{type}'` | Cast to a type not in the allowlist. |
| 400 | `Unbalanced parentheses in select parameter` | Mismatched `(` / `)` in `?select=`. |
| 400 | `'{alias}' is not a valid identifier for an alias` | Alias contains invalid characters. |
| 400 | `Empty column name after alias '{alias}'` | Alias present but column name missing. |
| 400 | `Duplicate select key '{key}'` | Same column or embed alias selected twice. |
| 400 | `Embedding depth exceeds maximum of {n}` | More nested embeds than `max-embed-depth` allows. |
| 400 | `Unknown operator '{operator}'` | Operator not in the allowlist (eq, gte, gt, lte, lt, like, ilike, match, imatch, neq, cs, cd, ov, sl, sr, nxr, nxl, adj, in, is, isdistinct, fts, plfts, phfts, wfts — each optionally prefixed `not.`). |
| 400 | `IS operator only supports null, not_null, true, false, unknown (got '{value}')` | `?col=is.maybe`. |
| 400 | `Unknown aggregate function '{name}'` | `?select=x.median()` — not one of count, sum, avg, min, max. |
| 400 | `Logical operator nesting exceeds maximum depth of {n}` | Too many nested `and(or(and(...)))` levels. |
| 400 | `Cannot filter on the embedded resource '{embed}' here` | A filter names an embed where only a column belongs. |
| 400 | `'{name}' is not a valid function name` | RPC name contains characters outside `[a-z0-9_]`. |
| 400 | `'{raw}' is not a valid percent-encoded path segment` | Malformed `%` escape in the path. |

**Client handling:** inspect the `message` and `details` — together they identify the exact field or parameter and the position in it. Fix the query string or request body and retry.

Filters that name an embed missing from `?select=` are **PGRST108**, not PGRST100, and nested embed filters are not limited in depth: `?children.gChildren.id=eq.1` walks the whole dotted path down the read plan, as upstream does.

---

### PGRST102 — Request body could not be read

| HTTP | Message | Cause |
|------|---------|-------|
| 400 | `Empty or invalid json` | POST/PATCH/PUT with an empty or unparseable JSON body. |
| 400 | `All object keys must match` | An array body whose objects do not share one key set. |
| 400 | `All lines must have same number of fields` | Ragged `text/csv` body. |
| 400 | `Content-Type not acceptable: {type}` | A body `Content-Type` the engine does not parse. |

---

### PGRST101 — Method not allowed for RPC

| HTTP | Message |
|------|---------|
| 405 | `Cannot use the {method} method on RPC` |

Only GET, POST and HEAD reach a function.

---

### PGRST103 — Range not satisfiable

| HTTP | Message | Details |
|------|---------|---------|
| 416 | `Requested range not satisfiable` | `An offset of {lower} was requested, but there are only {total} rows.` |

`Range` or `?offset=` asks to start past the end of the result. Sent only when the request also asks for a count, since the total has to be known to say so.

---

### PGRST105 — PUT filter mismatch

| HTTP | Message |
|------|---------|
| 405 | `Filters must include all and only primary key columns with 'eq' operators` |

A `PUT` addresses exactly one row, so its filters must name every primary key column with `eq` and nothing else.

---

### PGRST106 — Bulk change protection, and unknown schema

| HTTP | Message | When |
|------|---------|------|
| 400 | `UPDATE requires filters to prevent bulk change` | An UPDATE with **no `?` filters**, and the request is not an RPC. |
| 400 | `DELETE requires filters to prevent bulk change` | The same, for DELETE. |
| 406 | `Invalid schema: {profile}` | `Accept-Profile` / `Content-Profile` names a schema that `db-schemas` does not expose. |

For the first two, add at least one filter parameter to proceed. For the third, see [`db-schemas`](configuration.md).

---

### PGRST107 — No acceptable media type

| HTTP | Message |
|------|---------|
| 406 | `None of these media types are available: {accept}` |

The `Accept` header lists nothing the engine produces for this request. It recognises `application/json`, `application/vnd.pgrst.array+json`, `application/vnd.pgrst.object+json`, `application/openapi+json`, `application/x-www-form-urlencoded`, `text/csv`, `text/plain`, `text/xml` and `application/geo+json` — geo+json is recognised but not producible, since that needs PostGIS.

---

### PGRST108 — Filter or order on a resource that is not embedded

| HTTP | Message | Hint |
|------|---------|------|
| 400 | `'{resource}' is not an embedded resource in this request` | `Verify that '{resource}' is included in the 'select' query parameter.` |
| 400 | `'{resource}' is not an embedded resource in this request`, `details`: `Target names are not allowed in filters if they have an alias` | `Change '{resource}' to '{alias}' in filters, orders or limits.` |

`?orders.amount=gt.100` or `?order=orders(amount)` when `orders` is not in `?select=`, or is there under an alias — filter and order by the alias in that case.

---

### PGRST114 — limit/offset on PUT

| HTTP | Message |
|------|---------|
| 400 | `limit/offset querystring parameters are not allowed for PUT` |

---

### PGRST115 — PUT payload disagrees with the URL

| HTTP | Message |
|------|---------|
| 400 | `Payload values do not match URL in primary key column(s)` |

---

### PGRST116 — Singular response mismatch

Returned when the client requests a singular JSON object via `Accept: application/vnd.pgrst.object+json` but the row count doesn't match.

| HTTP | Message | Details | When |
|------|---------|---------|------|
| 406 | `Cannot coerce the result to a single JSON object` | `The result contains 0 rows` | No rows match. |
| 406 | `Cannot coerce the result to a single JSON object` | `The result contains {n} rows` | More than one row matches. |

**Client handling:** relax the `Accept` header to `application/json` to receive an array, or tighten your filters.

---

### PGRST118 — Related order is not possible

| HTTP | Message | Details |
|------|---------|---------|
| 400 | `A related order on '{embed}' is not possible` | `'{table}' and '{embed}' do not form a many-to-one or one-to-one relationship` |

`?order=embed(column)` sorts the parent by a single related row, so the relationship has to produce one.

---

### PGRST122 — Invalid preference under handling=strict

| HTTP | Message | Details |
|------|---------|---------|
| 400 | `Invalid preferences given with handling=strict` | `Invalid preferences: {list}` |

With `Prefer: handling=strict`, any preference the engine does not recognise is an error instead of being ignored.

---

### PGRST123 — Aggregates disabled

| HTTP | Message |
|------|---------|
| 400 | `Use of aggregate functions is not allowed` |

`?select=amount.sum()` while `db-aggregates-enabled` is off. This engine defaults
it to `true`, unlike upstream, so the error only appears once you set
`PGREST_DB_AGGREGATES_ENABLED=false` (`src/index.mjs`).

An aggregate inside a one-to-many or many-to-many spread (`...orders(amount.sum())`)
is a different error — `PGRST127`, which upstream also refuses.

---

### PGRST124 — max-affected exceeded

| HTTP | Message | Details |
|------|---------|---------|
| 400 | `Query result exceeds max-affected preference constraint` | `The query affects {n} rows` |

`Prefer: max-affected={n}` with `handling=strict`, and the mutation touched more rows than that. The transaction is rolled back.

---

### PGRST125 — Invalid path

| HTTP | Message |
|------|---------|
| 404 | `Invalid path specified in request URL` |

---

### PGRST126 — Root endpoint disabled

| HTTP | Message |
|------|---------|
| 404 | `Root endpoint metadata is disabled` |

`GET /` with `db-root-spec` set to serve nothing.

---

### PGRST127 — Feature not implemented

| HTTP | Message | Details |
|------|---------|---------|
| 400 | `Feature not implemented` | `Aggregates are not implemented for one-to-many or many-to-many spreads.` |

---

### PGRST128 — max-affected needs a set-returning function

| HTTP | Message |
|------|---------|
| 400 | `Function must return SETOF or TABLE when max-affected preference is used with handling=strict` |

---

### PGRST200 — Relationship not found

| HTTP | Message |
|------|---------|
| 400 | `Could not find a relationship between '{parent}' and '{embed}' in the schema cache` |

The embedded resource you requested (e.g. `?select=*,comments(*)`) has no discoverable foreign-key path.

**Client handling:** verify the foreign key exists, the schema cache is fresh (`POST /_refresh`), and spelling is correct.

---

### PGRST201 — Ambiguous relationship

| HTTP | Message |
|------|---------|
| 300 | `Could not embed because more than one relationship was found for '{parent}' and '{embed}'` |

Multiple foreign keys connect the two tables. The response includes:

- **`details`** — array of candidate relationships with cardinality info.
- **`hint`** — disambiguation syntax (e.g. `embed!fk_column(*)`).

**Client handling:** use the hint syntax to specify which foreign key to follow.

---

### PGRST202 — Function not found

| HTTP | Message |
|------|---------|
| 404 | `Could not find the function '{name}' in the schema cache` |

**Client handling:** check the function name, ensure it's in the exposed schema, and refresh the cache.

---

### PGRST203 — Overloaded function ambiguity

| HTTP | Message |
|------|---------|
| 300 | `Could not choose the best candidate function between: {name}` |

Multiple function overloads match the supplied arguments.

**Client handling:** pass explicit argument names/types to disambiguate, or rename one of the overloads.

---

### PGRST204 — Column / identifier not found

| HTTP | Message pattern |
|------|----------------|
| 400 | `'{name}' is not a valid identifier` |
| 400 | `Could not find the '{column}' column of '{table}' in the schema cache` |
| 400 | `Column '{col}' does not exist in function result` |
| 400 | `'{col}' is not a valid column name` |

---

### PGRST205 — Relation not found

| HTTP | Message | Hint |
|------|---------|------|
| 404 | `Could not find the table '{schema}.{table}' in the schema cache` | `Perhaps you meant the table '{schema}.{closest}'`, when a near-match exists. |
| 404 | `Docs are disabled` | Returned when requesting `/` with OpenAPI disabled. |

---

### PGRST207 — Unknown function argument

| HTTP | Message |
|------|---------|
| 400 | `Function '{name}' does not have an argument named '{key}'` |

---

### PGRST208 — Type coercion failure

| HTTP | Message |
|------|---------|
| 400 | `Argument '{name}' of function '{fn}' expects type '{type}' but received a value that could not be coerced` |

The RPC argument value cannot be cast to the declared PostgreSQL type.

---

### PGRST209 — Missing required function argument

| HTTP | Message |
|------|---------|
| 400 | `Function '{name}' requires argument '{arg}' which was not provided` |

The function has a parameter with no default and the request supplied no value for it.

---

### PGRST300 — Server misconfigured

| HTTP | Message |
|------|---------|
| 500 | `Server lacks JWT secret` |

A request carried a JWT but no `jwt-secret` is configured, so nothing can verify it. An operator problem, not a client one.

---

### PGRST301 — Authentication required, or JWT rejected

| HTTP | Message | When |
|------|---------|------|
| 401 | `Refresh requires service_role` | `/_refresh` without a `role=service_role` JWT. |
| 401 | `Empty JWT is sent in Authorization header` | `Authorization: Bearer ` with nothing after it. |
| 401 | `Expected 3 parts in JWT; got {n}` | The token is not a three-part JWS. |
| 401 | `No suitable key or wrong key type` | Structurally a JWS, signed by a key this deployment does not hold. `details`: `None of the keys was able to decode the JWT`. |
| 401 | `Wrong or unsupported encoding algorithm` | `alg` is not one this deployment accepts. |
| 401 | `JWT cryptographic operation failed` | Three parts that are not a JWS at all. |

Every one of these carries `WWW-Authenticate: Bearer error="invalid_token", error_description="{message}"`. The messages are upstream PostgREST's decode vocabulary, kept string-for-string because its auth specs assert them.

These only appear when the engine verifies JWTs itself (`jwt-secret` configured). The usual deployment verifies in the API Gateway authorizer, which answers before the engine sees the request.

---

### PGRST302 — Anonymous access disabled

| HTTP | Message |
|------|---------|
| 401 | `Anonymous access is disabled` |

No `Authorization` header, and the deployment does not serve the `anon` role.

---

### PGRST303 — Claims could not be parsed

| HTTP | Message |
|------|---------|
| 401 | `Parsing claims failed` |

The JWT verified but its payload is not a JSON object of claims.

---

### PGRST403 — Cedar authorization denied

| HTTP | When | Message |
|------|------|---------|
| 401 + `WWW-Authenticate: Bearer` | the caller is anonymous (`role=anon`) | `Permission denied` |
| 403 | the caller is authenticated | `Permission denied` |

Cedar evaluated the request and either found no matching `permit` policy or found a `forbid` that overrides. The `details` field carries the evaluated principal, action, and resource for debugging.

The status depends on the caller, not on the policy: an anonymous caller might succeed if it authenticated, so it gets `401` and a challenge; an authenticated one will not, so it gets `403`. This is the same split a PostgreSQL privilege error (SQLSTATE `42501`) gets in `src/rest/errors.mjs`, and the same one PostgREST uses, which matters because `@supabase/supabase-js` treats `401` as "refresh the token and retry".

**Client handling:** on `401`, sign in or refresh the token and retry once. On `403`, check your Cedar policies and the JWT's `role` / `sub` claims — retrying will not help.

---

### PGRST501 — Unsupported feature

| HTTP | Message | Hint |
|------|---------|------|
| 501 | `RPC is not supported on this database` | `Deploy on a database that supports CREATE FUNCTION` |

Returned when the database provider reports `supportsRpc: false`. Neither shipped provider does — Aurora DSQL runs RPC for `LANGUAGE sql` functions and reports `true`.

---

## PostgreSQL errors

When a query reaches the database and PostgreSQL returns an error, pgrest-lambda maps the PG error code to an HTTP status. The PG-native `message`, `detail`, and `hint` fields are forwarded.

| PG code | HTTP | Meaning |
|---------|------|---------|
| `23505` | 409 | **Unique violation** — a row with that key already exists. |
| `23503` | 409 | **Foreign key violation** — the referenced row doesn't exist (or is still referenced). |
| `23502` | 400 | **NOT NULL violation** — a required column was omitted. |
| `42P01` | 404 | **Undefined table** — the table doesn't exist in the current schema. |
| `42703` | 400 | **Undefined column** — the column name is wrong. |
| *(other)* | 500 | Unmapped PG error — the raw code is still in the `code` field. |

**Client handling for constraint errors (23xxx):** the `details` field usually names the constraint and conflicting values. Use these to build user-facing validation messages:

```javascript
const res = await fetch('/rest/v1/users', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', apikey: KEY },
  body: JSON.stringify({ email: 'dupe@example.com' }),
});

if (!res.ok) {
  const err = await res.json();
  if (err.code === '23505') {
    // err.details → 'Key (email)=(dupe@example.com) already exists.'
    showValidationError('That email is already taken.');
  }
}
```

> **Note:** PostgreSQL error messages may reveal table names, column names, constraint names, and submitted values. In a future release, production mode will sanitize these details. If this is a concern today, use an error-handling middleware in front of pgrest-lambda.

---

## Auth error codes

Auth endpoints return the `{ error, error_description }` shape. Group by the `error` field:

### validation_failed

| HTTP | Description | When |
|------|-------------|------|
| 400 | `Email is required` | Signup/login/magic-link/OTP without email. |
| 400 | `Password is required` | Signup/login without password. |
| 400 | `Invalid email format` | Email fails format check. |
| 400 | `Refresh token is required` | Token refresh without the token. |
| 400 | `Token is required` | OTP verify without a token. |
| 400 | `Provider is required` | OAuth authorize without provider. |
| 400 | `Unsupported OAuth provider: {provider}` | Provider not configured. |
| 400 | `redirect_to is required` | OAuth/magic-link without redirect URL. |
| 400 | `SES sender address is not configured` | Magic-link/OTP but no SES sender set up. |
| 400 | `Invalid JSON in request body` | Unparseable request body. |

### unsupported_grant_type

| HTTP | Description |
|------|-------------|
| 400 | `Missing or unsupported grant_type` |

The `/auth/v1/token` endpoint requires `grant_type=password` or `grant_type=refresh_token`.

### user_already_exists

| HTTP | Description |
|------|-------------|
| 400 | `User already registered` |

### invalid_grant

| HTTP | Description | When |
|------|-------------|------|
| 400 | `Invalid login credentials` | Wrong email/password. |
| 401 | `Invalid refresh token` | Expired or revoked refresh token. |
| 400 | `Invalid or expired OTP token` | OTP verification failed. |

### weak_password

| HTTP | Description | Extra fields |
|------|-------------|--------------|
| 422 | `Password must be at least 8 characters and include uppercase, lowercase, and numbers` | `weak_password.reasons` — array of strings. |

Example response:
```json
{
  "error": "weak_password",
  "error_description": "Password must be at least 8 characters and include uppercase, lowercase, and a number",
  "weak_password": {
    "reasons": ["length", "uppercase", "number"]
  }
}
```

### user_not_found

| HTTP | Description |
|------|-------------|
| 404 | `User not found` |

### not_authenticated

| HTTP | Description | When |
|------|-------------|------|
| 401 | `Missing authorization header` | No `Bearer` token on a protected endpoint. |
| 401 | `Invalid or expired token` | JWT signature check or expiry failed. |

### not_found

| HTTP | Description |
|------|-------------|
| 404 | `Endpoint not found` |

Unknown path under `/auth/v1/`.

### payload_too_large

| HTTP | Description |
|------|-------------|
| 413 | `Request body exceeds maximum size of {limit} bytes` |

### unexpected_failure

| HTTP | Description |
|------|-------------|
| 500 | `An unexpected error occurred` |

Catch-all for unhandled auth-provider errors. Server logs contain the full error. In production mode, stack traces are suppressed from the log.

---

## Error handling patterns

### Unified error handler (JavaScript)

```javascript
async function pgrestFetch(path, options = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      apikey: API_KEY,
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (res.ok) return res.json();

  const err = await res.json();

  // REST errors have 'code', auth errors have 'error'
  const code = err.code || err.error;

  switch (code) {
    case '23505':
      throw new ConflictError(err.details);
    case 'PGRST116':
      throw new NotFoundError('Row not found');
    case 'PGRST200':
      throw new BadRequestError(`Missing relationship: ${err.message}`);
    case 'PGRST403':
      // 401 means the caller was anonymous: authenticating may grant it.
      if (res.status === 401) throw new AuthError('Sign in and retry');
      throw new ForbiddenError('Permission denied by policy');
    case 'invalid_grant':
      throw new AuthError(err.error_description);
    default:
      throw new ApiError(res.status, code, err.message || err.error_description);
  }
}
```

### Retry guidance

| Code | Retryable? | Notes |
|------|-----------|-------|
| PGRST000 (500) | ✓ | Transient server error — retry with backoff. |
| PGRST100 (400) | ✗ | Fix the request before retrying. |
| PGRST403 (401) | Conditional | Anonymous caller. Sign in or refresh the token, then retry once. |
| PGRST403 (403) | ✗ | Policy decision on an authenticated caller — retrying won't help. |
| 23505 (409) | Conditional | Retry with a different key, or upsert with `Prefer: resolution=merge-duplicates`. |
| invalid_grant (401) | ✗ | Re-authenticate; refresh token is expired. |
| 413 | ✗ | Reduce payload size. |

### Correlating 500 errors

When you receive `PGRST000` with an `errorId`, pass it to the operator. On the server side, the full error is logged as:

```
Unhandled error [errorId=abc123]: TypeError: Cannot read properties of undefined …
```

Search CloudWatch / your log aggregator for the `errorId` value.
