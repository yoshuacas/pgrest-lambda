# PostgREST Compatibility Research

Date: 2026-04-12

## Goal

Validate pgrest-lambda's wire compatibility with PostgREST by building a portable HTTP test suite extracted from PostgREST's own test cases.

## PostgREST Test Suite Analysis

PostgREST's tests live at https://github.com/PostgREST/postgrest under `test/`.

### Structure

```
test/spec/                     # ~1,170 Haskell spec tests (hspec-wai)
  Main.hs                      # Entry point
  SpecHelper.hs                # Config, JWT helpers, shared utilities
  Feature/
    Query/                     # 28 spec files: CRUD, filters, embedding, RPC
    Auth/                      # 6 spec files: JWT, roles, anonymous access
    OpenApi/                   # 6 spec files: OpenAPI generation
    CorsSpec.hs, OptionsSpec.hs, RollbackSpec.hs, ...
  fixtures/
    load.sql                   # Orchestrator: loads all fixtures in order
    database.sql               # Extensions, drops/creates schemas
    roles.sql                  # 4 test roles
    schema.sql                 # 3,857 lines: tables, views, functions, types
    privileges.sql             # GRANT/REVOKE statements
    data.sql                   # Seed data
    jwt.sql, jsonschema.sql    # JWT and JSON schema validation functions

test/io/                       # Python IO tests (pytest + requests)
  conftest.py, postgrest.py    # Process management
  test_io.py, test_sanity.py   # Process lifecycle, smoke tests
```

### Why we can't run PostgREST's tests directly

The Haskell spec tests use `hspec-wai`, which calls PostgREST's WAI `Application` function in-process. There is no HTTP server involved. The tests import internal modules (`PostgREST.App`, `PostgREST.Config`, `PostgREST.SchemaCache.Identifiers`), construct Haskell-native config records, and invoke the application directly. There is no configurable base URL, no way to point them at a different server.

Rewriting pgrest-lambda in Haskell would not help. Even a Haskell implementation couldn't plug into these tests without becoming a PostgREST fork — the tests are coupled to PostgREST's internal API, not its HTTP API.

The Python IO tests (`test/io/`) do make HTTP requests, but they only test operational concerns (startup, shutdown, config reload, signals), not API behavior.

### What IS reusable

1. **SQL fixtures** — The `test/spec/fixtures/` directory contains standalone PostgreSQL DDL/DML. These can be loaded into any PostgreSQL database to create the exact schema PostgREST's tests expect: 78 tables, 20 views, 78 functions, 4 roles, seed data, grants.

2. **Test case specifications** — Each Haskell test is a readable HTTP assertion:
   ```haskell
   get "/items?id=eq.1" `shouldRespondWith`
     [json|[{"id":1}]|] { matchStatus = 200 }
   ```
   These can be mechanically extracted into request/response pairs: method, path, query string, expected status, expected body, expected headers.

## pgrest-lambda Current API Surface

### Supported

| Feature | Details |
|---|---|
| HTTP methods | GET, POST, PATCH, DELETE, OPTIONS |
| Paths | `/rest/v1/:table`, `/rest/v1/` (OpenAPI), `/rest/v1/_refresh` |
| Filter operators | eq, neq, gt, gte, lt, lte, like, ilike, in, is |
| Negation | `not.` prefix on any operator |
| Select | `?select=col1,col2` or `?select=*` |
| Order | `?order=col.desc.nullslast` (multi-column) |
| Pagination | `?limit=N&offset=M` |
| Upsert | `?on_conflict=col` with ON CONFLICT DO UPDATE/DO NOTHING |
| Prefer: return | `return=representation` on POST/PATCH/DELETE |
| Prefer: count | `count=exact` on GET (Content-Range with total) |
| Singular mode | `Accept: application/vnd.pgrst.object+json` |
| OpenAPI | Auto-generated 3.0.3 spec from schema introspection |
| Schema | Public schema only, tables (relkind 'r', 'p') |
| RLS model | Application-level: appends `WHERE user_id = $1` if column exists |

### Not supported (with PostgREST test counts)

