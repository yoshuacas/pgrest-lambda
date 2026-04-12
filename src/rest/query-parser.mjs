// query-parser.mjs — Parse PostgREST query params to structured objects

import { PostgRESTError } from './errors.mjs';

const RESERVED_PARAMS = new Set([
  'select', 'order', 'limit', 'offset', 'on_conflict',
]);

const VALID_OPERATORS = new Set([
  'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'in', 'is',
]);

const VALID_IS_VALUES = new Set(['null', 'true', 'false', 'unknown']);

export function parseQuery(params, method) {
  params = params || {};

  const select = params.select
    ? params.select.split(',')
    : ['*'];

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
