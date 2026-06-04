// postgres.mjs — Standard PostgreSQL provider

import pg from 'pg';

const { Pool } = pg;

function resolveSsl(ssl) {
  if (!ssl) return undefined;
  if (ssl === true) return { rejectUnauthorized: true };
  return { rejectUnauthorized: true, ...ssl };
}

// Read a password from an SSM SecureString parameter at runtime.
//
// CloudFormation forbids the `ssm-secure` dynamic reference inside Lambda
// environment variables, so a managed PostgreSQL password (e.g. an RDS master
// password) cannot be injected into PG_PASSWORD at deploy time. Instead the
// deployer stores the password as an SSM SecureString and passes only the
// parameter NAME via PG_PASSWORD_SSM_PARAM. We resolve it here, lazily, the
// same way the DSQL provider mints its IAM token inside getPool() — so no
// static secret ever lives in the function environment.
async function resolveSsmPassword(parameterName, region) {
  const { SSMClient, GetParameterCommand } = await import('@aws-sdk/client-ssm');
  const client = new SSMClient(region ? { region } : {});
  const out = await client.send(
    new GetParameterCommand({ Name: parameterName, WithDecryption: true })
  );
  const value = out?.Parameter?.Value;
  if (!value) {
    throw new Error(
      `SSM parameter '${parameterName}' resolved to an empty value`
    );
  }
  return value;
}

const POSTGRES_CAPABILITIES = Object.freeze({
  supportsForeignKeys: true,
  supportsFullTextSearch: true,
  supportsRangeTypes: true,
  supportsArrayContainment: true,
  supportsPlannedCount: true,
  supportsRegex: true,
  supportsRowLevelSecurity: true,
  supportsRpc: true,
  supportsGinIndex: true,
});

/** @returns {import('./interface.mjs').DatabaseProvider} */
export function createPostgresProvider(config) {
  let pool = null;

  function _setPool(p) {
    pool = p;
  }

  async function getPool() {
    if (pool) return pool;

    if (config.connectionString) {
      pool = new Pool({
        connectionString: config.connectionString,
        max: 5,
        idleTimeoutMillis: 60000,
      });
    } else {
      // Prefer an explicit password; otherwise resolve it from SSM at
      // connect time when a parameter name is supplied.
      let password = config.password;
      if (!password && config.passwordSsmParam) {
        password = await resolveSsmPassword(
          config.passwordSsmParam,
          config.region
        );
      }

      pool = new Pool({
        host: config.host || 'localhost',
        port: config.port || 5432,
        user: config.user || 'postgres',
        password: password || '',
        database: config.database || 'postgres',
        ssl: resolveSsl(config.ssl),
        max: 5,
        idleTimeoutMillis: 60000,
      });
    }

    return pool;
  }

  async function close() {
    if (pool) {
      await pool.end().catch(() => {});
      pool = null;
    }
  }

  return { getPool, _setPool, close, capabilities: () => POSTGRES_CAPABILITIES };
}
