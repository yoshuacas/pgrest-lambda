// query-parser.mjs — Parse PostgREST query params to structured objects

import { PostgRESTError } from './errors.mjs';

const RESERVED_PARAMS = new Set([
  'select', 'order', 'limit', 'offset', 'on_conflict',
]);

const VALID_OPERATORS = new Set([
  'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'in', 'is',
]);

const VALID_IS_VALUES = new Set(['null', 'true', 'false', 'unknown']);

export function parseSelectList(input) {
  const nodes = [];
  let i = 0;
  const len = input.length;

  while (i < len) {
    // Skip leading whitespace
    while (i < len && input[i] === ' ') i++;
    if (i >= len) break;

    // Scan token up to ',' or '(' at depth 0
    let tokenStart = i;
    let depth = 0;
    let parenStart = -1;

    while (i < len) {
      const ch = input[i];
      if (depth === 0 && ch === ',') break;
      if (ch === '(') {
        if (depth === 0) parenStart = i;
        depth++;
      } else if (ch === ')') {
        if (depth === 0) {
          throw new PostgRESTError(400, 'PGRST100',
            'Unbalanced parentheses in select parameter');
        }
        depth--;
        if (depth === 0) {
          i++; // move past closing ')'
          break;
        }
      }
      i++;
    }

    if (depth > 0) {
      throw new PostgRESTError(400, 'PGRST100',
        'Unbalanced parentheses in select parameter');
    }

    if (parenStart === -1) {
      // Plain column token
      const name = input.slice(tokenStart, i).trim();
      if (name) {
        nodes.push({ type: 'column', name });
      }
    } else {
      // Embed token: text before '(' is the embed descriptor
      const embedToken = input.slice(tokenStart, parenStart).trim();
      const innerContent = input.slice(parenStart + 1, i - 1);
      const childNodes = parseSelectList(innerContent);
      const embed = parseEmbedToken(embedToken);
      if (childNodes.length === 0) {
        throw new PostgRESTError(400, 'PGRST100',
          `Empty select list in embed '${embed.name}'`);
      }
      nodes.push({
        type: 'embed',
        name: embed.name,
        alias: embed.alias,
        hint: embed.hint,
        inner: embed.inner,
        select: childNodes,
      });
    }

    // Skip comma separator
    if (i < len && input[i] === ',') i++;
  }

  return nodes;
}

function parseEmbedToken(token) {
  let alias = null;
  let remainder = token;

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

  for (let j = 1; j < parts.length; j++) {
    const seg = parts[j].trim();
    if (seg === 'inner') {
      inner = true;
    } else {
      hint = seg;
    }
  }

  return { name, alias, hint, inner };
}

export function parseQuery(params, method) {
  params = params || {};

  const select = params.select
    ? parseSelectList(params.select)
    : [{ type: 'column', name: '*' }];

  const filters = [];
  for (const [key, rawValue] of Object.entries(params)) {
    if (RESERVED_PARAMS.has(key)) continue;
    filters.push(parseFilter(key, rawValue));
  }

  const order = params.order ? parseOrder(params.order) : [];

  const limit = params.limit != null ? parseInt(params.limit, 10) : null;
  const offset = params.offset != null ? parseInt(params.offset, 10) : 0;

  const onConflict = params.on_conflict || null;

  return { select, filters, order, limit, offset, onConflict };
}

function parseFilter(column, raw) {
  if (raw === 'not_null') {
    return { column, operator: 'is', value: 'null', negate: true };
  }

  const dotIdx = raw.indexOf('.');
  if (dotIdx === -1) {
    throw new PostgRESTError(
      400, 'PGRST100',
      `"${raw}" is not a valid filter for column "${column}"`,
    );
  }

  let prefix = raw.slice(0, dotIdx);
  let remainder = raw.slice(dotIdx + 1);
  let negate = false;

  if (prefix === 'not') {
    negate = true;
    const nextDot = remainder.indexOf('.');
    if (nextDot === -1) {
      throw new PostgRESTError(
        400, 'PGRST100',
        `"${raw}" is not a valid filter for column "${column}"`,
      );
    }
    prefix = remainder.slice(0, nextDot);
    remainder = remainder.slice(nextDot + 1);
  }

  const operator = prefix;

  if (!VALID_OPERATORS.has(operator)) {
    throw new PostgRESTError(
      400, 'PGRST100',
      `"${operator}" is not a valid filter operator`,
    );
  }

  let value = remainder;

  if (operator === 'is') {
    if (!VALID_IS_VALUES.has(value)) {
      throw new PostgRESTError(
        400, 'PGRST100',
        `"${value}" is not a valid value for is operator`,
      );
    }
  } else if (operator === 'in') {
    value = value.replace(/^\(/, '').replace(/\)$/, '');
    value = value.split(',');
  } else if (operator === 'like' || operator === 'ilike') {
    value = value.replaceAll('*', '%');
  }

  return { column, operator, value, negate };
}

function parseOrder(raw) {
  return raw.split(',').map((entry) => {
    const parts = entry.split('.');
    return {
      column: parts[0],
      direction: parts[1] || 'asc',
      nulls: parts[2] || null,
    };
  });
}
