// query-parser.mjs — Parse PostgREST query params to structured objects

import { PostgRESTError } from './errors.mjs';

const RESERVED_PARAMS = new Set([
  'select', 'order', 'limit', 'offset', 'on_conflict', 'columns',
]);

// Operator tables, in the order upstream tries them
// (QueryParams.hs `pOperation`, `simpleOperator`, `quantOperator`).
// Order matters: a prefix must be tried after the longer token that
// starts with it, so `gte` comes before `gt` and `lte` before `lt`.
const SIMPLE_OPERATORS = [
  'neq', 'cs', 'cd', 'ov', 'sl', 'sr', 'nxr', 'nxl', 'adj',
];
const QUANT_OPERATORS = [
  'eq', 'gte', 'gt', 'lte', 'lt', 'like', 'ilike', 'match', 'imatch',
];
const FTS_OPERATORS = ['fts', 'plfts', 'phfts', 'wfts'];

export const VALID_OPERATORS = new Set([
  ...SIMPLE_OPERATORS, ...QUANT_OPERATORS, ...FTS_OPERATORS,
  'in', 'is', 'isdistinct',
]);

// Upstream `pIsVal`, matched case-insensitively.
const VALID_IS_VALUES = new Set([
  'null', 'not_null', 'true', 'false', 'unknown',
]);

const LOGICAL_OPS = new Set(['or', 'and']);

const ALIAS_IDENT = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

// Legacy alias/cast diagnostics. Upstream reports every malformed select
// token as one Parsec error; pgrest-lambda has always named the specific
// mistake instead, and those messages are part of its API. They are kept
// for tokens without a json path — a json key may legally contain the
// characters these checks key off (`:` inside a quoted key), so a token
// carrying `->` is left entirely to the grammar.
function legacySelectChecks(token) {
  if (token.startsWith('::')) {
    throw new PostgRESTError(400, 'PGRST100',
      "Empty column name before '::'");
  }
  let colonIdx = -1;
  for (let j = 0; j < token.length; j++) {
    if (token[j] === ':') {
      if (j + 1 < token.length && token[j + 1] === ':') {
        j++;
      } else {
        colonIdx = j;
        break;
      }
    }
  }
  if (colonIdx === -1) return;
  const alias = token.slice(0, colonIdx).trim();
  const column = token.slice(colonIdx + 1).trim();
  if (!ALIAS_IDENT.test(alias)) {
    throw new PostgRESTError(400, 'PGRST100',
      `'${alias}' is not a valid identifier for an alias`);
  }
  if (!column) {
    throw new PostgRESTError(400, 'PGRST100',
      `Empty column name after alias '${alias}'`);
  }
}

const MAX_NESTING_DEPTH = 10;
export const DEFAULT_MAX_EMBED_DEPTH = 5;

// Upstream `pRelationSelect` is the only alternative that may be followed
// by a parenthesised sub-select, and it accepts nothing but
// `[...][alias:]name[!hint][!inner]` before the '(' — with an explicit
// `guard (name /= "count")` so that `count()` can never be read as an
// embed. Everything else that reaches a '(' is a field, which is what
// makes `select=data->(x` a json-path parse error rather than an embed
// with an empty select list.
//
// The leading `...` is upstream's spread marker (`pSpreadRelationSelect`):
// `...clients(name)` merges the embedded row's keys into the parent object
// instead of nesting them under a key of its own.
function looksLikeEmbedPrefix(prefix) {
  const sc = new Scanner(prefix);
  sc.ws();
  if (sc.src.startsWith('...', sc.pos)) sc.pos += 3;
  const before = sc.pos;
  const maybeAlias = pFieldName(sc);
  if (maybeAlias !== FAIL && sc.src[sc.pos] === ':'
      && sc.src[sc.pos + 1] !== ':') {
    sc.pos += 1;
  } else {
    sc.pos = before;
  }
  const name = pFieldName(sc);
  if (name === FAIL || name === 'count') return false;
  while (sc.src[sc.pos] === '!') {
    sc.pos += 1;
    if (pFieldName(sc) === FAIL) return false;
  }
  sc.ws();
  return sc.pos === prefix.length;
}

// The index just past the closing '"' of the quoted run that starts at `at`,
// or `at` itself when the quote is never closed. Upstream `pQuotedValue`
// treats a backslash as escaping whatever follows it.
function skipQuotedRun(input, at) {
  for (let j = at + 1; j < input.length; j += 1) {
    if (input[j] === '\\') { j += 1; continue; }
    if (input[j] === '"') return j + 1;
  }
  return at;
}

export function parseSelectList(
    input, maxEmbedDepth = DEFAULT_MAX_EMBED_DEPTH, depth = 0,
    source = input, offset = 0) {
  if (Number.isNaN(maxEmbedDepth)) {
    maxEmbedDepth = DEFAULT_MAX_EMBED_DEPTH;
  }
  const nodes = [];
  let i = 0;
  const len = input.length;
  // A `)` that closes nothing ends the field forest, and whatever follows it
  // is dropped. Upstream reads `select` with Parsec's `parse`
  // (QueryParams.hs:220 `P.parse pFieldForest`), which does not demand `eof`,
  // so `pFieldForest`'s `sepBy` simply stops at the first character it cannot
  // use and the parse still succeeds. SpreadQueriesSpec:391 sends
  // `...processes(process:name,...process_costs(cost)))` — one paren too many
  // — and expects 200.
  let forestEnded = false;

  while (i < len && !forestEnded) {
    // Skip leading whitespace
    while (i < len && input[i] === ' ') i++;
    if (i >= len) break;

    // Scan token up to ',' or the '(' of an embed, both at depth 0.
    let tokenStart = i;
    let parenDepth = 0;
    let parenStart = -1;

    while (i < len) {
      const ch = input[i];
      if (ch === '"') {
        // A quoted field name is one token to upstream's `pQuotedValue`, so
        // the ',', '(' and ')' inside it are ordinary characters — that is
        // how `select="(inside,parens)"` names a column with parentheses in
        // it (QuerySpec:1291). An unterminated quote is not a quoted value,
        // and the character is scanned like any other.
        const closed = skipQuotedRun(input, i);
        if (closed > i) { i = closed; continue; }
      }
      if (parenDepth === 0 && ch === ',') break;
      if (ch === '(') {
        if (parenDepth === 0) {
          if (!looksLikeEmbedPrefix(input.slice(tokenStart, i))) {
            // A field, not an embed: the '(' belongs to the field token
            // and the grammar decides what to make of it.
            while (i < len && input[i] !== ',') {
              const closed = input[i] === '"' ? skipQuotedRun(input, i) : i;
              i = closed > i ? closed : i + 1;
            }
            break;
          }
          parenStart = i;
        }
        parenDepth++;
      } else if (ch === ')') {
        if (parenDepth === 0) {
          forestEnded = true;
          break;
        }
        parenDepth--;
        if (parenDepth === 0) {
          i++; // move past closing ')'
          break;
        }
      }
      i++;
    }

    if (parenDepth > 0) {
      throw new PostgRESTError(400, 'PGRST100',
        'Unbalanced parentheses in select parameter');
    }

    if (parenStart === -1) {
      // Plain field token
      const token = input.slice(tokenStart, i).trim();
      if (token) {
        if (!token.includes('->')) legacySelectChecks(token);
        nodes.push(parseFieldSelect(
          source, offset + tokenStart, offset + i));
      }
    } else {
      // Embed token: text before '(' is the embed descriptor
      const embedToken = input.slice(tokenStart, parenStart).trim();
      const innerContent = input.slice(parenStart + 1, i - 1);
      if (depth + 1 > maxEmbedDepth) {
        throw new PostgRESTError(400, 'PGRST100',
          `Embedding depth exceeds maximum of ${maxEmbedDepth}`);
      }
      const childNodes = parseSelectList(
        innerContent, maxEmbedDepth, depth + 1,
        source, offset + parenStart + 1);
      const embed = parseEmbedToken(embedToken);
      // An embed with an empty select list — `?select=*,clients()` — is
      // legal upstream: it contributes no key to the response and exists
      // only so `?clients=is.null` has something to filter on
      // (Plan.hs `rsEmptyEmbed` / `addNullEmbedFilters`).
      nodes.push({
        type: 'embed',
        name: embed.name,
        alias: embed.alias,
        hint: embed.hint,
        inner: embed.inner,
        spread: embed.spread,
        select: childNodes,
        filters: [],
        order: [],
        limit: null,
      });
    }

    // Skip comma separator
    if (i < len && input[i] === ',') i++;
  }

  const keys = new Set();
  for (const node of nodes) {
    if (node.type === 'column' && !(node.name === '*' && !node.agg)) {
      // The key is the JSON key the response will carry: the alias when
      // there is one, and for a json path or an aggregate the alias the
      // parser derived (upstream Plan.hs `addAliases`).
      const key = node.alias || node.name;
      if (keys.has(key)) {
        throw new PostgRESTError(400, 'PGRST100',
          `Duplicate select key '${key}'`);
      }
      keys.add(key);
    } else if (node.type === 'embed') {
      // A spread embed carries no key of its own (its members are merged
      // into the parent object) and an empty embed carries none either.
      if (node.spread || node.select.length === 0) continue;
      const key = node.alias || node.name;
      if (keys.has(key)) {
        throw new PostgRESTError(400, 'PGRST100',
          `Duplicate select key '${key}'`);
      }
      keys.add(key);
    }
  }

  return nodes;
}

