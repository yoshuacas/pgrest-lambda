Replace the GoTrue provider with a better-auth-backed provider for pgrest-lambda's self-hosted auth path. Cognito remains the default AWS-managed provider; better-auth becomes the only self-hosted option (AUTH_PROVIDER=better-auth).

Scope v1:
- Email + password sign up / sign in / refresh / sign out / get-user
- Magic link (email OTP) via AWS SES for self-hosted email delivery
- Google OAuth social login with callback handling
- Adopt better-auth's JWT plugin with asymmetric signing (EdDSA/ES256/RS256) and expose a JWKS endpoint at /auth/v1/jwks
- Teach src/authorizer/index.mjs to verify both HS256 (Cognito path) and asymmetric JWTs (better-auth path) using jose.createRemoteJWKSet, dispatched by token alg header
- Preserve supabase-js wire compatibility: /auth/v1/* returns GoTrue-shaped envelopes {access_token, refresh_token, token_type, expires_in, user}. supabase-js treats access_token as opaque — signing algorithm change is invisible to it

Complete removal:
- Delete src/auth/providers/gotrue.mjs, src/auth/schema.mjs, src/auth/sessions.mjs
- Drop AUTH_PROVIDER=gotrue from template.yaml allowed values
- Remove bcryptjs dependency
- Remove all 'needsSessionTable' / auth.sessions / createSession / resolveSession / updateSessionPrt / revokeUserSessions branches from the auth handler — no remaining provider needs them

New provider lives at src/auth/providers/better-auth.mjs. All better-auth tables live under a dedicated better_auth schema (user, session, account, verification, jwks) — invisible to REST introspection which targets public only (CLAUDE.md rule #9).

Provider contract extension: add an optional issuesOwnAccessToken flag on the provider object. When true, signUp/signIn/refreshToken return {user, accessToken, refreshToken, expiresIn} fully baked and the handler forwards them verbatim instead of calling jwt.signAccessToken. Required because better-auth signs asymmetric JWTs directly.

New /auth/v1 routes for magic-link and OAuth: POST /otp, POST /verify, GET /authorize?provider=google, GET /callback, GET /jwks.

Reference plan file: /Users/davcasd/.claude/plans/jolly-beaming-moler.md contains the full approved plan.

Critical rules from CLAUDE.md that must be respected: REGION_NAME not AWS_REGION; parameterized SQL only; Node.js Lambda only; supabase-js wire compatibility is a hard gate; schema introspection targets public only; JWT issuer is 'pgrest-lambda'; auth providers are swappable via the interface contract; this project is standalone (no BOA/Harbor references).