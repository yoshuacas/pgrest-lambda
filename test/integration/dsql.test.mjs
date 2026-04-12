// dsql.test.mjs — Integration tests against a real Aurora DSQL cluster.
//
// This test creates a DSQL cluster, runs the full test suite, then destroys it.
// Requires AWS credentials with dsql:* permissions.
//
// Run:
//   TEST_DSQL_REGION=us-east-1 node --test test/integration/dsql.test.mjs
//
// The cluster takes 1-3 minutes to create and ~1 minute to delete.
// Total runtime: ~5-10 minutes.

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import pg from 'pg';
import { createPgrest } from '../../src/index.mjs';
import {
  JWT_SECRET, SCHEMA_SQL, SEED_SQL, DROP_SQL, makeEvent, sharedTests,
} from './helpers.mjs';

const REGION = process.env.TEST_DSQL_REGION || process.env.REGION_NAME;
// Allow using a pre-existing cluster to skip create/destroy
const EXISTING_ENDPOINT = process.env.TEST_DSQL_ENDPOINT;

function skip() {
  if (EXISTING_ENDPOINT) return false;
  return !REGION;
}

function exec(cmd) {
  return execSync(cmd, { encoding: 'utf-8', timeout: 300_000 }).trim();
}

describe('dsql integration', { skip: skip(), timeout: 600_000 }, () => {
  let clusterId;
  let endpoint;
  let pool;
  let pgrest;
  let createdCluster = false;

  before(async () => {
    if (EXISTING_ENDPOINT) {
      endpoint = EXISTING_ENDPOINT;
      console.log(`Using existing DSQL cluster: ${endpoint}`);
    } else {
      // Create a DSQL cluster
      console.log(`Creating DSQL cluster in ${REGION}...`);
      const result = JSON.parse(exec(
        `aws dsql create-cluster --deletion-protection-enabled false --region ${REGION} --output json`
      ));
      clusterId = result.identifier;
      endpoint = result.endpoint;
      createdCluster = true;
      console.log(`Cluster ${clusterId} creating, endpoint: ${endpoint}`);

      // Wait for cluster to become ACTIVE
      console.log('Waiting for cluster to become ACTIVE...');
      for (let i = 0; i < 60; i++) {
        const status = JSON.parse(exec(
          `aws dsql get-cluster --identifier ${clusterId} --region ${REGION} --output json`
        )).status;
        if (status === 'ACTIVE') {
          console.log('Cluster is ACTIVE');
          break;
        }
        if (status === 'FAILED') {
          throw new Error('Cluster creation failed');
        }
        await new Promise(r => setTimeout(r, 5000));
      }
    }

    // Generate IAM auth token and connect
    const token = exec(
      `aws dsql generate-db-connect-admin-auth-token --hostname ${endpoint} --region ${REGION}`
    );

    pool = new pg.Pool({
      host: endpoint,
      port: 5432,
      user: 'admin',
      password: token,
      database: 'postgres',
      ssl: { rejectUnauthorized: false },
      max: 5,
      idleTimeoutMillis: 60000,
    });

    // Verify connection
    const r = await pool.query('SELECT 1 as ok');
    assert.equal(r.rows[0].ok, 1, 'DSQL connection should work');
    console.log('Connected to DSQL');

    // Create schema
    // DSQL doesn't support multi-statement queries in a single call,
    // so split and execute individually
    const statements = SCHEMA_SQL
      .split(';')
      .map(s => s.trim())
      .filter(s => s.length > 0);
    for (const stmt of statements) {
      await pool.query(stmt);
    }
    console.log('Schema created');

    pgrest = createPgrest({
      database: { dsqlEndpoint: endpoint, region: REGION },
      jwtSecret: JWT_SECRET,
      auth: false,
    });
  });

  beforeEach(async () => {
    // Re-seed data before each test
    const statements = SEED_SQL
      .split(';')
      .map(s => s.trim())
      .filter(s => s.length > 0);
    for (const stmt of statements) {
      await pool.query(stmt);
    }
    await pgrest.rest(makeEvent({ method: 'POST', path: '/rest/v1/_refresh' }));
  });

  after(async () => {
    // Drop tables
    if (pool) {
      try {
        const statements = DROP_SQL
          .split(';')
          .map(s => s.trim())
          .filter(s => s.length > 0);
        for (const stmt of statements) {
          await pool.query(stmt);
        }
      } catch { /* best effort */ }
      await pool.end();
    }

    // Destroy cluster if we created it
    if (createdCluster && clusterId) {
      console.log(`Deleting DSQL cluster ${clusterId}...`);
      try {
        exec(
          `aws dsql delete-cluster --identifier ${clusterId} --region ${REGION}`
        );
        console.log('Cluster deletion initiated');
      } catch (err) {
        console.error(`Failed to delete cluster ${clusterId}: ${err.message}`);
        console.error(`Manual cleanup: aws dsql delete-cluster --identifier ${clusterId} --region ${REGION}`);
      }
    }
  });

  // Run shared test suite
  sharedTests(() => pgrest, () => pool);

  // DSQL-specific tests
  describe('DSQL-specific', () => {
    it('connects via IAM auth (no password in config)', async () => {
      // The fact that we got here means IAM auth works.
      // Verify the pgrest instance was created with dsqlEndpoint config.
      const res = await pgrest.rest(makeEvent({ path: '/rest/v1/' }));
      assert.equal(res.statusCode, 200);
    });
  });
});
