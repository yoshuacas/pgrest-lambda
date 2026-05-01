permit(
    principal is PgrestLambda::User,
    action == PgrestLambda::Action::"drop",
    resource is PgrestLambda::Row
);
