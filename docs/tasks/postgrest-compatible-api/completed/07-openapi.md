# Task 07: OpenAPI 3.0.3 Spec Generator

**Agent:** implementer
**Design:** docs/design/postgrest-compatible-api.md
**Depends on:** Task 03 (schema-cache structure)

## Objective

Create `postgrest/openapi.mjs` that generates an OpenAPI
3.0.3 specification from the schema cache.

## Target Tests

From `__tests__/openapi.test.mjs`:
- Produces valid OpenAPI 3.0.3 structure
- Includes a path per table
- Each table path has GET, POST, PATCH, DELETE operations
- Maps PG types to JSON Schema correctly (text->string,
  integer->integer, boolean->boolean, timestamptz->string
  with date-time format, uuid->string with uuid format,
  jsonb->object)
- Includes securitySchemes with Bearer JWT
- Includes PostgREST error schema in components

## Implementation

Create `plugin/lambda-templates/postgrest/openapi.mjs`.

**Export:**
```javascript
export function generateSpec(schema, apiUrl) { ... }
```

**Type mapping** (PG type string -> JSON Schema):

| PG Type                       | JSON Schema             |
|-------------------------------|-------------------------|
| text, varchar, char, character varying | `{ type: "string" }`    |
| integer, smallint, int4, int2 | `{ type: "integer" }`   |
| bigint, int8                  | `{ type: "integer" }`   |
| boolean, bool                 | `{ type: "boolean" }`   |
| numeric, real, double precision, float4, float8 | `{ type: "number" }` |
| timestamp with time zone, timestamp without time zone | `{ type: "string", format: "date-time" }` |
| date                          | `{ type: "string", format: "date" }` |
| jsonb, json                   | `{ type: "object" }`    |
| uuid                          | `{ type: "string", format: "uuid" }` |
| Other                         | `{ type: "string" }`    |

Note: `pg_catalog.format_type()` returns full type names like
`"timestamp with time zone"`, `"character varying"`, etc.
Match on these full strings or use prefix/includes matching.

**Spec structure:**
- `openapi: '3.0.3'`
- `info`: title "BOA PostgREST-Compatible API", version "1.0.0"
- `servers`: `[{ url: apiUrl }]`
- `paths`: one entry per table (`/{tableName}`) with GET,
  POST, PATCH, DELETE operations. Each operation has:
  - Summary and description
  - Query parameters for filters (reference PostgREST
    conventions)
  - Request body schema for POST/PATCH
  - Response schemas
- `components.schemas`: one schema per table with column
  properties mapped through the type table above
- `components.schemas.PostgRESTError`: the error object
  schema with code, message, details, hint
- `components.securitySchemes`: `BearerAuth` with type
  `http`, scheme `bearer`, bearerFormat `JWT`
- `security`: `[{ BearerAuth: [] }]`

## Acceptance Criteria

- All openapi.test.mjs tests pass.
- Existing tests still pass.

## Conflict Criteria

- If all target tests already pass before any code changes
  are made, investigate whether the tests are true positives
  before marking the task complete.
