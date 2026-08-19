---
title: PostgREST compatibility
description: What pgrest-lambda passes of the upstream PostgREST test suite, measured against a live Aurora DSQL cluster, and which PostgREST features Aurora DSQL makes permanently unavailable.
---

# PostgREST compatibility

pgrest-lambda aims to be wire-compatible with PostgREST. This page reports how close it is, measured rather than claimed.

The measurement extracts every `shouldRespondWith` assertion in PostgREST's own Haskell test suite into 1,539 portable cases, then replays each one against the Lambda handler in-process, against a live Aurora DSQL cluster. **The engine passes 547 of the 1,199 cases that ran and are in scope — 45.6%.** The other 340 extracted cases are held outside that denominator and itemised below; none of them counts as a pass.

Every number on this page comes from `conformance/results/latest.json` (run `2026-08-19T16:16:37Z`, commit `3fbf941` plus uncommitted engine work) and `conformance/fixtures/load-report.json`. The generated report at `compatreport/index.html` carries the same data with per-case detail, and `conformance/results/history.json` keeps the trend.

## Read the denominator before quoting the number

Of the 1,539 extracted cases:

| Group | Cases | What it means |
|---|---|---|
| Passed | 547 | Status, body and asserted headers all match upstream. |
| Failed | 652 | Ran and did not match. In the pass rate. |
| Blocked | 173 | The table, view, function or column the case needs cannot be created on Aurora DSQL, so the assertion cannot run either way. |
| Needs engine config | 124 | The assertion only holds when the PostgREST process runs with a setting pgrest-lambda has no switch for (`db-schemas`, `db-extra-search-path`, `db-pre-request`, `db-max-rows`, JWT audience/JWKS, CORS origins, trace header). A missing engine feature, not a harness limit. |
| Skipped at extraction | 35 | The Haskell assertion could not be converted without guessing — a header built by a helper, a body read from a file, a path taken from an earlier response. |
| Out of scope | 8 | Asserts namespaced run-time parameters (`response.headers`), which DSQL rejects outright. |

The pass rate is `passed / (passed + failed)` = 547 / 1,199. It is not 547 / 1,539, and it never counts an excluded case as a pass. Closing a harness skip or adding a missing setting moves cases *into* the denominator, where they usually fail first, so the rate can drop while the engine improves.

The same suite scored 135 of 1,153 (11.7%) on 2026-08-19 at 10:44 UTC, which is the baseline the report compares against.

## What works

By category, passed of ran:

| Category | Passed / ran | Rate | Blocked | Needs config | Excluded | Extracted |
|---|---|---|---|---|---|---|
| `json-operators` | 46 / 47 | 98% | 16 | 0 | 2 | 65 |
| `range` | 38 / 45 | 84% | 0 | 12 | 0 | 57 |
| `select` | 45 / 60 | 75% | 2 | 9 | 1 | 72 |
| `cors` | 3 / 5 | 60% | 0 | 4 | 0 | 9 |
| `filters` | 101 / 173 | 58% | 66 | 0 | 1 | 240 |
| `upsert` | 30 / 53 | 57% | 10 | 0 | 0 | 63 |
| `singular` | 19 / 36 | 53% | 0 | 0 | 0 | 36 |
| `preferences` | 15 / 29 | 52% | 0 | 0 | 0 | 29 |
| `rollback` | 1 / 2 | 50% | 0 | 0 | 24 | 26 |
| `aggregates` | 22 / 46 | 48% | 0 | 4 | 0 | 50 |
| `delete` | 7 / 18 | 39% | 0 | 0 | 0 | 18 |
| `embedding` | 105 / 286 | 37% | 13 | 0 | 0 | 299 |
| `rpc` | 57 / 153 | 37% | 32 | 10 | 10 | 205 |
| `openapi` | 1 / 3 | 33% | 0 | 4 | 1 | 8 |
| `update` | 20 / 64 | 31% | 2 | 4 | 0 | 70 |
| `media-types` | 14 / 47 | 30% | 15 | 13 | 0 | 75 |
| `insert` | 20 / 71 | 28% | 10 | 0 | 4 | 85 |
| `auth` | 2 / 33 | 6% | 3 | 20 | 0 | 56 |
| `errors` | 1 / 17 | 6% | 2 | 2 | 0 | 21 |
| `http-headers` | 0 / 1 | 0% | 0 | 1 | 0 | 2 |
| `observability` | 0 / 9 | 0% | 1 | 3 | 0 | 13 |
| `options` | 0 / 1 | 0% | 0 | 0 | 0 | 1 |
| `multiple-schemas` | 0 / 0 | — | 1 | 35 | 0 | 36 |
| `plan` | 0 / 0 | — | 0 | 3 | 0 | 3 |

