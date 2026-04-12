# Cedar-Based Authorization

## Overview

Replace the implicit `user_id` column filtering in
`sql-builder.mjs` with Cedar policy-as-code authorization.
Cedar policies translate into SQL WHERE clauses before query
execution via partial evaluation, keeping all row filtering
inside PostgreSQL. This gives developers explicit, writable
authorization rules while maintaining DSQL compatibility
(no RLS, no SET ROLE).

One new npm dependency: `@cedar-policy/cedar-wasm` (v4.9.1).
One new module: `src/rest/cedar.mjs` (~250 lines). Changes
to `handler.mjs` and `sql-builder.mjs` to wire Cedar into
the request pipeline.

## Current CX / Concepts

### Implicit user_id Filtering

`sql-builder.mjs` contains `appendUserId()` (line 80) which
silently adds `WHERE "user_id" = $N` to SELECT, UPDATE, and
DELETE queries when a table has a `user_id` column. For
INSERT, it forces `user_id` to the authenticated user's ID,
overriding the request body (line 138-166).

The `role` parameter is threaded through `buildSelect`,
`buildUpdate`, `buildDelete`, and `buildCount` — only to
skip the `user_id` filter for `service_role`.

Problems with this approach:

1. **Implicit and binary.** Authorization is either "own
   rows" or "all rows" based on column naming convention.
   No middle ground (team-scoped, admin, public tables).
2. **Not configurable.** Developers cannot write custom
   authorization rules without modifying engine source.
3. **Magic column name.** A table named `user_id_lookup`
   with a `user_id` column gets filtered whether the
   developer intended it or not.
4. **No deny rules.** No way to express "nobody can delete
   archived items" or "anon users see only published posts."
5. **Anon users get nothing.** Tables without `user_id`
   are fully open to all authenticated users, but anon
   gets no explicit policy — the absence of `userId` means
   no filter is appended, silently granting full access.

### Current Authorization Flow

```
JWT → Authorizer → { role, userId, email }
    │
    ├─ handler.mjs extracts role and userId
    ├─ Passes them to buildSelect/buildUpdate/buildDelete
    ├─ appendUserId() checks: service_role? skip. Otherwise,
    │  hasColumn(schema, table, 'user_id')? append filter.
    └─ Query executes with or without user_id filter
```

### What Changes

- `appendUserId()` removed from `sql-builder.mjs`
- `userId` and `role` parameters removed from
  `buildSelect`, `buildUpdate`, `buildDelete`, `buildCount`
- `buildInsert` no longer force-injects `user_id`
- All role-based and row-level access decisions move to
  Cedar policies

## Proposed CX / CX Specification

### Developer Experience

Developers write `.cedar` policy files in a `policies/`
directory at the project root. Default policies ship with
pgrest-lambda and replicate the current `user_id` behavior,
so upgrading is non-breaking.

```
pgrest-lambda/
├── policies/
│   ├── default.cedar      # Ships with pgrest-lambda
│   └── custom.cedar       # Developer-written (optional)
├── src/
│   └── rest/
│       └── cedar.mjs      # New: Cedar authorization module
```

### Default Policies

These policies ship with pgrest-lambda and reproduce the
current `appendUserId()` behavior:

```cedar
// Authenticated users can read/update/delete their own rows
permit(
    principal is PgrestLambda::User,
    action in [
        PgrestLambda::Action::"select",
        PgrestLambda::Action::"update",
        PgrestLambda::Action::"delete"
    ],
    resource is PgrestLambda::Row
) when {
    resource has user_id && resource.user_id == principal
};

// Authenticated users can insert into any table
permit(
    principal is PgrestLambda::User,
    action == PgrestLambda::Action::"insert",
    resource is PgrestLambda::Table
);

// Service role bypasses all authorization
permit(
    principal is PgrestLambda::ServiceRole,
    action,
    resource
);
```

Note: `resource.user_id == principal` compares the column
value to the principal entity UID, which is
`PgrestLambda::User::"<userId>"`. The residual-to-SQL
translator extracts the entity ID string from the UID.

### Custom Policies Developers Can Write

```cedar
// Admin users see all rows in any table
permit(
    principal is PgrestLambda::User,
    action == PgrestLambda::Action::"select",
    resource
) when {
    principal.role == "admin"
};

// Public tables readable by anyone (including anon)
permit(
    principal,
    action == PgrestLambda::Action::"select",
    resource is PgrestLambda::Row
) when {
    context.table == "public_posts"
};

// Team-scoped data access
permit(
    principal is PgrestLambda::User,
    action in [
        PgrestLambda::Action::"select",
        PgrestLambda::Action::"update"
    ],
    resource is PgrestLambda::Row
) when {
    resource has team_id &&
    resource.team_id == principal.team_id
};

// Forbid: nobody can delete archived items
forbid(
    principal,
    action == PgrestLambda::Action::"delete",
    resource is PgrestLambda::Row
) when {
    resource has status && resource.status == "archived"
};
```

### Cedar Entity Model

```cedar
namespace PgrestLambda {
    entity User = {
        "email": String,
        "role": String,
    };
    entity ServiceRole;
    entity AnonRole;
    entity Table;
    entity Row in [Table];

    action "select", "insert", "update", "delete"
        appliesTo {
            principal: [User, ServiceRole, AnonRole],
            resource: [Table, Row],
        };
}
```

Row entity attributes are derived dynamically from
`schema-cache.mjs` introspection. Each table's columns
become the Row entity's Cedar attributes for policy
evaluation. The Cedar schema is auto-generated at policy
load time — developers do not write it.

