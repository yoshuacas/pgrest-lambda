#!/usr/bin/env node
// load.mjs — apply the transformed fixtures to an Aurora DSQL cluster and
// report exactly what landed.
//
//   DSQL_ENDPOINT=... REGION_NAME=us-east-1 node conformance/fixtures/load.mjs
//   node conformance/fixtures/load.mjs --only 03-schema.sql
//   node conformance/fixtures/load.mjs --no-reset
//
// Statements are sent one per round trip in autocommit: DSQL rejects more than
// one DDL statement per transaction ("multiple ddl statements not supported in
// a transaction"). A failing statement is recorded and the load continues.
//
// Writes conformance/fixtures/load-report.json (CONTRACTS.md section 2),
// conformance/fixtures/load-failures.json (every failure, for iteration) and
// conformance/fixtures/relationships-residual.json (the foreign keys the
// catalog would not take).

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

import {
  splitStatements, norm, tokenize, parseQualifiedName, identValue,
} from './sqlsplit.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = join(HERE, 'dsql');

// 08-foreign-keys.sql re-adds the keys the transformer stripped from the CREATE
// TABLE statements, one `ALTER TABLE ... ADD CONSTRAINT ... NOT VALID` each —
// the only form DSQL accepts on a table that already exists
// (docs/plans/dsql-foreign-keys.md). readdirSync().sort() below puts it last, so
// it runs after 07-data.sql, and NOT VALID does not check the rows that are
// already there.
const FK_FILE = '08-foreign-keys.sql';

const ENDPOINT = process.env.DSQL_ENDPOINT
  || '6juamhyj5nkoeatkzc3ieaerc4.dsql.us-east-1.on.aws';
// REGION_NAME, never AWS_REGION (reserved by the Lambda runtime).
const REGION = process.env.REGION_NAME || 'us-east-1';
const DB_USER = process.env.PG_USER || 'admin';
const DB_NAME = process.env.PG_DATABASE || 'postgres';

const FIXTURE_SCHEMAS = [
  'test', 'private', 'postgrest', 'jwt', 'public', 'تست', 'extensions', 'v1', 'v2',
  'SPECIAL "@/\\#~_-', 'EXTRA "@/\\#~_-',
];

const args = process.argv.slice(2);
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
const noReset = args.includes('--no-reset');
// A partial load (--only) must not overwrite the report describing the full
// load: the conformance runner re-applies 07-data.sql between runs and its
// triage reads load-report.json. Still prints the same JSON on stdout.
// `--only` implies this — measured otherwise: after one `--only 07-data.sql`,
// load-report.json read statementsTotal 558 instead of 1122 and the object
// counts described a data-only pass.
const noReport = args.includes('--no-report') || Boolean(only);

async function newToken() {
  const { DsqlSigner } = await import('@aws-sdk/dsql-signer');
  const signer = new DsqlSigner({ hostname: ENDPOINT, region: REGION });
  return signer.getDbConnectAdminAuthToken();
}

async function connect() {
  const client = new pg.Client({
    host: ENDPOINT,
    port: 5432,
    user: DB_USER,
    password: await newToken(),
    database: DB_NAME,
    ssl: { rejectUnauthorized: true },
    // No statement_timeout / query_timeout here: pg sends those as
    // `SET statement_timeout`, which DSQL rejects for every session.
  });
  await client.connect();
  return client;
}

const TOKEN_TTL_MS = 45 * 60 * 1000;

class Session {
  constructor() {
    this.client = null;
    this.openedAt = 0;
    /** replayed after a reconnect so unqualified DDL still resolves */
    this.searchPath = null;
  }

  async ensure() {
    if (this.client && Date.now() - this.openedAt < TOKEN_TTL_MS) return this.client;
    if (this.client) await this.client.end().catch(() => {});
    this.client = await connect();
    this.openedAt = Date.now();
    if (this.searchPath) await this.client.query(this.searchPath).catch(() => {});
    return this.client;
  }

