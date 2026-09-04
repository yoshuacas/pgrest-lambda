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

  return { db, schemaCache, cedar, errorsVerbose: false };
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

    // A read field is not validated against the schema cache: upstream renders
    // every filter through `pgFmtField`, which qualifies it with the relation,
    // and lets PostgreSQL raise 42703 -> 400 (`column todos.badcol does not
    // exist`, QuerySpec.hs:1557 asserts that message verbatim). PGRST204 is
    // upstream's error for `?columns=`, `?on_conflict=` and mutation payload
    // keys only, so this test asserted an error the engine was wrong to raise;
    // the qualified spelling is also what makes a filter on a computed column
    // work (UpdateSpec.hs:144, :156). The mock pool cannot raise 42703, so what
    // is checked here is the SQL that reaches it.
    it('GET /rest/v1/todos?badcol=eq.x qualifies the unknown field so '
      + 'PostgreSQL raises 42703', async () => {
      const pool = createMockPool();
      const localHandler = createRestHandler(createTestContext(pool)).handler;
      const res = await localHandler(makeEvent({
        method: 'GET',
        path: '/rest/v1/todos',
        query: { badcol: 'eq.x' },
      }));
      assert.equal(res.statusCode, 200,
        'the mock pool answers the statement it is given');
      const read = pool.capturedQueries.find(qy =>
        qy.text.startsWith('SELECT') && qy.text.includes('FROM "todos"'));
      assert.ok(read, 'a read statement should have been sent');
      assert.match(read.text, /"todos"\."badcol" = \$\d+/);
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

    // Upstream answers a missing or unparseable mutation body with
    // 400 PGRST102 "Empty or invalid json" (ApiRequest/Payload.hs: `maybe
    // (Left "Empty or invalid json") Right $ JSON.decode reqBody`, and
    // `InvalidBody` is PGRST102/400 in Error.hs). PGRST100 is the
    // query-string parse error and never appears here — InsertSpec.hs:285/295
    // and UpdateSpec.hs:39/49 assert the PGRST102 body verbatim.
    it('POST /rest/v1/todos with missing body returns 400 with PGRST102', async () => {
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
      assert.equal(body.code, 'PGRST102',
        'error code should be PGRST102');
      assert.equal(body.message, 'Empty or invalid json');
    });

    it('catch-all 500 returns a generic message and errorId (sec L-20)', async () => {
      // Force an unexpected throw deep in the handler path by
      // installing a pool that always throws a raw Error.
      const badPool = {
        query: async () => { throw new Error('raw error with SELECT secret_col FROM internal_stuff'); },
      };
      const badCtx = createTestContext(badPool);
      badCtx.schemaCache._resetCache();
      badCtx.cedar._setPolicies({ staticPolicies: DEFAULT_POLICIES });
      const badHandler = createRestHandler(badCtx).handler;

      const event = makeEvent({ method: 'GET', path: '/rest/v1/todos' });
      const res = await badHandler(event);
      assert.equal(res.statusCode, 500);
      const body = JSON.parse(res.body);
      assert.equal(body.code, 'PGRST000');
      assert.match(body.message, /^Internal server error \(errorId: [0-9a-f]{8}\)$/,
        'message must be generic and include an errorId');
      assert.ok(!body.message.includes('secret_col'),
        'raw err.message must not leak into the response');
      assert.ok(!body.message.includes('internal_stuff'),
        'raw err.message must not leak into the response');
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
    // See the note above POST-with-missing-body: PGRST102 "Empty or invalid
    // json" is upstream's error for both of these.
    it('PATCH without body returns 400 with PGRST102', async () => {
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
      assert.equal(body.code, 'PGRST102',
        'error code should be PGRST102');
      assert.equal(body.message, 'Empty or invalid json');
    });

    it('malformed JSON body returns 400 with PGRST102', async () => {
      const event = makeEvent({
        method: 'POST',
        path: '/rest/v1/todos',
        rawBody: 'not json{',
      });
      const res = await handler(event);
      assert.equal(res.statusCode, 400,
        'malformed JSON should return 400');
      const body = JSON.parse(res.body);
      assert.equal(body.code, 'PGRST102',
        'error code should be PGRST102');
      assert.equal(body.message, 'Empty or invalid json');
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
      // PGRST102, not PGRST100: see ApiRequest/Payload.hs.
      assert.equal(body.code, 'PGRST102');
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

  describe('PG error sanitization (V-09)', () => {
    function createPgErrorPool() {
      const pgErr = new Error(
        'duplicate key value violates unique constraint "users_email_key"',
      );
      pgErr.code = '23505';
      pgErr.detail = 'Key (email)=(alice@example.com) already exists.';

      return {
        query: async (text) => {
          if (text.includes('pg_catalog') && !text.includes('contype')) {
            return { rows: mockColumnRows };
          }
          if (text.includes('contype')) {
            return { rows: mockPkRows };
          }
          throw pgErr;
        },
      };
    }

    // The handler forwards the server's own code/message/detail/hint, which is
    // what upstream does (PostgREST.Error, `instance ToJSON PgError`) and what
    // its test suite asserts. V-09's generic wording is still implemented in
    // errors.mjs behind `mapPgError(err, { sanitize: true })`; it is no longer
    // the default because it is not wire-compatible.
    it('PG error through handler forwards the server message', async () => {
      const errCtx = createTestContext(createPgErrorPool());
      const errHandler = createRestHandler(errCtx).handler;

      const event = makeEvent({
        method: 'POST',
        path: '/rest/v1/todos',
        body: { title: 'dup' },
        headers: { Prefer: 'return=representation' },
      });
      const res = await errHandler(event);
      const body = JSON.parse(res.body);

      assert.equal(res.statusCode, 409,
        'statusCode should be 409');
      assert.equal(body.code, '23505',
        'code should be 23505');
      assert.equal(body.message,
        'duplicate key value violates unique constraint "users_email_key"',
        'message should be the server message');
      assert.equal(body.details,
        'Key (email)=(alice@example.com) already exists.',
        'details should be the server detail');
      assert.equal(body.hint, null,
        'hint should be null — the source error carries none');
    });

    it('PG error through handler with verbose ctx uses raw text', async () => {
      const errCtx = createTestContext(createPgErrorPool());
      errCtx.errorsVerbose = true;
      const errHandler = createRestHandler(errCtx).handler;

      const event = makeEvent({
        method: 'POST',
        path: '/rest/v1/todos',
        body: { title: 'dup' },
        headers: { Prefer: 'return=representation' },
      });
      const res = await errHandler(event);
      const body = JSON.parse(res.body);

      assert.equal(res.statusCode, 409,
        'statusCode should be 409');
      assert.equal(body.code, '23505',
        'code should be 23505');
      assert.ok(body.message.includes('duplicate key'),
        'message should contain raw "duplicate key" text');
      assert.ok(body.details.includes('Key (email)'),
        'details should contain raw "Key (email)" text');
    });

    it('structured log emitted for sanitized PG error', async () => {
      const errCtx = createTestContext(createPgErrorPool());
      const errHandler = createRestHandler(errCtx).handler;

      const warns = [];
      const origWarn = console.warn;
      console.warn = (...args) => warns.push(args);

      try {
        const event = makeEvent({
          method: 'POST',
          path: '/rest/v1/todos',
          body: { title: 'dup' },
          headers: { Prefer: 'return=representation' },
        });
        await errHandler(event);

        const logEntry = warns.find((args) => {
          try {
            const parsed = JSON.parse(args[0]);
            return parsed.pgCode && parsed.message && parsed.detail;
          } catch { return false; }
        });
        assert.ok(logEntry,
          'console.warn should have been called with a JSON '
          + 'string containing pgCode, message, and detail');

        const parsed = JSON.parse(logEntry[0]);
        assert.equal(parsed.pgCode, '23505',
          'pgCode should be 23505');
        assert.ok(parsed.message.includes('duplicate'),
          'logged message should contain raw PG text');
        assert.ok(parsed.detail.includes('Key (email)'),
          'logged detail should contain raw PG detail');
      } finally {
        console.warn = origWarn;
      }
    });

    it('verbose mode does not emit structured PG log', async () => {
      const errCtx = createTestContext(createPgErrorPool());
      errCtx.errorsVerbose = true;
      const errHandler = createRestHandler(errCtx).handler;

      const warns = [];
      const origWarn = console.warn;
      console.warn = (...args) => warns.push(args);

      try {
        const event = makeEvent({
          method: 'POST',
          path: '/rest/v1/todos',
          body: { title: 'dup' },
          headers: { Prefer: 'return=representation' },
        });
        await errHandler(event);

        const pgLogEntry = warns.find((args) => {
          try {
            const parsed = JSON.parse(args[0]);
            return parsed.pgCode !== undefined;
          } catch { return false; }
        });
        assert.equal(pgLogEntry, undefined,
          'console.warn should not emit a structured PG error '
          + 'log entry in verbose mode');
      } finally {
        console.warn = origWarn;
      }
    });

    it('PG error with hint reaches the client', async () => {
      function createHintErrorPool() {
        const pgErr = new Error(
          'could not obtain lock on relation "accounts"',
        );
        pgErr.code = '55P03';
        pgErr.detail = 'Process 1234 waits for ...';
        pgErr.hint = 'See server log for query details.';

        return {
          query: async (text) => {
            if (text.includes('pg_catalog')
                && !text.includes('contype')) {
              return { rows: mockColumnRows };
            }
            if (text.includes('contype')) {
              return { rows: mockPkRows };
            }
            throw pgErr;
          },
        };
      }

      const errCtx = createTestContext(createHintErrorPool());
      const errHandler = createRestHandler(errCtx).handler;

      const event = makeEvent({
        method: 'POST',
        path: '/rest/v1/todos',
        body: { title: 'test' },
        headers: { Prefer: 'return=representation' },
      });
      const res = await errHandler(event);
      const body = JSON.parse(res.body);

      assert.equal(body.hint, 'See server log for query details.',
        'hint should be the server hint');
      assert.equal(body.details, 'Process 1234 waits for ...',
        'details should be the server detail');
      assert.equal(body.code, '55P03',
        'code should be preserved');
    });

    it('PG error with hint verbose in handler', async () => {
      function createHintErrorPool() {
        const pgErr = new Error(
          'could not obtain lock on relation "accounts"',
        );
        pgErr.code = '55P03';
        pgErr.detail = 'Process 1234 waits for ...';
        pgErr.hint = 'See server log for query details.';

        return {
          query: async (text) => {
            if (text.includes('pg_catalog')
                && !text.includes('contype')) {
              return { rows: mockColumnRows };
            }
            if (text.includes('contype')) {
              return { rows: mockPkRows };
            }
            throw pgErr;
          },
        };
      }

      const errCtx = createTestContext(createHintErrorPool());
      errCtx.errorsVerbose = true;
      const errHandler = createRestHandler(errCtx).handler;

      const event = makeEvent({
        method: 'POST',
        path: '/rest/v1/todos',
        body: { title: 'test' },
        headers: { Prefer: 'return=representation' },
      });
      const res = await errHandler(event);
      const body = JSON.parse(res.body);

      assert.equal(body.hint,
        'See server log for query details.',
        'hint should be preserved in verbose mode');
      assert.equal(body.details,
        'Process 1234 waits for ...',
        'details should be preserved in verbose mode');
      assert.equal(body.code, '55P03',
        'code should be preserved');
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

  describe('HTTP protocol headers', () => {
    it('GET carries Content-Range and the JSON charset', async () => {
      const res = await handler(makeEvent({ method: 'GET' }));
      assert.equal(res.statusCode, 200);
      assert.equal(res.headers['Content-Range'], '0-1/*');
      assert.equal(res.headers['Content-Type'],
        'application/json; charset=utf-8');
    });

    it('HEAD returns the GET headers with no body', async () => {
      const get = await handler(makeEvent({ method: 'GET' }));
      const head = await handler(makeEvent({ method: 'HEAD' }));
      assert.equal(head.statusCode, get.statusCode);
      assert.equal(head.headers['Content-Range'], get.headers['Content-Range']);
      assert.equal(head.headers['Content-Type'], get.headers['Content-Type']);
      assert.equal(head.body, '', 'HEAD must not carry a body');
    });

    it('applies the Range header on GET', async () => {
      const pool = createMockPool();
      const local = createRestHandler(createTestContext(pool)).handler;
      const res = await local(makeEvent({
        method: 'GET', headers: { Range: 'items=1-1' },
      }));
      const select = pool.capturedQueries
        .filter(q => q.text.trimStart().startsWith('SELECT'))
        .pop();
      assert.match(select.text, /LIMIT/,
        'the Range header should become a LIMIT');
      assert.equal(res.headers['Content-Range'].startsWith('1-'), true,
        `lower bound should follow the Range header, got `
        + `${res.headers['Content-Range']}`);
    });

    it('ignores the Range header on HEAD', async () => {
      // Upstream reads the header only when the raw method is GET
      // (ApiRequest.getRanges), so a HEAD range is a no-op.
      const pool = createMockPool();
      const local = createRestHandler(createTestContext(pool)).handler;
      const res = await local(makeEvent({
        method: 'HEAD', headers: { Range: 'items=1-1' },
      }));
      const select = pool.capturedQueries
        .filter(q => q.text.trimStart().startsWith('SELECT'))
        .pop();
      assert.doesNotMatch(select.text, /LIMIT/,
        'HEAD must not turn the Range header into a LIMIT');
      assert.equal(res.headers['Content-Range'], '0-1/*');
    });

    it('reports the total and 206 for Prefer: count=exact', async () => {
      const res = await handler(makeEvent({
        method: 'GET', query: { limit: '1' },
        headers: { Prefer: 'count=exact' },
      }));
      // mock COUNT returns 2, the mock SELECT returns 2 rows
      assert.equal(res.headers['Content-Range'], '0-1/2');
      assert.equal(res.headers['Preference-Applied'], 'count=exact');
    });

    it('sends no Content-Type on a 204', async () => {
      const res = await handler(makeEvent({
        method: 'PATCH', query: { id: 'eq.abc' },
        body: { title: 'x' },
      }));
      assert.equal(res.statusCode, 204);
      assert.equal(res.headers['Content-Type'], undefined,
        'a bodyless response must not claim a media type');
      assert.equal(res.body, '');
    });

    it('uses the update Content-Range form on PATCH', async () => {
      const res = await handler(makeEvent({
        method: 'PATCH', query: { id: 'eq.abc' },
        body: { title: 'x' },
        headers: { Prefer: 'return=representation' },
      }));
      assert.equal(res.statusCode, 200);
      assert.equal(res.headers['Content-Range'], '0-0/*');
      assert.equal(res.headers['Preference-Applied'], 'return=representation');
    });

    it('uses the delete Content-Range form on DELETE', async () => {
      const res = await handler(makeEvent({
        method: 'DELETE', query: { id: 'eq.abc' },
      }));
      assert.equal(res.statusCode, 204);
      assert.equal(res.headers['Content-Range'], '*/*');
    });

    it('uses the insert Content-Range form on POST', async () => {
      const res = await handler(makeEvent({
        method: 'POST', body: { title: 'x' },
      }));
      assert.equal(res.statusCode, 201);
      assert.equal(res.headers['Content-Range'], '*/*');
    });

    it('states Content-Length 0 on a bodyless 201', async () => {
      const res = await handler(makeEvent({
        method: 'POST', body: { title: 'x' },
        headers: { Prefer: 'return=minimal' },
      }));
      assert.equal(res.statusCode, 201);
      assert.equal(res.headers['Content-Length'], '0');
      assert.equal(res.headers['Content-Type'], undefined);
      assert.equal(res.body, '');
    });

    it('sends no Content-Length on a 204', async () => {
      const res = await handler(makeEvent({
        method: 'DELETE', query: { id: 'eq.abc' },
      }));
      assert.equal(res.statusCode, 204);
      assert.equal(res.headers['Content-Length'], undefined);
    });

    it('returns the singular media type for vnd.pgrst.object+json',
      async () => {
        const res = await handler(makeEvent({
          method: 'GET', query: { id: 'eq.abc' },
          headers: { Accept: 'application/vnd.pgrst.object+json' },
        }));
        assert.equal(res.statusCode, 200);
        assert.equal(res.headers['Content-Type'],
          'application/vnd.pgrst.object+json; charset=utf-8');
        assert.equal(Array.isArray(JSON.parse(res.body)), false);
      });

    it('rejects an invalid Prefer under handling=strict with PGRST122',
      async () => {
        const res = await handler(makeEvent({
          method: 'GET', headers: { Prefer: 'handling=strict, foo=bar' },
        }));
        assert.equal(res.statusCode, 400);
        const body = JSON.parse(res.body);
        assert.equal(body.code, 'PGRST122');
        assert.equal(body.details, 'Invalid preferences: foo=bar');
      });

    it('ignores an invalid Prefer without handling=strict', async () => {
      const res = await handler(makeEvent({
        method: 'GET', headers: { Prefer: 'foo=bar' },
      }));
      assert.equal(res.statusCode, 200);
      assert.equal(res.headers['Preference-Applied'], undefined);
    });
  });

  describe('PUT single-row upsert', () => {
    it('upserts the row the primary key pins', async () => {
      const res = await handler(makeEvent({
        method: 'PUT', query: { id: 'eq.abc' },
        body: { id: 'abc', user_id: 'user-1', title: 'x' },
        role: 'service_role',
      }));
      // No Prefer: return, so upstream answers 204 with no body
      // (Response.hs, MutationSingleUpsert).
      assert.equal(res.statusCode, 204);
      assert.equal(res.headers['Content-Range'], undefined,
        'upstream sends no Content-Range on a single upsert');
    });

    it('returns the row for return=representation', async () => {
      const res = await handler(makeEvent({
        method: 'PUT', query: { id: 'eq.abc' },
        body: { id: 'abc', user_id: 'user-1', title: 'x' },
        headers: { Prefer: 'return=representation' },
        role: 'service_role',
      }));
      assert.equal(res.statusCode, 200);
      assert.equal(res.headers['Preference-Applied'], 'return=representation');
      assert.ok(Array.isArray(JSON.parse(res.body)));
    });

    it('rejects a filter that is not the whole primary key', async () => {
      const res = await handler(makeEvent({
        method: 'PUT', query: { title: 'eq.x' },
        body: { id: 'abc', title: 'x' },
        role: 'service_role',
      }));
      assert.equal(res.statusCode, 405);
      assert.equal(JSON.parse(res.body).code, 'PGRST105');
    });

    it('rejects a payload whose key differs from the URL', async () => {
      const res = await handler(makeEvent({
        method: 'PUT', query: { id: 'eq.abc' },
        body: { id: 'other', title: 'x' },
        role: 'service_role',
      }));
      assert.equal(res.statusCode, 400);
      assert.equal(JSON.parse(res.body).code, 'PGRST115');
    });

    it('rejects limit on a PUT with PGRST114', async () => {
      const res = await handler(makeEvent({
        method: 'PUT', query: { id: 'eq.abc', limit: '1' },
        body: { id: 'abc', title: 'x' },
        role: 'service_role',
      }));
      assert.equal(res.statusCode, 400);
      assert.equal(JSON.parse(res.body).code, 'PGRST114');
    });
  });
});

// Headers that are a property of the protocol rather than of the rows: they are
// on (or deliberately off) every response, so they are asserted in one place.
describe('protocol headers', () => {
  let handler;

  beforeEach(() => {
    handler = createRestHandler(createTestContext()).handler;
  });

  it('says what the response varies on', async () => {
    const res = await handler(makeEvent({ method: 'GET' }));
    assert.equal(res.headers['Vary'], 'Accept, Prefer, Range',
      'Accept picks the media type, Prefer the shape, Range the window — a '
      + 'cache that ignores them serves the wrong body');
  });

  it('leaves a Vary that was already set alone', async () => {
    const ctx = createTestContext();
    ctx.cors = { allowedOrigins: ['https://app.com'], allowCredentials: false };
    const corsHandler = createRestHandler(ctx).handler;
    const res = await corsHandler(makeEvent({
      method: 'GET', headers: { Origin: 'https://app.com' },
    }));
    assert.equal(res.headers['Vary'], 'Origin',
      'the origin-reflecting Vary is not overwritten (upstream only appends '
      + 'its own when none is present)');
  });

  it('points Content-Location at the canonical query', async () => {
    const res = await handler(makeEvent({
      method: 'GET', query: { b: 'eq.1', a: 'eq.1' },
    }));
    assert.equal(res.headers['Content-Location'], '/todos?a=eq.1&b=eq.1',
      'parameters are sorted by name, so the same read always has the same '
      + 'Content-Location whatever order the client sent them in');
  });

  it('gives a mutation no Content-Location', async () => {
    const res = await handler(makeEvent({
      method: 'POST', body: { id: 'x', user_id: 'user-1', title: 'x' },
      role: 'service_role',
    }));
    assert.equal(res.headers['Content-Location'], undefined,
      'only a relation read is addressable by its query string');
  });

  it('refuses a nested path with PGRST125', async () => {
    const res = await handler(makeEvent({
      method: 'GET', path: '/rest/v1/todos/1/comments',
    }));
    assert.equal(res.statusCode, 404);
    const body = JSON.parse(res.body);
    assert.equal(body.code, 'PGRST125');
    assert.equal(body.message, 'Invalid path specified in request URL');
  });

  it('answers a CORS preflight without routing it', async () => {
    const res = await handler(makeEvent({
      method: 'OPTIONS', path: '/rest/v1/no_such_table',
      headers: {
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'apikey,Content-Type',
      },
    }));
    assert.equal(res.statusCode, 200,
      'a preflight asks whether a later request would be allowed; it must not '
      + 'be routed, so an unknown relation is not a 404 here');
    assert.equal(
      res.headers['Access-Control-Allow-Headers'],
      'Authorization, apikey, Content-Type, Accept, Accept-Language, '
      + 'Content-Language');
    assert.equal(res.headers['Access-Control-Max-Age'], '86400');
    assert.equal(res.headers['Content-Length'], '0');
  });

  it('reports what can be done with a relation', async () => {
    const res = await handler(makeEvent({
      method: 'OPTIONS', path: '/rest/v1/todos',
    }));
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['Content-Length'], '0');
    assert.ok(res.headers['Allow'].startsWith('OPTIONS,GET,HEAD'),
      `Allow should start with the read methods, got ${res.headers['Allow']}`);
    assert.equal(res.body, '', 'OPTIONS reports capabilities, not rows');
  });

  it('404s OPTIONS on a relation that does not exist', async () => {
    const res = await handler(makeEvent({
      method: 'OPTIONS', path: '/rest/v1/no_such_table',
    }));
    assert.equal(res.statusCode, 404,
      'an OPTIONS that is not a preflight is a question about a resource, and '
      + 'the answer for one that does not exist is 404');
  });

  it('has no Server-Timing unless it is turned on', async () => {
    const res = await handler(makeEvent({ method: 'GET' }));
    assert.equal(res.headers['Server-Timing'], undefined,
      'timing is opt-in, like upstream server-timing-enabled');
  });

  it('names all five phases when server-timing is on', async () => {
    const ctx = createTestContext();
    ctx.serverTiming = true;
    const timed = createRestHandler(ctx).handler;
    const res = await timed(makeEvent({ method: 'GET' }));
    const timing = res.headers['Server-Timing'];
    assert.ok(timing, 'Server-Timing should be present');
    for (const phase of ['jwt', 'parse', 'plan', 'transaction', 'response']) {
      assert.match(timing, new RegExp(`${phase};dur=[0-9]+\\.[0-9]`),
        `${phase} should be named with a duration in ${timing}`);
    }
    assert.equal(
      timing.replace(/[0-9]+\.[0-9]/g, 'N'),
      'jwt;dur=N, parse;dur=N, plan;dur=N, transaction;dur=N, response;dur=N',
      'the phases are named in upstream\'s order, comma-space separated');
  });

  it('reports timings on a path that never reaches the database', async () => {
    const ctx = createTestContext();
    ctx.serverTiming = true;
    const timed = createRestHandler(ctx).handler;
    const res = await timed(makeEvent({
      method: 'GET', path: '/rest/v1/todos/1/comments',
    }));
    assert.equal(res.statusCode, 404);
    assert.match(res.headers['Server-Timing'], /transaction;dur=0\.0/,
      'a request that opened no transaction spent no time in one, and still '
      + 'says so');
  });
});

// `Prefer: timezone=` is a request-scoped PostgreSQL setting, and the only way
// to make one request-scoped is to put it in a transaction that ends with the
// request.
describe('Prefer: timezone', () => {
  it('sets it inside a transaction, with the value bound', async () => {
    const pool = createMockPool();
    const handler = createRestHandler(createTestContext(pool)).handler;
    const res = await handler(makeEvent({
      method: 'GET', headers: { Prefer: 'timezone=America/Los_Angeles' },
    }));
    assert.equal(res.statusCode, 200);

    const texts = pool.capturedQueries.map(q => q.text.trim().toUpperCase());
    assert.ok(texts.includes('BEGIN'),
      'without a transaction a local setting has no effect, and a session one '
      + 'would leak onto the next request that got this connection');
    const setCfg = pool.capturedQueries.find(q => /set_config/.test(q.text));
    assert.ok(setCfg, 'the timezone should be set');
    assert.deepEqual(setCfg.values, ['timezone', 'America/Los_Angeles'],
      'the value is a bind parameter, never interpolated into SQL');
    assert.match(setCfg.text, /,\s*true\)/,
      'is_local = true, so PostgreSQL drops it when the transaction ends');
    assert.ok(texts.lastIndexOf('COMMIT') > texts.indexOf('BEGIN'),
      'the transaction is closed before the connection can be reused');
  });

  it('opens no transaction when no timezone was asked for', async () => {
    const pool = createMockPool();
    const handler = createRestHandler(createTestContext(pool)).handler;
    await handler(makeEvent({ method: 'GET' }));
    assert.ok(
      !pool.capturedQueries.some(q => /^begin$/i.test(q.text.trim())),
      'the default path is unchanged: no checkout, no transaction');
  });
});

// `app-settings` are configured once and applied to every request, so a
// function can read one back with `current_setting('app.settings.<name>')`
// (upstream Query/PreQuery.hs `txVarQuery`). Like the timezone, they only stay
// request-scoped inside a transaction.
describe('app-settings', () => {
  it('sets each one transaction-locally, with names and values bound',
    async () => {
      const pool = createMockPool();
      const ctx = createTestContext(pool);
      ctx.appSettings = {
        'app.settings.app_host': 'localhost',
        'app.settings.external_api_secret': '0123456789abcdef',
      };
      const res = await createRestHandler(ctx).handler(
        makeEvent({ method: 'GET' }));
      assert.equal(res.statusCode, 200);

      const texts = pool.capturedQueries.map(q => q.text.trim().toUpperCase());
      assert.ok(texts.includes('BEGIN'),
        'a session-level setting would leak onto the next request that got '
        + 'this connection');
      const setCfg = pool.capturedQueries.find(
        q => /set_config/.test(q.text));
      assert.ok(setCfg, 'the settings should be applied');
      assert.equal(setCfg.text,
        'select set_config($1, $2, true), set_config($3, $4, true)');
      assert.deepEqual(setCfg.values, [
        'app.settings.app_host', 'localhost',
        'app.settings.external_api_secret', '0123456789abcdef',
      ], 'every name and value is a bind parameter, never interpolated');
      assert.ok(texts.lastIndexOf('COMMIT') > texts.indexOf('BEGIN'),
        'the transaction is closed before the connection can be reused');
    });

  it('opens no transaction when none are configured', async () => {
    const pool = createMockPool();
    const ctx = createTestContext(pool);
    ctx.appSettings = {};
    await createRestHandler(ctx).handler(makeEvent({ method: 'GET' }));
    assert.ok(
      !pool.capturedQueries.some(q => /^begin$/i.test(q.text.trim())),
      'an empty configuration costs the default path nothing');
  });
});
