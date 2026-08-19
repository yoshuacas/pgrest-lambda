/**
 * Routine (stored function) resolution — upstream PostgREST's
 * `PostgREST.SchemaCache.Routine` + `Plan.findProc`.
 *
 * A function name alone does not identify a routine: PostgreSQL allows
 * overloads, and PostgREST picks between them by the *names of the arguments
 * supplied* by the request. That is why the schema cache keeps every candidate
 * for a name (`schema.routines[name]` is an array) instead of a single entry,
 * and why resolution happens per request rather than at introspection time.
 *
 * Everything here is pure: the SQL text, the row → routine mapping, the
 * candidate choice, and the error bodies. No connection, no request object.
 */

import { PostgRESTError } from './errors.mjs';

// --- Introspection ----------------------------------------------------------

/**
 * All callable routines of one schema, in upstream's shape (`funcsSqlQuery`).
 *
 * Two rules from upstream are load-bearing and easy to miss:
 *
 * 1. `callable` — a function with one unnamed argument is only reachable when
 *    that argument is a body type (bytea/json/jsonb/text/xml); with two or more
 *    unnamed arguments it is not reachable at all. Unreachable functions are
 *    left out of the cache entirely, which is what makes `unnamed_int_param`
 *    a 404 rather than a bad request.
 * 2. `rettype_is_composite` — TABLE/OUT/INOUT arguments make the return
 *    composite even when `prorettype` is `record` or a scalar, because those
 *    arguments *are* the result columns.
 *
 * The schema is bound ($1), never interpolated.
 */
export const ROUTINES_SQL = `
  WITH arguments AS (
    SELECT p.oid,
           array_agg(COALESCE(a.name, '') ORDER BY a.idx) AS arg_names,
           array_agg(a.type::regtype::text ORDER BY a.idx) AS arg_types,
           array_agg(
             CASE a.type
               WHEN 'bit'::regtype THEN 'bit varying'
               WHEN 'bit[]'::regtype THEN 'bit varying[]'
               WHEN 'character'::regtype THEN 'character varying'
               WHEN 'character[]'::regtype THEN 'character varying[]'
               ELSE a.type::regtype::text
             END ORDER BY a.idx) AS arg_cast_types,
           array_agg(a.idx <= (p.pronargs - p.pronargdefaults)
                     ORDER BY a.idx) AS arg_required,
           array_agg(COALESCE(a.mode = 'v', false) ORDER BY a.idx)
             AS arg_variadic,
           CASE COUNT(*) - COUNT(a.name)
             WHEN 0 THEN true
             WHEN 1 THEN (array_agg(a.type ORDER BY a.idx))[1]
                         IN ('bytea'::regtype, 'json'::regtype,
                             'jsonb'::regtype, 'text'::regtype,
                             'xml'::regtype)
             ELSE false
           END AS callable
      FROM pg_catalog.pg_proc p,
           unnest(p.proargnames, p.proargtypes, p.proargmodes)
             WITH ORDINALITY AS a(name, type, mode, idx)
     WHERE a.type IS NOT NULL
     GROUP BY p.oid
  ), out_args AS (
    SELECT p.oid,
           array_agg(COALESCE(a.name, '') ORDER BY a.idx) AS out_names,
           array_agg(a.type::regtype::text ORDER BY a.idx) AS out_types
      FROM pg_catalog.pg_proc p,
           unnest(p.proargnames, p.proallargtypes, p.proargmodes)
             WITH ORDINALITY AS a(name, type, mode, idx)
     WHERE a.mode IN ('o', 'b', 't')
     GROUP BY p.oid
  )
  SELECT pn.nspname AS routine_schema,
         p.proname AS routine_name,
         COALESCE(a.arg_names, '{}') AS arg_names,
         COALESCE(a.arg_types, '{}') AS arg_types,
         COALESCE(a.arg_cast_types, '{}') AS arg_cast_types,
         COALESCE(a.arg_required, '{}') AS arg_required,
         COALESCE(a.arg_variadic, '{}') AS arg_variadic,
         o.out_names AS out_names,
         o.out_types AS out_types,
         tn.nspname AS return_type_schema,
         t.typname AS return_type,
         COALESCE(comp.relname, t.typname) AS return_relation,
         p.proretset AS returns_set,
         (t.typtype = 'c'
          OR COALESCE(p.proargmodes::text[] && '{t,b,o}', false)
         ) AS returns_composite,
         p.provolatile AS volatility,
         l.lanname AS language,
         p.provariadic > 0 AS has_variadic
    FROM pg_catalog.pg_proc p
    LEFT JOIN arguments a ON a.oid = p.oid
    LEFT JOIN out_args o ON o.oid = p.oid
    JOIN pg_catalog.pg_namespace pn ON pn.oid = p.pronamespace
    JOIN pg_catalog.pg_type t ON t.oid = p.prorettype
    JOIN pg_catalog.pg_namespace tn ON tn.oid = t.typnamespace
    LEFT JOIN pg_catalog.pg_class comp ON comp.oid = t.typrelid
    JOIN pg_catalog.pg_language l ON l.oid = p.prolang
   WHERE t.oid <> 'trigger'::regtype
     AND COALESCE(a.callable, true)
     AND p.prokind = 'f'
     AND pn.nspname = $1
   ORDER BY p.proname`;

