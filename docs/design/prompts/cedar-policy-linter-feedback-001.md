This is a response to the code review in docs/code-review/cedar-policy-linter.md.

# V-06a feedback 001 — close code review gaps

Address the actionable findings from the code review in
`docs/code-review/cedar-policy-linter.md`. The reviewer confirmed the
implementation matches the design and all 807 tests pass. This
iteration closes the real bugs and the highest-value test gaps only.

## In scope

### 1. Fix E004 early-return bug (correctness)

`src/policies/linter.mjs:127` — `checkE004` returns on the first
unknown action entity it finds. Cedar policies with
`action in [PgrestLambda::Action::"nuke",
PgrestLambda::Action::"yeet"]` should surface BOTH unknowns as
separate E004 findings. Change the function to accumulate all
findings into an array (same shape as W003 does) and return the
array.

Add test `test_e004_reports_all_unknown_actions_in_list` to the
existing E004 describe block.

### 2. Complete `RULE_NAME_TO_ID` (correctness / sustainability)

`src/policies/linter.mjs:251-253` — the map has only one entry
(`unconditional-permit -> E001`). `@lint_allow("tautological-when")`
would silently fail to suppress E002 because there is no mapping.
Add entries for every rule that has a human name in its help text:

```
unconditional-permit -> E001
tautological-when    -> E002
syntax-error         -> E003
unknown-action       -> E004
principal-type-missing -> W001
resource-type-missing  -> W002
missing-has-guard      -> W003
forbid-without-scope   -> W004
```

Add one test per rule asserting the human name suppresses the
matching rule ID: `test_lint_allow_by_human_name_suppresses_each_rule`
(parameterized is fine, or one test per rule — whichever is cleaner).

### 3. Add E003 suppression-limitation test (test quality)

`@lint_allow("E003")` cannot suppress a syntax error because
annotations are only available after parsing succeeds. Document this
with a test:
`test_lint_allow_cannot_suppress_e003_syntax_errors`. If Cedar parses
annotations on otherwise-invalid files, the test may prove this case
can actually be suppressed — in which case update the linter OR
document the exception. Either way, the test must pin the behavior.

### 4. Add warnings-only CLI fixture + test (test quality)

`--max-severity warn` exiting 1 is currently only tested against a
directory that also contains errors, so the test proves nothing
about warnings alone. Add a `warningsOnlyDir` test fixture
containing only `w001-violation.cedar`, and add
`test_cli_max_severity_warn_exits_1_on_warnings_only` exercising the
warn-only path.

### 5. Add forbid-specific tests for W001 and E002 (test quality)

- `test_w001_fires_on_forbid_with_unscoped_principal` — assert W001
  fires on `forbid(principal, action == ..., resource is ...)` and
  W004 does not (action is narrowed).
- `test_e002_does_not_fire_on_forbid_with_tautology` — assert
  `forbid(principal, action, resource) when { true }` emits zero
  E002 (E002 is permit-only by design).

### 6. Add service-role == bypass test (test quality)

`isServiceRoleBypass` supports both `is` and `==` on the
ServiceRole entity type, but only the `is` form is tested. Add
`test_e001_service_role_bypass_via_equality` with
`permit(principal == PgrestLambda::ServiceRole::"svc", action, resource);`
and assert zero E001 findings.

### 7. Fix the guide pluralization (docs)

`docs/guide/write-cedar-policies.md` — the example output shows
`1 policy scanned`; the CLI actually prints `1 policies scanned`.
Either fix the CLI to pluralize correctly (preferred — cheap fix in
`bin/pgrest-lambda.mjs:279` with `count === 1 ? 'policy' : 'policies'`
plus a CLI test) or update the doc to match the current output. Pick
the CLI-side fix: it's better UX and the cost is one ternary.

Add `test_cli_summary_pluralization` asserting:
- 0 policies → `"0 policies scanned"`
- 1 policy → `"1 policy scanned"`
- 2 policies → `"2 policies scanned"`

## Out of scope

- The "collectColumnAccess set/record literal" speculative gap — the
  reviewer noted it may be unreachable given Cedar's grammar; defer
  until someone writes a policy that trips it.
- Extracting rule functions for unit-test-level isolation — useful
  future refactor, not blocking.
- Better `findPolicyLine` fallback than `line: 0` — acceptable
  graceful degradation for now.
- The mixed clean/dirty filename-attribution test (reviewer noted
  `>=` assertions are fuzzy — true, but low-risk; skip).

## Success criteria

- E004 reports every unknown action in a list, not just the first.
- `RULE_NAME_TO_ID` maps every rule's human name to its ID.
- CLI summary uses singular "policy" for count 1, plural otherwise.
- All new tests pass.
- Full suite stays green (currently 807 tests).
- No changes to the 8-rule set, severity levels, or CLI flag surface.