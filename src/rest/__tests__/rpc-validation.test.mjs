import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as handlerModule from '../handler.mjs';

const validateRpcArgs = handlerModule.validateRpcArgs
  || (() => { throw new Error('validateRpcArgs not exported from handler.mjs'); });
const coerceRpcArgs = handlerModule.coerceRpcArgs
  || (() => { throw new Error('coerceRpcArgs not exported from handler.mjs'); });
const classifyRpcParam = handlerModule.classifyRpcParam
  || null;

const threeArgSchema = {
  args: [
    { name: 'a', type: 'int4' },
    { name: 'b', type: 'int4' },
    { name: 'c', type: 'int4' },
  ],
  numDefaults: 1,
};

const twoArgSchema = {
  args: [
    { name: 'a', type: 'int4' },
    { name: 'b', type: 'int4' },
  ],
  numDefaults: 0,
};

describe('RPC argument validation', () => {
  describe('required arguments', () => {
    it('passes when all required args provided (3 args, 1 default, provide 2)', () => {
      assert.doesNotThrow(
        () => validateRpcArgs('calc', { a: 1, b: 2 }, threeArgSchema),
        'providing 2 of 3 args with 1 default should pass',
      );
    });

    it('throws PGRST209 when missing a required arg (provide 1 of 2 required)', () => {
      assert.throws(
        () => validateRpcArgs('calc', { a: 1 }, threeArgSchema),
        (err) => {
          return err.code === 'PGRST209'
            && err.message.includes('b');
        },
        'should throw PGRST209 naming the missing arg "b"',
      );
    });

    it('throws PGRST209 naming first missing arg when 0 args provided', () => {
      assert.throws(
        () => validateRpcArgs('calc', {}, threeArgSchema),
        (err) => {
          return err.code === 'PGRST209'
            && err.message.includes('a');
        },
        'should throw PGRST209 naming first required missing arg "a"',
      );
    });
  });

  describe('extra arguments', () => {
    it('throws PGRST207 for unknown argument', () => {
      assert.throws(
        () => validateRpcArgs('add', { a: 1, b: 2, c: 3 }, twoArgSchema),
        (err) => {
          return err.code === 'PGRST207'
            && err.message.includes('c');
        },
        'should throw PGRST207 naming unknown arg "c"',
      );
    });
  });

  describe('type coercion (GET string values)', () => {
    const intArgSchema = {
      args: [{ name: 'x', type: 'int4' }],
      numDefaults: 0,
    };
    const boolArgSchema = {
      args: [{ name: 'flag', type: 'bool' }],
      numDefaults: 0,
    };
    const jsonArgSchema = {
      args: [{ name: 'data', type: 'json' }],
      numDefaults: 0,
    };

    it('coerces string "42" to integer 42 for int4 arg', () => {
      const args = { x: '42' };
      const coerced = coerceRpcArgs('fn', args, intArgSchema);
      assert.equal(coerced.x, 42);
    });

    it('throws PGRST208 for non-numeric string on int4 arg', () => {
      assert.throws(
        () => coerceRpcArgs('fn', { x: 'abc' }, intArgSchema),
        (err) => err.code === 'PGRST208',
        'should throw PGRST208 for "abc" on int4',
      );
    });

    it('coerces string "true" to boolean true for bool arg', () => {
      const coerced = coerceRpcArgs('fn', { flag: 'true' }, boolArgSchema);
      assert.equal(coerced.flag, true);
    });

    it('throws PGRST208 for "yes" on bool arg', () => {
      assert.throws(
        () => coerceRpcArgs('fn', { flag: 'yes' }, boolArgSchema),
        (err) => err.code === 'PGRST208',
        'should throw PGRST208 for "yes" on bool',
      );
    });

    it('coerces valid JSON string to object for json arg', () => {
      const coerced = coerceRpcArgs(
        'fn', { data: '{"a":1}' }, jsonArgSchema);
      assert.deepStrictEqual(coerced.data, { a: 1 });
    });

    it('throws PGRST208 for invalid JSON string on json arg', () => {
      assert.throws(
        () => coerceRpcArgs('fn', { data: 'not json' }, jsonArgSchema),
        (err) => err.code === 'PGRST208',
        'should throw PGRST208 for "not json" on json arg',
      );
    });

    it('rejects trailing non-numeric chars for int4', () => {
      assert.throws(
        () => coerceRpcArgs('fn', { x: '42abc' }, intArgSchema),
        (err) => err.code === 'PGRST208',
        'should throw PGRST208 for "42abc" on int4',
      );
    });

    it('rejects float string for int4', () => {
      assert.throws(
        () => coerceRpcArgs('fn', { x: '3.14' }, intArgSchema),
        (err) => err.code === 'PGRST208',
        'should throw PGRST208 for "3.14" on int4',
      );
    });

    it('rejects leading space for int4', () => {
      assert.throws(
        () => coerceRpcArgs('fn', { x: ' 42' }, intArgSchema),
        (err) => err.code === 'PGRST208',
        'should throw PGRST208 for " 42" on int4',
      );
    });
  });
});

describe('GET param disambiguation', () => {
  it('dotted value not classified as filter', () => {
    if (!classifyRpcParam) {
      assert.fail(
        'classifyRpcParam not exported from handler.mjs — '
        + 'export the function or the OP_PREFIX regex so this '
        + 'test can verify that "john.doe" is classified as an '
        + 'argument, not a filter',
      );
      return;
    }
    const result = classifyRpcParam('name', 'john.doe');
    assert.equal(result, 'arg',
      '"john.doe" should be classified as an argument, '
      + 'not a filter (OP_PREFIX false positive on dotted values)');
  });
});