| Feature | PostgREST tests | Effort | Priority |
|---|---|---|---|
| RPC / stored procedures | ~152 | Large | High — supabase-js uses this |
| Resource embedding (FK joins) | ~137 | Large | High — supabase-js uses this |
| And/Or boolean filter logic | ~41 | Medium | Medium |
| Aggregate functions | ~41 | Medium | Low |
| JSON operators (->, ->>, @>, <@) | ~37 | Medium | Medium |
| Content types (CSV, binary, NDJSON) | ~46 | Medium | Low |
| Multiple schemas | ~31 | Medium | Low |
| Range request headers | ~30 | Medium | Low |
| Full-text search (fts, plfts, etc.) | ~20 | Small | Medium |
| Array operators (cs, cd, ov) | ~15 | Small | Medium |
| Views and materialized views | ~20 | Small | High — easy win |
| EXPLAIN/plan output | ~43 | Medium | Low |
| PUT method | ~10 | Small | Low |
| HEAD method | ~5 | Trivial | Low |

### Fundamental architecture gap: RLS model

PostgREST uses PostgreSQL's native role system: `SET LOCAL role TO 'user_role'` on each request, then relies on PostgreSQL RLS policies for row filtering. pgrest-lambda uses application-level filtering (auto-appends `WHERE user_id = $1`).

This difference means:
- PostgREST tests expect `SET ROLE` behavior and PostgreSQL GRANT/REVOKE access control
- Many auth tests exercise role switching, which pgrest-lambda can't replicate
- The `user_id` append pattern isn't standard PostgREST behavior

Decision: If deep PostgREST compatibility is the goal, switch to `SET LOCAL role`. If supabase-js compatibility on own infra is the goal, the current approach works and only the HTTP surface needs to match.

## Plan: Portable HTTP Compatibility Test Suite

### Approach

Build a Node.js test suite (`node:test` + `fetch`) that:
1. Loads PostgREST's SQL fixtures into a test PostgreSQL database
2. Runs extracted HTTP test cases against a configurable endpoint
3. Can target both pgrest-lambda and real PostgREST (as reference)
4. Produces a compatibility scorecard per feature category

### Test extraction

Parse PostgREST's Haskell spec files to extract test cases into a JSON/JS format:
```javascript
{
  source: 'Feature/Query/QuerySpec.hs',
  category: 'basic-select',
  description: 'returns single item by id',
  request: { method: 'GET', path: '/items', query: 'id=eq.1' },
  expected: { status: 200, body: [{ id: 1 }] },
}
```

Priority spec files for extraction (cover features pgrest-lambda already supports):
- `Feature/Query/QuerySpec.hs` — 212 tests (basic SELECT, filters)
- `Feature/Query/InsertSpec.hs` — 74 tests
- `Feature/Query/UpdateSpec.hs` — 54 tests
- `Feature/Query/DeleteSpec.hs` — 14 tests
- `Feature/Query/UpsertSpec.hs` — 45 tests
- `Feature/Query/RangeSpec.hs` — 55 tests (pagination)
- `Feature/Query/SingularSpec.hs` — 28 tests
- `Feature/OpenApi/OpenApiSpec.hs` — 60 tests

Estimated ~500 tests covering currently-implemented features.

### Database setup

```bash
# Load PostgREST fixtures into test database
psql $TEST_DATABASE_URL -f test/spec/fixtures/load.sql
```

Fixtures create their own schemas, roles, tables, and seed data. They're self-contained.

### Phases

**Phase 1: Harness + baseline score**
- Build the test runner and fixture loader
- Extract test cases from QuerySpec, InsertSpec, UpdateSpec, DeleteSpec
- Run against pgrest-lambda, measure pass rate
- Run against real PostgREST to validate tests

**Phase 2: Close easy gaps**
- Add views/materialized views to schema introspection (expand relkind)
- Add missing filter operators: fts, cs, cd, ov, sl, sr, adj
- Add HEAD method
- Re-run, measure improvement

**Phase 3: Close high-value gaps**
- Add RPC support (function introspection + `/rpc/:name` routing)
- Add resource embedding (FK introspection + join generation)
- These are the two features supabase-js clients use most after basic CRUD

**Phase 4: Polish**
- And/Or boolean filter logic
- JSON operators
- Range request headers
- Multiple schema support
- Content negotiation (CSV)

### Success metrics

Track as: `X / Y tests passing (Z%)` per category. Target:
- Phase 1: establish baseline (likely 60-70% of extractable tests)
- Phase 2: 85%+ on basic CRUD categories
- Phase 3: RPC and embedding categories start passing
- Long-term: 90%+ overall on features pgrest-lambda implements
