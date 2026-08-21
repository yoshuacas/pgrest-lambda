// pgrest-lambda — A serverless REST API for any PostgreSQL database.

import { readFileSync } from 'node:fs';

import { createDb } from './rest/db/index.mjs';
import { createSchemaCache } from './rest/schema-cache.mjs';
import { createCedar } from './rest/cedar.mjs';
import { createRestHandler } from './rest/handler.mjs';
import { DEFAULT_MAX_EMBED_DEPTH } from './rest/query-parser.mjs';
import { createAuthHandler } from './auth/handler.mjs';
import { createJwt, assertJwtSecret } from './auth/jwt.mjs';
import { assertCorsConfig } from './shared/cors.mjs';

export { ensureBetterAuthSchema } from './auth/schema-migrator.mjs';
export { startDevServer } from './dev/server.mjs';
export { generateApikey } from './dev/keys.mjs';
export {
  startBundledPostgres,
  stopBundledPostgres,
  resetBundledPostgres,
} from './dev/docker-postgres.mjs';

function parseIntOrDefault(value, fallback) {
  if (!value) return fallback;
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

// --- engine configuration surface -------------------------------------------
//
// The options below are named after upstream PostgREST's configuration keys
// (`db-schemas`, `db-extra-search-path`, `db-max-rows`, `db-pre-request`,
// `db-aggregates-enabled`, `db-plan-enabled`, `server-cors-allowed-origins`,
// `jwt-secret`, `jwt-aud`) so a PostgREST deployment can be translated one
// line at a time. Every one is settable by environment variable — see
// docs/configuration.md — and every one keeps the engine's previous behaviour
// as its default, except where the default was already upstream's.

/** Comma/whitespace separated list → array of trimmed, non-empty strings. */
export function parseList(value, fallback = []) {
  if (value === undefined || value === null) return fallback;
  if (Array.isArray(value)) {
    const list = value.map(v => String(v).trim()).filter(Boolean);
    return list.length ? list : fallback;
  }
  const list = String(value)
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  return list.length ? list : fallback;
}

function parseBool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const v = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(v)) return true;
  if (['false', '0', 'no', 'off'].includes(v)) return false;
  return fallback;
}

// `db-pre-request`, `db-root-spec` and `db-pre-config` are all function names,
// optionally schema-qualified. A function name cannot be a bind parameter, so
// it reaches SQL as text and is validated here: anything that is not one or two
// plain identifiers is rejected at boot rather than reaching the database.
const PRE_REQUEST_RE = /^[\p{L}_][\p{L}\p{N}_$]*$/u;

/**
 * Parse a `<schema>.<function>` or `<function>` configuration value.
 *
 * @param {*} value the raw setting
 * @param {string} option the upstream option name, for the error message
 * @returns {{schema: string|null, name: string}|null} null when unset
 */
export function parseQualifiedFunction(value, option) {
  if (!value) return null;
  const parts = String(value).trim().split('.');
  if (parts.length > 2 || !parts.every(p => PRE_REQUEST_RE.test(p))) {
    throw new Error(
      `pgrest-lambda: ${option} must be a function name, optionally `
      + `schema-qualified (got ${JSON.stringify(String(value))})`);
  }
  return parts.length === 2
    ? { schema: parts[0], name: parts[1] }
    : { schema: null, name: parts[0] };
}

export function parsePreRequest(value) {
  return parseQualifiedFunction(value, 'db-pre-request');
}

/**
 * `app-settings`: either an object (`{ 'app.settings.app_host': 'localhost' }`)
 * or, from the environment, a comma-separated `name=value` list. Order is
 * preserved because upstream applies the pairs in order.
 *
 * @param {*} value the raw setting
 * @returns {Array<[string, string]>} name/value pairs, empty when unset
 */
export function parseAppSettings(value) {
  if (value === undefined || value === null || value === '') return [];
  if (typeof value === 'object') {
    return Array.isArray(value) ? value : Object.entries(value);
  }
  return String(value)
    .split(',')
    .map(pair => pair.trim())
    .filter(Boolean)
    .map(pair => {
      const eq = pair.indexOf('=');
      if (eq === -1) {
        throw new Error(
          'pgrest-lambda: app-settings entries are name=value '
          + `(got ${JSON.stringify(pair)})`);
      }
      return [pair.slice(0, eq).trim(), pair.slice(eq + 1).trim()];
    });
}

