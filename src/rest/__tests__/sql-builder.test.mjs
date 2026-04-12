import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSelect,
  buildInsert,
  buildUpdate,
  buildDelete,
  buildCount,
} from '../sql-builder.mjs';

const schema = {
  tables: {
    todos: {
      columns: {
        id: { type: 'text', nullable: false, defaultValue: null },
        user_id: { type: 'text', nullable: false, defaultValue: null },
        title: { type: 'text', nullable: true, defaultValue: null },
        status: { type: 'text', nullable: true, defaultValue: null },
        created_at: { type: 'timestamptz', nullable: false, defaultValue: 'now()' },
      },
      primaryKey: ['id'],
    },
    categories: {
      columns: {
        id: { type: 'text', nullable: false, defaultValue: null },
        name: { type: 'text', nullable: false, defaultValue: null },
      },
      primaryKey: ['id'],
    },
  },
};

describe('sql-builder', () => {
  describe('buildSelect', () => {
    it('generates WHERE with "id" = $1 for filter id=eq.abc', () => {
      const parsed = {
        select: ['*'],
        filters: [{ column: 'id', operator: 'eq', value: 'abc', negate: false }],
        order: [],
        limit: null,
        offset: 0,
        onConflict: null,
      };
      const { text, values } = buildSelect('todos', parsed, schema);
      assert.ok(text.includes('"id"'), 'SQL should reference "id" quoted');
      assert.ok(text.includes('$'), 'SQL should use parameterized values');
      assert.ok(values.includes('abc'), 'values should include abc');
    });

    it('selects specific columns for select=id,title', () => {
      const parsed = {
        select: ['id', 'title'],
        filters: [],
        order: [],
        limit: null,
        offset: 0,
        onConflict: null,
      };
      const { text } = buildSelect('todos', parsed, schema);
      assert.ok(text.includes('"id"'), 'SQL should include "id"');
      assert.ok(text.includes('"title"'), 'SQL should include "title"');
      assert.ok(!text.includes('"status"'),
        'SQL should not include unselected columns');
    });

    it('includes ORDER BY for order=created_at.desc', () => {
      const parsed = {
        select: ['*'],
        filters: [],
        order: [{ column: 'created_at', direction: 'desc', nulls: null }],
        limit: null,
        offset: 0,
        onConflict: null,
      };
      const { text } = buildSelect('todos', parsed, schema);
      assert.ok(text.includes('ORDER BY'),
        'SQL should include ORDER BY');
      assert.ok(text.includes('"created_at"'),
        'SQL should include quoted column name');
      assert.ok(text.toUpperCase().includes('DESC'),
        'SQL should include DESC');
    });

    it('includes LIMIT and OFFSET for limit=20&offset=10', () => {
      const parsed = {
        select: ['*'],
        filters: [],
        order: [],
        limit: 20,
        offset: 10,
        onConflict: null,
      };
      const { text, values } = buildSelect('todos', parsed, schema);
      assert.ok(text.includes('LIMIT'),
        'SQL should include LIMIT');
      assert.ok(text.includes('OFFSET'),
        'SQL should include OFFSET');
    });

    it('throws PGRST204 for unknown column in filter', () => {
      const parsed = {
        select: ['*'],
        filters: [{ column: 'nonexistent', operator: 'eq', value: 'x', negate: false }],
        order: [],
        limit: null,
        offset: 0,
        onConflict: null,
      };
      assert.throws(
        () => buildSelect('todos', parsed, schema),
        (err) => err.code === 'PGRST204',
        'should throw PGRST204 for unknown column'
      );
    });

    it('appends authzConditions to WHERE clause', () => {
      const parsed = {
        select: ['*'],
        filters: [{ column: 'status', operator: 'eq', value: 'active', negate: false }],
        order: [],
        limit: null,
        offset: 0,
        onConflict: null,
      };
      const authz = {
        conditions: ['"user_id" = $2'],
        values: ['alice'],
      };
      const { text, values } = buildSelect('todos', parsed, schema, authz);
      assert.ok(text.includes('"status"'),
        'SQL should include filter column');
      assert.ok(text.includes('"user_id" = $2'),
        'SQL should include authz condition');
      assert.deepEqual(values, ['active', 'alice']);
    });

    it('works unchanged with no authzConditions', () => {
      const parsed = {
        select: ['*'],
        filters: [{ column: 'status', operator: 'eq', value: 'active', negate: false }],
        order: [],
        limit: null,
        offset: 0,
        onConflict: null,
      };
      const { text, values } = buildSelect('todos', parsed, schema);
      assert.ok(text.includes('"status"'),
        'SQL should include filter column');
      assert.deepEqual(values, ['active'],
        'values should only contain filter values, no authz values');
    });
  });

  describe('buildInsert', () => {
    it('generates INSERT with RETURNING * for single object body', () => {
      const body = { title: 'Buy milk' };
      const parsed = {
        select: ['*'],
        filters: [],
        order: [],
        limit: null,
        offset: 0,
        onConflict: null,
      };
      const { text, values } = buildInsert('todos', body, schema, parsed);
      assert.ok(text.includes('INSERT INTO'),
        'SQL should contain INSERT INTO');
      assert.ok(text.includes('"todos"'),
        'SQL should reference quoted table name');
      assert.ok(text.includes('"title"'),
        'SQL should include title column');
      assert.ok(text.includes('RETURNING'),
        'SQL should include RETURNING');
    });

    it('generates multiple VALUES tuples for array body', () => {
      const body = [{ title: 'a' }, { title: 'b' }];
      const parsed = {
        select: ['*'],
        filters: [],
        order: [],
        limit: null,
        offset: 0,
        onConflict: null,
      };
      const { text, values } = buildInsert('todos', body, schema, parsed);
      // Should have at least 2 parameter groups
      const dollarMatches = text.match(/\$/g);
      assert.ok(dollarMatches && dollarMatches.length >= 2,
        'SQL should have multiple parameter placeholders for bulk insert');
    });

    it('throws PGRST204 for body with unknown column', () => {
      const body = { nonexistent: 'value' };
      const parsed = {
        select: ['*'],
        filters: [],
        order: [],
        limit: null,
        offset: 0,
        onConflict: null,
      };
      assert.throws(
        () => buildInsert('todos', body, schema, parsed),
        (err) => err.code === 'PGRST204',
        'should throw PGRST204 for unknown column in body'
      );
    });
  });

  describe('buildInsert (upsert)', () => {
    it('generates ON CONFLICT ... DO UPDATE SET for upsert', () => {
      const body = { id: 'abc', title: 'Updated' };
      const parsed = {
        select: ['*'],
        filters: [],
        order: [],
        limit: null,
        offset: 0,
        onConflict: 'id',
      };
      const { text } = buildInsert('todos', body, schema, parsed);
      assert.ok(text.includes('ON CONFLICT'),
        'SQL should contain ON CONFLICT');
      assert.ok(text.includes('"id"'),
        'SQL should reference conflict column');
      assert.ok(text.includes('DO UPDATE SET'),
        'SQL should contain DO UPDATE SET');
    });
  });

  describe('buildInsert (upsert edge cases)', () => {
    it('produces DO NOTHING when all columns are in on_conflict', () => {
      const body = { id: 'abc' };
      const parsed = {
        select: ['*'],
        filters: [],
        order: [],
        limit: null,
        offset: 0,
        onConflict: 'id',
      };
      const { text } = buildInsert('todos', body, schema, parsed);
      assert.ok(text.includes('ON CONFLICT'),
        'SQL should contain ON CONFLICT');
      assert.ok(text.includes('DO NOTHING'),
        'SQL should fall back to DO NOTHING when SET would be empty');
      assert.ok(!text.includes('DO UPDATE SET'),
        'SQL should NOT contain DO UPDATE SET');
    });
  });

  describe('is filter guard', () => {
    it('throws PGRST100 for invalid IS value', () => {
      const parsed = {
        select: ['*'],
        filters: [{ column: 'title', operator: 'is', value: 'invalid', negate: false }],
        order: [],
        limit: null,
        offset: 0,
        onConflict: null,
      };
      assert.throws(
        () => buildSelect('todos', parsed, schema),
        (err) => err.code === 'PGRST100',
        'should throw PGRST100 for invalid IS value',
      );
    });

    it('accepts valid IS values (null, true, false, unknown)', () => {
      for (const value of ['null', 'true', 'false', 'unknown']) {
        const parsed = {
          select: ['*'],
          filters: [{ column: 'title', operator: 'is', value, negate: false }],
          order: [],
          limit: null,
          offset: 0,
          onConflict: null,
        };
        assert.doesNotThrow(
          () => buildSelect('todos', parsed, schema),
          `should not throw for IS ${value}`,
        );
      }
    });
  });

  describe('buildUpdate', () => {
    it('generates UPDATE ... SET ... WHERE for filters and body', () => {
      const body = { title: 'Updated title' };
      const parsed = {
        select: ['*'],
        filters: [{ column: 'id', operator: 'eq', value: 'abc', negate: false }],
        order: [],
        limit: null,
        offset: 0,
        onConflict: null,
      };
      const { text } = buildUpdate('todos', body, parsed, schema);
      assert.ok(text.includes('UPDATE'),
        'SQL should contain UPDATE');
      assert.ok(text.includes('"todos"'),
        'SQL should reference quoted table name');
      assert.ok(text.includes('SET'),
        'SQL should contain SET');
      assert.ok(text.includes('WHERE'),
        'SQL should contain WHERE');
    });

    it('throws PGRST106 when no filters', () => {
      const body = { title: 'Updated title' };
      const parsed = {
        select: ['*'],
        filters: [],
        order: [],
        limit: null,
        offset: 0,
        onConflict: null,
      };
      assert.throws(
        () => buildUpdate('todos', body, parsed, schema),
        (err) => err.code === 'PGRST106',
        'should throw PGRST106 for UPDATE without filters'
      );
    });

    it('appends authzConditions to WHERE clause', () => {
      const body = { title: 'Updated' };
      const parsed = {
        select: ['*'],
        filters: [{ column: 'id', operator: 'eq', value: 'abc', negate: false }],
        order: [],
        limit: null,
        offset: 0,
        onConflict: null,
      };
      const authz = {
        conditions: ['"user_id" = $3'],
        values: ['alice'],
      };
      const { text, values } = buildUpdate(
        'todos', body, parsed, schema, authz,
      );
      assert.ok(text.includes('"user_id" = $3'),
        'SQL should include authz condition');
      assert.ok(values.includes('alice'),
        'values should include authz value');
    });
  });

  describe('buildDelete', () => {
    it('generates DELETE FROM ... WHERE for filters', () => {
      const parsed = {
        select: ['*'],
        filters: [{ column: 'id', operator: 'eq', value: 'abc', negate: false }],
        order: [],
        limit: null,
        offset: 0,
        onConflict: null,
      };
      const { text } = buildDelete('todos', parsed, schema);
      assert.ok(text.includes('DELETE FROM'),
        'SQL should contain DELETE FROM');
      assert.ok(text.includes('"todos"'),
        'SQL should reference quoted table name');
      assert.ok(text.includes('WHERE'),
        'SQL should contain WHERE');
    });

    it('throws PGRST106 when no filters', () => {
      const parsed = {
        select: ['*'],
        filters: [],
        order: [],
        limit: null,
        offset: 0,
        onConflict: null,
      };
      assert.throws(
        () => buildDelete('todos', parsed, schema),
        (err) => err.code === 'PGRST106',
        'should throw PGRST106 for DELETE without filters'
      );
    });

    it('appends authzConditions to WHERE clause', () => {
      const parsed = {
        select: ['*'],
        filters: [{ column: 'id', operator: 'eq', value: 'abc', negate: false }],
        order: [],
        limit: null,
        offset: 0,
        onConflict: null,
      };
      const authz = {
        conditions: ['"user_id" = $2'],
        values: ['alice'],
      };
      const { text, values } = buildDelete(
        'todos', parsed, schema, authz,
      );
      assert.ok(text.includes('"user_id" = $2'),
        'SQL should include authz condition');
      assert.ok(values.includes('alice'),
        'values should include authz value');
    });
  });

  describe('buildCount', () => {
    it('generates SELECT COUNT(*) with matching WHERE', () => {
      const parsed = {
        select: ['*'],
        filters: [{ column: 'status', operator: 'eq', value: 'active', negate: false }],
        order: [],
        limit: null,
        offset: 0,
        onConflict: null,
      };
      const { text, values } = buildCount('todos', parsed, schema);
      assert.ok(text.includes('COUNT(*)'),
        'SQL should contain COUNT(*)');
      assert.ok(text.includes('WHERE'),
        'SQL should contain WHERE');
      assert.ok(values.includes('active'),
        'values should include filter value');
    });

    it('appends authzConditions to WHERE clause', () => {
      const parsed = {
        select: ['*'],
        filters: [{ column: 'status', operator: 'eq', value: 'active', negate: false }],
        order: [],
        limit: null,
        offset: 0,
        onConflict: null,
      };
      const authz = {
        conditions: ['"user_id" = $2'],
        values: ['alice'],
      };
      const { text, values } = buildCount(
        'todos', parsed, schema, authz,
      );
      assert.ok(text.includes('"user_id" = $2'),
        'SQL should include authz condition');
      assert.deepEqual(values, ['active', 'alice']);
    });
  });

  describe('general', () => {
    it('double-quotes all table and column names in output SQL', () => {
      const parsed = {
        select: ['id', 'title'],
        filters: [{ column: 'status', operator: 'eq', value: 'active', negate: false }],
        order: [{ column: 'created_at', direction: 'desc', nulls: null }],
        limit: null,
        offset: 0,
        onConflict: null,
      };
      const { text } = buildSelect('todos', parsed, schema);
      assert.ok(text.includes('"todos"'),
        'table name should be double-quoted');
      assert.ok(text.includes('"id"'),
        'column id should be double-quoted');
      assert.ok(text.includes('"title"'),
        'column title should be double-quoted');
      assert.ok(text.includes('"status"'),
        'column status should be double-quoted');
      assert.ok(text.includes('"created_at"'),
        'column created_at should be double-quoted');
    });
  });
});