Read down that table rather than across it: a category with a high rate is a feature you can rely on, and one with a low rate is not. Grouping the same cases by the request feature they use gives a sharper picture. Counts are cases that ran, so a feature with `0 / 0` has no measurement at all on DSQL:

| Request feature | Passed / ran | Excluded |
|---|---|---|
| `Range` request header | 20 / 20 | 1 |
| Unsatisfiable range → 416 | 11 / 11 | 0 |
| `match` / `imatch` (POSIX regex) | 7 / 7 | 3 |
| `!left` embed | 3 / 3 | 0 |
| JSON path (`->`, `->>`) in the query string | 47 / 53 | 18 |
| `PUT` | 20 / 22 | 7 |
| `in` operator | 47 / 67 | 12 |
| Cast in a select list (`col::type`) | 20 / 28 | 0 |
| `and=(...)` / `or=(...)` grouping | 30 / 44 | 11 |
| `Accept: application/vnd.pgrst.object+json` | 23 / 33 | 2 |
| `Prefer: count=exact` | 26 / 53 | 2 |
| `Content-Range` asserted on the response | 74 / 153 | 11 |
| `is` operator | 16 / 38 | 0 |
| `like` / `ilike` | 12 / 29 | 3 |
| `!inner` embed | 24 / 68 | 0 |
| `Prefer: return=representation` | 49 / 150 | 29 |
| `HEAD` | 15 / 39 | 11 |
| `text/csv` | 6 / 12 | 3 |
| `fts` / `plfts` / `phfts` / `wfts` | 6 / 26 | 14 |
| `order` on an embedded resource | 4 / 56 | 3 |
| `on_conflict` | 2 / 4 | 0 |
| `Prefer: resolution=merge-duplicates` | 3 / 12 | 2 |
| `Prefer: resolution=ignore-duplicates` | 0 / 10 | 3 |
| `cs`, `cd`, `ov`, `sl`, `sr`, `adj` | 0 / 0 | 16 |

Two entries need reading carefully. The containment and range operators have no measurement because every upstream case for them uses an array or range column, and DSQL stores neither — they are implemented in the engine and unit-tested, but this suite cannot confirm them. `ignore-duplicates` fails all ten of its cases.

Error bodies are the `{code, message, details, hint}` shape and the SQLSTATE-to-status mapping is a port of upstream's `mapSQLtoHTTP`, but the `errors` category still passes only 1 of 17: 9 of those failures assert the `SET ROLE` authorization model, 5 want a `Proxy-Status` response header the engine does not send, and 1 is an unmapped `42P17`.

## What does not work yet

652 cases fail. 566 of those are engine work that nothing in DSQL prevents; the largest groups, by failing cases:

