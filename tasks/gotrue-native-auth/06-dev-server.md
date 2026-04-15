# Task 06: Dev Server Auth Support

**Agent:** implementer
**Design:** docs/design/gotrue-native-auth.md
**Depends on:** Task 04 (provider wiring)

## Objective

Modify `dev.mjs` to enable auth by default and route auth
requests through the combined handler, so developers get
working GoTrue auth endpoints against their local PostgreSQL.

## Target Tests

No automated tests target this task directly. Verification
is manual (start dev server, test signup/signin against local
PostgreSQL). The dev server is not covered by `npm test`.

## Implementation

**Modified: `dev.mjs`**

### 1. Remove `auth: false`

Current (line 20):
```javascript
auth: false, // no Cognito in local dev
```

Remove this line. The `createPgrest` call becomes:
```javascript
const pgrest = createPgrest({
  database: {
    host: 'localhost',
    port: 5433,
    user: 'postgres',
    password: 'mySecurePassword123',
    database: 'postgres',
  },
  jwtSecret: JWT_SECRET,
  // auth defaults to { provider: 'gotrue' }
});
```

### 2. Route through combined handler

In the HTTP server request handler, change `pgrest.rest(event)`
to `pgrest.handler(event)` for non-docs paths. The combined
`handler` in `src/index.mjs` routes `/auth/v1/*` to auth and
everything else to REST.

Current (line 106):
```javascript
const result = await pgrest.rest(event);
```

Change to:
```javascript
const result = await pgrest.handler(event);
```

### 3. Print auth endpoints on startup

After the existing API key output, add:
```javascript
console.log('Auth endpoints:');
console.log(`  POST http://localhost:${PORT}/auth/v1/signup`);
console.log(`  POST http://localhost:${PORT}/auth/v1/token?grant_type=password`);
console.log(`  POST http://localhost:${PORT}/auth/v1/token?grant_type=refresh_token`);
console.log(`  GET  http://localhost:${PORT}/auth/v1/user`);
console.log(`  POST http://localhost:${PORT}/auth/v1/logout`);
```

## Acceptance Criteria

- `dev.mjs` no longer passes `auth: false`.
- Auth requests (`/auth/v1/*`) are routed to the auth handler.
- REST requests continue to work as before.
- Startup output includes auth endpoint listing.
- `node --check dev.mjs` succeeds (syntax valid).
- `npm test` still passes (dev server is not tested by
  the test suite).

## Conflict Criteria

- If `auth: false` is already removed from `dev.mjs`,
  investigate whether this task was already completed.
- If `dev.mjs` already routes through `pgrest.handler`,
  skip that change.
