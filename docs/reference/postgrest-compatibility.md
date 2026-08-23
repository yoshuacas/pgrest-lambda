---
title: PostgREST compatibility
description: What pgrest-lambda passes of the upstream PostgREST test suite, measured against a live Aurora DSQL cluster, and which PostgREST features Aurora DSQL makes permanently unavailable.
---

# PostgREST compatibility

pgrest-lambda aims to be wire-compatible with PostgREST. This page reports how close it is, measured rather than claimed.

The measurement extracts every `shouldRespondWith` assertion in PostgREST's own Haskell test suite into 1,539 portable cases, then replays each one against the Lambda handler in-process, against a live Aurora DSQL cluster. **The engine passes 1,176 of the 1,294 cases that ran and are in scope — one thousand one hundred and seventy-six of one thousand two hundred and ninety-four, 90.9%.** The other 245 extracted cases are held outside that denominator and itemised below. None of them counts as a pass.

Read that number next to the one this page used to carry, 1,074 of 1,358 (79.1%), and read the denominator as well as the rate: 64 of those 1,358 cases went back to `blocked` this wave because they address a column Aurora DSQL will not store, so they cannot run either way. On the older, wider denominator the engine now passes **1,176 of 1,358 — 86.6%**, and that is the like-for-like figure. Both are below.

Every number on this page comes from `conformance/results/run-2026-08-23T07-16-38-954Z.json` (run `2026-08-23T07:16:38Z`, tree `8bed54e`) and `conformance/fixtures/load-report.json`, except where another run file is named on the line that uses it. `conformance/results/latest.json` is a copy of that file, so the reproduction instructions and the rest of the repository read the published run rather than the last one that happened to finish. The results file records commit `c718ab4` in its own metadata because the run measured the working tree before the commit that carries the change in it existed; `tree` in `conformance/results/history.json` records which tree it was.

### Which run this is, and why

Two full runs of this tree exist, same flags, same cluster, and they scored the same:

| Run | Passed / ran | Cluster |
|---|---|---|
| `2026-08-23T06:57:07Z` | 1,176 / 1,294 | `lzt7fuha…` |
| **`2026-08-23T07:16:38Z`** | **1,176 / 1,294** | `lzt7fuha…` — **published** |

They agree case by case: no case passed in one and failed in the other. There is nothing to choose between them, so the published one is the second, which ran against the tree exactly as it is committed. A 0-case spread is the narrowest this suite has shown — the four runs of tree `2488109` spanned 1,068 to 1,080 — and it should not be read as the noise band having closed. `json_table` still has no column PostgreSQL can order by, so `JsonOperatorSpec:248` can move again.

Both runs were measured by the same pass that wrote the code in them, so the rule in `compatreport/README.md` about publishing a run measured by a pass with no code in the result is not satisfied here. The number to trust is the id-matched comparison below, which does not depend on who ran it.

The generated report at `compatreport/index.html` carries the same data with per-case detail and a section on how to read the number. `conformance/results/history.json` keeps every measured run.

## Read the denominator before quoting the number

Of the 1,539 extracted cases:

| Group | Cases | What it means |
|---|---|---|
| Passed | 1,176 | Status, body and asserted headers all match upstream. |
| Failed | 118 | Ran and did not match. In the pass rate. |
| Blocked | 191 | The table, view, function or column the case needs cannot be created on Aurora DSQL, so the assertion cannot run either way. |
| Needs engine config | 2 | The assertion only holds when the PostgREST process runs with a setting pgrest-lambda has no switch for. |
| Skipped at extraction | 35 | The Haskell assertion could not be converted without guessing — a header built by a helper, a body read from a file, a path taken from an earlier response. |
| Out of scope | 17 | Asserts namespaced run-time parameters (`response.headers`, `request.*`), which DSQL rejects outright. |

The pass rate is `passed / (passed + failed)` = 1,176 / 1,294. It is not 1,176 / 1,539, and it never counts an excluded case as a pass. Closing a harness skip or adding a missing setting moves cases *into* the denominator, where they usually fail first, so the rate can drop while the engine improves.

The 191 blocked cases break down by what DSQL refused to create: 63 `fixture-missing` (a named object the load report records as dropped), 34 array columns, 33 other column types, 32 plpgsql functions, 14 partitioned tables, 6 text search configurations or `tsvector` columns, 6 enum or composite types, 2 extensions and 1 materialized view.

### What changed since the last publication

**Against the previous report publication** — 1,173 of the same 1,294 on the same tree, `conformance/results/run-2026-08-23T06-25-20-085Z.json` — id-matched: **3 cases went from failing to passing and none went the other way.** The three are `QueryLimitedSpec:97`, `QueryLimitedSpec:108` and `UpdateSpec:444`, and they are one fix: a mutation with `Prefer: return=representation` and an `?order=` returned its rows unordered, because the representation came from the statement's own `RETURNING` list, which has no `ORDER BY` to put the order in. The engine now plans an ordered or embedding mutation's representation as a read over the source CTE, which is what upstream does (`Plan.hs` `mutateReadPlan`, and the `addRels` root case that re-points it at `pgrst_source`). All three were filed under `row-order-unspecified`, so that gap was reporting an engine defect as a property of DSQL.

