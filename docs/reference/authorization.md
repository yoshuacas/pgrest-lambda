---
title: Authorization reference
description: Canonical reference for the Cedar policy model pgrest-lambda evaluates on every request — principals, actions, resources, context, translation limits, error codes, and worked examples for anon, user, team, and admin policies.
---

# Authorization reference

Every request to `/rest/v1/*` is gated by [Cedar](https://docs.cedarpolicy.com/) policies. Policies are files with the `.cedar` extension loaded from `POLICIES_PATH` (filesystem or S3) on first request and cached for `policiesTtl` seconds.

This page is the reference: the exact principal, action, resource, and context shapes the engine passes to Cedar; the subset of Cedar that translates to SQL; every error the authorizer can raise; and worked examples of the patterns most pgrest-lambda deployments use.

For the narrative version, see the [how authorization works](../explanation/how-authorization-works) explanation and the [write Cedar row-level policies](../guide/write-cedar-policies) guide.

## Evaluation order

Every request runs through the same pipeline:

1. The authorizer reads `apikey` and (if present) `Authorization: Bearer …` to produce a `principal`.
2. The handler maps the HTTP method and path to one `action`.
3. For table-level actions (`insert`, `call`), the engine calls `isAuthorized` against a concrete `Table` or `Function` resource — one `permit` must match or the request returns `403`.
4. For row-level actions (`select`, `update`, `delete`), the engine calls Cedar's partial evaluator with `resource = null`, then translates every `permit`/`forbid` residual into SQL and appends it to the `WHERE` clause.
5. Postgres runs the resulting query. Rows that fail the translated predicate are not returned.

`permit` and `forbid` combine as Cedar defines them: at least one `permit` must match, and any matching `forbid` denies regardless.

## Principal

The principal is derived from the incoming `apikey` and optional Bearer token:

| apikey role | Bearer token | Principal entity |
|---|---|---|
| `anon` | absent | `PgrestLambda::AnonRole::"anon"` |
| `anon` | valid | `PgrestLambda::User::"<user-id>"` |
| `service_role` | any | `PgrestLambda::ServiceRole::"service"` |

`PgrestLambda::User` attributes:

| Attribute | Source | Type |
|---|---|---|
| `email` | JWT `email` claim (falls back to `""`) | `String` |
| `role` | JWT `role` claim (falls back to `"authenticated"`) | `String` |
| *(custom)* | Any extra top-level JWT claim | as minted |

Custom claims — `team_id`, `admin`, `org_id`, anything the auth provider adds — are copied onto the `User` entity verbatim. Read them in policies with `principal has <name> && principal.<name> …`. A claim that isn't in the JWT is not on the entity; referring to it in a `when` clause produces `PGRST000`.

`ServiceRole` and `AnonRole` carry no attributes.

## Action

| HTTP request | Cedar action |
|---|---|
| `GET /rest/v1/:table` | `PgrestLambda::Action::"select"` |
| `HEAD /rest/v1/:table` | `PgrestLambda::Action::"select"` |
| `POST /rest/v1/:table` | `PgrestLambda::Action::"insert"` |
| `PATCH /rest/v1/:table` | `PgrestLambda::Action::"update"` |
| `DELETE /rest/v1/:table` | `PgrestLambda::Action::"delete"` |
| `POST /rest/v1/rpc/:fn` | `PgrestLambda::Action::"call"` |
| `GET /rest/v1/rpc/:fn` | `PgrestLambda::Action::"call"` |

Embedded resources (`select=…,author(name)`) are authorized independently — the engine calls the authorizer once per table in the select tree with `action = "select"`. A policy that forbids `select` on `authors` hides the embed even if `select` on `posts` is allowed.

## Resource

| Entity type | Used for | Identifier | Attributes |
|---|---|---|---|
| `PgrestLambda::Table` | Table-level checks (`insert`, or `select`/`update`/`delete` before the row filter is built) | table name | none |
| `PgrestLambda::Row` | Per-row predicates compiled to SQL | *(null during partial eval)* | every column of the table, typed from `pg_catalog` |
| `PgrestLambda::Function` | RPC `call` action | function name | none |

`Row` is a member of `Table` — a rule that binds `resource is PgrestLambda::Row` implicitly restricts to rows of the current table named in `context.table`.

Column attribute types are derived from Postgres types:

| Postgres type | Cedar type |
|---|---|
| `text`, `varchar`, `char`, `character varying`, `uuid` | `String` |
| `integer`, `smallint`, `bigint`, `int`, `serial`, `bigserial` | `Long` |
| `boolean` | `Boolean` |
| *(anything else)* | `String` |

Timestamps, numeric, and JSON columns expose as `String`. Comparing them in a policy works (the value is passed through parameterized), but Cedar won't do type-specific reasoning on them.

## Context

Every authorization call passes a context record with two keys:

| Key | Value |
|---|---|
| `context.table` | The target table name (string). For RPC, the function name. |
| `context.resource_type` | `"Table"`, `"Row"`, or `"Function"`. |

Use `context.table` — not `resource.table` — to scope a rule to one table:

```cedar
when { context.table == "posts" }
```

`resource.<column>` is available only inside rules that match `resource is PgrestLambda::Row`.

## Policy file layout

Policies load from `POLICIES_PATH`:

| `POLICIES_PATH` value | Source |
|---|---|
| *(unset)* | `./policies/` (filesystem) |
| plain path, e.g. `/etc/pgrest/policies` | filesystem |
| `file:///absolute/path` | filesystem |
| `s3://bucket/prefix/` | S3, requires `s3:ListBucket` + `s3:GetObject` |

Rules:

- Only files ending in `.cedar` are loaded. Other files are silently skipped.
- All `.cedar` files in the source are concatenated and evaluated as one policy set — file boundaries are not significant.
- Policies are cached for `policiesTtl` seconds (default `300`). `POST /rest/v1/_refresh` or `pgrest-lambda refresh` drops the cache.
- If the source is empty or unreadable, every request returns `PGRST403` until policies are loaded.

## Translatable Cedar subset

Row-level policies are compiled to SQL via partial evaluation. The translator supports:

| Cedar expression | SQL output |
|---|---|
| `resource.<col> == <value>` | `"<col>" = $n` |
| `resource.<col> != <value>` | `"<col>" != $n` |
| `resource.<col> > <value>` (`>=`, `<`, `<=`) | `"<col>" > $n` etc. |
| `resource.<col> == principal` | `"<col>" = $n` with `$n` = user id |
| `resource.<col> == principal.<attr>` | `"<col>" = $n` with `$n` = claim value |
| `resource has <col>` | `"<col>" IS NOT NULL` (or `FALSE` if the column doesn't exist on the table) |
| `expr && expr` | `(left AND right)` |
| <code>expr &#124;&#124; expr</code> | `(left OR right)` |
| `!expr` | `NOT (expr)` |
| `if cond then a else b` | `CASE WHEN cond THEN a ELSE b END` |
| `resource is PgrestLambda::Row` | *(elided — always true at row evaluation time)* |

`<value>` must be a literal or a principal attribute. Two-column comparisons (`resource.a == resource.b`) are not translated.

### Untranslatable

The translator rejects these expressions with `PGRST000`. If a policy uses them in a rule that the current request exercises, the request fails:

| Expression | Why |
|---|---|
| `in`, `contains`, `containsAll`, `containsAny` | Set membership over columns has no parameterized SQL form the translator emits today. |
| `like`, `isEmpty`, `hasTag`, `getTag` | Not mapped. |
| `resource.<a> == resource.<b>` | Comparing two columns has no literal value to bind; the translator requires one side to resolve to a literal or principal attribute. |
| `principal.<attr>` where `<attr>` is not in the JWT | The attribute is absent from the entity; Cedar raises before translation can run. |
| Rules whose `resource` clause matches both `Table` and `Row` and then accesses `resource.<col>` | `Table` has no column attributes; split into two rules. |

`PGRST000` includes a short summary of the offending operator. The full request flow produces it only when the rule's preconditions match — a rule with an untranslatable body that doesn't apply to the request is ignored.

## Errors

### `PGRST403 — Not authorized`

No `permit` granted the request, or a matching `forbid` denied it. The response body shape:

```json
{
  "code": "PGRST403",
  "message": "Not authorized to select on 'posts'"
}
```

With `production=false` the message is expanded for debugging:

```text
Not authorized: role='anon' action='select' table='posts'.
No Cedar policy grants it. Loaded from ./policies. See
docs/authorization.md for the policy model and recipes.
```

Triggers:

- No `permit` matches the `(principal, action, resource)` triple.
- A `forbid` matched and overrode every `permit`.
- `POLICIES_PATH` is empty or unreadable — no policies loaded means default-deny.
- Request came in without an `apikey`, so the principal is unresolved. (This surfaces as `401` earlier in the pipeline for most misconfigurations; `403` appears only when the apikey is valid but grants nothing.)

### `PGRST000 — Authorization policy produced untranslatable condition`

One of the `when { … }` clauses in a residual rule used an expression the translator doesn't support. With `production=false` the message adds the offending policy id and the source the policies were loaded from:

```text
Authorization policy produced untranslatable condition: comparison must
be between a resource column and a value (e.g. `resource.user_id ==
principal`). Comparing two columns, or referencing a principal
attribute that isn't in the JWT, isn't supported
(comparison '==' where neither side resolves to a column+value).
See docs/authorization.md "Errors" for common causes.
  policy id: policy3
  policies loaded from: ./policies
```

HTTP status is `500` because the request was authorized at the policy level — the failure is the engine unable to compile the residual. The fix is always in the policy file.

### Other authorization failures

| Code | Status | Cause |
|---|---|---|
| `PGRST401` | 401 | `apikey` header missing, invalid JWT, or expired. No principal could be built. |
| `PGRST202` | 404 | RPC function not in the schema cache. Authorization never runs. |
| `PGRST501` | 501 | RPC called on Aurora DSQL, which doesn't support stored procedures. |

## Decision reference

### Anon (unauthenticated)

```cedar
permit(
    principal == PgrestLambda::AnonRole::"anon",
    action == PgrestLambda::Action::"select",
    resource is PgrestLambda::Row
) when {
    context.table == "posts"
};
```

Grants anon `select` on `posts` only. Other tables remain default-deny for anon. `principal is PgrestLambda::AnonRole` works equivalently and scales when there is only one AnonRole entity.

### Signed-in user reads their own rows

```cedar
permit(
    principal is PgrestLambda::User,
    action == PgrestLambda::Action::"select",
    resource is PgrestLambda::Row
) when {
    resource has user_id && resource.user_id == principal
};
```

Compiles to `"user_id" = $n` with `$n` bound to the user's id for every row-level `select`. The `has` guard is required — without it, a request against a table that lacks `user_id` raises `PGRST000`.

### Service role bypass

```cedar
permit(
    principal is PgrestLambda::ServiceRole,
    action,
    resource
);
```

Matches every action on every resource. Because the rule body is unconditionally true, the translator produces no residual — the `WHERE` clause is not modified. This is the pattern `policies/default.cedar` ships with.

### Public read, authenticated write

```cedar
permit(
    principal,
    action == PgrestLambda::Action::"select",
    resource is PgrestLambda::Row
) when {
    context.table == "posts"
};

permit(
    principal is PgrestLambda::User,
    action == PgrestLambda::Action::"insert",
    resource is PgrestLambda::Table
) when {
    resource == PgrestLambda::Table::"posts"
};
```

The second rule uses the `Table` resource because `insert` is authorized before the row exists. `update` and `delete` authorize per row and use `resource is PgrestLambda::Row`.

### Team-scoped access via JWT claim

Requires the auth provider to put `team_id` on the access token.

```cedar
permit(
    principal is PgrestLambda::User,
    action in [
        PgrestLambda::Action::"select",
        PgrestLambda::Action::"update"
    ],
    resource is PgrestLambda::Row
) when {
    resource has team_id
    && principal has team_id
    && resource.team_id == principal.team_id
};
```

Compiles to `"team_id" = $n` with `$n` bound to the claim value. Both `has` guards are required: the column guard keeps the rule from failing on tables without `team_id`, and the principal guard keeps it from failing for users whose token omits the claim.

### Admin claim wildcard

```cedar
permit(
    principal is PgrestLambda::User,
    action,
    resource
) when {
    principal has admin && principal.admin == true
};
```

Non-admin users fall through to the other rules. `principal.admin == true` requires the claim to be a JSON boolean, not the string `"true"`.

### Immutable archived rows

```cedar
forbid(
    principal,
    action in [
        PgrestLambda::Action::"update",
        PgrestLambda::Action::"delete"
    ],
    resource is PgrestLambda::Row
) when {
    resource has status && resource.status == "archived"
};
```

Applies on top of whatever `permit` rules grant update/delete. Service-role is not exempt — a `forbid` overrides every `permit`. Compiles to `NOT ("status" = $n)` appended to the `WHERE` clause.

### Scoping one rule to one table

```cedar
permit(
    principal is PgrestLambda::User,
    action == PgrestLambda::Action::"select",
    resource is PgrestLambda::Row
) when {
    context.table == "invoices"
    && resource has customer_id
    && resource.customer_id == principal.customer_id
};
```

`context.table == "invoices"` ensures the rule produces no residual on other tables — the `context` is known at evaluation time, so Cedar short-circuits the rule before the `resource.customer_id` clause is considered.

### RPC (`call` action)

```cedar
permit(
    principal is PgrestLambda::User,
    action == PgrestLambda::Action::"call",
    resource == PgrestLambda::Function::"get_my_orders"
);
```

RPC always authorizes against `PgrestLambda::Function::"<fn-name>"`. `call` does not take a `Row` resource — filtering the returned set is the function's responsibility. See the [RPC guide](../rpc.md#authorization) for the full contract.

## Refresh

Policies are cached in-process. To pick up a `.cedar` edit without restarting:

```bash
pgrest-lambda refresh
```

Or directly:

```bash
curl -s -X POST http://localhost:3000/rest/v1/_refresh \
  -H "apikey: $ANON_KEY"
```

The same call rebuilds the schema cache from `pg_catalog`. `_refresh` always returns the regenerated OpenAPI document as its body.

## See also

- [How to write Cedar row-level policies](../guide/write-cedar-policies) — goal-oriented walkthrough for adding a new policy.
- [How authorization works](../explanation/how-authorization-works) — why Cedar, the partial-evaluation pipeline, the caching model.
- [Cedar policy linter](cli.md#pgrest-lambda-lint-policies) — validate policies before deployment.
- [HTTP API reference](./http-api) — status codes and endpoint contracts.
- [Configuration reference](./configuration) — `POLICIES_PATH` forms, `policiesTtl`, `production` flag.
- [`policies/default.cedar`](https://github.com/yoshuacas/pgrest-lambda/blob/main/policies/default.cedar) — the starter bundle.
- [`src/rest/__tests__/cedar.test.mjs`](https://github.com/yoshuacas/pgrest-lambda/blob/main/src/rest/__tests__/cedar.test.mjs) — every pattern above has a matching passing test.
- [Cedar language reference](https://docs.cedarpolicy.com/) — full syntax.