### HTTP Method to Cedar Action Mapping

| HTTP Method | Cedar Action |
|-------------|--------------|
| GET         | `select`     |
| POST        | `insert`     |
| PATCH       | `update`     |
| DELETE      | `delete`     |

### Authorization Flow (Request Lifecycle)

```
1. JWT → Authorizer → { role, userId, email }

2. handler.mjs constructs Cedar principal:
   - role == 'authenticated'
     → PgrestLambda::User::"<userId>"
       with { email, role: "authenticated" }
   - role == 'service_role'
     → PgrestLambda::ServiceRole::"service"
   - role == 'anon'
     → PgrestLambda::AnonRole::"anon"

3. Map HTTP method to Cedar action

4. Table-level check (INSERT only):
   isAuthorized(principal, Action::"insert",
                Table::"<tableName>")
   DENY → 403

5. Row-level filter (SELECT, UPDATE, DELETE):
   isAuthorizedPartial(
     principal, action, resource: unknown)
   with context: { table: "<tableName>" }

   Result:
   a. Concrete Allow, no residuals → no WHERE filter
   b. Concrete Deny → 403
   c. Residuals → translate to SQL WHERE clauses

6. Append Cedar-derived WHERE to the SQL query
   alongside user-provided PostgREST filters

7. Execute query — database returns only
   authorized rows
```

### INSERT Authorization

INSERT is a table-level operation — there is no existing
row to filter. Cedar evaluates
`isAuthorized(principal, Action::"insert", Table::"tableName")`
as a concrete allow/deny. If allowed, the INSERT proceeds
with no additional conditions.

The current `user_id` force-injection on INSERT is removed.
If a developer wants inserts to include the user's ID, they
should set `user_id` in the request body. The default Cedar
policy permits authenticated users to insert into any table,
matching the current behavior minus the magic injection.

To replicate the old auto-injection behavior, developers can
add database-level DEFAULT values or triggers on `user_id`
columns.

### Error Responses

| Scenario | HTTP | Code | Message |
|---|---|---|---|
| Table-level deny | 403 | PGRST403 | Not authorized to {action} on '{table}' |
| Row-level deny (all residuals deny) | 403 | PGRST403 | Not authorized to {action} on '{table}' |
| Policy load failure | 500 | PGRST000 | Failed to load authorization policies |
| Residual translation failure | 500 | PGRST000 | Authorization policy produced untranslatable condition |

Error code `PGRST403` is new. It follows the PostgREST
error code convention (PGRST prefix + number).

### Policy Storage and Loading

| Environment | Source | Configuration |
|---|---|---|
| Local dev | Filesystem | `POLICIES_PATH` env var (default: `./policies`) |
| Lambda | S3 | `POLICIES_BUCKET` + `POLICIES_PREFIX` env vars |

Policy loading behavior:

- On cold start: load policies from configured source
- Cache in module scope with 5-minute TTL (matches schema
  cache TTL)
- `POST /rest/v1/_refresh` also reloads policies
- If no policy files are found, deny all requests by
  default (fail closed)
- If policy files have syntax errors, log the error and
  deny all requests (fail closed)

### Policy Refresh

`POST /rest/v1/_refresh` currently reloads the schema
cache. With Cedar, it also reloads policies:

```
POST /rest/v1/_refresh

Response (200):
{
  ... OpenAPI spec (existing behavior) ...
}
```

No new endpoint is needed. The refresh endpoint gains the
side effect of reloading Cedar policies.

## Technical Design

### Module: `src/rest/cedar.mjs`

New module (~250 lines). Handles all Cedar operations:
policy loading, authorization checks, partial evaluation,
and residual-to-SQL translation.

#### Imports

```javascript
import {
  isAuthorized,
  isAuthorizedPartial,
} from '@cedar-policy/cedar-wasm/nodejs';
```

The `/nodejs` subpath is required for Lambda/Node.js — it
loads the WASM binary from the filesystem synchronously.
The bare `@cedar-policy/cedar-wasm` is intended for
bundlers/browsers and will not work in Lambda.

The API is purely free functions — there are no classes
like `Authorizer` or `CedarPolicySet`. Policies and
entities are passed as plain objects to each function call.

#### Exports

```javascript
// Load .cedar files into a PolicySet object.
// Sources: filesystem (POLICIES_PATH) or S3
// (POLICIES_BUCKET + POLICIES_PREFIX).
// Caches the PolicySet in module scope.
export async function loadPolicies()

// Table-level authorization check.
// Returns true (allow) or throws PGRST403.
// Used for INSERT operations.
export function authorize({
  principal, action, resource, schema
})

// Row-level partial evaluation → SQL conditions.
// Returns { conditions: string[], values: any[] }
// where conditions are SQL fragments like
// '"user_id" = $3' and values are the corresponding
// parameter values.
// Returns { conditions: [], values: [] } for
// unconditional access.
// Throws PGRST403 for concrete deny.
export function buildAuthzFilter({
  principal, action, context, schema
})

// Force reload policies (called from _refresh).
export async function refreshPolicies()

// Test injection hook: replace compiled policies.
export function _setPolicies(policies)
```

#### Principal Construction

The cedar-wasm API accepts entity UIDs as plain objects
with `type` and `id` fields:

```javascript
function buildPrincipalUid(role, userId) {
  if (role === 'service_role') {
    return {
      type: 'PgrestLambda::ServiceRole',
      id: 'service',
    };
  }
  if (role === 'anon') {
    return {
      type: 'PgrestLambda::AnonRole',
      id: 'anon',
    };
  }
  return {
    type: 'PgrestLambda::User',
    id: userId,
  };
}
```

