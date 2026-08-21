// handler.mjs — REST API handler

import { PostgRESTError, mapPgError } from './errors.mjs';
import { parseQuery } from './query-parser.mjs';
import {
  buildSelect, buildInsert, buildUpdate, buildDelete, buildCount,
  buildConflictCount, buildMutationRead, buildRpcCall, RPC_SCALAR,
} from './sql-builder.mjs';
import { getFunction } from './schema-cache.mjs';
import {
  findRoutine, parseContentMediaType,
  MT_JSON, MT_TEXT, MT_XML, MT_OCTET, MT_URLENCODED, MT_CSV,
} from './routines.mjs';
import {
  success, error, negotiateMedia, mediaProducible, mediaUnavailable,
  acceptsOpenApi, rawMediaFor,
  MEDIA_OPENAPI, MEDIA_SINGULAR,
} from './response.mjs';
import { installPgTypeParsers } from './pg-types.mjs';
import { route } from './router.mjs';
import { generateSpec } from './openapi.mjs';
import { buildCorsHeaders, preflightHeaders } from '../shared/cors.mjs';
import { assertBodySize } from '../shared/body-size.mjs';
import {
  randomBytes, createHmac, createVerify, createPublicKey, timingSafeEqual,
} from 'node:crypto';

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
 * Upstream has three strategies (`PreferCount`): `exact` runs a COUNT over the
 * filtered read, `planned` reads the query planner's row estimate and runs no
 * count at all, `estimated` runs both and takes the larger of the two once the
 * exact count has passed `db-max-rows`. All three put a total in Content-Range;
 * which query produces it is what `shouldExactCount`/`shouldExplainCount`
 * decide below.
 */
export function shouldCount(prefer) {
  return prefer.count === 'exact'
    || prefer.count === 'planned'
    || prefer.count === 'estimated';
}

/** Upstream `shouldCount`: which strategies run the real COUNT. */
export function shouldExactCount(prefer) {
  return prefer.count === 'exact' || prefer.count === 'estimated';
}

/** Upstream `shouldExplainCount`: which strategies ask the planner. */
export function shouldExplainCount(prefer) {
  return prefer.count === 'planned' || prefer.count === 'estimated';
}

/**
 * The row-producing form of a count query, which is what can be EXPLAINed for
 * an estimate.
 *
 * Upstream EXPLAINs `readPlanToCountQuery`, a `SELECT 1 FROM <filtered read>`,
 * and reads the estimate off the *top* node of the plan
 * (`[0].Plan."Plan Rows"`, MainTx.hs `decodeExplain`). An aggregate has to be
 * kept out of it: EXPLAIN of `SELECT COUNT(*) ...` reports one row at the top,
 * because that is how many rows the aggregate returns.
 *
 * The input is this engine's own generated count SQL, never anything a client
 * sent — filter values travel as `$n` parameters and stay untouched here.
 *
 * @param {string} countSql text from buildCount()
 * @returns {string|null} the EXPLAIN target, or null when the SQL is not in the
 *          shape this rewrite understands (the caller then falls back to the
 *          exact count rather than reporting a wrong total)
 */
export function explainCountSql(countSql) {
  const text = String(countSql || '');
  const prefix = /^SELECT COUNT\(\*\)(?: AS count)? FROM /i;
  return prefix.test(text) ? text.replace(prefix, 'SELECT 1 FROM ') : null;
}

/**
 * The planner's row estimate out of an `EXPLAIN (FORMAT JSON)` result.
 *
 * The driver hands the plan back either as parsed JSON or as the text
 * PostgreSQL printed, depending on how the type is registered, so both are
 * accepted. Only the top node's estimate is read — for a `SELECT 1` plan that
 * is the whole result set's estimate, including under a Gather.
 *
 * @param {*} value the single `QUERY PLAN` column
 * @returns {number|null}
 */
