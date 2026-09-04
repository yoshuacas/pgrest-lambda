// query-parser-operators.test.mjs — the filter grammar ported from
// upstream PostgREST (PostgREST.ApiRequest.QueryParams).
//
// The expectations here come from two places in the upstream tree:
// the doctests in QueryParams.hs (`pOpExpr`, `pFieldName`) and the
// request/response pairs in test/spec/Feature/Query/AndOrParamsSpec.hs
// and QuerySpec.hs. Where a test names an upstream site, the assertion
// is that site's, not an invention.
//
//   node --test src/rest/__tests__/query-parser-operators.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseQuery } from '../query-parser.mjs';

function filterOf(query) {
  const [key, ...rest] = query.split('=');
  const parsed = parseQuery({ [key]: rest.join('=') }, 'GET');
  assert.equal(parsed.filters.length, 1,
    `${query} should produce exactly one filter`);
  return parsed.filters[0];
}

function errorOf(params) {
  try {
    parseQuery(params, 'GET');
  } catch (err) {
    return err;
  }
  throw new Error(`${JSON.stringify(params)} should not parse`);
}

describe('filter operators', () => {
  describe('single-value operators (upstream simpleOperator)', () => {
    const ops = ['neq', 'cs', 'cd', 'ov', 'sl', 'sr', 'nxr', 'nxl', 'adj'];

    for (const op of ops) {
      it(`parses ?col=${op}.value`, () => {
        const f = filterOf(`col=${op}.{1,2}`);
        assert.equal(f.operator, op);
        assert.equal(f.value, '{1,2}');
        assert.equal(f.negate, false);
        assert.equal(f.quantifier, undefined,
          'single-value operators take no quantifier');
      });
    }

    it('parses a range literal value without splitting it', () => {
      const f = filterOf('range=adj.(3,10]');
      assert.equal(f.operator, 'adj');
      assert.equal(f.value, '(3,10]');
    });
  });

  describe('quantifiable operators (upstream quantOperator)', () => {
    it('parses ?col=match.^foo as a POSIX regex filter', () => {
      const f = filterOf('col=match.^foo');
      assert.equal(f.operator, 'match');
      assert.equal(f.value, '^foo');
    });

    it('parses ?col=imatch.^foo', () => {
      const f = filterOf('col=imatch.^foo');
      assert.equal(f.operator, 'imatch');
      assert.equal(f.value, '^foo');
    });

    it('parses ?col=eq(any).{1,2} with an any quantifier', () => {
      const f = filterOf('col=eq(any).{1,2}');
      assert.equal(f.operator, 'eq');
      assert.equal(f.quantifier, 'any');
      assert.equal(f.value, '{1,2}');
    });

    it('parses ?col=like(all).{*b*,*c*} with an all quantifier', () => {
      const f = filterOf('col=like(all).{*b*,*c*}');
      assert.equal(f.operator, 'like');
      assert.equal(f.quantifier, 'all');
      assert.equal(f.value, '{%b%,%c%}',
        'like rewrites * to % (upstream SqlFragment.star)');
    });

    it('parses ?col=not.eq(all).value with both not and a quantifier',
      () => {
        const f = filterOf('col=not.eq(all).1');
        assert.equal(f.negate, true);
        assert.equal(f.quantifier, 'all');
      });

    it('prefers gte over gt and lte over lt', () => {
      assert.equal(filterOf('col=gte.1').operator, 'gte');
      assert.equal(filterOf('col=gt.1').operator, 'gt');
      assert.equal(filterOf('col=lte.1').operator, 'lte');
      assert.equal(filterOf('col=lt.1').operator, 'lt');
    });
  });

  describe('isdistinct', () => {
    it('parses ?col=isdistinct.value', () => {
      const f = filterOf('col=isdistinct.2');
      assert.equal(f.operator, 'isdistinct');
      assert.equal(f.value, '2');
    });

    it('parses ?col=not.isdistinct.value', () => {
      const f = filterOf('col=not.isdistinct.2');
      assert.equal(f.operator, 'isdistinct');
      assert.equal(f.negate, true);
    });
  });

  describe('is', () => {
    for (const word of ['null', 'not_null', 'true', 'false', 'unknown']) {
      it(`parses ?col=is.${word}`, () => {
        const f = filterOf(`col=is.${word}`);
        assert.equal(f.operator, 'is');
        assert.equal(f.value, word);
      });
    }

    it('matches the keyword case-insensitively', () => {
      assert.equal(filterOf('col=is.NULL').value, 'null');
      assert.equal(filterOf('col=is.Not_Null').value, 'not_null');
    });

    it('rejects a value outside the whitelist with the upstream label',
      () => {
        const err = errorOf({ col: 'is.foo' });
        assert.equal(err.code, 'PGRST100');
        assert.equal(err.details,
          'unexpected "f" expecting '
          + 'isVal: (null, not_null, true, false, unknown)');
      });
  });

  describe('in', () => {
    it('parses a plain list', () => {
      assert.deepStrictEqual(filterOf('col=in.(1,2,3)').value,
        ['1', '2', '3']);
    });

    it('keeps a comma inside a quoted element (AndOrParamsSpec:207)',
      () => {
        assert.deepStrictEqual(filterOf('col=in.("1,2",3)').value,
          ['1,2', '3']);
      });

    it('unescapes a backslash-escaped quote', () => {
      assert.deepStrictEqual(filterOf('col=in.("a\\"b")').value,
        ['a"b']);
    });

    it('treats a quote that is not the whole element as literal text',
      () => {
        assert.deepStrictEqual(filterOf('col=in.("a"b)').value,
          ['"a"b']);
      });

    it('parses in.("") as a single empty element (QuerySpec:1383)',
      () => {
        assert.deepStrictEqual(filterOf('col=in.("")').value, ['']);
      });

    it('parses in.() as a single empty element (QuerySpec:1377)', () => {
      assert.deepStrictEqual(filterOf('col=in.()').value, ['']);
    });
  });

  describe('full-text search', () => {
    for (const op of ['fts', 'plfts', 'phfts', 'wfts']) {
      it(`parses ?col=${op}.value`, () => {
        const f = filterOf(`col=${op}.impossible`);
        assert.equal(f.operator, op);
        assert.equal(f.value, 'impossible');
        assert.equal(f.ftsLang, undefined,
          'no config named means no ftsLang');
      });

      it(`parses ?col=${op}(english).value`, () => {
        const f = filterOf(`col=${op}(english).impossible`);
        assert.equal(f.operator, op);
        assert.equal(f.ftsLang, 'english');
        assert.equal(f.value, 'impossible');
      });
    }

    it('keeps the whole search string, spaces included', () => {
      assert.equal(filterOf('col=plfts(german).Art Spass').value,
        'Art Spass');
    });

    it('parses a negated fts filter', () => {
      const f = filterOf('col=not.fts(english).impossible|fat|fun');
      assert.equal(f.negate, true);
      assert.equal(f.value, 'impossible|fat|fun');
    });
  });

  describe('upstream pOpExpr doctests', () => {
    // QueryParams.hs documents these four errors with their exact
    // positions, which is the only check that the alternatives are
    // tried in the upstream order.
    const cases = [
      ['fts().value', 5, '")"'],
      ['eq().value', 4, '")"'],
      ['is().value', 3, '"("'],
      ['in().value', 3, '"("'],
    ];

    for (const [value, column, unexpected] of cases) {
      it(`${value} fails at column ${column}`, () => {
        const err = errorOf({ col: value });
        assert.equal(err.code, 'PGRST100');
        assert.equal(err.message,
          `"failed to parse filter (${value})" (line 1, column ${column})`);
        assert.equal(err.details,
          `unexpected ${unexpected} expecting operator (eq, gt, ...)`);
      });
    }

    it('reports QuerySpec:1270 verbatim for ?id=0', () => {
      const err = errorOf({ id: '0' });
      assert.equal(err.statusCode, 400);
      assert.deepStrictEqual(err.toJSON(), {
        code: 'PGRST100',
        message: '"failed to parse filter (0)" (line 1, column 1)',
        details: 'unexpected "0" expecting "not" or operator (eq, gt, ...)',
        hint: null,
      });
    });
  });
});

