Implement Cedar-based authorization for the BOA PostgREST-compatible
API layer, replacing PostgreSQL RLS with policy-as-code that agents
can read and write.

Requirements:

1. Use @cedar-policy/cedar-wasm to evaluate Cedar policies locally
   in Lambda (~5 microseconds per evaluation, no AWS service calls).

2. Cedar entity model for BOA:
   - Principals: BOA::User (with email, role), BOA::ServiceRole
   - Actions: BOA::Action::"read", "create", "update", "delete"
   - Resources: BOA::Table (with optional user_id attribute)
   - Context: ip, role, method, table name
   - Schema file: .boa/policies/schema.cedarschema

3. Default policies (.boa/policies/default.cedar):
   - Authenticated users can CRUD their own data (user_id == principal.id)
   - Authenticated users can create new data
   - Service role bypasses all authorization
   - Default deny for everything else (Cedar's default behavior)

4. Policy storage:
   - .boa/policies/*.cedar files in the developer's project
   - Uploaded to S3 at deploy time (aws s3 sync)
   - Lambda loads from S3 on cold start, compiles and caches (5-min TTL)
   - Force refresh via POST /rest/v1/_refresh (same endpoint that refreshes schema)

5. Integration with PostgREST handler:
   - For writes (INSERT/UPDATE/DELETE): evaluate Cedar BEFORE executing SQL
   - For reads (SELECT): execute SQL first, then filter rows through Cedar
   - Cedar evaluation uses: userId and role from authorizer context,
     table name from router, row attributes from query results
   - ALLOW → proceed; DENY → return 403

6. Create one new module: postgrest/cedar.mjs (~150 lines)
   Exports: loadPolicies(), authorize({principal, action, resource, context}),
   refreshPolicies()

7. One new npm dependency: @cedar-policy/cedar-wasm

8. SAM template changes: add POLICIES_BUCKET and POLICIES_PREFIX env vars
   to ApiFunction. No new Lambda functions or AWS resources.

9. Bootstrap changes: create .boa/policies/ with default schema and policies,
   upload to S3 during deploy.

This depends on the PostgREST layer (plans/postgrest-layer.md) and auth layer
(plans/auth-layer.md) being implemented. Cedar hooks into the PostgREST handler
and reads role/userId from the auth layer's authorizer context.

Reference: plans/authorization-cedar.md has the full architecture and examples.
