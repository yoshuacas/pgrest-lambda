# pgrest-lambda vs PostgREST: Gap Analysis

**Date:** 2026-04-12
**Scope:** Feature-by-feature comparison of pgrest-lambda against PostgREST v12

---

## Executive Summary

pgrest-lambda covers the basic CRUD surface of PostgREST: reads with filtering, inserts (single and bulk), updates, and deletes. It handles 10 of 28+ filter operators, basic column selection, ordering, and limit/offset pagination. Beyond that, there are significant gaps in resource embedding (joins), RPC, response format negotiation, advanced filtering, and the `Prefer` header system that PostgREST clients depend on.

The gaps are organized into three tiers:

| Tier | Description | Count |
|------|-------------|-------|
| **P0 — Breaking for supabase-js** | Features supabase-js calls that will fail or return wrong results | 7 |
| **P1 — Important for parity** | Commonly used PostgREST features not yet covered | 8 |
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

---

## P0 — Breaking for supabase-js Clients

These features are called by `@supabase/supabase-js` in normal usage. Missing them causes client-side errors or silently wrong results.

### 1. Resource Embedding (Foreign Key Joins)

**PostgREST:** Tables related by foreign keys can be fetched in a single request using nested `select`:
```
GET /rest/v1/orders?select=id,amount,customers(name,email)
```
Returns orders with customer objects embedded inline. Supports many-to-one, one-to-many, many-to-many, and computed relationships. Also supports `!inner` joins, disambiguation with `!fk_name`, and nested embedding.

**supabase-js usage:**
```js
const { data } = await supabase
  .from('orders')
  .select('id, amount, customers(name, email)')
```

**pgrest-lambda:** Not implemented. The `select` parameter is split on commas but parenthetical expressions are not parsed. Requests with embedded selects silently drop the join or error.

**Impact:** Any supabase-js query using `.select()` with related tables fails. This is extremely common in real applications.

---

### 2. Logical Operators: `or` and `and`

**PostgREST:** Complex filter logic via URL params:
```
GET /rest/v1/people?or=(age.lt.18,age.gt.65)
GET /rest/v1/people?and=(salary.gte.100000,or(dept.eq.eng,dept.eq.product))
```

**supabase-js usage:**
```js
const { data } = await supabase
  .from('people')
  .select()
  .or('age.lt.18,age.gt.65')
```

**pgrest-lambda:** Not implemented. The query parser treats every filter parameter as a column name and joins everything with AND. The `or(...)` and `and(...)` syntax is not recognized.

**Impact:** Any supabase-js query using `.or()` fails.

---

### 3. Column Renaming (Aliases) in Select

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

---

### 4. RPC / Stored Procedure Calls

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

---

### 5. `Prefer: return=minimal` and `Prefer: return=headers-only`

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

---

### 6. Type Casting in Select

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

---

### 7. Filtering on Embedded Resources

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

**pgrest-lambda:** Not implemented (depends on resource embedding).

**Impact:** Fails for any query that filters on joined tables.

---

## P1 — Important for Parity

These are commonly used PostgREST features. Missing them limits what developers can build, but they don't break basic supabase-js CRUD.

### 8. Full-Text Search Operators

**PostgREST operators:** `fts`, `plfts`, `phfts`, `wfts` — four variants mapping to PostgreSQL's `to_tsquery`, `plainto_tsquery`, `phraseto_tsquery`, `websearch_to_tsquery`. Accept optional language config: `col=plfts(english).search term`.

**pgrest-lambda:** Not implemented. None of the four FTS operators are recognized.

---

### 9. Range / Array / Containment Operators

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

---

### 10. Regex Operators: `match` and `imatch`

**PostgREST:** `match` maps to `~` (POSIX regex), `imatch` maps to `~*` (case-insensitive regex).

**pgrest-lambda:** Not implemented.

---

### 11. `HEAD` Method

**PostgREST:** `HEAD` returns the same headers as `GET` (including `Content-Range`) but no body. Efficient for existence checks and row counting without transferring data.

**pgrest-lambda:** Not handled. Returns 405 or falls through.

---

### 12. Range Header Pagination

**PostgREST:** Supports `Range: 0-24` header as an alternative to `limit`/`offset` query params. Returns `Content-Range` header with offset info and optional total count.

**pgrest-lambda:** Only `limit`/`offset` query params work. `Range` header is ignored.

---

### 13. `Prefer: count=planned` and `count=estimated`

**PostgREST:** Three counting strategies:
- `count=exact` — full `COUNT(*)` (slow on large tables)
- `count=planned` — uses `pg_class.reltuples` planner stats (instant, approximate)
- `count=estimated` — hybrid: exact if under `db-max-rows`, planned otherwise

**pgrest-lambda:** Only `count=exact` is implemented. No planned or estimated counting.

---

### 14. CSV Response Format

**PostgREST:** `Accept: text/csv` returns results as CSV. `Content-Type: text/csv` accepts CSV for bulk inserts.

**pgrest-lambda:** JSON only, both directions.

