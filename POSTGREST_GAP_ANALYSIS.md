# pgrest-lambda vs PostgREST: Gap Analysis

**Date:** 2026-04-17 (updated)
**Scope:** Feature-by-feature comparison of pgrest-lambda against PostgREST v12

---

## Executive Summary

pgrest-lambda covers the basic CRUD surface of PostgREST: reads with filtering, inserts (single and bulk), updates, and deletes. It handles 13 of 31 filter/logical operators, column selection with resource embedding (foreign key joins), ordering, and limit/offset pagination. Resource embedding supports many-to-one, one-to-many, inner joins, nested embedding, and FK disambiguation. Logical operators (`or`, `and`) support arbitrary nesting up to 10 levels. Remaining gaps include RPC, response format negotiation, advanced operators, and parts of the `Prefer` header system.

The gaps are organized into three tiers:

| Tier | Description | Count |
|------|-------------|-------|
| **P0 — Breaking for supabase-js** | Features supabase-js calls that will fail or return wrong results | 5 |
| **P1 — Important for parity** | Commonly used PostgREST features not yet covered | 9 |
| **P2 — Nice to have** | Advanced or niche PostgREST features | 9 |

---

## What Works Today

| Feature | Status | Notes |
|---------|--------|-------|
| `GET /rest/v1/{table}` | Done | Select with column projection |
| `POST /rest/v1/{table}` | Done | Single and bulk JSON insert |
| `PATCH /rest/v1/{table}` | Done | Update with required filters |
| `DELETE /rest/v1/{table}` | Done | Delete with required filters |
| `OPTIONS` (CORS) | Done | Preflight handling |
| Filter operators: `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `like`, `ilike`, `in`, `is` | Done | Core comparison set |
| `not` negation prefix | Done | `col=not.eq.value` |
| `order` with `asc`/`desc`/`nullsfirst`/`nullslast` | Done | Multi-column ordering |
| `limit` / `offset` | Done | Query param pagination |
| `select` column list | Done | Comma-separated, `*` default |
| `on_conflict` upsert | Done | With `Prefer: resolution=merge-duplicates` |
| `Prefer: return=representation` | Done | Returns mutated rows |
| `Prefer: count=exact` | Done | COUNT query for Content-Range |
| `Accept: application/vnd.pgrst.object+json` | Done | Singular object response |
| OpenAPI 3.0.3 spec generation | Done | Auto-generated from schema |
| Content-Range header | Done | On GET responses |
| Error codes (PGRST format) | Done | Structured JSON errors |
| JWT auth (external) | Done | Via Cognito + Lambda authorizer |
| Bulk update/delete prevention | Done | Requires at least one filter |
| Resource embedding (FK joins) | Done | Many-to-one, one-to-many, `!inner`, nested, `!fk_name` disambiguation |
| Logical operators `or` / `and` | Done | Nested up to 10 levels, negation via `not.or`/`not.and` |

---

## P0 — Breaking for supabase-js Clients

These features are called by `@supabase/supabase-js` in normal usage. Missing them causes client-side errors or silently wrong results.

### 1. Column Renaming (Aliases) in Select

**PostgREST:**
```
GET /rest/v1/people?select=fullName:full_name,birthDate:birth_date
```

**supabase-js usage:**
```js
const { data } = await supabase
  .from('people')
  .select('fullName:full_name, birthDate:birth_date')
