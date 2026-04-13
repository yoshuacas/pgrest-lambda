Fix two supabase-js insert bugs reported by a real user application.
Both are blocking for apps that use standard insert-then-use patterns.

Reference: /Users/davcasd/research/test/sampleapp412/feedback/pgrest-lambda-bulk-insert.md

## Bug 1: Bulk insert fails — `columns` query param not recognized

When `@supabase/supabase-js` inserts an array of objects, it adds a
`columns` query parameter:

```
POST /rest/v1/bill_splits?columns="bill_id","user_id","amount","paid"
Content-Type: application/json
Body: [{"bill_id":"123","user_id":"abc","amount":25,"paid":false}, ...]
```

pgrest-lambda does not recognize `columns` as a reserved parameter.
The query parser in `query-parser.mjs` treats it as a filter column
name and tries to parse `"bill_id","user_id","amount","paid"` as a
filter value, producing:

```
"bill_id","user_id","amount","paid" is not a valid filter for column "columns"
```

### What PostgREST does

The `columns` parameter tells PostgREST which columns to populate
from the JSON array body. This is a performance optimization for
bulk inserts — it avoids inspecting every row to determine the
column set. When `columns` is present:
- Only the listed columns are used in the INSERT
- Extra keys in the JSON body are ignored
- Missing keys get NULL (or the column default)

When `columns` is absent, PostgREST unions all keys from all rows
to determine the column set — which is what pgrest-lambda already
does in `buildInsert` in sql-builder.mjs.

### Fix

1. Add `columns` to `RESERVED_PARAMS` in query-parser.mjs so it's
   not treated as a filter.

2. Pass `parsed.columns` through to the handler. Parse the value as
   a comma-separated list of column names (strip any quotes that
   supabase-js adds).

3. In handler.mjs, when `columns` is present on a POST, pass it to
   `buildInsert` so it uses the specified column list instead of
   union-of-all-keys.

4. In sql-builder.mjs `buildInsert`, when a `columns` list is
   provided:
   - Validate each column exists in the schema
   - Use only those columns in the INSERT (ignore extra body keys)
   - For each row, if a column is missing from the row body, use
     NULL as the value

   When `columns` is NOT provided, behavior is unchanged (union of
   all keys from all rows).

## Bug 2: Insert with `Prefer: return=representation` returns null

When supabase-js chains `.select()` after `.insert()`:

```javascript
const { data } = await supabase
  .from('bills')
  .insert({ title: 'Lunch', total_amount: 50 })
  .select()
  .single();
// data is null — row was inserted but not returned
```

supabase-js sends:
```
POST /rest/v1/bills?select=*
Prefer: return=representation
```

The row IS inserted (confirmed in database), but the response body
is empty/null.

### Root cause

Looking at handler.mjs line 318-319:
```javascript
if (method === 'POST') {
  return success(201, returnRep ? rows : null, {});
}
```

The `returnRep` check exists and `buildInsert` uses `RETURNING *`,
so `rows` should contain the inserted data. The issue is that
supabase-js also sends `?select=*` on the POST. The `select`
parameter gets parsed by `parseQuery` and since `select=*` produces
`[{ type: 'column', name: '*' }]`, it should work.

Investigate the actual failure path — the `select` param on POST
may be interacting with the `columns` param (Bug 1) or with the
embed detection logic. The `?select=*` is standard but may conflict
with filter parsing if `select` is somehow not in `RESERVED_PARAMS`
for POST methods.

Actually — `select` IS in RESERVED_PARAMS and `*` resolves
correctly. The more likely cause: supabase-js sends `?select=*`
AND `?columns=...` together. If `columns` triggers the filter
parsing error (Bug 1), the whole request fails before the insert
runs, and the client sees `data: null` because the error response
doesn't match what supabase-js expects.

### Fix

Bug 1's fix likely resolves this. After fixing `columns`, verify
that:
- `POST /rest/v1/table?select=*` with `Prefer: return=representation`
  returns the inserted row(s) with status 201
- The `select` param on POST controls which columns appear in the
  response (not which columns are inserted — that's `columns`)
- `RETURNING *` in buildInsert returns all columns, and the handler
  filters to the `select` list if specified

If `select` on POST doesn't filter the response columns today,
that's a separate enhancement — the immediate fix is ensuring
the row is returned at all.

## Test cases

```javascript
// Bug 1: bulk insert with columns param
const { data, error } = await supabase
  .from('bill_splits')
  .insert([
    { bill_id: '123', user_id: 'abc', amount: 25.00, paid: false },
    { bill_id: '123', user_id: 'def', amount: 25.00, paid: false },
  ]);
// error should be null, both rows inserted

// Bug 2: insert then select
const { data, error } = await supabase
  .from('bills')
  .insert({ title: 'Lunch', total_amount: 50 })
  .select()
  .single();
// data should contain the inserted row with id and created_at

// Bug 2: bulk insert then select
const { data, error } = await supabase
  .from('bill_splits')
  .insert([
    { bill_id: '123', user_id: 'abc', amount: 25.00, paid: false },
    { bill_id: '123', user_id: 'def', amount: 25.00, paid: false },
  ])
  .select();
// data should be an array of 2 inserted rows

// Existing behavior preserved: single insert without select
const { error } = await supabase
  .from('bills')
  .insert({ title: 'Test' });
// still works, returns 201

// columns param with extra body keys (ignored)
// POST /rest/v1/bills?columns=title,total_amount
// Body: {"title":"X","total_amount":10,"extra_field":"ignored"}
// Should insert only title and total_amount, ignore extra_field

// columns param with missing body keys (NULL)
// POST /rest/v1/bills?columns=title,total_amount
// Body: {"title":"X"}
// Should insert title="X", total_amount=NULL
```

Files to modify:
  src/rest/query-parser.mjs  — add `columns` to RESERVED_PARAMS, parse column list
  src/rest/sql-builder.mjs   — accept optional columns list in buildInsert
  src/rest/handler.mjs       — pass columns to buildInsert on POST

No new files to create.
No new npm dependencies.

## Design constraints

- Column names from the `columns` param must be validated against
  the schema (same as body keys are today)
- All SQL remains parameterized
- Existing single-row and bulk insert behavior without `columns`
  param must not change
- The fix must work for both standard PostgreSQL and DSQL
