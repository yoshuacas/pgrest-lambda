# V-21 — Refresh token rotation race window

- **Severity (reported):** Info
- **Status:** Open
- **Affected (reported):** `src/auth/providers/gotrue.mjs:101-146`
- **Backend dependence:** No (DB-agnostic); **GoTrue provider only**

## Report summary

Read–revoke is not atomic. Two concurrent refreshes can both SELECT the unrevoked token before either UPDATE revokes it. Existing reuse detection catches the second-attempt-after-revoke case, but the simultaneous window produces two "valid" refreshes.

## Our analysis

**Status: mostly mitigated at HEAD, but race window remains.**

`src/auth/providers/gotrue.mjs:101-146` is more defensive than the audit claims:
- Line 105-109: SELECT for the token.
- Line 119-129: if `revoked`, cascade-revoke the whole family.
- Line 136-140: UPDATE to revoke the current token.
- Line 142-146: INSERT the new token.

The SELECT → UPDATE sequence is still not atomic — two concurrent refreshes both read `revoked=false` and each succeeds in revoking + issuing a new token. Reuse detection catches a *subsequent* use of the old token but not the simultaneous window.

Impact is smaller than a full bypass: attacker needs to race the legitimate holder; outcome is two valid sessions briefly coexisting.

**Fix surface:** single atomic statement:
```sql
UPDATE auth.refresh_tokens
SET revoked = true, updated_at = now()
WHERE id = $1 AND revoked = false
RETURNING user_id
```
Zero rows returned → someone else won; throw invalid_grant. One row returned → proceed with insert.

## Decision

_Pending triage._

## Evidence

_Commit / test / doc link when fixed._

## Residual risk

None once atomic.

## Reviewer handoff

_Two-sentence summary for the reviewer agent._