```

**pgrest-lambda:** Not implemented. The colon syntax is not parsed; the literal string `fullName:full_name` is treated as a column name and will produce a "column not found" error.

**Impact:** Any select with aliases fails.

**Where to fix:** `src/rest/query-parser.mjs` — `parseSelectList()` (~line 59-64) recognizes colons for embed tokens (`buyer:customers()`) but not for plain column aliases. Parse `alias:column` syntax in non-embed tokens and store as `{ column, alias }`. Then in `src/rest/sql-builder.mjs`, emit `"column" AS "alias"` in the SELECT clause.

---

### 2. RPC / Stored Procedure Calls

**PostgREST:** Functions exposed at `/rpc/{function_name}`:
```
POST /rest/v1/rpc/get_top_customers
Content-Type: application/json
{"min_orders": 10}
```
Supports named parameters, table-valued functions (with full filtering/pagination), scalar functions, and `GET` for immutable functions.

**supabase-js usage:**
```js
const { data } = await supabase.rpc('get_top_customers', { min_orders: 10 })
```

**pgrest-lambda:** No `/rpc/` endpoint exists. Requests to `/rest/v1/rpc/*` return 404.

**Impact:** Any supabase-js `.rpc()` call fails entirely.

**Where to fix:** Needs a new subsystem:
1. `src/rest/router.mjs` — add routing for `/rest/v1/rpc/{function_name}` paths
2. `src/rest/schema-cache.mjs` — add function introspection from `pg_catalog.pg_proc` (argument names, types, return types, volatility)
3. `src/rest/sql-builder.mjs` — new `buildRpcCall()` that generates `SELECT * FROM function_name($1, $2)` with named parameter mapping
4. `src/rest/handler.mjs` — handle RPC requests: POST body → named params, GET query params → named params. Table-valued functions should support the same filtering/pagination as table reads. Scalar functions return unwrapped values.

---

### 3. `Prefer: return=minimal` and `Prefer: return=headers-only`

**PostgREST:** Three return modes for mutations:
- `return=minimal` — no body (204), default for PATCH/DELETE
- `return=headers-only` — no body but includes `Location` header
- `return=representation` — full rows in body

**supabase-js usage:**
```js
// Default behavior (no .select() after mutation) expects 204 + no body
await supabase.from('items').insert({ name: 'test' })
// With .select() expects return=representation
await supabase.from('items').insert({ name: 'test' }).select()
```

**pgrest-lambda:** POST always returns 201 with the inserted rows (equivalent to `return=representation`). PATCH/DELETE return 204 without `return=representation`, or 200 with it. The `headers-only` mode and `Location` header are not implemented.

**Impact:** Mostly works for common patterns, but clients relying on precise status codes or `Location` headers may break.

**Where to fix:** `src/rest/handler.mjs` (~line 328-338) — add `headers-only` branch that returns 204 with a `Location` header in format `/rest/v1/{table}?{pk_column}=eq.{pk_value}`. Requires knowing the primary key columns from schema cache.

---

### 4. Type Casting in Select

**PostgREST:**
```
GET /rest/v1/people?select=name,salary::text
```

**supabase-js usage:**
```js
const { data } = await supabase.from('people').select('name, salary::text')
```

**pgrest-lambda:** Not implemented. `salary::text` is treated as a literal column name.

**Impact:** Select with type casts fails.

**Where to fix:** `src/rest/query-parser.mjs` — `parseSelectList()` (~line 59-64) needs to detect `::` in column tokens and split into `{ column, cast }`. Then in `src/rest/sql-builder.mjs`, emit `CAST("column" AS type)` or `"column"::type` in the SELECT clause. Should validate cast types against a safe allowlist to prevent SQL injection.

---

### 5. Filtering on Embedded Resources

**PostgREST:**
```
GET /rest/v1/directors?select=*,films(*)&films.year=gt.2000
```

**supabase-js usage:**
```js
const { data } = await supabase
  .from('directors')
  .select('*, films(*)')
  .eq('films.year', 2000)
```

**pgrest-lambda:** Not implemented. Resource embedding now works, but dot-notation filters on embedded tables (e.g., `films.year=gt.2000`) are not parsed. The filter is applied to the parent table where the column doesn't exist.

**Impact:** Fails for any query that filters on joined tables.

**Where to fix:** `src/rest/query-parser.mjs` — `parseFilter()` (~line 193) needs to detect dot notation in column names (`table.column`) and split into `{ table, column }`. Then in `src/rest/sql-builder.mjs`, route these filters into the embed subqueries (built by `buildEmbedSubquery()`) rather than the parent WHERE clause.

---

## P1 — Important for Parity

These are commonly used PostgREST features. Missing them limits what developers can build, but they don't break basic supabase-js CRUD.

### 6. Full-Text Search Operators

**PostgREST operators:** `fts`, `plfts`, `phfts`, `wfts` — four variants mapping to PostgreSQL's `to_tsquery`, `plainto_tsquery`, `phraseto_tsquery`, `websearch_to_tsquery`. Accept optional language config: `col=plfts(english).search term`.

**pgrest-lambda:** Not implemented. None of the four FTS operators are recognized.

**Where to fix:** `src/rest/query-parser.mjs` — add `fts`, `plfts`, `phfts`, `wfts` to the `VALID_OPERATORS` set (~line 9-11). Extend `parseFilter()` to handle optional language config syntax `fts(english)`. In `src/rest/sql-builder.mjs`, map to PostgreSQL's `@@` operator with the corresponding tsquery function (`to_tsquery`, `plainto_tsquery`, `phraseto_tsquery`, `websearch_to_tsquery`).

---

### 7. Range / Array / Containment Operators

| Operator | SQL | Purpose |
|----------|-----|---------|
| `cs` | `@>` | Contains |
| `cd` | `<@` | Contained in |
| `ov` | `&&` | Overlap (arrays/ranges) |
| `sl` | `<<` | Strictly left of |
| `sr` | `>>` | Strictly right of |
| `nxr` | `&<` | Does not extend right |
| `nxl` | `&>` | Does not extend left |
| `adj` | `-\|-` | Adjacent to |

**pgrest-lambda:** None of these are implemented. Queries using array containment (`tags=cs.{a,b}`) or range overlap silently fail.

**Where to fix:** Same pattern as FTS — add operators to `VALID_OPERATORS` in `query-parser.mjs`, extend `parseFilter()` to handle `{}` (array literal) and `[]` (range literal) value syntax. In `sql-builder.mjs`, emit the correct PostgreSQL operators.

---

### 8. Regex Operators: `match` and `imatch`

**PostgREST:** `match` maps to `~` (POSIX regex), `imatch` maps to `~*` (case-insensitive regex).

**pgrest-lambda:** Not implemented.

**Where to fix:** Add `match` and `imatch` to `VALID_OPERATORS` in `query-parser.mjs`. In `sql-builder.mjs`, map `match` → `~` and `imatch` → `~*`.

---

### 9. `HEAD` Method

**PostgREST:** `HEAD` returns the same headers as `GET` (including `Content-Range`) but no body. Efficient for existence checks and row counting without transferring data.

**pgrest-lambda:** Not handled. Returns 405 or falls through.

**Where to fix:** `src/rest/handler.mjs` (~line 274-277) — add `case 'HEAD':` to the method switch. Execute the same query as GET but return `success()` with null body. Content-Range header is already included in GET responses, so it carries over.

---

### 10. Range Header Pagination

**PostgREST:** Supports `Range: 0-24` header as an alternative to `limit`/`offset` query params. Returns `Content-Range` header with offset info and optional total count.

**pgrest-lambda:** Only `limit`/`offset` query params work. `Range` header is ignored.

**Where to fix:** `src/rest/handler.mjs` — parse `Range` header (format `0-24`), convert start/end to limit/offset. Apply before query building, with query params taking precedence if both are present.

---

### 11. `Prefer: count=planned` and `count=estimated`

**PostgREST:** Three counting strategies:
- `count=exact` — full `COUNT(*)` (slow on large tables)
- `count=planned` — uses `pg_class.reltuples` planner stats (instant, approximate)
- `count=estimated` — hybrid: exact if under `db-max-rows`, planned otherwise

**pgrest-lambda:** Only `count=exact` is implemented. No planned or estimated counting.

**Where to fix:** `src/rest/handler.mjs` (~line 207-212) — for `count=planned`, query `SELECT reltuples FROM pg_class WHERE relname = $1` (instant). For `count=estimated`, use exact count if under a configurable threshold, fall back to planned otherwise. `src/rest/schema-cache.mjs` could cache `reltuples` alongside table metadata.

---

### 12. CSV Response Format

**PostgREST:** `Accept: text/csv` returns results as CSV. `Content-Type: text/csv` accepts CSV for bulk inserts.

**pgrest-lambda:** JSON only, both directions.

**Where to fix:** `src/rest/handler.mjs` — detect `Accept: text/csv` and route to a CSV serializer in `src/rest/response.mjs`. For CSV input, parse `Content-Type: text/csv` body into a JSON array before passing to insert logic.

---

### 13. `Prefer: missing=default`

**PostgREST:** When set, omitted columns in INSERT/PATCH use the column's `DEFAULT` expression instead of being set to `NULL`.

**pgrest-lambda:** Not implemented. Omitted columns are always `NULL` (or excluded from the SET clause for PATCH).

**Where to fix:** `src/rest/sql-builder.mjs` — in `buildInsert()` and `buildUpdate()`, check the `prefer.missing` flag. When set to `default`, emit the `DEFAULT` keyword for omitted columns instead of `NULL` or excluding them.

---

### 14. `Prefer: resolution=ignore-duplicates`

**PostgREST:** `resolution=ignore-duplicates` with `on_conflict` emits `ON CONFLICT DO NOTHING` — silently skips rows that conflict instead of updating them.

**supabase-js usage:**
```js
await supabase.from('items').upsert([...], { ignoreDuplicates: true })
```

**pgrest-lambda:** Only `resolution=merge-duplicates` is implemented (ON CONFLICT DO UPDATE). `ignore-duplicates` is not handled.

**Impact:** supabase-js `ignoreDuplicates: true` option fails or falls through to default behavior.

**Where to fix:** `src/rest/sql-builder.mjs` — in the upsert branch of `buildInsert()`, check if resolution is `ignore-duplicates` and emit `ON CONFLICT (columns) DO NOTHING` instead of `DO UPDATE SET ...`.

---

## P2 — Nice to Have

These are advanced PostgREST features used in specific scenarios.

### 15. Schema Switching (`Accept-Profile` / `Content-Profile`)

**PostgREST:** Multiple schemas can be exposed. `Accept-Profile: api` switches the read schema; `Content-Profile: api` switches the write schema.

**pgrest-lambda:** Hardcoded to `public` schema only (by design per CLAUDE.md rule #9).

---

### 16. `PUT` Method (Single-Row Upsert)

**PostgREST:** `PUT` requires all columns (including PK) and performs a single-row upsert. Different from `POST` with `resolution=merge-duplicates`, which handles bulk.

**pgrest-lambda:** Not implemented as a separate method. Upsert is only via `POST` + `on_conflict`.

---

### 17. `any` / `all` Modifiers

**PostgREST:** `?name=like(any).{O*,P*}` matches names starting with O or P. `?name=like(all).{*a*,*b*}` requires both patterns match. Applicable to `eq`, `like`, `ilike`, `gt`, `gte`, `lt`, `lte`, `match`, `imatch`.

**pgrest-lambda:** Not implemented.

---

### 18. `isdistinct` Operator

**PostgREST:** `IS DISTINCT FROM` — like `neq` but treats NULL as a comparable value (NULL is distinct from 1, NULL is not distinct from NULL).

**pgrest-lambda:** Not implemented.

---

### 19. JSON Column Operators in Select and Filter

**PostgREST:** `->`, `->>` operators for JSON traversal in select, filter, and order clauses:
```
?select=data->>name&data->>age=gt.18&order=data->>age.desc
```

**pgrest-lambda:** Not implemented. JSON columns are returned as-is; no path traversal.

---

### 20. Computed Columns

**PostgREST:** Functions that take a table's row type as argument appear as virtual columns:
```sql
CREATE FUNCTION full_name(people) RETURNS text AS $$
  SELECT $1.first_name || ' ' || $1.last_name;
$$ LANGUAGE SQL;
-- Now: GET /people?select=full_name
```

**pgrest-lambda:** Not implemented. Only physical columns from `pg_catalog` are introspected.

---

### 21. Aggregate Functions

**PostgREST (v12+):** `count()`, `sum()`, `avg()`, `min()`, `max()` in select:
```
?select=amount.sum(),category&order=amount.sum().desc
```
Auto-groups by non-aggregated columns. Disabled by default (`db-aggregates-enabled`).

**pgrest-lambda:** Not implemented.

---

### 22. Transaction GUC Variables

**PostgREST:** Sets request context as PostgreSQL GUC variables readable in SQL:
- `request.headers`, `request.cookies`, `request.jwt.claims`, `request.method`, `request.path`
- `response.headers`, `response.status` — settable by SQL functions to control the HTTP response.

**pgrest-lambda:** Not implemented. Request context is not passed to PostgreSQL sessions.

---

### 23. Custom Media Type Handlers

**PostgREST:** Custom `Accept` types can be handled by PostgreSQL domain + function combos, allowing SQL to produce arbitrary formats (PDF, protobuf, etc.).

**pgrest-lambda:** Not implemented.

---

## Operator Coverage Matrix

| Operator | PostgREST | pgrest-lambda | Gap? |
|----------|-----------|---------------|------|
| `eq` | Yes | Yes | |
| `neq` | Yes | Yes | |
| `gt` | Yes | Yes | |
| `gte` | Yes | Yes | |
| `lt` | Yes | Yes | |
| `lte` | Yes | Yes | |
| `like` | Yes | Yes | |
| `ilike` | Yes | Yes | |
| `in` | Yes | Yes | |
| `is` | Yes | Yes | |
| `not` (prefix) | Yes | Yes | |
| `match` | Yes | No | P1 |
| `imatch` | Yes | No | P1 |
| `isdistinct` | Yes | No | P2 |
| `fts` | Yes | No | P1 |
| `plfts` | Yes | No | P1 |
| `phfts` | Yes | No | P1 |
| `wfts` | Yes | No | P1 |
| `cs` | Yes | No | P1 |
| `cd` | Yes | No | P1 |
| `ov` | Yes | No | P1 |
| `sl` | Yes | No | P2 |
| `sr` | Yes | No | P2 |
| `nxr` | Yes | No | P2 |
| `nxl` | Yes | No | P2 |
| `adj` | Yes | No | P2 |
| `and` (logical) | Yes | Yes | |
| `or` (logical) | Yes | Yes | |
| `any` modifier | Yes | No | P2 |
| `all` modifier | Yes | No | P2 |

**Coverage: 13/31 operators (42%)**

---

## Prefer Header Coverage

| Prefer Value | PostgREST | pgrest-lambda | Gap? |
|---|---|---|---|
| `return=representation` | Yes | Yes | |
| `return=minimal` | Yes | Partial (default for PATCH/DELETE) | |
| `return=headers-only` | Yes | No | P0 |
| `count=exact` | Yes | Yes | |
| `count=planned` | Yes | No | P1 |
| `count=estimated` | Yes | No | P1 |
| `resolution=merge-duplicates` | Yes | Yes | |
| `resolution=ignore-duplicates` | Yes | No | P1 (#14) |
| `missing=default` | Yes | No | P1 |
| `handling=strict` | Yes | No | P2 |
| `handling=lenient` | Yes | No | P2 |
| `tx=commit` | Yes | No | P2 |
| `tx=rollback` | Yes | No | P2 |
| `max-affected=N` | Yes | No | P2 |
| `timezone=...` | Yes | No | P2 |

**Coverage: 4/15 prefer values (27%)**

---

## Feature-Level Summary

| Feature Area | PostgREST | pgrest-lambda | Coverage |
|---|---|---|---|
| HTTP Methods | GET, HEAD, POST, PATCH, PUT, DELETE, OPTIONS | GET, POST, PATCH, DELETE, OPTIONS | 5/7 |
| Filter Operators | 31 | 13 | 42% |
| Prefer Headers | 15 | 4 | 27% |
| Select Features | columns, aliases, casts, JSON ops, embeds, spread | columns, embeds | ~30% |
| Response Formats | JSON, CSV, GeoJSON, plans, custom | JSON only | 1/5+ |
| Resource Embedding | Full (M2O, O2M, M2M, computed, inner, spread) | M2O, O2M, inner, nested, FK disambiguation | ~70% |
| RPC | Full (POST, GET, named params, table-valued) | None | 0% |
| Schema Switching | Multi-schema with profile headers | public only | 0% |
| Aggregates | count, sum, avg, min, max | None | 0% |
| Computed Columns | Via row-type functions | None | 0% |

---

## Recommended Implementation Order

If the goal is supabase-js wire compatibility, this is the priority order:

1. ~~**Resource embedding**~~ — Done
2. ~~**Logical operators (`or`, `and`)**~~ — Done
3. **RPC endpoint** (#2) — `.rpc()` is heavily used, biggest single gap
4. **Select aliases** (#1) — breaks `.select('firstName:first_name')`
5. **Type casting in select** (#4) — breaks `.select('salary::text')`
6. **Embedded resource filtering** (#5) — required now that embedding works
7. **`Prefer: return=headers-only`** (#3) — Location header for mutations
8. **Full-text search operators** (#6) — common in search UIs
9. **Range/containment operators** (#7) — needed for array/JSONB-heavy schemas
10. **HEAD method** (#9) + **Range header pagination** (#10) — HTTP compliance
11. **Prefer: count=planned/estimated** (#11) — performance on large tables
12. **Prefer: missing=default** (#13) — simpler insert logic
13. **Prefer: resolution=ignore-duplicates** (#14) — `ON CONFLICT DO NOTHING`
14. **Regex operators** (#8) — `match`, `imatch`
15. **CSV format** (#12) — data export use cases