**Against the last run published to this page** — 1,074 of 1,358 on tree `2488109`, `conformance/results/run-2026-08-21T13-03-49-026Z.json` — id-matched: **110 cases went from not passing to passing and 8 went the other way.** All 8 losses are `row-order-unspecified`: `QuerySpec:318`, `:324`, `:338`, `:345`, `:382`, `:389`, `RpcSpec:985` and `:997`, all reads of `tsearch_to_tsvector`, a table with no primary key. They came back in upstream's order by luck in that run and are now sorted deterministically, the wrong way. That is the trade the order tiebreak makes, and it is described below.

**The denominator moved, and only in one direction.** 64 cases left it, all from `fail` to an excluded status: 33 to `blocked` on an array column, 22 to `blocked` on another column type DSQL will not store, 6 to `blocked` on text search, 2 to `out-of-scope` on namespaced GUCs and 1 to `blocked` on an extension. Nothing entered the denominator. Those 64 are cases whose request names a column that does not exist on this database — the engine answers PostgreSQL's own `42703`, which is upstream's answer too, and no engine change can make them pass. Add all 64 back as failures and the rate reads **1,176 of 1,358, 86.6%**, against 1,074 of 1,358 in the run this page used to report. Quote 90.9% with its denominator or quote 86.6% against the old one; do not quote 90.9% against 79.1%.

### Where the 110 gains came from

The report's audit section attributes the largest blocks, each with what was run to check it:

- **41 are isolation.** Upstream's `SpecHelper.hs` sets `configDbTxRollbackAll` and `configDbTxAllowOverride`, so every mutating request its suite makes is undone unless that request asks for `Prefer: tx=commit`. The engine now implements the same option (`db-tx-end = rollback-allow-override`) and the runner sets it, so a mutating case stops changing the fixtures the cases after it read. Nine in `UpdateSpec`, 6 each in `InsertSpec` and `UpsertSpec`, 5 in `NullsStripSpec`, 4 each in `MaxAffectedSpec` and `MultipleSchemaSpec`, 3 in `AndOrParamsSpec`, 2 each in `DeleteSpec` and `SingularSpec`. None is a new query feature. The engine's own default is `db-tx-end=commit`.
- **18 are the JWT path being measured for the first time.** The harness used to build the API Gateway authorizer context by decoding the token's payload without verifying it, so a spec asserting a *rejected* token could not fail. The runner's base engine now runs with `rest-jwt` and upstream's own secret. Closing the 18 needed engine work too: the decode-error vocabulary the specs assert by string (`Error.hs message (JwtDecodeErr e)`) and registered-claim validation in upstream's order (`Auth/Jwt.hs checkForErrors`).
- **27 came from the privilege substitute** when it was measured on its own: upstream's `test/spec/fixtures/privileges.sql` ported to a Cedar policy set, with an untokened request resolving to `anon` the way upstream's `db-anon-role` does. Measured on the same flags, that run took the suite from 1,074 / 1,358 to 1,101 / 1,356.
- **9 are an extractor fix, not an engine fix.** The fixtures load upstream's `test` schema into `public` and the extractor rewrites `test.` to `public.` inside an expected error body, but it left the `Content-Length` assertion at upstream's byte count, so a byte-exact engine failed on the length of a schema name. The count is adjusted by the two bytes each rewrite adds, and each affected case records the adjustment. `QuerySpec:629` also asserts a `Content-Length`, is 10 bytes short on a body the rename never touched, and stays a failure.
- **4 are a fixture the transform used to drop whole.** `public.contract` is filled by upstream's only `INSERT ... SELECT`, one of whose columns is a `tsrange`; the transform could cut a dropped column out of a `VALUES` tuple but not out of a select list, so the table stayed empty and four embed assertions had no rows to read.
- **3 are the mutation-ordering fix** described above.

Those were measured at different points in the wave, against different denominators, so they do not add to 110 exactly. `conformance/cases/` was not edited to make anything pass: both case-file changes in this wave came from fixing the extractor and are checkable against the upstream source.

## What works

By category, passed of the cases that ran:

