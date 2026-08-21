#!/usr/bin/env node
// Builds compatreport/index.html from the conformance results.
//
//   node conformance/report/build-report.mjs
//   node conformance/report/build-report.mjs --results conformance/results/run-...json
//
// Inputs  : conformance/results/latest.json      (see CONTRACTS.md §3)
//           conformance/fixtures/load-report.json (see CONTRACTS.md §2)
// Output  : compatreport/index.html              (see CONTRACTS.md §4)
// Updates : conformance/results/history.json     (trend, see below)
//
// The report is self-contained: no network fetches at view time, no chart
// library, all data inlined in a <script type="application/json"> tag. Every
// number is read from the inputs; nothing here is hand-maintained except the
// short GAP_NOTES annotations and the fixability classification, both of which
// are marked as such in the output.
//
// history.json accumulates one entry per measured run so the report can show
// progress rather than a snapshot. It is append-only in practice: a run is
// keyed by `label` + `generatedAt`, so re-running the builder on the same
// results file overwrites that entry and leaves every other one alone.
//
//   { "runs": [ { "label", "generatedAt", "commit", "target", "results",
//                 "flags", "note", "totals", "byCategory" } ] }
//
// `runs` is sorted oldest first. `runs[0]` is the baseline the report compares
// against. `flags` is the runner flags the numbers were measured with, because
// a run without --reload-per-spec is not comparable to one with it.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');

// ---------------------------------------------------------------- args

const USAGE = `usage: build-report.mjs [options]

  --results FILE       run results to report on (default conformance/results/latest.json)
  --load-report FILE   fixture load report (default conformance/fixtures/load-report.json)
  --out FILE           HTML output (default compatreport/index.html)
  --history FILE       trend file (default conformance/results/history.json)
  --label NAME         name for this run in the trend (default: its commit)
  --flags "..."        runner flags the results were measured with, recorded
                       verbatim in the trend so incomparable runs are visible
  --note "..."         one-line note stored with the trend entry
  --tree SHA           the tree these results measure, when it is not the
                       results file's own commit field (a run measured on an
                       uncommitted working tree records the parent commit).
                       Runs sharing a tree are repeat measurements of one
                       engine, never progress, and the report says so.
  --cedar FILE         Cedar equivalence results, reported in its own section
                       and never added to the pass rate (default
                       conformance/cedar/results/latest.json when present)
  --no-history         report without reading or writing the trend file
  --history-only       update the trend file, write no HTML
`;

function parseArgs(argv) {
  const out = {
    results: resolve(REPO, 'conformance/results/latest.json'),
    loadReport: resolve(REPO, 'conformance/fixtures/load-report.json'),
    out: resolve(REPO, 'compatreport/index.html'),
    history: resolve(REPO, 'conformance/results/history.json'),
    label: null,
    flags: null,
    note: null,
    tree: null,
    cedar: resolve(REPO, 'conformance/cedar/results/latest.json'),
    useHistory: true,
    historyOnly: false
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`${arg} needs a value`);
      i += 1;
      return v;
    };
    if (arg === '--results') out.results = resolve(REPO, next());
    else if (arg === '--load-report') out.loadReport = resolve(REPO, next());
    else if (arg === '--out') out.out = resolve(REPO, next());
    else if (arg === '--history') out.history = resolve(REPO, next());
    else if (arg === '--label') out.label = next();
    else if (arg === '--flags') out.flags = next();
    else if (arg === '--note') out.note = next();
    else if (arg === '--tree') out.tree = next();
    else if (arg === '--cedar') out.cedar = resolve(REPO, next());
    else if (arg === '--no-history') out.useHistory = false;
    else if (arg === '--history-only') out.historyOnly = true;
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write(USAGE);
      process.exit(0);
    } else throw new Error(`unknown argument: ${arg}`);
  }
  return out;
}

// ---------------------------------------------------------------- classification
//
// Fixability labels: engine-fixable, dsql-substitute-needed,
// needs-engine-config, out-of-scope. A gap is dsql-substitute-needed when its
// failures come from something Aurora DSQL does not have, whether or not a
// substitute is possible; everything else that failed is engine work. The
// needs-engine-config gap gets its own label because it is a missing engine
// switch, not a defect. Gaps with no `fail` cases are excluded from the pass
// rate and are labelled out-of-scope.
//
// `harness-supplies-unverified-identity` is deliberately in neither set below:
// it is a fidelity gap between the harness and the deployed authorizer, and
// putting it in either one would lift the rate for a gap this project owns.
// It takes the default label and stays a counted failure.

const DSQL_SUBSTITUTE_NEEDED = new Set([
  // `no-foreign-keys` used to be here. The substitute now exists and is
  // measured: the engine reads a declared-relationship manifest, which took the
  // gap from 189 failures to 28. What is left is engine work — computed
  // relationships and disambiguation — so the gap is labelled engine-fixable
  // and the note says which of its cases DSQL still blocks.
  'no-set-role', // SET ROLE + RLS unavailable; needs engine-side authorization
  // Every failure here is DSQL's, not the engine's: 19 name a text search
  // configuration DSQL's pg_ts_config does not contain and 5 use a tsvector
  // column or argument DSQL rejects. The operators themselves pass with the
  // one configuration DSQL has. 2 more used to land here as mislabelled
  // ordering failures; the runner now attributes those to
  // row-order-unspecified, and the note says which they were.
  'missing-operator-fts',
  // Moved out of engine-fixable in the published run, because the gap changed
  // category rather than because the label was wrong before. Until this wave
  // these cases were scored `blocked`: the harness attributed them to the
  // fixture drop by matching the engine's own PGRST204 wording. The engine now
  // answers with PostgreSQL's 42703 for an unknown column, which is upstream's
  // behaviour, so they entered the denominator as failures for the first time.
  // Every one of the 54 is a filter or JSON operator naming a column DSQL
  // refused to create; verified case by case in the published run, where every
  // reason string reads `column <relation>.<column> does not exist`. No engine
  // change can make them pass and there is no substitute for the column type,
  // so labelling them engine work would put 54 cases on a backlog that cannot
  // be worked.
  'unimplemented-feature-filters',
  'unimplemented-feature-json-operators'
]);

// Failures that assert something this architecture deliberately does not
// promise. Still counted as failures in the headline — only the label differs.
const OUT_OF_SCOPE_FAILURES = new Set(['row-order-unspecified']);

// Fixture-drop families that are permanent properties of Aurora DSQL rather
// than a backlog item: the construct cannot be created, so the assertions that
// need it cannot run on this database however good the engine gets. The value
// says why there is no substitute (or what the substitute is, when one exists).
// Families not listed here are consequences (a cascade from a dropped object),
// harness mechanics (COPY from a file, schema teardown) or transform
// workarounds, and are left out of the "permanent" table rather than inflating
// it. Every family, permanent or not, still appears in the DSQL section below.
const PERMANENT_ON_DSQL = {
  'FOREIGN KEY constraints': {
    why: 'DSQL rejects FOREIGN KEY and ALTER TABLE ADD CONSTRAINT, and pg_constraint returns no rows for contype=\'f\'.',
    substitute: 'A declared-relationship manifest (<code>PGREST_RELATIONSHIPS_PATH</code>) replaces the catalog for embedding. Measured, and the reason the embedding category runs at all.'
  },
  'plpgsql functions': {
    why: 'CREATE FUNCTION ... LANGUAGE plpgsql is rejected. LANGUAGE sql works, including RETURNS SETOF and RETURNS TABLE.',
    substitute: 'None for a body that needs procedural code. The dependent cases are blocked, never scored.'
  },
  triggers: {
    why: 'CREATE TRIGGER needs a plpgsql function, so it fails for the same reason.',
    substitute: 'None.'
  },
  'column types DSQL rejects': {
    why: 'Arrays (integer[], int[][]), ranges (numrange, int4range), money, xml, tsvector and the geometric types are rejected as column types. Arrays and ranges still work in expressions and as function arguments.',
    substitute: 'None. The operators are implemented and unit-tested; this suite cannot confirm them because upstream tests them through columns.'
  },
  'domain base types DSQL rejects': {
    why: 'A domain over a type DSQL will not store is rejected with the same error as the type.',
    substitute: 'None.'
  },
  'CREATE TYPE (enum / composite)': {
    why: 'CREATE TYPE is rejected for both enums and composites.',
    substitute: 'None.'
  },
  extensions: {
    why: 'CREATE EXTENSION is rejected, so postgis, citext, ltree, hstore and isn are all absent.',
    substitute: 'None.'
  },
  'partitioned tables': {
    why: 'PARTITION BY and PARTITION OF are rejected.',
    substitute: 'None.'
  },
  'materialized views': {
    why: 'DSQL rejects the CreateTableAs statement a materialized view compiles to.',
    substitute: 'None.'
  },
  'user-defined aggregates': { why: 'CREATE AGGREGATE is rejected.', substitute: 'None.' },
  'user-defined casts': { why: 'CREATE CAST is rejected.', substitute: 'None.' },
  rules: { why: 'CREATE RULE is rejected.', substitute: 'None.' },
  procedures: { why: 'CREATE PROCEDURE is rejected.', substitute: 'None.' },
  'CREATE TABLE AS': { why: 'CREATE TABLE AS is rejected.', substitute: 'None.' },
  'namespaced run-time parameters (response.*, request.*)': {
    why: 'set_config(\'response.headers\', ...) and SET "request.jwt.claims" are both rejected, and because DSQL parses SQL function bodies at CREATE time the SET form also fails the CREATE FUNCTION.',
    substitute: 'None. PostgREST\'s GUC-driven response headers and claim passing have no equivalent here; those cases are reported out of scope.'
  },
  'session settings DSQL rejects': {
    why: 'ALTER DATABASE ... SET and session GUCs, including role, are rejected.',
    substitute: 'None. This is also why SET ROLE and row-level security are unreachable, so PostgREST\'s authorization model has to be replaced by engine-side authorization.'
  },
  'functions returning or taking an unsupported type': {
    why: 'A function whose signature names a type DSQL will not store fails at CREATE time.',
    substitute: 'None.'
  },
  'DSQL 10-schema limit': {
    why: 'DSQL allows at most 10 schemas per database.',
    substitute: 'None. The skipped schema only held postgis and isn objects DSQL cannot create anyway.'
  },
  'writes to pg_catalog': {
    why: 'pg_catalog is not writable on DSQL.',
    substitute: 'None.'
  },
  'tables where every column type is unsupported': {
    why: 'Nothing is left of the table once DSQL rejects every column type in it.',
    substitute: 'None.'
  }
};

const LABELS = {
  'engine-fixable': 'engine-fixable',
  'dsql-substitute-needed': 'dsql-substitute-needed',
  'needs-engine-config': 'needs-engine-config',
  'out-of-scope': 'out-of-scope'
};

function classifyGap(slug, statuses) {
  if (slug === 'needs-engine-config') return 'needs-engine-config';
  const fails = statuses.fail || 0;
  if (fails === 0) return 'out-of-scope';
  if (DSQL_SUBSTITUTE_NEEDED.has(slug)) return 'dsql-substitute-needed';
  if (OUT_OF_SCOPE_FAILURES.has(slug)) return 'out-of-scope';
  return 'engine-fixable';
}

