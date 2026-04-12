Implement Supabase-compatible authentication for the BOA backend.
The auth system must allow `@supabase/supabase-js` apps to authenticate
by changing only the Project URL and Anon Key.

Requirements:

1. GoTrue-compatible auth endpoints on the existing Lambda:
   - POST /auth/v1/signup — email/password signup, returns access_token + refresh_token + user
   - POST /auth/v1/token?grant_type=password — email/password sign-in
   - POST /auth/v1/token?grant_type=refresh_token — refresh session
   - GET /auth/v1/user — get current user from Bearer token
   - POST /auth/v1/logout — sign out (client-side, return 204)

2. BOA-issued JWTs (not Cognito tokens directly):
   - Cognito JWTs lack `role` and `aud` claims that supabase-js expects
   - Auth Lambda authenticates against Cognito, then mints BOA JWTs
   - Access token (1h): {sub, email, role:"authenticated", aud:"authenticated", iss:"boa"}
   - Refresh token (30d): embeds Cognito refresh token in `prt` claim
   - Uses HS256 with a JWT_SECRET stored in SSM Parameter Store

3. Anon key and service role key:
   - Anon key: long-lived JWT (10yr) with {role:"anon", iss:"boa"}
   - Service role key: long-lived JWT (10yr) with {role:"service_role", iss:"boa"}
   - Generated at bootstrap time by scripts/generate-keys.mjs (pure Node.js crypto, no deps)

4. Custom Lambda authorizer (replaces CognitoAuthorizer):
   - REQUEST-type authorizer, validates BOA JWTs
   - Accepts apikey header (anon key) and Authorization: Bearer header
   - Passes {role, userId, email} to downstream Lambda via authorizer context:
     event.requestContext.authorizer.role     // 'anon' | 'authenticated' | 'service_role'
     event.requestContext.authorizer.userId   // string: user UUID or '' for anon
     event.requestContext.authorizer.email    // string or ''
   - Cached for 300 seconds per Authorization header

5. Auth provider abstraction (swappable):
   - Interface: signUp, signIn, refreshToken, getUser, signOut
   - Default: CognitoProvider using @aws-sdk/client-cognito-identity-provider (in Lambda runtime)
   - Future: ClerkProvider, Auth0Provider (not implemented now, just the interface)

6. Bootstrap creates everything in one command:
   - sam deploy creates DSQL, Cognito pool (self-signup), Lambda, authorizer, API Gateway, S3
   - Bootstrap script generates JWT_SECRET, stores in SSM, generates anon/service keys
   - Writes .boa/config.json with apiUrl, anonKey, serviceRoleKey
   - Developer uses: createClient(config.apiUrl, config.anonKey)

7. SAM template changes to plugin/templates/backend.yaml:
   - Replace CognitoAuthorizer with BoaAuthorizer (REQUEST-type Lambda authorizer)
   - Add AuthorizerFunction Lambda (validates BOA JWTs, env: JWT_SECRET from SSM)
   - Add /auth/v1/{proxy+} route with Authorizer: NONE (public endpoints)
   - Add env vars to ApiFunction: JWT_SECRET, USER_POOL_CLIENT_ID, AUTH_PROVIDER
   - Update CORS: add apikey, Prefer, x-client-info to allowed headers; add PATCH method

8. No authorization/RLS in this plan. Authorization design comes later.
   The authorizer passes role and userId but no downstream filtering logic changes.

New files to create:
  plugin/lambda-templates/auth/handler.mjs           — GoTrue endpoint dispatcher (~100 lines)
  plugin/lambda-templates/auth/jwt.mjs               — BOA JWT sign/verify (~80 lines)
  plugin/lambda-templates/auth/gotrue-response.mjs   — GoTrue response formatting (~60 lines)
  plugin/lambda-templates/auth/providers/interface.mjs — AuthProvider contract (~30 lines)
  plugin/lambda-templates/auth/providers/cognito.mjs  — Cognito SDK wrapper (~200 lines)
  plugin/lambda-templates/authorizer/index.mjs        — Custom Lambda authorizer (~120 lines)
  plugin/scripts/generate-keys.mjs                    — JWT key gen, pure crypto (~50 lines)

Files to modify:
  plugin/lambda-templates/index.mjs    — route /auth/v1/* to auth handler
  plugin/lambda-templates/package.json — add jsonwebtoken dependency
  plugin/templates/backend.yaml        — replace authorizer, add auth route, add env vars
  plugin/scripts/bootstrap.sh          — add JWT secret + key generation steps

One new npm dependency: jsonwebtoken

Reference: plans/auth-layer.md has prior research and architectural thinking.
