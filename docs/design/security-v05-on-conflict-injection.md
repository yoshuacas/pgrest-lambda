# V-05 — `on_conflict` Column Validation

Route `on_conflict` identifiers through the existing `validateCol`
allowlist to close security finding V-05 (High).

Reference: `docs/security/findings/V-05-on-conflict-injection.md`
Source: `docs/design/prompts/security-v05-on-conflict-injection.md`

## Problem

`src/rest/sql-builder.mjs:444-448` was the only identifier path in
that file that did not run through `validateCol(schema, table, col)`.
Comma-split + double-quote is not a substitute for allowlist
validation; an embedded `"` can break the quoting and bogus
identifiers leak schema information through DB error messages.

## Approach

Insert `validateCol(schema, table, c.trim())` into the existing
`.map()` that builds the conflict-column list. No helper changes,
no new error path — `validateCol` already throws `PostgRESTError`
mapped to 400 by the handler.

## Change

```javascript
if (parsed.onConflict) {
  const conflictCols = parsed.onConflict
    .split(',')
    .map((c) => `"${validateCol(schema, table, c.trim())}"`)
    .join(', ');
```

## Tests

Added to `src/rest/__tests__/sql-builder.test.mjs`:

- Single valid column produces `ON CONFLICT ("email") DO ...`.
- Multi-column valid list: `on_conflict="email,tenant_id"`.
- Unknown column throws `PostgRESTError`.
- SQL-breakout payload (`email"; DROP TABLE x; --`) throws.
- Whitespace is trimmed and validated identically to the
  no-whitespace case.

## Non-goals

- No refactor of `buildInsert` or the `pk`/`updateCols` logic.
  Those iterate columns that are already validated upstream.
- No change to the error shape — reuses `PostgRESTError` and the
  existing handler mapping to 400.
- No README change — this is transparent to the PostgREST-
  compatible API surface.

## Constraints satisfied

- Zero behavior change for valid input.
- All 416+ existing tests pass.
- Identifier validation is now consistent across every
  identifier-interpolating site in `sql-builder.mjs`.