function buildEmbedAliasMap(selectNodes) {
  const map = new Map();
  for (const node of selectNodes) {
    if (node.type === 'embed') {
      const key = node.alias || node.name;
      map.set(key, node);
    }
  }
  return map;
}

// `?<embed>=is.null` / `?<embed>=not.is.null` is not a filter on a column
// called `<embed>`: it asks whether the embedded row exists at all. Upstream
// rewrites it to `<join alias> IS [NOT] DISTINCT FROM NULL`
// (Plan.hs `addNullEmbedFilters`, SqlFragment.hs `CoercibleFilterNullEmbed`),
// and it only does so for that one operator — `?status=eq.3` on an embed
// named `status` still filters the column of that name.
//
// `exists` is upstream's `hasNot`: `not.is.null` keeps the rows that have a
// match, `is.null` keeps the rows that have none.
//
// `?or=(clientinfo.not.is.null,contact.not.is.null)` puts the is-null form
// inside a logic tree, so the rewrite has to reach the leaves too
// (upstream `newNullFilters` recurses through `CoercibleExpr`).
function rewriteEmbedNullLeaves(filters, embedMap) {
  for (let i = 0; i < filters.length; i++) {
    const f = filters[i];
    if (f.type === 'logicalGroup') {
      rewriteEmbedNullLeaves(f.conditions, embedMap);
      continue;
    }
    if (f.type !== 'filter') continue;
    if (f.operator !== 'is') continue;
    if (f.jsonPath && f.jsonPath.length > 0) continue;
    if (String(f.value).toLowerCase() !== 'null') continue;
    const node = embedMap.get(f.column);
    if (!node) continue;
    filters[i] = {
      type: 'embedNull', embed: node, exists: Boolean(f.negate),
    };
  }
}

// Walk the select tree and rewrite is-null leaves at every level against
// the embeds visible at that level.
function rewriteEmbedNulls(selectNodes, filters) {
  const map = buildEmbedAliasMap(selectNodes);
  if (map.size > 0) rewriteEmbedNullLeaves(filters, map);
  for (const node of selectNodes) {
    if (node.type === 'embed') {
      rewriteEmbedNulls(node.select, node.filters);
    }
  }
}

function routeEmbedParam(embedNode, prefix, rest, rawValue) {
  if (rest === 'order') {
    embedNode.order = parseOrder(rawValue);
    return;
  }
  if (rest === 'limit') {
    embedNode.limit = parseInt(rawValue, 10);
    return;
  }
  if (rest === 'offset') {
    embedNode.offset = parseInt(rawValue, 10);
    return;
  }

  let logicalOp = null;
  let negate = false;
  if (LOGICAL_OPS.has(rest)) {
    logicalOp = rest;
  } else if (rest.startsWith('not.')) {
    const sub = rest.slice(4);
    if (LOGICAL_OPS.has(sub)) {
      logicalOp = sub;
      negate = true;
    }
  }
  if (logicalOp) {
    embedNode.filters.push(
      parseLogicalGroup(logicalOp, negate, rawValue));
    return;
  }

  // `?children.gChildren.id=eq.1` targets an embed two levels down. Upstream
  // walks the whole dotted path down the read plan tree
  // (Plan.hs `updateNode`), so the nesting is not limited to one level.
  const split = embedPathSplit(rest);
  if (split) {
    const nextPrefix = split.prefix;
    const nested = buildEmbedAliasMap(embedNode.select).get(nextPrefix);
    if (nested) {
      routeEmbedParam(
        nested, `${prefix}.${nextPrefix}`, split.rest, rawValue);
      return;
    }
    throw notEmbeddedError(nextPrefix, embedNode.select);
  }

  embedNode.filters.push(parseFilter(rest, rawValue));
}

function hasAnyEmbed(selectNodes) {
  return selectNodes.some(n => n.type === 'embed');
}

/**
 * The dotted prefix of a filter/order/limit key, or null when the key is a
 * plain field.
 *
 * Upstream's `pTreePath` parses the key as `pFieldName sepBy1 '.'` followed by
 * an optional json path, so every dot-separated component but the last names a
 * level of the embed tree — and the json path is only looked for *after* the
 * names, which is why `children.data->>x` splits on the dot before `data` and
 * `data->>a.b` does not split at all. A quoted name may itself contain dots
 * (`?"a.b"=eq.1`), so it is never a path.
 */
function embedPathSplit(key) {
  if (key.startsWith('"')) return null;
  const arrowIdx = key.indexOf('->');
  const head = arrowIdx === -1 ? key : key.slice(0, arrowIdx);
  const dotIdx = head.indexOf('.');
  if (dotIdx === -1) return null;
  return { prefix: key.slice(0, dotIdx), rest: key.slice(dotIdx + 1) };
}

/**
 * Upstream's `NotEmbedded` error (Error.hs): a filter, order or limit named a
 * resource the select list does not embed. Status 400, code PGRST108.
 *
 * When the name is a relation that *is* embedded but under an alias, upstream
 * points at the alias instead of telling the caller to add it to `select`
 * (Plan.hs `NotEmbedded`, with `configUrlUseLegacyTargetNames` off — the
 * default since v12).
 */
function notEmbeddedError(resource, selectNodes) {
  const message = `'${resource}' is not an embedded resource in this request`;
  const aliased = (selectNodes || []).find(
    n => n.type === 'embed' && n.alias && n.name === resource);
  if (aliased) {
    return new PostgRESTError(400, 'PGRST108', message,
      'Target names are not allowed in filters if they have an alias',
      `Change '${resource}' to '${aliased.alias}' in filters, orders or `
      + 'limits.');
  }
  return new PostgRESTError(400, 'PGRST108', message, null,
    `Verify that '${resource}' is included in the 'select' query parameter.`);
}

