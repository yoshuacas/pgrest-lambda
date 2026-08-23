#!/usr/bin/env node
// transform.mjs — rewrite the upstream PostgREST test fixtures into SQL that
// Aurora DSQL will accept, and record everything that had to change.
//
//   node conformance/fixtures/transform.mjs
//
// Outputs (see conformance/CONTRACTS.md section 2):
//   conformance/fixtures/dsql/NN-<name>.sql   loadable SQL, applied in order
//   conformance/fixtures/relationships.json   foreign keys DSQL cannot store
//   conformance/fixtures/transform-report.json  drops + rewrites (input to load.mjs)
//
// load.mjs merges the drop list into load-report.json after applying the SQL.
//
// Every DSQL limitation acted on here was measured with
// conformance/scripts/dsql-probe.sh — see conformance/DSQL-CAPABILITIES.md.
// Gaps found while building this transformer and NOT yet in that file:
//   - array column types are rejected  ("datatype text[] not supported")
//   - identity columns must be bigint  ("identity column type must be bigint")
//   - CREATE INDEX requires the ASYNC keyword
//   - xml / money / bit / inet / geometric / range / tsvector column types are
//     all rejected, even though the corresponding expressions work
//   - DDL cannot be batched: "multiple ddl statements not supported in a
//     transaction" — one statement per round trip, autocommit
//   - CREATE PROCEDURE, CREATE AGGREGATE, CREATE RULE, DROP TYPE, COPY
//     to/from file, WITH (...) / INHERITS / COLLATE / DEFERRABLE clauses

import { readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  splitStatements, stripComments, norm, matchParen, splitCommas,
  tokenize, identValue,
} from './sqlsplit.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const UPSTREAM = process.env.PGREST_UPSTREAM
  || '/home/ec2-user/postgrest-upstream/test/spec/fixtures';
const OUT_DIR = join(HERE, 'dsql');

// The two stages the sequence-rewind pass below needs by name: the runner
// re-applies the data stage on its own, without the schema stage.
const SCHEMA_STAGE = '03-schema.sql';
const DATA_STAGE = '07-data.sql';

const STAGES = [
  { file: 'database.sql', out: '01-database.sql' },
  { file: 'roles.sql', out: '02-roles.sql' },
  { file: 'schema.sql', out: '03-schema.sql' },
  { file: 'jwt.sql', out: '04-jwt.sql' },
  { file: 'jsonschema.sql', out: '05-jsonschema.sql' },
  { file: 'privileges.sql', out: '06-privileges.sql' },
  { file: 'data.sql', out: '07-data.sql' },
];

// Schemas the fixtures create, in the order roles.sql drops them.
const FIXTURE_SCHEMAS = [
  'test', 'private', 'postgrest', 'jwt', 'public', 'تست', 'extensions', 'v1', 'v2',
  'SPECIAL "@/\\#~_-', 'EXTRA "@/\\#~_-',
];

// Measured: a DSQL database allows 10 user schemas ("more than 10 schemas not
// allowed"); `public` does not count against the limit. The fixtures ask for
// exactly 10, so any other schema on the cluster pushes CREATE SCHEMA over the
// edge. `extensions` only ever holds postgis / isn objects, none of which DSQL
// can create, so it is dropped to leave one slot of headroom.
const SKIP_SCHEMAS = new Set(['extensions']);

// `public` exists already and is owned by pg_database_owner: DROP SCHEMA public
// fails with "must be owner of schema public" and CREATE SCHEMA public fails
// with "schema public already exists". Objects inside it are droppable, which is
// what load.mjs does before applying the files.
const UNDROPPABLE_SCHEMAS = new Set(['public']);

// Upstream runs its suite with `db-schemas=test`, so almost every fixture object
// lives in schema `test` (257 of 288 relations, 147 of 176 functions). The
// pgrest-lambda engine exposes the `public` schema only (CLAUDE.md rule 9,
// hardcoded `nspname = 'public'` in src/rest/schema-cache.mjs), so fixtures in
// `test` are invisible to it: a first end-to-end run scored 0/336 on
// select+filters with 296 cases failing as "engine-public-schema-only".
//
// The exposed schema is a deployment choice, not a REST feature, so the fixture
// side moves instead of the engine: every `test` object is created in `public`.
// Verified on the live cluster before switching — zero name collisions between
// the two schemas for relations, functions, sequences or domains. Every other
// fixture schema (private, postgrest, jwt, v1, v2, تست, SPECIAL/EXTRA) keeps its
// own name, so the tests that depend on cross-schema references still behave.
//
// Consequence for the report: upstream error bodies that name the schema say
// "test.foo" (e.g. PGRST205 "Could not find the table 'test.faketable'"), and
// the engine says "public.foo". ~20 extracted cases assert such a body and fail
// on that text; they are real, reported mismatches, not hidden.
const SCHEMA_ALIASES = new Map([['test', 'public']]);

/** Regex-safe alternation of the aliased schema names, quoted and bare. */
const ALIAS_NAME_RE = new RegExp(
  `(?:${[...SCHEMA_ALIASES.keys()]
    .map((s) => `"${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`
      + `|${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)
    .join('|')})`);

/** `test.` / `"test".` used as a qualification, anywhere in a chunk of SQL. */
const ALIAS_QUAL_RE = new RegExp(
  `(?<![A-Za-z0-9_$."])(${ALIAS_NAME_RE.source})\\s*\\.\\s*`, 'g');

function aliasOf(name) { return SCHEMA_ALIASES.get(name) || null; }

function unquoteIdent(raw) {
  const t = raw.trim();
  return t.startsWith('"') ? t.slice(1, -1).replace(/""/g, '"') : t;
}

/** Rewrite `test.x` -> `public.x` inside a body/comment chunk. */
function mapQualifications(chunk) {
  return chunk.replace(ALIAS_QUAL_RE, (m, name) => {
    const target = aliasOf(unquoteIdent(name));
    return target ? `${ident(target)}.` : m;
  });
}

/**
 * Rewrite every reference to an aliased schema in one statement.
 *
 * Qualified references are found by token so that data strings are never
 * touched; dollar-quoted bodies (and the single-quoted body of a CREATE
 * FUNCTION) are rewritten textually because they are SQL, not data. Bare
 * schema-name positions — `SET search_path`, `CREATE/DROP/ALTER/COMMENT ON
 * SCHEMA`, `GRANT ... ON SCHEMA` — carry no dot and are handled explicitly.
 */
function mapSchemaAliases(sql) {
  if (!SCHEMA_ALIASES.size) return sql;

  const isCreateFunction = /^\s*create\s+(or\s+replace\s+)?function\b/i
    .test(stripComments(sql).trim());

  // 1. qualified references, token by token
  const toks = tokenize(sql);
  let out = '';
  let cursor = 0;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.kind === 'dollar' || t.kind === 'comment'
      || (t.kind === 'string' && isCreateFunction)) {
      const mapped = mapQualifications(sql.slice(t.start, t.end));
      out += sql.slice(cursor, t.start) + mapped;
      cursor = t.end;
      continue;
    }
    if (t.kind !== 'word' && t.kind !== 'ident') continue;
    const target = aliasOf(identValue(t));
    if (!target) continue;
    const prev = toks[i - 1];
    const next = toks[i + 1];
    if (prev && prev.v === '.') continue;          // `x.test` — a column, not a schema
    if (!next || next.v !== '.') continue;         // not a qualification
    out += sql.slice(cursor, t.start) + ident(target);
    cursor = t.end;
  }
  out += sql.slice(cursor);

  // 2. bare schema-name positions: the name list that follows the SCHEMA
  //    keyword (CREATE/DROP/ALTER/COMMENT ON SCHEMA x, GRANT ... ON SCHEMA a, b,
  //    GRANT ... ON ALL TABLES IN SCHEMA a, b).
  const edits = [];
  const toks2 = tokenize(out);
  for (let i = 0; i < toks2.length; i++) {
    if (toks2[i].kind !== 'word' || toks2[i].v.toLowerCase() !== 'schema') continue;
    let j = i + 1;
    if (toks2[j] && toks2[j].v.toLowerCase() === 'if') j += 3; // IF NOT EXISTS
    for (;;) {
      const nt = toks2[j];
      if (!nt || (nt.kind !== 'word' && nt.kind !== 'ident')) break;
      const target = aliasOf(identValue(nt));
      if (target) edits.push({ start: nt.start, end: nt.end, text: ident(target) });
      j++;
      if (toks2[j] && toks2[j].v === ',') { j++; continue; }
      break;
    }
  }
  // 3. the search_path list (`SET search_path = test, "تست", pg_catalog`). The
  //    statement may be preceded by a comment, so this is found by token, not
  //    by anchoring a regex at the start of the text.
  const spIdx = toks2.findIndex((t, k) => t.kind === 'word'
    && t.v.toLowerCase() === 'search_path'
    && toks2[k + 1] && (toks2[k + 1].v === '=' || toks2[k + 1].v.toLowerCase() === 'to'));
  if (spIdx !== -1 && toks2[spIdx + 2]) {
    const listStart = toks2[spIdx + 2].start;
    const semi = out.lastIndexOf(';');
    const listEnd = semi > listStart ? semi : out.length;
    const mapped = splitCommas(out.slice(listStart, listEnd)).map((p) => {
      const target = aliasOf(unquoteIdent(p));
      return target ? ident(target) : p.trim();
    }).join(', ');
    edits.push({ start: listStart, end: listEnd, text: mapped });
  }

  for (const e of edits.sort((a, b) => b.start - a.start)) {
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
  }

  return out;
}

// ---------------------------------------------------------------------------
// measured-unsupported column types
// ---------------------------------------------------------------------------

const UNSUPPORTED_TYPES = new Set([
  'xml', 'money', 'tsvector', 'tsquery', 'jsonpath', 'pg_lsn', 'txid_snapshot',
  'bit', 'bit varying', 'varbit',
  'inet', 'cidr', 'macaddr', 'macaddr8',
  'point', 'line', 'lseg', 'box', 'path', 'polygon', 'circle',
  'int4range', 'int8range', 'numrange', 'tsrange', 'tstzrange', 'daterange',
  'int4multirange', 'int8multirange', 'nummultirange', 'tsmultirange',
  'tstzmultirange', 'datemultirange',
  'tid', 'int2vector', 'oidvector', 'regclass', 'regproc', 'regtype',
  // extension types: the extensions themselves cannot be created on DSQL
  'hstore', 'ltree', 'citext', 'isbn', 'issn', 'ean13', 'upc', 'isbn13',
  'issn13', 'ismn', 'ismn13', 'cube', 'geometry', 'geography', 'vector',
]);

// Types that do not exist on DSQL at all: an argument, a return value or a
// column of one of these is impossible. Everything here comes from an extension
// DSQL cannot install.
const NONEXISTENT_TYPES = new Set([
  'hstore', 'ltree', 'citext', 'isbn', 'issn', 'ean13', 'upc', 'isbn13',
  'issn13', 'ismn', 'ismn13', 'cube', 'geometry', 'geography', 'vector',
]);

// Measured 2026-08-19: these types exist but cannot be *produced*. DSQL accepts
// them as function parameters and rejects them as return types with
// "datatype <t> not supported". Arrays, tsvector, tsquery, inet, uuid, bytea,
// pg_lsn, tid and the reg* types all return fine — only columns reject those.
const UNSUPPORTED_RETURN_TYPES = new Set([
  'money', 'xml', 'jsonpath', 'macaddr', 'macaddr8', 'txid_snapshot',
  'bit', 'bit varying', 'varbit', 'cidr',
  'point', 'line', 'lseg', 'box', 'path', 'polygon', 'circle',
  'int4range', 'int8range', 'numrange', 'tsrange', 'tstzrange', 'daterange',
  'int4multirange', 'int8multirange', 'nummultirange', 'tsmultirange',
  'tstzmultirange', 'datemultirange',
]);

// Functions the fixtures reach for that come from an extension DSQL cannot
// install. Populated when the matching CREATE EXTENSION is dropped.
const EXTENSION_FUNCTIONS = {
  pgcrypto: ['digest', 'hmac', 'crypt', 'gen_salt', 'gen_random_bytes',
    'pgp_sym_encrypt', 'pgp_sym_decrypt', 'pgp_pub_encrypt', 'pgp_pub_decrypt',
    'armor', 'dearmor'],
  ltree: ['ltree2text', 'text2ltree', 'lca', 'subltree', 'subpath', 'nlevel'],
  isn: ['isbn13_in', 'make_valid', 'is_valid'],
};

