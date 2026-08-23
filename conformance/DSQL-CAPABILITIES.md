# DSQL Capabilities — Measured

Probed against a live Aurora DSQL cluster on 2026-08-19 with
`conformance/scripts/dsql-probe.sh`. DSQL reports `PostgreSQL 16`.

These are measurements, not documentation claims. Re-run the probe rather than
trusting this file if behaviour looks different — DSQL ships features
continuously.

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
| `pg_catalog` (`pg_class`, `pg_proc`, `pg_constraint`) | Readable; `contype='f'` always returns 0 rows |
| Full-text search with the `simple` config | `to_tsvector('simple', ...) @@ to_tsquery(...)` works |

## Not supported

| Construct | Error | Consequence for PostgREST compatibility |
|---|---|---|
| `FOREIGN KEY` constraints | `FOREIGN KEY constraint not supported` | Embedding cannot use FK introspection. 119 `REFERENCES` / 38 `FOREIGN KEY` in fixtures. Needs a declared relationship manifest. |
| `ALTER TABLE ADD CONSTRAINT` | `unsupported ALTER TABLE ADD CONSTRAINT statement` | FKs cannot be added after the fact either. |
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

## Implications

Five DSQL gaps are load-bearing for this project, in descending order:

1. **No foreign keys.** PostgREST derives resource embedding entirely from
   `pg_constraint`. The engine needs a relationship source that isn't the
   catalog.
2. **No `SET ROLE` and no RLS.** PostgREST's authorization is Postgres
   authorization. Ours cannot be, so the engine has to enforce it and the
   role-switching tests are permanently out of scope.
3. **No plpgsql.** Function bodies in the fixtures must be rewritten in SQL
   where possible; where not possible, the dependent RPC tests are blocked.
4. **No namespaced run-time parameters.** `set_config('response.headers', ...)`
   and `SET "request.jwt.claims"` are both rejected, so PostgREST's
   GUC-driven response headers and claim-passing mechanism have no equivalent.
   Because DSQL parses function bodies at `CREATE` time, the `SET` form also
   fails at `CREATE FUNCTION`, dropping 6 more fixture functions.
5. **No `SAVEPOINT`.** Nested rollback is out, but a single level is not:
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
