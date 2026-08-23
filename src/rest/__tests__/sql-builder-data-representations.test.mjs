// Data representations: the SQL a registered domain <-> json/text cast
// function turns up in.
//
// Every expectation is taken from upstream:
//   * which direction applies where — Plan.hs `withOutputFormat`,
//     `withTextParse`, `withJsonParse`
//   * how it is rendered — SqlFragment.hs `pgFmtCallUnary`,
//     `pgFmtTableCoerce`, `pgFmtCoerceNamed`, `pgFmtUnknownLiteralForField`,
//     `pgFmtArrayLiteralForField`
//   * order within a select item — SqlFragment.hs `pgFmtSelectItem`: field
//     (and json path), then the representation, then the cast, then the
//     aggregate
//
// The transform is a function call, never a CAST, which is what makes it work
// on a database that cannot register the cast at all.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSelect, buildInsert, buildUpdate, buildCount,
} from '../sql-builder.mjs';
import { parseQuery } from '../query-parser.mjs';

function norm(s) {
  return s.replace(/\s+/g, ' ').trim();
}

function cols(spec) {
  return Object.fromEntries(
    Object.entries(spec).map(([n, t]) => [n, { type: t }]));
}

const REPS = {
  'color|json': {
    sourceType: 'color', targetType: 'json', function: 'public.json',
  },
  'text|color': {
    sourceType: 'text', targetType: 'color', function: 'public.color',
  },
  'json|color': {
    sourceType: 'json', targetType: 'color', function: 'public.color',
  },
  'isodate|json': {
    sourceType: 'isodate', targetType: 'json', function: 'public.json',
  },
};

function makeSchema(representations) {
  return {
    tables: {
      datarep_todos: {
        columns: cols({
          id: 'bigint', name: 'text', label_color: 'color',
          due_at: 'isodate',
        }),
        primaryKey: ['id'],
      },
      datarep_next_two_todos: {
        columns: cols({
          id: 'bigint', name: 'text', first_item_id: 'bigint',
        }),
        primaryKey: ['id'],
      },
    },
    relationships: [{
      constraint: 'datarep_next_two_todos_first_item_id_fkey',
      fromSchema: 'public',
      fromTable: 'datarep_next_two_todos',
      fromColumns: ['first_item_id'],
      toSchema: 'public',
      toTable: 'datarep_todos',
      toColumns: ['id'],
    }],
    representations,
  };
}

const schema = makeSchema(REPS);
// The same schema with no representation registered: every assertion below has
// a counterpart here, because a database without the casts has to keep emitting
// exactly the SQL it emitted before the feature existed.
const bare = makeSchema({});

// `parseQuery` takes the API Gateway query-parameter map, not a query string.
function qp(query, method = 'GET') {
  const params = {};
  for (const [k, v] of new URLSearchParams(query)) params[k] = v;
  return parseQuery(params, method);
}

function sel(table, query, s = schema) {
  return norm(buildSelect(table, qp(query), s).text);
}

