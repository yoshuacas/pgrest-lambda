import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from '../db/index.mjs';
import { createRestHandler } from '../handler.mjs';
import { createSchemaCache } from '../schema-cache.mjs';
import { createCedar } from '../cedar.mjs';

// --- Default Cedar policy text (matches design doc) ---

const DEFAULT_POLICIES = `
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

permit(
    principal is PgrestLambda::User,
    action == PgrestLambda::Action::"insert",
    resource is PgrestLambda::Table
);

permit(
    principal is PgrestLambda::ServiceRole,
    action,
    resource
);
`;

const PUBLIC_POSTS_POLICY = `${DEFAULT_POLICIES}

permit(
    principal,
    action == PgrestLambda::Action::"select",
    resource is PgrestLambda::Row
) when {
    context.table == "public_posts"
};
`;

const FORBID_DELETE_ARCHIVED_POLICY = `${DEFAULT_POLICIES}

forbid(
    principal,
    action == PgrestLambda::Action::"delete",
    resource is PgrestLambda::Row
) when {
    resource has status && resource.status == "archived"
};
`;

// --- Mock data for schema introspection ---

const mockColumnRows = [
  // todos table (with level and team_id for Cedar policies)
  { table_name: 'todos', column_name: 'id',
    data_type: 'text', is_nullable: false, column_default: null },
  { table_name: 'todos', column_name: 'user_id',
    data_type: 'text', is_nullable: false, column_default: null },
  { table_name: 'todos', column_name: 'title',
    data_type: 'text', is_nullable: true, column_default: null },
  { table_name: 'todos', column_name: 'status',
    data_type: 'text', is_nullable: true, column_default: null },
  { table_name: 'todos', column_name: 'level',
    data_type: 'integer', is_nullable: true, column_default: null },
  { table_name: 'todos', column_name: 'team_id',
    data_type: 'text', is_nullable: true, column_default: null },
  { table_name: 'todos', column_name: 'created_at',
    data_type: 'timestamp with time zone',
    is_nullable: false, column_default: 'now()' },
  // public_posts table
  { table_name: 'public_posts', column_name: 'id',
    data_type: 'text', is_nullable: false, column_default: null },
  { table_name: 'public_posts', column_name: 'title',
    data_type: 'text', is_nullable: true, column_default: null },
  { table_name: 'public_posts', column_name: 'body',
    data_type: 'text', is_nullable: true, column_default: null },
  // categories table (no user_id — tests default deny)
  { table_name: 'categories', column_name: 'id',
    data_type: 'text', is_nullable: false, column_default: null },
  { table_name: 'categories', column_name: 'name',
    data_type: 'text', is_nullable: false, column_default: null },
];

const mockPkRows = [
  { table_name: 'todos', column_name: 'id' },
  { table_name: 'public_posts', column_name: 'id' },
  { table_name: 'categories', column_name: 'id' },
];

// --- Mock pool that handles schema + data queries ---

function createMockPool() {
  const capturedQueries = [];
  const pool = {
    capturedQueries,
    query: async (text, values) => {
      capturedQueries.push({ text, values });
      // Schema introspection: columns
      if (text.includes('pg_catalog') && !text.includes('contype')) {
        return { rows: mockColumnRows };
      }
      // Schema introspection: primary keys
      if (text.includes('contype')) {
        return { rows: mockPkRows };
      }

      // COUNT query
      if (text.trimStart().startsWith('SELECT COUNT')) {
        return { rows: [{ count: '2' }] };
      }

      // SELECT query
      if (text.trimStart().startsWith('SELECT')) {
        return {
          rows: [
            {
              id: '1', user_id: 'alice', title: 'Todo 1',
              status: 'active', level: 3, team_id: 'team-1',
              created_at: '2026-01-01T00:00:00Z',
            },
            {
              id: '2', user_id: 'bob', title: 'Todo 2',
              status: 'done', level: 7, team_id: 'team-2',
              created_at: '2026-01-02T00:00:00Z',
            },
          ],
        };
      }

      // INSERT query
      if (text.trimStart().startsWith('INSERT')) {
        return {
          rows: [{
            id: 'new-id', title: 'test',
            status: null, created_at: '2026-01-01T00:00:00Z',
          }],
        };
      }

      // DELETE query
      if (text.trimStart().startsWith('DELETE')) {
        return {
          rows: [{
            id: '123', user_id: 'alice', title: 'Deleted',
            status: 'active', created_at: '2026-01-01T00:00:00Z',
          }],
        };
      }

      return { rows: [] };
    },
  };
  return pool;
}

