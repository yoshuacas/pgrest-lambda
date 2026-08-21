// Tests that pin the meaning of the equivalence policy set, without a
// database.
//
// conformance/cedar/policies/*.cedar is a translation of the privilege
// statements in conformance/fixtures/dsql/06-privileges.sql. If a later edit
// widens one of those permits, the measured equivalences would rise for a
// reason that has nothing to do with the engine. These tests assert the
// translation, permit by permit, straight against src/rest/cedar.mjs.

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createCedar } from '../../../src/rest/cedar.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const POLICY_DIR = join(HERE, '..', 'policies');

const POLICY_FILES = readdirSync(POLICY_DIR)
  .filter((f) => f.endsWith('.cedar')).sort();

const POLICY_TEXT = POLICY_FILES
  .map((f) => readFileSync(join(POLICY_DIR, f), 'utf8')).join('\n');

/** Policy text with `//` comment lines removed, for the hygiene checks. */
function policyCode(text) {
  return text.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
}

const TABLES = ['authors_only', 'app_users', 'insertonly',
  'limited_article_stars', 'projects', 'items'];

const schema = {
  tables: Object.fromEntries(TABLES.map((t) => [t, {
    columns: {
      id: { type: 'integer', nullable: false, defaultValue: null },
      owner: { type: 'text', nullable: true, defaultValue: null },
    },
  }])),
  functions: {
    privileged_hello: {},
    hello: {},
  },
};

const ANON = { role: 'anon', userId: '', email: '' };
const AUTHOR = {
  role: 'postgrest_test_author',
  userId: 'jdoe',
  email: 'jdoe@example.com',
};
const OTHER_ROLE = {
  role: 'postgrest_test_default_role', userId: 'u1', email: '',
};
const NO_ROLE_CLAIM = { role: 'authenticated', userId: 'u2', email: '' };

function makeCedar() {
  const cedar = createCedar({ policiesPath: POLICY_DIR, production: false });
  cedar._setPolicies({ staticPolicies: POLICY_TEXT });
  return cedar;
}

/** Does a read of `table` by `principal` get through? */
function canRead(cedar, principal, table) {
  try {
    cedar.buildAuthzFilter({
      principal, action: 'select', context: { table }, schema, startParam: 1,
    });
    return true;
  } catch {
    return false;
  }
}

/** Does a call of `fn` by `principal` get through? */
function canCall(cedar, principal, fn) {
  try {
    cedar.authorize({
      principal, action: 'call', resource: fn,
      resourceType: 'Function', schema,
    });
    return true;
  } catch {
    return false;
  }
}

describe('equivalence policy set: file hygiene', () => {
  it('is not empty', () => {
    assert.ok(POLICY_FILES.length >= 2, POLICY_FILES.join(','));
    assert.ok(POLICY_TEXT.length > 500);
  });

  it('never scopes a policy with `resource == PgrestLambda::Table::`', () => {
    // A read is authorized by partial evaluation with the resource unknown, so
    // such a scope becomes a residual `==` against an entity literal that
    // translateExpr cannot turn into SQL: the request 500s, and which of a
    // 200 / 500 you get depends on residual order. Table rules key on
    // context.table instead.
    for (const file of POLICY_FILES) {
      const code = policyCode(readFileSync(join(POLICY_DIR, file), 'utf8'));
      assert.doesNotMatch(code, /resource\s*==\s*PgrestLambda::Table::/,
        `${file}: scope a table rule with context.table, not a Table literal`);
    }
  });

  it('names no status code and no response body', () => {
    // The policy set translates 06-privileges.sql. If it started naming an
    // expected status it would be fitting the tests, not the fixture.
    assert.doesNotMatch(policyCode(POLICY_TEXT),
      /\b(401|403|404|PGRST\d+|42501)\b/);
  });
});

describe('equivalence policy set: anonymous caller', () => {
  let cedar;
  beforeEach(() => { cedar = makeCedar(); });

  it('reads a table the fixture grants (GRANT ALL ... TO anonymous)', () => {
    assert.equal(canRead(cedar, ANON, 'projects'), true);
    assert.equal(canRead(cedar, ANON, 'items'), true);
  });

  it('adds no row filter to a granted read', () => {
    // The fixture's grant is table-wide, so the equivalent Cedar permit must
    // not narrow the result set — otherwise a 200 would still return a
    // different body.
    const filter = cedar.buildAuthzFilter({
      principal: ANON, action: 'select', context: { table: 'projects' },
      schema, startParam: 1,
    });
    assert.deepEqual(filter.conditions, []);
    assert.deepEqual(filter.values, []);
  });

  it('is denied every table the fixture REVOKEs from anonymous', () => {
    for (const table of ['app_users', 'authors_only', 'insertonly',
      'limited_article_stars']) {
      assert.equal(canRead(cedar, ANON, table), false, table);
    }
  });

  it('may insert into insertonly but not read it (GRANT INSERT only)', () => {
    assert.equal(canRead(cedar, ANON, 'insertonly'), false);
    assert.doesNotThrow(() => cedar.authorize({
      principal: ANON, action: 'insert', resource: 'insertonly',
      resourceType: 'Table', schema,
    }));
  });

  it('may call a function EXECUTE is PUBLIC on', () => {
    assert.equal(canCall(cedar, ANON, 'hello'), true);
  });

  it('may not call the function the fixture REVOKEs from PUBLIC', () => {
    assert.equal(canCall(cedar, ANON, 'privileged_hello'), false);
  });
});