| Failing cases | Gap | What is missing |
|---|---|---|
| 64 | `unimplemented-feature-embedding` | Spread embeds (`...table(col)`) are rejected by the select parser. |
| 33 | `body-mismatch-filters` | Right status, wrong body — mostly row shape rather than row selection. |
| 29 | `rpc-overload-resolution` | Overloaded functions: the engine cannot choose between candidates and answers `PGRST203`. |
| 28 | `no-foreign-keys` | Computed relationships (a function returning `SETOF` a table used as an embed target) and embeds that need more than one relationship between the same pair of relations. |
| 27 | `unimplemented-empty-embed` | `select=clients()` — an embed with an empty column list. |
| 25 | `unimplemented-feature-insert` | Bulk and edge-case insert bodies the engine turns into a database error instead of a PostgREST one. |
| 23 | `unimplemented-feature-rpc` | `VARIADIC`, `OUT` and `INOUT` parameters are not introspected, so 15 of these functions are reported missing (`PGRST202`). |
| 23 | `unimplemented-nested-embed-filters` | Filters nested more than one level deep (`projects.clients.id=eq.1`). |
| 22 | `unimplemented-feature-aggregates` | Aggregates inside an embedded resource; 21 of the 22 are inside a spread embed. |
| 21 | `body-mismatch-rpc` | Right status, wrong body from an RPC. |
| 20 | `body-mismatch-insert` | Right status, wrong body from an insert. |
| 19 | `unimplemented-feature-upsert` | Upserts that should merge and instead raise a uniqueness or not-null error. |
| 19 | `row-order-unspecified` | The same rows in a different order. DSQL does not promise a physical row order and the engine does not add an implicit `ORDER BY`; counted as failures anyway. |
| 15 | `bulk-mutation-guard-always-on` | The engine always requires a filter on `UPDATE`/`DELETE` (`PGRST106`); upstream only does so under `db-safe-update`. |
| 9 | `header-mismatch-server-timing` | No `Server-Timing` header. |

Three categories pass nothing at all: `observability` (9 cases, all `Server-Timing`), `http-headers` (1) and `options` (1).

## Permanently unavailable on Aurora DSQL

Aurora DSQL is not a drop-in PostgreSQL. The fixtures are upstream's, mechanically transformed until they load: 1,116 of 1,116 statements apply, producing 215 tables, 80 views, 153 functions and 23 domains — and 410 constructs are dropped, each with a recorded reason in `conformance/fixtures/load-report.json`. The measured capability probe is in `conformance/DSQL-CAPABILITIES.md`.

The features below cannot work on DSQL as PostgREST implements them. This is a property of the database, not a backlog.

### Foreign keys, and therefore FK-derived embedding

DSQL rejects `FOREIGN KEY` constraints, and `pg_constraint` returns zero rows for `contype='f'`. PostgREST derives resource embedding entirely from that catalog, so on DSQL there is nothing to derive from: 115 foreign keys are dropped at fixture load.

The substitute is a declared-relationship manifest. Point `PGREST_RELATIONSHIPS_PATH` at a JSON file listing the keys the catalog cannot report and embedding works. The effect is measured on the same commit and the same suite: without the manifest the `no-foreign-keys` gap is 189 failures and the whole suite scores 420 of 1,199; with it the gap is 28 failures and the suite scores 547 of 1,199. Both runs are in `conformance/results/history.json`.

What the manifest cannot express is a relationship that was never a foreign key — PostgREST's computed relationships, where a function returning `SETOF` a table is used as an embed target. Those 22 cases need engine support, not data.

### `SET ROLE`, `GRANT`-based access control and row-level security

DSQL rejects `SET ROLE`, `SET LOCAL ROLE` and `ALTER TABLE ... ENABLE ROW SECURITY`, and does not implement `CREATE POLICY`. PostgREST's authorization *is* PostgreSQL authorization: it switches role per request and lets `GRANT` and RLS decide. That model is unreachable here, so pgrest-lambda enforces authorization in the engine instead (see [Authorization](./authorization)).

43 cases fail because of it: they assert the 401 or 403 that a role switch plus a `GRANT` would produce. Roles can be created on DSQL; they just cannot be assumed.

### plpgsql, and therefore triggers

`CREATE FUNCTION ... LANGUAGE plpgsql` is rejected. 36 fixture functions and the 16 triggers that depend on them are dropped, which blocks 22 cases. Functions in `LANGUAGE sql` work, including `RETURNS SETOF` and `RETURNS TABLE`, so most RPC is testable — but any test whose function body needs procedural code is not.

### Namespaced run-time parameters

`set_config('response.headers', ...)`, `SET LOCAL "response.headers"` and the `request.*` claim GUCs are all rejected. PostgREST uses them to let a function set response headers and to expose JWT claims to SQL. Because DSQL parses SQL function bodies at `CREATE` time, the `SET` form also fails the `CREATE FUNCTION`, so 6 fixture functions never exist. 8 cases are reported out of scope for this reason.

