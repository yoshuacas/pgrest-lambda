---
title: Cedar equivalence
description: A second, separate measurement — for the upstream PostgREST cases whose outcome depends on SET ROLE and row-level security, does pgrest-lambda's Cedar policy layer produce the same client-visible outcome? Never added to the PostgREST pass rate.
---

# Cedar equivalence

Aurora DSQL has neither `SET ROLE` nor row-level security. PostgREST's authorization model is built on both: it assumes the role named in the JWT's `role` claim and lets PostgreSQL's own privilege system and RLS policies decide the outcome. 54 of the extracted upstream cases assert an outcome reached that way. On this architecture they can never pass by that mechanism, and they stay failures in the [PostgREST compatibility](./postgrest-compatibility.md) rate. They are not excluded from it, not marked out of scope, and not skipped.

pgrest-lambda authorizes with a Cedar policy layer instead (see [Authorization](./authorization.md)). This page reports a second measurement that asks a narrower question about those same 54 cases:

> Where the outcome is decided by an access-control decision, does a Cedar policy set standing in for the `GRANT`/`REVOKE` statement produce the same client-visible outcome — same status, same body, same asserted headers?

**Result: 24 of 28 equivalences hold. 26 of the 54 upstream cases have no fair equivalent at all.**

## This is not a pass rate

The rules this measurement is built to obey:

- **It is never added to the PostgREST pass rate, never averaged with it, and never presented as a single combined number.** Not "945 + 23", not a percentage of 1,285 + 28. Two measurements, two numbers, both reported whole.
- The 54 upstream cases behind it **remain failures** in `conformance/results/latest.json`. Nothing here changes that file.
- The upstream cases in `conformance/cases/*.json` are the spec and are not edited. The derived cases live only in `conformance/cedar/` and are generated from the upstream ones.
- A derived case copies upstream's `request` and upstream's `expected` **byte for byte**. Only the authorization mechanism changes. A different status, body or header is a *failing* equivalence and is reported failing, never softened into a pass. `conformance/cedar/__tests__/derive.test.mjs` asserts the byte-for-byte copy, field by field, so the derivation cannot quietly relax an expectation.
- There is no `skip` verdict. A derived case either holds or diverges; it cannot leave the denominator at run time.

The denominator is 28 — the derived cases, all of which ran. The 26 cases with no fair equivalent are reported beside it and counted in neither the numerator nor the denominator, in the same way the compatibility report holds blocked cases outside its rate. Each carries a written reason.

## What holds

24 equivalences hold. 23 are grant equivalences: upstream expects `200` because a role holds a privilege, and substituting a Cedar `permit` for the `GRANT` produces the same `200` and the same body. The 24th is a denial — `Cedar:AuthSpec:41`, an anonymous call of a function `REVOKE`d from `PUBLIC`, which asserts the status alone and began holding once Cedar denials took upstream's `401`/`403` split (see below).

| Derived cases | Upstream mechanism | Cedar mechanism |
|---|---|---|
| `Cedar:AsymmetricJwtSpec:29`, `:38`, `Cedar:AudienceJwtSecretSpec:73`, `:126`, `:138`, `:150`, `:169`, `:181`, `:194`, `:206`, `:218`, `:230`, `:242`, `Cedar:AuthSpec:73`, `:78`, `:84`, `:91`, `:142`, `:236`, `:238`, `Cedar:BinaryJwtSecretSpec:23`, `Cedar:NoAnonSpec:18` | `GRANT ALL ON TABLE authors_only TO postgrest_test_author` (`conformance/fixtures/dsql/06-privileges.sql:40`), reached by `SET ROLE` from the JWT `role` claim | `permit(principal is PgrestLambda::User, action in [select, …], resource is PgrestLambda::Row) when { principal.role == "postgrest_test_author" && context.table == "authors_only" }` |
| `Cedar:AuthSpec:45` | `REVOKE EXECUTE ON FUNCTION privileged_hello(text) FROM PUBLIC` then `GRANT EXECUTE TO postgrest_test_author` (`06-privileges.sql:54-57`) | `permit(… action == call, resource == PgrestLambda::Function::"privileged_hello") when { principal.role == "postgrest_test_author" }` |

### What a holding grant equivalence does not show

