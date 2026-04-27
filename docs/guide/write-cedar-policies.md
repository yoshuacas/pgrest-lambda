---
title: How to write Cedar row-level policies
description: Add .cedar files to the policies directory so anon, signed-in users, and service-role callers see exactly the rows they should.
---

# How to write Cedar row-level policies

pgrest-lambda uses [Cedar](https://www.cedarpolicy.com/) to decide who can read or write which rows. This guide covers adding a new policy file and verifying it works. For the full mental model, principal types, and every built-in resource, see the existing [authorization guide](../authorization.md).

**Prerequisites**

- pgrest-lambda is running (locally via `pgrest-lambda dev`, or deployed).
- You have write access to the `policies/` directory (or to the S3 bucket named by `POLICIES_PATH`).
- You know the table name and the principal type you want to grant access to.

## Step 1 — Decide the rule

Pick one from the decision table:

| Goal | Rule shape |
|---|---|
| Let anyone (even anon) read a public table | `permit(principal, action == "select", resource is Row) when { context.table == "<table>" }` |
| Let signed-in users read only their own rows | `permit(principal is User, action, resource is Row) when { resource has user_id && resource.user_id == principal }` |
| Let admins do anything | `permit(principal is User, action, resource) when { principal has admin && principal.admin == true }` |
| Block writes on archived rows | `forbid(principal, action in ["update","delete"], resource is Row) when { resource has status && resource.status == "archived" }` |

Full recipe set: existing [authorization guide](../authorization.md#recipes).

## Step 2 — Add the file

Cedar policies live in `policies/` by default. Create one file per table (or group them however you like — every `*.cedar` file is loaded together):

```cedar
// policies/posts.cedar

// Anyone can read posts.
permit(
    principal,
    action == PgrestLambda::Action::"select",
    resource is PgrestLambda::Row
) when {
    context.table == "posts"
};

// Signed-in users can insert their own post.
permit(
    principal is PgrestLambda::User,
    action == PgrestLambda::Action::"insert",
    resource is PgrestLambda::Table
) when {
    resource == PgrestLambda::Table::"posts"
};

// Authors can update or delete their own posts.
permit(
    principal is PgrestLambda::User,
    action in [
        PgrestLambda::Action::"update",
        PgrestLambda::Action::"delete"
    ],
    resource is PgrestLambda::Row
) when {
    context.table == "posts"
    && resource has user_id
    && resource.user_id == principal
};
```

Only files ending in `.cedar` are loaded. A file named `posts.policy` or `posts.txt` is silently skipped.

## Step 3 — Reload

Policies are cached for 5 minutes in-process. Force an immediate reload:

```bash
npx pgrest-lambda refresh
```

Expected output:

```text
→ POST http://localhost:3000/rest/v1/_refresh
✓ schema cache and Cedar policies reloaded
```

Against a deployed Lambda, set `PGREST_URL=https://…` (or pass `--url`). The `refresh` command mints an apikey from `JWT_SECRET` to authenticate itself, so `JWT_SECRET` in the local environment must match what the Lambda is configured with.

## Step 4 — Verify

Read as anon (should succeed for the `posts` table given the rule above):

```bash
curl -s 'http://localhost:3000/rest/v1/posts?select=id,title' \
  -H "apikey: $ANON_KEY"
```

Expected:

```json
[
  {"id": 1, "title": "Hello"},
  {"id": 2, "title": "Second"}
]
```

Try to insert as anon (should fail with `403`):

```bash
curl -s -X POST http://localhost:3000/rest/v1/posts \
  -H "apikey: $ANON_KEY" \
  -H "Content-Type: application/json" \
  -d '{"title":"nope","body":"anon cannot write"}'
```

Expected:

```json
{
  "code": "PGRST403",
  "message": "Not authorized to insert on 'posts'"
}
```

Sign in as a user, then retry the insert. With the posts rule above, it should succeed.

## Debugging

### "Not authorized" but you expected the rule to match

Run in development mode (`production=false`, the default for `pgrest-lambda dev`). The error body expands to show which role, action, and table were checked, and where the policies were loaded from:

```text
PGRST403: Not authorized: role='anon' action='select' table='notes'.
No Cedar policy grants it. Loaded from ./policies. See
docs/authorization.md for the policy model and recipes.
```

Checklist when this fires:

1. Confirm `pgrest-lambda refresh` ran after you edited the file.
2. Check you are keying on `context.table` (not `resource.table`) for row-level rules. `resource` exposes column values; the table name lives on `context`.
3. If you meant to grant anon, remove `is PgrestLambda::User` from the `principal` clause — that type excludes anon.

### "Authorization policy produced untranslatable condition" (`PGRST000`)

One of your `when { … }` clauses can't be turned into SQL. Common causes are comparing two row columns directly, or referring to a principal attribute that's not in the JWT. See the existing [authorization guide — Errors](../authorization.md#errors) for the full explanation.

### Production: policies live in S3

Set `POLICIES_PATH=s3://<bucket>/<prefix>/` and grant the Lambda execution role `s3:ListBucket` and `s3:GetObject`. Edit policies in the bucket, then call `refresh` against the deployed URL:

```bash
PGREST_URL=https://abc123.execute-api.us-east-1.amazonaws.com/v1 \
  JWT_SECRET="$(aws ssm get-parameter --name /pgrest/jwt-secret \
     --query Parameter.Value --output text --region us-east-1)" \
  npx pgrest-lambda refresh
```

## Related

- Existing [authorization guide](../authorization.md) — full principal/action/resource model, every recipe, every error code.
- Existing [configuration guide](../configuration.md) — `POLICIES_PATH` forms (filesystem, `file://`, `s3://`).
- [Explanation — How authorization works](../explanation/how-authorization-works) — why Cedar, how the SQL translation happens.
