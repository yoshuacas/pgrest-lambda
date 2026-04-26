Add PostgREST full-text search operators: fts, plfts, phfts, wfts. These map to PostgreSQL's to_tsquery, plainto_tsquery, phraseto_tsquery, and websearch_to_tsquery respectively. This is the first feature to actively gate on a DB capability flag (DSQL's FTS support is different from standard PG), so it doubles as the proof-of-concept for the capabilities() pattern.

Depends on: db-capabilities loop. This loop reads ctx.dbCapabilities.supportsFullTextSearch.

## Background

PostgREST syntax: ?column=fts.search term, ?column=plfts(english).phrase here, etc.

The operator suffix controls which tsquery parser Postgres uses:
  fts      → to_tsquery            (boolean operators: & | !)
  plfts    → plainto_tsquery        (plain words, no operators)
  phfts    → phraseto_tsquery       (phrase proximity)
  wfts     → websearch_to_tsquery   (Google-like: quotes, OR, -)

Optional language config: ?col=plfts(english).query. Default is whatever postgres has as default_text_search_config (usually 'english').

Supabase-js passes the string through; .textSearch() method exists but the operator chain ends up the same.

Reference: PostgREST docs https://postgrest.org/en/v12/references/api/tables_views.html#fts.

## What to build

1. src/rest/query-parser.mjs — add fts, plfts, phfts, wfts to VALID_OPERATORS (around line 9-11). Extend parseFilter() to handle the optional (language) syntax: regex /^(fts|plfts|phfts|wfts)(\\(([a-z_]+)\\))?$/ matches 'fts', 'fts(english)', 'plfts(simple)', etc.

2. src/rest/sql-builder.mjs — emit the tsquery function call and @@ operator:
     SELECT ... WHERE "col" @@ to_tsquery('english', $1)
     SELECT ... WHERE "col" @@ plainto_tsquery($1)   -- no lang
   Map operator suffix to function name. Language, when present, is the first argument (parameterized as a bind? no — language is an identifier-like value; Postgres requires a regconfig cast. Parameterize the search term only, keep the language as a validated literal: to_tsquery('english'::regconfig, $1).)

3. Language safelist: allow only known Postgres text-search configs. Allowlist starts with: simple, english, spanish, french, german, portuguese, italian, russian, dutch. Reject unknown with PGRST100 'unsupported FTS language "x"'.

4. Capability gate: if ctx.dbCapabilities.supportsFullTextSearch === false, return PGRST501 'full-text search is not supported on this database'. If supportsFullTextSearch === 'partial', log a warning in non-production mode but proceed.

## DB specialization: this is where the capabilities flag earns its keep

DSQL's current FTS support: confirm before writing the capability value. Likely findings (verify):
  - to_tsquery/@@ and the four tsquery-variant functions — supported.
  - GIN indexes for tsvector columns — may or may not be supported (check).
  - Custom text-search configs (CREATE TEXT SEARCH CONFIGURATION) — likely not supported.
  - The built-in 'english' config — available.

If DSQL supports enough for basic FTS, set supportsFullTextSearch: true. If some facet is missing, set to 'partial' with a companion flag (e.g., supportsFtsCustomConfigs: false).

The goal is NOT to make the engine handle every DSQL quirk. The goal is to tell the user up front (via a clear error) when their query hits an unsupported facet, instead of the raw Postgres error bubbling up.

## Testing

Unit tests (query-parser):
- fts, plfts, phfts, wfts parse as operators.
- fts(english).query extracts the language.
- Unknown language: rejected with PGRST100.

Unit tests (sql-builder):
- Each operator emits the correct tsquery function.
- Language passed as regconfig cast.
- Parameter numbering continues correctly.

Integration tests against real Postgres:
- Seed a table with a tsvector column, search with each operator, verify rows match.
- Language-specific search produces expected result for stemmed words.
- Unsupported language rejected at the handler level.

Capability-flag tests (using a mock provider with supportsFullTextSearch: false):
- Any FTS request returns PGRST501 with a helpful message.

## Out of scope for this loop

- The 'column->>json_field' path for searching JSON content.
- Ranking (ts_rank, ts_rank_cd).
- Highlighting (ts_headline).
- Building tsvector at query time vs relying on a stored tsvector column.

## Critical rules

- Language is validated against an allowlist, not interpolated.
- Search term is always a bind parameter.
- Capability gate before SQL generation.
- No DSQL-specific SQL in the main code path — everything branches through the capability flag.
- Parameterized, Node.js only, supabase-js compat.