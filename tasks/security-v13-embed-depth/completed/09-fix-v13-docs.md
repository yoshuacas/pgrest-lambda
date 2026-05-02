# Task 09: Fix V-13 Documentation Issues

**Agent:** maintainer
**Design:** docs/design/security-v13-embed-depth.md
**Review:** docs/code-review/security-v13-embed-depth.md

## Objective

Fix the two documentation issues in the V-13 security
finding identified by the code review: the stale commit
hash in the evidence section, and the present-tense
vulnerability description in the analysis section.

## Problem 1: Stale commit hash

The evidence section in
`docs/security/findings/V-13-embed-depth.md` (line 28)
references commit `0e7d775`. This is a feature-branch
commit. If the branch is squash-merged (as CLAUDE.md
recommends), this hash will not exist on main and the
evidence link becomes a dead reference.

## Problem 2: Present-tense analysis

The "Our analysis" section (lines 16-20) says "fixed at
HEAD" but describes the vulnerability in present tense
("`parseSelectList(input)` recurses ... with no depth
argument. Unbounded."). The description should clarify
this was the pre-fix state.

## Implementation

### docs/security/findings/V-13-embed-depth.md

**Evidence section (line 28):** Replace the specific commit
hash with a branch reference or a description that survives
squash-merge:

```markdown
## Evidence

Branch `fix/v13-embed-depth` -- adds `depth` parameter to
`parseSelectList` with a default limit of 5, throwing
PGRST100 on overflow.
```

**Analysis section (lines 16-20):** Rewrite to use past
tense, making clear this describes the pre-fix state:

```markdown
## Our analysis

**Status: fixed at HEAD.**

Prior to the fix:
- `src/rest/query-parser.mjs` -- `parseSelectList(input)`
  recursed with no depth argument. Unbounded.
- `MAX_NESTING_DEPTH = 10` was enforced for logical groups
  (`parseLogicalGroup`) but not for embeds. Asymmetry.
- `src/rest/sql-builder.mjs` -- `buildEmbedSubquery` built
  correlated subqueries whose planner cost grew with depth.

**Fix surface:** added `depth` and `maxEmbedDepth` params
to `parseSelectList`, increment on embed recursion, throw
PGRST100 at `depth > maxEmbedDepth`. Default 5;
configurable via factory.
```

## Target Tests

No automated tests -- documentation only.

## Acceptance Criteria

- Evidence section does not reference a specific commit
  hash that may not survive squash-merge.
- Analysis section uses past tense for the vulnerability
  description.
- No formatting inconsistencies with surrounding content.
- Word wrap at 72 columns.

## Conflict Criteria

- If the evidence section has already been updated to
  remove the commit hash, skip that change.
- If the analysis section is already in past tense, skip
  that change.
