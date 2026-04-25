# Tests

Three test tiers, each with a clear trigger. Use the fastest one that
covers your change.

| Command | Tier | What it covers | Wall time | Needs |
|---|---|---|---|---|
| `npm test` | Unit | Contract tests, mocked provider/DB. Fastest. | ~2s | Node only |
| `npm run test:integration` | Integration | Real Postgres + real better-auth. Catches DB-schema, better-auth wiring, and error-code bugs. | ~15s | Docker |
| `npm run test:e2e` | E2E | Real `@supabase/supabase-js` client against a locally-bound dev server. Proves wire compatibility. | ~10s | Docker |
| `npm run test:all` | All three | CI / pre-release. | ~30s | Docker |

## When to run what

**Write new code → `npm test`.** Iterating on handler logic, error
mapping, or shared utilities. If these fail, fix them before anything
else runs.

**Touch the better-auth provider, the auth handler, or SQL schema →
`npm run test:integration`.** Mocks won't catch bugs in how we call
better-auth or in the DDL we ship. Integration tests hit a real
Postgres container and the real better-auth library.

**Change the wire format, add a supabase-js feature, or bump
supabase-js → `npm run test:e2e`.** Only the e2e tier runs real client
code against real responses.

**Before a release, after a dependency bump, or in CI →
`npm run test:all`.** Runs all three tiers in order. Unit fails fast;
integration catches real-DB bugs; e2e proves external client
compatibility.

## Bumping the better-auth version

This is the workflow the harness was built for:

```bash
# 1. Update the version
npm i better-auth@<new-version>

# 2. Run the full matrix
npm run test:all
```

If `npm test` passes but `npm run test:integration` fails, better-auth
changed its API in a way our mocks didn't detect. Fix the provider,
rerun integration. If integration passes but e2e fails, the response
shape changed — check against `@supabase/supabase-js` expectations.

## Directory layout

```
tests/
├── docker-compose.yml            Postgres 16-alpine, port 54329
├── harness/
│   ├── db.mjs                    startPostgres(), resetDatabase(), stopPostgres()
│   ├── keys.mjs                  mintApikey(), mintAnonAndService()
│   ├── pgrest.mjs                createTestPgrest(), event() builder
│   └── server.mjs                startDevServer() for e2e
├── fixtures/
│   └── public-schema.sql         test tables (notes)
│                                 (better_auth DDL lives in
│                                 src/auth/migrations/ and is applied
│                                 via the library's ensureBetterAuthSchema)
├── integration/
│   ├── auth-flows.test.mjs       signup, signin, refresh, user, logout, JWKS
│   └── rest-with-auth.test.mjs   REST insert/select gated by authorizer context
└── e2e/
    └── supabase-js.test.mjs      real supabase-js client against the dev server
```

## How the harness works

### Docker lifecycle

`startPostgres()` runs `docker compose up -d postgres`, waits for the
health check to pass, and returns connection info. If the container is
already running (from a prior test file), it reuses it. `stopPostgres()`
runs `docker compose down -v` and wipes the tmpfs volume.

The container uses a tmpfs data dir so state is ephemeral between
invocations. The default port is **54329** — chosen to avoid colliding
with a developer's local Postgres on 5432.

### Schema reset

`resetDatabase(pool)` drops and recreates both the `better_auth` and
`public` schemas, then re-applies the DDL from `fixtures/`. Run it in a
`beforeEach` so each test gets a clean slate.

### The pgrest factory

`createTestPgrest({ baseUrl })` returns:

- `handler` — the combined Lambda handler (auth + REST routing)
- `anon`, `service` — apikey JWTs signed with a random per-test secret
- `destroy` — call in `afterEach` to close pools and avoid async leaks

The `event(...)` builder constructs API Gateway v1 Lambda events so
tests can invoke the handler directly.

### The dev server

`startDevServer(handler)` binds an ephemeral HTTP port, translates
incoming requests into Lambda events, and decodes the Bearer JWT
locally to populate `requestContext.authorizer` (mimicking the real
Lambda authorizer). Use it only from e2e tests.

## Common pitfalls

**Concurrency.** Integration and e2e tests share a Postgres container.
Run them with `--test-concurrency=1` (the npm scripts already do this).

**Stale containers.** If a test run crashes mid-way, `docker ps -a |
grep tests-postgres` may show a leftover. Run `docker compose -f
tests/docker-compose.yml down -v` to clean up.

**Port conflict.** If another process is using port 54329, override
with `PGREST_TEST_PG_PORT=<port> npm run test:integration`.

**Docker isn't running.** The harness will fail with a clear message.
Start Docker Desktop (or your equivalent) and retry. Docker is
assumed to be installed — we do not auto-install.
