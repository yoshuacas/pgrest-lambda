---
title: Why pgrest-lambda?
description: When pgrest-lambda is the right call versus PostgREST, Supabase, or Hasura — and what the deploy-agnostic core buys you.
---

# Why pgrest-lambda?

**Guiding question:** If PostgREST and Supabase already exist, what is pgrest-lambda for?

## The short answer

pgrest-lambda is the overlap of three things PostgREST and Supabase don't jointly offer:

1. **Supabase-client compatibility** — your React or Next.js app written against `@supabase/supabase-js` runs, unchanged, against pgrest-lambda. You keep the ergonomics of the Supabase SDK.
2. **Your own AWS account, your own database** — no multi-tenant control plane. The library runs as a Lambda function (or an Express handler, or a Cloudflare Worker) against a database you own.
3. **Policy-as-code authorization via Cedar** — row-level policies live in `.cedar` files, are version-controlled with your code, and compile down to SQL `WHERE` clauses at query time.

If you want the Supabase developer experience without the Supabase platform, that's the pitch.

## The landscape

| Option | Good at | Trade-off |
|---|---|---|
| **PostgREST** | Pure REST over PostgreSQL. Proven, minimal, language-agnostic. | Auth is out of scope — you bolt on GoTrue, Kong, an nginx reverse proxy, or roll your own. Row-level security goes in the database (PL/pgSQL + `RLS`). |
| **Supabase** | Hosted, batteries-included. Auth, storage, edge functions, realtime. Great for greenfield. | Control plane you don't own. Egress and tenancy follow Supabase's pricing. RLS lives in Postgres; your policies are coupled to schema migrations. |
| **Hasura** | GraphQL-first. Excellent subscriptions and introspection. | GraphQL is not REST; existing Supabase-client code does not translate. Different mental model. |
| **pgrest-lambda** | Drop-in for Supabase clients; auth + REST + authz in one package; runs as a Lambda you own. | Younger project. No realtime, no storage, no hosted dashboard. Aurora DSQL support has caveats (no RPC — see [docs/rpc.md](../rpc.md)). |

## Why a library, not a service

pgrest-lambda's primary export is `createPgrest(config)` — a function that returns a handler, not a server. That shape is deliberate.

- **Deploy-agnostic.** Every platform with an API-Gateway-shaped event (Lambda, Cloudflare Workers, Express, Fastify, Kong, any reverse proxy in front of Node) can host it. You bring the transport; pgrest-lambda brings the logic.
- **Embeddable.** It fits inside an existing Lambda alongside your own routes, with a single `if (event.path.startsWith('/rest/v1/')) return pgrest.handler(event)` dispatch.
- **Testable.** Everything happens in-process. No containers, no sidecars, no external auth service to stub.

The `pgrest-lambda dev` CLI is a convenience wrapper around the library — it starts Postgres, applies migrations, and mounts the handler on an HTTP server. It is not a "framework"; the real product is the handler.

## Why Cedar for authorization

Row-level security (RLS) in PostgreSQL works. It is also:

- **Coupled to the schema.** `CREATE POLICY` lives in the database. Rolling back a policy means a migration.
- **Hard to read across a large codebase.** Policies attach to tables; there's no single "who can do what" view.
- **Not portable** if you want the same auth rules at different transport layers (REST and, later, GraphQL; or REST and a cron job that also reads the data).

Cedar is a dedicated authorization policy language (AWS, used internally for IAM-adjacent features and open-sourced). It:

- **Lives in files** next to your code. Version-controlled, reviewable, diffable in PRs.
- **Is declarative and side-effect-free.** `permit`/`forbid` rules combine across files without ordering matters.
- **Translates to SQL.** pgrest-lambda partially evaluates the policy set against the known principal and action, produces a residual boolean expression over the row's columns, and injects that as a `WHERE` clause. The query executor never sees the rule directly — Postgres sees SQL.

The trade-off is real: Cedar is a new language for your team, and the partial-evaluation step has expressive limits (see [`PGRST000` in the authorization docs](../authorization.md#errors)). In practice the rules most apps need — "users see their own rows," "admins see everything," "public read," "forbid archived writes" — translate cleanly.

See [How authorization works](./how-authorization-works) for the full pipeline.

## When pgrest-lambda is the wrong choice

- **You want realtime subscriptions.** Not shipped. Use Supabase Realtime or a dedicated pub/sub layer.
- **You want GraphQL.** Use Hasura or PostGraphile. pgrest-lambda is PostgREST-wire-compatible, not a GraphQL engine.
- **You already run PostgREST successfully.** If your auth and RLS story is dialed in, switching to Cedar is work for work's sake.
- **You want a hosted control plane.** Use Supabase.

## What the package is

- **A library** (`createPgrest(config)`) — the handler.
- **A CLI** (`pgrest-lambda`) — local dev, migrations, key minting, refresh.
- **A reference deployment** (`deploy/aws-sam/`) — production-shaped SAM template.
- **An OpenAPI spec** (`GET /rest/v1/`) — live, generated from your schema, so clients and docs stay honest.

Everything else is a consequence. If your app needs what's in that list, pgrest-lambda is a good fit. If it needs something else, one of the alternatives above probably is.
