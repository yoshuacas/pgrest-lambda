import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from '../db/index.mjs';
import { createRestHandler } from '../handler.mjs';
import { createSchemaCache } from '../schema-cache.mjs';
import { createCedar } from '../cedar.mjs';

// --- Cedar policies ---

const OWNER_CONDITIONED_INSERT_POLICY = `
permit(
    principal is PgrestLambda::User,
    action == PgrestLambda::Action::"insert",
    resource is PgrestLambda::Row
) when {
    context.table == "orders"
    && resource.owner_id == principal
};
permit(
    principal is PgrestLambda::ServiceRole,
    action, resource
);
`;

const UNCONDITIONAL_INSERT_POLICY = `
permit(
    principal is PgrestLambda::User,
    action == PgrestLambda::Action::"insert",
    resource == PgrestLambda::Table::"posts"
);
permit(
    principal is PgrestLambda::ServiceRole,
    action, resource
);
`;

const TABLE_PERMIT_ROW_FORBID_POLICY = `
permit(
    principal is PgrestLambda::User,
    action == PgrestLambda::Action::"insert",
    resource == PgrestLambda::Table::"items"
);
forbid(
    principal,
    action == PgrestLambda::Action::"insert",
    resource is PgrestLambda::Row
) when {
    context.table == "items"
    && resource.restricted == true
};
`;

// --- Mock data for schema introspection ---

const mockColumnRows = [
  // orders table
  { table_name: 'orders', column_name: 'id',
    data_type: 'text', is_nullable: false, column_default: null },
  { table_name: 'orders', column_name: 'owner_id',
    data_type: 'text', is_nullable: false, column_default: null },
  { table_name: 'orders', column_name: 'amount',
    data_type: 'integer', is_nullable: false, column_default: null },
  // posts table
  { table_name: 'posts', column_name: 'id',
    data_type: 'text', is_nullable: false, column_default: null },
  { table_name: 'posts', column_name: 'title',
    data_type: 'text', is_nullable: true, column_default: null },
  // items table
  { table_name: 'items', column_name: 'id',
    data_type: 'text', is_nullable: false, column_default: null },
  { table_name: 'items', column_name: 'name',
    data_type: 'text', is_nullable: true, column_default: null },
  { table_name: 'items', column_name: 'restricted',
    data_type: 'boolean', is_nullable: true, column_default: null },
];

const mockPkRows = [
  { table_name: 'orders', column_name: 'id' },
  { table_name: 'posts', column_name: 'id' },
  { table_name: 'items', column_name: 'id' },
];

// --- Mock pool ---

function createMockPool() {
  const capturedQueries = [];
  const pool = {
    capturedQueries,
    query: async (text, values) => {
      capturedQueries.push({ text, values });
      if (text.includes('pg_catalog') && !text.includes('contype')) {
        return { rows: mockColumnRows };
      }
      if (text.includes('contype')) {
        return { rows: mockPkRows };
      }
      if (text.trimStart().startsWith('INSERT')) {
        return {
          rows: [{ id: 'new-id' }],
        };
      }
      return { rows: [] };
    },
  };
  return pool;
}

function createTestContext(mockPool) {
  const db = createDb({});
  db._setPool(mockPool || createMockPool());
  const schemaCache = createSchemaCache({});
  const cedar = createCedar({ policiesPath: './policies' });
  return { db, schemaCache, cedar };
}

function makeEvent({
  method = 'GET',
  path = '/rest/v1/orders',
  query = {},
  headers = {},
  body = null,
  userId = 'user-A',
  role = 'authenticated',
  email = 'user-a@test.com',
} = {}) {
  return {
    httpMethod: method,
    path,
    queryStringParameters: Object.keys(query).length ? query : null,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    body: body ? JSON.stringify(body) : null,
    requestContext: {
      authorizer: { role, userId, email },
    },
  };
}

function findDataQuery(queries, prefix) {
  return queries.find(
    (q) => q.text.trimStart().startsWith(prefix)
      && !q.text.includes('pg_catalog'),
  );
}

// ================================================================
// INSERT authorization -- owner-conditioned policy
// ================================================================

