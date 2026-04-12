// router.mjs — Extract table name from path, validate

import { PostgRESTError } from './errors.mjs';
import { hasTable } from './schema-cache.mjs';

export function route(path, schema) {
  const remaining = path.replace(/^\/rest\/v1/, '');

  if (remaining === '' || remaining === '/') {
    return { type: 'openapi' };
  }

  if (remaining === '/_refresh') {
    return { type: 'refresh' };
  }

  const tableName = remaining.replace(/^\//, '').replace(/\/.*$/, '');

  if (!tableName || !hasTable(schema, tableName)) {
    throw new PostgRESTError(
      404,
      'PGRST205',
      `Relation '${tableName}' does not exist`,
      null,
      'Check the spelling of the table name.',
    );
  }

  return { type: 'table', table: tableName };
}
