// query-parser-json-path.test.mjs — the `->` / `->>` grammar and the
// aggregate functions in select.
//
// Ported from upstream PostgREST.ApiRequest.QueryParams (`pJsonPath`,
// `pJsonOperand`, `pJIdx`, `pJsonKeyName`, `pFieldSelect`, `pAggregation`)
// and the behaviour asserted by test/spec/Feature/Query/JsonOperatorSpec.hs
// and AggregateFunctionsSpec.hs.
//
//   node --test src/rest/__tests__/query-parser-json-path.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseQuery } from '../query-parser.mjs';

function select(query) {
  return parseQuery({ select: query }, 'GET').select;
}

function err(fn) {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error('expected a PostgRESTError');
}

describe('json path in select', () => {
  it('parses a single ->> key', () => {
    assert.deepStrictEqual(select('data->>id'), [{
      type: 'column',
      name: 'data',
      jsonPath: [{ op: '->>', kind: 'key', value: 'id' }],
      alias: 'id',
    }]);
  });

  it('chains -> and ->>', () => {
    assert.deepStrictEqual(select('settings->foo->>bar'), [{
      type: 'column',
      name: 'settings',
      jsonPath: [
        { op: '->', kind: 'key', value: 'foo' },
        { op: '->>', kind: 'key', value: 'bar' },
      ],
      // Upstream `addAliases`/`lastJsonKey`: the last key names the column.
      alias: 'bar',
    }]);
  });

  it('reads ->N as an integer index and keeps the column name', () => {
    // Upstream derives no alias from an index, so the field name stays.
    assert.deepStrictEqual(select('data->>0'), [{
      type: 'column',
      name: 'data',
      jsonPath: [{ op: '->>', kind: 'idx', value: '+0' }],
      alias: 'data',
    }]);
  });

  it('reads a negative index', () => {
    assert.deepStrictEqual(select('data->-1->>b'), [{
      type: 'column',
      name: 'data',
      jsonPath: [
        { op: '->', kind: 'idx', value: '-1' },
        { op: '->>', kind: 'key', value: 'b' },
      ],
      alias: 'b',
    }]);
  });

  it('falls back to the last key when the path ends on an index', () => {
    const [node] = select('data->c->0->d->>4');
    assert.equal(node.alias, 'd');
  });

  it('takes a key that only looks like an index', () => {
    // `0xy1` starts with a digit but is not `many1 digit`, so pJIdx fails
    // and pJKey takes it — dashes included.
    const [node] = select('data->0->0xy1->1->23-xy-45->1->xy-6->>0');
    assert.deepStrictEqual(node.jsonPath.map(s => s.value),
      ['+0', '0xy1', '+1', '23-xy-45', '+1', 'xy-6', '+0']);
    assert.equal(node.alias, 'xy-6');
  });

  it('composes an explicit alias and a cast with a path', () => {
    assert.deepStrictEqual(select('x:jsonb_col->>k::int'), [{
      type: 'column',
      name: 'jsonb_col',
      jsonPath: [{ op: '->>', kind: 'key', value: 'k' }],
      alias: 'x',
      cast: 'int',
    }]);
  });

  it('keeps a key made of reserved-looking characters', () => {
    const [node] = select('data->!@#$%^&*_d->>!@#$%^&*_e::integer');
    assert.deepStrictEqual(node.jsonPath.map(s => s.value),
      ['!@#$%^&*_d', '!@#$%^&*_e']);
    assert.equal(node.alias, '!@#$%^&*_e');
    assert.equal(node.cast, 'integer');
  });

  it('rejects an operand that is not a key or an index', () => {
    // JsonOperatorSpec:58 — `(` cannot start a json operand, and the
    // relation branch does not apply because `data->` is not a field name.
    const e = err(() => select('data->(!@#$%^&*_d->>x::integer'));
    assert.equal(e.code, 'PGRST100');
    assert.equal(e.message,
      '"failed to parse select parameter (data->(!@#$%^&*_d->>x::integer)"'
      + ' (line 1, column 7)');
    assert.equal(e.details,
      'unexpected "(" expecting "-", digit or any non reserved character'
      + ' different from: .,>()');
  });

  it('reports only `digit` after a sign', () => {
    // JsonOperatorSpec:309 — once `-` is consumed the key branch is no
    // longer an alternative, so its label must not appear.
    const e = err(() => select('data->>--34'));
    assert.equal(e.message,
      '"failed to parse select parameter (data->>--34)" (line 1, column 9)');
    assert.equal(e.details, 'unexpected "-" expecting digit');
  });
});