// Hand-written one-liners for the gaps big enough to need explaining. Absent
// entries fall back to the measured symptom taken from the first case reason.
const GAP_NOTES = {
  'no-foreign-keys':
    'DSQL stores no foreign keys, so <code>pg_constraint</code> reports none and the engine reads its relationships from the declared manifest instead (<code>PGREST_RELATIONSHIPS_PATH</code>, reconstructed by the fixture transform into conformance/fixtures/relationships.json). What is left is what a manifest of foreign keys cannot express: relationships upstream derives from a view\'s column provenance rather than from a constraint, and disambiguation between two relationships that join the same pair of relations. Measured without the manifest on commit <code>3fbf941</code>, this gap was 189 failures — the trend above keeps that run for comparison.',
  'unimplemented-json-path':
    'Top-level JSON paths work. What fails is a JSON path used to pick a column inside an embedded resource (<code>trash_details(jsonb_col-&gt;key)</code>), which the embed resolver reports as a missing column.',
  'unimplemented-feature-aggregates':
    'Aggregates in a top-level select list parse and emit GROUP BY. What is left is aggregates inside a spread embed (<code>...processes(cost.sum())</code>): the engine computes them per parent row instead of grouping at the parent level, which is also what the larger <code>body-mismatch-aggregates</code> gap is.',
  'missing-operator-fts':
    'The <code>fts</code>, <code>plfts</code>, <code>phfts</code> and <code>wfts</code> operators are implemented and upstream cases pass with them. In the published run 24 of these failures are DSQL\'s: 19 name a text search configuration (<code>english</code>, <code>french</code>, <code>german</code>) that DSQL\'s <code>pg_ts_config</code> does not contain, and 5 use a <code>tsvector</code> column or function DSQL dropped at fixture load. There is no substitute — DSQL ships one configuration, <code>simple</code>, which is what <code>PGREST_DEFAULT_TS_CONFIG</code> is set to for these runs. Earlier runs reported 26 here, 2 of them mislabelled: <code>RpcSpec:985</code> and <code>RpcSpec:997</code> failed with the runner\'s own reason text reading "same rows, different order", which is an order-dependent failure and not a missing text search configuration. <code>conformance/runner/run.mjs</code> now attributes an order-only difference to <code>row-order-unspecified</code> whatever the log says, so those 2 are counted below instead and this gap no longer absorbs them. That correction did not move a case from failing to passing.',
  'unimplemented-feature-filters':
    'Moved out of <code>engine-fixable</code> in this run. All 39 failures are a filter on a column Aurora DSQL refused to create — <code>entities.arr</code> (20), <code>ranges.range</code> (15), <code>entities.text_search_vector</code> (2), <code>complex_items.arr_data</code> (2) — and every reason string in the published run reads <code>column … does not exist</code>, PostgreSQL\'s own 42703, which is what upstream answers for an unknown column (QuerySpec.hs:1556). The operators are implemented and unit-tested; upstream only exercises them through array, range and tsvector columns, and DSQL stores none of those. These cases were <code>blocked</code> until this wave, when the engine stopped answering <code>PGRST204</code> and the harness\'s drop-attribution stopped recognising them, so this is the gap changing category rather than a relabelled backlog: the count of cases DSQL makes impossible did not change, only which bucket they are reported in.',
  'unimplemented-feature-json-operators':
    'Moved out of <code>engine-fixable</code> in this run, for the same reason as <code>unimplemented-feature-filters</code> and with the same evidence. All 15 failures apply a JSON operator to an array column DSQL refused to create — <code>arrays.numbers</code> (6), <code>fav_numbers.num</code> (5), <code>arrays.numbers_mult</code> (4) — and answer 42703. The <code>json-operators</code> category passes 46 of the 62 cases that reach a column DSQL can store.',
  'no-set-role':
    'Upstream asserts authorization performed with SET ROLE + GRANT + RLS. DSQL rejects SET ROLE and has no RLS, so the engine needs its own authorization model to answer the same 401/403 bodies. Smaller in this run than in earlier ones by 7 cases, which have not started passing: they assert a rejected token and are now reported under <code>harness-supplies-unverified-identity</code>, still failing, because the reason they fail is the harness\'s identity handling rather than a missing privilege model. The Cedar layer that stands in for SET ROLE is measured separately and is never added to this rate — see docs/reference/cedar-equivalence.md.',
  'harness-supplies-unverified-identity':
    'Upstream expects <code>PGRST301</code> — the token is rejected before any privilege is consulted. The engine answers <code>PGRST403</code> instead, because the conformance harness builds the API Gateway authorizer context by decoding the JWT payload <em>without verifying it</em>, so the request reaches the authorization layer and is denied by policy rather than turned away at the door. 7 cases: <code>AuthSpec:96</code>, <code>:119</code>, <code>ErrorSpec:53</code>, <code>:110</code>, <code>:193</code>, <code>:205</code>, <code>:217</code>. <strong>They stay failures in the rate.</strong> The deployed <code>src/authorizer/index.mjs</code> does verify signature, <code>exp</code> and <code>alg</code>, so this is a fidelity gap between the harness and the deployment, not a claim that the engine accepts bad tokens — and it is not evidence that it rejects them either, since nothing here measured that path. The label is <code>engine-fixable</code> because nothing in DSQL prevents closing it, but the work is in the harness\'s identity handling, not in a query feature. Before this run these 7 were scattered across <code>no-set-role</code> and three body/header mismatch gaps, which read as four unrelated defects instead of one.',
  'extraction-skipped':
    'Haskell the extractor cannot evaluate without guessing: higher-order helpers whose request headers arrive as a parameter, bodies read from a fixture file, paths taken from a previous response, expectations behind a PostgreSQL version check. Never guessed: skipped and counted outside the pass rate.',
  'needs-engine-config':
    'The assertion only holds when the PostgREST process runs with a non-default setting the engine has no switch for (a different exposed schema, an extra search path, a row limit, a pre-request function, an aggregate or plan feature flag). A missing engine feature rather than a harness limitation, so it is reported apart from the skips; adding the switch moves these into the denominator, where they will fail until the behaviour behind it exists.',
  'fixture-missing':
    'The object the case needs does not exist on DSQL. Each one is named with its drop reason in conformance/fixtures/load-report.json.',
  'engine-error':
    'The database raised an error the engine does not translate into the PostgREST body upstream returns: both cases insert through a view DSQL will not write to (SQLSTATE 55000), where upstream returns 201.',
  'no-plpgsql': 'The fixture function is plpgsql, which DSQL cannot create.',
  'row-order-unspecified':
    'Same rows, different order. DSQL does not promise a physical row order and adding an implicit ORDER BY would change engine semantics. Counted as a failure here, not hidden.',
  'no-custom-gucs':
    'Namespaced run-time parameters (<code>response.headers</code>, <code>request.*</code> claims). DSQL rejects set_config on them and rejects the CREATE FUNCTION whose body contains the SET.'
};

// Disclosures an adversarial audit of the published run produced that no input
// file can compute: they are about how a pass was reached, not about whether it
// was reached. Editorial, like GAP_NOTES, and marked as such where rendered.
// Each one cites what was run so a reader can repeat it. Add an entry when an
// audit finds a pass whose cause is not what the case name suggests; never
// delete one to tidy the page up.
const AUDITED_DISCLOSURES = [
  {
    title: '3 of the passes cannot tell their setting apart',
    body: 'The harness now boots <code>PreparedStatementsSpec</code> twice, once with '
      + '<code>db-prepared-statements=true</code> and once with <code>false</code>, and all three '
      + 'of its cases pass both ways. They pass because nothing in <code>src/rest/</code> reads '
      + 'that setting: it is parsed in <code>src/index.mjs</code> and put on the request context, '
      + 'and no query path consults it (<code>grep -rn dbPreparedStatements src/</code> returns '
      + 'two hits, neither in the engine). <code>PreparedStatementsSpec:25</code> asserts a bare '
      + '<code>200</code>, so it cannot distinguish the two values even in principle. Read those '
      + 'three as "the switch is accepted", not "prepared statements behave as upstream". '
      + '<code>docs/reference/configuration.md</code> documents the setting as inert.'
  },
  {
    title: '23 of the gains ride on the data-representations manifest, not on catalog reading',
    body: 'DSQL rejects <code>CREATE CAST</code>, so all 15 casts upstream\'s <code>schema.sql</code> '
      + 'defines are dropped at fixture load and <code>pg_cast</code> reports nothing for the engine '
      + 'to read. <code>conformance/fixtures/representations.json</code> declares those 15 pairs and '
      + 'the runner points <code>PGREST_REPRESENTATIONS_PATH</code> at it by default for '
      + '<code>--target dsql</code>. 23 cases that were failures in the last comparable run pass '
      + 'because of it — <code>ComputedRelsSpec:110/123/129</code>, '
      + '<code>QuerySpec:1549</code>…<code>1650</code> (16 cases), <code>InsertSpec:802</code> and '
      + '<code>UpdateSpec:649/660/682</code>. The manifest is a substitute for a catalog DSQL cannot '
      + 'populate, exactly like the relationship manifest, and it is not tuned to pass everything: '
      + '11 data-representation cases still fail with it in place. But a reader is entitled to know '
      + 'that 23 of this wave\'s gains are configuration-enabled, and that on a database with '
      + '<code>pg_cast</code> the engine reads them from the catalog instead.'
  }
];

// Why this results file and not another run of the same tree. The rule is in
// compatreport/README.md: do not publish the run measured by the pass that wrote
// the code, and prefer the middle of the observed range to the top of it. The
// spread beside this note is computed; the reasoning is not, so it is editorial.
const PUBLISHED_RUN_CHOICE =
  'This report is built from the run an independent audit pass measured, not from the run the '
  + 'pass that wrote the engine changes measured, and not from the highest run of the tree. Of the '
  + 'four full-suite runs of this tree in the trend, the implementation pass\'s own run is the '
  + 'lowest and two later runs are the highest; the published one sits between them and is the run '
  + 'whose measurement was reported by a pass with no code in the result. Every one of the four is '
  + 'in the trend above with its own row, so the spread is visible rather than curated, and every '
  + 'case that differs between them is either an order-unspecified assertion or an upsert that '
  + 'depends on sequence state a data-only fixture reload does not restore.';

// Cedar equivalence is a second measurement of a different question. These lines
// state what it is not, and are rendered with it every time.
const CEDAR_DO_NOT_READ = [
  'It is not a PostgREST pass rate and is never added to one. The upstream cases it derives from '
    + 'stay failures in this report\'s denominator — they are not excluded, not marked out of scope '
    + 'and not skipped.',
  'A holding equivalence means a Cedar <code>permit</code> standing in for a <code>GRANT</code> '
    + 'produced the same status, body and asserted headers. It does not mean row-level security was '
    + 'exercised: the table behind most of them is empty in the fixtures, and the harness supplies '
    + 'the identity from the JWT payload rather than the engine verifying it.',
  'The denominator is the derived cases, not the 54 upstream cases they cover. 26 of those 54 have '
    + 'no fair equivalent and are counted in neither the numerator nor the denominator.',
  'It has no external referee. This project chose which cases are about authorization, wrote the '
    + 'policy set and wrote the runner. The PostgREST rate above has upstream\'s own assertions as '
    + 'the referee; this number does not.'
];

// ---------------------------------------------------------------- grouping helpers

/** First line of a runner reason — the measured symptom, without the diff. */
function firstLine(reason) {
  if (!reason) return null;
  const line = String(reason).split('\n')[0].trim();
  return line.length > 240 ? `${line.slice(0, 237)}...` : line;
}

/** Collapse the ~100 distinct fixture drop reasons into families. */
function dropFamily(reason) {
  const r = String(reason || 'unknown');
  const rules = [
    [/^FOREIGN KEY constraint not supported/i, 'FOREIGN KEY constraints', 'recovered in relationships.json'],
    [/language plpgsql not supported/i, 'plpgsql functions', null],
    [/CREATE TRIGGER not supported/i, 'triggers', 'trigger bodies need plpgsql'],
    [/^column type (.+) not supported/i, 'column types DSQL rejects', null],
    [/^base type (.+) not supported/i, 'domain base types DSQL rejects', null],
    [/^CREATE TYPE/i, 'CREATE TYPE (enum / composite)', null],
    [/^CREATE EXTENSION/i, 'extensions', null],
    [/^CREATE AGGREGATE/i, 'user-defined aggregates', null],
    [/^CREATE CAST/i, 'user-defined casts', null],
    [/^CREATE RULE/i, 'rules', null],
    [/PARTITION BY|PARTITION OF/i, 'partitioned tables', null],
    [/materialized views? not supported/i, 'materialized views', null],
    [/^CREATE TABLE AS/i, 'CREATE TABLE AS', null],
    [/^PROCEDURE is not supported/i, 'procedures', null],
    [/^COPY to\/from file/i, 'COPY from file', null],
    [/response\.headers|request\.jwt/i, 'namespaced run-time parameters (response.*, request.*)', null],
    [/ALTER DATABASE .* SET|session GUC|configuration parameter/i, 'session settings DSQL rejects', null],
    [/which DSQL cannot produce|does not exist on DSQL/i, 'functions returning or taking an unsupported type', null],
    [/^depends on |^references (relation|column|type) |was dropped$/i,
      'cascade: needs an object DSQL could not create', null],
    [/DROP of this object kind|object kind not supported|unsupported COMMENT|must be owner of schema public|already exists/i,
      'schema teardown / COMMENT statements DSQL rejects', null],
    [/every column uses a type DSQL does not support/i, 'tables where every column type is unsupported', null],
    [/writing to pg_catalog/i, 'writes to pg_catalog', null],
    [/explicit transaction removed/i, 'multi-DDL transactions', null],
    [/schemas? limit|more than 10 schemas/i, 'DSQL 10-schema limit', null],
    [/every schema in this grant/i, 'GRANTs on skipped schemas', null],
    [/cannot be rewritten mechanically/i, 'DML the transform cannot rewrite', null]
  ];
  for (const [re, family, note] of rules) if (re.test(r)) return { family, note };
  return { family: r.length > 70 ? `${r.slice(0, 67)}...` : r, note: null };
}

/** Collapse extraction skip reasons into families. First match wins. */
function skipFamily(reason) {
  const r = String(reason || 'unknown');
  const m = r.match(/requires non-default PostgREST config \(([^)]*)\)/);
  if (m) return { family: 'needs non-default PostgREST process config', detail: m[1] };
  if (/off by default/.test(r))
    return { family: 'asserts a PostgREST feature that is off by default', detail: null };
  if (/matchHeaderAbsent|header is absent|header substring|substring of/.test(r))
    return { family: 'header-absence / substring matcher the case format cannot carry', detail: null };
  if (/not representable|not a literal|unresolved/.test(r))
    return { family: 'request or expectation is not literal in the Haskell source', detail: null };
  if (/preceding assertion in the same example was skipped/.test(r))
    return { family: 'cascades from a skipped step in the same test', detail: null };
  if (/custom matchBody|readFixtureFile|helper/.test(r))
    return { family: 'non-literal Haskell matcher', detail: null };
  return { family: r.length > 70 ? `${r.slice(0, 67)}...` : r, detail: null };
}

function bump(map, key, init) {
  if (!map.has(key)) map.set(key, init());
  return map.get(key);
}

function topN(counts, n) {
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}

// ---------------------------------------------------------------- trend / history

const HISTORY_DESCRIPTION =
  'One entry per measured conformance run, oldest first. runs[0] is the '
  + 'baseline the compatibility report compares against. Written by '
  + 'conformance/report/build-report.mjs; an entry is keyed by label + '
  + 'generatedAt, so rebuilding the report from the same results file updates '
  + 'that entry and leaves the rest of the trend intact. `flags` records the '
  + 'runner flags the numbers were measured with: a run without '
  + '--reload-per-spec is not comparable to one with it.';

const COUNT_KEYS = [
  'total', 'passed', 'failed', 'skipped', 'needsConfig', 'blocked', 'outOfScope', 'errored'
];

/** Keep only the counts, defaulting the ones an older results file lacks. */
export function normalizeCounts(counts = {}) {
  const out = {};
  for (const k of COUNT_KEYS) out[k] = counts[k] || 0;
  return out;
}

