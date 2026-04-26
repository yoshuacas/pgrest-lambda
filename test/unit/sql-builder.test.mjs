// sql-builder.test.mjs — Unit tests for SQL generation
//
// These tests verify SQL string and parameter array output
// in isolation, without a database connection.
//
//   node --test test/unit/sql-builder.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { _buildFilterConditions } from '../../src/rest/sql-builder.mjs';

const mockSchema = {
  tables: {
    people: {
      columns: {
        id: { type: 'bigint' },
        name: { type: 'text' },
        age: { type: 'integer' },
        status: { type: 'text' },
        priority: { type: 'text' },
        assigned_to: { type: 'text' },
      },
    },
  },
  relationships: [],
};

describe('buildFilterConditions', () => {
  it('test_parameter_numbering_mixed_filters', () => {
    const filters = [
      { type: 'filter', column: 'age', operator: 'gt',
        value: '10', negate: false },
      { type: 'logicalGroup', logicalOp: 'or', negate: false,
        conditions: [
          { type: 'filter', column: 'status', operator: 'eq',
            value: 'active', negate: false },
          { type: 'filter', column: 'status', operator: 'eq',
            value: 'vip', negate: false },
        ]},
      { type: 'filter', column: 'name', operator: 'neq',
        value: 'x', negate: false },
    ];

    const values = [];
    const columnValidator = (col) => {
      if (!mockSchema.tables.people.columns[col]) {
        throw new Error(`Column '${col}' not found`);
      }
    };
    const conditions = _buildFilterConditions(
      filters, values, columnValidator);

    assert.deepStrictEqual(conditions, [
      '"age" > $1',
      '("status" = $2 OR "status" = $3)',
      '"name" != $4',
    ]);
    assert.deepStrictEqual(values, ['10', 'active', 'vip', 'x']);
  });

  it('test_filter_type_dispatches_correctly', () => {
    const filters = [
      { type: 'filter', column: 'age', operator: 'eq',
        value: '25', negate: false },
    ];

    const values = [];
    const columnValidator = (col) => {
      if (!mockSchema.tables.people.columns[col]) {
        throw new Error(`Column '${col}' not found`);
      }
    };
    const conditions = _buildFilterConditions(
      filters, values, columnValidator);

    assert.deepStrictEqual(conditions, ['"age" = $1']);
    assert.deepStrictEqual(values, ['25']);
  });

  it('test_in_operator_numbering_inside_or', () => {
    const filters = [
      { type: 'logicalGroup', logicalOp: 'or', negate: false,
        conditions: [
          { type: 'filter', column: 'status', operator: 'in',
            value: ['a', 'b', 'c'], negate: false },
          { type: 'filter', column: 'priority', operator: 'eq',
            value: 'high', negate: false },
        ]},
    ];

    const values = [];
    const columnValidator = (col) => {
      if (!mockSchema.tables.people.columns[col]) {
        throw new Error(`Column '${col}' not found`);
      }
    };
    const conditions = _buildFilterConditions(
      filters, values, columnValidator);

    assert.deepStrictEqual(conditions, [
      '("status" IN ($1, $2, $3) OR "priority" = $4)',
    ]);
    assert.deepStrictEqual(values, ['a', 'b', 'c', 'high']);
  });

  it('test_negate_wrapping', () => {
    const filters = [
      { type: 'logicalGroup', logicalOp: 'or', negate: true,
        conditions: [
          { type: 'filter', column: 'status', operator: 'eq',
            value: 'cancelled', negate: false },
          { type: 'filter', column: 'status', operator: 'eq',
            value: 'refunded', negate: false },
        ]},
    ];

    const values = [];
    const columnValidator = (col) => {
      if (!mockSchema.tables.people.columns[col]) {
        throw new Error(`Column '${col}' not found`);
      }
    };
    const conditions = _buildFilterConditions(
      filters, values, columnValidator);

    assert.deepStrictEqual(conditions, [
      'NOT ("status" = $1 OR "status" = $2)',
    ]);
    assert.deepStrictEqual(values, ['cancelled', 'refunded']);
  });
});