export function planRowsFromExplain(value) {
  let plan = value;
  if (typeof plan === 'string') {
    try {
      plan = JSON.parse(plan);
    } catch {
      return null;
    }
  }
  const top = Array.isArray(plan) ? plan[0]?.Plan : plan?.Plan;
  const rows = top?.['Plan Rows'];
  return Number.isFinite(Number(rows)) ? Number(rows) : null;
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

/**
 * Refuse a path that names no resource this API has.
 *
 * Upstream's `getResource` (ApiRequest.hs) recognises exactly three shapes —
 * nothing (the root spec), one segment (a relation), and `rpc/<name>` — and
 * answers anything else with 404 PGRST125. There is no nesting: `/items/1` is
 * not "row 1 of items", it is a path that does not exist, and saying so is what
 * keeps a mistyped URL from being served as a different relation's rows.
 *
 * Engine-specific single-segment paths (`_refresh`, `_docs`) are relation-shaped
 * and pass here; the router decides what they mean.
 *
 * @param {string} path the request path, with or without the /rest/v1 prefix
 * @throws {PostgRESTError} 404 PGRST125
 */
export function assertValidPath(path) {
  const remaining = String(path ?? '').replace(/^\/rest\/v1/, '');
  // A trailing slash names the same resource as the path without it, and the
  // router already reads it that way. Upstream's WAI `pathInfo` keeps the empty
  // segment and so refuses `/items/`; that difference is a proxy-normalisation
  // detail with no test behind it either way, and this engine's leniency here
  // predates this check.
  const trimmed = remaining.replace(/^\//, '').replace(/\/+$/, '');
  if (trimmed === '') return;
  const segments = trimmed.split('/');
  if (segments.length === 1) return;
  if (segments.length === 2 && segments[0] === 'rpc') return;
  throw new PostgRESTError(404, 'PGRST125',
    'Invalid path specified in request URL');
}

// What every response varies on (upstream App.hs `varyHeader`). Accept picks
// the media type, Prefer the shape and the counting, Range the window — three
// request headers that change the bytes without changing the URL, so a cache
// that ignores them serves the wrong body.
const VARY_VALUE = 'Accept, Prefer, Range';

// The phases `Server-Timing` reports, in upstream's order
// (Response/Performance.hs). A phase that did not happen — there is no plan or
// transaction behind an OPTIONS — is left out.
const TIMING_PHASES = ['jwt', 'parse', 'plan', 'transaction', 'response'];

/**
 * Render `Server-Timing` from the phase durations one request collected.
 *
 * Durations are milliseconds with one decimal, which is the unit the header is
 * defined in. `response` is not measured by the phases: it is whatever is left
 * of the request once the last measured phase ended, i.e. the time spent
 * turning rows into bytes.
 *
 * @param {Object} timings  phase → milliseconds
 * @param {bigint} startedAt process.hrtime.bigint() at the top of the request
 * @returns {string|null}
 */
function serverTimingHeader(timings, startedAt) {
  const total = Number(process.hrtime.bigint() - startedAt) / 1e6;
  const measured = TIMING_PHASES
    .filter(p => p !== 'response')
    .reduce((sum, p) => sum + (timings[p] || 0), 0);
  const all = { ...timings, response: Math.max(0, total - measured) };

  const parts = TIMING_PHASES
    .filter(p => all[p] != null)
    .map(p => `${p};dur=${all[p].toFixed(1)}`);
  return parts.length > 0 ? parts.join(', ') : null;
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

  // The window the query string asks for is intersected with `allRange` — 0 to
  // infinity — before anything else (upstream `getRanges` intersects with a
  // `headerRange` that defaults to `allRange`, and `allRange = rangeGeq 0`).
  // So a negative `offset` is a no-op on the lower bound while the upper bound
  // it implied stays where it was: `offset=-4` alone reads from row 0, and
  // `offset=-4&limit=3` keeps its upper bound of -2, which is an empty range.
  lower = Math.max(lower, 0);

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

// --- Location ---------------------------------------------------------------

/** RFC 3986 percent-encoding of one query-string key or value. */
function urlEncodePart(text) {
  return encodeURIComponent(text)
    .replace(/[!'()*]/g, ch => '%' + ch.charCodeAt(0).toString(16).toUpperCase());
}

/**
 * The canonical spelling of a request's query string: every parameter, sorted
 * by name, percent-encoded (upstream `qsCanonical`, built by
 * `urlEncodeVars . sortOn fst` over the parsed query).
 *
 * Two details of `Network.HTTP.Base.urlEncodeVars` are load-bearing and are
 * reproduced here: a parameter that appears more than once is written once with
 * its values joined by commas, in the order they were sent, and a parameter
 * with no value keeps its `=`. Nothing is dropped or rewritten — this is the
 * request as it would have to be re-sent to get the same rows, which is exactly
 * what makes it usable as a `Content-Location`.
 *
 * @param {Object} params            queryStringParameters
 * @param {Object} [multiValueParams] multiValueQueryStringParameters
 * @returns {string} `a=1&b=2`, or '' when there were no parameters
 */
export function canonicalQuery(params, multiValueParams) {
  const single = params || {};
  const multi = multiValueParams || null;
  const keys = [...new Set([
    ...Object.keys(single),
    ...(multi ? Object.keys(multi) : []),
  ])].sort();

  return keys.map((key) => {
    const values = multi && Array.isArray(multi[key])
      ? multi[key]
      : [single[key]];
    const joined = values
      .map(v => (v == null ? '' : urlEncodePart(v)))
      .join(',');
    return `${urlEncodePart(key)}=${joined}`;
  }).join('&');
}

/** A row value as `row_to_json` + `json_each_text` would spell it. */
function pkText(value) {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/**
 * The `Location` of a created row: `/<table>?<pk>=eq.<value>`, with `is.null`
 * for a null key (upstream `locationF` + `locationH`).
 *
 * Upstream builds it from `row_to_json` of the *first* row the INSERT
 * returned, keeping the keys that are primary-key columns — so the header is
 * there even when `?select=` left the primary key out — and emits it only when
 * the insert produced exactly one row and `Prefer: return=headers-only` asked
 * for it. A relation with no primary key gets no header at all.
 */
export function locationHeader(table, pkCols, rows) {
  if (!Array.isArray(rows) || rows.length !== 1) return null;
  if (!pkCols || pkCols.length === 0) return null;
  const row = rows[0];
  if (!row || typeof row !== 'object') return null;
  const wanted = new Set(pkCols);
  const parts = [];
  // Column order comes from the row, the way json_each_text walks the object.
  for (const [key, value] of Object.entries(row)) {
    if (!wanted.has(key)) continue;
    parts.push(`${urlEncodePart(key)}=${value === null || value === undefined
      ? 'is.null'
      : urlEncodePart(`eq.${pkText(value)}`)}`);
  }
  if (parts.length !== pkCols.length) return null;
  return `/${table}?${parts.join('&')}`;
}

/**
 * The `Allow` value for an OPTIONS request, following upstream's `allowH`
 * (Response.hs): a relation always allows OPTIONS, GET and HEAD, and each
 * writing method only when the relation accepts it — `pg_relation_is_updatable`
 * is what makes a view answer PATCH and a plain table answer everything. PUT
 * additionally needs a primary key, because a single-row upsert has nothing to
 * address the row by without one.
 *
 * A function allows OPTIONS and POST; a stable or immutable one also allows the
 * read methods, which is the same rule that decides whether it can be called
 * with GET at all.
 *
 * @param {{type: string, table?: string, functionName?: string}} routeInfo
 * @param {Object} schema the schema cache for this request's profile
 */
export function allowHeaderFor(routeInfo, schema) {
  if (routeInfo.type === 'rpc') {
    const candidates = schema?.routines?.[routeInfo.functionName] || [];
    const volatile = candidates.length === 0
      || candidates.some(c => c.volatility === 'v');
    return volatile ? 'OPTIONS,POST' : 'OPTIONS,GET,HEAD,POST';
  }

  if (routeInfo.type !== 'table') {
    // The root spec, the docs page and the cache refresh are not relations.
    return routeInfo.type === 'refresh' ? 'OPTIONS,POST' : 'OPTIONS,GET,HEAD';
  }

  const rel = schema?.tables?.[routeInfo.table] || {};
  const hasPk = (rel.primaryKey || []).length > 0;
  const methods = ['OPTIONS,GET,HEAD'];
  if (rel.insertable) methods.push('POST');
  if (rel.insertable && rel.updatable && hasPk) methods.push('PUT');
  if (rel.updatable) methods.push('PATCH');
  if (rel.deletable) methods.push('DELETE');
  return methods.join(',');
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

/**
 * NOT on the request path any more.
 *
 * Argument checking is upstream's `findProc` now (src/rest/routines.mjs): the
 * supplied argument *names* pick the overload, and a name that fits no overload
 * is a 404 PGRST202, not a 400. Types are cast in SQL (`$1::integer`) so a bad
 * value is the database's 22P02, not a hand-rolled PGRST208. These three are
 * kept only because the tests that pin them are outside this change's scope;
 * they should go with those tests.
 */
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
async function countRpcRows({ fnName, call, routine, parsed, schema, pool }) {
  if (routine.volatility !== 'i' && routine.volatility !== 's') {
    return null;
  }
  const q = buildRpcCall(fnName, call, routine, {
    ...parsed, limit: null, offset: 0, order: [],
  }, schema);
  if (q.resultMode !== 'set' && q.resultMode !== 'setofScalar') return null;

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

// --- RPC arguments ----------------------------------------------------------
//
// Where the arguments come from depends on the method and the Content-Type,
// and the *names* are needed before a routine can be resolved at all. So each
// source produces the same pair: the sorted key set that picks the overload,
// and the call payload that fills it in.

function sortedKeys(keys) {
  return [...new Set(keys)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** First line of a CSV body → its field names (upstream reads the header). */
function csvHeaderKeys(raw) {
  const line = String(raw || '').split(/\r?\n/)[0] || '';
  if (line === '') return [];
  return line.split(',').map(f => f.trim().replace(/^"|"$/g, ''));
}

function formPairs(raw) {
  const pairs = [];
  for (const [k, v] of new URLSearchParams(String(raw || ''))) {
    pairs.push([k, v]);
  }
  return pairs;
}

/**
 * `?columns=` restricts which body keys are arguments at all — the rest are
 * ignored rather than rejected (upstream `payloadColumns`).
 */
function restrictColumns(keys, columns) {
  if (!columns || columns.length === 0) return keys;
  const wanted = new Set(columns);
  return keys.filter(k => wanted.has(k));
}

// --- Mutation request bodies ------------------------------------------------
//
// A relation mutation writes a list of rows, and which parse turns the request
// body into that list is the Content-Type's business (upstream
// `ApiRequest/Payload.hs` `getPayload` for `ActRelationMut`). Every failure in
// here is the same wire error: 400 PGRST102.

function invalidBody(message) {
  return new PostgRESTError(400, 'PGRST102', message);
}

/**
 * CSV records per RFC 4180, which is what upstream's cassava reader accepts:
 * a quoted field may hold commas, newlines and `""` escapes.
 */
export function parseCsvRecords(text) {
  const src = text == null ? '' : String(text);
  const records = [];
  let record = [];
  let field = '';
  let quoted = false;
  let i = 0;
  const endRecord = () => {
    record.push(field);
    field = '';
    records.push(record);
    record = [];
  };
  while (i < src.length) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i += 1; continue;
      }
      field += ch; i += 1; continue;
    }
    if (ch === '"' && field === '') { quoted = true; i += 1; continue; }
    if (ch === ',') { record.push(field); field = ''; i += 1; continue; }
    if (ch === '\n' || ch === '\r') {
      endRecord();
      i += (ch === '\r' && src[i + 1] === '\n') ? 2 : 1;
      continue;
    }
    field += ch; i += 1;
  }
  // A trailing line terminator ends the last record rather than starting an
  // empty one.
  if (field !== '' || record.length > 0) endRecord();
  return records;
}

/**
 * A `text/csv` body → the rows it describes (upstream `csvToJson`): the first
 * line names the columns, a field spelled exactly `NULL` is JSON null, and
 * every other field stays a string for PostgreSQL to coerce.
 *
 * Upstream zips the header with each line, so a short line simply carries
 * fewer keys — and the key-uniformity check then rejects the whole payload
 * with "All lines must have same number of fields".
 */
function csvBodyToRows(raw) {
  const records = parseCsvRecords(raw);
  if (records.length === 0) return [];
  const header = records[0];
  const canonical = header.join('\u0000');
  return records.slice(1).map((rec) => {
    const row = {};
    const n = Math.min(header.length, rec.length);
    for (let k = 0; k < n; k += 1) {
      row[header[k]] = rec[k] === 'NULL' ? null : rec[k];
    }
    if (Object.keys(row).join('\u0000') !== canonical) {
      throw invalidBody('All lines must have same number of fields');
    }
    return row;
  });
}

/**
 * The rows a relation mutation writes.
 *
 * @param {object} args
 * @param {string} args.contentType  from parseContentMediaType()
 * @param {*} args.rawBody           the body before any parsing
 * @param {boolean} args.hasColumns  `?columns=` was given — that parameter *is*
 *        the column list, so upstream hands the JSON body through untouched
 *        (`RawJSON`) and never checks its keys.
 */
export function parseMutationBody({ contentType, rawBody, hasColumns }) {
  const text = rawBody == null ? '' : String(rawBody);

  if (contentType === MT_CSV) return csvBodyToRows(text);

  if (contentType === MT_URLENCODED) {
    // Every form field is a string value of one row.
    const row = {};
    for (const [k, v] of formPairs(text)) row[k] = v;
    return row;
  }

  if (contentType !== MT_JSON) {
    throw invalidBody(`Content-Type not acceptable: ${contentType}`);
  }

  let value;
  try {
    value = JSON.parse(text);
  } catch {
    // Upstream drops the parser's own message on purpose (issue #2344).
    throw invalidBody('Empty or invalid json');
  }
  if (hasColumns) return value;
  if (Array.isArray(value)) return value;
  if (value !== null && typeof value === 'object') return value;
  // Anything else is truncated to an empty array (`payloadAttributes`'
  // catch-all), so the mutation touches no row.
  return [];
}

/**
 * Arguments of a POST: the JSON body's keys, the form fields, the CSV header,
 * or — for a raw body — no names at all.
 */
function rpcPostArgs({ contentType, body, rawBody, columns }) {
  if (contentType === MT_URLENCODED) {
    const pairs = formPairs(rawBody);
    return {
      pairs,
      argKeys: sortedKeys(restrictColumns(pairs.map(([k]) => k), columns)),
    };
  }
  if (contentType === MT_TEXT || contentType === MT_XML) {
    return { raw: rawBody == null ? '' : String(rawBody), argKeys: [] };
  }
  if (contentType === MT_OCTET) {
    return { raw: rawBody, argKeys: [] };
  }
  if (contentType === MT_CSV) {
    return {
      raw: rawBody,
      argKeys: sortedKeys(restrictColumns(csvHeaderKeys(rawBody), columns)),
    };
  }
  // JSON (the default) — an array payload calls the function once, with the
  // first object (upstream takes the head of the recordset).
  const first = Array.isArray(body) ? body[0] : body;
  const obj = (first !== null && typeof first === 'object'
    && !Array.isArray(first)) ? first : {};
  return {
    json: obj,
    raw: rawBody == null ? '' : String(rawBody),
    argKeys: sortedKeys(restrictColumns(Object.keys(obj), columns)),
  };
}

/**
 * Query-string / form arguments → one value per parameter.
 *
 * A variadic parameter collects every repetition in query order; any other
 * parameter repeated keeps the last value (upstream `toRpcParams`).
 */
function mergeDirectArgs(routine, pairs) {
  const named = {};
  const variadic = new Set(
    routine.args.filter(a => a.variadic).map(a => a.name));
  for (const [key, value] of pairs) {
    if (variadic.has(key)) {
      if (!named[key]) named[key] = [];
      named[key].push(value);
    } else {
      named[key] = value;
    }
  }
  return named;
}

/**
 * Run one statement in a read-only transaction.
 *
 * `BEGIN READ ONLY` rather than `SET TRANSACTION READ ONLY` because the latter
 * is not accepted on Aurora DSQL, and a plain `SET` would leak onto a pooled
 * connection anyway. A pool hands out a dedicated connection for the duration;
 * an already-checked-out client (a session-scoped request) is used as it is,
 * and a bare `{query}` test double falls back to no transaction at all.
 */
async function queryReadOnly(pool, q) {
  const checkout = typeof pool.connect === 'function'
    && typeof pool.release !== 'function';
  const client = checkout ? await pool.connect() : pool;
  if (typeof client.query !== 'function') {
    throw new Error('pool has no query()');
  }
  try {
    await client.query('BEGIN READ ONLY');
    try {
      const result = await client.query(q.text, q.values);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // The transaction is already gone; the original error is what matters.
      }
      throw err;
    }
  } finally {
    if (checkout) client.release();
  }
}

/**
 * Run one statement and keep its effects only if it touched no more rows than
 * `max` allows.
 *
 * This is `Prefer: max-affected` on a function call. A function is a black box —
 * the rows it writes cannot be counted before it runs, the way a DELETE's can —
 * so upstream runs it, counts the rows it returned and aborts the request's
 * transaction when there are too many (`failMaxAffected`, checked inside
 * `MainTx.hs`'s transaction). The refusal therefore leaves the table exactly as
 * it was, which is the whole point of asking.
 *
 * @param {Object} pool
 * @param {{text: string, values: any[]}} q
 * @param {number} max
 * @throws {PostgRESTError} 400 PGRST124 when the count is over `max`
 */
async function queryMaxAffected(pool, q, max) {
  const checkout = typeof pool.connect === 'function'
    && typeof pool.release !== 'function';
  const client = checkout ? await pool.connect() : pool;
  if (typeof client.query !== 'function') {
    throw new Error('pool has no query()');
  }
  const rollback = async () => {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Already gone; whatever is being thrown is what matters.
    }
  };
  try {
    await client.query('BEGIN');
    let result;
    try {
      result = await client.query(q.text, q.values);
    } catch (err) {
      await rollback();
      throw err;
    }
    const affected = Array.isArray(result.rows) ? result.rows.length : 0;
    if (affected > max) {
      await rollback();
      throw new PostgRESTError(400, 'PGRST124',
        'Query result exceeds max-affected preference constraint',
        `The query affects ${affected} rows`);
    }
    await client.query('COMMIT');
    return result;
  } finally {
    if (checkout) client.release();
  }
}

/** A raw octet-stream body → a value `$1::bytea` accepts. */
function byteaLiteral(raw) {
  if (raw == null) return '\\x';
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), 'utf-8');
  return `\\x${buf.toString('hex')}`;
}

/**
 * The call payload for a resolved routine.
 *
 * A routine whose single parameter is unnamed takes the body verbatim; anything
 * else takes named arguments, and only the ones it declares (`?columns=` and
 * upstream both let unknown keys through as long as the *names* resolved).
 */
function rpcCallFor(routine, source, contentType) {
  const single = routine.args.length === 1 && routine.args[0].name === '';
  if (single) {
    return {
      mode: 'single',
      raw: contentType === MT_OCTET ? byteaLiteral(source.raw) : source.raw,
    };
  }
  if (source.pairs) {
    return { mode: 'direct', named: mergeDirectArgs(routine, source.pairs) };
  }
  return { mode: 'json', named: source.json || {} };
}

// --- Engine configuration surface -------------------------------------------
//
// Everything below implements the request-time half of the options resolved in
// src/index.mjs (`db-schemas`, `db-extra-search-path`, `db-pre-request`,
// `db-max-rows`, `db-aggregates-enabled`, `db-plan-enabled`, `jwt-secret` /
// `jwt-aud`). Each one is a no-op at its default value, so a deployment that
// configures nothing takes exactly the path it took before.

// Upstream ApiRequest.getSchema: these four methods select the schema with
// `Content-Profile`, everything else (GET, HEAD, OPTIONS) with `Accept-Profile`.
const CONTENT_PROFILE_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

/**
 * Pick the schema for this request out of the exposed set (`db-schemas`).
 *
 * @returns {{schema: string, negotiated: boolean}} `negotiated` is upstream's
 *   `iNegotiatedByProfile`: true when a profile header chose the schema, and
 *   also true when more than one schema is exposed (upstream then assumes the
 *   default schema was negotiated and echoes `Content-Profile`).
 */
export function resolveProfile(exposed, headers, method) {
  const raw = CONTENT_PROFILE_METHODS.has(method)
    ? headers['content-profile']
    : headers['accept-profile'];
  if (raw !== undefined && raw !== null) {
    const profile = String(raw);
    if (!exposed.includes(profile)) {
      throw new PostgRESTError(
        406, 'PGRST106', `Invalid schema: ${profile}`, null,
        `Only the following schemas are exposed: ${exposed.join(', ')}`);
    }
    return { schema: profile, negotiated: true };
  }
  return { schema: exposed[0], negotiated: exposed.length !== 1 };
}

/** Double-quote an identifier for use inside a search_path *value*. */
export function quoteIdent(name) {
  return `"${String(name).replaceAll('"', '""')}"`;
}

/**
 * The `search_path` a request runs with: the selected schema first, then
 * `db-extra-search-path` (upstream Query.hs `SET search_path TO <schema>,
 * <extra>`). Names are quoted, so a schema called `SPECIAL "@/\#~_-` resolves.
 */
export function searchPathValue(schema, extra = []) {
  return [schema, ...extra.filter(s => s !== schema)]
    .map(quoteIdent).join(', ');
}

/**
 * `app-settings`: the run-time settings every request runs with, so a function
 * can read them back with `current_setting('app.settings.<name>')`. Upstream
 * carries them as an ordered list of pairs (`configAppSettings`) and applies
 * them in `Query/PreQuery.hs txVarQuery`; accept either shape here — an object
 * or a list of `[name, value]` pairs — and drop entries with no name.
 *
 * @param {Object|Array|null|undefined} settings
 * @returns {Array<[string, string]>}
 */
export function normalizeAppSettings(settings) {
  if (!settings) return [];
  const pairs = Array.isArray(settings) ? settings : Object.entries(settings);
  return pairs
    .filter(pair => Array.isArray(pair) && pair[0] != null && pair[0] !== ''
      && pair[1] != null)
    .map(([name, value]) => [String(name), String(value)]);
}

/**
 * One statement setting every app setting, with both the name and the value
 * bound. Upstream uses `set_config(name, value, true)` for the same reason: the
 * setting is transaction-local, so PostgreSQL drops it when the request's
 * transaction ends and the pooled connection cannot leak it into the next
 * request (`setConfigWithDynamicName`).
 *
 * @param {Array<[string, string]>} settings
 */
export function appSettingsSql(settings) {
  const calls = settings.map(
    (_, i) => `set_config($${i * 2 + 1}, $${i * 2 + 2}, true)`);
  return `select ${calls.join(', ')}`;
}

function preRequestSql(preRequest) {
  const fn = preRequest.schema
    ? `${quoteIdent(preRequest.schema)}.${quoteIdent(preRequest.name)}`
    : quoteIdent(preRequest.name);
  return `select ${fn}()`;
}

/** Does any select node — at any depth, spread or not — use an aggregate? */
export function hasAggregate(nodes) {
  if (!Array.isArray(nodes)) return false;
  return nodes.some(n => (n.type === 'column' && n.agg)
    || (n.type === 'embed' && hasAggregate(n.select)));
}

const PLAN_MEDIA = /^application\/vnd\.pgrst\.plan\b/;

/** True when the client asked for an execution plan (`db-plan-enabled`). */
export function wantsPlan(accept) {
  return String(accept || '').split(',')
    .some(e => PLAN_MEDIA.test(e.trim().toLowerCase()));
}

/**
 * Apply `db-max-rows` to a read plan: every node's limit becomes
 * `min(limit, max-rows)`, top level and embeds alike (upstream Plan.hs
 * `treeRestrictRange`, which skips mutations).
 */
export function clampMaxRows(parsed, maxRows) {
  if (!maxRows && maxRows !== 0) return parsed;
  const clampLimit = (limit) =>
    (limit == null || limit > maxRows) ? maxRows : limit;
  const clampNode = (node) => {
    if (node.type !== 'embed') return node;
    return {
      ...node,
      limit: clampLimit(node.limit),
      select: Array.isArray(node.select) ? node.select.map(clampNode) : node.select,
    };
  };
  return {
    ...parsed,
    limit: clampLimit(parsed.limit),
    select: Array.isArray(parsed.select)
      ? parsed.select.map(clampNode) : parsed.select,
  };
}

// --- In-engine JWT verification --------------------------------------------
//
// Off unless `jwt-secret` is configured (see resolveRestJwt in src/index.mjs).
// The normal deployment verifies in the API Gateway authorizer and hands the
// engine a role; this path is for standalone deployments, and it is what
// upstream's auth specs assert against.

const BEARER = /^bearer\s+(.+)$/i;

function invalidToken(code, message, status = 401) {
  const err = new PostgRESTError(status, code, message);
  err.responseHeaders = {
    'WWW-Authenticate':
      `Bearer error="invalid_token", error_description="${message}"`,
  };
  return err;
}

function jwtKey(cfg) {
  const secret = cfg.secret;
  if (secret == null || secret === '') return null;
  const text = typeof secret === 'string' ? secret : null;
  const trimmed = text ? text.trim() : '';
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    // A JWK or JWK Set (upstream `parseSecret`).
    let doc;
    try {
      doc = JSON.parse(trimmed);
    } catch {
      return { kind: 'hmac', key: Buffer.from(text, 'utf8') };
    }
    const keys = Array.isArray(doc) ? doc
      : (Array.isArray(doc.keys) ? doc.keys : [doc]);
    return { kind: 'jwk', keys };
  }
  const raw = cfg.secretIsBase64
    ? Buffer.from(text, 'base64')
    : Buffer.from(text, 'utf8');
  return { kind: 'hmac', key: raw };
}

function decodeSegment(segment) {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
}

/**
 * Verify a bearer token and return the identity the request runs as.
 *
 * Upstream error vocabulary (Error.hs): PGRST300 when the server has no secret
 * at all, PGRST301 for anything that fails to decode or verify, PGRST302 when
 * anonymous access is disabled, PGRST303 for a claim the server rejects.
 */
export function verifyRestJwt(cfg, authorization, verifier) {
  const raw = authorization ? String(authorization).trim() : '';
  const anon = () => {
    if (cfg.anonRole == null) {
      const err = new PostgRESTError(
        401, 'PGRST302', 'Anonymous access is disabled');
      err.responseHeaders = { 'WWW-Authenticate': 'Bearer' };
      throw err;
    }
    return { role: cfg.anonRole, userId: '', email: '' };
  };
  if (!raw) return anon();
  const m = BEARER.exec(raw);
  if (!m) return anon();
  const token = m[1].trim();

  const key = jwtKey(cfg);
  if (!key) {
    throw new PostgRESTError(500, 'PGRST300', 'Server lacks JWT secret');
  }

  let claims;
  try {
    claims = verifier(token, key);
  } catch (err) {
    if (err instanceof PostgRESTError) throw err;
    throw invalidToken('PGRST301', err.message || 'JWT decode error');
  }

  // Audience: upstream checks it itself so the message is its own. A missing
  // or null `aud` claim is accepted; anything else must contain jwt-aud.
  if (cfg.audience) {
    const aud = claims.aud;
    const present = aud !== undefined && aud !== null;
    const list = Array.isArray(aud) ? aud : [aud];
    if (present && !list.includes(cfg.audience)) {
      throw invalidToken('PGRST303', 'JWT not in audience');
    }
  }

  const role = typeof claims.role === 'string' && claims.role
    ? claims.role
    : cfg.anonRole;
  if (role == null) {
    const err = new PostgRESTError(
      401, 'PGRST302', 'Anonymous access is disabled');
    err.responseHeaders = { 'WWW-Authenticate': 'Bearer' };
    throw err;
  }
  return {
    role,
    userId: claims.sub || claims.id || claims.user_id || '',
    email: claims.email || '',
    claims,
  };
}

/**
 * Decide what a filterless UPDATE/DELETE does (`db-bulk-mutation-guard`).
 *
 * `on` (default) leaves the refusal to sql-builder, which is where it has
 * always lived; `safeupdate` refuses with pg-safeupdate's wire error, the one
 * upstream produces when the extension is loaded; `off` lets it through, which
 * is upstream's behaviour with no extension loaded.
 */
export function applyBulkGuard(mode, method, parsed) {
  if (mode === 'off') return { ...parsed, allowBulkMutation: true };
  if (mode === 'safeupdate') {
    const verb = method === 'DELETE' ? 'DELETE' : 'UPDATE';
    throw new PostgRESTError(
      400, '21000', `${verb} requires a WHERE clause`);
  }
  return parsed;
}

// Signature check, split out so verifyRestJwt stays testable without crypto.
function defaultVerifier(token, key) {
  const parts = String(token).split('.');
  if (parts.length !== 3) throw new Error('Expected 3 parts in JWS');
  const header = decodeSegment(parts[0]);
  const signing = `${parts[0]}.${parts[1]}`;
  const signature = Buffer.from(parts[2], 'base64url');
  const alg = String(header.alg || '');

  if (key.kind === 'hmac') {
    if (!/^HS(256|384|512)$/.test(alg)) {
      throw new Error(`JWSError (JWSInvalidSignature): unsupported alg ${alg}`);
    }
    const expected = createHmac(`sha${alg.slice(2)}`, key.key)
      .update(signing).digest();
    if (expected.length !== signature.length
        || !timingSafeEqual(expected, signature)) {
      throw new Error('JWSError JWSInvalidSignature');
    }
  } else {
    const candidates = key.keys.filter(
      k => !header.kid || !k.kid || k.kid === header.kid);
    const digest = { RS256: 'sha256', RS384: 'sha384', RS512: 'sha512' }[alg];
    if (!digest) {
      throw new Error(`JWSError (JWSInvalidSignature): unsupported alg ${alg}`);
    }
    const ok = candidates.some((jwk) => {
      try {
        const pub = createPublicKey({ key: jwk, format: 'jwk' });
        return createVerify(digest).update(signing).verify(pub, signature);
      } catch {
        return false;
      }
    });
    if (!ok) throw new Error('JWSError JWSInvalidSignature');
  }

  const claims = decodeSegment(parts[1]);
  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp === 'number' && claims.exp <= now) {
    throw new Error('JWTExpired');
  }
  if (typeof claims.nbf === 'number' && claims.nbf > now) {
    throw new Error('JWTNotYetValid');
  }
  return claims;
}

export function createRestHandler(ctx, contributions = []) {
  const { db, schemaCache, cedar, docs } = ctx;
  const corsConfig = ctx.cors;
  const exposedSchemas = ctx.dbSchemas?.length ? ctx.dbSchemas : ['public'];
  const extraSearchPath = ctx.dbExtraSearchPath?.length
    ? ctx.dbExtraSearchPath : ['public'];
  const getSchemaFor = ctx.getSchemaFor
    || ((name, pool) => schemaCache.getSchema(pool));
  const refreshSchemaFor = ctx.refreshSchemaFor
    || ((name, pool) => schemaCache.refresh(pool));
  // Is any request-scoped session setup configured? When nothing is (the
  // default: `public` alone, no extra search path, no pre-request function) the
  // engine never checks out a dedicated connection and never issues a
  // set_config, exactly as before. When something is, *every* request pins a
  // connection and sets its search_path — a request must never inherit the
  // path a previous request left on a pooled connection.
  const sessionScoped = Boolean(ctx.dbPreRequest)
    || exposedSchemas.some(s => s !== 'public')
    || !(extraSearchPath.length === 1 && extraSearchPath[0] === 'public');

  /**
   * Check out the connection this request will use and put the settings it
   * asked for on it.
   *
   * `Prefer: timezone=` is one of those settings, and it is why a request with
   * no session-scoped *configuration* can still need a pinned connection: the
   * setting has to be visible to the statements that follow and invisible to
   * every other request. It is set with `is_local = true` inside an explicit
   * transaction, so PostgreSQL itself drops it at the end — nothing has to be
   * reset, and a connection can never be handed back carrying it.
   *
   * @param {Object} basePool
   * @param {string} schemaName
   * @param {string} [timezone] the raw `Prefer: timezone=` value; an invalid
   *        one raises PostgreSQL's own 22023, which is the error upstream
   *        reports for it
   */
  async function openSession(basePool, schemaName, timezone) {
    const appSettings = normalizeAppSettings(ctx.appSettings);
    const wantsTx = timezone != null || appSettings.length > 0;
    if (!sessionScoped && !wantsTx) return { pool: basePool, release: null };
    // Test doubles inject a bare `{query}`; there is nothing to check out, so
    // the session settings land on whatever that object talks to.
    const client = typeof basePool.connect === 'function'
      ? await basePool.connect()
      : null;
    const target = client || basePool;
    let inTx = false;
    const release = async () => {
      if (inTx) {
        try {
          // A failed statement has already aborted the transaction, and there
          // COMMIT is PostgreSQL's own spelling of ROLLBACK — no write from a
          // request that errored can reach the table this way.
          await target.query('COMMIT');
        } catch {
          try { await target.query('ROLLBACK'); } catch { /* gone already */ }
        }
      }
      if (client) client.release();
    };
    try {
      if (sessionScoped) {
        await target.query('select set_config($1, $2, false)',
          ['search_path', searchPathValue(schemaName, extraSearchPath)]);
        if (ctx.dbPreRequest) {
          await target.query(preRequestSql(ctx.dbPreRequest));
        }
      }
      if (wantsTx) {
        await target.query('BEGIN');
        inTx = true;
        if (timezone != null) {
          await target.query('select set_config($1, $2, true)',
            ['timezone', timezone]);
        }
        if (appSettings.length) {
          await target.query(appSettingsSql(appSettings), appSettings.flat());
        }
      }
    } catch (err) {
      await release();
      throw err;
    }
    return { pool: target, release };
  }

  // int8/numeric must reach the client as JSON numbers, the way PostgREST's
  // in-database json_agg emits them.
  installPgTypeParsers();

  async function handler(event) {
    const negotiated = { timings: null };
    const startedAt = process.hrtime.bigint();
    // Every phase starts at zero rather than absent: upstream wraps all five
    // stages in `withTiming` on every path, so the header names all five even
    // for a request that never opened a transaction (App.hs `NoDbTx`). A phase
    // this request never entered reports 0.0, which is what it spent there.
    if (ctx.serverTiming) {
      negotiated.timings = { jwt: 0, parse: 0, plan: 0, transaction: 0 };
    }
    const response = await handleRequest(event, negotiated);

    const headers = { ...response.headers };

    // `Content-Profile` rides on successful responses only, like upstream's
    // contentTypeHeaders (Response.hs `profileHeader`).
    if (negotiated.contentProfile
        && response.statusCode >= 200 && response.statusCode < 300) {
      headers['Content-Profile'] = negotiated.contentProfile;
    }

    // Every response says what it varies on, unless something upstream of here
    // already said (upstream App.hs: `[varyHeader | not $ varyHeaderPresent
    // hdrs]`). The three headers named are the ones that change the bytes:
    // Accept picks the media type, Prefer the shape and the counting, Range the
    // window.
    if (!Object.keys(headers).some(h => h.toLowerCase() === 'vary')) {
      headers['Vary'] = VARY_VALUE;
    }

    if (negotiated.timings) {
      const timing = serverTimingHeader(negotiated.timings, startedAt);
      if (timing) headers['Server-Timing'] = timing;
    }

    return { ...response, headers };
  }

  async function handleRequest(event, negotiated) {
    const headers = lowercaseHeaders(event.headers);
    const origin = headers['origin'] || '';
    const corsHeaders = buildCorsHeaders(corsConfig, origin);
    // Read outside the try: the catch below needs it to decide between 401 and
    // 403 for insufficient_privilege, and a `const` inside the try block is not
    // in scope there.
    let role = event.requestContext?.authorizer?.role || 'anon';
    let releaseSession = null;
    // `client-error-verbosity`: passed to every error() so `minimal` drops
    // `details` and `hint` from the payload (upstream Error.hs).
    const errorOpts = { clientErrorVerbosity: ctx.clientErrorVerbosity };

    const timings = negotiated.timings;
    const clock = () => process.hrtime.bigint();
    /** Charge the time since `from` to one Server-Timing phase. */
    const record = (phase, from) => {
      if (timings) {
        timings[phase] = (timings[phase] || 0)
          + Number(clock() - from) / 1e6;
      }
    };

    try {
      // A CORS preflight is answered before the request reaches a relation:
      // it asks whether a *later* request would be allowed, so it must not be
      // routed, authorized or counted. Upstream answers it in the wai-cors
      // middleware, which recognises it by the method it names in
      // `Access-Control-Request-Method`.
      //
      // An OPTIONS *without* that header is not a preflight — it is a request
      // for the relation's own capabilities, and it goes down the normal path
      // so an unknown relation still answers 404.
      if (event.httpMethod === 'OPTIONS'
          && headers['access-control-request-method']) {
        return {
          statusCode: 200,
          headers: {
            ...corsHeaders,
            ...preflightHeaders(headers['access-control-request-headers']),
            'Content-Length': '0',
          },
          body: '',
        };
      }

      // HEAD is GET with the body dropped at the very end (upstream keeps one
      // plan for both and only blanks the payload), so everything downstream
      // sees GET.
      const rawMethod = event.httpMethod;
      const headersOnly = rawMethod === 'HEAD';
      const method = headersOnly ? 'GET' : rawMethod;
      const path = event.path;
      const authorizer = event.requestContext?.authorizer || {};
      let userId = authorizer.userId || authorizer.claims?.sub || '';
      let email = authorizer.email || '';

      // `jwt-secret` configured: the engine verifies the bearer token itself
      // and the claims — not the API Gateway authorizer — decide the identity.
      const jwtStart = clock();
      if (ctx.restJwt) {
        const identity = verifyRestJwt(
          ctx.restJwt, headers['authorization'], defaultVerifier);
        role = identity.role;
        userId = identity.userId;
        email = identity.email;
      }
      record('jwt', jwtStart);

      const parseStart = clock();
      let body = null;
      // The body before JSON parsing. RPC needs it: a `text/plain`, `text/xml`
      // or `application/octet-stream` body is itself the argument of a function
      // with a single unnamed parameter, and a form body is a set of arguments.
      let rawBody = null;
      if (event.body) {
        assertBodySize(event.body);
        rawBody = event.isBase64Encoded
          ? Buffer.from(event.body, 'base64')
          : event.body;
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
      // Negotiated for a relation or a routine: `application/openapi+json` is
      // produced by the root path alone, and the root path below negotiates on
      // its own.
      const media = negotiateMedia(accept, { openApi: false });
      // RFC 9110: the Range header is only meaningful on GET. Upstream tests
      // the *raw* method (`headerRange = if method == "GET" ...` in
      // ApiRequest.getRanges), so a HEAD carrying a Range is served as if the
      // header were not there — only limit/offset shape its Content-Range.
      const headerRange = rawMethod === 'GET'
        ? parseRangeHeader(headers['range'])
        : null;

      // `db-plan-enabled` is off by default, and upstream refuses the plan
      // media type outright until it is turned on.
      if (!ctx.dbPlanEnabled && wantsPlan(accept)) {
        throw new PostgRESTError(406, 'PGRST107',
          'None of these media types are available: '
          + String(accept).split(',').map(s => s.trim()).join(', '));
      }

      // `db-schemas`: which schema this request reads and writes.
      const profile = resolveProfile(exposedSchemas, headers, rawMethod);
      if (profile.negotiated) negotiated.contentProfile = profile.schema;

      assertValidPath(path);
      record('parse', parseStart);

      const planStart = clock();
      const basePool = await db.getPool();
      const session = await openSession(
        basePool, profile.schema, prefer.timezone);
      releaseSession = session.release;
      const pool = session.pool;
      const schema = await getSchemaFor(profile.schema, pool);

      // The schema name is passed so PGRST205 can name the relation the way
      // upstream does: "the table 'v1.another_table'", not just the table.
      // `openapi-mode=disabled` makes the root report no metadata at all
      // (upstream `Config.OpenAPIMode`), which router.mjs turns into
      // 404 PGRST126.
      const routeInfo = route(path, schema, profile.schema,
        { openApiMode: ctx.openApiMode });
      record('plan', planStart);

      // OPTIONS on a resource that exists reports what can be done with it and
      // nothing else: no rows are read, no function is called (upstream's
      // ActRelationInfo / ActRoutineInfo, answered by `respondInfo`). Routing
      // has already turned an unknown relation into a 404.
      if (rawMethod === 'OPTIONS') {
        return {
          statusCode: 200,
          headers: {
            ...corsHeaders,
            'Content-Length': '0',
            Allow: allowHeaderFor(routeInfo, schema),
          },
          body: '',
        };
      }

      if (routeInfo.type === 'openapi') {
        // The root path produces the OpenAPI spec and nothing else, so an
        // Accept naming none of `application/openapi+json`, `application/json`
        // or `*/*` is PGRST107 (upstream `Plan.inspectPlan`).
        if (!acceptsOpenApi(accept)) throw mediaUnavailable(accept);
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
        const newSchema = await refreshSchemaFor(profile.schema, pool);
        await cedar.refreshPolicies();
        const apiUrl = resolveApiUrl(ctx, headers);
        const resolved = resolveContributions(contributions, apiUrl);
        return success(200, generateSpec(newSchema, apiUrl, resolved), { corsHeaders });
      }

      if (routeInfo.type === 'rpc') {
        return await handleRpc({
          fnName: routeInfo.functionName, method, rawMethod, body, rawBody,
          schemaName: profile.schema,
          params, multiValueParams, accept, prefer, headers,
          schema, pool, cedar, ctx, corsHeaders,
          role, userId, email,
          media, headersOnly, headerRange,
          // `client-error-verbosity` reaches the RPC 416 the same way it
          // reaches every other error(): passed in, since handleRpc is not
          // nested inside handleRequest's scope.
          errorOpts,
        });
      }

      const table = routeInfo.table;

      // Content negotiation happens in the plan, before the query is parsed
      // (upstream `Plan.wrappedReadPlan` calls `negotiateContent` and
      // CustomMediaSpec:306 expects the 406 to win over a bad `select`). A
      // relation produces json, csv and the vendored pgrst media types; asking
      // for anything else is PGRST107.
      if (!mediaProducible(media)) throw mediaUnavailable(accept);

      // The request body's own media type decides how a mutation payload is
      // read (JSON, CSV or a form).
      const contentType = parseContentMediaType(headers['content-type']);

      const parsedRaw = parseQuery(
        params, method, multiValueParams, ctx.maxEmbedDepth);

      // `db-aggregates-enabled`
      if (ctx.dbAggregatesEnabled === false && hasAggregate(parsedRaw.select)) {
        throw new PostgRESTError(400, 'PGRST123',
          'Use of aggregate functions is not allowed');
      }

      // PUT addresses exactly one row, so a window over the result set makes
      // no sense (upstream `PutLimitNotAllowedError`).
      if (method === 'PUT'
          && (parsedRaw.limit != null || (parsedRaw.offset || 0) > 0)) {
        throw new PostgRESTError(400, 'PGRST114',
          'limit/offset querystring parameters are not allowed for PUT');
      }

      const range = effectiveRange(parsedRaw, headerRange);
      // `db-max-rows` caps reads at every level of the tree, and never a
      // mutation (upstream `treeRestrictRange` skips ActRelationMut).
      const parsed = method === 'GET'
        ? clampMaxRows(
          { ...parsedRaw, limit: range.limit, offset: range.offset },
          ctx.dbMaxRows)
        : parsedRaw;
      const hasEmbeds = parsed.select.some(
        n => n.type === 'embed');

      // Filterless UPDATE/DELETE. Upstream ships no guard of its own — it
      // relies on the pg-safeupdate extension, which is loaded per session by
      // a `db-pre-request` function and answers SQLSTATE 21000. This engine
      // guards by default (`on`); `safeupdate` keeps the guard with upstream's
      // wire error, `off` allows the mutation through.
      const mutationParsed =
        (method === 'PATCH' || method === 'DELETE')
          && parsed.filters.length === 0
          ? applyBulkGuard(ctx.bulkMutationGuard, method, parsed)
          : parsed;

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

      /**
       * The query planner's row estimate for the filtered read — upstream's
       * `count=planned`, which never touches the rows themselves.
       *
       * @returns {Promise<number|null>} null when no estimate could be read,
       *          so the caller can fall back to counting for real rather than
       *          report a total it made up.
       */
      async function plannedCount(p) {
        const cq = buildCount(table, p, schema, parentAuthz);
        const target = explainCountSql(cq.text);
        if (!target) return null;
        const cr = await pool.query(
          `EXPLAIN (FORMAT JSON) ${target}`, cq.values);
        return planRowsFromExplain(cr.rows[0]?.['QUERY PLAN']);
      }

      /**
       * The exact count, stopped as soon as it has seen one row more than
       * `db-max-rows` — enough to know the window was surpassed without
       * walking a large table (upstream `limitedQuery countQuery (maxRows+1)`).
       */
      async function limitedExactCount(p, limit) {
        const cq = buildCount(table, p, schema, parentAuthz);
        const target = explainCountSql(cq.text);
        if (limit == null || !target) return countRows(p);
        const values = [...cq.values, limit + 1];
        const cr = await pool.query(
          `SELECT COUNT(*) FROM (${target} LIMIT $${values.length})`
          + ' _pgrst_count',
          values);
        return parseInt(cr.rows[0].count, 10);
      }

      /**
       * The total Content-Range reports, by the strategy the request asked for
       * (upstream MainTx.hs `actionResult`, WrappedReadPlan branch).
       *
       * `estimated` runs both queries: the exact count is authoritative until
       * it passes `db-max-rows`, at which point it was cut short and the
       * planner's estimate is the better answer if it is larger. With no
       * `db-max-rows` configured upstream's comparison is vacuously true, so
       * the larger of the two always wins.
       */
      async function countTotal(p) {
        const maxRows = Number.isSafeInteger(ctx.dbMaxRows)
          ? ctx.dbMaxRows : null;

        if (prefer.count === 'planned') {
          const estimate = await plannedCount(p);
          return estimate == null ? countRows(p) : estimate;
        }

        if (prefer.count === 'estimated') {
          const exact = await limitedExactCount(p, maxRows);
          if (maxRows != null && exact <= maxRows) return exact;
          const estimate = await plannedCount(p);
          return estimate == null ? exact : Math.max(exact, estimate);
        }

        return countRows(p);
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

      // `application/vnd.pgrst.object+json` on a mutation is a claim about the
      // result, not about how it is rendered: upstream runs the mutation, sees
      // a row count other than one, answers PGRST116 and rolls the whole
      // transaction back — so the rows stay untouched even with
      // `Prefer: tx=commit, return=minimal` (SingularSpec "the rows should not
      // be updated, either"). This engine has no transaction to roll back, so
      // it counts the rows the filters select before touching them, the same
      // way max-affected is enforced, and refuses first.
      async function assertSingularMutation(action) {
        if (media.kind !== MEDIA_SINGULAR) return;
        // Count under the mutation's own authorization filter, not the read
        // filter: a policy that hides a row from SELECT but allows the UPDATE
        // must not turn into a spurious PGRST116.
        const authz = cedar.buildAuthzFilter({
          principal, action, context: { table }, schema,
          startParam: 1, // renumbered by buildCount
        });
        const cq = buildCount(
          table, { ...mutationParsed, select: [] }, schema, authz);
        const cr = await pool.query(cq.text, cq.values);
        const total = parseInt(cr.rows[0].count, 10);
        const available = Math.max(0, total - (mutationParsed.offset || 0));
        const affected = mutationParsed.limit != null
          ? Math.min(available, mutationParsed.limit)
          : available;
        if (affected !== 1) {
          throw new PostgRESTError(406, 'PGRST116',
            'Cannot coerce the result to a single JSON object',
            `The result contains ${affected} rows`);
        }
      }

      /**
       * Run a mutation and return the rows its representation is built from.
       *
       * With an embed in `?select=` the statement carries the whole read plan
       * with it, over its own source CTE (sql-builder `buildMutationRead`),
       * because the rows a DELETE returns cannot be read again afterwards and
       * because `?order=` applies to the representation.
       */
      async function runMutation(q) {
        if (!(prefer.return === 'representation' && hasEmbeds)) {
          return (await pool.query(q.text, q.values)).rows;
        }
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
        const read = buildMutationRead(
          q, table, parsed, schema, authzFilters);
        return (await pool.query(read.text, read.values)).rows;
      }

      const txStart = clock();

      switch (method) {
        case 'GET': {
          rows = await runSelect(parsed);

          if (shouldCount(prefer)) {
            count = await countTotal(parsed);
          }
          break;
        }

        case 'POST': {
          const payload = parseMutationBody({
            contentType, rawBody,
            hasColumns: (parsed.columns || []).length > 0,
          });

          const insertRows = Array.isArray(payload) ? payload : [payload];
          cedar.authorizeInsert({
            principal, resource: table, schema,
            rows: insertRows,
          });

          // An INSERT's result row count is its payload's length, so the
          // singular claim can be settled before the write (see
          // assertSingularMutation). Exactly one row is left to the normal
          // path: `resolution=ignore-duplicates` can still insert none, and
          // that count only exists after the statement runs.
          if (media.kind === MEDIA_SINGULAR) {
            const n = insertRows.length;
            if (n !== 1) {
              throw new PostgRESTError(406, 'PGRST116',
                'Cannot coerce the result to a single JSON object',
                `The result contains ${n} rows`);
            }
          }

          // `ON CONFLICT` is the resolution preference's job: upstream emits it
          // only when `Prefer: resolution=` is present, with `?on_conflict=` —
          // or the primary key — as the target (Plan.hs `mutatePlan`). Passing
          // the preference down means `resolution=ignore-duplicates` and a
          // bare `resolution=merge-duplicates` (no `?on_conflict=`) work too.
          // With no representation to return, upstream reads the source CTE
          // back as `SELECT *` — "prevent using any of the column names in
          // ?select= when no response is returned from the CTE"
          // (Statements.hs `selectF`) — and the whole row is also where the
          // Location header's primary-key values come from.
          const insertParsed = prefer.return === 'representation'
            ? parsed
            : { ...parsed, select: [] };

          // `resolution=merge-duplicates` answers 200 when the statement
          // inserted nothing, so the rows that already exist are counted
          // first (see buildConflictCount).
          if (prefer.resolution === 'merge-duplicates') {
            const target = parsed.onConflict
              ? parsed.onConflict.split(',').map(c => c.trim())
              : (schema.tables[table]?.primaryKey || []);
            const cq = buildConflictCount(
              table, insertRows, target, schema, parsed.columns);
            const conflicting = cq
              ? parseInt((await pool.query(cq.text, cq.values)).rows[0].count,
                10)
              : 0;
            upsertInserted = insertRows.length - conflicting > 0;
          }

          const q = buildInsert(table, payload, schema, insertParsed, {
            resolution: prefer.resolution || null,
            applyDefaults: prefer.missing === 'default',
          });

          rows = await runMutation(q);
          break;
        }

        case 'PATCH': {
          const payload = parseMutationBody({
            contentType, rawBody,
            hasColumns: (parsed.columns || []).length > 0,
          });
          await assertMaxAffected();
          await assertSingularMutation('update');
          const updateOpts = {
            applyDefaults: prefer.missing === 'default',
          };
          const preview = buildUpdate(
            table, payload, mutationParsed, schema, null, updateOpts);
          const authz = cedar.buildAuthzFilter({
            principal, action: 'update', context: { table }, schema,
            startParam: preview.values.length + 1,
          });
          const q = buildUpdate(
            table, payload, mutationParsed, schema, authz, updateOpts,
          );
          rows = await runMutation(q);
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

          // Upstream's MutationSingleUpsert hardcodes the resolution:
          // `Insert qi cols body (Just (MergeDuplicates, pkCols)) ...`.
          const q = buildInsert(table, [payloadRow], schema, {
            ...parsed, onConflict: pk.join(','),
          }, { resolution: 'merge-duplicates' });
          const result = await pool.query(q.text, q.values);
          rows = result.rows;
          break;
        }

        case 'DELETE': {
          await assertMaxAffected();
          await assertSingularMutation('delete');
          const preview = buildDelete(table, mutationParsed, schema);
          const authz = cedar.buildAuthzFilter({
            principal, action: 'delete', context: { table }, schema,
            startParam: preview.values.length + 1,
          });
          const q = buildDelete(
            table, mutationParsed, schema, authz,
          );
          rows = await runMutation(q);
          break;
        }

        default:
          throw new PostgRESTError(
            405, 'PGRST000', `Method ${method} not allowed`,
          );
      }

      record('transaction', txStart);

      const returnRep = prefer.return === 'representation';

      // PUT: RETURNING is empty when ON CONFLICT DO NOTHING fires (a table
      // whose only columns are its primary key), and generated/embedded
      // columns are not in it either, so re-read the row the URL pins.
      if (method === 'PUT' && returnRep) {
        rows = await runSelect({ ...parsed, limit: null, offset: 0 });
      }

      const total = shouldCount(prefer) ? (count ?? rows.length) : null;
      const base = { media, headersOnly, corsHeaders };

      if (method === 'GET') {
        const lower = range.lower;
        const upper = lower + rows.length - 1;
        const cRange = contentRangeH(lower, upper, total);
        const status = rangeStatus(lower, upper, total);
        const applied = preferenceApplied(prefer, 'read');
        // The request that would fetch these rows again, canonically spelled.
        // Only a relation read gets one: it is the identity of a resource, and
        // a function call or a mutation is not addressable this way.
        const canonical = canonicalQuery(params, multiValueParams);
        const contentLocation =
          `/${table}${canonical ? `?${canonical}` : ''}`;

        if (status === 416) {
          return error(
            new PostgRESTError(416, 'PGRST103',
              'Requested range not satisfiable',
              `An offset of ${lower} was requested, but there are only `
              + `${total} rows.`),
            corsHeaders,
            {
              'Content-Range': cRange,
              'Content-Location': contentLocation,
              ...(applied ? { 'Preference-Applied': applied } : null),
            },
            errorOpts,
          );
        }

        return success(status, rows, {
          ...base,
          contentRange: cRange,
          preferenceApplied: applied,
          extraHeaders: { 'Content-Location': contentLocation },
        });
      }

      if (method === 'POST') {
        const pkCols = schema.tables[table]?.primaryKey || [];
        const extra = {
          // Upstream's MutationCreate branch always appends
          // `contentLengthHeader`, so a 201 with `return=minimal` still
          // states a length of zero. The 204 branches do not.
          ...(returnRep || headersOnly
            ? null
            : { 'Content-Length': '0' }),
          // `Prefer: return=headers-only` is what asks for the Location of the
          // created row (Statements.hs `locF`).
          ...(prefer.return === 'headers-only'
            ? (() => {
              const loc = locationHeader(table, pkCols, rows);
              return loc ? { Location: loc } : null;
            })()
            : null),
        };
        const opts = {
          ...base,
          contentRange: contentRangeH(1, 0, total),
          preferenceApplied: preferenceApplied(prefer, 'create', {
            resolutionApplies:
              pkCols.length > 0 || parsed.onConflict != null,
          }),
          ...(Object.keys(extra).length > 0 ? { extraHeaders: extra } : null),
        };
        // A merge-duplicates upsert that inserted no new row is a 200, not a
        // 201 (Response.hs `isInsertIfGTZero`); every other insert is a 201.
        const status = prefer.resolution === 'merge-duplicates'
          && !upsertInserted ? 200 : 201;
        return success(status, returnRep ? rows : null, opts);
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
        return error(err, corsHeaders, err.responseHeaders, errorOpts);
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
            // Opt-in redaction (V-09). Default false: upstream returns the
            // server's own message/detail/hint and its tests assert on them.
            sanitize: ctx.errorsSanitize === true,
            authed: role !== 'anon',
          }),
          corsHeaders,
          null,
          errorOpts,
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
        null,
        errorOpts,
      );
    } finally {
      // Hand the pinned connection back. Only set when a session was opened,
      // i.e. when some session-scoped option is configured or the request
      // asked for a timezone. Awaited: the transaction that carries a
      // request-local setting has to be closed before the connection can be
      // reused.
      if (releaseSession) await releaseSession();
    }
  }

  async function handleRpc({
      fnName, method, rawMethod, body, rawBody, schemaName,
      params, multiValueParams,
      accept, prefer, headers, schema, pool, cedar,
      ctx, corsHeaders, role, userId, email,
      media, headersOnly, headerRange, errorOpts,
  }) {
    if (method !== 'GET' && method !== 'POST' && method !== 'OPTIONS') {
      throw new PostgRESTError(405, 'PGRST101',
        `Cannot use the ${rawMethod} method on RPC`);
    }

    if (!ctx.dbCapabilities?.supportsRpc) {
      throw new PostgRESTError(501, 'PGRST501',
        'RPC is not supported on this database',
        null,
        'Deploy on standard PostgreSQL to use stored '
        + 'function calls.');
    }

    await cedar.loadPolicies();
    const principal = { role, userId, email };
    cedar.authorize({
      principal, action: 'call', resource: fnName,
      resourceType: 'Function', schema,
    });

    // GET has no body, so a Content-Type on it means nothing: it must not make
    // the engine look for a function that takes a body (upstream keys the whole
    // single-unnamed-parameter fallback off `isInvPost`).
    const isInvPost = method === 'POST';
    const contentType = parseContentMediaType(headers['content-type']);

    let parsed;
    let source;
    if (isInvPost) {
      parsed = parseQuery(params, method, multiValueParams, ctx.maxEmbedDepth);
      source = rpcPostArgs({
        contentType, body, rawBody, columns: parsed.columns,
      });
    } else {
      // On GET one query parameter can be both an argument and a filter
      // (`?id=5&id=gt.2`), so the split happens per value, in the parser.
      parsed = parseQuery(
        params, method, multiValueParams, ctx.maxEmbedDepth,
        { rpcRead: true });
      const pairs = parsed.rpcArgs || [];
      source = { pairs, argKeys: sortedKeys(pairs.map(([k]) => k)) };
    }

    // Which overload runs is decided by the argument names supplied.
    const routine = findRoutine({
      routines: schema.routines,
      schemaName: schemaName || 'public',
      fnName,
      argKeys: source.argKeys,
      isInvPost,
      contentType,
    });
    const call = rpcCallFor(routine, source, contentType);

    // A function whose return type is a media type domain — `create domain
    // "text/plain" as text` — produces that media type and serves the scalar
    // raw. Upstream only looks the function up when the request has no explicit
    // `select` (`hasDefaultSelect` in Plan/Negotiate.hs), and never for a
    // set-returning function: its rows go through an aggregate instead.
    const rawMedia = routine.returnsSet || params.select != null
      ? null
      : rawMediaFor(accept, routine.returnType);
    if (rawMedia) media = rawMedia;
    else if (!mediaProducible(media)) throw mediaUnavailable(accept);

    // A function that returns one value has no row count to constrain
    // (upstream `failMaxAffectedRpcReturnsSingle`).
    if (prefer.handling === 'strict' && prefer.maxAffected !== undefined
        && !routine.returnsSet) {
      throw new PostgRESTError(400, 'PGRST128',
        'Function must return SETOF or TABLE when max-affected preference '
        + 'is used with handling=strict');
    }

    const range = effectiveRange(parsed, headerRange);
    if (routine.returnsSet) {
      parsed = { ...parsed, limit: range.limit, offset: range.offset };
    }

    const q = buildRpcCall(fnName, call, routine, parsed, schema);

    if (!ctx.production) {
      console.info(
        `[pgrest-lambda] rpc: ${fnName}(`
        + `${source.argKeys.join(', ')})`);
    }

    // GET is read-only, so a function that writes must fail rather than write
    // (upstream plans GET as a read-only transaction; PostgreSQL then answers
    // 25006, which maps to 405). Only a VOLATILE function can write, and only
    // that case pays for the transaction.
    // `max-affected` on a set-returning function is settled after the call, by
    // rolling it back when it returned too many rows (queryMaxAffected).
    const enforceMaxAffected = prefer.handling === 'strict'
      && prefer.maxAffected !== undefined
      && routine.returnsSet;

    let result;
    if (routine.volatility === 'v' && method === 'GET') {
      result = await queryReadOnly(pool, q);
    } else if (enforceMaxAffected) {
      result = await queryMaxAffected(pool, q, prefer.maxAffected);
    } else {
      result = await pool.query(q.text, q.values);
    }

    const base = {
      media, headersOnly, corsHeaders,
      preferenceApplied: preferenceApplied(prefer, 'rpc'),
    };

    if (q.resultMode === 'void') {
      return success(204, null, base);
    }

    if (q.resultMode === 'scalar' || q.resultMode === 'single') {
      const value = q.resultMode === 'scalar'
        ? (result.rows[0]?.[RPC_SCALAR] ?? null)
        : (result.rows[0] ?? null);
      return success(200, value, {
        ...base,
        // A function returning one scalar/composite counts as exactly one row
        // (upstream: "includes exact count of 1 for functions that return a
        // single scalar, domain or composite").
        contentRange: contentRangeH(0, 0, shouldCount(prefer) ? 1 : null),
        // A single value is a body even when it is JSON null.
        serializedBody: q.resultMode === 'scalar' && rawMedia
          // A media type domain takes the value itself, not its JSON rendering
          // (upstream serves those from the raw scalar).
          ? (value == null ? '' : String(value))
          : JSON.stringify(value ?? null),
      });
    }

    // SETOF a scalar type is a list of values, not of one-column rows.
    const rows = q.resultMode === 'setofScalar'
      ? result.rows.map(r => r[RPC_SCALAR] ?? null)
      : result.rows;

    // Set-returning: the window and the total are the same machinery as a
    // table read, so 206/416 apply here too.
    let total = null;
    if (shouldCount(prefer)) {
      total = (range.limit == null && range.lower === 0)
        // Nothing was windowed away, so the rows in hand *are* the total. This
        // also covers VOLATILE functions, which must not be called twice.
        ? rows.length
        : await countRpcRows({ fnName, call, routine, parsed, schema, pool });
    }

    const lower = range.lower;
    const upper = lower + rows.length - 1;
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
        errorOpts,
      );
    }

    return success(status, rows, {
      ...base,
      contentRange: cRange,
    });
  }

  return { handler };
}
