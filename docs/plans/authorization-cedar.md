# BOA Authorization with Cedar — Replacing RLS with Policy-as-Code

## Execution via rring

```bash
cd /Users/davcasd/research/boa
git pull origin main
rring start authorization-cedar "Implement Cedar-based authorization for the BOA PostgREST layer"
# Then replace the prompt content with the full prompt below
rring design authorization-cedar
rring task authorization-cedar
rring work -n 15
rring review authorization-cedar
```

The prompt is at `docs/design/prompts/authorization-cedar.md`. The rring agent backend is Claude Code.

## Dependencies

This plan depends on the PostgREST layer (`plans/postgrest-layer.md`) being implemented first — Cedar evaluation hooks into the PostgREST handler. It also depends on the auth layer (`plans/auth-layer.md`) for the `{role, userId, email}` authorizer context.

---

## Context

BOA needs authorization (who can access what data). Instead of PostgreSQL RLS, BOA uses Cedar — AWS's open-source policy language. Cedar is human-readable, extremely fast (4-5 microseconds per evaluation via WASM), runs locally in Lambda, and agents can generate correct policies reliably.

## Why Cedar Instead of RLS

| Concern | RLS (PostgreSQL) | Cedar |
|---------|------------------|-------|
| Where it runs | Inside the database | In Lambda (application layer) |
| Language | SQL | Human-readable DSL |
| Testable in isolation | No (needs DB) | Yes (pure function) |
| Agent-friendly | No | Yes (text policy files) |
| Expressive power | SQL WHERE clauses | RBAC + ABAC + hierarchies + context |
| Multi-tenancy | user_id filter per policy | Entity hierarchies (User in Org) |
| Performance | Zero (query-time) | ~5μs per eval via WASM |

## Developer Experience

Developer tells their agent: "users should only see their own todos, but admins can see all"

Agent writes `.boa/policies/todos.cedar`:
```cedar
permit(
  principal is BOA::User,
  action == BOA::Action::"read",
  resource is BOA::Table
) when {
  resource.user_id == principal.id
};

permit(
  principal is BOA::User,
  action == BOA::Action::"read",
  resource is BOA::Table
) when {
  principal.role == "admin"
};
```

Policies uploaded to S3 at deploy. Every API request: Cedar evaluates before SQL executes. ALLOW → query runs. DENY → 403.

## Architecture

```
API Request → PostgREST Handler
    │
    ├── Parse request (table, method, filters)
    ├── Build Cedar authorization request
    ├── Evaluate via cedar-wasm (local, ~5μs)
    │   ├── ALLOW → execute SQL
    │   └── DENY  → return 403
    └── Return results
```

**For reads:** Execute SQL first (with basic user_id filter), then filter each row through Cedar (~5μs per row, 500 rows = 2.5ms).

**For writes:** Evaluate Cedar once before executing SQL.

## Cedar Entity Model

```cedar
// .boa/policies/schema.cedarschema
namespace BOA {
  entity User = { email: String, role: String };
  entity ServiceRole;
  entity Table = { user_id?: String };
  action read, create, update, delete appliesTo {
    principal: [User, ServiceRole],
    resource: [Table],
    context: { ip?: String, role: String, method: String, table: String }
  };
}
```

## Default Policies (ship with BOA)

```cedar
// .boa/policies/default.cedar

// Authenticated users can CRUD their own data
permit(principal is BOA::User, action == BOA::Action::"read", resource is BOA::Table)
  when { resource has user_id && resource.user_id == principal.id };

permit(principal is BOA::User, action == BOA::Action::"create", resource is BOA::Table);

permit(principal is BOA::User, action == BOA::Action::"update", resource is BOA::Table)
  when { resource has user_id && resource.user_id == principal.id };

permit(principal is BOA::User, action == BOA::Action::"delete", resource is BOA::Table)
  when { resource has user_id && resource.user_id == principal.id };

// Service role bypasses all authorization
permit(principal is BOA::ServiceRole, action, resource);
```

## Custom Policy Examples

```cedar
// Admins see all data
permit(principal is BOA::User, action == BOA::Action::"read", resource is BOA::Table)
  when { principal.role == "admin" };

// Public tables (anon access)
permit(principal, action == BOA::Action::"read", resource is BOA::Table)
  when { context.table == "public_posts" };

// Team members read each other's data
permit(principal is BOA::User, action == BOA::Action::"read", resource is BOA::Table)
  when { principal in resource.team };
```

## Module Structure

```
plugin/lambda-templates/postgrest/
  cedar.mjs              # Cedar policy engine (~150 lines)
                         # - loadPolicies(): fetch from S3, compile, cache
                         # - authorize({principal, action, resource, context}) → {allowed, reasons}
                         # - refreshPolicies(): force reload
```

One new file. One new npm dep: `@cedar-policy/cedar-wasm`.

## Policy Storage

- `.boa/policies/*.cedar` files in the developer's project
- Uploaded to S3 at deploy: `aws s3 sync .boa/policies/ s3://${BUCKET}/policies/`
- Lambda loads from S3 on cold start, caches in module scope (5-min TTL)
- Force refresh via `POST /rest/v1/_refresh`

## SAM Template Changes

Add to `ApiFunction` environment:
```yaml
POLICIES_BUCKET: !Ref StorageBucket
POLICIES_PREFIX: policies/
```

No new Lambdas. No new AWS resources. Policies in the existing S3 bucket.

## Implementation Order

| Step | What |
|------|------|
| 1 | Create `.boa/policies/schema.cedarschema` |
| 2 | Create `.boa/policies/default.cedar` |
| 3 | Create `postgrest/cedar.mjs` |
| 4 | Add `@cedar-policy/cedar-wasm` to `package.json` |
| 5 | Integrate Cedar into PostgREST handler |
| 6 | Update `bootstrap.sh` to upload policies to S3 |
| 7 | Update SAM template with policy env vars |
| 8 | Update docs (SKILL.md, ARCHITECTURE.md) with Cedar patterns |
| 9 | Add example custom policies to `plugin/docs/` |

## Verification

1. Default policies: authenticated user can CRUD own data, cannot access others'
2. Service role: bypasses all policies
3. Anon: denied by default on user-owned tables
4. Custom "admins see all" policy works
5. Custom "public table" policy allows anon reads
6. Performance: <1ms added to request latency
7. Policy refresh: new S3 policy takes effect after `_refresh` call