The principal entity (with attributes) is placed in the
entity store separately — the UID is just a reference.

The principal entity UID is constructed from the JWT claims
already available in `handler.mjs` via
`event.requestContext.authorizer`.

#### Entity Store Construction

The entity store is an array of entity objects passed to
`isAuthorized()` and `isAuthorizedPartial()`. Each entity
has `uid`, `attrs`, and `parents` fields.

For partial evaluation, the entity store contains:

1. The principal entity (User, ServiceRole, or AnonRole)
   with its attributes (email, role)
2. Table entities for all tables in the schema cache
3. No Row entities — the resource is left unknown (null)

```javascript
function buildEntities(principalUid, role, email,
                       schema) {
  const entities = [];

  // Principal entity with attributes
  if (principalUid.type === 'PgrestLambda::User') {
    entities.push({
      uid: principalUid,
      attrs: { email, role },
      parents: [],
    });
  } else {
    entities.push({
      uid: principalUid,
      attrs: {},
      parents: [],
    });
  }

  // Table entities (no attributes needed)
  for (const tableName of Object.keys(schema.tables)) {
    entities.push({
      uid: {
        type: 'PgrestLambda::Table',
        id: tableName,
      },
      attrs: {},
      parents: [],
    });
  }

  return entities;
}
```

#### Action Mapping

```javascript
const METHOD_TO_ACTION = {
  GET: 'select',
  POST: 'insert',
  PATCH: 'update',
  DELETE: 'delete',
};

function buildAction(method) {
  const action = METHOD_TO_ACTION[method];
  if (!action) {
    throw new PostgRESTError(
      405, 'PGRST000',
      `Method ${method} not allowed`,
    );
  }
  return {
    type: 'PgrestLambda::Action',
    id: action,
  };
}
```

#### PolicySet Format

The cedar-wasm API accepts policies as a plain object.
Cedar policy text (from .cedar files) is passed as a
string:

```javascript
// Module-scoped cache
let cachedPolicies = null;
let policiesLoadedAt = 0;
const POLICIES_TTL = 300000; // 5 minutes

async function compilePolicies() {
  const policyText = await loadPolicyText();
  // PolicySet is a plain object, not a class
  return { staticPolicies: policyText };
}
```

Policy IDs are auto-assigned (policy0, policy1, ...) when
passed as a single string. The residual response references
these IDs.

#### Calling isAuthorized and isAuthorizedPartial

Both functions accept a single call object and return a
response object:

```javascript
// Table-level check (concrete)
const result = isAuthorized({
  principal: principalUid,
  action: { type: 'PgrestLambda::Action', id: 'insert' },
  resource: { type: 'PgrestLambda::Table', id: tableName },
  context: {},
  policies: cachedPolicies,
  entities: entityStore,
});
// result.type === 'success' (or 'failure' on error)
// result.response.decision === 'allow' | 'deny'
// result.response.diagnostics.reason === string[]

// Row-level partial evaluation
const partial = isAuthorizedPartial({
  principal: principalUid,
  action: { type: 'PgrestLambda::Action', id: 'select' },
  resource: null,  // null = unknown (triggers residuals)
  context: { table: tableName },
  policies: cachedPolicies,
  entities: entityStore,
});
// partial.type === 'residuals'
// partial.response.decision === 'allow' | 'deny' | null
// partial.response.residuals === Record<string, PolicyJson>
// partial.response.nontrivialResiduals === string[]
```

#### Partial Evaluation Response Handling

`buildAuthzFilter()` calls `isAuthorizedPartial()` with
the resource set to `null` (unknown). Cedar evaluates
known conditions (principal attributes, context) and
returns a response with `type: "residuals"`.

The response always has `type: "residuals"`, even when
Cedar reaches a concrete decision. The three outcomes
are distinguished by `response.decision` and
`response.nontrivialResiduals`:

1. **Concrete Allow** (`decision === 'allow'` and
   `nontrivialResiduals.length === 0`): The principal
   has unconditional access. Return empty conditions.

2. **Concrete Deny** (`decision === 'deny'`): The
   principal is denied. Throw PGRST403.

3. **Residuals exist** (`decision === null` and
   `nontrivialResiduals.length > 0`): Walk the residual
   ASTs and translate resource-attribute conditions into
   parameterized SQL.

#### Residual Structure

Each residual in `response.residuals` is a PolicyJson
object containing an `effect` ("permit" or "forbid") and
`conditions` (the partially-evaluated `when` clause as an
Expr AST). The translator extracts the condition Expr from
each nontrivial residual and walks it to produce SQL.

#### Residual-to-SQL Translation

The residual `Expr` AST is a tagged JSON union (per the
Cedar JSON policy format specification). The translator
recursively walks the AST and produces SQL fragments.

```javascript
function translateExpr(expr, values, tableName, schema) {
  // Returns a SQL condition string.
  // Pushes parameter values into the values array.
  // Throws if an untranslatable expression is encountered.
}
```

**Expression mapping:**

