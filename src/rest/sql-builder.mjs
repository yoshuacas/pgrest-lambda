// sql-builder.mjs — Convert parsed queries to parameterized SQL

import { PostgRESTError } from './errors.mjs';
import { hasColumn } from './schema-cache.mjs';

// Defense-in-depth identifier guard. Every raw identifier that
// reaches a template literal must pass through q(). The schema
// cache still validates up-front; this catches any future code
// path that forgets to.
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

function q(name) {
  if (typeof name !== 'string' || !IDENT.test(name)) {
    throw new PostgRESTError(
      400, 'PGRST204',
      `'${name}' is not a valid identifier`,
    );
  }
  return `"${name}"`;
}

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

function castExpr(colExpr, cast) {
  return cast ? `CAST(${colExpr} AS ${cast})` : colExpr;
}

function resolveSelectCols(selectList, columnValidator, allColumns) {
  const cols = selectList
    .filter(s => typeof s === 'string' || s.type === 'column')
    .map(s => typeof s === 'string' ? s : s.name);
  if (cols.length === 1 && cols[0] === '*') {
    return [...allColumns];
  }
  for (const col of cols) {
    columnValidator(col);
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
    `${q(childTable)}.${q(rel.toColumns[i])} = `
    + `${q(parentTable)}.${q(fc)}`
  ).join(' AND ');

  let where = joinCond;

  if (node.filters?.length > 0) {
    const childValidator = (col) =>
      validateCol(schema, childTable, col);
    const filterConds = buildFilterConditions(
      node.filters, values, childValidator);
    where += ' AND ' + filterConds.join(' AND ');
  }

  const childAuthz = authzFilters?.[childTable];
  if (childAuthz?.conditions?.length > 0) {
    const renumbered = renumberConditions(
      childAuthz.conditions, values.length + 1);
    where += ' AND ' + renumbered.join(' AND ');
    values.push(...childAuthz.values);
  }

  return `(SELECT json_build_object(${childCols})`
    + ` FROM ${q(childTable)} WHERE ${where})`;
}

