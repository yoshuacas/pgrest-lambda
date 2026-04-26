import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PostgRESTError } from '../errors.mjs';
import { error } from '../response.mjs';

const MESSAGE = "operator 'fts' requires full-text search support, "
  + 'which Aurora DSQL does not provide';
const HINT = "use 'ilike' or a separate search index, "
  + 'or deploy on standard PostgreSQL';

describe('PGRST501 error', () => {
  it('toJSON() returns the expected shape', () => {
    const err = new PostgRESTError(501, 'PGRST501', MESSAGE, null, HINT);

    assert.equal(err.statusCode, 501);
    assert.deepStrictEqual(err.toJSON(), {
      code: 'PGRST501',
      message: MESSAGE,
      details: null,
      hint: HINT,
    });
  });

  it('passes through the response formatter', () => {
    const err = new PostgRESTError(501, 'PGRST501', MESSAGE, null, HINT);
    const res = error(err);

    assert.equal(res.statusCode, 501);
    assert.equal(res.headers['Content-Type'], 'application/json');

    const body = JSON.parse(res.body);
    assert.equal(body.code, 'PGRST501');
    assert.equal(body.message, MESSAGE);
    assert.equal(body.details, null);
    assert.equal(body.hint, HINT);
  });
});
