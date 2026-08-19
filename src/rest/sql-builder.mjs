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

// Operator SQL, from upstream SqlFragment.hs `simpleOperator`,
// `quantOperator` and `ftsOperator`. `neq` is `!=` rather than upstream's
// `<>` (the same operator, spelled differently) and LIKE/ILIKE are
// upper-cased; everything else is byte-for-byte upstream.
const SIMPLE_OP_SQL = {
  neq: '!=',
  cs: '@>',
  cd: '<@',
  ov: '&&',
  sl: '<<',
  sr: '>>',
  nxr: '&<',
  nxl: '&>',
  adj: '-|-',
};

const QUANT_OP_SQL = {
  eq: '=',
  gte: '>=',
  gt: '>',
  lte: '<=',
  lt: '<',
  like: 'LIKE',
  ilike: 'ILIKE',
  match: '~',
  imatch: '~*',
};

const FTS_FN = {
  fts: 'to_tsquery',
  plfts: 'plainto_tsquery',
  phfts: 'phraseto_tsquery',
  wfts: 'websearch_to_tsquery',
};

const IS_KEYWORD = {
  null: 'NULL',
  not_null: 'NOT NULL',
  true: 'TRUE',
  false: 'FALSE',
  unknown: 'UNKNOWN',
};

/**
 * Every operator token this module can turn into SQL.
 *
 * Exists so a test can assert it against the parser's `VALID_OPERATORS`: an
 * operator the query parser accepts but the builder cannot emit is worse than
 * one it rejects, because the filter is parsed, dropped, and the caller gets a
 * 200 with the wrong rows instead of a 400.
 *
 * `in`, `is` and `isdistinct` are listed by hand — they are emitted by the
 * dedicated branches in `filterSql`, not from an operator-to-symbol table.
 */
export function _supportedOperators() {
  return new Set([
    ...Object.keys(SIMPLE_OP_SQL),
    ...Object.keys(QUANT_OP_SQL),
    ...Object.keys(FTS_FN),
    'in', 'is', 'isdistinct',
  ]);
}

function validateCol(schema, table, column) {
  if (!hasColumn(schema, table, column)) {
    throw new PostgRESTError(
      400, 'PGRST204',
      `Column '${column}' does not exist in '${table}'`,
    );
  }
}

// A column validator also carries the declared type of each column, which
// the FTS operators need: a `tsvector` column must not be wrapped in
// `to_tsvector()` a second time (upstream Plan.hs `resolveTypeOrUnknown`
// leaves `cfToTsVector` empty when the base type is already tsvector).
function makeColumnValidator(schema, table) {
  const validator = (col) => validateCol(schema, table, col);
  validator.typeOf = (col) =>
    schema.tables[table]?.columns?.[col]?.type || null;
  return validator;
}

// Upstream `pgBuildArrayLiteral`: every element is quoted, NUL characters
// are dropped, and backslashes and double quotes are escaped.
function pgArrayLiteral(values) {
  const escaped = values.map((v) => {
    const text = String(v)
      .replaceAll('\u0000', '')
      .replaceAll('\\', '\\\\')
      .replaceAll('"', '\\"');
    return `"${text}"`;
  });
  return `{${escaped.join(',')}}`;
}

// Upstream `pgFmtIdent`: NUL characters are dropped and embedded double
// quotes are doubled. An output label derived from a json path is not an
// identifier — `select=data->>!@#$%^&*_e` labels the column `!@#$%^&*_e` —
// so those cannot go through q(), which is deliberately strict.
const NUL = String.fromCharCode(0);

function qLabel(name) {
  const text = String(name)
    .split(NUL).join('')
    .split('"').join('""');
  return `"${text}"`;
}

// Alias position: keep q()'s strictness for plain identifiers (it is the
// defense-in-depth guard) and fall back to the quoting rule for labels that
// legitimately are not identifiers.
function qAlias(name) {
  return IDENT.test(name) ? q(name) : qLabel(name);
}

// A json_build_object key. Real column names are already validated
// identifiers and stay inline; a json-path label is user input, so it is
// bound as a parameter rather than escaped into the statement.
function jsonKeyExpr(label, values) {
  if (IDENT.test(label)) return `'${label}'`;
  values.push(String(label));
  return `$${values.length}::text`;
}

function castExpr(colExpr, cast) {
  return cast ? `CAST(${colExpr} AS ${cast})` : colExpr;
}

const JSON_TYPES = new Set(['json', 'jsonb']);