| Cedar Expr Key | Cedar Meaning | SQL Output |
|---|---|---|
| `{ "==": { left, right } }` | Equality | `"col" = $N` |
| `{ "!=": { left, right } }` | Inequality | `"col" != $N` |
| `{ ">": { left, right } }` | Greater than | `"col" > $N` |
| `{ ">=": { left, right } }` | Greater or equal | `"col" >= $N` |
| `{ "<": { left, right } }` | Less than | `"col" < $N` |
| `{ "<=": { left, right } }` | Less or equal | `"col" <= $N` |
| `{ "&&": { left, right } }` | Logical AND | `(left AND right)` |
| `{ "\|\|": { left, right } }` | Logical OR | `(left OR right)` |
| `{ "!": { arg } }` | Logical NOT | `NOT (arg)` |
| `{ "has": { left, attr } }` | Has attribute | `"attr" IS NOT NULL` (attr is string or list) |
| `{ ".": { left, attr } }` | Attribute access | Resolve to column name |
| `{ "Value": true }` | Boolean true | Collapse (skip in AND chains) |
| `{ "Value": false }` | Boolean false | `FALSE` |
| `{ "Value": { "__entity": { type, id } } }` | Entity UID | Extract `id` as param value |
| `{ "Value": <string> }` | String literal | Parameter value |
| `{ "Value": <number> }` | Long literal | Parameter value |
| `{ "Var": "resource" }` | Resource var | Used for attribute access resolution |
| `{ "unknown": [{ "Value": "resource" }] }` | CPE unknown marker | Treated same as `Var: resource` |
| `{ "is": { left, entity_type } }` | Type check | Resolve to true/false based on entity type |
| `{ "if-then-else": { if, then, else } }` | Conditional | `CASE WHEN ... THEN ... ELSE ... END` |

**Handling attribute access:** When the translator
encounters `{ ".": { left: { "Var": "resource" }, attr: "user_id" } }`,
it resolves `attr` as a column name. The column is
validated against `schema-cache.mjs` to prevent injection.

**Handling CPE noise:** Cedar's Classic Partial Evaluation
produces `true && true && actual_condition` wrappers
because it cannot prove type safety without a schema. The
translator handles this by collapsing:
- `true AND X` → `X`
- `X AND true` → `X`
- `true OR X` → `true` (unconditional allow)

**Handling entity UID values:** When a comparison like
`resource.user_id == PgrestLambda::User::"alice"` appears,
the right side is a Cedar entity UID. The translator
extracts the `id` field (`"alice"`) as the SQL parameter
value.

**Combining multiple residuals:**

- Multiple `permit` residuals: combined with `OR` (any
  matching permit grants access)
- `forbid` residuals: each produces a `NOT (condition)`
  clause combined with `AND` alongside permit conditions

Final SQL structure:
```sql
WHERE (permit1_condition OR permit2_condition)
  AND NOT (forbid1_condition)
  AND NOT (forbid2_condition)
```

**Handling `is` type checks:** Cedar residuals may contain
`{ "is": { left, entity_type, in } }` for type checks
like `resource is PgrestLambda::Row`. Since all resources
in the REST API are rows (for row-level policies), the
translator resolves `is Row` to `true` and collapses it.
If the type check is for a different entity type, it
resolves to `false`.

**Handling `unknown` markers:** Cedar CPE represents
unknown values using an extension function:
`{ "unknown": [{ "Value": "resource" }] }`. The
translator treats this identically to
`{ "Var": "resource" }` — both indicate the unknown
resource for attribute access resolution.

**Handling `if-then-else`:** Cedar may produce
`{ "if-then-else": { if, then, else } }` in residuals.
The translator maps this to SQL `CASE WHEN`:
`CASE WHEN (if) THEN (then) ELSE (else) END`. However,
if the `if` condition involves only known values (already
resolved by CPE), the translator should simplify by
selecting the appropriate branch.

**Untranslatable expressions:** If the translator
encounters a Cedar expression it cannot map to SQL, it
throws `PGRST000` with message "Authorization policy
produced untranslatable condition". This fails the request
rather than silently dropping a security constraint.

Untranslatable expressions include:
- `in` — hierarchy membership (requires entity store)
- `like` — Cedar pattern matching (different syntax from
  SQL LIKE; pattern is array of Literal/Wildcard)
- `contains`, `containsAll`, `containsAny` — set
  operations
- Extension functions (e.g., `ip()`, `decimal()`)
- `isEmpty`, `hasTag`, `getTag`

**Supported expression subset:** The translator handles
the subset of Cedar expressions that map to SQL WHERE
clauses: comparisons (`==`, `!=`, `<`, `<=`, `>`, `>=`),
boolean logic (`&&`, `||`, `!`), attribute access (`.`),
has-checks (`has`), type checks (`is`), literal values,
entity UID values, and `if-then-else`. This covers the
vast majority of practical authorization policies.
Expressions requiring Cedar entity hierarchies (the `in`
keyword) are not translatable and require the developer
to restructure the policy using attribute comparisons.

#### SQL Parameter Numbering

The Cedar-derived conditions use parameter placeholders
that continue from the last parameter used by
user-provided PostgREST filters. The `buildAuthzFilter`
function accepts a `startParam` number:

```javascript
export function buildAuthzFilter({
  principal, action, context, schema, startParam
})
// Returns { conditions: ['...'], values: [...] }
// Parameter placeholders start at $startParam
```

This ensures no conflicts with PostgREST filter parameters.

### Changes to `src/rest/handler.mjs`

The handler calls Cedar authorization after routing and
before SQL building:

