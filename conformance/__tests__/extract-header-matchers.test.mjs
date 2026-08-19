// Extractor: the SpecHelper.hs header matchers that used to be skipped.
//
// Run with: node --test conformance/__tests__/
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseSpec, validateDocument } from '../extract/parse-spec.mjs';

/** Wrap assertion source in the minimal spec scaffolding the parser needs. */
function spec(body, name = 'Feature/Query/QuerySpec.hs') {
  return { src: `module Test where\n\nspec :: SpecWith ((), Application)\nspec =\n  describe "x" $ do\n${body}\n`, name };
}

function only(body) {
  const { src, name } = spec(body);
  const doc = parseSpec(src, name);
  assert.equal(doc.cases.length, 1, `expected one site, got ${doc.cases.length}`);
  return doc.cases[0];
}

describe('matchHeaderAbsent -> expected.headersAbsent', () => {
  it('records the header name and does not skip the case', () => {
    const c = only(`    it "no content length" $
      get "/items" \`shouldRespondWith\` ""
        { matchStatus = 204
        , matchHeaders = [matchHeaderAbsent hContentLength]
        }`);
    assert.equal(c.skip, false, c.skipReason || '');
    assert.deepEqual(c.expected.headersAbsent, ['Content-Length']);
    assert.deepEqual(c.expected.headers, {});
    assert.equal(c.skipClass, null);
  });

  it('resolves matchHeaderAbsent on a literal header name', () => {
    const c = only(`    it "no location" $
      get "/items" \`shouldRespondWith\` ""
        { matchStatus = 201
        , matchHeaders = [matchHeaderAbsent "Location"]
        }`);
    assert.equal(c.skip, false, c.skipReason || '');
    assert.deepEqual(c.expected.headersAbsent, ['Location']);
  });

  it('mixes with an exact header assertion in the same list', () => {
    const c = only(`    it "both" $
      get "/items" \`shouldRespondWith\` ""
        { matchStatus = 204
        , matchHeaders = [ matchHeaderAbsent hContentType
                         , "Preference-Applied" <:> "return=minimal" ]
        }`);
    assert.equal(c.skip, false, c.skipReason || '');
    assert.deepEqual(c.expected.headersAbsent, ['Content-Type']);
    assert.deepEqual(c.expected.headers, { 'Preference-Applied': 'return=minimal' });
  });

  it('omits headersAbsent when the spec asserts none', () => {
    const c = only(`    it "plain" $
      get "/items" \`shouldRespondWith\` 200`);
    assert.equal(c.skip, false, c.skipReason || '');
    assert.equal('headersAbsent' in c.expected, false);
  });
});

describe('matchHeaderValuePresent -> expected.headersContain', () => {
  it('records name and substring', () => {
    const c = only(`    it "allows post" $
      request methodOptions "/items" [] "" \`shouldRespondWith\` ""
        { matchStatus = 200
        , matchHeaders = [matchHeaderValuePresent "Access-Control-Allow-Methods" "POST"]
        }`);
    assert.equal(c.skip, false, c.skipReason || '');
    assert.deepEqual(c.expected.headersContain,
      [{ name: 'Access-Control-Allow-Methods', value: 'POST' }]);
  });
});

describe('matchServerTimingHasTiming -> expected.headersMatch', () => {
  it('translates the POSIX digit class to a JS regex', () => {
    const c = only(`    it "has timings" $
      get "/items" \`shouldRespondWith\` ""
        { matchStatus = 200
        , matchHeaders = [matchServerTimingHasTiming "parse"]
        }`);
    assert.equal(c.skip, false, c.skipReason || '');
    assert.deepEqual(c.expected.headersMatch,
      [{ name: 'Server-Timing', pattern: 'parse;dur=[0-9]+.[0-9]+' }]);
    assert.match('parse;dur=12.345',
      new RegExp(c.expected.headersMatch[0].pattern));
  });

  it('expands `map matchServerTimingHasTiming [..]` into one entry per metric', () => {
    const c = only(`    it "has all timings" $
      get "/items" \`shouldRespondWith\` ""
        { matchStatus = 200
        , matchHeaders = map matchServerTimingHasTiming ["jwt", "parse", "response"]
        }`);
    assert.equal(c.skip, false, c.skipReason || '');
    assert.deepEqual(c.expected.headersMatch.map((h) => h.pattern), [
      'jwt;dur=[0-9]+.[0-9]+',
      'parse;dur=[0-9]+.[0-9]+',
      'response;dur=[0-9]+.[0-9]+',
    ]);
  });
});

describe('matchers that are still not representable', () => {
  it('skips a raw regex matchHeader rather than guessing', () => {
    const c = only(`    it "regex header" $
      get "/items" \`shouldRespondWith\` ""
        { matchStatus = 200
        , matchHeaders = [matchHeader "Server-Timing" "[[:alpha:]]+"]
        }`);
    assert.equal(c.skip, true);
    assert.match(c.skipReason, /matchHeader/);
    assert.equal(c.skipClass, 'not-representable');
  });
});

describe('validateDocument', () => {
  it('accepts the header-matcher fields the extractor emits', () => {
    const doc = parseSpec(spec(`    it "ok" $
      get "/items" \`shouldRespondWith\` ""
        { matchStatus = 204
        , matchHeaders = [matchHeaderAbsent hContentLength]
        }`).src, 'Feature/Query/QuerySpec.hs');
    assert.deepEqual(validateDocument(doc, new Set()), []);
  });

  it('rejects an empty headersAbsent list', () => {
    const doc = parseSpec(spec(`    it "ok" $
      get "/items" \`shouldRespondWith\` 200`).src, 'Feature/Query/QuerySpec.hs');
    doc.cases[0].expected.headersAbsent = [];
    const problems = validateDocument(doc, new Set());
    assert.equal(problems.length, 1);
    assert.match(problems[0], /headersAbsent/);
  });

  it('rejects a headersMatch pattern that is not a regex', () => {
    const doc = parseSpec(spec(`    it "ok" $
      get "/items" \`shouldRespondWith\` 200`).src, 'Feature/Query/QuerySpec.hs');
    doc.cases[0].expected.headersMatch = [{ name: 'X', pattern: '([' }];
    const problems = validateDocument(doc, new Set());
    assert.equal(problems.length, 1);
    assert.match(problems[0], /not a regex/);
  });

  it('rejects an unknown skipClass on a skipped case', () => {
    const doc = parseSpec(spec(`    it "regex header" $
      get "/items" \`shouldRespondWith\` ""
        { matchHeaders = [matchHeader "X" "y"] }`).src, 'Feature/Query/QuerySpec.hs');
    assert.equal(doc.cases[0].skip, true);
    doc.cases[0].skipClass = 'something-else';
    const problems = validateDocument(doc, new Set());
    assert.equal(problems.length, 1);
    assert.match(problems[0], /bad skipClass/);
  });
});