function parseEmbedToken(token) {
  let alias = null;
  let remainder = token;
  let spread = false;

  if (remainder.startsWith('...')) {
    spread = true;
    remainder = remainder.slice(3).trim();
  }

  const colonIdx = remainder.indexOf(':');
  if (colonIdx !== -1) {
    alias = remainder.slice(0, colonIdx).trim();
    remainder = remainder.slice(colonIdx + 1).trim();
  }

  if (alias) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(alias)) {
      throw new PostgRESTError(400, 'PGRST100',
        `'${alias}' is not a valid identifier for an alias`);
    }
  }

  const parts = remainder.split('!');
  const name = parts[0].trim();
  let hint = null;
  let inner = false;

  // Upstream `pEmbedParam` (ApiRequest/QueryParams.hs:601) recognises exactly
  // two reserved words after a '!' — `left` and `inner` — and treats anything
  // else as a disambiguation hint. `!left` is the explicit spelling of the
  // default join, so it must not be mistaken for a hint named "left": that made
  // `?select=*,clients!left(*)` look for a relationship called "left" and
  // answer PGRST200. Where both a hint and a join type appear, upstream keeps
  // the first of each (`embedParamHint prm1 <|> embedParamHint prm2`).
  for (let j = 1; j < parts.length; j++) {
    const seg = parts[j].trim();
    if (seg === 'inner') {
      inner = true;
    } else if (seg === 'left') {
      inner = false;
    } else if (hint === null) {
      hint = seg;
    }
  }

  return { name, alias, hint, inner, spread };
}

export function parseQuery(
    params, method, multiValueParams,
    maxEmbedDepth = DEFAULT_MAX_EMBED_DEPTH, options = {}) {
  params = params || {};
  // `rpcRead` is upstream's `isRpcRead` (QueryParams.parse): on a GET to
  // /rpc/fn a query parameter that does not parse as an operator expression is
  // not an error, it is an argument to the function. `?id=5&id=gt.2` is both —
  // the argument id=5 and the filter id>2 — which is why the two are collected
  // side by side here rather than the key being classified once.
  const rpcRead = Boolean(options.rpcRead);
  const rpcArgs = [];

  const select = params.select
    ? parseSelectList(params.select, maxEmbedDepth)
    : [{ type: 'column', name: '*' }];

  const embedMap = buildEmbedAliasMap(select);

  const filters = [];
  const processedKeys = new Set();

  if (multiValueParams) {
    for (const key of ['or', 'and', 'not.or', 'not.and']) {
      const values = multiValueParams[key];
      if (Array.isArray(values) && values.length > 1) {
        let logicalOp, negate = false;
        if (LOGICAL_OPS.has(key)) {
          logicalOp = key;
        } else {
          logicalOp = key.slice(4);
          negate = true;
        }
        for (const val of values) {
          filters.push(parseLogicalGroup(logicalOp, negate, val));
        }
        processedKeys.add(key);
      }
    }
  }

  for (const [key, rawValue] of Object.entries(params)) {
    if (RESERVED_PARAMS.has(key)) continue;
    if (processedKeys.has(key)) continue;

    let logicalOp = null;
    let negate = false;

    if (LOGICAL_OPS.has(key)) {
      logicalOp = key;
    } else if (key.startsWith('not.')) {
      const rest = key.slice(4);
      if (LOGICAL_OPS.has(rest)) {
        logicalOp = rest;
        negate = true;
      }
    }

    if (logicalOp) {
      filters.push(parseLogicalGroup(logicalOp, negate, rawValue));
    } else {
      // A column can appear more than once — `?id=gt.5&id=lt.11` is upstream's
      // documented way to write a range, and every pair becomes its own ANDed
      // predicate (QueryParams.hs folds the whole query string into a list, it
      // does not key it by column). API Gateway's single-valued
      // `queryStringParameters` keeps only the last occurrence, so the earlier
      // filters were silently dropped and `gt.5` never reached the SQL.
      const repeated = multiValueParams?.[key];
      const rawValues = Array.isArray(repeated) && repeated.length > 1
        ? repeated
        : [rawValue];

      const split = embedPathSplit(key);
      if (split) {
        const { prefix, rest } = split;
        const embedNode = embedMap.get(prefix);
        if (embedNode) {
          for (const v of rawValues) {
            routeEmbedParam(embedNode, prefix, rest, v);
          }
          continue;
        }
        // Upstream errors whether or not anything is embedded: the key names a
        // path into the read plan tree, and there is no node at it
        // (QuerySpec.hs:528 asks for `select=*&non_existent_projects.name=...`
        // with no embed in the select at all and expects PGRST108). The one
        // exception is a function call, where an unrecognised parameter whose
        // value is not an operator expression is an argument, not a filter.
        if (!(rpcRead && rawValues.every(v => isRpcArgValue(v)))) {
          throw notEmbeddedError(prefix, select);
        }
      }
      for (const v of rawValues) {
        if (rpcRead && isRpcArgValue(v)) {
          rpcArgs.push([key, v]);
          continue;
        }
        filters.push(parseFilter(key, v));
      }
    }
  }

  const order = params.order ? parseOrder(params.order) : [];

  const limit = params.limit != null ? parseInt(params.limit, 10) : null;
  const offset = params.offset != null ? parseInt(params.offset, 10) : 0;

  const onConflict = params.on_conflict || null;

  // `?columns=` absent and `?columns=` present-but-empty are different
  // requests: upstream parses the parameter with `pRequestColumns` and an
  // empty value is a parse error, not "no columns".
  const columns = params.columns == null
    ? null
    : parseColumnsParam(params.columns);

  rewriteEmbedNulls(select, filters);

  const parsed = {
    select, filters, order, limit, offset, onConflict, columns,
  };
  if (rpcRead) parsed.rpcArgs = rpcArgs;
  return parsed;
}

/**
 * Is this query-parameter value a function argument rather than a filter?
 *
 * Upstream writes it as `pOpExpr pSingleVal <|> pure (NoOpExpr v)`, and
 * Parsec's `<|>` only reaches the second alternative when the first failed
 * *without consuming input*. So `5` is an argument, `gt.2` is a filter, and
 * `is.blah` is neither — it consumed `is.` and stays a parse error.
 */
export function isRpcArgValue(raw) {
  // `?col=not_null` is a pgrest-lambda shorthand parseFilter answers directly;
  // keep it a filter here too.
  if (raw === 'not_null') return false;
  const sc = new Scanner(raw);
  const opExpr = pOpExpr(sc, pSingleVal);
  return opExpr === FAIL && sc.pos === 0;
}

// --- Query-string grammar --------------------------------------------------
//
// Ported from upstream's Parsec grammar in
// PostgREST.ApiRequest.QueryParams (`pOpExpr`, `pLogicTree`, `pListVal`,
// `pFieldName`). The port is deliberately literal: the operator table, the
// order the alternatives are tried in, where whitespace is allowed, and
// where a quoted list element ends are all observable through the API.
//
// Upstream's PGRST100 body is a rendering of the Parsec error — `message`
// is the source position, `details` the "unexpected ... expecting ..."
// line — so the scanner also tracks the furthest position it reached and
// the labels of every alternative that failed there.

const FAIL = Symbol('parse-fail');

// Upstream `pIdentifierChar`: letter | digit | one of "_ $". The space is
// deliberate: `pIdentifier` strips the result afterwards, which is what
// makes `or=(id.eq.1, id.eq.2)` legal.
const IDENT_CHAR = /[\p{L}0-9_ $]/u;

