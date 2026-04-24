# V-03 — Configurable CORS Origin

Make CORS origin configurable and refuse wildcard in production
to close security finding V-03 (High).

Reference: `docs/security/findings/V-03-cors-wildcard.md`
Source: `docs/design/prompts/security-v03-cors-origin.md`

## Overview

`src/shared/cors.mjs` exports a static `CORS_HEADERS` object
with `Access-Control-Allow-Origin: '*'`. Every response in the
REST and auth handlers inherits this wildcard. Because
pgrest-lambda authenticates via headers (`Authorization`,
`apikey`), any site can replay a stolen Bearer token
cross-origin, and any site can call anon-scope endpoints with
the public anon key.

The fix introduces a `cors` config slice on `createPgrest`,
builds CORS headers per-request from that config, and refuses
wildcard origins when the deployment declares itself production.
Unconfigured deployments keep wildcard, preserving the
quick-start experience.

## Current CX / Concepts

### Static Wildcard

`src/shared/cors.mjs:1-10` defines a module-level constant:

```javascript
export const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'Accept, Authorization, Content-Type, Prefer, apikey, X-Client-Info',
  'Access-Control-Allow-Methods':
    'GET,POST,PUT,PATCH,DELETE,OPTIONS',
  'Access-Control-Expose-Headers': 'Content-Range',
  'Cache-Control': 'no-store',
  'Content-Type': 'application/json',
};
```

### Consumers

Four modules import `CORS_HEADERS`:

| Consumer | How it uses CORS_HEADERS |
|---|---|
| `src/rest/response.mjs:4` | Static import; spreads into every `success()` and `error()` response |
| `src/auth/gotrue-response.mjs:1` | Static import; spreads via internal `corsHeaders()` helper into every auth response |
| `src/auth/handler.mjs:59` | Dynamic `await import()` for OPTIONS preflight only |
| `src/rest/handler.mjs` | Indirect — calls `success()` / `error()` from response.mjs |

`src/rest/openapi.mjs` does not set CORS headers separately.

### No Config Path

`src/index.mjs` `resolveConfig` has no `cors` field.
`createPgrest(config)` has no way to narrow the origin
allowlist without forking the module.

## Proposed CX / CX Specification

### Config Shape

```javascript
createPgrest({
  cors: {
    allowedOrigins: '*' | string[] | (origin) => boolean,
    allowCredentials: false,
  },
  production: false,
});
```

### Config Resolution

In `resolveConfig`:

```
cors.allowedOrigins:
  config.cors.allowedOrigins  ??  '*'

cors.allowCredentials:
  config.cors.allowCredentials  ??  false

production:
  config.production  ??  (process.env.NODE_ENV === 'production')
```

The `config` value wins over the env var for `production`.
If neither is set, `production` defaults to `false`.

### Per-Request Behavior

Given a resolved `corsConfig` and the inbound `Origin` header:

1. **Wildcard** (`allowedOrigins === '*'`): Set
   `Access-Control-Allow-Origin: *`. Do not set `Vary`.
   (In production mode this branch is unreachable because
   construction throws.)

2. **Array** (`Array.isArray(allowedOrigins)`): If the
   `Origin` value matches a literal entry in the array, set
   `Access-Control-Allow-Origin` to that exact origin. If it
   does not match (or the array is empty), omit the
   `Access-Control-Allow-Origin` header entirely. Set
   `Vary: Origin` in both cases.

3. **Function** (`typeof allowedOrigins === 'function'`):
   Call `allowedOrigins(origin)`. If it returns `true`, set
   `Access-Control-Allow-Origin` to the origin value. If
   `false`, omit the header. Set `Vary: Origin` in both
   cases.

4. **Credentials**: Set
   `Access-Control-Allow-Credentials: true` only when
   `allowCredentials === true` AND the resolved allow-origin
   value is not `'*'`. The Fetch spec requires browsers to
   block the entire response when `Access-Control-Allow-
   Credentials: true` is combined with a wildcard origin in
   credentialed requests. When `allowCredentials` is true
   but `allowedOrigins` is `'*'`, the credentials header is
   silently omitted (the wildcard branch returns before
   checking `allowCredentials`) and the wildcard origin is
   still emitted.

5. **Preserved headers**: `Access-Control-Allow-Headers`,
   `Access-Control-Allow-Methods`,
   `Access-Control-Expose-Headers` keep their current
   values. `Cache-Control` and `Content-Type` are unchanged.
   This fix is about origin, not headers/methods.

