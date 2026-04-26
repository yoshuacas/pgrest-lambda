Add a new /rest/v1/rpc/:function_name endpoint that calls PostgreSQL stored procedures, matching PostgREST's RPC surface. This unblocks every supabase-js .rpc() call, which today gets a 404. For apps with any server-side business logic in stored procedures, this is the largest single compatibility gap.

Depends on: db-capabilities loop. Uses the supportsRpc capability flag to decide whether to expose the endpoint at all.

## Background: what supabase-js calls

.rpc(fn, args) translates to:

  POST /rest/v1/rpc/:fn          when args contains an object (JSON body)
  POST /rest/v1/rpc/:fn          default for most calls, args as JSON body
  GET  /rest/v1/rpc/:fn?a=1&b=2  when { get: true } passed or GET-safe
  HEAD /rest/v1/rpc/:fn          when { head: true } passed

Reference: node_modules/@supabase/postgrest-js/src/PostgrestClient.ts line 374 onward.

After the RPC call, users chain standard filter/order/limit/select methods — so the response stream is treated like a table read. This is only meaningful for table-valued functions; scalar functions return a single unwrapped value.

PostgREST spec: https://postgrest.org/en/v12/references/api/functions.html.

## What to build

A new subsystem, roughly 4 pieces:

### 1. Router

src/rest/router.mjs — add matching for /rest/v1/rpc/:function_name paths. Returns { type: 'rpc', functionName }.

### 2. Function introspection

src/rest/schema-cache.mjs — add pg_proc query that reads:
  - function name (proname)
  - argument names (proargnames)
  - argument types (pg_type.typname from proargtypes array)
  - return type + whether it returns a set (proretset, prorettype)
  - volatility (provolatile: 'i' immutable, 's' stable, 'v' volatile)
  - language (SQL, PL/pgSQL, etc.)

Filter to public schema only. Cache alongside tables with the same TTL. The cache shape grows a new .functions map keyed by function name.

Safety: reject functions where proargnames is NULL (functions declared with unnamed args — we can't map JSON keys to positions without names).

### 3. SQL builder

src/rest/sql-builder.mjs — new buildRpcCall(fnName, args, fnSchema). Generates:

  SELECT * FROM "fn_name"("arg1" := $1, "arg2" := $2)

with named-parameter syntax (:=) for clarity. The arg order in the SQL doesn't have to match the argument list — Postgres resolves by name. Missing optional args (those with proargdefaults in pg_proc) are simply omitted from the call.

For scalar functions (proretset=false, return type scalar), wrap the result to unwrap the single column:

  SELECT "fn_name"(args...) AS "_rpc_result"

and return response.data as the single value, not an array.

### 4. Handler

src/rest/handler.mjs — new branch for routeInfo.type === 'rpc'. Parses request body (POST) or query string (GET) into the named-args object, validates each arg matches a function parameter, builds the SQL, executes, and returns the result.

- GET with query params: each ?name=value becomes arg{name}=value. Values are strings — coerce to the expected type based on pg_proc argument type. Use the existing type-coercion logic from query-parser.mjs if any; otherwise keep it narrow (text, int, bool, numeric).
- POST with JSON body: body is an object, each key maps to a named argument. Types come from JSON directly.
- Arrays in GET: '{1,2,3}' syntax (same as PostgREST).
- HEAD: run GET SQL with LIMIT 0 for efficient existence check.

Table-valued functions (proretset=true) support the standard filter/order/limit query params (same infrastructure as table reads). Scalar functions ignore them (or reject if present, to match PostgREST's behavior — check spec).

Cedar authorization applies: the Cedar resource type for RPC is PgrestLambda::Function::"fn_name". A user who authorizes a call on a function can call it; no per-row filter because the engine doesn't know what rows the function returns.

### 5. Errors

- Function not found: PGRST202 'function "fn" not found in the schema cache'.
- Missing required argument: PGRST203 'missing required argument "x" for function "fn"'.
- Extra unknown argument: PGRST204 'unknown argument "x" for function "fn"'.
- Type mismatch: PGRST205 'argument "x" expected type "int" but got "text"'.
- Function disallowed by Cedar: PGRST403 with the usual enriched message.
- DSQL (if supportsRpc=false): PGRST501 "RPC is not supported on this database".

## DB specialization

This is the first feature that actually gates on a capability flag:

- If ctx.dbCapabilities.supportsRpc is false, the router returns PGRST501 for any /rpc/* request.
- DSQL: research PL/pgSQL support. DSQL supports SQL-language and PL/pgSQL functions but has stricter rules (no triggers from functions, some DDL blocked). For RPC to work, we need: CREATE FUNCTION, pg_proc introspection, and SELECT fn(args) — all of which DSQL supports as of late 2024. Set supportsRpc: true for DSQL; let DSQL reject specific function bodies that use unsupported features at CREATE FUNCTION time (user's problem, not pgrest-lambda's).

The capability exists so we can flip it later if a feature only certain engines support (e.g., plpy Python functions) becomes relevant.

## Out of scope for this loop

- Accept-Profile / Content-Profile schema switching (we're public-only).
- tx=commit / tx=rollback Prefer headers.
- Function overloading disambiguation via signature — PostgREST supports this; we defer. Reject the call with PGRST206 if multiple functions exist with the same name.
- Immutable-function GET caching (pg_proc.provolatile='i') — the engine could send cache-control headers for these; defer.

## Testing

Unit tests:
- Router parses /rest/v1/rpc/my_function.
- Schema cache queries pg_proc, handles NULL proargnames, groups by function name.
- SQL builder emits named-parameter SQL with correct quoting.
- Scalar vs table-valued response unwrapping.
- Error code mapping.

Integration tests (real Postgres, tests/integration/):
- CREATE FUNCTION with a simple scalar, call via RPC, receive the scalar.
- Table-valued function with filter and order.
- Missing arg → PGRST203.
- Unknown arg → PGRST204.
- Function-level Cedar permit/forbid rules.
- Call with GET params, call with POST body, verify same result.

E2E (tests/e2e/): supabase-js.rpc('fn', {args}) returning the scalar and table-valued cases.

DSQL-specific tests: add a capability-flag test that proves PGRST501 is returned when supportsRpc=false (using a mock provider).

## Critical rules

- Function name is validated as a Postgres identifier ([A-Za-z_][A-Za-z0-9_]*), always quoted in SQL. Never string-interpolated.
- Arguments always passed as $1, $2 bind parameters.
- Cedar check before SQL build.
- Follow the existing schema-cache refresh pattern — functions refresh alongside tables on POST /rest/v1/_refresh.
- Log function-call failures in dev mode (production=false) with the stack, per the existing auth-handler pattern.
- Never reference BOA/Harbor.
- No DSQL-specific SQL in the RPC path. Capability flag gates access.