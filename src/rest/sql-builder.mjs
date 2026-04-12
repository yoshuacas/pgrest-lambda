// sql-builder.mjs — Convert parsed queries to parameterized SQL

import { PostgRESTError } from './errors.mjs';
import { hasColumn } from './schema-cache.mjs';

const OP_SQL = {
  eq: '=',
  neq: '!=',
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
  like: 'LIKE',
  ilike: 'ILIKE',
};

const NEGATE_OP = {
  '=': '!=',
  '!=': '=',
  '>': '<=',
  '>=': '<',
  '<': '>=',
  '<=': '>',
  'LIKE': 'NOT LIKE',
  'ILIKE': 'NOT ILIKE',
};

function validateCol(schema, table, column) {
  if (!hasColumn(schema, table, column)) {
    throw new PostgRESTError(
      400, 'PGRST204',
      `Column '${column}' does not exist in '${table}'`,
    );
  }
}

function resolveSelectCols(selectList, schema, table) {
  if (selectList.length === 1 && selectList[0] === '*') {
    return Object.keys(schema.tables[table].columns);
  }
  for (const col of selectList) {
    validateCol(schema, table, col);
  }
  return selectList;
}

function buildFilterConditions(filters, schema, table, values) {
  const conditions = [];
  for (const f of filters) {
    validateCol(schema, table, f.column);
    if (f.operator === 'is') {
      const keyword = f.value.toLowerCase();
      if (!['null', 'true', 'false', 'unknown'].includes(keyword)) {
        throw new PostgRESTError(
          400, 'PGRST100',
          `IS operator only supports null, true, false, unknown (got '${f.value}')`,
        );
      }
      const not = f.negate ? ' NOT' : '';
      conditions.push(`"${f.column}" IS${not} ${keyword.toUpperCase()}`);
    } else if (f.operator === 'in') {
      const placeholders = f.value.map((v) => {
        values.push(v);
        return `$${values.length}`;
      });
      const not = f.negate ? 'NOT ' : '';
      conditions.push(
        `"${f.column}" ${not}IN (${placeholders.join(', ')})`,
      );
    } else {
      values.push(f.value);
      const base = OP_SQL[f.operator];
      const op = f.negate ? NEGATE_OP[base] : base;
      conditions.push(`"${f.column}" ${op} $${values.length}`);
    }
  }
  return conditions;
}

function whereClause(conditions) {
  return conditions.length > 0
    ? ` WHERE ${conditions.join(' AND ')}`
    : '';
}

function orderClause(order, schema, table) {
  if (!order || order.length === 0) return '';
  const parts = order.map((o) => {
    validateCol(schema, table, o.column);
    let sql = `"${o.column}" ${o.direction.toUpperCase()}`;
    if (o.nulls) {
      sql += ` NULLS ${o.nulls === 'nullsfirst' ? 'FIRST' : 'LAST'}`;
    }
    return sql;
  });
  return ` ORDER BY ${parts.join(', ')}`;
}

function limitOffsetClause(limit, offset, values) {
  let sql = '';
  if (limit != null) {
    values.push(limit);
    sql += ` LIMIT $${values.length}`;
  }
  if (offset) {
    values.push(offset);
    sql += ` OFFSET $${values.length}`;
  }
  return sql;
}

export function buildSelect(table, parsed, schema, authzConditions) {
  const values = [];
  const cols = resolveSelectCols(parsed.select, schema, table);
  const colList = cols.map((c) => `"${c}"`).join(', ');

  const conds = buildFilterConditions(
    parsed.filters, schema, table, values,
  );
  if (authzConditions?.conditions?.length > 0) {
    for (const cond of authzConditions.conditions) {
      conds.push(cond);
    }
    values.push(...authzConditions.values);
  }

  let sql = `SELECT ${colList} FROM "${table}"`;
  sql += whereClause(conds);
  sql += orderClause(parsed.order, schema, table);
  sql += limitOffsetClause(parsed.limit, parsed.offset, values);

  return { text: sql, values };
}

export function buildInsert(table, body, schema, parsed) {
  const rows = Array.isArray(body) ? body : [body];

  const colSet = new Set();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      validateCol(schema, table, key);
      colSet.add(key);
    }
  }

  const columns = [...colSet];

  const values = [];
  const tuples = rows.map((row) => {
    const placeholders = columns.map((col) => {
      values.push(row[col] !== undefined ? row[col] : null);
      return `$${values.length}`;
    });
    return `(${placeholders.join(', ')})`;
  });

  const colList = columns.map((c) => `"${c}"`).join(', ');
  let sql = `INSERT INTO "${table}" (${colList}) VALUES ${tuples.join(', ')}`;

  if (parsed.onConflict) {
    const conflictCols = parsed.onConflict
      .split(',')
      .map((c) => `"${c.trim()}"`)
      .join(', ');
    const pk = schema.tables[table]?.primaryKey || [];
    const updateCols = columns.filter(
      (c) => !pk.includes(c),
    );
    if (updateCols.length > 0) {
      const sets = updateCols
        .map((c) => `"${c}" = EXCLUDED."${c}"`)
        .join(', ');
      sql += ` ON CONFLICT (${conflictCols}) DO UPDATE SET ${sets}`;
    } else {
      sql += ` ON CONFLICT (${conflictCols}) DO NOTHING`;
    }
  }

  sql += ' RETURNING *';
  return { text: sql, values };
}

export function buildUpdate(table, body, parsed, schema, authzConditions) {
  if (parsed.filters.length === 0) {
    throw new PostgRESTError(
      400, 'PGRST106',
      'UPDATE requires filters to prevent bulk change',
    );
  }

  const values = [];
  const setClauses = [];
  for (const [col, val] of Object.entries(body)) {
    validateCol(schema, table, col);
    values.push(val);
    setClauses.push(`"${col}" = $${values.length}`);
  }

  const conds = buildFilterConditions(
    parsed.filters, schema, table, values,
  );
  if (authzConditions?.conditions?.length > 0) {
    for (const cond of authzConditions.conditions) {
      conds.push(cond);
    }
    values.push(...authzConditions.values);
  }

  let sql = `UPDATE "${table}" SET ${setClauses.join(', ')}`;
  sql += whereClause(conds);
  sql += ' RETURNING *';

  return { text: sql, values };
}

export function buildDelete(table, parsed, schema, authzConditions) {
  if (parsed.filters.length === 0) {
    throw new PostgRESTError(
      400, 'PGRST106',
      'DELETE requires filters to prevent bulk change',
    );
  }

  const values = [];
  const conds = buildFilterConditions(
    parsed.filters, schema, table, values,
  );
  if (authzConditions?.conditions?.length > 0) {
    for (const cond of authzConditions.conditions) {
      conds.push(cond);
    }
    values.push(...authzConditions.values);
  }

  let sql = `DELETE FROM "${table}"`;
  sql += whereClause(conds);
  sql += ' RETURNING *';

  return { text: sql, values };
}

export function buildCount(table, parsed, schema, authzConditions) {
  const values = [];
  const conds = buildFilterConditions(
    parsed.filters, schema, table, values,
  );
  if (authzConditions?.conditions?.length > 0) {
    for (const cond of authzConditions.conditions) {
      conds.push(cond);
    }
    values.push(...authzConditions.values);
  }

  let sql = `SELECT COUNT(*) FROM "${table}"`;
  sql += whereClause(conds);

  return { text: sql, values };
}
