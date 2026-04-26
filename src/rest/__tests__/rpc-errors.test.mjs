import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PostgRESTError } from '../errors.mjs';
import { error } from '../response.mjs';

describe('RPC error codes', () => {
  it('PGRST101 has statusCode 405 and correct message', () => {
    const err = new PostgRESTError(
      405, 'PGRST101',
      'Only GET, POST, and HEAD are allowed for RPC',
    );
    assert.equal(err.statusCode, 405);
    assert.equal(err.code, 'PGRST101');
    assert.ok(err.message.includes('Only GET, POST, and Head are allowed for RPC')
      || err.message.includes('Only GET, POST, and HEAD are allowed for RPC'));
  });

  it('PGRST202 has statusCode 404 and correct message', () => {
    const err = new PostgRESTError(
      404, 'PGRST202',
      "Could not find the function 'x' in the schema cache",
    );
    assert.equal(err.statusCode, 404);
    assert.equal(err.code, 'PGRST202');
    assert.ok(err.message.includes("function 'x'"));
  });

  it('PGRST203 has statusCode 300 and overloaded text', () => {
    const err = new PostgRESTError(
      300, 'PGRST203',
      "Could not choose the best candidate function between: calc(a integer), calc(a text)",
    );
    assert.equal(err.statusCode, 300);
    assert.equal(err.code, 'PGRST203');
    assert.ok(err.message.includes('candidate function'));
  });

  it('PGRST207 has statusCode 400 and unknown argument text', () => {
    const err = new PostgRESTError(
      400, 'PGRST207',
      "Function 'add' does not have an argument named 'c'",
    );
    assert.equal(err.statusCode, 400);
    assert.equal(err.code, 'PGRST207');
    assert.ok(err.message.includes("argument named 'c'"));
  });

  it('PGRST208 has statusCode 400 and type coercion text', () => {
    const err = new PostgRESTError(
      400, 'PGRST208',
      "Argument 'x' of function 'fn' expects type 'int4' "
      + 'but received a value that could not be coerced',
    );
    assert.equal(err.statusCode, 400);
    assert.equal(err.code, 'PGRST208');
    assert.ok(err.message.includes('could not be coerced'));
  });

  it('PGRST209 has statusCode 400 and missing required arg text', () => {
    const err = new PostgRESTError(
      400, 'PGRST209',
      "Function 'calc' requires argument 'b' which was not provided",
    );
    assert.equal(err.statusCode, 400);
    assert.equal(err.code, 'PGRST209');
    assert.ok(err.message.includes("requires argument 'b'"));
  });

  it('PGRST403 has statusCode 403 and permission denied text', () => {
    const err = new PostgRESTError(
      403, 'PGRST403',
      "Permission denied for function 'x'",
    );
    assert.equal(err.statusCode, 403);
    assert.equal(err.code, 'PGRST403');
    assert.ok(err.message.includes('Permission denied')
      || err.message.includes('Not authorized'));
  });

  it('PGRST501 has statusCode 501 and rpc not supported text', () => {
    const err = new PostgRESTError(
      501, 'PGRST501',
      'RPC is not supported on this database',
    );
    assert.equal(err.statusCode, 501);
    assert.equal(err.code, 'PGRST501');
    assert.ok(err.message.includes('RPC is not supported'));
  });

  describe('JSON shape through error() response formatter', () => {
    const codes = [
      { code: 'PGRST101', status: 405, msg: 'Only GET, POST, and HEAD are allowed for RPC' },
      { code: 'PGRST202', status: 404, msg: "Could not find the function 'x' in the schema cache" },
      { code: 'PGRST203', status: 300, msg: 'Could not choose the best candidate function' },
      { code: 'PGRST207', status: 400, msg: "Function 'add' does not have an argument named 'c'" },
      { code: 'PGRST208', status: 400, msg: "Argument 'x' expects type 'int4'" },
      { code: 'PGRST209', status: 400, msg: "Function 'calc' requires argument 'b'" },
      { code: 'PGRST403', status: 403, msg: "Permission denied for function 'x'" },
      { code: 'PGRST501', status: 501, msg: 'RPC is not supported on this database' },
    ];

    for (const { code, status, msg } of codes) {
      it(`${code} produces { code, message, details, hint } via error()`, () => {
        const err = new PostgRESTError(status, code, msg, null, null);
        const res = error(err);
        assert.equal(res.statusCode, status);
        const body = JSON.parse(res.body);
        assert.equal(body.code, code);
        assert.equal(body.message, msg);
        assert.ok('details' in body, 'should have details key');
        assert.ok('hint' in body, 'should have hint key');
      });
    }
  });
});
