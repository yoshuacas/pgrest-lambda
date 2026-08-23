#!/usr/bin/env node
// run.mjs — PostgREST conformance runner.
//
// Loads the extracted cases (CONTRACTS.md section 1), replays each one against
// the pgrest-lambda REST handler IN-PROCESS (an API Gateway REST event is built
// and the exported handler is called — no HTTP server, no deployed stack), and
// writes conformance/results/latest.json plus a timestamped copy
// (CONTRACTS.md section 3).
//
//   node conformance/runner/run.mjs --target dsql
//   node conformance/runner/run.mjs --target dsql --category select
//   node conformance/runner/run.mjs --id QuerySpec:142 --id QuerySpec:150
//   node conformance/runner/run.mjs --limit 50 --concurrency 1
//
// Every non-passing case gets a `gap` slug naming the root cause. Triage uses,
// in order: what the harness threw, what the extractor marked skipped, what the
// fixture loader had to drop (conformance/fixtures/load-report.json), what the
// live catalog actually contains, the PostgREST error code in the response, and
// the sanitized pg error the handler logged. See triage() for the full table.
//
// Env: DSQL_ENDPOINT / REGION_NAME (never AWS_REGION — reserved by Lambda) for
// the dsql target; DATABASE_URL or PG_* for the postgres target.

import {
  readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHmac } from 'node:crypto';

import { createPgrest } from '../../src/index.mjs';
import { splitStatements, tokenize, parseQualifiedName, norm }
  from '../fixtures/sqlsplit.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const CASES_DIR = join(REPO, 'conformance', 'cases');
const RESULTS_DIR = join(REPO, 'conformance', 'results');
// Upstream grants its test roles privileges in SQL; DSQL has neither `SET ROLE`
// nor `GRANT ... TO <role>`, so the fixture equivalent is a Cedar policy set.
// See conformance/fixtures/policies/10-privileges.cedar.
const POLICIES_DIR = join(REPO, 'conformance', 'fixtures', 'policies');
const LOAD_REPORT = join(REPO, 'conformance', 'fixtures', 'load-report.json');

// DSQL conformance cluster (CONTRACTS.md). Env wins.
const DEFAULT_DSQL_ENDPOINT =
  '6juamhyj5nkoeatkzc3ieaerc4.dsql.us-east-1.on.aws';
const DEFAULT_REGION = 'us-east-1';

const MAX_ACTUAL_BODY_CHARS = 8000;
const DATA_FILE = '07-data.sql';
const DATA_PATH = join(REPO, 'conformance', 'fixtures', 'dsql', DATA_FILE);

// ---------------------------------------------------------------- CLI

const USAGE = `conformance runner

  node conformance/runner/run.mjs [options]

  --target <dsql|postgres>  database under test (default: dsql)
  --category <slug>         only cases in this category (repeatable, or a,b,c)
  --id <case-id>            only this case id or id prefix (repeatable)
  --limit <n>               stop after n selected cases
  --concurrency <n>         in-flight cases (default 1; DSQL pool max is 5).
                            >1 makes results nondeterministic: mutating cases
                            share the live fixture data with reading cases and
                            there is no isolation, so the interleaving decides
                            some outcomes. Measured on select+filters: five
                            cases flipped between two runs at 4, none at 1.
  --timeout <ms>            per-case timeout (default 30000)
  --role <role>             authorizer role when a case sends no JWT
                            (default: anon, which is what upstream's
                            db-anon-role=postgrest_test_anonymous is)
  --cases-dir <path>        default conformance/cases
  --policies <path>         Cedar policy source. Defaults to
                            conformance/fixtures/policies, which is the
                            engine's shipped default set plus upstream's
                            privileges.sql translated into Cedar. Pass
                            ./policies to measure against the product
                            defaults alone.
  --out-dir <path>          default conformance/results
  --reload-data             re-apply conformance/fixtures/dsql/07-data.sql
                            before running (dsql target only). Mutating cases
                            write to the live fixtures and DSQL has no
                            SAVEPOINT, so a run that includes insert/update/
                            delete/upsert cases is only reproducible from
                            restored data. Any reset flag also empties the
                            tables the fixtures create and 07-data.sql never
                            fills: re-applying the data file cannot clear those,
                            so a row a case inserted into one of them would
                            otherwise outlive the run (the count and the rows
                            cleared are printed at the end of the run).
  --reset-mutations         restore 07-data.sql after every mutating case, so
                            each case starts from the fixture state upstream
                            gives it (SpecHelper sets db-tx-end=rollback-all:
                            upstream rolls back every request). Assertions
                            inside one example are kept together when the
                            earlier step sent Prefer: tx=commit. Needs
                            --concurrency 1; ~8 s per reset.
  --reload-per-spec         reload 07-data.sql before each spec file, the way
                            upstream reloads fixtures per spec. Without it a
                            full run reports the wrong numbers for whatever
                            runs after a mutating spec — measured: select
                            scores 17/76 alone and 13/76 in a full run because
                            DeleteSpec/UpdateSpec empty 'items' first. Costs
                            ~7 s per spec file and needs --concurrency 1.
  --reset-touched           restore only the tables a mutating case touched,
                            instead of re-applying all of 07-data.sql. Same
                            intent as --reset-mutations (upstream rolls back
                            every request) at a fraction of the cost: 2-4
                            statements instead of 562. Falls back to a full
                            reload when the touched set cannot be derived.
                            Needs --concurrency 1.
  --no-per-case-config      do not boot per-case engine configurations; leave
                            every 'requires non-default PostgREST config' case
                            reported as needs-config. On by default: a case
                            records the config fields it needs and the runner
                            boots a second engine with them (see
                            ENGINE_CONFIGS) so the case passes or fails for
                            real.
  --verbose-errors          run the engine with errors.verbose (changes bodies)
  --list                    print the selected case ids and exit
  --help
`;

function parseArgs(argv) {
  const opts = {
    target: 'dsql',
    categories: [],
    ids: [],
    limit: null,
    concurrency: 1,
    timeout: 30000,
    role: 'anon',
    casesDir: CASES_DIR,
    policies: POLICIES_DIR,
    outDir: RESULTS_DIR,
    reloadData: false,
    reloadPerSpec: false,
    resetMutations: false,
    resetTouched: false,
    perCaseConfig: true,
    verboseErrors: false,
    list: false,
  };
  const many = (v) => String(v).split(',').map(s => s.trim()).filter(Boolean);

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    switch (a) {
      case '--target': opts.target = next(); break;
      case '--category': opts.categories.push(...many(next())); break;
      case '--id': opts.ids.push(...many(next())); break;
      case '--limit': opts.limit = parseInt(next(), 10); break;
      case '--concurrency': opts.concurrency = parseInt(next(), 10); break;
      case '--timeout': opts.timeout = parseInt(next(), 10); break;
      case '--role': opts.role = next(); break;
      case '--cases-dir': opts.casesDir = next(); break;
      case '--policies': opts.policies = next(); break;
      case '--out-dir': opts.outDir = next(); break;
      case '--reload-data': opts.reloadData = true; break;
      case '--reload-per-spec': opts.reloadPerSpec = true; break;
      case '--reset-mutations': opts.resetMutations = true; break;
      case '--reset-touched': opts.resetTouched = true; break;
      case '--no-per-case-config': opts.perCaseConfig = false; break;
      case '--verbose-errors': opts.verboseErrors = true; break;
      case '--list': opts.list = true; break;
      case '--help': case '-h': process.stdout.write(USAGE); process.exit(0);
      default:
        throw new Error(`unknown flag: ${a}\n\n${USAGE}`);
    }
  }
  if (!Number.isFinite(opts.concurrency) || opts.concurrency < 1) {
    opts.concurrency = 1;
  }
  return opts;
}

// ---------------------------------------------------------------- case loading

export function loadCases(casesDir) {
  if (!existsSync(casesDir)) return { cases: [], files: [] };
  const files = readdirSync(casesDir)
    .filter(f => f.endsWith('.json'))
    .sort();

  const cases = [];
  const seen = new Map();
  for (const file of files) {
    const full = join(casesDir, file);
    let doc;
    try {
      doc = JSON.parse(readFileSync(full, 'utf8'));
    } catch (err) {
      throw new Error(`${file}: not valid JSON — ${err.message}`);
    }
    if (!Array.isArray(doc.cases)) {
      throw new Error(`${file}: missing "cases" array (CONTRACTS.md §1)`);
    }
    for (const c of doc.cases) {
      if (!c || typeof c.id !== 'string') {
        throw new Error(`${file}: a case is missing "id"`);
      }
      if (seen.has(c.id)) {
        throw new Error(
          `duplicate case id ${c.id} (${seen.get(c.id)} and ${file}); `
          + 'ids must be unique across all files (CONTRACTS.md §1)');
      }
      seen.set(c.id, file);
      cases.push({
        ...c,
        source: c.source || doc.source || file,
        category: c.category || 'uncategorized',
        bodyMatch: c.bodyMatch || 'exact',
        request: c.request || {},
        expected: c.expected || {},
      });
    }
  }
  return { cases, files };
}

export function selectCases(cases, opts) {
  let out = cases;
  if (opts.categories.length) {
    const wanted = new Set(opts.categories);
    out = out.filter(c => wanted.has(c.category));
  }
  if (opts.ids.length) {
    out = out.filter(c => opts.ids.some(
      id => c.id === id || c.id.startsWith(id)));
  }
  if (Number.isFinite(opts.limit) && opts.limit >= 0) {
    out = out.slice(0, opts.limit);
  }
  return out;
}

// ---------------------------------------------------------------- event build

// Query strings are decoded the way API Gateway hands them to a Lambda:
// percent-escapes resolved, '+' left alone (PostgREST uses '+' inside tsquery
// and range literals, and API Gateway does not treat it as a space here).
export function parseQueryString(qs) {
  const single = {};
  const multi = {};
  if (!qs) return { single: null, multi: null };
  for (const pair of String(qs).replace(/^\?/, '').split('&')) {
    if (pair === '') continue;
    const eq = pair.indexOf('=');
    const rawKey = eq === -1 ? pair : pair.slice(0, eq);
    const rawVal = eq === -1 ? '' : pair.slice(eq + 1);
    const key = safeDecode(rawKey);
    const val = safeDecode(rawVal);
    single[key] = val;                       // API Gateway keeps the last one
    (multi[key] ||= []).push(val);
  }
  if (Object.keys(single).length === 0) return { single: null, multi: null };
  return { single, multi };
}

// Percent-decode the way WAI (and therefore PostgREST) does: every *valid*
// %XX escape is resolved, and a stray '%' that is not followed by two hex
// digits is passed through as a literal '%'.
//
// decodeURIComponent() cannot be used directly, because it is all-or-nothing:
// one malformed escape anywhere in the string makes it throw, and the old
// fallback then returned the *whole* raw string undecoded. A query such as
// `data->!@#$%^%26*_d` (a valid `%26` sitting next to a bare `%^`) therefore
// reached the engine with `%26` still escaped, i.e. a literally different JSON
// key than upstream sees. Decoding escape-by-escape fixes that without
// inventing a decoding for the malformed ones.
export function safeDecode(s) {
  const str = String(s);
  if (!str.includes('%')) return str;

  const bytes = [];
  const utf8 = new TextEncoder();
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === '%' && /^[0-9a-fA-F]{2}$/.test(str.slice(i + 1, i + 3))) {
      bytes.push(parseInt(str.slice(i + 1, i + 3), 16));
      i += 2;
      continue;
    }
    // Literal character: encode as UTF-8 so it survives the byte-level
    // reassembly below alongside the decoded escapes.
    for (const b of utf8.encode(ch)) bytes.push(b);
  }

  // Non-fatal: a run of decoded bytes that is not valid UTF-8 becomes U+FFFD
  // rather than throwing, which is what a lenient HTTP stack does.
  return new TextDecoder('utf-8').decode(new Uint8Array(bytes));
}

function decodeJwtPayload(token) {
  const parts = String(token).split('.');
  if (parts.length < 2) return null;
  try {
    const json = Buffer.from(
      parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const payload = JSON.parse(json);
    return payload && typeof payload === 'object' ? payload : null;
  } catch {
    return null;
  }
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// `{ "$secondsFromNow": n }` in a claim value is upstream's
// `relativeSeconds n` (SpecHelper.hs) bound through a `#{currentTime}` splice.
// It has to be resolved at mint time: baking an absolute number at extraction
// time would silently flip the meaning of every exp/nbf/iat case.
export function resolveJwtClaims(value, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (Array.isArray(value)) {
    return value.map((v) => resolveJwtClaims(v, nowSeconds));
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0] === '$secondsFromNow') {
      return nowSeconds + Number(value.$secondsFromNow);
    }
    return Object.fromEntries(
      keys.map((k) => [k, resolveJwtClaims(value[k], nowSeconds)]));
  }
  return value;
}

/**
 * Re-create the token upstream's `generateJWT` / `generateJWTWithSecret` signs
 * (SpecHelper.hs: HMAC-SHA256 over the spec's own secret). `request.jwt` is
 * `{ alg, secret, claims }` per CONTRACTS.md section 1.
 */
export function mintJwt(spec, nowSeconds) {
  const alg = spec.alg || 'HS256';
  if (alg !== 'HS256') throw new Error(`unsupported JWT alg ${alg}`);
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const claims = resolveJwtClaims(spec.claims ?? {}, nowSeconds);
  const payload = b64url(JSON.stringify(claims));
  const signingInput = `${header}.${payload}`;
  const sig = b64url(createHmac('sha256', String(spec.secret ?? ''))
    .update(signingInput).digest());
  return `${signingInput}.${sig}`;
}

