---
title: Reference
description: Canonical reference for pgrest-lambda — CLI commands, configuration keys, HTTP endpoints, Cedar policy model, and RPC shapes.
---

# Reference

Reference pages are austere and neutral — they document what exists, not how to use it. For goal-oriented walkthroughs, see the [How-to guides](../guide/).

## Sections

- **[CLI](./cli)** — `pgrest-lambda dev`, `refresh`, `generate-key`, `migrate-auth`, `help`.
- **[Configuration](./configuration)** — every config key and environment variable accepted by `createPgrest(config)` and the CLI. The existing [configuration guide](../configuration.md) has the same material with more narrative.
- **[HTTP API](./http-api)** — path, method, and header contract for `/rest/v1/*` and `/auth/v1/*`.
- **[Authorization](./authorization)** — Cedar principal/action/resource model, the translatable subset, error codes, and worked policy examples.
- **[Lint rules](./lint-rules)** — Every rule checked by `pgrest-lambda lint-policies`, with example, fix, and suppression for each.

## Repo-rooted references

These pages live in the pre-existing `docs/` tree and ship as part of the source repo. They are linked here for a single navigable surface:

- **Authorization (Cedar policy model)** — [`docs/authorization.md`](../authorization.md)
- **Configuration (env var and secret management)** — [`docs/configuration.md`](../configuration.md)
- **RPC (calling PostgreSQL functions)** — [`docs/rpc.md`](../rpc.md)
