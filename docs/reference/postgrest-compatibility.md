---
title: PostgREST compatibility
description: What pgrest-lambda passes of the upstream PostgREST test suite, measured against a live Aurora DSQL cluster, and which PostgREST features Aurora DSQL makes permanently unavailable.
---

# PostgREST compatibility

pgrest-lambda aims to be wire-compatible with PostgREST. This page reports how close it is, measured rather than claimed.

The measurement extracts every `shouldRespondWith` assertion in PostgREST's own Haskell test suite into 1,539 portable cases, then replays each one against the Lambda handler in-process, against a live Aurora DSQL cluster. **The engine passes 945 of the 1,285 cases that ran and are in scope — nine hundred and forty-five of one thousand two hundred and eighty-five, 73.5%.** The other 254 extracted cases are held outside that denominator and itemised below. None of them counts as a pass.

Every number on this page comes from `conformance/results/run-2026-08-19T22-42-21-458Z.json` (run `2026-08-19T22:42:21Z`, commit `eeb1ac9`) and `conformance/fixtures/load-report.json`. Three full runs of that same tree exist: 943, 948 and 945 of 1,285. The published number is the third, which is neither the highest nor measured by the pass that wrote the code. The runs disagree on about a dozen of 1,539 cases, which is the size of the run-to-run noise on this cluster — treat any difference of that size as noise, not progress.

The generated report at `compatreport/index.html` carries the same data with per-case detail and a section on how to read the number. `conformance/results/history.json` keeps every measured run.

## Read the denominator before quoting the number

Of the 1,539 extracted cases:

| Group | Cases | What it means |
|---|---|---|
| Passed | 945 | Status, body and asserted headers all match upstream. |
| Failed | 340 | Ran and did not match. In the pass rate. |
| Blocked | 188 | The table, view, function or column the case needs cannot be created on Aurora DSQL, so the assertion cannot run either way. |
| Needs engine config | 16 | The assertion only holds when the PostgREST process runs with a setting pgrest-lambda has no switch for. |
| Skipped at extraction | 35 | The Haskell assertion could not be converted without guessing — a header built by a helper, a body read from a file, a path taken from an earlier response. |
| Out of scope | 15 | Asserts namespaced run-time parameters (`response.headers`, `request.*`), which DSQL rejects outright. |

The pass rate is `passed / (passed + failed)` = 945 / 1,285. It is not 945 / 1,539, and it never counts an excluded case as a pass. Closing a harness skip or adding a missing setting moves cases *into* the denominator, where they usually fail first, so the rate can drop while the engine improves.

### The comparable earlier run, and a stricter denominator

The last run measured with the same flags scored 550 of 1,199 (45.9%) on commit `3fbf941`. Matching case ids between that run and this one: 400 cases went from not passing to passing, and 5 went the other way. Those are counted separately and never netted against each other. All five are measurement artifacts rather than engine regressions: four are `row-order-unspecified` cases that turn on DSQL storage order, and `UpsertSpec:417` passes when the runner restores the tables an earlier mutating case in the same spec file touched (`--reset-touched`), which is residual within-spec fixture pollution.

Nine cases left the denominator between those two runs: 7 moved from `fail` to `out-of-scope` (RPC cases that assert namespaced run-time parameters) and 2 from `fail` to `blocked`. Add all nine back as failures and the rate is 945 of 1,294 — 73.0%. The difference between 73.5% and 73.0% is the whole effect of that reclassification, so nothing here rests on it.

The original baseline scored 135 of 1,153, but it was measured without `--reload-per-spec`. Its percentage is not comparable with this one and is not compared here. The flag-independent statement is the id-matched one: against the baseline, 816 cases went from not passing to passing and 6 went the other way.

## What works

By category, passed of the cases that ran:

| Category | Passed / ran | Rate | Blocked | Needs config | Other excluded | Extracted |
|---|---|---|---|---|---|---|
| `plan` | 3 / 3 | 100% | 0 | 0 | 0 | 3 |
| `json-operators` | 47 / 47 | 100% | 16 | 0 | 2 | 65 |
| `embedding` | 268 / 288 | 93% | 11 | 0 | 0 | 299 |
| `rpc` | 132 / 144 | 92% | 43 | 1 | 17 | 205 |
| `singular` | 33 / 36 | 92% | 0 | 0 | 0 | 36 |
| `select` | 56 / 64 | 88% | 2 | 5 | 1 | 72 |
| `range` | 47 / 57 | 82% | 0 | 0 | 0 | 57 |
| `cors` | 7 / 9 | 78% | 0 | 0 | 0 | 9 |
| `upsert` | 40 / 53 | 75% | 10 | 0 | 0 | 63 |
| `filters` | 112 / 173 | 65% | 66 | 0 | 1 | 240 |
| `multiple-schemas` | 18 / 28 | 64% | 8 | 0 | 0 | 36 |
| `update` | 41 / 68 | 60% | 2 | 0 | 0 | 70 |
| `preferences` | 17 / 29 | 59% | 0 | 0 | 0 | 29 |
| `delete` | 10 / 18 | 56% | 0 | 0 | 0 | 18 |
| `insert` | 40 / 71 | 56% | 10 | 0 | 4 | 85 |
| `media-types` | 33 / 62 | 53% | 13 | 0 | 0 | 75 |
| `aggregates` | 26 / 50 | 52% | 0 | 0 | 0 | 50 |
| `rollback` | 1 / 2 | 50% | 0 | 0 | 24 | 26 |
| `openapi` | 1 / 3 | 33% | 0 | 4 | 1 | 8 |
| `auth` | 10 / 51 | 20% | 3 | 2 | 0 | 56 |
| `errors` | 3 / 18 | 17% | 2 | 1 | 0 | 21 |
| `http-headers` | 0 / 1 | 0% | 1 | 0 | 0 | 2 |
| `observability` | 0 / 9 | 0% | 1 | 3 | 0 | 13 |
| `options` | 0 / 1 | 0% | 0 | 0 | 0 | 1 |

Read down that table rather than across it: a category with a high rate is a feature you can rely on, and one with a low rate is not.

Grouping the same cases by the request feature they use gives a sharper picture. Each row is one predicate over the extracted case, listed with the row in `conformance/report/feature-table.mjs`, so the table can be regenerated with `node conformance/report/feature-table.mjs --markdown` and argued with rather than trusted. Counts are cases that ran, so a feature showing `0 / 0` has no measurement at all on DSQL:

| Request feature | Passed / ran | Rate | Excluded |
|---|---|---|---|
| `!inner` embed | 68 / 68 | 100% | 0 |
| `!left` embed | 3 / 3 | 100% | 0 |
| `match` / `imatch` (POSIX regex) | 7 / 7 | 100% | 3 |
| `Prefer: count=exact` | 54 / 54 | 100% | 1 |
| `Range` request header | 21 / 21 | 100% | 0 |
| JSON path (`->`, `->>`) in the query string | 52 / 52 | 100% | 18 |
| Unsatisfiable range → 416 | 6 / 6 | 100% | 0 |
| `order` on an embedded resource | 52 / 53 | 98% | 2 |
| `Accept: application/vnd.pgrst.object+json` | 32 / 33 | 97% | 2 |
| `like` / `ilike` | 28 / 29 | 97% | 3 |
| `Prefer: tx=commit` | 14 / 15 | 93% | 6 |
| `PUT` | 22 / 24 | 92% | 5 |
| `limit` / `offset` | 54 / 60 | 90% | 2 |
| `is` operator | 34 / 38 | 89% | 0 |
| `HEAD` | 37 / 42 | 88% | 8 |
| RPC via `GET /rpc/...` | 91 / 105 | 87% | 42 |
| `and=(...)` / `or=(...)` grouping | 33 / 39 | 85% | 11 |
| Cast in a select list (`col::type`) | 23 / 28 | 82% | 0 |
| RPC via `POST /rpc/...` | 71 / 87 | 82% | 32 |
| `in` operator | 58 / 72 | 81% | 7 |
| `order=` | 112 / 142 | 79% | 18 |
| `Content-Range` asserted on the response | 126 / 162 | 78% | 2 |
| Spread embed (`...table(col)`) | 64 / 86 | 74% | 0 |
| `Prefer: resolution=ignore-duplicates` | 7 / 10 | 70% | 3 |
| `DELETE` | 26 / 39 | 67% | 2 |
| `not.` negation | 29 / 44 | 66% | 6 |
| `PATCH` | 55 / 88 | 63% | 3 |
| `Accept-Profile` / `Content-Profile` | 14 / 23 | 61% | 0 |
| Aggregate in a select list | 21 / 35 | 60% | 0 |
| `text/csv` | 7 / 12 | 58% | 3 |
| `Prefer: return=representation` | 94 / 165 | 57% | 14 |
| `columns=` | 18 / 34 | 53% | 1 |
| `on_conflict` | 2 / 4 | 50% | 0 |
| `Prefer: resolution=merge-duplicates` | 6 / 12 | 50% | 2 |
| `fts` / `plfts` / `phfts` / `wfts` | 8 / 43 | 19% | 28 |
| JWT in `Authorization` | 6 / 57 | 11% | 4 |
| `cs`, `cd`, `ov`, `sl`, `sr`, `adj` | 0 / 0 | — | 16 |
| `Prefer: tx=rollback` | 0 / 0 | — | 0 |

