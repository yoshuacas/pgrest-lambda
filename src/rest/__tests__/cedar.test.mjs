import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  translateExpr,
  createCedar,
  parsePolicySource,
  evaluateExprAgainstRow,
} from '../cedar.mjs';

// Helper: create a cedar instance with test defaults
function makeCedar(opts = {}) {
  return createCedar({
    policiesPath: opts.policiesPath || './policies',
    ...opts,
  });
}

const schema = {
  tables: {
    todos: {
      columns: {
        id: { type: 'text', nullable: false, defaultValue: null },
        user_id: { type: 'text', nullable: false, defaultValue: null },
        title: { type: 'text', nullable: true, defaultValue: null },
        status: { type: 'text', nullable: true, defaultValue: null },
        level: { type: 'integer', nullable: true, defaultValue: null },
        team_id: { type: 'text', nullable: true, defaultValue: null },
        created_at: { type: 'timestamp with time zone', nullable: false, defaultValue: 'now()' },
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
    public_posts: {
      columns: {
        id: { type: 'text', nullable: false, defaultValue: null },
        title: { type: 'text', nullable: true, defaultValue: null },
        body: { type: 'text', nullable: true, defaultValue: null },
      },
      primaryKey: ['id'],
    },
    posts: {
      columns: {
        id: { type: 'text', nullable: false, defaultValue: null },
        title: { type: 'text', nullable: true, defaultValue: null },
      },
      primaryKey: ['id'],
    },
    orders: {
      columns: {
        id: { type: 'text', nullable: false, defaultValue: null },
        owner_id: { type: 'text', nullable: false, defaultValue: null },
        amount: { type: 'integer', nullable: true, defaultValue: null },
      },
      primaryKey: ['id'],
    },
    items: {
      columns: {
        id: { type: 'text', nullable: false, defaultValue: null },
        name: { type: 'text', nullable: true, defaultValue: null },
        restricted: { type: 'boolean', nullable: true, defaultValue: null },
      },
      primaryKey: ['id'],
    },
  },
};

// --- Default Cedar policy text (matches design doc) ---

const DEFAULT_POLICIES = `
permit(
    principal is PgrestLambda::User,
    action in [
        PgrestLambda::Action::"select",
        PgrestLambda::Action::"update",
        PgrestLambda::Action::"delete"
    ],
    resource is PgrestLambda::Row
) when {
    resource has user_id && resource.user_id == principal
};

permit(
    principal is PgrestLambda::User,
    action == PgrestLambda::Action::"insert",
    resource is PgrestLambda::Table
);

permit(
    principal is PgrestLambda::ServiceRole,
    action,
    resource
);
`;

const PUBLIC_POSTS_POLICY = `${DEFAULT_POLICIES}

permit(
    principal,
    action == PgrestLambda::Action::"select",
    resource is PgrestLambda::Row
) when {
    context.table == "public_posts"
};
`;

const PUBLIC_POSTS_TABLE_POLICY = `${DEFAULT_POLICIES}

permit(
    principal,
    action == PgrestLambda::Action::"select",
    resource == PgrestLambda::Table::"public_posts"
);
`;

const FORBID_DELETE_ARCHIVED_POLICY = `${DEFAULT_POLICIES}

forbid(
    principal,
    action == PgrestLambda::Action::"delete",
    resource is PgrestLambda::Row
) when {
    resource has status && resource.status == "archived"
};
`;

const TEAM_ACCESS_POLICY = `${DEFAULT_POLICIES}

permit(
    principal is PgrestLambda::User,
    action in [
        PgrestLambda::Action::"select",
        PgrestLambda::Action::"update"
    ],
    resource is PgrestLambda::Row
) when {
    resource has team_id &&
    resource.team_id == principal.team_id
};
`;

// --- Helper: build a resource attribute access expr ---

function attrAccess(attr) {
  return { '.': { left: { Var: 'resource' }, attr } };
}

function eqExpr(attr, value) {
  return { '==': { left: attrAccess(attr), right: { Value: value } } };
}

// ================================================================
// translateExpr — residual-to-SQL translation
// ================================================================

describe('translateExpr', () => {
  it('equality comparison translates to "col" = $N', () => {
    const expr = eqExpr('user_id', 'alice');
    const values = [];
    const sql = translateExpr(expr, values, 'todos', schema);
    assert.equal(sql, '"user_id" = $1');
    assert.deepEqual(values, ['alice']);
  });

  it('inequality comparison translates to "col" != $N', () => {
    const expr = {
      '!=': {
        left: attrAccess('status'),
        right: { Value: 'archived' },
      },
    };
    const values = [];
    const sql = translateExpr(expr, values, 'todos', schema);
    assert.equal(sql, '"status" != $1');
    assert.deepEqual(values, ['archived']);
  });

  it('greater-than comparison translates to "col" > $N', () => {
    const expr = {
      '>': {
        left: attrAccess('level'),
        right: { Value: 5 },
      },
    };
    const values = [];
    const sql = translateExpr(expr, values, 'todos', schema);
    assert.equal(sql, '"level" > $1');
    assert.deepEqual(values, [5]);
  });

  it('greater-or-equal translates to "col" >= $N', () => {
    const expr = {
      '>=': {
        left: attrAccess('level'),
        right: { Value: 10 },
      },
    };
    const values = [];
    const sql = translateExpr(expr, values, 'todos', schema);
    assert.equal(sql, '"level" >= $1');
    assert.deepEqual(values, [10]);
  });

  it('less-than translates to "col" < $N', () => {
    const expr = {
      '<': {
        left: attrAccess('level'),
        right: { Value: 3 },
      },
    };
    const values = [];
    const sql = translateExpr(expr, values, 'todos', schema);
    assert.equal(sql, '"level" < $1');
    assert.deepEqual(values, [3]);
  });

  it('less-or-equal translates to "col" <= $N', () => {
    const expr = {
      '<=': {
        left: attrAccess('level'),
        right: { Value: 7 },
      },
    };
    const values = [];
    const sql = translateExpr(expr, values, 'todos', schema);
    assert.equal(sql, '"level" <= $1');
    assert.deepEqual(values, [7]);
  });

  it('AND conjunction translates to (left AND right)', () => {
    const expr = {
      '&&': {
        left: eqExpr('user_id', 'alice'),
        right: {
          '>': {
            left: attrAccess('level'),
            right: { Value: 5 },
          },
        },
      },
    };
    const values = [];
    const sql = translateExpr(expr, values, 'todos', schema);
    assert.equal(sql, '("user_id" = $1 AND "level" > $2)');
    assert.deepEqual(values, ['alice', 5]);
  });

  it('OR disjunction translates to (left OR right)', () => {
    const expr = {
      '||': {
        left: eqExpr('user_id', 'alice'),
        right: eqExpr('status', 'active'),
      },
    };
    const values = [];
    const sql = translateExpr(expr, values, 'todos', schema);
    assert.equal(sql, '("user_id" = $1 OR "status" = $2)');
    assert.deepEqual(values, ['alice', 'active']);
  });

  it('NOT negation translates to NOT (expr)', () => {
    const expr = {
      '!': {
        arg: eqExpr('status', 'archived'),
      },
    };
    const values = [];
    const sql = translateExpr(expr, values, 'todos', schema);
    assert.equal(sql, 'NOT ("status" = $1)');
    assert.deepEqual(values, ['archived']);
  });

  it('has-attribute translates to "col" IS NOT NULL', () => {
    const expr = {
      has: { left: { Var: 'resource' }, attr: 'user_id' },
    };
    const values = [];
    const sql = translateExpr(expr, values, 'todos', schema);
    assert.equal(sql, '"user_id" IS NOT NULL');
    assert.deepEqual(values, []);
  });

  it('CPE noise collapse: true AND condition reduces to condition', () => {
    const expr = {
      '&&': {
        left: { Value: true },
        right: eqExpr('user_id', 'alice'),
      },
    };
    const values = [];
    const sql = translateExpr(expr, values, 'todos', schema);
    assert.equal(sql, '"user_id" = $1',
      'true AND condition should collapse to just the condition');
    assert.deepEqual(values, ['alice']);
  });

  it('CPE noise collapse: nested true chains reduce to condition', () => {
    const expr = {
      '&&': {
        left: { Value: true },
        right: {
          '&&': {
            left: { Value: true },
            right: eqExpr('user_id', 'alice'),
          },
        },
      },
    };
    const values = [];
    const sql = translateExpr(expr, values, 'todos', schema);
    assert.equal(sql, '"user_id" = $1',
      'nested true chains should collapse to the final condition');
    assert.deepEqual(values, ['alice']);
  });

  it('CPE noise collapse: condition AND true reduces to condition', () => {
    const expr = {
      '&&': {
        left: eqExpr('user_id', 'alice'),
        right: { Value: true },
      },
    };
    const values = [];
    const sql = translateExpr(expr, values, 'todos', schema);
    assert.equal(sql, '"user_id" = $1',
      'condition AND true should collapse to just the condition');
    assert.deepEqual(values, ['alice']);
  });

  it('CPE noise collapse: true OR X reduces to true', () => {
    const expr = {
      '||': {
        left: { Value: true },
        right: eqExpr('user_id', 'alice'),
      },
    };
    const values = [];
    const sql = translateExpr(expr, values, 'todos', schema);
    // true OR anything is unconditionally true — no SQL filter
    assert.equal(sql, null,
      'true OR X should return null (unconditional allow)');
    assert.deepEqual(values, []);
  });

  it('entity UID value extraction: extracts id from __entity', () => {
    const expr = {
      '==': {
        left: attrAccess('user_id'),
        right: {
          Value: {
            __entity: { type: 'PgrestLambda::User', id: 'abc-123' },
          },
        },
      },
    };
    const values = [];
    const sql = translateExpr(expr, values, 'todos', schema);
    assert.equal(sql, '"user_id" = $1');
    assert.deepEqual(values, ['abc-123']);
  });

  it('type check (is Row) collapses to true', () => {
    const expr = {
      is: {
        left: { Var: 'resource' },
        entity_type: 'PgrestLambda::Row',
      },
    };
    const values = [];
    const sql = translateExpr(expr, values, 'todos', schema);
    assert.equal(sql, null,
      'is Row should collapse to true (no SQL emitted)');
  });

  it('type check (non-Row) collapses to false', () => {
    const expr = {
      is: {
        left: { Var: 'resource' },
        entity_type: 'PgrestLambda::Table',
      },
    };
    const values = [];
    const sql = translateExpr(expr, values, 'todos', schema);
    assert.equal(sql, 'FALSE',
      'is non-Row type check should evaluate to FALSE');
  });

  it('unknown marker treated as resource for attribute access', () => {
    const expr = {
      '==': {
        left: {
          '.': {
            left: { unknown: [{ Value: 'resource' }] },
            attr: 'user_id',
          },
        },
        right: { Value: 'alice' },
      },
    };
    const values = [];
    const sql = translateExpr(expr, values, 'todos', schema);
    assert.equal(sql, '"user_id" = $1',
      'unknown marker should be treated the same as Var: resource');
    assert.deepEqual(values, ['alice']);
  });

  it('untranslatable expression (in) throws PGRST000', () => {
    const expr = {
      in: {
        left: { Var: 'resource' },
        right: {
          Value: {
            __entity: { type: 'PgrestLambda::Table', id: 'todos' },
          },
        },
      },
    };
    const values = [];
    assert.throws(
      () => translateExpr(expr, values, 'todos', schema),
      (err) => err.code === 'PGRST000'
        && err.message.includes('untranslatable'),
      'in expression should throw PGRST000',
    );
  });

  it('untranslatable expression (contains) throws PGRST000', () => {
    const expr = {
      contains: {
        left: attrAccess('status'),
        right: { Value: 'active' },
      },
    };
    const values = [];
    assert.throws(
      () => translateExpr(expr, values, 'todos', schema),
      (err) => err.code === 'PGRST000'
        && err.message.includes('untranslatable'),
      'contains expression should throw PGRST000',
    );
  });

  it('untranslatable expression (like) throws PGRST000', () => {
    const expr = {
      like: {
        left: attrAccess('title'),
        right: { Value: '*test*' },
      },
    };
    const values = [];
    assert.throws(
      () => translateExpr(expr, values, 'todos', schema),
      (err) => err.code === 'PGRST000'
        && err.message.includes('untranslatable'),
      'like expression should throw PGRST000',
    );
  });

  it('parameter numbering respects startParam', () => {
    const expr = eqExpr('user_id', 'alice');
    // Pre-populate values to simulate startParam=5
    const values = ['_', '_', '_', '_'];
    const sql = translateExpr(expr, values, 'todos', schema);
    assert.ok(sql.includes('$5'),
      'placeholder should be $5 when 4 values already exist');
    assert.ok(!sql.includes('$1'),
      'should not use $1 when startParam offset is 5');
    assert.equal(values[4], 'alice');
  });

  it('if-then-else translates to CASE WHEN', () => {
    const expr = {
      'if-then-else': {
        if: eqExpr('status', 'active'),
        then: { Value: true },
        else: { Value: false },
      },
    };
    const values = [];
    const sql = translateExpr(expr, values, 'todos', schema);
    assert.ok(sql.includes('CASE WHEN'),
      'should produce CASE WHEN');
    assert.ok(sql.includes('"status"'),
      'should reference the status column');
    assert.ok(sql.includes('THEN TRUE'),
      'should include THEN TRUE');
    assert.ok(sql.includes('ELSE FALSE'),
      'should include ELSE FALSE');
    assert.ok(sql.includes('END'),
      'should include END');
  });

  it('Value false translates to FALSE', () => {
    const expr = { Value: false };
    const values = [];
    const sql = translateExpr(expr, values, 'todos', schema);
    assert.equal(sql, 'FALSE');
  });
});

// ================================================================
// generateCedarSchema — PG-to-Cedar type mapping
// ================================================================

describe('generateCedarSchema', () => {
  it('maps text/varchar/uuid PG types to Cedar String', () => {
    const testSchema = {
      tables: {
        test: {
          columns: {
            col_text: { type: 'text', nullable: true, defaultValue: null },
            col_varchar: { type: 'varchar', nullable: true, defaultValue: null },
            col_uuid: { type: 'uuid', nullable: true, defaultValue: null },
          },
          primaryKey: ['col_text'],
        },
      },
    };
    const cedar = makeCedar();
    const cedarSchema = cedar.generateCedarSchema(testSchema);
    // Walk into the schema to find Row entity attributes
    const ns = cedarSchema['PgrestLambda'] || cedarSchema;
    const rowType = ns.entityTypes?.Row
      || ns.entityTypes?.['PgrestLambda::Row'];
    const attrs = rowType?.shape?.attributes || {};
    for (const colName of ['col_text', 'col_varchar', 'col_uuid']) {
      assert.ok(attrs[colName],
        `Row entity should have ${colName} attribute`);
      assert.equal(attrs[colName].type, 'String',
        `${colName} should map to Cedar String`);
    }
  });

  it('maps integer/smallint/bigint PG types to Cedar Long', () => {
    const testSchema = {
      tables: {
        test: {
          columns: {
            col_int: { type: 'integer', nullable: true, defaultValue: null },
            col_small: { type: 'smallint', nullable: true, defaultValue: null },
            col_big: { type: 'bigint', nullable: true, defaultValue: null },
          },
          primaryKey: ['col_int'],
        },
      },
    };
    const cedar = makeCedar();
    const cedarSchema = cedar.generateCedarSchema(testSchema);
    const ns = cedarSchema['PgrestLambda'] || cedarSchema;
    const rowType = ns.entityTypes?.Row
      || ns.entityTypes?.['PgrestLambda::Row'];
    const attrs = rowType?.shape?.attributes || {};
    for (const colName of ['col_int', 'col_small', 'col_big']) {
      assert.ok(attrs[colName],
        `Row entity should have ${colName} attribute`);
      assert.equal(attrs[colName].type, 'Long',
        `${colName} should map to Cedar Long`);
    }
  });

  it('maps boolean PG type to Cedar Boolean', () => {
    const testSchema = {
      tables: {
        test: {
          columns: {
            is_active: { type: 'boolean', nullable: true, defaultValue: null },
          },
          primaryKey: ['is_active'],
        },
      },
    };
    const cedar = makeCedar();
    const cedarSchema = cedar.generateCedarSchema(testSchema);
    const ns = cedarSchema['PgrestLambda'] || cedarSchema;
    const rowType = ns.entityTypes?.Row
      || ns.entityTypes?.['PgrestLambda::Row'];
    const attrs = rowType?.shape?.attributes || {};
    assert.ok(attrs.is_active,
      'Row entity should have is_active attribute');
    assert.equal(attrs.is_active.type, 'Boolean',
      'boolean column should map to Cedar Boolean');
  });

  it('defaults unknown PG types to Cedar String', () => {
    const testSchema = {
      tables: {
        test: {
          columns: {
            created_at: {
              type: 'timestamp with time zone',
              nullable: false,
              defaultValue: 'now()',
            },
          },
          primaryKey: ['created_at'],
        },
      },
    };
    const cedar = makeCedar();
    const cedarSchema = cedar.generateCedarSchema(testSchema);
    const ns = cedarSchema['PgrestLambda'] || cedarSchema;
    const rowType = ns.entityTypes?.Row
      || ns.entityTypes?.['PgrestLambda::Row'];
    const attrs = rowType?.shape?.attributes || {};
    assert.ok(attrs.created_at,
      'Row entity should have created_at attribute');
    assert.equal(attrs.created_at.type, 'String',
      'unknown PG types should default to Cedar String');
  });

  it('union of all table columns in Row entity', () => {
    const testSchema = {
      tables: {
        table_a: {
          columns: {
            col_x: { type: 'text', nullable: true, defaultValue: null },
          },
          primaryKey: ['col_x'],
        },
        table_b: {
          columns: {
            col_y: { type: 'integer', nullable: true, defaultValue: null },
          },
          primaryKey: ['col_y'],
        },
      },
    };
    const cedar = makeCedar();
    const cedarSchema = cedar.generateCedarSchema(testSchema);
    const ns = cedarSchema['PgrestLambda'] || cedarSchema;
    const rowType = ns.entityTypes?.Row
      || ns.entityTypes?.['PgrestLambda::Row'];
    const attrs = rowType?.shape?.attributes || {};
    assert.ok(attrs.col_x,
      'Row entity should include col_x from table_a');
    assert.ok(attrs.col_y,
      'Row entity should include col_y from table_b');
  });
});

// ================================================================
// Policy loading
// ================================================================

describe('policy loading', () => {
  let tempDir;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cedar-test-'));
  });

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('loadPolicies loads .cedar files from filesystem', async () => {
    await writeFile(
      join(tempDir, 'default.cedar'),
      DEFAULT_POLICIES,
    );
    const cedar = makeCedar({ policiesPath: tempDir });
    await assert.doesNotReject(
      () => cedar.loadPolicies(),
      'loadPolicies should resolve without error',
    );
  });

  it('loadPolicies with no .cedar files denies all (fail closed)', async () => {
    const cedar = makeCedar({ policiesPath: tempDir });
    await cedar.loadPolicies();
    assert.throws(
      () => cedar.authorize({
        principal: {
          role: 'authenticated',
          userId: 'alice',
          email: 'alice@test.com',
        },
        action: 'select',
        resource: 'todos',
        schema,
      }),
      (err) => err.code === 'PGRST403',
      'authorize should deny when no policies are loaded',
    );
  });

  it('loadPolicies with syntax error denies all (fail closed)', async () => {
    await writeFile(
      join(tempDir, 'bad.cedar'),
      'this is not valid cedar syntax {{{{',
    );
    const cedar = makeCedar({ policiesPath: tempDir });
    await cedar.loadPolicies();
    assert.throws(
      () => cedar.authorize({
        principal: {
          role: 'authenticated',
          userId: 'alice',
          email: 'alice@test.com',
        },
        action: 'select',
        resource: 'todos',
        schema,
      }),
      'authorize should deny when policies have syntax errors',
    );
  });

  it('policy caching returns cached within TTL', async () => {
    await writeFile(
      join(tempDir, 'default.cedar'),
      DEFAULT_POLICIES,
    );
    const cedar = makeCedar({ policiesPath: tempDir });
    await cedar.loadPolicies();
    // Remove the file — if caching works, the second call
    // should succeed without re-reading the filesystem
    await rm(join(tempDir, 'default.cedar'));
    await assert.doesNotReject(
      () => cedar.loadPolicies(),
      'second loadPolicies call should use cached policies',
    );
  });

  it('refreshPolicies bypasses TTL cache', async () => {
    await writeFile(
      join(tempDir, 'default.cedar'),
      DEFAULT_POLICIES,
    );
    const cedar = makeCedar({ policiesPath: tempDir });
    await cedar.loadPolicies();
    await writeFile(
      join(tempDir, 'default.cedar'),
      PUBLIC_POSTS_TABLE_POLICY,
    );
    await cedar.refreshPolicies();
    assert.doesNotThrow(
      () => cedar.authorize({
        principal: { role: 'anon', userId: '', email: '' },
        action: 'select',
        resource: 'public_posts',
        schema,
      }),
      'refreshPolicies should reload and apply new policies',
    );
  });

  it('_setPolicies replaces compiled policies', () => {
    const cedar = makeCedar();
    cedar._setPolicies({ staticPolicies: PUBLIC_POSTS_TABLE_POLICY });
    assert.doesNotThrow(
      () => cedar.authorize({
        principal: { role: 'anon', userId: '', email: '' },
        action: 'select',
        resource: 'public_posts',
        schema,
      }),
      '_setPolicies should allow overriding policies for testing',
    );
  });
});

