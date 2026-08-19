// handler.mjs — REST API handler

import { PostgRESTError, mapPgError } from './errors.mjs';
import { parseQuery } from './query-parser.mjs';
import {
  buildSelect, buildInsert, buildUpdate, buildDelete, buildCount,
  buildRpcCall,
} from './sql-builder.mjs';
import { getFunction } from './schema-cache.mjs';
import {
  success, error, negotiateMedia, MEDIA_OPENAPI,
} from './response.mjs';
import { installPgTypeParsers } from './pg-types.mjs';
import { route } from './router.mjs';
import { generateSpec } from './openapi.mjs';
import { buildCorsHeaders } from '../shared/cors.mjs';
import { assertBodySize } from '../shared/body-size.mjs';
import { randomBytes } from 'node:crypto';

// --- Prefer / Preference-Applied -------------------------------------------
//
// Ported from upstream `PostgREST.ApiRequest.Preferences`. The vocabulary is
// closed: a token that is neither one of these `key=value` pairs nor a
// `timezone=`/`max-affected=` prefix is an *invalid* preference, which
// `handling=strict` turns into PGRST122. A preference given twice keeps the
// first occurrence.

const PREF_ENUM = {
  resolution: ['merge-duplicates', 'ignore-duplicates'],
  return: ['representation', 'minimal', 'headers-only'],
  count: ['exact', 'planned', 'estimated'],
  tx: ['commit', 'rollback'],
  missing: ['default', 'null'],
  handling: ['strict', 'lenient'],
};

export function parsePrefer(raw) {
  const prefer = { invalid: [] };
  if (!raw) return prefer;

  for (const part of String(raw).split(',')) {
    const token = part.trim();
    if (token === '') continue;

    const eqIdx = token.indexOf('=');
    const key = eqIdx === -1 ? null : token.slice(0, eqIdx);
    const value = eqIdx === -1 ? null : token.slice(eqIdx + 1);

    if (key !== null && PREF_ENUM[key]?.includes(value)) {
      if (prefer[key] === undefined) prefer[key] = value;
      continue;
    }
    // `timezone=`/`max-affected=` take free-form values, so an unparseable
    // one is still an accepted preference — it just has no effect.
    if (key === 'timezone') {
      if (prefer.timezone === undefined) prefer.timezone = value;
      continue;
    }
    if (key === 'max-affected') {
      if (prefer.maxAffectedRaw === undefined) {
        prefer.maxAffectedRaw = value;
        if (/^-?\d+$/.test(value)) prefer.maxAffected = parseInt(value, 10);
      }
      continue;
    }
    prefer.invalid.push(token);
  }
  return prefer;
}

export function assertValidPrefer(prefer) {
  if (prefer.handling === 'strict' && prefer.invalid.length > 0) {
    throw new PostgRESTError(400, 'PGRST122',
      'Invalid preferences given with handling=strict',
      `Invalid preferences: ${prefer.invalid.join(', ')}`);
  }
}

/**
 * Does this request want a total in Content-Range?
 *
 * Upstream has three strategies: `exact` runs a COUNT, `planned` reads the
 * planner's estimate, `estimated` takes the planner's estimate and falls back
 * to the exact count when it is below the configured threshold. This engine
 * has no usable estimate source — `pg_class.reltuples` accuracy is
 * undocumented on Aurora DSQL (see `supportsPlannedCount: false` in
 * src/rest/db/dsql.mjs) — so all three run the exact count. The header value
 * is then correct for every strategy; only `planned`'s "cheap" promise is not
 * kept.
 */
export function shouldCount(prefer) {
  return prefer.count === 'exact'
    || prefer.count === 'planned'
    || prefer.count === 'estimated';
}

const MUTATION_PLANS = new Set(['create', 'update', 'delete', 'upsert']);

/**
 * Build the Preference-Applied value for one plan, in upstream's order
 * (`prefAppliedHeader`): resolution, missing, return, count, tx, handling,
 * timezone, max-affected. Which of them are in scope depends on the plan
 * (upstream `responsePreferences`): `return` only on mutations, `missing`
 * only on insert/update, `resolution` only on inserts that have something
 * to resolve against, `max-affected` only with handling=strict.
 *
 * @param {Object} prefer  from parsePrefer()
 * @param {'read'|'create'|'update'|'delete'|'upsert'|'rpc'} plan
 * @param {{resolutionApplies?: boolean}} [opts]
 * @returns {string|null}
 */
