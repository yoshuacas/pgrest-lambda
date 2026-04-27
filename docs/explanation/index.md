---
title: Explanation
description: Discussions of design decisions and tradeoffs — why pgrest-lambda exists as a library, and how its Cedar authorization model works under the covers.
---

# Explanation

Explanation pages answer **why** questions. They discuss design choices, alternatives that were considered, and the trade-offs that led to the current implementation. If you're looking for *how* to accomplish something, try the [How-to guides](../guide/); for *what exactly* a thing does, try the [Reference](../reference/).

## Pages

- **[Why pgrest-lambda?](./why-pgrest-lambda)** — The positioning against PostgREST, Supabase, and Hasura. When each is a better fit; what pgrest-lambda actually adds to the space.
- **[How authorization works](./how-authorization-works)** — The Cedar-to-SQL partial-evaluation pipeline that turns policy-as-code into row filters. Why Cedar, and not ad-hoc guards.