const TYPE_CATEGORIES = [
  [/\[\s*\]\s*$/, 'array', ['filters', 'select']],
  [/^(tsvector|tsquery)/, 'text-search', ['filters']],
  [/range$/, 'range', ['filters']],
  [/^xml/, 'xml', ['media-types']],
  [/^(money|bit|bit varying|varbit)/, 'numeric-or-bit', ['select']],
  [/^(inet|cidr|macaddr)/, 'network', ['select']],
  [/^(point|line|lseg|box|path|polygon|circle|geometry|geography)/, 'geometric', ['select']],
];

function typeCategories(typeNorm) {
  for (const [re, , cats] of TYPE_CATEGORIES) if (re.test(typeNorm)) return cats;
  return ['select'];
}

const CAT_BY_KIND = {
  extension: ['rpc', 'select'],
  type: ['rpc', 'select', 'openapi'],
  domain: ['rpc', 'select', 'openapi'],
  function: ['rpc'],
  procedure: ['rpc'],
  aggregate: ['rpc'],
  cast: ['media-types', 'rpc'],
  trigger: ['insert', 'update', 'rpc'],
  rule: ['insert'],
  'materialized-view': ['select', 'embedding'],
  view: ['select', 'embedding'],
  table: ['select', 'embedding', 'insert', 'update', 'delete'],
  'partitioned-table': ['embedding', 'select'],
  column: ['select'],
  index: ['filters'],
  constraint: ['insert', 'upsert', 'singular'],
  'foreign-key': ['embedding'],
  policy: ['auth'],
  statement: [],
  data: ['select'],
};

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------

const relationships = [];
const dropped = [];
const rewrites = [];
/** custom type/domain names that could not be created (bare and qualified) */
const unavailableTypes = new Set();
/** qualified names of tables/views that could not be created */
const droppedRelations = new Set();
/** qualified names of functions that could not be created */
const droppedFunctions = new Set();
/** bare names of functions provided by extensions DSQL could not install */
const unavailableFunctions = new Set();
/** qualified table -> Set of dropped column names */
const droppedColumns = new Map();
/** qualified table -> declaration-order column list, with a dropped flag */
const tableColumns = new Map();
/** qualified table -> table constraint text folded in from ALTER TABLE */
let pendingPk = new Map();
/**
 * qualified table -> primary key column list, in declaration order.
 *
 * Needed because `REFERENCES t` with no column list targets `t`'s PRIMARY KEY
 * (SQL default), and that key may be declared after the referencing table. The
 * relationships whose foreign columns were left empty are resolved against this
 * map once every statement has been parsed — see resolveImpliedForeignColumns().
 */
const tablePrimaryKeys = new Map();

let searchPath = ['public'];

/**
 * Relations already emptied earlier in the file being transformed.
 *
 * Upstream data.sql is not re-runnable on its own: it TRUNCATEs most tables
 * before inserting but relies on roles.sql/schema.sql having just recreated the
 * schemas for the rest (private.labels, private.label_screen, test.car_brands).
 * Re-applying it a second time then fails — measured, on the live cluster:
 * `duplicate key value violates unique constraint "car_brands_pkey"` x3 and
 * `more than one row returned by a subquery used as an expression` for
 * label_screen, whose values are `(SELECT id FROM labels WHERE ...)`.
 *
 * The conformance runner needs a data-only reload (`--reload-data`) because
 * mutating cases write to the live fixtures and DSQL has no SAVEPOINT, so the
 * first INSERT into a relation that nothing has cleared yet gets a DELETE FROM
 * in front of it. At that point upstream's table is empty too, so this changes
 * the loaded rows not at all — it only makes the file idempotent. Reset per
 * file; only data.sql has top-level INSERTs, so no other stage is affected.
 */
let clearedRelations = new Set();

function currentSchema() { return searchPath[0] || 'public'; }

function qual(schema, name) { return `${schema || currentSchema()}.${name}`; }

function drop(object, kind, reason, extraCats) {
  dropped.push({
    object,
    kind,
    reason,
    affectsCategories: extraCats || CAT_BY_KIND[kind] || [],
  });
}

function rewrite(object, kind, change) {
  rewrites.push({ object, kind, change });
}

// ---------------------------------------------------------------------------
// name / type helpers
// ---------------------------------------------------------------------------

function normType(t) {
  return stripComments(t).replace(/\s+/g, ' ').trim().toLowerCase()
    .replace(/\s*\(\s*/g, '(').replace(/\s*\)\s*/g, ')');
}

/** Strip length/precision modifiers and schema qualification for lookup. */
function typeBase(typeNorm) {
  let t = typeNorm.replace(/\(.*?\)/g, '').trim();
  const isArray = /\[\s*\]/.test(t) || /\barray\b/.test(t);
  t = t.replace(/\[\s*\]/g, '').replace(/\barray\b/g, '').trim();
  t = t.replace(/^"(.*)"$/, '$1');
  const bare = t.includes('.') ? t.split('.').pop().replace(/^"(.*)"$/, '$1') : t;
  return { full: t, bare, isArray };
}

function typeSupported(typeNorm) {
  const { full, bare, isArray } = typeBase(typeNorm);
  if (isArray) return false;
  if (UNSUPPORTED_TYPES.has(full) || UNSUPPORTED_TYPES.has(bare)) return false;
  if (unavailableTypes.has(full) || unavailableTypes.has(bare)) return false;
  // a table/view row type used as a column type
  if (droppedRelations.has(full)) return false;
  return true;
}

/** Does this type exist on DSQL at all (as a parameter type, say)? */
function typeExists(typeNorm) {
  const { full, bare } = typeBase(typeNorm);
  if (NONEXISTENT_TYPES.has(full) || NONEXISTENT_TYPES.has(bare)) return false;
  if (unavailableTypes.has(full) || unavailableTypes.has(bare)) return false;
  if (droppedRelations.has(full)) return false;
  return true;
}

/** Can a function return this type? */
function returnTypeSupported(typeNorm) {
  const { full, bare, isArray } = typeBase(typeNorm);
  if (!typeExists(typeNorm)) return false;
  if (isArray) return true;
  return !(UNSUPPORTED_RETURN_TYPES.has(full) || UNSUPPORTED_RETURN_TYPES.has(bare));
}

// The fixtures deliberately shadow built-in type names (`create type bit as
// enum ...` in the postgrest schema, for instance). Dropping such a type must
// not make every later use of the built-in name look unavailable.
const BUILTIN_TYPE_NAMES = new Set([
  'bit', 'box', 'line', 'path', 'point', 'polygon', 'circle', 'lseg', 'money',
  'xml', 'text', 'json', 'jsonb', 'date', 'time', 'timestamp', 'timestamptz',
  'interval', 'numeric', 'decimal', 'char', 'character', 'varchar', 'int',
  'int2', 'int4', 'int8', 'integer', 'bigint', 'smallint', 'boolean', 'bool',
  'bytea', 'uuid', 'inet', 'cidr', 'macaddr', 'tsvector', 'tsquery', 'name',
  'oid', 'real', 'float', 'float4', 'float8', 'serial', 'record',
]);

function markTypeUnavailable(schema, name) {
  const bare = name.toLowerCase();
  if (!BUILTIN_TYPE_NAMES.has(bare)) unavailableTypes.add(bare);
  if (schema) unavailableTypes.add(`${schema.toLowerCase()}.${bare}`);
}

/**
 * Match `name` as an object reference, bare or schema-qualified. A bare name
 * must not be preceded by a dot (so `other.items` does not match `items`);
 * a qualified name may be.
 */
function referencesName(text, name) {
  const qualified = name.includes('.');
  const lookbehind = qualified ? '(?<![A-Za-z0-9_"])' : '(?<![A-Za-z0-9_."])';
  const body = qualified
    ? name.split('.').map((p) => `"?${escapeRe(p)}"?`).join('\\s*\\.\\s*')
    : escapeRe(name);
  return new RegExp(`${lookbehind}${body}(?![A-Za-z0-9_"])`, 'i').test(text);
}