export function preferenceApplied(prefer, plan, opts = {}) {
  const vals = [];

  if (plan === 'create' && prefer.resolution && opts.resolutionApplies) {
    vals.push(`resolution=${prefer.resolution}`);
  }
  if ((plan === 'create' || plan === 'update') && prefer.missing) {
    vals.push(`missing=${prefer.missing}`);
  }
  if (MUTATION_PLANS.has(plan) && prefer.return) {
    vals.push(`return=${prefer.return}`);
  }
  if (prefer.count) vals.push(`count=${prefer.count}`);
  // Only `tx=commit` is echoed: this engine has no request-scoped rollback,
  // so claiming `tx=rollback` was applied would be a lie.
  if (prefer.tx === 'commit') vals.push('tx=commit');
  if (prefer.handling) vals.push(`handling=${prefer.handling}`);
  if (prefer.timezone !== undefined) {
    vals.push(`timezone=${prefer.timezone}`);
  }
  if (prefer.handling === 'strict' && prefer.maxAffected !== undefined
      && (plan === 'update' || plan === 'delete' || plan === 'rpc')) {
    vals.push(`max-affected=${prefer.maxAffected}`);
  }

  return vals.length > 0 ? vals.join(', ') : null;
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

// --- Range / Content-Range -------------------------------------------------
//
// Ported from upstream `PostgREST.RangeQuery`. `contentRangeH` is used for
// every plan; the lower bound is the requested *offset*, not zero, and it is
// hard-coded per mutation (`1 0` for insert/delete, `0 (n-1)` for update) so
// that the header reads `*/N` or `0-(n-1)/N`.

export function contentRangeH(lower, upper, total) {
  const rangeString = total !== 0 && lower <= upper
    ? `${lower}-${upper}`
    : '*';
  return `${rangeString}/${total == null ? '*' : total}`;
}

export function rangeStatus(lower, upper, total) {
  if (total == null) return 200;
  if (lower > total) return 416;
  if ((1 + upper - lower) < total) return 206;
  return 200;
}

/**
 * Parse a `Range` request header into `{lower, upper}` (upstream
 * `rangeParse`, whose regex is `^([0-9]+)-([0-9]*)$`). An unparseable header
 * means "no range", exactly as upstream.
 *
 * The optional `<unit>=` prefix is an extension: upstream's own test helper
 * sends a bare `0-1`, but real clients (and the extracted conformance cases)
 * send `items=0-1`/`bytes=0-1`, and RFC 9110 requires a unit. Accepting both
 * is a superset of PostgREST's behaviour.
 */
export function parseRangeHeader(raw) {
  if (raw == null) return null;
  const m = /^(?:[A-Za-z]+\s*=\s*)?(\d+)-(\d*)$/.exec(String(raw).trim());
  if (!m) return null;
  return {
    lower: parseInt(m[1], 10),
    upper: m[2] === '' ? null : parseInt(m[2], 10),
  };
}

/**
 * Intersect the `Range` header with the `limit`/`offset` query parameters the
 * way upstream `getRanges` does, and return the effective window plus the
 * bounds the response headers are built from.
 *
 * @param {{limit: number|null, offset: number}} parsed
 * @param {{lower: number, upper: number|null}|null} headerRange
 *        already suppressed by the caller for non-GET methods
 * @returns {{limit: number|null, offset: number, lower: number}}
 */
export function effectiveRange(parsed, headerRange) {
  // `limit=0` bypasses every range validation and wins outright
  // (upstream `convertToLimitZeroRange`).
  if (parsed.limit === 0) {
    return { limit: 0, offset: 0, lower: 0 };
  }

  let lower = parsed.offset || 0;
  let upper = parsed.limit != null ? lower + parsed.limit - 1 : null;

  if (headerRange) {
    lower = Math.max(lower, headerRange.lower);
    if (headerRange.upper != null) {
      upper = upper == null
        ? headerRange.upper
        : Math.min(upper, headerRange.upper);
    }
  }

  if (upper != null && upper < lower) {
    const headerEmpty = headerRange && headerRange.upper != null
      && headerRange.upper < headerRange.lower;
    throw rangeError(
      headerEmpty
        ? 'The lower boundary must be lower than or equal to the upper '
          + 'boundary in the Range header.'
        : 'Limit should be greater than or equal to zero.',
    );
  }

  return {
    limit: upper == null ? null : upper - lower + 1,
    offset: lower,
    lower,
  };
}

function rangeError(details, extraHeaders) {
  const err = new PostgRESTError(416, 'PGRST103',
    'Requested range not satisfiable', details);
  if (extraHeaders) err.responseHeaders = extraHeaders;
  return err;
}

// --- PUT (single-row upsert) ----------------------------------------------

/**
 * A PUT must address exactly one row: no and()/or(), every filter a plain
 * `eq` (no `not.`, no quantifier), and the filtered columns exactly the
 * primary key. Anything else is upstream's PGRST105, a 405.
 */
export function assertPutFilters(filters, pk) {
  const cols = new Set();
  let ok = pk.length > 0;

  for (const f of filters) {
    if (f.type !== 'filter' || f.operator !== 'eq'
        || f.negate || f.quantifier) {
      ok = false;
      break;
    }
    cols.add(f.column);
  }

  if (ok) {
    ok = cols.size === pk.length && pk.every(c => cols.has(c));
  }

  if (!ok) {
    throw new PostgRESTError(405, 'PGRST105',
      "Filters must include all and only primary key columns "
      + "with 'eq' operators");
  }
}

/**
 * Pick the payload row the URL points at. Upstream guards the INSERT with a
 * WHERE that keeps only the rows whose primary key matches the URL, then
 * fails the request unless exactly one row survived (PGRST115).
 */
export function pickPutRow(filters, pk, body) {
  const urlValues = new Map(filters.map(f => [f.column, f.value]));
  const payload = Array.isArray(body) ? body : (body == null ? [] : [body]);

  const matching = payload.filter(row => row && typeof row === 'object'
    && pk.every(col => row[col] !== undefined
      && String(row[col]) === String(urlValues.get(col))));

  if (matching.length !== 1) {
    throw new PostgRESTError(400, 'PGRST115',
      'Payload values do not match URL in primary key column(s)');
  }
  return matching[0];
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

/**
 * Total row count for a set-returning function call, for `Prefer: count=`.
 *
 * Upstream counts in the same statement as the call; a second statement is
 * only safe when PostgreSQL itself guarantees the function has no side
 * effects, so a VOLATILE function reports no total rather than running twice.
 */
async function countRpcRows({ fnName, args, fnSchema, parsed, pool }) {
  if (fnSchema.volatility !== 'i' && fnSchema.volatility !== 's') {
    return null;
  }
  const q = buildRpcCall(fnName, args, fnSchema, {
    ...parsed, limit: null, offset: 0, order: [],
  });
  if (q.resultMode !== 'set') return null;

  // q.text is engine-generated SQL; every user value is still a placeholder.
  const r = await pool.query(
    `SELECT COUNT(*) AS count FROM (${q.text}) AS _pgrst_count`,
    q.values,
  );
  return parseInt(r.rows[0].count, 10);
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

  // int8/numeric must reach the client as JSON numbers, the way PostgREST's
  // in-database json_agg emits them.
  installPgTypeParsers();

  async function handler(event) {
    const headers = lowercaseHeaders(event.headers);
    const origin = headers['origin'] || '';
    const corsHeaders = buildCorsHeaders(corsConfig, origin);
    // Read outside the try: the catch below needs it to decide between 401 and
    // 403 for insufficient_privilege, and a `const` inside the try block is not
    // in scope there.
    const role = event.requestContext?.authorizer?.role || 'anon';

    try {
      if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers: corsHeaders };
      }

      // HEAD is GET with the body dropped at the very end (upstream keeps one
      // plan for both and only blanks the payload), so everything downstream
      // sees GET.
      const rawMethod = event.httpMethod;
      const headersOnly = rawMethod === 'HEAD';
      const method = headersOnly ? 'GET' : rawMethod;
      const path = event.path;
      const authorizer = event.requestContext?.authorizer || {};
      const userId = authorizer.userId || authorizer.claims?.sub || '';
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
      assertValidPrefer(prefer);
      const accept = headers['accept'] || '';
      const media = negotiateMedia(accept);
      // RFC 9110: the Range header is only meaningful on GET. Upstream tests
      // the *raw* method (`headerRange = if method == "GET" ...` in
      // ApiRequest.getRanges), so a HEAD carrying a Range is served as if the
      // header were not there — only limit/offset shape its Content-Range.
      const headerRange = rawMethod === 'GET'
        ? parseRangeHeader(headers['range'])
        : null;

      const pool = await db.getPool();
      const schema = await schemaCache.getSchema(pool);

      const routeInfo = route(path, schema);

      if (routeInfo.type === 'openapi') {
        const apiUrl = resolveApiUrl(ctx, headers);
        const resolved = resolveContributions(contributions, apiUrl);
        // Upstream's InspectPlan always answers with the OpenAPI media type,
        // whatever the client asked for.
        return success(200, generateSpec(schema, apiUrl, resolved), {
          corsHeaders,
          media: { kind: MEDIA_OPENAPI, stripNulls: false },
          headersOnly,
        });
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
          media, headersOnly, headerRange,
        });
      }

      const table = routeInfo.table;
      const parsedRaw = parseQuery(
        params, method, multiValueParams, ctx.maxEmbedDepth);

      // PUT addresses exactly one row, so a window over the result set makes
      // no sense (upstream `PutLimitNotAllowedError`).
      if (method === 'PUT'
          && (parsedRaw.limit != null || (parsedRaw.offset || 0) > 0)) {
        throw new PostgRESTError(400, 'PGRST114',
          'limit/offset querystring parameters are not allowed for PUT');
      }

      const range = effectiveRange(parsedRaw, headerRange);
      const parsed = method === 'GET'
        ? { ...parsedRaw, limit: range.limit, offset: range.offset }
        : parsedRaw;
      const hasEmbeds = parsed.select.some(
        n => n.type === 'embed');

      await cedar.loadPolicies();

      const principal = { role, userId, email };

      let rows;
      let count;
      let upsertInserted = false;

      let parentAuthz = null;

      // One read path for GET and for the re-read a mutation needs when it
      // has to return embedded or generated columns.
      async function runSelect(p) {
        if (p.select.some(n => n.type === 'embed')) {
          const tables = collectTables(p.select, table);
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
          const q = buildSelect(table, p, schema, authzFilters);
          return (await pool.query(q.text, q.values)).rows;
        }
        parentAuthz = cedar.buildAuthzFilter({
          principal, action: 'select',
          context: { table }, schema,
          startParam: 1, // renumbered by buildSelect
        });
        const q = buildSelect(table, p, schema, parentAuthz);
        return (await pool.query(q.text, q.values)).rows;
      }

      async function countRows(p) {
        const cq = buildCount(table, p, schema, parentAuthz);
        const cr = await pool.query(cq.text, cq.values);
        return parseInt(cr.rows[0].count, 10);
      }

      // `max-affected` is only enforced with handling=strict. Upstream runs
      // the mutation and rolls back; without a transaction the equivalent is
      // to count the rows the filters select before touching them.
      async function assertMaxAffected() {
        if (prefer.handling !== 'strict'
            || prefer.maxAffected === undefined) return;
        parentAuthz = cedar.buildAuthzFilter({
          principal, action: 'select',
          context: { table }, schema,
          startParam: 1, // renumbered by buildCount
        });
        const affected = await countRows(
          { ...parsed, limit: null, offset: 0 });
        if (affected > prefer.maxAffected) {
          throw new PostgRESTError(400, 'PGRST124',
            'Query result exceeds max-affected preference constraint',
            `The query affects ${affected} rows`);
        }
      }

      switch (method) {
        case 'GET': {
          rows = await runSelect(parsed);

          if (shouldCount(prefer)) {
            count = await countRows(parsed);
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
          await assertMaxAffected();
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

        // Single-row upsert (upstream MutationSingleUpsert): the URL must
        // pin exactly one row by its whole primary key, the payload must
        // agree with it, and the row is then INSERTed ON CONFLICT DO UPDATE.
        case 'PUT': {
          const pk = schema.tables[table]?.primaryKey || [];
          assertPutFilters(parsed.filters, pk);

          const payloadRow = pickPutRow(parsed.filters, pk, body);

          cedar.authorize({
            principal, action: 'insert', resource: table, schema,
          });
          cedar.authorize({
            principal, action: 'update', resource: table, schema,
          });

          // 201 vs 200 hinges on whether the row already existed; upstream
          // reads it off the INSERT's row count, which ON CONFLICT hides.
          parentAuthz = cedar.buildAuthzFilter({
            principal, action: 'select',
            context: { table }, schema,
            startParam: 1, // renumbered by buildCount
          });
          upsertInserted = (await countRows(
            { ...parsed, limit: null, offset: 0 })) === 0;

          const q = buildInsert(table, [payloadRow], schema, {
            ...parsed, onConflict: pk.join(','),
          });
          const result = await pool.query(q.text, q.values);
          rows = result.rows;
          break;
        }

        case 'DELETE': {
          await assertMaxAffected();
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

      const returnRep = prefer.return === 'representation';

      // PUT: RETURNING is empty when ON CONFLICT DO NOTHING fires (a table
      // whose only columns are its primary key), and generated/embedded
      // columns are not in it either, so re-read the row the URL pins.
      if (method === 'PUT' && returnRep) {
        rows = await runSelect({ ...parsed, limit: null, offset: 0 });
      }

      // Re-SELECT mutations with embeds for return=representation
      if (method !== 'GET' && method !== 'PUT' && returnRep && hasEmbeds
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

      const total = shouldCount(prefer) ? (count ?? rows.length) : null;
      const base = { media, headersOnly, corsHeaders };

      if (method === 'GET') {
        const lower = range.lower;
        const upper = lower + rows.length - 1;
        const cRange = contentRangeH(lower, upper, total);
        const status = rangeStatus(lower, upper, total);
        const applied = preferenceApplied(prefer, 'read');

        if (status === 416) {
          return error(
            new PostgRESTError(416, 'PGRST103',
              'Requested range not satisfiable',
              `An offset of ${lower} was requested, but there are only `
              + `${total} rows.`),
            corsHeaders,
            {
              'Content-Range': cRange,
              ...(applied ? { 'Preference-Applied': applied } : null),
            },
          );
        }

        return success(status, rows, {
          ...base,
          contentRange: cRange,
          preferenceApplied: applied,
        });
      }

      if (method === 'POST') {
        const pkCols = schema.tables[table]?.primaryKey || [];
        const opts = {
          ...base,
          contentRange: contentRangeH(1, 0, total),
          preferenceApplied: preferenceApplied(prefer, 'create', {
            resolutionApplies:
              pkCols.length > 0 || parsed.onConflict != null,
          }),
          // Upstream's MutationCreate branch always appends
          // `contentLengthHeader`, so a 201 with `return=minimal` still
          // states a length of zero. The 204 branches do not.
          ...(returnRep || headersOnly
            ? null
            : { extraHeaders: { 'Content-Length': '0' } }),
        };
        return success(201, returnRep ? rows : null, opts);
      }

      if (method === 'PUT') {
        // No Content-Range: a single-row upsert is not a range of anything.
        const opts = {
          ...base,
          preferenceApplied: preferenceApplied(prefer, 'upsert'),
        };
        if (!returnRep) return success(204, null, opts);
        return success(upsertInserted ? 201 : 200, rows, opts);
      }

      if (method === 'PATCH') {
        const opts = {
          ...base,
          contentRange: contentRangeH(0, rows.length - 1, total),
          preferenceApplied: preferenceApplied(prefer, 'update'),
        };
        return success(returnRep ? 200 : 204,
          returnRep ? rows : null, opts);
      }

      // DELETE
      const opts = {
        ...base,
        contentRange: contentRangeH(1, 0, total),
        preferenceApplied: preferenceApplied(prefer, 'delete'),
      };
      return success(returnRep ? 200 : 204,
        returnRep ? rows : null, opts);

    } catch (err) {
      if (err instanceof PostgRESTError) {
        return error(err, corsHeaders, err.responseHeaders);
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
          // `authed` only changes insufficient_privilege (42501): upstream
          // answers 401 to an anonymous caller so it knows to authenticate,
          // and 403 to one that already presented an identity.
          mapPgError(err, {
            verbose: ctx.errorsVerbose,
            authed: role !== 'anon',
          }),
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
      media, headersOnly, headerRange,
  }) {
    if (method !== 'GET' && method !== 'POST' && method !== 'OPTIONS') {
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
      parsed = parseQuery(params, method, multiValueParams, ctx.maxEmbedDepth);
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
      parsed = parseQuery(restParams, method, multiValueParams, ctx.maxEmbedDepth);
      args = argParams;
    }

    validateRpcArgs(fnName, args, fnSchema);

    if (method === 'GET') {
      coerceRpcArgs(fnName, args, fnSchema);
    }

    // A function that returns one value has no row count to constrain
    // (upstream `failMaxAffectedRpcReturnsSingle`).
    if (prefer.handling === 'strict' && prefer.maxAffected !== undefined
        && !fnSchema.returnsSet) {
      throw new PostgRESTError(400, 'PGRST128',
        'Function must return SETOF or TABLE when max-affected preference '
        + 'is used with handling=strict');
    }

    const range = effectiveRange(parsed, headerRange);
    if (fnSchema.returnsSet) {
      parsed = { ...parsed, limit: range.limit, offset: range.offset };
    }

    const q = buildRpcCall(fnName, args, fnSchema, parsed);

    if (!ctx.production) {
      console.info(
        `[pgrest-lambda] rpc: ${fnName}(`
        + `${Object.keys(args).join(', ')})`);
    }

    const result = await pool.query(q.text, q.values);

    const base = {
      media, headersOnly, corsHeaders,
      preferenceApplied: preferenceApplied(prefer, 'rpc'),
    };

    if (q.resultMode === 'void') {
      return success(204, null, base);
    }

    if (q.resultMode === 'scalar' || !fnSchema.returnsSet) {
      const value = q.resultMode === 'scalar'
        ? (result.rows[0]?.[fnName] ?? null)
        : (result.rows[0] ?? null);
      return success(200, value, {
        ...base,
        // A function returning one scalar/composite counts as exactly one row
        // (upstream: "includes exact count of 1 for functions that return a
        // single scalar, domain or composite").
        contentRange: contentRangeH(0, 0, shouldCount(prefer) ? 1 : null),
        // A single value is a body even when it is JSON null.
        serializedBody: JSON.stringify(value ?? null),
      });
    }

    // Set-returning: the window and the total are the same machinery as a
    // table read, so 206/416 apply here too.
    let total = null;
    if (shouldCount(prefer)) {
      total = (range.limit == null && range.lower === 0)
        // Nothing was windowed away, so the rows in hand *are* the total. This
        // also covers VOLATILE functions, which must not be called twice.
        ? result.rows.length
        : await countRpcRows({ fnName, args, fnSchema, parsed, pool });
    }

    const lower = range.lower;
    const upper = lower + result.rows.length - 1;
    const cRange = contentRangeH(lower, upper, total);
    const status = rangeStatus(lower, upper, total);

    if (status === 416) {
      return error(
        new PostgRESTError(416, 'PGRST103',
          'Requested range not satisfiable',
          `An offset of ${lower} was requested, but there are only `
          + `${total} rows.`),
        corsHeaders,
        {
          'Content-Range': cRange,
          ...(base.preferenceApplied
            ? { 'Preference-Applied': base.preferenceApplied }
            : null),
        },
      );
    }

    return success(status, result.rows, {
      ...base,
      contentRange: cRange,
    });
  }

  return { handler };
}
