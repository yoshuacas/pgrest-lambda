# Database Providers

pgrest-lambda connects to databases through provider modules. Each provider implements the same interface, so the rest of the system doesn't care which database is behind it.

## Existing providers

| Provider | File | Config trigger |
|---|---|---|
| Standard PostgreSQL | `postgres.mjs` | Default, or `provider: 'postgres'` |
| Aurora DSQL | `dsql.mjs` | `dsqlEndpoint` in config, or `provider: 'dsql'` |

## Adding a new provider

Create a single file in this directory. Your provider must export a factory function that returns an object implementing the `DatabaseProvider` interface.

### 1. Create the provider file

```javascript
// src/rest/db/mydb.mjs

export function createMyDbProvider(config) {
  let pool = null;

  function _setPool(p) {
    pool = p;
  }

  async function getPool() {
    if (pool) return pool;
    // Create your connection pool here using config.*
    // Must return an object with: query(text, values) → { rows }
    pool = createYourPool(config);
    return pool;
  }

  return { getPool, _setPool };
}
```

### 2. Register it in `index.mjs`

```javascript
import { createMyDbProvider } from './mydb.mjs';

export function createDb(config) {
  if (config.provider === 'mydb') return createMyDbProvider(config);
  // ... existing providers
}
```

### 3. Done

No changes needed in handler, schema-cache, sql-builder, cedar, auth, authorizer, or any other module.

## Interface

See `interface.mjs` for the full JSDoc contract. The short version:

### Required

**`getPool()`** — Returns a pool-like object with a `query` method.

```javascript
const pool = await provider.getPool();
const result = await pool.query('SELECT * FROM todos WHERE id = $1', ['abc']);
// result.rows → [{ id: 'abc', title: '...', ... }]
```

The `query` method must:
- Accept a SQL string and an array of parameter values
- Return `{ rows: [...] }` where rows is an array of objects keyed by column name
- Use `$1`, `$2`, ... for parameter placeholders (PostgreSQL style)

**`_setPool(pool)`** — Test injection hook. Allows tests to replace the real pool with a mock.

### Optional

**`introspect(pool)`** — Override schema introspection for databases that don't support `pg_catalog`.

By default, pgrest-lambda discovers tables and columns by querying `pg_catalog`. This works for any PostgreSQL-compatible database (PostgreSQL, Aurora, DSQL, CockroachDB, Neon, etc.). If your database doesn't support `pg_catalog`, implement this method:

```javascript
async function introspect(pool) {
  // Query your database's metadata however it works
  return {
    tables: {
      todos: {
        columns: {
          id: { type: 'integer', nullable: false, defaultValue: null },
          title: { type: 'text', nullable: false, defaultValue: null },
          done: { type: 'boolean', nullable: true, defaultValue: 'false' },
        },
        primaryKey: ['id'],
      },
      // ... more tables
    },
  };
}

export function createMyDbProvider(config) {
  return { getPool, _setPool, introspect };
}
```

The `introspect` function is called by the schema cache and its result is used for routing, query validation, OpenAPI generation, and Cedar authorization.

## Config

Providers receive the `config.database` object from `createPgrest()`. The shape is whatever your provider needs — there's no fixed schema beyond what each provider documents.

The registry in `index.mjs` picks a provider by:
1. Explicit `config.provider` field (`'postgres'`, `'dsql'`, `'mydb'`)
2. Auto-detection from config shape (e.g., `dsqlEndpoint` present → DSQL)
3. Default → PostgreSQL

## Connection lifecycle

- `getPool()` is called on every request. Providers should cache the pool and return it on subsequent calls.
- For databases with expiring credentials (like DSQL's IAM tokens), the provider manages refresh internally — see `dsql.mjs` for the pattern.
- Lambda containers are reused across invocations, so the pool persists for the container's lifetime.

## Testing

Provider tests go in `test/integration/`. Use the shared test helpers to run the same CRUD, filter, Cedar authorization, and authorizer tests against your database. See `src/rest/__tests__/real-db.test.mjs` for the pattern.
