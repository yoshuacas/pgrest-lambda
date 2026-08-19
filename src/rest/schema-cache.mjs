// schema-cache.mjs — pg_catalog introspection + TTL cache

import { readFileSync } from 'node:fs';
import {
  parseViewTargetLists,
  resolveViewColumnSources,
} from './view-sources.mjs';

// Relation kinds the engine exposes as endpoints. Matches PostgREST:
// ordinary tables, views, materialised views, foreign tables and
// partitioned tables are all selectable relations.
const READABLE_RELKINDS = ['r', 'p', 'v', 'm', 'f'];

const RELKIND_LIST = READABLE_RELKINDS.map(k => `'${k}'`).join(', ');

// pg_relation_is_updatable() returns a bitmask keyed by CmdType:
// 1<<CMD_SELECT = 2, 1<<CMD_UPDATE = 4, 1<<CMD_INSERT = 8,
// 1<<CMD_DELETE = 16. A plain table and an auto-updatable view both
// report 28 (update|insert|delete).
const UPDATABLE_BIT = 4;
const INSERTABLE_BIT = 8;
const DELETABLE_BIT = 16;

const COLUMNS_SQL = `
  SELECT c.relname AS table_name,
         c.oid AS rel_oid,
         c.relkind::text AS relkind,
         pg_catalog.pg_relation_is_updatable(c.oid, true) AS updatable_bits,
         a.attname AS column_name,
         a.attnum AS attnum,
         pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type,
         NOT a.attnotnull AS is_nullable,
         pg_get_expr(d.adbin, d.adrelid) AS column_default
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid
    LEFT JOIN pg_catalog.pg_attrdef d
      ON d.adrelid = c.oid AND d.adnum = a.attnum
   WHERE n.nspname = 'public'
     AND c.relkind IN (${RELKIND_LIST})
     AND c.relname NOT LIKE '\\_%'
     AND a.attnum > 0
     AND NOT a.attisdropped
   ORDER BY c.relname, a.attnum`;

// The rewrite rule of a view carries, per output column, the base
// relation and base attnum it came from (resorigtbl/resorigcol). That
// is the only place the mapping exists in the catalog, and it is how
// PostgREST propagates keys and relationships onto views.
const VIEW_DEFS_SQL = `
  SELECT c.oid AS view_oid,
         c.relname AS view_name,
         r.ev_action::text AS view_definition
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_catalog.pg_rewrite r
      ON r.ev_class = c.oid AND r.ev_type = '1'
   WHERE n.nspname = 'public'
     AND c.relkind IN ('v', 'm')
     AND c.relname NOT LIKE '\\_%'`;

const PK_SQL = `
  SELECT c.relname AS table_name,
         a.attname AS column_name
    FROM pg_catalog.pg_constraint con
    JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_catalog.pg_attribute a
      ON a.attrelid = c.oid AND a.attnum = ANY(con.conkey)
   WHERE con.contype = 'p'
     AND n.nspname = 'public'
     AND c.relname NOT LIKE '\\_%'
   ORDER BY c.relname, a.attnum`;

// Foreign keys are read from every non-system schema, not just `public`.
// A key on a table the engine does not serve still matters: a `public`
// view over that table inherits the relationship, which is how PostgREST
// resolves embeds between views over a hidden base schema.
const FK_SQL = `
  SELECT con.conname AS constraint_name,
         n.nspname AS from_schema,
         c.relname AS from_table,
         array_agg(a.attname ORDER BY k.n)::text[] AS from_columns,
         fn.nspname AS to_schema,
         fc.relname AS to_table,
         array_agg(fa.attname ORDER BY k.n)::text[] AS to_columns
    FROM pg_catalog.pg_constraint con
    JOIN pg_catalog.pg_class c
      ON c.oid = con.conrelid
    JOIN pg_catalog.pg_namespace n
      ON n.oid = c.relnamespace
    JOIN pg_catalog.pg_class fc
      ON fc.oid = con.confrelid
    JOIN pg_catalog.pg_namespace fn
      ON fn.oid = fc.relnamespace
    CROSS JOIN LATERAL unnest(con.conkey, con.confkey)
      WITH ORDINALITY AS k(col, fcol, n)
    JOIN pg_catalog.pg_attribute a
      ON a.attrelid = c.oid AND a.attnum = k.col
    JOIN pg_catalog.pg_attribute fa
      ON fa.attrelid = fc.oid AND fa.attnum = k.fcol
   WHERE con.contype = 'f'
     AND n.nspname NOT IN ('pg_catalog', 'information_schema')
     AND fn.nspname NOT IN ('pg_catalog', 'information_schema')
   GROUP BY con.conname, n.nspname, c.relname, fn.nspname, fc.relname
   ORDER BY con.conname`;

