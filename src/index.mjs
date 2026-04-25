// pgrest-lambda — A serverless REST API for any PostgreSQL database.

import { createDb } from './rest/db/index.mjs';
import { createSchemaCache } from './rest/schema-cache.mjs';
import { createCedar } from './rest/cedar.mjs';
import { createRestHandler } from './rest/handler.mjs';
import { createAuthHandler } from './auth/handler.mjs';
import { createJwt, assertJwtSecret } from './auth/jwt.mjs';
import { createAuthorizer } from './authorizer/index.mjs';
import { assertCorsConfig } from './shared/cors.mjs';

export { ensureBetterAuthSchema } from './auth/schema-migrator.mjs';

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
    provider: process.env.AUTH_PROVIDER || 'cognito',
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
  if (!config.cors) {
    return { allowedOrigins: '*', allowCredentials: false };
  }
  return {
    allowedOrigins: config.cors.allowedOrigins ?? '*',
    allowCredentials: config.cors.allowCredentials ?? false,
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
    policiesPath: config.policies || process.env.POLICIES_PATH || './policies',
    policiesBucket: config.policiesBucket || process.env.POLICIES_BUCKET || null,
    policiesPrefix: config.policiesPrefix || process.env.POLICIES_PREFIX || 'policies/',
    schemaCacheTtl: config.schemaCacheTtl
      || parseInt(process.env.SCHEMA_CACHE_TTL_MS || '30000', 10),
    docs: config.docs !== undefined ? config.docs
      : process.env.PGREST_DOCS !== 'false',
    apiBaseUrl: config.apiBaseUrl || process.env.API_BASE_URL || null,
    contributions: config.contributions || [],
    cors,
    production,
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
  const schemaCache = createSchemaCache({
    schemaCacheTtl: resolved.schemaCacheTtl,
    introspect: db.introspect || null,
  });
  const cedar = createCedar({
    policiesPath: resolved.policiesPath,
    policiesBucket: resolved.policiesBucket,
    policiesPrefix: resolved.policiesPrefix,
    region: resolved.region,
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

  const authorizer = createAuthorizer({
    jwtSecret: resolved.jwtSecret,
    jwksUrl: process.env.JWKS_URL || null,
  });

  // Combined handler (routes /auth/v1/* to auth, else to rest)
  function handler(event) {
    const path = event.path || '';
    if (path.startsWith('/auth/v1/') && auth) {
      return auth.handler(event);
    }
    return rest.handler(event);
  }

  return {
    rest: rest.handler,
    auth: auth?.handler || null,
    authorizer: authorizer.handler,
    handler,
    // Expose subsystems for advanced use and testing
    _db: db,
    _schemaCache: schemaCache,
    _cedar: cedar,
    _jwt: jwt,
    _auth: auth,
  };
}
