// Groups conformance results by the request feature a case exercises, rather
// than by the upstream spec file it came from. A category tells you which
// upstream file a case lives in; a feature tells you whether you can rely on
// `order=` or `columns=` in your own client, which is the question a reader of
// the compatibility page actually has.
//
// Every row is produced by one predicate over the extracted case, printed
// below with the row, so the table in docs/reference/postgrest-compatibility.md
// can be regenerated and argued with instead of trusted. A predicate matching
// nothing prints `0 / 0` rather than being dropped: "no measurement" and "no
// passes" are different findings and the table must not conflate them.
//
//   node conformance/report/feature-table.mjs [--results <path>] [--markdown]
//
// Counts are cases that ran (pass + fail). Excluded holds the blocked,
// skipped, needs-config and out-of-scope cases that matched the predicate, so
// a feature whose cases DSQL cannot even set up is visible as such.

import fs from 'node:fs';
import path from 'node:path';

const CASES_DIR = 'conformance/cases';
const DEFAULT_RESULTS = 'conformance/results/latest.json';

function header(request, name) {
  const headers = (request && request.headers) || {};
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === name) return String(headers[key]);
  }
  return '';
}

const has = (c, name) => header(c.request, name) !== '';
const prefer = (c) => header(c.request, 'prefer');
const accept = (c) => header(c.request, 'accept');
const query = (c) => (c.request && c.request.query) || '';
const decoded = (c) => {
  try { return decodeURIComponent(query(c)); } catch { return query(c); }
};
const method = (c) => (c.request && c.request.method) || '';
const pathOf = (c) => (c.request && c.request.path) || '';
const expectsHeader = (c, name) => {
  const h = (c.expected && c.expected.headers) || {};
  return Object.keys(h).some((k) => k.toLowerCase() === name);
};

// A PostgREST filter is `?col=op.value`, so an operator is detected as `=op.`
// with an optional `not.` in front. Anchoring on `=` avoids matching a column
// or a value that happens to contain the operator's name.
const op = (names) => new RegExp(`=(not\\.)?(${names})\\.`);