### Production Guardrail

When `production === true` and `allowedOrigins === '*'`,
throw at factory construction (`createPgrest`) with:

```
pgrest-lambda: CORS allowedOrigins='*' is not allowed when
production mode is enabled. Provide an explicit list of
origins in config.cors.allowedOrigins.
```

Error class: plain `Error`. Prefix: `pgrest-lambda:`.
Consistent with the V-01 `assertJwtSecret` error style.

### Validation Rules

| Condition | Result |
|---|---|
| `config.cors` absent | `allowedOrigins = '*'`, `allowCredentials = false` |
| `allowedOrigins` is `'*'` and `production` is `false` | Allowed (dev default) |
| `allowedOrigins` is `'*'` and `production` is `true` | Throws at construction |
| `allowedOrigins` is `[]` | Allowed; every origin is rejected at request time |
| `allowedOrigins` is a function | Allowed; called per-request with the origin string |
| `allowCredentials` is `true` and `allowedOrigins` is `'*'` | Allowed at construction; credentials header silently omitted at request time |

### Default Behavior

If `config.cors` is absent, every response gets
`Access-Control-Allow-Origin: *` with no `Vary` header. This
is identical to the current behavior. Existing deployments
without a `cors` config see zero change.

## Technical Design

### `src/shared/cors.mjs` — `buildCorsHeaders(corsConfig, origin)`

Replace the single static export with a per-request helper.
Keep the static `CORS_HEADERS` export alive as a backward-
compatibility snapshot for any external consumer.

```javascript
export const CORS_HEADERS = { /* unchanged static default */ };

const STATIC_HEADERS = {
  'Access-Control-Allow-Headers':
    'Accept, Authorization, Content-Type, Prefer, '
    + 'apikey, X-Client-Info',
  'Access-Control-Allow-Methods':
    'GET,POST,PUT,PATCH,DELETE,OPTIONS',
  'Access-Control-Expose-Headers': 'Content-Range',
  'Cache-Control': 'no-store',
  'Content-Type': 'application/json',
};

export function buildCorsHeaders(corsConfig, origin) {
  const { allowedOrigins, allowCredentials } = corsConfig;
  const headers = { ...STATIC_HEADERS };

  if (allowedOrigins === '*') {
    headers['Access-Control-Allow-Origin'] = '*';
    return headers;
  }

  headers['Vary'] = 'Origin';

  let allowed = false;
  if (Array.isArray(allowedOrigins)) {
    allowed = allowedOrigins.includes(origin);
  } else if (typeof allowedOrigins === 'function') {
    allowed = allowedOrigins(origin);
  }

  if (allowed && origin) {
    headers['Access-Control-Allow-Origin'] = origin;
    if (allowCredentials) {
      headers['Access-Control-Allow-Credentials'] = 'true';
    }
  }

  return headers;
}
```

Key details:
- When `allowedOrigins` is `'*'`, the `Vary` header is not
  set (the response does not depend on the request origin).
- When `allowedOrigins` is an array or function, `Vary:
  Origin` is always set, even when the origin is rejected.
  This is required for correct HTTP cache behavior.
- `Access-Control-Allow-Credentials` is only emitted when
  both `allowCredentials` is `true` and the resolved origin
  is an explicit value (not `'*'`).
- If the origin is an empty string or absent, and
  `allowedOrigins` is an array or function, the
  `Access-Control-Allow-Origin` header is omitted (same-
  origin requests don't send an `Origin` header; CORS does
  not apply).
- The literal string `"null"` is a valid `Origin` value
  sent by browsers for sandboxed iframes, `data:` URLs,
  and local files. If `allowedOrigins` is an array, it
  matches only if the array contains the literal `"null"`.
  If `allowedOrigins` is a function, it receives `"null"`
  as-is. Operators should not add `"null"` to the
  allowlist unless they understand the security
  implications (any sandboxed context would match).

### `src/shared/cors.mjs` — `assertCorsConfig(corsConfig, production)`

Factory-level validation. Called from `createPgrest` after
`resolveConfig`.

```javascript
export function assertCorsConfig(corsConfig, production) {
  if (production && corsConfig.allowedOrigins === '*') {
    throw new Error(
      'pgrest-lambda: CORS allowedOrigins=\'*\' is not '
      + 'allowed when production mode is enabled. Provide '
      + 'an explicit list of origins in '
      + 'config.cors.allowedOrigins.'
    );
  }
}
```