const LBL_FIELD_NAME = 'field name (* or [a..z0..9_$])';
const LBL_OPERATOR = 'operator (eq, gt, ...)';
const LBL_LOGIC_NOT = 'negation operator (not)';
const LBL_LOGIC_OP = 'logic operator (and, or)';
const LBL_IS_VAL = 'isVal: (null, not_null, true, false, unknown)';
const LBL_DELIMITER = 'delimiter (.)';

class Scanner {
  constructor(src) {
    this.src = src;
    this.pos = 0;
    this.failPos = -1;
    this.failExpecting = [];
    this.failToken = undefined;
    this.failTokenStyle = 'string';
  }

  get done() { return this.pos >= this.src.length; }

  // Record that `label` was acceptable at `pos` but not found, together
  // with the input token that was there instead. Only the furthest
  // position is kept, the way Parsec's `mergeError` discards the error of
  // an alternative that did not get as far.
  //
  // `style` is how Parsec renders that token: `string`/`tokens` shows a
  // Haskell String (`"t"`), while `char` and `eof` show a Char (`'t'`).
  // Only the parser that records the furthest failure decides, so this is
  // set on the same branch that takes over the position.
  expect(pos, label, token, style = 'string') {
    if (pos > this.failPos) {
      this.failPos = pos;
      this.failExpecting = [];
      this.failToken = token === undefined ? this.src[pos] : token;
      this.failTokenStyle = style;
    }
    if (pos !== this.failPos) return;
    if (label !== null && !this.failExpecting.includes(label)) {
      this.failExpecting.push(label);
    }
  }

  snapshot() {
    return {
      failPos: this.failPos,
      failExpecting: this.failExpecting.slice(),
      failToken: this.failToken,
      failTokenStyle: this.failTokenStyle,
    };
  }

  // Upstream `<?>`: when a parser fails, or succeeds, *without consuming
  // input*, the expectations it collected are replaced by a single label.
  // The position and the offending token are kept — that is why
  // `fts().value` reports column 5 and `unexpected ")"` while still
  // saying `expecting operator (eq, gt, ...)`.
  relabel(snap, label) {
    const attemptPos = this.failPos;
    const attemptToken = this.failToken;
    const attemptStyle = this.failTokenStyle;
    this.failPos = snap.failPos;
    this.failExpecting = snap.failExpecting;
    this.failToken = snap.failToken;
    this.failTokenStyle = snap.failTokenStyle;
    this.expect(attemptPos, label, attemptToken, attemptStyle);
  }

  labelled(label, fn) {
    const startPos = this.pos;
    const snap = this.snapshot();
    const result = fn();
    if (result === FAIL && this.pos === startPos) this.relabel(snap, label);
    return result;
  }

  // `<?>` again, but scoped to the failure `fn` itself produced.
  //
  // `labelled` merges into whatever the furthest failure so far was, which
  // is wrong when a *sibling* alternative already failed further along:
  // Parsec relabels the error of one parser, and `mergeError` then keeps
  // the furthest of the two. `?select=data->>--34` is the case that tells
  // them apart — the index branch fails at the second '-' expecting a
  // digit, the key branch fails one character earlier, and upstream
  // reports only `expecting digit`.
  labelledOwn(label, fn) {
    const startPos = this.pos;
    const outer = this.snapshot();
    this.failPos = -1;
    this.failExpecting = [];
    this.failToken = undefined;
    this.failTokenStyle = 'string';
    const result = fn();
    const inner = this.snapshot();
    this.failPos = outer.failPos;
    this.failExpecting = outer.failExpecting;
    this.failToken = outer.failToken;
    this.failTokenStyle = outer.failTokenStyle;
    if (inner.failPos < 0) {
      // nothing to merge
    } else if (result === FAIL && this.pos === startPos) {
      // Empty failure: the label replaces the collected expectations.
      this.expect(inner.failPos, label, inner.failToken, inner.failTokenStyle);
    } else {
      for (const l of inner.failExpecting) {
        this.expect(inner.failPos, l, inner.failToken, inner.failTokenStyle);
      }
      if (inner.failExpecting.length === 0) {
        this.expect(inner.failPos, null, inner.failToken, inner.failTokenStyle);
      }
    }
    return result;
  }

  // `string s`: Parsec's `tokens` reports the failure at the position the
  // literal started at, but names the character where the comparison
  // stopped as the unexpected one.
  literal(s) {
    if (this.src.startsWith(s, this.pos)) {
      this.pos += s.length;
      return true;
    }
    let i = 0;
    while (i < s.length && this.src[this.pos + i] === s[i]) i += 1;
    this.expect(this.pos, JSON.stringify(s), this.src[this.pos + i]);
    return false;
  }

  char(c) {
    if (this.src[this.pos] === c) {
      this.pos += 1;
      return true;
    }
    this.expect(this.pos, JSON.stringify(c));
    return false;
  }

  // Upstream `ws`: spaces and tabs only.
  ws() {
    while (this.src[this.pos] === ' ' || this.src[this.pos] === '\t') {
      this.pos += 1;
    }
  }

  // Upstream `lexeme p`: ws *> p <* ws.
  lexemeChar(c) {
    const start = this.pos;
    this.ws();
    if (!this.char(c)) {
      this.pos = start;
      return false;
    }
    this.ws();
    return true;
  }
}

function commasOr(labels) {
  if (labels.length === 0) return 'unknown parse error';
  if (labels.length === 1) return labels[0];
  return `${labels.slice(0, -1).join(', ')} or ${labels[labels.length - 1]}`;
}

// Parsec shows the offending token as a Haskell String, so one
// double-quoted character; past the end of the input it says
// "end of input" instead.
function unexpectedAt(sc) {
  if (sc.failToken === undefined) return 'end of input';
  // `show` on a Char is single-quoted; on a String it is double-quoted.
  if (sc.failTokenStyle === 'char') return `'${sc.failToken}'`;
  return JSON.stringify(sc.failToken);
}

// Upstream `mapError`: message is `show (errorPos e)`, which prints the
// source name Parsec was given followed by the position.
function qpError(what, raw, sc) {
  return new PostgRESTError(
    400, 'PGRST100',
    `"failed to parse ${what} (${raw})" (line 1, column `
    + `${Math.max(sc.failPos, 0) + 1})`,
    `unexpected ${unexpectedAt(sc)} `
    + `expecting ${commasOr(sc.failExpecting)}`,
  );
}

// Upstream `pDelimiter`: char '.' <?> "delimiter (.)".
function pDelimiter(sc) {
  return sc.labelled(LBL_DELIMITER, () => (sc.char('.') ? true : FAIL))
    !== FAIL;
}

// Upstream `pNot`: try (string "not" *> pDelimiter) <|> pure False, then
// `<?>`. Because the alternation succeeds without consuming input when
// there is no `not.`, the label replaces whatever the failed attempt
// expected — a plain `pure` still contributes its label to the error.
function pNotPrefix(sc, label) {
  const start = sc.pos;
  const snap = sc.snapshot();
  if (sc.literal('not') && pDelimiter(sc)) return true;
  sc.pos = start;
  if (label === null) return false;
  sc.relabel(snap, label);
  return false;
}

// Upstream `pQuotedValue`: char '"' *> many (noneOf "\\\"" | '\\' *> any)
// <* char '"'. A backslash escapes the next character, whatever it is.
function pQuotedValue(sc) {
  const start = sc.pos;
  if (!sc.char('"')) return FAIL;
  let out = '';
  for (;;) {
    const ch = sc.src[sc.pos];
    if (ch === undefined) {
      sc.expect(sc.pos, '"\\""');
      sc.pos = start;
      return FAIL;
    }
    if (ch === '"') { sc.pos += 1; return out; }
    if (ch === '\\') {
      const next = sc.src[sc.pos + 1];
      if (next === undefined) {
        sc.expect(sc.pos + 1, 'any character');
        sc.pos = start;
        return FAIL;
      }
      out += next;
      sc.pos += 2;
      continue;
    }
    out += ch;
    sc.pos += 1;
  }
}