/** Words in a statement that name an object we could not create. */
function unmetDependency(sql) {
  const text = stripComments(sql);
  for (const t of unavailableTypes) {
    if (/[^A-Za-z0-9_.]/.test(t)) {
      // names like "text/xml" only ever appear double-quoted
      const parts = t.split('.');
      const quoted = `"${parts[parts.length - 1].replace(/"/g, '""')}"`;
      if (text.toLowerCase().includes(quoted)) return { kind: 'type', name: t };
      continue;
    }
    if (referencesName(text, t)) return { kind: 'type', name: t };
  }
  for (const r of droppedRelations) {
    if (/[^A-Za-z0-9_.]/.test(r)) continue;
    const bare = r.split('.').slice(1).join('.');
    if (bare && referencesName(text, bare)) return { kind: 'relation', name: r };
    if (referencesName(text, r)) return { kind: 'relation', name: r };
  }
  // a function we could not create, called bare or schema-qualified
  for (const f of droppedFunctions) {
    const bare = f.includes('.') ? f.split('.').pop() : f;
    if (!/^[A-Za-z0-9_]+$/.test(bare)) continue;
    if (new RegExp(`(?<![A-Za-z0-9_"])${escapeRe(bare)}\\s*\\(`, 'i').test(text)) {
      return { kind: 'function', name: f };
    }
  }
  // a function that only exists inside an extension DSQL cannot install
  for (const f of unavailableFunctions) {
    if (new RegExp(`(?<![A-Za-z0-9_"])${escapeRe(f)}\\s*\\(`, 'i').test(text)) {
      return { kind: 'function', name: `${f}() (extension function)` };
    }
  }
  // a column that was pruned, mentioned together with its table. Column
  // references are usually qualified (`next.geom`), so a leading dot is allowed.
  for (const [table, cols] of droppedColumns) {
    const bare = table.split('.').slice(1).join('.');
    if (!referencesName(text, table) && !(bare && referencesName(text, bare))) continue;
    for (const c of cols) {
      if (!/^[A-Za-z0-9_]+$/.test(c)) continue;
      if (new RegExp(`(?<![A-Za-z0-9_"])${escapeRe(c)}(?![A-Za-z0-9_"])`, 'i').test(text)) {
        return { kind: 'column', name: `${table}.${c}` };
      }
    }
  }
  // an object in a schema we skipped entirely
  for (const s of SKIP_SCHEMAS) {
    if (new RegExp(`(?<![A-Za-z0-9_."])${escapeRe(s)}\\s*\\.`, 'i').test(text)) {
      return { kind: 'schema', name: s };
    }
  }
  // an explicit cast to a type DSQL does not have, e.g. `input::isbn`.
  // Only non-existent types matter: casts to money/bit/xml/ranges all evaluate
  // fine, it is columns and return values of those types that DSQL rejects.
  const cast = /::\s*("?[A-Za-z_][A-Za-z0-9_]*"?\s*\.\s*)?"?([A-Za-z_][A-Za-z0-9_]*)"?/g;
  let m;
  while ((m = cast.exec(text)) !== null) {
    const base = m[2].toLowerCase();
    if (NONEXISTENT_TYPES.has(base)) return { kind: 'type', name: base };
  }
  if (/\bxmltable\s*\(/i.test(text)) return { kind: 'feature', name: 'xmltable' };
  return null;
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/**
 * Is this run-time parameter one DSQL refuses to set?
 *
 * Any namespaced (dotted) parameter counts, not just the built-ins listed
 * below: DSQL has no custom GUCs at all. Measured on the live cluster —
 *   set local "response.headers" = '[]';            (inside a SQL body)
 *   select set_config('response.headers','[]',true);
 * both answer `setting configuration parameter "response.headers" not
 * supported`. That kills PostgREST's GUC-based response-header feature, and
 * because DSQL parses a SQL function body at CREATE time, the SET form also
 * makes the CREATE FUNCTION itself fail.
 */
function gucUnsettable(name) {
  return UNSETTABLE_GUCS.test(name) || name.includes('.');
}

/** GUCs DSQL refuses to set, in a session or in a function's SET clause. */
const UNSETTABLE_GUCS = /^(role|check_function_bodies|statement_timeout|lock_timeout|temp_file_limit|default_with_oids|default_tablespace|row_security|session_replication_role|idle_in_transaction_session_timeout|transaction_timeout|xmloption|standard_conforming_strings|escape_string_warning|client_encoding|client_min_messages)$/i;

const FUNC_TAIL_KEYWORDS = new Set([
  'as', 'language', 'stable', 'immutable', 'volatile', 'strict', 'security',
  'cost', 'rows', 'set', 'parallel', 'called', 'returns', 'window', 'leakproof',
  'support', 'transform', 'begin', 'atomic', 'external', 'not', 'no',
  'definer', 'invoker', 'return',
]);

const ARG_MODES = new Set(['in', 'out', 'inout', 'variadic']);

/**
 * Candidate type texts for one parameter declaration. Both the whole text and
 * the text with a leading parameter name removed are returned, because telling
 * `money numeric` (named parameter) from `double precision` (two-word type)
 * without a catalog is guesswork; only a candidate that matches an unsupported
 * type name exactly matters.
 */
function splitArgType(argText) {
  const cleaned = argText.replace(/\bdefault\b[\s\S]*$/i, '').replace(/=[\s\S]*$/, '').trim();
  const toks = tokenize(cleaned);
  let i = 0;
  while (toks[i] && ARG_MODES.has(toks[i].v.toLowerCase()) && toks[i + 1]) i++;
  if (!toks[i]) return [];
  const rest = cleaned.slice(toks[i].start).trim();
  const out = [rest];
  const t2 = tokenize(rest);
  if (t2.length > 1 && (t2[0].kind === 'word' || t2[0].kind === 'ident')
    && !['.', '(', '['].includes(t2[1].v)) {
    out.push(rest.slice(t2[1].start).trim());
  }
  return out.filter(Boolean);
}

/**
 * Pull the parameter types, return type and post-parameter tail out of a
 * CREATE FUNCTION statement.
 * @returns {{argTypes:string[], returns:string|null, tail:string}}
 */
function functionSignature(sql) {
  const clean = stripComments(sql);
  const toks = tokenize(clean);
  const fi = toks.findIndex((t) => t.kind === 'word' && t.v.toLowerCase() === 'function');
  const argTypes = [];
  if (fi === -1) return { argTypes, returns: null, tail: clean };

  let pi = -1;
  for (let k = fi + 1; k < toks.length; k++) {
    if (toks[k].v === '(') { pi = toks[k].start; break; }
    if (toks[k].kind === 'string' || toks[k].kind === 'dollar') break;
  }
  let tail;
  if (pi !== -1) {
    const close = matchParen(clean, pi);
    for (const a of splitCommas(clean.slice(pi + 1, close))) {
      if (a.trim()) argTypes.push(...splitArgType(a));
    }
    tail = clean.slice(close + 1);
  } else {
    tail = clean.slice(toks[fi].end);
  }

  let returns = null;
  const rm = /\breturns\b/i.exec(tail);
  if (rm) {
    const after = tail.slice(rm.index + rm[0].length);
    const t = tokenize(after);
    if (t[0] && t[0].v.toLowerCase() === 'table') {
      const open = after.indexOf('(');
      const close = open === -1 ? -1 : matchParen(after, open);
      if (close !== -1) {
        for (const a of splitCommas(after.slice(open + 1, close))) {
          if (a.trim()) argTypes.push(...splitArgType(a));
        }
      }
    } else {
      let k = 0;
      if (t[k] && t[k].v.toLowerCase() === 'setof') k++;
      let end = after.length;
      let depth = 0;
      for (let j = k; j < t.length; j++) {
        if (t[j].v === '(') { depth++; continue; }
        if (t[j].v === ')') { depth--; continue; }
        if (t[j].kind === 'dollar' || t[j].kind === 'string') { end = t[j].start; break; }
        if (depth === 0 && j > k && t[j].kind === 'word'
          && FUNC_TAIL_KEYWORDS.has(t[j].v.toLowerCase())) { end = t[j].start; break; }
      }
      if (t[k]) returns = after.slice(t[k].start, end).trim().replace(/;\s*$/, '');
    }
  }
  return { argTypes, returns, tail };
}

/** A GUC named in the function's SET clause (never inside the body). */
function functionSetGuc(tail) {
  const toks = tokenize(tail).filter((t) => t.kind !== 'comment');
  for (let i = 0; i < toks.length - 2; i++) {
    if (toks[i].kind !== 'word' || toks[i].v.toLowerCase() !== 'set') continue;
    const name = toks[i + 1];
    const op = toks[i + 2];
    if (!name || !op) continue;
    if (op.v === '=' || op.v.toLowerCase() === 'to') return identValue(name);
  }
  return null;
}

const BODY_SET_RE = /\bset\s+(?:local\s+|session\s+)?("(?:[^"]|"")+"|[a-z_][\w$]*(?:\.[\w$]+)*)\s*(?:=|to\b)/gi;

/**
 * A GUC set by a `SET ...` statement inside the function's body.
 *
 * Separate from functionSetGuc: the body is one dollar-quoted (or single-quoted)
 * token, so the signature scan never looks inside it. DSQL validates SQL bodies
 * when the function is created, so an unsettable GUC here fails the CREATE.
 */
function functionBodySetGuc(sql) {
  const bodies = tokenize(sql)
    .filter((t) => t.kind === 'dollar' || t.kind === 'string')
    .map((t) => sql.slice(t.start, t.end));
  for (const body of bodies) {
    BODY_SET_RE.lastIndex = 0;
    for (let m = BODY_SET_RE.exec(body); m; m = BODY_SET_RE.exec(body)) {
      const name = unquoteIdent(m[1]);
      if (gucUnsettable(name)) return name;
    }
  }
  return null;
}

/** Read a (possibly quoted, possibly qualified) name starting at token `i`. */
function readName(toks, i) {
  const parts = [];
  const raws = [];
  let j = i;
  for (;;) {
    const t = toks[j];
    if (!t || (t.kind !== 'word' && t.kind !== 'ident')) break;
    parts.push(identValue(t));
    raws.push(t.v);
    j++;
    if (toks[j] && toks[j].v === '.') { j++; continue; }
    break;
  }
  const name = parts.pop() || '';
  const schema = parts.length ? parts[parts.length - 1] : null;
  return { schema, name, next: j, raw: raws.join('.') };
}

// ---------------------------------------------------------------------------
// REFERENCES clause handling
// ---------------------------------------------------------------------------

const REF_ACTIONS = new Set(['no', 'action', 'restrict', 'cascade', 'set', 'null', 'default']);

/**
 * Parse a REFERENCES clause whose `references` keyword is token `i`.
 * @returns {{fSchema:string|null, fTable:string, fColumns:string[], end:number}}
 */
function parseReferences(toks, i) {
  let j = i + 1;
  const { schema, name, next } = readName(toks, j);
  j = next;
  const fColumns = [];
  if (toks[j] && toks[j].v === '(') {
    let depth = 0;
    for (; j < toks.length; j++) {
      const t = toks[j];
      if (t.v === '(') { depth++; continue; }
      if (t.v === ')') { depth--; if (depth === 0) { j++; break; } continue; }
      if (t.v === ',') continue;
      fColumns.push(identValue(t));
    }
  }
  // MATCH FULL | MATCH PARTIAL | MATCH SIMPLE
  if (toks[j] && toks[j].v.toLowerCase() === 'match') j += 2;
  // ON DELETE / ON UPDATE <action>
  while (toks[j] && toks[j].v.toLowerCase() === 'on') {
    j += 2; // ON DELETE|UPDATE
    while (toks[j] && toks[j].kind === 'word' && REF_ACTIONS.has(toks[j].v.toLowerCase())) j++;
    if (toks[j] && toks[j].v === '(') { // SET NULL (cols)
      let depth = 0;
      for (; j < toks.length; j++) {
        if (toks[j].v === '(') depth++;
        else if (toks[j].v === ')') { depth--; if (depth === 0) { j++; break; } }
      }
    }
  }
  // [NOT] DEFERRABLE / INITIALLY ...
  for (;;) {
    const v = toks[j] && toks[j].v.toLowerCase();
    if (v === 'not' && toks[j + 1] && toks[j + 1].v.toLowerCase() === 'deferrable') { j += 2; continue; }
    if (v === 'deferrable') { j += 1; continue; }
    if (v === 'initially') { j += 2; continue; }
    break;
  }
  return { fSchema: schema, fTable: name, fColumns, end: j };
}

function defaultFkName(table, columns) {
  return `${table}_${columns.join('_')}_fkey`;
}

/**
 * Fill in the foreign columns of every relationship recorded from a bare
 * `REFERENCES <table>` (no column list), which targets that table's PRIMARY
 * KEY. Runs after all statements are parsed, so forward references resolve.
 *
 * A relationship whose target primary key is unknown, or whose column count
 * does not match, is dropped from the manifest and reported: an entry Postgres
 * could never produce is worse than a missing one, because the engine has to
 * discard it anyway and the reason is then invisible.
 */
function resolveImpliedForeignColumns() {
  const kept = [];
  for (const rel of relationships) {
    if (!rel.foreignColumns.length) {
      const pk = tablePrimaryKeys.get(qual(rel.foreignSchema, rel.foreignTable));
      if (pk && pk.length) {
        rel.foreignColumns = pk.slice();
        rewrite(`${rel.schema}.${rel.constraint}`, 'foreign-key',
          `bare REFERENCES ${rel.foreignTable} resolved to its primary key `
          + `(${pk.join(', ')})`);
      }
    }
    if (rel.foreignColumns.length !== rel.columns.length) {
      drop(`${rel.schema}.${rel.constraint}`, 'foreign-key',
        `could not recover the referenced columns: ${rel.columns.length} `
        + `referencing column(s) against ${rel.foreignColumns.length} `
        + `referenced; the primary key of ${rel.foreignSchema}.`
        + `${rel.foreignTable} was not recorded`);
      continue;
    }
    kept.push(rel);
  }
  relationships.length = 0;
  relationships.push(...kept);
}

function recordRelationship({ name, schema, table, columns, fSchema, fTable, fColumns }) {
  const constraint = name || defaultFkName(table, columns);
  relationships.push({
    constraint,
    schema: schema || currentSchema(),
    table,
    columns,
    foreignSchema: fSchema || schema || currentSchema(),
    foreignTable: fTable,
    // `REFERENCES t` with no column list targets t's PRIMARY KEY. That key can
    // be declared later in the file (or by a separate ALTER TABLE), so it is
    // left empty here and filled in by resolveImpliedForeignColumns() once
    // everything has been parsed. Guessing ("id") produced manifest entries
    // with mismatched column counts — a shape no Postgres FK can have, which
    // the engine's normaliser then correctly discarded.
    foreignColumns: fColumns.length ? fColumns : [],
  });
  drop(`${schema || currentSchema()}.${constraint}`, 'foreign-key',
    'FOREIGN KEY constraint not supported by DSQL; recovered in relationships.json');
  return constraint;
}

// ---------------------------------------------------------------------------
// CREATE TABLE
// ---------------------------------------------------------------------------

const COL_CONSTRAINT_START = new Set([
  'constraint', 'not', 'null', 'default', 'check', 'primary', 'unique',
  'references', 'generated', 'collate', 'deferrable', 'initially', 'storage',
  'compression',
]);
const TABLE_CONSTRAINT_START = new Set([
  'constraint', 'primary', 'unique', 'check', 'foreign', 'exclude', 'like',
]);

const SERIAL_TYPES = new Set(['serial', 'serial4', 'serial8', 'bigserial', 'smallserial', 'serial2']);

function handleCreateTable(sql) {
  const n = norm(sql);
  const toks = tokenize(sql).filter((t) => t.kind !== 'comment');
  let i = 1; // past CREATE
  while (toks[i] && ['global', 'local', 'temp', 'temporary', 'unlogged', 'foreign'].includes(toks[i].v.toLowerCase())) i++;
  if (!toks[i] || toks[i].v.toLowerCase() !== 'table') return { action: 'keep', sql };
  i++;
  if (toks[i] && toks[i].v.toLowerCase() === 'if') i += 3; // IF NOT EXISTS
  const { schema, name, next, raw } = readName(toks, i);
  const qname = qual(schema, name);
  i = next;

  if (/\btemp(orary)?\s+table\b/.test(n)) {
    droppedRelations.add(qname);
    drop(qname, 'table', 'temporary tables not supported by DSQL');
    return { action: 'drop' };
  }
  if (/\bpartition\s+of\b/.test(n) || /\bpartition\s+by\b/.test(n)) {
    droppedRelations.add(qname);
    drop(qname, 'partitioned-table', 'PARTITION BY / PARTITION OF not supported by DSQL');
    return { action: 'drop' };
  }
  if (/\)\s*inherits\s*\(/.test(n)) {
    droppedRelations.add(qname);
    drop(qname, 'table', 'INHERITS clause not supported by DSQL');
    return { action: 'drop' };
  }
  if (toks[i] && toks[i].v.toLowerCase() === 'as') {
    droppedRelations.add(qname);
    drop(qname, 'table', 'CREATE TABLE AS not supported by DSQL');
    return { action: 'drop' };
  }

  const open = sql.indexOf('(', toks[i] ? toks[i].start - 1 : 0) >= 0
    ? sql.indexOf('(', (toks[i - 1] ? toks[i - 1].end : 0))
    : -1;
  if (open === -1) return { action: 'keep', sql };
  const close = matchParen(sql, open);
  if (close === -1) return { action: 'keep', sql };

  const body = sql.slice(open + 1, close);
  const tail = sql.slice(close + 1);
  const items = splitCommas(body);

  const outItems = [];
  const gone = new Set();
  const keptCols = [];
  const pkCols = [];
  let promoted = 0;

  // pass 1: columns (so constraints can see which columns went away)
  const parsed = items.map((raw) => {
    const item = stripComments(raw).trim();
    if (!item) return { skip: true };
    const it = tokenize(item);
    const head = it[0] ? it[0].v.toLowerCase() : '';
    if (it[0] && it[0].kind === 'word' && TABLE_CONSTRAINT_START.has(head)) {
      return { kind: 'constraint', item, toks: it };
    }
    return { kind: 'column', item, toks: it };
  });

  for (const p of parsed) {
    if (p.skip || p.kind !== 'column') continue;
    const colName = identValue(p.toks[0]);
    let stop = p.toks.length;
    let depth = 0;
    for (let k = 1; k < p.toks.length; k++) {
      const t = p.toks[k];
      if (t.v === '(') { depth++; continue; }
      if (t.v === ')') { depth--; continue; }
      if (depth === 0 && t.kind === 'word' && COL_CONSTRAINT_START.has(t.v.toLowerCase())) { stop = k; break; }
    }
    const typeText = p.item.slice(p.toks[1] ? p.toks[1].start : p.item.length,
      stop < p.toks.length ? p.toks[stop].start : p.item.length).trim();
    const rest = stop < p.toks.length ? p.item.slice(p.toks[stop].start) : '';
    p.colName = colName;
    p.typeText = typeText;
    p.typeNorm = normType(typeText);
    p.rest = rest;

    if (SERIAL_TYPES.has(p.typeNorm)) {
      p.newType = 'bigint GENERATED BY DEFAULT AS IDENTITY (CACHE 1)';
      promoted++;
      continue;
    }
    if (!typeSupported(p.typeNorm)) {
      p.dropCol = true;
      gone.add(colName.toLowerCase());
      drop(`${qname}.${colName}`, 'column',
        `column type ${p.typeNorm} not supported by DSQL`,
        typeCategories(p.typeNorm));
    }
  }

  // pass 2: emit
  for (const p of parsed) {
    if (p.skip) continue;
    if (p.kind === 'column') {
      if (p.dropCol) continue;
      let rest = p.rest;
      // strip inline REFERENCES
      rest = stripInlineReferences(rest, { schema: schema || currentSchema(), table: name, column: p.colName });
      rest = stripUnsupportedColumnClauses(rest, qname, p.colName);
      let type = p.newType || p.typeText;
      if (p.newType) rewrite(`${qname}.${p.colName}`, 'column', `${p.typeNorm} -> bigint identity (CACHE 1)`);
      // Identity columns: DSQL requires bigint and an explicit cache size.
      if (/\bgenerated\b[\s\S]*\bas\s+identity\b/i.test(rest)) {
        if (/^(int|int4|integer|smallint|int2)$/.test(normType(type))) {
          rewrite(`${qname}.${p.colName}`, 'column',
            `identity column ${normType(type)} -> bigint (DSQL: identity column type must be bigint)`);
          type = 'bigint';
        }
        if (!/\bcache\b/i.test(rest)) {
          rest = rest.replace(/\bas\s+identity\b/i, 'AS IDENTITY (CACHE 1)');
          rewrite(`${qname}.${p.colName}`, 'column',
            'added identity CACHE 1 (DSQL requires an explicit cache size)');
        }
      }
      if (/\bprimary\s+key\b/i.test(rest)) pkCols.push(p.colName);
      keptCols.push(p.colName.toLowerCase());
      outItems.push(`${p.toks[0].v} ${type}${rest ? ' ' + rest.trim() : ''}`);
      continue;
    }

    // table constraint
    const res = handleTableConstraint(p, { schema: schema || currentSchema(), table: name, qname, gone });
    if (res) {
      outItems.push(res.text);
      if (res.pkCols) pkCols.push(...res.pkCols);
    }
  }

  if (!outItems.length) {
    droppedRelations.add(qname);
    drop(qname, 'table', 'every column uses a type DSQL does not support');
    return { action: 'drop' };
  }
  if (gone.size) droppedColumns.set(qname, new Set([...(droppedColumns.get(qname) || []), ...gone]));
  tableColumns.set(qname, parsed.filter((p) => !p.skip && p.kind === 'column')
    .map((p) => ({ name: p.colName, dropped: !!p.dropCol })));

  // fold in PRIMARY KEY that upstream adds with ALTER TABLE (unsupported)
  const fold = pendingPk.get(qname);
  if (fold && !pkCols.length) {
    outItems.push(fold.text);
    if (fold.cols) pkCols.push(...fold.cols);
    rewrite(qname, 'table', `folded ${fold.name} PRIMARY KEY in from ALTER TABLE ADD CONSTRAINT`);
  }

  // Remember the primary key so a bare `REFERENCES <this table>` elsewhere can
  // be resolved to it instead of being guessed as ("id").
  if (pkCols.length) tablePrimaryKeys.set(qname, pkCols.slice());

  let cleanTail = stripComments(tail).replace(/\bwith\s*\([^)]*\)/i, '').trim();
  cleanTail = cleanTail.replace(/\btablespace\s+\S+/i, '').replace(/;\s*$/, '').trim();

  const out = `CREATE TABLE ${raw} (\n    ${outItems.map((s) => s.trim()).join(',\n    ')}\n)${cleanTail ? ' ' + cleanTail : ''};`;
  return { action: 'keep', sql: out, promoted };
}

