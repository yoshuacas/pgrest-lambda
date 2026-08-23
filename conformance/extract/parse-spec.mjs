// PostgREST Haskell spec -> portable conformance case extractor.
//
// Reads one test/spec/**/*.hs file and returns the JSON document described in
// conformance/CONTRACTS.md section 1.
//
// Design notes
// ------------
// The specs are Haskell, so a real parse is out of scope. What we do instead:
//
//   1. Lex the file (hs-lexer.mjs) into positioned tokens.
//   2. Track describe/context/it nesting by layout column to recover
//      descriptions and category context.
//   3. Anchor on every `shouldRespondWith` backtick operator. Walk left to the
//      nearest hspec-wai request helper (get/post/put/patch/delete/request)
//      and right through the ResponseMatcher literal plus its optional
//      { matchStatus = .., matchHeaders = [..] } record update.
//   4. Evaluate the argument expressions with a tiny interpreter that knows the
//      SpecHelper vocabulary (acceptHdrs, rangeHdrs, authHeaderJWT,
//      matchContentTypeJson, ...) and the local `let`/`where` bindings.
//
// Anything the interpreter cannot resolve to a concrete request/response
// becomes a case with skip:true and a skipReason naming the blocker. We never
// guess an assertion.

import { lex } from './hs-lexer.mjs';
import { parseRelaxedJson, decodeHeredoc } from './relaxed-json.mjs';

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

const REQUEST_HEADS = {
  get: { method: 'GET', args: ['path'] },
  post: { method: 'POST', args: ['path', 'body'] },
  put: { method: 'PUT', args: ['path', 'body'] },
  patch: { method: 'PATCH', args: ['path', 'body'] },
  delete: { method: 'DELETE', args: ['path'] },
  options: { method: 'OPTIONS', args: ['path'] },
  request: { method: null, args: ['method', 'path', 'headers', 'body'] },
};

const METHOD_IDENTS = {
  methodGet: 'GET', methodPost: 'POST', methodPut: 'PUT', methodPatch: 'PATCH',
  methodDelete: 'DELETE', methodHead: 'HEAD', methodOptions: 'OPTIONS',
  methodTrace: 'TRACE', methodConnect: 'CONNECT',
};

const HEADER_NAME_IDENTS = {
  hAccept: 'Accept',
  hAcceptLanguage: 'Accept-Language',
  hAuthorization: 'Authorization',
  hCacheControl: 'Cache-Control',
  hContentEncoding: 'Content-Encoding',
  hContentLength: 'Content-Length',
  hContentType: 'Content-Type',
  hCookie: 'Cookie',
  hLocation: 'Location',
  hOrigin: 'Origin',
  hRange: 'Range',
  hReferer: 'Referer',
  hUserAgent: 'User-Agent',
};

// SpecHelper MatchHeader helpers that assert an exact Content-Type value.
const CONTENT_TYPE_MATCHERS = {
  matchContentTypeJson: 'application/json; charset=utf-8',
  matchContentTypeSingular: 'application/vnd.pgrst.object+json; charset=utf-8',
  matchCTArrayStrip: 'application/vnd.pgrst.array+json;nulls=stripped; charset=utf-8',
  matchCTSingularStrip: 'application/vnd.pgrst.object+json;nulls=stripped; charset=utf-8',
};

// MatchHeader helpers whose semantics have no home in `expected.headers`.
const UNREPRESENTABLE_MATCHERS = {
  matchHeader: 'asserts a header against a regex (matchHeader)',
  filterAndMatchCT: 'asserts exactly-one Content-Type via a custom matcher (filterAndMatchCT)',
};

// SpecHelper's HS256 test secret (SpecHelper.hs `generateSecret`, the base64 of
// "reallyreallyreallyreallyverysafe", which is also `baseCfg`'s configJwtSecret).
// `generateJWT claims = JWT.hmacEncode HS256 generateSecret claims`, so a token
// built from a literal claim set is fully determined by the spec source.
const JWT_TEST_SECRET = 'reallyreallyreallyreallyverysafe';

// AppConfig fields that only switch on a PostgREST feature which pgrest-lambda
// either implements unconditionally or not at all. A spec block that flips one
// of these still asserts the same request -> response pair, so it does not
// force a skip. Every other deviation from `baseCfg` does: the engine has no
// knob for it, so the assertion cannot be reproduced.
const NON_BLOCKING_CONFIG_FIELDS = new Set([
  'configDbAggregates',   // aggregate functions enabled
  'configDbPlanEnabled',  // EXPLAIN / plan media type enabled
]);

// The same fields seen from the other side. pgrest-lambda has these features on
// permanently, so an assertion made under a config that does NOT turn them on
// is asserting the *disabled* behaviour (upstream's default is off) and cannot
// be reproduced either. In a file that flips one of these flags, a block
// running under plain `baseCfg` is exactly such an assertion:
// AggregateFunctionsSpec `disallowed` (PGRST123) and PlanSpec `disabledSpec`
// (406) are the two cases in the suite.
const FEATURE_FLAG_FIELDS = new Set(['configDbAggregates', 'configDbPlanEnabled']);
const FEATURE_FLAG_NAMES = {
  configDbAggregates: 'db-aggregates-enabled',
  configDbPlanEnabled: 'db-plan-enabled',
};

// Tokens that can never appear inside a request expression; hitting one while
// walking left means the request head we found belongs to another statement.
const LEFT_STOP_IDENTS = new Set([
  'do', 'let', 'where', 'in', 'then', 'else', 'of', 'case', 'if', 'it',
  'describe', 'context', 'liftIO', 'return', 'pure', 'pendingWith', 'when',
  'unless', 'forM_', 'mapM_', 'void', 'shouldBe', 'shouldSatisfy',
]);
const LEFT_STOP_OPS = new Set(['$', '>>', '>>=', '<-', '=', '->', '<$>', '<*>', '=<<', '$!']);

// ---------------------------------------------------------------------------
// Category mapping
// ---------------------------------------------------------------------------

// Default category per spec file. Keyed by the path under test/spec/.
const FILE_CATEGORY = {
  'Feature/Auth/AsymmetricJwtSpec.hs': 'auth',
  'Feature/Auth/AudienceJwtSecretSpec.hs': 'auth',
  'Feature/Auth/AuthSpec.hs': 'auth',
  'Feature/Auth/BinaryJwtSecretSpec.hs': 'auth',
  'Feature/Auth/JwtCacheSpec.hs': 'auth',
  'Feature/Auth/NoAnonSpec.hs': 'auth',
  'Feature/Auth/NoJwtSecretSpec.hs': 'auth',
  'Feature/ConcurrentSpec.hs': 'select',
  'Feature/CorsSpec.hs': 'cors',
  'Feature/ExtraSearchPathSpec.hs': 'multiple-schemas',
  'Feature/HttpHeaderSpec.hs': 'http-headers',
  'Feature/NoSuperuserSpec.hs': 'auth',
  'Feature/ObservabilitySpec.hs': 'observability',
  'Feature/OpenApi/DisabledOpenApiSpec.hs': 'openapi',
  'Feature/OpenApi/IgnorePrivOpenApiSpec.hs': 'openapi',
  'Feature/OpenApi/OpenApiSpec.hs': 'openapi',
  'Feature/OpenApi/ProxySpec.hs': 'openapi',
  'Feature/OpenApi/RootSpec.hs': 'openapi',
  'Feature/OpenApi/SecurityOpenApiSpec.hs': 'openapi',
  'Feature/OptionsSpec.hs': 'options',
  'Feature/Query/AggregateFunctionsSpec.hs': 'aggregates',
  'Feature/Query/AndOrParamsSpec.hs': 'filters',
  'Feature/Query/ComputedRelsSpec.hs': 'embedding',
  'Feature/Query/CustomMediaSpec.hs': 'media-types',
  'Feature/Query/DeleteSpec.hs': 'delete',
  'Feature/Query/EmbedDisambiguationSpec.hs': 'embedding',
  'Feature/Query/EmbedInnerJoinSpec.hs': 'embedding',
  'Feature/Query/ErrorSpec.hs': 'errors',
  'Feature/Query/InsertSpec.hs': 'insert',
  'Feature/Query/JsonOperatorSpec.hs': 'json-operators',
  'Feature/Query/MultipleSchemaSpec.hs': 'multiple-schemas',
  'Feature/Query/NullsStripSpec.hs': 'media-types',
  'Feature/Query/PgSafeUpdateSpec.hs': 'update',
  'Feature/Query/PlanSpec.hs': 'plan',
  'Feature/Query/PostGISSpec.hs': 'media-types',
  'Feature/Query/Preferences/HandlingSpec.hs': 'preferences',
  'Feature/Query/Preferences/MaxAffectedSpec.hs': 'preferences',
  'Feature/Query/Preferences/TimezoneSpec.hs': 'preferences',
  'Feature/Query/PreparedStatementsSpec.hs': 'select',
  'Feature/Query/QueryLimitedSpec.hs': 'range',
  'Feature/Query/QuerySpec.hs': 'filters',
  'Feature/Query/RangeSpec.hs': 'range',
  'Feature/Query/RawOutputTypesSpec.hs': 'media-types',
  'Feature/Query/RelatedQueriesSpec.hs': 'embedding',
  'Feature/Query/RpcSpec.hs': 'rpc',
  'Feature/Query/ServerTimingSpec.hs': 'observability',
  'Feature/Query/SingularSpec.hs': 'singular',
  'Feature/Query/SpreadQueriesSpec.hs': 'embedding',
  'Feature/Query/UnicodeSpec.hs': 'select',
  'Feature/Query/UpdateSpec.hs': 'update',
  'Feature/Query/UpsertSpec.hs': 'upsert',
  'Feature/RollbackSpec.hs': 'rollback',
  'Feature/RpcPreRequestGucsSpec.hs': 'rpc',
  'Main.hs': 'select',
  'SpecHelper.hs': 'openapi',
};