// Mirrors deploy/aws-sam/authorizer.mjs: the authorizer resolves a role, a user
// id and an email into flat requestContext.authorizer keys. Signatures are not
// verified here — the upstream specs sign with their own fixture key, and the
// point of the run is to exercise the REST engine, not the authorizer.
export function authorizerContext(caseHeaders, defaultRole) {
  const auth = pickHeader(caseHeaders, 'authorization');
  if (!auth) return { role: defaultRole, userId: '', email: '' };
  const m = /^bearer\s+(.+)$/i.exec(auth.trim());
  if (!m) return { role: 'anon', userId: '', email: '' };
  const payload = decodeJwtPayload(m[1]);
  if (!payload) return { role: 'anon', userId: '', email: '' };
  return {
    // No role claim means the anon role, not an authenticated one: upstream
    // reads `jwt-role-claim-key` and falls back to `db-anon-role` when it is
    // absent (Auth.hs `parseRoleClaim`), which is why a claimless JWT is
    // refused a table anonymous cannot read (AuthSpec:130, :135).
    role: payload.role || defaultRole,
    userId: payload.sub || payload.id || payload['user_id'] || '',
    email: payload.email || '',
  };
}

// Does this case write? Anything that is not a plain read, including
// `POST /rpc/...` — a SQL function can INSERT and the case format does not say
// whether it does, so the runner errs on the side of restoring the fixtures.
export function isMutating(testCase) {
  const m = String(testCase.request?.method || 'GET').toUpperCase();
  return !['GET', 'HEAD', 'OPTIONS'].includes(m);
}

function pickHeader(headers, name) {
  if (!headers) return undefined;
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

export function buildEvent(testCase, opts = {}) {
  const req = testCase.request || {};
  const method = (req.method || 'GET').toUpperCase();

  let rawPath = req.path || '/';
  let query = req.query || '';
  const qIdx = rawPath.indexOf('?');
  if (qIdx !== -1) {
    // Extractors sometimes keep the query on the path. Merge, path wins first.
    const fromPath = rawPath.slice(qIdx + 1);
    rawPath = rawPath.slice(0, qIdx);
    query = query ? `${fromPath}&${query}` : fromPath;
  }
  if (!rawPath.startsWith('/')) rawPath = '/' + rawPath;
  const path = rawPath.startsWith('/rest/v1')
    ? rawPath
    : '/rest/v1' + (rawPath === '/' ? '' : rawPath);

  const { single, multi } = parseQueryString(query);

  const headers = { host: 'conformance.local', ...(req.headers || {}) };
  // request.jwt: the spec built its Authorization header at runtime from a
  // freshly signed token. Mint the equivalent one now, so the claim set (and
  // any relative exp/nbf/iat) is what upstream sent.
  if (req.jwt) {
    headers.Authorization = `Bearer ${mintJwt(req.jwt, opts.nowSeconds)}`;
  }
  const multiValueHeaders = {};
  for (const [k, v] of Object.entries(headers)) {
    multiValueHeaders[k] = Array.isArray(v) ? v : [String(v)];
  }

  // request.bodyFormat (CONTRACTS.md § 1) decides the wire bytes: 'json' means
  // serialize the value (a JSON string body must keep its quotes), 'text' means
  // send it as-is. Cases without the field fall back to the old guess.
  let body = null;
  if (req.body != null) {
    if (req.bodyFormat === 'json') body = JSON.stringify(req.body);
    else if (req.bodyFormat === 'text') body = String(req.body);
    else body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
  }

  const authorizer = authorizerContext(headers, opts.role || 'anon');

  return {
    resource: '/{proxy+}',
    path,
    httpMethod: method,
    headers,
    multiValueHeaders,
    queryStringParameters: single,
    multiValueQueryStringParameters: multi,
    pathParameters: { proxy: path.replace(/^\/rest\/v1\/?/, '') },
    stageVariables: null,
    body,
    isBase64Encoded: false,
    requestContext: {
      resourceId: 'conformance',
      resourcePath: '/{proxy+}',
      httpMethod: method,
      path: `/prod${path}`,
      stage: 'prod',
      requestId: `conformance-${testCase.id}`,
      requestTimeEpoch: Date.now(),
      protocol: 'HTTP/1.1',
      identity: { sourceIp: '127.0.0.1', userAgent: 'conformance-runner' },
      authorizer,
    },
  };
}

// ---------------------------------------------------------------- comparison

export function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    return a.every((x, i) => deepEqual(x, b[i]));
  }
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every(k => k in b && deepEqual(a[k], b[k]));
}

// bodyMatch: "set" — deep equal ignoring array order, at every level.
export function deepEqualUnordered(a, b) {
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    const remaining = b.slice();
    for (const x of a) {
      const idx = remaining.findIndex(y => deepEqualUnordered(x, y));
      if (idx === -1) return false;
      remaining.splice(idx, 1);
    }
    return true;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every(k => k in b && deepEqualUnordered(a[k], b[k]));
  }
  return deepEqual(a, b);
}

// Header values are compared as strings. Two normalizations only:
// whitespace after ';' is collapsed, and a bare `charset=utf-8` parameter on
// Content-Type is dropped — the engine emits `application/json` where upstream
// asserts `application/json; charset=utf-8`, which is not a conformance gap.
export function normalizeHeaderValue(name, value) {
  if (value == null) return null;
  let v = String(value).trim().replace(/\s*;\s*/g, '; ');
  if (name.toLowerCase() === 'content-type') {
    v = v.toLowerCase().replace(/;\s*charset=utf-?8/g, '');
  }
  return v;
}

function firstDifferences(expected, actual, path = '$', out = [], limit = 5) {
  if (out.length >= limit) return out;
  const te = kind(expected), ta = kind(actual);
  if (te !== ta) {
    out.push(`${path}: expected ${te} ${short(expected)}, `
      + `actual ${ta} ${short(actual)}`);
    return out;
  }
  if (te === 'array') {
    if (expected.length !== actual.length) {
      out.push(`${path}: expected ${expected.length} element(s), `
        + `actual ${actual.length}`);
    }
    for (let i = 0; i < Math.max(expected.length, actual.length); i++) {
      if (out.length >= limit) break;
      if (i >= expected.length || i >= actual.length) break;
      if (!deepEqual(expected[i], actual[i])) {
        firstDifferences(expected[i], actual[i], `${path}[${i}]`, out, limit);
      }
    }
    return out;
  }
  if (te === 'object') {
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    for (const k of keys) {
      if (out.length >= limit) break;
      if (!(k in actual)) {
        out.push(`${path}.${k}: missing from actual `
          + `(expected ${short(expected[k])})`);
      } else if (!(k in expected)) {
        out.push(`${path}.${k}: unexpected in actual `
          + `(${short(actual[k])})`);
      } else if (!deepEqual(expected[k], actual[k])) {
        firstDifferences(expected[k], actual[k], `${path}.${k}`, out, limit);
      }
    }
    return out;
  }
  if (expected !== actual) {
    out.push(`${path}: expected ${short(expected)}, actual ${short(actual)}`);
  }
  return out;
}

// True when the only thing wrong with the body is that numbers arrived as JSON
// strings. node-postgres hands int8/numeric back as text, so a `bigint` column
// serializes as `"1"` where every PostgREST assertion (and supabase-js) expects
// `1`. One engine-side type-parser fix covers all of them, so they get their own
// slug instead of being scattered across body-mismatch-<category>.
function equalModuloNumericStrings(expected, actual) {
  if (typeof expected === 'number' && typeof actual === 'string') {
    return /^-?\d+(\.\d+)?$/.test(actual.trim())
      && Number(actual) === expected;
  }
  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!Array.isArray(expected) || !Array.isArray(actual)) return false;
    if (expected.length !== actual.length) return false;
    return expected.every((v, i) => equalModuloNumericStrings(v, actual[i]));
  }
  if (expected && actual && typeof expected === 'object'
      && typeof actual === 'object') {
    const ke = Object.keys(expected), ka = Object.keys(actual);
    if (ke.length !== ka.length) return false;
    return ke.every(k => k in actual
      && equalModuloNumericStrings(expected[k], actual[k]));
  }
  return deepEqual(expected, actual);
}

function kind(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function short(v, max = 160) {
  let s;
  try {
    s = typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v);
  } catch {
    s = String(v);
  }
  if (s === undefined) s = String(v);
  return s.length > max ? s.slice(0, max) + '…' : s;
}

// The response body the handler produced, parsed if it is JSON.
export function parseActualBody(bodyText) {
  if (bodyText == null || bodyText === '') {
    return { json: null, empty: true, parsed: true };
  }
  try {
    return { json: JSON.parse(bodyText), empty: false, parsed: true };
  } catch {
    return { json: undefined, empty: false, parsed: false };
  }
}

// The expected body from the case. `expected.bodyFormat` (CONTRACTS.md § 1)
// says how to read it: 'json' means expected.body IS the JSON value (a scalar
// body like `"Hello, world"`, `123` or `null` included), 'text' means compare
// the raw bytes, 'none' means the body must be empty. Cases written before the
// field existed fall back to the old guess.
function normalizeExpectedBody(expected, bodyFormat) {
  if (bodyFormat === 'ignore') return { mode: 'ignore' };
  if (bodyFormat === 'none') return { mode: 'empty' };
  if (bodyFormat === 'json') return { mode: 'json', json: expected ?? null };
  if (bodyFormat === 'text') {
    return expected == null || expected === ''
      ? { mode: 'empty' }
      : { mode: 'text', text: String(expected) };
  }
  return legacyExpectedBody(expected);
}

