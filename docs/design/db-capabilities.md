# Database Capabilities Interface

## Overview

Add a `capabilities()` method to the database provider
interface so every REST feature can check what the
underlying database supports at design time. Each provider
(postgres.mjs, dsql.mjs) declares a frozen capability
object. The REST engine reads these flags instead of
try/catch-and-fallback patterns.

This is a foundational change. Five feature loops
(select-aliases, rpc-endpoint, embedded-filtering,
select-casts, fts-operators) will read these flags to
decide whether to attempt a feature or return a clear
error.

Today the codebase has one try/catch in schema-cache.mjs
(lines 138-146) that silently swallows the FK query on
DSQL. That works, but the pattern does not scale. As we
add FTS, range ops, count=planned, aggregates, etc., every
feature would otherwise sprout its own DSQL-aware branch,
and the decision of "what works where" would be smeared
across ten files instead of declared once per provider.

## Current CX / Concepts

### Two Database Runtimes

pgrest-lambda targets two runtimes today:

- **Standard PostgreSQL** — RDS, Aurora Serverless v2,
  self-hosted, local Docker. Full feature set.
- **Aurora DSQL** — serverless, multi-region. Drops
  foreign key constraints, SET ROLE, RLS, tsvector/
  tsquery types, range types, PL/pgSQL, triggers,
  temporary tables, and GIN indexes. Only supports
  SQL-language functions.

Provider selection happens in `src/rest/db/index.mjs`:

```javascript
export function createDb(config) {
  if (config.provider === 'dsql') return createDsqlProvider(config);
  if (config.provider === 'postgres') return createPostgresProvider(config);
  if (config.dsqlEndpoint) return createDsqlProvider(config);
  return createPostgresProvider(config);
}
```

### Provider Interface

`src/rest/db/interface.mjs` defines the contract:

```javascript
/** @typedef {Object} DatabaseProvider
 * @property {() => Promise<Pool>} getPool
 * @property {(pool: Pool) => void} _setPool
 * @property {((pool: Pool) => Promise<Schema>)?} [introspect]
 */
```

Both providers implement `getPool`, `_setPool`, and
`close`. Neither declares what features its database
supports.

### FK Try/Catch in Schema Cache

`src/rest/schema-cache.mjs` lines 138-146:

```javascript
// FK introspection (may fail on DSQL)
let fkRows = [];
try {
  const fkResult = await pool.query(FK_SQL);
  fkRows = fkResult.rows;
} catch {
  // DSQL or other DB that rejects the FK query
  fkRows = [];
}
```

This is the only DSQL-aware code path in the engine.
When the FK query fails, the schema cache falls back to
convention-based relationship inference. The try/catch
works but spreads the "DSQL can't do X" decision into
the runtime error-handling path instead of declaring it
upfront.

### No Capability Awareness in the Engine

The handler (`src/rest/handler.mjs`), sql-builder, and
query-parser have no access to database capability
information. They assume PostgreSQL semantics everywhere.
When an unsupported feature is used on DSQL, the request
either fails with a raw PostgreSQL error or silently
returns unexpected results.

### Context Object

`src/index.mjs` builds a shared context:

```javascript
ctx.db = db;
ctx.schemaCache = schemaCache;
ctx.cedar = cedar;
ctx.jwt = jwt;
ctx.docs = resolved.docs;
ctx.apiBaseUrl = resolved.apiBaseUrl;
ctx.cors = resolved.cors;
ctx.production = resolved.production;
```

No `dbCapabilities` field exists.

## Proposed CX / CX Specification

### Capability Flags

The following flags are declared per provider:

| Flag | PostgreSQL | DSQL | Read by |
|------|-----------|------|---------|
| `supportsForeignKeys` | `true` | `false` | schema-cache.mjs FK introspection |
| `supportsFullTextSearch` | `true` | `false` | fts-operators feature (future) |
| `supportsRangeTypes` | `true` | `false` | embedded-filtering feature (future) |
| `supportsArrayContainment` | `true` | `true` | embedded-filtering feature (future) |
| `supportsPlannedCount` | `true` | `false` | count=planned strategy (future) |
| `supportsRegex` | `true` | `true` | query-parser regex operators (future); DSQL LIKE confirmed, POSIX ~ assumed |
| `supportsRowLevelSecurity` | `true` | `false` | documentation only; shaped the auth layer |
| `supportsRpc` | `true` | `true` | rpc-endpoint feature (future); DSQL: SQL-language functions only, no PL/pgSQL |
| `supportsGinIndex` | `true` | `false` | FTS and array performance hints (future) |

