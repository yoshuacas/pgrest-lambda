import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseQuery } from '../query-parser.mjs';

describe('query-parser', () => {
  describe('select parsing', () => {
    it('parses ?select=id,title into [id, title]', () => {
      const result = parseQuery({ select: 'id,title' }, 'GET');
      assert.deepStrictEqual(result.select, ['id', 'title'],
        'select should be [id, title]');
    });

    it('parses ?select=* into [*]', () => {
      const result = parseQuery({ select: '*' }, 'GET');
      assert.deepStrictEqual(result.select, ['*'],
        'select should be [*]');
    });

    it('defaults to [*] when no select param', () => {
      const result = parseQuery({}, 'GET');
      assert.deepStrictEqual(result.select, ['*'],
        'select should default to [*]');
    });
  });

  describe('filter parsing', () => {
    it('parses ?id=eq.abc into filter with op eq, value abc', () => {
      const result = parseQuery({ id: 'eq.abc' }, 'GET');
      const filter = result.filters.find(f => f.column === 'id');
      assert.ok(filter, 'should have filter for id');
      assert.equal(filter.operator, 'eq', 'operator should be eq');
      assert.equal(filter.value, 'abc', 'value should be abc');
      assert.equal(filter.negate, false, 'negate should be false');
    });

    it('parses ?status=neq.archived into filter with op neq', () => {
      const result = parseQuery({ status: 'neq.archived' }, 'GET');
      const filter = result.filters.find(f => f.column === 'status');
      assert.ok(filter, 'should have filter for status');
      assert.equal(filter.operator, 'neq', 'operator should be neq');
      assert.equal(filter.value, 'archived', 'value should be archived');
    });

    it('parses ?status=not.eq.archived into negated eq filter', () => {
      const result = parseQuery({ status: 'not.eq.archived' }, 'GET');
      const filter = result.filters.find(f => f.column === 'status');
      assert.ok(filter, 'should have filter for status');
      assert.equal(filter.negate, true, 'negate should be true');
      assert.equal(filter.operator, 'eq', 'operator should be eq');
      assert.equal(filter.value, 'archived', 'value should be archived');
    });

    it('parses ?status=in.(active,done) into in filter with array value', () => {
      const result = parseQuery({ status: 'in.(active,done)' }, 'GET');
      const filter = result.filters.find(f => f.column === 'status');
      assert.ok(filter, 'should have filter for status');
      assert.equal(filter.operator, 'in', 'operator should be in');
      assert.deepStrictEqual(filter.value, ['active', 'done'],
        'value should be [active, done]');
    });

    it('parses ?deleted_at=is.null into is filter with null', () => {
      const result = parseQuery({ deleted_at: 'is.null' }, 'GET');
      const filter = result.filters.find(f => f.column === 'deleted_at');
      assert.ok(filter, 'should have filter for deleted_at');
      assert.equal(filter.operator, 'is', 'operator should be is');
      assert.equal(filter.value, 'null', 'value should be null');
    });

    it('parses ?flag=is.true into is filter with true', () => {
      const result = parseQuery({ flag: 'is.true' }, 'GET');
      const filter = result.filters.find(f => f.column === 'flag');
      assert.ok(filter, 'should have filter for flag');
      assert.equal(filter.operator, 'is', 'operator should be is');
      assert.equal(filter.value, 'true', 'value should be true');
    });

    it('parses ?flag=is.false into is filter with false', () => {
      const result = parseQuery({ flag: 'is.false' }, 'GET');
      const filter = result.filters.find(f => f.column === 'flag');
      assert.ok(filter, 'should have filter for flag');
      assert.equal(filter.operator, 'is', 'operator should be is');
      assert.equal(filter.value, 'false', 'value should be false');
    });

    it('parses ?flag=is.unknown into is filter with unknown', () => {
      const result = parseQuery({ flag: 'is.unknown' }, 'GET');
      const filter = result.filters.find(f => f.column === 'flag');
      assert.ok(filter, 'should have filter for flag');
      assert.equal(filter.operator, 'is', 'operator should be is');
      assert.equal(filter.value, 'unknown', 'value should be unknown');
    });

    it('throws PGRST100 for ?col=is.invalid', () => {
      assert.throws(
        () => parseQuery({ col: 'is.invalid' }, 'GET'),
        (err) => err.code === 'PGRST100',
        'should throw with code PGRST100 for invalid is value'
      );
    });

    it('parses ?name=like.*smith* with asterisks replaced by %', () => {
      const result = parseQuery({ name: 'like.*smith*' }, 'GET');
      const filter = result.filters.find(f => f.column === 'name');
      assert.ok(filter, 'should have filter for name');
      assert.equal(filter.operator, 'like', 'operator should be like');
      assert.equal(filter.value, '%smith%',
        'asterisks should be replaced with %');
    });

    it('parses ?name=ilike.*smith* with asterisks replaced by %', () => {
      const result = parseQuery({ name: 'ilike.*smith*' }, 'GET');
      const filter = result.filters.find(f => f.column === 'name');
      assert.ok(filter, 'should have filter for name');
      assert.equal(filter.operator, 'ilike', 'operator should be ilike');
      assert.equal(filter.value, '%smith%',
        'asterisks should be replaced with %');
    });

    it('parses ?id=not.in.(a,b) into negated in filter', () => {
      const result = parseQuery({ id: 'not.in.(a,b)' }, 'GET');
      const filter = result.filters.find(f => f.column === 'id');
      assert.ok(filter, 'should have filter for id');
      assert.equal(filter.negate, true, 'negate should be true');
      assert.equal(filter.operator, 'in', 'operator should be in');
      assert.deepStrictEqual(filter.value, ['a', 'b'],
        'value should be [a, b]');
    });

    it('parses ?deleted_at=not.is.null into negated is null', () => {
      const result = parseQuery({ deleted_at: 'not.is.null' }, 'GET');
      const filter = result.filters.find(f => f.column === 'deleted_at');
      assert.ok(filter, 'should have filter for deleted_at');
      assert.equal(filter.negate, true, 'negate should be true');
      assert.equal(filter.operator, 'is', 'operator should be is');
      assert.equal(filter.value, 'null', 'value should be null');
    });

    it('treats ?deleted_at=not_null as not.is.null shorthand', () => {
      const result = parseQuery({ deleted_at: 'not_null' }, 'GET');
      const filter = result.filters.find(f => f.column === 'deleted_at');
      assert.ok(filter, 'should have filter for deleted_at');
      assert.equal(filter.negate, true, 'negate should be true');
      assert.equal(filter.operator, 'is', 'operator should be is');
      assert.equal(filter.value, 'null', 'value should be null');
    });

    it('throws PGRST100 for ?col=badvalue (no operator dot)', () => {
      assert.throws(
        () => parseQuery({ col: 'badvalue' }, 'GET'),
        (err) => err.code === 'PGRST100',
        'should throw with code PGRST100 for missing operator'
      );
    });
  });

  describe('order parsing', () => {
    it('parses ?order=created_at.desc.nullslast', () => {
      const result = parseQuery({ order: 'created_at.desc.nullslast' }, 'GET');
      assert.ok(result.order.length >= 1, 'should have at least one order entry');
      const entry = result.order[0];
      assert.equal(entry.column, 'created_at', 'column should be created_at');
      assert.equal(entry.direction, 'desc', 'direction should be desc');
      assert.equal(entry.nulls, 'nullslast', 'nulls should be nullslast');
    });

    it('parses ?order=a.asc,b.desc into two entries', () => {
      const result = parseQuery({ order: 'a.asc,b.desc' }, 'GET');
      assert.equal(result.order.length, 2, 'should have two order entries');
      assert.equal(result.order[0].column, 'a');
      assert.equal(result.order[0].direction, 'asc');
      assert.equal(result.order[1].column, 'b');
      assert.equal(result.order[1].direction, 'desc');
    });

    it('defaults direction to asc for ?order=name', () => {
      const result = parseQuery({ order: 'name' }, 'GET');
      assert.ok(result.order.length >= 1, 'should have at least one order entry');
      assert.equal(result.order[0].column, 'name', 'column should be name');
      assert.equal(result.order[0].direction, 'asc',
        'direction should default to asc');
    });
  });

  describe('pagination', () => {
    it('parses ?limit=20&offset=10', () => {
      const result = parseQuery({ limit: '20', offset: '10' }, 'GET');
      assert.equal(result.limit, 20, 'limit should be 20');
      assert.equal(result.offset, 10, 'offset should be 10');
    });

    it('defaults to limit null, offset 0 when not provided', () => {
      const result = parseQuery({}, 'GET');
      assert.equal(result.limit, null, 'limit should default to null');
      assert.equal(result.offset, 0, 'offset should default to 0');
    });
  });

  describe('reserved params', () => {
    it('does not treat select, order, limit, offset, on_conflict as filters', () => {
      const result = parseQuery({
        select: 'id',
        status: 'eq.active',
        order: 'id',
        limit: '10',
        offset: '0',
        on_conflict: 'id',
      }, 'GET');
      const filterColumns = result.filters.map(f => f.column);
      assert.ok(!filterColumns.includes('select'),
        'select should not be a filter');
      assert.ok(!filterColumns.includes('order'),
        'order should not be a filter');
      assert.ok(!filterColumns.includes('limit'),
        'limit should not be a filter');
      assert.ok(!filterColumns.includes('offset'),
        'offset should not be a filter');
      assert.ok(!filterColumns.includes('on_conflict'),
        'on_conflict should not be a filter');
      assert.ok(filterColumns.includes('status'),
        'status should be a filter');
    });
  });

  describe('on_conflict', () => {
    it('parses ?on_conflict=id into onConflict id', () => {
      const result = parseQuery({ on_conflict: 'id' }, 'POST');
      assert.equal(result.onConflict, 'id',
        'onConflict should be id');
    });
  });
});