// Upstream `pgFmtJsonPath`: every key and index is a parameter, never
// interpolated. An index carries an explicit `::int` because an untyped
// parameter would otherwise resolve `->` to its text (object key) overload.
//
// Upstream `pgFmtField` also wraps a non-json column in `to_jsonb()` before
// applying the path (`cfToJson`), which is what makes `?select=col->key`
// work on a composite or array column. json and jsonb are left alone so the
// arrow operators can still use an index (upstream issue #2594); every other
// type is wrapped, "even unknown types" (Plan.hs `resolveTypeOrUnknown`).
function jsonPathExpr(baseExpr, jsonPath, values, colType) {
  if (!jsonPath || jsonPath.length === 0) return baseExpr;
  let expr = JSON_TYPES.has(colType)
    ? baseExpr
    : `to_jsonb(${baseExpr})`;
  for (const seg of jsonPath) {
    if (seg.kind === 'idx') {
      values.push(Number(seg.value));
      expr += `${seg.op}$${values.length}::int`;
    } else {
      values.push(seg.value);
      expr += `${seg.op}$${values.length}`;
    }
  }
  return expr;
}

const AGG_SQL = {
  sum: 'SUM', avg: 'AVG', count: 'COUNT', max: 'MAX', min: 'MIN',
};

// Upstream `pgFmtSelectItem`: the json path is applied to the field, then
// the cast, then the aggregate, then the aggregate's own cast. `count()`
// carries no field, which upstream renders as a whole-row reference; a
// plain `COUNT(*)` counts the same rows.
function selectItemExpr(node, baseExpr, values, typeOf) {
  let expr = jsonPathExpr(
    baseExpr, node.jsonPath, values,
    node.jsonPath ? (typeOf ? typeOf(node.name) : null) : null);
  expr = castExpr(expr, node.cast);
  if (node.agg) {
    const fn = AGG_SQL[node.agg];
    if (!fn) {
      throw new PostgRESTError(400, 'PGRST100',
        `Unknown aggregate function '${node.agg}'`);
    }
    expr = castExpr(`${fn}(${expr})`, node.aggCast);
  }
  return expr;
}

// Upstream does not validate a select field against its schema cache — an
// unknown name is PostgreSQL's error to raise. That is what keeps
// `?select=count` working (AggregateFunctionsSpec "backwards compat"):
// `"entities"."count"` is functional notation for `count("entities")`, so
// PostgreSQL resolves it to the aggregate. The engine validates columns, so
// this one spelling is let through explicitly — qualified, because the
// unqualified `"count"` would not resolve.
function functionalCountExpr(node, schema, table, ref) {
  if (node.name !== 'count' || node.agg || node.jsonPath) return null;
  if (hasColumn(schema, table, 'count')) return null;
  return `${q(ref)}.${q('count')}`;
}

function isAggregated(selectNodes) {
  return selectNodes.some(n => n.type === 'column' && n.agg);
}

// Upstream `groupF`/`pgFmtGroup`: a select with at least one aggregate
// groups by every non-aggregated field. There is no GROUP BY otherwise —
// `?select=id` must not collapse rows.
function groupClause(groupTerms) {
  return groupTerms.length > 0
    ? ` GROUP BY ${groupTerms.join(', ')}`
    : '';
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

// A stored relationship is undirected: it records the foreign key once.
// Embedding is directed — `/projects?select=clients(*)` is many-to-one and
// `/clients?select=projects(*)` is one-to-many off the same key — so the
// stored list is expanded into directed candidates before matching, the
// way PostgREST holds both a relationship and its inverse in the schema
// cache (SchemaCache.hs `addInverseRels`).
//
// Each candidate keeps the engine's `fromTable`/`toTable` convention
// (`from` holds the foreign key) and adds two fields: `inverse`, true when
// the parent is the referenced side, and `cardinality`. A one-to-one key
// is one-to-one read from either end, so `inverse` — not the cardinality —
// is what tells the two directions apart.
function directedCandidates(schema, parentTable) {
  const out = [];
  for (const r of schema.relationships || []) {
    const isSelf = r.fromTable === r.toTable;

    if (r.cardinality === 'many-to-many') {
      // Normalized so `fromTable` is always the parent side; the mirror
      // of an m2m is the same relationship read from the other end.
      if (r.fromTable === parentTable) {
        out.push({ ...r, isSelf, inverse: false });
      }
      if (r.toTable === parentTable && !isSelf) {
        out.push({
          ...r,
          isSelf,
          inverse: false,
          fromTable: r.toTable,
          fromColumns: r.toColumns,
          toTable: r.fromTable,
          toColumns: r.fromColumns,
          junctionFromColumns: r.junctionToColumns,
          junctionToColumns: r.junctionFromColumns,
          junctionFromConstraint: r.junctionToConstraint,
          junctionToConstraint: r.junctionFromConstraint,
        });
      }
      continue;
    }

    const o2o = r.cardinality === 'one-to-one';
    if (r.fromTable === parentTable) {
      out.push({
        ...r, isSelf, inverse: false,
        cardinality: o2o ? 'one-to-one' : 'many-to-one',
      });
    }
    if (r.toTable === parentTable) {
      out.push({
        ...r, isSelf, inverse: true,
        cardinality: o2o ? 'one-to-one' : 'one-to-many',
      });
    }
  }
  return out;
}

// The table on the far side of a directed candidate.
function foreignTableOf(cand) {
  return cand.inverse ? cand.fromTable : cand.toTable;
}

// Origin-side and foreign-side columns of a directed candidate, in the
// order upstream's `relColumns` holds them: (origin, foreign).
function candidateColumns(cand) {
  return cand.inverse
    ? { origin: cand.toColumns, foreign: cand.fromColumns }
    : { origin: cand.fromColumns, foreign: cand.toColumns };
}

const CARDINALITY_RANK = {
  'one-to-many': 0,
  'many-to-one': 1,
  'one-to-one': 2,
  'many-to-many': 3,
};

// Upstream keeps each relationship bucket sorted (SchemaCache.hs
// `getOverrideRelationshipsMap`), and the ambiguity error reports the
// candidates in that order. Ord on Relationship compares the foreign
// table, then the self flag, then the cardinality constructor
// (O2M < M2O < O2O < M2M), then the constraint and columns.
function sortCandidates(cands) {
  const key = (c) => {
    const cols = candidateColumns(c);
    return [
      foreignTableOf(c),
      c.isSelf ? 1 : 0,
      CARDINALITY_RANK[c.cardinality] ?? 9,
      c.cardinality === 'many-to-many'
        ? (c.junctionTable || '')
        : (c.constraint || ''),
      c.cardinality === 'many-to-many'
        ? [c.junctionFromColumns, c.junctionToColumns].join('|')
        : [cols.origin, cols.foreign].join('|'),
    ].join('\u0000');
  };
  return [...cands]
    .map((c, i) => ({ c, i, k: key(c) }))
    .sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : a.i - b.i))
    .map(x => x.c);
}

