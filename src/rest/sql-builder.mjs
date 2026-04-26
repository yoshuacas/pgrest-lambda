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
  // Support both old string format and new node format
  const cols = selectList
    .filter(s => typeof s === 'string' || s.type === 'column')
    .map(s => typeof s === 'string' ? s : s.name);
  if (cols.length === 1 && cols[0] === '*') {
    return Object.keys(schema.tables[table].columns);
  }
  for (const col of cols) {
    validateCol(schema, table, col);
  }
  return cols;
}

// --- Resource embedding helpers ---

function resolveRelationship(schema, parentTable, embedName, hint) {
  const rels = (schema.relationships || []).filter(r =>
    (r.fromTable === parentTable && r.toTable === embedName)
    || (r.toTable === parentTable && r.fromTable === embedName)
  );

  if (rels.length === 0) {
    throw new PostgRESTError(400, 'PGRST200',
      `Could not find a relationship between `
      + `'${parentTable}' and '${embedName}' `
      + `in the schema cache`);
  }

  if (hint) {
    const hinted = rels.filter(r =>
      r.constraint === hint
      || r.fromColumns.includes(hint)
      || r.toColumns.includes(hint)
    );
    if (hinted.length === 0) {
      throw new PostgRESTError(400, 'PGRST200',
        `Could not find a relationship between `
        + `'${parentTable}' and '${embedName}' `
        + `in the schema cache`);
    }
    if (hinted.length > 1) {
      throw ambiguousError(parentTable, embedName, hinted);
    }
    return hinted[0];
  }

  if (rels.length > 1) {
    throw ambiguousError(parentTable, embedName, rels);
  }

  return rels[0];
}

function ambiguousError(parentTable, embedName, rels) {
  const details = rels.map(r => {
    const cardinality =
      r.fromTable === parentTable
        ? 'many-to-one' : 'one-to-many';
    return {
      cardinality,
      embedding: `${parentTable} with ${embedName}`,
      relationship: `${r.constraint || '(convention)'} `
        + `using ${r.fromTable}(${r.fromColumns.join(',')})`
        + ` and ${r.toTable}(${r.toColumns.join(',')})`,
    };
  });
  const hint = `Try changing '${embedName}' to one of the `
    + `following: ${rels.map(r =>
        `'${embedName}!${r.constraint || r.fromColumns[0]}'`
      ).join(', ')}. Find the desired relationship in the `
    + `'details' key.`;
  return new PostgRESTError(300, 'PGRST201',
    `Could not embed because more than one relationship `
    + `was found for '${parentTable}' and '${embedName}'`,
    details, hint);
}

function buildEmbedSubquery(
    node, rel, parentTable, schema, values, authzFilters
) {
  if (rel.fromTable === parentTable) {
    return buildManyToOneSubquery(
      node, rel, parentTable, schema, values, authzFilters);
  } else {
    return buildOneToManySubquery(
      node, rel, parentTable, schema, values, authzFilters);
  }
}

function buildManyToOneSubquery(
    node, rel, parentTable, schema, values, authzFilters
) {
  const childTable = rel.toTable;
  const childCols = buildJsonBuildObject(
    node.select, childTable, schema, values, authzFilters);
  const joinCond = rel.fromColumns.map((fc, i) =>
    `"${childTable}"."${rel.toColumns[i]}" = `
    + `"${parentTable}"."${fc}"`
  ).join(' AND ');

  let where = joinCond;
  const childAuthz = authzFilters?.[childTable];
  if (childAuthz?.conditions?.length > 0) {
    const renumbered = renumberConditions(
      childAuthz.conditions, values.length + 1);
    where += ' AND ' + renumbered.join(' AND ');
    values.push(...childAuthz.values);
  }

  return `(SELECT json_build_object(${childCols})`
    + ` FROM "${childTable}" WHERE ${where})`;
}

