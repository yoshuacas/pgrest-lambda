// sql-builder-operators.test.mjs — SQL emitted for every filter operator.
//
// The shapes come from upstream PostgREST.Query.SqlFragment
// (`pgFmtFilter`, `simpleOperator`, `quantOperator`, `ftsOperator`,
// `pgBuildArrayLiteral`). Every operator must place the user's value in a
// parameter — a value must never reach the SQL text.
//
//   node --test src/rest/__tests__/sql-builder-operators.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { _buildFilterConditions, _supportedOperators } from '../sql-builder.mjs';
import { VALID_OPERATORS } from '../query-parser.mjs';

const schema = {
  tables: {
    docs: {
      columns: {
        id: { type: 'bigint' },
        name: { type: 'text' },
        arr: { type: 'integer[]' },
        span: { type: 'numrange' },
        body: { type: 'text' },
        vec: { type: 'tsvector' },
      },
    },
  },
  relationships: [],
};

// The same validator the builders use, so the tsvector lookup is
// exercised rather than stubbed.
function validator() {
  const v = (col) => {
    if (!schema.tables.docs.columns[col]) {
      throw new Error(`Column '${col}' not found`);
    }
  };
  v.typeOf = (col) => schema.tables.docs.columns[col]?.type || null;
  return v;
}

function build(filters) {
  const values = [];
  const conditions = _buildFilterConditions(filters, values, validator());
  return { conditions, values };
}

function filter(column, operator, value, extra = {}) {
  return { type: 'filter', column, operator, value, negate: false, ...extra };
}

describe('single-value operators', () => {
  const expected = {
    neq: '!=', cs: '@>', cd: '<@', ov: '&&',
    sl: '<<', sr: '>>', nxr: '&<', nxl: '&>', adj: '-|-',
  };

  for (const [op, sql] of Object.entries(expected)) {
    it(`${op} emits ${sql} with a parameter`, () => {
      const { conditions, values } = build([filter('arr', op, '{1,2}')]);
      assert.deepStrictEqual(conditions, [`"arr" ${sql} $1`]);
      assert.deepStrictEqual(values, ['{1,2}']);
    });
  }

  it('negates with a NOT prefix, the way upstream does', () => {
    const { conditions } = build([
      filter('arr', 'cs', '{1}', { negate: true }),
    ]);
    assert.deepStrictEqual(conditions, ['NOT "arr" @> $1']);
  });
});

describe('quantifiable operators', () => {
  const expected = {
    eq: '=', gte: '>=', gt: '>', lte: '<=', lt: '<',
    like: 'LIKE', ilike: 'ILIKE', match: '~', imatch: '~*',
  };

  for (const [op, sql] of Object.entries(expected)) {
    it(`${op} emits ${sql} with a parameter`, () => {
      const { conditions, values } = build([filter('name', op, 'x')]);
      assert.deepStrictEqual(conditions, [`"name" ${sql} $1`]);
      assert.deepStrictEqual(values, ['x']);
    });
  }

  it('wraps the parameter in ANY() for the any quantifier', () => {
    const { conditions, values } = build([
      filter('id', 'eq', '{1,2}', { quantifier: 'any' }),
    ]);
    assert.deepStrictEqual(conditions, ['"id" = ANY($1)']);
    assert.deepStrictEqual(values, ['{1,2}']);
  });

  it('wraps the parameter in ALL() for the all quantifier', () => {
    const { conditions } = build([
      filter('name', 'like', '{%a%,%b%}', { quantifier: 'all' }),
    ]);
    assert.deepStrictEqual(conditions, ['"name" LIKE ALL($1)']);
  });

  it('negates a regex match with a NOT prefix', () => {
    const { conditions } = build([
      filter('name', 'imatch', '^yx', { negate: true }),
    ]);
    assert.deepStrictEqual(conditions, ['NOT "name" ~* $1']);
  });
});

