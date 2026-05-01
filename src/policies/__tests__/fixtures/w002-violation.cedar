permit(
    principal is PgrestLambda::User,
    action == PgrestLambda::Action::"select",
    resource
) when { context.table == "posts" };
