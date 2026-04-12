# Task 03: Cedar Module Foundation — Policy Loading and Table-Level Auth

**Agent:** implementer
**Design:** docs/design/authorization-cedar.md
**Depends on:** Task 02

## Objective

Create `src/rest/cedar.mjs` with policy loading from the
filesystem, principal/entity construction, action mapping,
the `authorize()` function for table-level checks, and the
`_setPolicies()` test hook.

## Target Tests

From `cedar.test.mjs` (Task 01):

- 'maps text/varchar/uuid PG types to Cedar String' (#25)
- 'maps integer/smallint/bigint PG types to Cedar Long' (#26)
- 'maps boolean PG type to Cedar Boolean' (#27)
- 'defaults unknown PG types to Cedar String' (#28)
- 'union of all table columns in Row entity' (#29)
- 'loadPolicies loads .cedar files from filesystem' (#30)
- 'loadPolicies with no .cedar files denies all (fail closed)' (#31)
- 'loadPolicies with syntax error denies all (fail closed)' (#32)
- 'policy caching returns cached within TTL' (#33)
- 'refreshPolicies bypasses TTL cache' (#34)
- '_setPolicies replaces compiled policies' (#35)
- 'service_role allowed on any table and action' (#36)
- 'authenticated user allowed to insert' (#37)
- 'anon user denied by default policies' (#38)
- 'custom policy allows anon select on specific table' (#39)

## Implementation

### Create `src/rest/cedar.mjs`

#### Imports

```javascript
import {
  isAuthorized,
  isAuthorizedPartial,
} from '@cedar-policy/cedar-wasm/nodejs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PostgRESTError } from './errors.mjs';
```

Use the `/nodejs` subpath — the bare import will not work
in Lambda.

#### Module-scoped cache

```javascript
let cachedPolicies = null;
let policiesLoadedAt = 0;
const POLICIES_TTL = 300000; // 5 minutes
```

#### Policy loading — filesystem

Implement `loadFromFilesystem(dirPath)`:
- Read all files in `dirPath`
- Filter to `.cedar` extension
- Read each file as UTF-8
- Join all texts with newline
- Return the concatenated policy text

Implement `loadPolicies()`:
- If cache exists and within TTL, return early
- Determine source: `POLICIES_PATH` env var
  (default: `./policies`)
- Call `loadFromFilesystem()`
- If no policy text found (empty string), set
  `cachedPolicies` to a sentinel value that causes
  all authorization to deny (fail closed)
- If policy text has Cedar syntax errors, log the error
  and set to deny-all sentinel
- Store in `cachedPolicies` as
  `{ staticPolicies: policyText }`
- Update `policiesLoadedAt`

Note: Cedar policy text is passed as a plain string to
the `isAuthorized`/`isAuthorizedPartial` functions via
`{ staticPolicies: text }`. There is no class-based
PolicySet — the API is purely free functions.

#### refreshPolicies()

```javascript
export async function refreshPolicies() {
  cachedPolicies = null;
  policiesLoadedAt = 0;
  await loadPolicies();
}
```

#### _setPolicies() test hook

```javascript
export function _setPolicies(policies) {
  cachedPolicies = policies;
  policiesLoadedAt = Date.now();
}
```

#### Principal construction

Implement `buildPrincipalUid(role, userId)` as specified in
the design — returns `{ type, id }` object based on role.

#### Entity store construction

Implement `buildEntities(principalUid, role, email, schema)`
as specified in the design. Returns an array of entity objects
with `uid`, `attrs`, and `parents` fields.

- User entities get `{ email, role }` attributes
- ServiceRole and AnonRole entities get empty attributes
- Table entities for all tables in schema (no attributes)

#### Action mapping

Implement `buildAction(method)` with the METHOD_TO_ACTION
map. Returns `{ type: 'PgrestLambda::Action', id: action }`.
Throws PGRST000 for unmapped methods.

#### authorize() — table-level check

```javascript
export function authorize({
  principal, action, resource, schema
}) {
  // principal: { role, userId, email }
  // action: HTTP method string (GET, POST, etc.)
  // resource: table name string
  // schema: from schema-cache

  const principalUid = buildPrincipalUid(
    principal.role, principal.userId
  );
  const actionUid = buildAction(action);
  const resourceUid = {
    type: 'PgrestLambda::Table',
    id: resource,
  };
  const entities = buildEntities(
    principalUid, principal.role, principal.email, schema
  );

  const result = isAuthorized({
    principal: principalUid,
    action: actionUid,
    resource: resourceUid,
    context: {},
    policies: cachedPolicies,
    entities,
  });

  if (result.type !== 'success') {
    throw new PostgRESTError(
      500, 'PGRST000',
      'Failed to load authorization policies',
    );
  }

  if (result.response.decision !== 'allow') {
    const cedarAction = METHOD_TO_ACTION[action] || action;
    throw new PostgRESTError(
      403, 'PGRST403',
      `Not authorized to ${cedarAction} on '${resource}'`,
    );
  }

  return true;
}
```

#### Exports

Export: `loadPolicies`, `authorize`, `refreshPolicies`,
`_setPolicies`, `generateCedarSchema`.

Do NOT implement `buildAuthzFilter` or `translateExpr` in
this task — those come in Tasks 04 and 05. You may stub
them as throwing "not implemented" if needed for the module
to be importable.

#### Cedar schema generation

Implement `generateCedarSchema(dbSchema)` as described in
the design. Maps PG types to Cedar types (text/varchar/uuid →
String, integer/smallint/bigint → Long, boolean → Boolean,
all others → String). The schema is a union of all column
attributes across all tables, assigned to the
`PgrestLambda::Row` entity type.

The generated schema is passed alongside policies to
`isAuthorized()` if required by the cedar-wasm API.

**Assumption:** The cedar-wasm free functions accept an
optional `schema` field in the call object. Verify this
during implementation — if the schema is required, pass it;
if optional, it may improve type checking but is not
strictly necessary for policy evaluation.

## Test Requirements

No additional unit tests beyond what Task 01 specifies.
The target tests above cover the functionality implemented
in this task.

## Acceptance Criteria

- `src/rest/cedar.mjs` exists with all exports listed above
- Target tests (#25-#39) pass
- Existing tests (`npm test`) still pass
- No TypeScript/lint warnings introduced

## Conflict Criteria

- If `src/rest/cedar.mjs` already exists, read it and extend
  rather than overwrite.
- If the cedar-wasm API does not match the design's
  description (e.g., `isAuthorized` expects different
  parameters), adapt the implementation to the actual API
  and document the deviation.
- If all target tests already pass before any code changes
  are made, investigate whether the tests are true positives
  before marking the task complete.