describe('json path in filters', () => {
  it('splits the path out of the parameter name', () => {
    const { filters } = parseQuery({ 'data->foo->>bar': 'eq.baz' }, 'GET');
    assert.deepStrictEqual(filters, [{
      type: 'filter',
      column: 'data',
      negate: false,
      operator: 'eq',
      value: 'baz',
      jsonPath: [
        { op: '->', kind: 'key', value: 'foo' },
        { op: '->>', kind: 'key', value: 'bar' },
      ],
    }]);
  });

  it('carries a path into a logic tree leaf', () => {
    const { filters } = parseQuery(
      { or: '(jsonb_col->a->>b.eq.foo,jsonb_col->>b.eq.bar)' }, 'GET');
    const [group] = filters;
    assert.equal(group.type, 'logicalGroup');
    assert.deepStrictEqual(
      group.conditions.map(c => c.jsonPath.map(s => s.value)),
      [['a', 'b'], ['b']]);
    assert.deepStrictEqual(
      group.conditions.map(c => c.column), ['jsonb_col', 'jsonb_col']);
  });

  it('leaves a column named like a path alone when it does not parse', () => {
    const { filters } = parseQuery({ 'data->': 'eq.1' }, 'GET');
    assert.equal(filters[0].column, 'data->');
    assert.equal(filters[0].jsonPath, undefined);
  });
});

describe('json path in order', () => {
  it('parses direction and nulls after the path', () => {
    const { order } = parseQuery({ order: 'data->>id.desc.nullslast' }, 'GET');
    assert.deepStrictEqual(order, [{
      column: 'data',
      direction: 'desc',
      nulls: 'nullslast',
      jsonPath: [{ op: '->>', kind: 'key', value: 'id' }],
    }]);
  });

  it('accepts a nulls option with no direction', () => {
    // JsonOperatorSpec:248 — `optionMaybe pOrdDir` before `optionMaybe pNulls`.
    const { order } = parseQuery(
      { order: 'data->foo->>bar.nullsfirst' }, 'GET');
    assert.equal(order[0].direction, 'asc');
    assert.equal(order[0].nulls, 'nullsfirst');
    assert.equal(order[0].jsonPath.length, 2);
  });

  it('still rejects a bad direction', () => {
    const e = err(() => parseQuery({ order: 'data->>id.up' }, 'GET'));
    assert.equal(e.code, 'PGRST100');
    assert.match(e.message, /Invalid order direction 'up'/);
  });
});

describe('aggregate functions in select', () => {
  it('parses count() with no field', () => {
    assert.deepStrictEqual(select('count()'), [{
      type: 'column', name: '*', alias: 'count', agg: 'count',
    }]);
  });

  it('takes an alias and a cast on count()', () => {
    assert.deepStrictEqual(select('cnt:count()::text'), [{
      type: 'column', name: '*', alias: 'cnt', agg: 'count', aggCast: 'text',
    }]);
  });

  it('labels an unaliased aggregate with the function name', () => {
    // PostgreSQL names the output column after the function, which is what
    // upstream relies on instead of emitting an alias.
    for (const fn of ['sum', 'avg', 'min', 'max', 'count']) {
      assert.deepStrictEqual(select(`invoice_total.${fn}()`), [{
        type: 'column', name: 'invoice_total', alias: fn, agg: fn,
      }]);
    }
  });

  it('keeps every aggregate in a mixed select', () => {
    const nodes = select('invoice_total.sum(),invoice_total.max(),project_id');
    assert.deepStrictEqual(nodes.map(n => [n.name, n.agg || null]), [
      ['invoice_total', 'sum'],
      ['invoice_total', 'max'],
      ['project_id', null],
    ]);
  });

  it('applies a cast before and after the aggregate', () => {
    assert.deepStrictEqual(select('s:jsonb_col->>key::integer.sum()::text'), [{
      type: 'column',
      name: 'jsonb_col',
      jsonPath: [{ op: '->>', kind: 'key', value: 'key' }],
      alias: 's',
      cast: 'integer',
      agg: 'sum',
      aggCast: 'text',
    }]);
  });

  it('does not read count() as an embedded resource', () => {
    // Upstream `pRelationSelect` has `guard (name /= "count")`.
    const nodes = select('client_id,count()');
    assert.equal(nodes[1].agg, 'count');
    assert.equal(nodes.filter(n => n.type === 'embed').length, 0);
  });

  it('rejects an unknown function as an embed with no relation syntax', () => {
    const e = err(() => select('invoice_total.sumx()'));
    assert.equal(e.code, 'PGRST100');
  });
});