// Files whose default category is broad enough that describe-block wording
// should be allowed to override it.
const GENERIC_CATEGORIES = new Set(['select', 'filters']);

// Ordered: first match wins. Matched against the joined describe/context
// labels only (not the `it` description, which is too noisy to classify on).
const CONTEXT_CATEGORY_RULES = [
  [/resource embedding|embed|to-one|to-many|many-to-many|spread|junction|!inner/i, 'embedding'],
  [/\brpc\b|remote procedure|stored procedure/i, 'rpc'],
  [/aggregate/i, 'aggregates'],
  [/jsonb? (and jsonb )?operator|json path|json arrow|->>/i, 'json-operators'],
  [/upsert|on conflict|resolution=/i, 'upsert'],
  [/insert/i, 'insert'],
  [/updat(e|ing)/i, 'update'],
  [/delet(e|ing)/i, 'delete'],
  [/singular|vnd\.pgrst\.object/i, 'singular'],
  [/limit|offset|\brange\b|pagination|paginated|count=exact|content-range/i, 'range'],
  [/openapi|swagger/i, 'openapi'],
  [/media type|content negotiation|accept header|text\/csv|text\/plain|binary|raw output|geojson/i, 'media-types'],
  [/explain|query plan/i, 'plan'],
  [/multiple schemas|accept-profile|content-profile|search path/i, 'multiple-schemas'],
  [/\bjwt\b|authoriz|role claim|anonymous|\bauth\b/i, 'auth'],
  [/error/i, 'errors'],
  [/filter|\boperator\b|and\/or|logical/i, 'filters'],
  [/select|order|column|shaping|cast|renam/i, 'select'],
];

// An embed is visible in the request itself: `select=...(...)`, `!inner`,
// `!left`, or an embedded-resource filter/order (`clients.order=`,
// `select=...&projects.limit=`). Describe wording alone files whole blocks of
// embedding tests under select/filters.
function requestLooksLikeEmbed(req) {
  if (!req) return false;
  const q = safeDecodeQuery(req.query || '');
  if (/!inner|!left/.test(q)) return true;
  const sel = /(?:^|&)select=([^&]*)/.exec(q);
  if (sel && /\w\s*\(/.test(sel[1])) return true;
  return false;
}

function safeDecodeQuery(q) {
  try { return decodeURIComponent(q); } catch { return q; }
}

function categoryFor(sourceRel, describePath, req) {
  const base = FILE_CATEGORY[sourceRel] ?? 'select';
  if (!GENERIC_CATEGORIES.has(base)) return base;
  const text = describePath.join(' | ');
  for (const [re, cat] of CONTEXT_CATEGORY_RULES) {
    if (re.test(text)) return cat;
  }
  if (requestLooksLikeEmbed(req)) return 'embedding';
  return base;
}

function pickHeaderName(headers, name) {
  if (!headers) return null;
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === name) return v;
  }
  return null;
}

/** `test.foo` -> `public.foo` inside every string of a JSON value. */
function rewriteSchemaNames(value) {
  if (typeof value === 'string') return value.replace(/\btest\./g, 'public.');
  if (Array.isArray(value)) return value.map(rewriteSchemaNames);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, rewriteSchemaNames(v)]));
  }
  return value;
}

// ---------------------------------------------------------------------------
// Token helpers
// ---------------------------------------------------------------------------

const OPEN = { '(': ')', '[': ']', '{': '}' };
const CLOSE = new Set([')', ']', '}']);

function matchBracket(toks, i) {
  const stack = [];
  for (let k = i; k < toks.length; k += 1) {
    const t = toks[k];
    if (t.type !== 'punct') continue;
    if (OPEN[t.value]) stack.push(OPEN[t.value]);
    else if (CLOSE.has(t.value)) {
      if (!stack.length) return -1;
      if (stack.pop() !== t.value) return -1;
      if (!stack.length) return k;
    }
  }
  return -1;
}

function splitTop(toks, isSep) {
  const parts = [];
  let cur = [];
  let depth = 0;
  for (const t of toks) {
    if (t.type === 'punct' && OPEN[t.value]) depth += 1;
    else if (t.type === 'punct' && CLOSE.has(t.value)) depth -= 1;
    if (depth === 0 && isSep(t)) { parts.push(cur); cur = []; continue; }
    cur.push(t);
  }
  parts.push(cur);
  return parts;
}

function hasTopLevel(toks, isSep) {
  return splitTop(toks, isSep).length > 1;
}

function unwrap(toks) {
  let t = toks;
  for (;;) {
    if (t.length >= 2 && t[0].type === 'punct' && t[0].value === '(' && matchBracket(t, 0) === t.length - 1) {
      t = t.slice(1, -1);
      continue;
    }
    return t;
  }
}

function isOp(t, v) { return t && t.type === 'op' && t.value === v; }
function isPunct(t, v) { return t && t.type === 'punct' && t.value === v; }

/** Split a function application into head token + argument groups. */
function splitApp(toks) {
  const parts = [];
  let i = 0;
  while (i < toks.length) {
    const t = toks[i];
    if (t.type === 'punct' && OPEN[t.value]) {
      const j = matchBracket(toks, i);
      if (j === -1) return null;
      parts.push(toks.slice(i, j + 1));
      i = j + 1;
    } else if (isOp(t, '$')) {
      parts.push(toks.slice(i + 1));
      i = toks.length;
    } else if (t.type === 'op' || (t.type === 'punct' && CLOSE.has(t.value))) {
      return null;
    } else {
      parts.push([t]);
      i += 1;
    }
  }
  if (!parts.length) return null;
  const head = parts[0];
  if (head.length !== 1) return null;
  return { head: head[0], args: parts.slice(1) };
}

function txt(toks) {
  return toks.map((t) => (t.type === 'string' ? JSON.stringify(t.value) : t.type === 'quasi' ? `[${t.qq}|..|]` : t.value)).join(' ');
}

// ---------------------------------------------------------------------------
// Bindings (let / where)
// ---------------------------------------------------------------------------

function collectBindings(toks) {
  const lineFirstCol = new Map();
  for (const t of toks) if (t.firstOfLine) lineFirstCol.set(t.line, t.col);

  const byName = new Map();
  for (let i = 0; i < toks.length; i += 1) {
    const t = toks[i];
    if (t.type !== 'ident') continue;
    if (!isOp(toks[i + 1], '=')) continue;
    const prev = toks[i - 1];
    const introduced = t.firstOfLine
      || (prev && ((prev.type === 'ident' && (prev.value === 'let' || prev.value === 'where'))
        || isPunct(prev, ';') || isPunct(prev, '{')));
    if (!introduced) continue;
    // RHS runs to the end of the logical line. For a binding introduced by
    // `let`/`where` the layout column is the *name's* column, not the column of
    // the `let` keyword: a `let` block's second binding lines up under the
    // first one, so using the keyword column swallows it into the first RHS
    // (measured on RawOutputTypesSpec's firefoxAcceptHdrs / chromeAcceptHdrs).
    const baseCol = t.firstOfLine || !prev
      || (prev.type === 'ident' && (prev.value === 'let' || prev.value === 'where'))
      ? t.col
      : (lineFirstCol.get(t.line) ?? t.col);
    let j = i + 2;
    while (j < toks.length) {
      const u = toks[j];
      if (u.firstOfLine && u.col <= baseCol) break;
      j += 1;
    }
    let rhs = toks.slice(i + 2, j);
    // `let x = expr in body` — drop the `in ...` tail.
    const inParts = splitTop(rhs, (u) => u.type === 'ident' && u.value === 'in');
    if (inParts.length > 1) rhs = inParts[0];
    if (!byName.has(t.value)) byName.set(t.value, []);
    byName.get(t.value).push({ name: t.value, line: t.line, index: i, rhs });
  }
  return byName;
}