// Upstream `pIdentifier`: many1 pIdentifierChar, stripped.
function pIdentifier(sc) {
  const start = sc.pos;
  while (sc.pos < sc.src.length && IDENT_CHAR.test(sc.src[sc.pos])) {
    sc.pos += 1;
  }
  if (sc.pos === start) {
    sc.expect(start, 'letter, digit, "_", " " or "$"');
    return FAIL;
  }
  return sc.src.slice(start, sc.pos).trim();
}

// Upstream `pFieldName`: a quoted value, or identifiers joined by dashes
// that are not the start of a `->` json arrow.
function pFieldName(sc) {
  return sc.labelled(LBL_FIELD_NAME, () => {
    const start = sc.pos;
    const quoted = pQuotedValue(sc);
    if (quoted !== FAIL) return quoted;
    const parts = [];
    for (;;) {
      const id = pIdentifier(sc);
      if (id === FAIL) {
        sc.pos = start;
        return FAIL;
      }
      parts.push(id);
      if (sc.src[sc.pos] === '-' && sc.src[sc.pos + 1] !== '>') {
        sc.pos += 1;
        continue;
      }
      return parts.join('-');
    }
  });
}

// Upstream `pRequestColumns`: `P.parse pColumns "failed to parse columns
// parameter (<raw>)" raw`, where `pColumns = pFieldName `sepBy1` lexeme
// (char ',')`. There is no `eof`, so trailing garbage after the last field
// upstream could parse is ignored — but an *empty* value has no first field at
// all, which is why `?columns=` is a PGRST100 parse error and not "no columns".
//
// @param {string} raw the raw `?columns=` value (present, possibly empty)
// @returns {string[]} the field names, quotes stripped
export function parseColumnsParam(raw) {
  const src = String(raw);
  const sc = new Scanner(src);
  const cols = [];
  for (;;) {
    const name = pFieldName(sc);
    // `sepBy1` has consumed the separator by the time it asks for this field,
    // so a failure here fails the whole parse — `a,` and `a,,b` are errors.
    if (name === FAIL) throw qpError('columns parameter', src, sc);
    cols.push(name);
    if (!sc.lexemeChar(',')) break;
  }
  return cols;
}

// --- JSON path -------------------------------------------------------------
//
// Upstream `pJsonPath`: `many (pJsonArrow <*> pJsonOperand)`, where the
// operand is an array index (optionally negative, and only when the next
// thing is `->`, `::`, `.`, `,` or the end of the input) or an object key.
// A key is the widest possible thing: any run of characters that are not
// one of `(-:.,>)`, with single dashes allowed inside it as long as they
// are not the start of another arrow. That is what makes
// `data->!@#$%^&*_d` and `data->23-xy-45` legal.

const LBL_JSON_KEY = 'any non reserved character different from: .,>()';

// Upstream `pJsonKeyIdentifier`: many1 (noneOf "(-:.,>)"), stripped.
function pJsonKeyIdentifier(sc) {
  const start = sc.pos;
  while (sc.pos < sc.src.length) {
    const ch = sc.src[sc.pos];
    if (ch === '(' || ch === '-' || ch === ':' || ch === '.'
        || ch === ',' || ch === '>' || ch === ')') break;
    sc.pos += 1;
  }
  if (sc.pos === start) {
    // `noneOf` is a bare `satisfy`: it names the offending character but
    // has no expectation of its own.
    sc.expect(start, null);
    return FAIL;
  }
  return sc.src.slice(start, sc.pos).trim();
}

// Upstream `pJsonKeyName`: pQuotedValue <|> sepByDash pJsonKeyIdentifier,
// relabelled as a whole (`<?>` is the loosest-binding operator).
function pJsonKeyName(sc) {
  return sc.labelledOwn(LBL_JSON_KEY, () => {
    const start = sc.pos;
    const quoted = pQuotedValue(sc);
    if (quoted !== FAIL) return quoted;
    sc.pos = start;
    const parts = [];
    for (;;) {
      const id = pJsonKeyIdentifier(sc);
      if (id === FAIL) {
        // The first identifier failing is an empty failure, so the label
        // applies; a later one has consumed the dash before it, which is
        // a consuming failure the caller's `try` undoes.
        if (parts.length === 0) sc.pos = start;
        return FAIL;
      }
      parts.push(id);
      if (sc.src[sc.pos] === '-' && sc.src[sc.pos + 1] !== '>') {
        sc.pos += 1;
        continue;
      }
      return parts.join('-');
    }
  });
}

// Upstream `pJIdx`: `option '+' (char '-')`, digits, then a lookahead that
// stops a key like `-78xy` from being read as the index -78.
function pJIdx(sc) {
  const start = sc.pos;
  let sign = '+';
  if (sc.src[sc.pos] === '-') {
    sign = '-';
    sc.pos += 1;
  } else {
    sc.expect(sc.pos, '"-"');
  }
  const digitStart = sc.pos;
  while (sc.pos < sc.src.length && sc.src[sc.pos] >= '0'
      && sc.src[sc.pos] <= '9') {
    sc.pos += 1;
  }
  if (sc.pos === digitStart) {
    sc.expect(digitStart, 'digit');
    sc.pos = start;
    return FAIL;
  }
  const digits = sc.src.slice(digitStart, sc.pos);
  // `many1 digit` stops here wanting one more digit, and says so.
  sc.expect(sc.pos, 'digit');
  const end = sc.pos;
  const ahead = sc.src.slice(end, end + 2);
  if (!(ahead.startsWith('->') || ahead.startsWith('::')
      || ahead.startsWith('.') || ahead.startsWith(',')
      || end >= sc.src.length)) {
    for (const label of ['"->"', '"::"', '"."', '","', 'end of input']) {
      sc.expect(end, label);
    }
    sc.pos = start;
    return FAIL;
  }
  return sign + digits;
}

// Upstream `pJsonOperand`: try pJIdx <|> try pJKey.
function pJsonOperand(sc) {
  const start = sc.pos;
  const idx = pJIdx(sc);
  if (idx !== FAIL) return { kind: 'idx', value: idx };
  sc.pos = start;
  const key = pJsonKeyName(sc);
  if (key !== FAIL) return { kind: 'key', value: key };
  sc.pos = start;
  return FAIL;
}

// Upstream `pJsonPath`. Returns [] when there is no arrow at all, and FAIL
// when an arrow was consumed but no operand followed — `many` propagates a
// failure that consumed input.
function pJsonPath(sc) {
  const path = [];
  for (;;) {
    const start = sc.pos;
    let op;
    if (sc.literal('->>')) op = '->>';
    else if (sc.literal('->')) op = '->';
    else { sc.pos = start; return path; }
    const operand = pJsonOperand(sc);
    if (operand === FAIL) return FAIL;
    path.push({ op, kind: operand.kind, value: operand.value });
  }
}

// Upstream `pField`: lexeme (pFieldName, optional json path).
function pField(sc) {
  sc.ws();
  const name = pFieldName(sc);
  if (name === FAIL) return FAIL;
  const jsonPath = pJsonPath(sc);
  if (jsonPath === FAIL) return FAIL;
  sc.ws();
  return { name, jsonPath };
}