// `openapi-mode` (upstream `parseOpenAPIMode`). `follow-privileges` is the
// default and what this engine has always done; `ignore-privileges` names the
// same behaviour here, because the engine introspects with its own connection
// role and never filters the spec by the caller's privileges — there is no
// `SET ROLE`; `disabled` makes the root endpoint report no metadata at all.
const OPENAPI_MODES = ['follow-privileges', 'ignore-privileges', 'disabled'];

export function parseOpenApiMode(value) {
  if (value === undefined || value === null || value === '') {
    return 'follow-privileges';
  }
  const v = String(value).trim().toLowerCase();
  if (OPENAPI_MODES.includes(v)) return v;
  throw new Error(
    `pgrest-lambda: openapi-mode must be one of ${OPENAPI_MODES.join(', ')} `
    + `(got ${JSON.stringify(String(value))})`);
}

// `client-error-verbosity` (upstream `parseErrorVerbosity`): `verbose` returns
// all four error fields, `minimal` returns `code` and `message` only.
const ERROR_VERBOSITIES = ['verbose', 'minimal'];

export function parseClientErrorVerbosity(value) {
  if (value === undefined || value === null || value === '') return 'verbose';
  const v = String(value).trim().toLowerCase();
  if (ERROR_VERBOSITIES.includes(v)) return v;
  throw new Error(
    'pgrest-lambda: client-error-verbosity must be one of '
    + `${ERROR_VERBOSITIES.join(', ')} (got ${JSON.stringify(String(value))})`);
}

// `server-trace-header`: the name of a request header echoed back on every
// response. It is written into a response header name, so it has to be a valid
// HTTP field name (RFC 9110 token) or a deployment could inject a header break.
const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * A non-negative integer setting, where 0 is a meaningful value.
 *
 * `parseIntOrDefault` cannot be used for these: it treats 0 as unset, and 0 is
 * how upstream turns the JWT cache off.
 */
export function parseCount(value, fallback, option) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(
      `pgrest-lambda: ${option} must be a non-negative integer `
      + `(got ${JSON.stringify(String(value))})`);
  }
  return n;
}

export function parseTraceHeader(value) {
  if (value === undefined || value === null || value === '') return null;
  const name = String(value).trim();
  if (!HEADER_NAME_RE.test(name)) {
    throw new Error(
      'pgrest-lambda: server-trace-header must be a valid HTTP header name '
      + `(got ${JSON.stringify(String(value))})`);
  }
  return name;
}

/**
 * Echo the configured trace header back on every response.
 *
 * Upstream implements `server-trace-header` as WAI middleware around the whole
 * application (App.hs `traceHeaderMiddleware`), which is why this wraps the
 * handler rather than living inside it: the header rides on error responses and
 * on responses no route produced, not just on successful reads. A request that
 * does not carry the header still gets it back empty, as upstream does
 * (`fromMaybe mempty`).
 *
 * @param {Function} handlerFn the handler to wrap
 * @param {string|null} headerName the configured header name, or null to
 *   return the handler untouched
 */
export function withTraceHeader(handlerFn, headerName) {
  if (!headerName || typeof handlerFn !== 'function') return handlerFn;
  const wanted = headerName.toLowerCase();
  return async function traceHeaderHandler(event, ...rest) {
    const response = await handlerFn(event, ...rest);
    let value = '';
    for (const [name, raw] of Object.entries(event?.headers || {})) {
      if (name.toLowerCase() === wanted) {
        value = raw === undefined || raw === null ? '' : String(raw);
        break;
      }
    }
    if (!response || typeof response !== 'object') return response;
    return {
      ...response,
      headers: { ...(response.headers || {}), [headerName]: value },
    };
  };
}