function legacyExpectedBody(expected) {
  if (expected === undefined) return { mode: 'ignore' };
  if (expected === null) return { mode: 'empty' };
  if (typeof expected === 'string') {
    const t = expected.trim();
    if (t === '') return { mode: 'empty' };
    if (/^[[{"]|^-?\d|^true$|^false$|^null$/.test(t)) {
      try {
        return { mode: 'json', json: JSON.parse(t) };
      } catch { /* fall through to text */ }
    }
    return { mode: 'text', text: expected };
  }
  return { mode: 'json', json: expected };
}

export function compare(testCase, actual) {
  const expected = testCase.expected || {};
  const bodyMatch = testCase.bodyMatch || 'exact';
  const lines = [];

  const statusOk = expected.status == null
    || Number(expected.status) === Number(actual.statusCode);
  if (!statusOk) {
    lines.push(`status: expected ${expected.status}, `
      + `actual ${actual.statusCode}`);
  }

  const actualHeaders = {};
  for (const [k, v] of Object.entries(actual.headers || {})) {
    actualHeaders[k.toLowerCase()] = v;
  }
  const headerMismatches = [];
  for (const [name, want] of Object.entries(expected.headers || {})) {
    const got = actualHeaders[name.toLowerCase()];
    const nWant = normalizeHeaderValue(name, want);
    const nGot = normalizeHeaderValue(name, got);
    if (nWant !== nGot) {
      headerMismatches.push(name);
      lines.push(`header ${name}: expected ${JSON.stringify(String(want))}, `
        + `actual ${got === undefined ? '<absent>' : JSON.stringify(String(got))}`);
    }
  }

  // matchHeaderAbsent name — upstream asserts the header is not sent at all.
  const headersPresentUnexpectedly = [];
  for (const name of expected.headersAbsent || []) {
    const got = actualHeaders[name.toLowerCase()];
    if (got !== undefined) {
      headersPresentUnexpectedly.push(name);
      lines.push(`header ${name}: expected absent, `
        + `actual ${JSON.stringify(String(got))}`);
    }
  }

  // matchHeaderValuePresent name value — substring, not equality.
  for (const { name, value } of expected.headersContain || []) {
    const got = actualHeaders[name.toLowerCase()];
    if (got === undefined || !String(got).includes(value)) {
      headerMismatches.push(name);
      lines.push(`header ${name}: expected to contain ${JSON.stringify(value)}, `
        + `actual ${got === undefined ? '<absent>' : JSON.stringify(String(got))}`);
    }
  }

  // matchServerTimingHasTiming metric and friends — a regex on the value.
  for (const { name, pattern } of expected.headersMatch || []) {
    const got = actualHeaders[name.toLowerCase()];
    let re;
    try { re = new RegExp(pattern); } catch { re = null; }
    if (got === undefined || !re || !re.test(String(got))) {
      headerMismatches.push(name);
      lines.push(`header ${name}: expected to match /${pattern}/, `
        + `actual ${got === undefined ? '<absent>' : JSON.stringify(String(got))}`);
    }
  }

  let bodyOk = true;
  // Set when an `exact` body differs from the expected one only in array order.
  // Still a failure — DSQL does not promise the physical row order upstream
  // relies on — but the report should name that cause instead of guessing.
  let orderOnly = false;
  // Set when a byte-exact (`[str|...|]`) body differs only in serialization —
  // the same JSON value, different bytes. Still a failure, but the cause is our
  // serializer, not the feature under test.
  let bytesOnly = false;
  // Set when the body is right except that numbers came back as JSON strings.
  let numericAsString = false;
  if (bodyMatch !== 'ignore') {
    const exp = normalizeExpectedBody(expected.body, expected.bodyFormat);
    const act = parseActualBody(actual.body);
    if (exp.mode === 'ignore') {
      bodyOk = true;
    } else if (exp.mode === 'empty') {
      bodyOk = act.empty;
      if (!bodyOk) {
        lines.push(`body: expected no body, actual ${short(actual.body, 300)}`);
      }
    } else if (exp.mode === 'text') {
      bodyOk = String(actual.body ?? '') === exp.text;
      if (!bodyOk) {
        const expJson = parseActualBody(exp.text);
        bytesOnly = expJson.parsed && act.parsed
          && deepEqual(expJson.json, act.json);
        lines.push('body (text): expected '
          + `${short(exp.text, 300)}, actual ${short(actual.body, 300)}`
          + `${bytesOnly ? ' — same JSON value, different bytes' : ''}`);
      }
    } else if (!act.parsed) {
      bodyOk = false;
      lines.push('body: expected JSON, actual is not JSON — '
        + short(actual.body, 300));
    } else {
      bodyOk = bodyMatch === 'set'
        ? deepEqualUnordered(exp.json, act.json)
        : deepEqual(exp.json, act.json);
      if (!bodyOk) {
        orderOnly = bodyMatch === 'exact'
          && deepEqualUnordered(exp.json, act.json);
        numericAsString = !orderOnly
          && equalModuloNumericStrings(exp.json, act.json);
        lines.push(`body (${bodyMatch}) mismatch`
          + `${orderOnly ? ' — same rows, different order' : ''}:`);
        lines.push(`  expected: ${short(exp.json, 600)}`);
        lines.push(`  actual:   ${short(act.json, 600)}`);
        for (const d of firstDifferences(exp.json, act.json)) {
          lines.push(`  at ${d}`);
        }
      }
    }
  }

  return {
    ok: statusOk && headerMismatches.length === 0
      && headersPresentUnexpectedly.length === 0 && bodyOk,
    statusOk,
    headerMismatches,
    headersPresentUnexpectedly,
    bodyOk,
    orderOnly,
    bytesOnly,
    numericAsString,
    diff: lines.join('\n'),
  };
}

// ---------------------------------------------------------------- gap triage

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 60) || 'unknown';
}

// Map a fixture-loader drop reason (conformance/fixtures/load-report.json) to
// a gap slug. Order matters: first match wins.
const DROP_REASON_GAPS = [
  [/foreign key/i, 'no-foreign-keys'],
  [/trigger/i, 'no-triggers'],
  [/plpgsql/i, 'no-plpgsql'],
  [/create type|composite|enum/i, 'no-custom-types'],
  [/extension/i, 'no-extensions'],
  [/partition/i, 'no-partitioned-tables'],
  [/materialized/i, 'no-materialized-views'],
  [/cast/i, 'no-casts'],
  [/aggregate/i, 'no-custom-aggregates'],
  [/row security|policy/i, 'no-row-level-security'],
  [/text search|tsvector|tsquery/i, 'missing-operator-fts'],
  [/column type .*\[\] not supported/i, 'no-array-columns'],
  [/(column|return|argument) type .* not supported/i, 'no-column-type'],
  [/set role|configuration parameter "role"/i, 'no-set-role'],
  [/rule/i, 'no-rules'],
  [/procedure/i, 'no-procedures'],
  [/session guc|configuration parameter|alter database/i, 'no-custom-gucs'],
  [/domain/i, 'fixture-missing'],
];

export function gapForDropReason(reason) {
  for (const [re, gap] of DROP_REASON_GAPS) {
    if (re.test(reason || '')) return gap;
  }
  return 'fixture-missing';
}

function loadDropIndex() {
  const index = new Map(); // bare or qualified object name -> drop entry
  if (!existsSync(LOAD_REPORT)) return index;
  let report;
  try {
    report = JSON.parse(readFileSync(LOAD_REPORT, 'utf8'));
  } catch {
    return index;
  }
  for (const d of report.dropped || []) {
    const name = String(d.object || '');
    if (!name || /\s/.test(name)) continue; // free-text "statement" entries
    if (!index.has(name)) index.set(name, d);
    const parts = name.split('.');
    const bare = parts[parts.length - 1];
    if (bare && !index.has(bare)) index.set(bare, d);
    // Column drops are recorded as schema.table.column; index table.column too,
    // so a PGRST204 on a column DSQL could not create can be attributed.
    if (parts.length >= 3) {
      const tail = parts.slice(-2).join('.');
      if (!index.has(tail)) index.set(tail, d);
    }
  }
  return index;
}

// What object does this case address? First path segment, or the rpc name.
export function caseTarget(testCase) {
  const raw = (testCase.request?.path || '').replace(/^\/rest\/v1/, '');
  const clean = raw.split('?')[0].replace(/^\/+/, '');
  const rpc = /^rpc\/([^/?]+)$/.exec(clean);
  if (rpc) return { kind: 'function', name: safeDecode(rpc[1]) };
  const seg = clean.split('/')[0];
  if (!seg || seg.startsWith('_')) return { kind: 'none', name: null };
  return { kind: 'relation', name: safeDecode(seg) };
}

// Errors the handler logs (sanitized responses hide the pg message, the log
// line keeps it) mapped to a root cause.
const LOG_GAPS = [
  [/configuration parameter "role"|set role/i, 'no-set-role'],
  [/configuration parameter "(request|response)\./i, 'no-custom-gucs'],
  [/plpgsql/i, 'no-plpgsql'],
  [/text search configuration/i, 'missing-operator-fts'],
  [/tsvector|tsquery|to_tsquery/i, 'missing-operator-fts'],
  [/does not exist.*function|function .* does not exist/i, 'fixture-missing'],
  // Log text only: the engine's own PGRST501 wording contains "not supported"
  // too ("Filter nesting deeper than one level is not supported"), and that is
  // our limitation, not the database's.
  [/not supported/i, 'dsql-unsupported', 'log-only'],
];

// The engine's own error messages, mapped to the feature behind them. Applied
// only when the engine answered with an error the case did not expect, so a
// case that asserts an error and merely gets different wording stays a body
// mismatch. Every regex here was read off a measured response body.
const ENGINE_MESSAGE_GAPS = [
  [/Filter nesting deeper than one level/i,
    () => 'unimplemented-nested-embed-filters'],
  [/"([^"]+)" is not a valid filter operator/, (m) => {
    const raw = m[1];
    // `id=eq(any).{3,4}` — the operator exists, the quantifier does not.
    if (/\((any|all)\)$/.test(raw)) return 'missing-quantified-operator-any-all';
    // Anything else with a paren is the logical-tree parser tripping over a
    // nested `and`/`or`/`not.or` group, not a missing operator.
    if (raw.includes('(')) return 'parser-logical-tree';
    return `missing-operator-${slug(raw)}`;
  }],
  [/is not a valid value for is operator/, () => 'missing-is-operator-values'],
  [/Unbalanced parentheses/i, () => 'parser-logical-tree'],
  [/Column '([^']*)' does not exist/, (m, ctx) => {
    const col = m[1];
    if (col.includes('->')) return 'unimplemented-json-path';
    if (col !== col.trim()) return 'parser-logical-tree-whitespace';
    if (isAggregateRef(col)) return 'unimplemented-feature-aggregates';
    // A computed column: upstream declares `f(table_row)` and PostgREST lets
    // you select and filter on it as if it were a column.
    if (ctx?.catalog?.functions?.has(col)) {
      return 'unimplemented-computed-columns';
    }
    // `?select=name,table_a(name)&table_a=not.is.null` — a filter that applies
    // to the embedded resource, not to a column of this table.
    const sel = ctx?.select || '';
    if (sel.includes(`${col}(`) || sel.includes(`${col}!`)) {
      return 'unimplemented-embedded-filters';
    }
    return 'column-unknown-to-engine';
  }],
  [/Empty select list in embed '([^']*)'/,
    (m) => (isAggregateRef(m[1])
      ? 'unimplemented-feature-aggregates'
      : 'unimplemented-empty-embed')],
  [/Cannot filter on '[^']*' -- no embed named/,
    () => 'unimplemented-embedded-filters'],
  [/Method ([A-Z]+) not allowed/, (m) => `unimplemented-method-${slug(m[1])}`],
  [/Could not choose the best candidate function/,
    () => 'rpc-overload-resolution'],
  [/requires argument '[^']*' which was not provided/,
    () => 'rpc-argument-handling'],
  [/does not have an argument named/, () => 'rpc-argument-handling'],
  [/requires filters to prevent bulk change/,
    () => 'bulk-mutation-guard-always-on'],
];

function isAggregateRef(name) {
  return /(^|\.)(count|sum|avg|min|max)$/.test(name);
}

function engineMessageGap(message, ctx) {
  for (const [re, toGap] of ENGINE_MESSAGE_GAPS) {
    const m = re.exec(message || '');
    if (m) return toGap(m, ctx);
  }
  return null;
}

// Gaps that are not gaps: the assertion tests a PostgREST mechanism this
// architecture cannot have, on any database.
//
//   no-custom-gucs — response headers and request claims driven by namespaced
//     run-time parameters (`response.headers`, `request.jwt.claims`). DSQL
//     rejects every dotted parameter, measured both as SET and set_config
//     (DSQL-CAPABILITIES.md), so a SQL function can never set a response header
//     here — there is nothing to implement.
//   no-row-level-security — the assertion is about rows an RLS policy filters.
//     DSQL rejects ENABLE ROW SECURITY and CreatePolicy, so the fixture itself
//     cannot exist.
//
// `no-set-role` is deliberately NOT here. Those cases fail because the engine's
// own authorization layer does not carry the privileges upstream expresses as
// GRANTs — that is a substitute we can build (CLAUDE.md rule 8), so they stay
// failures.
//
// Out-of-scope cases are excluded from the pass-rate denominator and are not
// counted as failures.
const OUT_OF_SCOPE_GAPS = new Set([
  'no-row-level-security', 'no-custom-gucs',
]);

// Two branches book a case under `row-order-unspecified`: the early guard that
// stops an incidental log line from outranking an order-only difference, and the
// body-comparison branch that reaches the same conclusion the long way round.
// One string for both — a reader comparing two runs should not have to work out
// whether two different wordings mean the same gap.
const ORDER_ONLY_REASON = 'the same rows came back in a different order; DSQL '
  + 'does not guarantee the physical order this assertion depends on';

export function triage(args) {
  const t = triageInner(args);
  if ((t.status === 'fail' || t.status === 'blocked')
      && OUT_OF_SCOPE_GAPS.has(t.gap)) {
    return { ...t, status: 'out-of-scope' };
  }
  return t;
}

