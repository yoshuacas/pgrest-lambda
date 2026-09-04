// Equivalence policy set — anonymous caller.
//
// Translation of the GRANTs Aurora DSQL cannot act on, from
// conformance/fixtures/dsql/06-privileges.sql. Upstream reaches these with
// `db-anon-role = postgrest_test_anonymous` plus SET ROLE; the derived runner
// maps an upstream request that carries no Authorization header to the
// engine's anonymous principal, PgrestLambda::AnonRole.
//
// This file is a translation of the fixture's privilege statements, not of any
// test's expected value. Nothing here names a status code or a response body.
//
// Every table rule keys on `context.table`, never on
// `resource == PgrestLambda::Table::"..."`. A read/update/delete is authorized
// by partial evaluation with the resource left unknown, and an unknown-resource
// `==` against an entity literal is not translatable to SQL — see
// docs/reference/cedar-equivalence.md.

// 06-privileges.sql:11-16
//   GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA "SPECIAL ...", "تست",
//         "public", v1, v2 TO postgrest_test_anonymous;
// 06-privileges.sql:18-23
//   REVOKE ALL PRIVILEGES ON TABLE app_users, authors_only, insertonly,
//          limited_article_stars FROM postgrest_test_anonymous;
//
// The REVOKE is the whole point of the AuthSpec "denies access to tables that
// anonymous does not own" assertions, so it is expressed as the exclusion it
// is rather than by leaving the grant out.
permit(
    principal is PgrestLambda::AnonRole,
    action in [
        PgrestLambda::Action::"select",
        PgrestLambda::Action::"insert",
        PgrestLambda::Action::"update",
        PgrestLambda::Action::"delete"
    ],
    resource is PgrestLambda::Row
) when {
    !(["app_users", "authors_only", "insertonly", "limited_article_stars"]
        .contains(context.table))
};

// Same grant, Table-scoped: the engine checks INSERT and UPSERT against
// PgrestLambda::Table and row-level reads/writes against PgrestLambda::Row.
permit(
    principal is PgrestLambda::AnonRole,
    action in [
        PgrestLambda::Action::"insert",
        PgrestLambda::Action::"update"
    ],
    resource is PgrestLambda::Table
) when {
    !(["app_users", "authors_only", "insertonly", "limited_article_stars"]
        .contains(context.table))
};

// 06-privileges.sql:25
//   GRANT INSERT ON TABLE insertonly TO postgrest_test_anonymous;
permit(
    principal is PgrestLambda::AnonRole,
    action == PgrestLambda::Action::"insert",
    resource is PgrestLambda::Table
) when {
    context.table == "insertonly"
};

// PostgreSQL grants EXECUTE on a function to PUBLIC by default, so every
// function is callable by the anonymous role except the one the fixture
// revokes:
// 06-privileges.sql:54
//   REVOKE EXECUTE ON FUNCTION privileged_hello(text) FROM PUBLIC;
permit(
    principal is PgrestLambda::AnonRole,
    action == PgrestLambda::Action::"call",
    resource is PgrestLambda::Function
) when {
    resource != PgrestLambda::Function::"privileged_hello"
};
