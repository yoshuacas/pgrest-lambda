---
title: PostgREST compatibility
description: What pgrest-lambda passes of the upstream PostgREST test suite, measured against a live Aurora DSQL cluster, and which PostgREST features Aurora DSQL makes permanently unavailable.
---

# PostgREST compatibility

pgrest-lambda aims to be wire-compatible with PostgREST. This page reports how close it is, measured rather than claimed.

The measurement extracts every `shouldRespondWith` assertion in PostgREST's own Haskell test suite into 1,539 portable cases, then replays each one against the Lambda handler in-process, against a live Aurora DSQL cluster. **The engine passes 1,066 of the 1,358 cases that ran and are in scope — one thousand and sixty-six of one thousand three hundred and fifty-eight, 78.5%.** The other 181 extracted cases are held outside that denominator and itemised below. None of them counts as a pass.

Every number on this page comes from `conformance/results/run-2026-08-21T09-52-43-792Z.json` (run `2026-08-21T09:52:43Z`, measured on the integration commit whose parent is `acd3b91`) and `conformance/fixtures/load-report.json`. Two full runs of that tree exist, 1,062 and 1,066 of 1,358; the second is published and the four cases between them are a fix made after the first (`RangeSpec:37/52/118/133`, an RPC 416 that answered 500). The two runs disagree on ten further cases in both directions, all of them rows returned in a different order, which is the size of the run-to-run noise on this cluster — treat any difference of that size as noise, not progress.

The generated report at `compatreport/index.html` carries the same data with per-case detail and a section on how to read the number. `conformance/results/history.json` keeps every measured run.

## Read the denominator before quoting the number

Of the 1,539 extracted cases:

| Group | Cases | What it means |
|---|---|---|
| Passed | 1,066 | Status, body and asserted headers all match upstream. |
| Failed | 292 | Ran and did not match. In the pass rate. |
| Blocked | 129 | The table, view, function or column the case needs cannot be created on Aurora DSQL, so the assertion cannot run either way. |
| Needs engine config | 2 | The assertion only holds when the PostgREST process runs with a setting pgrest-lambda has no switch for. |
| Skipped at extraction | 35 | The Haskell assertion could not be converted without guessing — a header built by a helper, a body read from a file, a path taken from an earlier response. |
| Out of scope | 15 | Asserts namespaced run-time parameters (`response.headers`, `request.*`), which DSQL rejects outright. |

The pass rate is `passed / (passed + failed)` = 1,066 / 1,358. It is not 1,066 / 1,539, and it never counts an excluded case as a pass. Closing a harness skip or adding a missing setting moves cases *into* the denominator, where they usually fail first, so the rate can drop while the engine improves.

### The comparable earlier run, and a denominator that grew

The last published run measured with the same flags scored 945 of 1,285 (73.5%) on commit `eeb1ac9`. Matching case ids between that run and this one: **130 cases went from not passing to passing, and 9 went the other way.** Those are counted separately and never netted. Eight of the nine are `row-order-unspecified` cases that turn on DSQL storage order (`JsonOperatorSpec:248`, `QuerySpec:318`, `QuerySpec:324`, `QuerySpec:1265`, `SpreadQueriesSpec:65`, `SpreadQueriesSpec:78`, `UpdateSpec:120`, `UpdateSpec:539`) — the same band of cases moves in the other direction too. The ninth is `QuerySpec:521`, and it is a false pass that has been removed rather than a regression: upstream asserts 400 for a computed column defined outside the exposed schema, the fixture transform maps upstream's `test` schema onto `public`, so on this database the function *is* in the exposed schema and returning its rows is the correct answer. It used to "pass" only because the engine rejected any unknown filter column; the engine now qualifies the field the way upstream does, which is what makes real computed columns work.

The denominator grew from 1,285 to 1,358, and both parts of that are visible in the table above. 14 cases left `needs engine config` because the harness now boots upstream's own configuration for them (server timing, observability, OpenAPI mode, prepared statements, client error verbosity, legacy target names, `db-pre-config`); 11 of the 14 pass. The other 60 moved from `blocked` to `fail` for one reason: those cases filter on a column DSQL cannot store (`entities.arr`, `ranges.range`, `entities.text_search_vector`, `complex_items.arr_data`), and the harness attributed them to the fixture drop by matching the engine's `PGRST204` wording. The engine now answers with PostgreSQL's own `42703 column entities.arr does not exist`, which is upstream's behaviour (QuerySpec.hs:1556) but not a string the drop-attribution recognises, so they are scored as failures. Nothing about those 60 cases changed on the database side; if they were attributed as before, the rate would read 1,066 of 1,298 (82.1%). The lower number is the published one.