// Upstream Plan.hs `addAliases`/`lastJsonKey`: a field with a json path is
// labelled with the last key in the path. When the path ends in an index
// the label is the last key before it, and when there is none it is the
// column name — `select=data->1->mycol->>2` comes back as `mycol`,
// `select=data->3` as `data`.
function derivedJsonAlias(name, jsonPath) {
  const last = jsonPath[jsonPath.length - 1];
  if (last.kind === 'key') return last.value;
  for (let i = jsonPath.length - 1; i >= 0; i--) {
    if (jsonPath[i].kind === 'key') return jsonPath[i].value;
  }
  return name;
}

// --- Select items ----------------------------------------------------------
//
// Upstream `pFieldSelect`, in the order it tries its three alternatives:
//
//   *                                          (and nothing else)
//   [alias:]count()[::cast]
//   [alias:]field[jsonpath][::cast][.agg()][::cast]
//
// The bare `count()` alternative exists because the aggregate has no field
// of its own; upstream models it as an aggregate over `*`.

const AGG_FUNCTIONS = ['sum', 'avg', 'count', 'max', 'min'];

// Upstream `pEnd` for a select item: `)`, `,` or end of input. The token
// boundary the tokenizer already found is that position, so reaching it —
// modulo the trailing whitespace `lexeme` allows — is what "ended" means.
function pSelectEnd(sc, tokenEnd) {
  const start = sc.pos;
  sc.ws();
  if (sc.pos === tokenEnd) return true;
  for (const label of ['")"', '","', 'end of input']) {
    sc.expect(sc.pos, label);
  }
  sc.pos = start;
  return false;
}

// Upstream `optionMaybe (try (pFieldName <* aliasSeparator))`, where
// `aliasSeparator` is a ':' not followed by another ':' — that is what
// keeps `col::text` from being read as the alias `col`.
function pOptAlias(sc) {
  const start = sc.pos;
  const name = pFieldName(sc);
  if (name !== FAIL) {
    if (sc.src[sc.pos] === ':' && sc.src[sc.pos + 1] !== ':') {
      sc.pos += 1;
      return name;
    }
    sc.expect(sc.pos, '":"');
  }
  sc.pos = start;
  return null;
}

// Upstream `optionMaybe (string "::" *> pIdentifier)`. There is no `try`,
// so a `::` with nothing usable after it fails the whole item; pgrest-lambda
// names that mistake instead of reporting a parse position.
function pOptCast(sc) {
  const start = sc.pos;
  if (!sc.literal('::')) { sc.pos = start; return null; }
  const id = pIdentifier(sc);
  if (id === FAIL) {
    throw new PostgRESTError(400, 'PGRST100',
      "Empty cast type after '::'");
  }
  return id;
}

function pAggregation(sc) {
  for (const fn of AGG_FUNCTIONS) {
    if (sc.literal(fn)) return fn;
  }
  return FAIL;
}

// Upstream `optionMaybe (try (char '.' *> pAggregation <* string "()"))`.
function pOptAggregate(sc) {
  const start = sc.pos;
  if (!sc.char('.')) { sc.pos = start; return null; }
  const fn = pAggregation(sc);
  if (fn === FAIL || !sc.literal('()')) { sc.pos = start; return null; }
  return fn;
}

// A cast type is any identifier: upstream parses it with `pIdentifier` and
// renders it into `CAST( x AS <type> )` unquoted, so PostgreSQL is what
// decides whether the type exists (42704 `type "..." does not exist`). An
// allowlist here would reject every domain, enum and composite type a user
// defines, so there is none.
//
// The cast is the one piece of a query that cannot be a bind parameter — a
// type name is not a value. What makes interpolating it safe is the charset:
// `pIdentifier` accepts only letters, digits, `_`, ` ` and `$`, so a cast can
// contain no quote, semicolon, parenthesis or comment marker and cannot
// escape the CAST expression. This is the check that turns a malformed cast
// into PGRST100 for the client; the same charset is re-checked in
// sql-builder.mjs `castExpr`, at the point the string becomes SQL, so the
// guarantee does not rest on this parser staying the only writer of `.cast`.
const CAST_TYPE_CHARS = /^[\p{L}0-9_ $]+$/u;

function checkCast(cast) {
  const type = cast.toLowerCase();
  // Unquoted type names are case-folded by PostgreSQL, so lowercasing here
  // is not a behaviour change; it only keeps one spelling in the plan.
  if (!CAST_TYPE_CHARS.test(type)) {
    throw new PostgRESTError(400, 'PGRST100',
      `Unsupported cast type '${cast}'`);
  }
  return type;
}

function pFieldSelect(sc, tokenEnd) {
  sc.ws();
  const start = sc.pos;

  // `*` on its own.
  if (sc.literal('*') && pSelectEnd(sc, tokenEnd)) {
    return { type: 'column', name: '*' };
  }
  sc.pos = start;

  // count() — an aggregate with no field.
  const countAlias = pOptAlias(sc);
  if (sc.literal('count()')) {
    const aggCast = pOptCast(sc);
    if (pSelectEnd(sc, tokenEnd)) {
      return {
        type: 'column', name: '*', agg: 'count',
        alias: countAlias, aggCast,
      };
    }
  }
  sc.pos = start;

  const alias = pOptAlias(sc);
  const field = pField(sc);
  if (field === FAIL) return FAIL;
  const cast = pOptCast(sc);
  const agg = pOptAggregate(sc);
  const aggCast = pOptCast(sc);
  if (!pSelectEnd(sc, tokenEnd)) return FAIL;
  if (aggCast !== null && agg === null) {
    // Upstream drops the second cast on the floor (`pgFmtApplyAggregate`
    // ignores its cast when there is no aggregate). Rejecting it keeps the
    // engine's long-standing "no double cast" error.
    throw new PostgRESTError(400, 'PGRST100',
      `Unsupported cast type '${cast}::${aggCast}'`);
  }
  return {
    type: 'column', name: field.name, jsonPath: field.jsonPath,
    alias, cast, agg, aggCast,
  };
}

// Parse one select item out of `source` between two absolute offsets, and
// turn it into a select node. Positions stay absolute so that a parse error
// reports the column upstream reports.
function parseFieldSelect(source, from, to) {
  const sc = new Scanner(source);
  sc.pos = from;
  const item = pFieldSelect(sc, to);
  if (item === FAIL) throw qpError('select parameter', source, sc);

  const node = { type: 'column', name: item.name };
  const jsonPath = item.jsonPath && item.jsonPath.length > 0
    ? item.jsonPath
    : null;
  let alias = item.alias;
  if (alias !== null && alias !== undefined) {
    if (!ALIAS_IDENT.test(alias)) {
      throw new PostgRESTError(400, 'PGRST100',
        `'${alias}' is not a valid identifier for an alias`);
    }
  } else if (item.agg) {
    // PostgreSQL labels an unaliased aggregate with the function name, so
    // that is the JSON key upstream returns.
    alias = item.agg;
  } else if (jsonPath) {
    alias = derivedJsonAlias(item.name, jsonPath);
  } else {
    alias = null;
  }

  if (jsonPath) node.jsonPath = jsonPath;
  if (alias !== null) node.alias = alias;
  if (item.cast) node.cast = checkCast(item.cast);
  if (item.agg) node.agg = item.agg;
  if (item.aggCast) node.aggCast = checkCast(item.aggCast);
  return node;
}

// Upstream `pListElement`: a quoted value that is followed by nothing but
// a delimiter, else everything up to the next ',' or ')'.
function pListElement(sc) {
  const start = sc.pos;
  const quoted = pQuotedValue(sc);
  if (quoted !== FAIL) {
    const after = sc.src[sc.pos];
    if (after === undefined || after === ',' || after === ')') return quoted;
    sc.pos = start;
  }
  let out = '';
  while (sc.pos < sc.src.length
      && sc.src[sc.pos] !== ',' && sc.src[sc.pos] !== ')') {
    out += sc.src[sc.pos];
    sc.pos += 1;
  }
  return out;
}