```javascript
import {
  authorize, buildAuthzFilter, loadPolicies,
  refreshPolicies,
} from './cedar.mjs';

// In handler(), after route resolution:

// Ensure policies are loaded
await loadPolicies();

const role = authorizer.role || 'anon';
const userId = authorizer.userId || '';
const email = authorizer.email || '';

// Construct Cedar principal info
const principal = { role, userId, email };
const action = method;  // GET, POST, PATCH, DELETE
const tableName = table;

// In _refresh handler, add:
await refreshPolicies();

// In each method case:
switch (method) {
  case 'GET': {
    const parsed = parseQuery(params, method);
    const q = buildSelect(table, parsed, schema);
    // buildSelect no longer takes userId/role
    // Cedar conditions appended separately
    // ...
  }
}
```

The handler constructs Cedar inputs from the authorizer
context and passes them alongside the SQL query building.

#### Method-Specific Authorization

**GET (SELECT):**
1. Call `buildAuthzFilter()` to get row-level conditions
2. Pass conditions to `buildSelect()` as extra WHERE
   clauses
3. For `Prefer: count=exact`, pass same conditions to
   `buildCount()`

**POST (INSERT):**
1. Call `authorize()` for table-level check (allow/deny)
2. If allowed, call `buildInsert()` with no authorization
   conditions
3. No `user_id` force-injection

**PATCH (UPDATE):**
1. Call `buildAuthzFilter()` for row-level conditions
2. Pass conditions to `buildUpdate()` as extra WHERE
   clauses

**DELETE:**
1. Call `buildAuthzFilter()` for row-level conditions
2. Pass conditions to `buildDelete()` as extra WHERE
   clauses

### Changes to `src/rest/sql-builder.mjs`

#### Removed

- `appendUserId()` function (lines 80-86) — deleted
- `userId` parameter from `buildSelect`, `buildUpdate`,
  `buildDelete`, `buildCount`
- `role` parameter from `buildSelect`, `buildUpdate`,
  `buildDelete`, `buildCount`
- `userId` parameter from `buildInsert`
- All `user_id` column convention logic in `buildInsert`
  (lines 145-146, 152-153, 159-160)

#### Added

All query-building functions accept an optional
`authzConditions` parameter:

```javascript
export function buildSelect(
  table, parsed, schema, authzConditions
)
export function buildUpdate(
  table, body, parsed, schema, authzConditions
)
export function buildDelete(
  table, parsed, schema, authzConditions
)
export function buildCount(
  table, parsed, schema, authzConditions
)
export function buildInsert(table, body, schema, parsed)
```

The `authzConditions` object has the shape:
```javascript
{
  conditions: ['("user_id" = $3)', '...'],
  values: ['alice', ...],
}
```

The SQL builder appends these conditions to the WHERE
clause after user-provided filter conditions, and appends
the values to the parameter array:

```javascript
// After buildFilterConditions():
if (authzConditions?.conditions?.length > 0) {
  // Renumber placeholders from current values.length
  for (const cond of authzConditions.conditions) {
    conditions.push(cond);
  }
  values.push(...authzConditions.values);
}
```

Note: `buildAuthzFilter` returns conditions with
placeholder numbers starting from `startParam`. The
handler passes `values.length + 1` as `startParam` to
ensure correct numbering. The SQL builder does not
renumber — it trusts that the placeholders are already
correct.

### Changes to `src/rest/schema-cache.mjs`

No changes to the module itself. The existing
`schema.tables[tableName].columns` structure provides
the column metadata Cedar needs for:

1. Validating column names referenced in residual
   expressions
2. Auto-generating the Cedar schema (column names and
   types)

#### Cedar Schema Generation

`cedar.mjs` auto-generates a Cedar schema from the
schema cache at policy load time:

```javascript
function generateCedarSchema(dbSchema) {
  const attrs = {};
  for (const [tableName, tableDef]
       of Object.entries(dbSchema.tables)) {
    for (const [colName, col]
         of Object.entries(tableDef.columns)) {
      attrs[colName] = pgTypeToCedarType(col.type);
    }
  }
  // Build PgrestLambda::Row entity with union of
  // all column attributes across all tables
  return { /* Cedar schema JSON */ };
}
```

PostgreSQL-to-Cedar type mapping:

| PG Type | Cedar Type |
|---|---|
| text, varchar, char, uuid | String |
| integer, smallint, bigint | Long |
| boolean | Boolean |
| All others | String (safe default) |

The schema is regenerated on each policy reload and
schema refresh.

### Changes to Refresh Endpoint

In `handler.mjs`, the `_refresh` route handler calls
`refreshPolicies()` after refreshing the schema cache:

```javascript
if (routeInfo.type === 'refresh') {
  if (method !== 'POST') {
    throw new PostgRESTError(
      405, 'PGRST000',
      'Method not allowed on _refresh',
    );
  }
  const newSchema = await refresh(pool);
  await refreshPolicies();
  const apiUrl = `https://${headers['host']}/rest/v1`;
  return success(200, generateSpec(newSchema, apiUrl));
}
```

### Policy Storage: S3 Loading

For Lambda deployment, policies are stored in S3 and
loaded on cold start:

```javascript
import { S3Client, ListObjectsV2Command,
         GetObjectCommand } from '@aws-sdk/client-s3';

async function loadFromS3(bucket, prefix) {
  const s3 = new S3Client({
    region: process.env.REGION_NAME,
  });
  const list = await s3.send(new ListObjectsV2Command({
    Bucket: bucket,
    Prefix: prefix,
  }));
  const policyTexts = [];
  for (const obj of list.Contents || []) {
    if (!obj.Key.endsWith('.cedar')) continue;
    const resp = await s3.send(new GetObjectCommand({
      Bucket: bucket, Key: obj.Key,
    }));
    policyTexts.push(
      await resp.Body.transformToString()
    );
  }
  return policyTexts.join('\n');
}
```

Note: `@aws-sdk/client-s3` is available in the Lambda
Node.js 20.x runtime. It does not need to be added to
`package.json`.

### Policy Storage: Filesystem Loading

For local development:

```javascript
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

