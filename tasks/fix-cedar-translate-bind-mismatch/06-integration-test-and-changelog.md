# Task 06 -- Integration Test and Changelog

**Agent:** implementer
**Design:** docs/design/fix-cedar-translate-bind-mismatch.md
**Depends on:** Tasks 02, 03, 04, 05

## Objective

Verify the end-to-end fix via the buildAuthzFilter
integration test (Test 10 from Task 01) and update
CHANGELOG.md.

## Target Tests

From Task 01:
- Test 10: Issue #4 policy -- partial collapse, placeholder
  count matches values

## Implementation

### Verify Test 10 Passes

Test 10 exercises `buildAuthzFilter` with a policy where
one branch of a disjunction collapses (referencing a column
the table lacks) and the other survives. After Tasks 02-05,
the returned `conditions` and `values` arrays should have
matching placeholder counts.

If Test 10 was written in Task 01 as part of the
`buildAuthzFilter` describe block, it should now pass
without additional production code changes. Verify by
running:

```bash
npm test -- --test-name-pattern="bind"
```

### Update CHANGELOG.md

Add a bullet under the `## [Unreleased]` / `### Fixed`
section:

```markdown
### Fixed

- Fix bind-parameter mismatch in Cedar policy-to-SQL
  translation when branch operators discard sub-expressions
  that already pushed values ([#4](https://github.com/yoshuacas/pgrest-lambda/issues/4))
```

If a `### Fixed` subsection does not exist under
`## [Unreleased]`, create it after any existing subsections
(Added, Changed, etc.).

## Test Requirements

Run the full test suite to confirm no regressions:

```bash
npm test
```

All tests must pass, including:
- The 9 unit tests from Task 01 (bind-parameter correctness)
- Test 10 (buildAuthzFilter integration)
- All pre-existing tests in `cedar.test.mjs` and
  `sql-builder.test.mjs`

## Acceptance Criteria

- Test 10 passes.
- Full test suite passes with zero failures.
- CHANGELOG.md updated with the fix reference.

## Conflict Criteria

- If Test 10 still fails after Tasks 02-05 are complete,
  the issue may be in `buildAuthzFilter`'s `tempValues`
  slicing logic rather than `translateExpr`. Investigate
  whether the pre-seeded array interacts with
  `values.length` truncation. The design specifies no
  change to `buildAuthzFilter` is needed -- if one IS
  needed, escalate.
- If existing tests that previously passed now fail,
  identify which operator change caused the regression
  and whether it's a test that relied on the buggy
  behavior (unlikely, but possible).
