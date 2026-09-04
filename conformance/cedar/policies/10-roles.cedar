// Equivalence policy set — callers whose JWT carries a `role` claim.
//
// Translation of the per-role GRANTs in
// conformance/fixtures/dsql/06-privileges.sql. Upstream reaches these by
// SET ROLE <role claim> and then relying on the role's table and function
// privileges. Here the role claim arrives as `principal.role` on the
// PgrestLambda::User entity the engine builds from the authorizer context, and
// the privilege is a Cedar permit keyed on that attribute.
//
// The role name is read from the token, never checked against a registry:
// Cedar's principal set is open, which is why "role does not exist" has no
// counterpart here.

// 06-privileges.sql:40
//   GRANT ALL ON TABLE authors_only TO postgrest_test_author;
permit(
    principal is PgrestLambda::User,
    action in [
        PgrestLambda::Action::"select",
        PgrestLambda::Action::"insert",
        PgrestLambda::Action::"update",
        PgrestLambda::Action::"delete"
    ],
    resource is PgrestLambda::Row
) when {
    principal.role == "postgrest_test_author"
    && context.table == "authors_only"
};

// Same grant, Table-scoped (INSERT / UPSERT path).
permit(
    principal is PgrestLambda::User,
    action in [
        PgrestLambda::Action::"insert",
        PgrestLambda::Action::"update"
    ],
    resource is PgrestLambda::Table
) when {
    principal.role == "postgrest_test_author"
    && context.table == "authors_only"
};

// 06-privileges.sql:54-57
//   REVOKE EXECUTE ON FUNCTION privileged_hello(text) FROM PUBLIC;
//   GRANT  EXECUTE ON FUNCTION privileged_hello(text) TO postgrest_test_author;
permit(
    principal is PgrestLambda::User,
    action == PgrestLambda::Action::"call",
    resource == PgrestLambda::Function::"privileged_hello"
) when {
    principal.role == "postgrest_test_author"
};

// EXECUTE on every other function is PUBLIC in PostgreSQL by default, so a
// token-bearing caller keeps it whatever the role claim says.
permit(
    principal is PgrestLambda::User,
    action == PgrestLambda::Action::"call",
    resource is PgrestLambda::Function
) when {
    resource != PgrestLambda::Function::"privileged_hello"
};

// Deliberately absent: any table grant for a role other than
// postgrest_test_author. Upstream's roles.sql creates
// postgrest_test_anonymous, postgrest_test_default_role and
// postgrest_test_author with no membership between them, so a token whose role
// claim is anything but postgrest_test_author holds no table privilege at all
// in the upstream fixture either.