async function loadFromFilesystem(dirPath) {
  const files = await readdir(dirPath);
  const policyTexts = [];
  for (const file of files) {
    if (!file.endsWith('.cedar')) continue;
    const text = await readFile(
      join(dirPath, file), 'utf-8'
    );
    policyTexts.push(text);
  }
  return policyTexts.join('\n');
}
```

## Code Architecture / File Changes

| File | Action | Description |
|---|---|---|
| `src/rest/cedar.mjs` | Create | Cedar authorization module: policy loading, table-level auth, partial eval, residual-to-SQL |
| `src/rest/handler.mjs` | Modify | Call Cedar authorize/buildAuthzFilter, pass authzConditions to SQL builders, call refreshPolicies on _refresh |
| `src/rest/sql-builder.mjs` | Modify | Remove appendUserId, remove userId/role params, accept authzConditions parameter |
| `policies/default.cedar` | Create | Default Cedar policies (replicates current user_id behavior) |
| `package.json` | Modify | Add `@cedar-policy/cedar-wasm` dependency |
| `template.yaml` | Modify | Add `POLICIES_BUCKET`, `POLICIES_PREFIX` env vars to ApiFunction; add S3 read policy |

### template.yaml Changes

Add environment variables to `ApiFunction`:

```yaml
Environment:
  Variables:
    # ... existing vars ...
    POLICIES_BUCKET: !Ref PolicyBucket
    POLICIES_PREFIX: policies/
```

Or, for filesystem-only deployment (no S3):

```yaml
Environment:
  Variables:
    POLICIES_PATH: ./policies
```

Add S3 read policy to `ApiFunction.Policies`:

```yaml
- Version: '2012-10-17'
  Statement:
    - Effect: Allow
      Action:
        - s3:GetObject
        - s3:ListBucket
      Resource:
        - !Sub 'arn:aws:s3:::${PolicyBucket}'
        - !Sub 'arn:aws:s3:::${PolicyBucket}/*'
