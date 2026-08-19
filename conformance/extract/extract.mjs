#!/usr/bin/env node
// CLI: extract portable conformance cases from the upstream PostgREST specs.
//
//   node conformance/extract/extract.mjs
//   node conformance/extract/extract.mjs --spec-dir /path/to/postgrest/test/spec
//   node conformance/extract/extract.mjs --out conformance/cases --json
//   node conformance/extract/extract.mjs --dry-run          # validate, write nothing
//
// Writes conformance/cases/<SpecName>.json per CONTRACTS.md section 1 and
// prints a per-file extracted/skipped table plus the top skip reasons.

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSpec, validateDocument } from './parse-spec.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');

function parseArgs(argv) {
  const args = {
    specDir: '/home/ec2-user/postgrest-upstream/test/spec',
    out: join(REPO, 'conformance', 'cases'),
    json: false,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--spec-dir') { args.specDir = resolve(argv[++i]); continue; }
    if (a === '--out') { args.out = resolve(argv[++i]); continue; }
    if (a === '--json') { args.json = true; continue; }
    if (a === '--dry-run') { args.dryRun = true; continue; }
    if (a === '--help' || a === '-h') { args.help = true; continue; }
    throw new Error(`unknown argument: ${a}`);
  }
  return args;
}

function walk(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, acc);
    else if (entry.endsWith('.hs')) acc.push(p);
  }
  return acc;
}

/** Group skip reasons into coarse buckets so the summary is readable. */
function bucketReason(reason) {
  const r = reason.toLowerCase();
  if (r.includes('non-default postgrest config')) return 'assertion runs under a non-default PostgREST config';
  if (r.includes('off by default and the engine has no switch')) return 'asserts a PostgREST feature that is off by default';
  if (r.includes('regex') && r.includes('matchheader')) return 'asserts a header against a regex (matchHeader)';
  if (r.includes('custom matchbody')) return 'uses a custom matchBody matcher';
  if (r.includes('actualpgversion')) return 'gated on a PostgreSQL version check';
  if (r.includes('pendingwith')) return 'example is conditionally pending (pendingWith)';
  if (r.includes('request path is not a literal')) return 'request path is not a literal';
  if (r.includes('request body not a literal')) return 'request body is not a literal';
  if (r.includes('request headers not representable')) return 'request headers are not literal';
  if (r.includes('no request helper') || r.includes('unparseable request expression') || r.includes('starts inside a bracket') || r.includes('chained infix')) {
    return 'left side is not a plain hspec-wai request call';
  }
  if (r.includes('not a literal responsematcher')) return 'expectation is a named/computed ResponseMatcher';
  if (r.includes('quasi quote not parseable')) return 'json quasi quote not statically parseable';
  if (r.includes('matchstatus is not a literal')) return 'matchStatus is not a literal';
  if (r.includes('matchheaders is not a literal list')) return 'matchHeaders is not a literal list';
  if (r.includes('unrecognized matchheaders entry')) return 'unrecognized matchHeaders entry';
  if (r.includes('undecodable') || r.includes('cannot decode')) return 'string literal escape not decodable';
  return reason;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(readFileSync(new URL(import.meta.url)).toString().split('\n').slice(1, 12).join('\n') + '\n');
    return 0;
  }

  const files = walk(args.specDir).sort();
  if (!files.length) throw new Error(`no .hs files under ${args.specDir}`);
  if (!args.dryRun) mkdirSync(args.out, { recursive: true });

  const seenIds = new Set();
  const perFile = [];
  const reasonCounts = new Map();
  const filesWritten = [];
  const problems = [];
  let totalSites = 0;
  let totalExtracted = 0;
  let totalNeedsConfig = 0;
  const categoryCounts = new Map();

  for (const file of files) {
    const rel = relative(args.specDir, file);
    const src = readFileSync(file, 'utf8');
    const doc = parseSpec(src, rel);

    problems.push(...validateDocument(doc, seenIds));

    totalSites += doc.cases.length;
    totalExtracted += doc.extractedCases;
    totalNeedsConfig += doc.needsConfigCases;
    perFile.push({
      file: rel,
      extracted: doc.extractedCases,
      skipped: doc.skippedSites,
      needsConfig: doc.needsConfigCases,
    });

    for (const c of doc.cases) {
      if (!c.skip) {
        categoryCounts.set(c.category, (categoryCounts.get(c.category) ?? 0) + 1);
        continue;
      }
      for (const part of c.skipReason.split('; ')) {
        const b = bucketReason(part);
        reasonCounts.set(b, (reasonCounts.get(b) ?? 0) + 1);
      }
    }

    const specName = rel.split('/').pop().replace(/\.hs$/, '');
    const outPath = join(args.out, `${specName}.json`);
    if (!args.dryRun) {
      writeFileSync(outPath, `${JSON.stringify(doc, null, 2)}\n`);
      filesWritten.push(outPath);
    }
  }

  const topReasons = [...reasonCounts.entries()].sort((a, b) => b[1] - a[1]);

  if (args.json) {
    process.stdout.write(`${JSON.stringify({
      totalSites,
      extracted: totalExtracted,
      skipped: totalSites - totalExtracted,
      needsConfig: totalNeedsConfig,
      notRepresentable: totalSites - totalExtracted - totalNeedsConfig,
      perFile,
      topSkipReasons: topReasons.map(([reason, count]) => ({ reason, count })),
      byCategory: Object.fromEntries([...categoryCounts.entries()].sort((a, b) => b[1] - a[1])),
      filesWritten,
      problems,
    }, null, 2)}\n`);
  } else {
    const w = Math.max(...perFile.map((p) => p.file.length));
    process.stdout.write(`spec files: ${files.length}\n`);
    process.stdout.write(`${'file'.padEnd(w)}  extracted  skipped  needs-config\n`);
    for (const p of perFile.sort((a, b) => b.extracted - a.extracted)) {
      process.stdout.write(`${p.file.padEnd(w)}  ${String(p.extracted).padStart(9)}  ${String(p.skipped).padStart(7)}  ${String(p.needsConfig).padStart(12)}\n`);
    }
    process.stdout.write(`\ntotal sites: ${totalSites}  extracted: ${totalExtracted}  skipped: ${totalSites - totalExtracted}`
      + ` (needs-engine-config ${totalNeedsConfig}, not-representable ${totalSites - totalExtracted - totalNeedsConfig})\n`);
    process.stdout.write('\ntop skip reasons:\n');
    for (const [reason, count] of topReasons.slice(0, 20)) {
      process.stdout.write(`  ${String(count).padStart(5)}  ${reason}\n`);
    }
    process.stdout.write('\nextracted by category:\n');
    for (const [cat, count] of [...categoryCounts.entries()].sort((a, b) => b[1] - a[1])) {
      process.stdout.write(`  ${String(count).padStart(5)}  ${cat}\n`);
    }
    if (problems.length) {
      process.stdout.write(`\nVALIDATION PROBLEMS (${problems.length}):\n`);
      for (const p of problems.slice(0, 50)) process.stdout.write(`  ${p}\n`);
    } else {
      process.stdout.write('\nvalidation: OK\n');
    }
  }

  return problems.length ? 1 : 0;
}

process.exitCode = main();
