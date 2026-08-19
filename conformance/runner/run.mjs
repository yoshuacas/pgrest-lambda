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

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const CASES_DIR = join(REPO, 'conformance', 'cases');
const RESULTS_DIR = join(REPO, 'conformance', 'results');
const LOAD_REPORT = join(REPO, 'conformance', 'fixtures', 'load-report.json');

// DSQL conformance cluster (CONTRACTS.md). Env wins.
const DEFAULT_DSQL_ENDPOINT =
  '6juamhyj5nkoeatkzc3ieaerc4.dsql.us-east-1.on.aws';
const DEFAULT_REGION = 'us-east-1';

const MAX_ACTUAL_BODY_CHARS = 8000;
const DATA_FILE = '07-data.sql';

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
                            (default: service_role)
  --cases-dir <path>        default conformance/cases
  --out-dir <path>          default conformance/results
  --reload-data             re-apply conformance/fixtures/dsql/07-data.sql
                            before running (dsql target only). Mutating cases
                            write to the live fixtures and DSQL has no
                            SAVEPOINT, so a run that includes insert/update/
                            delete/upsert cases is only reproducible from
                            restored data.
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
    role: 'service_role',
    casesDir: CASES_DIR,
    outDir: RESULTS_DIR,
    reloadData: false,
    reloadPerSpec: false,
    resetMutations: false,
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
      case '--out-dir': opts.outDir = next(); break;
      case '--reload-data': opts.reloadData = true; break;
      case '--reload-per-spec': opts.reloadPerSpec = true; break;
      case '--reset-mutations': opts.resetMutations = true; break;
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
    role: payload.role || 'authenticated',
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

  const authorizer = authorizerContext(headers, opts.role || 'service_role');

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
function parseActualBody(bodyText) {
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
  const colMatch = /Column '([^'.]+)' does not exist in '([^']+)'/.exec(message);
  if (colMatch) {
    const [, col, rel] = colMatch;
    const drop = ctx.dropIndex.get(`public.${rel}.${col}`)
      || ctx.dropIndex.get(`${rel}.${col}`);
    if (drop && drop.kind === 'column') {
      return {
        status: 'blocked',
        gap: gapForDropReason(drop.reason),
        reason: reason(`column ${drop.object} was dropped at fixture load: `
          + drop.reason),
      };
    }
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

  // 5. Whatever the database actually complained about.
  for (const [re, gap, scope] of LOG_GAPS) {
    if (re.test(logText) || (scope !== 'log-only' && re.test(message))) {
      return { status: 'fail', gap, reason: reason(firstLine(logText) || message) };
    }
  }

  // 6. PostgREST's auth model is Postgres roles; ours cannot be.
  const sentJwt = pickHeader(testCase.request?.headers, 'authorization') != null;
  const expectedStatusRaw = Number(testCase.expected?.status);
  const authShaped = [401, 403].includes(expectedStatusRaw);
  // The runner builds the authorizer context from the token payload without
  // verifying the signature (see authorizerContext), so every assertion whose
  // subject is token *validation* is unmeasurable here — not an engine gap.
  if (!comparison.statusOk && sentJwt && expectedStatusRaw === 401
      && actual.statusCode < 400) {
    return {
      status: 'fail',
      gap: 'harness-no-jwt-verification',
      reason: reason('the case asserts that the token is rejected; the runner '
        + 'trusts the payload and never verifies a signature'),
    };
  }
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
      reason: reason('the same rows came back in a different order; DSQL does '
        + 'not guarantee the physical order this assertion depends on'),
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

function resolveTargetConfig(target) {
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
  const rels = await pool.query(REL_SQL);
  for (const row of rels.rows) {
    add(relations, row);
    if (row.schema !== 'public') continue;
    if (row.relkind === 'v' || row.relkind === 'm') viewsInPublic.add(row.name);
    else tablesInPublic.add(row.name);
  }
  const fns = await pool.query(FN_SQL);
  for (const row of fns.rows) add(functions, row);
  const inPublic = (map) => new Set(
    [...map.entries()].filter(([, s]) => s.includes('public')).map(([n]) => n));
  return {
    relations,
    functions,
    relationsInPublic: inPublic(relations),
    functionsInPublic: inPublic(functions),
    // A name that is only a view in public: the engine's schema cache reads
    // relkind 'r'/'p' only, so those relations are invisible to it.
    viewsInPublic: new Set(
      [...viewsInPublic].filter(n => !tablesInPublic.has(n))),
  };
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
function withContentLength(response) {
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
// Two things it does NOT restore:
//   - rows in tables 07-data.sql never populates (nothing clears those);
//   - identity/sequence counters. Upstream gets a fresh sequence because
//     schema.sql recreates the schema; a data-only reload cannot, so a case
//     asserting a generated id drifts by the number of prior inserts.
// A full `node conformance/fixtures/load.mjs` is the only complete reset.
// A DSQL write can lose an optimistic-concurrency race with a transaction that
// has not finished settling ("change conflicts with another transaction",
// OC000/40001). Measured once mid-run on `delete from bets;`. The conflict says
// nothing about the fixture, so the reload is retried before giving up.
const CONFLICT_RE = /OC000|40001|conflicts with another transaction/i;

function reloadData(target, label, attempts = 3) {
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
    const conflictsOnly = (report.failures || []).length > 0
      && report.failures.every((f) => CONFLICT_RE.test(f.error || ''));
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

  // The engine needs a JWT secret to boot; conformance never verifies a token
  // (the authorizer context is built by the runner), so a fixed dummy is fine.
  const pgrest = createPgrest({
    database: resolveTargetConfig(opts.target),
    jwtSecret: process.env.JWT_SECRET
      || 'conformance-runner-secret-not-used-for-verification',
    auth: false,
    policies: join(REPO, 'policies'),
    // One introspection for the whole run.
    schemaCacheTtl: 24 * 60 * 60 * 1000,
    docs: false,
    production: false,
    errors: { verbose: opts.verboseErrors },
    cors: { allowedOrigins: '*', allowCredentials: false },
  });

  const restore = installLogCapture();
  let results;
  try {
    const pool = await pgrest._db.getPool();
    const catalog = await readCatalog(pool);
    const ctx = { catalog, dropIndex: loadDropIndex() };
    process.stderr.write(
      `[runner] catalog: ${catalog.relations.size} relation name(s), `
      + `${catalog.functions.size} function name(s)\n`);

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
    const outcomes = await mapWithConcurrency(cases, opts.concurrency,
      async (testCase) => {
        if (opts.reloadPerSpec && !testCase.skip
            && testCase.source !== loadedFor) {
          loadedFor = testCase.source;
          reloadData(opts.target, testCase.source);
          dirty = false;
        }
        if (opts.resetMutations && !testCase.skip && dirty) {
          const carryOver = prev && prev.txCommit && prev.example
            && prev.example === testCase.example;
          if (!carryOver) {
            reloadData(opts.target, `${testCase.id} (reset ${resets + 1})`);
            resets += 1;
            dirty = false;
          }
        }
        const o = await runCase(pgrest.rest, testCase, opts, ctx);
        if (!testCase.skip) {
          if (isMutating(testCase)) dirty = true;
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

    results = buildResults({ target: opts.target, cases, outcomes, occ: ctx });
  } finally {
    restore();
    if (typeof pgrest._db.close === 'function') {
      await Promise.resolve(pgrest._db.close()).catch(() => {});
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
