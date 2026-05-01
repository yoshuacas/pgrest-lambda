# V-06a Feedback 001 — Close Code Review Gaps

Address the actionable findings from the code review in
`docs/code-review/cedar-policy-linter.md`. The reviewer confirmed
the implementation matches the design and all 807 tests pass. This
iteration closes the real bugs and the highest-value test gaps.

Source: `docs/design/prompts/cedar-policy-linter-feedback-001.md`
Parent design: `docs/design/cedar-policy-linter.md`
Code review: `docs/code-review/cedar-policy-linter.md`

## Overview

Seven targeted changes: two correctness fixes in
`src/policies/linter.mjs`, one documentation fix in
`docs/guide/write-cedar-policies.md` with a corresponding CLI
fix in `bin/pgrest-lambda.mjs`, and ten new tests across the
linter test suite. No new rules, no new CLI flags, no changes
to the Cedar WASM API surface.

## Current CX / Concepts

### E004 Reports Only the First Unknown Action

`checkE004` in `src/policies/linter.mjs:127` iterates
action entities but returns on the first unknown it finds.
A policy with
`action in [PgrestLambda::Action::"nuke", PgrestLambda::Action::"yeet"]`
surfaces only `nuke`. The developer must fix-and-re-lint to
discover `yeet`. This differs from `checkW003`, which
accumulates all findings into an array.

### `RULE_NAME_TO_ID` Is Incomplete

`src/policies/linter.mjs:251-253` maps only
`"unconditional-permit"` to `"E001"`. The `@lint_allow`
annotation accepts human-readable rule names (e.g.,
`@lint_allow("tautological-when")`), but the map lookup
falls through to the raw string for all rules except E001.
Result: `@lint_allow("tautological-when")` silently fails
to suppress E002.

### CLI Summary Never Singularizes "policy"

`bin/pgrest-lambda.mjs:279` always prints `policies`
regardless of count. The guide at
`docs/guide/write-cedar-policies.md:144` shows `1 policy
scanned` (singular), but the CLI actually outputs `1
policies scanned`. Neither matches the other.

### Missing Test Coverage

The code review identified six test gaps:

1. E004 with multiple unknown actions in a single list.
2. `@lint_allow` by human name for every rule.
3. `@lint_allow("E003")` on syntax errors (inherent
   limitation: annotations require successful parsing).
4. `--max-severity warn` with a warnings-only directory.
5. W001 on `forbid` policies; E002 exclusion of `forbid`.
6. Service-role bypass via `==` operator (only `is` is
   tested).

## Proposed CX / CX Specification

### 1. E004 Reports All Unknown Actions

Before:

```
policies/bad.cedar:1 error E004 Unknown action 'nuke'. Valid actions: select, insert, update, delete, call.
1 policy scanned, 1 error, 0 warnings
```

After:

```
policies/bad.cedar:1 error E004 Unknown action 'nuke'. Valid actions: select, insert, update, delete, call.
policies/bad.cedar:1 error E004 Unknown action 'yeet'. Valid actions: select, insert, update, delete, call.
1 policy scanned, 2 errors, 0 warnings
```

Each unknown action in the list produces its own finding.
The message format is unchanged. The `file` and `line`
fields are the same for all findings from the same policy.

### 2. `@lint_allow` Accepts Human Names for All Rules

The following human names now map to rule IDs:

| Human name | Rule ID |
|---|---|
| `unconditional-permit` | `E001` |
| `tautological-when` | `E002` |
| `syntax-error` | `E003` |
| `unknown-action` | `E004` |
| `principal-type-missing` | `W001` |
| `resource-type-missing` | `W002` |
| `missing-has-guard` | `W003` |
| `forbid-without-scope` | `W004` |

Example:

```cedar
@lint_allow("tautological-when,principal-type-missing")
permit(principal, action, resource) when { true };
```

This suppresses E002 and W001. Both the human name and
the rule ID continue to work. Mixing is allowed (e.g.,
`@lint_allow("E001,principal-type-missing")`).

Note: `@lint_allow("syntax-error")` / `@lint_allow("E003")`
cannot suppress E003 in practice because annotations are
only available after parsing succeeds. If the file fails
`checkParsePolicySet`, annotations are never extracted. The
mapping exists for completeness but has no practical effect
on syntax errors.

