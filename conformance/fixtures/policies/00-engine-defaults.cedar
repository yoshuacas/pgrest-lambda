// A copy of the shipped `policies/default.cedar`, so that pointing the runner
// at this directory adds upstream's GRANTs instead of replacing the policy set
// every earlier measurement was taken under. Keep in step with that file.
//
// These rules are the engine's product defaults, not a translation of anything
// upstream has. The translation is in 10-privileges.cedar.

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

// service_role is the engine's own escape hatch, not a stand-in for any
// upstream role. The runner resolves an untokened request to `anon` (see
// `--role`), and anon's privileges are ported from upstream's fixture in
// 10-privileges.cedar. Running the suite with `--role service_role` therefore
// measures the engine with authorization effectively off, which is useful for
// isolating a failure but is not the conformance baseline.
permit(
    principal is PgrestLambda::ServiceRole,
    action,
    resource
);