/**
 * The engine tree a run measured. A results file records the commit that was
 * checked out, which is not the same thing: a run measured on an uncommitted
 * working tree records the parent commit and would otherwise look like a
 * measurement of a different engine. `tree` overrides it when the caller knows
 * better, so two runs of one engine are recognised as repeats rather than as
 * progress.
 */
export function treeOf(run) {
  return run?.tree || run?.commit || null;
}

/** A history entry for one results file. Counts only — everything else derived. */
export function entryFromResults(results, opts = {}) {
  return {
    label: opts.label || results.commit || 'unlabelled',
    generatedAt: results.generatedAt || null,
    commit: results.commit || null,
    ...(opts.tree ? { tree: opts.tree } : {}),
    target: results.target || null,
    results: opts.resultsPath ? relative(REPO, opts.resultsPath) : null,
    flags: opts.flags ?? null,
    note: opts.note ?? null,
    totals: normalizeCounts(results.totals),
    byCategory: Object.fromEntries(
      Object.entries(results.byCategory || {}).map(([name, c]) => [name, normalizeCounts(c)])
    )
  };
}

/**
 * Add (or replace) one run in the trend. Same label + timestamp replaces;
 * anything else appends. Result is sorted oldest first, so runs[0] is the
 * baseline.
 */
export function appendRun(history, entry) {
  const runs = Array.isArray(history?.runs) ? history.runs.slice() : [];
  const at = runs.findIndex(
    (r) => r.label === entry.label && r.generatedAt === entry.generatedAt
  );
  if (at >= 0) runs[at] = entry;
  else runs.push(entry);
  runs.sort((a, b) => String(a.generatedAt).localeCompare(String(b.generatedAt)));
  return { description: HISTORY_DESCRIPTION, runs };
}

function summarizeRun(run) {
  const t = normalizeCounts(run.totals);
  const ran = t.passed + t.failed;
  return {
    label: run.label,
    generatedAt: run.generatedAt,
    commit: run.commit || null,
    tree: treeOf(run),
    flags: run.flags || null,
    note: run.note || null,
    passed: t.passed,
    failed: t.failed,
    ran,
    rate: ran ? t.passed / ran : null,
    total: t.total,
    blocked: t.blocked,
    needsConfig: t.needsConfig,
    skipped: t.skipped,
    outOfScope: t.outOfScope
  };
}

/**
 * Baseline vs current, overall and per category. `runs` is the whole trend
 * (oldest first); the last entry is the current run.
 */
export function buildTrend(runs) {
  if (!Array.isArray(runs) || runs.length === 0) return null;
  const baselineRun = runs[0];
  const currentRun = runs[runs.length - 1];
  const baseline = summarizeRun(baselineRun);
  const current = summarizeRun(currentRun);

  const names = new Set([
    ...Object.keys(baselineRun.byCategory || {}),
    ...Object.keys(currentRun.byCategory || {})
  ]);
  const categories = [...names]
    .map((name) => {
      const b = baselineRun.byCategory?.[name];
      const c = currentRun.byCategory?.[name];
      const bc = normalizeCounts(b || {});
      const cc = normalizeCounts(c || {});
      const bRan = bc.passed + bc.failed;
      const cRan = cc.passed + cc.failed;
      return {
        name,
        measuredAtBaseline: Boolean(b),
        baselinePassed: bc.passed,
        baselineRan: bRan,
        baselineRate: bRan ? bc.passed / bRan : null,
        passed: cc.passed,
        ran: cRan,
        rate: cRan ? cc.passed / cRan : null,
        deltaPassed: cc.passed - bc.passed,
        deltaRan: cRan - bRan
      };
    })
    .sort((a, b) => b.deltaPassed - a.deltaPassed || a.name.localeCompare(b.name));

  return {
    baseline,
    current,
    runs: runs.map(summarizeRun),
    categories,
    sameFlags: (baseline.flags || '') === (current.flags || ''),
    isSelfComparison: runs.length === 1,
    deltaPassed: current.passed - baseline.passed,
    deltaFailed: current.failed - baseline.failed,
    deltaRan: current.ran - baseline.ran,
    deltaRate:
      current.rate === null || baseline.rate === null ? null : current.rate - baseline.rate,
    improved: categories.filter((c) => c.deltaPassed > 0).length,
    regressed: categories.filter((c) => c.deltaPassed < 0)
  };
}

/**
 * Case-level delta between two runs, matched by case id. This is the honest
 * comparison when two runs were measured with different runner flags: totals
 * can move because the denominator moved, but a case id that went from a
 * non-pass status to `pass` is a real change and a case that went the other way
 * is a real regression. `gained` / `lost` never net each other out here.
 */
export function idMatchedDelta(baselineCases, currentCases) {
  const before = new Map((baselineCases || []).map((c) => [c.id, c.status]));
  const transitions = new Map();
  let matched = 0;
  let gained = 0;
  let lost = 0;
  let onlyInCurrent = 0;
  for (const c of currentCases || []) {
    const was = before.get(c.id);
    if (was === undefined) {
      onlyInCurrent += 1;
      continue;
    }
    matched += 1;
    const key = `${was} → ${c.status}`;
    transitions.set(key, (transitions.get(key) || 0) + 1);
    if (was !== 'pass' && c.status === 'pass') gained += 1;
    if (was === 'pass' && c.status !== 'pass') lost += 1;
  }
  const seen = new Set((currentCases || []).map((c) => c.id));
  const onlyInBaseline = [...before.keys()].filter((id) => !seen.has(id)).length;
  return {
    matched,
    gained,
    lost,
    onlyInCurrent,
    onlyInBaseline,
    transitions: [...transitions.entries()].sort((a, b) => b[1] - a[1])
  };
}

/** Cases the runner classified as order-dependent, and still counted as failures. */
export function rowOrderFailures(cases) {
  const hits = (cases || []).filter(
    (c) => c.gap === 'row-order-unspecified' && c.status === 'fail'
  );
  return { count: hits.length, ids: hits.map((c) => c.id) };
}

/**
 * The measured cost of per-spec fixture reload, taken from the trend rather than
 * asserted. Only a pair of runs on the same commit whose flags differ by nothing
 * except `--reload-per-spec` is quotable; anything else would mix an engine
 * change into the number. Returns the newest such pair, or nulls.
 */
export function isolationEvidence(runs) {
  const reload = (r) => /--reload-per-spec/.test(r.flags || '');
  const withoutFlag = (r) =>
    (r.flags || '')
      .replace(/--reload-per-spec/g, '')
      .replace(/\s+/g, ' ')
      .replace(/\s*,\s*/g, ', ')
      .trim();
  const ordered = [...(runs || [])].reverse();
  for (const a of ordered) {
    if (!reload(a) || !a.commit) continue;
    const b = ordered.find(
      (r) => r !== a && !reload(r) && r.commit === a.commit && withoutFlag(r) === withoutFlag(a)
    );
    if (b) return { withReload: a, withoutReload: b };
  }
  return { withReload: null, withoutReload: null };
}

// ---------------------------------------------------------------- model

/**
 * The Cedar equivalence measurement, as a section of its own. Two things are
 * checked here rather than restated: that the upstream cases it derives from are
 * still failures in *this* results file, and how many of them are. If a derived
 * case's upstream original ever stopped being a failure, this measurement would
 * be double-counting a pass, and the report would say so instead of hiding it.
 */
function buildCedar(cedar, results) {
  if (!cedar?.summary) return null;
  const s = cedar.summary;
  const byId = new Map((results.cases || []).map((c) => [c.id, c]));
  const upstreamIds = [
    ...new Set([
      ...(cedar.outcomes || []).map((o) => o.upstreamId),
      ...(cedar.noFairEquivalent || []).map((o) => o.upstreamId)
    ])
  ].filter(Boolean);
  const upstreamStatus = {};
  for (const id of upstreamIds) {
    const status = byId.get(id)?.status || 'not in this run';
    upstreamStatus[status] = (upstreamStatus[status] || 0) + 1;
  }
  return {
    generatedAt: cedar.generatedAt || null,
    commit: cedar.commit || null,
    target: cedar.target || null,
    ran: s.equivalencesRan || 0,
    hold: s.equivalencesHold || 0,
    diverge: s.equivalencesDiverge || 0,
    divergenceKinds: Object.entries(s.divergenceKinds || {}),
    noFairEquivalent: s.noFairEquivalent || 0,
    noFairEquivalentByClass: Object.entries(s.noFairEquivalentByClass || {})
      .sort((a, b) => b[1] - a[1]),
    upstreamCasesCovered: s.upstreamCasesCovered || upstreamIds.length,
    upstreamStatus: Object.entries(upstreamStatus).sort((a, b) => b[1] - a[1]),
    upstreamAllFailing: Object.keys(upstreamStatus).every((k) => k === 'fail'),
    notThePostgrestRate: s.notThePostgrestRate || null,
    doNotRead: CEDAR_DO_NOT_READ
  };
}