/**
 * Resolve `/<parentTable>?select=<embedName>!<hint>(...)` to a single
 * directed relationship, following PostgREST's `findRel` (Plan.hs).
 *
 * The target may name the foreign table, a foreign key constraint or a
 * single foreign key column; the last two only when the foreign table is
 * not a view, because a view has no key of its own. A hint may name the
 * constraint, either side's single key column, or the junction table of a
 * many-to-many. A self-relationship is disambiguated by convention: the
 * table name selects the one-to-many, a column name the many-to-one.
 */
function resolveRelationship(schema, parentTable, embedName, hint) {
  const isView = (name) => Boolean(schema.tables?.[name]?.isView);

  const matches = (cand) => {
    const ft = foreignTableOf(cand);
    const cols = candidateColumns(cand);
    const single = cols.origin.length === 1;
    const m2m = cand.cardinality === 'many-to-many';

    if (cand.isSelf) {
      // Upstream does not resolve self many-to-many relationships.
      if (m2m) return false;
      if (!hint) {
        // /family_tree?select=children:family_tree(*)
        if (ft === embedName && cand.inverse) return true;
        // /family_tree?select=parent(*)
        return !cand.inverse
          && single && cols.origin[0] === embedName;
      }
      // /organizations?select=auditees:organizations!auditor(*)
      return ft === embedName
        && cand.inverse
        && cols.foreign.length === 1 && cols.foreign[0] === hint;
    }

    if (!hint) {
      // /projects?select=clients(*)
      if (ft === embedName) return true;
      if (m2m || isView(ft)) return false;
      // /projects?select=projects_client_id_fkey(*)
      if (cand.constraint && cand.constraint === embedName) return true;
      // /projects?select=client_id(*)
      return single && cols.origin[0] === embedName;
    }

    if (ft !== embedName) return false;
    if (m2m) {
      // /users?select=tasks!users_tasks(*)
      return cand.junctionTable === hint;
    }
    // /projects?select=clients!projects_client_id_fkey(*)
    if (cand.constraint && cand.constraint === hint) return true;
    // /projects?select=clients!client_id(*) or clients!id(*)
    return (single && cols.origin[0] === hint)
      || (cols.foreign.length === 1 && cols.foreign[0] === hint);
  };

  const found = sortCandidates(
    directedCandidates(schema, parentTable).filter(matches));

  if (found.length === 1) return found[0];
  if (found.length === 0) {
    throw noRelBetweenError(parentTable, embedName, hint, schema);
  }
  throw ambiguousError(parentTable, embedName, found);
}

