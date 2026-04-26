import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseQuery, parseSelectList } from '../query-parser.mjs';

describe('query-parser', () => {
  describe('select parsing', () => {
    it('parses ?select=id,title into column nodes', () => {
      const result = parseQuery({ select: 'id,title' }, 'GET');
      assert.deepStrictEqual(result.select, [
        { type: 'column', name: 'id' },
        { type: 'column', name: 'title' },
      ], 'select should be column nodes for id and title');
    });

    it('parses ?select=* into wildcard column node', () => {
      const result = parseQuery({ select: '*' }, 'GET');
      assert.deepStrictEqual(result.select, [
        { type: 'column', name: '*' },
      ], 'select should be wildcard column node');
    });

    it('defaults to wildcard column node when no select param', () => {
      const result = parseQuery({}, 'GET');
      assert.deepStrictEqual(result.select, [
        { type: 'column', name: '*' },
      ], 'select should default to wildcard column node');
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

describe('parseSelectList', () => {
  it('flat columns: id,amount', () => {
    assert.deepStrictEqual(parseSelectList('id,amount'), [
      { type: 'column', name: 'id' },
      { type: 'column', name: 'amount' },
    ]);
  });

  it('wildcard: *', () => {
    assert.deepStrictEqual(parseSelectList('*'), [
      { type: 'column', name: '*' },
    ]);
  });

  it('column + embed: id,customers(name)', () => {
    const result = parseSelectList('id,customers(name)');
    assert.equal(result.length, 2);
    assert.deepStrictEqual(result[0], { type: 'column', name: 'id' });
    assert.equal(result[1].type, 'embed');
    assert.equal(result[1].name, 'customers');
    assert.equal(result[1].alias, null);
    assert.equal(result[1].hint, null);
    assert.equal(result[1].inner, false);
    assert.deepStrictEqual(result[1].select, [
      { type: 'column', name: 'name' },
    ]);
  });

  it('embed with two child columns: id,customers(name,email)', () => {
    const result = parseSelectList('id,customers(name,email)');
    assert.equal(result[1].type, 'embed');
    assert.equal(result[1].name, 'customers');
    assert.deepStrictEqual(result[1].select, [
      { type: 'column', name: 'name' },
      { type: 'column', name: 'email' },
    ]);
  });

  it('wildcard parent + wildcard child: *,customers(*)', () => {
    const result = parseSelectList('*,customers(*)');
    assert.equal(result.length, 2);
    assert.deepStrictEqual(result[0], { type: 'column', name: '*' });
    assert.equal(result[1].type, 'embed');
    assert.equal(result[1].name, 'customers');
    assert.deepStrictEqual(result[1].select, [
      { type: 'column', name: '*' },
    ]);
  });

  it('aliased embed: id,buyer:customers(name)', () => {
    const result = parseSelectList('id,buyer:customers(name)');
    assert.equal(result[1].type, 'embed');
    assert.equal(result[1].name, 'customers');
    assert.equal(result[1].alias, 'buyer');
  });

  it('hint: *,addresses!billing_address_id(*)', () => {
    const result = parseSelectList('*,addresses!billing_address_id(*)');
    assert.equal(result[1].type, 'embed');
    assert.equal(result[1].name, 'addresses');
    assert.equal(result[1].hint, 'billing_address_id');
    assert.equal(result[1].inner, false);
  });

  it('inner: id,orders!inner(id)', () => {
    const result = parseSelectList('id,orders!inner(id)');
    assert.equal(result[1].type, 'embed');
    assert.equal(result[1].name, 'orders');
    assert.equal(result[1].inner, true);
    assert.equal(result[1].hint, null);
  });

  it('hint + inner: id,addresses!billing_fk!inner(*)', () => {
    const result = parseSelectList('id,addresses!billing_fk!inner(*)');
    assert.equal(result[1].type, 'embed');
    assert.equal(result[1].name, 'addresses');
    assert.equal(result[1].hint, 'billing_fk');
    assert.equal(result[1].inner, true);
  });

  it('nested embed: id,items(id,products(name))', () => {
    const result = parseSelectList('id,items(id,products(name))');
    assert.equal(result.length, 2);
    assert.deepStrictEqual(result[0], { type: 'column', name: 'id' });
    const items = result[1];
    assert.equal(items.type, 'embed');
    assert.equal(items.name, 'items');
    assert.equal(items.select.length, 2);
    assert.deepStrictEqual(items.select[0],
      { type: 'column', name: 'id' });
    const products = items.select[1];
    assert.equal(products.type, 'embed');
    assert.equal(products.name, 'products');
    assert.deepStrictEqual(products.select, [
      { type: 'column', name: 'name' },
    ]);
  });

  it('spaces trimmed: id, customers(name, email)', () => {
    const result = parseSelectList('id, customers(name, email)');
    assert.equal(result.length, 2);
    assert.deepStrictEqual(result[0], { type: 'column', name: 'id' });
    assert.equal(result[1].name, 'customers');
    assert.deepStrictEqual(result[1].select, [
      { type: 'column', name: 'name' },
      { type: 'column', name: 'email' },
    ]);
  });

  it('intermixed columns and embeds', () => {
    const result = parseSelectList(
      'id,customers(name),amount,items(id)');
    assert.equal(result.length, 4);
    assert.equal(result[0].type, 'column');
    assert.equal(result[0].name, 'id');
    assert.equal(result[1].type, 'embed');
    assert.equal(result[1].name, 'customers');
    assert.equal(result[2].type, 'column');
    assert.equal(result[2].name, 'amount');
    assert.equal(result[3].type, 'embed');
    assert.equal(result[3].name, 'items');
  });

  it('parseQuery default: no select param returns wildcard node',
    () => {
      const result = parseQuery({}, 'GET');
      assert.deepStrictEqual(result.select, [
        { type: 'column', name: '*' },
      ]);
    });

  it('parseQuery backward compat: select=id,name returns column nodes',
    () => {
      const result = parseQuery({ select: 'id,name' }, 'GET');
      assert.deepStrictEqual(result.select, [
        { type: 'column', name: 'id' },
        { type: 'column', name: 'name' },
      ]);
    });

  describe('column alias parsing', () => {
    it('parses alias:column as column node with alias', () => {
      const result = parseSelectList('firstName:first_name');
      assert.deepStrictEqual(result, [
        { type: 'column', name: 'first_name', alias: 'firstName' },
      ]);
    });

    it('parses multiple aliased columns alongside unaliased', () => {
      const result = parseSelectList(
        'id,firstName:first_name,lastName:last_name');
      assert.equal(result.length, 3);
      assert.deepStrictEqual(result[0],
        { type: 'column', name: 'id' });
      assert.deepStrictEqual(result[1],
        { type: 'column', name: 'first_name', alias: 'firstName' });
      assert.deepStrictEqual(result[2],
        { type: 'column', name: 'last_name', alias: 'lastName' });
    });

    it('parses mixed aliased and unaliased columns', () => {
      const result = parseSelectList(
        'id,displayName:first_name,email');
      assert.equal(result.length, 3);
      assert.deepStrictEqual(result[0],
        { type: 'column', name: 'id' });
      assert.deepStrictEqual(result[1],
        { type: 'column', name: 'first_name', alias: 'displayName' });
      assert.deepStrictEqual(result[2],
        { type: 'column', name: 'email' });
    });

    it('does not add alias property to unaliased columns', () => {
      const result = parseSelectList('id,first_name');
      assert.equal(result[0].alias, undefined,
        'id should not have an alias');
      assert.equal(result[1].alias, undefined,
        'first_name should not have an alias');
    });

    it('rejects column alias with single quote', () => {
      assert.throws(
        () => parseSelectList("x'injection:first_name"),
        (err) => err.code === 'PGRST100'
          && err.message.includes('not a valid identifier'),
        'single quote in column alias should throw PGRST100',
      );
    });

    it('rejects column alias with double quote', () => {
      assert.throws(
        () => parseSelectList('x"injection:first_name'),
        (err) => err.code === 'PGRST100'
          && err.message.includes('not a valid identifier'),
        'double quote in column alias should throw PGRST100',
      );
    });

    it('rejects column alias with space', () => {
      assert.throws(
        () => parseSelectList('x injection:first_name'),
        (err) => err.code === 'PGRST100'
          && err.message.includes('not a valid identifier'),
        'space in column alias should throw PGRST100',
      );
    });

    it('rejects column alias with leading digit', () => {
      assert.throws(
        () => parseSelectList('123bad:first_name'),
        (err) => err.code === 'PGRST100'
          && err.message.includes('not a valid identifier'),
        'leading digit in column alias should throw PGRST100',
      );
    });

    it('accepts column alias with leading underscore', () => {
      const result = parseSelectList('_valid:first_name');
      assert.equal(result.length, 1);
      assert.deepStrictEqual(result[0],
        { type: 'column', name: 'first_name', alias: '_valid' });
    });

    it('accepts camelCase column alias with digits', () => {
      const result = parseSelectList('camelCase123:first_name');
      assert.equal(result.length, 1);
      assert.deepStrictEqual(result[0],
        { type: 'column', name: 'first_name',
          alias: 'camelCase123' });
    });

    it('detects duplicate alias keys', () => {
      assert.throws(
        () => parseSelectList('a:col1,a:col2'),
        (err) => err.code === 'PGRST100'
          && err.message.includes("Duplicate select key 'a'"),
        'duplicate alias should throw PGRST100',
      );
    });

    it('detects alias colliding with plain column name', () => {
      assert.throws(
        () => parseSelectList('email,email:user_email'),
        (err) => err.code === 'PGRST100'
          && err.message.includes("Duplicate select key 'email'"),
        'alias colliding with column name should throw PGRST100',
      );
    });

    it('detects duplicate plain column names', () => {
      assert.throws(
        () => parseSelectList('id,name,id'),
        (err) => err.code === 'PGRST100'
          && err.message.includes("Duplicate select key 'id'"),
        'duplicate column names should throw PGRST100',
      );
    });

    it('existing embed alias still works', () => {
      const result = parseSelectList('id,buyer:customers(name)');
      assert.equal(result[1].type, 'embed');
      assert.equal(result[1].name, 'customers');
      assert.equal(result[1].alias, 'buyer');
    });

    it('parses column aliases inside embed', () => {
      const result = parseSelectList(
        'id,customers(displayName:name,mail:email)');
      assert.equal(result.length, 2);
      assert.equal(result[1].type, 'embed');
      assert.equal(result[1].name, 'customers');
      assert.deepStrictEqual(result[1].select, [
        { type: 'column', name: 'name', alias: 'displayName' },
        { type: 'column', name: 'email', alias: 'mail' },
      ]);
    });

    it('parses embed alias + column alias inside embed', () => {
      const result = parseSelectList(
        'id,buyer:customers(displayName:name)');
      assert.equal(result[1].type, 'embed');
      assert.equal(result[1].name, 'customers');
      assert.equal(result[1].alias, 'buyer');
      assert.deepStrictEqual(result[1].select, [
        { type: 'column', name: 'name', alias: 'displayName' },
      ]);
    });

    it('rejects empty column name after alias', () => {
      assert.throws(
        () => parseSelectList('alias:'),
        (err) => err.code === 'PGRST100',
        'empty column name after alias should throw PGRST100',
      );
    });

    it('wildcard has no alias', () => {
      const result = parseSelectList('*');
      assert.equal(result.length, 1);
      assert.deepStrictEqual(result[0],
        { type: 'column', name: '*' });
    });

    it('does not treat :: as alias separator', () => {
      const result = parseSelectList('col::text');
      assert.equal(result.length, 1);
      assert.equal(result[0].name, 'col::text');
      assert.equal(result[0].alias, undefined,
        'double colon should not produce an alias');
    });

    it('parses alias before column with cast', () => {
      const result = parseSelectList('alias:col::text');
      assert.equal(result.length, 1);
      assert.equal(result[0].alias, 'alias');
      assert.equal(result[0].name, 'col::text');
    });

    it('rejects invalid alias from :: prefix pattern', () => {
      assert.throws(
        () => parseSelectList('a::b:c'),
        (err) => err.code === 'PGRST100'
          && err.message.includes('not a valid identifier'),
        'a::b as alias should fail validation',
      );
    });
  });
});

describe('select validation', () => {
  describe('alias validation', () => {
    it('rejects alias with single quote', () => {
      assert.throws(
        () => parseSelectList("id,x'injection:customers(name)"),
        (err) => err.code === 'PGRST100'
          && err.message.includes('not a valid identifier'),
        'single quote in alias should throw PGRST100',
      );
    });

    it('rejects alias with double quote', () => {
      assert.throws(
        () => parseSelectList('id,x"injection:customers(name)'),
        (err) => err.code === 'PGRST100'
          && err.message.includes('not a valid identifier'),
        'double quote in alias should throw PGRST100',
      );
    });

    it('rejects alias with space', () => {
      assert.throws(
        () => parseSelectList('id,x injection:customers(name)'),
        (err) => err.code === 'PGRST100'
          && err.message.includes('not a valid identifier'),
        'space in alias should throw PGRST100',
      );
    });

    it('rejects alias with leading digit', () => {
      assert.throws(
        () => parseSelectList('id,123bad:customers(name)'),
        (err) => err.code === 'PGRST100'
          && err.message.includes('not a valid identifier'),
        'leading digit in alias should throw PGRST100',
      );
    });

    it('accepts valid alias with underscores', () => {
      const result = parseSelectList(
        'id,_valid_alias:customers(name)');
      assert.equal(result[1].type, 'embed');
      assert.equal(result[1].alias, '_valid_alias');
      assert.equal(result[1].name, 'customers');
    });

    it('accepts normal alias', () => {
      const result = parseSelectList('id,buyer:customers(name)');
      assert.equal(result[1].type, 'embed');
      assert.equal(result[1].alias, 'buyer');
      assert.equal(result[1].name, 'customers');
    });
  });

  describe('parenthesis balancing', () => {
    it('throws on unclosed paren', () => {
      assert.throws(
        () => parseSelectList('id,customers(name'),
        (err) => err.code === 'PGRST100'
          && err.message.includes('Unbalanced parentheses'),
        'unclosed paren should throw PGRST100',
      );
    });

    it('throws on extra closing paren', () => {
      assert.throws(
        () => parseSelectList('id,customers(name))'),
        (err) => err.code === 'PGRST100'
          && err.message.includes('Unbalanced parentheses'),
        'extra closing paren should throw PGRST100',
      );
    });

    it('throws on nested unclosed paren', () => {
      assert.throws(
        () => parseSelectList('id,items(id,products(name)'),
        (err) => err.code === 'PGRST100'
          && err.message.includes('Unbalanced parentheses'),
        'nested unclosed paren should throw PGRST100',
      );
    });
  });

  describe('empty embed select', () => {
    it('throws on empty embed select list', () => {
      assert.throws(
        () => parseSelectList('id,customers()'),
        (err) => err.code === 'PGRST100'
          && err.message.includes('Empty select list'),
        'empty embed select should throw PGRST100',
      );
    });
  });
});
