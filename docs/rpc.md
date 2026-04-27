# Calling PostgreSQL Functions (RPC)

pgrest-lambda exposes your PostgreSQL stored functions as HTTP
endpoints at `/rest/v1/rpc/:function_name`. Clients call them the
same way `@supabase/supabase-js` does:

```javascript
const { data, error } = await supabase.rpc('orders_for_customer', {
  customer_id: '11111111-1111-1111-1111-111111111111',
});
```

This page covers what that means end-to-end: the functions you
define in Postgres, the requests pgrest-lambda accepts, and the
responses you get back. There's a section at the bottom for
running on Aurora DSQL, which does **not** support RPC — you'll
do the same work a different way there.

## The example schema

Every example on this page uses this schema. Seed it with `psql`
before trying the requests yourself:

```sql
CREATE TABLE public.customers (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email      TEXT NOT NULL,
  name       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.orders (
  id          BIGSERIAL PRIMARY KEY,
  customer_id UUID NOT NULL REFERENCES public.customers(id),
  total       NUMERIC(10,2) NOT NULL,
  status      TEXT NOT NULL,
  placed_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO public.customers (id, email, name) VALUES
  ('11111111-1111-1111-1111-111111111111', 'alice@example.com', 'Alice'),
  ('22222222-2222-2222-2222-222222222222', 'bob@example.com', 'Bob');

INSERT INTO public.orders (customer_id, total, status) VALUES
  ('11111111-1111-1111-1111-111111111111', 120.00, 'paid'),
  ('11111111-1111-1111-1111-111111111111',  45.50, 'paid'),
  ('11111111-1111-1111-1111-111111111111',  99.00, 'pending'),
  ('22222222-2222-2222-2222-222222222222', 200.00, 'paid');
```

After adding any function to the database, run
`pgrest-lambda refresh` so the schema cache picks it up.

## The four function shapes

pgrest-lambda recognizes four shapes based on the function's
return type. The shape determines the response format.

### Scalar

A function that returns a single value (`int`, `text`, `numeric`,
`bool`, `uuid`, …).

**Define:**

```sql
CREATE FUNCTION public.add_numbers(a int, b int)
  RETURNS int
  LANGUAGE sql IMMUTABLE
AS $$ SELECT a + b $$;
```

**Call (POST with JSON body):**

```bash
curl -s -X POST http://localhost:3000/rest/v1/rpc/add_numbers \
  -H "apikey: $SERVICE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"a":3,"b":4}'
```

```
7
```

**Call (GET with query params):**

```bash
curl -s "http://localhost:3000/rest/v1/rpc/add_numbers?a=10&b=15" \
  -H "apikey: $SERVICE_KEY"
```

```
25
```

Notice the response is a bare JSON value. Not `{"result": 7}`,
not `[7]` — just `7`. Text scalars return a quoted string:

```bash
curl -s -X POST http://localhost:3000/rest/v1/rpc/greet_user \
  -H "apikey: $SERVICE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"Alice"}'
```

```
"Hello, Alice!"
```

### Set-returning (`RETURNS TABLE`)

A function that returns many rows. The columns are declared as
part of the return type:

```sql
CREATE FUNCTION public.orders_for_customer(customer_id uuid)
  RETURNS TABLE(order_id bigint, total numeric, status text)
  LANGUAGE sql STABLE
AS $$
  SELECT id, total, status FROM public.orders
   WHERE orders.customer_id = orders_for_customer.customer_id
   ORDER BY id
$$;
```

**Call:**

```bash
curl -s -X POST http://localhost:3000/rest/v1/rpc/orders_for_customer \
  -H "apikey: $SERVICE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"customer_id":"11111111-1111-1111-1111-111111111111"}'
```

```json
[
  {"order_id": "1", "total": "120.00", "status": "paid"},
  {"order_id": "2", "total":  "45.50", "status": "paid"},
  {"order_id": "3", "total":  "99.00", "status": "pending"}
]
```