describe('Cedar INSERT authz -- owner-conditioned policy', () => {
  let handler;
  let ctx;

  beforeEach(() => {
    ctx = createTestContext();
    ctx.schemaCache._resetCache();
    ctx.cedar._setPolicies({
      staticPolicies: OWNER_CONDITIONED_INSERT_POLICY,
    });
    handler = createRestHandler(ctx).handler;
  });

  it('Test 1: owner mismatch returns 403 PGRST403', async () => {
    const mockPool = createMockPool();
    ctx.db._setPool(mockPool);
    ctx.schemaCache._resetCache();

    const event = makeEvent({
      method: 'POST',
      path: '/rest/v1/orders',
      body: { owner_id: 'user-B', amount: 100 },
      userId: 'user-A',
      role: 'authenticated',
      headers: { Prefer: 'return=representation' },
    });
    const res = await handler(event);
    assert.equal(res.statusCode, 403,
      'INSERT with owner_id mismatch must return 403 (fail-open vulnerability regression)');
    const body = JSON.parse(res.body);
    assert.equal(body.code, 'PGRST403',
      'error code should be PGRST403');

    const insertQuery = findDataQuery(
      mockPool.capturedQueries, 'INSERT',
    );
    assert.equal(insertQuery, undefined,
      'no INSERT query should be executed when authorization denies');
  });

  it('Test 2: owner match returns 201', async () => {
    const mockPool = createMockPool();
    ctx.db._setPool(mockPool);
    ctx.schemaCache._resetCache();

    const event = makeEvent({
      method: 'POST',
      path: '/rest/v1/orders',
      body: { owner_id: 'user-A', amount: 100 },
      userId: 'user-A',
      role: 'authenticated',
      headers: { Prefer: 'return=representation' },
    });
    const res = await handler(event);
    assert.equal(res.statusCode, 201,
      'INSERT with matching owner_id should return 201');

    const insertQuery = findDataQuery(
      mockPool.capturedQueries, 'INSERT',
    );
    assert.ok(insertQuery,
      'INSERT query should be executed when authorization allows');
  });

  it('Test 3: bulk insert with mixed ownership returns 403 with row index', async () => {
    const mockPool = createMockPool();
    ctx.db._setPool(mockPool);
    ctx.schemaCache._resetCache();

    const event = makeEvent({
      method: 'POST',
      path: '/rest/v1/orders',
      body: [
        { owner_id: 'user-A', amount: 50 },
        { owner_id: 'user-B', amount: 75 },
      ],
      userId: 'user-A',
      role: 'authenticated',
      headers: { Prefer: 'return=representation' },
    });
    const res = await handler(event);
    assert.equal(res.statusCode, 403,
      'bulk INSERT with mixed ownership must return 403');
    const body = JSON.parse(res.body);
    assert.equal(body.code, 'PGRST403',
      'error code should be PGRST403');
    assert.ok(
      body.details && body.details.includes('Row 1'),
      'details should include "Row 1" indicating the failing row index',
    );

    const insertQuery = findDataQuery(
      mockPool.capturedQueries, 'INSERT',
    );
    assert.equal(insertQuery, undefined,
      'no INSERT query should be executed when any row fails authorization');
  });

  it('Test 4: service_role bypass returns 201', async () => {
    const mockPool = createMockPool();
    ctx.db._setPool(mockPool);
    ctx.schemaCache._resetCache();

    const event = makeEvent({
      method: 'POST',
      path: '/rest/v1/orders',
      body: { owner_id: 'anyone', amount: 999 },
      role: 'service_role',
      userId: '',
      headers: { Prefer: 'return=representation' },
    });
    const res = await handler(event);
    assert.equal(res.statusCode, 201,
      'service_role INSERT should return 201 regardless of owner_id');

    const insertQuery = findDataQuery(
      mockPool.capturedQueries, 'INSERT',
    );
    assert.ok(insertQuery,
      'INSERT query should be executed for service_role');
  });

  it('Test 8: missing owner_id column returns 403 (fail-closed)', async () => {
    const mockPool = createMockPool();
    ctx.db._setPool(mockPool);
    ctx.schemaCache._resetCache();

    const event = makeEvent({
      method: 'POST',
      path: '/rest/v1/orders',
      body: { amount: 100 },
      userId: 'user-A',
      role: 'authenticated',
      headers: { Prefer: 'return=representation' },
    });
    const res = await handler(event);
    assert.equal(res.statusCode, 403,
      'INSERT without owner_id should return 403 (fail-closed on missing column)');
    const body = JSON.parse(res.body);
    assert.equal(body.code, 'PGRST403',
      'error code should be PGRST403');

    const insertQuery = findDataQuery(
      mockPool.capturedQueries, 'INSERT',
    );
    assert.equal(insertQuery, undefined,
      'no INSERT query should be executed when required column is missing');
  });
});

