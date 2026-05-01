permit(
    principal,
    action == PgrestLambda::Action::"select",
    resource is PgrestLambda::Row
) when { context.table == "posts" };