Every derived case carries its own `doNotRead` line in `conformance/cedar/cases.json`. For the 22 table-read equivalences it reads:

> The engine did not verify this token — the harness supplies the identity from the payload — so a pass means only that a Cedar permit replaced a table-level `GRANT` on an empty table, not that any RLS policy or row filter was exercised.

Three specifics worth stating plainly:

- **`authors_only` is empty in the fixtures.** These cases assert `200` with body `[]`. The equivalence shows that authorization let the request through, not that any row was correctly filtered.
- **The identity is not verified by the engine.** The conformance harness builds the API Gateway authorizer context by decoding the JWT payload, exactly as it does for the PostgREST measurement. So these cases measure the authorization decision downstream of identity, not the token check.
- **Cedar's `Function` permits are per function name, not per overload.** Upstream's `GRANT` names `privileged_hello(text)`.

## What diverges: 4 denials, in two unrelated classes

The first measurement of this page found 5 divergences with one root cause: the Cedar layer answered every denial `403`, where PostgREST answers `401` with `WWW-Authenticate: Bearer` for a caller that is anonymous. That was a wire-compatibility defect rather than a difference of opinion — `@supabase/supabase-js` reads `401` as "refresh the token and retry" — and the engine already made the same distinction for a real PostgreSQL `42501` in `src/rest/errors.mjs` (`authed ? 403 : 401`) while `src/rest/cedar.mjs` bypassed it.

**That is now fixed.** Every Cedar denial goes through one `denyError()` helper that takes upstream's split. `Cedar:AuthSpec:41` holds as a result, and `Cedar:AuthSpec:16` gained the right status and the `WWW-Authenticate` header. 4 divergences remain, and they no longer share a cause:

| Derived case | Kind | Upstream | pgrest-lambda + Cedar |
|---|---|---|---|
| `Cedar:AuthSpec:16` | `body` | `401` + `WWW-Authenticate: Bearer`, body `{"code":"42501","message":"permission denied for table authors_only",…}` | same `401` and same header; body `{"code":"PGRST403","message":"Not authorized: role='anon' action='select' table='authors_only'…"}` |
| `Cedar:AuthSpec:130` | `identity-mapping` | `401` — the token carries no `role` claim, so PostgREST falls back to `db-anon-role` and denies an *anonymous* caller | `403` — the engine reads a role-less token as `authenticated` and denies an *authenticated* caller |
| `Cedar:AuthSpec:135` | `identity-mapping` | `401`, same fallback (token carries `id` but no `role`) | `403`, same reading |
| `Cedar:ErrorSpec:123` | `identity-mapping` | `401`, body `{"code":"22023","message":"role \"not existing\" does not exist"}` — `SET ROLE` fails before any privilege is consulted | `403`, body `{"code":"PGRST403",…}` — the role is simply one that holds no permit |

The remaining single-case divergence is a body: **the engine names the policy set where PostgREST forwards the database's error.** Upstream reports SQLSTATE `42501` and `permission denied for table authors_only` because PostgreSQL raised it; a Cedar denial has no SQLSTATE, and reporting `42501` for a denial no database raised would be mimicry — it would tell an operator to look at `GRANT`s that do not decide anything here. This one is left diverging on purpose.

The three `identity-mapping` divergences are **not** denial-shape gaps, and the runner no longer labels them as such (`conformance/cedar/run.mjs` `divergenceKind`, keyed off `identityDiffers` in `conformance/cedar/equivalence-map.mjs`). Each side returns the correct status *for the identity it resolved*; the two sides resolve different identities. For `:130` and `:135` that is a real difference in the engine's auth contract — what role a token with no `role` claim gets — and changing it to close two equivalences would be tuning identity semantics for a score. For `ErrorSpec:123` no policy engine can close it: Cedar's principal set is open, so "role does not exist" and "role holds no grant" are indistinguishable (pinned by a unit test in `conformance/cedar/__tests__/policies.test.mjs`).

This remains the most useful finding on the page: **the Cedar layer reaches the same allow/deny decision as `SET ROLE` plus table privileges on this group.** It now also reports the denial with the same status and challenge header, and differs only in the error body and in who it thinks an unlabelled caller is.

## What has no fair equivalent

26 of the 54, in four classes. `conformance/cedar/equivalence-map.mjs` carries the full reason and caveat for each.