### `src/index.mjs` — Config Resolution

Add `cors` and `production` to `resolveConfig`:

```javascript
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
  // ... existing fields ...
  const cors = resolveCors(config);
  const production = config.production
    ?? (process.env.NODE_ENV === 'production');
  return { /* ...existing... */ cors, production };
}
```

In `createPgrest`, after `resolveConfig` and
`assertJwtSecret`:

```javascript
import {
  buildCorsHeaders, assertCorsConfig,
} from './shared/cors.mjs';

export function createPgrest(config = {}) {
  const resolved = resolveConfig(config);
  assertJwtSecret(resolved.jwtSecret);
  assertCorsConfig(resolved.cors, resolved.production);

  // ... existing subsystem creation ...

  ctx.cors = resolved.cors;
  // ... rest unchanged ...
}
```

### `src/rest/response.mjs` — Accept CORS Headers

Change `success` and `error` to accept a `corsHeaders`
parameter. When absent, fall back to the static
`CORS_HEADERS` for backward compatibility with any external
consumer calling these functions directly.

```javascript
import { CORS_HEADERS } from '../shared/cors.mjs';

export function success(
  statusCode, body, options = {},
) {
  const cors = options.corsHeaders || CORS_HEADERS;
  // ... replace every ...CORS_HEADERS spread with ...cors
}

export function error(err, corsHeaders) {
  const cors = corsHeaders || CORS_HEADERS;
  // ... replace every ...CORS_HEADERS spread with ...cors
}
```

### `src/rest/handler.mjs` — Compute CORS Per-Request

In `createRestHandler`, read `ctx.cors`. In `handler(event)`,
compute CORS headers once at the top and pass them to
`success` and `error`:

```javascript
import { buildCorsHeaders } from '../shared/cors.mjs';

export function createRestHandler(ctx, contributions = []) {
  const { db, schemaCache, cedar, docs } = ctx;
  const corsConfig = ctx.cors;

  async function handler(event) {
    const headers = lowercaseHeaders(event.headers);
    const origin = headers['origin'] || '';
    const corsHeaders = buildCorsHeaders(corsConfig, origin);

    try {
      if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers: corsHeaders };
      }
      // ... existing logic unchanged ...

      // Pass corsHeaders via options:
      return success(200, rows, {
        contentRange, singleObject, corsHeaders,
      });
    } catch (err) {
      // Pass corsHeaders to error():
      return error(err, corsHeaders);
    }
  }
}
```

When `corsConfig` is `undefined` (standalone use of
`createRestHandler` without `createPgrest`),
`buildCorsHeaders` receives `undefined` and should fall back
to wildcard behavior. Handle this at the top of
`buildCorsHeaders`:

```javascript
export function buildCorsHeaders(corsConfig, origin) {
  if (!corsConfig) {
    return { ...CORS_HEADERS };
  }
  // ... rest as above
}
```

### `src/auth/gotrue-response.mjs` — Accept CORS Headers

Change the internal `corsHeaders()` function and all exported
response functions to accept a `corsHeaders` parameter:

```javascript
import { CORS_HEADERS } from '../shared/cors.mjs';

export function sessionResponse(
  accessToken, refreshToken, user, corsHeaders,
) {
  return {
    statusCode: 200,
    headers: resolveCors(corsHeaders),
    body: JSON.stringify({ /* ... */ }),
  };
}

// Same for userResponse(user, corsHeaders),
// logoutResponse(corsHeaders),
// errorResponse(statusCode, error, description, extra, corsHeaders)

function resolveCors(corsHeaders) {
  return corsHeaders
    ? { ...corsHeaders }
    : { ...CORS_HEADERS };
}
```

### `src/auth/handler.mjs` — Compute CORS Per-Request

In `createAuthHandler`, read `ctx.cors`. In `handler(event)`,
compute CORS headers and pass to response functions:

```javascript
import { buildCorsHeaders } from '../shared/cors.mjs';

export function createAuthHandler(config, ctx) {
  const jwt = ctx.jwt;
  const corsConfig = ctx.cors;

  async function handler(event) {
    const method = event.httpMethod;
    const origin =
      (event.headers?.Origin
        || event.headers?.origin
        || '');
    const corsHeaders =
      buildCorsHeaders(corsConfig, origin);

    if (method === 'OPTIONS') {
      return { statusCode: 200, headers: corsHeaders };
    }

    const path = event.path || '';
    const match = path.match(/^\/auth\/v1\/(\w+)$/);
    if (!match) {
      return errorResponse(
        404, 'not_found', 'Endpoint not found',
        undefined, corsHeaders,
      );
    }

    const action = match[1];
    switch (action) {
      case 'signup':
        return handleSignup(event, corsHeaders);
      // ... same for token, user, logout
      default:
        return errorResponse(
          404, 'not_found', 'Endpoint not found',
          undefined, corsHeaders,
        );
    }
  }
}
```

The OPTIONS branch replaces the current dynamic
`await import('../shared/cors.mjs')` with the already-
resolved `corsHeaders`.

The internal `providerErrorResponse(err)` helper (defined
inside `createAuthHandler`) calls `errorResponse()` without
forwarding CORS headers. It must be updated to accept and
pass `corsHeaders`:

```javascript
function providerErrorResponse(err, corsHeaders) {
  const code = err.code || 'unexpected_failure';
  const status = ERROR_STATUS[code] || 500;
  const desc = ERROR_DESCRIPTION[code] || '...';
  const extra = code === 'weak_password' && err.reasons
    ? { weak_password: { reasons: err.reasons } }
    : undefined;
  return errorResponse(status, code, desc, extra, corsHeaders);
}
```

The `handle*` functions (`handleSignup`, `handleToken`,
`handlePasswordGrant`, `handleRefreshGrant`, `handleGetUser`,
`handleLogout`) are sibling functions to `handler()` inside
`createAuthHandler` -- they do NOT have closure access to
`handler`'s local `corsHeaders`. Each must accept
`corsHeaders` as a second parameter (after `event`) and
forward it to every `sessionResponse`, `userResponse`,
`logoutResponse`, `errorResponse`, and
`providerErrorResponse` call within.

## Code Architecture / File Changes

### Modified Files

| File | Change |
|---|---|
| `src/shared/cors.mjs` | Add `buildCorsHeaders`, `assertCorsConfig`; keep `CORS_HEADERS` static export |
| `src/index.mjs` | Add `resolveCors`; add `cors` + `production` to resolved config; call `assertCorsConfig`; set `ctx.cors` |
| `src/rest/response.mjs` | `success` accepts `options.corsHeaders`; `error` accepts `corsHeaders` param; fall back to static default |
| `src/rest/handler.mjs` | Read `ctx.cors`; compute `buildCorsHeaders` per-request; pass to `success`/`error` |
| `src/auth/gotrue-response.mjs` | All exported functions accept `corsHeaders` param; fall back to static default |
| `src/auth/handler.mjs` | Read `ctx.cors`; compute `buildCorsHeaders` per-request; pass to response functions; update `providerErrorResponse` to forward `corsHeaders`; remove dynamic import for OPTIONS |
| `README.md` | Document `config.cors`, `config.production`, security note |
| `CHANGELOG.md` | Security entry under Unreleased |
| `docs/security/findings/V-03-cors-wildcard.md` | Status -> Fixed; fill Decision, Evidence, Residual risk, Reviewer handoff |
| `docs/security/assessment.md` | V-03 status Open -> Fixed |

### New Files

| File | Purpose | ~Lines |
|---|---|---|
| `src/shared/__tests__/cors.test.mjs` | Unit tests for `buildCorsHeaders` and `assertCorsConfig` | ~120 |

### Files That Do NOT Change

- `src/auth/jwt.mjs` — no change; CORS does not interact
  with JWT.
- `src/authorizer/index.mjs` — no change; the authorizer
  runs before the handler and does not set CORS headers.
- `src/rest/openapi.mjs` — does not set CORS headers; its
  responses flow through `success()` in response.mjs.

> Note: The `docs` route in `src/rest/handler.mjs` (the
> Scalar HTML page) returns a raw response object with
> `Content-Type: text/html` and no CORS headers — both
> before and after this change. This is acceptable because
> the docs page is loaded directly in the browser, not
> fetched cross-origin. If a future change requires
> cross-origin access to the docs route, CORS headers
> should be added at that time.
- `src/auth/providers/*` — no change; providers do not
  interact with response headers.
- `src/rest/db.mjs`, `src/rest/schema-cache.mjs`,
  `src/rest/sql-builder.mjs`, `src/rest/query-parser.mjs`,
  `src/rest/router.mjs`, `src/rest/errors.mjs` — no change.