### Access Pattern

Any code with access to `ctx` reads capabilities:

```javascript
if (!ctx.dbCapabilities.supportsForeignKeys) {
  // skip FK query, use convention fallback
}
```

No provider-specific imports. No `instanceof` checks.
No try/catch around feature SQL.

### Error Response: PGRST501

When a REST request uses a feature the current database
does not support, the engine returns HTTP 501 with a
structured error:

```json
{
  "code": "PGRST501",
  "message": "operator 'fts' requires full-text search support, which Aurora DSQL does not provide",
  "details": null,
  "hint": "use 'ilike' or a separate search index, or deploy on standard PostgreSQL"
}
```

The error follows the existing `PostgRESTError` shape.
HTTP 501 (Not Implemented) signals that the server
recognizes the request but the backend cannot fulfill it.

Each future feature loop that reads a capability flag
provides its own message and hint text tailored to the
specific operator or feature. This loop adds the error
code and the pattern; it does not add error-throwing
call sites (no features to gate yet, except the FK
refactor which uses a silent fallback, not an error).

### Validation Rules

1. Every flag in the capability object must be present
   on both providers. A missing flag is a bug, not a
   default.

2. Capability objects are frozen (`Object.freeze`).
   Mutation at runtime is not supported — these are
   design-time declarations.

3. When a capability is `false`, the engine must not
   attempt the unsupported operation. No try/catch
   fallbacks. No silent empty results from SQL errors.
   Either skip the operation with a documented fallback
   (like convention-based FK inference) or return
   PGRST501.

4. When a capability is `true`, the engine trusts it
   and runs the operation without defensive wrapping.

### Boot Logging

In non-production mode, `createPgrest` logs the
capability set once at initialization:

```
[pgrest-lambda] db capabilities: {"supportsForeignKeys":true,"supportsFullTextSearch":true,...}
```

One INFO line. No banner. Not logged in production.

## Technical Design

### DatabaseCapabilities Typedef

Add to `src/rest/db/interface.mjs`:

```javascript
/**
 * @typedef {Object} DatabaseCapabilities
 * @property {boolean} supportsForeignKeys
 *   Can the engine trust pg_constraint contype='f'?
 *   Read by: schema-cache.mjs FK introspection.
 *
 * @property {boolean} supportsFullTextSearch
 *   Basic to_tsquery / @@ support.
 *   Read by: fts-operators feature.
 *
 * @property {boolean} supportsRangeTypes
 *   int4range, tsrange, @>/<@/&& on ranges.
 *   Read by: embedded-filtering feature.
 *
 * @property {boolean} supportsArrayContainment
 *   @>, <@, && on plain arrays.
 *   Read by: embedded-filtering feature.
 *
 * @property {boolean} supportsPlannedCount
 *   Is pg_class.reltuples accurate and populated?
 *   Read by: count=planned strategy.
 *
 * @property {boolean} supportsRegex
 *   ~, ~*, !~, !~* operators.
 *   Read by: query-parser regex operators.
 *
 * @property {boolean} supportsRowLevelSecurity
 *   CREATE POLICY, SET ROLE, FORCE RLS.
 *   Documentation only — not used by engine.
 *
 * @property {boolean} supportsRpc
 *   Can we call functions via SELECT fn($1,$2)?
 *   DSQL: true but SQL-language only (no PL/pgSQL).
 *   Read by: rpc-endpoint feature.
 *
 * @property {boolean} supportsGinIndex
 *   GIN indexes available for FTS and array ops.
 *   Read by: FTS and array performance hints.
 */
```

Add `capabilities` to the `DatabaseProvider` typedef:

```javascript
/** @typedef {Object} DatabaseProvider
 * @property {() => Promise<Pool>} getPool
 * @property {(pool: Pool) => void} _setPool
 * @property {() => DatabaseCapabilities} capabilities
 *   Return the frozen capability set for this provider.
 *   Design-time assertions, not runtime probing.
 * @property {((pool: Pool) => Promise<Schema>)?} [introspect]
 */
```

### PostgreSQL Provider Capabilities