Set-returning functions accept the same `select`, `order`,
`limit`, `offset`, and filter query params as table reads.
Filters apply to the result columns — here, narrowing to paid
orders and sorting by total descending:

```bash
curl -s -X POST \
  "http://localhost:3000/rest/v1/rpc/orders_for_customer?status=eq.paid&order=total.desc&limit=2" \
  -H "apikey: $SERVICE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"customer_id":"11111111-1111-1111-1111-111111111111"}'
```

```json
[
  {"order_id": "1", "total": "120.00", "status": "paid"},
  {"order_id": "2", "total":  "45.50", "status": "paid"}
]
```

### Composite (single-row record)

A function that returns exactly one row, typed as a composite
type or an existing table:

```sql
CREATE FUNCTION public.customer_summary(cust_id uuid)
  RETURNS customers
  LANGUAGE sql STABLE
AS $$ SELECT * FROM public.customers WHERE id = cust_id $$;
```

**Call:**

```bash
curl -s -X POST http://localhost:3000/rest/v1/rpc/customer_summary \
  -H "apikey: $SERVICE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"cust_id":"11111111-1111-1111-1111-111111111111"}'
```

```json
{"id":"11111111-1111-1111-1111-111111111111","email":"alice@example.com","name":"Alice","created_at":"…"}
```

Note the response is a single object, not an array. One-row
composite functions are the right shape for "get this specific
thing by id."

### Void

A function that runs for its side effects and returns nothing:

```sql
CREATE FUNCTION public.log_event(event_type text, payload jsonb)
  RETURNS void
  LANGUAGE sql VOLATILE
AS $$ SELECT 1 $$;
```

**Call:**

```bash
curl -s -X POST http://localhost:3000/rest/v1/rpc/log_event \
  -H "apikey: $SERVICE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"event_type":"user_signup","payload":{"user_id":"abc"}}'
```

```
HTTP/1.1 200 OK
Content-Length: 0
```

HTTP 200, empty body. pgrest-lambda deliberately uses 200 and not
204 for void functions so `@supabase/supabase-js` doesn't treat
the response as an error.

## Aggregates and other set-returning-scalar functions

Functions can aggregate across tables and return a scalar:

```sql
CREATE FUNCTION public.monthly_revenue()
  RETURNS numeric
  LANGUAGE sql STABLE
AS $$
  SELECT COALESCE(SUM(total), 0) FROM public.orders
   WHERE status = 'paid'
     AND placed_at >= date_trunc('month', now())
$$;
```

**Call:**

```bash
curl -s http://localhost:3000/rest/v1/rpc/monthly_revenue \
  -H "apikey: $SERVICE_KEY"
```

```
"365.50"
```

Zero-argument functions work under GET or POST. The response is a
string because `numeric` is returned as an exact decimal in JSON
to preserve precision.

## GET vs POST

Both work. The choice affects how arguments are encoded:

| Shape | Method | Argument source | Notes |
|---|---|---|---|
| Scalar / set-returning | POST | JSON body | Preserves types (numbers, booleans, arrays, nested objects) |
| Scalar / set-returning | GET | Query params | Values are strings; simple types only |
| Existence check | HEAD | Query params | Same as GET but returns headers without a body |

Use POST when you have JSON objects, arrays, or precise numeric
types. Use GET for simple scalar arguments — it's the URL-
shareable form that browsers can bookmark.

### GET parameter disambiguation

Query parameters on GET are split by **value syntax**:

- `?customer_id=11111111-1111-...` — raw value, treated as a
  function argument.
- `?status=eq.paid` — value has a PostgREST operator prefix
  (`eq.`, `gt.`, `like.`, etc.), treated as a filter on the
  function's result.
- `select`, `order`, `limit`, `offset` — always reserved for
  PostgREST controls.