// Relations a view's columns come from may live outside `public`. Only
// the oids the view definitions actually name are looked up.
const SOURCE_COLUMNS_SQL = `
  SELECT c.oid AS rel_oid,
         n.nspname AS schema_name,
         c.relname AS rel_name,
         a.attnum AS attnum,
         a.attname AS column_name
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid
   WHERE c.oid = ANY($1::oid[])
     AND a.attnum > 0
     AND NOT a.attisdropped`;

const SOURCE_PK_SQL = `
  SELECT con.conrelid AS rel_oid,
         a.attname AS column_name
    FROM pg_catalog.pg_constraint con
    CROSS JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS k(col, n)
    JOIN pg_catalog.pg_attribute a
      ON a.attrelid = con.conrelid AND a.attnum = k.col
   WHERE con.contype = 'p'
     AND con.conrelid = ANY($1::oid[])
   ORDER BY con.conrelid, k.n`;

// Primary and unique keys of every non-system relation, one row per key.
// A foreign key whose columns cover one of these is one-to-one, not
// many-to-one (SchemaCache.hs `addO2ORels`). Read from every schema for
// the same reason FK_SQL is: a `public` view inherits the cardinality of
// the key on its base relation.
const UNIQUE_KEYS_SQL = `
  SELECT n.nspname AS schema_name,
         c.relname AS table_name,
         con.conname AS constraint_name,
         con.contype AS contype,
         array_agg(a.attname ORDER BY k.n)::text[] AS columns
    FROM pg_catalog.pg_constraint con
    JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS k(col, n)
    JOIN pg_catalog.pg_attribute a
      ON a.attrelid = c.oid AND a.attnum = k.col
   WHERE con.contype IN ('p', 'u')
     AND n.nspname NOT IN ('pg_catalog', 'information_schema')
   GROUP BY n.nspname, c.relname, con.conname, con.contype`;

const FUNCTIONS_SQL = `
  SELECT p.proname AS function_name,
         p.proargnames AS arg_names,
         COALESCE(
           (SELECT array_agg(t.typname ORDER BY a.ord)
              FROM unnest(p.proargtypes)
                   WITH ORDINALITY AS a(oid, ord)
              JOIN pg_catalog.pg_type t
                ON t.oid = a.oid),
           '{}'::text[]
         ) AS arg_types,
         p.proargmodes AS arg_modes,
         p.proallargtypes AS all_arg_types,
         rt.typname AS return_type,
         rt.typtype AS return_type_category,
         p.proretset AS returns_set,
         p.provolatile AS volatility,
         l.lanname AS language,
         p.pronargs AS num_args,
         p.pronargdefaults AS num_defaults,
         p.prokind AS prokind
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n
      ON n.oid = p.pronamespace
    JOIN pg_catalog.pg_type rt
      ON rt.oid = p.prorettype
    JOIN pg_catalog.pg_language l
      ON l.oid = p.prolang
   WHERE n.nspname = 'public'
     AND p.prokind = 'f'
     AND (
       p.proargmodes IS NULL
       OR NOT p.proargmodes::text[] && ARRAY['o','b','v']
     )
   ORDER BY p.proname`;

const EXCLUDED_ARG_MODES = new Set(['o', 'b', 'v']);

function parseCharArray(val) {
  if (Array.isArray(val)) return val;
  if (typeof val === 'string' && val.startsWith('{') && val.endsWith('}')) {
    return val.slice(1, -1).split(',');
  }
  return null;
}