describe('logic tree', () => {
  function treeOf(key, value) {
    const parsed = parseQuery({ [key]: value }, 'GET');
    assert.equal(parsed.filters.length, 1);
    return parsed.filters[0];
  }

  it('parses a flat or() group', () => {
    const t = treeOf('or', '(id.eq.1,id.eq.2)');
    assert.equal(t.type, 'logicalGroup');
    assert.equal(t.logicalOp, 'or');
    assert.equal(t.negate, false);
    assert.equal(t.conditions.length, 2);
  });

  it('parses a nested not.or() inside and() (AndOrParamsSpec:237)', () => {
    const t = treeOf('and',
      '( id.eq.1, not.or(id.eq.2, id.eq.3), id.in.(1,4), or(id.eq.1, id.eq.4) )');
    assert.equal(t.conditions.length, 4);
    assert.deepStrictEqual(
      t.conditions.map(c => c.type),
      ['filter', 'logicalGroup', 'filter', 'logicalGroup']);
    assert.equal(t.conditions[1].negate, true);
    assert.equal(t.conditions[1].logicalOp, 'or');
  });

  it('parses not.and= as a negated group', () => {
    const t = treeOf('not.and', '(id.eq.1,id.eq.2)');
    assert.equal(t.logicalOp, 'and');
    assert.equal(t.negate, true);
  });

  it('allows whitespace around parens and commas '
    + '(AndOrParamsSpec:212)', () => {
    const t = treeOf('and',
      '( and ( id.in.( 1, 2, 3 ) , id.eq.3 ) , or ( id.eq.2 , id.eq.3 ) )');
    assert.equal(t.conditions.length, 2);
    assert.equal(t.conditions[0].logicalOp, 'and');
    assert.equal(t.conditions[1].logicalOp, 'or');
    // Upstream leaves the whitespace inside a value alone — Postgres
    // ignores it when it casts the array literal.
    assert.deepStrictEqual(t.conditions[0].conditions[0].value,
      ['1', ' 2', ' 3 ']);
  });

  it('ignores trailing input after a complete tree '
    + '(AndOrParamsSpec:65)', () => {
    const t = treeOf('and', '(id.eq.1,id.neq.2))');
    assert.equal(t.conditions.length, 2);
    assert.equal(t.conditions[1].operator, 'neq');
  });

  it('parses a column whose name starts with a logic operator '
    + '(AndOrParamsSpec:288)', () => {
    const t = treeOf('or', '(and_starting_col.eq.smth, or_starting_col.eq.smth)');
    assert.deepStrictEqual(t.conditions.map(c => c.column),
      ['and_starting_col', 'or_starting_col']);
  });

  it('parses a quoted value containing a comma and a paren '
    + '(AndOrParamsSpec:202)', () => {
    const t = treeOf('or',
      '(name.eq."(grandchild,entity,4)",name.eq."(grandchild,entity,5)")');
    assert.deepStrictEqual(t.conditions.map(c => c.value),
      ['(grandchild,entity,4)', '(grandchild,entity,5)']);
  });

  it('parses a pg array literal inside a group', () => {
    const t = treeOf('and', '(id.gte.2,arr.cs.{1,2})');
    assert.equal(t.conditions[1].value, '{1,2}');
  });

  it('parses an fts filter with a config inside a group', () => {
    const t = treeOf('or',
      '(text_search.plfts(german).Art Spass, text_search.fts(english).impossible)');
    assert.equal(t.conditions[0].ftsLang, 'german');
    assert.equal(t.conditions[0].value, 'Art Spass');
    assert.equal(t.conditions[1].ftsLang, 'english');
  });

  it('parses a per-filter not inside a group '
    + '(AndOrParamsSpec:97)', () => {
    const t = treeOf('and', '(text_search.not.plfts(german).Art Spass)');
    assert.equal(t.conditions[0].negate, true);
    assert.equal(t.conditions[0].operator, 'plfts');
  });

  it('reports AndOrParamsSpec:217 verbatim for ?or=()', () => {
    const err = errorOf({ or: '()' });
    assert.equal(err.statusCode, 400);
    assert.deepStrictEqual(err.toJSON(), {
      code: 'PGRST100',
      message: '"failed to parse logic tree (())" (line 1, column 4)',
      details: 'unexpected ")" expecting '
        + 'field name (* or [a..z0..9_$]), negation operator (not)'
        + ' or logic operator (and, or)',
      hint: null,
    });
  });

  it('rejects a group whose parentheses never close', () => {
    const err = errorOf({ or: '(id.eq.1' });
    assert.equal(err.code, 'PGRST100');
    assert.match(err.message, /failed to parse logic tree/);
  });
});
