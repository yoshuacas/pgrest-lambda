# Task 02: Add cedar-wasm Dependency and Default Policies

**Agent:** implementer
**Design:** docs/design/authorization-cedar.md

## Objective

Add the `@cedar-policy/cedar-wasm` npm dependency and create
the default Cedar policy file that replicates the current
`appendUserId()` behavior.

## Implementation

### 1. Add npm dependency

Add `@cedar-policy/cedar-wasm` version `^4.9.1` to
`dependencies` in `package.json`. Run `npm install` to
generate the lock file entry.

### 2. Create `policies/default.cedar`

Create the `policies/` directory at the project root and
write `policies/default.cedar` with the default policies
from the design:

```cedar
// Authenticated users can read/update/delete their own rows
permit(
    principal is PgrestLambda::User,
    action in [
        PgrestLambda::Action::"select",
        PgrestLambda::Action::"update",
        PgrestLambda::Action::"delete"
    ],
    resource is PgrestLambda::Row
) when {
    resource has user_id && resource.user_id == principal
};

// Authenticated users can insert into any table
permit(
    principal is PgrestLambda::User,
    action == PgrestLambda::Action::"insert",
    resource is PgrestLambda::Table
);

// Service role bypasses all authorization
permit(
    principal is PgrestLambda::ServiceRole,
    action,
    resource
);
```

### 3. Verify cedar-wasm loads

Write a quick smoke test (can be a temporary script or
inline in the task) that imports
`@cedar-policy/cedar-wasm/nodejs` and calls `isAuthorized`
with a trivial input to confirm the WASM binary loads
correctly in the Node.js environment. Remove the smoke
test after verification.

## Target Tests

No tests from Task 01 are expected to pass from this task
alone. This task provides the dependency and policy files
that Tasks 03-07 build on.

## Acceptance Criteria

- `package.json` lists `@cedar-policy/cedar-wasm` in
  dependencies
- `npm install` completes without errors
- `policies/default.cedar` exists with the three default
  policies
- `@cedar-policy/cedar-wasm/nodejs` can be imported and
  `isAuthorized` is a callable function
- Existing tests (`npm test`) still pass

## Conflict Criteria

- If `@cedar-policy/cedar-wasm` is already in `package.json`,
  verify the version and skip the install.
- If `policies/default.cedar` already exists, compare its
  content to the design and update if it differs.
- If the WASM binary fails to load on the current Node.js
  version, escalate — the design depends on cedar-wasm
  v4.9.1 working on Node.js 20.x.
