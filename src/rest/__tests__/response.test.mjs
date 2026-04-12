import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { success, error } from '../response.mjs';
import { PostgRESTError } from '../errors.mjs';

describe('response', () => {
  describe('SELECT responses', () => {
    it('returns 200 with bare JSON array for SELECT result', () => {
      const rows = [{ id: '1', title: 'Test' }];
      const res = success(200, rows);
      assert.equal(res.statusCode, 200, 'status should be 200');
      const body = JSON.parse(res.body);
      assert.ok(Array.isArray(body), 'body should be a JSON array');
      assert.equal(body.length, 1);
    });
  });

  describe('INSERT responses', () => {
    it('returns 201 with array body for return=representation', () => {
      const rows = [{ id: '1', title: 'New' }];
      const res = success(201, rows);
      assert.equal(res.statusCode, 201, 'status should be 201');
      const body = JSON.parse(res.body);
      assert.ok(Array.isArray(body), 'body should be a JSON array');
    });

    it('returns 201 with empty body without representation', () => {
      const res = success(201);
      assert.equal(res.statusCode, 201, 'status should be 201');
      assert.ok(!res.body || res.body === '' || res.body === '""' || res.body === 'null',
        'body should be empty');
    });
  });

  describe('UPDATE responses', () => {
    it('returns 200 with array body for return=representation', () => {
      const rows = [{ id: '1', title: 'Updated' }];
      const res = success(200, rows);
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.ok(Array.isArray(body), 'body should be an array');
    });

    it('returns 204 with empty body without representation', () => {
      const res = success(204);
      assert.equal(res.statusCode, 204, 'status should be 204');
      assert.ok(!res.body || res.body === '',
        'body should be empty for 204');
    });
  });

  describe('DELETE responses', () => {
    it('returns 200 with array body for return=representation', () => {
      const rows = [{ id: '1' }];
      const res = success(200, rows);
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.ok(Array.isArray(body));
    });

    it('returns 204 with empty body without representation', () => {
      const res = success(204);
      assert.equal(res.statusCode, 204);
    });
  });

  describe('Content-Range header', () => {
    it('sets Content-Range 0-19/* correctly', () => {
      const rows = Array.from({ length: 20 }, (_, i) => ({ id: String(i) }));
      const res = success(200, rows, { contentRange: '0-19/*' });
      assert.equal(res.headers['Content-Range'], '0-19/*',
        'Content-Range should be 0-19/*');
    });

    it('sets Content-Range with count 0-19/157', () => {
      const rows = Array.from({ length: 20 }, (_, i) => ({ id: String(i) }));
      const res = success(200, rows, { contentRange: '0-19/157' });
      assert.equal(res.headers['Content-Range'], '0-19/157',
        'Content-Range should include count');
    });

    it('sets Content-Range */* or */0 for empty result', () => {
      const res = success(200, [], { contentRange: '*/*' });
      const cr = res.headers['Content-Range'];
      assert.ok(cr === '*/*' || cr === '*/0',
        'Content-Range for empty result should be */* or */0');
    });
  });

  describe('single object mode', () => {
    it('returns single object (not array) with 1 row', () => {
      const rows = [{ id: '1', title: 'Only' }];
      const res = success(200, rows, { singleObject: true });
      const body = JSON.parse(res.body);
      assert.ok(!Array.isArray(body), 'body should not be an array');
      assert.equal(body.id, '1', 'body should be the single object');
    });

    it('throws PGRST116 with 0 rows', () => {
      assert.throws(
        () => success(200, [], { singleObject: true }),
        (err) => err.code === 'PGRST116',
        'should throw PGRST116 for 0 rows in single object mode'
      );
    });

    it('throws PGRST116 with more than 1 row', () => {
      const rows = [{ id: '1' }, { id: '2' }];
      assert.throws(
        () => success(200, rows, { singleObject: true }),
        (err) => err.code === 'PGRST116',
        'should throw PGRST116 for >1 rows in single object mode'
      );
    });
  });

  describe('error response', () => {
    it('includes code, message, details, hint fields', () => {
      const err = new PostgRESTError(400, 'PGRST100', 'bad parse', null, null);
      const res = error(err);
      const body = JSON.parse(res.body);
      assert.ok('code' in body, 'error body should have code');
      assert.ok('message' in body, 'error body should have message');
      assert.ok('details' in body, 'error body should have details');
      assert.ok('hint' in body, 'error body should have hint');
    });
  });

  describe('CORS headers', () => {
    it('includes CORS headers on all responses', () => {
      const res = success(200, []);
      const h = res.headers;
      assert.equal(h['Access-Control-Allow-Origin'], '*',
        'should have Allow-Origin: *');
      assert.ok(h['Access-Control-Allow-Headers']?.includes('apikey'),
        'Allow-Headers should include apikey');
      assert.ok(h['Access-Control-Allow-Headers']?.includes('X-Client-Info'),
        'Allow-Headers should include X-Client-Info');
      assert.ok(h['Access-Control-Allow-Methods']?.includes('PATCH'),
        'Allow-Methods should include PATCH');
      assert.ok(h['Access-Control-Expose-Headers']?.includes('Content-Range'),
        'Expose-Headers should include Content-Range');
    });
  });
});