function buildModel(results, loadReport, trend = null, cedar = null) {
  const t = results.totals;
  const ran = (t.passed || 0) + (t.failed || 0);
  const excluded = (t.skipped || 0) + (t.needsConfig || 0)
    + (t.blocked || 0) + (t.outOfScope || 0);

  // ---- gaps
  const gapMap = new Map();
  for (const c of results.cases) {
    if (c.status === 'pass') continue;
    const slug = c.gap || '(ungrouped)';
    const g = bump(gapMap, slug, () => ({
      slug,
      cases: 0,
      statuses: {},
      categories: new Map(),
      symptoms: new Map(),
      examples: []
    }));
    g.cases += 1;
    g.statuses[c.status] = (g.statuses[c.status] || 0) + 1;
    g.categories.set(c.category, (g.categories.get(c.category) || 0) + 1);
    const sym = firstLine(c.reason);
    if (sym) g.symptoms.set(sym, (g.symptoms.get(sym) || 0) + 1);
    if (g.examples.length < 4) g.examples.push(c.id);
  }
  const gaps = [...gapMap.values()]
    .map((g) => ({
      slug: g.slug,
      cases: g.cases,
      statuses: g.statuses,
      counted: (g.statuses.fail || 0) > 0,
      failed: g.statuses.fail || 0,
      fixability: classifyGap(g.slug, g.statuses),
      categories: topN(g.categories, 6),
      symptom: topN(g.symptoms, 1)[0]?.[0] || null,
      examples: g.examples,
      note: GAP_NOTES[g.slug] || null
    }))
    .sort((a, b) => b.cases - a.cases || a.slug.localeCompare(b.slug));

  const byFixability = {
    'engine-fixable': 0,
    'dsql-substitute-needed': 0,
    'needs-engine-config': 0,
    'out-of-scope': 0
  };
  const failuresByFixability = { ...byFixability };
  for (const g of gaps) {
    byFixability[g.fixability] += g.cases;
    failuresByFixability[g.fixability] += g.failed;
  }

  // ---- categories, sorted by gap size (in-scope failures, then blocked)
  const categories = Object.entries(results.byCategory)
    .map(([name, c]) => ({
      name,
      total: c.total || 0,
      passed: c.passed || 0,
      failed: c.failed || 0,
      skipped: c.skipped || 0,
      needsConfig: c.needsConfig || 0,
      blocked: c.blocked || 0,
      outOfScope: c.outOfScope || 0,
      errored: c.errored || 0,
      ran: (c.passed || 0) + (c.failed || 0)
    }))
    .map((c) => ({ ...c, rate: c.ran ? c.passed / c.ran : null }))
    .sort((a, b) => b.failed - a.failed || b.blocked - a.blocked || b.total - a.total);

  // ---- DSQL fixture limitations
  const familyMap = new Map();
  const dsqlCategoryCost = new Map();
  const kindCounts = new Map();
  for (const d of loadReport.dropped || []) {
    const { family, note } = dropFamily(d.reason);
    const f = bump(familyMap, family, () => ({
      family,
      note,
      count: 0,
      kinds: new Map(),
      categories: new Map(),
      objects: [],
      reasons: new Map()
    }));
    f.count += 1;
    f.kinds.set(d.kind || 'unknown', (f.kinds.get(d.kind || 'unknown') || 0) + 1);
    kindCounts.set(d.kind || 'unknown', (kindCounts.get(d.kind || 'unknown') || 0) + 1);
    for (const cat of d.affectsCategories || []) {
      f.categories.set(cat, (f.categories.get(cat) || 0) + 1);
      dsqlCategoryCost.set(cat, (dsqlCategoryCost.get(cat) || 0) + 1);
    }
    if (f.objects.length < 5 && d.object) f.objects.push(d.object);
    f.reasons.set(d.reason, (f.reasons.get(d.reason) || 0) + 1);
  }
  const dropFamilies = [...familyMap.values()]
    .map((f) => ({
      family: f.family,
      note: f.note,
      count: f.count,
      kinds: topN(f.kinds, 5),
      categories: topN(f.categories, 6),
      objects: f.objects,
      distinctReasons: f.reasons.size,
      sampleReasons: topN(f.reasons, 3).map(([r]) => r)
    }))
    .sort((a, b) => b.count - a.count || a.family.localeCompare(b.family));

  // Cases actually lost to a missing fixture, by category.
  const blockedByCategory = new Map();
  const blockedByGap = new Map();
  for (const c of results.cases) {
    if (c.status !== 'blocked') continue;
    blockedByCategory.set(c.category, (blockedByCategory.get(c.category) || 0) + 1);
    blockedByGap.set(c.gap || '(ungrouped)', (blockedByGap.get(c.gap || '(ungrouped)') || 0) + 1);
  }

  // ---- excluded: extraction skips, needs-config, blocked, out-of-scope
  const familiesFor = (status) => {
    const skipMap = new Map();
    for (const c of results.cases) {
      if (c.status !== status) continue;
      const { family, detail } = skipFamily(c.reason);
      const s = bump(skipMap, family, () => ({ family, count: 0, details: new Map() }));
      s.count += 1;
      if (detail) s.details.set(detail, (s.details.get(detail) || 0) + 1);
    }
    return [...skipMap.values()]
      .map((s) => ({ family: s.family, count: s.count, details: topN(s.details, 8) }))
      .sort((a, b) => b.count - a.count);
  };
  const skipFamilies = familiesFor('skip');
  const needsConfigFamilies = familiesFor('needs-config');
  const needsConfigByCategory = new Map();
  for (const c of results.cases) {
    if (c.status !== 'needs-config') continue;
    needsConfigByCategory.set(c.category,
      (needsConfigByCategory.get(c.category) || 0) + 1);
  }

  const outOfScopeCases = results.cases
    .filter((c) => c.status === 'out-of-scope')
    .map((c) => ({ id: c.id, category: c.category, gap: c.gap, reason: firstLine(c.reason) }));

  // ---- zero-pass categories (used in the plain-spoken verdict)
  const zeroPass = categories.filter((c) => c.ran > 0 && c.passed === 0).map((c) => c.name);

  // ---- how to read the number: the three things that bias or bound it
  //
  // 1. fixture isolation. The flags the run was measured with decide this, so
  //    they are read back out of the trend entry rather than assumed.
  const flags = trend?.current?.flags || '';
  const isolation = {
    flags: flags || null,
    reloadPerSpec: /--reload-per-spec/.test(flags),
    targetedReset: /--reset-touched/.test(flags),
    fullReset: /--reset-mutations/.test(flags),
    evidence: trend ? isolationEvidence(trend.runs) : { withReload: null, withoutReload: null },
    // A concrete instance, quoted from this run rather than described: a read
    // that fails because an earlier case in the same spec file wrote the row.
    example: results.cases.find((c) => c.id === 'UpsertSpec:417' && c.status === 'fail') || null
  };

  // 2. order-dependent assertions, left as failures on purpose.
  const rowOrder = {
    ...rowOrderFailures(results.cases),
    byRun: trend?.rowOrderByRun || null
  };

  // 3. what DSQL makes impossible, with the cases it costs. `blocked`,
  //    `out-of-scope` and the `dsql-substitute-needed` failures are three
  //    different accounting buckets for the same underlying cause.
  const permanentFamilies = dropFamilies
    .filter((f) => PERMANENT_ON_DSQL[f.family])
    .map((f) => ({ ...f, ...PERMANENT_ON_DSQL[f.family] }));
  const permanent = {
    families: permanentFamilies,
    droppedObjects: permanentFamilies.reduce((a, f) => a + f.count, 0),
    droppedTotal: (loadReport.dropped || []).length,
    blocked: t.blocked || 0,
    blockedByGap: topN(blockedByGap, 20),
    outOfScope: t.outOfScope || 0,
    dsqlFailures: failuresByFixability['dsql-substitute-needed'],
    dsqlFailureGaps: gaps
      .filter((g) => g.fixability === 'dsql-substitute-needed')
      .map((g) => ({ slug: g.slug, failed: g.failed }))
  };
  permanent.casesTotal = permanent.blocked + permanent.outOfScope + permanent.dsqlFailures;

  // 4. cases that left the denominator since the last comparable run. Every one
  //    of them lifts the rate without the engine passing anything new, so the
  //    report states the rate recomputed as if they had all stayed failures.
  const prevTransitions = new Map(trend?.idMatched?.previous?.delta?.transitions || []);
  const leftDenominator = {
    toOutOfScope: prevTransitions.get('fail → out-of-scope') || 0,
    toBlocked: prevTransitions.get('fail → blocked') || 0,
    against: trend?.idMatched?.previous?.run || null
  };
  leftDenominator.total = leftDenominator.toOutOfScope + leftDenominator.toBlocked;
  leftDenominator.conservativeRan = ran + leftDenominator.total;
  leftDenominator.conservativeRate = leftDenominator.conservativeRan
    ? (t.passed || 0) / leftDenominator.conservativeRan
    : null;

  return {
    meta: {
      generatedAt: results.generatedAt,
      reportBuiltAt: new Date().toISOString(),
      target: results.target,
      commit: results.commit,
      occRetries: results.totals.occRetries ?? null,
      occExhausted: results.totals.occExhausted ?? null,
      errored: t.errored || 0
    },
    headline: {
      passed: t.passed || 0,
      failed: t.failed || 0,
      ran,
      excluded,
      total: t.total || 0,
      rate: ran ? (t.passed || 0) / ran : 0
    },
    totals: t,
    trend,
    cedar: buildCedar(cedar, results),
    measurement: { isolation, rowOrder, permanent, leftDenominator },
    categories,
    gaps,
    byFixability,
    failuresByFixability,
    dsql: {
      statementsTotal: loadReport.statementsTotal,
      statementsApplied: loadReport.statementsApplied,
      statementsFailed: loadReport.statementsFailed,
      objects: loadReport.objects,
      droppedTotal: (loadReport.dropped || []).length,
      kinds: topN(kindCounts, 20),
      families: dropFamilies,
      categoryCost: topN(dsqlCategoryCost, 20),
      blockedByCategory: topN(blockedByCategory, 20),
      blockedByGap: topN(blockedByGap, 20)
    },
    excluded: {
      skipFamilies,
      needsConfigFamilies,
      needsConfigByCategory: topN(needsConfigByCategory, 20),
      outOfScopeCases
    },
    zeroPass
  };
}

// ---------------------------------------------------------------- rendering

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

// GAP_NOTES contain a little inline markup on purpose; everything else is escaped.
const note = (s) => String(s ?? '');

const pct = (x, digits = 1) => `${(x * 100).toFixed(digits)}%`;
const num = (n) => Number(n).toLocaleString('en-US');

function bar(parts, total) {
  if (!total) return '<div class="bar"></div>';
  const seg = parts
    .filter((p) => p.value > 0)
    .map(
      (p) =>
        `<span class="seg ${p.cls}" style="width:${((p.value / total) * 100).toFixed(3)}%" title="${esc(
          `${p.label}: ${p.value}`
        )}"></span>`
    )
    .join('');
  return `<div class="bar">${seg}</div>`;
}

function fixBadge(f) {
  const cls =
    f === 'engine-fixable' ? 'fix-engine'
      : f === 'dsql-substitute-needed' ? 'fix-dsql'
        : f === 'needs-engine-config' ? 'fix-config'
          : 'fix-oos';
  return `<span class="badge ${cls}">${esc(LABELS[f] || f)}</span>`;
}

function verdictParagraphs(m) {
  const rate = m.headline.rate;
  const engineFail = m.failuresByFixability['engine-fixable'];
  const dsqlFail = m.failuresByFixability['dsql-substitute-needed'];
  const oosFail = m.failuresByFixability['out-of-scope'];
  const failed = m.headline.failed;
  const topTen = m.gaps.filter((g) => g.counted).slice(0, 10);
  const topTenCases = topTen.reduce((a, g) => a + g.failed, 0);
  const dsqlSlugs = m.gaps
    .filter((g) => g.fixability === 'dsql-substitute-needed')
    .map((g) => `<code>${esc(g.slug)}</code> (${g.failed})`)
    .join(', ');

  const level =
    rate < 0.2
      ? 'This is a low score, and the report does not dress it up.'
      : rate < 0.5
        ? 'This is a partial result.'
        : 'This is a substantial result, but read the exclusions before quoting it.';

  const tr = m.trend;
  // When the two runs used different runner flags, a percentage-point jump is
  // not a like-for-like claim: fixture state differs, so it would overstate the
  // engine's progress. Lead with the case delta measured by matching case ids
  // between the two results files, and send the reader to the flag-matched
  // figure for a rate comparison.
  const im = tr?.idMatched?.baseline || null;
  const flagNote = tr && !tr.isSelfComparison
    ? tr.sameFlags
      ? ` Both runs used the same runner flags, so the rate moved `
        + `${pct(tr.baseline.rate)} → ${pct(tr.current.rate)}.`
      : ` The two runs used different runner flags, so their rates are not compared here: `
        + `fixture state differs between them, and a percentage-point jump would credit the engine `
        + `with the flag's effect. See <a href="#progress">Progress since the baseline</a> for the `
        + `flag-matched pair.`
    : '';
  const progress =
    tr && !tr.isSelfComparison
      ? im
        ? ` Matched by case id against the baseline run (<code>${esc(tr.baseline.generatedAt)}</code>, `
          + `${num(tr.baseline.passed)} of ${num(tr.baseline.ran)}), ${num(im.gained)} cases went `
          + `from not passing to passing and ${num(im.lost)} went the other way, over `
          + `${num(im.matched)} ids present in both runs.${flagNote}`
        : ` That is ${signed(tr.deltaPassed)} cases against the baseline run `
          + `(<code>${esc(tr.baseline.generatedAt)}</code>, ${num(tr.baseline.passed)} of `
          + `${num(tr.baseline.ran)}).${flagNote}`
      : '';
  const sp = tr?.spread;
  const repeat = sp
    ? ` This tree was measured ${num(sp.runs.length)} times with these flags and the results `
      + `spanned ${num(sp.lowest.passed)} to ${num(sp.highest.passed)} of ${num(sp.highest.ran)} `
      + `(${pct(sp.lowest.rate)}–${pct(sp.highest.rate)}): `
      + `${sp.runs.map((r) => `<code>${esc(r.label)}</code> ${num(r.passed)}`).join(', ')}. `
      + `The published run is the one this report is built from, `
      + `${num(sp.published?.passed ?? m.headline.passed)} — neither the lowest nor the highest. `
      + `That range is run-to-run noise on a distributed database, not progress; `
      + `<a href="#spread">every run of the tree</a> is in the trend.`
    : tr?.idMatched?.repeat
      ? ` The same tree was measured twice: `
        + `<code>${esc(tr.idMatched.repeat.run.label)}</code> passed `
        + `${num(tr.idMatched.repeat.run.passed)} of ${num(tr.idMatched.repeat.run.ran)} `
        + `(${pct(tr.idMatched.repeat.run.rate)}) with the same flags, differing on `
        + `${num(tr.idMatched.repeat.delta.gained + tr.idMatched.repeat.delta.lost)} cases. `
        + `That is the run-to-run noise on this database, not progress.`
      : '';
  const previous = tr?.idMatched?.previous
    ? ` The last run measured with these same flags `
      + `(<code>${esc(tr.idMatched.previous.run.label)}</code>, `
      + `${num(tr.idMatched.previous.run.passed)} of ${num(tr.idMatched.previous.run.ran)}, `
      + `${pct(tr.idMatched.previous.run.rate)}) is directly comparable: `
      + `${num(tr.idMatched.previous.delta.gained)} cases gained and `
      + `${num(tr.idMatched.previous.delta.lost)} lost, `
      + `${pct(tr.idMatched.previous.run.rate)} → ${pct(m.headline.rate)}.`
    : '';

  const out = [];
  out.push(
    `<p><strong>${level}</strong> The engine passes ${num(m.headline.passed)} of the ` +
      `${num(m.headline.ran)} upstream assertions that ran and are in scope.` +
      `${progress}${previous}${repeat} ` +
      `Do not quote a higher figure: the denominator already excludes everything ` +
      `Aurora DSQL or this architecture makes unmeasurable. ` +
      (m.measurement.leftDenominator?.total
        ? `Counting the ${num(m.measurement.leftDenominator.total)} cases that were failures in the `
          + `comparable run and left the denominator by reclassification as failures instead gives `
          + `${num(m.headline.passed)} of ${num(m.measurement.leftDenominator.conservativeRan)} = `
          + `${pct(m.measurement.leftDenominator.conservativeRate)}. `
        : '') +
      `<a href="#measurement">How to read this number</a> states the residual measurement bias, ` +
      `the order-dependent failures and what DSQL makes impossible.</p>`
  );
  out.push(
    `<p>Of the ${num(failed)} failures, ${num(engineFail)} ` +
      `(${pct(engineFail / failed)}) are engine-side gaps that DSQL does not block, ` +
      `${num(dsqlFail)} come from something Aurora DSQL does not provide, where the engine has to ` +
      `supply the substitute itself or there is none (${dsqlSlugs}), and ` +
      `${num(oosFail)} assert behaviour this architecture does not promise. ` +
      `The ten largest gaps account for ${num(topTenCases)} failures ` +
      `(${pct(topTenCases / failed)}), so the number moves in large steps, not by grinding.</p>`
  );
  if (m.zeroPass.length) {
    out.push(
      `<p>Categories with zero passing cases: ${m.zeroPass
        .map((c) => `<code>${esc(c)}</code>`)
        .join(', ')}.</p>`
    );
  }
  return out.join('\n');
}

const signed = (n) => (n > 0 ? `+${num(n)}` : n < 0 ? `−${num(Math.abs(n))}` : '0');

function deltaCell(n) {
  const cls = n > 0 ? 'good' : n < 0 ? 'bad' : 'muted';
  return `<td class="n ${cls}">${signed(n)}</td>`;
}

/**
 * Progress: the whole measured trend, then baseline vs current per category.
 * Baseline is the first entry in conformance/results/history.json.
 */
