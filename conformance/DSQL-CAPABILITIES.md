# DSQL Capabilities — Measured

Probed against a live Aurora DSQL cluster on 2026-08-19 with
`conformance/scripts/dsql-probe.sh`, and re-probed 2026-08-28 after DSQL shipped
foreign key constraints. DSQL reports `PostgreSQL 16`.

These are measurements, not documentation claims. Re-run the probe rather than
trusting this file if behaviour looks different — DSQL ships features
continuously, and the foreign-key section below is what that looks like: a
finding that read "not supported" for nine days and then changed.

The 2026-08-28 pass re-measured the rest of this file unchanged: still no
`SET ROLE`, no RLS, no enum or composite types, no array, range or `tsvector`
columns, only the `simple` text-search configuration, no plpgsql, no partitioned
tables, no materialized views, no `CREATE TABLE AS`, no user-defined aggregates,
no `USING GIN`, `CREATE INDEX` must be `ASYNC`, no `TRUNCATE`, no temp tables,
no `ctid`, no extensions, and a 3,000-row transaction limit.

## Supported

| Construct | Note |
|---|---|
| Base tables, PK, UNIQUE, CHECK | |
| `CREATE VIEW` | 146 views visible in `pg_class` |
| `CREATE DOMAIN` (plain and with `CHECK`) | Fixtures use 28 domains |
| `CREATE FUNCTION ... LANGUAGE sql` | Including `RETURNS SETOF` and `RETURNS TABLE` |
| Identity columns | Only with explicit `CACHE 1` or `CACHE >= 65536` |
| `LATERAL`, `json_agg`, CTEs, window functions | Embedding is implementable |
| `jsonb` operators (`@>`, `->`, `->>`) | |
| Array containment (`@>` on arrays) | In expressions and as function arguments only — **not as a column type**. `integer[]`, `int[][]` are rejected with `datatype X not supported`. |
| Range types (`int4range` etc.) | In expressions and as function arguments only — **not as a column type and not as a function return type**. `numrange`, `int4range` columns are rejected. |
| POSIX regex (`~`) | |
| Generated columns (`STORED`) | |
| `EXPLAIN` and `EXPLAIN (ANALYZE)` | |
| `INSERT ... ON CONFLICT`, `RETURNING` | |
| `CREATE SCHEMA`, `CREATE ROLE`, `GRANT` | Roles can be created but not assumed |
| `pg_catalog` (`pg_class`, `pg_proc`, `pg_constraint`) | Readable. `contype='f'` returns the foreign keys — measured 114 rows on the loaded fixtures, with `conkey`, `confkey`, `confupdtype`, `confdeltype`, `confmatchtype`, `condeferrable` and `convalidated` all populated |
| `FOREIGN KEY` constraints | Added 2026-08-27, re-measured 2026-08-28 — see below |
| Full-text search with the `simple` config | `to_tsvector('simple', ...) @@ to_tsquery(...)` works |

## Not supported

| Construct | Error | Consequence for PostgREST compatibility |
|---|---|---|
| `ALTER TABLE ADD CONSTRAINT` without `NOT VALID` | `unsupported ALTER TABLE ADD CONSTRAINT statement` | Holds for primary key, unique, check and foreign key alike. A foreign key can still be added to an existing table as `... ADD CONSTRAINT n FOREIGN KEY (…) REFERENCES p (…) NOT VALID`; a primary key cannot be added at all, so the fixture transformer still folds `ALTER TABLE ... ADD PRIMARY KEY` into `CREATE TABLE`. |
| `ALTER TABLE ... VALIDATE CONSTRAINT` | `unsupported ALTER TABLE ... statement` (`0A000`) | A key added as `NOT VALID` stays `convalidated = false` for good. It is still enforced for every write after it is added; only the rows already present go unchecked. |
| `LANGUAGE plpgsql` | `CREATE FUNCTION with language plpgsql not supported` | 36 plpgsql functions in fixtures. Blocks a slice of the ~152 RPC tests. |
| `CREATE TRIGGER` | (blocked by plpgsql) | 15 triggers in fixtures. |
| `SET ROLE` / `SET LOCAL ROLE` | `setting configuration parameter "role" not supported` | PostgREST's entire auth model is unreachable. Authorization must live in the engine (this is what the Cedar layer is for). |
| Custom (namespaced) run-time parameters | `setting configuration parameter "response.headers" not supported` — same text for `set local "response.headers" = '[]'` and for `select set_config('response.headers','[]',true)` | PostgREST's GUC-driven response headers and `request.*` claim GUCs cannot work. Because DSQL parses SQL function bodies at CREATE time, the `SET` form also fails the `CREATE FUNCTION`: 6 fixture functions (`get_projects_and_guc_headers`, `get_int_and_guc_headers`, `bad_guc_headers_1..3`, `set_cookie_twice`) are dropped by the transform. The `set_config()` form creates fine and fails at call time. |
| Row-level security | `unsupported ALTER TABLE ENABLE ROW SECURITY`, `unsupported statement: CreatePolicy` | Same as above. |
| `CREATE TYPE` (enum and composite) | `CREATE TYPE not supported`, `unsupported statement: CompositeType` | 8 types in fixtures. |
| Materialized views | `unsupported statement: CreateTableAs` | 2 in fixtures. |
| `CREATE SEQUENCE` / `serial` | Needs explicit cache; `type "serial" does not exist` | 15 `serial` uses must become `GENERATED ... AS IDENTITY (CACHE 1)`. |
| `CREATE EXTENSION` | `unsupported statement: CreateExtension` | 6 in fixtures (incl. postgis-dependent tests). |
| `TRUNCATE` | `unsupported statement: Truncate` | Use `DELETE` when resetting fixtures. |
| Temp tables | `TEMPORARY or TEMP table not supported` | |
| `SAVEPOINT` | `unsupported transaction statement: SAVEPOINT` | Affects rollback-semantics tests. |
| `CREATE INDEX ... USING gin` | `USING not supported for CREATE INDEX` | No GIN; FTS and array queries have no index support. |
| Partitioned tables | `PARTITION BY clause not supported` | |
| Text search configs other than `simple` | `text search configuration "english" does not exist` | Only one row in `pg_ts_config`. FTS tests that name a language config cannot pass as written. |
| Creating a text search config or dictionary | `unsupported statement: Define` for both `CREATE TEXT SEARCH DICTIONARY` and `CREATE TEXT SEARCH CONFIGURATION`; `unsupported statement: AlterTSConfiguration` for `ALTER TEXT SEARCH CONFIGURATION ... ALTER MAPPING`. `pg_ts_template` holds `simple`, `synonym`, `ispell`, `thesaurus` — no `snowball`. | The missing `english` config cannot be substituted, which is why it is a ceiling and not a fixture problem. Without English stop words, `plainto_tsquery('simple','The Fat Rats')` keeps `the` and matches nothing, so the `plfts`/`wfts`/`phfts` assertions come back empty rather than erroring; without a stemmer there is no `rats`→`rat`. |