Add to `src/rest/db/postgres.mjs`:

```javascript
const POSTGRES_CAPABILITIES = Object.freeze({
  supportsForeignKeys: true,
  supportsFullTextSearch: true,
  supportsRangeTypes: true,
  supportsArrayContainment: true,
  supportsPlannedCount: true,
  supportsRegex: true,
  supportsRowLevelSecurity: true,
  supportsRpc: true,
  supportsGinIndex: true,
});
```

The returned provider gains a `capabilities` method:

```javascript
return {
  getPool, _setPool, close,
  capabilities: () => POSTGRES_CAPABILITIES,
};
```

### DSQL Provider Capabilities

Add to `src/rest/db/dsql.mjs`:

```javascript
// DSQL capability research — verified against
// docs.aws.amazon.com/aurora-dsql/ (2025-05):
//
// supportsForeignKeys: false
//   DSQL deliberately drops FK constraints for
//   distributed consistency. CREATE TABLE syntax
//   does not include FOREIGN KEY / REFERENCES.
//   pg_constraint has no contype='f' rows.
//   Source: CREATE TABLE syntax support page.
//
// supportsFullTextSearch: false
//   tsvector and tsquery are NOT in the supported
//   data types list. to_tsvector, to_tsquery, @@
//   are unavailable. Source: DSQL supported data
//   types page (lists numeric, character, date/time,
//   boolean, bytea, uuid, array, inet, json/jsonb
//   only).
//
// supportsRangeTypes: false
//   Range types (int4range, int8range, numrange,
//   tsrange, tstzrange, daterange) are NOT in the
//   supported data types list.
//   Source: DSQL supported data types page.
//
// supportsArrayContainment: true
//   Array types are listed as supported query
//   runtime types. The @>, <@, && operators on
//   arrays are expected to work (standard array
//   ops, not type-dependent). Conservative: verify
//   against a live cluster if available.
//   Source: DSQL supported data types page.
//
// supportsPlannedCount: false
//   DSQL runs automatic ANALYZE in the background
//   but pg_class.reltuples accuracy for planned
//   count is undocumented. Default to false;
//   revisit when DSQL publishes planner stats docs.
//   Source: DSQL EXPLAIN plans page mentions
//   automatic ANALYZE but not reltuples accuracy.
//
// supportsRegex: true
//   DSQL supports LIKE/ILIKE (confirmed in DSQL
//   EXPLAIN plans documentation which shows LIKE
//   in examples). POSIX regex operators (~, ~*)
//   are not explicitly documented but are standard
//   PostgreSQL operators on text types which DSQL
//   supports. Conservative: mark true, verify ~
//   against a live cluster.
//   Source: DSQL EXPLAIN plans page.
//
// supportsRowLevelSecurity: false
//   CREATE POLICY is not in the supported SQL
//   commands list. SET ROLE and FORCE ROW LEVEL
//   SECURITY are not mentioned. This constraint
//   shaped the auth layer (application-level Cedar
//   policies instead of database RLS).
//   Source: DSQL unsupported features page, DSQL
//   supported SQL features page.
//
// supportsRpc: true
//   DSQL supports calling SQL-language functions
//   via SELECT fn($1, $2). However, PL/pgSQL is
//   NOT supported — "Aurora DSQL supports SQL-based
//   functions but not procedural languages like
//   PL/pgSQL." Functions must use LANGUAGE SQL.
//   Sufficient for the rpc-endpoint feature (most
//   PostgREST RPC calls invoke simple SQL functions).
//   Source: DSQL migration/unsupported features page.
//
// supportsGinIndex: false
//   DSQL uses B-tree indexes only (shown as
//   btree_index in EXPLAIN output). GIN, GiST,
//   HASH, BRIN are not documented as supported.
//   Source: DSQL EXPLAIN plans page, DSQL index
//   documentation.

const DSQL_CAPABILITIES = Object.freeze({
  supportsForeignKeys: false,
  supportsFullTextSearch: false,
  supportsRangeTypes: false,
  supportsArrayContainment: true,
  supportsPlannedCount: false,
  supportsRegex: true,
  supportsRowLevelSecurity: false,
  supportsRpc: true,
  supportsGinIndex: false,
});
```

The returned provider gains a `capabilities` method:

```javascript
return {
  getPool, _setPool, close,
  capabilities: () => DSQL_CAPABILITIES,
};
```

