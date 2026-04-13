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

async function pgIntrospect(pool) {
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

  // FK introspection (may fail on DSQL)
  let fkRows = [];
  try {
    const fkResult = await pool.query(FK_SQL);
    fkRows = fkResult.rows;
  } catch {
    // DSQL or other DB that rejects the FK query
    fkRows = [];
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

  return { tables, relationships };
}

export function createSchemaCache(config) {
  const ttl = config.schemaCacheTtl || 300000;
  const introspect = config.introspect || pgIntrospect;
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