function boolOf(v) {
  return v === true || v === 't' || v === 'true';
}

function arrayOf(v) {
  if (Array.isArray(v)) return v;
  if (v === null || v === undefined) return [];
  // Defensive: a driver that hands back the raw array literal.
  if (typeof v === 'string' && v.startsWith('{') && v.endsWith('}')) {
    const inner = v.slice(1, -1);
    return inner === '' ? [] : inner.split(',');
  }
  return [];
}

/**
 * One introspection row → the routine shape the engine works with.
 *
 * `isScalar`/`returnsComposite`/`returnsSet` between them decide the whole
 * response shape, so they are named after upstream's `funcReturns*` predicates
 * rather than after anything in pg_catalog.
 */
export function makeRoutine(row) {
  const names = arrayOf(row.arg_names);
  const types = arrayOf(row.arg_types);
  const castTypes = arrayOf(row.arg_cast_types);
  const required = arrayOf(row.arg_required);
  const variadic = arrayOf(row.arg_variadic);

  const args = names.map((name, i) => ({
    name,
    type: types[i],
    castType: castTypes[i] || types[i],
    required: boolOf(required[i]),
    variadic: boolOf(variadic[i]),
  }));

  const returnsSet = boolOf(row.returns_set);
  const returnsComposite = boolOf(row.returns_composite);
  const outNames = row.out_names ? arrayOf(row.out_names) : null;
  const outTypes = row.out_types ? arrayOf(row.out_types) : null;

  return {
    schema: row.routine_schema,
    name: row.routine_name,
    args,
    returnType: row.return_type,
    returnTypeSchema: row.return_type_schema,
    returnRelation: row.return_relation,
    returnsSet,
    returnsComposite,
    // Upstream's funcReturnsScalar: a non-composite return, set or not.
    isScalar: !returnsComposite,
    returnColumns: outNames
      ? outNames.map((name, i) => ({ name, type: outTypes[i] }))
      : null,
    volatility: row.volatility,
    language: row.language,
    hasVariadic: boolOf(row.has_variadic),
    numDefaults: args.filter(a => !a.required).length,
  };
}

function compareParams(a, b) {
  // Upstream `Ord RoutineParam`: field order (name, type, maxLength, req, var).
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  if (a.type !== b.type) return a.type < b.type ? -1 : 1;
  if (a.castType !== b.castType) return a.castType < b.castType ? -1 : 1;
  if (a.required !== b.required) return a.required ? 1 : -1;
  if (a.variadic !== b.variadic) return a.variadic ? 1 : -1;
  return 0;
}

/**
 * Upstream `Ord Routine`: within one name, fewest parameters first, then
 * field-wise. The order is observable — it is the order candidates are listed
 * in the PGRST203 "could not choose the best candidate" message.
 */
export function compareRoutines(a, b) {
  if (a.args.length !== b.args.length) {
    return a.args.length - b.args.length;
  }
  for (let i = 0; i < a.args.length; i++) {
    const c = compareParams(a.args[i], b.args[i]);
    if (c !== 0) return c;
  }
  if (a.returnRelation !== b.returnRelation) {
    return a.returnRelation < b.returnRelation ? -1 : 1;
  }
  return 0;
}

/** Group introspection rows by name, each group ordered as upstream orders it. */
export function buildRoutineMap(rows) {
  const map = {};
  for (const row of rows) {
    const routine = makeRoutine(row);
    if (!map[routine.name]) map[routine.name] = [];
    map[routine.name].push(routine);
  }
  for (const name of Object.keys(map)) {
    map[name].sort(compareRoutines);
  }
  return map;
}

// --- Media types ------------------------------------------------------------

export const MT_JSON = 'application/json';
export const MT_TEXT = 'text/plain';
export const MT_XML = 'text/xml';
export const MT_OCTET = 'application/octet-stream';
export const MT_URLENCODED = 'application/x-www-form-urlencoded';
export const MT_CSV = 'text/csv';

