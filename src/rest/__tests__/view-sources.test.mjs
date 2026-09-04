import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseViewTargetList,
  parseViewTargetLists,
  resolveViewColumnSources,
} from '../view-sources.mjs';

// A trimmed but structurally faithful pg_rewrite.ev_action: a one-element
// list holding a QUERY node. The nested VAR/FUNCEXPR/RANGETBLENTRY nodes
// are there to prove the parser reads only the TARGETENTRY's own fields.
const evAction = '('
  + '{QUERY :commandType 1 :canSetTag true :utilityStmt <> '
  + ':rtable ({RTE :eref {ALIAS :aliasname authors_base '
  + ':colnames ("id" "name")} :rtekind 0 :relid 900 '
  + ':resorigtbl 111 :resorigcol 9}) '
  + ':targetList ('
  + '{TARGETENTRY :expr {VAR :varno 1 :varattno 1 :vartype 23 '
  + ':resorigtbl 777 :resorigcol 7} '
  + ':resno 1 :resname id :ressortgroupref 0 '
  + ':resorigtbl 900 :resorigcol 1 :resjunk false} '
  + '{TARGETENTRY :expr {VAR :varno 1 :varattno 3 :vartype 25} '
  + ':resno 2 :resname author_name :ressortgroupref 0 '
  + ':resorigtbl 900 :resorigcol 3 :resjunk false} '
  + '{TARGETENTRY :expr {FUNCEXPR :funcid 100 :args ({CONST :consttype 23})} '
  + ':resno 3 :resname computed :ressortgroupref 0 '
  + ':resorigtbl 0 :resorigcol 0 :resjunk false} '
  + '{TARGETENTRY :expr {VAR :varno 1 :varattno 4} '
  + ':resno 4 :resname ctid :resorigtbl 900 :resorigcol 4 '
  + ':resjunk true}'
  + ') :jointree {FROMEXPR :fromlist ({RANGETBLREF :rtindex 1}) '
  + ':quals <>}}'
  + ')';

describe('view-sources pg_node_tree parsing', () => {
  it('reads resno/resorigtbl/resorigcol from the target list', () => {
    assert.deepStrictEqual(parseViewTargetList(evAction), [
      { attnum: 1, srcOid: 900, srcAttnum: 1 },
      { attnum: 2, srcOid: 900, srcAttnum: 3 },
    ]);
  });

  it('drops expression columns and resjunk columns', () => {
    const entries = parseViewTargetList(evAction);
    assert.equal(entries.some(e => e.attnum === 3), false,
      'a column with resorigtbl 0 has no base column');
    assert.equal(entries.some(e => e.attnum === 4), false,
      'resjunk columns are not part of the view');
  });

  it('does not read fields of nested nodes', () => {
    const entries = parseViewTargetList(evAction);
    assert.equal(entries.some(e => e.srcOid === 777), false,
      'the VAR node carries its own fields, they must be skipped');
    assert.equal(entries.some(e => e.srcOid === 111), false,
      'rtable entries must be skipped');
  });

  it('tolerates junk input instead of throwing', () => {
    assert.deepStrictEqual(parseViewTargetList(''), []);
    assert.deepStrictEqual(parseViewTargetList(null), []);
    assert.deepStrictEqual(parseViewTargetList('({QUERY :rtable ()})'), []);
  });

  it('parseViewTargetLists keys by view oid, skipping empties', () => {
    const byView = parseViewTargetLists([
      { view_oid: '100', view_definition: evAction },
      { view_oid: '101', view_definition: 'not a node tree' },
      { view_oid: null, view_definition: evAction },
    ]);
    assert.deepStrictEqual([...byView.keys()], [100]);
  });
});

describe('view-sources chain resolution', () => {
  it('follows a view built on another view down to the table', () => {
    const byView = new Map([
      // view 100 column 1 comes from view 200 column 2
      [100, [{ attnum: 1, srcOid: 200, srcAttnum: 2 }]],
      // view 200 column 2 comes from table 300 column 5
      [200, [{ attnum: 2, srcOid: 300, srcAttnum: 5 }]],
    ]);
    const resolved = resolveViewColumnSources(byView);
    assert.deepStrictEqual(resolved.get(100), [
      { attnum: 1, srcOid: 300, srcAttnum: 5 },
    ]);
    assert.deepStrictEqual(resolved.get(200), [
      { attnum: 2, srcOid: 300, srcAttnum: 5 },
    ]);
  });

  it('drops a column whose chain cannot be resolved', () => {
    const byView = new Map([
      [100, [{ attnum: 1, srcOid: 200, srcAttnum: 99 }]],
      [200, [{ attnum: 2, srcOid: 300, srcAttnum: 5 }]],
    ]);
    assert.deepStrictEqual(resolveViewColumnSources(byView).get(100), []);
  });

  it('does not loop on a self-referencing chain', () => {
    const byView = new Map([
      [100, [{ attnum: 1, srcOid: 100, srcAttnum: 1 }]],
    ]);
    assert.deepStrictEqual(resolveViewColumnSources(byView).get(100), []);
  });
});
