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

  it('throws PGRST100 for unknown embed prefix', () => {
    assert.throws(() => {
      parseQuery({
        select: '*,customers(*)',
        'foo.bar': 'eq.1',
      }, 'GET');
    }, (err) => {
      assert.equal(err.code, 'PGRST100');
      assert.ok(err.message.includes("no embed named 'foo'"));
      return true;
    });
  });

  it('throws PGRST100 for nested embed filter', () => {
    assert.throws(() => {
      parseQuery({
        select: '*,items(id,products(name))',
        'items.products.name': 'eq.Widget',
      }, 'GET');
    }, (err) => {
      assert.equal(err.code, 'PGRST100');
      assert.ok(err.message.includes(
        'Filter nesting deeper than one level'));
      return true;
    });
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

  it('dotted key falls through when no embeds in select', () => {
    const result = parseQuery({
      select: 'id,name',
      'foo.bar': 'eq.1',
    }, 'GET');
    assert.equal(result.filters.length, 1);
    assert.equal(result.filters[0].column, 'foo.bar');
    assert.equal(result.filters[0].operator, 'eq');
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