// ================================================================
// authorize (table-level)
// ================================================================

describe('authorize (table-level)', () => {
  let cedar;

  beforeEach(() => {
    cedar = makeCedar();
    cedar._setPolicies({ staticPolicies: DEFAULT_POLICIES });
  });

  it('service_role allowed on any table and action', () => {
    assert.doesNotThrow(
      () => cedar.authorize({
        principal: {
          role: 'service_role',
          userId: '',
          email: '',
        },
        action: 'select',
        resource: 'todos',
        schema,
      }),
      'service_role should be allowed on any table',
    );
  });

  it('authenticated user allowed to insert', () => {
    assert.doesNotThrow(
      () => cedar.authorize({
        principal: {
          role: 'authenticated',
          userId: 'alice',
          email: 'alice@test.com',
        },
        action: 'insert',
        resource: 'todos',
        schema,
      }),
      'authenticated users should be allowed to insert',
    );
  });

  it('anon user denied by default policies', () => {
    assert.throws(
      () => cedar.authorize({
        principal: { role: 'anon', userId: '', email: '' },
        action: 'select',
        resource: 'todos',
        schema,
      }),
      (err) => err.code === 'PGRST403'
        // Message shape differs between production and dev modes;
        // check for the three facts that appear in both.
        && /select/.test(err.message)
        && /todos/.test(err.message),
      'anon should be denied with PGRST403',
    );
  });

  it('row-level policy produces residuals — authorize() denies (fail-closed)', () => {
    cedar._setPolicies({ staticPolicies: PUBLIC_POSTS_POLICY });
    assert.throws(
      () => cedar.authorize({
        principal: { role: 'anon', userId: '', email: '' },
        action: 'select',
        resource: 'public_posts',
        schema,
      }),
      (err) => err.code === 'PGRST403',
    );
  });
});

