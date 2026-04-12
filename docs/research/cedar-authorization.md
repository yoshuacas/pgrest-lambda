# Cedar Authorization for pgrest-lambda — Research

Date: 2026-04-12

## Constraint

DSQL does not support PostgreSQL RLS or SET ROLE. Row-level security must be application-layer.

## Two Cedar patterns for access control

Cedar documentation and examples show two patterns for controlling access to individual items. Both are relevant to pgrest-lambda, but for different reasons.

### Pattern 1: Per-item authorization (TinyTodo)

Source: https://aws.amazon.com/blogs/opensource/using-open-source-cedar-to-write-and-enforce-custom-authorization-policies/
Code: https://github.com/cedar-policy/cedar-examples/tree/main/tinytodo

TinyTodo is AWS's reference app for Cedar. It models individual resources (todo lists) as Cedar entities with ownership and team-based permissions.

**Schema** (from `tinytodo.cedarschema`):

```cedar
type Task = {
    "id": Long,
    "name": String,
    "state": String,
};
type Tasks = Set<Task>;

entity Application enum ["TinyTodo"];
entity User in [Team, Application] = {
    "joblevel": Long,
    "location": String,
};
entity Team in [Team, Application];
entity List in [Application] = {
    "editors": Team,
    "name": String,
    "owner": User,
    "readers": Team,
    "tasks": Tasks,
};

action DeleteList, GetList, UpdateList appliesTo {
    principal: [User],
    resource: [List]
};
action CreateList, GetLists appliesTo {
    principal: [User],
    resource: [Application]
};
action CreateTask, UpdateTask, DeleteTask appliesTo {
    principal: [User],
    resource: [List]
};
```

**Policies** (from `policies.cedar`):

```cedar
// Any User can create a list and see what lists they own
permit (
    principal,
    action in [Action::"CreateList", Action::"GetLists"],
    resource == Application::"TinyTodo"
);

// A User can perform any action on a List they own
permit (principal, action, resource is List)
when { resource.owner == principal };

// A User can see a List if they are either a reader or editor
permit (principal, action == Action::"GetList", resource)
when { principal in resource.readers || principal in resource.editors };

// A User can update a List and its tasks if they are an editor
permit (
    principal,
    action in [Action::"UpdateList", Action::"CreateTask",
               Action::"UpdateTask", Action::"DeleteTask"],
    resource
)
when { principal in resource.editors };
```

**How it works:** The app calls `is_authorized(principal, action, resource)` for each specific item. The resource is a concrete entity — e.g., `List::"0"` — with all its attributes (owner, readers, editors) loaded into the entity store. Cedar evaluates policies against the full entity.

**Why this doesn't work for pgrest-lambda:** This is per-item, post-query authorization. To answer "which todos can Alice see?", you'd have to load ALL todos from the database, construct Cedar entities for each, and call `is_authorized()` per row. This breaks pagination, wastes DB resources, and leaks data out of PostgreSQL before filtering.

**What IS useful from TinyTodo:** The entity modeling pattern. Each database table maps to a Cedar entity type. Columns map to entity attributes. Ownership and team membership are modeled as entity attributes and relationships. This is exactly how pgrest-lambda should model its Cedar schema.

### Pattern 2: Partial evaluation → query filter (Cedarland blog)

Source: https://cedarland.blog/usage/partial-evaluation/content.html

This is the pattern Cedar recommends when you need to filter a collection of items (like database rows) rather than check a single known item.

**How it works:**

1. Build a Cedar authorization request with the resource left as **unknown** (null)
2. Call `isAuthorizedPartial()` instead of `isAuthorized()`
3. Cedar evaluates as far as it can — principal, action, and context are known, resource attributes are not
4. Cedar returns **residual policies** — partially evaluated policies where known conditions have been resolved but resource-dependent conditions remain as expressions
5. Walk the residual AST and translate resource attribute conditions into SQL WHERE clauses
6. Execute the query with the WHERE clauses applied — only authorized rows come back

**Example from the Cedarland blog:**

Given policies about document access (owner can read, public docs readable by anyone), calling partial evaluation with `principal: User::"Alice"` and `resource: null` produces residuals like:

```cedar
permit(principal, action, resource)
when { true && true && resource.owner == DocCloud::User::"Alice" };

permit(principal, action, resource)
when { true && resource.isPublic };
```

These translate to SQL:

```sql
SELECT id FROM documents WHERE
  (owner = 'Alice')
  OR
  (is_public = true);
```

**This is the right pattern for pgrest-lambda.** The database only returns rows the user is authorized to see. No post-filtering, no pagination breakage, no data leakage.

## Cedar partial evaluation API

Available today in `@cedar-policy/cedar-wasm` (v4.9.1) via Classic Partial Evaluation (CPE).

### API signature

