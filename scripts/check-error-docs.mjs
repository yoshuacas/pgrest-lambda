#!/usr/bin/env node
// check-error-docs.mjs — does docs/reference/errors.md still match the engine?
//
// The error reference is hand-written, and the engine's messages moved to
// upstream PostgREST's wording as conformance work landed. Every message the
// page documents in a `| 4xx | \`text\` |` table row has to appear somewhere in
// the engine's source, and every PostgREST error code the engine constructs has
// to have a section on the page. Neither is a guarantee the prose is right, but
// both catch the drift that silently makes the page lie.
//
// Placeholders in the doc (`{table}`, `{n}`) stand for interpolations. A row
// matches when every literal fragment around them appears in the source, with
// adjacent string concatenations joined first — the engine wraps long messages
// across lines.
//
// Usage: node scripts/check-error-docs.mjs   (exits 1 on a mismatch)

import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const DOC = 'docs/reference/errors.md';

const sources = execSync('git ls-files "src/*.mjs" "src/**/*.mjs"',
  { encoding: 'utf8' })
  .split('\n')
  .filter(f => f && !f.includes('__tests__'));

const raw = sources.map(f => readFileSync(f, 'utf8')).join('\n');
// Join `'a ' + \n 'b'` into `a b`, blank out `${...}`, squash whitespace. The
// `+` is required: without it this would also eat the quote pair in
// `"… before '::'"` and turn a correct row into a false positive.
const flat = raw
  .replace(/['"`]\s*\+\s*['"`]/g, '')
  .replace(/\$\{[^}]*\}/g, ' ')
  .replace(/\s+/g, ' ');

const doc = readFileSync(DOC, 'utf8');
const lines = doc.split('\n');

// 1. Every documented message exists in the engine.
const unknownMessages = [];
lines.forEach((line, i) => {
  const m = line.match(/^\|\s*\d{3}\s*\|\s*`([^`]+)`/);
  if (!m) return;
  const fragments = m[1]
    .split(/\{[^}]*\}/)
    .map(s => s.replace(/\s+/g, ' ').trim())
    // Fragments shorter than this are punctuation, not evidence.
    .filter(s => s.length >= 6);
  if (!fragments.length) return;
  if (!fragments.every(f => flat.includes(f))) {
    unknownMessages.push(`${DOC}:${i + 1}  ${m[1]}`);
  }
});

// 2. Every code the engine emits has a section. Read the codes off the
//    PostgRESTError constructions rather than a list that would itself drift.
const emitted = new Set();
for (const match of raw.matchAll(/'(PGRST\d{3})'/g)) emitted.add(match[1]);
const documented = new Set(
  [...doc.matchAll(/^###\s+(PGRST\d{3})/gm)].map(m => m[1]));
const undocumented = [...emitted].filter(c => !documented.has(c)).sort();

for (const line of unknownMessages) {
  console.log(`message not found in src/: ${line}`);
}
if (undocumented.length) {
  console.log(`codes the engine emits with no section in ${DOC}: `
    + undocumented.join(', '));
}

const problems = unknownMessages.length + undocumented.length;
console.log(problems
  ? `${problems} problem(s)`
  : `${DOC} matches the engine`);
process.exit(problems ? 1 : 0);