// ================================================================
// buildAuthzFilter (row-level)
// ================================================================

describe('buildAuthzFilter (row-level)', () => {
  let cedar;

  beforeEach(() => {
    cedar = makeCedar();
    cedar._setPolicies({ staticPolicies: DEFAULT_POLICIES });
  });

  it('default policy for authenticated user produces user_id filter', () => {
    const result = cedar.buildAuthzFilter({
      principal: {
        role: 'authenticated',
        userId: 'alice',
        email: 'alice@test.com',
      },
      action: 'select',
      context: { table: 'todos' },
      schema,
      startParam: 1,
    });
    const joined = result.conditions.join(' ');
    assert.ok(joined.includes('"user_id"'),
      'conditions should reference user_id column');
    assert.ok(result.values.includes('alice'),
      'values should include the user ID "alice"');
  });

  it('service_role produces no conditions (unconditional access)', () => {
    const result = cedar.buildAuthzFilter({
      principal: {
        role: 'service_role',
        userId: '',
        email: '',
      },
      action: 'select',
      context: { table: 'todos' },
      schema,
      startParam: 1,
    });
    assert.deepEqual(result.conditions, [],
      'service_role should have no conditions');
    assert.deepEqual(result.values, [],
      'service_role should have no values');
  });

  it('forbid policy produces NOT condition', () => {
    cedar._setPolicies({
      staticPolicies: FORBID_DELETE_ARCHIVED_POLICY,
    });
    const result = cedar.buildAuthzFilter({
      principal: {
        role: 'authenticated',
        userId: 'alice',
        email: 'alice@test.com',
      },
      action: 'delete',
      context: { table: 'todos' },
      schema,
      startParam: 1,
    });
    const joined = result.conditions.join(' ');
    assert.ok(joined.includes('NOT'),
      'forbid policy should produce NOT condition');
    assert.ok(result.values.includes('archived'),
      'values should include "archived"');
  });

  it('multiple permit policies combine with OR', () => {
    cedar._setPolicies({ staticPolicies: TEAM_ACCESS_POLICY });
    const result = cedar.buildAuthzFilter({
      principal: {
        role: 'authenticated',
        userId: 'alice',
        email: 'alice@test.com',
        team_id: 'team-1',
      },
      action: 'select',
      context: { table: 'todos' },
      schema,
      startParam: 1,
    });
    const joined = result.conditions.join(' ');
    assert.ok(joined.includes('OR'),
      'multiple permit policies should combine with OR');
  });

  it('concrete deny throws PGRST403', () => {
    assert.throws(
      () => cedar.buildAuthzFilter({
        principal: { role: 'anon', userId: '', email: '' },
        action: 'select',
        context: { table: 'todos' },
        schema,
        startParam: 1,
      }),
      (err) => err.code === 'PGRST403',
      'anon with no matching permit should throw PGRST403',
    );
  });

  it('startParam offsets parameter numbering correctly', () => {
    const result = cedar.buildAuthzFilter({
      principal: {
        role: 'authenticated',
        userId: 'alice',
        email: 'alice@test.com',
      },
      action: 'select',
      context: { table: 'todos' },
      schema,
      startParam: 5,
    });
    const joined = result.conditions.join(' ');
    assert.ok(!joined.includes('$1'),
      'should not contain $1 when startParam is 5');
    const paramMatch = joined.match(/\$(\d+)/);
    assert.ok(paramMatch,
      'should contain parameter placeholders');
    assert.ok(parseInt(paramMatch[1], 10) >= 5,
      'parameter numbers should start at 5 or higher');
  });
});