/**
 * Per-schema view of the declared-relationship manifest.
 *
 * The manifest (CONTRACTS.md §2) is schema-qualified, but the schema cache
 * introspects one schema at a time and keys everything by bare relation name.
 * For an exposed schema other than `public`, keep only the relationships whose
 * both ends live in that schema and relabel them, so the cache treats them as
 * local. `public` is passed through untouched, which keeps the single-schema
 * default byte-for-byte what it was.
 */
export function relationshipsForSchema(source, schemaName) {
  if (schemaName === 'public') return source ?? undefined;
  let doc = source;
  if (typeof doc === 'string') {
    try {
      doc = JSON.parse(readFileSync(doc, 'utf8'));
    } catch {
      return [];
    }
  }
  const list = Array.isArray(doc) ? doc : (doc?.relationships || []);
  return list
    .filter(r => (r.schema || 'public') === schemaName
      && (r.foreignSchema || 'public') === schemaName)
    .map(r => ({ ...r, schema: 'public', foreignSchema: 'public' }));
}

// The introspection SQL in schema-cache.mjs targets `public` by name. Reading
// another exposed schema means substituting that predicate — as a bind
// parameter, never as interpolated text — and relabelling the schema columns
// the catalog returns so the cache sees one flat namespace. Queries that
// already carry parameters are oid-keyed and schema-agnostic, so they pass
// through untouched.
const PUBLIC_NSP_RE = /nspname\s*=\s*'public'/g;
const SCHEMA_COLUMNS = ['from_schema', 'to_schema', 'schema_name'];

export function schemaIntrospectionPool(pool, schemaName) {
  return {
    async query(text, values) {
      if (values && values.length) return pool.query(text, values);
      const sql = String(text);
      const result = PUBLIC_NSP_RE.test(sql)
        ? await pool.query(sql.replace(PUBLIC_NSP_RE, 'nspname = $1'),
          [schemaName])
        : await pool.query(sql);
      const rows = result?.rows;
      if (!Array.isArray(rows) || rows.length === 0) return result;
      const present = SCHEMA_COLUMNS.filter(c => c in rows[0]);
      if (present.length === 0) return result;
      const kept = rows
        .filter(row => present.every(c => (row[c] || 'public') === schemaName))
        .map(row => {
          const out = { ...row };
          for (const c of present) out[c] = 'public';
          return out;
        });
      return { ...result, rows: kept };
    },
  };
}

