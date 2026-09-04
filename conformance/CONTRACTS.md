# Conformance Harness Contracts

These file formats are fixed. Every component reads/writes them exactly as
specified. Do not change a format without changing this document first.

Upstream PostgREST checkout: `/home/ec2-user/postgrest-upstream`
(shallow clone, `test/spec/` holds specs + fixtures).

DSQL conformance cluster (us-east-1):

```
DSQL_ENDPOINT=6juamhyj5nkoeatkzc3ieaerc4.dsql.us-east-1.on.aws
REGION_NAME=us-east-1
user=admin  database=postgres  port=5432  sslmode=require
```

Password is a short-lived IAM token, regenerate when it expires (1h):

```bash
export PGPASSWORD="$(aws dsql generate-db-connect-admin-auth-token \
  --region us-east-1 --hostname "$DSQL_ENDPOINT" --expires-in 3600)"
export PGSSLMODE=require
```

## 1. Test case format

One JSON file per upstream spec file, written to
`conformance/cases/<SpecName>.json`. Top level is an object:

```json
{
  "source": "Feature/Query/QuerySpec.hs",
  "extractedCases": 212,
  "skippedSites": 4,
  "needsConfigCases": 3,
  "cases": [ /* case objects */ ]
}
```

A case object:

```json
{
  "id": "QuerySpec:142",
  "source": "Feature/Query/QuerySpec.hs",
  "line": 142,
  "category": "select",
  "description": "returns items by id",
  "example": "QuerySpec:it:140",
  "request": {
    "method": "GET",
    "path": "/items",
    "query": "id=eq.1",
    "headers": { "Accept": "application/json" },
    "body": null,
    "bodyFormat": "none"
  },
  "expected": {
    "status": 200,
    "body": [ { "id": 1 } ],
    "bodyFormat": "json",
    "headers": { "Content-Range": "0-0/*" },
    "headersAbsent": ["Content-Length"],
    "headersContain": [ { "name": "Access-Control-Allow-Methods", "value": "POST" } ],
    "headersMatch": [ { "name": "Server-Timing", "pattern": "parse;dur=[0-9]+.[0-9]+" } ]
  },
  "bodyMatch": "exact",
  "transforms": [],
  "skip": false,
  "skipReason": null,
  "skipClass": null
}
```

Rules:

- `id` is `<SpecName>:<line>` and must be unique across all files.
- `category` is a kebab-case slug grouping the feature under test
  (`select`, `filters`, `embedding`, `rpc`, `insert`, `update`, `delete`,
  `upsert`, `range`, `singular`, `openapi`, `auth`, `errors`, `json-operators`,
  `aggregates`, `media-types`, `multiple-schemas`, `plan`, `preferences`,
  `rollback`, `cors`, `options`, `http-headers`, `observability`).
- `bodyMatch` is `exact` (deep equal, array order significant),
  `set` (deep equal ignoring array order), or `ignore` (status/headers only).
- `expected.bodyFormat` says how to read `expected.body`, and is the only thing
  that can: a JSON body may itself be a string, a number or `null`.
  - `json` — `expected.body` **is** the JSON value. `[json|"Hello, world"|]`
    becomes `"body": "Hello, world", "bodyFormat": "json"` and the wire bytes
    must parse to that string. `[json|null|]` becomes
    `"body": null, "bodyFormat": "json"` and asserts the 4 bytes `null`.
  - `text` — compare the raw bytes (`[str|...|]` heredocs, CSV, binary output).
  - `none` — the spec asserts an empty body.
  - `ignore` — the spec asserts status/headers only (`matchBody` any).
  A Haskell `String` matcher is a byte comparison upstream; when those bytes
  parse as JSON the case records `json` and is compared structurally. That is a
  deliberate relaxation (key order, whitespace) and the only one.
- `request.bodyFormat` is `json` (serialize `request.body`), `text` (send it as
  written) or `none` (no body).