function renderProgress(m) {
  const tr = m.trend;
  if (!tr) return '<p class="fine">No trend file, so no baseline comparison.</p>';
  if (tr.isSelfComparison) {
    return `<p>This is the only measured run in <code>conformance/results/history.json</code>,
so there is nothing to compare it with yet. The next run will show a delta here.</p>`;
  }

  const runRows = tr.runs
    .map((r) => {
      const isCurrent = r.label === tr.current.label && r.generatedAt === tr.current.generatedAt;
      const isBaseline = r.label === tr.baseline.label && r.generatedAt === tr.baseline.generatedAt;
      const tag = isCurrent ? ' <span class="badge ct-yes">current</span>'
        : isBaseline ? ' <span class="badge ct-no">baseline</span>' : '';
      return `<tr>
  <th scope="row"><code>${esc(r.label)}</code>${tag}</th>
  <td class="fine mono">${esc(r.generatedAt)}</td>
  <td class="n good">${num(r.passed)}</td>
  <td class="n bad">${num(r.failed)}</td>
  <td class="n">${num(r.ran)}</td>
  <td class="n">${r.rate === null ? '—' : pct(r.rate)}</td>
  <td class="fine mono">${r.flags ? esc(r.flags) : '<span class="muted">not recorded</span>'}</td>
</tr>`;
    })
    .join('\n');

  const catRows = tr.categories
    .filter((c) => c.baselineRan > 0 || c.ran > 0)
    .map(
      (c) => `<tr>
  <th scope="row"><code>${esc(c.name)}</code></th>
  <td class="n">${c.measuredAtBaseline ? `${num(c.baselinePassed)} / ${num(c.baselineRan)}` : '<span class="muted">—</span>'}</td>
  <td class="n">${num(c.passed)} / ${num(c.ran)}</td>
  ${deltaCell(c.deltaPassed)}
  ${deltaCell(c.deltaRan)}
  <td class="n">${c.baselineRate === null ? '—' : pct(c.baselineRate, 0)} → ${c.rate === null ? '—' : pct(c.rate, 0)}</td>
</tr>`
    )
    .join('\n');

  const flagWarning = tr.sameFlags
    ? `<p class="fine">Baseline and current were measured with the same runner flags
(<code>${esc(tr.current.flags || 'not recorded')}</code>), so the two columns are directly
comparable.</p>`
    : `<p><strong>The two runs were measured with different runner flags</strong> — baseline
<code>${esc(tr.baseline.flags || 'not recorded')}</code>, current
<code>${esc(tr.current.flags || 'not recorded')}</code>. Fixture state differs between them, so
read the per-category deltas as indicative, not exact. Every future run should pin the current
flags.</p>`;

  const regressions = tr.regressed.length
    ? `<p>Categories below their baseline: ${tr.regressed
        .map((c) => `<code>${esc(c.name)}</code> (${signed(c.deltaPassed)})`)
        .join(', ')}. A category can fall while the engine improves: cases that used to be
excluded move into the denominator and fail there first, and a category that reads data another
spec mutates scores differently depending on the run flags.</p>`
    : '<p>No category is below its baseline.</p>';

  // A rate-to-rate comparison is only quoted when both runs used the same
  // flags. Across different flags the case delta is the claim.
  const ratePair = tr.sameFlags
    ? ` (${pct(tr.baseline.rate)} → ${pct(tr.current.rate)})`
    : '';

  return `<p>Baseline is the first entry in <code>conformance/results/history.json</code>:
${num(tr.baseline.passed)} passed and ${num(tr.baseline.failed)} failed of
${num(tr.baseline.total)} extracted cases, measured
<code>${esc(tr.baseline.generatedAt)}</code>. Current is
${num(tr.current.passed)} passed and ${num(tr.current.failed)} failed of
${num(tr.current.total)} extracted, a change of ${signed(tr.deltaPassed)} passing cases and
${signed(tr.deltaFailed)} failing ones on a denominator that moved by
${signed(tr.deltaRan)}${ratePair}. The denominator moves in both directions:
a case leaves the excluded groups when the harness or the engine learns to run it, and enters them
when a closer look shows its fixture cannot exist on DSQL. A rate on its own would hide that, so
the counts are shown next to it.</p>
${flagWarning}
${renderIdMatched(tr)}

<h3>Every measured run</h3>
<table class="grid">
<thead><tr><th scope="col">Run</th><th scope="col">Measured</th>
<th scope="col" class="n">Passed</th><th scope="col" class="n">Failed</th>
<th scope="col" class="n">Ran</th><th scope="col" class="n">Rate</th>
<th scope="col">Runner flags</th></tr></thead>
<tbody>
${runRows}
</tbody>
</table>

<h3>Baseline vs current, by category</h3>
<p class="fine">Passed / ran in each column. Sorted by the change in passing cases.
${num(tr.improved)} of ${num(tr.categories.length)} categories improved.</p>
<table class="grid">
<thead><tr><th scope="col">Category</th><th scope="col" class="n">Baseline</th>
<th scope="col" class="n">Current</th><th scope="col" class="n">Δ passed</th>
<th scope="col" class="n">Δ ran</th><th scope="col" class="n">Rate</th></tr></thead>
<tbody>
${catRows}
</tbody>
</table>
${regressions}`;
}

/**
 * The case-level delta, matched by id between two results files. This is the
 * comparison that survives a change of runner flags, so it is the one the
 * headline quotes.
 */
function renderIdMatched(tr) {
  const im = tr.idMatched;
  if (!im || !im.baseline) {
    return `<p class="fine">No case-level delta: one of the two results files is not on disk,
so only the totals above can be compared.</p>`;
  }
  const table = (d) => `<table class="grid">
<thead><tr><th scope="col">Status change</th><th scope="col" class="n">Cases</th></tr></thead>
<tbody>
${d.transitions
    .map(([k, n]) => `<tr><th scope="row"><code>${esc(k)}</code></th><td class="n">${num(n)}</td></tr>`)
    .join('\n')}
</tbody>
</table>`;

  const prev = im.previous
    ? `<h3>Against the last run with the same flags</h3>
<p><code>${esc(im.previous.run.label)}</code> (<code>${esc(im.previous.run.generatedAt)}</code>)
was measured with the same flags as this run and passed ${num(im.previous.run.passed)} of
${num(im.previous.run.ran)}. Matched by id: ${num(im.previous.delta.gained)} cases gained,
${num(im.previous.delta.lost)} lost, over ${num(im.previous.delta.matched)} shared ids. Because the
flags match, the rate comparison holds: ${pct(im.previous.run.rate)} → ${pct(tr.current.rate)}.</p>
${table(im.previous.delta)}`
    : '';

  const sp = tr.spread;
  const repeatRows = (im.repeats || [])
    .map(
      (r) => `<tr>
  <th scope="row"><code>${esc(r.run.label)}</code></th>
  <td class="fine mono">${esc(r.run.generatedAt)}</td>
  <td class="n">${num(r.run.passed)} / ${num(r.run.ran)}</td>
  <td class="n">${pct(r.run.rate)}</td>
  <td class="n">${num(r.delta.gained + r.delta.lost)}</td>
  <td class="n good">${num(r.delta.gained)}</td>
  <td class="n bad">${num(r.delta.lost)}</td>
</tr>`
    )
    .join('\n');
  const repeat = sp
    ? `<h3 id="spread">The same tree, measured ${num(sp.runs.length)} times</h3>
<p>${num(sp.runs.length)} runs in the trend measure this engine
(<code>${esc(sp.tree || 'unknown')}</code>) with the same flags, and they span
${num(sp.lowest.passed)} to ${num(sp.highest.passed)} of ${num(sp.highest.ran)} —
${pct(sp.lowest.rate)} to ${pct(sp.highest.rate)}. This report publishes
${num(sp.published?.passed ?? 0)}. Each row below is matched case by case against the published run,
so the disagreement is counted rather than inferred from the totals.</p>
<table class="grid">
<thead><tr><th scope="col">Other run of this tree</th><th scope="col">Measured</th>
<th scope="col" class="n">Passed / ran</th><th scope="col" class="n">Rate</th>
<th scope="col" class="n">Cases differing</th><th scope="col" class="n">Pass here only</th>
<th scope="col" class="n">Pass there only</th></tr></thead>
<tbody>
${repeatRows}
</tbody>
</table>
<p>${note(PUBLISHED_RUN_CHOICE)}</p>
<p class="fine">The choice of which run to publish is editorial and the rule it follows is written
down in <code>compatreport/README.md</code>: never publish the run measured by the pass that wrote
the code, prefer the middle of the observed range to the top of it, and keep every run in the trend
so the spread stays visible.</p>`
    : im.repeat
      ? `<h3 id="spread">The same tree, measured twice</h3>
<p><code>${esc(im.repeat.run.label)}</code> (<code>${esc(im.repeat.run.generatedAt)}</code>) is the
same tree and the same flags as this run and passed ${num(im.repeat.run.passed)} of
${num(im.repeat.run.ran)} (${pct(im.repeat.run.rate)}). Matched by id, the two disagree on
${num(im.repeat.delta.gained + im.repeat.delta.lost)} cases — ${num(im.repeat.delta.gained)} pass
here and not there, ${num(im.repeat.delta.lost)} the other way round. That is the measurement noise
on this database, mostly order luck and fixture-reload conflicts. Both runs are kept in the trend so
the noise is visible; a difference of that size is never progress.</p>`
      : '';

  return `<h3>Case-level delta since the baseline</h3>
<p>Totals can move because the denominator moved. Matching case ids between the two results files
cannot: ${num(im.baseline.gained)} cases went from a non-pass status to <code>pass</code> and
${num(im.baseline.lost)} went from <code>pass</code> to a non-pass status, over
${num(im.baseline.matched)} ids present in both runs${
  im.baseline.onlyInCurrent || im.baseline.onlyInBaseline
    ? ` (${num(im.baseline.onlyInCurrent)} ids are new since the baseline and ${num(im.baseline.onlyInBaseline)} are gone)`
    : ''
}. Every transition is listed, including the ones that left the denominator.</p>
${table(im.baseline)}
${prev}
${repeat}`;
}

/**
 * How to read the number: the residual measurement bias, the failures left in
 * on purpose, and the ceiling DSQL puts on the whole exercise. Everything here
 * is computed from the results file, the trend and the fixture load report; the
 * why-there-is-no-substitute column is the editorial part and is marked as such.
 */
