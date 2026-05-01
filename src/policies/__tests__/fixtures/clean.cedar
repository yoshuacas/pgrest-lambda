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

permit(
    principal is PgrestLambda::User,
    action == PgrestLambda::Action::"insert",
    resource is PgrestLambda::Table
);