## Foreign keys

Measured 2026-08-28 on a cluster created for the purpose, after the
[2026-08-27 announcement](https://aws.amazon.com/about-aws/whats-new/2026/08/amazon-aurora-dsql-foreign-key-constraints/)
and against the
[user guide](https://docs.aws.amazon.com/aurora-dsql/latest/userguide/working-with-foreign-key-constraints.html).
This replaces the "no foreign keys" finding of 2026-08-19.

Accepted: inline `REFERENCES` in `CREATE TABLE` in every shape tried — column
list, bare, table-level, composite, self-reference, two keys to one parent,
cross-schema; all five referential actions; `MATCH FULL`;
`DEFERRABLE INITIALLY DEFERRED`; `SET CONSTRAINTS ALL DEFERRED`;
`ALTER TABLE [ONLY] t ADD CONSTRAINT n FOREIGN KEY (…) REFERENCES p (…) NOT VALID`
including over rows that already violate it, against a non-PK `UNIQUE` target,
on a child with no primary key, and two clauses in one `ALTER`;
`ALTER TABLE t DROP CONSTRAINT n`; `DROP TABLE ... CASCADE` on a referenced
parent.

Enforced: `23503` on an orphan child insert, on deleting a referenced parent and
on updating a referenced key; `ON DELETE CASCADE` cascades. Measured again on
the loaded fixtures — `insert into public.tasks (id, name, project_id) values
(99991, 'orphan', 987654)` returns `23503`, `constraint "project"`.

Rejected: `CREATE TABLE ... REFERENCES <table that does not exist yet>` answers
`42P01`, so a fixture load cannot rely on declaration order; and
`ADD CONSTRAINT` without `NOT VALID` answers `0A000`, so the keys have to be
re-declared after the tables exist. The fixture pipeline therefore strips
`REFERENCES` from `CREATE TABLE` and emits
`conformance/fixtures/dsql/08-foreign-keys.sql`, applied after the data.

Consequence for the fixtures: a `DELETE FROM parent` now answers `23503` while a
child still holds rows, so `07-data.sql` empties its 149 tables in one leading
block in reverse topological order, and the runner's targeted restore expands a
touched table through the graph. One 2-cycle,
`public.departments` ↔ `public.agents`, cannot be ordered and is broken with an
`UPDATE public.agents SET department_id = NULL` ahead of the block.

## Implications

Four DSQL gaps are load-bearing for this project, in descending order:

1. **No `SET ROLE` and no RLS.** PostgREST's authorization is Postgres
   authorization. Ours cannot be, so the engine has to enforce it and the
   role-switching tests are permanently out of scope.
2. **No plpgsql.** Function bodies in the fixtures must be rewritten in SQL
   where possible; where not possible, the dependent RPC tests are blocked.
3. **No namespaced run-time parameters.** `set_config('response.headers', ...)`
   and `SET "request.jwt.claims"` are both rejected, so PostgREST's
   GUC-driven response headers and claim-passing mechanism have no equivalent.
   Because DSQL parses function bodies at `CREATE` time, the `SET` form also
   fails at `CREATE FUNCTION`, dropping 6 more fixture functions.
4. **No `SAVEPOINT`.** Nested rollback is out, but a single level is not:
   explicit `BEGIN` / `ROLLBACK` works, which is what upstream's harness needs.
   Upstream sets `configDbTxRollbackAll = True`, so every one of its tests runs
   against pristine fixtures, and the engine now offers the same option
   (`db-tx-end`, `PGREST_DB_TX_END`) — the runner sets
   `rollback-allow-override`, upstream's own value, so a mutating case undoes
   itself the way it does upstream. `--reload-per-spec` still reloads fixtures
   once per spec file, for the state a request cannot undo: a `Prefer: tx=commit`
   case, and the fixture drift the loader itself leaves behind.

A type-level restriction worth stating separately, because it is easy to
misread: arrays and range types work fine in **expressions and function
arguments** but are rejected as **column types**, and a range is also rejected
as a function **return type**. Several dozen upstream assertions depend on
array or range columns and are therefore unrunnable, not merely failing.
