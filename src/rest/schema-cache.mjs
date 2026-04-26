// schema-cache.mjs — pg_catalog introspection + TTL cache

const COLUMNS_SQL = `
  SELECT c.relname AS table_name,
         a.attname AS column_name,
         pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type,
         NOT a.attnotnull AS is_nullable,
         pg_get_expr(d.adbin, d.adrelid) AS column_default
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid
    LEFT JOIN pg_catalog.pg_attrdef d
      ON d.adrelid = c.oid AND d.adnum = a.attnum
   WHERE n.nspname = 'public'
     AND c.relkind IN ('r', 'p')
     AND c.relname NOT LIKE '\\_%'
     AND a.attnum > 0
     AND NOT a.attisdropped
   ORDER BY c.relname, a.attnum`;

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

const FK_SQL = `
  SELECT con.conname AS constraint_name,
         c.relname AS from_table,
         array_agg(a.attname ORDER BY k.n)::text[] AS from_columns,
         fc.relname AS to_table,
         array_agg(fa.attname ORDER BY k.n)::text[] AS to_columns
    FROM pg_catalog.pg_constraint con
    JOIN pg_catalog.pg_class c
      ON c.oid = con.conrelid
    JOIN pg_catalog.pg_namespace n
      ON n.oid = c.relnamespace
    JOIN pg_catalog.pg_class fc
      ON fc.oid = con.confrelid
    CROSS JOIN LATERAL unnest(con.conkey, con.confkey)
      WITH ORDINALITY AS k(col, fcol, n)
    JOIN pg_catalog.pg_attribute a
      ON a.attrelid = c.oid AND a.attnum = k.col
    JOIN pg_catalog.pg_attribute fa
      ON fa.attrelid = fc.oid AND fa.attnum = k.fcol
   WHERE con.contype = 'f'
     AND n.nspname = 'public'
   GROUP BY con.conname, c.relname, fc.relname
   ORDER BY con.conname`;

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

async function pgIntrospect(pool, capabilities) {
  const [colResult, pkResult] = await Promise.all([
    pool.query(COLUMNS_SQL),
    pool.query(PK_SQL),
  ]);

  const tables = {};

  for (const row of colResult.rows) {
    if (!tables[row.table_name]) {
      tables[row.table_name] = { columns: {}, primaryKey: [] };
    }
    tables[row.table_name].columns[row.column_name] = {
      type: row.data_type,
      nullable: Boolean(row.is_nullable),
      defaultValue: row.column_default || null,
    };
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

  let relationships = fkRows.map(row => ({
    constraint: row.constraint_name,
    fromTable: row.from_table,
    fromColumns: row.from_columns,
    toTable: row.to_table,
    toColumns: row.to_columns,
  }));

  // Convention fallback when no real FKs found
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
  const introspect = config.introspect
    || ((pool) => pgIntrospect(pool, capabilities));
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
