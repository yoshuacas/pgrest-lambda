// routines.test.mjs — overload resolution and its error bodies.
//
// Mirrors upstream PostgREST.Plan (`findProc`, `matchesParams`,
// `hasSingleUnnamedParam`), PostgREST.SchemaCache.Routine (`Ord Routine`) and
// PostgREST.Error (`NoRpc`, `AmbiguousRpc`, `noRpcHint`). The wire strings are
// asserted verbatim: they are the response body.
//
//   node --test src/rest/__tests__/routines.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  findRoutine, buildRoutineMap, makeRoutine, compareRoutines,
  parseContentMediaType, fuzzyBest, noRpcHint,
  MT_JSON, MT_TEXT, MT_XML, MT_OCTET, MT_URLENCODED, MT_CSV,
} from '../routines.mjs';

function param(name, type, opts = {}) {
  return {
    name, type, castType: type,
    required: opts.required !== false,
    variadic: Boolean(opts.variadic),
  };
}

function routine(name, args, opts = {}) {
  return {
    schema: 'public',
    name,
    args,
    returnType: opts.returnType || 'int4',
    returnTypeSchema: 'pg_catalog',
    returnRelation: opts.returnRelation || 'int4',
    returnsSet: Boolean(opts.returnsSet),
    returnsComposite: Boolean(opts.returnsComposite),
    isScalar: !opts.returnsComposite,
    returnColumns: opts.returnColumns || null,
    volatility: opts.volatility || 'v',
    language: 'sql',
    hasVariadic: args.some(a => a.variadic),
    numDefaults: args.filter(a => !a.required).length,
  };
}

describe('routines: introspection row mapping', () => {
  it('reads array columns into parameters', () => {
    const r = makeRoutine({
      routine_schema: 'public',
      routine_name: 'calc',
      arg_names: ['a', 'b'],
      arg_types: ['integer', 'bit'],
      arg_cast_types: ['integer', 'bit varying'],
      arg_required: [true, false],
      arg_variadic: [false, false],
      out_names: null,
      out_types: null,
      return_type_schema: 'pg_catalog',
      return_type: 'int4',
      return_relation: 'int4',
      returns_set: false,
      returns_composite: false,
      volatility: 'i',
      language: 'sql',
      has_variadic: false,
    });
    assert.deepStrictEqual(r.args, [
      { name: 'a', type: 'integer', castType: 'integer', required: true, variadic: false },
      { name: 'b', type: 'bit', castType: 'bit varying', required: false, variadic: false },
    ]);
    assert.equal(r.numDefaults, 1);
    assert.equal(r.isScalar, true);
    assert.equal(r.returnColumns, null);
  });

  it('turns OUT parameters into result columns', () => {
    const r = makeRoutine({
      routine_schema: 'public',
      routine_name: 'many_out_params',
      arg_names: [],
      arg_types: [],
      arg_cast_types: [],
      arg_required: [],
      arg_variadic: [],
      out_names: ['my_json', 'num'],
      out_types: ['json', 'integer'],
      return_type_schema: 'pg_catalog',
      return_type: 'record',
      return_relation: 'record',
      returns_set: false,
      returns_composite: true,
      volatility: 'i',
      language: 'sql',
      has_variadic: false,
    });
    assert.equal(r.isScalar, false);
    assert.deepStrictEqual(r.returnColumns, [
      { name: 'my_json', type: 'json' },
      { name: 'num', type: 'integer' },
    ]);
  });

  it('orders overloads by parameter count, then field-wise', () => {
    const map = buildRoutineMap([
      { routine_name: 'f', arg_names: ['arg'], arg_types: ['xml'], arg_cast_types: ['xml'], arg_required: [true], arg_variadic: [false], return_type: 'text', return_relation: 'text' },
      { routine_name: 'f', arg_names: ['arg', 'num'], arg_types: ['text', 'integer'], arg_cast_types: ['text', 'integer'], arg_required: [true, false], arg_variadic: [false, false], return_type: 'text', return_relation: 'text' },
      { routine_name: 'f', arg_names: ['arg'], arg_types: ['integer'], arg_cast_types: ['integer'], arg_required: [true], arg_variadic: [false], return_type: 'text', return_relation: 'text' },
    ]);
    assert.deepStrictEqual(
      map.f.map(r => r.args.map(a => a.type).join(',')),
      ['integer', 'xml', 'text,integer'],
    );
  });

  it('compares two routines by parameter count first', () => {
    const a = routine('f', [param('a', 'integer')]);
    const b = routine('f', [param('a', 'integer'), param('b', 'integer')]);
    assert.ok(compareRoutines(a, b) < 0);
  });
});