/**
 * `currentTime <- liftIO $ relativeSeconds (-35)` — the only monadic binding in
 * the specs whose value a case can carry. SpecHelper's `relativeSeconds s`
 * returns "now + s" in whole seconds, so the value is a time offset, not a
 * constant: the case records the offset and the runner resolves it when it mints
 * the token (a baked `nbf = now + 35` would silently become valid 35s later).
 *
 * Returns Map<name, { line, seconds }[]>.
 */
function collectRelativeSecondsBindings(toks) {
  const byName = new Map();
  for (let i = 0; i < toks.length; i += 1) {
    const t = toks[i];
    if (t.type !== 'ident') continue;
    if (!isOp(toks[i + 1], '<-')) continue;
    // RHS to the end of the logical line.
    let j = i + 2;
    while (j < toks.length) {
      const u = toks[j];
      if (u.firstOfLine && u.col <= t.col) break;
      j += 1;
    }
    const rhs = unwrap(toks.slice(i + 2, j))
      .filter((u) => !(u.type === 'ident' && u.value === 'liftIO') && !isOp(u, '$'));
    const flat = unwrap(rhs);
    if (!flat.length) continue;
    if (!(flat[0].type === 'ident' && flat[0].value === 'relativeSeconds')) continue;
    const arg = unwrap(flat.slice(1));
    let seconds = null;
    if (arg.length === 1 && arg[0].type === 'number') seconds = Number(arg[0].value);
    else if (arg.length === 2 && isOp(arg[0], '-') && arg[1].type === 'number') {
      seconds = -Number(arg[1].value);
    }
    if (seconds === null || !Number.isFinite(seconds)) continue;
    if (!byName.has(t.value)) byName.set(t.value, []);
    byName.get(t.value).push({ line: t.line, seconds });
  }
  return byName;
}

function nearest(list, line) {
  if (!list || !list.length) return null;
  let best = list[0];
  let bestD = Math.abs(list[0].line - line);
  for (const c of list) {
    const d = Math.abs(c.line - line);
    if (d < bestD) { best = c; bestD = d; }
  }
  return best;
}

/**
 * Resolve a name to the binding a Haskell reader would see: the nearest one
 * *above* the use site, and only then the nearest one below it.
 *
 * Plain line proximity is wrong, and wrong in a way that silently rewrites a
 * case rather than dropping it. Two adjacent `it` blocks each open with
 * `let jwtPayload = [json|…|]`; when the first block's assertion is a bare
 * `shouldRespondWith 200`, the block is short enough that the *next* block's
 * `let` is fewer lines away than its own, so the case went out carrying the
 * next test's token. Measured on AudienceJwtSecretSpec: the case for "succeeds
 * when the audience claim matches" (upstream line 23, `aud: "youraudience"`)
 * was extracted with `aud: "notyouraudience"`, the payload of the test below
 * it, and then failed against a correct engine.
 *
 * `let` binds above its use, so preferring an earlier binding is what the
 * language does. A `where` clause binds below, which is why a later binding is
 * still accepted when nothing precedes the use site.
 */
function makeResolver(bindings) {
  return function resolve(name, nearLine, seen = new Set()) {
    if (seen.has(name)) return null;
    const cands = bindings.get(name);
    if (!cands || !cands.length) return null;
    const above = cands.filter((c) => c.line <= nearLine);
    const pool = above.length ? above : cands;
    let best = pool[0];
    let bestD = Math.abs(pool[0].line - nearLine);
    for (const c of pool) {
      const d = Math.abs(c.line - nearLine);
      if (d < bestD) { best = c; bestD = d; }
    }
    return { rhs: best.rhs, seen: new Set([...seen, name]) };
  };
}

// ---------------------------------------------------------------------------
// Expression evaluation
// ---------------------------------------------------------------------------

const fail = (reason) => ({ ok: false, reason });
const okv = (value) => ({ ok: true, value });

function evalString(toks0, env) {
  const toks = unwrap(toks0);
  if (!toks.length) return fail('empty expression');

  const parts = splitTop(toks, (t) => isOp(t, '<>') || isOp(t, '++'));
  if (parts.length > 1) {
    let out = '';
    for (const p of parts) {
      const r = evalString(p, env);
      if (!r.ok) return r;
      out += r.value;
    }
    return okv(out);
  }

  if (toks.length === 1) {
    const t = toks[0];
    if (t.type === 'string') {
      if (!t.decodeOk) return fail(`string literal with an escape the extractor cannot decode: ${t.raw}`);
      return okv(t.value);
    }
    if (t.type === 'quasi' && t.qq === 'str') return okv(decodeHeredoc(t.raw));
    if (t.type === 'number') return okv(t.value);
    if (t.type === 'ident') {
      if (t.value === 'mempty') return okv('');
      const b = env.resolve(t.value, t.line, env.seen);
      if (b) return evalString(b.rhs, { ...env, seen: b.seen });
      return fail(`unresolved identifier "${t.value}"`);
    }
    return fail(`not a string literal: ${txt(toks)}`);
  }

  const app = splitApp(toks);
  if (!app) return fail(`not a string expression: ${txt(toks)}`);
  const fn = app.head.value;
  const PASSTHROUGH = new Set([
    'encodeUtf8', 'decodeUtf8', 'toS', 'BS.pack', 'BL.pack', 'T.pack',
    'BL.toStrict', 'BL.fromStrict', 'toStrict', 'fromStrict', 'show',
  ]);
  if (PASSTHROUGH.has(fn) && app.args.length === 1) return evalString(app.args[0], env);
  if (app.head.type === 'ident' && app.args.length === 0) {
    const b = env.resolve(fn, app.head.line, env.seen);
    if (b) return evalString(b.rhs, { ...env, seen: b.seen });
  }
  return fail(`not a string expression: ${txt(toks)}`);
}

function renderByteRange(toks0, env) {
  const toks = unwrap(toks0);
  const app = splitApp(toks);
  if (!app) return fail(`unrecognized byte range: ${txt(toks)}`);
  const nums = [];
  for (const a of app.args) {
    const u = unwrap(a);
    if (u.length === 1 && u[0].type === 'number') nums.push(u[0].value);
    else return fail(`non-literal byte range bound: ${txt(toks)}`);
  }
  switch (app.head.value) {
    case 'ByteRangeFromTo':
      if (nums.length !== 2) return fail('ByteRangeFromTo arity');
      return okv(`bytes=${nums[0]}-${nums[1]}`);
    case 'ByteRangeFrom':
      if (nums.length !== 1) return fail('ByteRangeFrom arity');
      return okv(`bytes=${nums[0]}-`);
    case 'ByteRangeSuffix':
      if (nums.length !== 1) return fail('ByteRangeSuffix arity');
      return okv(`bytes=-${nums[0]}`);
    default:
      return fail(`unrecognized byte range constructor "${app.head.value}"`);
  }
}

function evalHeaderName(toks0, env) {
  const toks = unwrap(toks0);
  if (toks.length === 1) {
    const t = toks[0];
    if (t.type === 'string') return t.decodeOk ? okv(t.value) : fail(`undecodable header name ${t.raw}`);
    if (HEADER_NAME_IDENTS[t.value]) return okv(HEADER_NAME_IDENTS[t.value]);
    if (t.type === 'ident') {
      const b = env.resolve(t.value, t.line, env.seen);
      if (b) return evalHeaderName(b.rhs, { ...env, seen: b.seen });
    }
    return fail(`unrecognized header name ${txt(toks)}`);
  }
  return evalString(toks, env);
}

// Marker used inside a claim set for `#{currentTime}`, i.e. a value the runner
// must compute at mint time. Kept as a JSON string while the relaxed-json
// parser runs, then replaced by { "$secondsFromNow": n }.
const REL_SECONDS_RE = /^\$\$secondsFromNow:(-?\d+)\$\$$/;

