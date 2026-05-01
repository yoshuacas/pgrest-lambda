---
title: How to lint Cedar policies
description: Run pgrest-lambda lint-policies locally and in CI to catch permissive or broken policies before deployment.
---

# How to lint Cedar policies

`pgrest-lambda lint-policies` checks every `.cedar` file for permissiveness and correctness issues — unconditional permits, tautological `when` clauses, syntax errors, unknown actions, missing type narrowing, and missing `has` guards. Run it locally before committing and in CI before deploying.

For a complete list of rules and fixes, see the [lint rules reference](../reference/lint-rules). For flag-level detail, see the [CLI reference](../reference/cli#pgrest-lambda-lint-policies).

**Prerequisites**

- pgrest-lambda installed (global install, `npx`, or a local `devDependency`).
- A `policies/` directory containing one or more `.cedar` files.

## Run it locally

From the repo root:

```bash
npx pgrest-lambda lint-policies
```

Default behavior: scan `./policies/`, report both errors and warnings to stdout, exit `0` if there are no errors.

Against a non-default directory:

```bash
npx pgrest-lambda lint-policies --path ./custom/policies
```

Sample clean output:

```text
3 policies scanned, 0 errors, 0 warnings
```

Sample output with findings:

```text
policies/custom.cedar:3 error E001 Unconditional permit — no conditions and no principal/action/resource narrowing. Add a when clause or narrow the scope.
policies/custom.cedar:10 warn W001 Principal type missing — policy applies to all principal types including anon. Add 'principal is PgrestLambda::User' or similar.
2 policies scanned, 1 error, 1 warning
```

Findings are sorted by file, then by order within the file. Each line is `<file>:<line> <severity> <rule> <message>`.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | No findings above the severity threshold. |
| `1` | One or more findings at or above the threshold. |
| `2` | Usage error — missing directory, no `.cedar` files, invalid flags. |

The default threshold is `error`. Use `--max-severity warn` to also fail on warnings, or `--max-severity off` to never fail (report-only mode).

## Read a finding

```text
policies/posts.cedar:3 error E001 Unconditional permit — no conditions and no principal/action/resource narrowing. Add a when clause or narrow the scope.
```

Parts:

- `policies/posts.cedar:3` — file and 1-based line number, copy-paste-able into most editors.
- `error` — severity (`error` or `warn`).
- `E001` — rule ID. Look it up in the [rules reference](../reference/lint-rules).
- Everything after — human-readable message with suggested fix.

## Suppress a finding

Add a `@lint_allow(...)` annotation on the line immediately before the `permit` or `forbid`:

```cedar
@lint_allow("W001")
permit(
    principal,
    action == PgrestLambda::Action::"select",
    resource is PgrestLambda::Row
) when {
    context.table == "posts"
};
```

The argument is a comma-separated list of rule IDs (`E001`, `W003`) or human-readable names (`unconditional-permit`, `missing-has-guard`):

```cedar
@lint_allow("tautological-when,W001,W002")
permit(principal, action, resource) when { true };
```

Suppression scope is the single annotated policy. `E003` (syntax error) cannot be suppressed. See [lint rules — suppression syntax](../reference/lint-rules#suppression-syntax) for the full rules.

## JSON output for scripting

Pass `--format json` to get a machine-readable report:

```bash
npx pgrest-lambda lint-policies --format json
```

```json
{
  "findings": [
    {
      "file": "policies/custom.cedar",
      "line": 3,
      "severity": "error",
      "rule": "E001",
      "message": "Unconditional permit — …"
    }
  ],
  "summary": { "policiesScanned": 2, "errors": 1, "warnings": 1 }
}
```

Useful for piping into `jq`, posting to a review comment bot, or consuming from a custom CI reporter.

## Silence clean runs

Pass `--quiet` to suppress output when there are no findings. Useful in pre-commit hooks:

```bash
npx pgrest-lambda lint-policies --quiet
```

With `--quiet`, a clean scan prints nothing and exits `0`. Findings still print normally.

## CI integration

### GitHub Actions

```yaml
# .github/workflows/lint-policies.yml
name: Lint Cedar policies

on:
  pull_request:
    paths:
      - 'policies/**'
      - 'package.json'

jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - run: npm ci
      - run: npx pgrest-lambda lint-policies --max-severity warn
```

`--max-severity warn` fails the job on warnings too, not just errors. Drop the flag to only fail on errors.

### Pre-commit hook

Add to `.husky/pre-commit` (or your hook runner of choice):

```bash
#!/bin/sh
npx pgrest-lambda lint-policies --quiet
```

The `--quiet` flag keeps the hook silent on clean runs.

### npm script

Add to `package.json`:

```json
{
  "scripts": {
    "lint:policies": "pgrest-lambda lint-policies"
  }
}
```

Then `npm run lint:policies` becomes the canonical invocation — convenient for developers and CI alike.

## S3-hosted policies

The linter only operates on local directories. If your production policies live in S3 (`POLICIES_PATH=s3://…`), lint them from your repo checkout before upload — the linter is a pre-deploy tool, not a runtime check.

Passing a path starting with `s3://` to `--path` exits `2` with a clear message.

## Related

- [Lint rules reference](../reference/lint-rules) — every rule, example, fix, and suppression.
- [CLI reference — `lint-policies`](../reference/cli#pgrest-lambda-lint-policies) — flags and exit codes.
- [How to write Cedar row-level policies](./write-cedar-policies) — authoring guide with recipes.