function triageInner({ testCase, actual, comparison, thrown, logs, ctx }) {
  const category = testCase.category || 'uncategorized';

  if (thrown) {
    return {
      status: 'error',
      gap: thrown.timedOut ? 'harness-timeout' : 'harness-error',
      reason: `harness ${thrown.timedOut ? 'timeout' : 'exception'}: `
        + `${thrown.message}`,
    };
  }

  if (testCase.skip) {
    // Two distinct kinds of not-run. `needs-engine-config` means the assertion
    // is representable but only holds under a PostgREST process configuration
    // the engine has no switch for — a missing engine feature, not a harness
    // limitation. `not-representable` is the harness limitation.
    if (testCase.skipClass === 'needs-engine-config') {
      return {
        status: 'needs-config',
        gap: 'needs-engine-config',
        reason: testCase.skipReason || 'requires non-default PostgREST config',
      };
    }
    return {
      status: 'skip',
      // One slug for every extraction skip: the reason text stays in `reason`,
      // so the report can list them without exploding the gap histogram.
      gap: 'extraction-skipped',
      reason: testCase.skipReason || 'marked skip at extraction',
    };
  }

  if (comparison.ok) return { status: 'pass', gap: null, reason: null };

  const body = actual.json && typeof actual.json === 'object' ? actual.json : {};
  const code = typeof body.code === 'string' ? body.code : null;
  const message = typeof body.message === 'string' ? body.message : '';
  const logText = logs.join('\n');
  const target = caseTarget(testCase);
  const diff = comparison.diff;
  const reason = (extra) => [extra, diff].filter(Boolean).join('\n');
  // What ENGINE_MESSAGE_GAPS needs to tell apart a computed column, an embedded
  // filter and a column that genuinely is not there.
  const msgCtx = {
    catalog: ctx.catalog,
    select: String(testCase.request?.query || ''),
  };
  // Upstream has negative tests that address a relation which is *meant* not to
  // exist (`/faketable`, `/fakefake`). "The fixture is missing" is never the
  // root cause for those — the engine answered, its wording differs.
  const expectsError = Number(testCase.expected?.status) >= 400;

  // 1. The object under test could not be created on this database. The drop
  // list is evidence, so it applies even when the case expects an error status
  // (upstream has plpgsql functions whose whole point is to raise): if the
  // fixture is not there, the assertion is not measurable.
  if (target.name) {
    const drop = ctx.dropIndex.get(target.name)
      || ctx.dropIndex.get(`test.${target.name}`)
      || ctx.dropIndex.get(`public.${target.name}`);
    const exists = target.kind === 'function'
      ? ctx.catalog.functions.has(target.name)
      : ctx.catalog.relations.has(target.name);
    if (drop && !exists) {
      return {
        status: 'blocked',
        gap: gapForDropReason(drop.reason),
        reason: reason(`${drop.kind} ${drop.object} was dropped at fixture `
          + `load: ${drop.reason}`),
      };
    }
  }

  // 2. The engine could not find the relation/function.
  const notFound = code === 'PGRST205' || code === 'PGRST202'
    || code === '42P01' || actual.statusCode === 404;
  if (notFound && target.name) {
    const inPublic = target.kind === 'function'
      ? ctx.catalog.functionsInPublic.has(target.name)
      : ctx.catalog.relationsInPublic.has(target.name);
    const anywhere = target.kind === 'function'
      ? ctx.catalog.functions.has(target.name)
      : ctx.catalog.relations.has(target.name);
    // The relation is there, as a view. src/rest/schema-cache.mjs introspects
    // `relkind IN ('r','p')`, so views are not in the schema cache at all and
    // every request against one 404s.
    if (target.kind === 'relation'
      && ctx.catalog.viewsInPublic?.has(target.name)) {
      return {
        status: 'fail',
        gap: 'engine-tables-only-no-views',
        reason: reason(`"${target.name}" is a view in public; the engine's `
          + "schema cache only reads relkind 'r'/'p'"),
      };
    }
    if (!inPublic && anywhere) {
      const schemas = (target.kind === 'function'
        ? ctx.catalog.functions.get(target.name)
        : ctx.catalog.relations.get(target.name)) || [];
      return {
        status: 'fail',
        gap: 'engine-public-schema-only',
        reason: reason(`${target.kind} "${target.name}" exists in schema(s) `
          + `${schemas.join(', ')}; the engine introspects public only`),
      };
    }
    if (!anywhere && !expectsError) {
      return {
        status: 'blocked',
        gap: 'fixture-missing',
        reason: reason(`${target.kind} "${target.name}" is not in the `
          + 'database at all'),
      };
    }
  }

  // 2b. A column the case filters on or selects could not be created. The
  // engine's PGRST204 is correct; the fixture cannot carry the column.
  // Two spellings are matched on purpose. The engine now emits upstream's
  // wording (Error.hs:254, "Could not find the '<col>' column of '<rel>' in
  // the schema cache"); the older pgrest-lambda text is kept so a result file
  // produced before that change still classifies the same way.
  //
  // PostgreSQL's own 42703 counts as the same evidence. Upstream does not check
  // a filter column against the schema cache — it emits the column and lets the
  // database raise, which is why `?arr=cs.{1,2}` on a table with no `arr` comes
  // back as 42703 rather than PGRST204. Whether the engine or the database
  // noticed is an artifact of which column the case names; the drop list is what
  // decides whether the assertion was measurable. Without this the same missing
  // column was booked `blocked` in a `select=` and `fail` in an `or=(…)`
  // (measured: 39 cases, all of them AndOrParamsSpec and QuerySpec reads of
  // `entities.arr`, `ranges.range`, `complex_items.arr_data` and
  // `entities.text_search_vector`).
  const colMatch =
    /Could not find the '([^'.]+)' column of '([^']+)' in the schema cache/
      .exec(message)
    || /Column '([^'.]+)' does not exist in '([^']+)'/.exec(message);
  const pgColMatch = code === '42703'
    ? (/column ([A-Za-z0-9_]+)\.([A-Za-z0-9_]+) does not exist/.exec(message)
      || /column "?([A-Za-z0-9_]+)"? does not exist/.exec(message))
    : null;
  let colDrop = null;
  if (colMatch) {
    const [, col, rel] = colMatch;
    colDrop = ctx.dropIndex.get(`public.${rel}.${col}`)
      || ctx.dropIndex.get(`${rel}.${col}`);
  } else if (pgColMatch) {
    // `column <rel>.<col>` when qualified, `column "<col>"` when not — an
    // unqualified one belongs to the relation under test.
    const [, a, b] = pgColMatch;
    const rel = b === undefined ? target.name : a;
    const col = b === undefined ? a : b;
    if (rel && col) {
      colDrop = ctx.dropIndex.get(`public.${rel}.${col}`)
        || ctx.dropIndex.get(`${rel}.${col}`);
    }
  }
  if (colDrop && colDrop.kind === 'column') {
    return {
      status: 'blocked',
      gap: gapForDropReason(colDrop.reason),
      reason: reason(`column ${colDrop.object} was dropped at fixture load: `
        + colDrop.reason),
    };
  }

  // 3. The engine said the capability is missing.
  if (code === 'PGRST501') {
    const op = /operator '([^']+)'/.exec(message)
      || /'([a-z_]+)' requires/.exec(message);
    if (op) return { status: 'fail', gap: `missing-operator-${slug(op[1])}`,
      reason: reason(message) };
    const feat = /requires ([a-z0-9 -]+) support/i.exec(message);
    return {
      status: 'fail',
      gap: feat ? `unimplemented-feature-${slug(feat[1])}`
        : `unimplemented-feature-${slug(category)}`,
      reason: reason(message),
    };
  }

  // 4. Embedding without foreign keys in the catalog.
  if (code === 'PGRST200' || code === 'PGRST201') {
    return { status: 'fail', gap: 'no-foreign-keys', reason: reason(message) };
  }

  // `harness-supplies-unverified-identity` was booked here, for the case that
  // asserts an invalid token is rejected as a token (PGRST301) and instead got an
  // authorization denial (PGRST403). The cause was the harness: it stood in for
  // the API Gateway authorizer and built the authorizer context by decoding the
  // JWT payload without verifying it, so an empty, truncated or badly signed
  // token still arrived carrying a role and was denied by policy rather than
  // rejected outright. Seven cases sat in it: AuthSpec:96, :119, ErrorSpec:53,
  // :110, :193, :205, :217.
  //
  // The base engine now verifies the token itself with upstream's own secret
  // (baseEngineConfig `restJwt`), which is what upstream's `baseCfg` configures
  // for every spec, so the harness no longer supplies an identity it did not
  // check and the bucket has nothing left to catch. A case of this shape now
  // falls through to the ordinary buckets and is attributed to the engine.

  // An order-only difference means the engine returned the right rows with the
  // right status, so nothing the database complained about in the log explains
  // this failure — the log line is incidental. Decide the gap on the observed
  // outcome before consulting LOG_GAPS, or a case that merely logged
  // "text search configuration" is booked under missing-operator-fts while its
  // real and only defect is ordering (measured: RpcSpec:985, RpcSpec:997, which
  // inflated the fts gap and understated order sensitivity at the same time).
  // The status stays `fail` either way; only the attribution changes.
  if (comparison.statusOk && comparison.orderOnly) {
    return {
      status: 'fail',
      gap: 'row-order-unspecified',
      reason: reason(ORDER_ONLY_REASON),
    };
  }

  // 5. Whatever the database actually complained about.
  for (const [re, gap, scope] of LOG_GAPS) {
    if (re.test(logText) || (scope !== 'log-only' && re.test(message))) {
      return { status: 'fail', gap, reason: reason(firstLine(logText) || message) };
    }
  }

  // 6. PostgREST's auth model is Postgres roles; ours cannot be.
  const authShaped = [401, 403].includes(Number(testCase.expected?.status));
  // There used to be a `harness-no-jwt-verification` bucket here: the runner
  // handed the engine an identity decoded from the token without checking the
  // signature, so an assertion about token *validation* was unmeasurable. The
  // base engine now runs with `jwt-secret` (baseEngineConfig `restJwt`) and
  // verifies the token itself, exactly as upstream's `baseCfg` does, so a case
  // that asserts a rejected token is measured and any failure is the engine's.
  //
  // A denial from the engine's own authorization layer, or an assertion about a
  // privilege upstream grants to a Postgres role.
  const deniedInEngine = /not authorized/i.test(message)
    || [401, 403].includes(Number(actual.statusCode));
  if (!comparison.statusOk && (deniedInEngine || authShaped)) {
    return { status: 'fail', gap: 'no-set-role', reason: reason(message) };
  }

  // 7. Generic buckets, most specific first.
  if (actual.statusCode >= 500) {
    return {
      status: 'fail',
      gap: 'engine-error',
      reason: reason(firstLine(logText) || message),
    };
  }
  const expectedStatus = Number(testCase.expected?.status);
  if (!comparison.statusOk) {
    if (expectedStatus < 400 && actual.statusCode >= 400) {
      // The engine refused the request. Its message usually names the exact
      // feature; fall back to the category when it does not.
      const named = engineMessageGap(message, msgCtx);
      return {
        status: 'fail',
        gap: named || `unimplemented-feature-${slug(category)}`,
        reason: reason(code ? `${code}: ${message}` : null),
      };
    }
    // 206 Partial Content for a limited/ranged read is a status the engine
    // never emits; that is one gap, not a per-category mismatch.
    if (expectedStatus === 206 && Number(actual.statusCode) === 200) {
      return {
        status: 'fail',
        gap: 'missing-status-206-partial-content',
        reason: reason(null),
      };
    }
    if (expectedStatus >= 400 && actual.statusCode < 400) {
      return {
        status: 'fail',
        gap: `missing-validation-${slug(category)}`,
        reason: reason(null),
      };
    }
    // Both sides are errors, or both are successes, with different codes. The
    // engine's message still names the feature when it has one (PGRST203
    // overload resolution answers 300, so it never reaches the branch above).
    return {
      status: 'fail',
      gap: engineMessageGap(message, msgCtx)
        || `status-mismatch-${slug(category)}`,
      reason: reason(code ? `${code}: ${message}` : null),
    };
  }
  // Content-Length is derived from the body: when the body is also wrong the
  // byte count is a symptom, not the cause, so do not book the case under a
  // header gap.
  const onlyLengthHeader = comparison.headerMismatches.length > 0
    && comparison.headerMismatches
      .every((h) => h.toLowerCase() === 'content-length');
  if (comparison.headerMismatches.length
      && !(onlyLengthHeader && !comparison.bodyOk)) {
    return {
      status: 'fail',
      gap: `header-mismatch-${slug(comparison.headerMismatches[0])}`,
      reason: reason(null),
    };
  }
  // matchHeaderAbsent: the engine sent a header upstream asserts is not there.
  const unexpected = comparison.headersPresentUnexpectedly || [];
  if (unexpected.length) {
    return {
      status: 'fail',
      gap: `header-sent-unexpectedly-${slug(unexpected[0])}`,
      reason: reason(null),
    };
  }
  if (comparison.bytesOnly) {
    return {
      status: 'fail',
      gap: 'body-serialization-bytes',
      reason: reason('the response carries the same JSON value as the '
        + 'assertion but not the same bytes'),
    };
  }
  if (comparison.numericAsString) {
    return {
      status: 'fail',
      gap: 'bigint-serialized-as-string',
      reason: reason('the rows are correct but numeric columns came back as '
        + 'JSON strings (node-postgres returns int8/numeric as text)'),
    };
  }
  if (comparison.orderOnly) {
    return {
      status: 'fail',
      gap: 'row-order-unspecified',
      reason: reason(ORDER_ONLY_REASON),
    };
  }
  return {
    status: 'fail',
    gap: `body-mismatch-${slug(category)}`,
    reason: reason(null),
  };
}

function firstLine(text) {
  if (!text) return '';
  const line = text.split('\n').find(Boolean) || '';
  try {
    const o = JSON.parse(line);
    return o.message ? `${o.pgCode || o.level || 'log'}: ${o.message}` : line;
  } catch {
    return line.slice(0, 400);
  }
}

// ---------------------------------------------------------------- log capture

const logStore = new AsyncLocalStorage();

function installLogCapture() {
  const real = {
    log: console.log, info: console.info,
    warn: console.warn, error: console.error, debug: console.debug,
  };
  const sink = (level) => (...args) => {
    const bucket = logStore.getStore();
    const text = args.map(a =>
      typeof a === 'string' ? a : safeStringify(a)).join(' ');
    if (bucket) bucket.push(text);
    else if (process.env.CONFORMANCE_DEBUG) real[level](...args);
  };
  console.log = sink('log');
  console.info = sink('info');
  console.warn = sink('warn');
  console.error = sink('error');
  console.debug = sink('debug');
  return () => Object.assign(console, real);
}

function safeStringify(v) {
  try { return JSON.stringify(v); } catch { return String(v); }
}

// ---------------------------------------------------------------- database

export function resolveTargetConfig(target) {
  if (target === 'dsql') {
    return {
      provider: 'dsql',
      dsqlEndpoint: process.env.DSQL_ENDPOINT || DEFAULT_DSQL_ENDPOINT,
      // REGION_NAME, never AWS_REGION (reserved by the Lambda runtime).
      region: process.env.REGION_NAME || DEFAULT_REGION,
    };
  }
  if (target === 'postgres') {
    return {
      provider: 'postgres',
      connectionString: process.env.DATABASE_URL || null,
      host: process.env.PG_HOST,
      port: process.env.PG_PORT ? parseInt(process.env.PG_PORT, 10) : undefined,
      user: process.env.PG_USER,
      password: process.env.PG_PASSWORD,
      database: process.env.PG_DATABASE,
      ssl: process.env.PG_SSL === 'true',
    };
  }
  throw new Error(`unknown --target ${target} (use dsql or postgres)`);
}

// One catalog read, used by triage to tell "dropped at load" from "wrong
// schema" from "never existed". Static SQL, no interpolation.
const REL_SQL = `
  SELECT n.nspname AS schema, c.relname AS name, c.relkind::text AS relkind
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE c.relkind IN ('r','v','m','p','f')
     AND n.nspname NOT IN ('pg_catalog','information_schema')`;

const FN_SQL = `
  SELECT n.nspname AS schema, p.proname AS name
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname NOT IN ('pg_catalog','information_schema')`;

// Function bodies, for --reset-touched: `POST /rpc/f` writes whatever `f`
// writes, and the case format does not say which tables those are. Every
// function that survived the fixture load is SQL-bodied (DSQL has no plpgsql),
// so its prosrc is the statement list and the write targets can be read off it.
const FN_SRC_SQL = `
  SELECT n.nspname AS schema, p.proname AS name, p.prosrc AS src
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname NOT IN ('pg_catalog','information_schema')`;

// `insert into x`, `update x.y`, `delete from x` — quoted or bare, one or two
// parts. Matches the identifier characters sqlsplit's WORD_RE accepts, so a
// unicode table name is found too.
const WRITE_TARGET_RE =
  /\b(?:insert\s+into|update|delete\s+from)\s+((?:"(?:[^"]|"")+"|[A-Za-z_-￿][A-Za-z0-9_$-￿]*)(?:\s*\.\s*(?:"(?:[^"]|"")+"|[A-Za-z_-￿][A-Za-z0-9_$-￿]*))?)/gi;

function unquoteIdent(raw) {
  const s = String(raw).trim();
  return s.startsWith('"')
    ? s.slice(1, -1).replace(/""/g, '"')
    : s.toLowerCase();
}

/** Qualified names a function body writes to, as `schema.table` keys. */
export function functionWriteTargets(src, defaultSchema = 'public') {
  const out = new Set();
  if (!src) return out;
  WRITE_TARGET_RE.lastIndex = 0;
  let m;
  while ((m = WRITE_TARGET_RE.exec(src)) !== null) {
    const parts = m[1].split('.');
    if (parts.length === 2) {
      out.add(`${unquoteIdent(parts[0])}.${unquoteIdent(parts[1])}`);
    } else {
      out.add(`${defaultSchema}.${unquoteIdent(parts[0])}`);
    }
  }
  return out;
}