| Class | Cases | Why no Cedar policy set can stand in |
|---|---|---|
| `jwt-verification` (16) | `AuthSpec:96`, `:108`, `:119`, `:152`, `:164`, `:176`, `:188`, `:200`, `ErrorSpec:53`, `:110`, `:138`, `:152`, `:166`, `:193`, `:205`, `:217` | The asserted `401` comes from JWT decoding and claim validation *before* any role is assumed — empty token, expired, two segments, `exp` as a string, `alg: none`. No privilege is ever consulted upstream, and no policy set can make an engine reject a token. These cases carry the `no-set-role` gap only because the harness supplies the authorizer identity from the unverified payload, so the request reaches the authorization layer at all. The engine has its own JWT verification path; it is simply not the mechanism under test here. |
| `session-identity-guc` (5) | `AuthSpec:68`, `:209`, `:218`, `:227`, `RpcSpec:923` | The function under test returns `current_user`, or reads `current_setting('request.jwt.claims')` / `request.headers`. Cedar decides permit/forbid and, for reads, contributes a `WHERE` fragment. It never changes the PostgreSQL session role and cannot create a namespaced run-time parameter. `AuthSpec:227` additionally asserts a `P0001` raised by a plpgsql pre-request function, which DSQL cannot run and a Cedar denial cannot impersonate. |
| `column-level-privilege` (3) | `DeleteSpec:124`, `InsertSpec:716`, `InsertSpec:724` | **A genuine capability gap.** Upstream grants the role `DELETE`/`INSERT` on the table but `SELECT` on only some columns, so the write succeeds and returning the representation is denied on a column. The Cedar model in `src/rest/cedar.mjs` authorizes actions against `PgrestLambda::Table` / `::Row` / `::Function` and contributes row predicates; nothing in it names a column as a resource. There is no policy set that permits the write and denies the column. |
| `extraction-defect` (2) | `AudienceJwtSecretSpec:32`, `:85` | The harness paired each assertion with the JWT payload of the *following* `it` block. The assertion at upstream line 32 belongs to `it "succeeds when the audience claim matches"` (`aud: "youraudience"`), but the extracted request carries `aud: "notyouraudience"`. The engine runs this spec with `jwt-aud=youraudience` and answers `401 JWT not in audience` — which is what upstream would answer to the request *as extracted*. Asserting `200` for it contradicts upstream's own behaviour, so making it hold would mean disabling audience checking, which is weakening the expectation. The grant these two would have measured is already measured by their eleven cleanly-extracted siblings. |

Note the asymmetry: the `jwt-verification` and `session-identity-guc` classes say the upstream case is not about authorization; the `column-level-privilege` class says it *is* about authorization and the Cedar layer cannot express it. Only the third is a finding about the engine.

## The policy set

Two files, `conformance/cedar/policies/00-anon.cedar` and `10-roles.cedar`. They are a translation of the privilege statements in `conformance/fixtures/dsql/06-privileges.sql` and of nothing else — no policy names a status code or a response body, and a unit test enforces that. What they encode:

- `GRANT ALL PRIVILEGES ON ALL TABLES … TO postgrest_test_anonymous`, minus the `REVOKE` on `app_users`, `authors_only`, `insertonly`, `limited_article_stars`, as a permit for `PgrestLambda::AnonRole`.
- `GRANT INSERT ON TABLE insertonly TO postgrest_test_anonymous`.
- `GRANT ALL ON TABLE authors_only TO postgrest_test_author`, keyed on `principal.role`.
- `EXECUTE` on functions being `PUBLIC` by default, minus the `REVOKE` on `privileged_hello`.
- **Deliberately absent:** any table grant for a role other than `postgrest_test_author`. Upstream's `roles.sql` creates the three test roles with no membership between them, so a token claiming any other role holds no table privilege in the upstream fixture either.

### One hazard worth knowing

Every table rule keys on `context.table`, never on `resource == PgrestLambda::Table::"…"`. A read, update or delete is authorized by partial evaluation with the resource left unknown, so an entity-literal `==` in the policy scope survives as a residual that the residual-to-SQL translator cannot express: the request fails with `500 PGRST000` instead of being allowed. Building this policy set also turned up the reason that was worse than intermittent: `buildAuthzFilter` returned as soon as it saw a permit residual that was trivially true, which made the outcome depend on residual order and, in the same move, discarded every `forbid` in the policy set. That is fixed — forbids are now translated before any permit can end the scan — and the fix carries its own regression tests in `src/rest/__tests__/cedar.test.mjs` and `cedar.integration.test.mjs`. What remains true is the advice: key table rules on `context.table`. A unit test asserts no equivalence policy uses the entity-literal form.

