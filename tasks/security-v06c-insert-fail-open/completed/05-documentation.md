# Task 05 -- Documentation Updates

**Agent:** implementer
**Design:** docs/design/security-v06c-insert-fail-open.md
**Depends on:** Task 04

## Objective

Update security findings, reference docs, and changelog to
reflect the V-06c fix.

## Target Tests

None -- documentation-only task.

## Implementation

### 1. `docs/security/findings/V-06-no-rls.md`

Add a subsection for V-06c. State:
- The fail-open in `authorize()` for INSERT residuals is
  closed.
- INSERT now uses `authorizeInsert()` which evaluates
  row-conditioned policies against the proposed row
  in-process (Option A).
- The fix is DSQL-compatible (no SQL dependency).
- Reference the design document for full details.

### 2. `docs/security/assessment.md`

Find the V-06 entry. Add a note that V-06c (INSERT fail-open)
is closed. Keep V-06b (optional RLS templates) as open/future.

### 3. `docs/reference/authorization.md`

Add a section on INSERT authorization behavior:
- INSERT uses two-phase authorization: table-level check
  then residual evaluation against the proposed row.
- Row-conditioned `permit` policies must have their `when`
  conditions satisfied by the proposed row data.
- Row-conditioned `forbid` policies deny the INSERT if
  their conditions match the proposed row.
- Missing columns fail-closed (treated as deny).
- Bulk inserts are checked per-row; if any row fails, the
  entire batch is rejected.
- Service-role bypass is unchanged.

### 4. `docs/guide/write-cedar-policies.md`

Add a note under the INSERT policy section:
- Row-conditioned INSERT policies (e.g.,
  `resource.owner_id == principal`) are now enforced at the
  application layer against the proposed row data.
- The `resource.<col>` in a `when` clause refers to the
  value being inserted, not an existing database row.
- If the proposed row omits a column referenced by the
  policy, the INSERT is denied (fail-closed).

### 5. `CHANGELOG.md`

Add an entry under `Unreleased` → `Security`:

```markdown
### Security

- **V-06c**: Close Cedar INSERT fail-open -- row-conditioned
  INSERT policies are now evaluated against the proposed row
  data in-process, preventing authorization bypass on DSQL
  deployments where Cedar is the only authorization layer.
```

## Acceptance Criteria

- All five files are updated.
- No production code changes.
- `npm test` still passes (sanity check).

## Conflict Criteria

- If any of the target documentation files do not exist,
  create them with appropriate structure matching nearby
  files. If the directory structure is unexpected, escalate.
- If `CHANGELOG.md` does not have an `Unreleased` section,
  add one at the top following the keepachangelog format.
