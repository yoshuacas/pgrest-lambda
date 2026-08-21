// Engine configuration surface: the request-time helpers behind db-schemas,
// db-extra-search-path, db-max-rows, db-aggregates-enabled, db-plan-enabled,
// jwt-secret / jwt-aud and the bulk-mutation guard. Behaviour is pinned to
// upstream PostgREST (Plan.hs treeRestrictRange, Error.hs PGRST106/300-303).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  resolveProfile, quoteIdent, searchPathValue, hasAggregate, wantsPlan,
  clampMaxRows, verifyRestJwt, applyBulkGuard,
  normalizeAppSettings, appSettingsSql,
} from '../handler.mjs';

describe('resolveProfile (db-schemas)', () => {
  it('picks the default schema and does not negotiate when one is exposed', () => {
    assert.deepEqual(resolveProfile(['public'], {}, 'GET'),
      { schema: 'public', negotiated: false });
  });

  it('negotiates by default when more than one schema is exposed', () => {
    assert.deepEqual(resolveProfile(['v1', 'v2'], {}, 'GET'),
      { schema: 'v1', negotiated: true });
  });

  it('honours Accept-Profile on reads', () => {
    assert.deepEqual(
      resolveProfile(['v1', 'v2'], { 'accept-profile': 'v2' }, 'GET'),
      { schema: 'v2', negotiated: true });
  });

  it('honours Content-Profile on writes and ignores Accept-Profile', () => {
    const headers = { 'content-profile': 'v2', 'accept-profile': 'v1' };
    assert.deepEqual(resolveProfile(['v1', 'v2'], headers, 'POST'),
      { schema: 'v2', negotiated: true });
  });

  it('ignores Content-Profile on reads', () => {
    assert.deepEqual(
      resolveProfile(['v1', 'v2'], { 'content-profile': 'v2' }, 'GET'),
      { schema: 'v1', negotiated: true });
  });

  it('rejects an unexposed schema with 406 PGRST106', () => {
    assert.throws(
      () => resolveProfile(['v1', 'v2'], { 'accept-profile': 'nope' }, 'GET'),
      (err) => {
        assert.equal(err.statusCode, 406);
        assert.equal(err.code, 'PGRST106');
        assert.equal(err.message, 'Invalid schema: nope');
        assert.equal(err.hint,
          'Only the following schemas are exposed: v1, v2');
        return true;
      });
  });
});

describe('searchPathValue (db-extra-search-path)', () => {
  it('puts the selected schema first', () => {
    assert.equal(searchPathValue('v1', ['public']), '"v1", "public"');
  });

  it('drops the selected schema from the extra list', () => {
    assert.equal(searchPathValue('public', ['public']), '"public"');
  });

  it('quotes a schema name that needs quoting', () => {
    assert.equal(searchPathValue('SPECIAL "@/\\#~_-', []),
      '"SPECIAL ""@/\\#~_-"');
  });

  it('keeps several extra schemas in order', () => {
    assert.equal(searchPathValue('public', ['public', 'extensions', 'tenant']),
      '"public", "extensions", "tenant"');
  });

  it('doubles embedded quotes in quoteIdent', () => {
    assert.equal(quoteIdent('a"b'), '"a""b"');
  });
});

// `app-settings` — upstream carries them as an ordered list of pairs
// (`configAppSettings`) and applies each one with
// `set_config(name, value, true)` in Query/PreQuery.hs `txVarQuery`, so a
// function can read one back with `current_setting('app.settings.<name>')`
// (RpcSpec.hs "app settings").
describe('normalizeAppSettings / appSettingsSql (app-settings)', () => {
  it('reads an object as pairs of strings', () => {
    assert.deepEqual(
      normalizeAppSettings({ 'app.settings.app_host': 'localhost' }),
      [['app.settings.app_host', 'localhost']]);
  });

  it('keeps the order of a list of pairs', () => {
    assert.deepEqual(
      normalizeAppSettings([['b', '2'], ['a', '1']]),
      [['b', '2'], ['a', '1']]);
  });

  it('stringifies non-string values', () => {
    assert.deepEqual(normalizeAppSettings({ n: 5, f: false }),
      [['n', '5'], ['f', 'false']]);
  });

  it('is empty for nothing configured', () => {
    for (const v of [undefined, null, {}, []]) {
      assert.deepEqual(normalizeAppSettings(v), []);
    }
  });

  it('drops entries with no name or no value', () => {
    assert.deepEqual(
      normalizeAppSettings([['', 'x'], [null, 'y'], ['ok', null], ['a', '1']]),
      [['a', '1']]);
  });

  it('binds every name and value, and sets them transaction-locally', () => {
    assert.equal(appSettingsSql([['a', '1']]),
      'select set_config($1, $2, true)');
    assert.equal(appSettingsSql([['a', '1'], ['b', '2']]),
      'select set_config($1, $2, true), set_config($3, $4, true)');
  });
});