  async run(sql) {
    const client = await this.ensure();
    try {
      await client.query(sql);
    } catch (err) {
      if (/Connection terminated|socket|ECONNRESET|not queryable|timeout/i.test(err.message)) {
        // reconnect once and retry: DSQL drops long-lived idle sessions
        this.client = null;
        const c2 = await this.ensure();
        await c2.query(sql);
        return;
      }
      throw err;
    }
    if (/^set\s+search_path/i.test(sql.trim())) this.searchPath = sql;
  }

  async end() {
    if (this.client) await this.client.end().catch(() => {});
    this.client = null;
  }
}

/**
 * Empty every fixture schema object by object, then drop the schemas that can
 * be dropped. Two DSQL limits force this over plain `DROP SCHEMA ... CASCADE`:
 *   - `DROP SCHEMA public CASCADE` -> "must be owner of schema public"
 *     (public is owned by pg_database_owner and cannot be recreated either).
 *   - `DROP SCHEMA test CASCADE` on a fully loaded fixture set ->
 *     "transaction row limit exceeded"; the cascade is one transaction.
 * @returns {Promise<{applied:number, failures:object[]}>}
 */
async function resetSchemas(session) {
  const client = await session.ensure();
  const q = async (sql, params) => (await client.query(sql, params)).rows;
  const present = (await q(
    'SELECT nspname FROM pg_namespace WHERE nspname = ANY($1)', [FIXTURE_SCHEMAS],
  )).map((r) => r.nspname);
  if (!present.length) return { applied: 0, failures: [] };

  const rels = await q(`SELECT c.relkind, quote_ident(s.nspname) AS s, quote_ident(c.relname) AS n
    FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace
    WHERE s.nspname = ANY($1) AND c.relkind IN ('v', 'r', 'S')`, [present]);
  const procs = await q(`SELECT quote_ident(s.nspname) AS s, quote_ident(p.proname) AS n,
      pg_get_function_identity_arguments(p.oid) AS args
    FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace
    WHERE s.nspname = ANY($1)`, [present]);
  const doms = await q(`SELECT quote_ident(s.nspname) AS s, quote_ident(t.typname) AS n
    FROM pg_type t JOIN pg_namespace s ON s.oid = t.typnamespace
    WHERE s.nspname = ANY($1) AND t.typtype = 'd'`, [present]);

  // Order matters: views before tables, functions before the domains they use
  // (DSQL rejects `DROP DOMAIN ... CASCADE`).
  const stmts = [
    ...rels.filter((r) => r.relkind === 'v').map((r) => `DROP VIEW IF EXISTS ${r.s}.${r.n} CASCADE`),
    ...rels.filter((r) => r.relkind === 'r').map((r) => `DROP TABLE IF EXISTS ${r.s}.${r.n} CASCADE`),
    ...rels.filter((r) => r.relkind === 'S').map((r) => `DROP SEQUENCE IF EXISTS ${r.s}.${r.n} CASCADE`),
    ...procs.map((p) => `DROP FUNCTION IF EXISTS ${p.s}.${p.n}(${p.args})`),
    ...doms.map((d) => `DROP DOMAIN IF EXISTS ${d.s}.${d.n}`),
  ];

  let applied = 0;
  let pending = stmts;
  // Up to three passes: dependency order is not perfectly knowable up front.
  for (let pass = 1; pass <= 3 && pending.length; pass++) {
    const stillFailing = [];
    const errors = new Map();
    for (const sql of pending) {
      try {
        await session.run(sql);
        applied++;
      } catch (err) {
        stillFailing.push(sql);
        errors.set(sql, String(err.message || err).replace(/\s+/g, ' ').slice(0, 300));
      }
    }
    if (stillFailing.length === pending.length || pass === 3) {
      return {
        applied,
        failures: stillFailing.map((sql) => ({
          file: '(reset)', line: 0, statement: sql, error: errors.get(sql),
        })),
      };
    }
    pending = stillFailing;
  }
  return { applied, failures: [] };
}