describe('is', () => {
  const expected = {
    null: 'IS NULL',
    not_null: 'IS NOT NULL',
    true: 'IS TRUE',
    false: 'IS FALSE',
    unknown: 'IS UNKNOWN',
  };

  for (const [word, sql] of Object.entries(expected)) {
    it(`is.${word} emits ${sql}`, () => {
      const { conditions, values } = build([filter('name', 'is', word)]);
      assert.deepStrictEqual(conditions, [`"name" ${sql}`]);
      assert.deepStrictEqual(values, [], 'a keyword is not a parameter');
    });
  }

  it('negates with a NOT prefix rather than flipping the keyword', () => {
    const { conditions } = build([
      filter('name', 'is', 'not_null', { negate: true }),
    ]);
    assert.deepStrictEqual(conditions, ['NOT "name" IS NOT NULL']);
  });

  it('rejects a keyword outside the whitelist', () => {
    assert.throws(
      () => build([filter('name', 'is', 'nope')]),
      (err) => err.code === 'PGRST100',
    );
  });
});

describe('isdistinct', () => {
  it('emits IS DISTINCT FROM with a parameter', () => {
    const { conditions, values } = build([
      filter('name', 'isdistinct', 'foo'),
    ]);
    assert.deepStrictEqual(conditions, ['"name" IS DISTINCT FROM $1']);
    assert.deepStrictEqual(values, ['foo']);
  });

  it('negates with a NOT prefix', () => {
    const { conditions } = build([
      filter('name', 'isdistinct', 'foo', { negate: true }),
    ]);
    assert.deepStrictEqual(conditions,
      ['NOT "name" IS DISTINCT FROM $1']);
  });
});

describe('in', () => {
  it('passes the list as one array literal parameter', () => {
    const { conditions, values } = build([
      filter('id', 'in', ['1', '2', '3']),
    ]);
    assert.deepStrictEqual(conditions, ['"id" = ANY($1)']);
    assert.deepStrictEqual(values, ['{"1","2","3"}']);
  });

  it('escapes quotes and backslashes in the array literal', () => {
    const { values } = build([
      filter('name', 'in', ['a"b', 'c\\d']),
    ]);
    assert.deepStrictEqual(values, ['{"a\\"b","c\\\\d"}']);
  });

  it('emits an empty array literal for a single empty element', () => {
    const { conditions, values } = build([filter('id', 'in', [''])]);
    assert.deepStrictEqual(conditions, ["\"id\" = ANY('{}')"]);
    assert.deepStrictEqual(values, []);
  });

  it('negates with a NOT prefix', () => {
    const { conditions } = build([
      filter('id', 'in', ['1'], { negate: true }),
    ]);
    assert.deepStrictEqual(conditions, ['NOT "id" = ANY($1)']);
  });
});

