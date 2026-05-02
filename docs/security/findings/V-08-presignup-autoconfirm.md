# V-08 — Cognito presignup trigger auto-confirms all users

- **Severity (reported):** Medium
- **Status:** Fixed
- **Affected (reported):** `src/presignup.mjs:1-5`, `deploy/aws-sam/lambda.mjs:35-42`
- **Backend dependence:** No (DB-agnostic); **auth-provider dependent — Cognito only**

## Report summary

Cognito pre-signup trigger automatically confirms all users and verifies their email without any actual email verification. Anyone can sign up with any email address (including emails they don't own) and immediately get a confirmed account. If Cedar policies use email-based access control, the attacker gains those permissions.

## Our analysis

**Status: fixed at HEAD.**

The pre-signup trigger (`deploy/aws-sam/lambda.mjs:35-42`) unconditionally set `autoConfirmUser = true` and `autoVerifyEmail = true` on every Cognito sign-up event. This was originally shipped as a developer convenience to avoid requiring email verification during initial setup.

However, pgrest-lambda is a framework — the pre-signup trigger shipped as part of the reference SAM deployment and was wired into the Cognito UserPool's `LambdaConfig.PreSignUp`. Consumers deploying with the default template inherited this insecure behavior without an explicit opt-in.

Related: `gotrue.mjs` (now deleted) had an analog where `email_confirmed_at` defaulted to `now()` in the auth schema. The replacement better-auth provider does not auto-confirm emails.

**Fix surface:** three changes:
1. Removed the `presignup` export from `deploy/aws-sam/lambda.mjs`.
2. Removed the `PreSignUpFunction` and `PreSignUpPermission` resources from `deploy/aws-sam/template.yaml`.
3. Removed the `LambdaConfig.PreSignUp` reference from the `UserPool` resource in the SAM template.

The Cognito provider (`src/auth/providers/cognito.mjs`) remains fully functional as an opt-in extension — only the insecure auto-confirm trigger was removed. Consumers who choose `AuthProvider=cognito` now get standard Cognito email verification flow (which requires configuring SES or Cognito's built-in email).

The SAM template default was also changed from `AuthProvider=cognito` to `AuthProvider=better-auth`, making the DB-native auth provider the out-of-box experience.

## Decision

Fixed. Removed the pre-signup auto-confirm trigger entirely from the reference deployment. Cognito users now get standard email verification. Framework consumers who explicitly need auto-confirm can add their own pre-signup trigger to their infrastructure.

## Evidence

- PreSignUp trigger removed from `deploy/aws-sam/lambda.mjs`
- `PreSignUpFunction`, `PreSignUpPermission` resources removed from `deploy/aws-sam/template.yaml`
- `LambdaConfig.PreSignUp` removed from `UserPool` in `deploy/aws-sam/template.yaml`
- SAM template `AuthProvider` default changed from `cognito` to `better-auth`
- `gotrue-response.mjs` renamed to `supabase-response.mjs` (legacy naming cleanup)
- GoTrue deploy path removed from documentation

## Residual risk

Consumers who explicitly deploy with `AuthProvider=cognito` must configure Cognito email verification (SES integration or Cognito built-in). If they skip this and add their own auto-confirm trigger, they accept the email-spoofing risk. This is documented in the deploy guide.

## Reviewer handoff

The Cognito pre-signup auto-confirm trigger has been removed from the reference SAM deployment. No code path in the framework auto-confirms users. The SAM template default is now `better-auth` (DB-native provider with no auto-confirm behavior). Cognito remains available as an opt-in extension with standard email verification.