/**
 * The request's Content-Type, reduced to the set upstream branches on.
 * A missing header is `application/json` (upstream ApiRequest).
 */
export function parseContentMediaType(header) {
  if (header === undefined || header === null || header === '') return MT_JSON;
  const mime = String(header).split(';')[0].trim().toLowerCase();
  switch (mime) {
    case MT_JSON: return MT_JSON;
    case MT_TEXT: return MT_TEXT;
    case MT_XML: return MT_XML;
    case MT_OCTET: return MT_OCTET;
    case MT_URLENCODED: return MT_URLENCODED;
    case MT_CSV: return MT_CSV;
    default: return mime;
  }
}

const SINGLE_PARAM_TYPES = {
  [MT_JSON]: ['json', 'jsonb'],
  [MT_TEXT]: ['text'],
  [MT_XML]: ['xml'],
  [MT_OCTET]: ['bytea'],
};

// --- Resolution -------------------------------------------------------------

function setEq(keys, names) {
  if (keys.length !== names.length) return false;
  const s = new Set(names);
  return keys.every(k => s.has(k));
}

function matchesParams(routine, argKeys, isInvPost, contentType) {
  const params = routine.args;
  if (params.length === 0) {
    // A body in one of the raw media types is an argument in itself, so a
    // no-parameter function cannot serve it.
    return argKeys.length === 0
      && !(isInvPost
           && (contentType === MT_OCTET || contentType === MT_TEXT
               || contentType === MT_XML));
  }
  const req = params.filter(p => p.required).map(p => p.name);
  const opt = params.filter(p => !p.required).map(p => p.name);
  if (opt.length === 0) return setEq(argKeys, req);
  if (req.length === 0) {
    const optSet = new Set(opt);
    return argKeys.every(k => optSet.has(k));
  }
  const optSet = new Set(opt);
  return setEq(argKeys.filter(k => !optSet.has(k)), req);
}

function hasSingleUnnamedParam(routine, isInvPost, contentType) {
  if (!isInvPost || routine.args.length !== 1) return false;
  const p = routine.args[0];
  if (p.name !== '') return false;
  const allowed = SINGLE_PARAM_TYPES[contentType];
  return Boolean(allowed) && allowed.includes(p.type);
}

function ambiguousError(candidates) {
  const listed = candidates.map(p =>
    `${p.schema}.${p.name}(`
    + p.args.map(a => `${a.name} => ${a.type}`).join(', ')
    + ')').join(', ');
  return new PostgRESTError(300, 'PGRST203',
    `Could not choose the best candidate function between: ${listed}`,
    null,
    'Try renaming the parameters or the function itself in the database so '
    + 'function overloading can be resolved');
}

function noRpcError({
  schemaName, fnName, argKeys, contentType, isInvPost, allNames, candidates,
}) {
  // With a raw body the arguments are not names at all, so upstream leaves the
  // parameter list out of the message and gives no hint.
  const onlySingleParams = isInvPost
    && (contentType === MT_TEXT || contentType === MT_XML
        || contentType === MT_OCTET);
  const func = `${schemaName}.${fnName}`;
  const prms = argKeys.join(', ');
  const fmtPrms = (p) => argKeys.length === 0 ? ' without parameters' : p;

  const message = 'Could not find the function ' + func
    + (onlySingleParams ? '' : fmtPrms(`(${prms})`))
    + ' in the schema cache';

  const prmsDet = ' with parameter'
    + (argKeys.length > 1 ? 's ' : ' ') + prms;
  let detailMiddle;
  if (isInvPost && contentType === MT_TEXT) {
    detailMiddle = ' with a single unnamed text parameter';
  } else if (isInvPost && contentType === MT_XML) {
    detailMiddle = ' with a single unnamed xml parameter';
  } else if (isInvPost && contentType === MT_OCTET) {
    detailMiddle = ' with a single unnamed bytea parameter';
  } else if (isInvPost && contentType === MT_JSON) {
    detailMiddle = fmtPrms(prmsDet)
      + ' or with a single unnamed json/jsonb parameter';
  } else {
    detailMiddle = fmtPrms(prmsDet);
  }
  const details = `Searched for the function ${func}${detailMiddle}, `
    + 'but no matches were found in the schema cache.';

  const hint = onlySingleParams
    ? null
    : noRpcHint(schemaName, fnName, argKeys, allNames, candidates);

  return new PostgRESTError(404, 'PGRST202', message, details, hint);
}