function resolveRestConfig(config) {
  const dbSchemas = parseList(
    config.dbSchemas ?? process.env.PGREST_DB_SCHEMAS, ['public']);
  const dbExtraSearchPath = parseList(
    config.dbExtraSearchPath ?? process.env.PGREST_DB_EXTRA_SEARCH_PATH,
    ['public']);
  const maxRows = config.dbMaxRows
    ?? (process.env.PGREST_DB_MAX_ROWS
      ? parseIntOrDefault(process.env.PGREST_DB_MAX_ROWS, null)
      : null);
  return {
    dbSchemas,
    dbExtraSearchPath,
    dbMaxRows: Number.isFinite(maxRows) && maxRows >= 0 ? maxRows : null,
    dbPreRequest: parsePreRequest(
      config.dbPreRequest ?? process.env.PGREST_DB_PRE_REQUEST),
    // `app-settings`: run-time settings every request runs with, readable from
    // SQL with `current_setting('app.settings.<name>')`. Upstream keeps them as
    // an ordered list of pairs (`configAppSettings`) and applies them
    // transaction-locally per request (Query/PreQuery.hs `txVarQuery`).
    appSettings: parseAppSettings(
      config.appSettings ?? process.env.PGREST_APP_SETTINGS),
    // Upstream defaults `db-aggregates-enabled` to false; this engine has
    // always served aggregates, so the default stays true here and the switch
    // exists to turn them off (PGRST123), which is the behaviour upstream
    // asserts with the option unset.
    dbAggregatesEnabled: parseBool(
      config.dbAggregatesEnabled ?? process.env.PGREST_DB_AGGREGATES_ENABLED,
      true),
    // Off by default, like upstream: `Accept: application/vnd.pgrst.plan` is
    // refused with 406 until it is turned on.
    dbPlanEnabled: parseBool(
      config.dbPlanEnabled ?? process.env.PGREST_DB_PLAN_ENABLED, false),
    // Upstream has no built-in filterless-mutation guard: it relies on the
    // pg-safeupdate extension, which is off unless a `db-pre-request` function
    // loads it, and which answers with SQLSTATE 21000 "UPDATE requires a WHERE
    // clause". This engine ships its own guard on, so `on` stays the default;
    // `off` allows filterless UPDATE/DELETE (upstream's default), and
    // `safeupdate` keeps the guard but answers with pg-safeupdate's wire error.
    bulkMutationGuard: parseBulkMutationGuard(
      config.bulkMutationGuard ?? process.env.PGREST_DB_BULK_MUTATION_GUARD),
    // `server-timing-enabled`, default false like upstream: the timing header
    // is a per-request measurement, so it is opt-in.
    serverTiming: parseBool(
      config.serverTiming ?? process.env.PGREST_SERVER_TIMING_ENABLED, false),
    // `server-trace-header`, unset by default: no header is echoed.
    serverTraceHeader: parseTraceHeader(
      config.serverTraceHeader ?? process.env.PGREST_SERVER_TRACE_HEADER),
    // `openapi-mode`, `follow-privileges` by default like upstream.
    openApiMode: parseOpenApiMode(
      config.openApiMode ?? process.env.PGREST_OPENAPI_MODE),
    // `client-error-verbosity`, `verbose` by default like upstream: all four
    // error fields. `minimal` drops `details` and `hint`.
    clientErrorVerbosity: parseClientErrorVerbosity(
      config.clientErrorVerbosity
      ?? process.env.PGREST_CLIENT_ERROR_VERBOSITY),
    // `db-root-spec`: a function whose result is served at `/` instead of the
    // generated OpenAPI document.
    dbRootSpec: parseQualifiedFunction(
      config.dbRootSpec ?? process.env.PGREST_DB_ROOT_SPEC, 'db-root-spec'),
    // `db-pre-config`: a function run once per connection before the
    // configuration is read, used upstream to set options from the database.
    dbPreConfig: parseQualifiedFunction(
      config.dbPreConfig ?? process.env.PGREST_DB_PRE_CONFIG, 'db-pre-config'),
    // `db-prepared-statements`, true by default like upstream.
    dbPreparedStatements: parseBool(
      config.dbPreparedStatements
      ?? process.env.PGREST_DB_PREPARED_STATEMENTS, true),
    // `url-use-legacy-target-names`. Upstream defaults this true: a filter on an
    // aliased embed may name the target relation instead of the alias, and gets
    // a deprecation `Warning` header. This engine has always required the alias
    // and answers PGRST108 otherwise — upstream's `false` — so `false` is the
    // default here, following the rule that a new option's default is the
    // behaviour the engine already had.
    urlUseLegacyTargetNames: parseBool(
      config.urlUseLegacyTargetNames
      ?? process.env.PGREST_URL_USE_LEGACY_TARGET_NAMES, false),
    // `jwt-cache-max-entries`, 1000 by default like upstream. 0 disables the
    // cache.
    jwtCacheMaxEntries: parseCount(
      config.jwtCacheMaxEntries ?? process.env.PGREST_JWT_CACHE_MAX_ENTRIES,
      1000, 'jwt-cache-max-entries'),
  };
}

const BULK_GUARD_MODES = ['on', 'off', 'safeupdate'];

export function parseBulkMutationGuard(value) {
  if (value === undefined || value === null || value === '') return 'on';
  if (value === true) return 'on';
  if (value === false) return 'off';
  const v = String(value).trim().toLowerCase();
  if (BULK_GUARD_MODES.includes(v)) return v;
  if (['true', '1', 'yes', 'on'].includes(v)) return 'on';
  if (['false', '0', 'no'].includes(v)) return 'off';
  throw new Error(
    'pgrest-lambda: db-bulk-mutation-guard must be one of '
    + `${BULK_GUARD_MODES.join(', ')} (got ${JSON.stringify(String(value))})`);
}