This means a function argument named `status` conflicts with a
filter on a result column named `status` when using GET. Use POST
for anything ambiguous.

## supabase-js

`@supabase/supabase-js` is wire-compatible with pgrest-lambda's
RPC endpoint. Anywhere you call `.rpc()` against Supabase, you
can point that same client at pgrest-lambda:

```javascript
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  'http://localhost:3000',
  process.env.PGREST_SERVICE_KEY,
);

// Scalar function
const { data: sum, error: sumErr } = await supabase.rpc('add_numbers', {
  a: 3, b: 4,
});
// sum === 7

// Set-returning function, chain standard filters
const { data: orders } = await supabase
  .rpc('orders_for_customer', {
    customer_id: '11111111-1111-1111-1111-111111111111',
  })
  .eq('status', 'paid')
  .order('total', { ascending: false })
  .limit(2);
// orders === [{ order_id: '1', total: '120.00', status: 'paid' }, ...]

// Void function — data is null on success
const { error } = await supabase.rpc('log_event', {
  event_type: 'user_signup',
  payload: { user_id: 'abc' },
});
```

## Error responses

### PGRST202 — Function not found

```bash
curl -s -X POST http://localhost:3000/rest/v1/rpc/does_not_exist \
  -H "apikey: $SERVICE_KEY" -H "Content-Type: application/json" -d '{}'
```

```json
{
  "code": "PGRST202",
  "message": "Could not find the function 'does_not_exist' in the schema cache"
}
```

Either the function truly doesn't exist, or you added it after
the schema cache was last loaded. Run `pgrest-lambda refresh` to
pick up new functions.

### PGRST209 — Missing required argument

```bash
curl -s -X POST http://localhost:3000/rest/v1/rpc/add_numbers \
  -H "apikey: $SERVICE_KEY" -H "Content-Type: application/json" -d '{"a":3}'
```

```json
{
  "code": "PGRST209",
  "message": "Function 'add_numbers' requires argument 'b' which was not provided"
}
```

Arguments with default values are optional. All others are
required.

### PGRST207 — Unknown argument

```bash
curl -s -X POST http://localhost:3000/rest/v1/rpc/add_numbers \
  -H "apikey: $SERVICE_KEY" -H "Content-Type: application/json" \
  -d '{"a":3,"b":4,"bogus":true}'
```

```json
{
  "code": "PGRST207",
  "message": "Function 'add_numbers' does not have an argument named 'bogus'"
}
```

Extra keys in the body that don't match a declared argument
produce this error. Supabase-js sometimes sends extras during
type-checking development; the error names the offender.

### PGRST208 — Type coercion failed (GET only)

GET requests receive all values as strings. When pgrest-lambda
can't coerce a string to the function's declared argument type,
you get PGRST208:

```bash
curl -s "http://localhost:3000/rest/v1/rpc/add_numbers?a=42abc&b=1" \
  -H "apikey: $SERVICE_KEY"
```

```json
{
  "code": "PGRST208",
  "message": "Argument 'a' of function 'add_numbers' expects type 'int4' but received '42abc'"
}
```

Use POST with a typed JSON body to avoid coercion entirely.

### PGRST203 — Overloaded function

PostgreSQL lets you have two functions with the same name and
different signatures. pgrest-lambda v1 rejects calls to
overloaded names:

```json
{
  "code": "PGRST203",
  "message": "Could not choose the best candidate function between: fn(a integer), fn(a text)"
}
```

If you need this, either rename one of the functions or
argue-by-name: `CREATE FUNCTION fn_int(a int) …` and
`CREATE FUNCTION fn_text(a text) …`. Argument-count-based
overload resolution may land in a future release.

### PGRST403 — Not authorized

If your Cedar policy denies the `call` action for the function:

```json
{
  "code": "PGRST403",
  "message": "Not authorized to call 'orders_for_customer'"
}
```