### 3. CLI Summary Pluralization

| Count | Output |
|---|---|
| 0 | `0 policies scanned, ...` |
| 1 | `1 policy scanned, ...` |
| 2+ | `N policies scanned, ...` |

The JSON output is unchanged (`policiesScanned` is always
a number).

### 4. Guide Example Matches CLI

`docs/guide/write-cedar-policies.md` line 144 shows:

```text
1 policy scanned, 1 error, 0 warnings
```

After the CLI pluralization fix, the CLI outputs `1 policy`
(singular for count 1), `1 error` (singular for count 1),
and `0 warnings` (plural for count 0). The guide example
is already correct. No change needed.

## Technical Design

### Fix 1: `checkE004` — Accumulate All Findings

Change `checkE004` in `src/policies/linter.mjs` from
returning a single finding to accumulating findings in
an array, matching the `checkW003` pattern.

Current code (lines 127-141):

```javascript
function checkE004(json) {
  const entities = extractActionEntities(json.action);
  for (const entity of entities) {
    const id = entity?.__entity?.id ?? entity?.id;
    const type = entity?.__entity?.type ?? entity?.type;
    if (type === "PgrestLambda::Action" && id
        && !KNOWN_ACTIONS.has(id)) {
      return {
        severity: "error",
        rule: "E004",
        message: `Unknown action '${id}'. ...`,
      };
    }
  }
  return null;
}
```

New code:

```javascript
function checkE004(json) {
  const findings = [];
  const entities = extractActionEntities(json.action);
  for (const entity of entities) {
    const id = entity?.__entity?.id ?? entity?.id;
    const type = entity?.__entity?.type ?? entity?.type;
    if (type === "PgrestLambda::Action" && id
        && !KNOWN_ACTIONS.has(id)) {
      findings.push({
        severity: "error",
        rule: "E004",
        message: `Unknown action '${id}'. Valid actions: `
          + `select, insert, update, delete, call.`,
      });
    }
  }
  return findings.length ? findings : null;
}
```

The caller in `lintPolicies` already handles arrays via
`Array.isArray(result)` at line 333, so no changes needed
there.

### Fix 2: Complete `RULE_NAME_TO_ID`

Replace the single-entry map at `src/policies/linter.mjs:251-253`:

```javascript
const RULE_NAME_TO_ID = {
  "unconditional-permit": "E001",
  "tautological-when": "E002",
  "syntax-error": "E003",
  "unknown-action": "E004",
  "principal-type-missing": "W001",
  "resource-type-missing": "W002",
  "missing-has-guard": "W003",
  "forbid-without-scope": "W004",
};
```

`getSuppressedRules` at line 52 already calls
`RULE_NAME_TO_ID[trimmed] || trimmed`, so no other code
changes are needed.

### Fix 3: CLI Summary Pluralization

In `bin/pgrest-lambda.mjs`, the text-mode summary line
(line 279) changes from:

```javascript
`${summary.policiesScanned} policies scanned, `
+ `${summary.errors} errors, `
+ `${summary.warnings} warnings`,
```

to:

```javascript
`${summary.policiesScanned} ${summary.policiesScanned === 1 ? 'policy' : 'policies'} scanned, `
+ `${summary.errors} ${summary.errors === 1 ? 'error' : 'errors'}, `
+ `${summary.warnings} ${summary.warnings === 1 ? 'warning' : 'warnings'}`,
```

All three nouns (policy/policies, error/errors,
warning/warnings) get singular/plural treatment for
consistency.

### Fix 4: Guide Example

`docs/guide/write-cedar-policies.md` line 144 shows
`1 policy scanned` (singular). After the CLI pluralization
fix, the CLI will also output `1 policy scanned` for a
single-policy run. The guide is already correct — no
change needed.

## Testing Strategy

All new tests go in
`src/policies/__tests__/linter.test.mjs`, using the
existing `node:test` + `assert/strict` setup.

### Test 1: `test_e004_reports_all_unknown_actions_in_list`

**Location:** `linter — E004 unknown-action` describe block.