describe('hasAggregate (db-aggregates-enabled)', () => {
  it('is false for plain columns', () => {
    assert.equal(hasAggregate([{ type: 'column', name: 'id' }]), false);
  });

  it('finds a top-level aggregate', () => {
    assert.equal(
      hasAggregate([{ type: 'column', name: 'id', agg: 'count' }]), true);
  });

  it('finds an aggregate nested in an embed', () => {
    const nodes = [{
      type: 'embed',
      select: [{ type: 'embed', select: [{ type: 'column', agg: 'sum' }] }],
    }];
    assert.equal(hasAggregate(nodes), true);
  });

  it('tolerates a non-array select', () => {
    assert.equal(hasAggregate(undefined), false);
  });
});

describe('wantsPlan (db-plan-enabled)', () => {
  it('detects the plan media type with parameters', () => {
    assert.equal(
      wantsPlan('application/vnd.pgrst.plan+json; for="application/json"'),
      true);
  });

  it('detects it in a list of accepted types', () => {
    assert.equal(wantsPlan('text/csv, application/vnd.pgrst.plan'), true);
  });

  it('is false for ordinary types and for no header', () => {
    assert.equal(wantsPlan('application/json'), false);
    assert.equal(wantsPlan(undefined), false);
  });
});

describe('clampMaxRows (db-max-rows)', () => {
  it('returns the plan untouched when the option is unset', () => {
    const parsed = { limit: null, select: [] };
    assert.equal(clampMaxRows(parsed, null), parsed);
  });

  it('applies the cap when no limit was asked for', () => {
    assert.equal(clampMaxRows({ limit: null, select: [] }, 2).limit, 2);
  });

  it('keeps a smaller client limit', () => {
    assert.equal(clampMaxRows({ limit: 1, select: [] }, 2).limit, 1);
  });

  it('lowers a larger client limit', () => {
    assert.equal(clampMaxRows({ limit: 10, select: [] }, 2).limit, 2);
  });

  it('caps embedded resources at any depth', () => {
    const parsed = {
      limit: null,
      select: [
        { type: 'column', name: 'id' },
        {
          type: 'embed',
          limit: 5,
          select: [{ type: 'embed', limit: null, select: [] }],
        },
      ],
    };
    const out = clampMaxRows(parsed, 2);
    assert.equal(out.select[0].limit, undefined);
    assert.equal(out.select[1].limit, 2);
    assert.equal(out.select[1].select[0].limit, 2);
  });

  it('honours a cap of zero', () => {
    assert.equal(clampMaxRows({ limit: 5, select: [] }, 0).limit, 0);
  });
});

describe('applyBulkGuard (bulk mutation guard)', () => {
  it('leaves the refusal to sql-builder when on', () => {
    const parsed = { filters: [] };
    assert.equal(applyBulkGuard('on', 'PATCH', parsed), parsed);
  });

  it('allows the mutation when off', () => {
    assert.equal(
      applyBulkGuard('off', 'PATCH', { filters: [] }).allowBulkMutation, true);
  });

  it('answers with pg-safeupdate wire error for UPDATE', () => {
    assert.throws(() => applyBulkGuard('safeupdate', 'PATCH', {}), (err) => {
      assert.equal(err.statusCode, 400);
      assert.equal(err.code, '21000');
      assert.equal(err.message, 'UPDATE requires a WHERE clause');
      return true;
    });
  });

  it('names DELETE in the safeupdate message', () => {
    assert.throws(() => applyBulkGuard('safeupdate', 'DELETE', {}),
      /DELETE requires a WHERE clause/);
  });
});

// --- jwt-secret / jwt-aud ---------------------------------------------------

const SECRET = 'reallyreallyreallyreallyverysafe';

function b64(obj) {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
}

function mint(claims, secret = SECRET, alg = 'HS256') {
  const signing = `${b64({ alg, typ: 'JWT' })}.${b64(claims)}`;
  const sig = createHmac(`sha${alg.slice(2)}`, secret)
    .update(signing).digest('base64url');
  return `${signing}.${sig}`;
}

