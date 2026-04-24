# V-08 — Cognito presignup trigger auto-confirms all users

- **Severity (reported):** Medium
- **Status:** Open
- **Affected (reported):** `src/presignup.mjs:1-5`
- **Backend dependence:** No (DB-agnostic); **auth-provider dependent — Cognito only**

## Report summary

Cognito pre-signup trigger auto-confirms and auto-verifies email. Anyone can sign up as any email and get a confirmed account. Email-claim-based Cedar rules become spoofable.

## Our analysis

**Status: still open at HEAD.**

`src/presignup.mjs` (5 lines, unchanged):
```js
export async function handler(event) {
  event.response.autoConfirmUser = true;
  event.response.autoVerifyEmail = true;
  return event;
}
```

This is shipped as a Cognito trigger. GoTrue-native provider has no equivalent (GoTrue `signUp` in `gotrue.mjs:10-53` does not auto-verify; it creates a user with `email_confirmed_at` defaulted to `now()` via `schema.mjs:8` — that's a related but separate finding worth flagging during triage).

**Fix surface:** remove the trigger from the default deploy; ship as an opt-in dev convenience. Also revisit `schema.mjs:8` (`email_confirmed_at TIMESTAMPTZ DEFAULT now()`) as a possible GoTrue-side analog.

## Decision

_Pending triage._ Likely: remove default auto-confirm; make it opt-in with a loud "dev only" config flag; document.

## Evidence

_Commit / test / doc link when fixed._

## Residual risk

Consumer who explicitly opts into auto-confirm accepts the email-spoofing risk.

## Reviewer handoff

_Two-sentence summary for the reviewer agent — scope to Cognito provider._
