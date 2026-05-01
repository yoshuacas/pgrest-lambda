# V-06a — Cedar policy linter as a CLI capability

Close one limb of security finding V-06 (High) by adding a Cedar policy
linter to the `pgrest-lambda` CLI. The auditor's recommended fix calls
for "a policy linter/validator that warns about overly permissive
policies (e.g., no conditions on `permit`)." This is the most
portable half of V-06 — it works across all backends, doesn't
require an RLS/DSQL architecture split, and hardens the primary
(and, on DSQL, the only) authz layer.

## Why this scope

V-06's other limbs — optional RLS templates for Aurora/RDS, and the
`cedar.mjs:488-490` INSERT fail-open branch — are separate tracks. This
task is only the linter + its documentation + skill wiring. The other
limbs will ship under V-06b/V-06c.

## What the linter must detect

At minimum, these severities on a per-file basis. Exit non-zero on any
`error`, zero on `warn` only (so CI can gate on the strict mode with a
`--max-severity=warn` flag or similar).

### Errors (hard-fail by default)

1. **Unconditional `permit`** — a `permit(principal, action, resource)`
   with no `when { }` clause and no narrowing on principal/action/
   resource types, except the documented `PgrestLambda::ServiceRole`
   bypass in `policies/default.cedar` which is explicitly allowlisted
   (match on the exact signature or on a magic comment token).
2. **`permit` with an always-true `when` clause** — `when { true }`,
   `when { 1 == 1 }`, literal tautologies.
3. **Syntax error** — bubble Cedar's parse error from `@cedarpolicy/cedar-wasm`
   (we already depend on it via `cedar.mjs`). Point at file:line.
4. **Unknown action** — `PgrestLambda::Action::"<x>"` where `<x>` is not
   one of `select`, `insert`, `update`, `delete`, `call`.

### Warnings (advisory, don't fail by default)

5. **Principal type missing** — `permit(principal, …)` with no
   `principal is …` narrowing. Almost always a bug (grants anon).
6. **Resource type missing** — same, for resource. Usually means the
   author forgot to distinguish `Row` vs `Table`.
7. **`when` clause mentions `resource.<col>` without a `resource has <col>`
   guard** — without the guard, the policy fails-closed on any row
   missing the column, which is often not the intent.
8. **Forbid without scope** — `forbid(principal, action, resource)` with
   no narrowing or `when { }` blocks every caller from everything.
   That's almost never what the author meant.

The severity set can grow later — V-06a ships the skeleton and the
checks above.

## CLI surface

Add a new command, `pgrest-lambda lint-policies`, following the
existing CLI conventions in `bin/pgrest-lambda.mjs` (thin wrapper over a
library primitive, flags parsed via the existing `parseFlags` helper,
exit codes documented in the `cli.md` reference).

```
pgrest-lambda lint-policies [path]

Flags:
  --path <path>         Directory of .cedar files. Default: ./policies
                        (or $POLICIES_PATH if set). S3 URIs supported
                        if the existing loader already does — reuse
                        whatever cedar.mjs uses.
  --format <fmt>        "text" (default) or "json".
  --max-severity <lvl>  "error" (default) — exit non-zero on errors only.
                        "warn" — exit non-zero on warnings and errors.
                        "off" — never exit non-zero; lint is advisory.
  --quiet               Suppress zero-finding output (useful in CI).
```

Exit codes:
- `0` — clean (or `--max-severity=off`).
- `1` — lint findings above the severity threshold.
- `2` — usage error (policy directory missing, unreadable, etc.).

Text output: one finding per line, `<file>:<line> <severity> <rule-id>
<message>`. Summary footer: `N policies scanned, E errors, W warnings`.

JSON output: `{ "summary": { ... }, "findings": [{ file, line, severity,
rule, message }, ... ] }`.

## Where the logic lives

1. **Library primitive** — `src/policies/linter.mjs` exports
   `lintPolicies({ path })` returning `{ findings, summary }`. Reuses
   the Cedar policy-parsing surface we already import in
   `src/rest/cedar.mjs`. The linter is pure (no process exit, no
   stdout); the CLI composes it.