export const FEATURES = [
  ['`Range` request header', (c) => has(c, 'range'), 'Range header present'],
  ['Unsatisfiable range → 416', (c) => has(c, 'range') && Number(c.expected?.status) === 416,
    'Range header present and the assertion expects 416'],
  ['`Prefer: count=exact`', (c) => /count=exact/.test(prefer(c)), 'Prefer contains count=exact'],
  ['`Prefer: return=representation`', (c) => /return=representation/.test(prefer(c)),
    'Prefer contains return=representation'],
  ['`Prefer: resolution=merge-duplicates`', (c) => /merge-duplicates/.test(prefer(c)),
    'Prefer contains merge-duplicates'],
  ['`Prefer: resolution=ignore-duplicates`', (c) => /ignore-duplicates/.test(prefer(c)),
    'Prefer contains ignore-duplicates'],
  ['`Prefer: tx=commit`', (c) => /tx=commit/.test(prefer(c)), 'Prefer contains tx=commit'],
  ['`Prefer: tx=rollback`', (c) => /tx=rollback/.test(prefer(c)), 'Prefer contains tx=rollback'],
  ['`Prefer: handling=strict` / `handling=lenient`', (c) => /handling=(strict|lenient)/.test(prefer(c)),
    'Prefer contains handling=strict or handling=lenient'],
  ['`Prefer: missing=default`', (c) => /missing=default/.test(prefer(c)), 'Prefer contains missing=default'],
  ['`Prefer: max-affected`', (c) => /max-affected/.test(prefer(c)), 'Prefer contains max-affected'],
  ['`Preference-Applied` asserted on the response', (c) => expectsHeader(c, 'preference-applied'),
    'the assertion checks Preference-Applied'],
  ['`is` operator', (c) => op('is').test(query(c)), '?col=is. or ?col=not.is.'],
  ['`in` operator', (c) => op('in').test(query(c)), '?col=in. or ?col=not.in.'],
  ['`like` / `ilike`', (c) => op('i?like').test(query(c)), '?col=like. / ilike., negated or not'],
  ['`match` / `imatch` (POSIX regex)', (c) => op('i?match').test(query(c)),
    '?col=match. / imatch., negated or not'],
  // The text-search operators carry an optional configuration in parentheses
  // — `?col=fts(english).word` — so the operator is not always followed
  // directly by the dot that op() requires.
  ['`fts` / `plfts` / `phfts` / `wfts`',
    (c) => /=(not\.)?(pl|ph|w)?fts(\([^)]*\))?\./.test(query(c)),
    'any full-text-search operator, with or without a config in parentheses'],
  ['`cs`, `cd`, `ov`, `sl`, `sr`, `adj`', (c) => op('cs|cd|ov|sl|sr|adj|nxl|nxr').test(query(c)),
    'array and range operators'],
  ['`not.` negation', (c) => /=not\./.test(query(c)), '?col=not.<op>.'],
  ['`and=(...)` / `or=(...)` grouping', (c) => /(^|&)(and|or)=\(/.test(query(c)),
    'a top-level and= or or= group'],
  ['`order=`', (c) => /order=/.test(query(c)), 'order= anywhere, including on an embed'],
  ['`limit` / `offset`', (c) => /(^|&|\()(limit|offset)=/.test(query(c)),
    'limit= or offset=, including on an embed'],
  ['`columns=`', (c) => /columns=/.test(query(c)), 'columns= present'],
  ['`on_conflict`', (c) => /on_conflict=/.test(query(c)), 'on_conflict= present'],
  ['JSON path (`->`, `->>`) in the query string', (c) => /->/.test(query(c)), '-> or ->> in the query'],
  ['`!inner` embed', (c) => /!inner/.test(query(c)), '!inner hint on an embed'],
  ['`!left` embed', (c) => /!left/.test(query(c)), '!left hint on an embed'],
  // A disambiguating hint names a foreign key or a table — `!fk_name`,
  // `!clients` — so it is any `!` that is not one of the two join modifiers.
  ['Disambiguating embed hint (`!fk`)', (c) => /!(?!inner|left)[A-Za-z_]/.test(decoded(c)),
    'a ! hint in the select list that is not !inner or !left'],
  // Depth is counted from the parentheses in the select list: one open paren
  // inside another is an embed inside an embed.
  ['Embed nested two or more levels deep', (c) => /\([^()]*\(/.test(decoded(c)),
    'a ( inside a ( in the query'],
  ['Embed nested three or more levels deep', (c) => /\([^()]*\([^()]*\(/.test(decoded(c)),
    'three levels of nested ( in the query'],
  ['Filter on an embedded resource', (c) => /(^|&)[A-Za-z_]\w*\.[A-Za-z_]\w*=/.test(decoded(c)),
    'a dotted <embed>.<column>= parameter'],
  ['Spread embed (`...table(col)`)', (c) => /(select=|,|\()\.\.\./.test(decoded(c)),
    '... spread operator in a select list'],
  // PostgREST orders an embed with a dotted top-level parameter —
  // `?select=clients(*)&clients.order=name` — not with order= inside the
  // embed's parentheses.
  ['`order` on an embedded resource', (c) => /(^|&)[A-Za-z_][\w.]*\.order=/.test(decoded(c)),
    'a dotted <embed>.order= parameter'],
  ['Cast in a select list (`col::type`)', (c) => /select=[^&]*::/.test(decoded(c)),
    ':: inside select='],
  ['Aggregate in a select list', (c) => /\.(count|sum|avg|max|min)\(\)/.test(decoded(c)),
    'col.sum(), col.count() and friends'],
  ['`Accept: application/vnd.pgrst.object+json`', (c) => /vnd\.pgrst\.object/.test(accept(c)),
    'the singular media type'],
  ['`text/csv`', (c) => /text\/csv/.test(accept(c)) || /text\/csv/.test(header(c.request, 'content-type')),
    'text/csv requested or sent'],
  ['`Accept-Profile` / `Content-Profile`', (c) => has(c, 'accept-profile') || has(c, 'content-profile'),
    'a schema-selection header'],
  ['JWT in `Authorization`', (c) => has(c, 'authorization') || !!(c.request && c.request.jwt),
    'a bearer token is sent'],
  ['`Content-Range` asserted on the response', (c) => expectsHeader(c, 'content-range'),
    'the assertion checks Content-Range'],
  ['`Vary` asserted on the response', (c) => expectsHeader(c, 'vary'), 'the assertion checks Vary'],
  // Prints 0 / 0. The engine emits Server-Timing, but no extracted case
  // asserts it, so this row records "not measured" rather than letting the
  // header pass as covered.
  ['`Server-Timing` asserted on the response', (c) => expectsHeader(c, 'server-timing'),
    'the assertion checks Server-Timing'],
  ['`HEAD`', (c) => method(c) === 'HEAD', 'HEAD request'],
  ['`OPTIONS`', (c) => method(c) === 'OPTIONS', 'OPTIONS request'],
  ['`PATCH`', (c) => method(c) === 'PATCH', 'PATCH request'],
  ['`PUT`', (c) => method(c) === 'PUT', 'PUT request'],
  ['`DELETE`', (c) => method(c) === 'DELETE', 'DELETE request'],
  ['RPC via `GET /rpc/...`', (c) => method(c) === 'GET' && /^\/rpc\//.test(pathOf(c)), 'GET on /rpc/'],
  ['RPC via `POST /rpc/...`', (c) => method(c) === 'POST' && /^\/rpc\//.test(pathOf(c)), 'POST on /rpc/'],
];

export function loadCases(dir = CASES_DIR) {
  const byId = new Map();
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    for (const testCase of parsed.cases || parsed) byId.set(testCase.id, testCase);
  }
  return byId;
}

export function featureTable(results, byId = loadCases()) {
  const rows = [];
  for (const [name, predicate, basis] of FEATURES) {
    let passed = 0; let ran = 0; let excluded = 0; let unmatched = 0;
    for (const record of results.cases) {
      const testCase = byId.get(record.id);
      if (!testCase) { unmatched++; continue; }
      let matches = false;
      try { matches = predicate(testCase); } catch { matches = false; }
      if (!matches) continue;
      if (record.status === 'pass') { passed++; ran++; } else if (record.status === 'fail') { ran++; } else excluded++;
    }
    rows.push({ name, basis, passed, ran, excluded, unmatched,
      rate: ran ? Math.round((100 * passed) / ran) : null });
  }
  // Descending by rate so the table reads as "what you can rely on" first;
  // features with no measurement sort last rather than as 0%.
  rows.sort((a, b) => (b.rate ?? -1) - (a.rate ?? -1) || a.name.localeCompare(b.name));
  return rows;
}

function main(argv) {
  const resultsPath = argv.includes('--results')
    ? argv[argv.indexOf('--results') + 1] : DEFAULT_RESULTS;
  const results = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));
  const rows = featureTable(results);
  if (argv.includes('--markdown')) {
    console.log('| Request feature | Passed / ran | Rate | Excluded |');
    console.log('|---|---|---|---|');
    for (const r of rows) {
      console.log(`| ${r.name} | ${r.passed} / ${r.ran} | ${r.rate === null ? '—' : `${r.rate}%`} | ${r.excluded} |`);
    }
    return;
  }
  console.log(`${resultsPath}: ${results.totals.passed}/${results.totals.passed + results.totals.failed} overall`);
  for (const r of rows) {
    console.log(`${`${r.passed}/${r.ran}`.padEnd(10)} ${String(r.rate === null ? '—' : `${r.rate}%`).padEnd(5)} `
      + `excluded ${String(r.excluded).padEnd(4)} ${r.name}  [${r.basis}]`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2));
