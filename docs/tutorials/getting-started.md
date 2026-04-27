---
title: Run your first pgrest-lambda query
description: A 10-minute walkthrough from zero to a working REST API on top of Postgres, with a query issued from the supabase-js client.
---

# Run your first pgrest-lambda query

This tutorial takes you from nothing installed to a running pgrest-lambda server that answers a REST query over HTTP. You will:

1. Start the CLI, which boots a local Postgres container, applies the `better_auth` schema, and prints an `anon` apikey.
2. Create a table with `psql`.
3. Issue a query from the `@supabase/supabase-js` client.

You will not need an AWS account, a cloud database, or any manual configuration.

## Prerequisites

- **Node.js 20+** — check with `node --version`.
- **Docker Desktop (or a Docker daemon)** — check with `docker info`. The CLI starts a Postgres container on `localhost:54322` on first run.

## Step 1 — Start pgrest-lambda

In a new directory, run:

```bash
npx --yes pgrest-lambda dev
```

The first run downloads the package, starts a Postgres container, applies the `better_auth` schema, and generates stable secrets in `.env.local`. You should see a banner like:

```text
  pgrest-lambda is running ✓

  API:           http://localhost:3000
  OpenAPI spec:  http://localhost:3000/rest/v1/
  Scalar docs:   http://localhost:3000/rest/v1/_docs
  DATABASE_URL:  postgres://postgres:postgres@localhost:54322/postgres

  Anon apikey:     eyJhbGciOiJIUzI1NiIs…
  Service apikey:  eyJhbGciOiJIUzI1NiIs…

  Press Ctrl-C to stop.
```

Leave this process running. Copy the `Anon apikey` — you will need it in Step 3.

## Step 2 — Create a table

Open a second terminal. Use the `DATABASE_URL` from the banner (or just the default) to create a `posts` table:

```bash
psql 'postgres://postgres:postgres@localhost:54322/postgres' <<'SQL'
CREATE TABLE public.posts (
  id         BIGSERIAL PRIMARY KEY,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO public.posts (title, body) VALUES
  ('Hello', 'First post.'),
  ('Second', 'Another one.');
SQL
```

Then reload the schema cache so pgrest-lambda sees the new table:

```bash
npx pgrest-lambda refresh
```

Expected output:

```text
→ POST http://localhost:3000/rest/v1/_refresh
✓ schema cache and Cedar policies reloaded
```

## Step 3 — Query with curl

Paste the anon apikey from the banner into your shell as `ANON_KEY`, then read from the new table:

```bash
export ANON_KEY='eyJhbGciOiJIUzI1NiIs…'   # the banner value

curl -s 'http://localhost:3000/rest/v1/posts?select=id,title' \
  -H "apikey: $ANON_KEY"
```

Expected response (ids may differ):

```json
[
  {"id": 1, "title": "Hello"},
  {"id": 2, "title": "Second"}
]
```

If you get a `401` or `403`, recheck the apikey — the default policy (`policies/default.cedar`) permits anon reads only on tables where a Cedar rule grants it. Out of the box, `posts` reads are permitted for authenticated users only. To also allow anon reads, see [How to write Cedar row-level policies](../guide/write-cedar-policies).

## Step 4 — Query from supabase-js

In a new Node.js project, install the Supabase client and run a script against your local pgrest-lambda instance:

```bash
npm install @supabase/supabase-js
```

```javascript
// query.mjs
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  'http://localhost:3000',
  process.env.ANON_KEY,
);

const { data, error } = await supabase.from('posts').select('id, title');
if (error) throw error;
console.log(data);
// [ { id: 1, title: 'Hello' }, { id: 2, title: 'Second' } ]
```

```bash
ANON_KEY="$ANON_KEY" node query.mjs
```

pgrest-lambda is wire-compatible with `@supabase/supabase-js`, so this is exactly the same code you would write against a Supabase project — pointed at your own database.

## Step 5 — Open the interactive explorer

In your browser, open:

```text
http://localhost:3000/rest/v1/_docs
```

This is the live Scalar explorer, auto-generated from your schema. Every table in `public` appears as a `/rest/v1/{table}` endpoint with the correct request and response types.

## What next?

You now have pgrest-lambda running locally, a table exposed as a REST endpoint, and working queries from both `curl` and `supabase-js`. From here:

- **Add authorization.** See [How to write Cedar row-level policies](../guide/write-cedar-policies) to let the right users read the right rows.
- **Embed the library.** See [How to use pgrest-lambda as a library](../guide/use-as-a-library) to call `createPgrest(config)` from your own server.
- **Go to production.** See [How to deploy to AWS Lambda with SAM](../guide/deploy-aws-sam) for the reference production stack.
- **Look up an option.** See the [Configuration reference](../reference/configuration) or the [CLI reference](../reference/cli).
