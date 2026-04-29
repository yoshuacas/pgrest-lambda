import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from '../db/index.mjs';
import { createRestHandler } from '../handler.mjs';
import { createSchemaCache } from '../schema-cache.mjs';
import { createCedar } from '../cedar.mjs';

// --- Default Cedar policies ---

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

// --- Mock data for schema introspection ---

const mockColumnRows = [
  { table_name: 'todos', column_name: 'id',
    data_type: 'text', is_nullable: false, column_default: null },
  { table_name: 'todos', column_name: 'user_id',
    data_type: 'text', is_nullable: false, column_default: null },
  { table_name: 'todos', column_name: 'title',
    data_type: 'text', is_nullable: true, column_default: null },
  { table_name: 'todos', column_name: 'status',
    data_type: 'text', is_nullable: true, column_default: null },
  { table_name: 'todos', column_name: 'created_at',
    data_type: 'timestamp with time zone',
    is_nullable: false, column_default: 'now()' },
];

const mockPkRows = [
  { table_name: 'todos', column_name: 'id' },
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
        if (values && values.includes('nonexistent')) {
          return { rows: [] };
        }
        if (values && values.includes('abc')) {
          return {
            rows: [{
              id: 'abc', user_id: 'user-1', title: 'Test todo',
              status: 'active', created_at: '2026-01-01T00:00:00Z',
            }],
          };
        }
        // Default: return 2 rows
        return {
          rows: [
            { id: '1', user_id: 'user-1', title: 'Todo 1',
              status: 'active', created_at: '2026-01-01T00:00:00Z' },
            { id: '2', user_id: 'user-1', title: 'Todo 2',
              status: 'done', created_at: '2026-01-02T00:00:00Z' },
          ],
        };
      }

      // INSERT query
      if (text.trimStart().startsWith('INSERT')) {
        return {
          rows: [{
            id: 'new-id', user_id: 'user-1', title: 'New todo',
            status: null, created_at: '2026-01-01T00:00:00Z',
          }],
        };
      }

      // UPDATE query
      if (text.trimStart().startsWith('UPDATE')) {
        return {
          rows: [{
            id: 'abc', user_id: 'user-1', title: 'Updated',
            status: 'active', created_at: '2026-01-01T00:00:00Z',
          }],
        };
      }

      // DELETE query
      if (text.trimStart().startsWith('DELETE')) {
        return {
          rows: [{
            id: 'abc', user_id: 'user-1', title: 'Deleted',
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
  cedar._setPolicies({ staticPolicies: DEFAULT_POLICIES });

  return { db, schemaCache, cedar };
}

// Helper to build a Lambda API Gateway proxy event
function makeEvent({
  method = 'GET',
  path = '/rest/v1/todos',
  query = {},
  headers = {},
  body = null,
  rawBody = undefined,
  userId = 'user-1',
  role = 'authenticated',
  email = '',
} = {}) {
  return {
    httpMethod: method,
    path,
    queryStringParameters: Object.keys(query).length ? query : null,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    body: rawBody !== undefined ? rawBody : (body ? JSON.stringify(body) : null),
    requestContext: {
      authorizer: { role, userId, email },
    },
  };
}

describe('handler integration', () => {
  let handler;
  let ctx;

  beforeEach(() => {
    ctx = createTestContext();
    handler = createRestHandler(ctx).handler;
  });

  describe('CRUD operations', () => {
    it('GET /rest/v1/todos returns 200 with bare JSON array', async () => {
      const event = makeEvent({ method: 'GET', path: '/rest/v1/todos' });
      const res = await handler(event);
      assert.equal(res.statusCode, 200,
        'GET should return 200');
      const body = JSON.parse(res.body);
      assert.ok(Array.isArray(body),
        'body should be a bare JSON array');
    });

    it('POST /rest/v1/todos with body returns 201', async () => {
      const event = makeEvent({
        method: 'POST',
        path: '/rest/v1/todos',
        body: { title: 'New todo' },
        headers: { Prefer: 'return=representation' },
      });
      const res = await handler(event);
      assert.equal(res.statusCode, 201,
        'POST should return 201');
      const body = JSON.parse(res.body);
      assert.ok(Array.isArray(body),
        'POST with representation should return array');
    });

    it('PATCH /rest/v1/todos?id=eq.abc returns 200 with updated rows', async () => {
      const event = makeEvent({
        method: 'PATCH',
        path: '/rest/v1/todos',
        query: { id: 'eq.abc' },
        body: { title: 'Updated' },
        headers: { Prefer: 'return=representation' },
      });
      const res = await handler(event);
      assert.equal(res.statusCode, 200,
        'PATCH should return 200');
      const body = JSON.parse(res.body);
      assert.ok(Array.isArray(body),
        'PATCH with representation should return array');
    });

    it('DELETE /rest/v1/todos?id=eq.abc returns 200 with deleted rows', async () => {
      const event = makeEvent({
        method: 'DELETE',
        path: '/rest/v1/todos',
        query: { id: 'eq.abc' },
        headers: { Prefer: 'return=representation' },
      });
      const res = await handler(event);
      assert.equal(res.statusCode, 200,
        'DELETE should return 200');
      const body = JSON.parse(res.body);
      assert.ok(Array.isArray(body),
        'DELETE with representation should return array');
    });
  });

  describe('special routes', () => {
    it('GET /rest/v1/ returns 200 with valid OpenAPI spec', async () => {
      const event = makeEvent({ method: 'GET', path: '/rest/v1/' });
      const res = await handler(event);
      assert.equal(res.statusCode, 200,
        'OpenAPI route should return 200');
      const body = JSON.parse(res.body);
      assert.ok(body.openapi || body.paths,
        'body should be an OpenAPI spec');
    });

    it('POST /rest/v1/_refresh returns 200 for service_role', async () => {
      // Refresh is gated to service_role (sec H-6). Test with the
      // default authenticated role lives in the H-6 describe block.
      const event = makeEvent({
        method: 'POST', path: '/rest/v1/_refresh', role: 'service_role',
      });
      const res = await handler(event);
      assert.equal(res.statusCode, 200,
        'refresh route should return 200 for service_role');
    });
  });

  describe('error handling', () => {
    it('GET /rest/v1/nonexistent returns 404 with PGRST205', async () => {
      const event = makeEvent({ method: 'GET', path: '/rest/v1/nonexistent' });
      const res = await handler(event);
      assert.equal(res.statusCode, 404,
        'unknown table should return 404');
      const body = JSON.parse(res.body);
      assert.equal(body.code, 'PGRST205',
        'error code should be PGRST205');
    });

    it('GET /rest/v1/todos?badcol=eq.x returns 400 with PGRST204', async () => {
      const event = makeEvent({
        method: 'GET',
        path: '/rest/v1/todos',
        query: { badcol: 'eq.x' },
      });
      const res = await handler(event);
      assert.equal(res.statusCode, 400,
        'unknown column in filter should return 400');
      const body = JSON.parse(res.body);
      assert.equal(body.code, 'PGRST204',
        'error code should be PGRST204');
    });

    it('PATCH /rest/v1/todos without filters returns 400 with PGRST106', async () => {
      const event = makeEvent({
        method: 'PATCH',
        path: '/rest/v1/todos',
        body: { title: 'Updated' },
      });
      const res = await handler(event);
      assert.equal(res.statusCode, 400,
        'PATCH without filters should return 400');
      const body = JSON.parse(res.body);
      assert.equal(body.code, 'PGRST106',
        'error code should be PGRST106');
    });

    it('DELETE /rest/v1/todos without filters returns 400 with PGRST106', async () => {
      const event = makeEvent({
        method: 'DELETE',
        path: '/rest/v1/todos',
      });
      const res = await handler(event);
      assert.equal(res.statusCode, 400,
        'DELETE without filters should return 400');
      const body = JSON.parse(res.body);
      assert.equal(body.code, 'PGRST106',
        'error code should be PGRST106');
    });

    it('POST /rest/v1/todos with missing body returns 400 with PGRST100', async () => {
      const event = makeEvent({
        method: 'POST',
        path: '/rest/v1/todos',
        body: null,
      });
      // body is null in the event
      event.body = null;
      const res = await handler(event);
      assert.equal(res.statusCode, 400,
        'POST without body should return 400');
      const body = JSON.parse(res.body);
      assert.equal(body.code, 'PGRST100',
        'error code should be PGRST100');
    });
  });

  describe('user isolation', () => {
    it('user_id is bound in SQL WHERE for per-user filtering', async () => {
      const queries = [];
      const capturingPool = {
        query: async (text, values) => {
          queries.push({ text, values });
          if (text.includes('pg_catalog') && !text.includes('contype')) {
            return { rows: mockColumnRows };
          }
          if (text.includes('contype')) {
            return { rows: mockPkRows };
          }
          return { rows: [
            { id: 'abc', user_id: 'user-1', title: 'Buy milk' },
            { id: 'def', user_id: 'user-1', title: 'Walk dog' },
          ] };
        },
      };
      ctx.db._setPool(capturingPool);
      // Need a fresh schema cache for each call
      ctx.schemaCache._resetCache();

      const eventA = makeEvent({
        method: 'GET',
        path: '/rest/v1/todos',
        userId: 'user-A',
      });
      await handler(eventA);

      // Find the SELECT query (not schema introspection)
      const selectA = queries.find((q) =>
        q.text.startsWith('SELECT') && !q.text.includes('pg_catalog'),
      );
      assert.ok(selectA, 'should have executed a SELECT query for user A');
      assert.ok(selectA.values.includes('user-A'),
        'user-A should be bound in SQL parameters');

      // Reset and test user B
      queries.length = 0;
      ctx.schemaCache._resetCache();
      ctx.db._setPool(capturingPool);

      const eventB = makeEvent({
        method: 'GET',
        path: '/rest/v1/todos',
        userId: 'user-B',
      });
      await handler(eventB);

      const selectB = queries.find((q) =>
        q.text.startsWith('SELECT') && !q.text.includes('pg_catalog'),
      );
      assert.ok(selectB, 'should have executed a SELECT query for user B');
      assert.ok(selectB.values.includes('user-B'),
        'user-B should be bound in SQL parameters');
    });

    it('Lambda authorizer userId is used in SQL query', async () => {
      const queries = [];
      const capturingPool = {
        query: async (text, values) => {
          queries.push({ text, values });
          if (text.includes('pg_catalog') && !text.includes('contype')) {
            return { rows: mockColumnRows };
          }
          if (text.includes('contype')) {
            return { rows: mockPkRows };
          }
          return { rows: [
            { id: 'abc', user_id: 'user-1', title: 'Buy milk' },
            { id: 'def', user_id: 'user-1', title: 'Walk dog' },
          ] };
        },
      };
      ctx.db._setPool(capturingPool);

      const event = makeEvent({
        method: 'GET',
        path: '/rest/v1/todos',
        userId: 'user-1',
      });
      const res = await handler(event);
      assert.equal(res.statusCode, 200);

      const selectQ = queries.find((q) =>
        q.text.startsWith('SELECT') && !q.text.includes('pg_catalog'),
      );
      assert.ok(selectQ.values.includes('user-1'),
        'user-1 from Lambda authorizer should be bound in SQL');
    });
  });

  describe('CORS', () => {
    it('OPTIONS returns 200 with CORS headers', async () => {
      const event = makeEvent({ method: 'OPTIONS', path: '/rest/v1/todos' });
      const res = await handler(event);
      assert.equal(res.statusCode, 200,
        'OPTIONS should return 200');
      assert.equal(res.headers['Access-Control-Allow-Origin'], '*',
        'should have Allow-Origin');
      assert.ok(res.headers['Access-Control-Allow-Methods']?.includes('PATCH'),
        'Allow-Methods should include PATCH');
      assert.ok(res.headers['Access-Control-Allow-Headers']?.includes('apikey'),
        'Allow-Headers should include apikey');
      assert.ok(res.headers['Access-Control-Allow-Headers']?.includes('X-Client-Info'),
        'Allow-Headers should include X-Client-Info');
      assert.ok(res.headers['Access-Control-Expose-Headers']?.includes('Content-Range'),
        'Expose-Headers should include Content-Range');
    });
  });

  describe('Prefer headers', () => {
    it('GET with Prefer: count=exact includes count in Content-Range', async () => {
      const event = makeEvent({
        method: 'GET',
        path: '/rest/v1/todos',
        headers: { Prefer: 'count=exact' },
      });
      const res = await handler(event);
      assert.equal(res.statusCode, 200);
      const cr = res.headers['Content-Range'];
      assert.ok(cr, 'Content-Range header should be present');
      // Should contain a slash followed by a number (not *)
      assert.ok(/\/\d+/.test(cr),
        'Content-Range should include exact count (e.g., 0-N/total)');
    });

    it('POST without Prefer: return=representation returns 201 empty', async () => {
      const event = makeEvent({
        method: 'POST',
        path: '/rest/v1/todos',
        body: { title: 'New' },
      });
      const res = await handler(event);
      assert.equal(res.statusCode, 201,
        'POST should return 201');
      assert.ok(!res.body || res.body === '' || res.body === 'null',
        'body should be empty without return=representation');
    });
  });

  describe('Content-Range for empty results', () => {
    it('returns */* for empty results without count', async () => {
      const event = makeEvent({
        method: 'GET',
        path: '/rest/v1/todos',
        query: { id: 'eq.nonexistent' },
      });
      const res = await handler(event);
      assert.equal(res.statusCode, 200);
      const cr = res.headers['Content-Range'];
      assert.ok(cr, 'Content-Range should be present');
      assert.ok(cr.startsWith('*/'),
        `Content-Range for empty results should start with */: got "${cr}"`);
    });
  });

  describe('body validation', () => {
    it('PATCH without body returns 400 with PGRST100', async () => {
      const event = makeEvent({
        method: 'PATCH',
        path: '/rest/v1/todos',
        query: { id: 'eq.abc' },
      });
      // Ensure body is null
      event.body = null;
      const res = await handler(event);
      assert.equal(res.statusCode, 400,
        'PATCH without body should return 400');
      const body = JSON.parse(res.body);
      assert.equal(body.code, 'PGRST100',
        'error code should be PGRST100');
    });

    it('malformed JSON body returns 400 with PGRST100', async () => {
      const event = makeEvent({
        method: 'POST',
        path: '/rest/v1/todos',
        rawBody: 'not json{',
      });
      const res = await handler(event);
      assert.equal(res.statusCode, 400,
        'malformed JSON should return 400');
      const body = JSON.parse(res.body);
      assert.equal(body.code, 'PGRST100',
        'error code should be PGRST100');
    });
  });

  describe('_refresh method restriction', () => {
    it('GET /rest/v1/_refresh returns 405', async () => {
      const event = makeEvent({
        method: 'GET',
        path: '/rest/v1/_refresh',
      });
      const res = await handler(event);
      assert.equal(res.statusCode, 405,
        'GET on _refresh should return 405');
    });
  });

  describe('PATCH/DELETE without Prefer', () => {
    it('PATCH with body and no Prefer returns 204 with empty body', async () => {
      const event = makeEvent({
        method: 'PATCH',
        path: '/rest/v1/todos',
        query: { id: 'eq.abc' },
        body: { title: 'Updated' },
      });
      const res = await handler(event);
      assert.equal(res.statusCode, 204,
        'PATCH without Prefer should return 204');
      assert.ok(!res.body || res.body === '',
        'body should be empty');
    });

    it('DELETE with no Prefer returns 204 with empty body', async () => {
      const event = makeEvent({
        method: 'DELETE',
        path: '/rest/v1/todos',
        query: { id: 'eq.abc' },
      });
      const res = await handler(event);
      assert.equal(res.statusCode, 204,
        'DELETE without Prefer should return 204');
      assert.ok(!res.body || res.body === '',
        'body should be empty');
    });
  });

  describe('single object mode', () => {
    it('returns single object with Accept: application/vnd.pgrst.object+json and 1 row', async () => {
      const event = makeEvent({
        method: 'GET',
        path: '/rest/v1/todos',
        query: { id: 'eq.abc' },
        headers: { Accept: 'application/vnd.pgrst.object+json' },
      });
      const res = await handler(event);
      // Should either return 200 with object or succeed
      assert.equal(res.statusCode, 200,
        'single object mode should return 200');
      const body = JSON.parse(res.body);
      assert.ok(!Array.isArray(body),
        'body should be a single object, not array');
    });

    it('returns 406 with PGRST116 for single object with 0 rows', async () => {
      const event = makeEvent({
        method: 'GET',
        path: '/rest/v1/todos',
        query: { id: 'eq.nonexistent' },
        headers: { Accept: 'application/vnd.pgrst.object+json' },
      });
      const res = await handler(event);
      assert.equal(res.statusCode, 406,
        'should return 406 for 0 rows in single object mode');
      const body = JSON.parse(res.body);
      assert.equal(body.code, 'PGRST116',
        'error code should be PGRST116');
    });

    it('returns 406 with PGRST116 for single object with >1 rows', async () => {
      const event = makeEvent({
        method: 'GET',
        path: '/rest/v1/todos',
        headers: { Accept: 'application/vnd.pgrst.object+json' },
      });
      // Default query returns multiple rows from mock
      const res = await handler(event);
      assert.equal(res.statusCode, 406,
        'should return 406 for >1 rows in single object mode');
      const body = JSON.parse(res.body);
      assert.equal(body.code, 'PGRST116',
        'error code should be PGRST116');
    });
  });

  describe('service_role bypass', () => {
    it('service_role skips user_id filter in SQL', async () => {
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

      // Find the SELECT query (not schema introspection)
      const selectQuery = mockPool.capturedQueries.find(
        q => q.text.trimStart().startsWith('SELECT') && !q.text.includes('pg_catalog')
      );
      assert.ok(selectQuery, 'should have captured a SELECT query');
      const whereIdx = selectQuery.text.indexOf('WHERE');
      const whereClause = whereIdx >= 0 ? selectQuery.text.slice(whereIdx) : '';
      assert.ok(
        !whereClause.includes('user_id'),
        'WHERE clause should NOT include user_id filter for service_role'
      );
    });
  });

  describe('user_id binding', () => {
    it('binds correct user_id for authenticated requests', async () => {
      const mockPool = createMockPool();
      ctx.db._setPool(mockPool);
      ctx.schemaCache._resetCache();

      const event = makeEvent({
        method: 'GET',
        path: '/rest/v1/todos',
        userId: 'specific-user-abc',
        role: 'authenticated',
      });
      const res = await handler(event);
      assert.equal(res.statusCode, 200);

      const selectQuery = mockPool.capturedQueries.find(
        q => q.text.trimStart().startsWith('SELECT') && !q.text.includes('pg_catalog')
      );
      assert.ok(selectQuery, 'should have captured a SELECT query');
      assert.ok(
        selectQuery.values.includes('specific-user-abc'),
        'SQL values should include the authenticated user_id'
      );
    });
  });

  describe('PATCH/DELETE with invalid body', () => {
    it('PATCH with malformed JSON body returns 400', async () => {
      const event = makeEvent({
        method: 'PATCH',
        path: '/rest/v1/todos',
        query: { id: 'eq.abc' },
      });
      event.body = '{{invalid json';
      const res = await handler(event);
      assert.equal(res.statusCode, 400,
        'PATCH with malformed JSON should return 400');
      const body = JSON.parse(res.body);
      assert.equal(body.code, 'PGRST100');
    });

    it('PATCH with null body returns 400', async () => {
      const event = makeEvent({
        method: 'PATCH',
        path: '/rest/v1/todos',
        query: { id: 'eq.abc' },
      });
      event.body = null;
      const res = await handler(event);
      assert.equal(res.statusCode, 400,
        'PATCH with null body should return 400');
    });
  });

  describe('router trailing slash', () => {
    it('GET /rest/v1/todos/ strips trailing slash and works', async () => {
      const event = makeEvent({ method: 'GET', path: '/rest/v1/todos/' });
      const res = await handler(event);
      assert.equal(res.statusCode, 200,
        'trailing slash should resolve to todos table');
    });
  });

  describe('CORS headers on REST responses', () => {
    let corsHandler;

    beforeEach(() => {
      const corsCtx = createTestContext();
      corsCtx.cors = {
        allowedOrigins: ['https://app.com'],
        allowCredentials: false,
      };
      corsHandler = createRestHandler(corsCtx).handler;
    });

    it('OPTIONS with matching origin reflects it in Allow-Origin', async () => {
      const event = makeEvent({
        method: 'OPTIONS',
        path: '/rest/v1/todos',
        headers: { Origin: 'https://app.com' },
      });
      const res = await corsHandler(event);
      assert.equal(res.statusCode, 200, 'OPTIONS should return 200');
      assert.equal(
        res.headers['Access-Control-Allow-Origin'],
        'https://app.com',
        'Allow-Origin should reflect the matching origin',
      );
    });

    it('error response includes CORS headers for matching origin', async () => {
      const event = makeEvent({
        method: 'GET',
        path: '/rest/v1/nonexistent',
        headers: { Origin: 'https://app.com' },
      });
      const res = await corsHandler(event);
      assert.equal(res.statusCode, 404, 'should return 404 for unknown table');
      assert.equal(
        res.headers['Access-Control-Allow-Origin'],
        'https://app.com',
        'error response should include Allow-Origin for matching origin',
      );
    });
  });

  describe('POST /rest/v1/_refresh authorization (sec H-6)', () => {
    it('rejects anon with 401 PGRST301', async () => {
      const event = makeEvent({
        method: 'POST', path: '/rest/v1/_refresh', role: 'anon',
      });
      const res = await handler(event);
      assert.equal(res.statusCode, 401,
        'anon must not be allowed to trigger refresh');
      const body = JSON.parse(res.body);
      assert.equal(body.code, 'PGRST301');
    });

    it('rejects authenticated user with 401 PGRST301', async () => {
      const event = makeEvent({
        method: 'POST', path: '/rest/v1/_refresh', role: 'authenticated',
      });
      const res = await handler(event);
      assert.equal(res.statusCode, 401,
        'authenticated users must not refresh');
      const body = JSON.parse(res.body);
      assert.equal(body.code, 'PGRST301');
    });

    it('allows service_role with 200', async () => {
      const event = makeEvent({
        method: 'POST', path: '/rest/v1/_refresh', role: 'service_role',
      });
      const res = await handler(event);
      assert.equal(res.statusCode, 200,
        'service_role must be allowed to refresh');
    });

    it('returns 405 on GET even for service_role', async () => {
      const event = makeEvent({
        method: 'GET', path: '/rest/v1/_refresh', role: 'service_role',
      });
      const res = await handler(event);
      assert.equal(res.statusCode, 405,
        'GET remains blocked by existing method guard');
    });
  });
});
