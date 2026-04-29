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

// Service role bypasses all authorization.
//
// SECURITY — READ BEFORE TOUCHING (sec M-10).
//
// This permit is deliberate. The service role is for trusted
// server-side contexts: CI jobs, admin scripts, SSR renderers,
// backend-to-backend traffic. It authenticates with an apikey that
// resolves to role='service_role' in the authorizer, after which
// every Cedar check becomes a no-op.
//
// The service role key MUST NEVER:
//   - appear in browser code or a mobile app
//   - be committed to version control
//   - be embedded in a distributed build artifact
//
// A leaked service role key grants full read/write/delete access to
// every row in the database, with no row-level filter, no audit
// trail beyond Lambda logs, and no way to revoke without rotating
// the JWT secret (see `boa rotate-keys`).
//
// If your code path wants service-role privileges from the browser,
// it's wrong. Add a narrower Cedar rule; don't paste the key.
permit(
    principal is PgrestLambda::ServiceRole,
    action,
    resource
);
