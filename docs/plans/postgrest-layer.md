# PostgREST-Compatible Lambda Layer on Aurora DSQL

## Execution Instructions

This plan can be executed independently by any agent. It only touches files in `plugin/lambda-templates/`. No changes needed to the SAM template or other plugin files.

**To execute:** Create all 9 modules in `plugin/lambda-templates/postgrest/`, rewrite `index.mjs`, then update docs. Follow the implementation order below. Read the existing `crud-api.mjs` first — extract its connection pool logic into `db.mjs`.

---

## Context

BOA currently has a simple hardcoded CRUD Lambda handler (`plugin/lambda-templates/crud-api.mjs`, 149 lines) with routes for `/items`. Replace it with a **PostgREST-compatible API layer** so that `@supabase/supabase-js` can talk to BOA backends using the exact same query syntax it uses against Supabase. This makes BOA a drop-in replacement for Supabase's data API without running PostgREST itself.

The Supabase JS client sends requests like:
```
supabase.from('todos').select('*').eq('id', '1')  →  GET /rest/v1/todos?select=*&id=eq.1
supabase.from('todos').insert({title: 'foo'})      →  POST /rest/v1/todos
supabase.from('todos').update({done: true}).eq(...)  →  PATCH /rest/v1/todos?id=eq.1
supabase.from('todos').delete().eq('id', '1')      →  DELETE /rest/v1/todos?id=eq.1
```

## Architecture

```
@supabase/supabase-js client
    │
    ▼
GET /rest/v1/todos?select=*&status=eq.active&order=created_at.desc&limit=20
    │
    ▼
API Gateway (/{proxy+}) → Cognito authorizer → Lambda
    │
    ▼
handler.mjs → router.mjs → query-parser.mjs → sql-builder.mjs → DSQL
    │                                                               │
    ▼                                                               ▼
response.mjs ← ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─  result
    │
    ▼
JSON array response with Content-Range headers
```

## New Module Structure

```
plugin/lambda-templates/
  index.mjs                    # Rewritten: exports postgrest handler
  package.json                 # Unchanged (no new deps needed)
  auth-presignup.mjs           # Unchanged
  presigned-upload.mjs         # Unchanged
  postgrest/
    handler.mjs                # Lambda entry: dispatch by method (~80 lines)
    router.mjs                 # Extract table from /rest/v1/{table} (~40 lines)
    query-parser.mjs           # Parse PostgREST query params into structured object (~200 lines)
    sql-builder.mjs            # Convert parsed query to parameterized SQL (~250 lines)
    schema-cache.mjs           # Introspect information_schema, cache metadata (~120 lines)
    response.mjs               # PostgREST-format responses, Content-Range (~80 lines)
    errors.mjs                 # PostgREST-compatible error codes/format (~50 lines)
    db.mjs                     # Connection pool extracted from crud-api.mjs (~60 lines)
    openapi.mjs                # Generate OpenAPI 3.0 spec from schema cache (~200 lines)
```

**9 new files, ~1080 lines total. No new npm dependencies.**

## What Each Module Does

**`db.mjs`** — Connection pool extracted from current `crud-api.mjs`. Same DsqlSigner + pg.Pool pattern with 10-minute token refresh. Exports `getPool()`. Reference the existing implementation in `crud-api.mjs` lines 1-62.

**`errors.mjs`** — PostgREST error format: `{ code, message, details, hint }`. Maps PG error codes (23505 unique violation, 23503 FK violation) and application errors (PGRST200 table not found, PGRST204 column not found).

**`schema-cache.mjs`** — On cold start, queries `information_schema.columns`, primary keys, and foreign keys. Caches table/column metadata in module scope (TTL 5 min, configurable via `SCHEMA_CACHE_TTL_MS` env var). Used for column validation (SQL injection defense), OpenAPI spec generation, and resource embedding. Exports a `refresh()` method that forces immediate re-introspection (called by the `/_refresh` endpoint).

Introspection queries:
```sql
-- Columns
SELECT table_name, column_name, data_type, is_nullable, column_default
FROM information_schema.columns WHERE table_schema = 'public'
ORDER BY table_name, ordinal_position;

-- Primary keys
SELECT tc.table_name, kcu.column_name
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = 'public';

-- Foreign keys
SELECT tc.table_name, kcu.column_name,
  ccu.table_name AS referenced_table, ccu.column_name AS referenced_column
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name
WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public';
```

Cache structure:
```javascript
{
  tables: {
    'todos': {
      columns: { 'id': { type: 'text', nullable: false }, ... },
      primaryKey: ['id'],
      foreignKeys: [{ columns: ['user_id'], referencedTable: 'users', referencedColumns: ['id'] }]
    }
  }
}
```