async function buildFunctionsMap(rows, pool) {
  const groups = new Map();
  for (const row of rows) {
    if (row.prokind && row.prokind !== 'f') continue;

    const modes = parseCharArray(row.arg_modes);
    row.arg_modes = modes;
    if (modes && modes.some(m => EXCLUDED_ARG_MODES.has(m))) continue;

    const name = row.function_name;
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(row);
  }

  const tableOids = new Set();
  for (const [, fnRows] of groups) {
    if (fnRows.length !== 1) continue;
    const row = fnRows[0];
    if (row.arg_modes && row.arg_modes.includes('t')
        && row.all_arg_types) {
      for (let i = 0; i < row.arg_modes.length; i++) {
        if (row.arg_modes[i] === 't') {
          tableOids.add(row.all_arg_types[i]);
        }
      }
    }
  }

  const oidToType = {};
  if (tableOids.size > 0) {
    const res = await pool.query(
      'SELECT oid, typname FROM pg_catalog.pg_type'
      + ' WHERE oid = ANY($1::oid[])',
      [Array.from(tableOids)],
    );
    for (const r of res.rows) {
      oidToType[r.oid] = r.typname;
    }
  }

  const functions = {};
  for (const [name, fnRows] of groups) {
    if (fnRows.length > 1) {
      functions[name] = { overloaded: true };
      continue;
    }

    const row = fnRows[0];

    if (row.num_args > 0 && row.arg_names == null) continue;
    if (row.num_args > 0
        && row.arg_names.slice(0, row.num_args).some(n => n === '')) {
      continue;
    }

    const args = [];
    for (let i = 0; i < row.num_args; i++) {
      args.push({
        name: row.arg_names[i],
        type: row.arg_types[i],
      });
    }

    let returnColumns = null;
    if (row.arg_modes && row.arg_modes.includes('t')
        && row.all_arg_types) {
      returnColumns = [];
      for (let i = 0; i < row.arg_modes.length; i++) {
        if (row.arg_modes[i] === 't') {
          returnColumns.push({
            name: row.arg_names[i],
            type: oidToType[row.all_arg_types[i]] || 'unknown',
          });
        }
      }
    }

    const isScalar = ['b', 'd', 'e'].includes(row.return_type_category)
      && !row.returns_set;

    functions[name] = {
      args,
      returnType: row.return_type,
      returnColumns,
      returnsSet: Boolean(row.returns_set),
      isScalar,
      volatility: row.volatility,
      language: row.language,
      numDefaults: row.num_defaults,
    };
  }

  return functions;
}

function inferConventionRelationships(tables) {
  const relationships = [];
  const tableNames = Object.keys(tables);

  for (const tableName of tableNames) {
    const columns = Object.keys(tables[tableName].columns);
    for (const col of columns) {
      if (!col.endsWith('_id')) continue;

      const base = col.slice(0, -3); // strip '_id'
      if (!base) continue; // bare '_id' column

      // Find target table: exact match or pluralized.
      // Skip self-references: both 'base === tableName' and
      // 'base + "s" === tableName' are excluded.
      // Build candidate table names in priority order
      const candidates = [base, base + 's'];

      // -es plural: bases ending in s, x, z, sh, ch
      if (/(?:s|x|z|sh|ch)$/.test(base)) {
        candidates.push(base + 'es');
      }

      // -ies plural: bases ending in consonant + y
      if (/[^aeiou]y$/.test(base)) {
        candidates.push(base.slice(0, -1) + 'ies');
      }

      let targetTable = null;
      for (const candidate of candidates) {
        if (tableNames.includes(candidate)
            && candidate !== tableName) {
          targetTable = candidate;
          break;
        }
      }
      if (!targetTable) continue;

      // Target must have single-column PK
      const targetPK = tables[targetTable].primaryKey;
      if (targetPK.length !== 1) continue;

      relationships.push({
        constraint: null,
        fromTable: tableName,
        fromColumns: [col],
        toTable: targetTable,
        toColumns: [targetPK[0]],
      });
    }
  }

  return relationships;
}