function sqlFiles() {
  const files = readdirSync(SQL_DIR).filter((f) => f.endsWith('.sql')).sort();
  if (only) return files.filter((f) => f === only || f.startsWith(only));
  return noReset ? files.filter((f) => f !== '00-reset.sql') : files;
}

async function countObjects(session) {
  const client = await session.ensure();
  const list = FIXTURE_SCHEMAS;
  const q = async (sql) => (await client.query(sql, [list])).rows[0].n | 0;
  const tables = await q(`SELECT count(*)::int AS n FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind = 'r' AND n.nspname = ANY($1)`);
  const views = await q(`SELECT count(*)::int AS n FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind = 'v' AND n.nspname = ANY($1)`);
  const functions = await q(`SELECT count(*)::int AS n FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = ANY($1)`);
  const domains = await q(`SELECT count(*)::int AS n FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typtype = 'd' AND n.nspname = ANY($1)`);
  return { tables, views, functions, domains };
}

function firstLine(sql) {
  return norm(sql).slice(0, 160);
}

/** Errors worth a second attempt once every object exists. */
const RETRYABLE = /does not exist|has no field|could not determine|is not unique/i;

/**
 * The table and constraint name an `ALTER TABLE ... ADD CONSTRAINT` statement
 * declares, so a failed statement can be matched back to the relationship it
 * came from. Constraint names repeat across tables upstream — `user` and
 * `parent` each appear on two — so the name alone is not a key.
 *
 * @returns {{schema:string|null, table:string, constraint:string}|null}
 */
function addedConstraint(sql) {
  const toks = tokenize(sql || '').filter((t) => t.kind !== 'comment');
  const word = (i) => (toks[i]?.v || '').toLowerCase();
  if (word(0) !== 'alter' || word(1) !== 'table') return null;
  let i = 2;
  if (word(i) === 'only') i += 1;
  if (word(i) === 'if' && word(i + 1) === 'exists') i += 2;
  const q = parseQualifiedName(toks, i);
  if (!q.name) return null;
  i = q.next;
  if (word(i) !== 'add' || word(i + 1) !== 'constraint') return null;
  const constraint = identValue(toks[i + 2]);
  if (!constraint) return null;
  return { schema: q.schema, table: q.name, constraint };
}

/**
 * The relationships whose `ALTER TABLE` failed, in the shape relationships.json
 * uses so the file can be handed to PGREST_RELATIONSHIPS_PATH unchanged. The
 * residual file exists so a key the catalog could not take is still declared to
 * the engine — and only that key.
 *
 * `declarable` says whether declaring it would achieve anything: a key whose own
 * table or whose referenced table the transformer had to drop describes a
 * relationship between relations the cluster does not have, so the manifest
 * cannot recover it either. Measured: the single residual key,
 * public.car_racers -> public.car_models, is of exactly that kind — car_models
 * is partitioned, which DSQL rejects, and car_racers went with it.
 *
 * @param {object[]} fkFailures failures from 08-foreign-keys.sql, still holding
 *   their `text`.
 * @param {object[]} dropped the transformer's drop list.
 */
function residualRelationships(fkFailures, dropped) {
  const path = join(HERE, 'relationships.json');
  const all = existsSync(path)
    ? JSON.parse(readFileSync(path, 'utf8')).relationships || []
    : [];
  const goneTables = new Set(dropped
    .filter((d) => d.kind === 'table' || d.kind === 'partitioned-table')
    .map((d) => d.object));
  const out = [];
  for (const f of fkFailures) {
    const ref = addedConstraint(f.text);
    if (!ref) continue;
    const rel = all.find((r) => ref.constraint === r.constraint
      && ref.table === r.table
      && (ref.schema === null || ref.schema === r.schema));
    if (!rel) continue;
    const missing = [`${rel.schema}.${rel.table}`,
      `${rel.foreignSchema}.${rel.foreignTable}`].filter((t) => goneTables.has(t));
    out.push({
      ...rel,
      error: f.error,
      declarable: missing.length === 0,
      ...(missing.length ? { droppedTables: missing } : {}),
    });
  }
  return out;
}

function quoteIdent(name) { return `"${name.replace(/"/g, '""')}"`; }

