# Task 08: Add Handler Integration Test for Depth Rejection

**Agent:** implementer
**Design:** docs/design/security-v13-embed-depth.md
**Review:** docs/code-review/security-v13-embed-depth.md

## Objective

Add an integration test that confirms the handler threads
`ctx.maxEmbedDepth` to `parseQuery` and returns HTTP 400
with PGRST100 when embed depth exceeds the configured
limit.

## Problem

All depth-enforcement tests call `parseSelectList` or
`parseQuery` directly. There is no test confirming that
the handler wires `ctx.maxEmbedDepth` through to the
parser and surfaces the error as an HTTP 400 response.
The wiring is straightforward but an integration test
would catch a regression if a new `parseQuery` call site
is added without the `maxEmbedDepth` argument.

## Target Tests

**test_handler_rejects_deep_embed:**

> Given a pgrest instance with `maxEmbedDepth: 2`
> When a GET request includes `select=a(b(c(id)))`
> Then the response is HTTP 400
> And the body contains `code: 'PGRST100'`
> And the body contains `message` matching
> `'Embedding depth exceeds maximum of 2'`

**test_handler_allows_within_limit:**

> Given a pgrest instance with `maxEmbedDepth: 2`
> When a GET request includes `select=id,customers(name)`
> Then the response is HTTP 200 (or successful, not 400)

## Implementation

### Test location

Add tests to `test/integration/embedding.test.mjs` inside
the existing `resource embedding` describe block, in a new
nested `describe('embed depth limit', ...)` block.

### Harness check

The existing embedding integration test creates a pgrest
instance in the `before` hook via:

```javascript
pgrest = createPgrest({
  database: { connectionString: DATABASE_URL },
  jwtSecret: JWT_SECRET,
  auth: false,
});
```

The depth-limit tests need a separate pgrest instance with
`maxEmbedDepth: 2`. Create it inside the new describe
block's `before` hook:

```javascript
describe('embed depth limit', () => {
  let depthPgrest;

  before(async () => {
    depthPgrest = createPgrest({
      database: { connectionString: DATABASE_URL },
      jwtSecret: JWT_SECRET,
      auth: false,
      maxEmbedDepth: 2,
    });
    await depthPgrest.rest(makeEvent({
      method: 'POST', path: '/rest/v1/_refresh',
    }));
  });
  // tests here
});
```

Use `makeEvent` from `./helpers.mjs` with:
- `path: '/rest/v1/customers'` (a table that exists in
  the embedding schema)
- `query: { select: '...' }` with the appropriate nesting

For the rejection test, use a select string that produces
depth 3 using real table names from the embedding schema:
`select=orders(order_items(products(name)))` -- this is
depth 3 and should fail with `maxEmbedDepth: 2`.

For the pass test, use `select=id,orders(amount)` -- this
is depth 1 and should succeed.

### Assertions

```javascript
it('rejects embed depth exceeding maxEmbedDepth', async () => {
  const res = await depthPgrest.rest(makeEvent({
    path: '/rest/v1/customers',
    query: { select: 'orders(order_items(products(name)))' },
  }));
  assert.equal(res.statusCode, 400);
  const body = JSON.parse(res.body);
  assert.equal(body.code, 'PGRST100');
  assert.match(body.message,
    /Embedding depth exceeds maximum of 2/);
});

it('allows embed depth within maxEmbedDepth', async () => {
  const res = await depthPgrest.rest(makeEvent({
    path: '/rest/v1/customers',
    query: { select: 'id,orders(amount)' },
  }));
  assert.equal(res.statusCode, 200);
});
```

## Acceptance Criteria

- Both integration tests pass when run with
  `TEST_DATABASE_URL` set.
- The rejection test confirms HTTP 400, PGRST100, and the
  correct message.
- The pass test confirms the request succeeds within the
  configured limit.
- All existing embedding integration tests still pass.

## Conflict Criteria

- If the embedding integration tests skip (no
  `TEST_DATABASE_URL`), the tests should also skip via the
  existing `{ skip: !DATABASE_URL }` mechanism on the
  parent describe block.
- If `createPgrest` does not accept `maxEmbedDepth` in
  config, escalate -- Task 03 should have wired this.
