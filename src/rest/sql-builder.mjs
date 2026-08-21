// sql-builder.mjs — Convert parsed queries to parameterized SQL

import { PostgRESTError } from './errors.mjs';
import { hasColumn } from './schema-cache.mjs';

// Identifiers that are ASCII-simple. Used to decide *formatting* (a bare word
// can be emitted unquoted as a JSON key, an alias label, or an ORDER BY term),
// never to decide safety — see q().
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Quote an identifier, upstream's `escapeIdent`
 * (SchemaCache/Identifiers.hs:56-59): truncate at the first NUL, double every
 * internal quote, wrap in quotes.
 *
 * This is the whole defence, and it is complete: a double-quoted PostgreSQL
 * identifier ends at the first unescaped `"`, so doubling every quote makes it
 * impossible for any input to terminate the identifier early — there is no
 * remaining character with syntactic power inside the quotes. That matters
 * because relation, column and function names are arbitrary identifiers
 * upstream: a table can be called `Escap3e;` or `تست`, and rejecting those on
 * an ASCII character class turned a legal request into an error
 * (QuerySpec:1277, EmbedDisambiguationSpec:278, UnicodeSpec) without adding
 * safety that the quoting does not already give.
 *
 * Every name that reaches here has additionally been matched against the
 * schema cache by the router / column validators, so in practice it came out
 * of pg_class in the first place.
 */