async function readCatalog(pool) {
  const relations = new Map();
  const functions = new Map();
  const add = (map, row) => {
    const list = map.get(row.name) || [];
    if (!list.includes(row.schema)) list.push(row.schema);
    map.set(row.name, list);
  };
  const viewsInPublic = new Set();
  const tablesInPublic = new Set();
  // Every real table, `schema.table`, in every schema: the fixture-reset sweep
  // needs to know a key exists before it deletes from it, and the tables it
  // clears are not all in public (private.junction, تست.موارد).
  const tables = new Set();
  const rels = await pool.query(REL_SQL);
  for (const row of rels.rows) {
    add(relations, row);
    if (row.relkind === 'r' || row.relkind === 'p') {
      tables.add(`${row.schema}.${row.name}`);
    }
    if (row.schema !== 'public') continue;
    if (row.relkind === 'v' || row.relkind === 'm') viewsInPublic.add(row.name);
    else tablesInPublic.add(row.name);
  }
  const fns = await pool.query(FN_SQL);
  for (const row of fns.rows) add(functions, row);
  // One entry per function name: the union of the write targets of every
  // overload, so a name that any overload writes through is always restored.
  const srcs = await pool.query(FN_SRC_SQL);
  const directWrites = new Map();
  const calls = new Map();
  const known = new Set(srcs.rows.map(r => r.name));
  for (const row of srcs.rows) {
    const w = directWrites.get(row.name) || new Set();
    for (const t of functionWriteTargets(row.src, row.schema)) w.add(t);
    directWrites.set(row.name, w);
    // `select insert_and_return()` writes whatever the callee writes, so the
    // scan is closed over the fixture functions a body calls.
    const c = calls.get(row.name) || new Set();
    for (const m of String(row.src || '')
      .matchAll(/([A-Za-z_][A-Za-z0-9_$]*)\s*\(/g)) {
      const callee = known.has(m[1]) ? m[1]
        : (known.has(m[1].toLowerCase()) ? m[1].toLowerCase() : null);
      if (callee && callee !== row.name) c.add(callee);
    }
    calls.set(row.name, c);
  }
  const functionWrites = new Map();
  for (const name of directWrites.keys()) {
    const out = new Set();
    const seen = new Set();
    const stack = [name];
    while (stack.length) {
      const cur = stack.pop();
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const t of directWrites.get(cur) || []) out.add(t);
      for (const callee of calls.get(cur) || []) stack.push(callee);
    }
    functionWrites.set(name, out);
  }
  const inPublic = (map) => new Set(
    [...map.entries()].filter(([, s]) => s.includes('public')).map(([n]) => n));
  return {
    relations,
    functions,
    functionWrites,
    tables,
    tablesInPublic,
    relationsInPublic: inPublic(relations),
    functionsInPublic: inPublic(functions),
    // A name that is only a view in public: the engine's schema cache reads
    // relkind 'r'/'p' only, so those relations are invisible to it.
    viewsInPublic: new Set(
      [...viewsInPublic].filter(n => !tablesInPublic.has(n))),
  };
}

// ------------------------------------------------ per-case engine config
//
// Upstream boots more than one PostgREST process. Most specs run under
// `baseCfg` (test/spec/SpecHelper.hs), but 20-odd describe blocks run under
// `withConfig`/`withConfigDbs` with specific fields changed
// (test/spec/Main.hs). The extractor records which fields a case needs in its
// `skipReason` — "requires non-default PostgREST config (configDbSchemas)" —
// and marks it `needs-engine-config`.
//
// The table below translates each of those blocks into this engine's
// configuration surface (docs/configuration.md). A case whose required fields
// are all covered by a matching entry is run against a second engine instance
// built with that configuration, so it becomes a pass or an honest fail. A case
// whose fields are not covered (configDbPreparedStatements,
// configServerTraceHeader, configOpenApiMode, configDbRootSpec,
// configUrlUseLegacyTargetNames, configClientErrorVerbosity, configDbPreConfig,
// configJwtCacheMaxEntries, configServerTimingEnabled) keeps its needs-config
// status: the engine has no equivalent switch, and inventing one that only the
// runner sets would be measuring the runner.
//
// `provides` lists the config field names the entry answers for. `from`/`to`
// bound it to the upstream source lines of that describe block, because a spec
// file can boot several configurations (CorsSpec, ErrorSpec, PgSafeUpdateSpec).
// `substitute` records where the entry reproduces upstream's wire behaviour by
// another mechanism than upstream's; it is printed with the run summary so a
// pass under it is never read as "the same thing upstream does".

// SpecHelper.hs: `baseCfg` signs with "reallyreallyreallyreallyverysafe", and
// `generateSecret` is the base64 of the same bytes.
export const SPEC_JWT_SECRET = 'reallyreallyreallyreallyverysafe';

// Feature/Auth/AsymmetricJwtSpec.hs: the RS256 public key, as a JWK and as a
// JWK Set. Verbatim from the spec file.
const SPEC_JWK = '{"alg":"RS256","e":"AQAB","key_ops":["verify"],"kty":"RSA",'
  + '"n":"0etQ2Tg187jb04MWfpuogYGV75IFrQQBxQaGH75eq_FpbkyoLcEpRUEWSbECP2eeFya'
  + '2yZ9vIO5ScD-lPmovePk4Aa4SzZ8jdjhmAbNykleRPCxMg0481kz6PQhnHRUv3nF5WP479Cn'
  + 'ObJKqTVdEagVL66oxnX9VhZG9IZA7k0Th5PfKQwrKGyUeTGczpOjaPqbxlunP73j9AfnAt4X'
  + 'CS8epa-n3WGz1j-wfpr_ys57Aq-zBCfqP67UYzNpeI1AoXsJhD9xSDOzvJgFRvc3vm2wjAW4'
  + 'LEMwi48rCplamOpZToIHEPIaPzpveYQwDnB1HFTR1ove9bpKJsHmi-e2uzQ","use":"sig"}';
const SPEC_JWKS = `{"keys": [${SPEC_JWK}]}`;

// Every JWT block below keeps `anonRole: 'anon'`, which is the runner's own
// default for a request without a token — so the only thing these entries
// change is that the engine verifies the token itself, which is what the block
// is about.
//
// `anon` stands in for upstream's `db-anon-role=postgrest_test_anonymous`, a
// database role whose privileges come from GRANTs. This engine authorizes with
// Cedar and has no such role, so those GRANTs are ported to policy in
// conformance/fixtures/policies/10-privileges.cedar. Before that port the
// default here was `service_role`, which the engine permits unconditionally —
// it made every REVOKE in upstream's fixture invisible, so the cases asserting
// that an anonymous caller is refused could not pass.
const JWT_KEYS = ['configJwtSecret', 'configJWKS', 'configJwtAudience',
  'configDbAnonRole'];

export const ENGINE_CONFIGS = [
  // test/spec/Feature/Query/MultipleSchemaSpec.hs:21
  {
    spec: 'MultipleSchemaSpec',
    label: 'db-schemas=v1,v2,SPECIAL',
    provides: ['configDbSchemas'],
    config: { dbSchemas: ['v1', 'v2', 'SPECIAL "@/\\#~_-'] },
  },
  // test/spec/Feature/Query/UnicodeSpec.hs:15
  {
    spec: 'UnicodeSpec',
    label: 'db-schemas=تست',
    provides: ['configDbSchemas'],
    config: { dbSchemas: ['تست'] },
  },
  // test/spec/Feature/ExtraSearchPathSpec.hs:14
  {
    spec: 'ExtraSearchPathSpec',
    label: 'db-extra-search-path=public,extensions,EXTRA',
    provides: ['configDbExtraSearchPath'],
    config: { dbExtraSearchPath: ['public', 'extensions', 'EXTRA "@/\\#~_-'] },
  },
  // test/spec/Feature/Query/PostGISSpec.hs:14
  {
    spec: 'PostGISSpec',
    label: 'db-extra-search-path=public,extensions',
    provides: ['configDbExtraSearchPath'],
    config: { dbExtraSearchPath: ['public', 'extensions'] },
  },
  // test/spec/Feature/Query/QueryLimitedSpec.hs:14
  {
    spec: 'QueryLimitedSpec',
    label: 'db-max-rows=2',
    provides: ['configDbMaxRows'],
    config: { dbMaxRows: 2 },
  },
  // test/spec/Feature/Query/AggregateFunctionsSpec.hs:310 (`disallowed`)
  {
    spec: 'AggregateFunctionsSpec',
    from: 309,
    label: 'db-aggregates-enabled=false',
    provides: ['db-aggregates-enabled', 'configDbAggregates'],
    config: { dbAggregatesEnabled: false },
  },
  // test/spec/Feature/Query/PlanSpec.hs:544 (`disabledSpec`) — upstream's
  // default, which is this engine's default too, so no second engine is needed.
  {
    spec: 'PlanSpec',
    from: 543,
    label: 'db-plan-enabled=false',
    provides: ['db-plan-enabled', 'configDbPlanEnabled'],
    config: { dbPlanEnabled: false },
  },
  // test/spec/Feature/RpcPreRequestGucsSpec.hs:15
  {
    spec: 'RpcPreRequestGucsSpec',
    label: 'db-pre-request=custom_headers',
    provides: ['configDbPreRequest'],
    config: { dbPreRequest: 'custom_headers' },
  },
  // test/spec/Feature/HttpHeaderSpec.hs:15
  {
    spec: 'HttpHeaderSpec',
    to: 25,
    label: 'db-pre-request=custom_vary_hdr',
    provides: ['configDbPreRequest'],
    config: { dbPreRequest: 'custom_vary_hdr' },
  },
  // test/spec/Feature/Query/PgSafeUpdateSpec.hs:15. Upstream's guard is the
  // pg-safeupdate extension, loaded by a `db-pre-request` function; DSQL has no
  // extensions and no plpgsql. The engine has its own filterless-mutation guard
  // and `safeupdate` mode makes it answer with pg-safeupdate's wire error, so
  // the assertion is measured against the same status and body.
  {
    spec: 'PgSafeUpdateSpec',
    to: 52,
    label: 'bulk-mutation-guard=safeupdate',
    provides: ['configDbPreRequest'],
    config: { bulkMutationGuard: 'safeupdate' },
    substitute: 'engine guard in safeupdate mode instead of the pg-safeupdate '
      + 'extension (no extensions on DSQL); same 400 / SQLSTATE 21000 body',
  },
  // test/spec/Feature/CorsSpec.hs:72
  {
    spec: 'CorsSpec',
    from: 72,
    to: 110,
    label: 'server-cors-allowed-origins=example.com,example2.com',
    provides: ['configServerCorsAllowedOrigins'],
    config: {
      cors: {
        allowedOrigins: ['http://example.com', 'http://example2.com'],
        allowCredentials: true,
      },
    },
  },
  // test/spec/Feature/CorsSpec.hs:111 — the empty list, i.e. the default.
  {
    spec: 'CorsSpec',
    from: 111,
    label: 'server-cors-allowed-origins=[]',
    provides: ['configServerCorsAllowedOrigins'],
    config: {},
  },
  // test/spec/Feature/Auth/AudienceJwtSecretSpec.hs:13
  {
    spec: 'AudienceJwtSecretSpec',
    to: 156,
    label: 'jwt-secret+jwt-aud=youraudience',
    provides: JWT_KEYS,
    config: {
      restJwt: {
        secret: SPEC_JWT_SECRET, audience: 'youraudience',
        anonRole: 'anon',
      },
    },
  },
  // test/spec/Feature/Query/ErrorSpec.hs:176
  {
    spec: 'ErrorSpec',
    from: 176,
    to: 188,
    label: 'jwt-aud=spec tests',
    provides: JWT_KEYS,
    config: {
      restJwt: {
        secret: SPEC_JWT_SECRET, audience: 'spec tests',
        anonRole: 'anon',
      },
    },
  },
  // test/spec/Feature/Auth/BinaryJwtSecretSpec.hs:13
  {
    spec: 'BinaryJwtSecretSpec',
    label: 'jwt-secret=binary',
    provides: JWT_KEYS,
    config: {
      restJwt: { secret: SPEC_JWT_SECRET, anonRole: 'anon' },
    },
  },
  // test/spec/Feature/Auth/AsymmetricJwtSpec.hs:23 (JWK) and :32 (JWK Set)
  {
    spec: 'AsymmetricJwtSpec',
    to: 31,
    label: 'jwt-secret=JWK',
    provides: JWT_KEYS,
    config: { restJwt: { secret: SPEC_JWK, anonRole: 'anon' } },
  },
  {
    spec: 'AsymmetricJwtSpec',
    from: 32,
    label: 'jwt-secret=JWKSet',
    provides: JWT_KEYS,
    config: { restJwt: { secret: SPEC_JWKS, anonRole: 'anon' } },
  },
  // test/spec/Feature/Auth/NoJwtSecretSpec.hs:14
  {
    spec: 'NoJwtSecretSpec',
    label: 'jwt-secret=<none>',
    provides: JWT_KEYS,
    config: {
      restJwt: { verify: true, secret: '', anonRole: 'anon' },
    },
  },
  // test/spec/Feature/Auth/NoAnonSpec.hs:14
  {
    spec: 'NoAnonSpec',
    label: 'db-anon-role=<none>',
    provides: JWT_KEYS,
    config: { restJwt: { secret: SPEC_JWT_SECRET, anonRole: '' } },
  },
  // test/spec/SpecHelper.hs:185 — upstream runs its whole suite with
  // server-timing-enabled and only this spec asserts the header, so the engine
  // keeps upstream's *documented* default (off) and the spec gets its own engine.
  {
    spec: 'ServerTimingSpec',
    label: 'server-timing-enabled=true',
    provides: ['configServerTimingEnabled'],
    config: { serverTiming: true },
  },
  // test/spec/Feature/ObservabilitySpec.hs:15
  {
    spec: 'ObservabilitySpec',
    label: 'server-trace-header=X-Request-Id',
    provides: ['configServerTraceHeader'],
    config: { serverTraceHeader: 'X-Request-Id' },
  },
  // test/spec/Feature/Auth/JwtCacheSpec.hs:54
  {
    spec: 'JwtCacheSpec',
    from: 54,
    label: 'server-timing-enabled=false,jwt-cache-max-entries=86400',
    provides: ['configServerTimingEnabled', 'configJwtCacheMaxEntries'],
    config: { serverTiming: false, jwtCacheMaxEntries: 86400 },
  },
  // test/spec/Feature/OpenApi/DisabledOpenApiSpec.hs:15
  {
    spec: 'DisabledOpenApiSpec',
    label: 'openapi-mode=disabled',
    provides: ['configOpenApiMode'],
    config: { openApiMode: 'disabled' },
  },
  // test/spec/Feature/OpenApi/IgnorePrivOpenApiSpec.hs:21
  {
    spec: 'IgnorePrivOpenApiSpec',
    label: 'openapi-mode=ignore-privileges,db-schemas=public,v1',
    provides: ['configOpenApiMode', 'configDbSchemas'],
    config: { openApiMode: 'ignore-privileges', dbSchemas: ['public', 'v1'] },
  },
  // test/spec/Feature/Query/ErrorSpec.hs:230 — the `minimal` block is the last
  // one in the file, and the jwt-aud entry above it covers lines 176-188.
  {
    spec: 'ErrorSpec',
    from: 230,
    label: 'client-error-verbosity=minimal',
    provides: ['configClientErrorVerbosity'],
    config: { clientErrorVerbosity: 'minimal' },
  },
  // test/spec/Feature/Query/PreparedStatementsSpec.hs:15 (true) and :23 (false)
  {
    spec: 'PreparedStatementsSpec',
    to: 22,
    label: 'db-prepared-statements=true',
    provides: ['configDbPreparedStatements'],
    config: { dbPreparedStatements: true },
  },
  {
    spec: 'PreparedStatementsSpec',
    from: 23,
    label: 'db-prepared-statements=false',
    provides: ['configDbPreparedStatements'],
    config: { dbPreparedStatements: false },
  },
  // test/spec/Feature/Query/QuerySpec.hs:1696 (`specLegacyTargetNames`), the
  // last block in the file: no case after that line needs a different engine.
  {
    spec: 'QuerySpec',
    from: 1696,
    label: 'url-use-legacy-target-names=false',
    provides: ['configUrlUseLegacyTargetNames'],
    config: { urlUseLegacyTargetNames: false },
  },
  // test/spec/Feature/Query/RpcSpec.hs:1496, the last block in the file.
  {
    spec: 'RpcSpec',
    from: 1496,
    label: 'db-pre-config=true',
    provides: ['configDbPreConfig'],
    config: { dbPreConfig: 'true' },
  },
];