// ================================================================
// evaluateExprAgainstRow -- in-process residual evaluation
// ================================================================

describe('evaluateExprAgainstRow', () => {
  function res(attr) {
    return { '.': { left: { Var: 'resource' }, attr } };
  }
  function val(v) {
    return { Value: v };
  }

  it('Value true returns true', () => {
    assert.equal(evaluateExprAgainstRow({ Value: true }, {}, null), true);
  });

  it('Value false returns false', () => {
    assert.equal(evaluateExprAgainstRow({ Value: false }, {}, null), false);
  });

  it('null expression returns true', () => {
    assert.equal(evaluateExprAgainstRow(null, {}, null), true);
  });

  it('is PgrestLambda::Row returns true', () => {
    assert.equal(
      evaluateExprAgainstRow(
        { is: { entity_type: 'PgrestLambda::Row' } }, {}, null,
      ),
      true,
    );
  });

  it('is PgrestLambda::Table returns false', () => {
    assert.equal(
      evaluateExprAgainstRow(
        { is: { entity_type: 'PgrestLambda::Table' } }, {}, null,
      ),
      false,
    );
  });

  it('has attr present returns true', () => {
    assert.equal(
      evaluateExprAgainstRow({ has: { attr: 'x' } }, { x: 1 }, null),
      true,
    );
  });

  it('has attr missing returns false', () => {
    assert.equal(
      evaluateExprAgainstRow({ has: { attr: 'x' } }, { y: 1 }, null),
      false,
    );
  });

  it('has attr null returns false', () => {
    assert.equal(
      evaluateExprAgainstRow({ has: { attr: 'x' } }, { x: null }, null),
      false,
    );
  });

  it('== match returns true', () => {
    assert.equal(
      evaluateExprAgainstRow(
        { '==': { left: res('a'), right: val(5) } }, { a: 5 }, null,
      ),
      true,
    );
  });

  it('== mismatch returns false', () => {
    assert.equal(
      evaluateExprAgainstRow(
        { '==': { left: res('a'), right: val(5) } }, { a: 6 }, null,
      ),
      false,
    );
  });

  it('== missing column returns false', () => {
    assert.equal(
      evaluateExprAgainstRow(
        { '==': { left: res('a'), right: val('x') } }, {}, null,
      ),
      false,
    );
  });

  it('!= returns true on mismatch', () => {
    assert.equal(
      evaluateExprAgainstRow(
        { '!=': { left: res('a'), right: val(5) } }, { a: 6 }, null,
      ),
      true,
    );
  });

  it('> returns true when greater', () => {
    assert.equal(
      evaluateExprAgainstRow(
        { '>': { left: res('a'), right: val(5) } }, { a: 6 }, null,
      ),
      true,
    );
  });

  it('> returns false when equal', () => {
    assert.equal(
      evaluateExprAgainstRow(
        { '>': { left: res('a'), right: val(5) } }, { a: 5 }, null,
      ),
      false,
    );
  });

  it('>= returns true when equal', () => {
    assert.equal(
      evaluateExprAgainstRow(
        { '>=': { left: res('a'), right: val(5) } }, { a: 5 }, null,
      ),
      true,
    );
  });

  it('< returns true when less', () => {
    assert.equal(
      evaluateExprAgainstRow(
        { '<': { left: res('a'), right: val(5) } }, { a: 4 }, null,
      ),
      true,
    );
  });

  it('<= returns true when equal', () => {
    assert.equal(
      evaluateExprAgainstRow(
        { '<=': { left: res('a'), right: val(5) } }, { a: 5 }, null,
      ),
      true,
    );
  });

  it('&& true+true returns true', () => {
    assert.equal(
      evaluateExprAgainstRow(
        { '&&': { left: val(true), right: val(true) } }, {}, null,
      ),
      true,
    );
  });

  it('&& true+false returns false', () => {
    assert.equal(
      evaluateExprAgainstRow(
        { '&&': { left: val(true), right: val(false) } }, {}, null,
      ),
      false,
    );
  });

  it('|| false+true returns true', () => {
    assert.equal(
      evaluateExprAgainstRow(
        { '||': { left: val(false), right: val(true) } }, {}, null,
      ),
      true,
    );
  });

  it('|| false+false returns false', () => {
    assert.equal(
      evaluateExprAgainstRow(
        { '||': { left: val(false), right: val(false) } }, {}, null,
      ),
      false,
    );
  });

  it('! true returns false', () => {
    assert.equal(
      evaluateExprAgainstRow({ '!': { arg: val(true) } }, {}, null),
      false,
    );
  });

  it('! false returns true', () => {
    assert.equal(
      evaluateExprAgainstRow({ '!': { arg: val(false) } }, {}, null),
      true,
    );
  });

  it('if-then-else true branch', () => {
    assert.equal(
      evaluateExprAgainstRow(
        { 'if-then-else': {
          if: val(true), then: val(true), else: val(false),
        } },
        {}, null,
      ),
      true,
    );
  });

  it('if-then-else false branch', () => {
    assert.equal(
      evaluateExprAgainstRow(
        { 'if-then-else': {
          if: val(false), then: val(true), else: val(false),
        } },
        {}, null,
      ),
      false,
    );
  });

  it('untranslatable expression (in) returns false', () => {
    assert.equal(
      evaluateExprAgainstRow({ in: {} }, {}, null),
      false,
    );
  });

  it('entity UID match returns true', () => {
    assert.equal(
      evaluateExprAgainstRow(
        { '==': {
          left: res('owner_id'),
          right: { Value: {
            __entity: { type: 'PgrestLambda::User', id: 'u1' },
          } },
        } },
        { owner_id: 'u1' }, null,
      ),
      true,
    );
  });

  it('entity UID mismatch returns false', () => {
    assert.equal(
      evaluateExprAgainstRow(
        { '==': {
          left: res('owner_id'),
          right: { Value: {
            __entity: { type: 'PgrestLambda::User', id: 'u1' },
          } },
        } },
        { owner_id: 'u2' }, null,
      ),
      false,
    );
  });
});