**`query-parser.mjs`** — Parses PostgREST query params into a structured object:
- Filters: `?id=eq.1&status=neq.archived` → `[{column:'id', op:'eq', value:'1', negate: false}, ...]`
- Select: `?select=id,title` → `['id','title']`
- Order: `?order=created_at.desc` → `[{column:'created_at', dir:'desc', nulls: null}]`
- Limit/offset: `?limit=20&offset=0`
- Reserved params (not treated as filters): `select`, `order`, `limit`, `offset`, `on_conflict`
- Filter operators: eq, neq, gt, gte, lt, lte, like, ilike, in, is, not
- `not.` prefix negates: `id=not.eq.1` → `{negate: true}`
- `in` has parenthesized values: `status=in.(active,done)` → array
- `is` accepts: null, true, false

**`sql-builder.mjs`** — Takes parsed query + method + body + userId. Produces `{text, values}` parameterized SQL. Column/table names validated against schema cache whitelist, then double-quoted in SQL. User values always become `$N` params. Injects `user_id` filter for application-level RLS on tables that have a `user_id` column.

Operations:
- SELECT: `SELECT "col1","col2" FROM "table" WHERE ... ORDER BY ... LIMIT ... OFFSET ...`
- INSERT: `INSERT INTO "table" ("col1") VALUES ($1) RETURNING *` (if Prefer: return=representation)
- INSERT bulk: multiple VALUES tuples
- UPSERT: `INSERT ... ON CONFLICT ("col") DO UPDATE SET ...` (when on_conflict + Prefer: resolution=merge-duplicates)
- UPDATE: `PATCH` → `UPDATE "table" SET "col1" = $1 WHERE ... RETURNING *` (reject if no filters)
- DELETE: `DELETE FROM "table" WHERE ... RETURNING *` (reject if no filters)

**`router.mjs`** — Parses path to extract table name. The path from `@supabase/supabase-js` is `/rest/v1/{table}`. Strips `/rest/v1/` prefix, validates table against schema cache whitelist. Returns 404 for unknown tables. Also detects special routes: `/rest/v1/` (OpenAPI), `/rest/v1/_refresh`, `/rest/v1/rpc/{function}`.

**`response.mjs`** — PostgREST-format responses:
- SELECT: HTTP 200, bare JSON array body (NOT `{items:[...]}`)
- INSERT: HTTP 201 (with Prefer: return=representation → body is inserted rows), else 201 empty
- UPDATE: HTTP 200 with return=representation, else 204
- DELETE: HTTP 200 with return=representation, else 204
- Content-Range header: `0-24/1000` (with Prefer: count=exact, requires parallel COUNT query) or `0-24/*`
- CORS headers: `Access-Control-Allow-Methods: GET,POST,PATCH,DELETE,OPTIONS`, expose `Content-Range`
- Accept: `application/vnd.pgrst.object+json` → single object response (for `.single()` calls)

**`handler.mjs`** — Wires everything together. CORS preflight, extract method/path/userId, call router → parser → builder → execute → respond. Special routes:
- `GET /rest/v1/` — serves OpenAPI 3.0 spec (from `openapi.mjs`)
- `POST /rest/v1/_refresh` — forces schema cache reload and returns updated OpenAPI spec

**`openapi.mjs`** — Dynamically generates an OpenAPI 3.0 spec from the schema cache. The spec includes:
- `openapi: "3.0.3"`, info block with BOA version
- A path entry for each table (`/rest/v1/{table}`) with GET, POST, PATCH, DELETE operations
- Schema definitions for each table (columns → JSON Schema properties)
- PG type mapping: text→string, integer/bigint→integer, boolean→boolean, timestamptz→string(date-time), jsonb→object, uuid→string(uuid)
- Common query parameters: select, order, limit, offset, filter operators
- Cognito Bearer JWT auth scheme in securitySchemes
- PostgREST-compatible error schema
- Foreign key relationships as links between schemas
- Cached alongside schema cache (same TTL), regenerated on refresh

## Schema Update Flow (Zero-Deploy CX)

No Lambda redeployment needed for schema changes. The API auto-discovers tables and columns.

```
Developer: "add a posts table"
    │
    ▼
Agent runs SQL migration against DSQL:
  CREATE TABLE posts (id text primary key, user_id text, title text, ...);
    │
    ▼
Agent calls POST /rest/v1/_refresh
    │
    ▼
schema-cache.mjs re-queries information_schema → discovers "posts"
openapi.mjs regenerates spec with "posts" table and columns
    │
    ▼
GET /rest/v1/posts now works immediately
GET /rest/v1/ (OpenAPI spec) now includes "posts"
supabase.from('posts').select('*') ← works, no deploy
```

**What triggers schema discovery:**
1. **Lambda cold start** — full introspection runs automatically
2. **Cache TTL expiry** — re-introspects every 5 min (configurable via `SCHEMA_CACHE_TTL_MS`)
3. **`POST /rest/v1/_refresh`** — force refresh, returns updated OpenAPI spec immediately

**The skill teaches the agent to call `_refresh` after migrations.**

**What requires `sam deploy` (rare):**
- Changing Lambda memory/timeout, environment variables, Cognito, or API Gateway settings
- NOT: adding tables, columns, indexes, foreign keys (all via SQL, auto-discovered)

