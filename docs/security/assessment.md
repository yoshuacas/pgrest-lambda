# pgrest-lambda Security Assessment

Master tracker for the security audit findings (source: `research/pgrest-lambda-security-report.html`, dated 2026-04-17, against commit `25c090f`). This is the living working doc the team uses to triage findings, record decisions, and hand off to the security reviewer agent. Everything under `docs/security/findings/` is per-finding detail.

## Status legend

| Status | Meaning |
|---|---|
| Open | Not yet triaged or analysis incomplete |
| Fixed | Addressed at HEAD, with evidence (commit / test / doc link) |
| Accepted | Knowingly not addressed; rationale + documented risk transfer to library consumer |
| Invalid | Claim does not hold against current code or threat model |
| Deferred | Real issue, scheduled for later phase with a target milestone |
| N/A (backend) | Mitigation depends on a capability only some supported DB backends expose (see backend matrix) |

## Backend capability matrix

pgrest-lambda is a library: one code path, multiple deployment targets. Several findings land differently depending on the underlying Postgres. We track capability explicitly and document residual risk to library consumers rather than forcing a lowest-common-denominator posture.

| Capability | DSQL | Aurora Postgres / RDS | Standard Postgres (self-managed) |
|---|---|---|---|
| Row-Level Security (RLS) / `CREATE POLICY` | No | Yes | Yes |
| `SET ROLE` / per-request session role | Limited | Yes | Yes |
| Session GUCs for request context | Limited | Yes | Yes |
| TLS to DB | Required (AWS-managed certs) | Yes (RDS CA bundle) | Depends on config |
| IAM auth | Yes | Optional | No |
| `pg_proc` / RPC functions | No | Yes | Yes |

Rule: when a finding's fix relies on a capability not present on all supported backends, we take the strongest fix that works everywhere (application-layer), and **document the residual risk per backend** so library consumers can opt into the stronger posture (e.g., turning on RLS in Aurora) with eyes open.

## Findings index

| ID | Severity | Finding | Status | Notes |
|---|---|---|---|---|
| [V-01](findings/V-01-jwt-secret-strength.md) | Critical | No JWT secret strength enforcement | Fixed | Closes V-01; `assertJwtSecret` enforced at all entry points |
| [V-02](findings/V-02-jwt-algorithm-pinning.md) | Critical | JWT algorithm not pinned | Fixed | Pinned HS256 at all sign/verify sites via shared constant |
| [V-03](findings/V-03-cors-wildcard.md) | High | CORS wildcard with header-based auth | Fixed | Configurable CORS origin with production guardrail |
| [V-04](findings/V-04-ssl-cert-validation.md) | High | SSL cert validation disabled | Open | **Worse than audit:** opting into TLS still disables verify |
| [V-05](findings/V-05-on-conflict-injection.md) | High | Identifier injection via `on_conflict` | Open | Confirmed at HEAD |
| [V-06](findings/V-06-no-rls.md) | High | Cedar is the only authz layer (no RLS) | Open | Backend-specific; DSQL cannot satisfy. Flag: possible fail-open at `cedar.mjs:386-388` |
| [V-07](findings/V-07-provider-refresh-in-jwt.md) | High | Provider refresh token in JWT `prt` claim | Open | Cognito provider only (GoTrue path does not set `prt`) |
| [V-08](findings/V-08-presignup-autoconfirm.md) | Medium | Cognito presignup auto-confirm | Open | Cognito provider only; GoTrue analog at `schema.mjs:8` |
| [V-09](findings/V-09-error-leaks.md) | Medium | PG error details forwarded to client | Open | Confirmed at HEAD |
| [V-10](findings/V-10-openapi-exposes-schema.md) | Medium | OpenAPI exposes full schema to anon | Open | Confirmed; no role check |
| [V-11](findings/V-11-refresh-no-authz.md) | Medium | `/_refresh` has no authz check | Open | Confirmed at HEAD |
| [V-12](findings/V-12-auth-no-rate-limit.md) | Medium | No rate limiting on auth endpoints | Open | Infra-layer fix |
| [V-13](findings/V-13-embed-depth.md) | Medium | Unbounded resource embedding depth | Open | Confirmed; no depth arg |
| [V-14](findings/V-14-order-direction.md) | Medium | Order direction not validated | Open | **Real injection:** `order=col.asc;DROP…` survives dot-split |
| [V-15](findings/V-15-schema-cache-race.md) | Low | Schema cache TOCTOU race | Open | Confirmed; TTL now 30s |
| [V-16](findings/V-16-cedar-observability.md) | Low | No Cedar authz logging | Open | Pairs with V-23 |
| [V-17](findings/V-17-cognito-id-unverified.md) | Low | Cognito ID token parsed without sig verify | Open | Cognito provider only |
| [V-18](findings/V-18-json-parse-silent.md) | Low | JSON body parse failure silently nulls | Open | Additional 500s in auth handler |
| [V-19](findings/V-19-no-size-limits.md) | Low | No request size / bulk row limits | Open | Also: no `statement_timeout` on either adapter |
| [V-20](findings/V-20-docs-host-xss.md) | Info | XSS via Host header in `docsHtml` | Open | Confirmed at HEAD |
| [V-21](findings/V-21-refresh-token-race.md) | Info | Refresh token rotation race window | Partial | Reuse detection mitigates; race window remains |
| [V-22](findings/V-22-auth-schema-migration.md) | Info | Auth schema DDL on cold start | Open | GoTrue provider only |
| [V-23](findings/V-23-no-audit-logging.md) | Info | No audit logging system-wide | Open | Umbrella; pairs with V-16 |

## Triage workflow

1. **Freshness pass** — re-verify each finding against HEAD; update `Status` and fill the `Our analysis` section in each finding file.
2. **Per-finding triage** — decide Fix / Accept / Defer / Invalid. Record the decision + rationale. For backend-dependent findings, specify what's mitigated code-side vs. documented to the consumer.
3. **Execute fixes** — change code, add tests, reference the commit in the finding's `Evidence` section.
4. **Handoff to reviewer** — the `Reviewer handoff` section of each finding is what the security reviewer agent reads. Keep it short and decision-focused.
5. **Presentation** — assembled from the finding files once all are resolved.

## Handoff notes for the security reviewer agent

Read this section before reviewing any individual finding:

- **Scope:** library + reference deployment. pgrest-lambda is consumed as an npm package; the reference SAM deployment in `docs/deploy/` is one example, not the product.
- **DB targets are heterogeneous.** Treat the backend matrix above as authoritative. A fix that requires RLS is valid for Aurora consumers but cannot be the primary defense on DSQL — application-layer enforcement (Cedar) has to hold alone in that case.
- **Auth is pluggable.** Findings scoped to Cognito (V-08, V-17) do not affect deployments using the GoTrue-native provider, and vice versa.
- **Authoritative source of status is this tracker.** The HTML report in `research/` is a point-in-time audit snapshot; where it conflicts with a finding file here, the finding file wins.
- **Not addressed != ignored.** For items marked Accepted or Deferred, the `Residual risk` section captures what the library consumer inherits and where it's documented.