/**
 * In-engine JWT verification (upstream `jwt-secret` / `jwt-aud` / JWKS).
 *
 * Off unless a REST-level secret is configured: the normal deployment verifies
 * tokens in the API Gateway authorizer and hands the engine a role. When it is
 * on, the REST handler verifies the bearer token itself and derives the role
 * from the claims, which is what a standalone (non-API-Gateway) deployment
 * needs and what the upstream auth specs assert against.
 */
function resolveRestJwt(config) {
  const raw = config.restJwt ?? {};
  const enabled = parseBool(
    raw.verify ?? process.env.PGREST_JWT_VERIFY,
    raw.secret !== undefined || process.env.PGREST_JWT_SECRET !== undefined);
  if (!enabled) return null;
  const secret = raw.secret ?? process.env.PGREST_JWT_SECRET ?? null;
  // `db-anon-role`: the role a request with no token runs as. Upstream leaves
  // it unset to disable anonymous access altogether, which an empty string
  // expresses here (an unset environment variable cannot be told apart from a
  // variable that was never mentioned).
  const anonRole = raw.anonRole ?? process.env.PGREST_DB_ANON_ROLE ?? 'anon';
  return {
    // A JSON object/array secret is a JWK or JWK Set (upstream `parseSecret`).
    secret: secret === '' ? null : secret,
    audience: raw.audience ?? process.env.PGREST_JWT_AUD ?? null,
    secretIsBase64: parseBool(
      raw.secretIsBase64 ?? process.env.PGREST_JWT_SECRET_IS_BASE64, false),
    anonRole: anonRole === '' ? null : anonRole,
  };
}

function resolveDatabase(config) {
  if (config.database) {
    const d = config.database;
    return {
      dsqlEndpoint: d.dsqlEndpoint || null,
      region: d.region || null,
      connectionString: d.connectionString || null,
      host: d.host,
      port: d.port,
      user: d.user,
      password: d.password,
      passwordSsmParam: d.passwordSsmParam || null,
      database: d.database,
      ssl: d.ssl,
    };
  }
  // Fall back to env vars
  const dsql = process.env.DSQL_ENDPOINT;
  if (dsql) {
    return {
      dsqlEndpoint: dsql,
      region: process.env.REGION_NAME,
    };
  }
  return {
    connectionString: process.env.DATABASE_URL || null,
    host: process.env.PG_HOST,
    port: process.env.PG_PORT ? parseInt(process.env.PG_PORT, 10) : undefined,
    user: process.env.PG_USER,
    password: process.env.PG_PASSWORD,
    passwordSsmParam: process.env.PG_PASSWORD_SSM_PARAM || null,
    region: process.env.REGION_NAME,
    database: process.env.PG_DATABASE,
    ssl: process.env.PG_SSL === 'true',
  };
}

function resolveAuth(config) {
  if (config.auth === false) return false;
  if (typeof config.auth === 'function') return config.auth;
  if (config.auth && typeof config.auth === 'object') return config.auth;
  // Fall back to env vars
  return {
    provider: process.env.AUTH_PROVIDER || 'better-auth',
    region: process.env.REGION_NAME,
    userPoolId: process.env.USER_POOL_ID,
    clientId: process.env.USER_POOL_CLIENT_ID,
    betterAuthSecret: process.env.BETTER_AUTH_SECRET,
    betterAuthUrl: process.env.BETTER_AUTH_URL,
    googleClientId: process.env.GOOGLE_CLIENT_ID,
    googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
    sesFromAddress: process.env.SES_FROM_ADDRESS,
  };
}

function resolveCors(config) {
  // `server-cors-allowed-origins`: upstream treats an empty list as "no
  // restriction" (`*` with no credentials) and a non-empty list as "echo the
  // request origin when it is on the list", which requires
  // Access-Control-Allow-Credentials: true to be useful.
  const envOrigins = parseList(
    process.env.PGREST_SERVER_CORS_ALLOWED_ORIGINS, null);
  if (!config.cors) {
    if (envOrigins) {
      return { allowedOrigins: envOrigins, allowCredentials: true };
    }
    return { allowedOrigins: '*', allowCredentials: false };
  }
  const allowedOrigins = config.cors.allowedOrigins ?? envOrigins ?? '*';
  return {
    allowedOrigins,
    allowCredentials: config.cors.allowCredentials
      ?? (Array.isArray(allowedOrigins) && allowedOrigins.length > 0),
  };
}