// Helper: create wired-up instances for each test
function createTestContext(mockPool) {
  const db = createDb({});
  db._setPool(mockPool || createMockPool());

  const schemaCache = createSchemaCache({});

  const cedar = createCedar({ policiesPath: './policies' });

  return { db, schemaCache, cedar };
}

// Helper to build a Lambda API Gateway proxy event

function makeEvent({
  method = 'GET',
  path = '/rest/v1/todos',
  query = {},
  headers = {},
  body = null,
  userId = 'alice',
  role = 'authenticated',
  email = 'alice@test.com',
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

// Helper to find a non-introspection query by prefix

function findDataQuery(queries, prefix) {
  return queries.find(
    (q) => q.text.trimStart().startsWith(prefix)
      && !q.text.includes('pg_catalog'),
  );
}

// ================================================================
// Cedar integration — authenticated GET
// ================================================================

describe('Cedar integration — authenticated GET', () => {
  let handler;
  let ctx;

  beforeEach(() => {
    ctx = createTestContext();
    ctx.schemaCache._resetCache();
    ctx.cedar._setPolicies({ staticPolicies: DEFAULT_POLICIES });
    handler = createRestHandler(ctx).handler;
  });

  it('GET /rest/v1/todos returns only owned rows (backward compat)', async () => {
    const mockPool = createMockPool();
    ctx.db._setPool(mockPool);
    ctx.schemaCache._resetCache();

    const event = makeEvent({
      method: 'GET',
      path: '/rest/v1/todos',
      userId: 'alice',
      role: 'authenticated',
    });
    const res = await handler(event);
    assert.equal(res.statusCode, 200);

    const selectQuery = findDataQuery(mockPool.capturedQueries, 'SELECT');
    assert.ok(selectQuery,
      'should have captured a SELECT query');
    assert.ok(selectQuery.values.includes('alice'),
      'SQL values should include user ID "alice" for row filtering');
    assert.ok(selectQuery.text.includes('"user_id"'),
      'SQL should include user_id column reference');
  });

  it('service_role GET returns all rows (no authz WHERE)', async () => {
    const mockPool = createMockPool();
    ctx.db._setPool(mockPool);
    ctx.schemaCache._resetCache();

    const event = makeEvent({
      method: 'GET',
      path: '/rest/v1/todos',
      role: 'service_role',
      userId: '',
    });
    const res = await handler(event);
    assert.equal(res.statusCode, 200);

    const selectQuery = findDataQuery(mockPool.capturedQueries, 'SELECT');
    assert.ok(selectQuery,
      'should have captured a SELECT query');
    const whereIdx = selectQuery.text.indexOf('WHERE');
    const whereClause = whereIdx >= 0
      ? selectQuery.text.slice(whereIdx) : '';
    assert.ok(!whereClause.includes('user_id'),
      'WHERE clause should NOT include user_id for service_role');
  });

  it('anon GET denied by default policies returns 403 PGRST403', async () => {
    const event = makeEvent({
      method: 'GET',
      path: '/rest/v1/todos',
      role: 'anon',
      userId: '',
    });
    const res = await handler(event);
    assert.equal(res.statusCode, 403,
      'anon GET should return 403');
    const body = JSON.parse(res.body);
    assert.equal(body.code, 'PGRST403',
      'error code should be PGRST403');
  });
});

// ================================================================
// Cedar integration — INSERT
// ================================================================

describe('Cedar integration — INSERT', () => {
  let handler;
  let ctx;

  beforeEach(() => {
    ctx = createTestContext();
    ctx.schemaCache._resetCache();
    ctx.cedar._setPolicies({ staticPolicies: DEFAULT_POLICIES });
    handler = createRestHandler(ctx).handler;
  });

  it('authenticated INSERT allowed without user_id injection', async () => {
    const mockPool = createMockPool();
    ctx.db._setPool(mockPool);
    ctx.schemaCache._resetCache();

    const event = makeEvent({
      method: 'POST',
      path: '/rest/v1/todos',
      body: { title: 'test' },
      headers: { Prefer: 'return=representation' },
    });
    const res = await handler(event);
    assert.equal(res.statusCode, 201,
      'authenticated INSERT should return 201');

    const insertQuery = findDataQuery(
      mockPool.capturedQueries, 'INSERT',
    );
    assert.ok(insertQuery,
      'should have captured an INSERT query');
    // Should include only the columns from the request body
    assert.ok(insertQuery.text.includes('"title"'),
      'INSERT should include title column from body');
    // Should NOT force-inject user_id
    assert.ok(!insertQuery.text.includes('"user_id"'),
      'INSERT should NOT force-inject user_id column');
  });
});

// ================================================================
// Cedar integration — DELETE with forbid
// ================================================================

describe('Cedar integration — DELETE with forbid', () => {
  let handler;
  let ctx;

  beforeEach(() => {
    ctx = createTestContext();
    ctx.schemaCache._resetCache();
    ctx.cedar._setPolicies({
      staticPolicies: FORBID_DELETE_ARCHIVED_POLICY,
    });
    handler = createRestHandler(ctx).handler;
  });

  it('DELETE with forbid-archived policy includes NOT condition', async () => {
    const mockPool = createMockPool();
    ctx.db._setPool(mockPool);
    ctx.schemaCache._resetCache();

    const event = makeEvent({
      method: 'DELETE',
      path: '/rest/v1/todos',
      query: { id: 'eq.123' },
      headers: { Prefer: 'return=representation' },
    });
    const res = await handler(event);

    const deleteQuery = findDataQuery(
      mockPool.capturedQueries, 'DELETE',
    );
    assert.ok(deleteQuery,
      'should have captured a DELETE query');
    assert.ok(deleteQuery.text.includes('NOT'),
      'DELETE SQL should include NOT clause from forbid policy');
    assert.ok(deleteQuery.values.includes('archived'),
      'DELETE values should include "archived" from forbid policy');
  });
});

// ================================================================
// Cedar integration — custom public table
// ================================================================

describe('Cedar integration — custom public table', () => {
  let handler;
  let ctx;

  beforeEach(() => {
    ctx = createTestContext();
    ctx.schemaCache._resetCache();
    ctx.cedar._setPolicies({ staticPolicies: PUBLIC_POSTS_POLICY });
    handler = createRestHandler(ctx).handler;
  });

  it('anon GET on public_posts with custom policy returns 200', async () => {
    const mockPool = createMockPool();
    ctx.db._setPool(mockPool);
    ctx.schemaCache._resetCache();

    const event = makeEvent({
      method: 'GET',
      path: '/rest/v1/public_posts',
      role: 'anon',
      userId: '',
    });
    const res = await handler(event);
    assert.equal(res.statusCode, 200,
      'anon GET on public_posts should return 200');

    const selectQuery = findDataQuery(
      mockPool.capturedQueries, 'SELECT',
    );
    assert.ok(selectQuery,
      'should have captured a SELECT query');
    // No authorization filter should be applied for public table
    const whereIdx = selectQuery.text.indexOf('WHERE');
    const whereClause = whereIdx >= 0
      ? selectQuery.text.slice(whereIdx) : '';
    assert.ok(!whereClause.includes('user_id'),
      'public_posts query should not have user_id filter');
  });
});

// ================================================================
// Cedar integration — default deny
// ================================================================

describe('Cedar integration — default deny', () => {
  let handler;
  let ctx;

  beforeEach(() => {
    ctx = createTestContext();
    ctx.schemaCache._resetCache();
    ctx.cedar._setPolicies({ staticPolicies: DEFAULT_POLICIES });
    handler = createRestHandler(ctx).handler;
  });

  it('authenticated GET on table with no matching policy returns 403', async () => {
    const event = makeEvent({
      method: 'GET',
      path: '/rest/v1/categories',
      role: 'authenticated',
      userId: 'alice',
    });
    const res = await handler(event);
    assert.equal(res.statusCode, 403,
      'GET on categories (no user_id, no policy) should return 403');
    const body = JSON.parse(res.body);
    assert.equal(body.code, 'PGRST403',
      'error code should be PGRST403');
  });
});

// ================================================================
// Cedar integration — policy refresh
// ================================================================

describe('Cedar integration — policy refresh', () => {
  let handler;
  let ctx;

  beforeEach(() => {
    ctx = createTestContext();
    ctx.schemaCache._resetCache();
    ctx.cedar._setPolicies({ staticPolicies: DEFAULT_POLICIES });
    handler = createRestHandler(ctx).handler;
  });

  it('POST /rest/v1/_refresh reloads Cedar policies', async () => {
    // Initial state: anon denied on todos
    const event1 = makeEvent({
      method: 'GET',
      path: '/rest/v1/todos',
      role: 'anon',
      userId: '',
    });
    const res1 = await handler(event1);
    assert.equal(res1.statusCode, 403,
      'anon should be denied before policy refresh');

    // Trigger refresh (reloads schema + policies from disk).
    // _refresh is gated to service_role (sec H-6).
    ctx.schemaCache._resetCache();
    ctx.db._setPool(createMockPool());
    const refreshEvent = makeEvent({
      method: 'POST',
      path: '/rest/v1/_refresh',
      role: 'service_role',
    });
    const refreshRes = await handler(refreshEvent);
    assert.equal(refreshRes.statusCode, 200,
      '_refresh should return 200');

    // Simulate deploying new policies that allow anon on public_posts
    ctx.cedar._setPolicies({ staticPolicies: PUBLIC_POSTS_POLICY });

    // Now anon should be allowed on public_posts
    ctx.schemaCache._resetCache();
    ctx.db._setPool(createMockPool());
    const event2 = makeEvent({
      method: 'GET',
      path: '/rest/v1/public_posts',
      role: 'anon',
      userId: '',
    });
    const res2 = await handler(event2);
    assert.equal(res2.statusCode, 200,
      'anon should be allowed on public_posts after policy update');
  });
});

// ================================================================
// Cedar integration — combined filters
// ================================================================

describe('Cedar integration — combined filters', () => {
  let handler;
  let ctx;

  beforeEach(() => {
    ctx = createTestContext();
    ctx.schemaCache._resetCache();
    ctx.cedar._setPolicies({ staticPolicies: DEFAULT_POLICIES });
    handler = createRestHandler(ctx).handler;
  });

  it('PostgREST filters combined with Cedar conditions have correct param numbering', async () => {
    const mockPool = createMockPool();
    ctx.db._setPool(mockPool);
    ctx.schemaCache._resetCache();

    const event = makeEvent({
      method: 'GET',
      path: '/rest/v1/todos',
      query: { status: 'eq.active' },
      userId: 'alice',
    });
    const res = await handler(event);
    assert.equal(res.statusCode, 200);

    const selectQuery = findDataQuery(
      mockPool.capturedQueries, 'SELECT',
    );
    assert.ok(selectQuery,
      'should have captured a SELECT query');
    // PostgREST filter should be present
    assert.ok(selectQuery.values.includes('active'),
      'values should include PostgREST filter value "active"');
    // Cedar condition should be present
    assert.ok(selectQuery.values.includes('alice'),
      'values should include Cedar authz value "alice"');
    // Parameter numbers must not collide — check that all
    // $N placeholders are unique and sequential
    const params = selectQuery.text.match(/\$\d+/g) || [];
    const paramNums = params.map((p) => parseInt(p.slice(1), 10));
    const uniqueNums = [...new Set(paramNums)];
    assert.equal(paramNums.length, uniqueNums.length,
      'all parameter numbers should be unique');
  });
});

// ================================================================
// Cedar integration — backward compatibility
// ================================================================

describe('Cedar integration — backward compatibility', () => {
  let handler;
  let ctx;

  beforeEach(() => {
    ctx = createTestContext();
    ctx.schemaCache._resetCache();
    ctx.cedar._setPolicies({ staticPolicies: DEFAULT_POLICIES });
    handler = createRestHandler(ctx).handler;
  });

  it('same result set as old appendUserId for owned rows', async () => {
    const mockPool = createMockPool();
    ctx.db._setPool(mockPool);
    ctx.schemaCache._resetCache();

    const event = makeEvent({
      method: 'GET',
      path: '/rest/v1/todos',
      userId: 'user-A',
      role: 'authenticated',
    });
    const res = await handler(event);
    assert.equal(res.statusCode, 200);

    const selectQuery = findDataQuery(
      mockPool.capturedQueries, 'SELECT',
    );
    assert.ok(selectQuery,
      'should have captured a SELECT query');
    assert.ok(selectQuery.values.includes('user-A'),
      'SQL should filter on user_id = user-A');
    assert.ok(selectQuery.text.includes('"user_id"'),
      'SQL should reference user_id column');
  });

  it('service_role still sees all rows', async () => {
    const mockPool = createMockPool();
    ctx.db._setPool(mockPool);
    ctx.schemaCache._resetCache();

    const event = makeEvent({
      method: 'GET',
      path: '/rest/v1/todos',
      role: 'service_role',
      userId: '',
    });
    const res = await handler(event);
    assert.equal(res.statusCode, 200);

    const selectQuery = findDataQuery(
      mockPool.capturedQueries, 'SELECT',
    );
    assert.ok(selectQuery,
      'should have captured a SELECT query');
    // service_role should not have any user_id filtering
    assert.ok(!selectQuery.values.includes(''),
      'service_role should not bind empty userId');
    const whereIdx = selectQuery.text.indexOf('WHERE');
    const whereClause = whereIdx >= 0
      ? selectQuery.text.slice(whereIdx) : '';
    assert.ok(!whereClause.includes('user_id'),
      'service_role should not have user_id in WHERE clause');
  });
});