describe('data representations: response output', () => {
  it('calls the domain -> json function and names the column back', () => {
    const sql = sel('datarep_todos', 'select=id,label_color');
    assert.match(
      sql, /public\.json\("label_color"\) AS "label_color"/);
    assert.doesNotMatch(sql, /CAST\("label_color"/);
  });

  it('leaves a column with no registered cast alone', () => {
    const sql = sel('datarep_todos', 'select=id,name');
    assert.match(sql, /SELECT "id", "name" FROM/);
  });

  it('applies to every transformable column of select=*', () => {
    const sql = sel('datarep_todos', 'select=*');
    assert.match(sql, /public\.json\("label_color"\) AS "label_color"/);
    assert.match(sql, /public\.json\("due_at"\) AS "due_at"/);
    assert.match(sql, /"id", "name"/);
  });

  it('keeps the bare column list when nothing is registered', () => {
    assert.equal(
      sel('datarep_todos', 'select=*', bare),
      'SELECT "id", "name", "label_color", "due_at" FROM "datarep_todos" ORDER BY "datarep_todos"."id" ASC');
  });

  it('uses the requested alias rather than the column name', () => {
    assert.match(
      sel('datarep_todos', 'select=c:label_color'),
      /public\.json\("label_color"\) AS "c"/);
  });

  it('applies the cast on top of the representation', () => {
    assert.match(
      sel('datarep_todos', 'select=label_color::text'),
      /CAST\(public\.json\("label_color"\) AS text\)/);
  });

  it('applies the representation inside an embed', () => {
    const sql = sel(
      'datarep_next_two_todos',
      'select=id,first_item:datarep_todos'
      + '!datarep_next_two_todos_first_item_id_fkey(label_color)');
    assert.match(sql, /public\.json\(".*?"\."label_color"\)/);
  });

  it('aliases a transformed column of a top-level select with an embed', () => {
    // The top level of a read with embeds is a plain select list, not a
    // json_build_object, so a function call there takes the function's name as
    // its output label unless it is aliased back — the response key would be
    // `json` instead of the column name.
    const sql = sel(
      'datarep_todos',
      'select=label_color,datarep_next_two_todos(name)');
    assert.match(
      sql,
      /public\.json\("datarep_todos"\."label_color"\) AS "label_color"/);
  });
});

describe('data representations: filter values', () => {
  it('parses the value with text -> domain, not the column', () => {
    const sql = sel('datarep_todos', 'label_color=neq.000100');
    assert.match(sql, /"label_color" != public\.color\(\$1\)/);
  });

  it('parses every element of in.() through unnest', () => {
    assert.match(
      sel('datarep_todos', 'label_color=in.(000100,000200)'),
      /"label_color" = ANY\(\(SELECT public\.color\(unnest\(\$1::text\[\]\)\)\)\)/);
  });

  it('leaves in.() empty-list handling alone', () => {
    assert.match(
      sel('datarep_todos', 'label_color=in.()'),
      /"label_color" = ANY\('\{\}'\)/);
  });

  it('parses the value of a quantified operator', () => {
    assert.match(
      sel('datarep_todos', 'label_color=eq(any).{000100,000200}'),
      /"label_color" = ANY\(public\.color\(\$1\)\)/);
  });

  it('does not parse a LIKE pattern', () => {
    // Upstream's OpLike/OpILike branch skips pgFmtUnknownLiteralForField: a
    // pattern is not a value of the column's type.
    assert.match(
      sel('datarep_todos', 'label_color=like.*0001*'),
      /"label_color" LIKE \$1/);
  });

  it('does not parse an IS DISTINCT FROM value', () => {
    assert.match(
      sel('datarep_todos', 'label_color=isdistinct.000100'),
      /"label_color" IS DISTINCT FROM \$1/);
  });

  it('does not parse an IS value', () => {
    assert.match(
      sel('datarep_todos', 'label_color=is.null'),
      /"label_color" IS NULL/);
  });

  it('has no registered text parser for due_at, so the value is raw', () => {
    // The fixtures deliberately register isodate -> json without
    // text -> isodate; the absence has to be honoured per direction.
    assert.match(
      sel('datarep_todos', 'due_at=eq.2018-01-02'),
      /"due_at" = \$1/);
  });

  it('leaves every filter alone when nothing is registered', () => {
    assert.match(
      sel('datarep_todos', 'label_color=neq.000100', bare),
      /"label_color" != \$1/);
  });

  it('parses a filter value in a count query too', () => {
    const built = buildCount(
      'datarep_todos',
      qp('label_color=neq.000100'),
      schema);
    assert.match(norm(built.text), /"label_color" != public\.color\(\$1\)/);
  });
});

describe('data representations: payload values', () => {
  it('parses an inserted value with json -> domain', () => {
    const built = buildInsert(
      'datarep_todos', { name: 'Report', label_color: '#000100' },
      schema, qp(''));
    assert.match(norm(built.text), /VALUES \(\$1, public\.color\(\$2::json\)\)/);
    assert.deepEqual(built.values, ['Report', '"#000100"']);
  });

  it('parses an updated value with json -> domain', () => {
    const built = buildUpdate(
      'datarep_todos', { label_color: '#000100' },
      qp('id=eq.1', 'PATCH'), schema);
    assert.match(
      norm(built.text), /SET "label_color" = public\.color\(\$1::json\)/);
    assert.deepEqual(built.values[0], '"#000100"');
  });

  it('leaves an explicit null alone', () => {
    // json_to_recordset yields SQL NULL for a JSON null upstream, so no parser
    // ever sees it.
    const built = buildUpdate(
      'datarep_todos', { label_color: null },
      qp('id=eq.1', 'PATCH'), schema);
    assert.match(norm(built.text), /SET "label_color" = \$1/);
  });

  it('leaves a payload alone when nothing is registered', () => {
    const built = buildInsert(
      'datarep_todos', { label_color: '#000100' },
      bare, qp(''));
    assert.match(norm(built.text), /VALUES \(\$1\)/);
    assert.deepEqual(built.values, ['#000100']);
  });

  it('applies the output representation to a RETURNING projection', () => {
    const built = buildInsert(
      'datarep_todos', { label_color: '#000100' },
      schema, qp('select=label_color', 'POST'));
    assert.match(
      norm(built.text),
      /RETURNING public\.json\("label_color"\) AS "label_color"/);
  });
});
