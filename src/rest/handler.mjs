// handler.mjs — REST API handler

import { PostgRESTError, mapPgError } from './errors.mjs';
import { parseQuery } from './query-parser.mjs';
import {
  buildSelect, buildInsert, buildUpdate, buildDelete, buildCount,
} from './sql-builder.mjs';
import { success, error } from './response.mjs';
import { route } from './router.mjs';
import { generateSpec } from './openapi.mjs';

function parsePrefer(raw) {
  const prefer = {};
  if (!raw) return prefer;
  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx !== -1) {
      prefer[trimmed.slice(0, eqIdx)] = trimmed.slice(eqIdx + 1);
    }
  }
  return prefer;
}

function lowercaseHeaders(raw) {
  const headers = {};
  if (raw) {
    for (const [k, v] of Object.entries(raw)) {
      headers[k.toLowerCase()] = v;
    }
  }
  return headers;
}

function contentRange(rowCount, totalCount) {
  if (totalCount != null) {
    return rowCount > 0
      ? `0-${rowCount - 1}/${totalCount}`
      : `*/${totalCount}`;
  }
  return rowCount > 0
    ? `0-${rowCount - 1}/*`
    : `*/*`;
}

function docsHtml(specUrl) {
  return `<!doctype html>
<html>
<head>
  <title>API Reference</title>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
</head>
<body>
  <script id="api-reference" data-url="${specUrl}"></script>
  <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
</body>
</html>`;
}

export function createRestHandler(ctx) {
  const { db, schemaCache, cedar } = ctx;

  async function handler(event) {
    try {
      if (event.httpMethod === 'OPTIONS') {
        return success(200, null, {});
      }

      const method = event.httpMethod;
      const path = event.path;
      const authorizer = event.requestContext?.authorizer || {};
      const userId = authorizer.userId || authorizer.claims?.sub || '';
      const role = authorizer.role || 'anon';
      const email = authorizer.email || '';
      const headers = lowercaseHeaders(event.headers);

      let body = null;
      if (event.body) {
        try {
          body = JSON.parse(event.body);
        } catch {
          body = null;
        }
      }

      const params = event.queryStringParameters || {};
      const prefer = parsePrefer(headers['prefer']);
      const accept = headers['accept'] || '';

      const pool = await db.getPool();
      const schema = await schemaCache.getSchema(pool);

      const routeInfo = route(path, schema);

      if (routeInfo.type === 'openapi') {
        const apiUrl =
          `https://${headers['host'] || 'localhost'}/rest/v1`;
        return success(200, generateSpec(schema, apiUrl));
      }

      if (routeInfo.type === 'docs') {
        const proto = headers['x-forwarded-proto'] || 'https';
        const specUrl = `${proto}://${headers['host'] || 'localhost'}/rest/v1/`;
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'text/html' },
          body: docsHtml(specUrl),
        };
      }

      if (routeInfo.type === 'refresh') {
        if (method !== 'POST') {
          throw new PostgRESTError(405, 'PGRST000', 'Method not allowed on _refresh');
        }
        const newSchema = await schemaCache.refresh(pool);
        await cedar.refreshPolicies();
        const apiUrl =
          `https://${headers['host'] || 'localhost'}/rest/v1`;
        return success(200, generateSpec(newSchema, apiUrl));
      }

      const table = routeInfo.table;
      const parsed = parseQuery(params, method);

      await cedar.loadPolicies();

      const principal = { role, userId, email };

      let rows;
      let count;

      switch (method) {
        case 'GET': {
          const preview = buildSelect(table, parsed, schema);
          const authz = cedar.buildAuthzFilter({
            principal, action: 'select', context: { table }, schema,
            startParam: preview.values.length + 1,
          });
          const q = buildSelect(table, parsed, schema, authz);
          const result = await pool.query(q.text, q.values);
          rows = result.rows;

          if (prefer.count === 'exact') {
            const cq = buildCount(table, parsed, schema, authz);
            const cr = await pool.query(cq.text, cq.values);
            count = parseInt(cr.rows[0].count, 10);
          }
          break;
        }

        case 'POST': {
          if (!body) {
            throw new PostgRESTError(
              400, 'PGRST100',
              'Missing or invalid request body',
            );
          }

          cedar.authorize({
            principal, action: 'insert', resource: table, schema,
          });

          const q =
            parsed.onConflict
              && prefer.resolution === 'merge-duplicates'
              ? buildInsert(table, body, schema, parsed)
              : buildInsert(table, body, schema,
                { ...parsed, onConflict: null });

          const result = await pool.query(q.text, q.values);
          rows = result.rows;
          break;
        }

        case 'PATCH': {
          if (!body || typeof body !== 'object') {
            throw new PostgRESTError(
              400, 'PGRST100',
              'Missing or invalid request body',
            );
          }
          const preview = buildUpdate(table, body, parsed, schema);
          const authz = cedar.buildAuthzFilter({
            principal, action: 'update', context: { table }, schema,
            startParam: preview.values.length + 1,
          });
          const q = buildUpdate(
            table, body, parsed, schema, authz,
          );
          const result = await pool.query(q.text, q.values);
          rows = result.rows;
          break;
        }

        case 'DELETE': {
          const preview = buildDelete(table, parsed, schema);
          const authz = cedar.buildAuthzFilter({
            principal, action: 'delete', context: { table }, schema,
            startParam: preview.values.length + 1,
          });
          const q = buildDelete(
            table, parsed, schema, authz,
          );
          const result = await pool.query(q.text, q.values);
          rows = result.rows;
          break;
        }

        default:
          throw new PostgRESTError(
            405, 'PGRST000', `Method ${method} not allowed`,
          );
      }

      const singleObject =
        accept.includes('application/vnd.pgrst.object+json');
      const returnRep = prefer.return === 'representation';

      if (method === 'GET') {
        return success(200, rows, {
          contentRange: contentRange(rows.length, count),
          singleObject,
        });
      }

      if (method === 'POST') {
        return success(201, returnRep ? rows : null, {});
      }

      if (returnRep) {
        return success(200, rows, { singleObject });
      }
      return success(204, null, {});

    } catch (err) {
      if (err instanceof PostgRESTError) {
        return error(err);
      }
      if (err.code && typeof err.code === 'string'
          && /^[0-9A-Z]{5}$/.test(err.code)) {
        return error(mapPgError(err));
      }
      return error(
        new PostgRESTError(
          500, 'PGRST000',
          err.message || 'Internal server error',
        ),
      );
    }
  }

  return { handler };
}