The original baseline scored 135 of 1,153, but it was measured without `--reload-per-spec`. Its percentage is not comparable with this one and is not compared here. The flag-independent statement is the id-matched one: against the baseline, 816 cases went from not passing to passing and 6 went the other way.

## What works

By category, passed of the cases that ran:

| Category | Passed / ran | Rate | Blocked | Needs config | Other excluded | Extracted |
|---|---|---|---|---|---|---|
| `cors` | 9 / 9 | 100% | 0 | 0 | 0 | 9 |
| `openapi` | 5 / 5 | 100% | 0 | 2 | 1 | 8 |
| `http-headers` | 1 / 1 | 100% | 1 | 0 | 0 | 2 |
| `observability` | 12 / 12 | 100% | 1 | 0 | 0 | 13 |
| `options` | 1 / 1 | 100% | 0 | 0 | 0 | 1 |
| `plan` | 3 / 3 | 100% | 0 | 0 | 0 | 3 |
| `range` | 55 / 57 | 96% | 0 | 0 | 0 | 57 |
| `aggregates` | 48 / 50 | 96% | 0 | 0 | 0 | 50 |
| `embedding` | 273 / 288 | 95% | 11 | 0 | 0 | 299 |
| `select` | 65 / 69 | 94% | 2 | 0 | 1 | 72 |
| `rpc` | 137 / 147 | 93% | 41 | 0 | 17 | 205 |
| `singular` | 33 / 36 | 92% | 0 | 0 | 0 | 36 |
| `upsert` | 46 / 53 | 87% | 10 | 0 | 0 | 63 |
| `multiple-schemas` | 22 / 29 | 76% | 7 | 0 | 0 | 36 |
| `json-operators` | 46 / 62 | 74% | 1 | 0 | 2 | 65 |
| `insert` | 51 / 70 | 73% | 11 | 0 | 4 | 85 |
| `preferences` | 21 / 29 | 72% | 0 | 0 | 0 | 29 |
| `delete` | 13 / 18 | 72% | 0 | 0 | 0 | 18 |
| `update` | 47 / 69 | 68% | 1 | 0 | 0 | 70 |
| `filters` | 129 / 214 | 60% | 25 | 0 | 1 | 240 |
| `media-types` | 33 / 62 | 53% | 13 | 0 | 0 | 75 |
| `rollback` | 1 / 2 | 50% | 0 | 0 | 24 | 26 |
| `errors` | 5 / 19 | 26% | 2 | 0 | 0 | 21 |
| `auth` | 10 / 53 | 19% | 3 | 0 | 0 | 56 |

Read down that table rather than across it: a category with a high rate is a feature you can rely on, and one with a low rate is not.

Grouping the same cases by the request feature they use gives a sharper picture. Each row is one predicate over the extracted case, listed with the row in `conformance/report/feature-table.mjs`, so the table can be regenerated with `node conformance/report/feature-table.mjs --markdown` and argued with rather than trusted. Counts are cases that ran, so a feature showing `0 / 0` has no measurement at all on DSQL:

| Request feature | Passed / ran | Rate | Excluded |
|---|---|---|---|
| `!inner` embed | 68 / 68 | 100% | 0 |
| `!left` embed | 3 / 3 | 100% | 0 |
| `HEAD` | 46 / 46 | 100% | 4 |
| `match` / `imatch` (POSIX regex) | 7 / 7 | 100% | 3 |
| `Prefer: count=exact` | 54 / 54 | 100% | 1 |
| `Prefer: resolution=merge-duplicates` | 12 / 12 | 100% | 2 |
| `Prefer: tx=commit` | 15 / 15 | 100% | 6 |
| `Range` request header | 21 / 21 | 100% | 0 |
| `text/csv` | 12 / 12 | 100% | 3 |
| Unsatisfiable range → 416 | 6 / 6 | 100% | 0 |
| `order` on an embedded resource | 53 / 54 | 98% | 1 |
| Spread embed (`...table(col)`) | 84 / 86 | 98% | 0 |
| `Accept: application/vnd.pgrst.object+json` | 32 / 33 | 97% | 2 |
| `like` / `ilike` | 29 / 30 | 97% | 2 |
| Aggregate in a select list | 34 / 35 | 97% | 0 |
| `PUT` | 23 / 24 | 96% | 5 |
| Cast in a select list (`col::type`) | 26 / 28 | 93% | 0 |
| `is` operator | 35 / 38 | 92% | 0 |
| `order=` | 137 / 149 | 92% | 11 |
| `limit` / `offset` | 54 / 60 | 90% | 2 |
| RPC via `GET /rpc/...` | 97 / 108 | 90% | 39 |
| `Content-Range` asserted on the response | 142 / 162 | 88% | 2 |
| `in` operator | 61 / 72 | 85% | 7 |
| RPC via `POST /rpc/...` | 76 / 89 | 85% | 30 |
| `DELETE` | 31 / 39 | 79% | 2 |
| JSON path (`->`, `->>`) in the query string | 51 / 67 | 76% | 3 |
| `Accept-Profile` / `Content-Profile` | 17 / 23 | 74% | 0 |
| `PATCH` | 64 / 89 | 72% | 2 |
| `and=(...)` / `or=(...)` grouping | 33 / 47 | 70% | 3 |
| `not.` negation | 31 / 44 | 70% | 6 |
| `Prefer: resolution=ignore-duplicates` | 7 / 10 | 70% | 3 |
| `Prefer: return=representation` | 115 / 166 | 69% | 13 |
| `columns=` | 22 / 34 | 65% | 1 |
| `on_conflict` | 2 / 4 | 50% | 0 |
| `fts` / `plfts` / `phfts` / `wfts` | 8 / 47 | 17% | 24 |
| JWT in `Authorization` | 6 / 59 | 10% | 2 |
| `cs`, `cd`, `ov`, `sl`, `sr`, `adj` | 0 / 14 | 0% | 2 |
| `Prefer: tx=rollback` | 0 / 0 | — | 0 |

Four rows need reading carefully.

The containment and range operators pass none of their 14 measured cases, and no engine change can fix that: every upstream case for them uses an array or a range column, and DSQL stores neither, so the request reaches a column that is not there (`42703 column entities.arr does not exist`). They are implemented in the engine and unit-tested; this suite cannot confirm them on DSQL.