function stripInlineReferences(rest, ctx) {
  if (!/\breferences\b/i.test(rest)) return rest;
  let out = rest;
  for (;;) {
    const toks = tokenize(out);
    const idx = toks.findIndex((t) => t.kind === 'word' && t.v.toLowerCase() === 'references');
    if (idx === -1) break;
    const ref = parseReferences(toks, idx);
    // `col int CONSTRAINT c REFERENCES t(id)` — the name belongs to the FK, so
    // the CONSTRAINT prefix has to go with it or we leave dangling syntax.
    let named = null;
    let start = idx;
    if (idx >= 2 && toks[idx - 2].kind === 'word'
      && toks[idx - 2].v.toLowerCase() === 'constraint') {
      named = identValue(toks[idx - 1]);
      start = idx - 2;
    }
    const from = toks[start].start;
    const to = ref.end < toks.length ? toks[ref.end].start : out.length;
    recordRelationship({
      name: named,
      schema: ctx.schema,
      table: ctx.table,
      columns: [ctx.column],
      fSchema: ref.fSchema,
      fTable: ref.fTable,
      fColumns: ref.fColumns,
    });
    out = (out.slice(0, from) + ' ' + out.slice(to)).replace(/\s+/g, ' ');
  }
  return out.trim();
}

function stripUnsupportedColumnClauses(rest, qname, col) {
  let out = rest;
  if (/\bdeferrable\b|\binitially\b/i.test(out)) {
    out = out.replace(/\bnot\s+deferrable\b/gi, '').replace(/\bdeferrable\b/gi, '')
      .replace(/\binitially\s+(deferred|immediate)\b/gi, '');
    rewrite(`${qname}.${col}`, 'column', 'stripped DEFERRABLE/INITIALLY (not supported by DSQL)');
  }
  if (/\bcollate\b/i.test(out)) {
    out = out.replace(/\bcollate\s+("[^"]*"|[A-Za-z0-9_."]+)/gi, '');
    rewrite(`${qname}.${col}`, 'column', 'stripped COLLATE (not supported by DSQL)');
  }
  return out.replace(/\s+/g, ' ').trim();
}

function handleTableConstraint(p, ctx) {
  const toks = p.toks;
  let i = 0;
  let cname = null;
  if (toks[0].v.toLowerCase() === 'constraint') {
    cname = identValue(toks[1]);
    i = 2;
  }
  const kw = toks[i] ? toks[i].v.toLowerCase() : '';

  if (kw === 'foreign') {
    // FOREIGN KEY (cols) REFERENCES ...
    let j = i + 2;
    const columns = [];
    if (toks[j] && toks[j].v === '(') {
      let depth = 0;
      for (; j < toks.length; j++) {
        if (toks[j].v === '(') { depth++; continue; }
        if (toks[j].v === ')') { depth--; if (depth === 0) { j++; break; } continue; }
        if (toks[j].v === ',') continue;
        columns.push(identValue(toks[j]));
      }
    }
    const refIdx = toks.findIndex((t, k) => k >= j && t.kind === 'word' && t.v.toLowerCase() === 'references');
    if (refIdx !== -1) {
      const ref = parseReferences(toks, refIdx);
      recordRelationship({
        name: cname, schema: ctx.schema, table: ctx.table, columns,
        fSchema: ref.fSchema, fTable: ref.fTable, fColumns: ref.fColumns,
      });
    }
    return null;
  }

  if (kw === 'exclude') {
    drop(`${ctx.qname}.${cname || 'exclude'}`, 'constraint',
      'EXCLUDE constraints not supported by DSQL');
    return null;
  }

  if (kw === 'like') {
    drop(`${ctx.qname}`, 'constraint', 'CREATE TABLE (LIKE ...) not supported by DSQL');
    return null;
  }

  // PRIMARY KEY / UNIQUE / CHECK
  const cols = [];
  if (kw === 'primary' || kw === 'unique') {
    let j = kw === 'primary' ? i + 2 : i + 1;
    if (toks[j] && toks[j].v === '(') {
      let depth = 0;
      for (; j < toks.length; j++) {
        if (toks[j].v === '(') { depth++; continue; }
        if (toks[j].v === ')') { depth--; if (depth === 0) { j++; break; } continue; }
        if (toks[j].v === ',') continue;
        cols.push(identValue(toks[j]));
      }
    }
  }
  const refsGone = ctx.gone.size && [...ctx.gone].some((g) => {
    if (cols.length) return cols.some((c) => c.toLowerCase() === g);
    return new RegExp(`(?<![A-Za-z0-9_"])${escapeRe(g)}(?![A-Za-z0-9_"])`, 'i').test(p.item);
  });
  if (refsGone) {
    drop(`${ctx.qname}.${cname || kw}`, 'constraint',
      'constraint references a column dropped for an unsupported type');
    return null;
  }

  let text = p.item;
  if (/\bdeferrable\b|\binitially\b/i.test(text)) {
    text = text.replace(/\bnot\s+deferrable\b/gi, '').replace(/\bdeferrable\b/gi, '')
      .replace(/\binitially\s+(deferred|immediate)\b/gi, '');
    rewrite(`${ctx.qname}.${cname || kw}`, 'constraint', 'stripped DEFERRABLE/INITIALLY');
  }
  return { text: text.replace(/\s+$/, ''), pkCols: kw === 'primary' ? cols : null };
}

// ---------------------------------------------------------------------------
// statement dispatch
// ---------------------------------------------------------------------------