// ================================================================
// INSERT authorization -- unconditional policy (no row conditions)
// ================================================================

describe('Cedar INSERT authz -- unconditional policy', () => {
  let handler;
  let ctx;

  beforeEach(() => {
    ctx = createTestContext();
    ctx.schemaCache._resetCache();
    ctx.cedar._setPolicies({
      staticPolicies: UNCONDITIONAL_INSERT_POLICY,
    });
    handler = createRestHandler(ctx).handler;
  });

  it('Test 5: decided allow with no row conditions returns 201', async () => {
    const mockPool = createMockPool();
    ctx.db._setPool(mockPool);
    ctx.schemaCache._resetCache();

    const event = makeEvent({
      method: 'POST',
      path: '/rest/v1/posts',
      body: { title: 'Hello' },
      userId: 'user-A',
      role: 'authenticated',
      headers: { Prefer: 'return=representation' },
    });
    const res = await handler(event);
    assert.equal(res.statusCode, 201,
      'unconditional INSERT permit should return 201');

    const insertQuery = findDataQuery(
      mockPool.capturedQueries, 'INSERT',
    );
    assert.ok(insertQuery,
      'INSERT query should be executed for unconditional permit');
  });
});

// ================================================================
// INSERT authorization -- table permit + row forbid
// ================================================================

describe('Cedar INSERT authz -- table permit + row forbid', () => {
  let handler;
  let ctx;

  beforeEach(() => {
    ctx = createTestContext();
    ctx.schemaCache._resetCache();
    ctx.cedar._setPolicies({
      staticPolicies: TABLE_PERMIT_ROW_FORBID_POLICY,
    });
    handler = createRestHandler(ctx).handler;
  });

  it('Test 6: forbid residual with restricted=true returns 403', async () => {
    const mockPool = createMockPool();
    ctx.db._setPool(mockPool);
    ctx.schemaCache._resetCache();

    const event = makeEvent({
      method: 'POST',
      path: '/rest/v1/items',
      body: { name: 'ok', restricted: true },
      userId: 'user-A',
      role: 'authenticated',
      headers: { Prefer: 'return=representation' },
    });
    const res = await handler(event);
    assert.equal(res.statusCode, 403,
      'INSERT with restricted=true should return 403 (forbid residual)');

    const insertQuery = findDataQuery(
      mockPool.capturedQueries, 'INSERT',
    );
    assert.equal(insertQuery, undefined,
      'no INSERT query should be executed when forbid residual fires');
  });

  it('Test 7: forbid residual with restricted=false returns 201', async () => {
    const mockPool = createMockPool();
    ctx.db._setPool(mockPool);
    ctx.schemaCache._resetCache();

    const event = makeEvent({
      method: 'POST',
      path: '/rest/v1/items',
      body: { name: 'ok', restricted: false },
      userId: 'user-A',
      role: 'authenticated',
      headers: { Prefer: 'return=representation' },
    });
    const res = await handler(event);
    assert.equal(res.statusCode, 201,
      'INSERT with restricted=false should return 201 (forbid residual does not fire)');

    const insertQuery = findDataQuery(
      mockPool.capturedQueries, 'INSERT',
    );
    assert.ok(insertQuery,
      'INSERT query should be executed when forbid residual does not fire');
  });
});