- `expected.headers` holds only headers the spec explicitly asserts, one exact
  value each (upstream `name <:> value`). The three optional sibling fields carry
  the other header matchers in SpecHelper.hs. All are omitted when empty.
  - `headersAbsent` — array of header names that must not be present at all
    (upstream `matchHeaderAbsent name`). An empty value is still present, so
    this is not the same as asserting `""`.
  - `headersContain` — `{ name, value }` pairs where `value` must appear as a
    substring of the response header (upstream `matchHeaderValuePresent`).
  - `headersMatch` — `{ name, pattern }` pairs where `pattern` is a JavaScript
    regex source that must match the response header value. Used for upstream's
    regex matchers, e.g. `matchServerTimingHasTiming metric` becomes
    `metric;dur=[0-9]+.[0-9]+`. POSIX classes such as `[[:digit:]]` are
    translated at extraction time; a pattern that cannot be translated is a skip,
    never a guess.
- `request.jwt` is present when the spec built its `Authorization` header at
  runtime from a token it signed itself (`authHeaderJWT $ generateJWT claims`,
  SpecHelper.hs). It is `{ "alg": "HS256", "secret": "<signing key>",
  "claims": { ... } }` and the runner mints the token and sets
  `Authorization: Bearer <token>` before invoking the handler. A claim value of
  the form `{ "$secondsFromNow": -35 }` is upstream's `relativeSeconds -35`
  spliced in as `#{currentTime}`; it must be resolved at mint time, because
  baking an absolute number at extraction time would silently flip the meaning
  of every `exp`/`nbf`/`iat` case. Any other Haskell splice in a claim set is a
  skip.
- `example` identifies the enclosing upstream `it` (`<SpecName>:it:<line>`), or
  is `null` when there is none. Several cases sharing an `example` are
  sequential steps of one test, which is what lets the runner know where it may
  restore the fixtures between cases.
- `transforms` lists mechanical rewrites applied to the expectation so it can
  match the DSQL fixtures, one human-readable line each. Empty for a verbatim
  case. The only one in use rewrites `test.<object>` to `public.<object>` in
  expected error messages, because the fixtures load upstream's `test` schema
  into `public`.
- A `shouldRespondWith` site that cannot be converted faithfully gets a case
  with `skip: true` and a `skipReason` naming what was not representable.
  Never guess an assertion — an unfaithful case is worse than a skipped one.
  This includes assertions that depend on state a skipped step in the same
  `example` was supposed to create.
- `skipClass` says *why* a skipped case does not run. It is `null` when
  `skip` is `false`, and otherwise one of:
  - `needs-engine-config` — the assertion and the request are both
    representable; it only holds when the PostgREST process runs with a setting
    the engine has no switch for (`configDbSchemas`, `configDbExtraSearchPath`,
    `configDbMaxRows`, `configDbPreRequest`, `db-aggregates-enabled`,
    `db-plan-enabled`, …). This is a missing engine feature, not a harness
    limitation, and the runner reports it as its own status so the report can
    show it separately. Adding the switch moves the case into the denominator.
  - `not-representable` — the harness cannot carry the assertion or build the
    request without guessing.
  A case whose reasons mix the two classes is `not-representable`: the harness
  limitation is the binding one.
- `needsConfigCases` at the top level counts the `needs-engine-config` cases in
  the file. `extractedCases + skippedSites` is every site;
  `needsConfigCases` ≤ `skippedSites`.

## 2. Fixture output

`conformance/fixtures/dsql/NN-<name>.sql` — DDL/DML that loads cleanly into
DSQL, applied in filename order.

`conformance/fixtures/dsql/08-foreign-keys.sql` — one
`ALTER TABLE ... ADD CONSTRAINT ... FOREIGN KEY ... NOT VALID` per key. It sorts
last on purpose: DSQL rejects `REFERENCES` to a table that does not exist yet
(`42P01`) and rejects `ADD CONSTRAINT` without `NOT VALID` (`0A000`), so the keys
have to be re-declared once the tables and their data are in place. `NOT VALID`
does not check the rows already there and enforces every write after it.

`conformance/fixtures/relationships.json` — the same graph as a manifest, for an
engine that cannot read `pg_constraint`. It is no longer how the measurement
resolves embedding: since 2026-08-27 DSQL stores the keys and the engine reads
them from the catalog, which is what it does in production. The file stays
because the transformer needs the graph to order the deletes in `07-data.sql`,
and because `PGREST_RELATIONSHIPS_PATH` is still the answer for a relationship
that was never a constraint.

