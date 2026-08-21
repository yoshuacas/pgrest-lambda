#!/usr/bin/env node
// run.mjs — runner for the Cedar equivalence measurement.
//
// This is a SECOND, SEPARATE measurement from the PostgREST conformance rate.
// It answers one question: for the upstream cases whose outcome PostgreSQL
// reaches with SET ROLE plus row-level security — neither of which Aurora DSQL
// has — does this engine's Cedar policy layer deliver the SAME client-visible
// outcome (same status, same body, same headers)?
//
//   node conformance/cedar/run.mjs --target dsql
//   node conformance/cedar/run.mjs --target dsql --id Cedar:AuthSpec:73
//
// Rules this file enforces, not just documents:
//   * It never prints, and never computes, a number combining this score with
//     the PostgREST pass rate.
//   * It never touches conformance/results/ or conformance/report/.
//   * Every request and every expectation comes from conformance/cases/ by way
//     of conformance/cedar/derive.mjs, unchanged. The comparison is
//     conformance/runner/run.mjs's own `compare()`, imported, not reimplemented
//     — a private copy could drift into being laxer.
//   * It refuses to run if a derived case would write to the shared fixtures.
//
// Env: DSQL_ENDPOINT / REGION_NAME (never AWS_REGION — reserved by Lambda).

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

import { createPgrest } from '../../src/index.mjs';
import { buildEvent, compare, engineConfigFor } from '../runner/run.mjs';
import { CASES_PATH, readDerived } from './derive.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const POLICIES = join(HERE, 'policies');
const DEFAULT_OUT = join(HERE, 'results');

// Aurora DSQL conformance cluster defaults; env wins (CONTRACTS.md).
const DEFAULT_DSQL_ENDPOINT =
  '6juamhyj5nkoeatkzc3ieaerc4.dsql.us-east-1.on.aws';
const DEFAULT_REGION = 'us-east-1';

const USAGE = `Cedar equivalence runner

  node conformance/cedar/run.mjs [options]

  --target <dsql|postgres>  database under test (default: dsql)
  --id <case-id>            only this derived id or id prefix (repeatable)
  --timeout <ms>            per-case timeout (default 30000)
  --out-dir <path>          default conformance/cedar/results
  --list                    print the selected ids and exit
  --help

This score is NOT the PostgREST pass rate. It is never added to it, never
averaged with it, and never presented as a single combined number.
`;

export function parseArgs(argv) {
  const opts = {
    target: 'dsql', ids: [], timeout: 30000, outDir: DEFAULT_OUT,
    list: false, help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--target') opts.target = next();
    else if (a === '--id') opts.ids.push(next());
    else if (a === '--timeout') opts.timeout = parseInt(next(), 10);
    else if (a === '--out-dir') opts.outDir = next();
    else if (a === '--list') opts.list = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else throw new Error(`unknown option ${a}`);
  }
  return opts;
}

export function selectDerived(cases, ids) {
  if (!ids.length) return cases;
  return cases.filter((c) => ids.some(
    (id) => c.id === id || c.id.startsWith(id) || c.upstreamId === id));
}

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

/**
 * API Gateway fills in Content-Length on the proxy result; the handler never
 * emits it. Upstream asserts it on some of these cases, so the same fill-in
 * conformance/runner/run.mjs does has to happen here or every assertion would
 * report `<absent>` — a harness artefact, not a divergence.
 */
export function withContentLength(response) {
  const headers = { ...(response.headers || {}) };
  if (Object.keys(headers).some((h) => h.toLowerCase() === 'content-length')) {
    return headers;
  }
  const body = response.body;
  if (body == null || body === '') return headers;
  headers['Content-Length'] = String(response.isBase64Encoded
    ? Buffer.from(body, 'base64').length
    : Buffer.byteLength(body, 'utf8'));
  return headers;
}

const MAX_ACTUAL_BODY_CHARS = 2000;

/** The response body as recorded in the results file, truncated. */
export function recordBody(bodyText) {
  const s = String(bodyText ?? '');
  if (s === '') return null;
  return s.length <= MAX_ACTUAL_BODY_CHARS
    ? s
    : `${s.slice(0, MAX_ACTUAL_BODY_CHARS)}…[${s.length} chars]`;
}

/**
 * Classify one comparison into an equivalence verdict.
 *
 * `hold` — the Cedar mechanism produced the same client-visible outcome.
 * `diverges` — it did not. There is no third verdict on purpose: a derived
 * case can neither be skipped nor excluded at run time, because that is how a
 * second measurement starts flattering itself.
 */