// --- Declared relationships (external manifest) ---
//
// Aurora DSQL rejects FOREIGN KEY, so pg_constraint has no contype='f'
// rows and embedding has nothing to derive from. A manifest supplies the
// same facts out of band. On a database that does have foreign keys the
// catalog is still read first and the manifest only adds what the catalog
// did not report, so the PostgreSQL path is unchanged.

function relKey(rel) {
  return [
    rel.fromSchema || 'public', rel.fromTable, rel.fromColumns.join(','),
    rel.toSchema || 'public', rel.toTable, rel.toColumns.join(','),
    rel.junctionSchema || '',
    rel.junctionTable || '',
    (rel.junctionFromColumns || []).join(','),
    (rel.junctionToColumns || []).join(','),
  ].join('|');
}

/**
 * Normalise the manifest format documented in
 * conformance/CONTRACTS.md §2 into the engine's internal relationship
 * shape. Schemas are kept: a key on a relation outside `public` is not
 * served directly but still propagates onto `public` views.
 */
export function normalizeDeclaredRelationships(manifest) {
  const list = Array.isArray(manifest)
    ? manifest
    : (manifest?.relationships || []);
  const out = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const { table, foreignTable } = entry;
    const columns = entry.columns || [];
    const foreignColumns = entry.foreignColumns || [];
    if (!table || !foreignTable) continue;
    if (!Array.isArray(columns) || !Array.isArray(foreignColumns)) continue;
    if (columns.length === 0
        || columns.length !== foreignColumns.length) {
      continue;
    }
    out.push({
      constraint: entry.constraint || null,
      fromSchema: entry.schema || 'public',
      fromTable: table,
      fromColumns: [...columns],
      toSchema: entry.foreignSchema || 'public',
      toTable: foreignTable,
      toColumns: [...foreignColumns],
      source: 'declared',
    });
  }
  return out;
}

function loadRelationshipManifest(source) {
  if (!source) return null;
  if (typeof source !== 'string') return source;
  let text;
  try {
    text = readFileSync(source, 'utf8');
  } catch (err) {
    throw new Error(
      `pgrest-lambda: cannot read relationship manifest '${source}': `
      + err.message);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(
      `pgrest-lambda: relationship manifest '${source}' is not valid `
      + `JSON: ${err.message}`);
  }
}

/**
 * Propagate primary keys and foreign-key relationships from base
 * relations onto the views that expose their columns, the way PostgREST
 * does (SchemaCache.hs `addViewPrimaryKeys` / `addViewM2OAndO2ORels`).
 *
 * @param {Array} baseRels    schema-qualified base relationships
 * @param {Map} viewColumnMap viewName →
 *   Map('baseSchema.baseTable.baseCol' → [viewColumn])
 * @returns {Array} relationships that involve at least one view
 */