/**
 * The PostgREST config fields a case says it needs.
 *
 * The extractor writes them into `skipReason` as the upstream `AppConfig`
 * field names in the first parenthesised group; the two "off by default"
 * reasons name the config key instead (`db-aggregates-enabled`).
 */
export function requiredConfigKeys(testCase) {
  const m = /\(([^)]*)\)/.exec(String(testCase.skipReason || ''));
  if (!m) return [];
  return m[1].split(',').map(s => s.trim()).filter(Boolean);
}

function specName(testCase) {
  const src = String(testCase.source || '');
  const base = src.split('/').pop().replace(/\.hs$/, '');
  return base || String(testCase.id || '').split(':')[0];
}

/** The ENGINE_CONFIGS entry that covers this case, or null. */
export function engineConfigFor(testCase) {
  const spec = specName(testCase);
  const line = Number(testCase.line) || 0;
  const needed = testCase.skipClass === 'needs-engine-config'
    ? requiredConfigKeys(testCase)
    : [];
  for (const entry of ENGINE_CONFIGS) {
    if (entry.spec !== spec) continue;
    if (entry.from !== undefined && line < entry.from) continue;
    if (entry.to !== undefined && line > entry.to) continue;
    // A case that already runs (not needs-config) still belongs to the block's
    // configuration when it sits inside its line range.
    if (needed.length && !needed.every(k => entry.provides.includes(k))) {
      continue;
    }
    return entry;
  }
  return null;
}

// ------------------------------------------------ targeted fixture restore
//
// --reset-mutations restores by re-applying all 562 statements of 07-data.sql
// (~8 s), which is too slow to run after every mutating case on the full suite.
// A mutating case writes to the tables it addresses and nothing else — there
// are no foreign keys on DSQL and no triggers survived the fixture load — so
// restoring just those tables is equivalent and costs 2-4 statements.
//
// 07-data.sql is DELETE-then-INSERT per table with `SET search_path` blocks
// deciding what an unqualified name means, so the groups have to be parsed with
// the same search_path bookkeeping the loader applies.

/**
 * Group 07-data.sql by the table each statement restores.
 *
 * @returns {{groups: Map<string, {schema: string, table: string,
 *   statements: string[]}>, order: string[]}} groups keyed `schema.table`,
 *   `order` in file order (a table appearing in two blocks keeps one entry
 *   holding every statement, in file order).
 */
export function parseFixtureGroups(sql) {
  const groups = new Map();
  const order = [];
  let schema = 'public';
  let lastKey = null;

  const at = (toks, i) => {
    const q = parseQualifiedName(toks, i);
    if (!q.name) return null;
    return `${q.schema || schema}.${q.name}`;
  };

  for (const st of splitStatements(sql)) {
    if (st.kind !== 'sql' || !norm(st.text)) continue;
    const toks = tokenize(st.text).filter(t => t.kind !== 'comment');
    if (!toks.length) continue;
    const head = toks[0].v.toLowerCase();
    const second = (toks[1]?.v || '').toLowerCase();

    if (head === 'set' && second === 'search_path') {
      const eq = toks.findIndex(t => t.v === '=');
      const q = eq === -1 ? null : parseQualifiedName(toks, eq + 1);
      if (q && q.name) schema = q.name;
      continue;
    }

    let key = null;
    if (head === 'insert' && second === 'into') key = at(toks, 2);
    else if (head === 'delete' && second === 'from') key = at(toks, 2);
    else if (head === 'update') key = at(toks, 1);
    else if (head === 'select' && /setval/i.test(st.text)) key = lastKey;
    if (!key) continue;

    let group = groups.get(key);
    if (!group) {
      const dot = key.indexOf('.');
      group = {
        schema: key.slice(0, dot), table: key.slice(dot + 1), statements: [],
      };
      groups.set(key, group);
      order.push(key);
    }
    group.statements.push(st.text);
    lastKey = key;
  }
  return { groups, order };
}

let fixtureGroupsCache = null;
function fixtureGroups() {
  if (!fixtureGroupsCache) {
    fixtureGroupsCache = parseFixtureGroups(readFileSync(DATA_PATH, 'utf8'));
  }
  return fixtureGroupsCache;
}

function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

// ------------------------------------------- tables the fixtures never fill
//
// 07-data.sql is DELETE-then-INSERT per table, so re-applying it only restores
// the tables it names. 03-schema.sql creates 215 tables and 07-data.sql fills
// 149 of them; the other 66 are empty the moment the fixtures finish loading and
// nothing ever clears them again. A row a mutating case inserts into one of
// those survives the reload, the run, and every run after it — measured:
// InsertSpec:596 inserts k='棋圍' into simple_pk2 and asserts 201, so it passes
// on the run that first inserts the row and fails 23505 on every run after.
// Upstream never sees this: db-tx-end=rollback-all rolls back each request, so
// every example starts with those tables empty. Emptying them is therefore what
// "restore the fixture state" means for them.
//
// The set is derived from the fixture SQL on every run — CREATE TABLE across all
// of conformance/fixtures/dsql/*.sql minus the tables 07-data.sql writes — so
// adding a table to a fixture file cannot leave a stale hand-written list
// behind. No fixture file other than 07-data.sql inserts, and none creates a
// table AS SELECT, so "created and not written by 07-data.sql" is exactly
// "empty after a load".

const CREATE_TABLE_NOISE =
  new Set(['unlogged', 'temporary', 'temp', 'global', 'local']);

/**
 * The `schema.table` keys a fixture file's CREATE TABLE statements define, in
 * file order, resolving unqualified names against the file's `SET search_path`
 * the way the loader does.
 *
 * @returns {string[]}
 */
export function parseCreatedTables(sql) {
  const keys = [];
  let schema = 'public';
  for (const st of splitStatements(sql)) {
    if (st.kind !== 'sql' || !norm(st.text)) continue;
    const toks = tokenize(st.text).filter(t => t.kind !== 'comment');
    if (!toks.length) continue;
    const words = toks.map(t => t.v.toLowerCase());
    if (words[0] === 'set' && words[1] === 'search_path') {
      const eq = toks.findIndex(t => t.v === '=');
      const q = eq === -1 ? null : parseQualifiedName(toks, eq + 1);
      if (q && q.name) schema = q.name;
      continue;
    }
    if (words[0] !== 'create') continue;
    let i = 1;
    while (i < words.length && CREATE_TABLE_NOISE.has(words[i])) i += 1;
    if (words[i] !== 'table') continue;
    i += 1;
    if (words[i] === 'if' && words[i + 1] === 'not' && words[i + 2] === 'exists') {
      i += 3;
    }
    const q = parseQualifiedName(toks, i);
    if (!q.name) continue;
    const key = `${q.schema || schema}.${q.name}`;
    if (!keys.includes(key)) keys.push(key);
  }
  return keys;
}

/**
 * The `schema.table` keys the fixtures create and 07-data.sql never writes to,
 * i.e. the tables that are empty after a fixture load.
 *
 * @param {string[]} fixtureSql every fixture file's SQL, in load order.
 * @param {string} dataSql 07-data.sql.
 * @returns {string[]} keys in creation order.
 */
export function unpopulatedTables(fixtureSql, dataSql) {
  const populated = new Set(parseFixtureGroups(dataSql).groups.keys());
  const keys = [];
  for (const sql of fixtureSql) {
    for (const key of parseCreatedTables(sql)) {
      if (!populated.has(key) && !keys.includes(key)) keys.push(key);
    }
  }
  return keys;
}

let unpopulatedCache = null;
function fixtureEmptyTables() {
  if (!unpopulatedCache) {
    const dir = join(REPO, 'conformance', 'fixtures', 'dsql');
    const files = readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
    unpopulatedCache = unpopulatedTables(
      files.map(f => readFileSync(join(dir, f), 'utf8')),
      readFileSync(DATA_PATH, 'utf8'));
  }
  return unpopulatedCache;
}

/**
 * Empty the tables the fixtures never populate, so a reload leaves them in the
 * state a fixture load does.
 *
 * A key the live catalog has no table for is skipped: the fixture SQL creates
 * tables DSQL rejects, and a DELETE from one of those would abort the reset.
 * One `count(*)` probe covers the whole set in a single round trip, and only the
 * tables that actually hold rows are deleted from — normally none, so the sweep
 * costs one query per reload.
 *
 * @returns {Promise<{checked: number, cleared: string[], rows: number}>}
 */
export async function clearUnpopulatedTables(pool, catalog, keys) {
  const wanted = (keys || fixtureEmptyTables())
    .filter(k => catalog?.tables?.has(k));
  const out = { checked: wanted.length, cleared: [], rows: 0 };
  if (!wanted.length) return out;
  // Identifiers cannot be bound. These come from the fixture SQL and are
  // checked against pg_catalog above, never from a request, and are quoted.
  const qualified = wanted.map((key) => {
    const dot = key.indexOf('.');
    return `${quoteIdent(key.slice(0, dot))}.${quoteIdent(key.slice(dot + 1))}`;
  });
  const probe = qualified
    .map((t, i) => `(select count(*) from ${t}) as c${i}`).join(', ');
  const counts = await queryRetrying(pool, `select ${probe}`);
  const row = counts.rows[0] || {};
  for (let i = 0; i < wanted.length; i += 1) {
    const n = Number(row[`c${i}`] || 0);
    if (!n) continue;
    // eslint-disable-next-line no-await-in-loop
    await queryRetrying(pool, `DELETE FROM ${qualified[i]}`);
    out.cleared.push(wanted[i]);
    out.rows += n;
  }
  return out;
}

/**
 * The `schema.table` keys a case's writes can have reached, or null when that
 * cannot be decided (the caller then falls back to a full reload).
 */
export function touchedTables(testCase, ctx, groups) {
  const target = caseTarget(testCase);
  if (!target.name) return null;

  // 07-data.sql is the only fixture file that inserts, so a table it never
  // populates was empty when the fixtures loaded, and nothing — not even a full
  // reload — clears it again. A row a case inserts there therefore survives the
  // run and every run after it (measured: InsertSpec:596 fails with 23505
  // against the `棋圍` row an earlier run left in simple_pk2). Restoring such a
  // table means emptying it. Only tables in the default exposed schema qualify:
  // a namesake in another schema is not what the request reached.
  const emptyOnLoad = (name) =>
    ctx.catalog.tablesInPublic?.has(name) ? `public.${name}` : null;

  if (target.kind === 'function') {
    const writes = ctx.catalog.functionWrites?.get(target.name);
    // A name pg_proc does not have cannot have written anything: the request
    // was a 404 or a schema-cache error, so there is nothing to restore.
    if (!writes) {
      return ctx.catalog.functions?.has(target.name) ? null : new Set();
    }
    const keys = new Set();
    for (const key of writes) {
      if (groups.groups.has(key)) {
        keys.add(key);
        continue;
      }
      const dot = key.indexOf('.');
      const empty = key.slice(0, dot) === 'public'
        ? emptyOnLoad(key.slice(dot + 1)) : null;
      if (empty) keys.add(empty);
    }
    return keys;
  }

  // A write through a view lands in a base table the view name does not name.
  if (ctx.catalog.viewsInPublic.has(target.name)) return null;

  const schemas = ctx.catalog.relations.get(target.name) || ['public'];
  const keys = new Set();
  for (const s of schemas) {
    if (groups.groups.has(`${s}.${target.name}`)) keys.add(`${s}.${target.name}`);
  }
  if (keys.size === 0) {
    const empty = emptyOnLoad(target.name);
    if (empty) keys.add(empty);
  }
  return keys;
}

// A restore statement races whatever the engine's pool is still committing, and
// Aurora DSQL answers a write conflict with OC000 / 40001 rather than blocking
// (DSQL-CAPABILITIES.md). AWS documents both as retryable; without a retry a
// single conflict aborts the whole run (measured on SingularSpec: `delete from
// bets` conflicted once in 36 cases).
const RESTORE_RETRIES = 4;

function isConflict(err) {
  return err?.code === 'OC000' || err?.code === '40001'
    || /conflicts with another transaction/i.test(err?.message || '');
}