function noRelBetweenError(parentTable, embedName, hint, schema) {
  const usingHint = hint ? ` using the hint '${hint}'` : '';
  return new PostgRESTError(400, 'PGRST200',
    `Could not find a relationship between `
    + `'${parentTable}' and '${embedName}' `
    + `in the schema cache`,
    `Searched for a foreign key relationship between `
    + `'${parentTable}' and '${embedName}'${usingHint} in the schema `
    + `'${schema.schema || 'public'}', but no matches were found.`);
}

// Error.hs `compressedRel` / `relHint`.
function ambiguousError(parentTable, embedName, cands) {
  const fmtEls = (els) => `(${els.join(', ')})`;

  const details = cands.map((c) => {
    if (c.cardinality === 'many-to-many') {
      return {
        cardinality: 'many-to-many',
        embedding: `${parentTable} with ${embedName}`,
        relationship: `${c.junctionTable} using `
          + `${c.junctionFromConstraint || c.junctionTable}`
          + `${fmtEls(c.junctionFromColumns)} and `
          + `${c.junctionToConstraint || c.junctionTable}`
          + `${fmtEls(c.junctionToColumns)}`,
      };
    }
    const cols = candidateColumns(c);
    return {
      cardinality: c.cardinality,
      embedding: `${parentTable} with ${embedName}`,
      relationship: `${c.constraint || '(convention)'} using `
        + `${parentTable}${fmtEls(cols.origin)} and `
        + `${embedName}${fmtEls(cols.foreign)}`,
    };
  });

  const hint = `Try changing '${embedName}' to one of the `
    + `following: ${cands.map((c) => {
        const disambiguator = c.cardinality === 'many-to-many'
          ? c.junctionTable
          : (c.constraint || candidateColumns(c).origin[0]);
        return `'${embedName}!${disambiguator}'`;
      }).join(', ')}. Find the desired relationship in the `
    + `'details' key.`;

  return new PostgRESTError(300, 'PGRST201',
    `Could not embed because more than one relationship `
    + `was found for '${parentTable}' and '${embedName}'`,
    details, hint);
}

// A self-relationship embeds a table into itself, so the inner relation
// needs its own name or every column reference in the subquery would bind
// to the inner row and the join condition would collapse to
// `id = parent_id` on a single row. `scope` carries the relation names
// already visible at this point in the tree so a fresh one can be picked.
function pickRef(base, scope) {
  if (!scope.includes(base)) return base;
  for (let n = 1; ; n += 1) {
    const candidate = `${base}_${n}`;
    if (!scope.includes(candidate)) return candidate;
  }
}

// `FROM "t"` or `FROM "t" AS "t_1"` when the name had to be freed up.
function fromClause(table, ref) {
  return ref === table ? q(table) : `${q(table)} AS ${q(ref)}`;
}

// A many-to-many junction may live outside the served schema. It is only
// ever named in a FROM clause, and PostgreSQL still lets the unqualified
// relation name refer to it, so only the FROM has to be qualified.
function junctionFromClause(rel, ref) {
  const table = rel.junctionTable;
  const relation = rel.junctionSchema && rel.junctionSchema !== 'public'
    ? `${q(rel.junctionSchema)}.${q(table)}`
    : q(table);
  return ref === table ? relation : `${relation} AS ${q(ref)}`;
}

function buildEmbedSubquery(
    node, rel, parentTable, schema, values, authzFilters,
    parentRef = parentTable, scope = [parentRef]
) {
  if (rel.cardinality === 'many-to-many') {
    return buildManyToManySubquery(
      node, rel, parentTable, schema, values, authzFilters,
      parentRef, scope);
  }
  if (rel.inverse) {
    // The foreign key sits on the child row. A one-to-one key means at
    // most one such row, so it is returned as an object, not an array
    // (PostgREST returns `null` when there is none).
    return buildOneToManySubquery(
      node, rel, parentTable, schema, values, authzFilters,
      parentRef, scope, rel.cardinality === 'one-to-one');
  }
  return buildManyToOneSubquery(
    node, rel, parentTable, schema, values, authzFilters,
    parentRef, scope);
}

