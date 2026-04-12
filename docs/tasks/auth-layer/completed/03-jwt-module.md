# Task 03: JWT Module

**Agent:** implementer
**Design:** docs/design/auth-layer.md

## Objective

Create `plugin/lambda-templates/auth/jwt.mjs` for BOA JWT
signing and verification, and add `jsonwebtoken` to
`plugin/lambda-templates/package.json`.

## Target Tests

From `__tests__/jwt.test.mjs`:
- signAccessToken produces JWT with sub, email,
  role=authenticated, aud=authenticated, iss=boa, ~1h expiry
- signRefreshToken embeds provider refresh token in prt claim
  with ~30d expiry
- verifyToken returns decoded payload for valid token
- verifyToken throws for expired token
- verifyToken throws for wrong secret
- verifyToken throws for wrong issuer
- verifyToken throws for malformed token

## Implementation

### auth/jwt.mjs

Create `plugin/lambda-templates/auth/jwt.mjs` as specified
in the design's "JWT Module" section:

```javascript
import jwt from 'jsonwebtoken';

const SECRET = process.env.JWT_SECRET;
const ISSUER = 'boa';

export function signAccessToken({ sub, email }) { ... }
export function signRefreshToken(sub, providerRefreshToken) { ... }
export function verifyToken(token) { ... }
```

- `signAccessToken` signs with claims: `sub`, `email`,
  `role: "authenticated"`, `aud: "authenticated"`.
  Expires in 1 hour. Issuer `boa`.
- `signRefreshToken` signs with claims: `sub`,
  `role: "authenticated"`, `prt: <provider refresh token>`.
  Expires in 30 days. Issuer `boa`.
- `verifyToken` verifies with `JWT_SECRET` and
  `issuer: "boa"`. Returns decoded payload or throws.

### package.json

Add `jsonwebtoken` to
`plugin/lambda-templates/package.json` dependencies:
```json
"jsonwebtoken": "^9.0.0"
```

Run `npm install` in `plugin/lambda-templates/` to update
the lock file if one exists.

## Acceptance Criteria

- All jwt.test.mjs tests pass.
- `jsonwebtoken` is listed in package.json dependencies.
- Existing tests still pass.

## Conflict Criteria

- If all target tests already pass before any code changes
  are made, investigate whether the tests are true positives
  before marking the task complete.