/** The statement's own search_path with every fixture schema appended. */
function widenedPath(setStatement) {
  const own = (setStatement || '')
    .replace(/^\s*set\s+search_path\s*(?:=|to)\s*/i, '')
    .replace(/;\s*$/, '')
    .trim();
  const all = FIXTURE_SCHEMAS.map(quoteIdent).join(', ');
  return own ? `SET search_path = ${own}, ${all}` : `SET search_path = ${all}, pg_catalog`;
}

async function main() {
  const session = new Session();
  let failures = [];
  let total = 0;
  let applied = 0;
  const t0 = Date.now();

  let resetApplied = 0;
  if (!noReset && !only) {
    const r = await resetSchemas(session);
    resetApplied = r.applied;
    failures.push(...r.failures);
    process.stderr.write(`(reset): ${r.applied} drops, ${r.failures.length} failed\n`);
  }
  const resetFailures = failures.length;

  // The foreign keys are counted on their own: a rejected key is not a missing
  // object, it is a relationship the catalog does not hold, and the run has to
  // declare that one by hand.
  let fkTotal = 0;
  let triedForeignKeys = false;

  for (const file of sqlFiles()) {
    const src = readFileSync(join(SQL_DIR, file), 'utf8');
    // norm() strips comments: a comment-only chunk is not a statement.
    const statements = splitStatements(src).filter((s) => s.kind === 'sql' && norm(s.text));
    if (file === FK_FILE) {
      triedForeignKeys = true;
      fkTotal += statements.length;
    }
    let ok = 0;
    for (const st of statements) {
      total++;
      try {
        await session.run(st.text);
        applied++;
        ok++;
      } catch (err) {
        failures.push({
          file,
          line: st.line,
          statement: firstLine(st.text),
          error: String(err.message || err).replace(/\s+/g, ' ').slice(0, 300),
          text: st.text,
          searchPath: session.searchPath,
        });
      }
    }
    process.stderr.write(`${file}: ${ok}/${statements.length} applied\n`);
  }

  // DSQL validates SQL function bodies at creation time and does not allow
  // `SET check_function_bodies = off`, so a function that references an object
  // defined further down the fixture file fails on the first pass. Retry those
  // now that everything else exists.
  //
  // Pass 3 widens search_path to every fixture schema, keeping the statement's
  // own path in front so existing name resolution wins. Upstream loads these
  // fixtures with a database-level search_path (`ALTER DATABASE ... SET`), which
  // DSQL does not support; a SQL function body that calls an object in another
  // schema unqualified cannot be created without it. For string-bodied SQL
  // functions the body is re-parsed at call time, so this does not change what
  // the function does.
  for (let pass = 1; pass <= 3; pass++) {
    const retryable = failures.filter((f) => f.text && RETRYABLE.test(f.error));
    if (!retryable.length) break;
    const widen = pass === 3;
    let fixed = 0;
    for (const f of retryable) {
      const path = widen ? widenedPath(f.searchPath) : f.searchPath;
      try {
        if (path) await session.run(path);
        await session.run(f.text);
        applied++;
        fixed++;
        if (widen) f.widenedSearchPath = true;
        failures = failures.filter((x) => x !== f);
      } catch (err) {
        f.error = String(err.message || err).replace(/\s+/g, ' ').slice(0, 300);
      }
    }
    process.stderr.write(`retry pass ${pass}${widen ? ' (widened search_path)' : ''}: `
      + `${fixed}/${retryable.length} recovered\n`);
    if (!fixed && pass === 1) continue; // still try the widened pass
  }
  // Read the residual keys off the failures while they still carry their
  // statement text: `f.statement` has been through norm(), which lowercases, and
  // a quoted mixed-case identifier does not survive that.
  const fkFailures = failures.filter((f) => f.file === FK_FILE);
  const transformPath = join(HERE, 'transform-report.json');
  const dropped = existsSync(transformPath)
    ? JSON.parse(readFileSync(transformPath, 'utf8')).dropped
    : [];
  const residual = residualRelationships(fkFailures, dropped);
  for (const f of failures) { delete f.text; delete f.searchPath; }

  let objects = { tables: 0, views: 0, functions: 0, domains: 0 };
  try {
    objects = await countObjects(session);
  } catch (err) {
    process.stderr.write(`object count failed: ${err.message}\n`);
  }
  await session.end();

  // statementsTotal/Applied/Failed count the generated fixture files only; the
  // dynamic public-schema cleanup is reported in load-failures.json.
  const fileFailures = failures.filter((f) => f.file !== '(reset)');
  const report = {
    statementsTotal: total,
    statementsApplied: total - fileFailures.length,
    statementsFailed: fileFailures.length,
    // 08-foreign-keys.sql on its own. A failed key is a relationship the engine
    // cannot read from pg_constraint, so it has to be declared by hand:
    // relationships-residual.json holds those and nothing else.
    foreignKeysApplied: fkTotal - fkFailures.length,
    foreignKeysFailed: fkFailures.length,
    objects,
    dropped,
  };
  if (!noReport) {
    writeFileSync(join(HERE, 'load-report.json'),
      `${JSON.stringify(report, null, 2)}\n`);
  }

  // Written even when it is empty — an empty array is a result, a missing file
  // is ambiguous. A load that never applied 08-foreign-keys.sql has measured
  // nothing about the keys and leaves the file alone: the conformance runner
  // reloads 07-data.sql with `--only` between specs and must not blank a
  // manifest the run is reading.
  if (triedForeignKeys) {
    writeFileSync(join(HERE, 'relationships-residual.json'),
      `${JSON.stringify({ relationships: residual }, null, 2)}\n`);
    if (residual.length) {
      const declarable = residual.filter((r) => r.declarable).length;
      process.stderr.write(`${FK_FILE}: ${residual.length} key(s) rejected `
        + `(${declarable} worth declaring), written to `
        + 'relationships-residual.json: '
        + `${residual.map((r) => `${r.schema}.${r.table}.${r.constraint}`
          + (r.declarable ? '' : ' [table dropped]')).join(', ')}\n`);
    }
    // A rejected key with no entry in relationships.json cannot be declared at
    // all; say so rather than let the shorter list read as fewer failures.
    if (fkFailures.length !== residual.length) {
      process.stderr.write(`${FK_FILE}: ${fkFailures.length} statement(s) `
        + `failed but ${residual.length} matched a relationship in `
        + 'relationships.json; see load-failures.json\n');
    }
  }

  const byError = {};
  for (const f of failures) {
    const key = f.error.replace(/"[^"]*"/g, '"…"').replace(/\s+at\s+.*/, '').slice(0, 90);
    byError[key] = (byError[key] || 0) + 1;
  }
  // Partial loads write their own failure file for the same reason they do not
  // rewrite load-report.json: the runner re-applies 07-data.sql between specs,
  // which would otherwise erase the full load's failure detail (measured — after
  // one runner pass load-failures.json read "statementsTotal": 558).
  const failuresFile = only ? 'load-failures-partial.json' : 'load-failures.json';
  writeFileSync(join(HERE, failuresFile), `${JSON.stringify({
    generatedAt: new Date().toISOString(),
    endpoint: ENDPOINT,
    elapsedMs: Date.now() - t0,
    statementsTotal: total,
    statementsFailed: fileFailures.length,
    resetApplied,
    resetFailures,
    byError,
    failures,
  }, null, 2)}\n`);

  process.stdout.write(`${JSON.stringify({
    statementsTotal: total,
    statementsApplied: total - fileFailures.length,
    statementsFailed: fileFailures.length,
    foreignKeysApplied: fkTotal - fkFailures.length,
    foreignKeysFailed: fkFailures.length,
    objects,
    elapsedMs: Date.now() - t0,
    topErrors: Object.entries(byError).sort((a, b) => b[1] - a[1]).slice(0, 12),
  }, null, 2)}\n`);
}

main().catch((err) => {
  process.stderr.write(`${err.stack}\n`);
  process.exit(1);
});