function resolveConfig(config) {
  const dbConfig = resolveDatabase(config);
  const region = config.region || dbConfig.region || process.env.REGION_NAME;
  const cors = resolveCors(config);
  const production = config.production
    ?? (process.env.NODE_ENV === 'production');

  return {
    database: dbConfig,
    jwtSecret: config.jwtSecret ?? process.env.JWT_SECRET,
    auth: resolveAuth(config),
    region,
    // POLICIES_PATH accepts a filesystem path or a URI with a scheme
    // (currently `s3://<bucket>/<prefix>`; `file://` also accepted as an
    // explicit synonym for the default). See src/rest/cedar.mjs for the
    // parser and loader dispatch.
    policiesPath: config.policies || process.env.POLICIES_PATH || './policies',
    schemaCacheTtl: config.schemaCacheTtl
      || parseInt(process.env.SCHEMA_CACHE_TTL_MS || '30000', 10),
    docs: config.docs !== undefined ? config.docs
      : process.env.PGREST_DOCS !== 'false',
    apiBaseUrl: config.apiBaseUrl || process.env.API_BASE_URL || null,
    contributions: config.contributions || [],
    cors,
    production,
    errorsVerbose: config.errors?.verbose
      ?? (process.env.PGREST_ERRORS_VERBOSE === 'true'),
    // Replace a PostgreSQL error's message/detail/hint with generic wording
    // (security finding V-09). Off by default, because upstream returns the
    // server's own strings and 83 of its assertions read them — project rule 7.
    // A deployment that must not echo server strings turns this on and accepts
    // the loss of wire compatibility.
    errorsSanitize: config.errors?.sanitize
      ?? (process.env.PGREST_ERRORS_SANITIZE === 'true'),
    maxEmbedDepth: config.maxEmbedDepth
      ?? parseIntOrDefault(
        process.env.PGREST_MAX_EMBED_DEPTH, DEFAULT_MAX_EMBED_DEPTH),
    rest: resolveRestConfig(config),
    restJwt: resolveRestJwt(config),
    relationships: config.relationships
      ?? process.env.PGREST_RELATIONSHIPS_PATH ?? null,
  };
}