// ================================================================
// authorizeInsert — INSERT authorization with residual evaluation
// ================================================================

const UNCONDITIONAL_INSERT_POLICY = `
permit(
    principal is PgrestLambda::User,
    action == PgrestLambda::Action::"insert",
    resource == PgrestLambda::Table::"posts"
);
permit(
    principal is PgrestLambda::ServiceRole,
    action, resource
);
`;

const OWNER_CONDITIONED_INSERT_POLICY = `
permit(
    principal is PgrestLambda::User,
    action == PgrestLambda::Action::"insert",
    resource is PgrestLambda::Row
) when {
    context.table == "orders"
    && resource.owner_id == principal
};
permit(
    principal is PgrestLambda::ServiceRole,
    action, resource
);
`;

const TABLE_PERMIT_ROW_FORBID_POLICY = `
permit(
    principal is PgrestLambda::User,
    action == PgrestLambda::Action::"insert",
    resource == PgrestLambda::Table::"items"
);
forbid(
    principal,
    action == PgrestLambda::Action::"insert",
    resource is PgrestLambda::Row
) when {
    context.table == "items"
    && resource.restricted == true
};
`;

describe('authorizeInsert', () => {
  it('decided allow — unconditional table permit', () => {
    const cedar = makeCedar();
    cedar._setPolicies({
      staticPolicies: UNCONDITIONAL_INSERT_POLICY,
    });
    const result = cedar.authorizeInsert({
      principal: {
        role: 'authenticated',
        userId: 'user-A',
        email: 'a@test.com',
      },
      resource: 'posts',
      schema,
      rows: [{ title: 'Hello' }],
    });
    assert.equal(result, true);
  });

  it('residual evaluated — matching row', () => {
    const cedar = makeCedar();
    cedar._setPolicies({
      staticPolicies: OWNER_CONDITIONED_INSERT_POLICY,
    });
    const result = cedar.authorizeInsert({
      principal: {
        role: 'authenticated',
        userId: 'user-A',
        email: 'a@test.com',
      },
      resource: 'orders',
      schema,
      rows: [{ owner_id: 'user-A' }],
    });
    assert.equal(result, true);
  });

  it('residual evaluated — non-matching row', () => {
    const cedar = makeCedar();
    cedar._setPolicies({
      staticPolicies: OWNER_CONDITIONED_INSERT_POLICY,
    });
    assert.throws(
      () => cedar.authorizeInsert({
        principal: {
          role: 'authenticated',
          userId: 'user-A',
          email: 'a@test.com',
        },
        resource: 'orders',
        schema,
        rows: [{ owner_id: 'user-B' }],
      }),
      (err) => err.code === 'PGRST403',
    );
  });

  it('bulk: all rows match', () => {
    const cedar = makeCedar();
    cedar._setPolicies({
      staticPolicies: OWNER_CONDITIONED_INSERT_POLICY,
    });
    const result = cedar.authorizeInsert({
      principal: {
        role: 'authenticated',
        userId: 'user-A',
        email: 'a@test.com',
      },
      resource: 'orders',
      schema,
      rows: [{ owner_id: 'user-A' }, { owner_id: 'user-A' }],
    });
    assert.equal(result, true);
  });

  it('bulk: one row fails — includes row index in details', () => {
    const cedar = makeCedar();
    cedar._setPolicies({
      staticPolicies: OWNER_CONDITIONED_INSERT_POLICY,
    });
    assert.throws(
      () => cedar.authorizeInsert({
        principal: {
          role: 'authenticated',
          userId: 'user-A',
          email: 'a@test.com',
        },
        resource: 'orders',
        schema,
        rows: [{ owner_id: 'user-A' }, { owner_id: 'user-B' }],
      }),
      (err) => err.code === 'PGRST403'
        && err.details && err.details.includes('Row 1'),
    );
  });

  it('no policies loaded — throws PGRST403', () => {
    const cedar = makeCedar();
    assert.throws(
      () => cedar.authorizeInsert({
        principal: {
          role: 'authenticated',
          userId: 'user-A',
          email: 'a@test.com',
        },
        resource: 'orders',
        schema,
        rows: [{ owner_id: 'user-A' }],
      }),
      (err) => err.code === 'PGRST403',
    );
  });

  it('forbid residual fires — restricted=true denied', () => {
    const cedar = makeCedar();
    cedar._setPolicies({
      staticPolicies: TABLE_PERMIT_ROW_FORBID_POLICY,
    });
    assert.throws(
      () => cedar.authorizeInsert({
        principal: {
          role: 'authenticated',
          userId: 'user-A',
          email: 'a@test.com',
        },
        resource: 'items',
        schema,
        rows: [{ restricted: true }],
      }),
      (err) => err.code === 'PGRST403',
    );
  });

  it('forbid residual does not fire — restricted=false allowed', () => {
    const cedar = makeCedar();
    cedar._setPolicies({
      staticPolicies: TABLE_PERMIT_ROW_FORBID_POLICY,
    });
    const result = cedar.authorizeInsert({
      principal: {
        role: 'authenticated',
        userId: 'user-A',
        email: 'a@test.com',
      },
      resource: 'items',
      schema,
      rows: [{ restricted: false }],
    });
    assert.equal(result, true);
  });
});