`conformance/fixtures/relationships-residual.json` — the keys whose `ALTER`
the cluster rejected, in the same shape, written on every full load even when
empty. Each entry carries the `error` and a `declarable` flag: `false` means the
key's own table or its referenced table was dropped at load, so declaring it
would name relations the cluster does not have. Currently 1 entry,
`public.car_racers` → `public.car_models`, `declarable: false` — `car_models` is
partitioned, which DSQL rejects, and `car_racers` went with it.

```json
{
  "relationships": [
    {
      "constraint": "items_owner_fkey",
      "schema": "public",
      "table": "items",
      "columns": ["owner_id"],
      "foreignSchema": "public",
      "foreignTable": "users",
      "foreignColumns": ["id"]
    }
  ]
}
```

`conformance/fixtures/load-report.json` — what happened on load:

```json
{
  "statementsTotal": 0,
  "statementsApplied": 0,
  "statementsFailed": 0,
  "foreignKeysApplied": 0,
  "foreignKeysFailed": 0,
  "objects": { "tables": 0, "views": 0, "functions": 0, "domains": 0 },
  "dropped": [
    { "object": "public.get_items", "kind": "function",
      "reason": "plpgsql not supported by DSQL",
      "affectsCategories": ["rpc"] }
  ]
}
```

Every construct dropped for a DSQL limitation must appear in `dropped` with a
reason. That list is what makes the compatibility report honest.

## 3. Results format

`conformance/results/latest.json` (and a timestamped copy alongside it):

```json
{
  "generatedAt": "2026-08-19T00:00:00Z",
  "target": "dsql",
  "commit": "abc1234",
  "totals": { "total": 0, "passed": 0, "failed": 0, "skipped": 0,
              "needsConfig": 0, "blocked": 0, "outOfScope": 0, "errored": 0 },
  "byCategory": {
    "select": { "total": 0, "passed": 0, "failed": 0, "skipped": 0,
                "needsConfig": 0, "blocked": 0, "outOfScope": 0, "errored": 0 }
  },
  "cases": [
    {
      "id": "QuerySpec:142",
      "category": "select",
      "status": "pass",
      "reason": null,
      "gap": null,
      "actual": { "status": 200, "body": null }
    }
  ]
}
```

`status` is `pass`, `fail`, `skip` (marked `skip` at extraction with
`skipClass: "not-representable"` — a harness limitation), `needs-config`
(marked `skip` with `skipClass: "needs-engine-config"` — the assertion needs a
PostgREST process setting the engine has no switch for; gap slug
`needs-engine-config`), `blocked` (fixture the case needs could not exist on
DSQL), `out-of-scope` (the assertion tests a PostgREST mechanism this
architecture cannot have — `SET ROLE`/RLS authorization, namespaced run-time
parameters), or `error` (harness threw). `gap` is a slug naming the root cause
for non-passing cases, e.g. `missing-operator-fts`, `no-plpgsql`, `no-set-role`,
`no-foreign-keys`.

The headline pass rate is `passed / (passed + failed)` — the cases that ran and
are in scope. `skipped`, `needsConfig`, `blocked` and `outOfScope` are reported
next to it, not inside it; `total` is every case in `conformance/cases/`.
`needs-config` is kept apart from `skip` on purpose: a skip is the harness
falling short, a needs-config is the engine falling short, and collapsing them
would hide missing engine features inside a harness caveat.

## 4. HTML report

`compatreport/index.html` — self-contained (no network fetches at view time),
generated from `conformance/results/latest.json` by
`conformance/report/build-report.mjs`. Must show overall pass rate, a
per-category breakdown, and the gap list with counts. Data is inlined as JSON
in a `<script>` tag so the file works opened directly from disk.

## 5. Running

The runner invokes the Lambda handler in-process (build an API Gateway event
and call the exported handler). No HTTP server, no deployed stack.

```bash
node conformance/runner/run.mjs --target dsql            # full suite
node conformance/runner/run.mjs --target dsql --category select
node conformance/report/build-report.mjs                 # regenerate HTML
```
