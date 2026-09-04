// derive.mjs — build conformance/cedar/cases.json from the upstream cases plus
// the hand-written equivalence map.
//
//   node conformance/cedar/derive.mjs            # rewrite cases.json
//   node conformance/cedar/derive.mjs --check    # fail if cases.json is stale
//
// The point of generating rather than hand-writing cases.json is that the
// derivation copies `request` and `expected` out of conformance/cases/
// unchanged. A derived case may substitute the authorization *mechanism* and
// nothing else — no status, body, header or matcher may be softened. The unit
// tests assert exactly that.

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DO_NOT_READ_OVERALL, EQUIVALENCE_MAP } from './equivalence-map.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = join(HERE, '..', '..');
export const GROUP_PATH = join(HERE, 'upstream-group.json');
export const CASES_PATH = join(HERE, 'cases.json');
export const UPSTREAM_CASES_DIR = join(REPO, 'conformance', 'cases');
export const POLICY_DIR = 'conformance/cedar/policies';

/** Fields copied from the upstream case, unchanged. */
export const VERBATIM = ['source', 'line', 'category', 'description',
  'example', 'request', 'expected', 'bodyMatch', 'transforms'];

/** Fields the runner needs to pick the same per-case engine configuration. */
export const CONFIG_FIELDS = ['skipReason', 'skipClass'];

/** Read every extracted upstream case, keyed by id. */
export function loadUpstreamCases(casesDir = UPSTREAM_CASES_DIR) {
  const out = new Map();
  for (const file of readdirSync(casesDir)) {
    if (!file.endsWith('.json')) continue;
    const parsed = JSON.parse(readFileSync(join(casesDir, file), 'utf8'));
    for (const c of parsed.cases || []) out.set(c.id, c);
  }
  return out;
}

/**
 * Does an upstream request establish an identity of its own?
 *
 * `false` means the request carries neither an Authorization header nor a
 * runtime-minted token, so upstream ran it as `db-anon-role`. The derived case
 * records `defaultRole: "anon"` for it — the engine's anonymous principal —
 * instead of the conformance runner's `service_role` default, which would let
 * the shipped service-role bypass answer the question instead of a policy.
 */
export function establishesIdentity(request) {
  if (request?.jwt) return true;
  const headers = request?.headers || {};
  return Object.keys(headers).some((h) => h.toLowerCase() === 'authorization');
}

/** Does this derived case write to the fixtures? */
export function isWrite(request) {
  const method = String(request?.method || 'GET').toUpperCase();
  if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return false;
  // POST /rpc/<f> calls a function. Every function the derived cases call is
  // read-only SQL (privileged_hello is `select 'Privileged hello to ' || $1`),
  // so it is not a write even though the method is POST. The runner re-checks
  // this against the function body before it runs anything.
  return !String(request?.path || '').startsWith('/rpc/');
}

/**
 * Build the derived-case document.
 *
 * @param {Map<string, object>} upstream every extracted upstream case by id
 * @param {object} group the upstream-group.json document
 * @param {object} map the equivalence map
 */
export function deriveCases(upstream, group, map = EQUIVALENCE_MAP) {
  const cases = [];
  const noFairEquivalent = [];
  const missing = [];

  for (const entry of group.upstreamCases) {
    const id = entry.id;
    const verdict = map[id];
    const src = upstream.get(id);
    if (!verdict || !src) { missing.push(id); continue; }

    if (verdict.equivalence === 'none') {
      noFairEquivalent.push({
        upstreamId: id,
        upstreamCategory: entry.category,
        class: verdict.class,
        upstreamMechanism: verdict.upstreamMechanism,
        upstreamExpectedStatus: src.expected?.status ?? null,
        reason: verdict.reason,
        doNotRead: verdict.doNotRead,
      });
      continue;
    }

    const derived = {
      id: `Cedar:${id}`,
      upstreamId: id,
      upstreamMechanism: verdict.upstreamMechanism,
      cedarMechanism: verdict.cedarMechanism,
      policySet: POLICY_DIR,
      policyFile: verdict.policyFile || null,
      doNotRead: verdict.doNotRead,
      // Set where the two mechanisms resolve the caller to different
      // identities, so a status difference is attributed to that rather than to
      // the shape of the denial. See run.mjs `divergenceKind`.
      identityDiffers: verdict.identityDiffers === true,
      defaultRole: establishesIdentity(src.request) ? null : 'anon',
      write: isWrite(src.request),
      skip: false,
    };
    for (const f of VERBATIM) if (f in src) derived[f] = src[f];
    for (const f of CONFIG_FIELDS) if (f in src) derived[f] = src[f];
    cases.push(derived);
  }

  if (missing.length) {
    throw new Error(
      `no equivalence verdict or no upstream case for: ${missing.join(', ')}`);
  }

  return {
    description:
      'Cedar equivalence cases: for each upstream PostgREST case in the group '
      + 'recorded in upstream-group.json — every case carrying the '
      + '`no-set-role` gap when the group was fixed — the same client-visible '
      + 'outcome re-asked with a Cedar policy set standing in for SET ROLE + '
      + 'row-level security. This is a SECOND measurement. It is never added '
      + 'to the PostgREST pass rate, never averaged with it, and never '
      + 'presented as one combined number. Most of these cases now pass that '
      + 'rate on their own, which makes this a cross-check of the same '
      + 'mechanism rather than a substitute for a failure. See '
      + 'docs/reference/cedar-equivalence.md.',
    doNotReadOverall: DO_NOT_READ_OVERALL,
    generatedBy: 'conformance/cedar/derive.mjs',
    upstreamGroup: 'conformance/cedar/upstream-group.json',
    policySet: POLICY_DIR,
    counts: {
      upstreamCases: group.upstreamCases.length,
      derived: cases.length,
      noFairEquivalent: noFairEquivalent.length,
    },
    cases,
    noFairEquivalent,
  };
}

/** Rebuild the document from the files on disk. */
export function build() {
  return deriveCases(
    loadUpstreamCases(),
    JSON.parse(readFileSync(GROUP_PATH, 'utf8')),
  );
}

/** The committed cases.json, as the runner reads it. */
export function readDerived(path = CASES_PATH) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function main() {
  const doc = build();
  const json = `${JSON.stringify(doc, null, 2)}\n`;
  if (process.argv.includes('--check')) {
    if (readFileSync(CASES_PATH, 'utf8') !== json) {
      process.stderr.write(
        'conformance/cedar/cases.json is stale — run '
        + 'node conformance/cedar/derive.mjs\n');
      process.exit(1);
    }
    process.stdout.write('cases.json is up to date\n');
    return;
  }
  writeFileSync(CASES_PATH, json);
  process.stdout.write(
    `wrote ${CASES_PATH}\n  ${doc.counts.derived} derived, `
    + `${doc.counts.noFairEquivalent} with no fair equivalent, `
    + `of ${doc.counts.upstreamCases} upstream cases\n`);
}

const invokedDirectly = process.argv[1]
  && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) main();