| Category | Passed / ran | Rate | Blocked | Needs config | Other excluded | Extracted |
|---|---|---|---|---|---|---|
| `range` | 57 / 57 | 100% | 0 | 0 | 0 | 57 |
| `singular` | 36 / 36 | 100% | 0 | 0 | 0 | 36 |
| `preferences` | 29 / 29 | 100% | 0 | 0 | 0 | 29 |
| `observability` | 12 / 12 | 100% | 1 | 0 | 0 | 13 |
| `cors` | 9 / 9 | 100% | 0 | 0 | 0 | 9 |
| `openapi` | 5 / 5 | 100% | 0 | 2 | 1 | 8 |
| `plan` | 3 / 3 | 100% | 0 | 0 | 0 | 3 |
| `http-headers` | 1 / 1 | 100% | 1 | 0 | 0 | 2 |
| `options` | 1 / 1 | 100% | 0 | 0 | 0 | 1 |
| `upsert` | 52 / 53 | 98% | 10 | 0 | 0 | 63 |
| `json-operators` | 46 / 47 | 98% | 16 | 0 | 2 | 65 |
| `embedding` | 280 / 288 | 97% | 11 | 0 | 0 | 299 |
| `select` | 65 / 67 | 97% | 4 | 0 | 1 | 72 |
| `aggregates` | 48 / 50 | 96% | 0 | 0 | 0 | 50 |
| `rpc` | 137 / 144 | 95% | 43 | 0 | 18 | 205 |
| `delete` | 17 / 18 | 94% | 0 | 0 | 0 | 18 |
| `multiple-schemas` | 26 / 28 | 93% | 8 | 0 | 0 | 36 |
| `auth` | 48 / 52 | 92% | 3 | 0 | 1 | 56 |
| `errors` | 17 / 19 | 89% | 2 | 0 | 0 | 21 |
| `update` | 60 / 68 | 88% | 2 | 0 | 0 | 70 |
| `insert` | 57 / 70 | 81% | 11 | 0 | 4 | 85 |
| `filters` | 131 / 173 | 76% | 66 | 0 | 1 | 240 |
| `media-types` | 38 / 62 | 61% | 13 | 0 | 0 | 75 |
| `rollback` | 1 / 2 | 50% | 0 | 0 | 24 | 26 |

Read down that table rather than across it: a category with a high rate is a feature you can rely on, and one with a low rate is not. Two rows are mostly excluded rather than mostly failing — `filters` holds 66 blocked cases that address an array, range or `tsvector` column, and `rollback` holds 24 cases the extractor skipped because their request headers come from a Haskell helper it will not guess.

Grouping the same cases by the request feature they use gives a sharper picture. Each row is one predicate over the extracted case, listed with the row in `conformance/report/feature-table.mjs`, so the table can be regenerated with `node conformance/report/feature-table.mjs --markdown` and argued with rather than trusted. Counts are cases that ran, so a feature showing `0 / 0` has no measurement at all on DSQL:

| Request feature | Passed / ran | Rate | Excluded |
|---|---|---|---|
| `!inner` embed | 68 / 68 | 100% | 0 |
| `!left` embed | 3 / 3 | 100% | 0 |
| `Accept: application/vnd.pgrst.object+json` | 33 / 33 | 100% | 2 |
| `HEAD` | 46 / 46 | 100% | 4 |
| `like` / `ilike` | 30 / 30 | 100% | 2 |
| `match` / `imatch` (POSIX regex) | 7 / 7 | 100% | 3 |
| `on_conflict` | 4 / 4 | 100% | 0 |
| `OPTIONS` | 10 / 10 | 100% | 0 |
| `Prefer: count=exact` | 54 / 54 | 100% | 1 |
| `Prefer: handling=strict` / `handling=lenient` | 24 / 24 | 100% | 0 |
| `Prefer: max-affected` | 13 / 13 | 100% | 0 |
| `Prefer: resolution=ignore-duplicates` | 10 / 10 | 100% | 3 |
| `Prefer: resolution=merge-duplicates` | 12 / 12 | 100% | 2 |
| `Prefer: tx=commit` | 15 / 15 | 100% | 6 |
| `Range` request header | 21 / 21 | 100% | 0 |
| `text/csv` | 12 / 12 | 100% | 3 |
| `Vary` asserted on the response | 1 / 1 | 100% | 1 |
| Embed nested three or more levels deep | 17 / 17 | 100% | 0 |
| Spread embed (`...table(col)`) | 86 / 86 | 100% | 0 |
| Unsatisfiable range → 416 | 6 / 6 | 100% | 0 |
| Filter on an embedded resource | 111 / 112 | 99% | 2 |
| `order` on an embedded resource | 53 / 54 | 98% | 1 |
| `order=` | 140 / 143 | 98% | 17 |
| Embed nested two or more levels deep | 124 / 127 | 98% | 6 |
| JSON path (`->`, `->>`) in the query string | 51 / 52 | 98% | 18 |
| `limit` / `offset` | 58 / 60 | 97% | 2 |
| Aggregate in a select list | 34 / 35 | 97% | 0 |
| Disambiguating embed hint (`!fk`) | 35 / 36 | 97% | 1 |
| `PUT` | 23 / 24 | 96% | 5 |
| Cast in a select list (`col::type`) | 26 / 27 | 96% | 1 |
| `DELETE` | 37 / 39 | 95% | 2 |
| RPC via `POST /rpc/...` | 83 / 87 | 95% | 32 |
| `Content-Range` asserted on the response | 153 / 162 | 94% | 2 |
| RPC via `GET /rpc/...` | 99 / 106 | 93% | 41 |
| `and=(...)` / `or=(...)` grouping | 36 / 39 | 92% | 11 |
| `is` operator | 35 / 38 | 92% | 0 |
| `Accept-Profile` / `Content-Profile` | 21 / 23 | 91% | 0 |
| `Preference-Applied` asserted on the response | 80 / 89 | 90% | 10 |
| `PATCH` | 78 / 88 | 89% | 3 |
| JWT in `Authorization` | 51 / 57 | 89% | 4 |
| `in` operator | 62 / 72 | 86% | 7 |
| `Prefer: return=representation` | 141 / 165 | 85% | 14 |
| `columns=` | 25 / 34 | 74% | 1 |
| `Prefer: missing=default` | 11 / 15 | 73% | 1 |
| `not.` negation | 31 / 44 | 70% | 6 |
| `fts` / `plfts` / `phfts` / `wfts` | 6 / 43 | 14% | 28 |
| `cs`, `cd`, `ov`, `sl`, `sr`, `adj` | 0 / 0 | — | 16 |
| `Prefer: tx=rollback` | 0 / 0 | — | 0 |
| `Server-Timing` asserted on the response | 0 / 0 | — | 0 |