### Context Wiring

In `src/index.mjs`, after creating the db provider:

```javascript
const db = createDb(resolved.database);
const dbCapabilities = db.capabilities();

// ... later ...
ctx.dbCapabilities = dbCapabilities;

if (!resolved.production) {
  console.info(
    '[pgrest-lambda] db capabilities:',
    JSON.stringify(dbCapabilities),
  );
}
```

The schema cache also receives capabilities:

```javascript
const schemaCache = createSchemaCache({
  schemaCacheTtl: resolved.schemaCacheTtl,
  introspect: db.introspect || null,
  capabilities: dbCapabilities,
});
```

### Schema Cache FK Refactor

Replace the try/catch in `pgIntrospect` with a
capability check. The function signature changes to
accept capabilities:

```javascript
async function pgIntrospect(pool, capabilities) {
  const [colResult, pkResult] = await Promise.all([
    pool.query(COLUMNS_SQL),
    pool.query(PK_SQL),
  ]);

  // ... existing table/column/PK parsing ...

  // FK introspection — only query when supported
  let fkRows = [];
  if (!capabilities || capabilities.supportsForeignKeys) {
    const fkResult = await pool.query(FK_SQL);
    fkRows = fkResult.rows;
  }

  let relationships = fkRows.map(row => ({
    constraint: row.constraint_name,
    fromTable: row.from_table,
    fromColumns: row.from_columns,
    toTable: row.to_table,
    toColumns: row.to_columns,
  }));

  if (relationships.length === 0) {
    relationships = inferConventionRelationships(tables);
  }

  return { tables, relationships };
}
```

`createSchemaCache` passes capabilities through:

```javascript
export function createSchemaCache(config) {
  const ttl = config.schemaCacheTtl || 30000;
  const capabilities = config.capabilities || null;
  const introspect = config.introspect
    || ((pool) => pgIntrospect(pool, capabilities));
  // ... rest unchanged
}
```

When `capabilities` is null (backward compatibility,
e.g., direct `createSchemaCache` calls in tests without
a capabilities object), the code falls through to
querying FKs. When `supportsForeignKeys` is `false`,
the FK query is skipped entirely — no SQL sent to the
database, no try/catch.

### PGRST501 Error Code

Add to `src/rest/errors.mjs` as documentation alongside
the existing PGRST200/PGRST201 comments:

```javascript
// PGRST501 — Feature requires unsupported database
//            capability. HTTP 501. Thrown when a REST
//            request uses a feature (FTS, range ops,
//            etc.) that the current database provider
//            does not support. Response includes a
//            message naming the feature and provider,
//            and a hint suggesting alternatives.
```

Future feature loops throw the error like this:

```javascript
throw new PostgRESTError(
  501, 'PGRST501',
  `operator '${op}' requires full-text search `
  + `support, which Aurora DSQL does not provide`,
  null,
  `use 'ilike' or a separate search index, `
  + `or deploy on standard PostgreSQL`,
);
```

No helper function needed — `PostgRESTError` already
handles arbitrary codes. The pattern is documented so
each feature loop writes its own message and hint.

### How Future Features Use Capabilities

A feature loop (e.g., fts-operators) adds a check in
the handler or sql-builder before attempting the
feature:

```javascript
// In handler.mjs or sql-builder.mjs, when building
// a query that uses FTS operators:
if (!ctx.dbCapabilities.supportsFullTextSearch) {
  throw new PostgRESTError(
    501, 'PGRST501',
    `operator 'fts' requires full-text search `
    + `support, which Aurora DSQL does not provide`,
    null,
    `use 'ilike' or a separate search index, `
    + `or deploy on standard PostgreSQL`,
  );
}
```

The handler already has `ctx`. The sql-builder receives
what it needs from the handler's call arguments. No new
dependency injection is required for the handler path.

If a future feature needs capabilities in the
sql-builder, the handler passes
`ctx.dbCapabilities` as an argument. The capabilities
object is plain data (frozen object of booleans), so
passing it is cheap and does not couple the sql-builder
to the ctx shape.

## Code Architecture / File Changes

