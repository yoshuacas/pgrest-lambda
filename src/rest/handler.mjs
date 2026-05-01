// handler.mjs — REST API handler

import { PostgRESTError, mapPgError } from './errors.mjs';
import { parseQuery } from './query-parser.mjs';
import {
  buildSelect, buildInsert, buildUpdate, buildDelete, buildCount,
  buildRpcCall,
} from './sql-builder.mjs';
import { getFunction } from './schema-cache.mjs';
import { success, error } from './response.mjs';
import { route } from './router.mjs';
import { generateSpec } from './openapi.mjs';
import { buildCorsHeaders } from '../shared/cors.mjs';
import { assertBodySize } from '../shared/body-size.mjs';
import { randomBytes } from 'node:crypto';

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

function collectTables(selectNodes, parentTable) {
  const tables = new Set([parentTable]);
  for (const node of selectNodes) {
    if (node.type === 'embed') {
      tables.add(node.name);
      const nested = collectTables(node.select, node.name);
      for (const t of nested) tables.add(t);
    }
  }
  return tables;
}

function buildPerTableAuthz(tables, cedar, principal, schema) {
  const perTableAuthz = {};
  for (const t of tables) {
    perTableAuthz[t] = cedar.buildAuthzFilter({
      principal, action: 'select',
      context: { table: t }, schema,
      startParam: 1, // renumbered by sql-builder
    });
  }
  return perTableAuthz;
}

function resolveContributions(contributions, apiUrl) {
  return contributions.map(c =>
    typeof c === 'function' ? c(apiUrl) : c
  );
}

function resolveApiUrl(ctx, headers) {
  if (ctx.apiBaseUrl) return ctx.apiBaseUrl;
  const host = headers['host'] || 'localhost';
  // Prefer X-Forwarded-Proto (set by API Gateway and most proxies);
  // fall back to http for plain local connections (e.g. `pgrest-lambda dev`).
  const proto = headers['x-forwarded-proto']
    || (host.startsWith('localhost') || host.startsWith('127.0.0.1') ? 'http' : 'https');
  return `${proto}://${host}/rest/v1`;
}

export function validateRpcArgs(fnName, args, fnSchema) {
  const required = fnSchema.args.length - fnSchema.numDefaults;
  for (let i = 0; i < required; i++) {
    const argDef = fnSchema.args[i];
    if (!(argDef.name in args)) {
      throw new PostgRESTError(400, 'PGRST209',
        `Function '${fnName}' requires argument `
        + `'${argDef.name}' which was not provided`);
    }
  }
  const validNames = new Set(fnSchema.args.map(a => a.name));
  for (const key of Object.keys(args)) {
    if (!validNames.has(key)) {
      throw new PostgRESTError(400, 'PGRST207',
        `Function '${fnName}' does not have an `
        + `argument named '${key}'`);
    }
  }
}

export function coerceRpcArgs(fnName, args, fnSchema) {
  for (const argDef of fnSchema.args) {
    if (!(argDef.name in args)) continue;
    const val = args[argDef.name];
    if (typeof val !== 'string') continue;

    const t = argDef.type;
    if (['int4', 'int2', 'int8'].includes(t)) {
      if (!/^-?\d+$/.test(val)) {
        throw new PostgRESTError(400, 'PGRST208',
          `Argument '${argDef.name}' of function `
          + `'${fnName}' expects type '${t}' but `
          + `received a value that could not be coerced`);
      }
      const n = parseInt(val, 10);
      args[argDef.name] = n;
    } else if (t === 'bool') {
      if (val === 'true') args[argDef.name] = true;
      else if (val === 'false') args[argDef.name] = false;
      else {
        throw new PostgRESTError(400, 'PGRST208',
          `Argument '${argDef.name}' of function `
          + `'${fnName}' expects type '${t}' but `
          + `received a value that could not be coerced`);
      }
    } else if (['json', 'jsonb'].includes(t)) {
      try {
        args[argDef.name] = JSON.parse(val);
      } catch {
        throw new PostgRESTError(400, 'PGRST208',
          `Argument '${argDef.name}' of function `
          + `'${fnName}' expects type '${t}' but `
          + `received a value that could not be coerced`);
      }
    }
  }
  return args;
}

const RPC_RESERVED = new Set([
  'select', 'order', 'limit', 'offset',
  'on_conflict', 'columns',
]);
const RPC_OP_PREFIX = /^(not\.)?(eq|neq|gt|gte|lt|lte|like|ilike|match|imatch|in|is|isdistinct|fts|plfts|phfts|wfts|cs|cd|ov|sl|sr|nxr|nxl|adj)\./;

export function classifyRpcParam(key, val) {
  if (RPC_RESERVED.has(key)) return 'rest';
  if (RPC_OP_PREFIX.test(val)) return 'rest';
  return 'arg';
}

