# Task 06: Error Codes Documentation

Agent: implementer
Design: docs/design/resource-embedding.md
Depends on: Task 04

## Objective

Document the PGRST200 and PGRST201 error codes in
`errors.mjs` for discoverability. No new error class or
runtime code is needed — these codes are used directly by
the relationship resolver in `sql-builder.mjs`.

## Target Tests

From Task 01:
- Error: no relationship found (PGRST200)
- Error: ambiguous relationship (PGRST201)

These tests are already targeted by Task 04 (where the
errors are thrown). This task only adds documentation
comments.

## Implementation

### File: `src/rest/errors.mjs`

Add comments after the `PG_ERROR_MAP` object documenting
the PostgREST-specific error codes used by resource
embedding:

```javascript
// PostgREST-compatible error codes used by resource embedding
// (thrown directly via PostgRESTError, not mapped from PG):
//
// PGRST200 — Could not find a relationship between tables
//            HTTP 400. Thrown when an embed name doesn't match
//            any FK relationship, or when a !hint matches zero
//            relationships.
//
// PGRST201 — Ambiguous relationship (multiple matches)
//            HTTP 300. Thrown when multiple FK relationships
//            exist between two tables and no !hint is provided,
//            or the hint still matches multiple. Response
//            includes details array and hint suggestion.
//
// PGRST204 — Column not found (already used by sql-builder
//            for flat selects; also applies to columns inside
//            embed select lists)
```

## Acceptance Criteria

- Comments are present in `errors.mjs`
- No runtime behavior changes
- Existing tests still pass

## Conflict Criteria

- If the PGRST200/PGRST201 codes are already documented,
  verify the documentation is accurate and update if needed
  rather than duplicating.