export function verdictFor(comparison) {
  return comparison.ok ? 'hold' : 'diverges';
}

/** Why a divergence happened, for the summary. Never changes the verdict. */
export function divergenceKind(derived, actualStatus, comparison) {
  const expected = derived.expected?.status ?? null;
  if (!comparison.statusOk) {
    // A 401-vs-403 used to mean one thing: every Cedar denial answered 403
    // while upstream answered 401 for an anonymous caller. src/rest/cedar.mjs
    // now takes upstream's split (`authed ? 403 : 401`), so a residual
    // 401-vs-403 has a different cause and must not keep the old label — that
    // label would read as "the denial shape is still wrong" when the shape is
    // right and the disagreement is about who the caller is. For AuthSpec:130
    // and :135 upstream falls back to db-anon-role on a token with no `role`
    // claim while the engine reads it as "authenticated"; for ErrorSpec:123
    // Cedar's open principal set cannot tell a nonexistent role from an
    // ungranted one. Those are identity-mapping differences, flagged in
    // equivalence-map.mjs, not denial-shape ones. Closing them would mean
    // changing what identity a role-less token gets, which is an auth-contract
    // decision and not something to do for a score.
    if (derived.identityDiffers) return 'identity-mapping';
    return expected === 401 && actualStatus === 403
      ? 'deny-status-401-vs-403'
      : 'status';
  }
  if (!comparison.bodyOk) return 'body';
  if (comparison.headerMismatches?.length
      || comparison.headersPresentUnexpectedly?.length) {
    return 'headers';
  }
  return 'unknown';
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

/** Roll the outcomes up. Deliberately produces no combined-with-PostgREST number. */
export function summarize(doc, outcomes) {
  const hold = outcomes.filter((o) => o.verdict === 'hold');
  const diverges = outcomes.filter((o) => o.verdict === 'diverges');
  const byKind = {};
  for (const o of diverges) {
    byKind[o.divergence] = (byKind[o.divergence] || 0) + 1;
  }
  const byClass = {};
  for (const n of doc.noFairEquivalent) {
    byClass[n.class] = (byClass[n.class] || 0) + 1;
  }
  return {
    measurement: 'cedar-equivalence',
    notThePostgrestRate:
      'This is equivalent behaviour through a different mechanism. It is not '
      + 'a PostgREST pass rate, it is never added to one, and the upstream '
      + 'cases it derives from remain failures in '
      + 'conformance/results/latest.json.',
    equivalencesRan: outcomes.length,
    equivalencesHold: hold.length,
    equivalencesDiverge: diverges.length,
    divergenceKinds: byKind,
    noFairEquivalent: doc.noFairEquivalent.length,
    noFairEquivalentByClass: byClass,
    upstreamCasesCovered: doc.counts.upstreamCases,
  };
}

function gitCommit() {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'],
      { cwd: REPO, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { process.stdout.write(USAGE); return; }

  const doc = readDerived();
  const cases = selectDerived(doc.cases, opts.ids);
  if (opts.list) {
    for (const c of cases) {
      process.stdout.write(`${c.id}\t${c.category}\t${c.description || ''}\n`);
    }
    return;
  }

  // The derived set is read-only by construction. Assert it, rather than trust
  // it: this runner shares a cluster with the PostgREST measurement and must
  // never leave a row behind that the reading cases there would then see.
  const writers = cases.filter((c) => c.write);
  if (writers.length) {
    throw new Error(
      'refusing to run: these derived cases would write to the shared '
      + `fixtures: ${writers.map((c) => c.id).join(', ')}`);
  }

  process.stderr.write(
    `[cedar] ${cases.length}/${doc.cases.length} derived case(s), `
    + `${doc.noFairEquivalent.length} upstream case(s) with no fair `
    + `equivalent, target=${opts.target}\n`);
  process.stderr.write(`[cedar] policy set: ${POLICIES}\n`);

  // Aurora DSQL ships one text search configuration, `simple`, so a working
  // deployment sets this; the PostgREST runner does the same.
  if (opts.target === 'dsql' && !process.env.PGREST_DEFAULT_TS_CONFIG) {
    process.env.PGREST_DEFAULT_TS_CONFIG = 'simple';
  }

  // Identical to conformance/runner/run.mjs's base engine config except for
  // `policies`, which points at the equivalence policy set instead of the
  // shipped default. Holding everything else constant is what makes the two
  // measurements comparable case by case.
  const baseEngineConfig = {
    database: resolveTargetConfig(opts.target),
    jwtSecret: process.env.JWT_SECRET
      || 'conformance-runner-secret-not-used-for-verification',
    auth: false,
    policies: POLICIES,
    schemaCacheTtl: 24 * 60 * 60 * 1000,
    docs: false,
    production: false,
    errors: { verbose: false },
    cors: { allowedOrigins: '*', allowCredentials: false },
    bulkMutationGuard: 'off',
  };

  const engines = new Map();
  const engineFor = (label, extra) => {
    let engine = engines.get(label);
    if (!engine) {
      engine = createPgrest({ ...baseEngineConfig, ...extra });
      engines.set(label, engine);
      if (label !== 'base') {
        process.stderr.write(`[cedar] engine "${label}" booted\n`);
      }
    }
    return engine;
  };

  const outcomes = [];
  try {
    for (const derived of cases) {
      // Same per-case engine configuration the PostgREST runner uses, so a
      // jwt-aud / JWKS case is measured under the same server settings.
      const entry = engineConfigFor(derived);
      const handler = engineFor(
        entry ? entry.label : 'base', entry ? entry.config : {}).rest;
      const event = buildEvent(derived, { role: derived.defaultRole || 'anon' });

      let response = null;
      let thrown = null;
      try {
        response = await withTimeout(handler(event), opts.timeout);
      } catch (err) {
        thrown = err && err.message ? err.message : String(err);
      }

      if (!response) {
        outcomes.push({
          id: derived.id,
          upstreamId: derived.upstreamId,
          verdict: 'diverges',
          divergence: 'error',
          reason: thrown || 'handler returned nothing',
          expectedStatus: derived.expected?.status ?? null,
          actualStatus: null,
          engineConfig: entry ? entry.label : 'base',
        });
        continue;
      }

      const actual = {
        statusCode: response.statusCode,
        headers: withContentLength(response),
        body: response.body ?? '',
      };
      const comparison = compare(derived, actual);
      const verdict = verdictFor(comparison);
      outcomes.push({
        id: derived.id,
        upstreamId: derived.upstreamId,
        verdict,
        divergence: verdict === 'hold'
          ? null : divergenceKind(derived, actual.statusCode, comparison),
        reason: verdict === 'hold' ? null : comparison.diff,
        expectedStatus: derived.expected?.status ?? null,
        actualStatus: actual.statusCode,
        actualBody: recordBody(actual.body),
        engineConfig: entry ? entry.label : 'base',
        upstreamMechanism: derived.upstreamMechanism,
        cedarMechanism: derived.cedarMechanism,
        doNotRead: derived.doNotRead,
      });
      process.stderr.write(
        `[cedar] ${verdict === 'hold' ? 'hold    ' : 'DIVERGES'} `
        + `${derived.id}\n`);
    }
  } finally {
    for (const engine of engines.values()) {
      if (typeof engine._db.close === 'function') {
        // eslint-disable-next-line no-await-in-loop
        await Promise.resolve(engine._db.close()).catch(() => {});
      }
    }
  }

  const summary = summarize(doc, outcomes);
  const results = {
    generatedAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    target: opts.target,
    commit: gitCommit(),
    casesFile: CASES_PATH,
    policySet: POLICIES,
    summary,
    outcomes,
    noFairEquivalent: doc.noFairEquivalent,
  };

  mkdirSync(opts.outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const latest = join(opts.outDir, 'latest.json');
  const copy = join(opts.outDir, `run-${stamp}.json`);
  const json = `${JSON.stringify(results, null, 2)}\n`;
  writeFileSync(latest, json);
  writeFileSync(copy, json);

  process.stdout.write(
    `${summary.equivalencesHold}/${summary.equivalencesRan} equivalences `
    + `hold, ${summary.noFairEquivalent} upstream cases have no fair `
    + 'equivalent\n');
  for (const [kind, n] of Object.entries(summary.divergenceKinds)) {
    process.stdout.write(`  diverges: ${String(n).padStart(3)}  ${kind}\n`);
  }
  for (const [cls, n] of Object.entries(summary.noFairEquivalentByClass)) {
    process.stdout.write(`  no equivalent: ${String(n).padStart(3)}  ${cls}\n`);
  }
  process.stdout.write(`${summary.notThePostgrestRate}\n`);
  process.stdout.write(`wrote ${latest}\n      ${copy}\n`);
}

const invokedDirectly = process.argv[1]
  && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  main().catch((err) => {
    process.stderr.write(`[cedar] fatal: ${err.stack || err.message}\n`);
    process.exit(1);
  });
}