function buildOneToManySubquery(
    node, rel, parentTable, schema, values, authzFilters
) {
  const childTable = rel.fromTable;
  const childCols = buildJsonBuildObject(
    node.select, childTable, schema, values, authzFilters);
  const joinCond = rel.fromColumns.map((fc, i) =>
    `${q(childTable)}.${q(fc)} = `
    + `${q(parentTable)}.${q(rel.toColumns[i])}`
  ).join(' AND ');

  let where = joinCond;

  if (node.filters?.length > 0) {
    const childValidator = (col) =>
      validateCol(schema, childTable, col);
    const filterConds = buildFilterConditions(
      node.filters, values, childValidator);
    where += ' AND ' + filterConds.join(' AND ');
  }

  const childAuthz = authzFilters?.[childTable];
  if (childAuthz?.conditions?.length > 0) {
    const renumbered = renumberConditions(
      childAuthz.conditions, values.length + 1);
    where += ' AND ' + renumbered.join(' AND ');
    values.push(...childAuthz.values);
  }

  return `COALESCE((SELECT json_agg(json_build_object(`
    + `${childCols})) FROM ${q(childTable)} WHERE ${where})`
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
          pairs.push(`'${c}', ${q(table)}.${q(c)}`);
        }
      } else {
        validateCol(schema, table, node.name);
        const jsonKey = node.alias || node.name;
        const ref = castExpr(
          `${q(table)}.${q(node.name)}`, node.cast);
        pairs.push(`'${jsonKey}', ${ref}`);
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

function buildSingleCondition(f, values, columnValidator) {
  columnValidator(f.column);
  if (f.operator === 'is') {
    const keyword = f.value.toLowerCase();
    if (!['null', 'true', 'false', 'unknown'].includes(keyword)) {
      throw new PostgRESTError(
        400, 'PGRST100',
        `IS operator only supports null, true, false, unknown (got '${f.value}')`,
      );
    }
    const not = f.negate ? ' NOT' : '';
    return `${q(f.column)} IS${not} ${keyword.toUpperCase()}`;
  } else if (f.operator === 'in') {
    const placeholders = f.value.map((v) => {
      values.push(v);
      return `$${values.length}`;
    });
    const not = f.negate ? 'NOT ' : '';
    return `${q(f.column)} ${not}IN (${placeholders.join(', ')})`;
  } else {
    values.push(f.value);
    const base = OP_SQL[f.operator];
    const op = f.negate ? NEGATE_OP[base] : base;
    return `${q(f.column)} ${op} $${values.length}`;
  }
}

const MAX_NESTING_DEPTH = 10;

function buildLogicalCondition(
    group, values, columnValidator, depth = 0) {
  if (depth > MAX_NESTING_DEPTH) {
    throw new PostgRESTError(400, 'PGRST100',
      'Logical operator nesting exceeds maximum '
      + `depth of ${MAX_NESTING_DEPTH}`);
  }

  const parts = [];
  for (const cond of group.conditions) {
    if (cond.type === 'logicalGroup') {
      parts.push(buildLogicalCondition(
        cond, values, columnValidator, depth + 1));
    } else {
      parts.push(
        buildSingleCondition(cond, values, columnValidator));
    }
  }

  const joiner =
    group.logicalOp === 'or' ? ' OR ' : ' AND ';
  const inner = parts.join(joiner);
  const wrapped = `(${inner})`;

  return group.negate ? `NOT ${wrapped}` : wrapped;
}

function buildFilterConditions(filters, values, columnValidator) {
  const conditions = [];
  for (const f of filters) {
    if (f.type === 'logicalGroup') {
      conditions.push(
        buildLogicalCondition(f, values, columnValidator));
    } else {
      conditions.push(
        buildSingleCondition(f, values, columnValidator));
    }
  }
  return conditions;
}

function whereClause(conditions) {
  return conditions.length > 0
    ? ` WHERE ${conditions.join(' AND ')}`
    : '';
}

function orderClause(order, columnValidator) {
  if (!order || order.length === 0) return '';
  const parts = order.map((o) => {
    columnValidator(o.column);
    let sql = `${q(o.column)} ${o.direction.toUpperCase()}`;
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
  const columnValidator = (col) => validateCol(schema, table, col);
  const allColumns = Object.keys(schema.tables[table].columns);
  const hasEmbeds = parsed.select.some(
    n => n.type === 'embed');

  let colList;
  const innerJoinConds = [];

  if (hasEmbeds) {
    const expressions = [];
    for (const node of parsed.select) {
      if (node.type === 'column') {
        if (node.name === '*') {
          for (const c of allColumns) {
            expressions.push(`${q(table)}.${q(c)}`);
          }
        } else {
          validateCol(schema, table, node.name);
          const ref = castExpr(
            `${q(table)}.${q(node.name)}`, node.cast);
          const alias = node.alias || (node.cast ? node.name : null);
          if (alias) {
            expressions.push(`${ref} AS ${q(alias)}`);
          } else {
            expressions.push(ref);
          }
        }
      } else if (node.type === 'embed') {
        const rel = resolveRelationship(
          schema, table, node.name, node.hint);
        const alias = node.alias || node.name;
        const subquery = buildEmbedSubquery(
          node, rel, table, schema, values,
          authzConditions?.embeds);
        expressions.push(`${subquery} AS ${q(alias)}`);

        if (node.inner) {
          if (rel.fromTable === table) {
            if (node.filters?.length > 0) {
              const childTable = rel.toTable;
              const existsCond = rel.fromColumns.map((fc, i) =>
                `${q(childTable)}.${q(rel.toColumns[i])} = `
                + `${q(table)}.${q(fc)}`
              ).join(' AND ');
              const childValidator = (col) =>
                validateCol(schema, childTable, col);
              const filterConds = buildFilterConditions(
                node.filters, values, childValidator);
              innerJoinConds.push(
                `EXISTS (SELECT 1 FROM ${q(childTable)}`
                + ` WHERE ${existsCond}`
                + ` AND ${filterConds.join(' AND ')})`);
            } else {
              innerJoinConds.push(
                rel.fromColumns.map(fc =>
                  `${q(table)}.${q(fc)} IS NOT NULL`
                ).join(' AND '));
            }
          } else {
            const existsCond = rel.fromColumns.map((fc, i) =>
              `${q(rel.fromTable)}.${q(fc)} = `
              + `${q(table)}.${q(rel.toColumns[i])}`
            ).join(' AND ');
            let existsWhere = existsCond;
            if (node.filters?.length > 0) {
              const childValidator = (col) =>
                validateCol(schema, rel.fromTable, col);
              const filterConds = buildFilterConditions(
                node.filters, values, childValidator);
              existsWhere += ' AND '
                + filterConds.join(' AND ');
            }
            innerJoinConds.push(
              `EXISTS (SELECT 1 FROM ${q(rel.fromTable)}`
              + ` WHERE ${existsWhere})`);
          }
        }
      }
    }
    colList = expressions.join(', ');
  } else {
    const cols = parsed.select.filter(
      n => typeof n === 'string' || n.type === 'column');
    const names = cols.map(n => typeof n === 'string' ? n : n.name);
    if (names.length === 1 && names[0] === '*') {
      colList = allColumns
        .map(c => q(c)).join(', ');
    } else {
      for (const c of names) columnValidator(c);
      colList = cols.map(n => {
        const name = typeof n === 'string' ? n : n.name;
        const alias = typeof n === 'string' ? undefined : n.alias;
        const cast = typeof n === 'string' ? undefined : n.cast;
        const ref = castExpr(q(name), cast);
        if (alias) return `${ref} AS ${q(alias)}`;
        return ref;
      }).join(', ');
    }
  }

  const conds = buildFilterConditions(
    parsed.filters, values, columnValidator);

  for (const ijc of innerJoinConds) {
    conds.push(ijc);
  }

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

  let sql = `SELECT ${colList} FROM ${q(table)}`;
  sql += whereClause(conds);
  sql += orderClause(parsed.order, columnValidator);
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

  const colList = columns.map((c) => q(c)).join(', ');
  let sql = `INSERT INTO ${q(table)} (${colList}) VALUES ${tuples.join(', ')}`;

  if (parsed.onConflict) {
    const conflictCols = parsed.onConflict
      .split(',')
      .map((c) => {
        const col = c.trim();
        validateCol(schema, table, col);
        return q(col);
      })
      .join(', ');
    const pk = schema.tables[table]?.primaryKey || [];
    const updateCols = columns.filter(
      (c) => !pk.includes(c),
    );
    if (updateCols.length > 0) {
      const sets = updateCols
        .map((c) => `${q(c)} = EXCLUDED.${q(c)}`)
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
    setClauses.push(`${q(col)} = $${values.length}`);
  }

  const columnValidator = (col) =>
    validateCol(schema, table, col);
  const conds = buildFilterConditions(
    parsed.filters, values, columnValidator,
  );
  if (authzConditions?.conditions?.length > 0) {
    const renumbered = renumberConditions(
      authzConditions.conditions, values.length + 1);
    for (const cond of renumbered) {
      conds.push(cond);
    }
    values.push(...authzConditions.values);
  }

  let sql = `UPDATE ${q(table)} SET ${setClauses.join(', ')}`;
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
  const columnValidator = (col) =>
    validateCol(schema, table, col);
  const conds = buildFilterConditions(
    parsed.filters, values, columnValidator,
  );
  if (authzConditions?.conditions?.length > 0) {
    const renumbered = renumberConditions(
      authzConditions.conditions, values.length + 1);
    for (const cond of renumbered) {
      conds.push(cond);
    }
    values.push(...authzConditions.values);
  }

  let sql = `DELETE FROM ${q(table)}`;
  sql += whereClause(conds);
  sql += ' RETURNING *';

  return { text: sql, values };
}

export function buildCount(table, parsed, schema, authzConditions) {
  const values = [];
  const columnValidator = (col) =>
    validateCol(schema, table, col);
  const conds = buildFilterConditions(
    parsed.filters, values, columnValidator,
  );
  if (authzConditions?.conditions?.length > 0) {
    const renumbered = renumberConditions(
      authzConditions.conditions, values.length + 1);
    for (const cond of renumbered) {
      conds.push(cond);
    }
    values.push(...authzConditions.values);
  }

  let sql = `SELECT COUNT(*) FROM ${q(table)}`;
  sql += whereClause(conds);

  return { text: sql, values };
}

export function makeRpcColumnValidator(fnSchema) {
  if (fnSchema.returnColumns) {
    const valid = new Set(
      fnSchema.returnColumns.map(c => c.name));
    return (col) => {
      if (!valid.has(col)) {
        throw new PostgRESTError(400, 'PGRST204',
          `Column '${col}' does not exist `
          + `in function result`);
      }
    };
  }
  return (col) => {
    if (!IDENT.test(col)) {
      throw new PostgRESTError(400, 'PGRST204',
        `'${col}' is not a valid column name`);
    }
  };
}

export function buildRpcCall(fnName, args, fnSchema, parsed) {
  const values = [];

  const argEntries = fnSchema.args
    .filter(a => a.name in args)
    .map(a => {
      values.push(args[a.name]);
      return `${q(a.name)} := $${values.length}`;
    });
  const argList = argEntries.join(', ');

  if (fnSchema.returnType === 'void') {
    return {
      text: `SELECT ${q(fnName)}(${argList})`,
      values,
      resultMode: 'void',
    };
  }

  if (fnSchema.isScalar && !fnSchema.returnsSet) {
    return {
      text: `SELECT ${q(fnName)}(${argList}) AS ${q(fnName)}`,
      values,
      resultMode: 'scalar',
    };
  }

  let selectPart = '*';

  if (parsed && fnSchema.returnsSet) {
    const columnValidator = makeRpcColumnValidator(fnSchema);
    const allColumns = fnSchema.returnColumns?.map(c => c.name);

    const selectNodes = parsed.select
      .filter(s => typeof s === 'string' || s.type === 'column');
    const selectNames = selectNodes
      .map(s => typeof s === 'string' ? s : s.name);

    if (selectNames.length === 1 && selectNames[0] === '*') {
      if (allColumns) {
        selectPart = allColumns.map(c => q(c)).join(', ');
      }
    } else {
      for (const col of selectNames) {
        columnValidator(col);
      }
      selectPart = selectNodes.map(s => {
        const name = typeof s === 'string' ? s : s.name;
        const alias = typeof s === 'string' ? undefined : s.alias;
        const cast = typeof s === 'string' ? undefined : s.cast;
        const ref = castExpr(q(name), cast);
        if (alias) return `${ref} AS ${q(alias)}`;
        return ref;
      }).join(', ');
    }

    let sql = `SELECT ${selectPart} FROM ${q(fnName)}(${argList})`;

    const conds = buildFilterConditions(
      parsed.filters, values, columnValidator);
    sql += whereClause(conds);
    sql += orderClause(parsed.order, columnValidator);
    sql += limitOffsetClause(parsed.limit, parsed.offset, values);

    return { text: sql, values, resultMode: 'set' };
  }

  return {
    text: `SELECT * FROM ${q(fnName)}(${argList})`,
    values,
    resultMode: 'set',
  };
}

export { buildFilterConditions as _buildFilterConditions };