Five rows need reading carefully.

The containment and range operators now read `0 / 0` rather than `0 / 14`: every upstream case for them uses an array or a range column, DSQL stores neither, and all 16 are counted as blocked. They are implemented in the engine and unit-tested; this suite cannot confirm them on DSQL, and it no longer claims to have measured them either way.

Full-text search passes 6 of 43. Of the 37 failures, 17 name a text search configuration DSQL does not have, 12 return `[]` because the one configuration it does have (`simple`) has no stop words or stemming, and 8 are order-dependent reads of a keyless table. That row read 14 of 47 in the previous publication; the difference is DSQL's storage order and the reclassification of 4 blocked cases, not text search behaviour. See [Text search beyond `simple`](#text-search-beyond-the-simple-configuration).

`Prefer: tx=rollback` has no measurement because all of its cases are among the 24 `RollbackSpec` assertions the extractor skipped: their request headers come from a Haskell helper (`reqHeaders`), which the extractor will not guess. That is a harness limit, not a DSQL one — the engine implements `Prefer: tx=rollback`, and `Prefer: tx=commit` passes 15 of 15.

`Server-Timing` also reads `0 / 0`, for a different reason: the engine sends the header, and no extracted case asserts it. Both rows stay in the table because "not measured" and "measured and failing" are different findings.

Requests carrying a JWT pass 51 of 57, where the previous publication had 6 of 59. Two things changed at once: the engine verifies the token instead of trusting a payload the harness decoded, and the privilege model behind the token has a substitute. Read the row as "the JWT path is now measured", not as a path that got faster to fix.

## What does not work yet

118 cases fail. The report classifies them: **86 are engine work that nothing in DSQL prevents, 20 need a substitute for something DSQL does not have, and 12 are the order-dependent assertions described below.** By failing cases:

| Failing cases | Gap | What is missing |
|---|---|---|
| 22 | `unimplemented-feature-media-types` | Custom media types upstream registers with `CREATE AGGREGATE` over a domain named after the media type. DSQL rejects `CREATE AGGREGATE`, and the engine has no aggregate-backed media handler either, so it answers `PGRST107`. 11 are `PostGISSpec`, which also needs an extension. |
| 20 | `missing-operator-fts` | Text search configurations DSQL does not ship, and `tsvector` columns it will not store. Permanent — see below. |
| 14 | `body-mismatch-filters` | Right status, wrong body. 12 are full-text filters returning no rows on DSQL's `simple` configuration; 2 are `not.in` with `limit=3` on a keyless table, where the order tiebreak changes which three rows come back. |
| 12 | `row-order-unspecified` | The same rows in a different order. Kept as failures — see below. |
| 6 | `no-foreign-keys` | Relationships the manifest cannot express: a view's column provenance, and disambiguating two relationships that join the same pair of relations. |
| 6 | `body-mismatch-insert` | Right status, wrong body from an insert. |
| 6 | `body-mismatch-update` | Right status, wrong body from an update. |
| 4 | `no-set-role` | What is left of upstream's `SET ROLE` + `GRANT` + RLS model after the Cedar substitute — see below. |
| 3 | `body-mismatch-auth` | Right status, wrong body on an auth assertion. |
| 3 | `unimplemented-feature-insert` | Insert bodies the engine turns into a database error (`22P02`) instead of a PostgREST one. |
| 2 | `engine-error` | A 500. Both are `INSERT` into a view DSQL will not let anything insert into (`55000 cannot insert into view`). |
| 2 | `missing-status-206-partial-content` | A partial-content status the engine does not send on a related-resource read. |
| 2 | `unimplemented-feature-multiple-schemas` | Cross-schema behaviour the engine does not implement yet. |
| 2 | `unimplemented-feature-update` | Same as the insert group, on `PATCH`. |
| 14 | 14 gaps with one case each | `body-mismatch-aggregates`, `body-mismatch-media-types`, `body-mismatch-rollback`, `body-mismatch-select`, `body-mismatch-upsert`, `header-mismatch-content-length`, `header-mismatch-location`, `missing-validation-auth`, `missing-validation-errors`, `missing-validation-filters`, `status-mismatch-media-types`, `status-mismatch-rpc`, `unimplemented-feature-aggregates`, `unimplemented-feature-rpc`. |