**Setup:** Inline policy:
```cedar
permit(
    principal is PgrestLambda::User,
    action in [
        PgrestLambda::Action::"nuke",
        PgrestLambda::Action::"yeet"
    ],
    resource is PgrestLambda::Row
);
```

**Assertions:**
- `findFindings(findings, 'E004').length === 2`
- One finding message matches `/'nuke'/`
- One finding message matches `/'yeet'/`

### Test 2: `test_lint_allow_by_human_name_suppresses_each_rule`

**Location:** `linter — annotation suppression` describe
block.

**Approach:** One sub-test per rule. For each rule, create
an inline policy that would trigger the rule, add
`@lint_allow("<human-name>")`, and assert 0 findings for
that rule ID.

| Human name | Triggering policy | Rule suppressed |
|---|---|---|
| `unconditional-permit` | `permit(principal, action, resource);` | E001 |
| `tautological-when` | `permit(principal, action, resource) when { true };` | E002 |
| `unknown-action` | `permit(principal is PgrestLambda::User, action == PgrestLambda::Action::"nuke", resource is PgrestLambda::Row);` | E004 |
| `principal-type-missing` | `permit(principal, action == PgrestLambda::Action::"select", resource is PgrestLambda::Row) when { context.table == "x" };` | W001 |
| `resource-type-missing` | `permit(principal is PgrestLambda::User, action == PgrestLambda::Action::"select", resource) when { context.table == "x" };` | W002 |
| `missing-has-guard` | `permit(principal is PgrestLambda::User, action == PgrestLambda::Action::"select", resource is PgrestLambda::Row) when { resource.col == "x" };` | W003 |
| `forbid-without-scope` | `forbid(principal, action, resource);` | W004 |

E003 (`syntax-error`) is covered by Test 3 below — it
cannot be suppressed via annotation.

### Test 3: `test_lint_allow_cannot_suppress_e003_syntax_errors`

**Location:** `linter — annotation suppression` describe
block.

**Setup:** Inline file:
```cedar
@lint_allow("E003")
permit(principal, action, resource
```
(missing closing paren and semicolon)

**Assertions:**
- At least 1 E003 finding is reported.
- The `@lint_allow("E003")` annotation does not suppress
  it.

Note: If Cedar parses annotations on otherwise-invalid
policy text (returning the annotation even though the body
fails), this test may reveal that E003 CAN be suppressed.
In that case, the test documents the actual behavior. The
test's purpose is to pin behavior, not to enforce a
specific outcome. If it turns out E003 is suppressible,
that is acceptable — the test should assert the actual
behavior and a comment should note the finding.

### Test 4: `test_cli_max_severity_warn_exits_1_on_warnings_only`

**Location:** `CLI smoke tests — lint-policies` describe
block.

**Setup:** Add `warningsOnlyDir` to `beforeEach` using
`fixtureDir('w001-violation.cedar')`. The
`w001-violation.cedar` fixture triggers W001 (warning) but
not E001 (the action is narrowed to `select`).

**Assertions:**
- `runCli(['--path', warningsOnlyDir, '--max-severity', 'warn'])`
  returns `exitCode === 1`.
- `runCli(['--path', warningsOnlyDir])` returns
  `exitCode === 0` (warnings alone do not exceed the
  default `--max-severity error` threshold).

### Test 5a: `test_w001_fires_on_forbid_with_unscoped_principal`

**Location:** `linter — W001 principal-type-missing`
describe block.

**Setup:** Inline policy:
```cedar
forbid(
    principal,
    action == PgrestLambda::Action::"delete",
    resource is PgrestLambda::Row
);
```

**Assertions:**
- 1 W001 finding (principal is `op: "All"`).
- 0 W004 findings (action is narrowed, so not fully
  unscoped).

### Test 5b: `test_e002_does_not_fire_on_forbid_with_tautology`

**Location:** `linter — E002 tautological-when` describe
block.

**Setup:** Inline policy:
```cedar
forbid(principal, action, resource) when { true };
```

**Assertions:**
- 0 E002 findings (E002 only fires on `permit`).
- W001, W002, and W004 findings may be present (this
  test only asserts the absence of E002).

