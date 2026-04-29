// router.mjs — Extract table name from path, validate

import { PostgRESTError } from './errors.mjs';
import { hasTable } from './schema-cache.mjs';

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function route(path, schema) {
  const remaining = path.replace(/^\/rest\/v1/, '');

  if (remaining === '' || remaining === '/') {
    return { type: 'openapi' };
  }

  if (remaining === '/_refresh') {
    return { type: 'refresh' };
  }

  if (remaining === '/_docs') {
    return { type: 'docs' };
  }

  if (remaining.startsWith('/rpc/')) {
    const rpcMatch = remaining.match(
      /^\/rpc\/([A-Za-z_][A-Za-z0-9_]*)$/);
    if (!rpcMatch) {
      const raw = remaining.slice(5);
      throw new PostgRESTError(400, 'PGRST100',
        `'${raw}' is not a valid function name`,
        null,
        'Function names must match '
        + '[A-Za-z_][A-Za-z0-9_]*.');
    }
    return { type: 'rpc', functionName: rpcMatch[1] };
  }

  const tableName = remaining.replace(/^\//, '').replace(/\/.*$/, '');

  if (!tableName || !IDENT.test(tableName) || !hasTable(schema, tableName)) {
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
