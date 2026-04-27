---
layout: home
title: pgrest-lambda
description: A serverless REST API and auth layer for any PostgreSQL database — PostgREST-compatible, Supabase-client-compatible, Cedar-authorized.

hero:
  name: "pgrest-lambda"
  text: "A serverless REST API for any PostgreSQL database"
  tagline: "Point it at a schema, get a Supabase-compatible REST API, auth, and an interactive OpenAPI explorer. Run locally, embed in your own server, or deploy with the AWS SAM template."
  actions:
    - theme: brand
      text: Get started
      link: /tutorials/getting-started
    - theme: alt
      text: View on GitHub
      link: https://github.com/yoshuacas/pgrest-lambda

features:
  - title: PostgREST-compatible query syntax
    details: Filtering, ordering, pagination, upserts, exact counts, and resource embedding (joins) — wire-compatible with @supabase/supabase-js.
  - title: Supabase-wire-compatible auth
    details: Signup, signin, refresh, user profile, magic link, OAuth, and JWKS — works with existing Supabase clients unchanged.
  - title: Cedar authorization
    details: Policy-as-code row-level filters translated into SQL WHERE clauses before each query runs.
  - title: OpenAPI 3.0 auto-generation
    details: Live spec and an interactive Scalar explorer on every running instance, auto-generated from schema introspection.
  - title: Multiple database backends
    details: Aurora DSQL (IAM auth), Aurora Serverless v2, RDS PostgreSQL, or any reachable Postgres.
  - title: Deploy-agnostic core
    details: The library doesn't care whether it's behind API Gateway, Kong, Cloudflare Workers, or plain Express.
---