describe('routines: content type', () => {
  it('defaults a missing Content-Type to application/json', () => {
    assert.equal(parseContentMediaType(undefined), MT_JSON);
    assert.equal(parseContentMediaType(''), MT_JSON);
  });

  it('drops parameters and lowercases', () => {
    assert.equal(
      parseContentMediaType('Text/Plain; charset=utf-8'), MT_TEXT);
    assert.equal(parseContentMediaType(MT_URLENCODED), MT_URLENCODED);
    assert.equal(parseContentMediaType('text/csv'), MT_CSV);
  });
});

describe('routines: findRoutine', () => {
  it('matches a routine whose required parameters are exactly supplied', () => {
    const routines = { add_them: [routine('add_them', [param('a', 'integer'), param('b', 'integer')])] };
    const r = findRoutine({
      routines, fnName: 'add_them', argKeys: ['a', 'b'],
    });
    assert.equal(r.name, 'add_them');
  });

  it('accepts a subset of optional-only parameters', () => {
    const routines = {
      variadic_param: [routine('variadic_param',
        [param('v', 'text[]', { required: false, variadic: true })])],
    };
    assert.ok(findRoutine({
      routines, fnName: 'variadic_param', argKeys: [],
    }));
    assert.ok(findRoutine({
      routines, fnName: 'variadic_param', argKeys: ['v'],
    }));
  });

  it('requires every required parameter when some are optional', () => {
    const routines = {
      f: [routine('f', [
        param('num', 'integer'),
        param('str', 'text'),
        param('b', 'boolean', { required: false }),
      ])],
    };
    assert.ok(findRoutine({ routines, fnName: 'f', argKeys: ['num', 'str'] }));
    assert.throws(
      () => findRoutine({ routines, fnName: 'f', argKeys: ['num', 'b'] }),
      (e) => e.code === 'PGRST202');
  });

  it('picks the overload the argument names fit', () => {
    const routines = {
      overloaded: [
        routine('overloaded', []),
        routine('overloaded', [param('a', 'integer'), param('b', 'integer')]),
        routine('overloaded', [
          param('a', 'text'), param('b', 'text'), param('c', 'text')]),
      ],
    };
    assert.equal(
      findRoutine({ routines, fnName: 'overloaded', argKeys: [] }).args.length,
      0);
    assert.equal(
      findRoutine({
        routines, fnName: 'overloaded', argKeys: ['a', 'b'],
      }).args.length,
      2);
    assert.equal(
      findRoutine({
        routines, fnName: 'overloaded', argKeys: ['a', 'b', 'c'],
      }).args.length,
      3);
  });

  it('answers 300 PGRST203 when more than one overload fits', () => {
    const routines = {
      overloaded_same_args: [
        routine('overloaded_same_args', [param('arg', 'integer')]),
        routine('overloaded_same_args', [param('arg', 'xml')]),
        routine('overloaded_same_args', [
          param('arg', 'text'), param('num', 'integer', { required: false })]),
      ],
    };
    assert.throws(
      () => findRoutine({
        routines, fnName: 'overloaded_same_args', argKeys: ['arg'],
      }),
      (err) => {
        assert.equal(err.statusCode, 300);
        assert.equal(err.code, 'PGRST203');
        assert.equal(err.message,
          'Could not choose the best candidate function between: '
          + 'public.overloaded_same_args(arg => integer), '
          + 'public.overloaded_same_args(arg => xml), '
          + 'public.overloaded_same_args(arg => text, num => integer)');
        assert.equal(err.details, null);
        assert.equal(err.hint,
          'Try renaming the parameters or the function itself in the database '
          + 'so function overloading can be resolved');
        return true;
      });
  });

  it('falls back to a single unnamed json parameter on POST', () => {
    const routines = {
      overloaded_unnamed_param: [
        routine('overloaded_unnamed_param', []),
        routine('overloaded_unnamed_param', [param('', 'json')]),
        routine('overloaded_unnamed_param', [
          param('x', 'integer'), param('y', 'integer')]),
      ],
    };
    const r = findRoutine({
      routines, fnName: 'overloaded_unnamed_param',
      argKeys: ['A', 'B', 'C'], isInvPost: true, contentType: MT_JSON,
    });
    assert.deepStrictEqual(r.args.map(a => a.type), ['json']);
  });

  it('prefers a named match over the unnamed fallback', () => {
    const routines = {
      overloaded_unnamed_param: [
        routine('overloaded_unnamed_param', [param('', 'json')]),
        routine('overloaded_unnamed_param', [
          param('x', 'integer'), param('y', 'integer')]),
      ],
    };
    const r = findRoutine({
      routines, fnName: 'overloaded_unnamed_param',
      argKeys: ['x', 'y'], isInvPost: true, contentType: MT_JSON,
    });
    assert.deepStrictEqual(r.args.map(a => a.name), ['x', 'y']);
  });

  it('does not use the fallback on GET, whatever the Content-Type', () => {
    const routines = {
      overloaded_unnamed_param: [
        routine('overloaded_unnamed_param', []),
        routine('overloaded_unnamed_param', [param('', 'text')]),
      ],
    };
    const r = findRoutine({
      routines, fnName: 'overloaded_unnamed_param',
      argKeys: [], isInvPost: false, contentType: MT_TEXT,
    });
    assert.equal(r.args.length, 0);
  });

  it('does not offer a no-parameter routine for a raw body', () => {
    const routines = { f: [routine('f', [])] };
    assert.throws(
      () => findRoutine({
        routines, fnName: 'f', argKeys: [],
        isInvPost: true, contentType: MT_OCTET,
      }),
      (e) => e.code === 'PGRST202');
  });

  it('is ambiguous between unnamed json and jsonb fallbacks', () => {
    const routines = {
      overloaded_unnamed_json_jsonb_param: [
        routine('overloaded_unnamed_json_jsonb_param', [param('', 'json')]),
        routine('overloaded_unnamed_json_jsonb_param', [param('', 'jsonb')]),
      ],
    };
    assert.throws(
      () => findRoutine({
        routines, fnName: 'overloaded_unnamed_json_jsonb_param',
        argKeys: ['A'], isInvPost: true, contentType: MT_JSON,
      }),
      (err) => {
        assert.equal(err.statusCode, 300);
        assert.equal(err.message,
          'Could not choose the best candidate function between: '
          + 'public.overloaded_unnamed_json_jsonb_param( => json), '
          + 'public.overloaded_unnamed_json_jsonb_param( => jsonb)');
        return true;
      });
  });
});