function renderMeasurement(m) {
  const { isolation, rowOrder, permanent, leftDenominator } = m.measurement;
  const ev = isolation.evidence;

  const isolationEffect =
    ev.withReload && ev.withoutReload
      ? `The size of the effect is measured, on one commit
(<code>${esc(ev.withReload.commit || 'unknown')}</code>) with every other flag held constant:
${num(ev.withReload.passed)} of ${num(ev.withReload.ran)} with the flag
(<code>${esc(ev.withReload.label)}</code>) against ${num(ev.withoutReload.passed)} of
${num(ev.withoutReload.ran)} without it (<code>${esc(ev.withoutReload.label)}</code>). That
${num(Math.abs(ev.withReload.passed - ev.withoutReload.passed))}-case difference is reading specs
being scored against rows an earlier mutating spec left behind.`
      : 'The trend holds no pair of runs on one commit that differ only in this flag, so the size of the effect is not quoted here.';

  const exampleBlock = isolation.example
    ? `<p>A worked example from this run, not a hypothetical.
<code>${esc(isolation.example.id)}</code> failed:</p>
<pre class="cmd">${esc(String(isolation.example.reason).trim())}</pre>
<p>Earlier cases in the same spec file write that row with the other value and no later case
restores it, so the read is scored against a database upstream never sees. Upstream never hits this
because it rolls the row back before the next example starts.</p>`
    : '';

  const resetBlock = isolation.targetedReset || isolation.fullReset
    ? `<p>This run was measured with
<code>${isolation.fullReset ? '--reset-mutations' : '--reset-touched'}</code>, so the residual bias
above is removed for the cases that flag covers.</p>`
    : `<p><strong>The targeted reset does not remove this bias in the published number.</strong>
The runner has <code>--reset-touched</code>, which restores only the tables a mutating case wrote
to, and <code>--reset-mutations</code>, which re-applies the whole data fixture after every
mutating case. Both default to off, both need <code>--concurrency 1</code>, and neither is in the
flags this run was measured with (<code>${esc(isolation.flags || 'not recorded')}</code>). A
three-spec control run during verification (<code>UpsertSpec</code>, <code>InsertSpec</code>,
<code>UpdateSpec</code>) moved cases in both directions with the targeted reset on — 11 from fail to
pass and 4 from pass to fail — so it makes the measurement more faithful rather than higher. That
control is not in the trend, because a three-spec run is not a suite score.</p>`;

  // The set of order-dependent assertions is larger than any one run's count:
  // whether a given one fails depends on the order DSQL happened to return.
  const prevRowOrder = m.trend?.idMatched?.previous
    ? (rowOrder.byRun || []).find(
      (r) => r.label === m.trend.idMatched.previous.run.label
        && r.generatedAt === m.trend.idMatched.previous.run.generatedAt
    )
    : null;
  const counts = (rowOrder.byRun || []).map((r) => r.count);
  const rowOrderSpread = counts.length > 1 && Math.min(...counts) !== Math.max(...counts)
    ? `<p>Do not read ${num(rowOrder.count)} as the size of the problem. Across the measured runs
this count ranges from ${num(Math.min(...counts))} to ${num(Math.max(...counts))}
${prevRowOrder ? `(the previous run with the same flags, <code>${esc(prevRowOrder.label)}</code>, recorded ${num(prevRowOrder.count)})` : ''}
— the order-dependent assertions are a fixed set, and how many of them happen to come back in the
order upstream expects is luck. Counts per measured run:</p>`
    : '';

  const rowOrderRuns = (rowOrder.byRun || []).length
    ? `${rowOrderSpread}<table class="grid">
<thead><tr><th scope="col">Run</th><th scope="col">Measured</th>
<th scope="col" class="n">Order-dependent failures</th></tr></thead>
<tbody>
${rowOrder.byRun
      .map(
        (r) => `<tr><th scope="row"><code>${esc(r.label)}</code></th>
  <td class="fine mono">${esc(r.generatedAt)}</td><td class="n">${num(r.count)}</td></tr>`
      )
      .join('\n')}
</tbody>
</table>
<p class="fine">The count is not stable between runs, which is the point: the same assertion passes
or fails depending on the order DSQL happens to return rows in. Runs whose results file is no longer
on disk are omitted.</p>`
    : '';

  const permRows = permanent.families
    .map(
      (f) => `<tr>
  <th scope="row">${esc(f.family)}</th>
  <td class="n">${num(f.count)}</td>
  <td>${f.kinds.map(([k, n]) => `${esc(k)} ${n}`).join(', ')}</td>
  <td>${esc(f.why)}</td>
  <td>${note(f.substitute)}</td>
</tr>`
    )
    .join('\n');

  const conservative = leftDenominator?.total && leftDenominator.against
    ? `<h3>4. Cases that left the denominator since the comparable run</h3>
<p>${num(leftDenominator.total)} cases were failures in
<code>${esc(leftDenominator.against.label)}</code> and are not failures here because they were
reclassified, not because they now pass: ${num(leftDenominator.toOutOfScope)} moved to out of scope
and ${num(leftDenominator.toBlocked)} to blocked. Both moves lift the rate on their own, so the
conservative reading — every one of them counted as a failure — is
<strong>${num(m.headline.passed)} of ${num(leftDenominator.conservativeRan)} =
${pct(leftDenominator.conservativeRate)}</strong> against the headline
${pct(m.headline.rate)}. Quote either, but quote the denominator with it.</p>
<p class="fine">Each reclassification is evidence-gated and listed in
<a href="#notcounted">Not counted</a>: an out-of-scope case names a namespaced run-time parameter
DSQL rejects outright, and a blocked case names a fixture column the load report confirms was
dropped. The reason they only surfaced now is that the engine started forwarding the database's own
error text, which made the cause visible to the classifier.</p>`
    : '';

  const audited = AUDITED_DISCLOSURES.length
    ? `<h3>${conservative ? '5' : '4'}. What an audit of this run found in the passes</h3>
<p>An independent pass re-measured this tree and went looking for passes that are weaker than they
look. It found no inflation in the rate — its own run scored higher than the one published here —
but it did find two things about <em>how</em> some passes are reached that no input file can
compute. Both are recorded here rather than in a commit message:</p>
<ul>
${AUDITED_DISCLOSURES.map(
    (d) => `<li><strong>${esc(d.title)}.</strong> ${note(d.body)}</li>`
  ).join('\n')}
</ul>
<p class="fine">Editorial, like the gap notes: an audit finding is a judgement about a cause, and
causes are not in the results file. Each one names what was run so it can be checked. Neither
changes a status, and neither is netted off the rate — they change what the rate means, not what it
is.</p>`
    : '';

  return `<p>Three things bound this measurement. The first biases it, the second is left failing on
purpose, and the third is a ceiling no amount of engine work moves${conservative
  ? ', a fourth records what left the denominator since the comparable run'
  : ''}${audited ? ', and the last lists what an audit found behind some of the passes' : ''}.</p>

<h3>1. Fixture isolation is per spec file, not per request</h3>
<p>Upstream runs its suite with <code>configDbTxRollbackAll = True</code>
(<code>test/spec/SpecHelper.hs</code>), so every request is rolled back and no upstream example ever
sees another example's writes. That is not available here: Aurora DSQL has no <code>SAVEPOINT</code>
and the engine holds no transaction open across a request. The runner's closest approximation is
<code>--reload-per-spec</code>, which reloads the fixtures once per spec file and
${isolation.reloadPerSpec ? 'was used for this run' : '<strong>was not used for this run</strong>'}.
${isolationEffect}</p>
<p>The residual bias is what per-spec reload cannot reach: a case that mutates data still changes
what <em>later cases in the same spec file</em> read. Upstream's own ordering assumes a pristine row
at every example.</p>
${exampleBlock}
${resetBlock}
<p class="fine">Direction of the bias: mostly downward. A read that upstream scores against pristine
data is scored here against data an earlier case in the same file changed, which produces a failure,
not a pass. It can also flatter a case in the other direction — a read that happens to want the
mutated row — which is why the residual is called a bias and not a discount.</p>

<h3>2. Order-dependent assertions: ${num(rowOrder.count)} failures kept as failures</h3>
<p>${num(rowOrder.count)} cases in this run failed with the right rows in the wrong order.
Aurora DSQL is distributed and keeps no heap the way PostgreSQL does, so a query with no
<code>ORDER BY</code> comes back in whatever order the storage layer produces and insertion order is
not preserved. Upstream's assertions were written against PostgreSQL, where a sequential scan of a
freshly loaded table returns rows in heap order, which is insertion order — so upstream can assert a
row sequence without ever writing <code>order=</code>. The engine adds no implicit
<code>ORDER BY</code>, because inventing one would change its semantics for every caller in order to
make a test pass.</p>
<p>These are counted as <strong>failures</strong> in the headline. Reclassifying them as skipped or
out of scope would lift the rate on a technicality, so the report leaves them in and names them:
${rowOrder.ids.length
    ? rowOrder.ids.map((id) => `<code>${esc(id)}</code>`).join(', ')
    : 'none in this run'}.</p>
${rowOrderRuns}

<h3>3. Permanently impossible on Aurora DSQL</h3>
<p>${num(permanent.droppedObjects)} of the ${num(permanent.droppedTotal)} constructs dropped at
fixture load are dropped because DSQL cannot create them at all, not because the transform gave up.
Every one is listed with its reason in <code>conformance/fixtures/load-report.json</code>. The cost
in cases is ${num(permanent.casesTotal)}: ${num(permanent.blocked)} blocked (the object under test
does not exist, so the assertion cannot run either way), ${num(permanent.outOfScope)} out of scope
(namespaced run-time parameters), and ${num(permanent.dsqlFailures)} counted as failures anyway
because the request still ran and returned the wrong thing —
${permanent.dsqlFailureGaps
    .map((g) => `<code>${esc(g.slug)}</code> ${num(g.failed)}`)
    .join(', ')}.</p>
<p class="fine">Blocked cases by cause: ${permanent.blockedByGap
    .map(([g, n]) => `<code>${esc(g)}</code> ${num(n)}`)
    .join(', ')}.</p>
<table class="grid">
<thead><tr><th scope="col">What DSQL will not create</th><th scope="col" class="n">Objects</th>
<th scope="col">Kinds</th><th scope="col">Why</th><th scope="col">Substitute</th></tr></thead>
<tbody>
${permRows}
</tbody>
</table>
<p class="fine">Object counts and kinds come from the load report. The "Why" and "Substitute"
columns are editorial, like the gap notes, and are the only hand-written text in this section.
Families that are consequences of another drop — a view that referenced a table DSQL refused, a
GRANT on a schema that was skipped — are in <a href="#dsql">Aurora DSQL limitations</a> below rather
than here, so this table is not padded with knock-on effects.</p>
${conservative}
${audited}`;
}

function renderCategories(m) {
  const trendByName = new Map((m.trend?.categories || []).map((c) => [c.name, c]));
  const hasBaseline = Boolean(m.trend) && !m.trend.isSelfComparison;
  const rows = m.categories
    .filter((c) => c.total > 0)
    .map((c) => {
      const rate = c.rate === null ? '—' : pct(c.rate, 0);
      const t = trendByName.get(c.name);
      const baselineCells = !hasBaseline
        ? ''
        : t && t.measuredAtBaseline
          ? `<td class="n muted">${num(t.baselinePassed)} / ${num(t.baselineRan)}</td>${deltaCell(t.deltaPassed)}`
          : '<td class="n muted">—</td><td class="n muted">—</td>';
      return `<tr>
  <th scope="row"><code>${esc(c.name)}</code></th>
  <td class="n">${num(c.total)}</td>
  <td class="n good">${num(c.passed)}</td>
  <td class="n bad">${num(c.failed)}</td>
  ${baselineCells}
  <td class="n warn">${num(c.blocked)}</td>
  <td class="n muted">${num(c.needsConfig)}</td>
  <td class="n muted">${num(c.skipped + c.outOfScope)}</td>
  <td class="n">${rate}</td>
  <td class="barcell">${bar(
    [
      { value: c.passed, cls: 's-pass', label: 'passed' },
      { value: c.failed, cls: 's-fail', label: 'failed' },
      { value: c.blocked, cls: 's-blocked', label: 'blocked' },
      { value: c.needsConfig, cls: 's-config', label: 'needs engine config' },
      { value: c.skipped + c.outOfScope, cls: 's-excluded', label: 'excluded' }
    ],
    c.total
  )}</td>
</tr>`;
    })
    .join('\n');
  const empty = m.categories.filter((c) => c.total === 0).map((c) => c.name);
  return `<table class="grid">
<thead><tr>
  <th scope="col">Category</th><th scope="col" class="n">Total</th>
  <th scope="col" class="n">Passed</th><th scope="col" class="n">Failed</th>
  ${hasBaseline ? '<th scope="col" class="n">Baseline passed / ran</th><th scope="col" class="n">Δ passed</th>' : ''}
  <th scope="col" class="n">Blocked</th>
  <th scope="col" class="n">Needs config</th><th scope="col" class="n">Excluded</th>
  <th scope="col" class="n">Pass rate</th><th scope="col">Mix</th>
</tr></thead>
<tbody>
${rows}
</tbody>
</table>
${
  empty.length
    ? `<p class="fine">Categories with no extracted cases: ${empty
        .map((c) => `<code>${esc(c)}</code>`)
        .join(', ')}.</p>`
    : ''
}`;
}

function renderGaps(m) {
  return m.gaps
    .map((g) => {
      const statuses = Object.entries(g.statuses)
        .sort((a, b) => b[1] - a[1])
        .map(([s, n]) => `${esc(s)} ${n}`)
        .join(' · ');
      const cats = g.categories.map(([c, n]) => `${esc(c)} ${n}`).join(', ');
      return `<li class="gap">
  <div class="gap-head">
    <span class="gap-count">${num(g.cases)}</span>
    <code class="gap-slug">${esc(g.slug)}</code>
    ${fixBadge(g.fixability)}
    <span class="badge ${g.counted ? 'ct-yes' : 'ct-no'}">${
      g.counted ? 'in pass rate' : 'excluded from pass rate'
    }</span>
  </div>
  ${g.note ? `<p class="gap-note">${note(g.note)}</p>` : ''}
  ${g.symptom ? `<p class="gap-sym">Measured: <span class="mono">${esc(g.symptom)}</span></p>` : ''}
  <p class="fine">status: ${statuses} &nbsp;|&nbsp; categories: ${cats} &nbsp;|&nbsp; e.g. ${g.examples
    .map((e) => `<code>${esc(e)}</code>`)
    .join(', ')}</p>
</li>`;
    })
    .join('\n');
}

function renderDsql(m) {
  const d = m.dsql;
  const rows = d.families
    .map(
      (f) => `<tr>
  <th scope="row">${esc(f.family)}${f.note ? ` <span class="fine">(${esc(f.note)})</span>` : ''}</th>
  <td class="n">${num(f.count)}</td>
  <td>${f.kinds.map(([k, n]) => `${esc(k)} ${n}`).join(', ')}</td>
  <td>${f.categories.length ? f.categories.map(([c, n]) => `${esc(c)} ${n}`).join(', ') : '<span class="muted">—</span>'}</td>
  <td class="mono fine">${f.objects.map((o) => esc(o)).join('<br>')}</td>
</tr>`
    )
    .join('\n');

  const blockedTotal = d.blockedByCategory.reduce((a, [, n]) => a + n, 0);
  const blockedRows = d.blockedByCategory
    .map(
      ([c, n]) => `<tr><th scope="row"><code>${esc(c)}</code></th><td class="n">${num(n)}</td>
  <td class="barcell">${bar([{ value: n, cls: 's-blocked', label: 'blocked' }], blockedTotal || 1)}</td></tr>`
    )
    .join('\n');

  const gapRows = d.blockedByGap
    .map(([g, n]) => `<tr><th scope="row"><code>${esc(g)}</code></th><td class="n">${num(n)}</td></tr>`)
    .join('\n');

  return `<p>The fixtures are upstream's, mechanically transformed until they load on DSQL.
${num(d.statementsApplied)} of ${num(d.statementsTotal)} statements applied
(${num(d.statementsFailed)} failed), producing
${num(d.objects?.tables ?? 0)} tables, ${num(d.objects?.views ?? 0)} views,
${num(d.objects?.functions ?? 0)} functions and ${num(d.objects?.domains ?? 0)} domains.
${num(d.droppedTotal)} constructs were dropped, each with a recorded reason in
<code>conformance/fixtures/load-report.json</code>. That list is what keeps this report honest:
a case whose fixture does not exist is reported <em>blocked</em>, never <em>failed</em>, and never
counted as a pass.</p>

<h3>What could not be created</h3>
<table class="grid">
<thead><tr><th scope="col">Limitation</th><th scope="col" class="n">Objects</th>
<th scope="col">Kinds</th><th scope="col">Test categories touched</th>
<th scope="col">Examples</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>

<h3>What that cost, in test cases</h3>
<p>${num(blockedTotal)} cases are blocked: the object under test is absent, so the assertion cannot
run either way. These sit outside the pass rate.</p>
<div class="two-col">
<table class="grid">
<thead><tr><th scope="col">Category</th><th scope="col" class="n">Blocked</th><th scope="col">Share</th></tr></thead>
<tbody>
${blockedRows}
</tbody>
</table>
<table class="grid">
<thead><tr><th scope="col">Blocked because</th><th scope="col" class="n">Cases</th></tr></thead>
<tbody>
${gapRows}
</tbody>
</table>
</div>`;
}

