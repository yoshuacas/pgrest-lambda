// Extractor: skipClass separates "the engine has no switch for this" from
// "the harness cannot carry this". CONTRACTS.md section 1.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseSpec } from '../extract/parse-spec.mjs';

function cases(body) {
  const src = `module Test where\n\nspec :: SpecWith ((), Application)\nspec = do\n${body}\n`;
  return parseSpec(src, 'Feature/Query/QuerySpec.hs');
}

describe('skipClass', () => {
  it('is needs-engine-config for a non-default configDbMaxRows block', () => {
    const doc = cases(`  describe "limited" $
    withConfig baseCfg { configDbMaxRows = Just 2 } $ do
      it "caps rows" $
        get "/items" \`shouldRespondWith\` 200`);
    assert.equal(doc.cases.length, 1);
    const c = doc.cases[0];
    assert.equal(c.skip, true);
    assert.equal(c.skipClass, 'needs-engine-config');
    assert.match(c.skipReason, /configDbMaxRows/);
    assert.equal(doc.needsConfigCases, 1);
    assert.equal(doc.extractedCases, 0);
    assert.equal(doc.skippedSites, 1);
  });

  it('is needs-engine-config for configDbSchemas', () => {
    const doc = cases(`  describe "schemas" $
    withConfig baseCfg { configDbSchemas = fromList ["v1", "v2"] } $ do
      it "switches schema" $
        get "/items" \`shouldRespondWith\` 200`);
    assert.equal(doc.cases[0].skipClass, 'needs-engine-config');
  });

  it('is not-representable for a harness limitation', () => {
    const doc = cases(`  describe "regex" $ do
    it "regex header" $
      get "/items" \`shouldRespondWith\` ""
        { matchHeaders = [matchHeader "X" "y"] }`);
    assert.equal(doc.cases[0].skip, true);
    assert.equal(doc.cases[0].skipClass, 'not-representable');
    assert.equal(doc.needsConfigCases, 0);
  });

  it('is not-representable when both reasons apply', () => {
    const doc = cases(`  describe "both" $
    withConfig baseCfg { configDbMaxRows = Just 2 } $ do
      it "regex header under config" $
        get "/items" \`shouldRespondWith\` ""
          { matchHeaders = [matchHeader "X" "y"] }`);
    const c = doc.cases[0];
    assert.equal(c.skip, true);
    assert.equal(c.skipClass, 'not-representable');
    assert.match(c.skipReason, /configDbMaxRows/);
    assert.match(c.skipReason, /matchHeader/);
  });

  it('is null on a case that runs', () => {
    const doc = cases(`  describe "plain" $ do
    it "reads" $
      get "/items" \`shouldRespondWith\` 200`);
    assert.equal(doc.cases[0].skip, false);
    assert.equal(doc.cases[0].skipClass, null);
    assert.equal(doc.needsConfigCases, 0);
    assert.equal(doc.extractedCases, 1);
  });

  it('counts needsConfigCases at most skippedSites over the real specs', () => {
    const doc = cases(`  describe "mixed" $ do
    it "reads" $
      get "/items" \`shouldRespondWith\` 200
    withConfig baseCfg { configDbMaxRows = Just 2 } $ do
      it "caps rows" $
        get "/items" \`shouldRespondWith\` 200`);
    assert.equal(doc.extractedCases + doc.skippedSites, doc.cases.length);
    assert.ok(doc.needsConfigCases <= doc.skippedSites);
  });
});