Full-text search passes 8 of 47 because most of the rest name a text search configuration DSQL does not have. See [Text search beyond `simple`](#text-search-beyond-the-simple-configuration).

`Prefer: tx=rollback` has no measurement at all, and its neighbour `tx=commit` explains why: the upstream rollback specs set `tx=commit` and rely on the harness rolling every request back, which is the one thing DSQL cannot do. 24 of the 26 rollback cases are excluded for that reason.

Requests carrying a JWT pass 6 of 59 because most of those cases assert what `SET ROLE` plus `GRANT` would answer. See [`SET ROLE`, `GRANT` and row-level security](#set-role-grant-based-access-control-and-row-level-security). The JWT itself is verified correctly; the authorization decision behind it is a different model.

## What does not work yet

292 cases fail. Most are engine work that nothing in DSQL prevents; the rest need a DSQL substitute or are the order-dependent assertions described below. The largest groups, by failing cases:

| Failing cases | Gap | What is missing |
|---|---|---|
| 56 | `no-set-role` | Upstream's authorization: `SET ROLE` plus `GRANT` plus RLS. DSQL has none of it. Permanent — see below. |
| 39 | `unimplemented-feature-filters` | A filter on a column DSQL refused to create (`entities.arr`, `ranges.range`, `entities.text_search_vector`, `complex_items.arr_data`). The engine passes the name to the database, which answers `42703`, exactly as upstream would. Permanent — see below. |
| 24 | `missing-operator-fts` | Text search configurations DSQL does not ship, and `tsvector` columns it will not store. Permanent — see below. |
| 23 | `unimplemented-feature-media-types` | Custom media types produced by a function (`application/geo+json`, `text/tab-separated-values`); the engine answers `PGRST107`. |
| 21 | `row-order-unspecified` | The same rows in a different order. Kept as failures — see below. |
| 15 | `body-mismatch-filters` | Right status, wrong body. Most are full-text filters returning no rows on DSQL's `simple` configuration. |
| 15 | `unimplemented-feature-json-operators` | A JSON operator applied to a column DSQL refused to create — same root cause as the filter group above. |
| 11 | `unimplemented-feature-insert` | Insert bodies the engine turns into a database error (`22P02`) instead of a PostgREST one. |
| 11 | `body-mismatch-update` | Right status, wrong body from an update. |
| 10 | `header-mismatch-content-length` | Byte count off by a couple of bytes — JSON separators. |
| 7 | `body-mismatch-upsert` | Right status, wrong body from an upsert. |
| 6 | `no-foreign-keys` | Relationships the manifest cannot express: a view's column provenance, and disambiguating two relationships that join the same pair of relations. |
| 5 | `body-mismatch-media-types` | Right status, wrong body for a media type. |
| 4 | `body-mismatch-delete` | Right status, wrong body from a delete. |
| 4 | `unimplemented-feature-multiple-schemas` | Cross-schema behaviour the engine does not implement yet. |
| 4 | `body-mismatch-insert` | Right status, wrong body from an insert. |
| 4 | `body-mismatch-embedding` | Right status, wrong embedded row shape. |
| 4 | `header-mismatch-content-range` | `Content-Range: 0-0/*` expected, `*/*` sent. |
| 3 | `body-mismatch-multiple-schemas` | Right status, wrong body from a non-default schema. |
| 3 | `body-mismatch-singular` | Right status, wrong body under `Accept: application/vnd.pgrst.object+json`. |
| 3 | `unimplemented-feature-update` | Same as the insert group, on `PATCH`. |
| 2 | `engine-error` | A 500. Both are `INSERT` into a view DSQL will not let anything insert into (`55000 cannot insert into view`). |

One category passes nothing at all: `auth` passes 10 of 53, and 43 of those failures are the `SET ROLE` model described below.


### The order-dependent failures stay failures

21 cases fail only because the rows came back in a different order: `JsonOperatorSpec:248`, `QueryLimitedSpec:97`, `QueryLimitedSpec:108`, `QuerySpec:318`, `QuerySpec:324`, `QuerySpec:338`, `QuerySpec:345`, `QuerySpec:382`, `QuerySpec:389`, `QuerySpec:1265`, `QuerySpec:1282`, `QuerySpec:1313`, `QuerySpec:1427`, `SpreadQueriesSpec:65`, `SpreadQueriesSpec:78`, `TimezoneSpec:15`, `TimezoneSpec:25`, `TimezoneSpec:61`, `TimezoneSpec:71`, `UpdateSpec:120` and `UpdateSpec:539`. Which cases land in this group moves between runs — the count across the nine recorded runs is 5, 12, 19, 16, 14, 14, 7, 11 and 21 — because it is decided by DSQL's storage order rather than by engine behaviour. Upstream's assertion lists rows in the order a PostgreSQL heap scan returns them after a fresh insert. Aurora DSQL does not preserve insertion order and pgrest-lambda does not add an implicit `ORDER BY`, so a query with no `order=` can legitimately return the same rows in any sequence.

They are counted as failures. Reclassifying them would lift the published rate by about a point and a half on a technicality. They are also the whole run-to-run noise band: between the two runs of this tree, ten cases moved in one direction or the other and every one of them is in this group. Do not read a change in this number as engine work.

## Permanently unavailable on Aurora DSQL

Aurora DSQL is not a drop-in PostgreSQL. The fixtures are upstream's, mechanically transformed until they load: 1,116 of 1,116 statements apply, producing 215 tables, 80 views, 153 functions and 23 domains — and 410 constructs are dropped, each with a recorded reason in `conformance/fixtures/load-report.json`. Of those 410, 314 are constructs DSQL will never accept. The measured capability probe is in `conformance/DSQL-CAPABILITIES.md`.

286 cases sit on the wrong side of that line: 129 blocked, 15 out of scope, and 142 failures that need a substitute rather than a fix — 56 `no-set-role`, 39 filters and 15 JSON operators on a column DSQL will not store, 24 full-text search, 6 relationships no manifest can express, and 2 inserts into a view DSQL will not write through.

The features below cannot work on DSQL as PostgREST implements them. This is a property of the database, not a backlog.

### Foreign keys, and therefore FK-derived embedding

DSQL rejects `FOREIGN KEY` and `ALTER TABLE ... ADD CONSTRAINT`, and `pg_constraint` returns zero rows for `contype='f'`. PostgREST derives resource embedding entirely from that catalog, so on DSQL there is nothing to derive from: 115 foreign keys are dropped at fixture load.

The substitute is a declared-relationship manifest. Point `PGREST_RELATIONSHIPS_PATH` at a JSON file listing the keys the catalog cannot report and embedding works — the `embedding` category runs at 273 of 288 with it. Measured on commit `3fbf941` with everything else held constant, the `no-foreign-keys` gap was 189 failures without the manifest and 28 with it. Both runs are in `conformance/results/history.json`.

What the manifest cannot express is a relationship that was never a foreign key: a view's column provenance, which upstream reads from `pg_rewrite`, and the disambiguation between two relationships joining the same pair of relations. Those 6 remaining failures need engine support, not data.

### `SET ROLE`, `GRANT`-based access control and row-level security

DSQL rejects `SET ROLE` and `SET LOCAL ROLE`, rejects `ALTER TABLE ... ENABLE ROW SECURITY`, and does not implement `CREATE POLICY`. PostgREST's authorization *is* PostgreSQL authorization: it switches role per request and lets `GRANT` and RLS decide. That model is unreachable here, so pgrest-lambda enforces authorization in the engine instead (see [Authorization](./authorization)).

56 cases fail because of it — 43 in `auth`, 9 in `errors`, 2 in `insert`, 1 each in `delete` and `rpc`. They assert the 401 or 403 that a role switch plus a `GRANT` would produce, and the engine's own decision does not reproduce upstream's wire response case for case. Roles can be created on DSQL; they just cannot be assumed.

### plpgsql, and therefore triggers

`CREATE FUNCTION ... LANGUAGE plpgsql` is rejected. 36 fixture functions and the 16 triggers that depend on them are dropped, which blocks 32 cases outright. Functions in `LANGUAGE sql` work, including `RETURNS SETOF` and `RETURNS TABLE`, so most RPC is testable — the `rpc` category runs at 137 of 147. Any test whose function body needs procedural code is not testable.

### Namespaced run-time parameters

`set_config('response.headers', ...)`, `SET LOCAL "response.headers"` and the `request.*` claim GUCs are all rejected. PostgREST uses them to let a function set response headers and to expose JWT claims to SQL. Because DSQL parses SQL function bodies at `CREATE` time, the `SET` form also fails the `CREATE FUNCTION`, so 6 fixture functions never exist. 15 cases are reported out of scope for this reason, all in `rpc`.

### Text search beyond the `simple` configuration

`pg_ts_config` contains one row. `to_tsvector('english', ...)` fails with `text search configuration "english" does not exist`, and `tsvector` is not a usable column type. The `fts`, `plfts`, `phfts` and `wfts` operators are implemented and 8 upstream cases pass with them, but 17 of the 24 failures name a configuration such as `english`, `french` or `german` and cannot pass as written; the other 7 use a `tsvector` column, domain or function DSQL dropped. There is also no GIN index (`USING` is rejected for `CREATE INDEX`), so full-text and array queries have no index support.

Set `PGREST_DEFAULT_TS_CONFIG=simple` on DSQL. Without it the engine emits PostgreSQL's default (`english`) and every full-text query errors.

### Column types DSQL will not store

Arrays and range types work in expressions and as function arguments, but DSQL rejects them as column types — and a range is also rejected as a function return type. Measured at fixture load, 12 cases are blocked outright because the relation they address lost every column, and 54 more fail with PostgreSQL's own `42703 column … does not exist` when a filter or JSON operator names one of the missing columns — `entities.arr`, `complex_items.arr_data`, `arrays.numbers`, `fav_numbers.num`, `ranges.range`, `entities.text_search_vector`. The engine's answer there is upstream's answer; only the fixture is impossible. 35 column definitions and 4 domain base types are dropped for this reason, plus 19 functions that return or take one of those types, plus 5 tables where no column survived.

Enum and composite types cannot be created at all (`CREATE TYPE` is rejected — 8 in the fixtures, 6 blocked cases), and neither can extensions (7 dropped, so no `postgis`, `citext`, `ltree` or `hstore` columns, and 2 blocked cases).

### Other DDL the fixtures need and DSQL refuses

Partitioned tables (12 dropped, 14 blocked cases), materialized views (2 dropped, 1 blocked case), `CREATE TABLE AS` (2), user-defined aggregates (14), user-defined casts (15), rules (1), procedures (1), `TRUNCATE`, temporary tables, and `SAVEPOINT`. DSQL also caps a database at 10 schemas, which drops 1 fixture schema.

The absence of `SAVEPOINT` is the one that shapes the measurement itself. Upstream sets `configDbTxRollbackAll = True` (`test/spec/SpecHelper.hs`), so every upstream request rolls back and no example ever sees another example's writes. pgrest-lambda cannot do that on DSQL, so the harness reloads fixtures once per spec file instead. Cases that mutate data can still affect later cases in the same file. The report's "How to read this number" section quantifies what that costs: measured on commit `3fbf941` with everything else held constant, 443 of 1,199 without per-spec reload and 550 of 1,199 with it.

## Settings that change the score

| Setting | Effect |
|---|---|
| `PGREST_RELATIONSHIPS_PATH` | Declared relationships for a database with no foreign keys. Required on DSQL; without it, embedding degrades silently. |
| `PGREST_DEFAULT_TS_CONFIG` | Text search configuration. Must be `simple` on DSQL. |
| `PGREST_REPRESENTATIONS_PATH` | Declared data representations for a database that rejects `CREATE CAST`. The runner defaults it to `conformance/fixtures/representations.json` for `--target dsql`; without it the `datarep_*` cases are measured against the untransformed column value. |
| `PGREST_DB_BULK_MUTATION_GUARD` | The harness runs with `off`. The engine's default is `on`, which refuses a filterless `PATCH`/`DELETE`; upstream has no such guard unless the `pg_safeupdate` extension is loaded, so measuring upstream's behaviour means matching upstream's state. `PgSafeUpdateSpec` is measured separately with `safeupdate`. |

The harness also boots the engine with upstream's own non-default configuration for 12 spec ranges that require one — `db-schemas`, `db-extra-search-path`, `db-max-rows`, `db-aggregates-enabled`, `db-plan-enabled`, `db-pre-request`, `server-cors-allowed-origins`. Those cases are measured, not excluded.

2 cases still need a setting the engine does not have, both `db-root-spec` (`RootSpec:19` and `RootSpec:28`): upstream serves a function's result at `/` instead of the generated spec, and the fixture function is plpgsql, which DSQL dropped. The 14 cases that were here in the previous run — OpenAPI mode, prepared-statement control, a server trace header, the JWT cache with server timing, legacy target names, client error verbosity and `db-pre-config` — are now measured, and 11 of them pass. Adding a switch moves its cases into the denominator, where they fail until the behaviour behind the switch exists.

## Standard PostgreSQL

This page measures Aurora DSQL only. There is no conformance number for standard PostgreSQL yet, and most of the section above does not apply to it: foreign keys, plpgsql, triggers, enums, extensions, `SET ROLE`, RLS, array and range columns and every text search configuration work normally there. The engine probes the database at startup and adapts (`supportsForeignKeys`, `supportsFullTextSearch`, `supportsRangeTypes`, `supportsRowLevelSecurity`, `supportsGinIndex`, …), so on PostgreSQL it reads relationships from `pg_constraint` and needs no manifest. Do not read 78.5% as pgrest-lambda's compatibility on PostgreSQL; read it as the compatibility measured on DSQL, which is the harder target.

## Reproducing the measurement

```bash
# fixtures must already be loaded; see conformance/CONTRACTS.md for the cluster
PGREST_RELATIONSHIPS_PATH=$PWD/conformance/fixtures/relationships.json \
  node conformance/runner/run.mjs --target dsql --concurrency 1 --reload-per-spec
node conformance/report/build-report.mjs \
  --label "$(git rev-parse --short HEAD)" \
  --flags "--target dsql --concurrency 1 --reload-per-spec, PGREST_RELATIONSHIPS_PATH set"
```

`--reload-per-spec` matters: without it the specs that mutate data leave rows behind for every spec that runs after them. The DSQL connection needs a fresh IAM token, valid one hour.

`compatreport/README.md` documents the report, the trend file and the honesty rules that govern both.