describe('full-text search', () => {
  const fns = {
    fts: 'to_tsquery',
    plfts: 'plainto_tsquery',
    phfts: 'phraseto_tsquery',
    wfts: 'websearch_to_tsquery',
  };

  for (const [op, fn] of Object.entries(fns)) {
    it(`${op} searches to_tsvector(col) with ${fn}`, () => {
      const { conditions, values } = build([
        filter('body', op, 'impossible'),
      ]);
      assert.deepStrictEqual(conditions,
        [`to_tsvector("body") @@ ${fn}($1)`]);
      assert.deepStrictEqual(values, ['impossible']);
    });

    it(`${op} passes a named config to both calls`, () => {
      const { conditions, values } = build([
        filter('body', op, 'impossible', { ftsLang: 'english' }),
      ]);
      assert.deepStrictEqual(conditions,
        [`to_tsvector($1, "body") @@ ${fn}($2, $3)`]);
      assert.deepStrictEqual(values,
        ['english', 'english', 'impossible'],
        'the config is a parameter, never inlined');
    });
  }

  it('does not wrap a tsvector column in to_tsvector', () => {
    const { conditions, values } = build([
      filter('vec', 'fts', 'impossible', { ftsLang: 'english' }),
    ]);
    assert.deepStrictEqual(conditions, ['"vec" @@ to_tsquery($1, $2)']);
    assert.deepStrictEqual(values, ['english', 'impossible']);
  });

  it('negates with a NOT prefix', () => {
    const { conditions } = build([
      filter('body', 'fts', 'impossible', { negate: true }),
    ]);
    assert.deepStrictEqual(conditions,
      ['NOT to_tsvector("body") @@ to_tsquery($1)']);
  });

  it('uses PGREST_DEFAULT_TS_CONFIG when the filter names no config',
    () => {
      const previous = process.env.PGREST_DEFAULT_TS_CONFIG;
      process.env.PGREST_DEFAULT_TS_CONFIG = 'simple';
      try {
        const { conditions, values } = build([
          filter('body', 'fts', 'impossible'),
        ]);
        assert.deepStrictEqual(conditions,
          ['to_tsvector($1, "body") @@ to_tsquery($2, $3)']);
        assert.deepStrictEqual(values,
          ['simple', 'simple', 'impossible']);
      } finally {
        if (previous === undefined) {
          delete process.env.PGREST_DEFAULT_TS_CONFIG;
        } else {
          process.env.PGREST_DEFAULT_TS_CONFIG = previous;
        }
      }
    });

  it('a config named in the filter wins over the default', () => {
    const previous = process.env.PGREST_DEFAULT_TS_CONFIG;
    process.env.PGREST_DEFAULT_TS_CONFIG = 'simple';
    try {
      const { values } = build([
        filter('body', 'fts', 'impossible', { ftsLang: 'english' }),
      ]);
      assert.deepStrictEqual(values,
        ['english', 'english', 'impossible']);
    } finally {
      if (previous === undefined) {
        delete process.env.PGREST_DEFAULT_TS_CONFIG;
      } else {
        process.env.PGREST_DEFAULT_TS_CONFIG = previous;
      }
    }
  });
});

describe('parameter numbering across operators', () => {
  it('numbers parameters left to right through a nested group', () => {
    const { conditions, values } = build([
      filter('id', 'in', ['1', '2']),
      { type: 'logicalGroup', logicalOp: 'or', negate: true,
        conditions: [
          filter('body', 'fts', 'cats', { ftsLang: 'english' }),
          filter('name', 'isdistinct', 'x'),
          filter('name', 'is', 'null'),
          filter('id', 'gte', '3', { quantifier: 'any' }),
        ] },
    ]);
    assert.deepStrictEqual(conditions, [
      '"id" = ANY($1)',
      'NOT (to_tsvector($2, "body") @@ to_tsquery($3, $4)'
      + ' OR "name" IS DISTINCT FROM $5'
      + ' OR "name" IS NULL'
      + ' OR "id" >= ANY($6))',
    ]);
    assert.deepStrictEqual(values, [
      '{"1","2"}', 'english', 'english', 'cats', 'x', '3',
    ]);
  });

  it('never puts a value in the SQL text', () => {
    const nasty = "'; DROP TABLE docs; --";
    const { conditions, values } = build([
      filter('name', 'eq', nasty),
      filter('name', 'match', nasty),
      filter('name', 'isdistinct', nasty),
      filter('body', 'plfts', nasty),
      filter('id', 'in', [nasty]),
    ]);
    for (const cond of conditions) {
      assert.ok(!cond.includes('DROP'),
        `value leaked into SQL: ${cond}`);
    }
    assert.equal(values.length, 5);
  });
});

// An operator the parser accepts but the builder cannot emit is a silent
// wrong-answer bug: the filter parses, no SQL is produced for it, and the
// caller gets 200 with unfiltered rows instead of 400. Keep the two tables in
// step.
describe('operator table coherence', () => {
  it('every operator the parser accepts can be emitted as SQL', () => {
    const emitted = _supportedOperators();
    const missing = [...VALID_OPERATORS].filter(op => !emitted.has(op));
    assert.deepStrictEqual(missing, [],
      'parser accepts operators the builder cannot emit');
  });

  it('the builder emits no operator the parser would reject', () => {
    const extra = [..._supportedOperators()]
      .filter(op => !VALID_OPERATORS.has(op));
    assert.deepStrictEqual(extra, [],
      'builder has SQL for operators no request can reach');
  });
});
