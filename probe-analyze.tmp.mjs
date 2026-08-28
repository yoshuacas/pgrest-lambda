// Probe: does DSQL support ANALYZE, and does it fix the planner's row estimate?
// Temporary; delete after use.
import { DsqlSigner } from '@aws-sdk/dsql-signer';
import pg from 'pg';

const ENDPOINT = '6juamhyj5nkoeatkzc3ieaerc4.dsql.us-east-1.on.aws';
const REGION = 'us-east-1';

const signer = new DsqlSigner({ hostname: ENDPOINT, region: REGION });
const token = await signer.getDbConnectAdminAuthToken();
const client = new pg.Client({
  host: ENDPOINT,
  port: 5432,
  user: 'admin',
  password: token,
  database: 'postgres',
  ssl: { rejectUnauthorized: false },
});
await client.connect();

async function q(sql) {
  try {
    const r = await client.query(sql);
    return { ok: true, rows: r.rows };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { /* not in a tx */ }
    return { ok: false, code: e.code, message: e.message };
  }
}

const plan = async (label) => {
  const r = await q('EXPLAIN (FORMAT JSON) SELECT 1 FROM public.items');
  const rows = r.ok ? JSON.stringify(r.rows[0]).slice(0, 400) : JSON.stringify(r);
  console.log(label, rows);
};

console.log('count(*) items:', JSON.stringify((await q('SELECT count(*) FROM public.items')).rows));
await plan('plan before:');
console.log('reltuples:', JSON.stringify((await q(
  "SELECT relname, reltuples, relpages FROM pg_class WHERE relname IN ('items','client','projects','clients')")).rows));
console.log('ANALYZE items:', JSON.stringify(await q('ANALYZE public.items')));
console.log('ANALYZE (bare):', JSON.stringify(await q('ANALYZE')));
console.log('VACUUM ANALYZE:', JSON.stringify(await q('VACUUM ANALYZE public.items')));
await plan('plan after:');
console.log('pg_stats rows for items:', JSON.stringify((await q(
  "SELECT count(*) FROM pg_stats WHERE tablename = 'items'")).rows));
console.log('last_analyze:', JSON.stringify((await q(
  "SELECT relname, last_analyze, last_autoanalyze, n_live_tup FROM pg_stat_all_tables WHERE relname = 'items'")).rows));

await client.end();