### Text search beyond the `simple` configuration

`pg_ts_config` contains one row. `to_tsvector('english', ...)` fails with `text search configuration "english" does not exist`, and `tsvector` is not a usable column type. The `fts`, `plfts`, `phfts` and `wfts` operators are implemented and 6 upstream cases pass with them, but 17 more name `english`, `french` or `german` and cannot pass as written; the rest use a `tsvector` column, domain or function argument DSQL rejects. There is also no GIN index (`USING` is rejected for `CREATE INDEX`), so full-text and array queries have no index support.

Set `PGREST_DEFAULT_TS_CONFIG=simple` on DSQL. Without it the engine emits PostgreSQL's default (`english`) and every full-text query errors.

### Column types DSQL will not store

Measured at fixture load, these blocked cases outright: array columns such as `integer[]` (33 cases), range columns such as `numrange` (15), `money` (8), `bit(n)`, `xml`, `tsvector`, and the geometric and network types. Enum and composite types cannot be created at all (`CREATE TYPE` is rejected — 8 in the fixtures, 6 blocked cases), and neither can extensions (7 dropped, so no `postgis`, `citext`, `ltree` or `hstore` columns).

### Other DDL the fixtures need and DSQL refuses

Partitioned tables (`PARTITION BY` — 12 dropped, 16 blocked cases), materialized views (2 dropped), `CREATE TABLE AS`, user-defined aggregates (14) and casts (15), rules, procedures, `TRUNCATE`, temporary tables, and `SAVEPOINT`. The absence of `SAVEPOINT` is why the harness reloads fixtures per spec file instead of rolling back each request the way upstream does.

## Settings that change the score

| Setting | Effect |
|---|---|
| `PGREST_RELATIONSHIPS_PATH` | Declared relationships for databases with no foreign keys. Measured: 420 → 547 passing cases on DSQL. |
| `PGREST_DEFAULT_TS_CONFIG` | Text search configuration. Must be `simple` on DSQL. |

124 cases need a setting that does not exist yet. The largest groups: a different exposed schema (30), an extra search path (22), a pre-request function (14), a row limit (12), JWT audience and JWKS options (17), CORS allowed origins (4), a trace header (3), prepared-statement control (3), and 7 that assert a PostgREST feature which is off by default. The remaining 12 are one or two cases each — anonymous role, legacy target names, root spec, OpenAPI mode, error verbosity, JWT cache, pre-config. Adding a switch moves its cases into the denominator, where they will fail until the behaviour behind the switch exists.

## Standard PostgreSQL

This page measures Aurora DSQL only. There is no conformance number for standard PostgreSQL yet, and most of the section above does not apply to it: foreign keys, plpgsql, enums, extensions, `SET ROLE`, RLS and every text search configuration work normally there. The engine probes the database at startup and adapts (`supportsForeignKeys`, `supportsFullTextSearch`, `supportsRangeTypes`, `supportsRowLevelSecurity`, `supportsGinIndex`, …), so on PostgreSQL it reads relationships from `pg_constraint` and needs no manifest. Do not read 45.6% as pgrest-lambda's compatibility on PostgreSQL; read it as the compatibility measured on DSQL, which is the harder target.

## Reproducing the measurement

```bash
# fixtures must already be loaded; see conformance/CONTRACTS.md for the cluster
PGREST_RELATIONSHIPS_PATH=$PWD/conformance/fixtures/relationships.json \
  node conformance/runner/run.mjs --target dsql --concurrency 1 --reload-per-spec
node conformance/report/build-report.mjs \
  --label "$(git rev-parse --short HEAD)" \
  --flags "--target dsql --concurrency 1 --reload-per-spec, PGREST_RELATIONSHIPS_PATH set"
```

`--reload-per-spec` matters: without it the specs that mutate data leave rows behind for every spec that runs after them. Two runs of the same commit still differ by a handful of cases, so treat a difference of that size as noise.

`compatreport/README.md` documents the report, the trend file and the honesty rules that govern both.