The `auth` category, which passed 10 of 53 in the previous publication, now passes 48 of 52. Its 4 failures are `AuthSpec:16`, `:209`, `:218` (right status, wrong body) and `:227` (a validation the engine does not perform).

### The order-dependent failures stay failures

12 cases fail only because the rows came back in a different order: `JsonOperatorSpec:248`, `QuerySpec:318`, `:324`, `:338`, `:345`, `:382`, `:389`, `:571`, `:1305`, `:1313`, `RpcSpec:985` and `:997`. Upstream's assertion lists rows in the order a PostgreSQL heap scan returns them after a fresh insert. Aurora DSQL does not preserve insertion order, so a query with no `order=` can legitimately return the same rows in any sequence.

The engine appends the relation's primary key to every `ORDER BY` (`PGREST_DETERMINISTIC_ORDER`, on by default), and for a relation with no primary key it appends every column PostgreSQL can order by. That did not shrink this gap — it stopped the rest of the suite moving. The widest spread between runs of one tree was 12 cases before it and has been 1 case and then 0 since. Read the tiebreak as buying repeatability, not passes: 8 of these 12 passed in the last run before it and fail in every run with it, because they came back in upstream's order by luck then and are sorted the wrong way consistently now — a stable wrong answer over an unstable right one.

Every one of the 12 is a relation with no primary key whose rows were inserted in an order no column sorts into: `tsearch_to_tsvector` (`text_search text`, `jsonb_search jsonb`) 8, six read directly and two through `/rpc/get_tsearch_to_tsvector`; `w_or_wo_comma_names` (`name text`) 2; `no_pk` (`a`, `b`) 1; and `json_table` 1. `json_table` is the one the tiebreak cannot reach at all: its only column is `data json`, a type PostgreSQL will not order by, so nothing is appended and the rows carrying no `foo` key stay tied. That is why `JsonOperatorSpec:248` passed in one earlier run of a tree whose other runs failed it, and why this count can still move by one. The one mechanism that would reproduce physical order — `ctid` — DSQL refuses: `SELECT ctid FROM w_or_wo_comma_names` answers `cannot retrieve a system column in this context`, probed on the conformance cluster.

Three cases left this gap this wave, and they were never DSQL's order: `QueryLimitedSpec:97`, `:108` and `UpdateSpec:444` asked a mutation to order the representation it returns, and the engine dropped the order. The gap was hiding an engine defect as a database trait. All 12 that remain are counted as failures.

## Permanently unavailable on Aurora DSQL

Aurora DSQL is not a drop-in PostgreSQL. The fixtures are upstream's, mechanically transformed until they load: 1,135 of 1,135 statements apply, producing 215 tables, 80 views, 153 functions and 23 domains — and 409 constructs are dropped, each with a recorded reason in `conformance/fixtures/load-report.json`. Of those 409, 314 are constructs DSQL will never accept. The measured capability probe is in `conformance/DSQL-CAPABILITIES.md`.

228 cases sit on the wrong side of that line: 191 blocked, 17 out of scope, and 20 failures that need a substitute rather than a fix. The features below cannot work on DSQL as PostgREST implements them. This is a property of the database, not a backlog.

### Foreign keys, and therefore FK-derived embedding

DSQL rejects `FOREIGN KEY` and `ALTER TABLE ... ADD CONSTRAINT`, and `pg_constraint` returns zero rows for `contype='f'`. PostgREST derives resource embedding entirely from that catalog, so on DSQL there is nothing to derive from: 115 foreign keys are dropped at fixture load.

The substitute is a declared-relationship manifest. Point `PGREST_RELATIONSHIPS_PATH` at a JSON file listing the keys the catalog cannot report and embedding works — the `embedding` category runs at 280 of 288 with it. Measured on commit `3fbf941` with everything else held constant, the `no-foreign-keys` gap was 189 failures without the manifest and 28 with it. Both runs are in `conformance/results/history.json`.

What the manifest cannot express is a relationship that was never a foreign key: a view's column provenance, which upstream reads from `pg_rewrite`, and the disambiguation between two relationships joining the same pair of relations. Those 6 remaining failures need engine support, not data.