function buildManyToOneSubquery(
    node, rel, parentTable, schema, values, authzFilters,
    parentRef = parentTable, scope = [parentRef]
) {
  const childTable = rel.toTable;
  const childRef = pickRef(childTable, scope);
  const { pairs: childCols, groupTerms } = buildJsonBuildObject(
    node.select, childTable, schema, values, authzFilters,
    childRef, [...scope, childRef]);
  const joinCond = rel.fromColumns.map((fc, i) =>
    `${q(childRef)}.${q(rel.toColumns[i])} = `
    + `${q(parentRef)}.${q(fc)}`
  ).join(' AND ');

  let where = joinCond;

  if (node.filters?.length > 0) {
    const childValidator = makeColumnValidator(schema, childTable);
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
    + ` FROM ${fromClause(childTable, childRef)} WHERE ${where}`
    + `${groupClause(groupTerms)})`;
}

function buildOneToManySubquery(
    node, rel, parentTable, schema, values, authzFilters,
    parentRef = parentTable, scope = [parentRef], single = false
) {
  const childTable = rel.fromTable;
  const childRef = pickRef(childTable, scope);
  const { pairs: childCols, groupTerms } = buildJsonBuildObject(
    node.select, childTable, schema, values, authzFilters,
    childRef, [...scope, childRef]);
  const joinCond = rel.fromColumns.map((fc, i) =>
    `${q(childRef)}.${q(fc)} = `
    + `${q(parentRef)}.${q(rel.toColumns[i])}`
  ).join(' AND ');

  let where = joinCond;

  if (node.filters?.length > 0) {
    const childValidator = makeColumnValidator(schema, childTable);
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

  if (single) {
    return `(SELECT json_build_object(${childCols})`
      + ` FROM ${fromClause(childTable, childRef)} WHERE ${where}`
      + `${groupClause(groupTerms)})`;
  }

  // An aggregate inside the embed cannot sit under `json_agg` — that would
  // nest one aggregate in another — so the grouped rows are built first and
  // aggregated into the array from a derived table.
  if (isAggregated(node.select)) {
    return `COALESCE((SELECT json_agg(${q('pgrst_agg')})`
      + ` FROM (SELECT json_build_object(${childCols})`
      + ` AS ${q('pgrst_agg')} FROM ${fromClause(childTable, childRef)}`
      + ` WHERE ${where}${groupClause(groupTerms)})`
      + ` AS ${q('pgrst_grouped')}), '[]'::json)`;
  }

  return `COALESCE((SELECT json_agg(json_build_object(`
    + `${childCols})) FROM ${fromClause(childTable, childRef)}`
    + ` WHERE ${where}), '[]'::json)`;
}

// Many-to-many: parent and child are joined through a junction table
// whose primary key covers both foreign keys. The junction is reached
// with EXISTS rather than a JOIN so the child stays the only relation in
// the subquery's FROM — that keeps the unqualified column references
// produced by filters unambiguous.
function buildManyToManySubquery(
    node, rel, parentTable, schema, values, authzFilters,
    parentRef = parentTable, scope = [parentRef]
) {
  // resolveRelationship normalizes an m2m so the parent is the `from`
  // side, whichever end the request came in on.
  const parentCols = rel.fromColumns;
  const junctionParentCols = rel.junctionFromColumns;
  const childTable = rel.toTable;
  const childCols = rel.toColumns;
  const junctionChildCols = rel.junctionToColumns;
  const junction = rel.junctionTable;

  const childRef = pickRef(childTable, scope);
  const childScope = [...scope, childRef];
  const junctionRef = pickRef(junction, childScope);

  const { pairs: childJson, groupTerms } = buildJsonBuildObject(
    node.select, childTable, schema, values, authzFilters,
    childRef, childScope);

  const linkConds = [
    ...junctionChildCols.map((jc, i) =>
      `${q(junctionRef)}.${q(jc)} = ${q(childRef)}.${q(childCols[i])}`),
    ...junctionParentCols.map((jc, i) =>
      `${q(junctionRef)}.${q(jc)} = ${q(parentRef)}.${q(parentCols[i])}`),
  ].join(' AND ');

  let where = `EXISTS (SELECT 1 FROM `
    + `${junctionFromClause(rel, junctionRef)}`
    + ` WHERE ${linkConds})`;

  if (node.filters?.length > 0) {
    const childValidator = makeColumnValidator(schema, childTable);
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

  if (isAggregated(node.select)) {
    return `COALESCE((SELECT json_agg(${q('pgrst_agg')})`
      + ` FROM (SELECT json_build_object(${childJson})`
      + ` AS ${q('pgrst_agg')} FROM ${fromClause(childTable, childRef)}`
      + ` WHERE ${where}${groupClause(groupTerms)})`
      + ` AS ${q('pgrst_grouped')}), '[]'::json)`;
  }

  return `COALESCE((SELECT json_agg(json_build_object(`
    + `${childJson})) FROM ${fromClause(childTable, childRef)}`
    + ` WHERE ${where}), '[]'::json)`;
}

// `!inner` on an embed turns it into a filter on the parent row: the
// parent only comes back when a matching child exists.
function buildInnerJoinCondition(
    node, rel, table, schema, values, scope = [table]
) {
  if (rel.cardinality === 'many-to-many') {
    const parentCols = rel.fromColumns;
    const junctionParentCols = rel.junctionFromColumns;
    const childTable = rel.toTable;
    const childCols = rel.toColumns;
    const junctionChildCols = rel.junctionToColumns;
    const junction = rel.junctionTable;

    const childRef = pickRef(childTable, scope);
    const junctionRef = pickRef(junction, [...scope, childRef]);

    const linkConds = [
      ...junctionChildCols.map((jc, i) =>
        `${q(junctionRef)}.${q(jc)} = `
        + `${q(childRef)}.${q(childCols[i])}`),
      ...junctionParentCols.map((jc, i) =>
        `${q(junctionRef)}.${q(jc)} = ${q(table)}.${q(parentCols[i])}`),
    ].join(' AND ');

    let where = `EXISTS (SELECT 1 FROM `
      + `${junctionFromClause(rel, junctionRef)}`
      + ` WHERE ${linkConds})`;
    if (node.filters?.length > 0) {
      const childValidator = makeColumnValidator(schema, childTable);
      where += ' AND ' + buildFilterConditions(
        node.filters, values, childValidator).join(' AND ');
    }
    return `EXISTS (SELECT 1 FROM `
      + `${fromClause(childTable, childRef)} WHERE ${where})`;
  }

  if (!rel.inverse) {
    // many-to-one (or the key side of a one-to-one): the FK is on the
    // parent row.
    if (node.filters?.length > 0) {
      const childTable = rel.toTable;
      const childRef = pickRef(childTable, scope);
      const existsCond = rel.fromColumns.map((fc, i) =>
        `${q(childRef)}.${q(rel.toColumns[i])} = `
        + `${q(table)}.${q(fc)}`
      ).join(' AND ');
      const childValidator = makeColumnValidator(schema, childTable);
      const filterConds = buildFilterConditions(
        node.filters, values, childValidator);
      return `EXISTS (SELECT 1 FROM `
        + `${fromClause(childTable, childRef)}`
        + ` WHERE ${existsCond}`
        + ` AND ${filterConds.join(' AND ')})`;
    }
    return rel.fromColumns.map(fc =>
      `${q(table)}.${q(fc)} IS NOT NULL`
    ).join(' AND ');
  }

  // one-to-many (or the referenced side of a one-to-one): the FK is on
  // the child row.
  const childTable = rel.fromTable;
  const childRef = pickRef(childTable, scope);
  const existsCond = rel.fromColumns.map((fc, i) =>
    `${q(childRef)}.${q(fc)} = `
    + `${q(table)}.${q(rel.toColumns[i])}`
  ).join(' AND ');
  let existsWhere = existsCond;
  if (node.filters?.length > 0) {
    const childValidator = makeColumnValidator(schema, childTable);
    const filterConds = buildFilterConditions(
      node.filters, values, childValidator);
    existsWhere += ' AND ' + filterConds.join(' AND ');
  }
  return `EXISTS (SELECT 1 FROM `
    + `${fromClause(childTable, childRef)}`
    + ` WHERE ${existsWhere})`;
}

function buildJsonBuildObject(
    selectNodes, table, schema, values, authzFilters,
    ref = table, scope = [ref]
) {
  const pairs = [];
  const groupTerms = [];
  const aggregated = isAggregated(selectNodes);
  const typeOf = (col) =>
    schema.tables[table]?.columns?.[col]?.type || null;

  for (const node of selectNodes) {
    if (node.type === 'column') {
      if (node.name === '*' && !node.agg) {
        for (const c of Object.keys(
            schema.tables[table].columns)) {
          pairs.push(`'${c}', ${q(ref)}.${q(c)}`);
          if (aggregated) groupTerms.push(`${q(ref)}.${q(c)}`);
        }
      } else {
        const fnCount = functionalCountExpr(node, schema, table, ref);
        const base = node.name === '*'
          ? '*'
          : (fnCount || `${q(ref)}.${q(node.name)}`);
        if (node.name !== '*' && !fnCount) {
          validateCol(schema, table, node.name);
        }
        const jsonKey = node.alias || node.name;
        const colRef = selectItemExpr(node, base, values, typeOf);
        pairs.push(`${jsonKeyExpr(jsonKey, values)}, ${colRef}`);
        if (aggregated && !node.agg) groupTerms.push(colRef);
      }
    } else if (node.type === 'embed') {
      const rel = resolveRelationship(
        schema, table, node.name, node.hint);
      const alias = node.alias || node.name;
      const subquery = buildEmbedSubquery(
        node, rel, table, schema, values, authzFilters,
        ref, scope);
      pairs.push(`'${alias}', ${subquery}`);
    }
  }
  return { pairs: pairs.join(', '), groupTerms };
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

// Text search configuration used when a filter names none. Unset by
// default, which makes `fts` emit `to_tsvector(col) @@ to_tsquery($1)` —
// byte-identical to upstream, and resolved by the server's
// `default_text_search_config`. Aurora DSQL ships only the `simple`
// config while reporting `pg_catalog.english` as the default, so a DSQL
// deployment has to set this to `simple` to search at all.
function defaultTsConfig() {
  const cfg = process.env.PGREST_DEFAULT_TS_CONFIG;
  return cfg ? cfg : null;
}

// Upstream `pgFmtField`: an FTS filter searches `to_tsvector(<cfg,> col)`
// unless the column already holds a tsvector.
function ftsFieldExpr(f, values, columnValidator, lang, base) {
  const colType = columnValidator.typeOf?.(f.column) || null;
  if (colType === 'tsvector') return base;
  if (lang === null) return `to_tsvector(${base})`;
  values.push(lang);
  return `to_tsvector($${values.length}, ${base})`;
}

// `?data->foo->>bar=eq.baz` filters on the json path, not on a column
// named `data->foo->>bar` (upstream `pTreePath` parses the path out of the
// parameter name).
function filterFieldExpr(f, values, columnValidator) {
  if (!f.jsonPath || f.jsonPath.length === 0) return q(f.column);
  const colType = columnValidator.typeOf?.(f.column) || null;
  return jsonPathExpr(q(f.column), f.jsonPath, values, colType);
}

function buildSingleCondition(f, values, columnValidator) {
  columnValidator(f.column);
  const not = f.negate ? 'NOT ' : '';
  const field = filterFieldExpr(f, values, columnValidator);

  // Upstream emits negation as a prefix — `NOT <field> <op> <value>` —
  // rather than flipping the operator, so it works for every operator
  // including the ones that have no inverse.
  if (f.operator === 'is') {
    const keyword = IS_KEYWORD[String(f.value).toLowerCase()];
    if (!keyword) {
      throw new PostgRESTError(
        400, 'PGRST100',
        'IS operator only supports null, not_null, true, false, unknown'
        + ` (got '${f.value}')`,
      );
    }
    return `${not}${field} IS ${keyword}`;
  }

  if (f.operator === 'isdistinct') {
    values.push(f.value);
    return `${not}${field} IS DISTINCT FROM $${values.length}`;
  }

  if (f.operator === 'in') {
    // Upstream passes the whole list as one array literal and uses
    // `= ANY(...)`, so `in.()` — a single empty element — is an empty
    // array rather than a syntax error.
    if (f.value.length === 1 && f.value[0] === '') {
      return `${not}${field} = ANY('{}')`;
    }
    values.push(pgArrayLiteral(f.value));
    return `${not}${field} = ANY($${values.length})`;
  }

  if (FTS_FN[f.operator]) {
    const lang = f.ftsLang || defaultTsConfig();
    const ftsField = ftsFieldExpr(
      f, values, columnValidator, lang, field);
    const args = [];
    if (lang !== null) {
      values.push(lang);
      args.push(`$${values.length}`);
    }
    values.push(f.value);
    args.push(`$${values.length}`);
    return `${not}${ftsField} @@ ${FTS_FN[f.operator]}(${args.join(', ')})`;
  }

  const simple = SIMPLE_OP_SQL[f.operator];
  if (simple) {
    values.push(f.value);
    return `${not}${field} ${simple} $${values.length}`;
  }

  const quant = QUANT_OP_SQL[f.operator];
  if (!quant) {
    throw new PostgRESTError(
      400, 'PGRST100',
      `Unknown operator '${f.operator}'`,
    );
  }
  values.push(f.value);
  let operand = `$${values.length}`;
  if (f.quantifier === 'any') operand = `ANY(${operand})`;
  else if (f.quantifier === 'all') operand = `ALL(${operand})`;
  return `${not}${field} ${quant} ${operand}`;
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

function orderClause(order, columnValidator, values) {
  if (!order || order.length === 0) return '';
  const parts = order.map((o) => {
    columnValidator(o.column);
    const field = o.jsonPath?.length > 0
      ? jsonPathExpr(
        q(o.column), o.jsonPath, values,
        columnValidator.typeOf?.(o.column) || null)
      : q(o.column);
    let sql = `${field} ${o.direction.toUpperCase()}`;
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
  const columnValidator = makeColumnValidator(schema, table);
  const allColumns = Object.keys(schema.tables[table].columns);
  const hasEmbeds = parsed.select.some(
    n => n.type === 'embed');

  let colList;
  const innerJoinConds = [];
  const aggregated = isAggregated(parsed.select);
  const groupTerms = [];

  if (hasEmbeds) {
    const expressions = [];
    for (const node of parsed.select) {
      if (node.type === 'column') {
        if (node.name === '*' && !node.agg) {
          for (const c of allColumns) {
            expressions.push(`${q(table)}.${q(c)}`);
            if (aggregated) groupTerms.push(`${q(table)}.${q(c)}`);
          }
        } else {
          const fnCount = functionalCountExpr(node, schema, table, table);
          const base = node.name === '*'
            ? '*'
            : (fnCount || `${q(table)}.${q(node.name)}`);
          if (node.name !== '*' && !fnCount) {
            validateCol(schema, table, node.name);
          }
          const ref = selectItemExpr(
            node, base, values, columnValidator.typeOf);
          const alias = node.alias
            || (node.cast && node.name !== '*' ? node.name : null);
          if (alias) {
            expressions.push(`${ref} AS ${qAlias(alias)}`);
          } else {
            expressions.push(ref);
          }
          if (aggregated && !node.agg) groupTerms.push(ref);
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
          innerJoinConds.push(buildInnerJoinCondition(
            node, rel, table, schema, values));
        }
      }
    }
    colList = expressions.join(', ');
  } else {
    const cols = parsed.select.filter(
      n => typeof n === 'string' || n.type === 'column');
    const names = cols.map(n => typeof n === 'string' ? n : n.name);
    const plainStar = names.length === 1 && names[0] === '*'
      && !(typeof cols[0] === 'object' && cols[0].agg);
    if (plainStar) {
      colList = allColumns
        .map(c => q(c)).join(', ');
    } else {
      const expressions = [];
      for (const n of cols) {
        const node = typeof n === 'string' ? { name: n } : n;
        if (node.name === '*' && !node.agg) {
          for (const c of allColumns) {
            expressions.push(q(c));
            if (aggregated) groupTerms.push(q(c));
          }
          continue;
        }
        const fnCount = functionalCountExpr(node, schema, table, table);
        if (node.name !== '*' && !fnCount) columnValidator(node.name);
        const base = node.name === '*'
          ? '*'
          : (fnCount || q(node.name));
        const ref = selectItemExpr(
          node, base, values, columnValidator.typeOf);
        if (node.alias) {
          expressions.push(`${ref} AS ${qAlias(node.alias)}`);
        } else {
          expressions.push(ref);
        }
        if (aggregated && !node.agg) groupTerms.push(ref);
      }
      colList = expressions.join(', ');
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
  sql += groupClause(groupTerms);
  sql += orderClause(parsed.order, columnValidator, values);
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

  const columnValidator = makeColumnValidator(schema, table);
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
  const columnValidator = makeColumnValidator(schema, table);
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
  const columnValidator = makeColumnValidator(schema, table);
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
  const typeOf = (col) =>
    fnSchema.returnColumns?.find(c => c.name === col)?.type || null;
  let validator;
  if (fnSchema.returnColumns) {
    const valid = new Set(
      fnSchema.returnColumns.map(c => c.name));
    validator = (col) => {
      if (!valid.has(col)) {
        throw new PostgRESTError(400, 'PGRST204',
          `Column '${col}' does not exist `
          + `in function result`);
      }
    };
  } else {
    validator = (col) => {
      if (!IDENT.test(col)) {
        throw new PostgRESTError(400, 'PGRST204',
          `'${col}' is not a valid column name`);
      }
    };
  }
  validator.typeOf = typeOf;
  return validator;
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

    const aggregated = isAggregated(parsed.select);
    const groupTerms = [];
    const plainStar = selectNames.length === 1 && selectNames[0] === '*'
      && !(typeof selectNodes[0] === 'object' && selectNodes[0].agg);

    if (plainStar) {
      if (allColumns) {
        selectPart = allColumns.map(c => q(c)).join(', ');
      }
    } else {
      const expressions = [];
      for (const s of selectNodes) {
        const node = typeof s === 'string' ? { name: s } : s;
        if (node.name === '*' && !node.agg) {
          if (allColumns) {
            for (const c of allColumns) {
              expressions.push(q(c));
              if (aggregated) groupTerms.push(q(c));
            }
          } else {
            expressions.push('*');
          }
          continue;
        }
        if (node.name !== '*') columnValidator(node.name);
        const base = node.name === '*' ? '*' : q(node.name);
        const ref = selectItemExpr(
          node, base, values, columnValidator.typeOf);
        if (node.alias) {
          expressions.push(`${ref} AS ${qAlias(node.alias)}`);
        } else {
          expressions.push(ref);
        }
        if (aggregated && !node.agg) groupTerms.push(ref);
      }
      selectPart = expressions.join(', ');
    }

    let sql = `SELECT ${selectPart} FROM ${q(fnName)}(${argList})`;

    const conds = buildFilterConditions(
      parsed.filters, values, columnValidator);
    sql += whereClause(conds);
    sql += groupClause(groupTerms);
    sql += orderClause(parsed.order, columnValidator, values);
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
