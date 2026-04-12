# Schema Examples

Example DDL for creating tables that pgrest-lambda can serve. Pick the file that matches your database.

| File | Use when |
|---|---|
| `dsql-compatible.sql` | Aurora DSQL, or when you don't know the target database (works everywhere) |
| `standard-postgres.sql` | Standard PostgreSQL, Aurora Serverless v2, RDS, Neon, Supabase |

## Which to use

If in doubt, use `dsql-compatible.sql` — it works on all PostgreSQL-compatible databases including DSQL.

The only downside of the DSQL-compatible syntax is that auto-increment IDs are `BIGINT` instead of `INTEGER`, which uses 8 bytes per row instead of 4. This is negligible for most applications.

## pgrest-lambda requirements

- Tables must be in the `public` schema
- Primary keys are recommended (used for upsert conflict resolution)
- A column named `user_id` enables automatic per-user row filtering via the default Cedar policy
- UUID, TEXT, INTEGER, BIGINT, BOOLEAN, TIMESTAMPTZ, DATE, JSON/JSONB types are all supported