### `SET ROLE`, `GRANT`-based access control and row-level security

DSQL rejects `SET ROLE` and `SET LOCAL ROLE`, rejects `ALTER TABLE ... ENABLE ROW SECURITY`, and does not implement `CREATE POLICY`. PostgREST's authorization *is* PostgreSQL authorization: it switches role per request and lets `GRANT` and RLS decide. That model is unreachable here, so pgrest-lambda enforces authorization in the engine instead (see [Authorization](./authorization)).

**This gap used to be 49 failures and is now 4.** The substitute has the same shape as the relationship manifest: upstream's `test/spec/fixtures/privileges.sql` is ported to a Cedar policy set in `conformance/fixtures/policies/`, and the harness resolves a request with no token — and a token whose payload carries no role claim — to `anon`, which is what upstream's `db-anon-role=postgrest_test_anonymous` does (`Auth.hs parseRoleClaim`). Every run before this wave resolved an untokened request to `service_role`, so every `REVOKE` in the fixture was invisible and no case asserting a denial could pass. Two engine defects had to be fixed alongside it: `buildAuthzFilter` read only Cedar's `nontrivialResiduals` and dropped a permit that Cedar had already satisfied from principal and context alone, and a numeric `sub` or `id` claim was handed to Cedar unquoted, which made the request unparseable and read as a denial. Making the runner verify the token took the gap from 11 to 4.

The 4 that are left are not a privilege model. Three need column-level `GRANT`s — `InsertSpec:716` and `:724` (`POST /limited_article_stars`) and `DeleteSpec:124` (`DELETE /app_users` with `return=representation`) — which a policy set keyed on table and action cannot express. The fourth, `ErrorSpec:123`, asserts the response for a role that does not exist: upstream reports PostgreSQL's `22023` from the failed `SET ROLE`, and this engine has no role to set.

### plpgsql, and therefore triggers

`CREATE FUNCTION ... LANGUAGE plpgsql` is rejected. 36 fixture functions and the 16 triggers that depend on them are dropped, which blocks 32 cases outright. Functions in `LANGUAGE sql` work, including `RETURNS SETOF` and `RETURNS TABLE`, so most RPC is testable — the `rpc` category runs at 137 of 144. Any test whose function body needs procedural code is not testable.

### Namespaced run-time parameters

`set_config('response.headers', ...)`, `SET LOCAL "response.headers"` and the `request.*` claim GUCs are all rejected. PostgREST uses them to let a function set response headers and to expose JWT claims to SQL. Because DSQL parses SQL function bodies at `CREATE` time, the `SET` form also fails the `CREATE FUNCTION`, so 6 fixture functions never exist. 17 cases are reported out of scope for this reason — 16 in `rpc` and `AuthSpec:68`.

### Text search beyond the `simple` configuration

`pg_ts_config` contains one row. `to_tsvector('english', ...)` fails with `text search configuration "english" does not exist`, and `tsvector` is not a usable column type. The `fts`, `plfts`, `phfts` and `wfts` operators are implemented and 6 upstream cases pass with them in the published run. All 20 failures in the `missing-operator-fts` gap are DSQL's: 17 name a configuration such as `english`, `french` or `german` and cannot pass as written, and 3 reach a `tsvector` column or a function over one that DSQL dropped. 6 more cases are blocked outright for the same reason. Creating the missing configuration was probed on the conformance cluster and rejected: `CREATE TEXT SEARCH CONFIGURATION` and `CREATE TEXT SEARCH DICTIONARY` both answer `unsupported statement: Define`, `ALTER TEXT SEARCH CONFIGURATION ... ALTER MAPPING` answers `unsupported statement: AlterTSConfiguration`, and `pg_ts_template` holds no `snowball` to build a stemmer from (`conformance/DSQL-CAPABILITIES.md`). There is also no GIN index — `USING` is rejected for `CREATE INDEX` — so full-text and array queries have no index support.

The 14 `body-mismatch-filters` failures are the same ceiling one layer in: with no English stop words, `plainto_tsquery('simple', 'The Fat Rats')` keeps `the` and matches nothing, so the response is `[]` where upstream has a row.

Set `PGREST_DEFAULT_TS_CONFIG=simple` on DSQL. Without it the engine emits PostgreSQL's default (`english`) and every full-text query errors.

### Column types DSQL will not store

Arrays and range types work in expressions and as function arguments, but DSQL rejects them as column types — and a range is also rejected as a function return type. 67 cases are blocked because the request addresses a column that does not exist on this database (34 array columns, 33 other types), and 5 tables lost every column they had. 35 column definitions and 4 domain base types are dropped for this reason, plus 19 functions that return or take one of those types.

Those cases were counted as failures in the run this page used to report, because the engine had started answering PostgreSQL's own `42703 column entities.arr does not exist` — which is upstream's answer (`QuerySpec.hs:1556`) — and the harness's drop-attribution no longer recognised it. Triage now accepts `42703` against the drop list as the same evidence, so they are blocked again. Nothing about the cases changed in either direction; the rate is quoted both ways above.

