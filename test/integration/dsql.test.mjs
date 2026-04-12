// dsql.test.mjs — Integration tests against a real Aurora DSQL cluster.
//
// Creates a single-region DSQL cluster (takes ~2 seconds), runs the
// full test suite, then destroys the cluster.
//
// Requires AWS credentials with dsql:* permissions.
//
// Run:
//   TEST_DSQL_REGION=us-east-1 node --test test/integration/dsql.test.mjs
//
// Or use an existing cluster (skips create/destroy):
//   TEST_DSQL_ENDPOINT=id.dsql.us-east-1.on.aws node --test test/integration/dsql.test.mjs

import { describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import pg from 'pg';
import { createPgrest } from '../../src/index.mjs';
import {
  JWT_SECRET, SCHEMA_SQL, SEED_SQL, DROP_SQL, makeEvent, sharedTests,
} from './helpers.mjs';

const REGION = process.env.TEST_DSQL_REGION || process.env.REGION_NAME;
const EXISTING_ENDPOINT = process.env.TEST_DSQL_ENDPOINT;

function skip() {
  if (EXISTING_ENDPOINT) return false;
  return !REGION;
}

function exec(cmd) {
  return execSync(cmd, { encoding: 'utf-8', timeout: 30_000 }).trim();
}

async function connectDsql(endpoint, region) {
  const token = exec(
    `aws dsql generate-db-connect-admin-auth-token --hostname ${endpoint} --region ${region}`
  );
  return new pg.Pool({
    host: endpoint,
    port: 5432,
    user: 'admin',
    password: token,
    database: 'postgres',
    ssl: { rejectUnauthorized: false },
    max: 5,
    idleTimeoutMillis: 60000,
  });
}

// DSQL doesn't support multi-statement queries, so split on semicolons
async function execStatements(pool, sql) {
  const statements = sql
    .split(';')
    .map(s => s.trim())
    .filter(s => s.length > 0);
  for (const stmt of statements) {
    await pool.query(stmt);
  }
}

describe('dsql integration', { skip: skip(), timeout: 120_000 }, () => {
  let clusterId;
  let endpoint;
  let region;
  let pool;
  let pgrest;
  let createdCluster = false;

  before(async () => {
    if (EXISTING_ENDPOINT) {
      endpoint = EXISTING_ENDPOINT;
      region = REGION || EXISTING_ENDPOINT.split('.dsql.')[1]?.split('.on.aws')[0];
      console.log(`Using existing DSQL cluster: ${endpoint}`);
    } else {
      // Create cluster — single-region, no deletion protection, instant
      console.log(`Creating DSQL cluster in ${REGION}...`);
      const result = JSON.parse(exec(
        `aws dsql create-cluster --no-deletion-protection-enabled --region ${REGION} --output json`
      ));
      clusterId = result.identifier;
      endpoint = `${clusterId}.dsql.${REGION}.on.aws`;
      region = REGION;
      createdCluster = true;
      console.log(`Cluster created: ${endpoint}`);
    }

    // Wait for the cluster to accept connections
    console.log('Waiting for cluster to accept connections...');
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        pool = await connectDsql(endpoint, region);
        await pool.query('SELECT 1');
        console.log('Connected to DSQL');
        break;
      } catch {
        if (pool) { await pool.end().catch(() => {}); pool = null; }
        if (attempt === 29) throw new Error('DSQL cluster not ready after 30 attempts');
        await new Promise(r => setTimeout(r, 2000));
      }
    }

    await execStatements(pool, SCHEMA_SQL);
    console.log('Schema created');

    pgrest = createPgrest({
      database: { dsqlEndpoint: endpoint, region },
      jwtSecret: JWT_SECRET,
      auth: false,
    });
  });

  beforeEach(async () => {
    await execStatements(pool, SEED_SQL);
    await pgrest.rest(makeEvent({ method: 'POST', path: '/rest/v1/_refresh' }));
  });

  after(async () => {
    if (pool) {
      try { await execStatements(pool, DROP_SQL); } catch { /* best effort */ }
      await pool.end();
    }

    if (createdCluster && clusterId) {
      console.log(`Deleting DSQL cluster ${clusterId}...`);
      try {
        exec(`aws dsql delete-cluster --identifier ${clusterId} --region ${region}`);
        console.log('Cluster deletion initiated');
      } catch (err) {
        console.error(`Failed to delete cluster: ${err.message}`);
        console.error(`Manual cleanup: aws dsql delete-cluster --identifier ${clusterId} --region ${region}`);
      }
    }
  });

  // Shared tests — same suite as PostgreSQL
  sharedTests(() => pgrest, () => pool);
});