## Testing Strategy

### Unit Tests: `src/shared/__tests__/cors.test.mjs`

All tests use `node:test` + `assert/strict`, matching project
convention.

#### `buildCorsHeaders` — Wildcard (default)

| Input | Expected |
|---|---|
| `corsConfig = { allowedOrigins: '*', allowCredentials: false }`, no origin | `Access-Control-Allow-Origin` is `'*'`; no `Vary` header |
| Same config, `origin = 'https://example.com'` | `Access-Control-Allow-Origin` is `'*'`; no `Vary` header |
| `corsConfig` is `undefined` | Returns static default headers (backward compat fallback) |

#### `buildCorsHeaders` — Array Allowlist

| Input | Expected |
|---|---|
| `allowedOrigins = ['https://app.example.com']`, `origin = 'https://app.example.com'` | `Access-Control-Allow-Origin` is `'https://app.example.com'`; `Vary` is `'Origin'` |
| Same config, `origin = 'https://evil.com'` | No `Access-Control-Allow-Origin` key in returned headers; `Vary` is `'Origin'` |
| `allowedOrigins = []`, any origin | No `Access-Control-Allow-Origin` key; `Vary` is `'Origin'` |
| `allowedOrigins = ['https://a.com', 'https://b.com']`, `origin = 'https://b.com'` | `Access-Control-Allow-Origin` is `'https://b.com'` |
| `allowedOrigins = ['https://a.com']`, `origin = 'null'` | No `Access-Control-Allow-Origin` key; `Vary` is `'Origin'` (literal `"null"` origin from sandboxed iframe is not in list) |

#### `buildCorsHeaders` — Function Allowlist

| Input | Expected |
|---|---|
| `allowedOrigins = (o) => o.endsWith('.example.com')`, `origin = 'https://app.example.com'` | `Access-Control-Allow-Origin` is `'https://app.example.com'`; `Vary` is `'Origin'` |
| Same function, `origin = 'https://evil.com'` | No `Access-Control-Allow-Origin` key; `Vary` is `'Origin'` |
| Function receives the raw origin string as its argument | Assert by capturing the argument in the test function |

#### `buildCorsHeaders` — Credentials

| Input | Expected |
|---|---|
| `allowCredentials = true`, `allowedOrigins = ['https://a.com']`, `origin = 'https://a.com'` | `Access-Control-Allow-Credentials` is `'true'`; `Access-Control-Allow-Origin` is `'https://a.com'` |
| `allowCredentials = true`, `allowedOrigins = '*'` | No `Access-Control-Allow-Credentials` key; `Access-Control-Allow-Origin` is `'*'` |
| `allowCredentials = false`, `allowedOrigins = ['https://a.com']`, `origin = 'https://a.com'` | No `Access-Control-Allow-Credentials` key |

#### `buildCorsHeaders` — Static Headers Preserved

| Assertion |
|---|
| Every result includes `Access-Control-Allow-Headers` with the existing value (`Accept, Authorization, Content-Type, Prefer, apikey, X-Client-Info`) |
| Every result includes `Access-Control-Allow-Methods` with `GET,POST,PUT,PATCH,DELETE,OPTIONS` |
| Every result includes `Access-Control-Expose-Headers` with `Content-Range` |

#### `assertCorsConfig` — Production Guardrail

| Input | Expected |
|---|---|
| `corsConfig = { allowedOrigins: '*' }`, `production = true` | Throws; message includes `'production'` and `'allowedOrigins'` |
| `corsConfig = { allowedOrigins: ['https://a.com'] }`, `production = true` | Does not throw |
| `corsConfig = { allowedOrigins: '*' }`, `production = false` | Does not throw |

> Warning: The "does not throw" assertions are trivially
> satisfiable. The implementing agent should verify that the
> function actually returns rather than simply not throwing a
> different error.

### Integration: `createPgrest` Production Guardrail

Add to existing test file or create a new one:

| Input | Expected |
|---|---|
| `createPgrest({ production: true, cors: { allowedOrigins: '*' }, jwtSecret: <valid> })` | Throws; message includes `'production'` and `'allowedOrigins'` |
| `createPgrest({ production: true, cors: { allowedOrigins: ['https://a.com'] }, jwtSecret: <valid>, database: { host: 'localhost' } })` | Constructs without error |
| `createPgrest({ production: false, cors: { allowedOrigins: '*' }, jwtSecret: <valid>, database: { host: 'localhost' } })` | Constructs without error |
| `process.env.NODE_ENV = 'production'` with no `config.production`, `allowedOrigins: '*'` | Throws same error |