| File | Action | Lines | Description |
|------|--------|-------|-------------|
| `src/rest/db/interface.mjs` | Modify | ~40 added | `DatabaseCapabilities` typedef, `capabilities` on `DatabaseProvider` |
| `src/rest/db/postgres.mjs` | Modify | ~15 added | Frozen `POSTGRES_CAPABILITIES` object, `capabilities` method |
| `src/rest/db/dsql.mjs` | Modify | ~45 added | Frozen `DSQL_CAPABILITIES` with inline research notes, `capabilities` method |
| `src/rest/db/index.mjs` | No change | 0 | Provider already returns capabilities as part of its interface |
| `src/index.mjs` | Modify | ~10 added | `ctx.dbCapabilities`, pass capabilities to schema cache, boot logging |
| `src/rest/schema-cache.mjs` | Modify | ~5 changed | Replace FK try/catch with `supportsForeignKeys` check, accept capabilities in config |
| `src/rest/errors.mjs` | Modify | ~5 added | Document PGRST501 error code |

**Files that do NOT change:**
- `src/rest/handler.mjs` — no features gated yet
- `src/rest/query-parser.mjs` — no features gated yet
- `src/rest/sql-builder.mjs` — no features gated yet
- `src/rest/router.mjs` — no new routes
- `src/rest/openapi.mjs` — no spec changes
- `src/rest/response.mjs` — response formatting unchanged
- `src/auth/**` — no auth changes
- `src/rest/db/index.mjs` — provider selection unchanged

**No new files. No new npm dependencies.**

## Testing Strategy

### Unit Tests: Provider Capability Snapshots

Test file: `tests/unit/db-capabilities.test.mjs`

**PostgreSQL capabilities snapshot:**
- Import `createPostgresProvider`, create a provider
  with minimal config, call `capabilities()`.
- Assert the returned object matches the exact expected
  shape: every flag present with the correct boolean
  value.
- Assert the object is frozen (`Object.isFrozen`).

**DSQL capabilities snapshot:**
- Import `createDsqlProvider`, create a provider with
  minimal config (mock the DsqlSigner import), call
  `capabilities()`.
- Assert the returned object matches the exact expected
  shape.
- Assert the object is frozen.

**Shape consistency:**
- Assert that both providers return objects with
  identical keys. No flag present on one but missing
  on the other.

These tests are snapshot-style: changing a capability
value requires a deliberate test update. This prevents
accidental changes.

### Unit Tests: Schema Cache FK Refactor

Test file: `tests/unit/schema-cache-capabilities.test.mjs`

**supportsForeignKeys = true:**
- Create a schema cache with
  `capabilities: { supportsForeignKeys: true }`.
- Mock pool.query to return FK rows.
- Call `getSchema(pool)`.
- Assert FK_SQL was executed.
- Assert relationships contain the FK data.

**supportsForeignKeys = false:**
- Create a schema cache with
  `capabilities: { supportsForeignKeys: false }`.
- Mock pool.query.
- Call `getSchema(pool)`.
- Assert FK_SQL was NOT executed (pool.query called
  only for COLUMNS_SQL and PK_SQL).
- Assert relationships are populated via convention
  fallback (given appropriate table/column names).

**No capabilities (backward compat):**
- Create a schema cache with no `capabilities` config.
- Mock pool.query to return FK rows.
- Call `getSchema(pool)`.
- Assert FK_SQL was executed (null capabilities falls
  through to querying).

### Unit Tests: PGRST501 Error Shape

Test file: `tests/unit/pgrst501-error.test.mjs`

- Construct a `PostgRESTError` with status 501, code
  `PGRST501`, a message, and a hint.
- Assert `toJSON()` returns the expected shape.
- Assert `statusCode` is 501.
- Pass through the `error()` response formatter.
- Assert the HTTP response has status 501 and the body
  matches the expected JSON.

### Integration Tests: Context Wiring

Test file: `tests/integration/db-capabilities.test.mjs`

**PostgreSQL provider via createPgrest:**
- Boot with the bundled PostgreSQL (standard test
  harness).
- Access `pgrest._db.capabilities()`.
- Assert `supportsForeignKeys === true`.
- Assert `supportsFullTextSearch === true`.
- Assert all flags match expected PostgreSQL values.

**DSQL-shaped provider:**
- Create a pgrest instance with
  `config.database.dsqlEndpoint` set (or
  `config.database.provider = 'dsql'`).
- Mock the DsqlSigner import to avoid real AWS calls.
- Access `pgrest._db.capabilities()`.
- Assert `supportsForeignKeys === false`.
- Assert all flags match expected DSQL values.

