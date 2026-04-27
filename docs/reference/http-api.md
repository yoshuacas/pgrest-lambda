---
title: HTTP API reference
description: Paths, methods, headers, and response shapes for the /rest/v1 and /auth/v1 endpoints exposed by every pgrest-lambda instance.
---

# HTTP API reference

Every running pgrest-lambda instance exposes two stable top-level prefixes: `/rest/v1/*` for CRUD over your schema, and `/auth/v1/*` for user lifecycle. A running instance also serves its own OpenAPI 3.0 spec at `GET /rest/v1/` — use that as the authoritative, schema-specific source. This page is the orientation.

## Common headers

Every request to `/rest/v1/*` and `/auth/v1/*` requires:

| Header | Value | Required |
|---|---|---|
| `apikey` | An HS256-signed JWT with role `anon` or `service_role`. Mint with [`pgrest-lambda generate-key`](./cli#pgrest-lambda-generate-key-anon-service-role). | yes |
| `Authorization: Bearer <access-token>` | A user access token. Presence switches the Cedar principal from `AnonRole` to `User`. | no |
| `Content-Type: application/json` | Required for bodies. | on `POST`, `PATCH`, `PUT` |
| `Prefer` | Optional: `return=representation`, `return=minimal`, `count=exact`, `count=planned`, `resolution=merge-duplicates`. | no |

## `/rest/v1/*` — REST over tables

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/rest/v1/` | Returns the auto-generated OpenAPI 3.0 spec. |
| `GET` | `/rest/v1/_docs` | Interactive Scalar explorer (HTML). Disable with `PGREST_DOCS=false`. |
| `POST` | `/rest/v1/_refresh` | Reload the schema cache and Cedar policies. |
| `GET` | `/rest/v1/:table` | Read rows from `public.<table>`. |
| `POST` | `/rest/v1/:table` | Insert rows into `public.<table>`. |
| `PATCH` | `/rest/v1/:table` | Update rows matching the query filters. |
| `DELETE` | `/rest/v1/:table` | Delete rows matching the query filters. |
| `HEAD` | `/rest/v1/:table` | Same as `GET` but returns headers only. |
| `POST`, `GET` | `/rest/v1/rpc/:function_name` | Call a stored function. See the existing [RPC guide](../rpc.md). |

### Query syntax (PostgREST-compatible)

The query-string grammar is PostgREST-compatible. Summary:

| Query param | Example | Meaning |
|---|---|---|
| `select` | `select=id,title,author(name)` | Column projection; nested tables become embedded resources. |
| Filter | `status=eq.published`, `created_at=gt.2024-01-01` | Operator-prefixed value. Operators include `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `like`, `ilike`, `in`, `is`. |
| `order` | `order=created_at.desc,id` | Comma-separated sort keys. Default is ascending. |
| `limit` | `limit=50` | Maximum rows returned. |
| `offset` | `offset=100` | Pagination offset. |
| `on_conflict` | `on_conflict=id` | Upsert target columns. Pairs with `Prefer: resolution=merge-duplicates`. |

The live OpenAPI explorer at `GET /rest/v1/_docs` documents the exact query params for your schema.

### Response codes

| Code | Meaning |
|---|---|
| `200` | Read succeeded or non-returning write with no body requested. |
| `201` | `POST` insert succeeded and rows are returned (`Prefer: return=representation`). |
| `204` | Write succeeded with `Prefer: return=minimal`. |
| `400` | Malformed query syntax. |
| `401` | Missing or invalid `apikey`. |
| `403` | Cedar policy denied. See [`PGRST403`](../authorization.md#errors). |
| `404` | Table or function not in the schema cache. Call `POST /rest/v1/_refresh`. |
| `406` | Requested a response type that can't be produced. |

## `/auth/v1/*` — User lifecycle

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/auth/v1/signup` | Register a new user. Body: `{ email, password }`. |
| `POST` | `/auth/v1/token?grant_type=password` | Password grant. Body: `{ email, password }`. Returns `{ access_token, refresh_token, user }`. |
| `POST` | `/auth/v1/token?grant_type=refresh_token` | Refresh-token grant. Body: `{ refresh_token }`. |
| `POST` | `/auth/v1/logout` | Invalidate the caller's refresh token. |
| `GET` | `/auth/v1/user` | Current user profile. Requires a Bearer access token. |
| `PUT` | `/auth/v1/user` | Update current user attributes. |
| `POST` | `/auth/v1/otp` | Request a magic-link email. Requires `SES_FROM_ADDRESS`. |
| `POST` | `/auth/v1/verify` | Verify a magic-link token. |
| `GET` | `/auth/v1/authorize` | Start an OAuth flow. Query: `?provider=google`. |
| `GET` | `/auth/v1/callback` | OAuth redirect target. |
| `GET` | `/auth/v1/jwks` | Public JWKS for asymmetric verification of `access_token`. |

These endpoints are wire-compatible with Supabase's equivalents, so `@supabase/supabase-js` client calls (`.auth.signUp`, `.auth.signInWithPassword`, `.auth.getUser`, `.auth.signInWithOtp`, `.auth.signInWithOAuth`) work unchanged against a pgrest-lambda server.

## `_refresh`

```bash
curl -s -X POST http://localhost:3000/rest/v1/_refresh \
  -H "apikey: $ANON_KEY"
```

Returns the full OpenAPI spec as a JSON body. The side effect is:

- Schema cache rebuilt from `pg_catalog`.
- Cedar policies reloaded from `POLICIES_PATH` (filesystem or S3).

Use after adding tables or editing policies. See [How to write Cedar row-level policies](../guide/write-cedar-policies) for the common workflow.

## RPC

`/rest/v1/rpc/:function_name` is a full sub-protocol documented separately — function shapes, argument encoding, error codes, and the DSQL caveat are in the existing [RPC guide](../rpc.md).

## See also

- [CLI reference](./cli) — commands that hit these endpoints.
- [Configuration reference](./configuration) — env vars that control endpoint behavior.
- Existing [authorization guide](../authorization.md) — how every endpoint is gated.
- Existing [RPC guide](../rpc.md) — the full `/rest/v1/rpc/*` contract.