function objectNameAfter(sql, keywords) {
  const toks = tokenize(sql).filter((t) => t.kind !== 'comment');
  const idx = toks.findIndex((t, k) => keywords.every((w, o) => toks[k + o]
    && toks[k + o].v.toLowerCase() === w));
  if (idx === -1) return null;
  return readName(toks, idx + keywords.length);
}

/**
 * Remove skipped schemas from a `GRANT ... ON [ALL x IN] SCHEMA a, b, c TO r`
 * list. Returns null when the statement needs no change.
 */
function filterSchemaList(sql) {
  const clean = stripComments(sql).trim().replace(/;\s*$/, '');
  const toks = tokenize(clean);
  const si = toks.findIndex((t) => t.kind === 'word' && t.v.toLowerCase() === 'schema');
  if (si === -1 || !toks[si + 1]) return null;
  const endTok = toks.findIndex((t, k) => k > si && t.kind === 'word'
    && (t.v.toLowerCase() === 'to' || t.v.toLowerCase() === 'from'));
  if (endTok === -1) return null;
  const listStart = toks[si + 1].start;
  const listEnd = toks[endTok].start;
  // `GRANT ... ON SCHEMA public` is rejected outright ("feature not supported on
  // system entity"): on DSQL public is a system entity. Grants on the objects
  // *inside* public are fine, so only the direct schema grant is filtered.
  const directSchemaGrant = !toks.slice(0, si).some((t) => t.kind === 'word'
    && t.v.toLowerCase() === 'in');
  const skip = new Set(SKIP_SCHEMAS);
  if (directSchemaGrant) for (const s of UNDROPPABLE_SCHEMAS) skip.add(s);
  const parts = splitCommas(clean.slice(listStart, listEnd));
  const kept = parts.filter((p) => {
    const first = tokenize(p)[0];
    return !first || !skip.has(identValue(first));
  });
  if (kept.length === parts.length) return null;
  const label = norm(sql).slice(0, 60);
  if (!kept.length) {
    drop(label, 'statement', 'every schema in this grant was skipped');
    return { action: 'drop' };
  }
  rewrite(label, 'statement',
    `removed schema(s) from the grant list: ${[...skip].join(', ')}`);
  return {
    action: 'keep',
    sql: `${clean.slice(0, listStart)}${kept.map((p) => p.trim()).join(', ')} ${clean.slice(listEnd)};`,
  };
}

