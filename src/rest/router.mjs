// router.mjs — Extract table name from path, validate

import { PostgRESTError, tableNotFound } from './errors.mjs';
import { hasTable } from './schema-cache.mjs';

/**
 * Decode one percent-encoded path segment.
 *
 * A relation or function name is an arbitrary PostgreSQL identifier, so a
 * client reaching a table called `Escap3e;` or a schema called `تست` has to
 * percent-encode it, and API Gateway hands the path through still encoded.
 * `decodeURIComponent` throws on a malformed escape (`/%`), which is a client
 * error, not a server one — so it is reported as a 400 rather than crashing.
 */
function decodeSegment(raw) {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new PostgRESTError(400, 'PGRST100',
      `'${raw}' is not a valid percent-encoded path segment`);
  }
}

/**
 * Turn a request path into a route.
 *
 * @param {string} path the request path
 * @param {Object} schema the schema cache for this request's profile
 * @param {string} schemaName the exposed schema this request selected
 * @param {{openApiMode?: string}} [options] engine configuration the routing
 *   decision depends on. `openApiMode` is upstream `openapi-mode`: `disabled`
 *   makes the root endpoint report no metadata at all.
 */
export function route(path, schema, schemaName = 'public', options = {}) {
  const remaining = path.replace(/^\/rest\/v1/, '');

  if (remaining === '' || remaining === '/') {
    // `openapi-mode = disabled` (upstream OADisabled): the root endpoint is a
    // 404 rather than a spec. It applies to the root only — the table and RPC
    // routes below are unaffected.
    if (options.openApiMode === 'disabled') {
      throw new PostgRESTError(404, 'PGRST126',
        'Root endpoint metadata is disabled');
    }
    return { type: 'openapi' };
  }

  if (remaining === '/_refresh') {
    return { type: 'refresh' };
  }

  if (remaining === '/_docs') {
    return { type: 'docs' };
  }

  if (remaining.startsWith('/rpc/')) {
    // Everything after /rpc/ up to the next slash is the function name. No
    // character class is imposed: upstream takes the segment as an identifier
    // and lets the schema cache decide whether it exists, which is how
    // `/rpc/welcome.html` resolves to a function literally named
    // `welcome.html` (CustomMediaSpec). The name never reaches SQL as text —
    // routines.mjs resolves it against pg_proc and the call is built from the
    // catalog entry — so admitting the character is not admitting injection.
    const raw = remaining.slice(5).replace(/\/.*$/, '');
    if (raw === '') {
      throw new PostgRESTError(400, 'PGRST100',
        "'' is not a valid function name");
    }
    return { type: 'rpc', functionName: decodeSegment(raw) };
  }

  const tableName = decodeSegment(remaining.replace(/^\//, '').replace(/\/.*$/, ''));

  // The schema cache is the validator. A name it holds came out of pg_class,
  // so it is a real identifier whatever characters it contains, and
  // sql-builder quotes it on the way out. A name it does not hold is a 404 —
  // the same answer upstream gives, and it never reaches the database.
  if (!tableName || !hasTable(schema, tableName)) {
    throw tableNotFound(schemaName, tableName, Object.keys(schema?.tables || {}));
  }

  return { type: 'table', table: tableName };
}
