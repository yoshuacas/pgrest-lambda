# Plan: use Aurora DSQL foreign keys

Aurora DSQL added foreign key constraints on 2026-08-27
([What's New](https://aws.amazon.com/about-aws/whats-new/2026/08/aurora-dsql-foreign-key-constraints/),
[user guide](https://docs.aws.amazon.com/aurora-dsql/latest/userguide/working-with-foreign-key-constraints.html)).
The engine and the conformance fixtures both carry workarounds for their
absence. This plan removes them.

The announcement is about **foreign keys**, not primary keys. `ALTER TABLE ADD
PRIMARY KEY` is still rejected, so the fixture transformer's primary-key folding
stays.

## Measured, not assumed

Probed on a cluster created for this purpose (`xrube2i23rqmv5w6xulf5numr4`,
`us-east-1`, reports `PostgreSQL 16`), 2026-08-28. Scripts: `probe-fk*.tmp.mjs`
(temporary, not committed).

Accepted:

| Shape | Result |
| --- | --- |
| Inline `REFERENCES` in `CREATE TABLE` — column list, bare, table-level, composite, self, two to one parent, cross-schema | all OK |
| All five referential actions, `MATCH FULL`, `DEFERRABLE INITIALLY DEFERRED` | OK |
| `ALTER TABLE [ONLY] t ADD CONSTRAINT n FOREIGN KEY (…) REFERENCES p (…) … NOT VALID` | OK |
| …over rows that already violate it | OK |
| …child without a primary key, self-reference, non-PK `UNIQUE` target, composite, cross-schema, bare `REFERENCES p`, quoted constraint name (`"user"`), two clauses in one `ALTER` | all OK |
| `ALTER TABLE t DROP CONSTRAINT n` on a foreign key | OK |
| Enforcement: `23503` on orphan child insert, on deleting a referenced parent, on updating a referenced key; `ON DELETE CASCADE` cascades | OK |
| `pg_constraint` `contype='f'` with `conkey`, `confkey`, `confupdtype`, `confdeltype`, `confmatchtype`, `condeferrable`, `convalidated`; `information_schema.referential_constraints` | populated |
| `SET CONSTRAINTS ALL DEFERRED`; `DELETE FROM <self-referencing table>` (all rows) | OK |

Rejected:

| Shape | Error |
| --- | --- |
| `ALTER TABLE … ADD CONSTRAINT` **without** `NOT VALID` — primary key, unique, check, foreign key | `0A000 unsupported ALTER TABLE ADD CONSTRAINT statement` |
| `ALTER TABLE … VALIDATE CONSTRAINT` | `0A000` |
| `CREATE TABLE … REFERENCES <table that does not exist yet>` | `42P01` |

So a foreign key can be added to an existing table only as `NOT VALID`, which
leaves `convalidated = false` in the catalog but enforces every subsequent
write. That is the whole basis of the fixture change below.

Everything else in `conformance/DSQL-CAPABILITIES.md` re-measured unchanged in
the same pass: no `SET ROLE`, no RLS, no enum or composite types, no array,
range or `tsvector` columns, only the `simple` text-search configuration, no
plpgsql, no partitioned tables, no materialized views, no `CREATE TABLE AS`, no
aggregates, no `USING GIN`, `CREATE INDEX` must be `ASYNC`, no `TRUNCATE`, no
temp tables, no `ctid`, no extensions, 3,000-row transaction limit. Domains,
`CREATE ROLE`, table and column `GRANT`s, SQL-language functions and
`SET LOCAL "<custom.guc>"` are accepted.

## A. Engine

1. `src/rest/db/dsql.mjs`: `supportsForeignKeys: false` → `true`. Rewrite the
   header comment: cite the announcement date and the measured facts, and record
   that adding a key to an existing table needs `NOT VALID`.
2. `src/rest/schema-cache.mjs`: `FK_SQL` needs no change — it does not filter
   `convalidated`, which is what makes `NOT VALID` keys visible. Add a comment
   saying that is deliberate, because on DSQL that is the only way to add a key
   to an existing table, and upstream PostgREST does not filter either.
3. Audit every other reader of `supportsForeignKeys`; the only gate today is
   `pgIntrospect`.
4. Keep `PGREST_RELATIONSHIPS_PATH`. It is still the answer for computed and
   view relationships and for other engines. Stop documenting it as *required
   on DSQL*.
5. Tests: the DSQL capability object reports `supportsForeignKeys: true`;
   `pgIntrospect` issues `FK_SQL` under DSQL capabilities; a row with
   `convalidated = false` still yields a relationship.

## B. Conformance fixtures

The transformer drops all 115 foreign keys and recovers them into
`conformance/fixtures/relationships.json`, which the run then feeds back through
`PGREST_RELATIONSHIPS_PATH`. That means the published rate measures the manifest
path, not the catalog path the product actually ships.

1. `conformance/fixtures/transform.mjs`: keep stripping inline `REFERENCES` and
   keep recording every key into the manifest — the manifest is the foreign-key
   graph and both outputs need it. Additionally emit
   `conformance/fixtures/dsql/08-foreign-keys.sql`, one statement per recorded
   relationship:

   ```sql
   ALTER TABLE "s"."t" ADD CONSTRAINT "n"
     FOREIGN KEY ("c", …) REFERENCES "fs"."ft" ("fc", …) <options> NOT VALID;
   ```

   `parseReferences` currently skips `MATCH` / `ON DELETE` / `ON UPDATE` /
   `DEFERRABLE` without capturing them; it has to return that source text so the
   emitted key matches upstream. Upstream uses `on delete cascade`,
   `on update cascade` and `not deferrable`; no `MATCH`.

   Because `08` runs after `07-data.sql`, and `NOT VALID` does not check
   existing rows, the initial load needs no data reordering and cannot fail on
   fixture data the transformer has already thinned.

2. `conformance/fixtures/load.mjs`: `08-foreign-keys.sql` is picked up by the
   existing `readdirSync` glob in sort order — verify, do not assume. Record
   `foreignKeysApplied` / `foreignKeysFailed` in `load-report.json`, and write
   `conformance/fixtures/relationships-residual.json` holding only the keys
   whose `ALTER` failed, with the error. If a key cannot reach the catalog, the
   run may still declare it — but only that one, and the report has to name it.

3. Reload ordering. `07-data.sql` is `DELETE`-then-`INSERT` per table, 149
   deletes, emitted parents-first because upstream's inserts are parents-first.
   With the keys enforced, a parent delete now fails `23503`. Fix in two places:

   - `transform.mjs`: emit the deletes as one leading block, fully qualified, in
     reverse topological order of the foreign-key graph. Measured on the current
     manifest: 147 tables, 95 cross-table edges, 8 self-references (a full-table
     delete satisfies those), and exactly one 2-cycle,
     `public.departments` ↔ `public.agents`. Break cycles deterministically and
     log which edge was broken.
   - `conformance/runner/run.mjs`: the per-table restore (`--reset-mutations`
     and the touched-table path) issues `DELETE FROM t` for one table. Expand
     the touched set through the foreign-key graph — clear descendants first,
     refill them after. Read the graph from `pg_constraint` at runner start, so
     the runner needs no manifest. Fall back to the existing full reload when
     the order cannot be derived.

4. Drop `PGREST_RELATIONSHIPS_PATH` from the documented run command. Point it at
   the residual file only if that file is non-empty, and say what is in it.

## C. Expected movement

Direct: the 6 `no-foreign-keys` failures — `EmbedDisambiguationSpec:217`,
`:408`, `:411`, `:507`, `:518` and `QuerySpec:798`. Three need a real constraint
name for `!hint` disambiguation and two need a view to inherit its base table's
key, neither of which the manifest can do.

Against that, keys that are now enforced can turn passes into failures: a
mutation case that leaves a dangling reference used to succeed. Report both
directions; do not net them out.

## D. Verification, on a real cluster

1. Fresh DSQL cluster; `node conformance/fixtures/load.mjs`; check
   `load-report.json` for the `08` counts and confirm `pg_constraint` reports
   the keys.
2. Full conformance run with the published flag string minus
   `PGREST_RELATIONSHIPS_PATH`; two runs on the same tree; compare with the
   published 1,176 / 1,294; publish the lower.
3. `npm test`, `npm run test:integration`, `npm run test:e2e`.
4. Update `conformance/DSQL-CAPABILITIES.md`,
   `docs/reference/postgrest-compatibility.md`, `compatreport/README.md`,
   `docs/configuration.md`, `CHANGELOG.md`.

## Outcome, measured

All four steps ran. What they produced:

1. Fixtures loaded on the conformance cluster
   (`6juamhyj5nkoeatkzc3ieaerc4`, `us-east-1`): 1,250 of 1,251 statements
   applied, `foreignKeysApplied: 114`, `foreignKeysFailed: 1`. The one that fails
   is `public.car_racers → public.car_models`; `car_models` is partitioned, so
   DSQL creates neither table and no manifest could have expressed the
   relationship either. `pg_constraint` reports all 114 with
   `convalidated = false`, which is what `NOT VALID` leaves behind, and
   enforcement is live for every write after it.
2. Four full runs, all with `--target dsql --concurrency 1 --reload-per-spec`
   and no `PGREST_RELATIONSHIPS_PATH`. Tree `aafedf0` scored 1,173 and 1,179 of
   1,294; tree `4cebc95` scored 1,179 twice, agreeing case for case, and the
   second is published (91.1%). The 6-case spread on `aafedf0` was not the keys —
   every case in it reads DSQL's planner estimate through
   `Prefer: count=planned`, and a freshly created DSQL table has no statistics,
   so the planner answered a round default. `4cebc95` adds an `ANALYZE` pass to
   the fixture loader, one relation at a time because DSQL rejects the bare and
   `VACUUM ANALYZE` forms with `0A000`, and the spread closed.
3. `npm test` 1,946 pass — 1,694 engine and deploy tests plus the 252
   conformance harness tests the same glob picks up — then
   `npm run test:integration` 68 pass and `npm run test:e2e` 14 pass.
4. Docs updated as listed, plus `AGENTS.md`,
   `schema-examples/dsql-compatible.sql`, `docs/reference/cedar-equivalence.md`
   and `docs/reference/index.md`.

Two results worth stating as null results. Retiring the manifest changed no
case's outcome: the 3 cases that moved between 1,176 and 1,179 are the two
planner estimates and one row-order case, none of them a relationship. And the
Cedar equivalence measurement, re-run on `4cebc95`, still holds 28 of 30 with
the same two divergences — the relationships an authorization decision travels
through changed underneath it and nothing moved.

The movement section C predicted was wrong in both directions. All six cases it
named as direct gains — `EmbedDisambiguationSpec:217`, `:408`, `:411`, `:507`,
`:518` and `QuerySpec:798` — still fail under `no-foreign-keys`, because none of
them needs a constraint the catalog was missing: what is left in that gap is a
view's column provenance, which upstream reads from `pg_rewrite`, and
disambiguation between two relationships joining the same pair of relations.
Neither is something a foreign key expresses, so real keys could not close them.
Nothing moved the other way either: no pass became a failure because keys are now
enforced, in a run where every in-run `07-data.sql` reload applied 578 of 578
statements with 0 failures and a full reset dropped 493 objects with 0 failures.
