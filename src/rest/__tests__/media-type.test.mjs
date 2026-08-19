// Accept negotiation, Content-Type bytes, nulls=stripped and CSV rendering.
// Pinned to upstream `PostgREST.MediaType` and `PostgREST.Response`.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeMediaType, mediaContentType, negotiateMedia, stripNulls, toCsv,
  success, MEDIA_JSON, MEDIA_SINGULAR, MEDIA_CSV, MEDIA_OPENAPI, MEDIA_OTHER,
} from '../response.mjs';

describe('decodeMediaType', () => {
  it('lowercases the type and the parameter names', () => {
    assert.deepEqual(decodeMediaType('APPLICATION/JSON; Charset=UTF-8'), {
      main: 'application', sub: 'json', params: { charset: 'UTF-8' },
    });
  });

  it('unquotes parameter values', () => {
    const { params } = decodeMediaType('application/json; profile="tenant"');
    assert.equal(params.profile, 'tenant');
  });
});

describe('negotiateMedia', () => {
  it('defaults to JSON for a missing Accept', () => {
    assert.deepEqual(negotiateMedia(''), { kind: MEDIA_JSON, stripNulls: false });
    assert.deepEqual(negotiateMedia(undefined),
      { kind: MEDIA_JSON, stripNulls: false });
  });

  it('treats */* as JSON', () => {
    assert.equal(negotiateMedia('*/*').kind, MEDIA_JSON);
  });

  it('recognises the singular media type', () => {
    assert.equal(
      negotiateMedia('application/vnd.pgrst.object+json').kind, MEDIA_SINGULAR);
    assert.equal(
      negotiateMedia('application/vnd.pgrst.object').kind, MEDIA_SINGULAR);
  });

  it('recognises the array media type and nulls=stripped', () => {
    const m = negotiateMedia('application/vnd.pgrst.array+json;nulls=stripped');
    assert.equal(m.kind, MEDIA_JSON);
    assert.equal(m.stripNulls, true);
  });

  it('recognises text/csv and application/openapi+json', () => {
    assert.equal(negotiateMedia('text/csv').kind, MEDIA_CSV);
    assert.equal(negotiateMedia('application/openapi+json').kind,
      MEDIA_OPENAPI);
  });

  it('picks the first producible type in order', () => {
    assert.equal(negotiateMedia('application/geo+json, text/csv').kind,
      MEDIA_CSV);
  });

  it('honours q-values', () => {
    assert.equal(negotiateMedia('text/csv;q=0.5, application/json;q=0.9').kind,
      MEDIA_JSON);
  });

  it('reports an unproducible Accept as MEDIA_OTHER with its mime', () => {
    const m = negotiateMedia('application/vnd.geo2+json');
    assert.equal(m.kind, MEDIA_OTHER);
    assert.equal(m.mime, 'application/vnd.geo2+json');
  });
});

describe('mediaContentType', () => {
  it('emits the charset on every produced type', () => {
    assert.equal(mediaContentType({ kind: MEDIA_JSON, stripNulls: false }),
      'application/json; charset=utf-8');
    assert.equal(mediaContentType({ kind: MEDIA_SINGULAR, stripNulls: false }),
      'application/vnd.pgrst.object+json; charset=utf-8');
    assert.equal(mediaContentType({ kind: MEDIA_CSV, stripNulls: false }),
      'text/csv; charset=utf-8');
    assert.equal(mediaContentType({ kind: MEDIA_OPENAPI, stripNulls: false }),
      'application/openapi+json; charset=utf-8');
  });

  it('echoes nulls=stripped', () => {
    assert.equal(mediaContentType({ kind: MEDIA_JSON, stripNulls: true }),
      'application/vnd.pgrst.array+json;nulls=stripped; charset=utf-8');
    assert.equal(mediaContentType({ kind: MEDIA_SINGULAR, stripNulls: true }),
      'application/vnd.pgrst.object+json;nulls=stripped; charset=utf-8');
  });
});

describe('stripNulls', () => {
  it('drops null object members recursively', () => {
    assert.deepEqual(
      stripNulls([{ a: 1, b: null, c: { d: null, e: 2 } }]),
      [{ a: 1, c: { e: 2 } }]);
  });

  it('keeps null array elements', () => {
    assert.deepEqual(stripNulls({ a: [1, null] }), { a: [1, null] });
  });
});

describe('toCsv', () => {
  it('writes a header line from the first row', () => {
    assert.equal(toCsv([{ id: 1, name: 'a' }]), 'id,name\n1,a');
  });

  it('renders null as an empty field', () => {
    assert.equal(toCsv([{ id: 1, name: null }]), 'id,name\n1,');
  });

  it('quotes fields containing a comma, quote or newline', () => {
    assert.equal(toCsv([{ a: 'x,y' }]), 'a\n"x,y"');
    assert.equal(toCsv([{ a: 'he said "hi"' }]), 'a\n"he said ""hi"""');
  });

  it('renders an empty result as a single newline', () => {
    assert.equal(toCsv([]), '\n');
  });
});

describe('success Content-Type', () => {
  it('omits Content-Type when there is no body', () => {
    const res = success(204, null, {});
    assert.equal(res.headers['Content-Type'], undefined);
    assert.equal(res.body, '');
  });

  it('sets Content-Type when there is a body', () => {
    const res = success(200, [{ a: 1 }], {});
    assert.equal(res.headers['Content-Type'], 'application/json; charset=utf-8');
  });

  it('keeps the headers but drops the body for HEAD', () => {
    const res = success(200, [{ a: 1 }],
      { headersOnly: true, contentRange: '0-0/*' });
    assert.equal(res.body, '');
    assert.equal(res.headers['Content-Type'], 'application/json; charset=utf-8');
    assert.equal(res.headers['Content-Range'], '0-0/*');
  });

  it('serializes a bare JSON null body when asked to', () => {
    const res = success(200, null, { serializedBody: 'null' });
    assert.equal(res.body, 'null');
    assert.equal(res.headers['Content-Type'], 'application/json; charset=utf-8');
  });

  it('emits Content-Range and Preference-Applied when given', () => {
    const res = success(200, [{ a: 1 }],
      { contentRange: '0-0/1', preferenceApplied: 'count=exact' });
    assert.equal(res.headers['Content-Range'], '0-0/1');
    assert.equal(res.headers['Preference-Applied'], 'count=exact');
  });

  it('fails with PGRST116 when the singular type gets the wrong row count',
    () => {
      const media = { kind: MEDIA_SINGULAR, stripNulls: false };
      assert.throws(() => success(200, [{ a: 1 }, { a: 2 }], { media }),
        (err) => {
          assert.equal(err.statusCode, 406);
          assert.equal(err.code, 'PGRST116');
          assert.equal(err.details, 'The result contains 2 rows');
          return true;
        });
      assert.throws(() => success(200, [], { media }), (err) => {
        assert.equal(err.details, 'The result contains 0 rows');
        return true;
      });
    });

  it('unwraps the single row for the singular type', () => {
    const res = success(200, [{ a: 1 }],
      { media: { kind: MEDIA_SINGULAR, stripNulls: false } });
    assert.deepEqual(JSON.parse(res.body), { a: 1 });
  });
});
