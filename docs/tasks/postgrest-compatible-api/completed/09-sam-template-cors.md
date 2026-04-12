# Task 09: SAM Template CORS Update

**Agent:** implementer
**Design:** docs/design/postgrest-compatible-api.md
**Depends on:** Task 08 (handler wired up)

## Objective

Update the SAM template `plugin/templates/backend.yaml` to
include PATCH in AllowMethods, additional headers in
AllowHeaders, and Content-Range in ExposeHeaders for API
Gateway CORS configuration.

## Target Tests

No automated tests target this directly (SAM template changes
are validated at deploy time). Verify manually that the YAML
is valid after editing.

## Implementation

Edit `plugin/templates/backend.yaml` CORS configuration:

1. **AllowMethods:** Add `PATCH` to the existing methods list.
   Before: `GET,POST,PUT,DELETE,OPTIONS`
   After: `GET,POST,PATCH,PUT,DELETE,OPTIONS`

2. **AllowHeaders:** Add `Prefer`, `Accept`, `apikey`, and
   `X-Client-Info` to the existing headers list.
   Before: `Content-Type,Authorization`
   After: `Content-Type,Authorization,Prefer,Accept,apikey,X-Client-Info`

3. **ExposeHeaders:** Add `Content-Range` (may need to add
   this property if it doesn't exist).

These are additive changes — no existing values are removed.

## Acceptance Criteria

- `backend.yaml` is valid YAML after editing.
- CORS config includes all required methods and headers.
- No existing CORS values are removed.

## Conflict Criteria

- If the CORS section in `backend.yaml` has a different
  structure than expected (e.g., uses a different property
  name or format), investigate the actual structure and
  adapt the edit accordingly rather than escalating.
- If `backend.yaml` already includes all the required CORS
  values, verify and mark complete.
