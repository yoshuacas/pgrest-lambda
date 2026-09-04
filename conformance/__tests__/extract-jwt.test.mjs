// Extractor: Authorization headers upstream builds at runtime.
//
// SpecHelper.hs signs its own tokens (`generateJWT`, `generateJWTWithSecret`)
// and splices `relativeSeconds n` into the claim set. The extractor records the
// claim set symbolically; the runner mints the token.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseSpec, validateDocument } from '../extract/parse-spec.mjs';

const SPEC_SECRET = 'reallyreallyreallyreallyverysafe';

function only(body, name = 'Feature/Auth/AuthSpec.hs') {
  const src = `module Test where\n\nspec :: SpecWith ((), Application)\nspec =\n  describe "auth" $ do\n${body}\n`;
  const doc = parseSpec(src, name);
  assert.equal(doc.cases.length, 1, `expected one site, got ${doc.cases.length}`);
  return doc.cases[0];
}

describe('generateJWT -> request.jwt', () => {
  it('records the spec secret and the literal claim set', () => {
    const c = only(`    it "succeeds with a role claim" $ do
      let jwtPayload = [json|{ "role": "postgrest_test_author" }|]
          auth = authHeaderJWT $ generateJWT jwtPayload
      request methodGet "/authors_only" [auth] ""
        \`shouldRespondWith\` 200`);
    assert.equal(c.skip, false, c.skipReason || '');
    assert.deepEqual(c.request.jwt, {
      alg: 'HS256',
      secret: SPEC_SECRET,
      claims: { role: 'postgrest_test_author' },
    });
    // The Authorization header itself is not baked into the case.
    assert.equal('Authorization' in c.request.headers, false);
  });

  it('keeps a relativeSeconds splice symbolic', () => {
    const c = only(`    it "it should return error if expired" $ do
      currentTime <- liftIO $ relativeSeconds (-35)
      let jwtPayload = [json|{ "exp": #{currentTime} }|]
          auth = authHeaderJWT $ generateJWT jwtPayload
      request methodGet "/authors_only" [auth] ""
        \`shouldRespondWith\` 401`);
    assert.equal(c.skip, false, c.skipReason || '');
    assert.deepEqual(c.request.jwt.claims, { exp: { $secondsFromNow: -35 } });
  });

  it('handles a positive relativeSeconds binding without liftIO', () => {
    const c = only(`    it "not yet valid" $ do
      currentTime <- relativeSeconds 35
      let jwtPayload = [json|{ "nbf": #{currentTime} }|]
          auth = authHeaderJWT $ generateJWT jwtPayload
      request methodGet "/authors_only" [auth] ""
        \`shouldRespondWith\` 401`);
    assert.equal(c.skip, false, c.skipReason || '');
    assert.deepEqual(c.request.jwt.claims, { nbf: { $secondsFromNow: 35 } });
  });

  it('records the per-case secret for generateJWTWithSecret', () => {
    const c = only(`    it "fails with a wrong secret" $ do
      let jwtPayload = [json|{ "role": "postgrest_test_author" }|]
          auth = authHeaderJWT $ generateJWTWithSecret jwtPayload "notthesamesecret"
      request methodGet "/authors_only" [auth] ""
        \`shouldRespondWith\` 401`);
    assert.equal(c.skip, false, c.skipReason || '');
    assert.equal(c.request.jwt.secret, 'notthesamesecret');
  });

  it('skips a splice that is not a relativeSeconds binding', () => {
    const c = only(`    it "unknown splice" $ do
      let jwtPayload = [json|{ "exp": #{somethingElse} }|]
          auth = authHeaderJWT $ generateJWT jwtPayload
      request methodGet "/authors_only" [auth] ""
        \`shouldRespondWith\` 401`);
    assert.equal(c.skip, true);
    assert.match(c.skipReason, /somethingElse/);
    assert.equal(c.skipClass, 'not-representable');
  });

  it('still passes validation', () => {
    const src = `module Test where\n\nspec :: SpecWith ((), Application)\nspec =\n  describe "auth" $ do\n    it "ok" $ do\n      let jwtPayload = [json|{ "role": "r" }|]\n          auth = authHeaderJWT $ generateJWT jwtPayload\n      request methodGet "/authors_only" [auth] ""\n        \`shouldRespondWith\` 200\n`;
    const doc = parseSpec(src, 'Feature/Auth/AuthSpec.hs');
    assert.deepEqual(validateDocument(doc, new Set()), []);
  });

  it('rejects a malformed request.jwt at validation', () => {
    const src = `module Test where\n\nspec :: SpecWith ((), Application)\nspec =\n  describe "auth" $ do\n    it "ok" $\n      get "/items" \`shouldRespondWith\` 200\n`;
    const doc = parseSpec(src, 'Feature/Auth/AuthSpec.hs');
    doc.cases[0].request.jwt = { alg: 'RS256', secret: 'x', claims: {} };
    const problems = validateDocument(doc, new Set());
    assert.equal(problems.length, 1);
    assert.match(problems[0], /jwt/);
  });
});