```typescript
interface PartialAuthorizationCall {
    principal: EntityUid | null;  // null = unknown
    action: EntityUid | null;
    resource: EntityUid | null;   // null = unknown for data filtering
    context: Context;
    schema?: Schema;
    policies: PolicySet;
    entities: Entities;
}

type PartialAuthorizationAnswer =
    | { type: "failure"; errors: DetailedError[] }
    | { type: "residuals"; response: ResidualResponse };

interface ResidualResponse {
    decision: Decision | null;          // null if indeterminate
    satisfied: PolicyId[];              // policies that definitely allow
    errored: PolicyId[];
    mayBeDetermining: PolicyId[];
    mustBeDetermining: PolicyId[];
    residuals: Record<string, Expr>;    // the residual policy ASTs
    nontrivialResiduals: PolicyId[];    // residuals that aren't just true/false
}
```

### Residual expression AST

The residual `Expr` type is a tagged union (JSON):

```typescript
type Expr =
    | { Value: CedarValueJson }
    | { Var: "principal" | "action" | "resource" | "context" }
    | { "==": { left: Expr; right: Expr } }
    | { "!=": { left: Expr; right: Expr } }
    | { "&&": { left: Expr; right: Expr } }
    | { "||": { left: Expr; right: Expr } }
    | { ".": { left: Expr; attr: string } }       // attribute access
    | { has: { left: Expr; attr: string } }        // has-attribute check
    | { in: { left: Expr; right: Expr } }          // hierarchy membership
    | { "<": { left: Expr; right: Expr } }
    | { "<=": { left: Expr; right: Expr } }
    | { ">": { left: Expr; right: Expr } }
    | { ">=": { left: Expr; right: Expr } }
    | { contains: { left: Expr; right: Expr } }    // set contains
    | { like: { left: Expr; pattern: PatternElem[] } }
    | { "if-then-else": { if: Expr; then: Expr; else: Expr } }
    | { "!": { arg: Expr } }
    | { Set: Expr[] }
    | { Record: Record<string, Expr> }
    | { unknown: [{ Value: string }] }             // CPE unknown marker
```

### CPE residual quirk

CPE (without schema) cannot safely simplify certain expressions, so residuals contain `true && true && actual_condition` wrappers. Semantically correct but noisy. The AST walker needs to handle these by collapsing `true && X` to just `X`.

A newer system called Type-Aware Partial Evaluation (TPE, RFC 0095) produces cleaner residuals using schema type information, but TPE is not yet available in cedar-wasm — only in Rust and Cedar CLI.

## Cedar team's recommended approaches

From GitHub issue cedar-policy/cedar#592 ("Data filtering support using Cedar"):

**Approach A — Partial evaluation (Aaron Eline, Cedar contributor):**
Use `isAuthorizedPartial()` with unknown resource, translate residuals to database queries.

**Approach B — Policy metadata (Mike Hicks, Cedar contributor):**
Annotate policies with pre-written SQL filters. Use Cedar to determine which policies match, then combine their SQL filters:

```cedar
@id("tenant-isolation")
@sqlFilter("user_id = $userId")
permit(principal, action == Action::"read", resource)
when { resource.user_id == principal.id };
```

Run `isAuthorized()` at the table level. From the `diagnostics.reason` array, get satisfied policy IDs. Look up `@sqlFilter` annotations. Combine with OR.

**Tradeoff:** Approach A is automatic but requires building an AST-to-SQL compiler. Approach B is simpler but the SQL filters are hand-written per policy and can drift from the Cedar conditions.

## Proposed architecture for pgrest-lambda

### Entity model

Map database concepts to Cedar entities:

```cedar
namespace PgrestLambda {
    entity User = {
        "email": String,
        "role": String,      // "authenticated" | "admin" | etc.
    };
    entity ServiceRole;
    entity AnonRole;
    entity Table;
    entity Row in [Table] = {
        // Attributes derived from table columns at schema introspection time
        // e.g., for a "todos" table: "user_id": String, "status": String
    };

    action "select", "insert", "update", "delete" appliesTo {
        principal: [User, ServiceRole, AnonRole],
        resource: [Table, Row],
    };
}
```

Note: The TinyTodo pattern of putting `owner`, `readers`, `editors` as entity attributes maps directly to database columns. For pgrest-lambda, `resource.user_id` in a policy corresponds to the `user_id` column.

### Authorization flow

```
Request → Authorizer (JWT → role, userId, email)
    │
    ├─ Construct Cedar principal: User::"<userId>" or ServiceRole::"key" or AnonRole::"anon"
    ├─ Construct Cedar action: Action::"select" (from HTTP method)
    ├─ Construct Cedar context: { table: "todos", method: "GET" }
    │
    ├─ Step 1: Table-level check
    │   Call isAuthorized(principal, action, Table::"todos")
    │   DENY → 403
    │
    ├─ Step 2: Row-level filter generation
    │   Call isAuthorizedPartial(principal, action, resource: null, ...)
    │   Get residual policies → walk AST → generate SQL WHERE clauses
    │   If decision is concrete Allow with no residuals → no WHERE filter needed
    │   If decision is concrete Deny → 403
    │   If residuals exist → translate to SQL
    │
    ├─ Step 3: Execute SQL with Cedar-derived WHERE clauses
    │   SELECT ... FROM "todos" WHERE <cedar-conditions> AND <user-filters>
    │
    └─ Return results
```