export function createRestHandler(ctx, contributions = []) {
  const { db, schemaCache, cedar, docs } = ctx;
  const corsConfig = ctx.cors;

  async function handler(event) {
    const headers = lowercaseHeaders(event.headers);
    const origin = headers['origin'] || '';
    const corsHeaders = buildCorsHeaders(corsConfig, origin);

    try {
      if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers: corsHeaders };
      }

      const method = event.httpMethod;
      const path = event.path;
      const authorizer = event.requestContext?.authorizer || {};
      const userId = authorizer.userId || authorizer.claims?.sub || '';
      const role = authorizer.role || 'anon';
      const email = authorizer.email || '';

      let body = null;
      if (event.body) {
        assertBodySize(event.body);
        try {
          body = JSON.parse(event.body);
        } catch {
          body = null;
        }
      }

      const params = event.queryStringParameters || {};
      const multiValueParams =
        event.multiValueQueryStringParameters || null;
      const prefer = parsePrefer(headers['prefer']);
      const accept = headers['accept'] || '';

      const pool = await db.getPool();
      const schema = await schemaCache.getSchema(pool);

      const routeInfo = route(path, schema);

      if (routeInfo.type === 'openapi') {
        const apiUrl = resolveApiUrl(ctx, headers);
        const resolved = resolveContributions(contributions, apiUrl);
        return success(200, generateSpec(schema, apiUrl, resolved), { corsHeaders });
      }

      if (routeInfo.type === 'docs') {
        if (!docs) {
          throw new PostgRESTError(404, 'PGRST205', 'Docs are disabled');
        }
        const specUrl = resolveApiUrl(ctx, headers) + '/';
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
        if (role !== 'service_role') {
          throw new PostgRESTError(401, 'PGRST301', 'Refresh requires service_role');
        }
        const newSchema = await schemaCache.refresh(pool);
        await cedar.refreshPolicies();
        const apiUrl = resolveApiUrl(ctx, headers);
        const resolved = resolveContributions(contributions, apiUrl);
        return success(200, generateSpec(newSchema, apiUrl, resolved), { corsHeaders });
      }

      if (routeInfo.type === 'rpc') {
        return await handleRpc({
          fnName: routeInfo.functionName, method, body,
          params, multiValueParams, accept, prefer, headers,
          schema, pool, cedar, ctx, corsHeaders,
          role, userId, email,
        });
      }

      const table = routeInfo.table;
      const parsed = parseQuery(params, method, multiValueParams);
      const hasEmbeds = parsed.select.some(
        n => n.type === 'embed');

      await cedar.loadPolicies();

      const principal = { role, userId, email };

      let rows;
      let count;

      let parentAuthz = null;

      switch (method) {
        case 'GET': {
          if (hasEmbeds) {
            const tables = collectTables(parsed.select, table);
            const perTableAuthz = buildPerTableAuthz(
              tables, cedar, principal, schema);
            parentAuthz = perTableAuthz[table] || null;
            const authzFilters = {
              parent: parentAuthz,
              embeds: Object.fromEntries(
                [...tables]
                  .filter(t => t !== table)
                  .map(t => [t, perTableAuthz[t]])
              ),
            };
            const q = buildSelect(
              table, parsed, schema, authzFilters);
            const result = await pool.query(q.text, q.values);
            rows = result.rows;
          } else {
            parentAuthz = cedar.buildAuthzFilter({
              principal, action: 'select',
              context: { table }, schema,
              startParam: 1, // renumbered by buildSelect
            });
            const q = buildSelect(
              table, parsed, schema, parentAuthz);
            const result = await pool.query(q.text, q.values);
            rows = result.rows;
          }

          if (prefer.count === 'exact') {
            const cq = buildCount(
              table, parsed, schema, parentAuthz);
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

      // Re-SELECT mutations with embeds for return=representation
      if (method !== 'GET' && returnRep && hasEmbeds
          && rows && rows.length > 0) {
        const pk = schema.tables[table]?.primaryKey;
        if (pk && pk.length > 0) {
          const filters = pk.map(col => ({
            column: col,
            operator: 'in',
            value: rows.map(r => String(r[col])),
            negate: false,
          }));
          const reSelectParsed = {
            ...parsed,
            filters,
            order: [],
            limit: null,
            offset: 0,
          };
          const embTables = collectTables(parsed.select, table);
          const perTableAuthz = buildPerTableAuthz(
            embTables, cedar, principal, schema);
          const authzFilters = {
            parent: perTableAuthz[table] || null,
            embeds: Object.fromEntries(
              [...embTables]
                .filter(t => t !== table)
                .map(t => [t, perTableAuthz[t]])
            ),
          };
          const reQ = buildSelect(
            table, reSelectParsed, schema, authzFilters);
          const reResult = await pool.query(
            reQ.text, reQ.values);
          rows = reResult.rows;
        }
      }

      if (method === 'GET') {
        return success(200, rows, {
          contentRange: contentRange(rows.length, count),
          singleObject,
          corsHeaders,
        });
      }

      if (method === 'POST') {
        if (returnRep) {
          return success(201, rows, { singleObject, corsHeaders });
        }
        return success(201, null, { corsHeaders });
      }

      if (returnRep) {
        return success(200, rows, { singleObject, corsHeaders });
      }
      return success(204, null, { corsHeaders });

    } catch (err) {
      if (err instanceof PostgRESTError) {
        return error(err, corsHeaders);
      }
      if (err.code && typeof err.code === 'string'
          && /^[0-9A-Z]{5}$/.test(err.code)) {
        if (!ctx.errorsVerbose) {
          console.warn(JSON.stringify({
            level: 'warn',
            pgCode: err.code,
            message: err.message,
            detail: err.detail || null,
            hint: err.hint || null,
          }));
        }
        return error(
          mapPgError(err, { verbose: ctx.errorsVerbose }),
          corsHeaders,
        );
      }
      // Catch-all: never echo err.message. It can contain SQL
      // fragments, schema names, or internal paths. Log the details
      // server-side against a short random id and return that id to
      // the client for support correlation.
      const errorId = randomBytes(4).toString('hex');
      console.error(JSON.stringify({
        level: 'error',
        errorId,
        message: err.message,
        stack: err.stack,
      }));
      return error(
        new PostgRESTError(
          500, 'PGRST000',
          `Internal server error (errorId: ${errorId})`,
        ),
        corsHeaders,
      );
    }
  }

  async function handleRpc({
      fnName, method, body, params, multiValueParams,
      accept, prefer, headers, schema, pool, cedar,
      ctx, corsHeaders, role, userId, email,
  }) {
    if (method !== 'GET' && method !== 'POST'
        && method !== 'HEAD' && method !== 'OPTIONS') {
      throw new PostgRESTError(405, 'PGRST101',
        'Only GET, POST, and HEAD are allowed for RPC');
    }

    if (!ctx.dbCapabilities?.supportsRpc) {
      throw new PostgRESTError(501, 'PGRST501',
        'RPC is not supported on this database',
        null,
        'Deploy on standard PostgreSQL to use stored '
        + 'function calls.');
    }

    const fnSchema = getFunction(schema, fnName);
    if (!fnSchema) {
      throw new PostgRESTError(404, 'PGRST202',
        `Could not find the function '${fnName}' in the schema cache`);
    }

    if (fnSchema.overloaded) {
      throw new PostgRESTError(300, 'PGRST203',
        `Could not choose the best candidate function between: ${fnName}`);
    }

    await cedar.loadPolicies();
    const principal = { role, userId, email };
    cedar.authorize({
      principal, action: 'call', resource: fnName,
      resourceType: 'Function', schema,
    });

    let args;
    let parsed;

    if (method === 'POST') {
      args = body || {};
      parsed = parseQuery(params, method, multiValueParams);
    } else {
      const argParams = {};
      const restParams = {};
      for (const [key, val] of Object.entries(params)) {
        const kind = classifyRpcParam(key, val);
        if (kind === 'arg') {
          argParams[key] = val;
        } else {
          restParams[key] = val;
        }
      }
      parsed = parseQuery(restParams, method, multiValueParams);
      args = argParams;
    }

    validateRpcArgs(fnName, args, fnSchema);

    if (method === 'GET' || method === 'HEAD') {
      coerceRpcArgs(fnName, args, fnSchema);
    }

    if (method === 'HEAD' && fnSchema.returnsSet) {
      parsed = { ...parsed, limit: 0 };
    }

    const q = buildRpcCall(fnName, args, fnSchema, parsed);

    if (!ctx.production) {
      console.info(
        `[pgrest-lambda] rpc: ${fnName}(`
        + `${Object.keys(args).join(', ')})`);
    }

    const result = await pool.query(q.text, q.values);

    if (method === 'HEAD') {
      return {
        statusCode: 200,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json',
        },
        body: '',
      };
    }

    if (q.resultMode === 'void') {
      return success(200, null, { corsHeaders });
    }

    if (q.resultMode === 'scalar') {
      const value = result.rows[0]?.[fnName] ?? null;
      return {
        statusCode: 200,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(value),
      };
    }

    const singleObject =
      accept.includes('application/vnd.pgrst.object+json');

    if (!fnSchema.returnsSet) {
      const row = result.rows[0] || null;
      return {
        statusCode: 200,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(row),
      };
    }

    return success(200, result.rows, {
      singleObject,
      corsHeaders,
    });
  }

  return { handler };
}