## Key Design Decisions

| Decision | Choice | Why |
|----------|--------|-----|
| Schema discovery | Dynamic from information_schema | Works with any agent-generated schema; no config file sync |
| SQL injection defense | Column whitelist from introspection + parameterized queries | Double defense: unknown columns rejected, values never interpolated |
| RLS | Application-level user_id filter | More predictable than DSQL RLS; works without DDL changes |
| Response format | Bare JSON arrays | PostgREST convention; supabase-js expects this |
| New dependencies | None | pg + @aws-sdk/dsql-signer already sufficient |
| PATCH vs PUT | PATCH for updates | PostgREST convention; supabase-js sends PATCH |
| OpenAPI | Dynamic from schema cache | Agents discover tables/columns automatically; auto-updates on schema change |

## Tier 1 Scope (MVP — what to build)

- `GET /rest/v1/` — **OpenAPI 3.0 spec** (dynamically generated from schema)
- `POST /rest/v1/_refresh` — **Force schema reload** (returns updated OpenAPI spec)
- `GET /rest/v1/{table}` — SELECT with filters, select, order, limit/offset
- `POST /rest/v1/{table}` — INSERT (single and bulk), upsert with on_conflict
- `PATCH /rest/v1/{table}?filters` — UPDATE
- `DELETE /rest/v1/{table}?filters` — DELETE
- Filter operators: eq, neq, gt, gte, lt, lte, like, ilike, in, is, not
- `Prefer: return=representation` and `Prefer: count=exact` headers
- PostgREST-compatible error format: `{ code, message, details, hint }`
- Content-Range response headers
- Schema introspection and column whitelisting
- Application-level user_id RLS

## Files to Create/Modify

| File | Action |
|------|--------|
| `plugin/lambda-templates/postgrest/db.mjs` | **Create** — extract pool from crud-api.mjs |
| `plugin/lambda-templates/postgrest/errors.mjs` | **Create** |
| `plugin/lambda-templates/postgrest/schema-cache.mjs` | **Create** |
| `plugin/lambda-templates/postgrest/query-parser.mjs` | **Create** |
| `plugin/lambda-templates/postgrest/sql-builder.mjs` | **Create** |
| `plugin/lambda-templates/postgrest/response.mjs` | **Create** |
| `plugin/lambda-templates/postgrest/router.mjs` | **Create** |
| `plugin/lambda-templates/postgrest/handler.mjs` | **Create** |
| `plugin/lambda-templates/postgrest/openapi.mjs` | **Create** — OpenAPI 3.0 spec generator |
| `plugin/lambda-templates/index.mjs` | **Rewrite** — export postgrest handler |
| `plugin/lambda-templates/crud-api.mjs` | **Keep as reference** (not imported anymore) |
| `plugin/templates/backend.yaml` | **No changes** — /{proxy+} already catches all paths |
| `plugin/lambda-templates/package.json` | **No changes** — no new deps |

## Implementation Order

1. `postgrest/db.mjs` — extract connection pool from crud-api.mjs
2. `postgrest/errors.mjs` — error format and codes
3. `postgrest/schema-cache.mjs` — introspection queries + caching + refresh()
4. `postgrest/query-parser.mjs` — parse filters, select, order, pagination
5. `postgrest/sql-builder.mjs` — SELECT, INSERT, UPDATE, DELETE, UPSERT builders
6. `postgrest/response.mjs` — format responses with headers
7. `postgrest/router.mjs` — path → table name + special routes
8. `postgrest/openapi.mjs` — OpenAPI 3.0 spec generator from schema cache
9. `postgrest/handler.mjs` — wire together + serve OpenAPI at root + _refresh endpoint
10. Rewrite `index.mjs` — export from postgrest/handler.mjs
11. Update `plugin/skills/boa/SKILL.md` — reflect PostgREST + OpenAPI compatibility
12. Update `plugin/docs/API-PATTERNS.md` — document PostgREST query syntax
13. Update `plugin/CLAUDE.md` — add PostgREST info

## Verification

1. Unit test query-parser: verify SQL output for `?id=eq.1`, `?status=in.(a,b)`, `?order=created_at.desc&limit=10`
2. Unit test sql-builder: verify parameterized SQL for SELECT, INSERT, PATCH, DELETE
3. Test `@supabase/supabase-js` connection (set supabaseUrl to API Gateway endpoint)
4. Test: `supabase.from('todos').select('*')` returns bare JSON array
5. Test: `.eq()`, `.gt()`, `.order()`, `.limit()` produce correct results
6. Test: `.insert()`, `.update()`, `.delete()` work with Prefer headers
7. Test: unknown columns return 400, unknown tables return 404
8. Test: user_id isolation (user A cannot see user B's data)
9. Test: `GET /rest/v1/` returns valid OpenAPI 3.0 JSON
10. Test: `POST /rest/v1/_refresh` reloads schema and returns updated spec