function renderExcluded(m) {
  const skipTotal = m.excluded.skipFamilies.reduce((a, f) => a + f.count, 0);
  const skipRows = m.excluded.skipFamilies
    .map(
      (f) => `<tr>
  <th scope="row">${esc(f.family)}</th>
  <td class="n">${num(f.count)}</td>
  <td class="fine">${
    f.details.length
      ? f.details.map(([d, n]) => `<code>${esc(d)}</code> ${n}`).join(', ')
      : '<span class="muted">—</span>'
  }</td>
</tr>`
    )
    .join('\n');

  const oos = m.excluded.outOfScopeCases;
  const oosRows = oos
    .map(
      (c) => `<tr><th scope="row"><code>${esc(c.id)}</code></th><td><code>${esc(c.category)}</code></td>
  <td><code>${esc(c.gap)}</code></td><td class="fine mono">${esc(c.reason)}</td></tr>`
    )
    .join('\n');

  const cfgTotal = m.excluded.needsConfigFamilies.reduce((a, f) => a + f.count, 0);
  const cfgRows = m.excluded.needsConfigFamilies
    .map(
      (f) => `<tr>
  <th scope="row">${esc(f.family)}</th>
  <td class="n">${num(f.count)}</td>
  <td class="fine">${
    f.details.length
      ? f.details.map(([d, n]) => `<code>${esc(d)}</code> ${n}`).join(', ')
      : '<span class="muted">—</span>'
  }</td>
</tr>`
    )
    .join('\n');
  const cfgCats = m.excluded.needsConfigByCategory
    .map(([c, n]) => `<code>${esc(c)}</code> ${n}`)
    .join(', ');

  return `<p>Four groups of cases are outside the denominator. None of them is counted as a pass,
and moving any of them in would lower the rate before it raises it — most would fail on first
measurement.</p>

<h3>1. Needs engine configuration — ${num(cfgTotal)} cases</h3>
<p>The assertion is representable and the request is ordinary; it only holds when the PostgREST
process runs with a non-default setting the engine has no switch for — a different exposed schema,
an extra search path, a row limit, a pre-request function, an aggregate or plan feature flag.
These are missing engine features, not harness limitations, and they are reported separately from
skips for that reason. Making the switch exist moves them into the denominator, where they will
fail until the behaviour behind the switch exists too.</p>
<table class="grid">
<thead><tr><th scope="col">Configuration needed</th><th scope="col" class="n">Cases</th><th scope="col">Setting</th></tr></thead>
<tbody>
${cfgRows}
</tbody>
</table>
${cfgCats ? `<p class="fine">By category: ${cfgCats}.</p>` : ''}

<h3>2. Skipped at extraction — ${num(skipTotal)} cases</h3>
<p>A <code>shouldRespondWith</code> site that cannot be converted faithfully is recorded with
<code>skip: true</code> and a reason. Guessing an assertion would be worse than skipping it.
A reason can name more than one obstacle; each case is counted under the first that applies.</p>
<table class="grid">
<thead><tr><th scope="col">Reason</th><th scope="col" class="n">Cases</th><th scope="col">Detail</th></tr></thead>
<tbody>
${skipRows}
</tbody>
</table>
<p class="fine">What is left here is Haskell the extractor cannot evaluate without guessing:
higher-order helpers whose request headers arrive as a parameter, bodies read from a fixture file,
paths built from a previous response, and expectations behind a PostgreSQL version check.</p>

<h3>3. Blocked by a missing fixture — ${num(m.totals.blocked || 0)} cases</h3>
<p>Detailed in the DSQL section above.</p>

<h3>4. Out of scope — ${num(oos.length)} cases</h3>
<p>The assertion tests a PostgREST mechanism this architecture cannot have: namespaced run-time
parameters that carry response headers and JWT claims. DSQL rejects both the
<code>set_config</code> call and the <code>CREATE FUNCTION</code> whose body contains the SET.</p>
<table class="grid">
<thead><tr><th scope="col">Case</th><th scope="col">Category</th><th scope="col">Gap</th><th scope="col">Reason</th></tr></thead>
<tbody>
${oosRows}
</tbody>
</table>`;
}

/**
 * A second measurement, kept apart from the first on purpose. The PostgREST rate
 * above answers "does upstream's own assertion pass". This answers "where the
 * outcome depends on SET ROLE and RLS, which DSQL does not have, does the Cedar
 * policy layer produce the same client-visible outcome". The two are never
 * averaged, and the cases below are failures in the rate above.
 */
function renderCedar(m) {
  const c = m.cedar;
  if (!c) return '';
  const kinds = c.divergenceKinds
    .map(([k, n]) => `<code>${esc(k)}</code> ${num(n)}`)
    .join(', ');
  const classes = c.noFairEquivalentByClass
    .map(
      ([k, n]) => `<tr><th scope="row"><code>${esc(k)}</code></th><td class="n">${num(n)}</td></tr>`
    )
    .join('\n');
  const upstream = c.upstreamAllFailing
    ? `All ${num(c.upstreamCasesCovered)} upstream cases behind this measurement are
<code>fail</code> in the run this report is built from — checked against that file, not asserted.
Nothing here moves a case out of the pass rate's denominator or into its numerator.`
    : `<strong>Check this:</strong> the upstream cases behind this measurement are not all failures
in this run (${c.upstreamStatus.map(([k, n]) => `${esc(k)} ${num(n)}`).join(', ')}). If one of them
now passes on its own mechanism, this section is describing a case the rate above already counts, and
the two measurements have started to overlap.`;

  return `<div class="cedar">
<p><strong>This is not part of the ${pct(m.headline.rate)} above and is never averaged into it.</strong>
Aurora DSQL has neither <code>SET ROLE</code> nor row-level security, and PostgREST's authorization
is built on both. ${num(c.upstreamCasesCovered)} extracted upstream cases assert an outcome reached
that way; on this architecture they cannot pass by that mechanism and they remain failures above
(the <code>no-set-role</code> gap). This measurement asks a different question about those same
cases: with a Cedar policy set standing in for the <code>GRANT</code>, is the client-visible outcome
— status, body, asserted headers — the same?</p>

<div class="strip">
  <div class="tile pass"><div class="v">${num(c.hold)}</div><div class="k">equivalences hold</div></div>
  <div class="tile fail"><div class="v">${num(c.diverge)}</div><div class="k">diverge</div></div>
  <div class="tile"><div class="v">${num(c.ran)}</div><div class="k">derived cases run</div></div>
  <div class="tile excluded"><div class="v">${num(c.noFairEquivalent)}</div><div class="k">no fair equivalent</div></div>
</div>

<p><strong>Cedar equivalence: ${num(c.hold)} of ${num(c.ran)} hold.</strong> The
${num(c.diverge)} divergences are all one kind (${kinds || 'none recorded'}): both mechanisms deny
the request and disagree on the shape of the denial — PostgREST answers <code>401</code> with
<code>WWW-Authenticate</code> for an anonymous caller, the Cedar layer answers <code>403</code>.
Measured ${esc(c.generatedAt || 'unknown')} on commit <code>${esc(c.commit || 'unknown')}</code>,
target <code>${esc(c.target || 'unknown')}</code>, from
<code>conformance/cedar/results/latest.json</code>.</p>

<p>${upstream}</p>

<h3>What a reader should not read into it</h3>
<ul>
${c.doNotRead.map((line) => `<li>${note(line)}</li>`).join('\n')}
</ul>

<h3>The ${num(c.noFairEquivalent)} with no fair equivalent</h3>
<p class="fine">Counted in neither the numerator nor the denominator, itemised with a written reason
in <code>conformance/cedar/equivalence-map.mjs</code> and on the
<code>docs/reference/cedar-equivalence.md</code> page. Only one of these classes is a finding about
the engine: <code>column-level-privilege</code>, where upstream grants a write on the table and
<code>SELECT</code> on some columns only, and the Cedar model has no column resource to express
that.</p>
<table class="grid">
<thead><tr><th scope="col">Class</th><th scope="col" class="n">Upstream cases</th></tr></thead>
<tbody>
${classes}
</tbody>
</table>
</div>`;
}

function renderHtml(m, paths) {
  const h = m.headline;
  const t = m.totals;
  const dataJson = JSON.stringify(m, null, 0).replace(/</g, '\\u003c');
  const relResults = relative(REPO, paths.results);
  const relLoad = relative(REPO, paths.loadReport);
  const relHistory = paths.useHistory ? relative(REPO, paths.history) : 'no trend file';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>pgrest-lambda — PostgREST compatibility report</title>
<style>
:root {
  color-scheme: light dark;
  --bg: #ffffff; --panel: #f6f7f9; --fg: #16191d; --fg-dim: #565c66;
  --line: #d9dde3; --line-soft: #e7eaee;
  --pass: #1f7a4d; --fail: #b03030; --blocked: #a8681a; --excluded: #7b8493;
  --config: #4a5fa5;
  --pass-bg: #e6f2ea; --fail-bg: #fbe9e9; --blocked-bg: #fbf1e2; --excluded-bg: #eceef1;
  --accent: #2b5fb8;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #14171b; --panel: #1c2026; --fg: #e6e9ee; --fg-dim: #a3abb8;
    --line: #333a44; --line-soft: #262b32;
    --pass: #5cc98d; --fail: #f08a84; --blocked: #e0b062; --excluded: #98a1ae;
    --config: #8fa2e0;
    --pass-bg: #1b2c22; --fail-bg: #33201f; --blocked-bg: #2e2617; --excluded-bg: #23272d;
    --accent: #82aaf0;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--fg);
  font: 16px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
}
.wrap { max-width: 1080px; margin: 0 auto; padding: 32px 20px 96px; }
h1 { font-size: 1.6rem; margin: 0 0 4px; letter-spacing: -0.01em; }
h2 { font-size: 1.2rem; margin: 44px 0 10px; padding-bottom: 6px; border-bottom: 1px solid var(--line); }
h3 { font-size: 1rem; margin: 26px 0 8px; }
p { margin: 0 0 12px; }
a { color: var(--accent); }
code, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.87em; }
.sub { color: var(--fg-dim); margin: 0 0 4px; }
.headline {
  margin: 24px 0 8px; padding: 22px 24px; background: var(--panel);
  border: 1px solid var(--line); border-radius: 10px;
}
.rate { font-size: 3.1rem; font-weight: 650; line-height: 1; letter-spacing: -0.02em; }
.rate small { font-size: 1rem; font-weight: 400; color: var(--fg-dim); margin-left: 10px; }
.denom { margin: 12px 0 0; max-width: 76ch; }
.strip { display: flex; flex-wrap: wrap; gap: 10px; margin: 18px 0 0; }
.tile {
  flex: 1 1 150px; padding: 10px 12px; border: 1px solid var(--line);
  border-radius: 8px; background: var(--bg);
}
.tile .v { font-size: 1.45rem; font-weight: 600; }
.tile .k { color: var(--fg-dim); font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.04em; }
.tile.pass .v { color: var(--pass); } .tile.fail .v { color: var(--fail); }
.tile.blocked .v { color: var(--blocked); } .tile.excluded .v { color: var(--excluded); }
.tile.config .v { color: var(--config); }
/* The Cedar section is boxed and inset so it cannot be skim-read as part of the
   PostgREST rate above it. Different question, different number. */
