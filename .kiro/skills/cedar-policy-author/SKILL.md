---
name: cedar-policy-author
description: Guide for writing and validating Cedar authorization policies. Use when creating or editing .cedar files in the policies/ directory.
---

## Purpose

Write Cedar policies for pgrest-lambda and validate them
with the built-in linter before deployment.

## Process

1. Determine the access rule — who (principal), what
   (action), which rows/tables (resource), and under
   what conditions (`when`/`unless`).
2. Write the `.cedar` file in `policies/` (or the path
   named by `POLICIES_PATH`). One file per table or
   logical group.
3. Run the linter to validate:
   ```bash
   pgrest-lambda lint-policies
   ```
4. Fix any findings. The linter checks 8 rules:
   - **E001** unconditional-permit
   - **E002** tautological-when
   - **E003** syntax-error
   - **E004** unknown-action
   - **W001** principal-type-missing
   - **W002** resource-type-missing
   - **W003** missing-has-guard
   - **W004** unscoped-forbid
5. Suppress a rule on a specific policy with
   `@lint_allow("rule-id")` if the finding is
   intentional.
6. Reload policies on the running server:
   ```bash
   pgrest-lambda refresh
   ```

## References

- Full authoring guide:
  `docs/guide/write-cedar-policies.md`
- CLI flag reference:
  `docs/reference/cli.md#pgrest-lambda-lint-policies`
- Authorization model:
  `docs/reference/authorization.md`