async function queryRetrying(target, sql, values) {
  for (let attempt = 0; ; attempt++) {
    try {
      // eslint-disable-next-line no-await-in-loop
      return await target.query(sql, values);
    } catch (err) {
      if (!isConflict(err) || attempt >= RESTORE_RETRIES) throw err;
      // eslint-disable-next-line no-await-in-loop
      await new Promise(r => setTimeout(r, 50 * (attempt + 1)));
    }
  }
}

/**
 * Restore `keys` to the state the fixture load left them in: re-apply the
 * 07-data.sql statements for a table the file populates, in file order, and
 * empty a table it does not.
 */
export async function restoreTables(pool, keys, groups) {
  if (!keys || keys.size === 0) return 0;
  const client = typeof pool.connect === 'function'
    ? await pool.connect() : null;
  const target = client || pool;
  let applied = 0;
  // The restore borrows a connection from the engine's own pool, and
  // `set_config('search_path', ..., false)` is session-wide: left behind, it
  // decides how the *next* request's unqualified names resolve (measured: a
  // restore of a `private` table left that path on the connection and the next
  // `rpc/is_superuser` came back 404 / 42883). The connection's own path is
  // read once and put back before it is released.
  let entryPath = null;
  const pinPath = async (value) => {
    if (entryPath === null) {
      const shown = await target.query('show search_path');
      entryPath = shown.rows[0]?.search_path ?? '';
    }
    await queryRetrying(target, 'select set_config($1, $2, false)',
      ['search_path', value]);
  };
  try {
    for (const key of keys) {
      if (groups.groups.has(key)) continue;
      const dot = key.indexOf('.');
      // Identifiers cannot be bound; they come from pg_catalog, not from a
      // request, and are quoted.
      // eslint-disable-next-line no-await-in-loop
      await queryRetrying(target,
        `DELETE FROM ${quoteIdent(key.slice(0, dot))}`
        + `.${quoteIdent(key.slice(dot + 1))}`);
      applied += 1;
    }
    for (const key of groups.order) {
      if (!keys.has(key)) continue;
      const group = groups.groups.get(key);
      // Restore under the same search_path the file's block ran with: the
      // statements are unqualified. set_config is a plain statement, so it
      // works on DSQL, which rejects `SET search_path` outside a session.
      // eslint-disable-next-line no-await-in-loop
      await pinPath(`${quoteIdent(group.schema)}, pg_catalog`);
      for (const sql of group.statements) {
        // eslint-disable-next-line no-await-in-loop
        await queryRetrying(target, sql);
        applied += 1;
      }
    }
  } finally {
    if (entryPath !== null) {
      await queryRetrying(target, 'select set_config($1, $2, false)',
        ['search_path', entryPath]).catch(() => {});
    }
    if (client) client.release();
  }
  return applied;
}

// ---------------------------------------------------------------- run

function truncateBody(json, text) {
  const value = json === undefined ? (text ?? null) : json;
  if (value == null) return null;
  const s = safeStringify(value);
  if (s.length <= MAX_ACTUAL_BODY_CHARS) return value;
  return { __truncated__: true, chars: s.length,
    preview: s.slice(0, MAX_ACTUAL_BODY_CHARS) };
}

// DSQL is optimistic-concurrency only: a plain read can come back as SQLSTATE
// 40001 ("Request failed with a database error." with code 40001 in the body)
// when it races another transaction. AWS documents 40001 as retryable and the
// engine does not retry it, so without a retry here the same case passes or
// fails depending on what else is in flight — measured: AndOrParamsSpec:267
// failed with 40001 at --concurrency 4 and returned a normal body at
// --concurrency 1. Retries are counted and reported (totals.occRetries) so the
// engine's missing retry stays visible instead of being hidden.
const OCC_RETRIES = 2;

function isOccConflict(response) {
  if (!response || response.statusCode < 500) return false;
  try {
    return JSON.parse(response.body || 'null')?.code === '40001';
  } catch {
    return false;
  }
}

// API Gateway sets Content-Length on the response it builds from the Lambda
// proxy result; the handler itself never emits it. Upstream asserts
// Content-Length on 62 sites, so comparing against the raw handler headers
// would report every one as "<absent>" — a harness artefact, not a gap. The
// deployed value is the body's byte length, so that is what is filled in. An
// explicit Content-Length from the handler always wins.
export function withContentLength(response) {
  const headers = { ...(response.headers || {}) };
  if (Object.keys(headers).some((h) => h.toLowerCase() === 'content-length')) {
    return headers;
  }
  const body = response.body;
  if (body == null || body === '') return headers;
  const bytes = response.isBase64Encoded
    ? Buffer.from(body, 'base64').length
    : Buffer.byteLength(body, 'utf8');
  headers['Content-Length'] = String(bytes);
  return headers;
}

async function runCase(handler, testCase, opts, ctx) {
  if (testCase.skip) {
    const t = triage({
      testCase,
      actual: { statusCode: null, headers: {}, body: null, json: null },
      comparison: { ok: false, statusOk: false, headerMismatches: [], bodyOk: false, diff: '' },
      thrown: null, logs: [], ctx,
    });
    return { ...t, actual: { status: null, body: null } };
  }

  const logs = [];
  const event = buildEvent(testCase, opts);
  let response = null;
  let thrown = null;

  for (let attempt = 0; attempt <= OCC_RETRIES; attempt++) {
    logs.length = 0;
    response = null;
    thrown = null;
    // eslint-disable-next-line no-await-in-loop
    await logStore.run(logs, async () => {
      try {
        response = await withTimeout(handler(event), opts.timeout);
      } catch (err) {
        thrown = {
          message: err && err.message ? err.message : String(err),
          timedOut: Boolean(err && err.__timeout),
        };
      }
    });
    if (!isOccConflict(response)) break;
    ctx.occRetries = (ctx.occRetries || 0) + 1;
    if (attempt === OCC_RETRIES) {
      ctx.occExhausted = (ctx.occExhausted || 0) + 1;
    }
  }

  if (thrown || !response) {
    const t = triage({
      testCase,
      actual: { statusCode: null, headers: {}, body: null, json: null },
      comparison: { ok: false, statusOk: false, headerMismatches: [], bodyOk: false, diff: '' },
      thrown: thrown || { message: 'handler returned nothing', timedOut: false },
      logs, ctx,
    });
    if (logs.length) t.reason = `${t.reason}\n${firstLine(logs.join('\n'))}`;
    return { ...t, actual: { status: null, body: null } };
  }

  const actual = {
    statusCode: response.statusCode,
    headers: withContentLength(response),
    body: response.body ?? '',
  };
  const parsedBody = parseActualBody(actual.body);
  actual.json = parsedBody.json;

  const comparison = compare(testCase, actual);
  const t = triage({ testCase, actual, comparison, thrown: null, logs, ctx });

  return {
    ...t,
    actual: {
      status: actual.statusCode,
      body: truncateBody(actual.json, actual.body),
    },
  };
}

function withTimeout(promise, ms) {
  if (!Number.isFinite(ms) || ms <= 0) return promise;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`case exceeded ${ms}ms`);
      err.__timeout = true;
      reject(err);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(
    async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        results[i] = await fn(items[i], i);
      }
    });
  await Promise.all(workers);
  return results;
}

// Mutating cases write to the live fixtures (no transaction isolation is
// possible: DSQL has no SAVEPOINT and the handler owns its own connections), so
// a second run sees the first run's writes. 07-data.sql is DELETE-then-INSERT
// per table, so re-applying it restores the rows upstream's fixtures define.
//
// Two things it does NOT restore on its own:
//   - rows in tables 07-data.sql never populates. `reloadData` cannot clear
//     those; the caller pairs it with `clearUnpopulatedTables`, which empties
//     them (see "tables the fixtures never fill" above). A reload that is not
//     followed by that sweep leaves a row a mutating case inserted in place
//     forever.
//   - identity/sequence counters. Upstream gets a fresh sequence because
//     schema.sql recreates the schema; a data-only reload cannot, so a case
//     asserting a generated id drifts by the number of prior inserts.
// A full `node conformance/fixtures/load.mjs` is the only complete reset.
// A DSQL write can lose an optimistic-concurrency race with a transaction that
// has not finished settling ("change conflicts with another transaction",
// OC000/40001). Measured once mid-run on `delete from bets;`. The conflict says
// nothing about the fixture, so the reload is retried before giving up.
// A DELETE that lost that race leaves its table populated, so the INSERTs that
// follow it in the same block fail with a duplicate key. Those are the same
// conflict reported twice, so a reload whose failures are conflicts plus
// duplicate keys is retried too (measured on a full run: 34 conflicts and 21
// duplicate keys in one reload, all of them gone on the next attempt).
const CONFLICT_RE = /OC000|40001|conflicts with another transaction/i;
const DUP_KEY_RE = /duplicate key value|23505/i;