.cedar {
  border: 2px dashed var(--line); border-radius: 10px; padding: 4px 20px 12px;
  background: var(--panel); margin: 8px 0 16px;
}
table.grid { width: 100%; border-collapse: collapse; margin: 8px 0 16px; font-size: 0.92rem; }
table.grid th, table.grid td { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--line-soft); vertical-align: top; }
table.grid thead th { border-bottom: 1px solid var(--line); color: var(--fg-dim); font-weight: 600; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.03em; }
table.grid tbody tr:hover { background: var(--panel); }
table.grid th[scope="row"] { font-weight: 500; }
.n { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.good { color: var(--pass); } .bad { color: var(--fail); } .warn { color: var(--blocked); }
.muted, .fine { color: var(--fg-dim); }
.fine { font-size: 0.82rem; }
.barcell { width: 210px; }
.bar { display: flex; height: 10px; border-radius: 5px; overflow: hidden; background: var(--line-soft); min-width: 120px; margin-top: 4px; }
.seg { display: block; height: 100%; }
.s-pass { background: var(--pass); } .s-fail { background: var(--fail); }
.s-blocked { background: var(--blocked); } .s-excluded { background: var(--excluded); }
.s-config { background: var(--config); }
ol.gaps { list-style: none; margin: 0; padding: 0; counter-reset: gap; }
li.gap { border: 1px solid var(--line); border-radius: 9px; padding: 12px 14px; margin: 0 0 10px; background: var(--panel); }
.gap-head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.gap-count { font-size: 1.25rem; font-weight: 650; font-variant-numeric: tabular-nums; min-width: 3ch; text-align: right; }
.gap-slug { font-size: 0.95rem; }
.gap-note { margin: 8px 0 4px; max-width: 92ch; }
.gap-sym { margin: 4px 0; color: var(--fg-dim); font-size: 0.85rem; max-width: 100ch; }
.badge { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 0.74rem; font-weight: 600; border: 1px solid var(--line); white-space: nowrap; }
.fix-engine { background: var(--pass-bg); color: var(--pass); }
.fix-dsql { background: var(--blocked-bg); color: var(--blocked); }
.fix-config { background: var(--excluded-bg); color: var(--config); }
.fix-oos { background: var(--excluded-bg); color: var(--excluded); }
.ct-yes { background: var(--fail-bg); color: var(--fail); }
.ct-no { background: var(--excluded-bg); color: var(--excluded); }
.legend { display: flex; flex-wrap: wrap; gap: 14px; margin: 0 0 14px; font-size: 0.85rem; color: var(--fg-dim); }
.two-col { display: flex; flex-wrap: wrap; gap: 20px; }
.two-col > * { flex: 1 1 340px; }
footer { margin-top: 48px; padding-top: 14px; border-top: 1px solid var(--line); color: var(--fg-dim); font-size: 0.85rem; }
pre.cmd { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; overflow-x: auto; font-size: 0.85rem; }
</style>
</head>
<body>
<div class="wrap">

<h1>pgrest-lambda — PostgREST compatibility</h1>
<p class="sub">Upstream PostgREST test suite, extracted to cases and run against a live
Aurora DSQL cluster through the Lambda handler in-process.</p>
<p class="sub fine">run <code>${esc(m.meta.generatedAt)}</code> &nbsp;·&nbsp;
target <code>${esc(m.meta.target)}</code> &nbsp;·&nbsp;
commit <code>${esc(m.meta.commit)}</code> &nbsp;·&nbsp;
harness errors ${num(m.meta.errored)}${
    m.meta.occExhausted === null ? '' : ` &nbsp;·&nbsp; exhausted OCC retries ${num(m.meta.occExhausted)}`
  } &nbsp;·&nbsp; report built <code>${esc(m.meta.reportBuiltAt)}</code></p>

<div class="headline">
  <div class="rate">${pct(h.rate)}<small>${num(h.passed)} of ${num(h.ran)} assertions passed</small></div>
  <p class="denom"><strong>The denominator is ${num(h.ran)} cases</strong> — the
  ${num(h.passed)} that passed plus the ${num(h.failed)} that failed. Those are the upstream
  assertions that actually ran against live Aurora DSQL and are in scope for this architecture.
  ${num(h.total)} cases were extracted in total; the other ${num(h.excluded)} are excluded and
  itemised below: ${num(t.needsConfig || 0)} need a PostgREST process setting the engine has no
  switch for, ${num(t.skipped || 0)} skipped at extraction because the assertion could not be
  represented faithfully, ${num(t.blocked || 0)} blocked because the fixture they need cannot exist
  on DSQL, and ${num(t.outOfScope || 0)} out of scope. Excluded cases are never counted as
  passes.</p>
  <div class="strip">
    <div class="tile"><div class="v">${num(h.total)}</div><div class="k">extracted</div></div>
    <div class="tile pass"><div class="v">${num(h.passed)}</div><div class="k">passed</div></div>
    <div class="tile fail"><div class="v">${num(h.failed)}</div><div class="k">failed</div></div>
    <div class="tile blocked"><div class="v">${num(t.blocked || 0)}</div><div class="k">blocked</div></div>
    <div class="tile config"><div class="v">${num(t.needsConfig || 0)}</div><div class="k">needs engine config</div></div>
    <div class="tile excluded"><div class="v">${num(t.skipped || 0)}</div><div class="k">skipped</div></div>
    <div class="tile excluded"><div class="v">${num(t.outOfScope || 0)}</div><div class="k">out of scope</div></div>
  </div>
</div>

${verdictParagraphs(m)}

<h2 id="progress">Progress since the baseline</h2>
${renderProgress(m)}

<h2 id="measurement">How to read this number</h2>
${renderMeasurement(m)}

<h2>By category</h2>
<p class="fine">Sorted by gap size — failures first, then blocked cases. "Needs config" is cases
that only hold under a non-default PostgREST setting; "Excluded" is skipped plus out-of-scope.
Pass rate is passed / (passed + failed) for that category only.
${m.trend && !m.trend.isSelfComparison ? 'The baseline column is the same category in the first run recorded in <code>conformance/results/history.json</code>.' : ''}</p>
${renderCategories(m)}

<h2>Gaps, ranked by cases</h2>
<div class="legend">
  <span>${fixBadge('engine-fixable')} engine work, nothing in DSQL prevents it</span>
  <span>${fixBadge('dsql-substitute-needed')} needs a replacement for a Postgres feature DSQL lacks, or has none</span>
  <span>${fixBadge('needs-engine-config')} needs a PostgREST process setting the engine does not expose</span>
  <span>${fixBadge('out-of-scope')} not something this architecture promises, or not measurable here</span>
</div>
<p class="fine">One entry per gap slug recorded by the runner (${num(m.gaps.length)} distinct,
0 ungrouped). "Measured" quotes the most common observed symptom verbatim, not an interpretation.
The fixability label and the notes are the only editorial content on this page.</p>
<ol class="gaps">
${renderGaps(m)}
</ol>

<h2 id="dsql">Aurora DSQL limitations</h2>
${renderDsql(m)}

<h2 id="notcounted">Not counted: needs-config, skipped, blocked and out of scope</h2>
${renderExcluded(m)}
${m.cedar
    ? `\n<h2 id="cedar">A separate measurement: Cedar equivalence (not part of the pass rate)</h2>\n${renderCedar(m)}\n`
    : ''}

<footer>
<p>Generated by <code>conformance/report/build-report.mjs</code> from
<code>${esc(relResults)}</code> and <code>${esc(relLoad)}</code>, with the trend read from and
written back to <code>${esc(relHistory)}</code>. Self-contained: the full report dataset is inlined
below as JSON, so this file needs no network access.</p>
<pre class="cmd">node conformance/runner/run.mjs --target dsql --concurrency 1 --reload-per-spec
node conformance/report/build-report.mjs --label &lt;name&gt; --flags "--target dsql --concurrency 1 --reload-per-spec"</pre>
<p class="fine">The prose in this report is generated from the measured numbers, including the
verdict. Nothing here is written by hand except the gap notes and the fixability labels, both
marked as editorial where they appear.</p>
</footer>

</div>
<script type="application/json" id="report-data">${dataJson}</script>
</body>
</html>
`;
}

// ---------------------------------------------------------------- main

function readHistory(path) {
  if (!existsSync(path)) return { description: HISTORY_DESCRIPTION, runs: [] };
  return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * Cases of a trend entry's results file, or null when it is gone. An entry that
 * points at a mutable path (`latest.json`) can end up describing a different run
 * than the one it was written for, so the file's own `generatedAt` has to agree
 * with the entry's before its cases are used for a delta.
 */
function casesOfRun(run) {
  if (!run?.results) return null;
  const path = resolve(REPO, run.results);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (run.generatedAt && parsed.generatedAt && parsed.generatedAt !== run.generatedAt) {
      process.stderr.write(
        `warning: ${run.results} now holds run ${parsed.generatedAt}, not `
          + `${run.generatedAt} — skipping the case delta for "${run.label}"\n`
      );
      return null;
    }
    return parsed.cases || null;
  } catch {
    return null;
  }
}

/**
 * Case-level deltas and the per-run order-dependent counts, both of which need
 * the other runs' results files rather than the counts the trend stores. Absent
 * or unreadable files degrade to null instead of failing the build.
 */
function attachCaseDeltas(trend, runs, results) {
  if (!trend || trend.isSelfComparison) return;
  const currentCases = results.cases || [];
  const baselineCases = casesOfRun(runs[0]);
  const current = runs[runs.length - 1];
  // The newest earlier run measured with exactly the flags this one used: the
  // only pair in the trend a rate comparison is honest about.
  const sameFlags = (r) => (r.flags || '') === (current.flags || '');
  // Same engine, not same commit field: a run measured on an uncommitted working
  // tree records the parent commit, so `tree` decides this when it is set.
  const sameTree = (r) => treeOf(r) !== null && treeOf(r) === treeOf(current);
  const earlier = [...runs.slice(0, -1)].reverse();
  const previousRun = earlier.find((r) => sameFlags(r) && !sameTree(r));
  // Another measurement of the same tree with the same flags is not progress;
  // it is the run-to-run noise, and the report says so rather than hiding it.
  // All of them are kept, not just the newest, because the spread is the claim.
  const repeatRuns = earlier.filter((r) => sameFlags(r) && sameTree(r));

  const pair = (run) => {
    const cases = run ? casesOfRun(run) : null;
    if (!run || !cases) return null;
    return {
      run: trend.runs.find(
        (r) => r.label === run.label && r.generatedAt === run.generatedAt
      ),
      delta: idMatchedDelta(cases, currentCases)
    };
  };

  const repeats = repeatRuns.map(pair).filter(Boolean);
  trend.idMatched = {
    baseline: baselineCases ? idMatchedDelta(baselineCases, currentCases) : null,
    previous: pair(previousRun),
    // The newest repeat keeps the single-pair shape earlier reports used; the
    // full list is what the spread below is computed from.
    repeat: repeats[0] || null,
    repeats
  };

  // The observed range across every run of this tree measured with these flags,
  // including this one. Published rate against the spread it sits in: one run of
  // a distributed database is a sample, and the honest headline says so.
  const treeRuns = [...repeatRuns, current]
    .map((r) => trend.runs.find(
      (x) => x.label === r.label && x.generatedAt === r.generatedAt
    ))
    .filter(Boolean)
    .sort((a, b) => a.passed - b.passed);
  trend.spread = treeRuns.length > 1
    ? {
      tree: treeOf(current),
      flags: current.flags || null,
      runs: treeRuns,
      lowest: treeRuns[0],
      highest: treeRuns[treeRuns.length - 1],
      published: trend.runs.find(
        (x) => x.label === current.label && x.generatedAt === current.generatedAt
      ) || null
    }
    : null;

  trend.rowOrderByRun = runs
    .map((r) => {
      const cases = r === current ? currentCases : casesOfRun(r);
      if (!cases) return null;
      return {
        label: r.label,
        generatedAt: r.generatedAt,
        count: rowOrderFailures(cases).count
      };
    })
    .filter(Boolean);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const results = JSON.parse(readFileSync(opts.results, 'utf8'));

  // Trend first: the current run joins the history, then the report reads the
  // whole history back so the HTML and the file can never disagree.
  let trend = null;
  if (opts.useHistory) {
    const entry = entryFromResults(results, {
      label: opts.label,
      flags: opts.flags,
      note: opts.note,
      tree: opts.tree,
      resultsPath: opts.results
    });
    const history = appendRun(readHistory(opts.history), entry);
    mkdirSync(dirname(opts.history), { recursive: true });
    writeFileSync(opts.history, `${JSON.stringify(history, null, 2)}\n`);
    // The current run is the entry just added, not necessarily the newest by
    // timestamp — report on the results file the caller asked for.
    const ordered = history.runs.filter(
      (r) => !(r.label === entry.label && r.generatedAt === entry.generatedAt)
    );
    trend = buildTrend([...ordered, entry]);
    attachCaseDeltas(trend, [...ordered, entry], results);
    process.stdout.write(
      `history ${relative(REPO, opts.history)}: ${history.runs.length} run(s), `
        + `baseline ${history.runs[0].label} ${history.runs[0].totals.passed}`
        + `/${history.runs[0].totals.passed + history.runs[0].totals.failed}\n`
    );
  }
  if (opts.historyOnly) return;

  const loadReport = JSON.parse(readFileSync(opts.loadReport, 'utf8'));
  // Absent Cedar results drop the section rather than failing the build: the
  // PostgREST measurement does not depend on the equivalence measurement.
  const cedar = opts.cedar && existsSync(opts.cedar)
    ? JSON.parse(readFileSync(opts.cedar, 'utf8'))
    : null;
  const model = buildModel(results, loadReport, trend, cedar);
  const html = renderHtml(model, opts);
  mkdirSync(dirname(opts.out), { recursive: true });
  writeFileSync(opts.out, html);
  const h = model.headline;
  process.stdout.write(
    // Byte length, not character count: the report contains non-ASCII text
    // (— in the prose, é in fixture data), so the two differ and only the
    // byte count matches what the file system reports.
    `wrote ${opts.out} (${num(Buffer.byteLength(html))} bytes)\n` +
      `pass rate ${h.passed}/${h.ran} = ${pct(h.rate)}  ` +
      `[extracted ${h.total}, needs-config ${model.totals.needsConfig || 0}, ` +
      `skipped ${model.totals.skipped}, blocked ${model.totals.blocked}, ` +
      `out-of-scope ${model.totals.outOfScope}]\n` +
      `${model.gaps.length} gap slugs, ${model.dsql.families.length} DSQL drop families\n` +
      `${model.measurement.rowOrder.count} order-dependent failures kept as failures\n` +
      (model.cedar
        ? `cedar equivalence (separate measurement, never added): `
          + `${model.cedar.hold}/${model.cedar.ran} hold, `
          + `${model.cedar.noFairEquivalent} with no fair equivalent, `
          + `${model.cedar.upstreamCasesCovered} upstream cases covered and still `
          + `${model.cedar.upstreamAllFailing ? 'all failing above' : 'NOT all failing above'}\n`
        : '') +
      (trend?.spread
        ? `same tree, ${trend.spread.runs.length} runs with these flags: `
          + `${trend.spread.runs.map((r) => r.passed).join(', ')} of ${trend.spread.highest.ran} `
          + `— published ${model.headline.passed}\n`
        : '') +
      (trend && !trend.isSelfComparison
        ? `vs baseline ${trend.baseline.label}: ${signed(trend.deltaPassed)} passed, `
          + `${signed(trend.deltaFailed)} failed, denominator ${signed(trend.deltaRan)}\n`
        : '') +
      (trend?.idMatched?.baseline
        ? `id-matched vs baseline: +${trend.idMatched.baseline.gained} pass, `
          + `-${trend.idMatched.baseline.lost} regress `
          + `(${trend.idMatched.baseline.matched} shared ids)\n`
        : '') +
      (trend?.idMatched?.previous
        ? `id-matched vs ${trend.idMatched.previous.run.label} (same flags): `
          + `+${trend.idMatched.previous.delta.gained} pass, `
          + `-${trend.idMatched.previous.delta.lost} regress\n`
        : '') +
      (trend?.idMatched?.repeat
        ? `noise vs ${trend.idMatched.repeat.run.label} (same tree, same flags): `
          + `${trend.idMatched.repeat.delta.gained + trend.idMatched.repeat.delta.lost} `
          + `cases differ\n`
        : '')
  );
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
