// interface.mjs — Database provider contract
//
// Any database provider must implement this interface.
// See postgres.mjs and dsql.mjs for reference implementations.

/**
 * @typedef {Object} Pool
 * @property {(text: string, values?: any[]) => Promise<{rows: any[]}>} query
 */

/**
 * @typedef {Object} Schema
 * @property {Object<string, {columns: Object, primaryKey: string[]}>} tables
 */

/**
 * @typedef {Object} DatabaseProvider
 * @property {() => Promise<Pool>} getPool
 *   Return a connection pool (or pool-like object). Called on every request.
 *   The provider manages pooling, reconnection, and token refresh internally.
 *
 * @property {(pool: Pool) => void} _setPool
 *   Test injection hook — pre-set the pool to skip real connections.
 *
 * @property {((pool: Pool) => Promise<Schema>)?} [introspect]
 *   Optional. Override the default pg_catalog schema introspection.
 *   If not provided, pgrest-lambda uses PostgreSQL pg_catalog queries.
 *   Implement this for databases that don't support pg_catalog
 *   (e.g., MySQL, DynamoDB, or custom schemas).
 *
 *   Must return: { tables: { [tableName]: { columns: { [colName]: { type, nullable, defaultValue } }, primaryKey: [colName] } } }
 */
