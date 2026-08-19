import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseQuery } from '../query-parser.mjs';

describe('parseQuery embed param routing', () => {
  it('routes embed filter to embed node', () => {
    const result = parseQuery({
      select: '*,customers(*)',
      'customers.name': 'eq.Alice',
    }, 'GET');
    const embed = result.select.find(n => n.type === 'embed');
    assert.equal(embed.filters.length, 1);
    assert.equal(embed.filters[0].column, 'name');
    assert.equal(embed.filters[0].operator, 'eq');
    assert.equal(embed.filters[0].value, 'Alice');
    assert.equal(result.filters.length, 0,
      'parent filters should be empty');
  });

  it('routes embed OR to embed node as logicalGroup', () => {
    const result = parseQuery({
      select: '*,customers(*)',
      'customers.or': '(name.eq.Alice,status.eq.active)',
    }, 'GET');
    const embed = result.select.find(n => n.type === 'embed');
    assert.equal(embed.filters.length, 1);
    assert.equal(embed.filters[0].type, 'logicalGroup');
    assert.equal(embed.filters[0].logicalOp, 'or');
    assert.equal(embed.filters[0].negate, false);
    assert.equal(embed.filters[0].conditions.length, 2);
  });

  it('routes embed not.or to embed node with negate', () => {
    const result = parseQuery({
      select: '*,customers(*)',
      'customers.not.or':
        '(status.eq.cancelled,status.eq.refunded)',
    }, 'GET');
    const embed = result.select.find(n => n.type === 'embed');
    assert.equal(embed.filters.length, 1);
    assert.equal(embed.filters[0].type, 'logicalGroup');
    assert.equal(embed.filters[0].logicalOp, 'or');
    assert.equal(embed.filters[0].negate, true);
  });

  it('stores embed order on embed node', () => {
    const result = parseQuery({
      select: '*,orders(*)',
      'orders.order': 'amount.desc',
    }, 'GET');
    const embed = result.select.find(n => n.type === 'embed');
    assert.deepStrictEqual(embed.order, [
      { column: 'amount', direction: 'desc', nulls: null },
    ]);
  });

  it('stores embed limit on embed node', () => {
    const result = parseQuery({
      select: '*,orders(*)',
      'orders.limit': '5',
    }, 'GET');
    const embed = result.select.find(n => n.type === 'embed');
    assert.equal(embed.limit, 5);
  });

  it('stores embed offset on embed node', () => {
    const result = parseQuery({
      select: '*,orders(*)',
      'orders.offset': '10',
    }, 'GET');
    const embed = result.select.find(n => n.type === 'embed');
    assert.equal(embed.offset, 10);
  });

  // Upstream's `NotEmbedded` (Error.hs:182,219): 400 PGRST108 with the hint
  // naming the select parameter. QuerySpec.hs:528 asserts these strings.
  it('throws PGRST108 for unknown embed prefix', () => {
    assert.throws(() => {
      parseQuery({
        select: '*,customers(*)',
        'foo.bar': 'eq.1',
      }, 'GET');
    }, (err) => {
      assert.equal(err.statusCode, 400);
      assert.equal(err.code, 'PGRST108');
      assert.equal(err.message,
        "'foo' is not an embedded resource in this request");
      assert.equal(err.details, null);
      assert.equal(err.hint,
        "Verify that 'foo' is included in the 'select' query parameter.");
      return true;
    });
  });

  // QuerySpec.hs:1709 — the embed is there, but under an alias, so upstream
  // points at the alias instead of telling the caller to add it to select.
  it('names the alias when the prefix is an aliased embed target', () => {
    assert.throws(() => {
      parseQuery({
        select: 'id,name,the_tasks:tasks(id,name)',
        'tasks.name': 'like.Code*',
      }, 'GET');
    }, (err) => {
      assert.equal(err.code, 'PGRST108');
      assert.equal(err.message,
        "'tasks' is not an embedded resource in this request");
      assert.equal(err.details,
        'Target names are not allowed in filters if they have an alias');
      assert.equal(err.hint,
        "Change 'tasks' to 'the_tasks' in filters, orders or limits.");
      return true;
    });
  });

  // Upstream walks the whole dotted path down the read plan
  // (Plan.hs `updateNode`), so a filter can name an embed at any depth.
  it('routes a filter onto a nested embed', () => {
    const parsed = parseQuery({
      select: '*,items(id,products(name))',
      'items.products.name': 'eq.Widget',
    }, 'GET');
    const items = parsed.select.find(n => n.name === 'items');
    assert.equal(items.filters.length, 0);
    const products = items.select.find(n => n.name === 'products');
    assert.equal(products.filters.length, 1);
    assert.equal(products.filters[0].column, 'name');
    assert.equal(products.filters[0].operator, 'eq');
    assert.equal(products.filters[0].value, 'Widget');
  });

  // QuerySpec.hs:549 — `projects.tasks2.name=like.Design*` names only the
  // missing leaf, not the whole path, in both message and hint.
  it('throws PGRST108 naming the leaf of an unknown nested path', () => {
    assert.throws(() => {
      parseQuery({
        select: '*,items(id,products(name))',
        'items.nope.name': 'eq.Widget',
      }, 'GET');
    }, (err) => {
      assert.equal(err.code, 'PGRST108');
      assert.equal(err.message,
        "'nope' is not an embedded resource in this request");
      assert.equal(err.hint,
        "Verify that 'nope' is included in the 'select' query parameter.");
      return true;
    });
  });

  it('routes order and limit onto a nested embed', () => {
    const parsed = parseQuery({
      select: '*,items(id,products(name))',
      'items.products.order': 'name.desc',
      'items.products.limit': '2',
    }, 'GET');
    const products = parsed.select
      .find(n => n.name === 'items').select
      .find(n => n.name === 'products');
    assert.deepStrictEqual(products.order.map(o => o.column), ['name']);
    assert.equal(products.order[0].direction, 'desc');
    assert.equal(products.limit, 2);
  });

  it('top-level not.or is not routed to embed', () => {
    const result = parseQuery({
      select: '*,customers(*)',
      'not.or': '(status.eq.a,status.eq.b)',
    }, 'GET');
    const embed = result.select.find(n => n.type === 'embed');
    assert.equal(embed.filters.length, 0,
      'embed should have no filters');
    assert.equal(result.filters.length, 1,
      'parent should have the logical group');
    assert.equal(result.filters[0].type, 'logicalGroup');
    assert.equal(result.filters[0].negate, true);
  });

  // Upstream does not look at the select list before deciding a dotted key is
  // an embed path: `pTreePath` splits the key, then Plan.hs fails to find a
  // node at that path. QuerySpec.hs:528 uses `select=*` with no embed at all.
  it('errors on a dotted key even when nothing is embedded', () => {
    assert.throws(() => parseQuery({
      select: 'id,name',
      'foo.bar': 'eq.1',
    }, 'GET'), (err) => {
      assert.equal(err.code, 'PGRST108');
      assert.equal(err.message,
        "'foo' is not an embedded resource in this request");
      return true;
    });
  });

  // A quoted field name may contain dots, and a json path is only parsed after
  // the dotted names — so neither of these is an embed path.
  it('treats a quoted dotted key as a single field', () => {
    const result = parseQuery({ select: '*', '"foo.bar"': 'eq.1' }, 'GET');
    assert.equal(result.filters.length, 1);
    assert.equal(result.filters[0].column, '"foo.bar"');
  });

  it('splits on the dot before a json path, not inside it', () => {
    const result = parseQuery({
      select: '*,items(id)',
      'items.data->>a': 'eq.1',
    }, 'GET');
    const items = result.select.find(n => n.type === 'embed');
    assert.equal(items.filters.length, 1);
    assert.equal(items.filters[0].column, 'data');
    assert.deepStrictEqual(items.filters[0].jsonPath,
      [{ kind: 'key', op: '->>', value: 'a' }]);
  });

  it('routes alias-based embed filter correctly', () => {
    const result = parseQuery({
      select: '*,buyer:customers(*)',
      'buyer.name': 'eq.Alice',
    }, 'GET');
    const embed = result.select.find(n => n.type === 'embed');
    assert.equal(embed.alias, 'buyer');
    assert.equal(embed.filters.length, 1);
    assert.equal(embed.filters[0].column, 'name');
  });

  it('multiple filters on same embed are all routed', () => {
    const result = parseQuery({
      select: '*,customers(*)',
      'customers.name': 'eq.Alice',
      'customers.status': 'eq.active',
    }, 'GET');
    const embed = result.select.find(n => n.type === 'embed');
    assert.equal(embed.filters.length, 2);
    assert.equal(embed.filters[0].column, 'name');
    assert.equal(embed.filters[1].column, 'status');
  });

  it('parent filter + embed filter coexist', () => {
    const result = parseQuery({
      select: '*,customers(*)',
      amount: 'gt.50',
      'customers.name': 'eq.Alice',
    }, 'GET');
    assert.equal(result.filters.length, 1,
      'parent should have one filter');
    assert.equal(result.filters[0].column, 'amount');
    const embed = result.select.find(n => n.type === 'embed');
    assert.equal(embed.filters.length, 1);
    assert.equal(embed.filters[0].column, 'name');
  });
});