Enum and composite types cannot be created at all (`CREATE TYPE` is rejected — 8 in the fixtures, 6 blocked cases), and neither can extensions (7 dropped, 2 blocked cases).

### Other DDL the fixtures need and DSQL refuses

Partitioned tables (12 dropped, 14 blocked cases), materialized views (2 dropped, 1 blocked case), `CREATE TABLE AS` (2), user-defined aggregates (14), user-defined casts (15), rules (1), procedures (1), `TRUNCATE`, temporary tables, and `SAVEPOINT`. DSQL also caps a database at 10 schemas, which drops 1 fixture schema.

Upstream's own isolation is reachable, but only per request. `SpecHelper.hs` sets `configDbTxRollbackAll = True` and `configDbTxAllowOverride = True`, and the engine now implements the same option, so the runner undoes every mutating request that does not ask for `Prefer: tx=commit` — worth 41 cases, itemised above. What DSQL cannot do is nest that inside anything: with no `SAVEPOINT`, a case that does commit cannot be unwound, so the harness still reloads fixtures once per spec file. Measured on commit `3fbf941` with everything else held constant, that reload was worth 550 of 1,199 against 443 of 1,199 without it.

## Settings that change the score

| Setting | Effect |
|---|---|
| `PGREST_RELATIONSHIPS_PATH` | Declared relationships for a database with no foreign keys. Required on DSQL; without it, embedding degrades silently. |
| `PGREST_DEFAULT_TS_CONFIG` | Text search configuration. Must be `simple` on DSQL. |
| `PGREST_REPRESENTATIONS_PATH` | Declared data representations for a database that rejects `CREATE CAST`. The runner defaults it to `conformance/fixtures/representations.json` for `--target dsql`; without it the `datarep_*` cases are measured against the untransformed column value. |
| `PGREST_DB_BULK_MUTATION_GUARD` | The harness runs with `off`. The engine's default is `on`, which refuses a filterless `PATCH`/`DELETE`; upstream has no such guard unless the `pg_safeupdate` extension is loaded, so measuring upstream's behaviour means matching upstream's state. `PgSafeUpdateSpec` is measured separately with `safeupdate`. |
| `db-tx-end` | The harness runs with `rollback-allow-override`, which is upstream's own setting. The engine's default is `commit`. Worth 41 cases, and it is about the harness rather than the engine: a deployment on the default gets none of that isolation and does not need it. |
| `policies` | The harness points the engine at `conformance/fixtures/policies/`, upstream's `privileges.sql` ported to Cedar. Without it every request is authorized as `service_role` and no case asserting a denial can pass. |

The harness also boots the engine with upstream's own non-default configuration for 29 spec ranges across 25 spec files (`conformance/runner/run.mjs`, `ENGINE_CONFIGS`) — `db-schemas`, `db-extra-search-path`, `db-max-rows`, `db-aggregates-enabled`, `db-plan-enabled`, `db-pre-request`, `server-cors-allowed-origins`, `jwt-secret` and its variants, `server-timing-enabled`, `server-trace-header`, `jwt-cache-max-entries`, `openapi-mode`, `client-error-verbosity`, `db-prepared-statements`, `url-use-legacy-target-names` and `db-pre-config`. Those cases are measured, not excluded. One of the 29 substitutes a mechanism: `PgSafeUpdateSpec` gets the engine's own guard in `safeupdate` mode instead of the `pg_safeupdate` extension DSQL cannot load, matching the same 400 and SQLSTATE 21000 body.

2 cases still need a setting the engine does not have, both `db-root-spec` (`RootSpec:19` and `RootSpec:28`): upstream serves a function's result at `/` instead of the generated spec, and the fixture function is plpgsql, which DSQL dropped. Adding a switch moves its cases into the denominator, where they fail until the behaviour behind the switch exists.

### Passes that are weaker than they look

An adversarial audit of the published runs looks for passes that do not mean what they appear to mean. It has found no inflation in the rate, and three things about how some passes are reached. All three are recorded in `compatreport/index.html` with what was run to check them:

- `PreparedStatementsSpec:17`, `:25` and `:29` pass with `db-prepared-statements` set both true and false, because nothing in `src/rest/` reads the setting: it is parsed in `src/index.mjs` and put on the request context, and no query path consults it. `PreparedStatementsSpec:25` asserts a bare `200`, so it cannot tell the two values apart even in principle. Read those three as "the switch is accepted", not "prepared statements behave as upstream". `docs/configuration.md` documents the setting as inert.
- 23 passes ride on the data-representations manifest. DSQL rejects `CREATE CAST`, so all 15 casts in upstream's `schema.sql` are dropped at fixture load and `pg_cast` has nothing for the engine to read; `conformance/fixtures/representations.json` declares the 15 pairs and the runner points `PGREST_REPRESENTATIONS_PATH` at it by default for `--target dsql`. It is a substitute for a catalog DSQL cannot populate, exactly like the relationship manifest, and it is not tuned to pass everything. On a database with `pg_cast`, the engine reads the same information from the catalog.
- The 41 isolation gains and the 18 JWT-path gains described above are both "this is now measured the way upstream measures it" rather than new query features. The 9 `Content-Length` gains are an extractor fix. None of them is a claim about a request feature working better than it did.