describe('parsePolicySource (POLICIES_PATH URI parsing)', () => {
  it('defaults undefined/empty input to ./policies on the filesystem', () => {
    assert.deepEqual(parsePolicySource(undefined), { scheme: 'file', path: './policies' });
    assert.deepEqual(parsePolicySource(''), { scheme: 'file', path: './policies' });
  });

  it('treats a plain relative path as a filesystem source', () => {
    assert.deepEqual(
      parsePolicySource('./my-policies'),
      { scheme: 'file', path: './my-policies' },
    );
  });

  it('treats a plain absolute path as a filesystem source', () => {
    assert.deepEqual(
      parsePolicySource('/etc/pgrest/policies'),
      { scheme: 'file', path: '/etc/pgrest/policies' },
    );
  });

  it('parses file:///absolute/path as a filesystem source', () => {
    assert.deepEqual(
      parsePolicySource('file:///var/policies'),
      { scheme: 'file', path: '/var/policies' },
    );
  });

  it('parses s3://bucket/prefix/ as an S3 source', () => {
    assert.deepEqual(
      parsePolicySource('s3://my-bucket/policies/'),
      { scheme: 's3', bucket: 'my-bucket', prefix: 'policies/' },
    );
  });

  it('parses s3://bucket/ with no prefix', () => {
    assert.deepEqual(
      parsePolicySource('s3://my-bucket/'),
      { scheme: 's3', bucket: 'my-bucket', prefix: '' },
    );
  });

  it('parses s3://bucket (no trailing slash) as bucket + empty prefix', () => {
    assert.deepEqual(
      parsePolicySource('s3://my-bucket'),
      { scheme: 's3', bucket: 'my-bucket', prefix: '' },
    );
  });

  it('parses s3://bucket/deep/nested/prefix/', () => {
    assert.deepEqual(
      parsePolicySource('s3://b/one/two/three/'),
      { scheme: 's3', bucket: 'b', prefix: 'one/two/three/' },
    );
  });

  it('throws on unsupported schemes with a clear message', () => {
    assert.throws(
      () => parsePolicySource('gcs://some-bucket/policies/'),
      /Unsupported POLICIES_PATH scheme 'gcs'/,
    );
  });
});