function reloadData(target, label, attempts = 4) {
  if (target !== 'dsql') {
    throw new Error('--reload-data is implemented for --target dsql only');
  }
  const loader = join(REPO, 'conformance', 'fixtures', 'load.mjs');
  let report = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const out = execFileSync(process.execPath, [loader, '--only', DATA_FILE], {
      cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    report = JSON.parse(out);
    process.stderr.write(
      `[runner] reloaded ${DATA_FILE}${label ? ` before ${label}` : ''}: `
      + `${report.statementsApplied}/${report.statementsTotal} statements, `
      + `${report.statementsFailed} failed`
      + `${attempt > 1 ? ` (attempt ${attempt})` : ''}\n`);
    if (report.statementsFailed === 0) return;
    // The loader's stdout carries `topErrors` ([message, count] pairs), not the
    // per-statement list it writes to load-failures-partial.json, so the
    // classification has to read those messages.
    const errors = (report.topErrors || []).map(([message]) => String(message));
    const conflictsOnly = errors.length > 0
      && errors.some((m) => CONFLICT_RE.test(m))
      && errors.every((m) => CONFLICT_RE.test(m) || DUP_KEY_RE.test(m));
    if (!conflictsOnly) break;
  }
  throw new Error(`${report.statementsFailed} data statement(s) failed to `
    + 'reload; see conformance/fixtures/load-failures-partial.json');
}

function gitCommit() {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'],
      { cwd: REPO, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

function emptyCounts() {
  return {
    total: 0, passed: 0, failed: 0, skipped: 0, needsConfig: 0, blocked: 0,
    outOfScope: 0, errored: 0,
  };
}

function bump(counts, status) {
  counts.total++;
  if (status === 'pass') counts.passed++;
  else if (status === 'fail') counts.failed++;
  else if (status === 'skip') counts.skipped++;
  else if (status === 'needs-config') counts.needsConfig++;
  else if (status === 'blocked') counts.blocked++;
  else if (status === 'out-of-scope') counts.outOfScope++;
  else counts.errored++;
}

export function buildResults({ target, cases, outcomes, occ }) {
  const totals = emptyCounts();
  const byCategory = {};
  const gaps = new Map();
  const caseRows = [];

  cases.forEach((testCase, i) => {
    const o = outcomes[i];
    const category = testCase.category || 'uncategorized';
    bump(totals, o.status);
    byCategory[category] ||= emptyCounts();
    bump(byCategory[category], o.status);
    if (o.gap) gaps.set(o.gap, (gaps.get(o.gap) || 0) + 1);
    caseRows.push({
      id: testCase.id,
      category,
      status: o.status,
      reason: o.reason || null,
      gap: o.gap || null,
      actual: o.actual,
    });
  });

  // Retries are additive keys on totals: totals.total is still
  // passed+failed+skipped+needsConfig+blocked+outOfScope+errored
  // (CONTRACTS.md section 3).
  totals.occRetries = occ?.occRetries || 0;
  totals.occExhausted = occ?.occExhausted || 0;

  return {
    generatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    target,
    commit: gitCommit(),
    totals,
    byCategory,
    gaps: Object.fromEntries([...gaps.entries()].sort((a, b) => b[1] - a[1])),
    cases: caseRows,
  };
}

/**
 * A `db-pre-request` block whose function does not exist on this database.
 *
 * Upstream's pre-request functions are plpgsql and set namespaced run-time
 * parameters; DSQL has neither, so the fixture loader dropped them
 * (load-report.json). Running the case anyway would score the engine on a
 * missing fixture, so it is reported blocked with the drop reason — the same
 * treatment any other unbuildable fixture gets.
 *
 * @returns an outcome, or null when the case can run.
 */
async function preRequestBlocked(entry, testCase, ctx) {
  const fn = entry?.config?.dbPreRequest;
  if (!fn || testCase.skip) return null;
  const bare = String(fn).split('.').pop();
  if (ctx.catalog.functions.has(bare)) return null;
  const drop = ctx.dropIndex.get(bare) || ctx.dropIndex.get(`public.${bare}`);
  return {
    status: 'blocked',
    gap: drop ? gapForDropReason(drop.reason) : 'fixture-missing',
    reason: `db-pre-request function ${fn} does not exist on this database`
      + (drop ? `: ${drop.reason}` : ''),
    actual: { status: null, body: null },
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  const { cases: allCases, files } = loadCases(opts.casesDir);
  if (allCases.length === 0) {
    process.stderr.write(
      `no cases in ${opts.casesDir} — run the extractor first\n`);
    process.exit(1);
  }
  const cases = selectCases(allCases, opts);
  if (opts.list) {
    for (const c of cases) {
      process.stdout.write(`${c.id}\t${c.category}\t${c.description || ''}\n`);
    }
    return;
  }
  process.stderr.write(
    `[runner] ${cases.length}/${allCases.length} case(s) from `
    + `${files.length} file(s), target=${opts.target}, `
    + `concurrency=${opts.concurrency}\n`);

  if (opts.resetMutations && opts.concurrency !== 1) {
    throw new Error('--reset-mutations needs --concurrency 1: the reset is a '
      + 'blocking DELETE/INSERT over the whole fixture set');
  }
  if (opts.resetTouched && opts.concurrency !== 1) {
    throw new Error('--reset-touched needs --concurrency 1: it restores the '
      + 'tables the previous case wrote, which only has a meaning when cases '
      + 'run one at a time');
  }
  if (opts.reloadPerSpec && opts.concurrency !== 1) {
    throw new Error('--reload-per-spec needs --concurrency 1: the reload is a '
      + 'blocking DELETE/INSERT over the whole fixture set and would land in '
      + 'the middle of other in-flight cases');
  }
  if (opts.reloadData) reloadData(opts.target);

  // Aurora DSQL ships exactly one text search configuration, `simple`
  // (DSQL-CAPABILITIES.md; `SELECT cfgname FROM pg_ts_config` returns one row,
  // and to_tsvector('english', ...) errors with `text search configuration
  // "pg_catalog.english" does not exist`). A real DSQL deployment therefore
  // has to set PGREST_DEFAULT_TS_CONFIG=simple or every fts filter that names
  // no config fails at the database. Configure the target the way a working
  // deployment would, so the report measures the engine and not a
  // misconfiguration. An explicit env var still wins.
  if (opts.target === 'dsql' && !process.env.PGREST_DEFAULT_TS_CONFIG) {
    process.env.PGREST_DEFAULT_TS_CONFIG = 'simple';
  }

  // Data representations come from pg_cast — an implicit, function-backed cast
  // between a domain and json/text (SchemaCache.hs `dataRepresentations`). DSQL
  // rejects CREATE CAST, so the 15 casts upstream's schema.sql defines are
  // dropped at load time (load-report.json, kind `cast`) and pg_cast reports
  // none, while every cast function loads fine. representations.json declares
  // them the way relationships.json declares the foreign keys DSQL cannot store;
  // without it every representation path in the engine is a no-op. Same rule as
  // the manifest: an explicit env var still wins.
  if (opts.target === 'dsql' && !process.env.PGREST_REPRESENTATIONS_PATH) {
    process.env.PGREST_REPRESENTATIONS_PATH =
      join(REPO, 'conformance', 'fixtures', 'representations.json');
  }

  // Upstream's `baseCfg` configures `jwt-secret` for every spec, not only the
  // auth ones (SpecHelper.hs), so the base engine verifies too. Before this the
  // runner handed the engine an identity decoded from the token without
  // checking the signature, which passed the specs that assert a *successful*
  // token and could not fail the ones that assert a rejected one — a token
  // signed with the wrong secret reached the table. `anonRole` follows --role so
  // a run with a different default role still gets it for tokenless requests.
  const baseEngineConfig = {
    database: resolveTargetConfig(opts.target),
    restJwt: { secret: SPEC_JWT_SECRET, anonRole: opts.role || 'anon' },
    jwtSecret: process.env.JWT_SECRET
      || 'conformance-runner-secret-not-used-for-verification',
    auth: false,
    policies: opts.policies,
    // One introspection for the whole run.
    schemaCacheTtl: 24 * 60 * 60 * 1000,
    docs: false,
    production: false,
    errors: { verbose: opts.verboseErrors },
    cors: { allowedOrigins: '*', allowCredentials: false },
    // Upstream has no filterless-mutation guard of its own: `PATCH /items` with
    // no filter updates every row, and the 400 upstream asserts in
    // PgSafeUpdateSpec comes from the pg-safeupdate extension loaded by a
    // db-pre-request function. This engine's guard is on by default; measuring
    // upstream's behaviour means running with the guard in upstream's state.
    bulkMutationGuard: 'off',
    // Upstream's `baseCfg` sets `configDbTxRollbackAll = True` and
    // `configDbTxAllowOverride = True` (SpecHelper.hs:175-176), i.e.
    // `db-tx-end = "rollback-allow-override"`, for every spec it runs. Every
    // mutating request in the suite is therefore undone before the next one
    // starts, unless it asked for `Prefer: tx=commit` — which is how a spec can
    // delete the same 15 rows twice and expect both to succeed
    // (MaxAffectedSpec.hs:87-118). Running the engine with the ending upstream
    // configured is what makes those assertions measurable at all; without it
    // the second one is scored against rows the first one removed.
    dbTxEnd: 'rollback-allow-override',
    // Upstream's `baseCfg` (test/spec/fixtures/*.conf) sets two `app-settings`
    // for every spec — `app.settings.app_host` and
    // `app.settings.external_api_secret` — and RpcSpec:915 reads the first back
    // with `current_setting`. They are deliberately NOT configured here: Aurora
    // DSQL rejects a custom GUC outright, in or out of a transaction
    //
    //   BEGIN; SET LOCAL app.settings.app_host = 'localhost';
    //   ERROR 0A000: setting configuration parameter
    //                "app.settings.app_host" not supported
    //
    // (probed on the conformance cluster, PostgreSQL 16 / DSQL). `set_config(…,
    // true)` fails the same way, and because it aborts the request's
    // transaction it turns *every* case into a 400 0A000 — measured: 3 of 115
    // passing on a 124-case probe with the settings configured. The engine's
    // `app-settings` surface (src/index.mjs `parseAppSettings`, handler.mjs
    // `appSettingsSql`) is implemented and unit-tested; on DSQL there is nothing
    // it can be pointed at, so RpcSpec:915 stays failing.
  };

  // One engine per configuration, built on first use. Each one holds its own
  // connection pool and its own schema cache (db-schemas changes what gets
  // introspected), so they are created lazily and all closed at the end.
  const engines = new Map();
  const engineFor = (label, extra) => {
    let engine = engines.get(label);
    if (!engine) {
      engine = createPgrest({ ...baseEngineConfig, ...extra });
      engines.set(label, engine);
      if (label !== 'base') {
        process.stderr.write(`[runner] engine "${label}" booted\n`);
      }
    }
    return engine;
  };
  const pgrest = engineFor('base', {});

  const restore = installLogCapture();
  let results;
  try {
    const pool = await pgrest._db.getPool();
    const catalog = await readCatalog(pool);
    const ctx = { catalog, dropIndex: loadDropIndex() };
    process.stderr.write(
      `[runner] catalog: ${catalog.relations.size} relation name(s), `
      + `${catalog.functions.size} function name(s)\n`);

    // Every reset path has to leave the tables 07-data.sql never populates
    // empty: that is the state a fixture load leaves them in, and the state
    // upstream's per-request rollback leaves them in. Re-applying 07-data.sql
    // cannot do it, so the sweep runs with it — once before the first case, and
    // after every reload the run performs.
    const resetting = opts.reloadData || opts.reloadPerSpec
      || opts.resetMutations || opts.resetTouched;
    let sweeps = 0;
    let sweptRows = 0;
    const sweepUnpopulated = async (label) => {
      // Ask the provider for the pool every time: the DSQL provider replaces it
      // when the IAM token it was built with nears expiry.
      const swept = await clearUnpopulatedTables(
        await pgrest._db.getPool(), catalog);
      sweeps += 1;
      sweptRows += swept.rows;
      if (swept.cleared.length) {
        process.stderr.write(
          `[runner] cleared ${swept.rows} leftover row(s) from `
          + `${swept.cleared.join(', ')}`
          + `${label ? ` before ${label}` : ''}\n`);
      }
      return swept;
    };
    const reloadFixtures = async (label) => {
      reloadData(opts.target, label);
      if (opts.target === 'dsql') await sweepUnpopulated(label);
    };
    if (resetting && opts.target === 'dsql') {
      await sweepUnpopulated('the first case');
    }

    let done = 0;
    // --reset-mutations bookkeeping. `dirty` means the previous case wrote to
    // the fixtures; upstream would have rolled that write back, so the next
    // case has to start from restored data. The one exception is a follow-up
    // step in the same example after a `Prefer: tx=commit` request, which is
    // the only way an upstream write is visible to a later request.
    let dirty = false;
    let prev = null;
    let resets = 0;
    // Upstream reloads its fixtures per spec file. Without the same reset,
    // every spec that runs after a mutating one is scored against data the
    // previous spec changed (measured: 15 QuerySpec cases differ between a
    // select-only run and a full run, 4 of them pass/fail flips).
    let loadedFor = null;
    // --reset-touched bookkeeping: which tables the previous case can have
    // written, and how often that could not be decided.
    const groups = opts.resetTouched ? fixtureGroups() : null;
    let touched = null;
    let fallbacks = 0;
    let restored = 0;
    // Per-case engine configuration (ENGINE_CONFIGS): how many cases ran under
    // each, so the summary can say what the number was measured with.
    const configUse = new Map();
    const outcomes = await mapWithConcurrency(cases, opts.concurrency,
      async (rawCase) => {
        const entry = opts.perCaseConfig ? engineConfigFor(rawCase) : null;
        // A needs-config case whose configuration the runner can supply is run
        // for real; it stops being held out of the denominator.
        const testCase = entry && rawCase.skip
            && rawCase.skipClass === 'needs-engine-config'
          ? { ...rawCase, skip: false, skipReason: null, skipClass: null }
          : rawCase;
        if (entry) {
          configUse.set(entry.label, (configUse.get(entry.label) || 0) + 1);
        }
        if (opts.reloadPerSpec && !testCase.skip
            && testCase.source !== loadedFor) {
          loadedFor = testCase.source;
          await reloadFixtures(testCase.source);
          dirty = false;
        }
        const carryOver = () => prev && prev.txCommit && prev.example
          && prev.example === testCase.example;
        if (opts.resetMutations && !testCase.skip && dirty && !carryOver()) {
          await reloadFixtures(`${testCase.id} (reset ${resets + 1})`);
          resets += 1;
          dirty = false;
        }
        if (opts.resetTouched && !testCase.skip && dirty && !carryOver()) {
          if (touched === null) {
            // The previous case's writes cannot be attributed to tables (a
            // write through a view, or an RPC whose body is not on record).
            // Restore everything rather than guess.
            await reloadFixtures(`${testCase.id} (full reset ${resets + 1})`);
            resets += 1;
            fallbacks += 1;
          } else {
            // Ask the provider for the pool every time: the DSQL provider
            // ends the pool and opens a new one when the IAM token it was
            // built with is close to expiring, so a pool captured at startup
            // is dead about 50 minutes into a full run.
            restored += await restoreTables(
              await pgrest._db.getPool(), touched, groups);
            resets += 1;
          }
          dirty = false;
          touched = null;
        }
        const handler = entry
          ? engineFor(entry.label, entry.config).rest
          : pgrest.rest;
        const o = await preRequestBlocked(entry, testCase, ctx)
          || await runCase(handler, testCase, opts, ctx);
        if (!testCase.skip) {
          if (isMutating(testCase)) {
            dirty = true;
            if (opts.resetTouched) touched = touchedTables(testCase, ctx, groups);
          }
          prev = {
            example: testCase.example || null,
            txCommit: /tx=commit/i
              .test(String(pickHeader(testCase.request?.headers, 'prefer') || '')),
          };
        }
        done++;
        if (done % 50 === 0 || done === cases.length) {
          process.stderr.write(`[runner] ${done}/${cases.length}\n`);
        }
        return o;
      });

    if (configUse.size) {
      const labels = [...configUse.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([label, n]) => `${label} (${n})`);
      process.stderr.write(
        `[runner] per-case engine config: ${labels.join(', ')}\n`);
      for (const e of ENGINE_CONFIGS) {
        if (e.substitute && configUse.has(e.label)) {
          process.stderr.write(
            `[runner]   substitute in "${e.label}": ${e.substitute}\n`);
        }
      }
    }
    if (opts.resetTouched) {
      process.stderr.write(
        `[runner] targeted resets: ${resets} (${restored} statement(s) `
        + `re-applied, ${fallbacks} full reload fallback(s))\n`);
    }
    if (sweeps) {
      process.stderr.write(
        `[runner] unpopulated-table sweeps: ${sweeps} over `
        + `${fixtureEmptyTables().length} table(s) the fixtures never `
        + `populate, ${sweptRows} leftover row(s) cleared\n`);
    }
    results = buildResults({ target: opts.target, cases, outcomes, occ: ctx });
  } finally {
    restore();
    for (const engine of engines.values()) {
      if (typeof engine._db.close === 'function') {
        // eslint-disable-next-line no-await-in-loop
        await Promise.resolve(engine._db.close()).catch(() => {});
      }
    }
  }

  mkdirSync(opts.outDir, { recursive: true });
  // Millisecond stamp: two runs in the same second must not overwrite the copy.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const latest = join(opts.outDir, 'latest.json');
  const copy = join(opts.outDir, `run-${stamp}.json`);
  const json = JSON.stringify(results, null, 2) + '\n';
  writeFileSync(latest, json);
  writeFileSync(copy, json);

  const t = results.totals;
  // Headline denominator: cases that actually ran and are in scope. skipped
  // (not representable), needs-config (assertion only holds under a PostgREST
  // process config the engine has no switch for), blocked (fixture cannot exist
  // on DSQL) and out-of-scope (PostgREST process/role mechanisms) are all
  // excluded and reported next to it.
  const runnable = t.passed + t.failed;
  const rate = runnable ? ((t.passed / runnable) * 100).toFixed(1) : '0.0';
  process.stdout.write(
    `pass ${t.passed}/${runnable} (${rate}% of runnable in-scope)  `
    + `fail ${t.failed}  blocked ${t.blocked}  out-of-scope ${t.outOfScope}  `
    + `needs-config ${t.needsConfig}  skip ${t.skipped}  `
    + `error ${t.errored}  total ${t.total}\n`);
  if (t.occRetries) {
    process.stdout.write(
      `  dsql 40001 retries: ${t.occRetries} `
      + `(${t.occExhausted} still failing after ${OCC_RETRIES})\n`);
  }
  const topGaps = Object.entries(results.gaps).slice(0, 10);
  for (const [gap, n] of topGaps) {
    process.stdout.write(`  ${String(n).padStart(5)}  ${gap}\n`);
  }
  process.stdout.write(`wrote ${latest}\n      ${copy}\n`);
}

const invokedDirectly = process.argv[1]
  && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  main().catch(err => {
    process.stderr.write(`[runner] fatal: ${err.stack || err.message}\n`);
    process.exit(1);
  });
}