See [authorization.md](authorization.md) for how `call` policies
interact with the `PgrestLambda::Function` resource type.

## Authorization

Every RPC call runs through Cedar with:

- **principal** — the caller (`AnonRole`, `User`, or `ServiceRole`)
- **action** — `"call"` (new for RPC)
- **resource** — `PgrestLambda::Function::"<function_name>"`
- **context** — `{ "function": "<function_name>" }`

The shipped default policy at `policies/default.cedar` lets
`ServiceRole` call any function. To let authenticated users call
a specific one:

```cedar
permit(
    principal is PgrestLambda::User,
    action == PgrestLambda::Action::"call",
    resource == PgrestLambda::Function::"orders_for_customer"
);
```

To let anon users call a public stats function:

```cedar
permit(
    principal,
    action == PgrestLambda::Action::"call",
    resource == PgrestLambda::Function::"monthly_revenue"
);
```

**Row-level authorization doesn't apply to RPC results.**
Function results are not filtered by Cedar policies — the engine
doesn't know the shape of the returned rows. Authorization is
all-or-nothing: either the user can call the function, or they
can't. If you need per-row filtering, either build the filter
into the function's SQL (using the authenticated user's ID) or
switch to a direct table query with table-level policies.

## Function discovery

Every non-overloaded function in the `public` schema appears in
the auto-generated OpenAPI spec at `GET /rest/v1/`:

```bash
curl -s http://localhost:3000/rest/v1/ \
  -H "apikey: $ANON_KEY" \
  | jq '.paths | with_entries(select(.key | startswith("/rpc/")))'
```

```json
{
  "/rpc/add_numbers": {
    "post": {
      "tags": ["Functions"],
      "requestBody": {
        "content": {
          "application/json": {
            "schema": {
              "type": "object",
              "required": ["a", "b"],
              "properties": {
                "a": {"type": "integer"},
                "b": {"type": "integer"}
              }
            }
          }
        }
      },
      "responses": {
        "200": {
          "content": {"application/json": {"schema": {"type": "integer"}}}
        }
      }
    }
  },
  ...
}
```

For `RETURNS TABLE` functions, the response schema lists every
return column with its type. For `SETOF record` or other untyped
returns, the response schema is a generic object array — pgrest-
lambda can't introspect column names from the Postgres side.

Open `GET /rest/v1/_docs` in a browser to explore the full list
in Scalar.

## Limits

In v1, these functions are **excluded** from RPC and return
PGRST202 if called:

- Functions with `OUT`, `INOUT`, or `VARIADIC` parameters.
- Functions with unnamed arguments (declare them with names).
- Aggregate functions, window functions, and procedures
  (`CREATE PROCEDURE` instead of `CREATE FUNCTION`).
- Overloaded functions (multiple definitions with the same name
  and different signatures).
- Functions in schemas other than `public`.

`RETURNS TABLE(...)` functions are fully supported — the table
columns become queryable result columns.

`supabase.rpc().single()` returns the first row of a
set-returning function when you know there's exactly one. For
scalar and composite functions it's a no-op.

---

## Running on Aurora DSQL

Aurora DSQL **does not support RPC** in pgrest-lambda's current
release. Any call to `/rest/v1/rpc/…` against a pgrest-lambda
instance configured for DSQL returns:

```json
{
  "code": "PGRST501",
  "message": "RPC is not supported on this database"
}
```

This is deliberate. DSQL's function support differs from standard
PostgreSQL in ways that affect RPC end-to-end:

- DSQL supports `LANGUAGE sql` functions only. PL/pgSQL is not
  available, which rules out stored procedures with loops,
  conditionals, RAISE statements, or temp tables. A large slice
  of "business logic in the database" patterns don't work.
- DSQL does not expose the same `pg_proc` introspection that
  pgrest-lambda uses to discover argument names, types, and
  return shapes. The capability flag is set to `false` to avoid
  misleading users.