describe('equivalence policy set: role claim', () => {
  let cedar;
  beforeEach(() => { cedar = makeCedar(); });

  it('postgrest_test_author reads authors_only (GRANT ALL to that role)', () => {
    assert.equal(canRead(cedar, AUTHOR, 'authors_only'), true);
  });

  it('and gets no row filter, so the whole table comes back', () => {
    const filter = cedar.buildAuthzFilter({
      principal: AUTHOR, action: 'select', context: { table: 'authors_only' },
      schema, startParam: 1,
    });
    assert.deepEqual(filter.conditions, []);
    assert.deepEqual(filter.values, []);
  });

  it('postgrest_test_author may write authors_only', () => {
    for (const action of ['insert', 'update']) {
      assert.doesNotThrow(() => cedar.authorize({
        principal: AUTHOR, action, resource: 'authors_only',
        resourceType: 'Table', schema,
      }), action);
    }
    assert.equal(canRead(cedar, AUTHOR, 'authors_only'), true);
  });

  it('postgrest_test_author may call privileged_hello', () => {
    assert.equal(canCall(cedar, AUTHOR, 'privileged_hello'), true);
  });

  it('any other role holds no table privilege — roles.sql grants no '
     + 'membership between the test roles', () => {
    for (const principal of [OTHER_ROLE, NO_ROLE_CLAIM]) {
      assert.equal(canRead(cedar, principal, 'authors_only'), false,
        principal.role);
      // Not just authors_only: the anonymous blanket grant belongs to
      // AnonRole, and no permit gives it to a token-bearing caller.
      assert.equal(canRead(cedar, principal, 'projects'), false,
        principal.role);
    }
  });

  it('any other role may not call privileged_hello', () => {
    assert.equal(canCall(cedar, OTHER_ROLE, 'privileged_hello'), false);
    assert.equal(canCall(cedar, NO_ROLE_CLAIM, 'privileged_hello'), false);
  });

  it('but keeps EXECUTE on functions PUBLIC holds it on', () => {
    assert.equal(canCall(cedar, OTHER_ROLE, 'hello'), true);
  });

  it('a nonexistent role name is simply an ungranted role', () => {
    // Cedar's principal set is open: "not existing" is indistinguishable from
    // a real role with no grant. This is why ErrorSpec:123's equivalence
    // carries the caveat it does.
    const ghost = { role: 'not existing', userId: 'u3', email: '' };
    assert.equal(canRead(cedar, ghost, 'authors_only'), false);
  });
});

describe('equivalence policy set: denial shape', () => {
  // This test used to assert 403 for an anonymous caller and pin the
  // divergence the equivalence suite measured. The divergence is now fixed:
  // src/rest/cedar.mjs routes every denial through denyError(), which picks the
  // status the way errors.mjs already picks it for a real PostgreSQL 42501
  // (`authed ? 403 : 401`). The assertion moves from "records the gap" to
  // "holds the fix", which is why the expectation flipped rather than loosened.
  it('answers an anonymous denial 401 with WWW-Authenticate, as upstream does', () => {
    const cedar = makeCedar();
    assert.throws(() => cedar.buildAuthzFilter({
      principal: ANON, action: 'select', context: { table: 'authors_only' },
      schema, startParam: 1,
    }), (err) => {
      assert.equal(err.statusCode, 401,
        'an anonymous caller might succeed if it authenticated');
      assert.equal(err.code, 'PGRST403');
      assert.deepEqual(err.responseHeaders, { 'WWW-Authenticate': 'Bearer' });
      return true;
    });
  });

  it('answers an authenticated denial 403 with no WWW-Authenticate', () => {
    // Authenticating again cannot help, so there is nothing to challenge for.
    const cedar = makeCedar();
    const known = { role: 'postgrest_test_author', userId: 'u1', email: '' };
    assert.throws(() => cedar.buildAuthzFilter({
      principal: known, action: 'select', context: { table: 'app_users' },
      schema, startParam: 1,
    }), (err) => {
      assert.equal(err.statusCode, 403);
      assert.equal(err.code, 'PGRST403');
      assert.equal(err.responseHeaders, undefined);
      return true;
    });
  });

  it('does not depend on residual order for a granted read', () => {
    // Same request twice through two instances: buildAuthzFilter returns
    // early on the first trivially-true permit residual, so a policy set
    // mixing Table-literal scopes with Row rules can answer 200 or 500 for
    // the same request. This set must be stable.
    for (let i = 0; i < 5; i++) {
      const cedar = makeCedar();
      const filter = cedar.buildAuthzFilter({
        principal: ANON, action: 'select', context: { table: 'projects' },
        schema, startParam: 1,
      });
      assert.deepEqual(filter.conditions, []);
    }
  });
});
