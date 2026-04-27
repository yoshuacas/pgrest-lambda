---
title: How authorization works
description: The Cedar-to-SQL pipeline — how pgrest-lambda partially evaluates policies against the request and compiles the residual into a WHERE clause.
---

# How authorization works

**Guiding question:** How does a `.cedar` file end up gating the rows Postgres returns?

This page walks the full request → response pipeline so you know where your policies execute, what they can express, and where the limits are. For the recipe-level guide, see [How to write Cedar row-level policies](../guide/write-cedar-policies); for the full policy model, see the existing [authorization guide](../authorization.md).

## The high-level shape

```text
Request arrives
  ├── apikey JWT       → role (anon | service_role)
  └── Bearer token     → user (id, email, custom claims)
                ↓
Build principal + action + resource + context
                ↓
Cedar partial evaluation (all policies across all files)
                ↓
  ├── Decision = allow, deny, or "depends on the row"
  └── If "depends": a residual boolean expression over resource.<col>
                ↓
Translate residual → SQL WHERE clause
                ↓
Compile full query, run against Postgres
                ↓
Return rows
```

The crucial move is step 3: **partial evaluation**. Cedar is handed everything it can know up front — which user, which action, which table — and reduces the policy set as far as it can. What's left is a boolean expression involving only `resource.<column>` references. pgrest-lambda translates that expression into SQL.

## Why partial evaluation

The alternative is "evaluate the policy per row, after the query runs." That approach works but has costs:

- Every row gets fetched, then thrown away if the policy forbids it. Pagination becomes meaningless.
- The Postgres query planner has no insight into the policy. It can't use indexes that would otherwise prune the scan.
- Aggregates (`count(*)`, `sum(total)`) are almost impossible to authorize correctly without running the policy against every candidate row.

Partial evaluation pushes the policy into the `WHERE` clause, so all three problems disappear. Postgres sees:

```sql
SELECT id, title FROM public.posts
 WHERE created_at > '2024-01-01'          -- user's filter
   AND (user_id = $1)                     -- Cedar residual, $1 = principal id
```

…and uses the index on `user_id` the same way it would for any other filter.

## The pieces Cedar needs

Three inputs produce a decision. The engine composes them from the request:

**Principal** — derived from the apikey and (optional) Bearer token:

| Input | Principal type |
|---|---|
| `apikey` role = `anon`, no bearer | `PgrestLambda::AnonRole` |
| `apikey` role = `anon`, bearer present | `PgrestLambda::User::"<user-id>"` with email/claims |
| `apikey` role = `service_role` | `PgrestLambda::ServiceRole` |

**Action** — from the HTTP method and URL shape:

| Request | Action |
|---|---|
| `GET /rest/v1/:table` | `"select"` |
| `POST /rest/v1/:table` | `"insert"` |
| `PATCH /rest/v1/:table` | `"update"` |
| `DELETE /rest/v1/:table` | `"delete"` |
| `POST /rest/v1/rpc/:fn` | `"call"` |

**Resource** — two shapes:

- `PgrestLambda::Table::"<table>"` for table-level decisions (e.g., "can this principal insert at all?").
- `PgrestLambda::Row` for row-level decisions. The row's columns are accessible as `resource.<col>`.

RPC adds one more resource type, `PgrestLambda::Function::"<name>"`, documented in the [RPC guide](../rpc.md#authorization).

## The limits of the partial evaluator

Cedar is more expressive than what can cleanly translate to SQL. Expressions that can't translate raise `PGRST000: Authorization policy produced untranslatable condition`. Common causes:

- **Comparing two row columns directly.** `resource.author_id == resource.editor_id` doesn't reduce to a simple `WHERE`. Postgres supports it; pgrest-lambda's translator, for now, does not.
- **Referring to a principal attribute that isn't in the JWT.** `principal.team_id` works only if the JWT was minted with `team_id` in its claims.
- **Mixing resource types in one rule.** A rule that matches both `Row` and `Table` can ask for `resource.user_id` on the Row branch and a column lookup on the Table branch — the translator rejects the combination. Split into two rules.

The fix is almost always narrowing: split one permissive rule into two narrow ones, each with a clear resource type and a simple `when`.

## Why Cedar, not database RLS

PostgreSQL has first-class row-level security (`CREATE POLICY`). pgrest-lambda doesn't use it. The reasoning:

- **Policies belong in the repo, not the database.** PRs reviewing an auth change should show the policy diff in the PR, not a migration file that applies DDL. Cedar files are code; database-side RLS is state.
- **One engine for one model.** If we added GraphQL, cron jobs, or a background worker later, we'd need the same authorization decisions there. Cedar lives in the library and is reusable across transports.
- **Aurora DSQL support.** DSQL's feature coverage differs from standard PostgreSQL, including RLS behavior in some cases. Keeping authorization out of the database is one less DSQL-vs-Postgres difference.

The cost is that pgrest-lambda's authorization model is now its own thing to learn. That cost is front-loaded: once your team has written three or four policies, the pattern is stable.

## Caching

Policies load from `POLICIES_PATH` (filesystem or S3) on the first request after startup, and are cached in-process for `policiesTtl` seconds (default 300). The schema cache — the `pg_catalog` introspection that tells the engine which tables and columns exist — is cached similarly.

Both caches drop on:

- Process restart.
- `POST /rest/v1/_refresh`.
- The TTL expiring.

For local development, `pgrest-lambda refresh` is the shortcut. For production with S3 policies, `refresh` against the deployed URL is how you roll out a policy change without redeploying code.

## What happens when no policy matches

Cedar is default-deny. If no `permit` in any loaded policy file matches the incoming `(principal, action, resource)` triple, the request returns `PGRST403`. Any `forbid` that matches also denies, regardless of whether a `permit` matched.

This is why the shipped `policies/default.cedar` includes an explicit `service_role`-bypasses-everything rule — without it, nothing works until you've written your first policy.

## See also

- Existing [authorization guide](../authorization.md) — the principal types, every action, every recipe, every error.
- [How to write Cedar row-level policies](../guide/write-cedar-policies) — the goal-oriented version.
- [Cedar language docs](https://docs.cedarpolicy.com/) — full syntax reference.
- `src/rest/__tests__/cedar.test.mjs` in the repo — every pattern in the guide has a matching passing test.