The `supportsRpc` flag on the database capabilities interface
(see [configuration.md](configuration.md)) gates this. The flag
is `true` on standard PostgreSQL and `false` on DSQL.

### The pattern to use instead: regular table endpoints with views

On DSQL, replace RPC with **views and computed columns**. The
REST surface is already there (`/rest/v1/:table`) and it
introspects views the same way it introspects tables.

Take the `monthly_revenue` function from above. On standard
Postgres, it's an RPC call. On DSQL, create a view:

```sql
CREATE VIEW public.monthly_revenue AS
  SELECT COALESCE(SUM(total), 0) AS revenue
    FROM public.orders
   WHERE status = 'paid'
     AND placed_at >= date_trunc('month', now());
```

Now the client calls it as a table:

```bash
curl -s "http://localhost:3000/rest/v1/monthly_revenue?select=revenue" \
  -H "apikey: $SERVICE_KEY"
```

```json
[{"revenue": "365.50"}]
```

The trade-off: no arguments. A view is a fixed query. If your
function takes parameters, encode them as filter values instead.

### Function with a parameter → parameterized query on a view

`orders_for_customer(customer_id uuid)` becomes a view over the
orders table, and the client filters:

```sql
-- On DSQL, no function needed — query the table directly.
-- Or, if you want to hide columns or do joins, a view:
CREATE VIEW public.visible_orders AS
  SELECT id AS order_id, customer_id, total, status, placed_at
    FROM public.orders;
```

The client:

```bash
curl -s "http://localhost:3000/rest/v1/visible_orders?customer_id=eq.11111111-1111-1111-1111-111111111111&order=order_id" \
  -H "apikey: $SERVICE_KEY"
```

```json
[
  {"order_id": "1", "customer_id": "11111111-...", "total": "120.00", "status": "paid", ...},
  {"order_id": "2", "customer_id": "11111111-...", "total":  "45.50", "status": "paid", ...},
  {"order_id": "3", "customer_id": "11111111-...", "total":  "99.00", "status": "pending", ...}
]
```

Filter, order, limit, offset, select, and Cedar policies all
work on the view just like any other table. The customer_id is a
filter value in the URL, not a function argument in the body.

### Function with side effects → regular INSERT

`log_event(event_type, payload)` has no query-shaped substitute
— inserting into an events table does:

```sql
CREATE TABLE public.events (
  id          BIGSERIAL PRIMARY KEY,
  event_type  TEXT NOT NULL,
  payload     JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

```bash
curl -s -X POST http://localhost:3000/rest/v1/events \
  -H "apikey: $SERVICE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"event_type":"user_signup","payload":{"user_id":"abc"}}'
```

Use Cedar to restrict who can insert.

### When you genuinely need RPC on DSQL

If you have a logic-heavy codebase that depends on stored
functions and you want to run on DSQL, two approaches work:

1. **Move the logic out of the database.** A Lambda function or
   application-layer service that reads via pgrest-lambda,
   computes, and writes via pgrest-lambda. More code, but no
   DSQL-specific limits.

2. **Split your deployment.** Use standard PostgreSQL (Aurora
   Serverless v2, RDS, or your own) for the parts of the app
   that need functions, and DSQL for the parts that benefit from
   DSQL's scale. Two pgrest-lambda instances against two
   databases.

Most apps land fine on option 1 — the "thick database" pattern
is not strictly required for Postgres-backed apps, and pgrest-
lambda's REST surface plus a small amount of Lambda code
typically replaces what stored functions were doing.

---

## Reference

- [authorization.md](authorization.md) — Cedar policies for
  `call` action and `PgrestLambda::Function` resource.
- [configuration.md](configuration.md) — database capabilities
  and the `supportsRpc` flag.
- [PostgREST RPC docs](https://postgrest.org/en/v12/references/api/functions.html)
  — pgrest-lambda aims for wire compatibility with PostgREST v12.