/**
 * Upstream `Plan.findProc`: choose one routine out of the candidates for a
 * name, by the argument names the request supplied.
 *
 * @param {object} args
 * @param {object} args.routines schema.routines — name → candidate array
 * @param {string} args.fnName
 * @param {string[]} args.argKeys argument names supplied, sorted
 * @param {boolean} args.isInvPost true for POST (a body can be an argument)
 * @param {string} args.contentType reduced request Content-Type
 * @returns {object} the chosen routine
 * @throws {PostgRESTError} 404 PGRST202 when nothing matches, 300 PGRST203
 *   when more than one candidate does
 */
export function findRoutine({
  routines, schemaName = 'public', fnName, argKeys = [],
  isInvPost = false, contentType = MT_JSON,
}) {
  const candidates = (routines && routines[fnName]) || [];
  const matched = [];
  const fallbacks = [];
  for (const routine of candidates) {
    if (matchesParams(routine, argKeys, isInvPost, contentType)) {
      matched.push(routine);
    } else if (hasSingleUnnamedParam(routine, isInvPost, contentType)) {
      fallbacks.push(routine);
    }
  }

  if (matched.length === 1) return matched[0];
  if (matched.length > 1) throw ambiguousError(matched);
  if (fallbacks.length === 1) return fallbacks[0];
  if (fallbacks.length > 1) throw ambiguousError(fallbacks);

  throw noRpcError({
    schemaName, fnName, argKeys, contentType, isInvPost,
    allNames: routines ? Object.keys(routines) : [],
    candidates,
  });
}

// --- Fuzzy hints ------------------------------------------------------------
//
// Upstream hints the closest function name (or the closest parameter list) with
// the `fuzzyset` algorithm: cosine similarity over character n-gram counts,
// falling back to a shorter n-gram when nothing overlaps, plus a
// Levenshtein-based score for candidates the n-grams rate poorly. The score
// thresholds are upstream's: 0.75 for a function name, 0.33 for parameters.

function normalizeFuzzy(text) {
  let out = '';
  for (const ch of String(text).toLowerCase()) {
    if (/[a-z0-9]/.test(ch) || ch === ' ' || ch === ',') out += ch;
  }
  return out;
}

function gramCounts(normalized, size) {
  const padded = `-${normalized}-`;
  const counts = new Map();
  for (let i = 0; i + size <= padded.length; i++) {
    const gram = padded.slice(i, i + size);
    counts.set(gram, (counts.get(gram) || 0) + 1);
  }
  return counts;
}

function vectorNormal(counts) {
  let sum = 0;
  for (const c of counts.values()) sum += c * c;
  return Math.sqrt(sum);
}

function cosine(queryCounts, candCounts) {
  const qNormal = vectorNormal(queryCounts);
  const cNormal = vectorNormal(candCounts);
  if (qNormal === 0 || cNormal === 0) return 0;
  let dot = 0;
  for (const [gram, count] of queryCounts) {
    const other = candCounts.get(gram);
    if (other) dot += count * other;
  }
  if (dot === 0) return 0;
  return dot / (qNormal * cNormal);
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array(b.length + 1);
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[b.length];
}

function levenshteinScore(a, b) {
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return 0;
  return 1 - levenshtein(a, b) / longest;
}

/**
 * Closest candidate to `value`, or null when nothing scores high enough.
 * `candidates` are matched on their normalized form but returned verbatim.
 */
export function fuzzyBest(candidates, value, minScore) {
  const query = normalizeFuzzy(value);
  const seen = new Set();
  let best = null;
  let bestScore = 0;
  const queryGrams = [3, 2].map(size => gramCounts(query, size));
  for (const candidate of candidates) {
    const normalized = normalizeFuzzy(candidate);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    if (normalized === query) return candidate;
    let score = levenshteinScore(query, normalized);
    [3, 2].forEach((size, i) => {
      const c = cosine(queryGrams[i], gramCounts(normalized, size));
      if (c > score) score = c;
    });
    if (score >= minScore && score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

function paramListText(names) {
  return `(${[...names].sort().join(', ')})`;
}

/**
 * Upstream `Error.noRpcHint`: with no routine of that name, hint the closest
 * name; with a routine of that name but no parameter match, hint the closest
 * parameter list of its overloads.
 */
export function noRpcHint(schemaName, fnName, argKeys, allNames, candidates) {
  if (!candidates || candidates.length === 0) {
    const best = fuzzyBest(allNames || [], fnName, 0.75);
    return best === null
      ? null
      : `Perhaps you meant to call the function ${schemaName}.${best}`;
  }
  const paramLists = candidates.map(c => paramListText(c.args.map(a => a.name)));
  const best = fuzzyBest(paramLists, paramListText(argKeys), 0.33);
  return best === null
    ? null
    : `Perhaps you meant to call the function ${schemaName}.${fnName}${best}`;
}
