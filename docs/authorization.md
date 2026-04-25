# Authorization

pgrest-lambda uses [Cedar](https://www.cedarpolicy.com/) to decide who
can read or write which rows. You write `.cedar` policy files; the
engine translates them into SQL `WHERE` clauses before every query.

This page is a guide to writing those policies. It's organized so you
can skim: try the example first, then jump to the recipe that matches
what you're building.

## A working example, start to finish

Problem: you want anyone (logged in or not) to read from a `posts`
table, but only the author should be able to update or delete their own
row.

Drop this file in `policies/posts.cedar`:

```cedar
// Anyone can read posts.
permit(
    principal,
    action == PgrestLambda::Action::"select",
    resource is PgrestLambda::Row
) when {
    context.table == "posts"
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

Restart the dev server (or `POST /rest/v1/_refresh`), then:

```bash
# Anon can read — no Bearer token needed.
curl http://localhost:3000/rest/v1/posts -H "apikey: $ANON_KEY"

# Anon cannot insert — returns 403.
curl -X POST http://localhost:3000/rest/v1/posts \
  -H "apikey: $ANON_KEY" \
  -H "Content-Type: application/json" \
  -d '{"body":"nope"}'

# Alice can update her own posts (but not Bob's).
curl -X PATCH "http://localhost:3000/rest/v1/posts?id=eq.1" \
  -H "apikey: $ANON_KEY" \
  -H "Authorization: Bearer $ALICE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"body":"updated"}'
```

That's the whole workflow: write Cedar, restart, curl. Everything below
is either a variation or a troubleshooting aid.

## Where policies live

| Path | What it's for |
|---|---|
| `./policies/` | Default source. One `.cedar` file per table (or any layout you want — all files are loaded together). |
| `POLICIES_PATH=s3://bucket/prefix/` | Production: load from S3 instead of disk. See [configuration.md](configuration.md). |

Files get loaded lazily on the first request after startup and cached
for 5 minutes. To force a reload:

```bash
curl -X POST http://localhost:3000/rest/v1/_refresh -H "apikey: $ANON_KEY"
```

`pgrest-lambda dev` seeds a reasonable `policies/default.cedar` — read
it before writing your own. It covers the common "users see their own
rows, service_role is admin" setup.

## The mental model, short

Every REST request arrives at pgrest-lambda with a **principal**, takes
an **action** on a **resource**, and the engine runs your policies to
decide yes or no.

**Principal types.** Cedar sees one of three, determined by the apikey
and optional Bearer token:

| Type | When |
|---|---|
| `PgrestLambda::AnonRole` | Only an `apikey` with role `anon` is present. No user is signed in. |
| `PgrestLambda::User` | A Bearer access token is present; the signed-in user's id is `principal.id`, and their email/role are on the principal. |
| `PgrestLambda::ServiceRole` | The `apikey` has role `service_role`. Used by trusted backend code. |

**Action.** One of `"select"`, `"insert"`, `"update"`, `"delete"` —
mapped from the HTTP method and the request.

**Resource.** Two shapes:

- `PgrestLambda::Table::"<table_name>"` — used for table-level
  decisions like "can this principal insert at all?"
- `PgrestLambda::Row` — used for row-level decisions. The row's column
  values are accessible as `resource.<column_name>`.

**Context.** The engine also passes `context.table` (the table name as
a string). Use this in row-level policies to key rules to a specific
table:

```cedar
when {
    context.table == "posts"
}
```

**How `permit` and `forbid` combine.**

- At least one `permit` must match, OR the request is denied.
- Any `forbid` that matches denies, even if a `permit` also matches.
- Row-level policies translate into SQL `WHERE` predicates. The query
  runs; rows that don't satisfy the policy simply aren't returned.

## Recipes

### Service role bypasses everything

```cedar
permit(
    principal is PgrestLambda::ServiceRole,
    action,
    resource
);
```

Already in `default.cedar`. Equivalent to Supabase's service-role
behavior: trusted backend code skips all row checks.

### Signed-in users can only see their own rows

Works when the table has a `user_id` column.

```cedar
permit(
    principal is PgrestLambda::User,
    action == PgrestLambda::Action::"select",
    resource is PgrestLambda::Row
) when {
    resource has user_id && resource.user_id == principal
};
```

`resource has user_id` guards against tables that don't have that
column. Without the guard, the policy throws on every other table.

### Public read, authenticated write

```cedar
// Everyone reads.
permit(
    principal,
    action == PgrestLambda::Action::"select",
    resource is PgrestLambda::Row
) when {
    context.table == "posts"
};

// Only signed-in users can insert.
permit(
    principal is PgrestLambda::User,
    action == PgrestLambda::Action::"insert",
    resource is PgrestLambda::Table
) when {
    resource == PgrestLambda::Table::"posts"
};
```

### Team-scoped access

Rows have a `team_id` column; users have a `team_id` claim embedded in
their JWT.

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

For this to work, your better-auth setup needs to put `team_id` in the
JWT's custom claims. See the better-auth JWT plugin config in
`src/auth/providers/better-auth.mjs`.

### Admins get a wildcard

Admins are regular users with an `admin == true` claim.

```cedar
permit(
    principal is PgrestLambda::User,
    action,
    resource
) when {
    principal has admin && principal.admin == true
};
```

### Forbid writes on archived rows

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

`forbid` overrides `permit`. Nothing — not even service_role — can
mutate archived rows if this is in force. That's usually what you want
for compliance-style rules.

### Only the row's author can delete

```cedar
permit(
    principal is PgrestLambda::User,
    action == PgrestLambda::Action::"delete",
    resource is PgrestLambda::Row
) when {
    resource has user_id && resource.user_id == principal
};
```

Combine with the "public read" recipe above: readers are unrestricted,
but only the author deletes.

## Errors

### `PGRST403: Not authorized to <action> on '<table>'`

The policy model says no. In development mode (`production=false`) the
message is expanded to include the role, action, table, and where the
policies were loaded from:

```
PGRST403: Not authorized: role='anon' action='select' table='notes'.
No Cedar policy grants it. Loaded from ./policies. See
docs/authorization.md for the policy model and recipes.
```

Steps to unblock:

1. Confirm the policies loaded. Hit `POST /rest/v1/_refresh`. If the
   request itself returns 403, the Cedar engine found no `permit`
   anywhere.
2. Check you're keying on `context.table` (not `resource.table`) in
   row-level rules. `resource` exposes column values; the table name
   is on `context`.
3. If you meant to grant access to anon, confirm the policy's
   `principal` clause doesn't restrict to `is PgrestLambda::User` — that
   type excludes the anon role.

### `PGRST000: Authorization policy produced untranslatable condition`

One of your `when { ... }` clauses uses a Cedar expression that can't
be turned into SQL. Common causes:

- Referring to a principal attribute that isn't in the JWT claims.
  E.g. `principal.team_id == resource.team_id`, but you never put
  `team_id` in the JWT.
- Comparing two row columns directly — pgrest-lambda's partial
  evaluator doesn't currently support that.
- Using `has` or `==` on a resource type that doesn't support it, like
  asking for `resource.user_id` when the rule also matches
  `PgrestLambda::Table` resources.

The fix is usually to narrow the rule. Split one permissive rule into
two more specific ones — one for `Row`, one for `Table`.

### Policy file appears not to load

Two things to check:

1. File extension. Only files ending in `.cedar` get loaded. A file
   named `posts.policy` or `posts.txt` is silently skipped.
2. Cache TTL. Policies cache for five minutes. Restart `pgrest-lambda
   dev` or hit `POST /rest/v1/_refresh` to see changes immediately.

## Cedar language, cheatsheet

Full spec: https://docs.cedarpolicy.com/. What you'll likely use:

```cedar
// Basic shape
permit(
    principal <is | ==>,
    action <in [] | ==>,
    resource <is | ==>
) when {
    <boolean expression>
};

// Principal type check
principal is PgrestLambda::User

// Principal identity check (for specific user)
principal == PgrestLambda::User::"alice-user-id"

// Action membership
action in [
    PgrestLambda::Action::"select",
    PgrestLambda::Action::"update"
]

// Resource type check vs. specific resource
resource is PgrestLambda::Row
resource == PgrestLambda::Table::"posts"

// Attribute access with guard
resource has user_id && resource.user_id == principal
principal has team_id && principal.team_id == resource.team_id

// Context
context.table == "posts"

// Forbid (higher priority than permit)
forbid(
    principal,
    action,
    resource
) when { ... };
```

Cedar is declarative — order of rules doesn't matter. `permit` and
`forbid` across all files combine into one decision.

## Related

- [configuration.md](configuration.md) — `POLICIES_PATH` (filesystem
  vs. S3).
- [`policies/default.cedar`](../policies/default.cedar) — the starter
  policy bundle. Read it as a working example.
- [Cedar language docs](https://docs.cedarpolicy.com/) — full syntax
  reference.
- [`src/rest/__tests__/cedar.test.mjs`](../src/rest/__tests__/cedar.test.mjs)
  — every pattern in this guide has a matching passing test in that
  file. When in doubt, crib from there.