function q(name) {
  if (typeof name !== 'string' || name === '') {
    throw new PostgRESTError(
      400, 'PGRST204',
      `'${name}' is not a valid identifier`,
    );
  }
  const nul = name.indexOf('\u0000');
  const trimmed = nul === -1 ? name : name.slice(0, nul);
  return `"${trimmed.replaceAll('"', '""')}"`;
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

// Upstream's `ColumnNotFound` (Error.hs): PGRST204, 400, and this exact
// sentence — five upstream cases assert it verbatim for `?columns=` naming a
// column the schema cache does not have (InsertSpec.hs:466,845,901,
// UpdateSpec.hs:348,724).
function columnNotFound(table, column) {
  return new PostgRESTError(
    400, 'PGRST204',
    `Could not find the '${column}' column of '${table}' in the schema cache`,
  );
}

function validateCol(schema, table, column) {
  if (!hasColumn(schema, table, column)) {
    throw columnNotFound(table, column);
  }
}

// A column validator also carries the declared type of each column, which
// the FTS operators need: a `tsvector` column must not be wrapped in
// `to_tsvector()` a second time (upstream Plan.hs `resolveTypeOrUnknown`
// leaves `cfToTsVector` empty when the base type is already tsvector).
//
// `resolve` is how a filter renders the field: the plain column name when the
// schema cache has it, the qualified form when it does not, so a filter on a
// computed column works (see computedFieldExpr). `ref` is the relation's name
// in the enclosing FROM and defaults to the table.
function makeColumnValidator(schema, table, ref = table) {
  const validator = (col) => validateCol(schema, table, col);
  validator.typeOf = (col) =>
    schema.tables[table]?.columns?.[col]?.type || null;
  validator.resolve = (col) =>
    computedFieldExpr(schema, table, col, ref) || q(col);
  // A filter value arrives as query-string text, so the `text -> <type>` data
  // representation is what parses it (Plan.hs `withTextParse`). The parser is
  // applied to the *value*, never to the column.
  validator.textParserOf = (col) =>
    representationFn(schema, 'text', validator.typeOf(col));
  return validator;
}

/**
 * A payload value as PostgreSQL has to receive it for one column.
 *
 * Upstream never faces this: its INSERT reads the request body with
 * `json_to_recordset`, so a nested array or object arrives at a `json` column
 * as JSON text. Here the value is a bind parameter, and the driver renders a
 * JS array as an array literal (`{1,2,3}`), which `json` rejects with 22P02
 * (`invalid input syntax for type json`). Sending its JSON text instead is
 * what upstream's statement does — for every JSON value, so a bare string or
 * number lands as the JSON scalar it was in the body rather than as raw text.
 */
function paramValue(value, type) {
  if (value === null || value === undefined) return value;
  if (type !== 'json' && type !== 'jsonb') return value;
  return JSON.stringify(value);
}

/**
 * One payload value as a bind placeholder, with the `json -> <type>` data
 * representation applied when the column has one (Plan.hs `withJsonParse`).
 *
 * Upstream reads the body with `json_to_recordset`, so the parser receives the
 * value as JSON; here the value is a bind parameter, which is why it is sent as
 * JSON text and cast back to `json` for the call. A JSON `null` is left alone:
 * upstream's recordset yields SQL NULL for it, which never reaches a parser.
 */
function payloadOperand(schema, table, col, value, values) {
  const type = schema?.tables?.[table]?.columns?.[col]?.type;
  const parser = value === null || value === undefined
    ? null
    : representationFn(schema, 'json', type);
  if (parser) {
    values.push(JSON.stringify(value));
    return `${parser}($${values.length}::json)`;
  }
  values.push(paramValue(value, type));
  return `$${values.length}`;
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

// --- Data representations ---
//
// A representation is a cast function registered between a domain and
// json/text (schema-cache.mjs `DATA_REPRESENTATIONS_SQL`). Upstream applies it
// by calling that function, never by writing a CAST: `pgFmtCallUnary
// formatterProc (pgFmtField table fld)`. Which direction is used depends on
// where the value is going (Plan.hs `withOutputFormat`, `withTextParse`,
// `withJsonParse`):
//
//   response column  <type> -> json
//   filter value     text   -> <type>
//   payload value    json   -> <type>
//
// The map is empty unless the database has such casts or a manifest declares
// them, and an empty map makes every helper here return the expression
// unchanged.

// The output format of a read. Upstream keys this on the response media type;
// json is the only one the engine renders a select list for.
const OUTPUT_TYPE = 'json';

function representationFn(schema, sourceType, targetType) {
  if (!sourceType || !targetType) return null;
  const reps = schema?.representations;
  if (!reps) return null;
  return reps[`${sourceType}|${targetType}`]?.function || null;
}

function applyTransform(expr, fn) {
  return fn ? `${fn}(${expr})` : expr;
}

// The transform that renders a column of this table in a response, or null.
function outputTransformOf(schema, table, column) {
  const type = schema?.tables?.[table]?.columns?.[column]?.type;
  return representationFn(schema, type, OUTPUT_TYPE);
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

// Upstream `pgFmtSelectItem`: the json path is applied to the field, then the
// data representation, then the cast, then the aggregate, then the aggregate's
// own cast. `count()` carries no field, which upstream renders as a whole-row
// reference; a plain `COUNT(*)` counts the same rows.
function selectItemExpr(node, baseExpr, values, typeOf, transform = null) {
  let expr = jsonPathExpr(
    baseExpr, node.jsonPath, values,
    node.jsonPath ? (typeOf ? typeOf(node.name) : null) : null);
  expr = applyTransform(expr, transform);
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

/**
 * A read field the schema cache does not know as a column, qualified.
 *
 * Upstream never validates a select/filter/order field against its schema
 * cache: every one of them is rendered through `pgFmtField`, which qualifies
 * it with the relation (`pgFmtColumn` -> `"items"."always_true"`), and an
 * unresolvable name is PostgreSQL's error to raise, not PGRST204 —
 * QuerySpec.hs:1557 expects `column datarep_todos.banana does not exist`, a
 * message only the qualified form produces.
 *
 * That one spelling is what makes a *computed column* work: `always_true` is a
 * function of the row (`CREATE FUNCTION always_true(items)`), and
 * `"items"."always_true"` is PostgreSQL's functional notation for
 * `always_true("items")`. The same rule covers `?select=count` over a table
 * with no `count` column (AggregateFunctionsSpec "backwards compat"), where
 * the qualified name resolves to the aggregate.
 *
 * Known columns keep their unqualified spelling so the projection a mutation
 * shares with a plain read is unchanged.
 *
 * PGRST204 stays what upstream uses it for: `?columns=`, `?on_conflict=` and
 * mutation payload keys, which upstream *does* check against the cache.
 */
function computedFieldExpr(schema, table, name, ref) {
  if (name === '*' || hasColumn(schema, table, name)) return null;
  return `${q(ref)}.${q(name)}`;
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

    // A computed relationship is a function of the parent row, so it is
    // directed by construction: `computed_designers(videogames)` embeds
    // designers into videogames and there is no reading of it the other way
    // round (upstream `ComputedRelationship`).
    if (r.computed) {
      if (r.fromTable === parentTable) {
        out.push({ ...r, isSelf, inverse: false });
      }
      continue;
    }

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
    // A computed relationship is named by its function, never by the table
    // it returns, and takes no hint.
    if (cand.computed) return cand.function === embedName;

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

  const candidates = directedCandidates(schema, parentTable).filter(matches);
  // A computed relationship shadows a key-based one that answers to the same
  // name: upstream unions the computed map over the detected one and lets the
  // computed entries prevail (SchemaCache.hs `getOverrideRelationshipsMap`).
  const computed = candidates.filter(c => c.computed);
  const found = sortCandidates(
    computed.length > 0 ? computed : candidates);

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

// --- Embedding: relation bodies -------------------------------------------
//
// Upstream builds one SELECT per node of the read plan and stitches the
// children in with LEFT JOIN LATERAL (QueryBuilder.hs `getJoin`). This engine
// keeps a to-one/to-many embed as a correlated subquery in the select list —
// the shape `json_build_object` wants anyway — and only reaches for a LATERAL
// where the correlated form cannot work: a spread embed, whose members must
// all be aggregated in the *same* pass over the child rows, or element N of
// one array would not line up with element N of the next.

// Aliases the builder invents. `pgrst_` is upstream's own reserved prefix for
// generated aliases, so it cannot collide with a fixture column.
function newBuildEnv() {
  return { lateralSeq: 0 };
}

function nextLateralRef(env) {
  env.lateralSeq += 1;
  return `pgrst_spread_${env.lateralSeq}`;
}

// The table on the far side of a resolved embed.
function embedTargetTable(rel) {
  if (rel.computed) return rel.toTable;
  if (rel.cardinality === 'many-to-many') return rel.toTable;
  return rel.inverse ? rel.fromTable : rel.toTable;
}

// At most one child row: the embed is a json object, not an array
// (upstream `relIsToOne`). A one-to-one key is to-one read from either end,
// which is why the cardinality and not `inverse` decides it there.
function embedIsToOne(rel) {
  if (rel.computed) return Boolean(rel.toOne);
  if (rel.cardinality === 'many-to-many') return false;
  if (rel.cardinality === 'one-to-one') return true;
  return !rel.inverse;
}

// An embed with an empty select list contributes no key to the response, and
// neither does one whose whole subtree is empty (upstream `rsEmptyEmbed`). It
// exists only so `?<embed>=is.null` and `!inner` have something to filter on.
function isEmptyEmbed(node) {
  return node.select.every(
    n => n.type === 'embed' && isEmptyEmbed(n));
}

/**
 * The child relation of an embed: what the subquery reads from and the
 * conditions that correlate it with the parent row.
 *
 * A computed relationship needs no correlation condition — the parent row is
 * the function's argument (upstream `fromF`, which casts the alias back to
 * the table type so an overloaded function still resolves).
 */
function embedChild(rel, parentRef, scope) {
  const childTable = embedTargetTable(rel);
  const childRef = pickRef(childTable, scope);
  const childScope = [...scope, childRef];
  const conds = [];
  let from;

  if (rel.computed) {
    from = `${q(rel.function)}(${q(parentRef)}::${q(rel.fromTable)})`
      + ` AS ${q(childRef)}`;
  } else if (rel.cardinality === 'many-to-many') {
    const junctionRef = pickRef(rel.junctionTable, childScope);
    childScope.push(junctionRef);
    from = fromClause(childTable, childRef);
    const linkConds = [
      ...rel.junctionToColumns.map((jc, i) =>
        `${q(junctionRef)}.${q(jc)} = `
        + `${q(childRef)}.${q(rel.toColumns[i])}`),
      ...rel.junctionFromColumns.map((jc, i) =>
        `${q(junctionRef)}.${q(jc)} = `
        + `${q(parentRef)}.${q(rel.fromColumns[i])}`),
    ].join(' AND ');
    conds.push(`EXISTS (SELECT 1 FROM `
      + `${junctionFromClause(rel, junctionRef)} WHERE ${linkConds})`);
  } else if (rel.inverse) {
    // The foreign key sits on the child row.
    from = fromClause(childTable, childRef);
    conds.push(rel.fromColumns.map((fc, i) =>
      `${q(childRef)}.${q(fc)} = `
      + `${q(parentRef)}.${q(rel.toColumns[i])}`
    ).join(' AND '));
  } else {
    // The foreign key sits on the parent row.
    from = fromClause(childTable, childRef);
    conds.push(rel.fromColumns.map((fc, i) =>
      `${q(childRef)}.${q(rel.toColumns[i])} = `
      + `${q(parentRef)}.${q(fc)}`
    ).join(' AND '));
  }

  return { childTable, childRef, childScope, from, conds };
}

// The embed's own `?<embed>.<col>=` filters plus whatever the authorization
// layer contributes for the child table.
function addNodeFilters(
    conds, node, child, schema, values, env, authzFilters) {
  if (node.filters?.length > 0) {
    const childValidator = makeColumnValidator(
      schema, child.childTable, child.childRef);
    conds.push(...buildFilterConditions(
      node.filters, values, childValidator,
      filterCtx(schema, child.childTable, child.childRef,
        child.childScope, env, authzFilters)));
  }
  const childAuthz = authzFilters?.[child.childTable];
  if (childAuthz?.conditions?.length > 0) {
    conds.push(...renumberConditions(
      childAuthz.conditions, values.length + 1));
    values.push(...childAuthz.values);
  }
}

// Context a filter list needs when one of its leaves is an embed-existence
// test rather than a column comparison.
function filterCtx(schema, table, ref, scope, env, authzFilters) {
  return { schema, table, ref, scope, env, authzFilters };
}

/**
 * "A matching child row exists."
 *
 * `!inner` and `?<embed>=not.is.null` are the same question asked twice.
 * Upstream answers the first with an INNER JOIN LATERAL and the second with
 * `<join alias> IS DISTINCT FROM NULL` on a LEFT one; against a correlated
 * subquery both are an EXISTS over the child relation, carrying the embed's
 * own filters and the inner joins below it.
 */
function buildEmbedExists(
    node, rel, parentRef, schema, values, env, authzFilters, scope) {
  const child = embedChild(rel, parentRef, scope);
  const conds = [...child.conds];

  for (const n of node.select) {
    if (n.type === 'embed' && n.inner) {
      const nestedRel = resolveRelationship(
        schema, child.childTable, n.name, n.hint);
      conds.push(buildEmbedExists(
        n, nestedRel, child.childRef, schema, values, env,
        authzFilters, child.childScope));
    }
  }

  addNodeFilters(conds, node, child, schema, values, env, authzFilters);

  return `EXISTS (SELECT 1 FROM ${child.from}`
    + `${whereClause(conds)})`;
}

// Order terms of an embed, as both an ORDER BY clause for the child query and
// the individual expressions a spread's `json_agg(... ORDER BY ...)` needs.
/**
 * `?order=<embed>(<column>)` orders the parent rows by a column of an embedded
 * to-one resource (upstream `pOrderRelationTerm` / `OrderRelationTerm`).
 *
 * Upstream orders by the joined LATERAL's column. The correlated equivalent is
 * the embed's own subquery selecting that one column — with the embed's
 * filters applied, so the ordering agrees with what the embed returns.
 *
 * A spread embed is the exception: it *is* a joined LATERAL here too, so the
 * order term is its output column, exactly as upstream renders it
 * (`pgFmtField (relAggAlias …)`). That is not a shortcut — the correlated form
 * cannot be used at a level that groups, because a subquery correlated on an
 * ungrouped column of the parent is an error (42803), and it is the aggregate
 * cases that order by a spread member. It also means the term names the
 * member's *alias*, which is the only spelling upstream accepts for
 * `?select=...processes(factory:factory_id)&order=processes(factory)`.
 */
function relatedOrderExpr(
    o, schema, table, ref, selectNodes, values, env, authzFilters, scope,
    spreadFields) {
  const node = (selectNodes || []).find(n =>
    n.type === 'embed' && (n.alias || n.name) === o.relation);
  if (!node) {
    throw new PostgRESTError(400, 'PGRST108',
      `'${o.relation}' is not an embedded resource in this request`,
      null,
      `Verify that '${o.relation}' is included in the 'select' `
      + `query parameter.`);
  }
  if (!o.jsonPath?.length) {
    const member = (spreadFields?.get(o.relation) || []).find(
      f => f.key === o.column && !f.hoist);
    if (member) return member.expr;
  }
  const rel = resolveRelationship(schema, table, node.name, node.hint);
  if (!embedIsToOne(rel)) {
    throw new PostgRESTError(400, 'PGRST118',
      `A related order on '${o.relation}' is not possible`,
      `'${table}' and '${o.relation}' do not form a many-to-one or `
      + `one-to-one relationship`);
  }
  const child = embedChild(rel, ref, scope);
  const validator = makeColumnValidator(
    schema, child.childTable, child.childRef);
  const col = `${q(child.childRef)}.${q(o.column)}`;
  const expr = o.jsonPath?.length > 0
    ? jsonPathExpr(col, o.jsonPath, values, validator.typeOf(o.column))
    : col;
  const conds = [...child.conds];
  addNodeFilters(conds, node, child, schema, values, env, authzFilters);
  return `(SELECT ${expr} FROM ${child.from}${whereClause(conds)})`;
}

/**
 * ORDER BY of one relation, as a clause and as the individual expressions a
 * spread's `json_agg(... ORDER BY ...)` needs. `ref` qualifies every column,
 * which upstream always does (`orderF` renders each term through
 * `pgFmtField`): a bare name in ORDER BY binds to an *output* column first, so
 * `?select=factory:name,...processes(name)&order=name` would otherwise sort by
 * the spread json array instead of by `factories.name`.
 */
function relationOrder(
    order, schema, table, ref, selectNodes, values, env, authzFilters, scope,
    spreadFields) {
  if (!order || order.length === 0) return { terms: [], sql: '' };
  const validator = makeColumnValidator(schema, table);
  const terms = order.map((o) => {
    let expr;
    if (o.relation) {
      expr = relatedOrderExpr(
        o, schema, table, ref, selectNodes, values, env, authzFilters, scope,
        spreadFields);
    } else {
      // Qualified, so an `order=` on a computed column resolves the same way
      // a select on one does (see computedFieldExpr).
      const col = `${q(ref)}.${q(o.column)}`;
      expr = o.jsonPath?.length > 0
        ? jsonPathExpr(col, o.jsonPath, values, validator.typeOf(o.column))
        : col;
    }
    return {
      expr,
      dir: o.direction.toUpperCase(),
      nulls: o.nulls
        ? ` NULLS ${o.nulls === 'nullsfirst' ? 'FIRST' : 'LAST'}`
        : '',
    };
  });
  const sql = ` ORDER BY ${terms
    .map(t => `${t.expr} ${t.dir}${t.nulls}`).join(', ')}`;
  return { terms, sql };
}

function jsonPairs(fields, values) {
  return fields
    .map(f => `${jsonKeyExpr(f.key, values)}, ${f.expr}`)
    .join(', ');
}

// The aggregate function of a hoisted aggregate, as SQL.
function aggSqlFn(name) {
  const fn = AGG_SQL[name];
  if (!fn) {
    throw new PostgRESTError(400, 'PGRST100',
      `Unknown aggregate function '${name}'`);
  }
  return fn;
}

/**
 * One aggregate lifted out of a to-one spread embed.
 *
 * The spread selects the aggregate's *input* and the level that receives it
 * applies the function, so `?select=client_id,...project_invoices(
 * invoice_total.sum())` sums across the rows of one `client_id` instead of
 * summing each single joined row (upstream `hoistSpreadAggFunctions`, whose
 * comment calls the un-hoisted form "essentially a no-op").
 *
 * `count()` carries no field of its own: upstream hoists
 * `COUNT("<join alias>".*)`, and a bare relation reference is that whole row —
 * NULL for a parent row the spread matched nothing for, which is what makes
 * `COUNT` skip it.
 */
function hoistedSpreadEntry(node, ref, base, values, typeOf, transform = null) {
  const plain = { ...node, agg: null, aggCast: null };
  return {
    key: node.alias || node.name,
    expr: node.name === '*'
      ? q(ref)
      : selectItemExpr(plain, base, values, typeOf, transform),
    explicitAlias: true,
    group: false,
    hoist: {
      agg: node.agg,
      cast: node.aggCast,
      key: node.alias || node.agg,
    },
  };
}

/**
 * The SELECT-list contribution of one relation.
 *
 * `ref` is the relation's name in the enclosing FROM. Returns the output
 * fields in order, the GROUP BY terms an aggregate select needs, the LATERAL
 * joins spread embeds want appended to the FROM, and the EXISTS conditions
 * `!inner` embeds add to the WHERE.
 *
 * `opts.spreadToOne` says this relation is itself a to-one spread embed, and
 * so is not where an aggregate belongs: its aggregates are handed to the
 * caller through `fields[].hoist` and applied one level up. Upstream repeats
 * that until it reaches the root or a relation that is embedded as json, which
 * is where the GROUP BY has to live for the result to mean anything.
 */
function buildRelationSelect(
    selectNodes, table, ref, schema, values, env, authzFilters, scope,
    opts = {}) {
  const hoistOut = opts.spreadToOne === true;
  const fields = [];
  const laterals = [];
  const innerConds = [];
  const spreadFields = new Map();
  const typeOf = (col) =>
    schema.tables[table]?.columns?.[col]?.type || null;

  for (const node of selectNodes) {
    if (node.type === 'column') {
      if (node.name === '*' && !node.agg) {
        for (const c of Object.keys(schema.tables[table].columns)) {
          // A data representation is a function call, whose output label is
          // the function's name, so a transformed column has to be aliased
          // back (upstream `pgFmtCoerceNamed`).
          const fn = outputTransformOf(schema, table, c);
          fields.push({
            key: c,
            expr: applyTransform(`${q(ref)}.${q(c)}`, fn),
            explicitAlias: Boolean(fn),
            group: true,
          });
        }
        continue;
      }
      // Already qualified with the relation, which is all a computed column
      // needs (see computedFieldExpr): nothing to validate here.
      const base = node.name === '*'
        ? '*'
        : `${q(ref)}.${q(node.name)}`;
      const transform = node.name === '*'
        ? null
        : outputTransformOf(schema, table, node.name);
      if (node.agg && hoistOut) {
        fields.push(hoistedSpreadEntry(
          node, ref, base, values, typeOf, transform));
        continue;
      }
      const expr = selectItemExpr(node, base, values, typeOf, transform);
      fields.push({
        key: node.alias || node.name,
        expr,
        explicitAlias: Boolean(node.alias)
          || Boolean(node.cast && node.name !== '*')
          || Boolean(transform),
        agg: Boolean(node.agg),
        group: !node.agg,
      });
      continue;
    }

    // Resource embed.
    const rel = resolveRelationship(schema, table, node.name, node.hint);
    if (node.inner) {
      innerConds.push(buildEmbedExists(
        node, rel, ref, schema, values, env, authzFilters, scope));
    }
    if (isEmptyEmbed(node)) continue;

    if (node.spread) {
      const spread = buildSpreadLateral(
        node, rel, ref, schema, values, env, authzFilters, scope);
      laterals.push(spread.lateral);
      spreadFields.set(node.alias || node.name, spread.fields);
      for (const f of spread.fields) {
        if (f.hoist && !hoistOut) {
          fields.push({
            key: f.hoist.key,
            expr: castExpr(
              `${aggSqlFn(f.hoist.agg)}(${f.expr})`, f.hoist.cast),
            explicitAlias: true,
            agg: true,
            group: false,
          });
          continue;
        }
        fields.push({
          key: f.key, expr: f.expr, explicitAlias: true,
          hoist: f.hoist, group: !f.hoist, json: f.json,
        });
      }
      continue;
    }

    fields.push({
      key: node.alias || node.name,
      expr: buildEmbedSubquery(
        node, rel, ref, schema, values, env, authzFilters, scope),
      explicitAlias: true,
      group: false,
      json: true,
    });
  }

  // Upstream `groupF`/`pgFmtGroup`: a select with at least one aggregate —
  // its own or one hoisted into it — groups by every non-aggregated field.
  const aggregated = fields.some(f => f.agg);
  if (aggregated) {
    // A json value cannot be a GROUP BY term: `json` has no equality operator
    // (42883). jsonb does, which is why upstream renders every embed as
    // `row_to_json(...)::jsonb` and groups by that — a spread embed carrying a
    // nested embed of its own (`...processes(factories(name),...)`) is grouped
    // by the nested object. The select expression and the group term have to be
    // the same string, so both carry the cast.
    for (const f of fields) {
      if (f.group && f.json) f.expr = `CAST(${f.expr} AS jsonb)`;
    }
  }
  const groupTerms = aggregated
    ? fields.filter(f => f.group).map(f => f.expr)
    : [];

  return { fields, groupTerms, laterals, innerConds, aggregated, spreadFields };
}

/**
 * A to-one or to-many embed, as a correlated subquery yielding one json
 * value: an object for a to-one relationship (`null` when there is no match,
 * which is what a scalar subquery over no rows returns) and an array for a
 * to-many one (`[]` when there is none).
 */
function buildEmbedSubquery(
    node, rel, parentRef, schema, values, env, authzFilters, scope) {
  const child = embedChild(rel, parentRef, scope);
  const inner = buildRelationSelect(
    node.select, child.childTable, child.childRef, schema, values, env,
    authzFilters, child.childScope);

  const conds = [...child.conds, ...inner.innerConds];
  addNodeFilters(conds, node, child, schema, values, env, authzFilters);

  const pairs = jsonPairs(inner.fields, values);
  const from = `${child.from}${inner.laterals.join('')}`;
  const order = relationOrder(
    node.order, schema, child.childTable, child.childRef, node.select,
    values, env, authzFilters, child.childScope, inner.spreadFields);
  const group = groupClause(inner.groupTerms);
  const range = limitOffsetClause(node.limit, node.offset, values);

  if (embedIsToOne(rel)) {
    // `ROWS 1` is a promise the function makes, not one the database enforces.
    // Upstream joins a LATERAL and reads its first row; a scalar subquery
    // raises 21000 on the second, so the promise is enforced here instead.
    const one = rel.computed && node.limit == null ? ' LIMIT 1' : '';
    return `(SELECT json_build_object(${pairs})`
      + ` FROM ${from}${whereClause(conds)}${group}${order.sql}`
      + `${range}${one})`;
  }

  // An aggregate inside the embed cannot sit under `json_agg` — that would
  // nest one aggregate in another — so the grouped rows are built first and
  // aggregated into the array from a derived table. An ordered or limited
  // embed needs the same shape, because `json_agg` has to be told the order
  // explicitly rather than inherit it from a subquery.
  if (inner.aggregated || group || order.terms.length > 0 || range) {
    const ordCols = order.terms.map((t, i) =>
      `${t.expr} AS ${q(`pgrst_o${i + 1}`)}`);
    const aggOrder = order.terms.length > 0
      ? ` ORDER BY ${order.terms.map((t, i) =>
        `${q(`pgrst_o${i + 1}`)} ${t.dir}${t.nulls}`).join(', ')}`
      : '';
    return `COALESCE((SELECT json_agg(`
      + `${q('pgrst_agg')}${aggOrder})`
      + ` FROM (SELECT json_build_object(${pairs})`
      + ` AS ${q('pgrst_agg')}`
      + `${ordCols.length > 0 ? `, ${ordCols.join(', ')}` : ''}`
      + ` FROM ${from}${whereClause(conds)}${group}${order.sql}${range})`
      + ` AS ${q('pgrst_grouped')}), '[]'::json)`;
  }

  return `COALESCE((SELECT json_agg(json_build_object(${pairs}))`
    + ` FROM ${from}${whereClause(conds)}), '[]'::json)`;
}

/**
 * A spread embed merges the embedded relation's members into the parent
 * object instead of nesting them under a key of its own (upstream `Spread`
 * and `pgFmtSpreadSelectItem`).
 *
 * On a to-one relationship each member is the child row's value. On a to-many
 * one each member becomes a json array, and every one of those arrays has to
 * come from the same pass over the child rows — which is why this is the one
 * place the engine joins a LATERAL instead of correlating a subquery.
 */
function buildSpreadLateral(
    node, rel, parentRef, schema, values, env, authzFilters, scope) {
  const child = embedChild(rel, parentRef, scope);
  const toOne = embedIsToOne(rel);
  const inner = buildRelationSelect(
    node.select, child.childTable, child.childRef, schema, values, env,
    authzFilters, child.childScope, { spreadToOne: toOne });

  // A to-many spread turns each member into a json array, and there is no
  // reading of an aggregate over one that upstream commits to: it refuses the
  // request instead (upstream `addToManyOrderSelects`). Nothing was hoisted
  // out of this level, so an aggregate here is one applied here — its own, or
  // one hoisted up from a to-one spread underneath it.
  if (!toOne && inner.aggregated) {
    throw new PostgRESTError(400, 'PGRST127', 'Feature not implemented',
      'Aggregates are not implemented for one-to-many or many-to-many '
      + 'spreads.');
  }

  const conds = [...child.conds, ...inner.innerConds];
  addNodeFilters(conds, node, child, schema, values, env, authzFilters);

  const latRef = nextLateralRef(env);
  scope.push(latRef);

  const cols = inner.fields.map((f, i) => ({
    key: f.key, expr: f.expr, col: `pgrst_s${i + 1}`, hoist: f.hoist,
    json: f.json,
  }));
  const order = relationOrder(
    node.order, schema, child.childTable, child.childRef, node.select,
    values, env, authzFilters, child.childScope, inner.spreadFields);
  const ordCols = order.terms.map((t, i) =>
    `${t.expr} AS ${q(`pgrst_o${i + 1}`)}`);

  const childQuery = `SELECT `
    + [...cols.map(c => `${c.expr} AS ${q(c.col)}`), ...ordCols].join(', ')
    + ` FROM ${child.from}${inner.laterals.join('')}`
    + `${whereClause(conds)}${groupClause(inner.groupTerms)}`
    + `${order.sql}`
    + limitOffsetClause(node.limit, node.offset, values);

  const fields = cols.map(c => ({
    key: c.key, expr: `${q(latRef)}.${q(c.col)}`, hoist: c.hoist,
    json: c.json,
  }));

  if (toOne) {
    return {
      lateral: ` LEFT JOIN LATERAL (${childQuery})`
        + ` AS ${q(latRef)} ON TRUE`,
      fields,
    };
  }

  const aggOrder = order.terms.length > 0
    ? ` ORDER BY ${order.terms.map((t, i) =>
      `${q('pgrst_src')}.${q(`pgrst_o${i + 1}`)} ${t.dir}${t.nulls}`)
      .join(', ')}`
    : '';
  const aggQuery = `SELECT ${cols.map(c =>
    `COALESCE(json_agg(${q('pgrst_src')}.${q(c.col)}${aggOrder}),`
    + ` '[]'::json) AS ${q(c.col)}`).join(', ')}`
    + ` FROM (${childQuery}) AS ${q('pgrst_src')}`;

  return {
    lateral: ` LEFT JOIN LATERAL (${aggQuery}) AS ${q(latRef)} ON TRUE`,
    fields,
  };
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
  // A validator without `resolve` (the RPC one, whose field list is the
  // function's own output columns) keeps validating: there is no row type for
  // a computed field to be declared on.
  let base;
  if (columnValidator.resolve) {
    base = columnValidator.resolve(f.column);
  } else {
    columnValidator(f.column);
    base = q(f.column);
  }
  if (!f.jsonPath || f.jsonPath.length === 0) return base;
  const colType = columnValidator.typeOf?.(f.column) || null;
  return jsonPathExpr(base, f.jsonPath, values, colType);
}

function buildSingleCondition(f, values, columnValidator) {
  const not = f.negate ? 'NOT ' : '';
  const field = filterFieldExpr(f, values, columnValidator);
  // Upstream `pgFmtUnknownLiteralForField`. `IS`, `IS DISTINCT FROM`, the FTS
  // operators and LIKE/ILIKE are the operators it leaves un-parsed (an
  // `IsDistinctFrom` literal and an FTS query are not values of the column's
  // type, and a LIKE pattern is not either).
  const parser = columnValidator.textParserOf?.(f.column) || null;

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
    // With a parser the list is unpacked and parsed element by element rather
    // than repeating the call per value (upstream
    // `pgFmtArrayLiteralForField`).
    const list = parser
      ? `(SELECT ${parser}(unnest($${values.length}::text[])))`
      : `$${values.length}`;
    return `${not}${field} = ANY(${list})`;
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
    return `${not}${field} ${simple} `
      + `${applyTransform(`$${values.length}`, parser)}`;
  }

  const quant = QUANT_OP_SQL[f.operator];
  if (!quant) {
    throw new PostgRESTError(
      400, 'PGRST100',
      `Unknown operator '${f.operator}'`,
    );
  }
  values.push(f.value);
  const patternOp = f.operator === 'like' || f.operator === 'ilike';
  let operand = applyTransform(
    `$${values.length}`, patternOp ? null : parser);
  if (f.quantifier === 'any') operand = `ANY(${operand})`;
  else if (f.quantifier === 'all') operand = `ALL(${operand})`;
  return `${not}${field} ${quant} ${operand}`;
}

const MAX_NESTING_DEPTH = 10;

function buildLogicalCondition(
    group, values, columnValidator, ctx, depth = 0) {
  if (depth > MAX_NESTING_DEPTH) {
    throw new PostgRESTError(400, 'PGRST100',
      'Logical operator nesting exceeds maximum '
      + `depth of ${MAX_NESTING_DEPTH}`);
  }

  const parts = [];
  for (const cond of group.conditions) {
    if (cond.type === 'logicalGroup') {
      parts.push(buildLogicalCondition(
        cond, values, columnValidator, ctx, depth + 1));
    } else if (cond.type === 'embedNull') {
      parts.push(buildEmbedNullCondition(cond, values, ctx));
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

/**
 * `?<embed>=is.null` / `?<embed>=not.is.null` asks whether the embedded row
 * exists at all, not whether a column of that name is null. Upstream rewrites
 * it to `<join alias> IS [NOT] DISTINCT FROM NULL` against its LEFT JOIN
 * LATERAL (Plan.hs `addNullEmbedFilters`, SqlFragment.hs
 * `CoercibleFilterNullEmbed`); against a correlated subquery it is the same
 * EXISTS the `!inner` form uses, negated for the `is.null` direction.
 */
function buildEmbedNullCondition(f, values, ctx) {
  if (!ctx) {
    throw new PostgRESTError(400, 'PGRST100',
      `Cannot filter on the embedded resource `
      + `'${f.embed.alias || f.embed.name}' here`);
  }
  const rel = resolveRelationship(
    ctx.schema, ctx.table, f.embed.name, f.embed.hint);
  const exists = buildEmbedExists(
    f.embed, rel, ctx.ref, ctx.schema, values, ctx.env,
    ctx.authzFilters, ctx.scope);
  return f.exists ? exists : `NOT ${exists}`;
}

function buildFilterConditions(filters, values, columnValidator, ctx) {
  const conditions = [];
  for (const f of filters) {
    if (f.type === 'logicalGroup') {
      conditions.push(
        buildLogicalCondition(f, values, columnValidator, ctx));
    } else if (f.type === 'embedNull') {
      conditions.push(buildEmbedNullCondition(f, values, ctx));
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

// ORDER BY of a set-returning function call. A table read goes through
// `relationOrder` instead, which qualifies its columns and can order by an
// embedded resource; neither applies to a function's result set.
function orderClause(order, columnValidator, values) {
  if (!order || order.length === 0) return '';
  const parts = order.map((o) => {
    columnValidator(o.column);
    const col = q(o.column);
    const field = o.jsonPath?.length > 0
      ? jsonPathExpr(
        col, o.jsonPath, values,
        columnValidator.typeOf?.(o.column) || null)
      : col;
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
  return buildSelectFrom(table, parsed, schema, authzConditions, {});
}

/**
 * The SELECT list of a read with no embeds: `?select=pId:id::text,name` and
 * friends, rendered against one relation.
 *
 * Factored out of `buildSelectFrom` because a mutation needs the same
 * projection — there it becomes the RETURNING list, which is why
 * `POST /projects?select=pId:id::text` answers `[{"pId":"7"}]` and not the
 * whole row.
 *
 * A known column is referenced unqualified, so the same string works over a
 * table, over a RETURNING list and over a function call. `opts.ref` names the
 * relation for the one case that has to be qualified: a field that is not a
 * column (see computedFieldExpr). It defaults to the table.
 */
function flatSelectList(selectNodes, schema, table, values, opts = {}) {
  const columnValidator = opts.columnValidator
    || makeColumnValidator(schema, table);
  const allColumns = Object.keys(schema.tables[table].columns);
  const aggregated = opts.aggregated === true;
  const groupTerms = opts.groupTerms || [];

  const cols = selectNodes.filter(
    n => typeof n === 'string' || n.type === 'column');
  const names = cols.map(n => typeof n === 'string' ? n : n.name);
  // A data representation is rendered as a function call, so the column has to
  // be aliased back to its own name (upstream `pgFmtCoerceNamed`) and the bare
  // `*` shortcut cannot be taken.
  const transformOf = (col) =>
    representationFn(schema, columnValidator.typeOf?.(col), OUTPUT_TYPE);
  const plainStar = names.length === 1 && names[0] === '*'
    && !(typeof cols[0] === 'object' && cols[0].agg);
  if (plainStar && !allColumns.some(transformOf)) {
    return allColumns.map(c => q(c)).join(', ');
  }

  const expressions = [];
  for (const n of cols) {
    const node = typeof n === 'string' ? { name: n } : n;
    if (node.name === '*' && !node.agg) {
      for (const c of allColumns) {
        const fn = transformOf(c);
        const expr = fn ? `${fn}(${q(c)}) AS ${q(c)}` : q(c);
        expressions.push(expr);
        if (aggregated) groupTerms.push(fn ? `${fn}(${q(c)})` : q(c));
      }
      continue;
    }
    const computed = node.name === '*'
      ? null
      : computedFieldExpr(schema, table, node.name, opts.ref || table);
    const base = node.name === '*'
      ? '*'
      : (computed || q(node.name));
    const transform = node.name === '*' || computed
      ? null
      : transformOf(node.name);
    const ref = selectItemExpr(
      node, base, values, columnValidator.typeOf, transform);
    if (node.alias) {
      expressions.push(`${ref} AS ${qAlias(node.alias)}`);
    } else if (transform && !node.agg) {
      // A function call takes the function's name as its output label, so the
      // column has to be named back.
      expressions.push(`${ref} AS ${q(node.name)}`);
    } else {
      expressions.push(ref);
    }
    if (aggregated && !node.agg) groupTerms.push(ref);
  }
  return expressions.join(', ');
}

/**
 * Is this select list one a mutation can project with `flatSelectList`?
 *
 * `?select=*` (or no select at all) is already what `RETURNING *` gives, and an
 * embed needs the join columns the projection would drop — the handler re-reads
 * those rows by primary key, so the primary key has to survive RETURNING.
 * Aggregates over a mutation are left alone for the same reason.
 */
function mutationProjects(selectNodes) {
  if (!Array.isArray(selectNodes) || selectNodes.length === 0) return false;
  if (selectNodes.some(n => n.type === 'embed')) return false;
  if (isAggregated(selectNodes)) return false;
  const cols = selectNodes.filter(
    n => typeof n === 'string' || n.type === 'column');
  if (cols.length !== selectNodes.length) return false;
  const names = cols.map(n => typeof n === 'string' ? n : n.name);
  if (names.length === 1 && names[0] === '*'
      && !(typeof cols[0] === 'object'
        && (cols[0].alias || cols[0].cast || cols[0].jsonPath))) {
    return false;
  }
  return true;
}

/**
 * The RETURNING list a mutation needs so the response carries the requested
 * columns, aliases and casts instead of the whole row — `RETURNING *` when the
 * select list is not one a mutation can project.
 *
 * Upstream narrows in an outer SELECT over the mutation's source CTE
 * (QueryBuilder.hs `mutateRequestToQuery` + `sourceCTE`: `WITH pgrst_source AS
 * (<mutation> RETURNING ...) SELECT <select list> FROM pgrst_source AS
 * "<table>"`). Narrowing in RETURNING gives the same rows and the same columns
 * with one less query level, and it keeps the projection over the table
 * itself — which matters for a computed column, whose function is declared on
 * the table's composite type. Over the CTE the row is a RECORD, so an
 * overloaded computed column cannot resolve there (`function
 * computed_overload(record) is not unique`); in RETURNING it does.
 */
function mutationReturning(table, parsed, schema, values) {
  if (!mutationProjects(parsed.select)) return ' RETURNING *';
  const projection = flatSelectList(
    parsed.select, schema, table, values, { ref: table });
  return ` RETURNING ${projection}`;
}

const MUTATION_SOURCE_CTE = 'pgrst_source';

/**
 * A mutation whose representation is a full read plan — embeds included —
 * computed over the rows the statement itself touched.
 *
 * This is upstream's shape: `WITH pgrst_source AS (<mutation> RETURNING *)`
 * followed by the read plan, whose FROM is that CTE *aliased to the table*
 * (Plan.hs `addRels`, root case: "the CTE for mutations/rpc is used as WITH
 * sourceCTEName .. SELECT .. FROM sourceCTEName as alias, we use the table name
 * as an alias so findRel can find the right relationship"). The alias is what
 * lets the embed's join conditions and the select list read exactly as they do
 * for a plain read of the table.
 *
 * A DELETE is why this cannot be done by re-reading the rows afterwards: they
 * are gone (DeleteSpec.hs:72, :79, :91, :160). Ordering is the other reason —
 * `?order=` belongs to the representation, and a re-read by primary key loses
 * it (UpsertSpec.hs:570).
 *
 * `limit`/`offset` are dropped: they never restrict a mutation's rows upstream
 * (`treeRestrictRange` skips ActRelationMut), and `?limit=` on a mutation is
 * the engine's `max-affected` check, not a slice of the representation.
 *
 * @param {{text: string, values: any[]}} mutation ending in `RETURNING *`
 */
export function buildMutationRead(
    mutation, table, parsed, schema, authzConditions) {
  const built = buildSelectFrom(
    table, { ...parsed, limit: null, offset: 0 }, schema, authzConditions, {
      fromSql: `${MUTATION_SOURCE_CTE} AS ${q(table)}`,
      values: [...mutation.values],
    });
  return {
    text: `WITH ${MUTATION_SOURCE_CTE} AS (${mutation.text}) ${built.text}`,
    values: built.values,
  };
}

/**
 * `buildSelect` with the FROM clause supplied by the caller.
 *
 * The read plan (select list, filters, order, limit, embeds) is written against
 * one alias — `table` — everywhere, so a function call aliased to the relation
 * it returns takes exactly the same plan a table read takes. That is how
 * `?select=`/`?order=`/embeds work on `/rpc/fn` (upstream wraps the call in
 * `WITH pgrst_source AS (...)` and plans over it; here the call *is* the FROM).
 *
 * @param {object} opts
 * @param {string} [opts.fromSql] FROM clause; defaults to the quoted table
 * @param {any[]} [opts.values] bind values to append to (RPC pre-seeds the
 *   function arguments, which must keep their $n positions)
 */
function buildSelectFrom(table, parsed, schema, authzConditions, opts = {}) {
  const values = opts.values || [];
  const columnValidator = makeColumnValidator(schema, table);
  const allColumns = Object.keys(schema.tables[table].columns);
  const hasEmbeds = parsed.select.some(
    n => n.type === 'embed');

  let colList;
  let lateralJoins = '';
  const innerJoinConds = [];
  const aggregated = isAggregated(parsed.select);
  const groupTerms = [];
  const env = newBuildEnv();
  let rootSpreadFields = null;

  if (hasEmbeds) {
    const rs = buildRelationSelect(
      parsed.select, table, table, schema, values, env,
      authzConditions?.embeds, [table]);
    colList = rs.fields
      .map(f => f.explicitAlias
        ? `${f.expr} AS ${qAlias(f.key)}`
        : f.expr)
      .join(', ');
    // `?select=clients()` selects nothing but the empty embed. Upstream's
    // `defSelect` falls back to the row when a select list comes out empty,
    // so that is what happens here rather than emitting `SELECT FROM`.
    if (rs.fields.length === 0) {
      colList = allColumns.map(c => `${q(table)}.${q(c)}`).join(', ');
    }
    lateralJoins = rs.laterals.join('');
    innerJoinConds.push(...rs.innerConds);
    groupTerms.push(...rs.groupTerms);
    rootSpreadFields = rs.spreadFields;
  } else {
    colList = flatSelectList(parsed.select, schema, table, values, {
      columnValidator, aggregated, groupTerms,
    });
  }

  const conds = buildFilterConditions(
    parsed.filters, values, columnValidator,
    filterCtx(schema, table, table, [table], env,
      authzConditions?.embeds));

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

  let sql = `SELECT ${colList} FROM ${opts.fromSql || q(table)}${lateralJoins}`;
  sql += whereClause(conds);
  sql += groupClause(groupTerms);
  sql += relationOrder(
    parsed.order, schema, table, table, parsed.select, values, env,
    authzConditions?.embeds, [table], rootSpreadFields).sql;
  sql += limitOffsetClause(parsed.limit, parsed.offset, values);

  return { text: sql, values };
}

/**
 * Upstream's payload key-uniformity check (ApiRequest/Payload.hs
 * `payloadAttributes`): a json array body must be an array of objects that all
 * carry the same keys, because the INSERT has one column list for every row.
 *
 * It is skipped when `?columns=` is given — that parameter *is* the column
 * list, so rows are free to differ (InsertSpec.hs:547 posts
 * `[{"a":"val"},{"a":"val","b":"val"}]` with `?columns=a,b` and expects
 * PostgreSQL's generated-column error, not this one).
 */
function assertUniformPayload(rows) {
  if (rows.length === 0) return;
  let keys = null;
  for (const row of rows) {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      throw new PostgRESTError(400, 'PGRST102',
        'All object keys must match');
    }
    const rowKeys = Object.keys(row).sort().join('\u0000');
    if (keys === null) keys = rowKeys;
    else if (rowKeys !== keys) {
      throw new PostgRESTError(400, 'PGRST102',
        'All object keys must match');
    }
  }
}

/**
 * @param {object} [opts]
 * @param {string|null} [opts.resolution] `Prefer: resolution=` —
 *        `merge-duplicates` or `ignore-duplicates`. Upstream emits an
 *        `ON CONFLICT` clause only when this preference is present
 *        (Plan.hs `mutatePlan`: `(,) <$> preferResolution <*> Just confCols`),
 *        and the conflict target is `?on_conflict=` when given, the primary key
 *        otherwise.
 * @param {boolean} [opts.applyDefaults] `Prefer: missing=default` — a key
 *        absent from a row takes the column's default instead of NULL.
 */
export function buildInsert(table, body, schema, parsed, opts = {}) {
  const rows = Array.isArray(body) ? body : [body];
  const explicitCols = parsed.columns && parsed.columns.length > 0
    ? parsed.columns
    : null;
  const applyDefaults = opts.applyDefaults === true;
  const resolution = opts.resolution || null;
  const values = [];

  let columns;
  if (explicitCols) {
    for (const col of explicitCols) validateCol(schema, table, col);
    columns = [...new Set(explicitCols)];
  } else {
    if (Array.isArray(body)) assertUniformPayload(rows);
    const colSet = new Set();
    for (const row of rows) {
      for (const key of Object.keys(row)) {
        validateCol(schema, table, key);
        colSet.add(key);
      }
    }
    columns = [...colSet];
  }

  // `POST /t` with `[]` inserts nothing. Upstream gets there for free — its
  // INSERT selects from `json_to_recordset(<body>)`, which yields no rows — but
  // an explicit VALUES list cannot be empty, so the statement becomes a
  // zero-row read of the same shape (the trick upstream itself uses for an
  // empty PATCH payload).
  if (Array.isArray(body) && rows.length === 0) {
    const projection = mutationProjects(parsed.select)
      ? flatSelectList(parsed.select, schema, table, values)
      : Object.keys(schema.tables[table].columns).map(c => q(c)).join(', ');
    return {
      text: `SELECT ${projection} FROM ${q(table)} WHERE false`,
      values,
    };
  }

  const columnTypes = schema.tables[table].columns;
  const allColumns = Object.keys(columnTypes);
  // A payload with no keys at all (`{}`, `[{}, {}]`) asks for a row of
  // defaults. `DEFAULT VALUES` says that for one row; for several, every
  // column takes the DEFAULT keyword, which is what upstream's
  // `jsonb_build_object` of column defaults amounts to.
  const allDefaults = columns.length === 0;

  let sql;
  if (allDefaults && rows.length === 1) {
    sql = `INSERT INTO ${q(table)} DEFAULT VALUES`;
  } else {
    const insertCols = allDefaults ? allColumns : columns;
    const tuples = rows.map((row) => {
      const placeholders = insertCols.map((col) => {
        if (allDefaults) return 'DEFAULT';
        if (row[col] === undefined) return applyDefaults ? 'DEFAULT' : 'NULL';
        return payloadOperand(schema, table, col, row[col], values);
      });
      return `(${placeholders.join(', ')})`;
    });
    const colList = insertCols.map((c) => q(c)).join(', ');
    sql = `INSERT INTO ${q(table)} (${colList}) VALUES ${tuples.join(', ')}`;
  }

  if (resolution) {
    const target = parsed.onConflict
      ? parsed.onConflict.split(',').map((c) => c.trim())
      : (schema.tables[table]?.primaryKey || []);
    for (const col of target) validateCol(schema, table, col);
    if (target.length > 0) {
      const conflictCols = target.map((c) => q(c)).join(', ');
      // Upstream sets *every* inserted column from EXCLUDED, the conflict
      // target included (`DO UPDATE SET id = EXCLUDED.id, ...`), and only falls
      // back to DO NOTHING when there is no column to set at all — a table
      // whose columns are all defaulted. Excluding the primary key instead
      // turned `?select=` upserts on a PK-only table into DO NOTHING, which
      // silently returned nothing for the conflicting rows.
      if (resolution === 'ignore-duplicates' || columns.length === 0) {
        sql += ` ON CONFLICT (${conflictCols}) DO NOTHING`;
      } else {
        const sets = columns
          .map((c) => `${q(c)} = EXCLUDED.${q(c)}`)
          .join(', ');
        sql += ` ON CONFLICT (${conflictCols}) DO UPDATE SET ${sets}`;
      }
    }
  }

  sql += mutationReturning(table, parsed, schema, values);
  return {
    text: sql,
    values,
  };
}

/**
 * How many rows of an upsert's payload already exist, matched on the conflict
 * target.
 *
 * `Prefer: resolution=merge-duplicates` answers 200 instead of 201 when the
 * statement inserted no new row (Response.hs `isInsertIfGTZero`). Upstream
 * knows the count because its INSERT bumps a transaction-local GUC
 * (`set_config('pgrst.inserted', ...)`) that the DO UPDATE branch decrements
 * again; neither that GUC nor the `xmax` trick survives here — Aurora DSQL
 * refuses a system column in a RETURNING list — so the conflicting rows are
 * counted before the write, the same substitute the single-row PUT upsert
 * already uses.
 *
 * A row that leaves any target column out cannot conflict: the column takes
 * its default or NULL, and a unique index treats NULLs as distinct. Returns
 * null when no row could conflict at all, in which case no query is needed.
 *
 * @returns {{text: string, values: any[]}|null}
 */
export function buildConflictCount(table, rows, targetCols, schema, columns) {
  if (!targetCols || targetCols.length === 0) return null;
  for (const col of targetCols) validateCol(schema, table, col);
  const restricted = columns && columns.length > 0 ? new Set(columns) : null;
  if (restricted && !targetCols.every(c => restricted.has(c))) return null;

  const colTypes = schema.tables[table].columns;
  const values = [];
  const tuples = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    if (!targetCols.every(c => row[c] !== undefined && row[c] !== null)) {
      continue;
    }
    const placeholders = targetCols.map((c) => {
      values.push(paramValue(row[c], colTypes[c]?.type));
      return `$${values.length}`;
    });
    tuples.push(targetCols.length === 1
      ? placeholders[0]
      : `(${placeholders.join(', ')})`);
  }
  if (tuples.length === 0) return null;

  const left = targetCols.length === 1
    ? q(targetCols[0])
    : `(${targetCols.map(c => q(c)).join(', ')})`;
  return {
    text: `SELECT COUNT(*) AS count FROM ${q(table)}`
      + ` WHERE ${left} IN (${tuples.join(', ')})`,
    values,
  };
}

export function buildUpdate(
    table, body, parsed, schema, authzConditions, opts = {}) {
  // A PATCH payload may arrive as a one-element array: upstream accepts both
  // `{"a":1}` and `[{"a":1}]` for an update (ApiRequest takes the payload as a
  // row list and an update names the columns of one row). Reading the array
  // itself with Object.entries would take its indices for column names and
  // fail with PGRST204 `Column '0' does not exist`.
  const payload = Array.isArray(body) && body.length === 1 ? body[0] : body;

  const values = [];
  const explicitCols = parsed.columns && parsed.columns.length > 0
    ? [...new Set(parsed.columns)]
    : null;
  if (explicitCols) {
    for (const col of explicitCols) validateCol(schema, table, col);
  } else {
    for (const col of Object.keys(payload)) validateCol(schema, table, col);
  }
  // `?columns=` is the column list, so a key the payload does not carry is
  // still updated — to its default with `Prefer: missing=default`, to NULL
  // without it (upstream's json_to_record yields NULL for an absent key).
  const setCols = explicitCols || Object.keys(payload);
  const setClauses = setCols.map((col) => {
    if (payload[col] === undefined) {
      return `${q(col)} = ${opts.applyDefaults === true ? 'DEFAULT' : 'NULL'}`;
    }
    return `${q(col)} = `
      + `${payloadOperand(schema, table, col, payload[col], values)}`;
  });

  // An empty payload updates nothing. `UPDATE t SET` is a syntax error, so
  // upstream answers the request with a zero-row read that still has the
  // requested shape (QueryBuilder.hs: "if there are no columns we cannot do
  // UPDATE table SET {empty} ... selecting an empty resultset from mainQi gives
  // us the column names to prevent errors when using &select=").
  if (setCols.length === 0) {
    const projection = mutationProjects(parsed.select)
      ? flatSelectList(parsed.select, schema, table, values)
      : Object.keys(schema.tables[table].columns).map(c => q(c)).join(', ');
    return {
      text: `SELECT ${projection} FROM ${q(table)} WHERE false`,
      values,
    };
  }

  // `parsed.allowBulkMutation` is the caller's statement that a filterless
  // mutation is intentional (the handler sets it when the engine's
  // bulk-mutation guard is configured off, which is upstream's default: it has
  // no guard of its own and relies on the pg-safeupdate extension). Absent, the
  // guard refuses.
  //
  // The check sits after the empty-payload short-circuit above on purpose: an
  // update that sets no columns changes no rows, so refusing it as a "bulk
  // change" would answer 400 to a request upstream answers 204 to
  // (UpdateSpec:245, :256, :279, :290) while protecting nothing.
  if (parsed.filters.length === 0 && parsed.allowBulkMutation !== true) {
    throw new PostgRESTError(
      400, 'PGRST106',
      'UPDATE requires filters to prevent bulk change',
    );
  }

  const columnValidator = makeColumnValidator(schema, table);
  const conds = buildFilterConditions(
    parsed.filters, values, columnValidator,
    filterCtx(schema, table, table, [table], newBuildEnv(), undefined),
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
  sql += mutationReturning(table, parsed, schema, values);

  return {
    text: sql,
    values,
  };
}

export function buildDelete(table, parsed, schema, authzConditions) {
  // See buildUpdate: opt-in bypass for a deliberately filterless mutation.
  if (parsed.filters.length === 0 && parsed.allowBulkMutation !== true) {
    throw new PostgRESTError(
      400, 'PGRST106',
      'DELETE requires filters to prevent bulk change',
    );
  }

  const values = [];
  const columnValidator = makeColumnValidator(schema, table);
  const conds = buildFilterConditions(
    parsed.filters, values, columnValidator,
    filterCtx(schema, table, table, [table], newBuildEnv(), undefined),
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
  sql += mutationReturning(table, parsed, schema, values);

  return {
    text: sql,
    values,
  };
}

export function buildCount(table, parsed, schema, authzConditions) {
  const values = [];
  const env = newBuildEnv();
  const columnValidator = makeColumnValidator(schema, table);
  const conds = buildFilterConditions(
    parsed.filters, values, columnValidator,
    filterCtx(schema, table, table, [table], env, undefined),
  );

  // An `!inner` embed drops parent rows that have no match, so the count has
  // to see it too or `Content-Range` reports more rows than the body holds
  // (upstream counts over the same read plan, joins included).
  for (const node of parsed.select || []) {
    if (node.type === 'embed' && node.inner) {
      const rel = resolveRelationship(
        schema, table, node.name, node.hint);
      conds.push(buildEmbedExists(
        node, rel, table, schema, values, env, undefined, [table]));
    }
  }

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

/**
 * Column the scalar return of a function arrives under. Upstream's name, and
 * the handler unwraps it, so it is exported rather than spelled twice.
 */
export const RPC_SCALAR = 'pgrst_scalar';

// A catalog type name, as `regtype::text` renders it: `integer`, `text[]`,
// `character varying`, `"MyType"`, `public.dom`. Never user input — but an
// interpolated string in SQL, so it is checked before it goes in.
const CAST_TYPE = /^[A-Za-z_"][A-Za-z0-9_ ."[\]]*$/;

function castSuffix(type) {
  return type && CAST_TYPE.test(type) ? `::${type}` : '';
}

/**
 * A JSON body value → a bind value for a parameter of `arg`'s type.
 *
 * Upstream feeds the whole payload through `json_to_recordset`, so a value's
 * JSON type decides how it lands: an object/array stays JSON text for a
 * json/jsonb parameter (which is why a quoted JSON string arrives as a JSON
 * *string*, not a parsed object), and everything else is cast from its text
 * form by the `::type` on the placeholder.
 */
function rpcJsonBind(arg, value) {
  if (value === null || value === undefined) return null;
  const t = arg.type;
  if (t === 'json' || t === 'jsonb') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return value.map(
      v => (v !== null && typeof v === 'object') ? JSON.stringify(v) : v);
  }
  if (typeof value === 'object') return JSON.stringify(value);
  return value;
}

/**
 * The `(...)` of a routine call.
 *
 * Only the parameters the request actually supplied are named, so parameters
 * with a DEFAULT keep their default instead of being overwritten with NULL.
 */
function rpcArgList(routine, call, values) {
  if (call.mode === 'single') {
    const p = routine.args[0];
    values.push(call.raw);
    return `$${values.length}${castSuffix(p.castType)}`;
  }
  const named = call.named || {};
  const parts = [];
  for (const a of routine.args) {
    if (!Object.prototype.hasOwnProperty.call(named, a.name)) continue;
    values.push(call.mode === 'json'
      ? rpcJsonBind(a, named[a.name])
      : named[a.name]);
    parts.push(
      `${a.variadic ? 'VARIADIC ' : ''}${q(a.name)} := `
      + `$${values.length}${castSuffix(a.castType)}`);
  }
  return parts.join(', ');
}

function normalizeCall(callArgs) {
  if (callArgs && typeof callArgs === 'object' && callArgs.mode) {
    return callArgs;
  }
  return { mode: 'json', named: callArgs || {} };
}

const EMPTY_READ_PLAN = {
  select: ['*'], filters: [], order: [], limit: null, offset: 0,
};

/**
 * A stored function call.
 *
 * @param {string} fnName
 * @param {object} callArgs `{mode: 'direct'|'json'|'single', named, raw}` —
 *   `direct` is GET/urlencoded (values are text), `json` a JSON body, `single`
 *   a raw body bound to a single unnamed parameter. A plain map is taken as
 *   `json` arguments.
 * @param {object} routine the resolved routine (src/rest/routines.mjs)
 * @param {object} parsed the read plan to apply over the result, or null
 * @param {object} [schema] schema cache — lets a function that returns a table
 *   take the full read plan, embeds included
 * @returns {{text: string, values: any[], resultMode: string}} `resultMode` is
 *   `void` | `scalar` | `setofScalar` | `single` | `set`
 */
export function buildRpcCall(fnName, callArgs, routine, parsed, schema) {
  const call = normalizeCall(callArgs);
  const values = [];
  const argList = rpcArgList(routine, call, values);
  const callSql = `${q(fnName)}(${argList})`;
  const plan = parsed || EMPTY_READ_PLAN;

  if (routine.returnType === 'void') {
    return { text: `SELECT ${callSql}`, values, resultMode: 'void' };
  }

  // Not composite: one value per row, rendered under a fixed column name.
  // `record` with no OUT parameters is a scalar too, and the only way to get
  // its fields out is to let PostgreSQL render them (upstream's json_agg does
  // the same job).
  if (!routine.returnsComposite) {
    const inner = routine.returnType === 'record'
      ? `to_json(pgrst_call.${RPC_SCALAR})`
      : `pgrst_call.${RPC_SCALAR}`;
    let sql = `SELECT ${inner} AS ${RPC_SCALAR}`
      + ` FROM (SELECT ${callSql} AS ${RPC_SCALAR}) pgrst_call`;
    if (routine.returnsSet) {
      sql += limitOffsetClause(plan.limit, plan.offset, values);
      return { text: sql, values, resultMode: 'setofScalar' };
    }
    return { text: sql, values, resultMode: 'scalar' };
  }

  const resultMode = routine.returnsSet ? 'set' : 'single';
  const rel = routine.returnRelation;

  // Returns a relation the API exposes: plan it exactly like a read of that
  // relation, which brings ?select= expansion, filters on unselected columns,
  // order, limit and embeds along for free.
  if (rel && schema?.tables?.[rel]) {
    const built = buildSelectFrom(rel, plan, schema, null, {
      fromSql: `${callSql} AS ${q(rel)}`,
      values,
    });
    return { text: built.text, values: built.values, resultMode };
  }

  // Returns an anonymous record (TABLE(...) or OUT parameters): the columns are
  // the OUT parameters, and there is nothing to embed on.
  const columnValidator = makeRpcColumnValidator(routine);
  const allColumns = routine.returnColumns?.map(c => c.name);

  const selectNodes = plan.select
    .filter(s => typeof s === 'string' || s.type === 'column');
  const selectNames = selectNodes
    .map(s => typeof s === 'string' ? s : s.name);

  const aggregated = isAggregated(plan.select);
  const groupTerms = [];
  const plainStar = selectNames.length === 1 && selectNames[0] === '*'
    && !(typeof selectNodes[0] === 'object' && selectNodes[0].agg);

  let selectPart = '*';
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

  let sql = `SELECT ${selectPart} FROM ${callSql}`;
  const conds = buildFilterConditions(plan.filters, values, columnValidator);
  sql += whereClause(conds);
  sql += groupClause(groupTerms);
  sql += orderClause(plan.order, columnValidator, values);
  sql += limitOffsetClause(plan.limit, plan.offset, values);

  return { text: sql, values, resultMode };
}

export { buildFilterConditions as _buildFilterConditions };