```

The decision between S3 and filesystem policy storage is
left to the deployment configuration. Both are supported.
For the initial implementation, filesystem loading is
sufficient — S3 support is a follow-up if needed for
production Lambda deployments where bundling `.cedar`
files in the deployment package is impractical.

## Testing Strategy

### Unit Tests: Residual-to-SQL Translation

Pure function tests — no database, no Cedar WASM needed
for most cases. Test the `translateExpr()` function
directly with hand-crafted AST inputs.

**Equality comparison:**
- Input: `{ "==": { left: { ".": { left: { "Var": "resource" }, attr: "user_id" } }, right: { "Value": "alice" } } }`
- Expected SQL: `"user_id" = $1`
- Expected values: `["alice"]`

**Inequality comparison:**
- Input: `{ "!=": { left: { ".": { left: { "Var": "resource" }, attr: "status" } }, right: { "Value": "archived" } } }`
- Expected SQL: `"status" != $1`
- Expected values: `["archived"]`

**Greater-than comparison:**
- Input: `{ ">": { left: { ".": { left: { "Var": "resource" }, attr: "level" } }, right: { "Value": 5 } } }`
- Expected SQL: `"level" > $1`
- Expected values: `[5]`

**AND conjunction:**
- Input: `{ "&&": { left: <eq_expr>, right: <gt_expr> } }`
- Expected SQL: `("user_id" = $1 AND "level" > $2)`

**OR disjunction:**
- Input: `{ "||": { left: <eq_expr>, right: <eq_expr2> } }`
- Expected SQL: `("user_id" = $1 OR "status" = $2)`

**NOT negation:**
- Input: `{ "!": { arg: <eq_expr> } }`
- Expected SQL: `NOT ("status" = $1)`

**Has-attribute (IS NOT NULL):**
- Input: `{ "has": { left: { "Var": "resource" }, attr: "user_id" } }`
- Expected SQL: `"user_id" IS NOT NULL`
- Expected values: `[]`

**CPE noise collapse — true AND condition:**
- Input: `{ "&&": { left: { "Value": true }, right: <eq_expr> } }`
- Expected SQL: `"user_id" = $1` (not `TRUE AND "user_id" = $1`)

**CPE noise collapse — nested true chains:**
- Input: `{ "&&": { left: { "Value": true }, right: { "&&": { left: { "Value": true }, right: <eq_expr> } } } }`
- Expected SQL: `"user_id" = $1`

**Entity UID value extraction:**
- Input: `{ "==": { left: { ".": { left: { "Var": "resource" }, attr: "user_id" } }, right: { "Value": { "__entity": { "type": "PgrestLambda::User", "id": "abc-123" } } } } }`
- Expected SQL: `"user_id" = $1`
- Expected values: `["abc-123"]`

**Type check (is Row) — collapse to true:**
- Input: `{ "is": { left: { "Var": "resource" }, entity_type: "PgrestLambda::Row" } }`
- Expected: collapsed to `true` (no SQL emitted)

**Unknown marker treated as resource:**
- Input: `{ ".": { left: { "unknown": [{ "Value": "resource" }] }, attr: "user_id" } }`
- Expected: same behavior as `{ ".": { left: { "Var": "resource" }, attr: "user_id" } }`

**Untranslatable expression — hierarchy membership:**
- Input: `{ "in": { left: ..., right: ... } }`
- Expected: throws PGRST000

**Untranslatable expression — set contains:**
- Input: `{ "contains": { left: ..., right: ... } }`
- Expected: throws PGRST000

**Parameter numbering with startParam:**
- Input: any expression with startParam=5
- Expected: placeholders start at $5

> Warning: Tests that verify SQL output should check both
> the SQL text and the parameter values array. A test that
> only checks the SQL text could pass even if parameter
> values are in the wrong order or missing.

### Unit Tests: Policy Loading

**Load from filesystem:**
- Given: `policies/` dir with `default.cedar`
- When: `loadPolicies()` called
- Then: policies compile without errors

**Load from filesystem — no .cedar files:**
- Given: empty `policies/` dir
- When: `loadPolicies()` called
- Then: all requests denied (fail closed)

**Load from filesystem — syntax error in policy:**
- Given: `policies/bad.cedar` with invalid Cedar syntax
- When: `loadPolicies()` called
- Then: error logged, all requests denied

**Policy caching within TTL:**
- Given: policies loaded
- When: `loadPolicies()` called again within 5 minutes
- Then: returns cached policies (no filesystem read)

**refreshPolicies() bypasses TTL:**
- Given: policies loaded 1 minute ago
- When: `refreshPolicies()` called
- Then: policies reloaded from source

**_setPolicies() test hook:**
- Given: custom policy set
- When: `_setPolicies(ps)` called
- Then: subsequent authorize/buildAuthzFilter use `ps`

### Unit Tests: authorize() (Table-Level)

**Service role allowed on any table:**
- Given: default policies, service_role principal
- When: `authorize()` for select on any table
- Then: returns true

**Authenticated user allowed to insert:**
- Given: default policies, authenticated user
- When: `authorize()` for insert on any table
- Then: returns true

**Anon user denied by default:**
- Given: default policies only, anon principal
- When: `authorize()` for select on any table
- Then: throws PGRST403

**Custom policy allows anon on specific table:**
- Given: default + public_posts policy, anon principal
- When: `authorize()` for select on public_posts
- Then: returns true

### Unit Tests: buildAuthzFilter() (Row-Level)

**Default policy — authenticated user:**
- Given: default policies, user "alice"
- When: `buildAuthzFilter()` for select
- Then: conditions include `"user_id" = $N` with
  value "alice", plus `"user_id" IS NOT NULL`

> Warning: This test's expected output depends on how
> Cedar CPE structures the residual for
> `resource has user_id && resource.user_id == principal`.
> The implementing agent should run the actual Cedar
> partial evaluation and adjust the expected SQL based on
> the actual residual shape, rather than assuming a
> specific AST structure.

**Service role — no conditions:**
- Given: default policies, service_role principal
- When: `buildAuthzFilter()` for select
- Then: conditions are empty (unconditional access)

**Forbid policy — delete archived:**
- Given: default + forbid-archived policy
- When: `buildAuthzFilter()` for delete
- Then: conditions include
  `NOT ("status" = $N)` with value "archived"

**Multiple permit policies — OR combination:**
- Given: owner-access + team-access policies
- When: `buildAuthzFilter()` for select as user
- Then: conditions combined with OR:
  `("user_id" = $N OR "team_id" = $M)`

> Warning: This test assumes Cedar produces separate
> residuals for each permit policy. If Cedar merges
> permit residuals, the SQL structure may differ. The
> implementing agent should verify against actual Cedar
> output.

### Integration Tests: Full Request Pipeline

**Authenticated GET — returns only owned rows:**
- Setup: policies/default.cedar loaded, table "todos"
  with user_id column
- Given: authenticated user "alice"
- When: GET /rest/v1/todos
- Then: SQL includes
  `WHERE "user_id" IS NOT NULL AND "user_id" = $1`
  (behavioral equivalent to old appendUserId)

> Warning: This test verifies backward compatibility with
> the old appendUserId behavior. The exact SQL may differ
> (Cedar adds `IS NOT NULL` for the `has` check). Verify
> that the query returns the same result set, not that the
> SQL is character-identical.

**Service role GET — returns all rows:**
- Given: service_role principal
- When: GET /rest/v1/todos
- Then: no authorization WHERE clause

**Anon GET — denied by default:**
- Given: anon principal, only default policies
- When: GET /rest/v1/todos
- Then: 403 response with PGRST403

**Authenticated INSERT — allowed without user_id
injection:**
- Given: authenticated user
- When: POST /rest/v1/todos with body
  `{"title": "test"}`
- Then: INSERT includes only columns from request body
  (no forced user_id)

**Authenticated DELETE with forbid policy:**
- Setup: default + forbid-delete-archived policy
- Given: authenticated user
- When: DELETE /rest/v1/todos?id=eq.123
- Then: SQL includes
  `AND NOT ("status" = $N)` alongside user filter

**Custom public table policy:**
- Setup: policy granting anon select on "public_posts"
- Given: anon principal
- When: GET /rest/v1/public_posts
- Then: 200 response, no authorization filter

**Table with no matching policy — denied:**
- Setup: default policies only, table "secrets" exists
  (no user_id column)
- Given: authenticated user
- When: GET /rest/v1/secrets
- Then: 403 response (default deny, no policy matches)

> Warning: This test verifies the default-deny behavior
> for tables without a matching policy. It depends on the
> default policies not including a blanket authenticated
> access rule for tables without user_id. Verify the
> default policies match the design.

**Policy refresh reloads Cedar policies:**
- Setup: initial policies loaded
- Given: policy file modified
- When: POST /rest/v1/_refresh
- Then: subsequent requests use updated policies

**PostgREST filters combined with Cedar conditions:**
- Given: authenticated user, table with user_id
- When: GET /rest/v1/todos?status=eq.active
- Then: SQL WHERE includes both
  `"status" = $1` (PostgREST filter) AND
  Cedar conditions with correctly numbered params

> Warning: Parameter numbering is critical. PostgREST
> filters use $1, $2, etc. Cedar conditions must continue
> from the next available number. Verify that $N
> references in Cedar conditions match the actual values
> array positions.

### Integration Tests: Backward Compatibility

**Same result set as old appendUserId:**
- Setup: table "todos" with columns id, user_id, title
- Insert rows for user A and user B
- Given: user A with default Cedar policies
- When: GET /rest/v1/todos
- Then: returns only user A's rows (same as old behavior)

**Service role still sees all:**
- Same setup
- Given: service_role
- When: GET /rest/v1/todos
- Then: returns all rows

**Tables without user_id — behavior change:**
- Setup: table "categories" without user_id column
- Given: authenticated user with default Cedar policies
- When: GET /rest/v1/categories
- Then: 403 (default deny)
- Note: this is a **breaking change** from old behavior
  where tables without user_id were open to all
  authenticated users. Developers must add an explicit
  policy to grant access.

> Warning: The backward-incompatible behavior for tables
> without user_id must be documented in migration notes.
> The implementing agent should verify this is the
> intended design decision and consider whether a
> transitional policy is needed.

## Implementation Order

### Phase 1: Cedar Module Foundation

1. Add `@cedar-policy/cedar-wasm` to `package.json`
2. Create `policies/default.cedar` with default policies
3. Create `src/rest/cedar.mjs` with:
   - Policy loading (filesystem only for Phase 1)
   - `authorize()` for table-level checks
   - `_setPolicies()` test hook
   - Unit tests for policy loading

### Phase 2: Residual-to-SQL Translator

4. Implement `translateExpr()` in `cedar.mjs`:
   - Handle all expression types in the mapping table
   - CPE noise collapsing
   - Entity UID value extraction
   - Parameter numbering
5. Implement `buildAuthzFilter()`:
   - Call `isAuthorizedPartial()`
   - Route concrete allow/deny
   - Combine permit/forbid residuals
6. Unit tests for all expression translations

### Phase 3: Handler and SQL Builder Integration

7. Modify `sql-builder.mjs`:
   - Remove `appendUserId()`
   - Remove `userId`/`role` params from all build functions
   - Add `authzConditions` parameter
8. Modify `handler.mjs`:
   - Call `loadPolicies()` at start
   - Construct Cedar principal from authorizer context
   - Call `authorize()` for INSERT
   - Call `buildAuthzFilter()` for SELECT/UPDATE/DELETE
   - Pass `authzConditions` to SQL build functions
   - Call `refreshPolicies()` in _refresh handler
9. Integration tests for the full pipeline

### Phase 4: S3 Policy Loading (Optional)

10. Add S3 loading to `cedar.mjs`
11. Add `POLICIES_BUCKET`/`POLICIES_PREFIX` env vars to
    `template.yaml`
12. Add S3 read IAM policy to `template.yaml`

## Open Questions

1. **INSERT user_id injection removal.** The current
   behavior silently sets `user_id` on every insert.
   Removing this is a breaking change for applications
   that rely on it. Options: (a) remove it and document
   the migration, (b) keep a Cedar-based equivalent that
   adds `user_id` from the principal to the INSERT
   columns, (c) make it configurable. **Recommendation:**
   Remove it. Developers should explicitly include
   `user_id` in their request body. The Supabase pattern
   is to set `user_id` client-side.

2. **Tables without user_id — default deny vs. default
   allow.** Today, tables without `user_id` are open to
   all authenticated users. With Cedar default-deny,
   these tables become inaccessible unless a policy
   explicitly permits access. This is more secure but
   breaks backward compatibility. **Recommendation:**
   Ship a transitional `permit-authenticated.cedar`
   policy that allows authenticated users to access any
   table, and document it as a policy to remove once
   proper per-table policies are in place.

3. **Cedar WASM bundle size.** `@cedar-policy/cedar-wasm`
   adds WASM binary to the Lambda package (~2-4 MB).
   This may increase cold start time. Measure the impact
   and consider lazy loading if significant.

4. **Entity hierarchy support.** Cedar `in` keyword
   (e.g., `principal in Team::"engineering"`) requires
   entity hierarchies loaded into the entity store. This
   means querying a team membership table per request.
   **Recommendation:** Defer hierarchy support. Use
   attribute comparisons (`resource.team_id ==
   principal.team_id`) instead, which work with partial
   evaluation without entity store queries.

5. **Context-based table scoping.** The design uses
   `context.table` for policies like "anon can read
   public_posts". Cedar partial evaluation may or may
   not resolve context conditions before producing
   residuals (context is known at evaluation time). If
   Cedar resolves `context.table == "public_posts"` to
   `true` or `false` before producing residuals, this
   works as expected. If not, the translator needs to
   handle context expressions. **Recommendation:** Test
   this during implementation. Context values are known
   inputs, so Cedar should resolve them.

6. **Policy testing workflow.** Developers need a way to
   test their Cedar policies locally before deploying.
   A `pgrest-lambda policy-check` CLI command that loads
   policies and runs sample authorization requests would
   be valuable but is out of scope for the initial
   implementation.