---

### 15. `Prefer: missing=default`

**PostgREST:** When set, omitted columns in INSERT/PATCH use the column's `DEFAULT` expression instead of being set to `NULL`.

**pgrest-lambda:** Not implemented. Omitted columns are always `NULL` (or excluded from the SET clause for PATCH).

---

## P2 — Nice to Have

These are advanced PostgREST features used in specific scenarios.

### 16. Schema Switching (`Accept-Profile` / `Content-Profile`)

**PostgREST:** Multiple schemas can be exposed. `Accept-Profile: api` switches the read schema; `Content-Profile: api` switches the write schema.

**pgrest-lambda:** Hardcoded to `public` schema only (by design per CLAUDE.md rule #9).

---

### 17. `PUT` Method (Single-Row Upsert)

**PostgREST:** `PUT` requires all columns (including PK) and performs a single-row upsert. Different from `POST` with `resolution=merge-duplicates`, which handles bulk.

**pgrest-lambda:** Not implemented as a separate method. Upsert is only via `POST` + `on_conflict`.

---

### 18. `any` / `all` Modifiers

**PostgREST:** `?name=like(any).{O*,P*}` matches names starting with O or P. `?name=like(all).{*a*,*b*}` requires both patterns match. Applicable to `eq`, `like`, `ilike`, `gt`, `gte`, `lt`, `lte`, `match`, `imatch`.

**pgrest-lambda:** Not implemented.

---

### 19. `isdistinct` Operator

**PostgREST:** `IS DISTINCT FROM` — like `neq` but treats NULL as a comparable value (NULL is distinct from 1, NULL is not distinct from NULL).

**pgrest-lambda:** Not implemented.

---

### 20. JSON Column Operators in Select and Filter

**PostgREST:** `->`, `->>` operators for JSON traversal in select, filter, and order clauses:
```
?select=data->>name&data->>age=gt.18&order=data->>age.desc
```

**pgrest-lambda:** Not implemented. JSON columns are returned as-is; no path traversal.

---

### 21. Computed Columns

**PostgREST:** Functions that take a table's row type as argument appear as virtual columns:
```sql
CREATE FUNCTION full_name(people) RETURNS text AS $$
  SELECT $1.first_name || ' ' || $1.last_name;
$$ LANGUAGE SQL;
-- Now: GET /people?select=full_name
```

**pgrest-lambda:** Not implemented. Only physical columns from `pg_catalog` are introspected.

---

### 22. Aggregate Functions

**PostgREST (v12+):** `count()`, `sum()`, `avg()`, `min()`, `max()` in select:
```
?select=amount.sum(),category&order=amount.sum().desc
```
Auto-groups by non-aggregated columns. Disabled by default (`db-aggregates-enabled`).

**pgrest-lambda:** Not implemented.

---

### 23. Transaction GUC Variables

**PostgREST:** Sets request context as PostgreSQL GUC variables readable in SQL:
- `request.headers`, `request.cookies`, `request.jwt.claims`, `request.method`, `request.path`
- `response.headers`, `response.status` — settable by SQL functions to control the HTTP response.

**pgrest-lambda:** Not implemented. Request context is not passed to PostgreSQL sessions.

---

### 24. Custom Media Type Handlers

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
| `and` (logical) | Yes | No | P0 |
| `or` (logical) | Yes | No | P0 |
| `any` modifier | Yes | No | P2 |
| `all` modifier | Yes | No | P2 |

**Coverage: 11/31 operators (35%)**

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
| `resolution=ignore-duplicates` | Yes | No | P1 |
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
| Filter Operators | 31 | 11 | 35% |
| Prefer Headers | 15 | 4 | 27% |
| Select Features | columns, aliases, casts, JSON ops, embeds, spread | columns only | ~15% |
| Response Formats | JSON, CSV, GeoJSON, plans, custom | JSON only | 1/5+ |
| Resource Embedding | Full (M2O, O2M, M2M, computed, inner, spread) | None | 0% |
| RPC | Full (POST, GET, named params, table-valued) | None | 0% |
| Schema Switching | Multi-schema with profile headers | public only | 0% |
| Aggregates | count, sum, avg, min, max | None | 0% |
| Computed Columns | Via row-type functions | None | 0% |

---

## Recommended Implementation Order

If the goal is supabase-js wire compatibility, this is the priority order:

1. **Resource embedding** — most used supabase-js feature after basic CRUD
2. **Logical operators (`or`, `and`)** — required for non-trivial queries
3. **RPC endpoint** — `.rpc()` is heavily used
4. **Select aliases and type casting** — breaks `.select()` with aliases
5. **Full-text search operators** — common in search UIs
6. **Embedded resource filtering** — required once embedding works
7. **Range/containment operators** — needed for array/JSONB-heavy schemas
8. **HEAD method + Range pagination** — standard HTTP compliance
9. **Prefer header expansion** — `missing=default`, `count=planned`, `resolution=ignore-duplicates`
10. **CSV format** — useful for data export use cases