const cfg = (over = {}) => ({
  secret: SECRET, audience: null, secretIsBase64: false, anonRole: 'anon',
  ...over,
});

// A verifier that only decodes, so the option handling is tested on its own.
const decode = (token) =>
  JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url')
    .toString('utf8'));

describe('verifyRestJwt (jwt-secret, jwt-aud, db-anon-role)', () => {
  it('runs a tokenless request as the anonymous role', () => {
    assert.deepEqual(verifyRestJwt(cfg(), undefined, decode),
      { role: 'anon', userId: '', email: '' });
  });

  it('refuses a tokenless request with PGRST302 when anon is disabled', () => {
    assert.throws(() => verifyRestJwt(cfg({ anonRole: null }), '', decode),
      (err) => {
        assert.equal(err.statusCode, 401);
        assert.equal(err.code, 'PGRST302');
        assert.equal(err.message, 'Anonymous access is disabled');
        assert.equal(err.responseHeaders['WWW-Authenticate'], 'Bearer');
        return true;
      });
  });

  it('takes the role from the claims', () => {
    const id = verifyRestJwt(
      cfg(), `Bearer ${mint({ role: 'postgrest_test_author', sub: 'u1' })}`,
      decode);
    assert.equal(id.role, 'postgrest_test_author');
    assert.equal(id.userId, 'u1');
  });

  it('falls back to the anonymous role when the token has none', () => {
    assert.equal(
      verifyRestJwt(cfg(), `Bearer ${mint({ sub: 'u1' })}`, decode).role,
      'anon');
  });

  it('answers PGRST300 with 500 when the server has no secret', () => {
    assert.throws(
      () => verifyRestJwt(cfg({ secret: null }), `Bearer ${mint({})}`, decode),
      (err) => {
        assert.equal(err.statusCode, 500);
        assert.equal(err.code, 'PGRST300');
        assert.equal(err.message, 'Server lacks JWT secret');
        return true;
      });
  });

  it('turns a verifier failure into PGRST301 with WWW-Authenticate', () => {
    const boom = () => { throw new Error('JWSError JWSInvalidSignature'); };
    assert.throws(
      () => verifyRestJwt(cfg(), `Bearer ${mint({})}`, boom), (err) => {
        assert.equal(err.statusCode, 401);
        assert.equal(err.code, 'PGRST301');
        assert.match(err.responseHeaders['WWW-Authenticate'],
          /^Bearer error="invalid_token"/);
        return true;
      });
  });

  it('accepts an audience that matches jwt-aud', () => {
    const token = `Bearer ${mint({ aud: 'youraudience', role: 'anon' })}`;
    assert.equal(
      verifyRestJwt(cfg({ audience: 'youraudience' }), token, decode).role,
      'anon');
  });

  it('accepts jwt-aud inside an audience array', () => {
    const token = `Bearer ${mint({ aud: ['other', 'youraudience'] })}`;
    assert.doesNotThrow(
      () => verifyRestJwt(cfg({ audience: 'youraudience' }), token, decode));
  });

  it('accepts a token with no audience claim', () => {
    assert.doesNotThrow(() => verifyRestJwt(
      cfg({ audience: 'youraudience' }), `Bearer ${mint({})}`, decode));
  });

  it('accepts a null audience claim', () => {
    assert.doesNotThrow(() => verifyRestJwt(
      cfg({ audience: 'youraudience' }), `Bearer ${mint({ aud: null })}`,
      decode));
  });

  it('rejects a foreign audience with PGRST303', () => {
    const token = `Bearer ${mint({ aud: 'notyouraudience' })}`;
    assert.throws(
      () => verifyRestJwt(cfg({ audience: 'youraudience' }), token, decode),
      (err) => {
        assert.equal(err.statusCode, 401);
        assert.equal(err.code, 'PGRST303');
        assert.equal(err.message, 'JWT not in audience');
        return true;
      });
  });

  it('ignores the audience claim when jwt-aud is unset', () => {
    const token = `Bearer ${mint({ aud: 'anything' })}`;
    assert.doesNotThrow(() => verifyRestJwt(cfg(), token, decode));
  });

  it('treats a malformed Authorization header as anonymous', () => {
    assert.equal(verifyRestJwt(cfg(), 'Basic dXNlcjpwYXNz', decode).role,
      'anon');
  });
});
