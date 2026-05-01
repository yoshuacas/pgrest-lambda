---
title: Lint rules reference
description: Every rule checked by pgrest-lambda lint-policies — what it catches, an example, how to fix it, and how to suppress it.
---

# Lint rules reference

`pgrest-lambda lint-policies` checks each Cedar policy against eight rules. Four are errors (fail the build by default); four are warnings (informational unless `--max-severity warn` is passed).

For how to run the linter and wire it into CI, see the [lint Cedar policies guide](../guide/lint-cedar-policies). For flag and exit-code details, see the [CLI reference](./cli#pgrest-lambda-lint-policies).

## At a glance

| Rule | Severity | What it catches |
|---|---|---|
| [`E001`](#e001-unconditional-permit) | error | `permit` with no conditions and no principal/action/resource narrowing. |
| [`E002`](#e002-tautological-when) | error | `when { true }` or equivalent always-true condition. |
| [`E003`](#e003-syntax-error) | error | Cedar parse failure. |
| [`E004`](#e004-unknown-action) | error | Action that is not `select`, `insert`, `update`, `delete`, or `call`. |
| [`W001`](#w001-principal-type-missing) | warn | Policy scopes `principal` with `op: All` — matches anon too. |
| [`W002`](#w002-resource-type-missing) | warn | Policy scopes `resource` with `op: All` — matches every resource type. |
| [`W003`](#w003-missing-has-guard) | warn | `resource.<col>` accessed without a `resource has <col>` guard. |
| [`W004`](#w004-unscoped-forbid) | warn | `forbid(principal, action, resource);` — blocks everything. |

## Errors

### `E001` unconditional-permit

**Trigger.** A `permit` policy with `principal`, `action`, and `resource` all set to `op: All`, and no `when`/`unless` clauses.

```cedar
// BAD — grants everything to everyone.
permit(principal, action, resource);
```

**Why it's an error.** This is the most common and most destructive Cedar mistake. It silently overrides any narrower `permit` for every principal (including anon), every action, and every resource.

**Fix.** Narrow at least one of principal, action, or resource, OR add a `when` clause:

```cedar
permit(
    principal is PgrestLambda::User,
    action == PgrestLambda::Action::"select",
    resource is PgrestLambda::Row
) when {
    resource has user_id && resource.user_id == principal
};
```

**Exception.** `permit(principal is PgrestLambda::ServiceRole, action, resource);` does not trigger `E001` or `W002`. Service-role bypass is a recognized pattern — it's how trusted backends skip Cedar entirely. See `policies/default.cedar` for the annotated reference version.

**Suppress.** `@lint_allow("E001")` or `@lint_allow("unconditional-permit")`.

---

### `E002` tautological-when

**Trigger.** A `permit` policy whose `when` clause is a literal `true` or a comparison of two identical literal values (`1 == 1`, `"x" == "x"`).

```cedar
// BAD — the condition is always true, so the permit is unconditional.
permit(principal, action, resource) when { true };
permit(principal, action, resource) when { 1 == 1 };
```

**Why it's an error.** A tautological condition defeats the reason for the `when` clause. Because `E001` only fires when `conditions.length == 0`, a `when { true }` sneaks past `E001` — `E002` catches it.

**Fix.** Write a real condition, or narrow the scope and drop the `when` entirely. `E002` does not fire on `forbid` (a tautological forbid is simply a blanket deny, which is the purpose of `W004`).

**Suppress.** `@lint_allow("E002")` or `@lint_allow("tautological-when")`.

---

### `E003` syntax-error

**Trigger.** Cedar fails to parse the file. Typically missing `;`, unclosed parentheses, or an unknown keyword.

```cedar
// BAD — missing closing paren and semicolon.
permit(principal, action, resource
```

**Why it's an error.** A syntactically broken policy file fails loading at runtime and every request returns `PGRST403`. Catching it at lint time is the whole point.

**Fix.** Read the error message — it includes the line number. Cedar's error messages are specific (missing token, unexpected identifier, etc.).

**Suppress.** `E003` cannot be suppressed. `@lint_allow("E003")` is silently ignored — annotations only take effect after the policy parses.

---

### `E004` unknown-action

**Trigger.** An action identifier under `PgrestLambda::Action::` that is not one of the five known values: `select`, `insert`, `update`, `delete`, `call`.

```cedar
// BAD — "drop" is not a known action.
permit(
    principal is PgrestLambda::User,
    action == PgrestLambda::Action::"drop",
    resource is PgrestLambda::Row
);
```

**Why it's an error.** Unknown actions never match anything at runtime, so the policy is dead code. Almost always a typo (`selct`, `udpate`) or a copy-paste from a different policy system.

**Fix.** Use one of the five documented actions. `E004` reports every unknown action in an `action in [...]` list, so you'll see all typos at once.

**Suppress.** `@lint_allow("E004")` or `@lint_allow("unknown-action")`.

## Warnings

### `W001` principal-type-missing

**Trigger.** `principal` is not narrowed with `is` or `==` — it's left as the bare `principal` keyword.

```cedar
// WARN — matches anon too.
permit(
    principal,
    action == PgrestLambda::Action::"select",
    resource is PgrestLambda::Row
);
```

**Why it's a warning.** Bare `principal` applies to every principal type, including `PgrestLambda::Anon`. If you meant "any signed-in user", you want `principal is PgrestLambda::User`. If you meant "any user including anon" — intentional for public-read tables — suppress the warning explicitly.

**Fix.** Add a type:

```cedar
permit(
    principal is PgrestLambda::User,
    action == PgrestLambda::Action::"select",
    resource is PgrestLambda::Row
);
```

**Suppress.** `@lint_allow("W001")` or `@lint_allow("principal-type-missing")`. Common on `forbid` rules (blanket denies) and on public-read `permit` rules.

---

### `W002` resource-type-missing

**Trigger.** `resource` is not narrowed — the policy applies to every resource type (`Row`, `Table`, and any future additions).

```cedar
// WARN — matches every resource type.
permit(
    principal is PgrestLambda::User,
    action == PgrestLambda::Action::"select",
    resource
);
```

**Why it's a warning.** Row-level rules should target `resource is PgrestLambda::Row`; table-level rules (like insert gating) should target `resource is PgrestLambda::Table`. A missing type usually means the author forgot one or the other.

**Fix.** Add a type:

```cedar
permit(
    principal is PgrestLambda::User,
    action == PgrestLambda::Action::"select",
    resource is PgrestLambda::Row
);
```

**Exception.** Service-role bypass (`permit(principal is PgrestLambda::ServiceRole, action, resource);`) does not trigger `W002`. That pattern intentionally covers all resource types.

**Suppress.** `@lint_allow("W002")` or `@lint_allow("resource-type-missing")`.

---

### `W003` missing-has-guard

**Trigger.** A `when` clause accesses `resource.<col>` without a matching `resource has <col>` guard earlier in the same clause.

```cedar
// WARN — user_id is accessed but not guarded.
permit(
    principal is PgrestLambda::User,
    action == PgrestLambda::Action::"select",
    resource is PgrestLambda::Row
) when {
    resource.user_id == principal
};
```

**Why it's a warning.** Cedar evaluates `resource.user_id` strictly — if the row's table doesn't have a `user_id` column, the policy throws and fails closed. Without a `has` guard, the same policy silently stops matching when applied to a table missing the column.

**Fix.** Guard every column you reference:

```cedar
permit(
    principal is PgrestLambda::User,
    action == PgrestLambda::Action::"select",
    resource is PgrestLambda::Row
) when {
    resource has user_id && resource.user_id == principal
};
```

**Partial guards work per-column.** Guarding `status` but accessing `user_id` unguarded still fires `W003` for `user_id`.

**Suppress.** `@lint_allow("W003")` or `@lint_allow("missing-has-guard")`.

---

### `W004` unscoped-forbid

**Trigger.** A `forbid` policy with `principal`, `action`, and `resource` all `op: All`, and no conditions.

```cedar
// WARN — denies everything.
forbid(principal, action, resource);
```

**Why it's a warning.** An unconditional forbid blocks every request, including the service role. It's almost always a mistake — usually a half-finished policy. When intentional (maintenance mode, feature kill-switch), suppress explicitly so the intent is on the page.

**Fix.** Narrow the scope or add a condition:

```cedar
forbid(
    principal,
    action in [PgrestLambda::Action::"update", PgrestLambda::Action::"delete"],
    resource is PgrestLambda::Row
) when {
    resource has status && resource.status == "archived"
};
```

An unscoped forbid also triggers `W001` (unnarrowed principal) and `W002` (unnarrowed resource) — all three fire together.

**Suppress.** `@lint_allow("W004")` or `@lint_allow("unscoped-forbid")`. Typically combine with `W001,W002` if the forbid is intentional.

## Suppression syntax

Add a `@lint_allow(...)` annotation on the line immediately before `permit` or `forbid`:

```cedar
@lint_allow("W001,W002")
permit(principal, action, resource) when { context.table == "public" };
```

The argument is a comma-separated list. Each entry is either a rule ID (`E001`, `W003`) or the human-readable name (`unconditional-permit`, `missing-has-guard`). Mixing is allowed:

```cedar
@lint_allow("tautological-when,W001,W002")
permit(principal, action, resource) when { true };
```

**Rules:**

- Suppression applies only to the annotated policy, not the whole file.
- An empty `@lint_allow("")` suppresses nothing.
- `E003` (syntax error) cannot be suppressed — annotations are only readable after the policy parses.

## See also

- [How to lint Cedar policies](../guide/lint-cedar-policies) — running the linter, CI integration, reading findings.
- [CLI reference — `lint-policies`](./cli#pgrest-lambda-lint-policies) — flags, exit codes, environment variables.
- [How to write Cedar row-level policies](../guide/write-cedar-policies) — authoring guide with recipes.
- Existing [authorization guide](../authorization.md) — full principal/action/resource model.