2. **CLI** — new `cmdLintPolicies` in `bin/pgrest-lambda.mjs`, wired
   into `COMMANDS` and `cmdHelp()`. Formats findings, resolves the
   severity threshold, exits appropriately.
3. **Tests** — unit tests in `src/policies/__tests__/linter.test.mjs`
   with fixture policies for every rule (happy path + violation per
   rule). A small CLI smoke test that runs the binary against a fixture
   directory and asserts exit code + stdout shape.

## Documentation updates

1. **`docs/reference/cli.md`** — new `### pgrest-lambda lint-policies`
   section after `generate-key`, matching the existing command-doc
   template (Flags, Exit codes, Example). Add to "See also" the
   write-cedar-policies guide.
2. **`docs/guide/write-cedar-policies.md`** — new "Step 5 — Lint the
   policy" section between current Step 4 (Verify) and Debugging.
   Make it concrete: show a sample violation, the command, the
   expected output, and the CI snippet. Note that the linter is
   advisory by default but should be wired into CI.
3. **`docs/reference/authorization.md`** — if there is a Recipes or
   Pitfalls section, add a cross-link to the linter and list the
   rule IDs.
4. **`CHANGELOG.md`** — under Unreleased → Security, note V-06a is
   closed and the linter is opt-in via the CLI, not mandatory at
   runtime.
5. **`docs/security/findings/V-06-no-rls.md`** — do NOT flip the
   overall V-06 status to Fixed. Add an "Evidence (partial — linter)"
   entry pointing at the commit and CLI command; call out that RLS
   and the INSERT fail-open remain.

## Skill guidance

Add linter awareness to the existing agent skill set in `.kiro/skills/`.
Two touchpoints:

1. **New skill: `.kiro/skills/cedar-policy-author/SKILL.md`** — short
   skill (one page) that authoritatively guides an agent that is
   writing or editing Cedar policies. Frontmatter: `name:
   cedar-policy-author`, `description: Use when creating or editing
   files under policies/ (*.cedar) in pgrest-lambda.` Content:
   - Reference `docs/guide/write-cedar-policies.md` for the idiomatic
     shapes.
   - **Mandate running `pgrest-lambda lint-policies` before finishing
     any change**, unless the environment cannot run the CLI; in
     that case, hand-verify against the rule list in the linter
     source (`src/policies/linter.mjs`) or the CLI doc.
   - Call out the service-role bypass exception explicitly — agents
     must not "fix" the unconditional service-role permit, which is
     the documented magic case.
2. **Existing skills that touch policies** — if any of
   `design-author`, `design-audit`, `task-author`, `task-audit` already
   mention Cedar, add a single line: "If the feature involves new or
   edited `.cedar` policy files, add a task step that runs
   `pgrest-lambda lint-policies` after the policy change and before
   marking the task complete." No broader rework — just thread the
   linter step in so future rring loops pick it up.

## Out of scope

- RLS template / backend-split doc (V-06b).
- `cedar.mjs:488-490` INSERT fail-open investigation (V-06c).
- Policy-linting as a hard gate at runtime inside `createPgrest` —
  this was considered and deferred. The linter is CLI-only for now
  because a hard runtime gate risks bricking deployments on minor rule
  additions.
- Real-time linting in the dev server (`pgrest-lambda dev`). Could be
  a nice follow-up but is not in this scope.

## Success criteria

- `pgrest-lambda lint-policies` runs cleanly on `policies/default.cedar`
  (zero findings, exit 0).
- Every documented rule has a passing unit test against a fixture
  violation and a fixture-clean case.
- CI-friendly: `--max-severity=warn --format=json` produces parseable
  output.
- `docs/reference/cli.md`, `docs/guide/write-cedar-policies.md`,
  `CHANGELOG.md` all updated.
- `.kiro/skills/cedar-policy-author/SKILL.md` exists and references the
  linter.
- V-06 finding file reflects the partial closure (NOT flipped to Fixed
  overall).
- Full test suite green (`npm test`).