> Warning: `createPgrest` needs valid `jwtSecret` (>= 32
> chars) and valid database config to avoid unrelated errors.
> Tests must provide these. The implementing agent should
> verify test isolation — the guardrail test should fail on
> the CORS error, not on JWT or database errors.

### Regression: CORS Headers on REST Responses

One spot-check test: call the REST handler with an OPTIONS
request and verify the returned headers include
`Access-Control-Allow-Origin`. Verify 4xx error responses
also include the header. This confirms the per-request
plumbing works end to end.

> Warning: This test exercises the full handler stack and
> needs a mock database pool and schema cache. The
> implementing agent should verify the test targets the CORS
> header path specifically, not the database interaction.

### Regression: CORS Headers on Auth Responses

One spot-check test: call the auth handler with an OPTIONS
request to `/auth/v1/signup` and verify the returned headers
include `Access-Control-Allow-Origin`. Verify an error
response (e.g., missing email on signup) also includes the
header.

### Existing Tests Must Still Pass

All existing tests must continue to pass. The backward-
compatibility fallback (`corsHeaders || CORS_HEADERS`) in
`response.mjs` and `gotrue-response.mjs` ensures tests that
construct handlers without `ctx.cors` still get wildcard
headers.

Verification: `npm test`

## Implementation Order

### Phase 1: CORS Helper + Unit Tests

1. Add `buildCorsHeaders` and `assertCorsConfig` to
   `src/shared/cors.mjs`. Keep the existing `CORS_HEADERS`
   export unchanged.
2. Create `src/shared/__tests__/cors.test.mjs` with all
   unit test cases for `buildCorsHeaders` and
   `assertCorsConfig`.
3. Verify: `node --test src/shared/__tests__/cors.test.mjs`

### Phase 2: Config Resolution + Guardrail

4. Add `resolveCors` to `src/index.mjs`; add `cors` and
   `production` to `resolveConfig` return value.
5. Import `assertCorsConfig` in `src/index.mjs`; call it
   in `createPgrest` after `assertJwtSecret`.
6. Set `ctx.cors = resolved.cors`.
7. Add `createPgrest` production guardrail tests.
8. Verify: `npm test`

### Phase 3: REST Handler Plumbing

9. Update `src/rest/response.mjs` — `success` accepts
   `options.corsHeaders`, `error` accepts `corsHeaders`
   param, both fall back to `CORS_HEADERS`.
10. Update `src/rest/handler.mjs` — read `ctx.cors`,
    compute `buildCorsHeaders` per-request, pass to
    `success`/`error`.
11. Add REST regression spot-check test.
12. Verify: `npm test`

### Phase 4: Auth Handler Plumbing

13. Update `src/auth/gotrue-response.mjs` — all functions
    accept `corsHeaders` param, fall back to `CORS_HEADERS`.
14. Update `src/auth/handler.mjs` — read `ctx.cors`,
    compute `buildCorsHeaders` per-request, pass to
    response functions. Update `providerErrorResponse` to
    accept and forward `corsHeaders`. Remove dynamic import
    for OPTIONS.
15. Add auth regression spot-check test.
16. Verify: `npm test`

### Phase 5: Documentation

17. Update `README.md` — document `config.cors`,
    `config.production`, security note about anon apikey.
18. Update `CHANGELOG.md` — Security entry under Unreleased.
19. Update `docs/security/findings/V-03-cors-wildcard.md` —
    Status, Decision, Evidence, Residual risk, Reviewer
    handoff.
20. Update `docs/security/assessment.md` — V-03 status to
    Fixed.

## Open Questions

None. The config shape, validation rules, per-request
behavior, and error messages are fully specified. The design
preserves backward compatibility for unconfigured deployments
and existing tests.

**Resolved during design:** `Cache-Control: no-store` and
`Content-Type: application/json` are included in the current
`CORS_HEADERS` object. These are not CORS headers, but they
have been bundled with the CORS headers since inception. The
new `buildCorsHeaders` preserves them in the `STATIC_HEADERS`
base to avoid changing response behavior. A future cleanup
could separate them, but that is out of scope for this
security fix.