**ctx.dbCapabilities availability:**
- Boot with bundled PostgreSQL.
- Verify the context object passed to the REST handler
  includes `dbCapabilities`. (This may require
  inspecting the schema cache config or adding a test
  hook.)

**Boot logging (non-production):**
- Boot with `production: false`.
- Capture console.info output.
- Assert a line containing `db capabilities:` was
  logged.
- Assert the logged JSON parses to a valid capabilities
  object.

**No logging in production:**
- Boot with `production: true`.
- Capture console.info output.
- Assert no `db capabilities:` line was logged.

### Integration Tests: Schema Cache Without Try/Catch

Extend existing schema cache integration tests:

- Boot with bundled PostgreSQL (has real FKs).
- Introspect schema.
- Assert relationships are populated from FK query
  (not convention fallback).

- Boot with DSQL stub provider.
- Introspect schema with tables that have `_id` columns.
- Assert FK query was skipped.
- Assert relationships are populated from convention
  fallback.

## Implementation Order

### Phase 1: Interface and Provider Objects

1. Add `DatabaseCapabilities` typedef and `capabilities`
   method to `src/rest/db/interface.mjs`.
2. Add `POSTGRES_CAPABILITIES` frozen object and
   `capabilities` method to `src/rest/db/postgres.mjs`.
3. Add `DSQL_CAPABILITIES` frozen object with inline
   research notes and `capabilities` method to
   `src/rest/db/dsql.mjs`.
4. Unit tests: snapshot tests for both providers.

### Phase 2: Context Wiring

5. Add `ctx.dbCapabilities = db.capabilities()` to
   `src/index.mjs`.
6. Add boot logging in non-production mode.
7. Pass capabilities to `createSchemaCache` config.
8. Integration tests: context wiring and boot logging.

### Phase 3: Schema Cache Refactor

9. Modify `createSchemaCache` to accept `capabilities`
   in config and pass to `pgIntrospect`.
10. Replace FK try/catch in `pgIntrospect` with
    `supportsForeignKeys` check.
11. Unit tests: schema cache with capabilities true,
    false, and null.
12. Integration tests: FK query skipped on DSQL stub.

### Phase 4: Error Pattern

13. Add PGRST501 documentation to `src/rest/errors.mjs`.
14. Unit tests: PGRST501 error shape via
    `PostgRESTError` and response formatter.

## Open Questions

1. **DSQL FTS timeline.** The tsvector/tsquery types are
   absent from DSQL's supported data types list as of
   2025-05. If DSQL adds FTS in a future release, flip
   the flag. If partial support lands (e.g., only the
   `english` configuration), we may need a richer flag
   shape. Defer until DSQL publishes FTS types.

2. **DSQL array operator verification.** Array types are
   listed as supported runtime types, and @>, <@, &&
   are standard array operators, so
   `supportsArrayContainment: true` is the expected
   value. Verify against a live DSQL cluster to confirm
   these operators work as expected on arrays.

3. **Third-party providers.** If someone adds a MySQL
   or DynamoDB provider, they must implement
   `capabilities()`. The interface typedef documents
   this requirement. No runtime enforcement exists
   beyond TypeScript/JSDoc checks. Adding a runtime
   assertion in `createDb` (or in `createPgrest`) is
   possible but deferred — the current provider count
   is two, both maintained in-tree.

4. **Partial capability values.** Some capabilities
   might be partially supported (e.g., FTS with only
   certain language configurations). The current design
   uses boolean flags. If partial support becomes
   common, we could extend the type to
   `boolean | 'partial'` with companion detail objects.
   Defer until a concrete case arises.

5. **DSQL PL/pgSQL and RPC.** DSQL supports
   `SELECT fn($1, $2)` but only for SQL-language
   functions. PL/pgSQL is explicitly unsupported. The
   `supportsRpc` flag is `true` because the RPC
   endpoint calls functions via SELECT regardless of
   language. However, users who deploy PL/pgSQL
   functions on standard PostgreSQL and then move to
   DSQL will find those functions missing. The
   rpc-endpoint feature loop should document this
   limitation. Whether to add a separate
   `supportsPlpgsql` flag depends on whether the RPC
   endpoint needs to distinguish SQL from PL/pgSQL
   functions. Defer to the rpc-endpoint design.
