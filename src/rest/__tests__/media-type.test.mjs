// Accept negotiation, Content-Type bytes, nulls=stripped and CSV rendering.
// Pinned to upstream `PostgREST.MediaType` and `PostgREST.Response`.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeMediaType, mediaContentType, negotiateMedia, stripNulls, toCsv,
  success, mediaProducible, mediaUnavailable, mediaTypeDomain, rawMediaFor,
  acceptsOpenApi,
  MEDIA_JSON, MEDIA_SINGULAR, MEDIA_CSV, MEDIA_OPENAPI, MEDIA_OTHER,
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

  // OpenApiSpec.hs:30 — only the root path produces the OpenAPI media type;
  // a relation or a routine has no handler for it, so `{ openApi: false }` has
  // to fall through to the next entry and, failing that, to MEDIA_OTHER, which
  // is what the caller turns into PGRST107.
  it('does not produce the OpenAPI media type when it is not offered', () => {
    assert.equal(negotiateMedia('application/openapi+json',
      { openApi: false }).kind, MEDIA_OTHER);
    assert.equal(negotiateMedia('application/openapi+json, text/csv',
      { openApi: false }).kind, MEDIA_CSV);
    assert.equal(negotiateMedia('application/openapi+json',
      { openApi: true }).kind, MEDIA_OPENAPI);
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

// Content negotiation against what the engine can produce. Upstream
// `Plan/Negotiate.hs` intersects the Accept header with the media handlers in
// the schema cache; nothing in the intersection is `MediaTypeError` — 406
// PGRST107 (Error.hs:181).
// The root path produces the OpenAPI spec alone. Upstream `Plan.inspectPlan`
// intersects the Accept header with `[MTOpenAPI, MTApplicationJSON, MTAny]`
// and raises MediaTypeError when nothing matches (OpenApiSpec.hs:35).
describe('acceptsOpenApi', () => {
  it('accepts the openapi media type, json and the wildcard', () => {
    for (const accept of ['application/openapi+json', 'application/json',
      '*/*', 'application/openapi+json; charset=utf-8']) {
      assert.equal(acceptsOpenApi(accept), true, accept);
    }
  });

  it('accepts a match anywhere in the list, whatever its position', () => {
    assert.equal(acceptsOpenApi('text/csv, application/json'), true);
  });

  it('accepts a request with no Accept header', () => {
    assert.equal(acceptsOpenApi(''), true);
    assert.equal(acceptsOpenApi(undefined), true);
  });

  it('refuses anything else', () => {
    for (const accept of ['text/csv', 'text/plain', 'application/geo+json',
      'application/vnd.pgrst.object+json']) {
      assert.equal(acceptsOpenApi(accept), false, accept);
    }
  });
});

describe('mediaProducible / mediaUnavailable', () => {
  it('accepts json, csv, the vendored types and the wildcard', () => {
    for (const accept of ['', '*/*', 'application/json', 'text/csv',
      'application/vnd.pgrst.object+json',
      'application/vnd.pgrst.array+json;nulls=stripped',
      'application/openapi+json']) {
      assert.equal(mediaProducible(negotiateMedia(accept)), true, accept);
    }
  });

  it('refuses a media type the engine has no handler for', () => {
    for (const accept of ['text/plain', 'text/unknowntype', 'undefined',
      'application/vnd.twkb', 'application/octet-stream']) {
      assert.equal(mediaProducible(negotiateMedia(accept)), false, accept);
    }
  });

  it('accepts when any entry is producible, whatever its position', () => {
    assert.equal(mediaProducible(negotiateMedia('text/unknowntype, */*')), true);
    assert.equal(
      mediaProducible(negotiateMedia('text/unknowntype, text/csv')), true);
  });

  // QuerySpec.hs:1192 pins the message; CustomMediaSpec.hs:396 sends a garbage
  // token and expects it echoed as-is.
  it('builds the PGRST107 error listing every media type asked for', () => {
    const err = mediaUnavailable('text/unknowntype');
    assert.equal(err.statusCode, 406);
    assert.equal(err.code, 'PGRST107');
    assert.equal(err.message,
      'None of these media types are available: text/unknowntype');
    assert.equal(err.details, null);
    assert.equal(err.hint, null);
    assert.equal(mediaUnavailable('undefined').message,
      'None of these media types are available: undefined');
    assert.equal(mediaUnavailable('text/plain, image/png').message,
      'None of these media types are available: text/plain, image/png');
  });
});

// `create domain "text/plain" as text` names a media type, and a function
// returning that domain produces it (upstream `SchemaCache.mediaHandlers`).
describe('mediaTypeDomain', () => {
  it('reads the media type off a domain name', () => {
    assert.equal(mediaTypeDomain('text/plain'), 'text/plain');
    assert.equal(mediaTypeDomain('application/vnd.twkb'),
      'application/vnd.twkb');
    assert.equal(mediaTypeDomain('text/tab-separated-values'),
      'text/tab-separated-values');
  });

  it('resolves the wildcard domain to octet-stream', () => {
    assert.equal(mediaTypeDomain('*/*'), 'application/octet-stream');
  });

  it('is null for an ordinary type', () => {
    for (const t of ['text', 'int4', 'json', 'items', '', null]) {
      assert.equal(mediaTypeDomain(t), null, String(t));
    }
  });
});

describe('rawMediaFor', () => {
  it('matches the domain the client asked for', () => {
    const media = rawMediaFor('text/plain', 'text/plain');
    assert.equal(media.contentType, 'text/plain; charset=utf-8');
    assert.equal(media.kind, MEDIA_OTHER);
    assert.equal(mediaContentType(media), 'text/plain; charset=utf-8');
  });

  it('leaves the charset off a media type upstream does not name', () => {
    assert.equal(rawMediaFor('text/html', 'text/html').contentType,
      'text/html');
  });

  it('matches any Accept for the wildcard domain, as octet-stream', () => {
    for (const accept of ['*/*', 'app/bingo', 'image/boingo', '']) {
      assert.equal(rawMediaFor(accept, '*/*').contentType,
        'application/octet-stream', accept);
    }
  });

  // CustomMediaSpec.hs:117 — `welcome` returns the "text/plain" domain, so
  // text/xml is not available and upstream answers 406 rather than raw bytes.
  it('does not match a different media type', () => {
    assert.equal(rawMediaFor('text/xml', 'text/plain'), null);
    assert.equal(rawMediaFor('application/json', 'text/plain'), null);
  });

  // Plan/Negotiate.hs only looks up `(RelId, MTAny)`, which only the wildcard
  // domain registers, so `Accept: */*` on a text/plain function is JSON.
  it('does not match a wildcard Accept against a named domain', () => {
    assert.equal(rawMediaFor('*/*', 'text/plain'), null);
  });

  it('is null for a function that returns an ordinary type', () => {
    assert.equal(rawMediaFor('text/plain', 'text'), null);
  });

  it('picks the domain out of a multi-entry Accept', () => {
    assert.equal(
      rawMediaFor('text/xml, text/plain', 'text/plain').contentType,
      'text/plain; charset=utf-8');
  });
});