function transformStatement(sql) {
  const n = norm(sql);
  if (!n) return { action: 'skip' };

  // ---- session settings -------------------------------------------------
  if (/^set\s+search_path\s*=/.test(n)) {
    const m = /^set\s+search_path\s*=\s*(.+?)\s*;?$/i.exec(stripComments(sql).trim());
    if (m) {
      searchPath = splitCommas(m[1]).map((s) => {
        const t = s.trim();
        return t.startsWith('"') ? t.slice(1, -1).replace(/""/g, '"') : t.toLowerCase();
      }).filter((s) => s && s !== 'pg_catalog' && s !== '$user');
      if (!searchPath.length) searchPath = ['public'];
    }
    return { action: 'keep', sql: stripComments(sql).trim().replace(/;?$/, ';') };
  }
  if (/^set\s+(check_function_bodies|default_with_oids|default_tablespace|client_min_messages|statement_timeout|lock_timeout|client_encoding|standard_conforming_strings|escape_string_warning|xmloption|row_security|idle_in_transaction_session_timeout|transaction_timeout|session_replication_role)\b/.test(n)) {
    drop(n.slice(0, 60), 'statement', 'session GUC not settable on DSQL');
    return { action: 'drop' };
  }
  if (/^set\s+/.test(n)) return { action: 'keep', sql };
  if (/^(begin|commit|end|start\s+transaction|rollback)\b/.test(n)) {
    // DDL cannot be batched in a transaction on DSQL; the loader is autocommit.
    drop(n.slice(0, 30), 'statement',
      'explicit transaction removed: DSQL rejects multiple DDL statements in one transaction');
    return { action: 'drop' };
  }

  // ---- schemas -----------------------------------------------------------
  if (/^create\s+schema\b/.test(n)) {
    const toks = tokenize(sql).filter((t) => t.kind !== 'comment');
    let i = 2;
    if (toks[i] && toks[i].v.toLowerCase() === 'if') i += 3; // IF NOT EXISTS
    const name = identValue(toks[i]);
    if (UNDROPPABLE_SCHEMAS.has(name)) {
      drop(name, 'statement',
        'schema public already exists on DSQL and cannot be recreated (schema "public" already exists)');
      return { action: 'drop' };
    }
    if (SKIP_SCHEMAS.has(name)) {
      drop(name, 'schema',
        'skipped to stay under the DSQL 10-schema limit ("more than 10 schemas not allowed"); '
        + 'it only holds postgis/isn objects DSQL cannot create anyway',
        ['select', 'rpc', 'media-types']);
      return { action: 'drop' };
    }
    return { action: 'keep', sql };
  }
  if (/^drop\s+schema\b/.test(n)) {
    // 00-reset.sql owns schema teardown; the fixtures' own DROP SCHEMA lists
    // include public, which DSQL will not let us drop.
    drop(n.slice(0, 70), 'statement',
      'schema teardown moved to 00-reset.sql (DROP SCHEMA public is rejected: must be owner of schema public)');
    return { action: 'drop' };
  }
  if (/^(grant|revoke)\b/.test(n) && /\bschema\b/.test(n)) {
    const r = filterSchemaList(sql);
    if (r) return r;
  }

  // ---- hard drops --------------------------------------------------------
  if (/^create\s+extension\b/.test(n)) {
    const toks = tokenize(stripComments(sql)).filter((t) => t.kind !== 'comment');
    let ei = toks.findIndex((t) => t.v.toLowerCase() === 'extension') + 1;
    if (toks[ei] && toks[ei].v.toLowerCase() === 'if') ei += 3; // IF NOT EXISTS
    const name = toks[ei] ? identValue(toks[ei]) : null;
    for (const f of EXTENSION_FUNCTIONS[name] || []) unavailableFunctions.add(f);
    drop(name || n.slice(0, 40), 'extension', 'CREATE EXTENSION not supported by DSQL');
    return { action: 'drop' };
  }
  if (/^create\s+(or\s+replace\s+)?materialized\s+view\b/.test(n)) {
    const nm = objectNameAfter(sql, ['view']);
    if (nm) droppedRelations.add(qual(nm.schema, nm.name));
    drop(nm ? qual(nm.schema, nm.name) : n.slice(0, 40), 'materialized-view',
      'materialized views not supported by DSQL (unsupported statement: CreateTableAs)');
    return { action: 'drop' };
  }
  if (/^create\s+type\b/.test(n)) {
    const nm = objectNameAfter(sql, ['type']);
    const isEnum = /\bas\s+enum\b/.test(n);
    if (nm) markTypeUnavailable(nm.schema || currentSchema(), nm.name);
    drop(nm ? qual(nm.schema, nm.name) : n.slice(0, 40), 'type',
      `CREATE TYPE (${isEnum ? 'enum' : 'composite'}) not supported by DSQL`);
    return { action: 'drop' };
  }
  if (/^drop\s+(type|aggregate|cast|rule|trigger|procedure|extension|server|foreign\s+table|materialized\s+view|policy)\b/.test(n)) {
    drop(n.slice(0, 70), 'statement',
      'DROP of this object kind is rejected by DSQL (unsupported object in DROP statement)');
    return { action: 'drop' };
  }
  if (/^drop\s+domain\b/.test(n) && /\bcascade\b/.test(n)) {
    const out = stripComments(sql).trim().replace(/;\s*$/, '').replace(/\s+cascade\s*$/i, '');
    rewrite(n.slice(0, 60), 'domain', 'DROP DOMAIN ... CASCADE -> DROP DOMAIN (CASCADE unsupported on DSQL)');
    return { action: 'keep', sql: `${out};` };
  }
  if (/^create\s+(server|foreign\s+table|foreign\s+data\s+wrapper|publication|subscription|operator|collation|text\s+search)\b/.test(n)) {
    drop(n.slice(0, 70), 'statement', 'object kind not supported by DSQL');
    return { action: 'drop' };
  }
  if (/^(update|insert\s+into|delete\s+from)\s+pg_/.test(n)) {
    drop(n.slice(0, 70), 'statement', 'writing to pg_catalog is not permitted on DSQL');
    return { action: 'drop' };
  }
  if (/^create\s+(constraint\s+)?trigger\b/.test(n)) {
    const nm = objectNameAfter(sql, [/^create\s+constraint/.test(n) ? 'trigger' : 'trigger']);
    drop(nm ? nm.name : n.slice(0, 40), 'trigger',
      'CREATE TRIGGER not supported by DSQL (trigger functions require plpgsql)');
    return { action: 'drop' };
  }
  if (/^create\s+(or\s+replace\s+)?(procedure)\b/.test(n)) {
    const nm = objectNameAfter(sql, ['procedure']);
    drop(nm ? qual(nm.schema, nm.name) : n.slice(0, 40), 'procedure',
      'PROCEDURE is not supported by DSQL');
    return { action: 'drop' };
  }
  if (/^create\s+aggregate\b/.test(n)) {
    const nm = objectNameAfter(sql, ['aggregate']);
    drop(nm ? qual(nm.schema, nm.name) : n.slice(0, 40), 'aggregate',
      'CREATE AGGREGATE not supported by DSQL (unsupported statement: Define)');
    return { action: 'drop' };
  }
  if (/^create\s+cast\b/.test(n)) {
    drop(stripComments(sql).trim().slice(0, 80), 'cast',
      'CREATE CAST not supported by DSQL');
    return { action: 'drop' };
  }
  if (/^create\s+(or\s+replace\s+)?rule\b/.test(n)) {
    const nm = objectNameAfter(sql, ['rule']);
    drop(nm ? nm.name : n.slice(0, 40), 'rule',
      'CREATE RULE not supported by DSQL (unsupported statement: Rule)');
    return { action: 'drop' };
  }
  if (/^create\s+policy\b/.test(n) || /^alter\s+table\s+.*\brow\s+level\s+security\b/.test(n)) {
    drop(stripComments(sql).trim().slice(0, 80), 'policy',
      'row-level security not supported by DSQL');
    return { action: 'drop' };
  }
  if (/^alter\s+database\b/.test(n)) {
    drop(n.slice(0, 60), 'statement', 'ALTER DATABASE ... SET not supported by DSQL');
    return { action: 'drop' };
  }
  if (/^copy\b/.test(n)) {
    drop(n.slice(0, 60), 'data', 'COPY to/from file not supported by DSQL');
    return { action: 'drop' };
  }
  if (/^(grant|revoke)\b/.test(n) && /\bon\s+sequence\b/.test(n) === false && false) {
    return { action: 'keep', sql };
  }

  // ---- indexes ----------------------------------------------------------
  if (/^create\s+(unique\s+)?index\b/.test(n)) {
    if (/\busing\s+(gin|gist|hash|brin|spgist)\b/.test(n)) {
      drop(stripComments(sql).trim().slice(0, 80), 'index',
        'only B-tree indexes exist on DSQL (USING not supported for CREATE INDEX)');
      return { action: 'drop' };
    }
    const out = stripComments(sql).trim()
      .replace(/^create\s+(unique\s+)?index\b/i, (m0) => `${m0} ASYNC`);
    rewrite(n.slice(0, 60), 'index', 'CREATE INDEX -> CREATE INDEX ASYNC');
    return { action: 'keep', sql: out };
  }

  // ---- functions --------------------------------------------------------
  if (/^create\s+(or\s+replace\s+)?function\b/.test(n)) {
    const nm = objectNameAfter(sql, ['function']);
    const label = nm ? qual(nm.schema, nm.name) : n.slice(0, 40);
    const lang = /\blanguage\s+'?([a-z_0-9]+)'?/.exec(n);
    const langName = lang ? lang[1] : 'sql';
    if (langName !== 'sql' && langName !== 'internal') {
      drop(label, 'function', `CREATE FUNCTION with language ${langName} not supported by DSQL`);
      droppedFunctions.add(label);
      return { action: 'drop' };
    }
    if (/\breturns\s+trigger\b/.test(n)) {
      drop(label, 'function', 'trigger functions require plpgsql, not supported by DSQL');
      droppedFunctions.add(label);
      return { action: 'drop' };
    }
    const sig = functionSignature(sql);
    // A GUC DSQL will not let us set, in the function's SET clause or in a SET
    // statement inside the body (both are rejected when the function is created).
    const clauseGuc = functionSetGuc(sig.tail);
    const guc = (clauseGuc && gucUnsettable(clauseGuc))
      ? clauseGuc : functionBodySetGuc(sql);
    if (guc) {
      drop(label, 'function',
        `SET ${guc} is rejected by DSQL (setting configuration parameter `
        + `"${guc}" not supported)`);
      droppedFunctions.add(label);
      return { action: 'drop' };
    }
    // A parameter can have any type that exists; a return type additionally has
    // to be one DSQL can materialise.
    const badArg = sig.argTypes.find((t) => !typeExists(normType(t)));
    const badRet = sig.returns && !returnTypeSupported(normType(sig.returns))
      ? sig.returns : null;
    if (badArg || badRet) {
      const t = normType(badRet || badArg);
      drop(label, 'function',
        badRet
          ? `returns ${t}, which DSQL cannot produce (datatype ${typeBase(t).bare} not supported)`
          : `parameter type ${t} does not exist on DSQL`,
        typeCategories(t));
      droppedFunctions.add(label);
      return { action: 'drop' };
    }
    const dep = unmetDependency(sql);
    if (dep) {
      drop(label, 'function', `depends on ${dep.kind} ${dep.name}, which DSQL could not create`);
      droppedFunctions.add(label);
      return { action: 'drop' };
    }
    return { action: 'keep', sql };
  }

  // ---- domains ----------------------------------------------------------
  if (/^create\s+domain\b/.test(n)) {
    const toks = tokenize(sql).filter((t) => t.kind !== 'comment');
    const di = toks.findIndex((t) => t.v.toLowerCase() === 'domain');
    const nm = readName(toks, di + 1);
    let j = nm.next;
    if (toks[j] && toks[j].v.toLowerCase() === 'as') j++;
    let stop = toks.length;
    let depth = 0;
    for (let k = j; k < toks.length; k++) {
      const t = toks[k];
      if (t.v === '(') { depth++; continue; }
      if (t.v === ')') { depth--; continue; }
      if (depth === 0 && t.kind === 'word'
        && ['constraint', 'check', 'not', 'null', 'default', 'collate'].includes(t.v.toLowerCase())) {
        stop = k; break;
      }
    }
    const typeText = sql.slice(toks[j].start, stop < toks.length ? toks[stop].start : sql.length)
      .replace(/;\s*$/, '').trim();
    const label = qual(nm.schema, nm.name);
    // A domain over a table's row type: DSQL rejects it with
    // "datatype <table> not supported" even though the table exists.
    const baseName = typeBase(normType(typeText));
    const asRelation = baseName.full.includes('.')
      ? baseName.full
      : qual(null, baseName.bare);
    if (tableColumns.has(asRelation)) {
      markTypeUnavailable(nm.schema || currentSchema(), nm.name);
      drop(label, 'domain',
        `domain over the row type of table ${asRelation} not supported by DSQL `
        + `(datatype ${baseName.bare} not supported)`);
      return { action: 'drop' };
    }
    if (!typeSupported(normType(typeText))) {
      markTypeUnavailable(nm.schema || currentSchema(), nm.name);
      drop(label, 'domain', `base type ${normType(typeText)} not supported by DSQL`,
        typeCategories(normType(typeText)));
      return { action: 'drop' };
    }
    return { action: 'keep', sql };
  }

  // ---- views ------------------------------------------------------------
  if (/^create\s+(or\s+replace\s+)?(recursive\s+)?view\b/.test(n)) {
    const nm = objectNameAfter(sql, ['view']);
    const label = nm ? qual(nm.schema, nm.name) : n.slice(0, 40);
    const dep = unmetDependency(sql);
    if (dep) {
      if (nm) droppedRelations.add(label);
      drop(label, 'view', `depends on ${dep.kind} ${dep.name}, which DSQL could not create`);
      return { action: 'drop' };
    }
    return { action: 'keep', sql };
  }

  // ---- tables -----------------------------------------------------------
  if (/^create\s+(global\s+|local\s+|temp\s+|temporary\s+|unlogged\s+)*table\b/.test(n)) {
    const dep = unmetDependency(sql);
    const r = handleCreateTable(sql);
    if (r.action === 'drop') return r;
    if (dep && dep.kind === 'relation') {
      const nm = objectNameAfter(sql, ['table']);
      const label = nm ? qual(nm.schema, nm.name) : n.slice(0, 40);
      droppedRelations.add(label);
      drop(label, 'table', `depends on ${dep.kind} ${dep.name}, which DSQL could not create`);
      return { action: 'drop' };
    }
    return r;
  }

  // ---- ALTER TABLE ------------------------------------------------------
  if (/^alter\s+table\b/.test(n)) {
    const toks = tokenize(sql).filter((t) => t.kind !== 'comment');
    let i = 2;
    if (toks[i] && toks[i].v.toLowerCase() === 'only') i++;
    if (toks[i] && toks[i].v.toLowerCase() === 'if') i += 2;
    const nm = readName(toks, i);
    const qname = qual(nm.schema, nm.name);
    if (droppedRelations.has(qname)) {
      drop(n.slice(0, 60), 'statement', `target ${qname} was dropped`);
      return { action: 'drop' };
    }
    // RENAME CONSTRAINT on a foreign key: the constraint only exists in
    // relationships.json now, so rename it there. PostgREST embedding hints
    // use these names (`?select=client!client(*)`), so losing them costs tests.
    if (/\brename\s+constraint\b/.test(n)) {
      const ri = toks.findIndex((t, k) => t.v.toLowerCase() === 'constraint'
        && toks[k - 1] && toks[k - 1].v.toLowerCase() === 'rename');
      const from = identValue(toks[ri + 1]);
      const to = identValue(toks[ri + 3]); // ... TO <new>
      const rel = relationships.find((r) => r.constraint === from
        && r.table === nm.name && r.schema === (nm.schema || currentSchema()));
      if (rel) {
        rel.constraint = to;
        for (const d of dropped) {
          if (d.kind === 'foreign-key' && d.object.endsWith(`.${from}`)) {
            d.object = `${d.object.slice(0, -from.length)}${to}`;
          }
        }
        rewrite(`${qname}.${from}`, 'foreign-key', `renamed to ${to} in relationships.json`);
      } else {
        drop(n.slice(0, 70), 'statement',
          'RENAME CONSTRAINT target not found in the recovered relationship manifest');
      }
      return { action: 'drop' };
    }
    if (/\badd\s+constraint\b/.test(n) || /\badd\s+(primary\s+key|unique|check|foreign\s+key)\b/.test(n)) {
      if (/\bforeign\s+key\b/.test(n)) {
        // One ALTER TABLE can carry several ADD CONSTRAINT clauses; upstream
        // uses that (`alter table only comments add constraint "user" foreign
        // key ... , add constraint comments_task_id_fkey foreign key ...`).
        const fkIdxs = toks.map((t, k) => (t.v.toLowerCase() === 'key'
          && toks[k - 1] && toks[k - 1].v.toLowerCase() === 'foreign' ? k : -1))
          .filter((k) => k !== -1);
        let prev = 0;
        for (const fkIdx of fkIdxs) {
          let ci = -1;
          for (let k = fkIdx; k >= prev; k--) {
            if (toks[k].v.toLowerCase() === 'constraint') { ci = k; break; }
          }
          const cname = ci !== -1 ? identValue(toks[ci + 1]) : null;
          const columns = [];
          let j = fkIdx + 1;
          if (toks[j] && toks[j].v === '(') {
            let depth = 0;
            for (; j < toks.length; j++) {
              if (toks[j].v === '(') { depth++; continue; }
              if (toks[j].v === ')') { depth--; if (depth === 0) { j++; break; } continue; }
              if (toks[j].v === ',') continue;
              columns.push(identValue(toks[j]));
            }
          }
          const refIdx = toks.findIndex((t, k) => k >= j && t.kind === 'word'
            && t.v.toLowerCase() === 'references');
          const ref = refIdx === -1
            ? { fSchema: null, fTable: '', fColumns: [] }
            : parseReferences(toks, refIdx);
          recordRelationship({
            name: cname, schema: nm.schema || currentSchema(), table: nm.name, columns,
            fSchema: ref.fSchema, fTable: ref.fTable, fColumns: ref.fColumns,
          });
          prev = fkIdx;
        }
        return { action: 'drop' };
      }
      // PK / UNIQUE / CHECK: folded into CREATE TABLE by the pre-pass when the
      // pre-pass saw it; anything left here is unfoldable.
      const ci = toks.findIndex((t) => t.v.toLowerCase() === 'constraint');
      const cname = ci !== -1 ? identValue(toks[ci + 1]) : '(unnamed)';
      if (pendingPk.get(qname) && pendingPk.get(qname).name === cname) return { action: 'drop' };
      drop(`${qname}.${cname}`, 'constraint',
        'ALTER TABLE ADD CONSTRAINT not supported by DSQL and could not be folded into CREATE TABLE');
      return { action: 'drop' };
    }
    if (/\balter\s+column\b.*\bset\s+default\b/.test(n) || /\bdrop\s+default\b/.test(n)
      || /\bset\s+not\s+null\b/.test(n) || /\bdrop\s+not\s+null\b/.test(n)
      || /\badd\s+column\b/.test(n) || /\bdrop\s+column\b/.test(n)
      || /\brename\b/.test(n) || /\balter\s+column\b.*\btype\b/.test(n)) {
      const col = /alter\s+column\s+("(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_$]*)/i.exec(stripComments(sql));
      const colName = col ? identValue(tokenize(col[1])[0]) : null;
      if (colName && (droppedColumns.get(qname) || new Set()).has(colName.toLowerCase())) {
        drop(n.slice(0, 60), 'statement', `column ${qname}.${colName} was dropped`);
        return { action: 'drop' };
      }
      // ADD COLUMN can carry an inline REFERENCES, and DSQL rejects the whole
      // statement if it does. Upstream uses this form (`alter table
      // test.car_models add column car_brand_name varchar(64) references
      // test.car_brands(name)`), so the FK has to be recovered into the
      // manifest and stripped from the SQL rather than losing the column.
      if (/\badd\s+column\b/.test(n) && /\breferences\b/.test(n)) {
        const addToks = tokenize(sql).filter((t) => t.kind !== 'comment');
        const addIdx = addToks.findIndex((t, k) => t.v.toLowerCase() === 'column'
          && addToks[k - 1] && addToks[k - 1].v.toLowerCase() === 'add');
        const addedCol = addIdx !== -1 && addToks[addIdx + 1]
          ? identValue(addToks[addIdx + 1]) : null;
        if (addedCol) {
          const body = stripComments(sql).trim().replace(/;\s*$/, '');
          const head = body.slice(0, addToks[addIdx + 1].start);
          const restSql = body.slice(addToks[addIdx + 1].start);
          const stripped = stripInlineReferences(restSql, {
            schema: nm.schema || currentSchema(), table: nm.name, column: addedCol,
          });
          rewrite(`${qname}.${addedCol}`, 'column',
            'stripped inline REFERENCES from ADD COLUMN; recovered in '
            + 'relationships.json');
          return { action: 'keep', sql: `${head}${stripped};` };
        }
      }
      return { action: 'keep', sql };
    }
    return { action: 'keep', sql };
  }

  // ---- ALTER/COMMENT on dropped objects ---------------------------------
  // Measured: `COMMENT ON SCHEMA "public" IS ...` -> "must be owner of schema
  // public". Upstream comments the exposed schema (`test`, now aliased to
  // public) with the API title/description that the OpenAPI output reports, so
  // the OpenAPI info block cannot come from the database here.
  if (/^comment\s+on\s+schema\s+("public"|public)(\s|$)/.test(n)) {
    drop(n.slice(0, 70), 'statement',
      'COMMENT ON SCHEMA public is rejected by DSQL (must be owner of schema '
      + 'public); the OpenAPI title/description carried by that comment is lost',
      ['openapi']);
    return { action: 'drop' };
  }
  if (/^comment\s+on\s+(foreign\s+table|type|trigger|rule|cast|aggregate|procedure|extension|materialized\s+view|policy|server)\b/.test(n)) {
    drop(n.slice(0, 70), 'statement',
      'COMMENT on this object kind is rejected by DSQL (unsupported COMMENT statement)');
    return { action: 'drop' };
  }
  if (/^(comment\s+on|alter\s+(view|sequence|function|domain|type))\b/.test(n)) {
    const dep = unmetDependency(sql);
    if (dep) {
      drop(n.slice(0, 60), 'statement', `references ${dep.kind} ${dep.name}, which DSQL could not create`);
      return { action: 'drop' };
    }
    return { action: 'keep', sql };
  }

  // ---- sequences --------------------------------------------------------
  if (/^create\s+sequence\b/.test(n)) {
    let out = stripComments(sql).trim().replace(/;\s*$/, '');
    if (!/\bcache\b/i.test(out)) {
      out += ' CACHE 1';
      const nm = objectNameAfter(sql, ['sequence']);
      rewrite(nm ? qual(nm.schema, nm.name) : n.slice(0, 40), 'sequence',
        'added CACHE 1 (DSQL requires an explicit cache)');
    }
    return { action: 'keep', sql: `${out};` };
  }

  // ---- roles ------------------------------------------------------------
  if (/^create\s+role\b/.test(n)) {
    const nm = objectNameAfter(sql, ['role']);
    let out = stripComments(sql).trim().replace(/;\s*$/, '');
    if (/\bwith\b/i.test(out)) {
      out = out.replace(/\s+with\b[\s\S]*$/i, '');
      rewrite(nm ? nm.name : n.slice(0, 40), 'role',
        'stripped role options (unsupported role option(s) on DSQL)');
    }
    return { action: 'keep', sql: `${out};` };
  }

  // ---- TRUNCATE ---------------------------------------------------------
  if (/^truncate\b/.test(n)) {
    const toks = tokenize(sql).filter((t) => t.kind !== 'comment');
    let i = 1;
    if (toks[i] && toks[i].v.toLowerCase() === 'table') i++;
    if (toks[i] && toks[i].v.toLowerCase() === 'only') i++;
    const nm = readName(toks, i);
    const qname = qual(nm.schema, nm.name);
    if (droppedRelations.has(qname)) {
      drop(n.slice(0, 60), 'data', `target ${qname} was dropped`);
      return { action: 'drop' };
    }
    rewrite(qname, 'table', 'TRUNCATE -> DELETE FROM (TRUNCATE not supported by DSQL)');
    clearedRelations.add(qname);
    return { action: 'keep', sql: `DELETE FROM ${nm.raw};` };
  }

  // ---- INSERT -----------------------------------------------------------
  if (/^insert\s+into\b/.test(n)) return handleInsert(sql);

  // ---- UPDATE / DELETE / SELECT ----------------------------------------
  if (/^(update|delete\s+from|select|with)\b/.test(n)) {
    const dep = unmetDependency(sql);
    if (dep && (dep.kind === 'relation' || dep.kind === 'column' || dep.kind === 'schema')) {
      drop(n.slice(0, 60), 'data', `references ${dep.kind} ${dep.name}, which DSQL could not create`);
      return { action: 'drop' };
    }
    // An unconditional DELETE already empties the table; count it as a clear so
    // no redundant DELETE is prepended to the INSERTs that follow.
    if (/^delete\s+from\b/.test(n) && !/\bwhere\b/.test(n)) {
      const dtoks = tokenize(stripComments(sql).trim())
        .filter((t) => t.kind !== 'comment');
      const dnm = readName(dtoks, 2);
      clearedRelations.add(qual(dnm.schema, dnm.name));
    }
    return { action: 'keep', sql };
  }

  return { action: 'keep', sql };
}

// ---------------------------------------------------------------------------
// INSERT rewriting (drop values for columns that no longer exist)
// ---------------------------------------------------------------------------

/**
 * Offset of the first bare `word` at paren depth zero, or -1.
 *
 * Used to find where a SELECT list ends: a `from` inside `tsrange(now(), ...)`
 * or a subquery is not the one that ends it.
 */
function topLevelWord(sql, word) {
  let depth = 0;
  for (const t of tokenize(sql)) {
    if (t.kind === 'punct' && t.v === '(') depth++;
    else if (t.kind === 'punct' && t.v === ')') depth--;
    else if (depth === 0 && t.kind === 'word'
      && t.v.toLowerCase() === word) return t.start;
  }
  return -1;
}

function handleInsert(sql) {
  const n = norm(sql);
  const clean = stripComments(sql).trim();
  const toks = tokenize(clean);
  const nm = readName(toks, 2); // INSERT INTO <name>
  const qname = qual(nm.schema, nm.name);
  if (droppedRelations.has(qname)) {
    drop(n.slice(0, 70), 'data', `target ${qname} was dropped`);
    return { action: 'drop' };
  }

  // See clearedRelations: make the file re-runnable on its own. Applied only on
  // a `keep` return — a dropped INSERT must not consume the clear, or the next
  // INSERT into the same table would go in unguarded.
  const needsClear = !clearedRelations.has(qname);
  const withClear = (out) => {
    if (!needsClear) return out;
    clearedRelations.add(qname);
    rewrite(qname, 'data',
      'prepended DELETE FROM before the first INSERT: upstream relies on the '
      + 'schema being recreated before data.sql runs, so the file was not '
      + "re-runnable (needed by the runner's --reload-data)");
    return `DELETE FROM ${nm.raw};\n${out}`;
  };

  const gone = droppedColumns.get(qname);
  if (!gone || !gone.size) return { action: 'keep', sql: withClear(clean) };

  // explicit column list?
  let listOpen = clean.indexOf('(', toks[nm.next - 1].end);
  const valuesIdx = clean.search(/\b(values|select|default\s+values)\b/i);
  let cols;
  let listClose;
  const positional = listOpen === -1
    || (valuesIdx !== -1 && listOpen > valuesIdx);
  if (positional) {
    // positional INSERT: reconstruct the column list from the CREATE TABLE
    const all = tableColumns.get(qname);
    if (!all || !all.length) {
      drop(n.slice(0, 70), 'data',
        `${qname} lost columns to unsupported types and this INSERT has no explicit column list`);
      return { action: 'drop' };
    }
    cols = all.map((c) => `"${c.name.replace(/"/g, '""')}"`);
    listOpen = -1;
    listClose = valuesIdx - 1;
  } else {
    listClose = matchParen(clean, listOpen);
    cols = splitCommas(clean.slice(listOpen + 1, listClose)).map((c) => c.trim());
  }

  const after = clean.slice(listClose + 1);
  const vm = /^\s*values\s*/i.exec(after);
  const sm = vm ? null : /^\s*select\s+/i.exec(after);
  if (!vm && !sm) {
    drop(n.slice(0, 70), 'data',
      `${qname} lost columns and this INSERT is neither VALUES nor a flat SELECT`);
    return { action: 'drop' };
  }
  let rest = after.slice((vm || sm)[0].length);

  // `INSERT ... SELECT <expr>, <expr> ... FROM ...`: the select list is
  // positional exactly like a VALUES tuple, so the expression for a column
  // that no longer exists comes out the same way. Only a flat list is handled
  // — `select *` names no columns to line up, and a set operation or a CTE
  // has more than one list. Upstream has one statement of this shape,
  // `insert into contract select ... tsrange(...) ...`, and dropping it left
  // the table empty and four embed assertions unpassable for want of rows.
  if (sm) {
    const head0 = listOpen === -1
      ? `INSERT INTO ${nm.raw} `
      : clean.slice(0, listOpen);
    const body = rest.replace(/;\s*$/, '');
    const cut = topLevelWord(body, 'from');
    const listSql = cut === -1 ? body : body.slice(0, cut);
    const tail = cut === -1 ? '' : body.slice(cut).trim();
    const items = splitCommas(listSql).map((s) => s.trim()).filter(Boolean);
    if (items.some((s) => s === '*' || s.endsWith('.*'))) {
      drop(n.slice(0, 70), 'data',
        `${qname} lost columns and this INSERT ... SELECT selects *`);
      return { action: 'drop' };
    }
    let selCols = cols;
    if (positional && items.length < cols.length) {
      selCols = cols.slice(0, items.length);
    }
    if (items.length !== selCols.length) {
      drop(n.slice(0, 70), 'data',
        `${qname} lost columns; INSERT ... SELECT list arity mismatch`);
      return { action: 'drop' };
    }
    const keep = [];
    selCols.forEach((c, k) => {
      if (!gone.has(identValue(tokenize(c)[0]).toLowerCase())) keep.push(k);
    });
    if (keep.length === selCols.length) return { action: 'keep', sql: withClear(clean) };
    if (!keep.length) {
      drop(n.slice(0, 70), 'data', `all inserted columns of ${qname} were dropped`);
      return { action: 'drop' };
    }
    rewrite(qname, 'data',
      `dropped ${selCols.length - keep.length} expression(s) from an `
      + 'INSERT ... SELECT list for removed columns');
    const newCols = keep.map((k) => selCols[k]).join(', ');
    const newList = keep.map((k) => items[k]).join(', ');
    return {
      action: 'keep',
      sql: withClear(
        `${head0}(${newCols}) SELECT ${newList}${tail ? ` ${tail}` : ''};`),
    };
  }

  const tuples = [];
  let trailing = '';
  let i = 0;
  for (;;) {
    while (i < rest.length && /[\s,]/.test(rest[i])) i++;
    if (rest[i] !== '(') { trailing = rest.slice(i); break; }
    const close = matchParen(rest, i);
    if (close === -1) { trailing = rest.slice(i); break; }
    tuples.push(rest.slice(i + 1, close));
    i = close + 1;
  }
  if (!tuples.length) {
    drop(n.slice(0, 70), 'data', `${qname} lost columns; could not parse VALUES list`);
    return { action: 'drop' };
  }

  // A positional INSERT may list fewer values than the table has columns;
  // PostgreSQL fills the leading columns and defaults the rest. Upstream does
  // this (test.complex_items rows 1 and 2 supply 4 of 5 columns), so the
  // reconstructed column list has to be trimmed to the tuple arity or every
  // such row is lost. Only uniform arity within one statement is handled — a
  // mixed-arity VALUES list would need one INSERT per arity.
  const arities = new Set(tuples.map((t) => splitCommas(t).length));
  if (positional && arities.size === 1) {
    const arity = [...arities][0];
    if (arity < cols.length) cols = cols.slice(0, arity);
  }

  const keepIdx = [];
  cols.forEach((c, k) => {
    const name = identValue(tokenize(c)[0]);
    if (!gone.has(name.toLowerCase())) keepIdx.push(k);
  });
  if (keepIdx.length === cols.length) {
    return { action: 'keep', sql: withClear(clean) };
  }
  if (!keepIdx.length) {
    drop(n.slice(0, 70), 'data', `all inserted columns of ${qname} were dropped`);
    return { action: 'drop' };
  }

  const newTuples = [];
  for (const t of tuples) {
    const vals = splitCommas(t);
    if (vals.length !== cols.length) {
      drop(n.slice(0, 70), 'data', `${qname} lost columns; VALUES arity mismatch`);
      return { action: 'drop' };
    }
    newTuples.push(`(${keepIdx.map((k) => vals[k].trim()).join(', ')})`);
  }
  const newCols = keepIdx.map((k) => cols[k]).join(', ');
  const head = listOpen === -1
    ? `INSERT INTO ${nm.raw} `
    : clean.slice(0, listOpen);
  rewrite(qname, 'data', `dropped ${cols.length - keepIdx.length} value(s) per row for removed columns`);
  return {
    action: 'keep',
    sql: withClear(
      `${head}(${newCols}) VALUES ${newTuples.join(',\n  ')}`
      + `${trailing.replace(/;\s*$/, '')};`),
  };
}

// ---------------------------------------------------------------------------
// COPY ... FROM STDIN -> INSERT
// ---------------------------------------------------------------------------

function expandCopyStdin(src) {
  const re = /^COPY\s+([^;]*?)\s+FROM\s+STDIN([^\n;]*);\n([\s\S]*?)\n\\\.\s*$/gmi;
  return src.replace(re, (m0, target, opts, data) => {
    const delim = /delimiter\s+'([^']+)'/i.exec(opts);
    const d = delim ? delim[1] : '\t';
    const rows = data.split('\n').filter((l) => l.trim() !== '');
    const values = rows.map((line) => {
      // COPY does not trim: every byte between two delimiters is part of the
      // value, so a pipe-aligned block loads padded strings. Upstream's two
      // COPY blocks rely on that — `Server Today` keeps `'argnim1    '` and a
      // leading space on each model, `pgrst_reserved_chars` keeps a leading and
      // trailing space on its text columns — and QuerySpec:1282/1291 assert the
      // padded bytes. Trimming here silently changed the fixture's data.
      const cells = line.split(d);
      return `(${cells.map((c) => (c.trim() === '\\N' ? 'NULL' : `'${c.replace(/'/g, "''")}'`)).join(', ')})`;
    });
    return `INSERT INTO ${target} VALUES\n  ${values.join(',\n  ')};`;
  });
}

