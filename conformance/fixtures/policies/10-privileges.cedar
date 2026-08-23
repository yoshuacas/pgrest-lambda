// Upstream's test/spec/fixtures/privileges.sql, translated into Cedar.
//
// Upstream authorizes with PostgreSQL roles: it `SET ROLE`s to the role named
// in the JWT and lets GRANT/REVOKE decide. Aurora DSQL supports neither `SET
// ROLE` nor `GRANT ... TO <role>`, so this engine authorizes with Cedar
// instead, and a faithful port of the privilege fixture has to be a policy set
// rather than SQL. This file is that port, in the same spirit as
// `relationships.json` standing in for the foreign keys DSQL will not store.
//
// It is a fixture, not engine configuration: it exists so the harness presents
// the engine with the same privileges upstream's database presents to
// PostgREST. Nothing here weakens an assertion — every rule below is a GRANT
// that upstream's fixture performs, and every table it names is one upstream
// names.
//
// Scoping is by `context.table`, which the engine populates with the relation
// (or function) a request targets. A `resource == PgrestLambda::Table::"..."`
// condition cannot do the job: a row-level check evaluates with the resource
// still unknown, so a condition naming a Table entity translates to FALSE
// rather than to a filter (see `buildAuthzFilter` and `translateExpr`).

// privileges.sql:18-24
//   GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA
//         "SPECIAL ""@/\#~_-", "تست", test, v1, v2
//   TO postgrest_test_anonymous;
//
// The runner resolves a request with no token to the anon role, which is what
// upstream's `db-anon-role=postgrest_test_anonymous` does, and that role holds
// every privilege on every table the suite exposes. So the anon baseline is an
// unconditional permit, and the REVOKEs below take pieces back out of it.
permit(
    principal is PgrestLambda::AnonRole,
    action,
    resource
);

// privileges.sql:26-31
//   REVOKE ALL PRIVILEGES ON TABLE
//         app_users, authors_only, insertonly, limited_article_stars
//   FROM postgrest_test_anonymous;
//
// Then privileges.sql:33 and :53-59 hand some of it back:
//   GRANT INSERT ON TABLE insertonly TO postgrest_test_anonymous;
//   GRANT SELECT (article_id, user_id), INSERT (...), UPDATE (...)
//     ON TABLE limited_article_stars TO postgrest_test_anonymous;
//   GRANT SELECT(id, email), INSERT, UPDATE, DELETE
//     ON TABLE app_users TO postgrest_test_anonymous;
//
// What survives as a whole-table refusal, and so is expressible here:
//   authors_only            — nothing granted back, every action forbidden
//   insertonly              — INSERT only, so read/update/delete forbidden
//   limited_article_stars   — no DELETE granted back
//
// Column-level privileges are not expressible: Cedar decides per action and
// row, not per column, so the `SELECT (article_id, user_id)` narrowing on
// limited_article_stars and the `SELECT(id, email)` narrowing on app_users are
// not ported. A case that asserts a refusal on a *column* anonymous may not
// read therefore still fails, and that is recorded rather than papered over.
forbid(
    principal is PgrestLambda::AnonRole,
    action,
    resource
) when {
    context.table == "authors_only"
};

forbid(
    principal is PgrestLambda::AnonRole,
    action in [
        PgrestLambda::Action::"select",
        PgrestLambda::Action::"update",
        PgrestLambda::Action::"delete"
    ],
    resource
) when {
    context.table == "insertonly"
};

forbid(
    principal is PgrestLambda::AnonRole,
    action == PgrestLambda::Action::"delete",
    resource
) when {
    context.table == "limited_article_stars"
};

// privileges.sql:50-51
//   GRANT USAGE ON SCHEMA test TO postgrest_test_author;
//   GRANT ALL ON TABLE authors_only TO postgrest_test_author;
//
// ALL is every table privilege, so this covers select/insert/update/delete and
// stays scoped to the one table upstream grants.
permit(
    principal is PgrestLambda::User,
    action in [
        PgrestLambda::Action::"select",
        PgrestLambda::Action::"insert",
        PgrestLambda::Action::"update",
        PgrestLambda::Action::"delete"
    ],
    resource
) when {
    principal.role == "postgrest_test_author" &&
    context.table == "authors_only"
};

// privileges.sql:61, in upstream's own words:
//   -- All functions are available to every role(PUBLIC) by default
//
// PostgreSQL grants EXECUTE on a new function to PUBLIC, so upstream's roles
// can call every function in the fixture without a GRANT saying so. This
// engine has no such default — a call needs a policy — so the default is what
// this permit is. It carries no table privilege: a function still reads
// whatever the rules above allow.
permit(
    principal is PgrestLambda::User,
    action == PgrestLambda::Action::"call",
    resource
);

// privileges.sql:61-62
//   REVOKE EXECUTE ON FUNCTION privileged_hello(text) FROM PUBLIC;
//   GRANT EXECUTE ON FUNCTION privileged_hello(text) TO postgrest_test_author;
//
// The REVOKE takes back the PUBLIC default above, and the GRANT hands it to
// one role. A forbid is how Cedar says that: it overrides every permit,
// including the unconditional service_role rule in 00-engine-defaults.cedar,
// which is what the runner resolves an untokened request to. That matters —
// service_role stands in for upstream's postgrest_test_anonymous, and
// postgrest_test_anonymous is exactly who this REVOKE is aimed at.
//
// `principal is PgrestLambda::User &&` guards the attribute access: Cedar's
// `&&` short-circuits, so a ServiceRole or AnonRole principal, which has no
// `role` attribute, is refused rather than erroring.
forbid(
    principal,
    action == PgrestLambda::Action::"call",
    resource
) when {
    context.table == "privileged_hello" &&
    !(principal is PgrestLambda::User
      && principal.role == "postgrest_test_author")
};

// privileges.sql:64
//   GRANT USAGE ON SCHEMA test TO postgrest_test_default_role;
// Schema usage alone grants no table privilege, so postgrest_test_default_role
// gets no rule: it can reach the API and read nothing. That is the absence of a
// policy, recorded here so the omission reads as deliberate.