## How to reproduce

```bash
export DSQL_ENDPOINT=<your-cluster>.dsql.us-east-1.on.aws
export REGION_NAME=us-east-1                     # never AWS_REGION
export PGREST_RELATIONSHIPS_PATH=conformance/fixtures/relationships.json

# 1. Load the fixtures. These are the PostgREST measurement's own fixtures,
#    unchanged, so a cluster already loaded for that measurement needs nothing.
#    A full load rewrites conformance/fixtures/load-report.json.
node conformance/fixtures/load.mjs

# 2. Confirm the derived cases are current with the upstream cases.
node conformance/cedar/derive.mjs --check

# 3. Measure.
node conformance/cedar/run.mjs --target dsql
```

The runner writes `conformance/cedar/results/latest.json` plus a timestamped copy, and prints:

```
24/28 equivalences hold, 26 upstream cases have no fair equivalent
  diverges:   1  body
  diverges:   3  identity-mapping
  no equivalent:   2  extraction-defect
  no equivalent:   5  session-identity-guc
  no equivalent:  16  jwt-verification
  no equivalent:   3  column-level-privilege
```

A single equivalence: `node conformance/cedar/run.mjs --target dsql --id Cedar:AuthSpec:73`. `--id` also accepts a prefix or the upstream id it mirrors. `--list` prints the selection without running it.

Every derived case in this set is a read or an RPC call, so the run does not write to the fixtures; the runner refuses to start if a derived case ever would. That means it can share a cluster with the PostgREST measurement without disturbing it.

The numbers on this page come from `conformance/cedar/results/latest.json` (run `2026-08-21T12:29:27Z`, commit `2488109`, target `dsql`). Three earlier runs are kept beside it, and the differences between them are code, not noise: the two runs at commit `acd3b91` measured the engine before Cedar denials took upstream's `401`/`403` split and both reported 23 holds with 5 `deny-status-401-vs-403` divergences. The run at `ebf0c88` reported the same 24 holds and the same four divergences as this one, case for case — it predates the `forbid`-discard fix described above, which changed nothing here because the equivalence policy set contains no `forbid`. That is worth stating rather than leaving implied: this measurement did not exercise the bug it helped find. Unlike the PostgREST measurement, this set contains no row-order-dependent cases, so repeated runs of the same tree agree case for case and there is no run-to-run spread to allow for — which is why a changed number here is attributable to a changed engine. The engine configuration is identical to `conformance/runner/run.mjs`'s except for `policies`, which points at the equivalence policy set instead of the shipped default; holding everything else constant is what makes the two measurements comparable case by case. The comparison itself is the PostgREST runner's own `compare()`, imported rather than reimplemented, so a private copy cannot drift into being laxer.

## The caveat that matters most

**An equivalence assessed by the same project that built both sides is weaker evidence than an upstream test passing unmodified.**

The PostgREST pass rate has an external referee: PostgREST's own test suite wrote the assertion, and the engine either matches it or does not. Nothing in this repository can argue with it.

This measurement has no such referee. This project chose which upstream cases were "about authorization", wrote the policy set that stands in for the `GRANT`, and wrote the runner that grades the result. Three of those four judgements are ours. The guards below narrow the room for self-flattery; they do not eliminate it:

- the request and the expectation are copied from the upstream case byte for byte, and a unit test proves it;
- the policy set is a translation of the fixture's `GRANT`/`REVOKE` statements, traceable line by line to `06-privileges.sql`, and names no status code;
- the comparison is the PostgREST runner's, imported;
- there is no skip verdict, and the 26 non-equivalences are itemised with reasons rather than dropped.

What remains ours is the judgement of which cases are "about authorization" at all. Read the four `no fair equivalent` classes as the place where that judgement was exercised, and read the `doNotRead` line on each derived case as the limit of what its passing shows. If you need a number with an external referee, use the PostgREST pass rate — where these 54 cases are, and remain, failures.
