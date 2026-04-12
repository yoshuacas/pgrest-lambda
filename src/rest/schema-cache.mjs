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

  return { tables };
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
