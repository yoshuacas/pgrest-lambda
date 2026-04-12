# Task 08: Handler and Entry Point Wiring

**Agent:** implementer
**Design:** docs/design/postgrest-compatible-api.md
**Depends on:** Tasks 02-07 (all modules)

## Objective

Create `postgrest/handler.mjs` (Lambda entry point that wires
all modules together) and update `index.mjs` to re-export from
the new handler.

## Target Tests

From `__tests__/handler.integration.test.mjs`:
- GET /rest/v1/todos returns 200 with bare JSON array
- POST /rest/v1/todos with body returns 201
- PATCH /rest/v1/todos?id=eq.abc returns updated rows
- DELETE /rest/v1/todos?id=eq.abc returns deleted rows
- GET /rest/v1/ returns valid OpenAPI spec
- POST /rest/v1/_refresh returns refreshed spec
- Unknown table returns 404 with PGRST205
- Unknown column in filter returns 400 with PGRST204
- PATCH without filters returns 400 with PGRST106
- DELETE without filters returns 400 with PGRST106
- POST with missing body returns 400 with PGRST100
- User A cannot see User B's rows
- OPTIONS returns CORS headers
- Prefer: count=exact includes count in Content-Range
- POST without return=representation returns 201 empty body
- Single object mode (1 row, 0 rows, >1 rows)

## Implementation

### postgrest/handler.mjs

Create `plugin/lambda-templates/postgrest/handler.mjs`.

**Export:**
```javascript
export async function handler(event) { ... }
```

**Handler flow:**

1. **CORS preflight:** If `event.httpMethod === 'OPTIONS'`,
   return `success(200, null, {})` — just CORS headers.

2. **Extract request data:**
   - `method` = `event.httpMethod`
   - `path` = `event.path`
   - `userId` = `event.requestContext?.authorizer?.claims?.sub
     || 'anonymous'`
   - `headers` = lowercase all header keys for
     case-insensitive lookup
   - `body` = parse `event.body` as JSON (handle null/empty)
   - `params` = `event.queryStringParameters || {}`
   - `prefer` = parse Prefer header (comma-separated key=value
     pairs)
   - `accept` = `headers['accept'] || ''`

3. **Get pool and schema:**
   ```javascript
   const pool = await getPool();
   const schema = await getSchema(pool);
   ```

4. **Route:**
   ```javascript
   const routeInfo = route(path, schema);
   ```

5. **Handle special routes:**
   - `openapi`: return `success(200, generateSpec(schema, ...))`
   - `refresh`: call `refresh(pool)`, return
     `success(200, generateSpec(newSchema, ...))`

6. **Parse query:**
   ```javascript
   const parsed = parseQuery(params, method);
   ```

7. **Validate columns** in filters, select, order, and body
   against schema. Throw PGRST204 for unknown columns.

8. **Build and execute SQL** based on method:
   - `GET`: buildSelect + execute. If
     `Prefer: count=exact`, also buildCount + execute in
     parallel.
   - `POST`: check body exists (throw PGRST100 if not).
     If `parsed.onConflict` and prefer has
     `resolution=merge-duplicates`, build upsert. Otherwise
     buildInsert.
   - `PATCH`: buildUpdate + execute.
   - `DELETE`: buildDelete + execute.

9. **Format response:**
   - Determine `contentRange` string from result rows and
     optional count.
   - Check `singleObject` = accept includes
     `application/vnd.pgrst.object+json`.
   - Determine `returnRepresentation` from Prefer header.
   - For GET: `success(200, rows, { contentRange, singleObject })`
   - For POST: `success(201, returnRep ? rows : null, {})`
   - For PATCH/DELETE: if returnRep,
     `success(200, rows, { singleObject })`; else
     `success(204, null, {})`

10. **Error handling (catch block):**
    - If `PostgRESTError`: return `error(err)`
    - If PG error (has `.code` matching PG pattern):
      return `error(mapPgError(err))`
    - Otherwise: return `error(new PostgRESTError(500, ...))`

### index.mjs Update

Change `plugin/lambda-templates/index.mjs` from:
```javascript
export { handler } from "./crud-api.mjs";
```
to:
```javascript
export { handler } from "./postgrest/handler.mjs";
```

## Acceptance Criteria

- All handler.integration.test.mjs tests pass.
- All unit tests from previous tasks still pass.
- `index.mjs` exports the new handler.
- `crud-api.mjs` is NOT deleted (kept as reference).

## Conflict Criteria

- If all target tests already pass before any code changes
  are made, investigate whether the tests are true positives
  before marking the task complete.
- If any module API from Tasks 02-07 differs from what this
  task expects, adapt the handler to match the actual module
  APIs rather than escalating.