function buildOneToManySubquery(
    node, rel, parentTable, schema, values, authzFilters
) {
  const childTable = rel.fromTable;
  const childCols = buildJsonBuildObject(
    node.select, childTable, schema, values, authzFilters);
  const joinCond = rel.fromColumns.map((fc, i) =>
    `"${childTable}"."${fc}" = `
    + `"${parentTable}"."${rel.toColumns[i]}"`
  ).join(' AND ');

  let where = joinCond;
  const childAuthz = authzFilters?.[childTable];
  if (childAuthz?.conditions?.length > 0) {
    const renumbered = renumberConditions(
      childAuthz.conditions, values.length + 1);
    where += ' AND ' + renumbered.join(' AND ');
    values.push(...childAuthz.values);
  }

  return `COALESCE((SELECT json_agg(json_build_object(`
    + `${childCols})) FROM "${childTable}" WHERE ${where})`
    + `, '[]'::json)`;
}

function buildJsonBuildObject(
    selectNodes, table, schema, values, authzFilters
) {
  const pairs = [];
  for (const node of selectNodes) {
    if (node.type === 'column') {
      if (node.name === '*') {
        for (const c of Object.keys(
            schema.tables[table].columns)) {
          pairs.push(`'${c}', "${table}"."${c}"`);
        }
      } else {
        validateCol(schema, table, node.name);
        const jsonKey = node.alias || node.name;
        pairs.push(
          `'${jsonKey}', "${table}"."${node.name}"`);
      }
    } else if (node.type === 'embed') {
      const rel = resolveRelationship(
        schema, table, node.name, node.hint);
      const alias = node.alias || node.name;
      const subquery = buildEmbedSubquery(
        node, rel, table, schema, values, authzFilters);
      pairs.push(`'${alias}', ${subquery}`);
    }
  }
  return pairs.join(', ');
}

function renumberConditions(conditions, startParam) {
  let paramIdx = 0;
  return conditions.map(cond =>
    cond.replace(/\$\d+/g, () => {
      paramIdx++;
      return `$${startParam + paramIdx - 1}`;
    })
  );
}

function buildSingleCondition(f, schema, table, values) {
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
    return `"${f.column}" IS${not} ${keyword.toUpperCase()}`;
  } else if (f.operator === 'in') {
    const placeholders = f.value.map((v) => {
      values.push(v);
      return `$${values.length}`;
    });
    const not = f.negate ? 'NOT ' : '';
    return `"${f.column}" ${not}IN (${placeholders.join(', ')})`;
  } else {
    values.push(f.value);
    const base = OP_SQL[f.operator];
    const op = f.negate ? NEGATE_OP[base] : base;
    return `"${f.column}" ${op} $${values.length}`;
  }
}

const MAX_NESTING_DEPTH = 10;

function buildLogicalCondition(
    group, schema, table, values, depth = 0) {
  if (depth > MAX_NESTING_DEPTH) {
    throw new PostgRESTError(400, 'PGRST100',
      'Logical operator nesting exceeds maximum '
      + `depth of ${MAX_NESTING_DEPTH}`);
  }

  const parts = [];
  for (const cond of group.conditions) {
    if (cond.type === 'logicalGroup') {
      parts.push(buildLogicalCondition(
        cond, schema, table, values, depth + 1));
    } else {
      parts.push(
        buildSingleCondition(cond, schema, table, values));
    }
  }

  const joiner =
    group.logicalOp === 'or' ? ' OR ' : ' AND ';
  const inner = parts.join(joiner);
  const wrapped = `(${inner})`;

  return group.negate ? `NOT ${wrapped}` : wrapped;
}

