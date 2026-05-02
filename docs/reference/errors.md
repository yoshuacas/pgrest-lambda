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
| 413 | `Request body exceeds maximum size of 1048576 bytes` |

The default body-size limit is **1 MB**. This fires before any parsing occurs.

---

### PGRST100 — Parse / validation error

The most common client-facing code. Returned for any malformed query-string parameter, filter, select expression, or request body.

| HTTP | Message pattern | Cause |
|------|----------------|-------|
| 400 | `Missing or invalid request body` | POST/PATCH/PUT with empty or unparseable body. |
| 400 | `Empty column name before '::'` | Cast syntax `::type` without a column name. |
| 400 | `Empty cast type after '::'` | Column `col::` without a type. |
| 400 | `Unsupported cast type '{type}'` | Cast to a type not in the allowlist. |
| 400 | `Unbalanced parentheses in select parameter` | Mismatched `(` / `)` in `?select=`. |
| 400 | `'{alias}' is not a valid identifier for an alias` | Alias contains invalid characters. |
| 400 | `Empty column name after alias '{alias}'` | Alias present but column name missing. |
| 400 | `Empty select list in embed '{embed}'` | `embed()` with nothing inside the parens. |
| 400 | `Duplicate select key '{key}'` | Same column or embed alias selected twice. |
| 400 | `Filter nesting deeper than one level is not supported` | `a.b.c=eq.1` — only one level of embed filtering. |
| 400 | `Cannot filter on '{key}' -- no embed named '{prefix}' in select` | Filter references an embed not in `?select=`. |
| 400 | `"{raw}" is not a valid filter for column "{column}"` | Unparseable filter expression. |
| 400 | `"{operator}" is not a valid filter operator` | Operator not in allowlist (eq, gt, lt, gte, lte, neq, like, ilike, in, is, cs, cd, ov, sl, sr, nxl, nxr, adj, not, fts, plfts, phfts, wfts). |
| 400 | `"{value}" is not a valid value for is operator` | `is` only accepts `null`, `true`, `false`, `unknown`. |
| 400 | `Unbalanced parentheses in logical operator value` | Mismatched parens in `and(...)` / `or(...)`. |
| 400 | `Empty condition list in '{op}' operator` | `and()` or `or()` with no conditions. |
| 400 | `"{str}" is not a valid filter condition` | Condition inside `and()` / `or()` can't be parsed. |
| 400 | `Logical operator nesting exceeds maximum depth` | Too many nested `and(or(and(...)))` levels. |
| 400 | `Invalid order direction: "{dir}". Expected asc or desc` | `?order=col.upward` — only `asc` and `desc`. |
| 400 | `Invalid nulls option: "{opt}". Expected nullsfirst or nullslast` | Only `nullsfirst` and `nullslast` are accepted. |
| 400 | `'{name}' is not a valid function name` | RPC name contains characters outside `[a-z0-9_]`. |

**Client handling:** inspect the `message` — it identifies the exact field or parameter. Fix the query string or request body and retry.

---

### PGRST101 — Method not allowed for RPC

| HTTP | Message |
|------|---------|
| 405 | `Only GET, POST, and HEAD are allowed for RPC` |

---

### PGRST106 — Bulk change protection

| HTTP | Message |
|------|---------|
| 400 | `UPDATE requires filters to prevent bulk change` |
| 400 | `DELETE requires filters to prevent bulk change` |

Fires when an UPDATE or DELETE has **no `?` filters** and the request is not an RPC. Add at least one filter parameter to proceed.

---

### PGRST116 — Singular response mismatch

Returned when the client requests a singular JSON object via `Accept: application/vnd.pgrst.object+json` but the row count doesn't match.

| HTTP | Message | When |
|------|---------|------|
| 406 | `JSON object requested but 0 rows returned` | No rows match. |
| 406 | `Singular response expected but more rows found` | More than one row matches. |

**Client handling:** relax the `Accept` header to `application/json` to receive an array, or tighten your filters.

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
| 400 | `Column '{column}' does not exist in '{table}'` |
| 400 | `Column '{col}' does not exist in function result` |
| 400 | `'{col}' is not a valid column name` |

---

### PGRST205 — Relation not found

| HTTP | Message | Hint |
|------|---------|------|
| 404 | `Relation '{table}' does not exist` | `Check the spelling of the table name.` |
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
| 400 | `Argument '{name}' of function '{fn}' expects type '{type}' but received '{value}'` |

The RPC argument value cannot be cast to the declared PostgreSQL type.

---

### PGRST209 — Missing required function argument

| HTTP | Message |
|------|---------|
| 400 | `Function '{name}' requires argument '{arg}' which was not provided` |

---

### PGRST301 — Authentication required

| HTTP | Message |
|------|---------|
| 401 | `Refresh requires service_role` |

The `/_refresh` endpoint requires a JWT with `role=service_role`.

---

### PGRST403 — Cedar authorization denied

| HTTP | Message |
|------|---------|
| 403 | `Permission denied` |

Cedar evaluated the request and either found no matching `permit` policy or found a `forbid` that overrides. The `details` field carries the evaluated principal, action, and resource for debugging.

**Client handling:** check your Cedar policies and the JWT's `role` / `sub` claims.

---

### PGRST501 — Unsupported feature

| HTTP | Message | Hint |
|------|---------|------|
| 501 | `RPC is not supported on this database` | `Deploy on a database that supports CREATE FUNCTION` |

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
| 422 | `Password must be at least 8 characters…` | `weak_password.reasons` — array of strings. |

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
| 413 | `Request body exceeds maximum size of 1048576 bytes` |

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
| PGRST403 (403) | ✗ | Policy decision — retrying won't help. |
| 23505 (409) | Conditional | Retry with a different key, or upsert with `Prefer: resolution=merge-duplicates`. |
| invalid_grant (401) | ✗ | Re-authenticate; refresh token is expired. |
| 413 | ✗ | Reduce payload size. |

### Correlating 500 errors

When you receive `PGRST000` with an `errorId`, pass it to the operator. On the server side, the full error is logged as:

```
Unhandled error [errorId=abc123]: TypeError: Cannot read properties of undefined …
```

Search CloudWatch / your log aggregator for the `errorId` value.
