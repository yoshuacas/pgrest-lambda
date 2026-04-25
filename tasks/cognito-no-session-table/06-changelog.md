# Task 06 — Update CHANGELOG

Agent: implementer
Design: docs/design/cognito-no-session-table.md
Depends on: Task 03, Task 04, Task 05

## Objective

Correct the v0.2.0 CHANGELOG entry that incorrectly states
Cognito deployments require a PostgreSQL database for session
storage, and add an entry for this change.

## Target tests

None — this is a documentation-only task.

## Implementation

### CHANGELOG.md

1. In the **Breaking** section of 0.2.0, remove or amend the
   sentence: "Cognito deployments now require a PostgreSQL
   database for session storage (`auth.sessions` table)."

   Replace with: "Refresh tokens issued before this version
   are rejected on upgrade. Clients must re-authenticate."
   (Remove the second sentence about Cognito requiring a
   PostgreSQL database.)

2. Under **Unreleased**, add:

   ```
   ### Fixed
   - **Cognito path no longer requires `auth.sessions` table** —
     the handler now checks `provider.needsSessionTable` and
     skips session creation, lookup, and revocation for
     providers that manage their own refresh tokens (Cognito).
     The Cognito refresh token is returned directly to the
     client. GoTrue path is unchanged.
   ```

## Acceptance criteria

- The v0.2.0 Breaking section no longer claims Cognito needs
  a PostgreSQL database for session storage.
- The Unreleased section documents the fix.
- No other CHANGELOG content is modified.

## Conflict criteria

- If the CHANGELOG has already been updated for this change,
  verify the content matches the design and skip.