export function deriveViewRelationships(baseRels, viewColumnMap) {
  const derived = [];

  // All combinations of view columns for a list of base columns. A view
  // may expose the same base column more than once (aliased twice), and
  // PostgREST then treats each exposure as its own relationship — which
  // is what makes those embeds ambiguous rather than silently picking
  // one.
  const MAX_COMBOS = 8;
  function combos(viewName, schema, baseTable, baseColumns) {
    const map = viewColumnMap.get(viewName);
    if (!map) return [];
    let acc = [[]];
    for (const col of baseColumns) {
      const options = map.get(`${schema}.${baseTable}.${col}`);
      if (!options || options.length === 0) return [];
      const next = [];
      for (const prefix of acc) {
        for (const option of options) {
          if (next.length >= MAX_COMBOS) break;
          next.push([...prefix, option]);
        }
      }
      acc = next;
    }
    return acc;
  }

  const viewNames = [...viewColumnMap.keys()];

  // A view inherits the cardinality of the key it exposes: a one-to-one
  // base key stays one-to-one through the view. Spread conditionally so a
  // plain many-to-one keeps the field absent.
  const card = (rel) =>
    rel.cardinality ? { cardinality: rel.cardinality } : {};

  for (const rel of baseRels) {
    const fromViews = [];
    const toViews = [];
    for (const viewName of viewNames) {
      for (const cols of combos(
          viewName, rel.fromSchema, rel.fromTable, rel.fromColumns)) {
        fromViews.push({ viewName, cols });
      }
      for (const cols of combos(
          viewName, rel.toSchema, rel.toTable, rel.toColumns)) {
        toViews.push({ viewName, cols });
      }
    }

    for (const fv of fromViews) {
      derived.push({
        constraint: rel.constraint,
        ...card(rel),
        fromSchema: 'public',
        fromTable: fv.viewName,
        fromColumns: fv.cols,
        toSchema: rel.toSchema,
        toTable: rel.toTable,
        toColumns: rel.toColumns,
        source: 'view',
      });
    }
    for (const tv of toViews) {
      derived.push({
        constraint: rel.constraint,
        ...card(rel),
        fromSchema: rel.fromSchema,
        fromTable: rel.fromTable,
        fromColumns: rel.fromColumns,
        toSchema: 'public',
        toTable: tv.viewName,
        toColumns: tv.cols,
        source: 'view',
      });
    }
    for (const fv of fromViews) {
      for (const tv of toViews) {
        derived.push({
          constraint: rel.constraint,
          ...card(rel),
          fromSchema: 'public',
          fromTable: fv.viewName,
          fromColumns: fv.cols,
          toSchema: 'public',
          toTable: tv.viewName,
          toColumns: tv.cols,
          source: 'view',
        });
      }
    }
  }

  return derived;
}

/**
 * Group primary/unique key rows by qualified relation name.
 * @param {Array<object>} rows rows of UNIQUE_KEYS_SQL
 * @returns {Map<string, string[][]>} 'schema.table' → list of key column
 *   lists
 */
