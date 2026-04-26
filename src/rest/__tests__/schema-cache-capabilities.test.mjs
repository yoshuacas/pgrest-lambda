import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createSchemaCache } from '../schema-cache.mjs';

function createMockPool({ fkRows = [], tables = ['users', 'notes'] } = {}) {
  const calls = [];

  const columnRows = [];
  if (tables.includes('users')) {
    columnRows.push(
      { table_name: 'users', column_name: 'id', data_type: 'bigint', is_nullable: false, column_default: null },
      { table_name: 'users', column_name: 'name', data_type: 'text', is_nullable: true, column_default: null },
    );
  }
  if (tables.includes('notes')) {
    columnRows.push(
      { table_name: 'notes', column_name: 'id', data_type: 'bigint', is_nullable: false, column_default: null },
      { table_name: 'notes', column_name: 'user_id', data_type: 'text', is_nullable: false, column_default: null },
      { table_name: 'notes', column_name: 'body', data_type: 'text', is_nullable: false, column_default: null },
    );
  }

  const pkRows = [];
  if (tables.includes('users')) {
    pkRows.push({ table_name: 'users', column_name: 'id' });
  }
  if (tables.includes('notes')) {
    pkRows.push({ table_name: 'notes', column_name: 'id' });
  }

  return {
    calls,
    query(sql) {
      calls.push(sql);
      if (sql.includes('format_type')) return { rows: columnRows };
      if (sql.includes("contype = 'p'")) return { rows: pkRows };
      if (sql.includes("contype = 'f'")) return { rows: fkRows };
      return { rows: [] };
    },
  };
}

describe('schema cache with capabilities', () => {
  it('supportsForeignKeys=true — FK query executes', async () => {
    const fkRows = [{
      constraint_name: 'notes_user_id_fkey',
      from_table: 'notes',
      from_columns: ['user_id'],
      to_table: 'users',
      to_columns: ['id'],
    }];
    const pool = createMockPool({ fkRows });
    const cache = createSchemaCache({
      schemaCacheTtl: 60000,
      capabilities: { supportsForeignKeys: true },
    });

    const schema = await cache.getSchema(pool);

    const fkCalls = pool.calls.filter(s => s.includes("contype = 'f'"));
    assert.equal(fkCalls.length, 1, 'FK_SQL should have been executed');

    const rel = schema.relationships.find(
      r => r.fromTable === 'notes' && r.fromColumns.includes('user_id'),
    );
    assert.ok(rel, 'should have FK-based relationship');
    assert.equal(rel.toTable, 'users');
    assert.deepStrictEqual(rel.toColumns, ['id']);
  });

  it('supportsForeignKeys=false — FK query skipped', async () => {
    const pool = createMockPool();
    const cache = createSchemaCache({
      schemaCacheTtl: 60000,
      capabilities: { supportsForeignKeys: false },
    });

    const schema = await cache.getSchema(pool);

    const fkCalls = pool.calls.filter(s => s.includes("contype = 'f'"));
    assert.equal(fkCalls.length, 0, 'FK_SQL should NOT have been executed');

    const rel = schema.relationships.find(
      r => r.fromTable === 'notes' && r.fromColumns.includes('user_id'),
    );
    assert.ok(rel, 'convention fallback should infer notes.user_id → users');
    assert.equal(rel.toTable, 'users');
    assert.deepStrictEqual(rel.toColumns, ['id']);
  });

  it('no capabilities (backward compat) — FK query executes', async () => {
    const pool = createMockPool({ tables: ['users'] });
    const cache = createSchemaCache({
      schemaCacheTtl: 60000,
    });

    await cache.getSchema(pool);

    const fkCalls = pool.calls.filter(s => s.includes("contype = 'f'"));
    assert.equal(fkCalls.length, 1, 'FK_SQL should execute when no capabilities set');
  });
});