Four rows need reading carefully.

The containment and range operators have no measurement at all: every upstream case for them uses an array or a range column, and DSQL stores neither. They are implemented in the engine and unit-tested, but this suite cannot confirm them.

Full-text search passes 8 of 43 because most of the rest name a text search configuration DSQL does not have. See [Text search beyond `simple`](#text-search-beyond-the-simple-configuration).

`Prefer: tx=rollback` has no measurement either, and its neighbour `tx=commit` explains why: the upstream rollback specs set `tx=commit` and rely on the harness rolling every request back, which is the one thing DSQL cannot do. 24 of the 26 rollback cases are excluded for that reason.

Requests carrying a JWT pass 6 of 57 because most of those cases assert what `SET ROLE` plus `GRANT` would answer. See [`SET ROLE`, `GRANT` and row-level security](#set-role-grant-based-access-control-and-row-level-security). The JWT itself is verified correctly; the authorization decision behind it is a different model.

## What does not work yet

340 cases fail. Most are engine work that nothing in DSQL prevents; the rest need a DSQL substitute or are the order-dependent assertions described below. The largest groups, by failing cases:

| Failing cases | Gap | What is missing |
|---|---|---|
| 54 | `no-set-role` | Upstream's authorization: `SET ROLE` plus `GRANT` plus RLS. DSQL has none of it. Permanent — see below. |
| 27 | `body-mismatch-filters` | Right status, wrong body. Most are full-text filters returning no rows on DSQL's `simple` configuration. |
| 23 | `unimplemented-feature-media-types` | Custom media types produced by a function (`application/geo+json`, `text/tab-separated-values`); the engine answers `PGRST107`. |
| 22 | `missing-operator-fts` | Text search configurations DSQL does not ship, and `tsvector` columns it will not store. Permanent — see below. |
| 17 | `unimplemented-feature-insert` | Insert bodies the engine turns into a database error (`22P02`) instead of a PostgREST one. |
| 17 | `body-mismatch-aggregates` | Right status, wrong body from an aggregate select. |
| 13 | `unimplemented-feature-update` | Same as the insert group, on `PATCH`. |
| 11 | `body-mismatch-embedding` | Right status, wrong embedded row shape. |
| 10 | `body-mismatch-upsert` | Right status, wrong body from an upsert. |
| 9 | `header-mismatch-server-timing` | No `Server-Timing` header. |
| 9 | `body-mismatch-update` | Right status, wrong body from an update. |
| 8 | `body-mismatch-insert` | Right status, wrong body from an insert. |
| 7 | `body-mismatch-delete` | Right status, wrong body from a delete. |
| 11 | `row-order-unspecified` | The same rows in a different order. Kept as failures — see below. |
| 6 | `no-foreign-keys` | Relationships the manifest cannot express: a view's column provenance, and disambiguating two relationships that join the same pair of relations. |
| 6 | `unimplemented-feature-aggregates` | Aggregates inside a spread embed; the engine computes them per parent row instead of grouped. |
| 6 | `engine-public-schema-only` | RPC dispatch resolves the function against `public`, so a function that exists only in an exposed schema such as `v1` or `v2` is reported missing. |
| 6 | `missing-validation-preferences` | An invalid `Prefer` value should be a 400 and returns 200. |
| 6 | `body-mismatch-preferences` | Right status, wrong body under a `Prefer` header. |
| 6 | `header-mismatch-content-range` | `Content-Range: 0-0/*` expected, `*/*` sent. |
| 6 | `header-mismatch-content-length` | Byte count off by a couple of bytes — JSON separators. |
| 6 | `missing-status-206-partial-content` | 206 expected for a partial range, 200 sent. |
| 5 | `header-mismatch-proxy-status` | No `Proxy-Status` header on errors. |
| 5 | `body-mismatch-media-types` | Right status, wrong body for a media type. |
| 5 | `unimplemented-feature-filters` | Filter values the engine passes to the database as-is and the database rejects. |

Three categories pass nothing at all: `observability` (9 cases, all `Server-Timing`), `http-headers` (1) and `options` (1).

### The seven order-dependent failures stay failures

Eleven cases fail only because the rows came back in a different order: `QueryLimitedSpec:97`, `QueryLimitedSpec:108`, `QuerySpec:75`, `QuerySpec:80`, `QuerySpec:338`, `QuerySpec:345`, `QuerySpec:382`, `QuerySpec:389`, `QuerySpec:1305`, `QuerySpec:1313` and `QuerySpec:1427`. Which cases land in this group moves between runs — the count across the eight recorded runs is 5, 12, 19, 16, 14, 14, 7 and 11 — because it is decided by DSQL's storage order rather than by engine behaviour. Upstream's assertion lists rows in the order a PostgreSQL heap scan returns them after a fresh insert. Aurora DSQL does not preserve insertion order and pgrest-lambda does not add an implicit `ORDER BY`, so a query with no `order=` can legitimately return the same rows in any sequence.

They are counted as failures. Reclassifying them would lift the published rate by about half a point on a technicality.

The count moves between runs because it depends on which order the storage layer happens to return: the seven runs in `conformance/results/history.json` recorded 5, 12, 19, 16, 14, 14 and 7 order-only failures. When it is 7, some of the cases that would otherwise land here fail for a different reason instead, or happen to come back in the expected order. Do not read a change in this number as engine work.

## Permanently unavailable on Aurora DSQL

Aurora DSQL is not a drop-in PostgreSQL. The fixtures are upstream's, mechanically transformed until they load: 1,116 of 1,116 statements apply, producing 215 tables, 80 views, 153 functions and 23 domains — and 410 constructs are dropped, each with a recorded reason in `conformance/fixtures/load-report.json`. Of those 410, 314 are constructs DSQL will never accept. The measured capability probe is in `conformance/DSQL-CAPABILITIES.md`.

279 cases sit on the wrong side of that line: 188 blocked, 15 out of scope, and 76 failures that need a substitute rather than a fix.

The features below cannot work on DSQL as PostgREST implements them. This is a property of the database, not a backlog.

### Foreign keys, and therefore FK-derived embedding

DSQL rejects `FOREIGN KEY` and `ALTER TABLE ... ADD CONSTRAINT`, and `pg_constraint` returns zero rows for `contype='f'`. PostgREST derives resource embedding entirely from that catalog, so on DSQL there is nothing to derive from: 115 foreign keys are dropped at fixture load.

The substitute is a declared-relationship manifest. Point `PGREST_RELATIONSHIPS_PATH` at a JSON file listing the keys the catalog cannot report and embedding works — the `embedding` category runs at 268 of 288 with it. Measured on commit `3fbf941` with everything else held constant, the `no-foreign-keys` gap was 189 failures without the manifest and 28 with it. Both runs are in `conformance/results/history.json`.

What the manifest cannot express is a relationship that was never a foreign key: a view's column provenance, which upstream reads from `pg_rewrite`, and the disambiguation between two relationships joining the same pair of relations. Those 6 remaining failures need engine support, not data.

### `SET ROLE`, `GRANT`-based access control and row-level security

DSQL rejects `SET ROLE` and `SET LOCAL ROLE`, rejects `ALTER TABLE ... ENABLE ROW SECURITY`, and does not implement `CREATE POLICY`. PostgREST's authorization *is* PostgreSQL authorization: it switches role per request and lets `GRANT` and RLS decide. That model is unreachable here, so pgrest-lambda enforces authorization in the engine instead (see [Authorization](./authorization)).

54 cases fail because of it — 41 in `auth`, 9 in `errors`, 2 in `insert`, 1 each in `delete` and `rpc`. They assert the 401 or 403 that a role switch plus a `GRANT` would produce, and the engine's own decision does not reproduce upstream's wire response case for case. Roles can be created on DSQL; they just cannot be assumed.

### plpgsql, and therefore triggers

`CREATE FUNCTION ... LANGUAGE plpgsql` is rejected. 36 fixture functions and the 16 triggers that depend on them are dropped, which blocks 32 cases outright. Functions in `LANGUAGE sql` work, including `RETURNS SETOF` and `RETURNS TABLE`, so most RPC is testable — the `rpc` category runs at 132 of 144. Any test whose function body needs procedural code is not testable.

### Namespaced run-time parameters

`set_config('response.headers', ...)`, `SET LOCAL "response.headers"` and the `request.*` claim GUCs are all rejected. PostgREST uses them to let a function set response headers and to expose JWT claims to SQL. Because DSQL parses SQL function bodies at `CREATE` time, the `SET` form also fails the `CREATE FUNCTION`, so 6 fixture functions never exist. 15 cases are reported out of scope for this reason, all in `rpc`.

### Text search beyond the `simple` configuration

`pg_ts_config` contains one row. `to_tsvector('english', ...)` fails with `text search configuration "english" does not exist`, and `tsvector` is not a usable column type. The `fts`, `plfts`, `phfts` and `wfts` operators are implemented and 12 upstream cases pass with them, but 19 of the 22 failures name a configuration such as `english`, `french` or `german` and cannot pass as written; the other 3 use a `tsvector` column or function DSQL dropped. A further 6 cases are blocked because their fixture could not be created at all. There is also no GIN index (`USING` is rejected for `CREATE INDEX`), so full-text and array queries have no index support.

Set `PGREST_DEFAULT_TS_CONFIG=simple` on DSQL. Without it the engine emits PostgreSQL's default (`english`) and every full-text query errors.

### Column types DSQL will not store

Arrays and range types work in expressions and as function arguments, but DSQL rejects them as column types — and a range is also rejected as a function return type. Measured at fixture load, this blocks 33 cases on array columns such as `integer[]` and 31 more on other column types DSQL refuses (`money`, `bit(n)`, `xml`, `tsvector`, and the geometric and network types). 35 column definitions and 4 domain base types are dropped for this reason, plus 19 functions that return or take one of those types, plus 5 tables where no column survived.

Enum and composite types cannot be created at all (`CREATE TYPE` is rejected — 8 in the fixtures, 6 blocked cases), and neither can extensions (7 dropped, so no `postgis`, `citext`, `ltree` or `hstore` columns, and 2 blocked cases).

### Other DDL the fixtures need and DSQL refuses

Partitioned tables (12 dropped, 14 blocked cases), materialized views (2 dropped, 1 blocked case), `CREATE TABLE AS` (2), user-defined aggregates (14), user-defined casts (15), rules (1), procedures (1), `TRUNCATE`, temporary tables, and `SAVEPOINT`. DSQL also caps a database at 10 schemas, which drops 1 fixture schema.

The absence of `SAVEPOINT` is the one that shapes the measurement itself. Upstream sets `configDbTxRollbackAll = True` (`test/spec/SpecHelper.hs`), so every upstream request rolls back and no example ever sees another example's writes. pgrest-lambda cannot do that on DSQL, so the harness reloads fixtures once per spec file instead. Cases that mutate data can still affect later cases in the same file. The report's "How to read this number" section quantifies what that costs: measured on commit `3fbf941` with everything else held constant, 443 of 1,199 without per-spec reload and 550 of 1,199 with it.

## Settings that change the score

| Setting | Effect |
|---|---|
| `PGREST_RELATIONSHIPS_PATH` | Declared relationships for a database with no foreign keys. Required on DSQL; without it, embedding degrades silently. |
| `PGREST_DEFAULT_TS_CONFIG` | Text search configuration. Must be `simple` on DSQL. |
| `PGREST_DB_BULK_MUTATION_GUARD` | The harness runs with `off`. The engine's default is `on`, which refuses a filterless `PATCH`/`DELETE`; upstream has no such guard unless the `pg_safeupdate` extension is loaded, so measuring upstream's behaviour means matching upstream's state. `PgSafeUpdateSpec` is measured separately with `safeupdate`. |

The harness also boots the engine with upstream's own non-default configuration for 12 spec ranges that require one — `db-schemas`, `db-extra-search-path`, `db-max-rows`, `db-aggregates-enabled`, `db-plan-enabled`, `db-pre-request`, `server-cors-allowed-origins`. Those cases are measured, not excluded.

16 cases still need a setting the engine does not have: `db-root-spec` (2), OpenAPI mode (2), prepared-statement control (3), a server trace header (3), the JWT cache with server timing (2), legacy target names (2), client error verbosity (1) and `db-pre-config` (1). Adding a switch moves its cases into the denominator, where they will fail until the behaviour behind the switch exists.

## Standard PostgreSQL

This page measures Aurora DSQL only. There is no conformance number for standard PostgreSQL yet, and most of the section above does not apply to it: foreign keys, plpgsql, triggers, enums, extensions, `SET ROLE`, RLS, array and range columns and every text search configuration work normally there. The engine probes the database at startup and adapts (`supportsForeignKeys`, `supportsFullTextSearch`, `supportsRangeTypes`, `supportsRowLevelSecurity`, `supportsGinIndex`, …), so on PostgreSQL it reads relationships from `pg_constraint` and needs no manifest. Do not read 73.5% as pgrest-lambda's compatibility on PostgreSQL; read it as the compatibility measured on DSQL, which is the harder target.

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