export function buildUniqueKeyMap(rows) {
  const map = new Map();
  for (const row of rows || []) {
    const cols = Array.isArray(row?.columns) ? row.columns : [];
    if (cols.length === 0 || !row.table_name) continue;
    const key = `${row.schema_name || 'public'}.${row.table_name}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(cols);
  }
  return map;
}

/**
 * A foreign key is one-to-one, not many-to-one, when its own columns
 * cover a primary or unique key of the referencing table: at most one
 * child row can point at a given parent. PostgREST reports that
 * cardinality in `PGRST201` details and returns the embed as a single
 * object instead of an array (SchemaCache.hs `addO2ORels`).
 *
 * @param {Array<object>} rels relationships to classify
 * @param {Map<string, string[][]>} uniqueKeys from buildUniqueKeyMap
 * @returns {Array<object>} same list, one-to-one entries marked
 */
export function markOneToOneRelationships(rels, uniqueKeys) {
  if (!uniqueKeys || uniqueKeys.size === 0) return rels;
  return rels.map((rel) => {
    if (rel.cardinality) return rel;
    const keys = uniqueKeys.get(`${rel.fromSchema}.${rel.fromTable}`);
    if (!keys) return rel;
    const fkCols = new Set(rel.fromColumns);
    const covered = keys.some(cols => cols.every(c => fkCols.has(c)));
    return covered ? { ...rel, cardinality: 'one-to-one' } : rel;
  });
}

/**
 * A junction table — one whose primary key covers the columns of two
 * different foreign keys — yields a many-to-many relationship between
 * the two tables it points at. PostgREST derives `actors?select=films(*)`
 * this way (SchemaCache.hs `addM2MRels`).
 *
 * The junction itself does not have to be served: upstream derives the
 * relationship over every schema it introspects and only filters the two
 * ends afterwards, so `public.a ↔ public.b` through `private.junction`
 * embeds normally.
 *
 * @param {object} tables served relations, keyed by bare name
 * @param {Array<object>} rels candidate foreign keys, any schema
 * @param {Map<string, string[]>} [primaryKeys] 'schema.table' → pk
 *   columns, for junctions outside the served schema
 */
export function deriveManyToManyRelationships(tables, rels, primaryKeys) {
  const pkOf = (schema, tableName) => {
    if (schema === 'public') {
      const pk = tables[tableName]?.primaryKey || [];
      if (pk.length > 0) return pk;
    }
    return primaryKeys?.get(`${schema}.${tableName}`) || [];
  };

  const byJunction = new Map();
  for (const rel of rels) {
    // Only plain many-to-one keys form a junction. A one-to-one key
    // already matches at most one row, and an m2m is a derivation output.
    if (rel.cardinality) continue;
    const key = `${rel.fromSchema || 'public'}.${rel.fromTable}`;
    if (!byJunction.has(key)) byJunction.set(key, []);
    byJunction.get(key).push(rel);
  }

  const out = [];
  const seen = new Set();
  for (const [qualified, jrels] of byJunction) {
    const junctionSchema = jrels[0].fromSchema || 'public';
    const junction = jrels[0].fromTable;
    const pk = pkOf(junctionSchema, junction);
    if (pk.length === 0) continue;
    const pkSet = new Set(pk);
    for (const a of jrels) {
      for (const b of jrels) {
        if (a === b) continue;
        if (a.constraint && b.constraint
            && a.constraint === b.constraint) {
          continue;
        }
        const used = [...a.fromColumns, ...b.fromColumns];
        if (!used.every(c => pkSet.has(c))) continue;
        // The pair (a, b) and the pair (b, a) are the same
        // relationship seen from either end. Emitting both would make
        // every m2m embed ambiguous.
        const side = (r) =>
          `${r.toSchema || 'public'}.${r.toTable}`
          + `(${r.toColumns.join(',')})`
          + `:${r.fromColumns.join(',')}`;
        const pairKey = `${qualified}|`
          + [side(a), side(b)].sort().join('|');
        if (seen.has(pairKey)) continue;
        seen.add(pairKey);
        out.push({
          constraint: null,
          cardinality: 'many-to-many',
          fromSchema: a.toSchema || 'public',
          fromTable: a.toTable,
          fromColumns: a.toColumns,
          toSchema: b.toSchema || 'public',
          toTable: b.toTable,
          toColumns: b.toColumns,
          junctionSchema,
          junctionTable: junction,
          junctionFromColumns: a.fromColumns,
          junctionToColumns: b.fromColumns,
          junctionFromConstraint: a.constraint || null,
          junctionToConstraint: b.constraint || null,
          source: 'm2m',
        });
      }
    }
  }
  return out;
}

function dedupeRelationships(lists) {
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    for (const rel of list) {
      const key = relKey(rel);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(rel);
    }
  }
  return out;
}

async function pgIntrospect(pool, capabilities, options = {}) {
  const [colResult, pkResult, uniqueResult] = await Promise.all([
    pool.query(COLUMNS_SQL),
    pool.query(PK_SQL),
    pool.query(UNIQUE_KEYS_SQL),
  ]);

  const tables = {};
  // oid → relation name and (oid, attnum) → column name, needed to turn
  // the view provenance oids back into names.
  const oidToRelation = new Map();
  const attnumToColumn = new Map();
  let hasViews = false;

  for (const row of colResult.rows) {
    if (!tables[row.table_name]) {
      const bits = row.updatable_bits == null
        ? INSERTABLE_BIT | UPDATABLE_BIT | DELETABLE_BIT
        : Number(row.updatable_bits);
      const kind = row.relkind || 'r';
      if (kind === 'v' || kind === 'm') hasViews = true;
      tables[row.table_name] = {
        columns: {},
        primaryKey: [],
        kind,
        isView: kind === 'v' || kind === 'm',
        insertable: (bits & INSERTABLE_BIT) !== 0,
        updatable: (bits & UPDATABLE_BIT) !== 0,
        deletable: (bits & DELETABLE_BIT) !== 0,
      };
      if (row.rel_oid != null) {
        oidToRelation.set(Number(row.rel_oid), row.table_name);
      }
    }
    tables[row.table_name].columns[row.column_name] = {
      type: row.data_type,
      nullable: Boolean(row.is_nullable),
      defaultValue: row.column_default || null,
    };
    if (row.rel_oid != null && row.attnum != null) {
      attnumToColumn.set(
        `${Number(row.rel_oid)}.${Number(row.attnum)}`, row.column_name);
    }
  }

  for (const row of pkResult.rows) {
    if (tables[row.table_name]) {
      tables[row.table_name].primaryKey.push(row.column_name);
    }
  }

  let fkRows = [];
  if (!capabilities || capabilities.supportsForeignKeys) {
    const fkResult = await pool.query(FK_SQL);
    fkRows = fkResult.rows;
  }

  const catalogRels = fkRows
    .filter(row =>
      row.from_table && row.to_table
      && Array.isArray(row.from_columns)
      && Array.isArray(row.to_columns)
      && row.from_columns.length === row.to_columns.length
      && row.from_columns.length > 0)
    .map(row => ({
      constraint: row.constraint_name,
      fromSchema: row.from_schema || 'public',
      fromTable: row.from_table,
      fromColumns: row.from_columns,
      toSchema: row.to_schema || 'public',
      toTable: row.to_table,
      toColumns: row.to_columns,
      source: 'catalog',
    }));

  const manifest = loadRelationshipManifest(options.relationships);
  const declaredRels = manifest
    ? normalizeDeclaredRelationships(manifest)
    : [];

  const uniqueRows = uniqueResult?.rows || [];
  const baseRels = markOneToOneRelationships(
    dedupeRelationships([catalogRels, declaredRels]),
    buildUniqueKeyMap(uniqueRows));
  // Primary keys of every schema, so a junction the engine does not serve
  // can still be recognised as one.
  const allPrimaryKeys = new Map();
  for (const [name, keys] of buildUniqueKeyMap(
      uniqueRows.filter(r => r.contype === 'p'))) {
    allPrimaryKeys.set(name, keys[0]);
  }

  // View column provenance: view column → 'schema.table.column' of the
  // base relation it came from. The base relation is often outside
  // `public`, which is exactly why the oids are looked up separately.
  const viewColumnMap = new Map();
  const sourcePk = new Map();
  if (hasViews) {
    const viewRows = await pool.query(VIEW_DEFS_SQL);
    const sources = resolveViewColumnSources(
      parseViewTargetLists(viewRows.rows));

    const unknownOids = new Set();
    for (const entries of sources.values()) {
      for (const entry of entries) {
        if (!oidToRelation.has(entry.srcOid)) unknownOids.add(entry.srcOid);
      }
    }
    if (unknownOids.size > 0) {
      const oids = [...unknownOids];
      const [srcCols, srcPks] = await Promise.all([
        pool.query(SOURCE_COLUMNS_SQL, [oids]),
        pool.query(SOURCE_PK_SQL, [oids]),
      ]);
      for (const row of srcCols.rows) {
        const oid = Number(row.rel_oid);
        oidToRelation.set(oid, `${row.schema_name}.${row.rel_name}`);
        attnumToColumn.set(
          `${oid}.${Number(row.attnum)}`, row.column_name);
      }
      for (const row of srcPks.rows) {
        const name = oidToRelation.get(Number(row.rel_oid));
        if (!name) continue;
        if (!sourcePk.has(name)) sourcePk.set(name, []);
        sourcePk.get(name).push(row.column_name);
      }
    }

    for (const [viewOid, entries] of sources) {
      const viewName = oidToRelation.get(viewOid);
      if (!viewName || !tables[viewName]) continue;
      const map = new Map();
      for (const entry of entries) {
        const viewCol =
          attnumToColumn.get(`${viewOid}.${entry.attnum}`);
        const base = oidToRelation.get(entry.srcOid);
        const baseCol = base
          ? attnumToColumn.get(`${entry.srcOid}.${entry.srcAttnum}`)
          : null;
        if (!viewCol || !base || !baseCol) continue;
        // Names from COLUMNS_SQL are bare (public); source lookups are
        // already qualified.
        const key = base.includes('.')
          ? `${base}.${baseCol}`
          : `public.${base}.${baseCol}`;
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(viewCol);
      }
      if (map.size > 0) viewColumnMap.set(viewName, map);
    }

    // A view inherits the primary key of a source relation when it
    // exposes every PK column. PostgREST needs this for Location headers
    // and to treat a junction view as a junction.
    for (const [name, def] of Object.entries(tables)) {
      if (def.primaryKey.length > 0) {
        sourcePk.set(`public.${name}`, def.primaryKey);
      }
    }
    for (const [viewName, map] of viewColumnMap) {
      if (!tables[viewName].isView) continue;
      if (tables[viewName].primaryKey.length > 0) continue;
      // Prefer the relation the view draws the most columns from.
      const contributors = new Map();
      for (const key of map.keys()) {
        const rel = key.slice(0, key.lastIndexOf('.'));
        contributors.set(rel, (contributors.get(rel) || 0) + 1);
      }
      const ranked = [...contributors.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      for (const [rel] of ranked) {
        if (rel === `public.${viewName}`) continue;
        const pk = sourcePk.get(rel);
        if (!pk || pk.length === 0) continue;
        const mapped = pk.map(c => map.get(`${rel}.${c}`)?.[0]);
        if (mapped.every(Boolean)) {
          tables[viewName].primaryKey = mapped;
          break;
        }
      }
    }
  }

  const withViews = dedupeRelationships([
    baseRels,
    deriveViewRelationships(baseRels, viewColumnMap),
  ]);

  // Only relations the engine serves can take part in an embed.
  const isServed = (rel) =>
    rel.fromSchema === 'public' && rel.toSchema === 'public'
    && tables[rel.fromTable] && tables[rel.toTable]
    && rel.fromColumns.every(c => tables[rel.fromTable].columns[c])
    && rel.toColumns.every(c => tables[rel.toTable].columns[c]);
  const servedRels = withViews.filter(isServed);

  // Junctions are looked for among the served relations only. Deriving
  // over every schema instead double-counts a junction that lives in a
  // hidden schema and is also exposed as a `public` view: both copies
  // link the same two tables, and every m2m embed through it turns
  // ambiguous.
  let relationships = dedupeRelationships([
    servedRels,
    deriveManyToManyRelationships(tables, servedRels, allPrimaryKeys),
  ]);

  // Convention fallback only when nothing else produced a relationship.
  if (relationships.length === 0) {
    relationships = inferConventionRelationships(tables);
  }

  let functions = {};
  if (!capabilities || capabilities.supportsRpc) {
    const fnResult = await pool.query(FUNCTIONS_SQL);
    functions = await buildFunctionsMap(fnResult.rows, pool);
  }

  return { tables, relationships, functions };
}

export function createSchemaCache(config) {
  const ttl = config.schemaCacheTtl || 30000;
  const capabilities = config.capabilities || null;
  // A declared-relationship manifest: an inline object/array, or a path
  // read from config or PGREST_RELATIONSHIPS_PATH.
  const relationships = config.relationships
    ?? process.env.PGREST_RELATIONSHIPS_PATH
    ?? null;
  const introspect = config.introspect
    || ((pool) => pgIntrospect(pool, capabilities, { relationships }));
  let cache = null;
  let lastRefreshAt = 0;

  function _resetCache() {
    cache = null;
    lastRefreshAt = 0;
  }

  async function getSchema(pool) {
    const now = Date.now();
    if (cache && (now - lastRefreshAt) < ttl) {
      return cache;
    }
    cache = await introspect(pool);
    lastRefreshAt = Date.now();
    return cache;
  }

  async function refresh(pool) {
    cache = await introspect(pool);
    lastRefreshAt = Date.now();
    return cache;
  }

  return { getSchema, refresh, _resetCache };
}

// Pure helpers — no state, exported directly
export function hasTable(schema, table) {
  return Boolean(schema.tables[table]);
}

export function hasColumn(schema, table, column) {
  return Boolean(schema.tables[table]?.columns[column]);
}

export function getPrimaryKey(schema, table) {
  return schema.tables[table]?.primaryKey || [];
}

export function getRelationships(schema) {
  return schema.relationships || [];
}

export function hasFunction(schema, fnName) {
  return Boolean(schema.functions?.[fnName]);
}

export function getFunction(schema, fnName) {
  return schema.functions?.[fnName] || null;
}