describe('routines: 404 body', () => {
  const routines = {
    sayhello: [routine('sayhello', [param('name', 'text')])],
    add_them: [routine('add_them',
      [param('a', 'integer'), param('b', 'integer')])],
    unnamed_text_param: [routine('unnamed_text_param', [param('', 'text')])],
  };

  it('names the parameters and hints the closest function', () => {
    assert.throws(
      () => findRoutine({ routines, fnName: 'sayhell', argKeys: [] }),
      (err) => {
        assert.equal(err.statusCode, 404);
        assert.equal(err.code, 'PGRST202');
        assert.equal(err.message,
          'Could not find the function public.sayhell without parameters '
          + 'in the schema cache');
        assert.equal(err.details,
          'Searched for the function public.sayhell without parameters, '
          + 'but no matches were found in the schema cache.');
        assert.equal(err.hint,
          'Perhaps you meant to call the function public.sayhello');
        return true;
      });
  });

  it('hints the closest parameter list when the name exists', () => {
    assert.throws(
      () => findRoutine({ routines, fnName: 'sayhello', argKeys: ['nam'] }),
      (err) => {
        assert.equal(err.message,
          'Could not find the function public.sayhello(nam) '
          + 'in the schema cache');
        assert.equal(err.details,
          'Searched for the function public.sayhello with parameter nam, '
          + 'but no matches were found in the schema cache.');
        assert.equal(err.hint,
          'Perhaps you meant to call the function public.sayhello(name)');
        return true;
      });
  });

  it('pluralizes several parameters', () => {
    assert.throws(
      () => findRoutine({
        routines, fnName: 'add_them', argKeys: ['a', 'b', 'smthelse'],
      }),
      (err) => {
        assert.equal(err.message,
          'Could not find the function public.add_them(a, b, smthelse) '
          + 'in the schema cache');
        assert.equal(err.details,
          'Searched for the function public.add_them with parameters '
          + 'a, b, smthelse, but no matches were found in the schema cache.');
        assert.equal(err.hint,
          'Perhaps you meant to call the function public.add_them(a, b)');
        return true;
      });
  });

  it('mentions the unnamed json parameter on a JSON POST', () => {
    assert.throws(
      () => findRoutine({
        routines, fnName: 'named_json_param', argKeys: ['A', 'B', 'C'],
        isInvPost: true, contentType: MT_JSON,
      }),
      (err) => {
        assert.equal(err.details,
          'Searched for the function public.named_json_param with parameters '
          + 'A, B, C or with a single unnamed json/jsonb parameter, but no '
          + 'matches were found in the schema cache.');
        return true;
      });
  });

  it('leaves out the parameter list for a raw body, and gives no hint', () => {
    for (const [ct, word] of [
      [MT_TEXT, 'text'], [MT_XML, 'xml'], [MT_OCTET, 'bytea'],
    ]) {
      assert.throws(
        () => findRoutine({
          routines, fnName: 'unnamed_int_param', argKeys: [],
          isInvPost: true, contentType: ct,
        }),
        (err) => {
          assert.equal(err.message,
            'Could not find the function public.unnamed_int_param '
            + 'in the schema cache');
          assert.equal(err.details,
            'Searched for the function public.unnamed_int_param with a single '
            + `unnamed ${word} parameter, but no matches were found in the `
            + 'schema cache.');
          assert.equal(err.hint, null);
          return true;
        });
    }
  });
});

describe('routines: fuzzy hints', () => {
  it('finds a near-identical name', () => {
    assert.equal(fuzzyBest(['sayhello', 'add_them'], 'sayhell', 0.75),
      'sayhello');
  });

  it('rejects a name that is not close enough', () => {
    assert.equal(fuzzyBest(['sayhello', 'add_them'], 'zzzz', 0.75), null);
  });

  it('gives no hint when no overload has a similar parameter list', () => {
    const candidates = [
      { args: [] },
      { args: [{ name: 'a' }, { name: 'b' }] },
      { args: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] },
    ];
    assert.equal(
      noRpcHint('public', 'overloaded', ['wrong_arg'], [], candidates), null);
  });

  it('hints the closest overload parameter list', () => {
    const candidates = [
      { args: [] },
      { args: [{ name: 'a' }, { name: 'b' }] },
      { args: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] },
    ];
    assert.equal(
      noRpcHint('public', 'overloaded', ['a', 'b', 'wrong_arg'], [],
        candidates),
      'Perhaps you meant to call the function public.overloaded(a, b, c)');
  });
});
