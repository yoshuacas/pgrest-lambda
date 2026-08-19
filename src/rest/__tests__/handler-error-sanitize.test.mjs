// Security finding V-09 (docs/security/findings/V-09-error-leaks.md) asked for
// PostgreSQL error strings not to be echoed to the client. Upstream PostgREST
// does echo them — `code`, `message`, `details` and `hint` in the error body are
// the server's own strings (PostgREST.Error, `instance ToJSON PgError`) and 83
// upstream assertions read them, so redacting by default breaks project rule 7.
//
// The resolution is that redaction is a setting rather than the default. These
// tests pin both halves of that: the default body carries the server's strings,
// and `errors.sanitize` (env PGREST_ERRORS_SANITIZE) replaces them. Without the
// second test the sanitize branch of mapPgError is unreachable from any
// configuration, i.e. the finding's mitigation would be dead code.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from '../db/index.mjs';
import { createRestHandler } from '../handler.mjs';
import { createSchemaCache } from '../schema-cache.mjs';
import { createCedar } from '../cedar.mjs';

const POLICIES = `
permit(principal is PgrestLambda::ServiceRole, action, resource);
`;

const columnRows = [
  { table_name: 'todos', column_name: 'id',
    data_type: 'text', is_nullable: false, column_default: null },
  { table_name: 'todos', column_name: 'title',
    data_type: 'text', is_nullable: true, column_default: null },
];

// The error a real server sends for a unique violation, with the strings the
// client would see verbatim upstream.
const PG_ERROR = Object.assign(new Error(
  'duplicate key value violates unique constraint "todos_pkey"'), {
  code: '23505',
  detail: 'Key (id)=(abc) already exists.',
  hint: 'Use a different id.',
});

function createMockPool() {
  return {
    query: async (text) => {
      if (text.includes('pg_catalog') && !text.includes('contype')) {
        return { rows: columnRows };
      }
      if (text.includes('contype')) {
        return { rows: [{ table_name: 'todos', column_name: 'id' }] };
      }
      if (text.trimStart().startsWith('SELECT')) throw PG_ERROR;
      return { rows: [] };
    },
  };
}

function createHandler(extraCtx) {
  const db = createDb({});
  db._setPool(createMockPool());
  const cedar = createCedar({ policiesPath: './policies' });
  cedar._setPolicies({ staticPolicies: POLICIES });
  const ctx = {
    db,
    schemaCache: createSchemaCache({}),
    cedar,
    errorsVerbose: true, // keep the test output quiet; does not affect the body
    ...extraCtx,
  };
  return createRestHandler(ctx).handler;
}

const event = {
  httpMethod: 'GET',
  path: '/rest/v1/todos',
  queryStringParameters: null,
  headers: { 'Content-Type': 'application/json' },
  body: null,
  requestContext: { authorizer: { role: 'service_role', userId: '', email: '' } },
};

describe('database error body (V-09 resolution)', () => {
  it('by default returns the server code, message, details and hint', async () => {
    const res = await createHandler()(event);
    assert.equal(res.statusCode, 409);
    const body = JSON.parse(res.body);
    assert.deepEqual(body, {
      code: '23505',
      message: 'duplicate key value violates unique constraint "todos_pkey"',
      details: 'Key (id)=(abc) already exists.',
      hint: 'Use a different id.',
    });
  });

  it('errors.sanitize replaces the strings and drops details and hint',
    async () => {
      const res = await createHandler({ errorsSanitize: true })(event);
      assert.equal(res.statusCode, 409, 'the status still comes from SQLSTATE');
      const body = JSON.parse(res.body);
      assert.deepEqual(body, {
        code: '23505',
        message: 'Uniqueness violation.',
        details: null,
        hint: null,
      });
      assert.ok(!res.body.includes('todos_pkey'),
        'no server string may survive sanitization');
    });
});