Note: W004 should NOT fire here because the policy has a
`when` clause (`conditions.length > 0`). The test may
optionally verify this, but the primary assertion is the
E002 absence.

### Test 6: `test_e001_service_role_bypass_via_equality`

**Location:** `linter — E001 unconditional-permit` describe
block.

**Setup:** Inline policy:
```cedar
permit(
    principal == PgrestLambda::ServiceRole::"svc",
    action,
    resource
);
```

**Assertions:**
- 0 E001 findings (service-role bypass detected via `==`).
- 0 W002 findings (service-role bypass exempts W002).

Note: W001 should NOT fire because `principal` has
`op: "=="`, not `op: "All"`. The test may optionally
verify 0 W001 findings.

### Test 7: `test_cli_summary_pluralization`

**Location:** `CLI smoke tests — lint-policies` describe
block.

**Setup:** Three scenarios using `runCli`:

1. **0 policies:** Create an inline dir with a single
   valid `.cedar` file containing zero policies — this is
   not possible since a file must contain at least one
   policy to be valid Cedar. Instead, use a directory
   where all files are empty (skipped) plus one valid
   file. Actually, the simplest approach: use
   `fixtureDir('clean.cedar')` which has 2+ policies —
   this verifies plural. For singular, create an inline
   dir with exactly one policy. For zero, the CLI exits 2
   on empty dirs, so `0 policies scanned` only appears
   when all policies fail parsing. Use a dir with one
   syntax-error file (0 scanned, E003 reported).

   Revised approach:

   a. **1 policy:** Inline dir with one valid single-policy
      file. Assert stdout matches `/1 policy scanned/`.
   b. **2 policies:** Use `fixtureDir('clean.cedar')`.
      Assert stdout matches `/\d+ policies scanned/`
      (plural).
   c. **1 error:** Inline dir with one E001-triggering
      policy. Assert stdout matches `/1 error/` (not
      `1 errors`).
   d. **1 warning:** Use `fixtureDir('w001-violation.cedar')`.
      Assert stdout matches `/1 warning[^s]/` or
      `/1 warning\b/`.

**Assertions:** Each sub-case verifies the correct
singular/plural form in stdout.

## Code Architecture / File Changes

### Modified Files

| File | Change |
|---|---|
| `src/policies/linter.mjs` | Fix `checkE004` to accumulate findings; complete `RULE_NAME_TO_ID` |
| `bin/pgrest-lambda.mjs` | Add singular/plural ternaries to summary line |
| `src/policies/__tests__/linter.test.mjs` | Add 10 new tests across existing describe blocks |

### Files That Do NOT Change

- `docs/guide/write-cedar-policies.md` — the guide already
  shows `1 policy scanned` (singular). After the CLI fix,
  this is now correct. No update needed.
- `src/rest/cedar.mjs` — no runtime changes.
- `package.json` — no new dependencies.
- `docs/reference/cli.md` — no CLI flag changes.
- `CHANGELOG.md` — these are bug fixes within the same
  feature branch; changelog was already updated for V-06a.

## Implementation Order

### Phase 1: Correctness Fixes

1. Fix `checkE004` in `src/policies/linter.mjs` to
   accumulate findings.
2. Complete `RULE_NAME_TO_ID` in `src/policies/linter.mjs`.
3. Fix pluralization in `bin/pgrest-lambda.mjs`.

### Phase 2: Tests

4. Add `test_e004_reports_all_unknown_actions_in_list`.
5. Add `test_lint_allow_by_human_name_suppresses_each_rule`
   (7 sub-tests, one per suppressible rule).
6. Add `test_lint_allow_cannot_suppress_e003_syntax_errors`.
7. Add `test_cli_max_severity_warn_exits_1_on_warnings_only`
   with `warningsOnlyDir` fixture.
8. Add `test_w001_fires_on_forbid_with_unscoped_principal`.
9. Add `test_e002_does_not_fire_on_forbid_with_tautology`.
10. Add `test_e001_service_role_bypass_via_equality`.
11. Add `test_cli_summary_pluralization`.

### Phase 3: Verify

12. Run full test suite (`npm test`) — all 807 existing
    tests plus ~10 new tests must pass.

## Open Questions

None. All decisions are made in the feedback prompt.