## A separate measurement: Cedar equivalence

This section is not part of the PostgREST pass rate above. It is a second, separate measurement, and it is never averaged into the first one.

It asks a narrower question than the conformance suite: for an upstream case that is really about an authorization decision, does a Cedar `permit`/`forbid` produce the same wire response as upstream's `GRANT`? **Result: 28 of 30 equivalences hold. 24 of the 54 upstream cases the set is derived from have no fair equivalent at all.** From `conformance/cedar/results/latest.json` (generated `2026-08-23T07:23:34Z`, tree `8bed54e`, the same tree as the published PostgREST run). The 2 divergences are 1 `body` — the engine names the policy set where PostgREST forwards SQLSTATE `42501` — and 1 `identity-mapping`, where the two mechanisms resolve the caller to different identities and each returns the correct status for the identity it saw. The 24 with no fair equivalent are 16 `jwt-verification`, 5 `session-identity-guc` and 3 `column-level-privilege`. Full method and case list: [Cedar equivalence](./cedar-equivalence).

What a reader should **not** read into it:

- It is not a PostgREST pass rate and is never added to one. It also no longer stands in for failures: the conformance runner loads its own port of the same `GRANT`s, so **44 of those 54 upstream cases now pass in the 1,176 / 1,294 above** and are counted there once. 8 fail there and 2 are out of scope. When this section was first written all 54 failed; that is no longer true, and the equivalence measurement is now a cross-check rather than a stand-in.
- A holding equivalence means a Cedar `permit` standing in for a `GRANT` produced the same status, body and asserted headers. It does not mean row-level security was exercised: the table behind most of them is empty in the fixtures.
- The denominator is the 30 derived cases, not the 54 upstream cases they cover. The 24 with no fair equivalent are in neither the numerator nor the denominator.
- It has no external referee. This project chose which cases are about authorization, wrote the policy set and wrote the runner. The PostgREST rate above has upstream's own assertions as the referee; this number does not.

The one capability gap this measurement surfaced and cannot close is column-level privilege: 3 upstream cases grant a role the write but `SELECT` on only some columns, and nothing in the Cedar model names a column as a resource, so no policy set can permit the write and deny the column. Those are the same 3 cases the `no-set-role` gap is now down to.

## Standard PostgreSQL

This page measures Aurora DSQL only. There is no conformance number for standard PostgreSQL yet, and most of the section above does not apply to it: foreign keys, plpgsql, triggers, enums, extensions, `SET ROLE`, RLS, array and range columns and every text search configuration work normally there. The engine probes the database at startup and adapts (`supportsForeignKeys`, `supportsFullTextSearch`, `supportsRangeTypes`, `supportsRowLevelSecurity`, `supportsGinIndex`, …), so on PostgreSQL it reads relationships from `pg_constraint` and needs no manifest. Do not read 90.9% as pgrest-lambda's compatibility on PostgreSQL; read it as the compatibility measured on DSQL, which is the harder target.

## Reproducing the measurement

```bash
# fixtures must already be loaded; see conformance/CONTRACTS.md for the cluster
PGREST_RELATIONSHIPS_PATH=$PWD/conformance/fixtures/relationships.json \
  node conformance/runner/run.mjs --target dsql --concurrency 1 --reload-per-spec
node conformance/report/build-report.mjs \
  --results conformance/results/run-<timestamp>.json \
  --label "$(git rev-parse --short HEAD) <timestamp>" \
  --tree "$(git rev-parse --short HEAD)" \
  --flags "--target dsql --concurrency 1 --reload-per-spec, PGREST_RELATIONSHIPS_PATH set" \
  --note "what this run changed"
node conformance/report/feature-table.mjs --results conformance/results/latest.json --markdown
```

The `--flags` string is byte-identical across every comparable run on purpose: the generator compares a run only against runs with the same string, so widening it drops the run out of every comparison it could have been part of. Anything else about the run — a variable the runner defaults, a substitute mechanism, the provenance of the file — goes in `--note`. `--tree` records which working tree was measured, which is not always the commit the file names: a run measured before the integration commit exists carries the earlier commit in its own metadata.

`--reload-per-spec` matters: without it the specs that mutate data leave rows behind for every spec that runs after them. The DSQL connection needs a fresh IAM token, valid one hour.

`compatreport/README.md` documents the report, the trend file and the honesty rules that govern both.
