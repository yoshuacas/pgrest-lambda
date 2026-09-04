---
title: Resource embedding reference
description: How pgrest-lambda discovers relationships and the full select syntax for embedding related tables, including join types, spreads, filters, order, limits, and the errors each one raises.
---

# Resource embedding reference

Embedding returns related rows inside the parent row, in one request and one SQL
statement. `?select=*,orders(*)` on `/rest/v1/customers` puts each customer's
orders in an `orders` key.

Embedding works on both providers. Aurora DSQL reports foreign key constraints in
`pg_constraint` like standard PostgreSQL does, so `supportsForeignKeys` is `true`
on both (`src/rest/db/dsql.mjs`, `src/rest/db/postgres.mjs`), and no declared
relationship manifest is needed for keys that exist in the DDL.

## Where relationships come from

The schema cache builds one relationship list at introspection time
(`src/rest/schema-cache.mjs`). Six sources feed it, and all six produce the same
record shape, so nothing downstream can tell them apart:

| Source | Derived from | Notes |
|---|---|---|
| Foreign keys | `pg_constraint` where `contype = 'f'` | The primary source. Gated on the provider's `supportsForeignKeys`. |
| Many-to-many | A junction table whose primary key contains the columns of two distinct many-to-one foreign keys | Derived, not declared. Searched among served relations only, and emitted once per pair. |
| View inheritance | `pg_rewrite`, mapping a view's columns back to its source columns | A view over a table inherits that table's relationships, and its primary key when every key column maps through. |
| Computed relationships | A one-argument SQL function taking the parent row type and returning a row type | Embedded by **function name**. Gated on the provider's `supportsRpc`. |
| Declared manifest | A JSON file at `relationshipsPath` / `PGREST_RELATIONSHIPS_PATH` | For relationships the catalog cannot report. |
| `{singular}_id` convention | Column names ending in `_id` | **Last resort only.** Runs when the five sources above produced zero relationships. Matches `author_id` → `author`, `authors`, and the `-es` / `-ies` plurals; skips self-references. |

Only relations the engine actually serves can take part in an embed: both ends
must be in the exposed schema and every column on both sides must be present in
the cache.

## Select syntax

| Form | Example | Meaning |
|---|---|---|
| Embed | `select=*,orders(*)` | Nest the related rows under `orders`. |
| Column list | `select=id,orders(id,amount)` | Project inside the embed. |
| Alias | `select=*,purchases:orders(*)` | Rename the key. The alias must be a valid identifier, or `PGRST100`. |
| Nested | `select=*,orders(*,line_items(*))` | Embeds nest to `maxEmbedDepth` / `PGREST_MAX_EMBED_DEPTH`. |
| Inner join | `select=*,orders!inner(*)` | Drop parents with no related row. |
| Left join | `select=*,orders!left(*)` | The default, spelled explicitly. |
| Hint | `select=*,orders!orders_customer_id_fkey(*)` | Pick one relationship when several match. Anything after `!` that is not `inner` or `left` is a hint. |
| Spread | `select=*,...customers(name)` | Merge the related columns into the parent row instead of nesting them. |

Where a hint and a join type both appear, the first of each wins.

## Modifiers on an embed

Each is namespaced by the embed's key — its **alias** if it has one.

| Param | Example |
|---|---|
| Filter | `orders.amount=gt.100` |
| Logical | `orders.or=(amount.gt.100,status.eq.paid)` |
| `order` | `orders.order=created_at.desc` |
| `limit` | `orders.limit=5` |
| `offset` | `orders.offset=10` |

Filtering an embed works at any nesting depth. `?orders=not.is.null` filters the
parent on the existence of a related row, at any level.

Ordering the **parent** by an embedded column uses a different spelling:
`?order=customers(name)`, and the relationship has to be many-to-one or
one-to-one.

By default `url-use-legacy-target-names` is `false` here, so a filter on an
aliased embed must name the alias. Upstream defaults it `true` and accepts the
target name with a `Warning` header.

## Errors

| Code | HTTP | Raised when |
|---|---|---|
| `PGRST100` | 400 | An alias is not a valid identifier. |
| `PGRST108` | 400 | A filter, order, or limit names a resource the select list does not embed — including naming the target instead of the alias. |
| `PGRST118` | 400 | `?order=orders(col)` where the relationship is not many-to-one or one-to-one. |
| `PGRST127` | 400 | An aggregate inside a one-to-many or many-to-many spread. |
| `PGRST200` | 400 | No relationship found between the two tables. The `details` name the schema searched and the hint used. |
| `PGRST201` | 300 | More than one relationship matched. The `details` list every candidate with its cardinality; the `hint` gives the `table!disambiguator` spelling for each. |

Full messages: [Error codes](./errors).

## Measured coverage

From the published conformance run (2026-08-28, 1,179 of 1,294 upstream
assertions on a live DSQL cluster — see
[PostgREST compatibility](./postgrest-compatibility)):

| Feature | Passing |
|---|---|
| `embedding` spec overall | 282 / 288 (98%) |
| `!inner` embed | 68 / 68 |
| `!left` embed | 3 / 3 |
| Spread embed | 86 / 86 |
| Embed nested three or more levels deep | 17 / 17 |
| Filter on an embedded resource | 111 / 112 |
| `order` on an embedded resource | 53 / 54 |
| Disambiguating hint | 35 / 36 |

That run declares no relationship manifest: every relationship above is derived
from `pg_constraint` on DSQL, through the same code path used on standard
PostgreSQL.