// Upstream `pListVal`: lexeme '(' *> pListElement `sepBy1` ',' <* lexeme ')'.
function pListVal(sc) {
  const start = sc.pos;
  if (!sc.lexemeChar('(')) { sc.pos = start; return FAIL; }
  const elements = [pListElement(sc)];
  while (sc.src[sc.pos] === ',') {
    sc.pos += 1;
    elements.push(pListElement(sc));
  }
  if (!sc.lexemeChar(')')) { sc.pos = start; return FAIL; }
  return elements;
}

// Upstream `pSingleVal`: the whole remaining input.
function pSingleVal(sc) {
  const out = sc.src.slice(sc.pos);
  sc.pos = sc.src.length;
  return out;
}

// Upstream `pLogicSingleVal`: a quoted value, a `{...}` array literal, or
// everything up to the next ',' or ')'.
function pLogicSingleVal(sc) {
  const start = sc.pos;
  const quoted = pQuotedValue(sc);
  if (quoted !== FAIL) {
    const after = sc.src[sc.pos];
    if (after === undefined || after === ',' || after === ')') return quoted;
    sc.pos = start;
  }
  if (sc.src[sc.pos] === '{') {
    const close = sc.src.indexOf('}', sc.pos + 1);
    const inner = close === -1
      ? null
      : sc.src.slice(sc.pos + 1, close);
    if (inner !== null && !inner.includes('{')) {
      sc.pos = close + 1;
      return `{${inner}}`;
    }
  }
  let out = '';
  while (sc.pos < sc.src.length
      && sc.src[sc.pos] !== ',' && sc.src[sc.pos] !== ')') {
    out += sc.src[sc.pos];
    sc.pos += 1;
  }
  return out;
}

function matchOneOf(sc, tokens) {
  for (const token of tokens) {
    if (sc.literal(token)) return token;
  }
  return FAIL;
}

// Upstream `pOpExpr`: optional `not.`, then one operation. `valueParser`
// is `pSingleVal` for a plain filter and `pLogicSingleVal` inside and()/or().
function pOpExpr(sc, valueParser) {
  // No `<?>` here, which is why an unparsable filter lists `"not"`
  // alongside the operator label in its `details`.
  const negate = pNotPrefix(sc, null);
  const operation = sc.labelled(LBL_OPERATOR,
    () => pOperation(sc, valueParser));
  if (operation === FAIL) return FAIL;
  return { negate, ...operation };
}

function pOperation(sc, valueParser) {
  const start = sc.pos;

  // in.(a,b) — once `in.` is consumed the failure is not recoverable,
  // exactly as upstream's `pIn` has no outer `try`.
  if (sc.literal('in') && pDelimiter(sc)) {
    const list = pListVal(sc);
    if (list === FAIL) return FAIL;
    return { operator: 'in', value: list };
  }
  sc.pos = start;

  // is.null / is.not_null / is.true / is.false / is.unknown
  if (sc.literal('is') && pDelimiter(sc)) {
    const word = sc.labelled(LBL_IS_VAL, () => pIsVal(sc));
    if (word === FAIL) return FAIL;
    return { operator: 'is', value: word };
  }
  sc.pos = start;

  // isdistinct.value
  if (sc.literal('isdistinct') && pDelimiter(sc)) {
    return { operator: 'isdistinct', value: valueParser(sc) };
  }
  sc.pos = start;

  // fts / plfts / phfts / wfts, with an optional text search config
  const fts = matchOneOf(sc, FTS_OPERATORS);
  if (fts !== FAIL) {
    const lang = pParenthesized(sc, () => pIdentifier(sc));
    if (!pDelimiter(sc)) { sc.pos = start; return FAIL; }
    const node = { operator: fts, value: valueParser(sc) };
    if (lang !== null) node.ftsLang = lang;
    return node;
  }
  sc.pos = start;

  // Single-value operators: no quantifier, and no `*` to `%` rewrite.
  const simple = matchOneOf(sc, SIMPLE_OPERATORS);
  if (simple !== FAIL) {
    if (!pDelimiter(sc)) { sc.pos = start; return FAIL; }
    return { operator: simple, value: valueParser(sc) };
  }
  sc.pos = start;

  // Quantifiable operators, optionally `(any)` or `(all)`.
  const quant = matchOneOf(sc, QUANT_OPERATORS);
  if (quant !== FAIL) {
    const quantifier = pParenthesized(sc,
      () => matchOneOf(sc, ['any', 'all']));
    if (!pDelimiter(sc)) { sc.pos = start; return FAIL; }
    let value = valueParser(sc);
    // Upstream rewrites `*` to `%` when emitting SQL for LIKE/ILIKE
    // (`SqlFragment.star`); doing it here keeps the filter node the thing
    // the SQL builder can use verbatim.
    if (quant === 'like' || quant === 'ilike') {
      value = value.replaceAll('*', '%');
    }
    const node = { operator: quant, value };
    if (quantifier !== null) node.quantifier = quantifier;
    return node;
  }
  sc.pos = start;
  return FAIL;
}

// Upstream `pIsVal`: the five keywords, matched case-insensitively, each
// behind its own `try`.
function pIsVal(sc) {
  for (const word of VALID_IS_VALUES) {
    const slice = sc.src.slice(sc.pos, sc.pos + word.length);
    if (slice.toLowerCase() === word) {
      sc.pos += word.length;
      return word;
    }
    sc.expect(sc.pos, JSON.stringify(word));
  }
  return FAIL;
}

// Upstream `optionMaybe $ try (between (char '(') (char ')') p)`: absent
// is not an error, and a malformed group makes the whole optional group
// vanish rather than failing the operator.
function pParenthesized(sc, p) {
  const start = sc.pos;
  if (!sc.char('(')) { sc.pos = start; return null; }
  const inner = p();
  if (inner === FAIL || !sc.char(')')) { sc.pos = start; return null; }
  return inner;
}

// Upstream `pTreePath` parses the parameter *name* as field names joined by
// dots with an optional json path on the last one, so `?data->foo->>bar=eq.x`
// filters on a json path. The dot-splitting for embedded filters has already
// happened by the time this runs; what is left is one field name.
function splitFilterKey(key) {
  if (key.startsWith('"')) {
    // The name upstream filters on is what `pFieldName` returns, so a quoted
    // parameter name is the column *inside* the quotes — that is how
    // `?"*id*"=eq.1` filters on a column whose name contains characters
    // PostgREST reserves (QuerySpec:1291).
    const sc = new Scanner(key);
    const name = pQuotedValue(sc);
    if (name !== FAIL) {
      if (sc.done) return { column: name, jsonPath: null };
      const jsonPath = pJsonPath(sc);
      if (jsonPath !== FAIL && jsonPath.length > 0 && sc.done) {
        return { column: name, jsonPath };
      }
    }
  }
  if (!key.includes('->')) return { column: key, jsonPath: null };
  const sc = new Scanner(key);
  const name = pFieldName(sc);
  if (name === FAIL) return { column: key, jsonPath: null };
  const jsonPath = pJsonPath(sc);
  if (jsonPath === FAIL || jsonPath.length === 0 || !sc.done) {
    return { column: key, jsonPath: null };
  }
  return { column: name, jsonPath };
}

