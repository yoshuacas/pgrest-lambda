# Task 04: Update Security Tracker and Configuration Docs

**Agent:** implementer
**Design:** docs/design/security-v13-embed-depth.md

## Objective

Update the V-13 finding status to Fixed, flip the
assessment row, and document the new `maxEmbedDepth`
config key.

## Target Tests

No automated tests. This task modifies documentation only.

## Implementation

### docs/security/findings/V-13-embed-depth.md

Change the Status field from `Open` to `Fixed`. Update the
Evidence section with a reference to the implementing
commit (use the most recent commit on the current branch
that touches `query-parser.mjs`). Update the Reviewer
handoff to note that the fix is in place and ready for
verification.

### docs/security/assessment.md

Change the V-13 row (line 47) from:

```
| [V-13](findings/V-13-embed-depth.md) | Medium | Unbounded resource embedding depth | Open | Confirmed; no depth arg |
```

to:

```
| [V-13](findings/V-13-embed-depth.md) | Medium | Unbounded resource embedding depth | Fixed | Depth limit added to parseSelectList |
```

### docs/reference/configuration.md

Add a row to the Core config table for `maxEmbedDepth`.
Place it after the existing config rows, following the
same 5-column format:

```
| maxEmbedDepth | PGREST_MAX_EMBED_DEPTH | No | 5 | Maximum embed nesting depth in select parameters. |
```

## Acceptance Criteria

- V-13 finding shows status Fixed.
- Assessment table row shows Fixed.
- Configuration reference includes the new config key
  with correct env var name, default, and description.
- No formatting inconsistencies with surrounding content.

## Conflict Criteria

- If V-13 is already marked Fixed, verify the evidence
  section references the correct commit and skip
  redundant changes.
- If `maxEmbedDepth` is already in configuration.md,
  verify accuracy and skip.