### Residual-to-SQL translation

The AST walker maps Cedar expressions to parameterized SQL:

| Cedar expression | SQL |
|---|---|
| `resource.user_id == User::"alice"` | `"user_id" = $N` |
| `resource.status == "active"` | `"status" = $N` |
| `resource.is_public == true` | `"is_public" = $N` |
| `&&` | `AND` |
| `\|\|` | `OR` |
| `!` | `NOT` |
| `resource.level > 5` | `"level" > $N` |
| `has(resource, "team_id")` | `"team_id" IS NOT NULL` |
| `true` (CPE noise) | skip / collapse |
| Multiple permit residuals | Combined with `OR` |
| Forbid residuals | `AND NOT (condition)` |

All values go through parameterized placeholders ($1, $2, etc.) — never interpolated.

### What replaces the current user_id magic

Current `appendUserId()` becomes unnecessary. Instead:

**Default policy** (ships with pgrest-lambda):
```cedar
// Authenticated users can CRUD rows they own
permit(
    principal is PgrestLambda::User,
    action,
    resource is PgrestLambda::Row
) when {
    resource has user_id && resource.user_id == principal.id
};

// Service role bypasses all authorization
permit(principal is PgrestLambda::ServiceRole, action, resource);
```

Partial evaluation with `principal: User::"alice"` and `resource: null` produces a residual like:
```cedar
when { resource has user_id && resource.user_id == User::"alice" }
```

The AST walker translates this to:
```sql
WHERE "user_id" IS NOT NULL AND "user_id" = $1  -- $1 = 'alice'
```

Same SQL as today's `appendUserId()`, but driven by policy rather than column-name convention. Tables without `user_id` don't silently become public — they require an explicit policy granting access.

### Custom policies developers can write

```cedar
// Admins see all rows in any table
permit(
    principal is PgrestLambda::User,
    action == PgrestLambda::Action::"select",
    resource
) when {
    principal.role == "admin"
};

// Public tables readable by anyone (including anon)
permit(
    principal,
    action == PgrestLambda::Action::"select",
    resource is PgrestLambda::Row
) when {
    context.table == "public_posts"
};

// Team-scoped data
permit(
    principal is PgrestLambda::User,
    action == PgrestLambda::Action::"select",
    resource is PgrestLambda::Row
) when {
    resource has team_id && resource.team_id == principal.team_id
};

// Forbid: nobody can delete archived items
forbid(
    principal,
    action == PgrestLambda::Action::"delete",
    resource is PgrestLambda::Row
) when {
    resource has status && resource.status == "archived"
};
```

## Reference implementations

### cedar-rag-authz-demo (Phil Windley)

https://github.com/windley/cedar-rag-authz-demo

The only existing open-source implementation of Cedar residual-to-query translation. Targets OpenSearch (not SQL), but the pattern is identical:
1. Call Cedar TPE with unknown resource
2. Walk residual AST in `src/compile/residual-to-filter.js`
3. Translate to OpenSearch bool query filters
4. Route `forbid` residuals into `must_not` clauses

### Cerbos PlanResources (different policy language, same pattern)

https://github.com/cerbos/cerbos

Cerbos has the most mature implementation of policy-to-query-filter translation. Their `PlanResources` API returns `ALWAYS_ALLOWED`, `ALWAYS_DENIED`, or `CONDITIONAL` with an AST. They provide official adapters for Prisma, Drizzle, SQLAlchemy, and MongoDB. The adapter pattern (walking an AST to produce ORM-native filters) is exactly what we'd build for Cedar residuals.

## Open questions

1. **Schema generation:** Cedar needs a schema that matches the database. Should we auto-generate the Cedar schema from `schema-cache.mjs` introspection, or require developers to write it manually?

2. **Policy storage:** The current plan says S3. For local development and DSQL users, should policies also be loadable from the filesystem or environment variables?

3. **Entity construction:** For partial evaluation, we need the principal entity (User with role, email) in the entity store. How much user metadata do we load? Just role/email from the authorizer, or query a users table?

4. **Hierarchy support:** TinyTodo's team membership (`User in Team`) requires entity hierarchies. If pgrest-lambda wants team-scoped access, it needs a way to load team membership into the Cedar entity store. This likely means querying a `team_members` table on each request.

5. **Performance:** CPE adds one `isAuthorizedPartial()` call per request (~5μs for WASM evaluation) plus AST walking time. Acceptable for Lambda, but should be measured.

6. **Approach A vs B:** Partial evaluation (automatic filter derivation) vs policy metadata (hand-written SQL annotations). Partial evaluation is more correct but harder to build. Policy metadata is simpler but fragile. Could support both — use partial evaluation by default, allow `@sqlFilter` annotations as an optimization escape hatch.