function parseFilter(key, raw) {
  const { column, jsonPath } = splitFilterKey(key);

  // pgrest-lambda extension, kept for backwards compatibility:
  // `?col=not_null` is shorthand for `?col=not.is.null`.
  if (raw === 'not_null') {
    const shorthand = {
      type: 'filter', column, operator: 'is',
      value: 'null', negate: true,
    };
    if (jsonPath) shorthand.jsonPath = jsonPath;
    return shorthand;
  }

  const sc = new Scanner(raw);
  const opExpr = pOpExpr(sc, pSingleVal);
  if (opExpr === FAIL) throw qpError('filter', raw, sc);
  const filter = { type: 'filter', column, ...opExpr };
  if (jsonPath) filter.jsonPath = jsonPath;
  return filter;
}

// Upstream `pLogicTree`:
//   Stmnt <$> try pLogicFilter
//   <|> Expr <$> pNot <*> pLogicOp
//            <*> (lexeme '(' *> pLogicTree `sepBy1` lexeme ',' <* lexeme ')')
function pLogicTree(sc, depth) {
  if (depth > MAX_NESTING_DEPTH) {
    throw new PostgRESTError(400, 'PGRST100',
      'Logical operator nesting exceeds maximum '
      + `depth of ${MAX_NESTING_DEPTH}`);
  }

  const start = sc.pos;

  // try pLogicFilter — a leaf wins over the and()/or() branch, which is
  // what makes a column called `and_starting_col` parse as a filter.
  const field = pField(sc);
  if (field !== FAIL && pDelimiter(sc)) {
    const opExpr = pOpExpr(sc, pLogicSingleVal);
    if (opExpr !== FAIL) {
      const leaf = { type: 'filter', column: field.name, ...opExpr };
      if (field.jsonPath.length > 0) leaf.jsonPath = field.jsonPath;
      return leaf;
    }
  }
  sc.pos = start;

  // Expr: pNot, a logic operator, then a parenthesised list of subtrees.
  const negate = pNotPrefix(sc, LBL_LOGIC_NOT);

  const logicalOp = sc.labelled(LBL_LOGIC_OP,
    () => matchOneOf(sc, [...LOGICAL_OPS]));
  if (logicalOp === FAIL) { sc.pos = start; return FAIL; }
  if (!sc.lexemeChar('(')) { sc.pos = start; return FAIL; }

  const conditions = [];
  for (;;) {
    const child = pLogicTree(sc, depth + 1);
    if (child === FAIL) { sc.pos = start; return FAIL; }
    conditions.push(child);
    const beforeComma = sc.pos;
    if (!sc.lexemeChar(',')) { sc.pos = beforeComma; break; }
  }
  if (!sc.lexemeChar(')')) { sc.pos = start; return FAIL; }

  return { type: 'logicalGroup', logicalOp, negate, conditions };
}

// Upstream concatenates the parameter name and value so the tree is
// regular: `?and=(a,b)` is parsed as `and(a,b)` and `?not.or=(a,b)` as
// `not.or(a,b)`. Parsec's `parse` does not require end of input, so
// trailing junk after the closing paren is ignored — `and=(a,b))` is a
// 200 upstream, not a parse error.
function parseLogicalGroup(op, negate, raw, depth = 0) {
  const prefix = negate ? `not.${op}` : op;
  const sc = new Scanner(prefix + raw);
  const tree = pLogicTree(sc, depth);
  if (tree === FAIL) throw qpError('logic tree', raw, sc);
  return tree;
}

// Upstream `pOrder`:
//
//   pOrder = lexeme (try pOrderRelationTerm <|> pOrderTerm) `sepBy1` char ','
//   pOrderTerm         = pField      *> optionMaybe pOrdDir *> nulls *> pEnd
//   pOrderRelationTerm = pFieldName  *> "(" pField ")"
//                                    *> optionMaybe pOrdDir *> nulls *> pEnd
//   pOrdDir = try (pDelimiter *> "asc")        <|> try (pDelimiter *> "desc")
//   pNulls  = try (pDelimiter *> "nullsfirst") <|> try (pDelimiter *> "nullslast")
//   pEnd    = lookAhead (char ',') <|> eof
//
// Running it through the Scanner rather than splitting the value on '.' is
// what makes a malformed order report the position and the expectation set
// Parsec reports (QuerySpec:1174), and what lets a quoted column name
// contain a '.' or a ','.

// `pEnd`. Both halves fail through Parsec's `char`/`eof`, which render the
// offending token as a Char — `unexpected 't'`, not `unexpected "t"`.
function pOrderEnd(sc) {
  if (sc.done || sc.src[sc.pos] === ',') return true;
  sc.expect(sc.pos, '","', undefined, 'char');
  sc.expect(sc.pos, 'end of input', undefined, 'char');
  return false;
}

// `try (pDelimiter *> string w)` for each word, in order: an attempt that
// fails leaves the position where it started, so the next word sees the
// delimiter again and every word ends up in the expectation set.
function pDottedWord(sc, words) {
  const start = sc.pos;
  for (const word of words) {
    if (pDelimiter(sc) && sc.literal(word)) return word;
    sc.pos = start;
  }
  return null;
}

// `optionMaybe pOrdDir` then `optionMaybe pNulls <* pEnd <|> pEnd $> Nothing`.
// The two alternatives differ only in whether the nulls option was consumed,
// and a consumed one cannot be backtracked over, so requiring the end after
// an optional nulls option is the same parser.
function pOrderMods(sc) {
  const direction = pDottedWord(sc, ORDER_DIRECTIONS);
  const nulls = pDottedWord(sc, ORDER_NULLS);
  if (!pOrderEnd(sc)) return FAIL;
  // Upstream keeps the direction as a Maybe and omits ASC from the SQL when
  // it is absent; ASC is PostgreSQL's default, so naming it here is the same
  // ordering.
  return { direction: direction || 'asc', nulls };
}

const ORDER_DIRECTIONS = ['asc', 'desc'];
const ORDER_NULLS = ['nullsfirst', 'nullslast'];

function orderTerm(fld, mods, relation) {
  const term = relation === undefined
    ? { column: fld.name, direction: mods.direction, nulls: mods.nulls }
    : {
      relation, column: fld.name,
      direction: mods.direction, nulls: mods.nulls,
    };
  if (fld.jsonPath.length > 0) term.jsonPath = fld.jsonPath;
  return term;
}

// `order=<relation>(<field>)[.dir][.nulls]`. It orders the parent rows by a
// column of an embedded resource; a to-many one is rejected at planning
// time, not here.
function pOrderRelationTerm(sc) {
  const relation = pFieldName(sc);
  if (relation === FAIL) return FAIL;
  if (!sc.char('(')) return FAIL;
  const fld = pField(sc);
  if (fld === FAIL) return FAIL;
  if (!sc.char(')')) return FAIL;
  const mods = pOrderMods(sc);
  if (mods === FAIL) return FAIL;
  return orderTerm(fld, mods, relation);
}

// A plain term. `pField` takes the json path before the modifiers, so
// `order=data->>k.desc` sorts on the json path and not on a column called
// `data->>k`.
function pOrderTerm(sc) {
  const fld = pField(sc);
  if (fld === FAIL) return FAIL;
  const mods = pOrderMods(sc);
  if (mods === FAIL) return FAIL;
  return orderTerm(fld, mods);
}

function parseOrder(raw) {
  const sc = new Scanner(raw);
  const terms = [];
  for (;;) {
    const start = sc.pos;
    let term = pOrderRelationTerm(sc);
    if (term === FAIL) {
      sc.pos = start;
      term = pOrderTerm(sc);
    }
    if (term === FAIL) throw qpError('order', raw, sc);
    terms.push(term);
    if (!sc.char(',')) return terms;
  }
}