// ---------------------------------------------------------------------------
// data-only reload: restore the sequence state a fresh load leaves
// ---------------------------------------------------------------------------

// The runner re-applies 07-data.sql between specs and never re-applies
// 03-schema.sql, so every sequence keeps the value the previous spec (and the
// previous run) left it at. Upstream never has to think about this: its fixture
// load recreates the schema, so every sequence is fresh and its data.sql only
// has to `setval` the four it advances past 1 itself.
//
// A data-only reload therefore has to rewind the rest by hand, to exactly the
// state `CREATE SEQUENCE` / `GENERATED ... AS IDENTITY` leaves: last value 1,
// not yet called, so the next `nextval` is 1. Without it the fixture rows whose
// id comes from a sequence land somewhere else on every run (measured:
// `surr_serial_upsert`'s single row at id 1140, where upstream has id 1, which
// is why UpsertSpec's `id=1` payload inserted instead of updating) and
// `callcounter()` never returns 1 again (measured: 59).
//
// This is fixture fidelity, not a test-literal fit: the target state is the one
// a full `schema.sql` + `data.sql` load produces. Sequences data.sql sets itself
// are left alone — its own `setval` is upstream's answer for those.
function collectGeneratedIdColumns(schemaSql) {
  const out = [];
  const re = /CREATE\s+TABLE\s+([^\s(]+)\s*\(([\s\S]*?)\n\);/gi;
  for (let m = re.exec(schemaSql); m; m = re.exec(schemaSql)) {
    const table = m[1];
    for (const line of m[2].split('\n')) {
      const l = line.trim();
      if (!/\bGENERATED\b[\s\S]*\bAS\s+IDENTITY\b/i.test(l)
        && !/\bnextval\s*\(/i.test(l)) continue;
      const col = identValue(tokenize(l)[0]);
      if (col) out.push({ table, column: col });
    }
  }
  return out;
}

function rewindStatements(dataSql, schemaSql) {
  const already = (name) =>
    new RegExp(`setval\\s*\\(\\s*'?"?${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"?'?`, 'i')
      .test(dataSql);
  const lines = [];

  for (const { table, column } of collectGeneratedIdColumns(schemaSql)) {
    // pg_get_serial_sequence() parses the name, so the quoting a
    // case-sensitive identifier needs has to survive into the literal.
    const bare = table.replace(/^"?[^".]+"?\./, '').replace(/"/g, '');
    if (already(`${bare}_${column}_seq`)) continue;
    lines.push('SELECT pg_catalog.setval(pg_get_serial_sequence('
      + `'${table.replace(/'/g, "''")}', '${column.replace(/'/g, "''")}'), 1, false)`);
  }

  // Sequences that belong to no column — upstream's `callcounter_count`, read
  // by `callcounter()`, which RpcSpec asserts returns 1 then 2. A sequence a
  // column default draws from is already covered by the pass above, so only the
  // ones no `DEFAULT nextval(...)` names are listed here.
  const owned = new Set();
  const defRe = /DEFAULT\s+nextval\s*\(\s*'([^']+)'/gi;
  for (let m = defRe.exec(schemaSql); m; m = defRe.exec(schemaSql)) {
    owned.add(m[1].replace(/"/g, '').replace(/^[^.]+\./, ''));
  }
  const seqRe = /CREATE\s+SEQUENCE\s+(?:IF\s+NOT\s+EXISTS\s+)?([^\s;(]+)/gi;
  for (let m = seqRe.exec(schemaSql); m; m = seqRe.exec(schemaSql)) {
    const name = m[1];
    const bare = name.replace(/"/g, '').replace(/^[^.]+\./, '');
    if (owned.has(bare) || already(bare)) continue;
    lines.push(`SELECT pg_catalog.setval('${name.replace(/'/g, "''")}', 1, false)`);
  }
  return lines;
}

// ---------------------------------------------------------------------------
// pre-pass: collect ALTER TABLE ADD CONSTRAINT PRIMARY KEY to fold
// ---------------------------------------------------------------------------

function collectPkFolds(statements) {
  const saved = searchPath;
  searchPath = ['public'];
  const folds = new Map();
  for (const st of statements) {
    const n = norm(st.text);
    if (/^set\s+search_path\s*=/.test(n)) {
      const m = /^set\s+search_path\s*=\s*(.+?)\s*;?$/i.exec(stripComments(st.text).trim());
      if (m) {
        searchPath = splitCommas(m[1]).map((s) => {
          const t = s.trim();
          return t.startsWith('"') ? t.slice(1, -1).replace(/""/g, '"') : t.toLowerCase();
        }).filter((s) => s && s !== 'pg_catalog' && s !== '$user');
        if (!searchPath.length) searchPath = ['public'];
      }
      continue;
    }
    // `ADD CONSTRAINT <name> PRIMARY KEY (...)` and the unnamed
    // `ADD PRIMARY KEY (...)` (upstream uses both, e.g.
    // `alter table test.car_models add primary key (name, year)`).
    if (!/^alter\s+table\b/.test(n) || !/\bprimary\s+key\b/.test(n)) continue;
    if (!/\badd\s+constraint\b/.test(n) && !/\badd\s+primary\s+key\b/.test(n)) continue;
    const toks = tokenize(st.text).filter((t) => t.kind !== 'comment');
    let i = 2;
    if (toks[i] && toks[i].v.toLowerCase() === 'only') i++;
    const nm = readName(toks, i);
    const ci = toks.findIndex((t) => t.v.toLowerCase() === 'constraint');
    const cname = ci !== -1 ? identValue(toks[ci + 1]) : null;
    const pkIdx = toks.findIndex((t, k) => t.v.toLowerCase() === 'key'
      && toks[k - 1] && toks[k - 1].v.toLowerCase() === 'primary');
    const open = toks[pkIdx + 1] && toks[pkIdx + 1].v === '(' ? toks[pkIdx + 1].start : -1;
    if (open === -1) continue;
    const close = matchParen(st.text, open);
    folds.set(qual(nm.schema, nm.name), {
      name: cname,
      text: `PRIMARY KEY ${st.text.slice(open, close + 1)}`,
      // Column list, so a bare `REFERENCES <table>` can resolve to this key.
      cols: splitCommas(st.text.slice(open + 1, close))
        .map((c) => identValue(tokenize(c.trim())[0]))
        .filter(Boolean),
    });
  }
  searchPath = saved;
  return folds;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function resetDir() {
  mkdirSync(OUT_DIR, { recursive: true });
  for (const f of readdirSync(OUT_DIR)) if (f.endsWith('.sql')) unlinkSync(join(OUT_DIR, f));
}

function ident(name) { return `"${name.replace(/"/g, '""')}"`; }

function main() {
  resetDir();

  // 00-reset: DSQL has no TRUNCATE and DROP TYPE, but DROP SCHEMA CASCADE works.
  // `public` is owned by pg_database_owner and cannot be dropped or recreated,
  // so load.mjs empties it object by object before applying these files.
  const reset = [
    '-- 00-reset.sql — generated by conformance/fixtures/transform.mjs',
    '-- DROP SCHEMA ... CASCADE is supported on DSQL; DROP TYPE is not.',
    '-- public is missing on purpose: "must be owner of schema public". load.mjs',
    '-- drops the objects inside it instead.',
    ...FIXTURE_SCHEMAS
      .filter((s) => !UNDROPPABLE_SCHEMAS.has(s))
      .map((s) => `DROP SCHEMA IF EXISTS ${ident(s)} CASCADE;`),
  ].join('\n');
  writeFileSync(join(OUT_DIR, '00-reset.sql'), `${reset}\n`);

  const stageStats = [];
  // The schema stage's own output, kept so the data stage can see which columns
  // draw from a sequence.
  let schemaOut = null;

  for (const stage of STAGES) {
    let src = readFileSync(join(UPSTREAM, stage.file), 'utf8');
    src = src
      .replace(/:"PGUSER"/g, 'admin')
      .replace(/:DBNAME/g, 'postgres');
    src = expandCopyStdin(src);

    const statements = splitStatements(src);
    // Alias the exposed schema before anything parses the statement, so the
    // transformer's own bookkeeping (qualified drop lists, relationships.json)
    // records the schema the objects are actually created in.
    for (const st of statements) {
      if (st.kind === 'sql') st.text = mapSchemaAliases(st.text);
    }
    pendingPk = collectPkFolds(statements.filter((s) => s.kind === 'sql'));
    searchPath = ['public'];
    clearedRelations = new Set();

    const out = [
      `-- ${stage.out} — generated from ${stage.file} by conformance/fixtures/transform.mjs`,
      '-- Do not edit: re-run the transformer.',
      '',
    ];
    let kept = 0;
    let removed = 0;

    for (const st of statements) {
      if (st.kind === 'meta') {
        drop(`${stage.file}:${st.line} ${st.text.slice(0, 30)}`, 'statement',
          'psql meta-command has no server-side equivalent');
        removed++;
        continue;
      }
      let r;
      try {
        r = transformStatement(st.text);
      } catch (err) {
        drop(`${stage.file}:${st.line}`, 'statement', `transformer error: ${err.message}`);
        removed++;
        continue;
      }
      if (r.action === 'skip') continue;
      if (r.action === 'drop') { removed++; continue; }
      const text = (r.sql || st.text).trim().replace(/;*\s*$/, '');
      out.push(`${text};`);
      out.push('');
      kept++;
    }

    // The data stage is the one the runner re-applies on its own, so it carries
    // the sequence rewinds. They go first: the fixture rows that take their id
    // from a sequence are inserted further down this same file, and they have to
    // land on the ids a fresh load gives them.
    if (stage.out === DATA_STAGE && schemaOut) {
      const rewinds = rewindStatements(out.join('\n'), schemaOut);
      out.splice(3, 0,
        '-- Sequence state a data-only reload has to restore: CREATE SEQUENCE /',
        '-- GENERATED AS IDENTITY leaves "last value 1, not yet called", and this',
        '-- file is re-applied without 03-schema.sql. The four setvals data.sql',
        '-- carries itself are further down and are not repeated here.',
        ...rewinds.map((s) => `${s};`),
        '');
      kept += rewinds.length;
    }

    const stageText = `${out.join('\n')}\n`;
    if (stage.out === SCHEMA_STAGE) schemaOut = stageText;
    writeFileSync(join(OUT_DIR, stage.out), stageText);
    stageStats.push({ file: stage.out, source: stage.file, kept, removed });
  }

  // Every statement has been parsed, so every primary key is known: resolve
  // the bare `REFERENCES <table>` targets before the manifest is written.
  resolveImpliedForeignColumns();

  writeFileSync(join(HERE, 'relationships.json'),
    `${JSON.stringify({ relationships }, null, 2)}\n`);

  const byKind = {};
  for (const d of dropped) byKind[d.kind] = (byKind[d.kind] || 0) + 1;

  writeFileSync(join(HERE, 'transform-report.json'), `${JSON.stringify({
    generatedAt: new Date().toISOString(),
    upstream: UPSTREAM,
    stages: stageStats,
    relationships: relationships.length,
    droppedByKind: byKind,
    dropped,
    rewrites,
  }, null, 2)}\n`);

  process.stdout.write(`${JSON.stringify({
    stages: stageStats, relationships: relationships.length,
    dropped: dropped.length, droppedByKind: byKind, rewrites: rewrites.length,
  }, null, 2)}\n`);
}

main();