function buildFilterConditions(filters, schema, table, values) {
  const conditions = [];
  for (const f of filters) {
    if (f.type === 'logicalGroup') {
      conditions.push(
        buildLogicalCondition(f, schema, table, values));
    } else {
      conditions.push(
        buildSingleCondition(f, schema, table, values));
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
  const hasEmbeds = parsed.select.some(
    n => n.type === 'embed');

  let colList;
  const innerJoinConds = [];

  if (hasEmbeds) {
    // Build select expressions from tree
    const expressions = [];
    for (const node of parsed.select) {
      if (node.type === 'column') {
        if (node.name === '*') {
          for (const c of Object.keys(
              schema.tables[table].columns)) {
            expressions.push(`"${table}"."${c}"`);
          }
        } else {
          validateCol(schema, table, node.name);
          if (node.alias) {
            expressions.push(
              `"${table}"."${node.name}" AS "${node.alias}"`);
          } else {
            expressions.push(`"${table}"."${node.name}"`);
          }
        }
      } else if (node.type === 'embed') {
        const rel = resolveRelationship(
          schema, table, node.name, node.hint);
        const alias = node.alias || node.name;
        const subquery = buildEmbedSubquery(
          node, rel, table, schema, values,
          authzConditions?.embeds);
        expressions.push(`${subquery} AS "${alias}"`);

        // Inner join conditions
        if (node.inner) {
          if (rel.fromTable === table) {
            // Many-to-one inner: FK column IS NOT NULL
            innerJoinConds.push(
              rel.fromColumns.map(fc =>
                `"${table}"."${fc}" IS NOT NULL`
              ).join(' AND '));
          } else {
            // One-to-many inner: EXISTS subquery
            const existsCond = rel.fromColumns.map((fc, i) =>
              `"${rel.fromTable}"."${fc}" = `
              + `"${table}"."${rel.toColumns[i]}"`
            ).join(' AND ');
            innerJoinConds.push(
              `EXISTS (SELECT 1 FROM "${rel.fromTable}"`
              + ` WHERE ${existsCond})`);
          }
        }
      }
    }
    colList = expressions.join(', ');
  } else {
    // Flat select — backward compatible path
    const cols = parsed.select.filter(
      n => typeof n === 'string' || n.type === 'column');
    const names = cols.map(n => typeof n === 'string' ? n : n.name);
    if (names.length === 1 && names[0] === '*') {
      colList = Object.keys(schema.tables[table].columns)
        .map(c => `"${c}"`).join(', ');
    } else {
      for (const c of names) validateCol(schema, table, c);
      colList = cols.map(n => {
        const name = typeof n === 'string' ? n : n.name;
        const alias = typeof n === 'string' ? undefined : n.alias;
        if (alias) return `"${name}" AS "${alias}"`;
        return `"${name}"`;
      }).join(', ');
    }
  }

  // Build WHERE conditions
  const conds = buildFilterConditions(
    parsed.filters, schema, table, values);

  // Add inner join conditions
  for (const ijc of innerJoinConds) {
    conds.push(ijc);
  }

  // Add parent authz conditions
  const parentAuthz = authzConditions?.parent
    || authzConditions;
  if (parentAuthz?.conditions?.length > 0) {
    const renumbered = renumberConditions(
      parentAuthz.conditions, values.length + 1);
    for (const cond of renumbered) {
      conds.push(cond);
    }
    values.push(...parentAuthz.values);
  }

  let sql = `SELECT ${colList} FROM "${table}"`;
  sql += whereClause(conds);
  sql += orderClause(parsed.order, schema, table);
  sql += limitOffsetClause(parsed.limit, parsed.offset, values);

  return { text: sql, values };
}

export function buildInsert(table, body, schema, parsed) {
  const rows = Array.isArray(body) ? body : [body];

  let columns;

  if (parsed.columns && parsed.columns.length > 0) {
    for (const col of parsed.columns) {
      validateCol(schema, table, col);
    }
    columns = parsed.columns;
  } else {
    const colSet = new Set();
    for (const row of rows) {
      for (const key of Object.keys(row)) {
        validateCol(schema, table, key);
        colSet.add(key);
      }
    }
    columns = [...colSet];
  }

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
      .map((c) => {
        const col = c.trim();
        validateCol(schema, table, col);
        return `"${col}"`;
      })
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
    const renumbered = renumberConditions(
      authzConditions.conditions, values.length + 1);
    for (const cond of renumbered) {
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
    const renumbered = renumberConditions(
      authzConditions.conditions, values.length + 1);
    for (const cond of renumbered) {
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
    const renumbered = renumberConditions(
      authzConditions.conditions, values.length + 1);
    for (const cond of renumbered) {
      conds.push(cond);
    }
    values.push(...authzConditions.values);
  }

  let sql = `SELECT COUNT(*) FROM "${table}"`;
  sql += whereClause(conds);

  return { text: sql, values };
}

export { buildFilterConditions as _buildFilterConditions };