function reviveRelativeClaims(value) {
  if (typeof value === 'string') {
    const m = REL_SECONDS_RE.exec(value);
    return m ? { $secondsFromNow: Number(m[1]) } : value;
  }
  if (Array.isArray(value)) return value.map(reviveRelativeClaims);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, reviveRelativeClaims(v)]));
  }
  return value;
}

/**
 * A JWT claim set: a `[json| ... |]` quasi quote, possibly with a `#{ident}`
 * splice bound by `ident <- liftIO $ relativeSeconds n`.
 */
function evalJwtClaims(toks0, env) {
  const toks = unwrap(toks0);
  if (toks.length === 1 && toks[0].type === 'quasi'
      && (toks[0].qq === 'json' || toks[0].qq === 'aesonQQ')) {
    let raw = toks[0].raw;
    const line = toks[0].line;
    const splices = [...raw.matchAll(/#\{\s*([A-Za-z_][A-Za-z0-9_']*)\s*\}/g)];
    for (const s of splices) {
      const bound = nearest(env.relativeSeconds?.get(s[1]), line);
      if (!bound) {
        return fail(`claim set contains the Haskell splice #{${s[1]}}, which is `
          + 'not a relativeSeconds binding');
      }
      // Replacement passed as a function: `$$` in a literal replacement string
      // would be collapsed to a single `$` by String.replace.
      raw = raw.replace(s[0], () => `"$$secondsFromNow:${bound.seconds}$$"`);
    }
    const p = parseRelaxedJson(raw);
    if (!p.ok) return fail(`claim set is not parseable: ${p.error}`);
    return okv(reviveRelativeClaims(p.value));
  }
  if (toks.length === 1 && toks[0].type === 'ident') {
    const b = env.resolve(toks[0].value, toks[0].line, env.seen);
    if (b) return evalJwtClaims(b.rhs, { ...env, seen: b.seen });
    return fail(`unresolved claim set identifier "${toks[0].value}"`);
  }
  return fail(`claim set is not a literal: ${txt(toks)}`);
}

/**
 * `generateJWT claims` / `generateJWTWithSecret claims secret` — the token
 * upstream signs in SpecHelper.hs. Returns { alg, secret, claims }, which the
 * runner turns back into a token (CONTRACTS.md section 1, request.jwt).
 */
function evalGeneratedJwt(toks0, env) {
  const toks = unwrap(toks0);
  const app = splitApp(toks);
  if (!app || app.head.type !== 'ident') return null;
  if (app.head.value === 'generateJWT' && app.args.length === 1) {
    const c = evalJwtClaims(app.args[0], env);
    if (!c.ok) return c;
    return okv({ alg: 'HS256', secret: JWT_TEST_SECRET, claims: c.value });
  }
  if (app.head.value === 'generateJWTWithSecret' && app.args.length === 2) {
    const c = evalJwtClaims(app.args[0], env);
    if (!c.ok) return c;
    const s = evalString(app.args[1], env);
    if (!s.ok) return fail(`token secret is not a literal: ${s.reason}`);
    return okv({ alg: 'HS256', secret: s.value, claims: c.value });
  }
  return null;
}

/** One (name, value) request header. */
function evalHeaderItem(toks0, env) {
  const toks = unwrap(toks0);
  if (!toks.length) return fail('empty header item');

  // Tuple form: ("Name", "value")
  if (toks0.length >= 2 && isPunct(toks0[0], '(') && matchBracket(toks0, 0) === toks0.length - 1) {
    const inner = toks0.slice(1, -1);
    const fields = splitTop(inner, (t) => isPunct(t, ','));
    if (fields.length === 2) {
      const n = evalHeaderName(fields[0], env);
      if (!n.ok) return n;
      const v = evalString(fields[1], env);
      if (!v.ok) return v;
      return okv([n.value, v.value]);
    }
  }

  if (toks.length === 1 && toks[0].type === 'ident') {
    const name = toks[0].value;
    if (name === 'planHdr') return okv(['Accept', 'application/vnd.pgrst.plan+json']);
    if (name === 'rangeUnit') return okv(['Range-Unit', 'items']);
    const b = env.resolve(name, toks[0].line, env.seen);
    if (b) return evalHeaderItem(b.rhs, { ...env, seen: b.seen });
    return fail(`unresolved header identifier "${name}"`);
  }

  const app = splitApp(toks);
  if (app) {
    const fn = app.head.value;
    if (fn === 'authHeaderJWT' && app.args.length === 1) {
      const v = evalString(app.args[0], env);
      if (v.ok) return okv(['Authorization', `Bearer ${v.value}`]);
      const j = evalGeneratedJwt(app.args[0], env);
      if (j && j.ok) return okv(['Authorization', { jwt: j.value }]);
      const why = j ? j.reason : v.reason;
      return fail(`Authorization header built at runtime (${why})`);
    }
    if (fn === 'authHeader' && app.args.length === 2) {
      const a = evalString(app.args[0], env);
      if (!a.ok) return fail(`Authorization header built at runtime (${a.reason})`);
      const b = evalString(app.args[1], env);
      if (b.ok) return okv(['Authorization', `${a.value} ${b.value}`]);
      const j = evalGeneratedJwt(app.args[1], env);
      if (j && j.ok && a.value === 'Bearer') {
        return okv(['Authorization', { jwt: j.value }]);
      }
      return fail('Authorization header built at runtime '
        + `(${j ? j.reason : b.reason})`);
    }
  }
  return fail(`unrecognized header item: ${txt(toks)}`);
}

/** A [Header] list. Returns array of [name, value]. */
function evalHeaderList(toks0, env) {
  const toks = unwrap(toks0);
  if (!toks.length) return okv([]);

  // list append
  const appended = splitTop(toks, (t) => isOp(t, '<>') || isOp(t, '++'));
  if (appended.length > 1) {
    const out = [];
    for (const p of appended) {
      const r = evalHeaderList(p, env);
      if (!r.ok) return r;
      out.push(...r.value);
    }
    return okv(out);
  }

  // cons
  const consed = splitTop(toks, (t) => isOp(t, ':'));
  if (consed.length > 1) {
    const out = [];
    for (let k = 0; k < consed.length - 1; k += 1) {
      const r = evalHeaderItem(consed[k], env);
      if (!r.ok) return r;
      out.push(r.value);
    }
    const tail = evalHeaderList(consed[consed.length - 1], env);
    if (!tail.ok) return tail;
    out.push(...tail.value);
    return okv(out);
  }

  // literal list
  if (isPunct(toks[0], '[') && matchBracket(toks, 0) === toks.length - 1) {
    const inner = toks.slice(1, -1);
    if (!inner.length) return okv([]);
    const out = [];
    for (const item of splitTop(inner, (t) => isPunct(t, ','))) {
      const r = evalHeaderItem(item, env);
      if (!r.ok) return r;
      out.push(r.value);
    }
    return okv(out);
  }

  if (toks.length === 1 && toks[0].type === 'ident') {
    const name = toks[0].value;
    if (name === 'mempty') return okv([]);
    const b = env.resolve(name, toks[0].line, env.seen);
    if (b) return evalHeaderList(b.rhs, { ...env, seen: b.seen });
    return fail(`unresolved header list identifier "${name}"`);
  }

  const app = splitApp(toks);
  if (app) {
    const fn = app.head.value;
    if (fn === 'acceptHdrs' && app.args.length === 1) {
      const v = evalString(app.args[0], env);
      if (!v.ok) return v;
      return okv([['Accept', v.value]]);
    }
    if (fn === 'rangeHdrs' && app.args.length === 1) {
      const r = renderByteRange(app.args[0], env);
      if (!r.ok) return r;
      return okv([['Range-Unit', 'items'], ['Range', r.value]]);
    }
    if (fn === 'rangeHdrsWithCount' && app.args.length === 1) {
      const r = renderByteRange(app.args[0], env);
      if (!r.ok) return r;
      return okv([['Prefer', 'count=exact'], ['Range-Unit', 'items'], ['Range', r.value]]);
    }
    if (app.args.length === 0 && app.head.type === 'ident') {
      const b = env.resolve(fn, app.head.line, env.seen);
      if (b) return evalHeaderList(b.rhs, { ...env, seen: b.seen });
    }
  }
  return fail(`unrecognized header list: ${txt(toks)}`);
}

/**
 * A request body. Returns { kind: 'empty' | 'json' | 'text', value }.
 */
function evalBody(toks0, env) {
  const toks = unwrap(toks0);
  if (!toks.length) return okv({ kind: 'empty', value: null });

  if (toks.length === 1) {
    const t = toks[0];
    if (t.type === 'quasi') {
      if (t.qq === 'json' || t.qq === 'aesonQQ') {
        const p = parseRelaxedJson(t.raw);
        if (!p.ok) return fail(`request body json quasi quote not parseable: ${p.error}`);
        return okv({ kind: 'json', value: p.value });
      }
      if (t.qq === 'str') return okv({ kind: 'text', value: decodeHeredoc(t.raw) });
      return fail(`unsupported quasi quoter [${t.qq}| in request body`);
    }
    if (t.type === 'ident' && (t.value === 'mempty' || t.value === 'BL.empty' || t.value === 'BS.empty')) {
      return okv({ kind: 'empty', value: null });
    }
    if (t.type === 'ident') {
      const b = env.resolve(t.value, t.line, env.seen);
      if (b) return evalBody(b.rhs, { ...env, seen: b.seen });
    }
  }

  const s = evalString(toks, env);
  if (s.ok) {
    if (s.value === '') return okv({ kind: 'empty', value: null });
    return okv({ kind: 'text', value: s.value });
  }
  return fail(`request body not a literal: ${s.reason}`);
}

// ---------------------------------------------------------------------------
// describe / context / it layout tracking
// ---------------------------------------------------------------------------

function buildScopes(toks) {
  const lineFirstCol = new Map();
  for (const t of toks) if (t.firstOfLine) lineFirstCol.set(t.line, t.col);

  const stack = [];
  const snapshots = []; // { index, stack: frozen copy }
  const snap = (index) => snapshots.push({ index, stack: stack.slice() });

  for (let i = 0; i < toks.length; i += 1) {
    const t = toks[i];
    if (t.firstOfLine) {
      let popped = false;
      while (stack.length && stack[stack.length - 1].col >= t.col) { stack.pop(); popped = true; }
      if (popped) snap(i);
    }
    if (t.type !== 'ident') continue;
    const kind = t.value === 'it' ? 'it' : (t.value === 'describe' || t.value === 'context') ? 'describe' : null;
    if (!kind) continue;
    const next = toks[i + 1];
    if (!next) continue;
    const isLabel = next.type === 'string' || isPunct(next, '(');
    if (!isLabel) continue;

    let eff = t.firstOfLine ? t.col : (lineFirstCol.get(t.line) ?? t.col);
    if (!t.firstOfLine && stack.length && stack[stack.length - 1].line === t.line) {
      eff = stack[stack.length - 1].col + 1;
    }
    while (stack.length && stack[stack.length - 1].col >= eff) stack.pop();

    // label expression extent
    let labelToks;
    if (next.type === 'string') labelToks = [next];
    else {
      const j = matchBracket(toks, i + 1);
      labelToks = j === -1 ? [] : toks.slice(i + 1, j + 1);
    }
    stack.push({ kind, col: eff, line: t.line, index: i, labelToks });
    snap(i + 1);
  }
  return snapshots;
}

function scopeAt(snapshots, index) {
  let lo = 0;
  let hi = snapshots.length - 1;
  let best = [];
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (snapshots[mid].index <= index) { best = snapshots[mid].stack; lo = mid + 1; }
    else hi = mid - 1;
  }
  return best;
}

/** End index (exclusive) of the block a scope frame governs. */
function blockEnd(toks, frame) {
  for (let i = frame.index + 1; i < toks.length; i += 1) {
    if (toks[i].firstOfLine && toks[i].col <= frame.col) return i;
  }
  return toks.length;
}

// ---------------------------------------------------------------------------
// withConfig tracking
// ---------------------------------------------------------------------------

function collectConfigs(toks) {
  const out = [];
  for (let i = 0; i < toks.length; i += 1) {
    const t = toks[i];
    if (t.type !== 'ident' || t.value !== 'withConfig') continue;
    if (isOp(toks[i + 1], '=')) continue;                  // LHS of a definition
    const prev = toks[i - 1];
    if (prev && prev.type === 'ident' && prev.value === 'spec') continue; // parameter binder
    // Config expression runs until a top-level `$` or `do`.
    let j = i + 1;
    let depth = 0;
    const expr = [];
    while (j < toks.length) {
      const u = toks[j];
      if (u.type === 'punct' && OPEN[u.value]) depth += 1;
      else if (u.type === 'punct' && CLOSE.has(u.value)) depth -= 1;
      if (depth === 0 && (isOp(u, '$') || (u.type === 'ident' && (u.value === 'do' || u.value === 'describe')))) break;
      expr.push(u);
      j += 1;
    }
    const flat = unwrap(expr);
    const isBase = flat.length === 1 && flat[0].type === 'ident' && flat[0].value === 'baseCfg';
    const fields = [...new Set(expr.filter((u) => /^config[A-Z]/.test(u.value ?? '')).map((u) => u.value))];
    out.push({ index: i, line: t.line, isBase, fields, text: txt(expr) });
  }
  return out;
}

function configAt(configs, index) {
  let found = null;
  for (const c of configs) {
    if (c.index <= index) found = c;
    else break;
  }
  return found;
}

// ---------------------------------------------------------------------------
// Expectation (right-hand side of shouldRespondWith)
// ---------------------------------------------------------------------------

function parseExpectation(toks, start, env) {
  const reasons = [];
  const lit = toks[start];
  if (!lit) return { reasons: ['no expectation expression after shouldRespondWith'], end: start };

  let status = null;
  let body = null;
  let bodyMatch = 'ignore';
  // How `body` is to be interpreted on the wire. Without this a JSON body that
  // happens to be a scalar (`[json|"Hello, world"|]`, `[json|null|]`,
  // `[json|"123"|]`) is indistinguishable from a raw text body, and the runner
  // guesses wrong every time. 'none' = the spec asserts an empty body.
  let bodyFormat = 'ignore';
  let next = start + 1;

  if (lit.type === 'number') {
    status = Number(lit.value);
    body = null;
    bodyMatch = 'ignore';
    bodyFormat = 'ignore';
  } else if (lit.type === 'quasi' && (lit.qq === 'json' || lit.qq === 'aesonQQ')) {
    const p = parseRelaxedJson(lit.raw);
    if (!p.ok) reasons.push(`expected body json quasi quote not parseable: ${p.error}`);
    else { body = p.value; bodyMatch = 'exact'; bodyFormat = 'json'; }
    status = 200;
  } else if (lit.type === 'quasi' && lit.qq === 'str') {
    // [str|...|] is a raw ByteString: upstream compares the bytes.
    body = decodeHeredoc(lit.raw);
    bodyMatch = 'exact';
    bodyFormat = 'text';
    status = 200;
  } else if (lit.type === 'string') {
    if (!lit.decodeOk) reasons.push(`expected body string has an escape the extractor cannot decode: ${lit.raw}`);
    else if (lit.value === '') { body = null; bodyMatch = 'exact'; bodyFormat = 'none'; }
    else {
      // A Haskell String matcher is also a byte comparison upstream. When the
      // bytes are valid JSON we compare structurally instead — a documented
      // relaxation (key order / whitespace), recorded as bodyFormat 'json'.
      const p = parseRelaxedJson(lit.value);
      body = p.ok ? p.value : lit.value;
      bodyMatch = 'exact';
      bodyFormat = p.ok ? 'json' : 'text';
    }
    status = 200;
  } else if (lit.type === 'conid' && lit.value === 'ResponseMatcher' && isPunct(toks[start + 1], '{')) {
    // Explicit record construction. Status/body/headers all come from fields.
    status = null;
    body = null;
    bodyMatch = null; // must be decided by matchBody
    bodyFormat = 'ignore';
  } else {
    // Not a literal: a variable, a conditional, a helper application...
    // Consume nothing; report.
    return { reasons: [`expectation is not a literal ResponseMatcher: ${txt([lit])}`], end: start + 1, status: null, body: null, bodyMatch: 'ignore', bodyFormat: 'ignore', headers: {}, headersAbsent: [], headersContain: [], headersMatch: [] };
  }

  const headers = {};
  const headersAbsent = [];
  const headersContain = [];
  const headersMatch = [];

  // Optional record update { matchStatus = .., matchHeaders = [..] }
  const brace = toks[next];
  if (isPunct(brace, '{')) {
    const close = matchBracket(toks, next);
    const inner = close === -1 ? [] : toks.slice(next + 1, close);
    const firstInner = inner[0];
    const looksLikeMatcher = firstInner && firstInner.type === 'ident' && /^match/.test(firstInner.value);
    if (close !== -1 && looksLikeMatcher) {
      next = close + 1;
      for (const field of splitTop(inner, (t) => isPunct(t, ','))) {
        if (!field.length) continue;
        const name = field[0].value;
        const eq = field[1];
        if (!isOp(eq, '=')) { reasons.push(`unparseable ResponseMatcher field: ${txt(field)}`); continue; }
        const rhs = field.slice(2);
        if (name === 'matchStatus') {
          const u = unwrap(rhs);
          if (u.length === 1 && u[0].type === 'number') status = Number(u[0].value);
          else reasons.push(`matchStatus is not a literal: ${txt(rhs)}`);
        } else if (name === 'matchHeaders') {
          const r = evalMatchHeaders(rhs, env);
          Object.assign(headers, r.headers);
          for (const n of r.absent) if (!headersAbsent.includes(n)) headersAbsent.push(n);
          headersContain.push(...r.contains);
          headersMatch.push(...r.matches);
          reasons.push(...r.reasons);
        } else if (name === 'matchBody') {
          // The one matchBody form with a static meaning: match any body.
          if (txt(unwrap(rhs)) === 'MatchBody ( \\ _ _ -> Nothing )') {
            body = null;
            bodyMatch = 'ignore';
            bodyFormat = 'ignore';
          } else {
            reasons.push('uses a custom matchBody matcher');
          }
        } else {
          reasons.push(`unknown ResponseMatcher field "${name}"`);
        }
      }
    }
  }

  if (bodyMatch === null) {
    reasons.push('ResponseMatcher record without a representable matchBody');
    bodyMatch = 'ignore';
    bodyFormat = 'ignore';
  }
  return {
    reasons, end: next, status, body, bodyMatch, bodyFormat, headers,
    headersAbsent, headersContain, headersMatch,
  };
}

// POSIX character classes the Server-Timing matcher uses, in JS RegExp form.
// `.` stays `.` — upstream's regex means "any character" there too.
function posixToJsRegex(pattern) {
  return pattern.replace(/\[\[:digit:\]\]/g, '[0-9]')
    .replace(/\[\[:alpha:\]\]/g, '[A-Za-z]')
    .replace(/\[\[:alnum:\]\]/g, '[A-Za-z0-9]')
    .replace(/\[\[:space:\]\]/g, '\\s');
}

/**
 * A `matchHeaders` list. Fills four buckets, all of them assertions the case
 * format can carry (CONTRACTS.md section 1):
 *   headers  — exact value        ("Name" <:> "value", matchContentTypeJson)
 *   absent   — header must not be present  (matchHeaderAbsent)
 *   contains — value must contain a substring (matchHeaderValuePresent)
 *   matches  — value must match a regex   (matchServerTimingHasTiming)
 */
function evalMatchHeaders(toks0, env) {
  const acc = { headers: {}, absent: [], contains: [], matches: [], reasons: [] };
  collectMatchHeaders(toks0, env, acc);
  return acc;
}

function collectMatchHeaders(toks0, env, acc) {
  const toks = unwrap(toks0);
  if (!toks.length) return;

  // list append / cons: `matchContentTypeJson : map matchServerTimingHasTiming [..]`
  const appended = splitTop(toks, (t) => isOp(t, '<>') || isOp(t, '++'));
  if (appended.length > 1) {
    for (const p of appended) collectMatchHeaders(p, env, acc);
    return;
  }
  const consed = splitTop(toks, (t) => isOp(t, ':'));
  if (consed.length > 1) {
    for (let k = 0; k < consed.length - 1; k += 1) {
      collectMatchHeaderItem(consed[k], env, acc);
    }
    collectMatchHeaders(consed[consed.length - 1], env, acc);
    return;
  }

  if (isPunct(toks[0], '[') && matchBracket(toks, 0) === toks.length - 1) {
    const inner = toks.slice(1, -1);
    if (!inner.length) return;
    for (const item of splitTop(inner, (t) => isPunct(t, ','))) {
      collectMatchHeaderItem(item, env, acc);
    }
    return;
  }

  if (toks.length === 1 && toks[0].type === 'ident') {
    if (toks[0].value === 'mempty') return;
    const b = env.resolve(toks[0].value, toks[0].line, env.seen);
    if (b) { collectMatchHeaders(b.rhs, { ...env, seen: b.seen }, acc); return; }
  }

  // `map matchServerTimingHasTiming [ "jwt", "parse" ]`
  const app = splitApp(toks);
  if (app && app.head.type === 'ident' && app.head.value === 'map'
      && app.args.length === 2) {
    const fn = unwrap(app.args[0]);
    const list = unwrap(app.args[1]);
    if (fn.length === 1 && isPunct(list[0], '[')
        && matchBracket(list, 0) === list.length - 1) {
      const inner = list.slice(1, -1);
      const items = inner.length ? splitTop(inner, (t) => isPunct(t, ',')) : [];
      for (const item of items) {
        collectMatchHeaderItem([...fn, ...item], env, acc);
      }
      return;
    }
  }

  acc.reasons.push(`matchHeaders is not a literal list: ${txt(toks)}`);
}

function collectMatchHeaderItem(item0, env, acc) {
  const item = unwrap(item0);
  if (!item.length) return;

  // "Name" <:> "value"
  const sides = splitTop(item, (t) => isOp(t, '<:>'));
  if (sides.length === 2) {
    const n = evalHeaderName(sides[0], env);
    const v = evalString(sides[1], env);
    if (!n.ok) { acc.reasons.push(`asserted header name not literal: ${n.reason}`); return; }
    if (!v.ok) { acc.reasons.push(`asserted header value not literal: ${v.reason}`); return; }
    acc.headers[n.value] = acc.headers[n.value] === undefined
      ? v.value : `${acc.headers[n.value]}, ${v.value}`;
    return;
  }

  if (item.length === 1 && item[0].type === 'ident'
      && CONTENT_TYPE_MATCHERS[item[0].value]) {
    acc.headers['Content-Type'] = CONTENT_TYPE_MATCHERS[item[0].value];
    return;
  }

  const app = splitApp(item);
  const headName = app ? app.head.value
    : (item[0].type === 'ident' ? item[0].value : null);

  if (app && headName === 'matchHeaderAbsent' && app.args.length === 1) {
    const n = evalHeaderName(app.args[0], env);
    if (!n.ok) { acc.reasons.push(`asserted absent header name not literal: ${n.reason}`); return; }
    if (!acc.absent.includes(n.value)) acc.absent.push(n.value);
    return;
  }
  if (app && headName === 'matchHeaderValuePresent' && app.args.length === 2) {
    const n = evalHeaderName(app.args[0], env);
    const v = evalString(app.args[1], env);
    if (!n.ok) { acc.reasons.push(`asserted header name not literal: ${n.reason}`); return; }
    if (!v.ok) { acc.reasons.push(`asserted header substring not literal: ${v.reason}`); return; }
    acc.contains.push({ name: n.value, value: v.value });
    return;
  }
  if (app && headName === 'matchServerTimingHasTiming' && app.args.length === 1) {
    const v = evalString(app.args[0], env);
    if (!v.ok) { acc.reasons.push(`Server-Timing metric name not literal: ${v.reason}`); return; }
    // SpecHelper.hs: hdr =~ (metric <> ";dur=[[:digit:]]+.[[:digit:]]+")
    acc.matches.push({
      name: 'Server-Timing',
      pattern: posixToJsRegex(`${v.value};dur=[[:digit:]]+.[[:digit:]]+`),
    });
    return;
  }

  if (headName && UNREPRESENTABLE_MATCHERS[headName]) {
    acc.reasons.push(UNREPRESENTABLE_MATCHERS[headName]);
    return;
  }
  if (!app && item.length === 1 && item[0].type === 'ident') {
    const b = env.resolve(item[0].value, item[0].line, env.seen);
    if (b) { collectMatchHeaders(b.rhs, { ...env, seen: b.seen }, acc); return; }
  }
  acc.reasons.push(`unrecognized matchHeaders entry: ${txt(item)}`);
}

// ---------------------------------------------------------------------------
// Request (left-hand side of shouldRespondWith)
// ---------------------------------------------------------------------------

function findRequestExpr(toks, opIndex) {
  // Walk left to the nearest hspec-wai request helper, refusing to cross a
  // statement boundary.
  let depth = 0;
  for (let i = opIndex - 1; i >= 0; i -= 1) {
    const t = toks[i];
    if (t.type === 'punct' && CLOSE.has(t.value)) { depth += 1; continue; }
    if (t.type === 'punct' && OPEN[t.value]) {
      if (depth === 0) return { error: `request expression starts inside a bracket: ${txt(toks.slice(i, opIndex))}` };
      depth -= 1;
      continue;
    }
    if (depth > 0) continue;
    if (t.type === 'ident' && REQUEST_HEADS[t.value]) return { start: i };
    if (t.type === 'backtick') return { error: 'chained infix operator before shouldRespondWith' };
    if (t.type === 'ident' && LEFT_STOP_IDENTS.has(t.value)) {
      return { error: `no request helper between "${t.value}" and shouldRespondWith` };
    }
    if (t.type === 'op' && LEFT_STOP_OPS.has(t.value)) {
      return { error: `no request helper after "${t.value}"` };
    }
    if (t.type === 'punct' && (t.value === ',' || t.value === ';')) {
      return { error: 'no request helper in this expression' };
    }
  }
  return { error: 'no request helper found before shouldRespondWith' };
}

function parseRequest(toks, start, opIndex, env) {
  const slice = toks.slice(start, opIndex);
  const head = slice[0];
  const spec = REQUEST_HEADS[head.value];
  const app = splitApp(slice);
  if (!app) return fail(`unparseable request expression: ${txt(slice)}`);
  if (app.args.length !== spec.args.length) {
    return fail(`${head.value} called with ${app.args.length} arguments, expected ${spec.args.length}: ${txt(slice)}`);
  }

  const req = { method: spec.method, path: null, query: '', headers: {}, body: null };
  const argMap = {};
  spec.args.forEach((n, k) => { argMap[n] = app.args[k]; });

  if (argMap.method) {
    const u = unwrap(argMap.method);
    if (u.length === 1 && METHOD_IDENTS[u[0].value]) req.method = METHOD_IDENTS[u[0].value];
    else {
      const s = evalString(argMap.method, env);
      if (s.ok && /^[A-Z]+$/.test(s.value)) req.method = s.value;
      else return fail(`request method is not a literal: ${txt(argMap.method)}`);
    }
  }

  const p = evalString(argMap.path, env);
  if (!p.ok) return fail(`request path is not a literal: ${p.reason}`);
  // A handful of upstream sites omit the leading slash (get "items?id=eq.1").
  // Network.Wai.Test.setPath splits on '/' and drops the empty leading
  // segment, so "items" and "/items" address the same route.
  const rawPath = p.value.startsWith('/') ? p.value : `/${p.value}`;
  const qi = rawPath.indexOf('?');
  req.path = qi === -1 ? rawPath : rawPath.slice(0, qi);
  req.query = qi === -1 ? '' : rawPath.slice(qi + 1);

  if (argMap.headers) {
    const h = evalHeaderList(argMap.headers, env);
    if (!h.ok) return fail(`request headers not representable: ${h.reason}`);
    for (const [n, v] of h.value) {
      // A token the spec signs at run time is carried as request.jwt, not as a
      // literal header: the runner mints it (CONTRACTS.md section 1).
      if (v && typeof v === 'object' && v.jwt) { req.jwt = v.jwt; continue; }
      req.headers[n] = req.headers[n] === undefined ? v : `${req.headers[n]}, ${v}`;
    }
  }

  if (argMap.body) {
    const b = evalBody(argMap.body, env);
    if (!b.ok) return fail(b.reason);
    req.body = b.value.kind === 'empty' ? null : b.value.value;
    req.bodyKind = b.value.kind;
  } else {
    req.bodyKind = 'empty';
  }

  return okv(req);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export function parseSpec(src, sourceRel) {
  const specName = sourceRel.split('/').pop().replace(/\.hs$/, '');
  const toks = lex(src);
  const bindings = collectBindings(toks);
  const resolve = makeResolver(bindings);
  const env = {
    resolve,
    seen: new Set(),
    relativeSeconds: collectRelativeSecondsBindings(toks),
  };
  const snapshots = buildScopes(toks);
  const configs = collectConfigs(toks);
  const fileFeatureFlags = [...new Set(configs
    .flatMap((c) => c.fields)
    .filter((f) => FEATURE_FLAG_FIELDS.has(f)))];

  const cases = [];
  const usedIds = new Set();
  // Index of the previous shouldRespondWith site, and whether it was skipped.
  // A later assertion inside the same `it` runs against state the earlier
  // request was supposed to create.
  let lastSite = null;

  for (let i = 0; i < toks.length; i += 1) {
    const t = toks[i];
    if (t.type !== 'backtick' || t.value !== 'shouldRespondWith') continue;

    // Reasons carry a kind: 'config' means the only thing standing in the way is
    // a PostgREST configuration knob the engine does not have, so the case is
    // reclassified as needs-engine-config rather than buried in `skipped`
    // (CONTRACTS.md section 1, skipClass). 'hard' means the assertion itself
    // cannot be represented.
    const reasons = [];
    const pushReason = (text, kind = 'hard') => reasons.push({ text, kind });
    const scope = scopeAt(snapshots, i);
    const itFrame = [...scope].reverse().find((f) => f.kind === 'it') ?? null;
    const describePath = scope.filter((f) => f.kind === 'describe')
      .map((f) => {
        const s = evalString(f.labelToks, env);
        return s.ok ? s.value : txt(f.labelToks);
      });
    let description;
    if (itFrame) {
      const s = evalString(itFrame.labelToks, env);
      description = s.ok ? s.value : txt(itFrame.labelToks);
    } else {
      description = describePath.join(' / ') || specName;
    }

    const found = findRequestExpr(toks, i);
    let request = null;
    let line = t.line;
    if (found.error) {
      pushReason(found.error);
    } else {
      line = toks[found.start].line;
      const r = parseRequest(toks, found.start, i, env);
      if (r.ok) request = r.value;
      else pushReason(r.reason);
    }

    const exp = parseExpectation(toks, i + 1, env);
    for (const r of exp.reasons) pushReason(r);

    // Config gate: an assertion under a non-default AppConfig cannot be
    // reproduced against the engine's fixed configuration.
    const cfg = configAt(configs, i);
    if (cfg && !cfg.isBase) {
      const blocking = cfg.fields.filter((f) => !NON_BLOCKING_CONFIG_FIELDS.has(f));
      if (blocking.length || !cfg.fields.length) {
        const what = blocking.length ? blocking.join(', ') : cfg.text;
        pushReason(`requires non-default PostgREST config (${what})`, 'config');
      }
    }
    if (cfg && cfg.isBase && fileFeatureFlags.length) {
      const names = fileFeatureFlags.map((f) => FEATURE_FLAG_NAMES[f] ?? f);
      pushReason('asserts the behaviour of a PostgREST feature that is off by '
        + `default and the engine has no switch for (${names.join(', ')})`,
      'config');
    }

    // A `shouldRespondWith` with no enclosing `it` is not a test: it is a
    // top-level helper definition (RollbackSpec's `postItem`/`deleteItems`).
    if (!itFrame) {
      pushReason('assertion is not inside an `it` example (top-level helper '
        + 'definition, not a test)');
    }

    // Multi-step example: the previous assertion in this same `it` could not be
    // represented, so the state this one reads was never produced. Upstream
    // RollbackSpec has two byte-identical GETs asserting opposite bodies for
    // exactly this reason.
    // A read-only predecessor changes no state, so only a mutating (or
    // unparseable, therefore unknown) one poisons the follow-up.
    // The cascade inherits the predecessor's class: a step that only waits on a
    // config knob does not make the follow-up unrepresentable.
    if (itFrame && lastSite && lastSite.itIndex === itFrame.index
        && lastSite.skipped && lastSite.mutating !== false) {
      pushReason('a preceding assertion in the same example was skipped, so '
        + 'the state this one depends on is never created',
      lastSite.skipClass === 'needs-engine-config' ? 'config' : 'hard');
    }

    // Version guards / conditional pending inside the enclosing example.
    const guardFrame = itFrame ?? scope[scope.length - 1];
    if (guardFrame) {
      const end = blockEnd(toks, guardFrame);
      for (let k = guardFrame.index; k < end; k += 1) {
        const u = toks[k];
        if (u.type !== 'ident') continue;
        if (u.value === 'pendingWith') { pushReason('example is conditionally pending (pendingWith)'); break; }
      }
      for (let k = guardFrame.index; k < end; k += 1) {
        const u = toks[k];
        if (u.type === 'ident' && u.value === 'actualPgVersion') {
          pushReason('example is gated on a PostgreSQL version check (actualPgVersion)');
          break;
        }
      }
    }

    let id = `${specName}:${line}`;
    if (usedIds.has(id)) {
      id = `${specName}:${t.line}`;
      let n = 2;
      while (usedIds.has(id)) { id = `${specName}:${line}#${n}`; n += 1; }
    }
    usedIds.add(id);

    if (request === null && !reasons.length) {
      pushReason('request expression could not be parsed');
    }
    const skip = reasons.length > 0;
    // De-duplicate on the text, keeping the strictest kind for a repeated text.
    const byText = new Map();
    for (const r of reasons) {
      const prev = byText.get(r.text);
      if (!prev) byText.set(r.text, r.kind);
      else if (prev !== r.kind) byText.set(r.text, 'hard');
    }
    const uniqueReasons = [...byText.keys()];
    // Only a knob away from running: every obstacle is PostgREST configuration.
    const skipClass = !skip ? null
      : ([...byText.values()].every((k) => k === 'config')
        ? 'needs-engine-config' : 'not-representable');
    lastSite = {
      itIndex: itFrame ? itFrame.index : null,
      skipped: skip,
      skipClass,
      mutating: request
        ? !['GET', 'HEAD', 'OPTIONS'].includes(request.method)
        : null,
    };

    const req = request
      ? {
        method: request.method,
        path: request.path,
        query: request.query,
        headers: request.headers,
        body: request.body === undefined ? null : request.body,
        bodyFormat: request.bodyKind === 'empty' ? 'none' : request.bodyKind,
      }
      : null;
    // A token upstream signs in SpecHelper.hs. The claim set is what the spec
    // wrote; the runner signs it (CONTRACTS.md section 1).
    if (req && request.jwt) req.jwt = request.jwt;
    const expected = {
      status: exp.status ?? null,
      body: exp.body === undefined ? null : exp.body,
      bodyFormat: exp.bodyFormat ?? 'ignore',
      headers: exp.headers ?? {},
    };
    // Header assertions that are not "this header equals this value". Emitted
    // only when the spec makes one, so a case file stays readable.
    if (exp.headersAbsent?.length) expected.headersAbsent = exp.headersAbsent;
    if (exp.headersContain?.length) expected.headersContain = exp.headersContain;
    if (exp.headersMatch?.length) expected.headersMatch = exp.headersMatch;
    const transforms = [];
    // The fixtures rewrite upstream's `test` schema into `public` (CLAUDE.md
    // rule 9: the engine introspects public only), so an error message that
    // names `test.<object>` can never match. Apply the same rename to the
    // expectation instead of throwing the case away — it is testing the error
    // shape, not the schema name. Only for cases that do not select a schema.
    if (req && !pickHeaderName(req.headers, 'accept-profile')
        && !pickHeaderName(req.headers, 'content-profile')
        && /\btest\./.test(JSON.stringify(expected.body ?? null))) {
      expected.body = rewriteSchemaNames(expected.body);
      transforms.push('expected body: schema "test." rewritten to "public." '
        + '(the DSQL fixtures load upstream\'s test schema into public)');
    }

    cases.push({
      id,
      source: sourceRel,
      line,
      category: categoryFor(sourceRel,
        describePath.length ? describePath : [description], req),
      description,
      // Which upstream `it` this assertion belongs to. Several assertions in
      // one example are sequential steps; the runner needs the grouping to
      // know where it may reset the fixtures.
      example: itFrame ? `${specName}:it:${itFrame.line}` : null,
      request: req,
      expected,
      bodyMatch: exp.bodyMatch ?? 'ignore',
      transforms,
      skip,
      skipReason: skip ? uniqueReasons.join('; ') : null,
      skipClass,
    });
  }

  const extractedCases = cases.filter((c) => !c.skip).length;
  const needsConfigCases = cases
    .filter((c) => c.skipClass === 'needs-engine-config').length;
  return {
    source: sourceRel,
    extractedCases,
    skippedSites: cases.length - extractedCases,
    needsConfigCases,
    cases,
  };
}

/**
 * Structural validation of one extracted document. Returns array of problems.
 */
export function validateDocument(doc, seenIds = new Set()) {
  const problems = [];
  const push = (m) => problems.push(`${doc.source}: ${m}`);
  if (typeof doc.source !== 'string') push('missing source');
  if (!Array.isArray(doc.cases)) { push('missing cases array'); return problems; }
  if (doc.extractedCases !== doc.cases.filter((c) => !c.skip).length) push('extractedCases does not match cases');
  if (doc.skippedSites !== doc.cases.filter((c) => c.skip).length) push('skippedSites does not match cases');

  for (const c of doc.cases) {
    if (!c.id) { push('case without id'); continue; }
    if (seenIds.has(c.id)) push(`duplicate id ${c.id}`);
    seenIds.add(c.id);
    if (typeof c.line !== 'number') push(`${c.id}: line is not a number`);
    if (!c.category || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(c.category)) push(`${c.id}: bad category ${c.category}`);
    if (typeof c.description !== 'string') push(`${c.id}: bad description`);
    if (!['exact', 'set', 'ignore'].includes(c.bodyMatch)) push(`${c.id}: bad bodyMatch ${c.bodyMatch}`);
    if (typeof c.skip !== 'boolean') push(`${c.id}: skip is not a boolean`);
    if (c.skip && !c.skipReason) push(`${c.id}: skip without skipReason`);
    if (!c.skip && c.skipReason) push(`${c.id}: skipReason on a non-skipped case`);
    if (c.skip && !['needs-engine-config', 'not-representable'].includes(c.skipClass)) {
      push(`${c.id}: bad skipClass ${c.skipClass}`);
    }
    if (!c.skip && c.skipClass !== null) push(`${c.id}: skipClass on a non-skipped case`);
    const absent = c.expected?.headersAbsent;
    if (absent !== undefined
        && !(Array.isArray(absent) && absent.length
          && absent.every((n) => typeof n === 'string' && n))) {
      push(`${c.id}: expected.headersAbsent must be a non-empty array of header names`);
    }
    for (const [field, valueKey] of [['headersContain', 'value'], ['headersMatch', 'pattern']]) {
      const list = c.expected?.[field];
      if (list === undefined) continue;
      if (!Array.isArray(list) || !list.length) {
        push(`${c.id}: expected.${field} must be a non-empty array`);
        continue;
      }
      for (const e of list) {
        if (!e || typeof e.name !== 'string' || typeof e[valueKey] !== 'string') {
          push(`${c.id}: expected.${field} entries need name and ${valueKey} strings`);
        }
      }
    }
    const jwt = c.request?.jwt;
    if (jwt !== undefined) {
      if (!jwt || typeof jwt !== 'object'
          || jwt.alg !== 'HS256' || typeof jwt.secret !== 'string' || !jwt.secret
          || !jwt.claims || typeof jwt.claims !== 'object') {
        push(`${c.id}: request.jwt must be { alg: "HS256", secret, claims }`);
      }
    }
    if (c.expected?.headersMatch) {
      for (const e of c.expected.headersMatch) {
        try { new RegExp(e.pattern); } catch {
          push(`${c.id}: expected.headersMatch pattern is not a regex: ${e.pattern}`);
        }
      }
    }
    if (!('body' in (c.expected ?? {}))) push(`${c.id}: expected.body missing (must be explicit null)`);
    if (!['json', 'text', 'none', 'ignore'].includes(c.expected?.bodyFormat)) push(`${c.id}: bad expected.bodyFormat ${c.expected?.bodyFormat}`);
    if (!Array.isArray(c.transforms)) push(`${c.id}: transforms is not an array`);
    if (c.expected && c.expected.headers && typeof c.expected.headers !== 'object') push(`${c.id}: expected.headers not an object`);

    if (!c.skip) {
      if (!c.request) { push(`${c.id}: non-skipped case without a request`); continue; }
      const r = c.request;
      if (!/^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/.test(r.method ?? '')) push(`${c.id}: bad method ${r.method}`);
      if (typeof r.path !== 'string' || !r.path.startsWith('/')) push(`${c.id}: bad path ${r.path}`);
      if (typeof r.query !== 'string') push(`${c.id}: query must be a string`);
      if (!('body' in r)) push(`${c.id}: request.body missing (must be explicit null)`);
      if (!['json', 'text', 'none'].includes(r.bodyFormat)) push(`${c.id}: bad request.bodyFormat ${r.bodyFormat}`);
      if (typeof r.headers !== 'object' || r.headers === null) push(`${c.id}: request.headers not an object`);
      try {
        new URL(`http://x${r.path}${r.query ? `?${r.query}` : ''}`);
      } catch {
        push(`${c.id}: request path/query is not a parseable URL: ${r.path}?${r.query}`);
      }
      if (typeof c.expected.status !== 'number') push(`${c.id}: expected.status missing`);
    }
  }
  return problems;
}

export const SPEC_CATEGORY_MAP = FILE_CATEGORY;