export function createPgrest(config = {}) {
  const resolved = resolveConfig(config);
  assertJwtSecret(resolved.jwtSecret);
  assertCorsConfig(resolved.cors, resolved.production);

  // Build context — shared mutable state lives here
  const ctx = {
    authProvider: null,
    authProviderSetClient: null,
  };

  // Create subsystems
  const db = createDb(resolved.database);
  const dbCapabilities = db.capabilities();

  // One schema cache per exposed schema (`db-schemas`). With the default single
  // `public` schema this is exactly one cache built exactly as before; the map
  // only grows when a deployment exposes more.
  const schemaCaches = new Map();
  function cacheFor(schemaName) {
    let cache = schemaCaches.get(schemaName);
    if (!cache) {
      cache = createSchemaCache({
        schemaCacheTtl: resolved.schemaCacheTtl,
        introspect: db.introspect || null,
        capabilities: dbCapabilities,
        // The schema-scoped introspection SQL binds this; the pool wrapper
        // below rewrites the literal-`public` predicates for the same schema.
        schema: schemaName,
        relationships:
          relationshipsForSchema(resolved.relationships, schemaName),
      });
      schemaCaches.set(schemaName, cache);
    }
    return cache;
  }
  function poolFor(pool, schemaName) {
    return schemaName === 'public'
      ? pool
      : schemaIntrospectionPool(pool, schemaName);
  }
  const defaultSchema = resolved.rest.dbSchemas[0];
  const schemaCache = cacheFor(defaultSchema);
  const cedar = createCedar({
    policiesPath: resolved.policiesPath,
    region: resolved.region,
    production: resolved.production,
  });
  const jwt = createJwt({ jwtSecret: resolved.jwtSecret });

  // Attach subsystems to context for cross-cutting access
  ctx.db = db;
  ctx.schemaCache = schemaCache;
  ctx.cedar = cedar;
  ctx.jwt = jwt;
  ctx.docs = resolved.docs;
  ctx.apiBaseUrl = resolved.apiBaseUrl;
  ctx.cors = resolved.cors;
  ctx.production = resolved.production;
  ctx.errorsVerbose = resolved.errorsVerbose;
  ctx.errorsSanitize = resolved.errorsSanitize;
  ctx.maxEmbedDepth = resolved.maxEmbedDepth;
  ctx.dbCapabilities = dbCapabilities;
  // Engine configuration surface (upstream names). See docs/configuration.md.
  ctx.dbSchemas = resolved.rest.dbSchemas;
  ctx.defaultSchema = defaultSchema;
  ctx.dbExtraSearchPath = resolved.rest.dbExtraSearchPath;
  ctx.dbMaxRows = resolved.rest.dbMaxRows;
  ctx.dbPreRequest = resolved.rest.dbPreRequest;
  ctx.appSettings = resolved.rest.appSettings;
  ctx.dbAggregatesEnabled = resolved.rest.dbAggregatesEnabled;
  ctx.dbPlanEnabled = resolved.rest.dbPlanEnabled;
  ctx.bulkMutationGuard = resolved.rest.bulkMutationGuard;
  ctx.serverTiming = resolved.rest.serverTiming;
  ctx.serverTraceHeader = resolved.rest.serverTraceHeader;
  ctx.openApiMode = resolved.rest.openApiMode;
  ctx.clientErrorVerbosity = resolved.rest.clientErrorVerbosity;
  ctx.dbRootSpec = resolved.rest.dbRootSpec;
  ctx.dbPreConfig = resolved.rest.dbPreConfig;
  ctx.dbPreparedStatements = resolved.rest.dbPreparedStatements;
  ctx.urlUseLegacyTargetNames = resolved.rest.urlUseLegacyTargetNames;
  ctx.jwtCacheMaxEntries = resolved.rest.jwtCacheMaxEntries;
  ctx.restJwt = resolved.restJwt;
  ctx.getSchemaFor = (schemaName, pool) =>
    cacheFor(schemaName).getSchema(poolFor(pool, schemaName));
  ctx.refreshSchemaFor = (schemaName, pool) =>
    cacheFor(schemaName).refresh(poolFor(pool, schemaName));

  if (!resolved.production) {
    console.info(
      '[pgrest-lambda] db capabilities:',
      JSON.stringify(dbCapabilities),
    );
  }

  // Create auth handler first (needed for OpenAPI contributions)
  let auth = null;
  if (resolved.auth === false) {
    auth = null;
  } else if (typeof resolved.auth === 'function') {
    auth = { handler: resolved.auth };
  } else {
    auth = createAuthHandler(resolved, ctx);
  }

  // Collect OpenAPI contributions from internal handlers + external config
  const contributions = [...resolved.contributions];
  if (auth?.getOpenApiPaths) {
    contributions.push(auth.getOpenApiPaths);
  }

  // Create rest handler with contributions
  const rest = createRestHandler(ctx, contributions);

  // `server-trace-header` wraps both handlers, the way upstream wraps the whole
  // application (App.hs `traceHeaderMiddleware`), so the echo also rides on
  // error responses. Unset — the default — returns the handlers untouched.
  const traceHeader = resolved.rest.serverTraceHeader;
  const restHandler = withTraceHeader(rest.handler, traceHeader);
  const authHandler = auth?.handler
    ? withTraceHeader(auth.handler, traceHeader)
    : null;

  // Combined handler (routes /auth/v1/* to auth, else to rest)
  function handler(event) {
    const path = event.path || '';
    if (path.startsWith('/auth/v1/') && authHandler) {
      return authHandler(event);
    }
    return restHandler(event);
  }

  return {
    rest: restHandler,
    auth: authHandler,
    handler,
    // Expose subsystems for advanced use and testing
    _db: db,
    _dbCapabilities: dbCapabilities,
    _ctx: ctx,
    _schemaCache: schemaCache,
    _cedar: cedar,
    _jwt: jwt,
    _auth: auth,
  };
}
