# BOA Authentication Architecture — Supabase-Compatible, Provider-Swappable

## Execution via rring

This plan is executed through the rring harness. The prompt is already created at `docs/design/prompts/auth-layer.md`. Run these commands in order:

```bash
cd /Users/davcasd/research/boa

# 1. Generate design document from the prompt
rring design auth-layer

# 2. Break the design into implementation tasks
rring task auth-layer

# 3. Execute tasks via the implementer agent loop
rring work -n 15

# 4. Review the implementation
rring review auth-layer
```

The rring agent backend is Claude Code (configured in `.rring/agent`). No authorization/RLS in this plan — focus purely on authentication.

## Coordination

This plan runs in parallel with the PostgREST layer plan. They share one contract:

**Contract with PostgREST layer:** After auth is implemented, downstream Lambdas read:
```
event.requestContext.authorizer.userId   // string: user UUID or '' for anon
event.requestContext.authorizer.role     // 'anon' | 'authenticated' | 'service_role'
event.requestContext.authorizer.email    // string or ''
```

---

## Context

supabase-js apps must work against BOA by changing only the Project URL and Anon Key. This requires:
1. GoTrue-compatible auth endpoints (/auth/v1/signup, /auth/v1/token, etc.)
2. BOA-issued JWTs with `role` claim (Cognito JWTs lack this)
3. Anon key and service role key (long-lived JWTs)
4. Custom Lambda authorizer that validates BOA JWTs and passes role/userId to downstream
5. Swappable auth provider (Cognito default, Clerk/Auth0 possible)

## Architecture

```
supabase-js client: createClient(apiUrl, anonKey)
    │
    ├── Auth requests (/auth/v1/*) ──── NO authorizer ──── AuthFunction
    │     POST /auth/v1/signup                                │
    │     POST /auth/v1/token?grant_type=password             ├─▶ CognitoProvider (SDK calls)
    │     POST /auth/v1/token?grant_type=refresh_token        ├─▶ jwt.mjs (sign BOA JWTs)
    │     GET  /auth/v1/user                                  └─▶ GoTrue-format responses
    │     POST /auth/v1/logout
    │
    └── Data requests (/rest/v1/*) ──── BOA Authorizer ──── PostgREST Lambda
          apikey: <anon_key>              │                      │
          Authorization: Bearer <jwt>     ├─ Validates JWT       └─▶ DSQL
                                          ├─ Extracts role, userId
                                          └─ Returns IAM policy + context
```

## Why BOA Issues Its Own JWTs

Cognito JWTs lack `role` and `aud` claims. Supabase-js expects them. We also need anon keys (long-lived JWTs with role=anon). Solution: the auth Lambda authenticates against Cognito, then mints BOA JWTs with the right claim structure. When swapping to Clerk/Auth0, only the provider changes — JWT format stays identical.

## Module Structure

```
plugin/lambda-templates/
  auth/
    handler.mjs                      # GoTrue endpoint dispatcher (~100 lines)
    jwt.mjs                          # BOA JWT sign/verify + key generation (~80 lines)
    gotrue-response.mjs              # Format responses to GoTrue protocol (~60 lines)
    providers/
      interface.mjs                  # AuthProvider interface definition (~30 lines)
      cognito.mjs                    # CognitoProvider implementation (~200 lines)
  authorizer/
    index.mjs                        # Custom Lambda authorizer (~120 lines)

plugin/scripts/
    generate-keys.mjs               # JWT key generation, no external deps (~50 lines)
```

**7 new files, ~640 lines. One new npm dependency: `jsonwebtoken`.**

## Module Details

### `auth/jwt.mjs`
Signs and verifies BOA JWTs using JWT_SECRET from environment (stored in SSM Parameter Store).

- `signAccessToken({sub, email})` → 1-hour JWT with `{sub, email, role:"authenticated", aud:"authenticated", iss:"boa"}`
- `signRefreshToken(sub, providerRefreshToken)` → 30-day JWT embedding the Cognito refresh token in `prt` claim
- `verifyToken(token)` → decoded payload or throws
- `generateAnonKey(secret)` → 10-year JWT with `{role:"anon", iss:"boa"}`
- `generateServiceRoleKey(secret)` → 10-year JWT with `{role:"service_role", iss:"boa"}`

### `auth/providers/interface.mjs`
Defines the contract any auth provider must implement:
- `signUp(email, password, metadata?)` → AuthUser
- `signIn(email, password)` → {user, providerTokens}
- `refreshToken(providerRefreshToken)` → {user, providerTokens}
- `getUser(providerAccessToken)` → AuthUser
- `signOut(providerAccessToken)` → void

### `auth/providers/cognito.mjs`
Uses `@aws-sdk/client-cognito-identity-provider` (in Lambda runtime, no install needed):
- `signUp` → `SignUpCommand` (pre-signup Lambda auto-confirms)
- `signIn` → `InitiateAuthCommand` with `USER_PASSWORD_AUTH`
- `refreshToken` → `InitiateAuthCommand` with `REFRESH_TOKEN_AUTH`
- `getUser` → `GetUserCommand`
- `signOut` → returns void (BOA JWT expires naturally, no server-side revocation for MVP)

### `auth/gotrue-response.mjs`
Formats responses to match what supabase-js expects:
- Signup/signin: `{access_token, token_type:"bearer", expires_in:3600, refresh_token, user:{id, email, role, ...}}`
- Get user: `{id, email, role, app_metadata, user_metadata, ...}`
- Logout: HTTP 204
- Errors: `{error:"invalid_grant", error_description:"Invalid login credentials"}`

### `auth/handler.mjs`
Routes GoTrue endpoints to provider methods:

| Endpoint | Flow |
|----------|------|
| `POST /auth/v1/signup` | provider.signUp → provider.signIn → sign BOA tokens → GoTrue response |
| `POST /auth/v1/token?grant_type=password` | provider.signIn → sign BOA tokens → GoTrue response |
| `POST /auth/v1/token?grant_type=refresh_token` | verify BOA refresh JWT → extract provider token → provider.refreshToken → sign new BOA tokens |
| `GET /auth/v1/user` | verify BOA access JWT → return user from claims |
| `POST /auth/v1/logout` | return 204 (client clears tokens) |

Provider selection via `AUTH_PROVIDER` env var (default: `cognito`).

### `authorizer/index.mjs`
REQUEST-type Lambda authorizer. Handles both `apikey` and `Authorization` headers:

1. Verify `apikey` header JWT (must be valid anon or service_role key)
2. Verify `Authorization: Bearer <token>` JWT
3. Determine effective role from Authorization token:
   - `role: "service_role"` → service_role (bypass RLS)
   - `role: "authenticated"` with `sub` → authenticated user
   - `role: "anon"` → anon access
4. Return IAM Allow policy + context: `{role, userId, email}`
5. Cache result for 300 seconds (per Authorization header value)

### `scripts/generate-keys.mjs`
Pure Node.js (no external deps) — generates HS256 JWTs using `crypto` module. Called by bootstrap.sh to create anon key and service role key without requiring `jsonwebtoken` to be installed locally.

## SAM Template Changes (`backend.yaml`)

| Change | What |
|--------|------|
| **Replace** CognitoAuthorizer | With BoaAuthorizer (REQUEST-type Lambda authorizer) |
| **Add** AuthorizerFunction | New Lambda for JWT validation |
| **Add** AuthorizerPermission | Allow API Gateway to invoke authorizer |
| **Add** auth route | `/auth/v1/{proxy+}` with `Authorizer: NONE` (public) |
| **Modify** CORS | Add `apikey, Prefer, x-client-info` to allowed headers; add `PATCH`; expose `Content-Range` |
| **Add** env vars | `JWT_SECRET` (from SSM), `USER_POOL_CLIENT_ID`, `AUTH_PROVIDER` |

Auth endpoints (`/auth/v1/*`) have NO authorizer — they are public. Data endpoints (`/rest/v1/*`) use the BoaAuthorizer.

## Bootstrap Flow (Under 1 Minute)

```bash
./bootstrap.sh --stack-name my-app --region us-east-1
```

1. Check prerequisites (aws, sam, node, jq)
2. Verify AWS credentials
3. Generate JWT_SECRET (32 random bytes, base64)
4. Store JWT_SECRET in SSM Parameter Store (`/${stack}/jwt-secret`, SecureString)
5. `sam build && sam deploy` (creates DSQL, Cognito, auth Lambda, authorizer, PostgREST Lambda, API GW, S3)
6. Extract CloudFormation outputs
7. Generate anon key and service role key (via `generate-keys.mjs`)
8. Write `.boa/config.json` with apiUrl, anonKey, serviceRoleKey, poolIds, endpoints
9. Print: "Your backend is ready."

## Config Output (`.boa/config.json`)

```json
{
  "stackName": "my-app",
  "region": "us-east-1",
  "apiUrl": "https://xxx.execute-api.us-east-1.amazonaws.com/prod",
  "anonKey": "eyJhbGciOiJIUzI1NiIs...",
  "serviceRoleKey": "eyJhbGciOiJIUzI1NiIs...",
  "userPoolId": "us-east-1_xxxxx",
  "userPoolClientId": "xxxxxxxxx",
  "bucketName": "my-app-storage-123456",
  "dsqlEndpoint": "xxx.dsql.us-east-1.on.aws"
}
```

Developer usage:
```javascript
import { createClient } from '@supabase/supabase-js'
const supabase = createClient(config.apiUrl, config.anonKey)
```

## Auth Provider Swapping

To replace Cognito with Clerk/Auth0:
1. Create `auth/providers/clerk.mjs` implementing the same interface
2. Set `AUTH_PROVIDER=clerk` in SAM template
3. Add provider-specific env vars
4. Everything else stays the same — BOA JWTs, authorizer, PostgREST layer unchanged

## Implementation Order

| Step | File | Depends On |
|------|------|------------|
| 1 | `scripts/generate-keys.mjs` | Nothing |
| 2 | `auth/jwt.mjs` | Nothing |
| 3 | `auth/providers/interface.mjs` | Nothing |
| 4 | `auth/providers/cognito.mjs` | Step 3 |
| 5 | `auth/gotrue-response.mjs` | Nothing |
| 6 | `auth/handler.mjs` | Steps 2, 4, 5 |
| 7 | `authorizer/index.mjs` | Step 2 |
| 8 | `index.mjs` (rewrite) | Steps 6, 7 |
| 9 | `templates/backend.yaml` | Steps 6, 7, 8 |
| 10 | `scripts/bootstrap.sh` | Steps 1, 9 |
| 11 | `package.json` | Add jsonwebtoken |
| 12 | Update docs | All |

## Verification

1. `POST /auth/v1/signup` with `{email, password}` returns GoTrue response with access_token
2. `POST /auth/v1/token?grant_type=password` returns tokens for existing user
3. `POST /auth/v1/token?grant_type=refresh_token` returns new tokens
4. `GET /auth/v1/user` with Bearer token returns user object
5. Data request with anon key only → authorizer returns role=anon
6. Data request with user JWT → authorizer returns role=authenticated, userId set
7. Data request with service role key → authorizer returns role=service_role
8. supabase-js `createClient(apiUrl, anonKey)` + `auth.signUp()` + `from('table').select('*')` works end-to-end
9. JWT secret exists in SSM Parameter Store
10. Anon key and service role key are valid JWTs with correct role claims
