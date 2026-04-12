# Task 02: Key Generation Script

**Agent:** implementer
**Design:** docs/design/auth-layer.md

## Objective

Create `plugin/scripts/generate-keys.mjs`, a pure Node.js
script that generates BOA anon key and service role key JWTs
using only the `crypto` module.

## Target Tests

From `__tests__/generate-keys.test.mjs`:
- Outputs valid JSON with anonKey and serviceRoleKey
- anonKey decodes to `{role: "anon", iss: "boa"}` with
  ~10-year expiry
- serviceRoleKey decodes to `{role: "service_role", iss: "boa"}`
  with ~10-year expiry
- Both keys are verifiable with the input secret (HMAC-SHA256)
- Exits with error if no secret argument provided

## Implementation

Create `plugin/scripts/generate-keys.mjs` as specified in the
design's "Key Generation Script" section.

The script:
1. Reads `process.argv[2]` as the JWT secret.
2. Exits with code 1 and usage message to stderr if missing.
3. Implements manual JWT signing using
   `crypto.createHmac('sha256', secret)` with base64url
   encoding.
4. Signs an anon key: `{role: "anon", iss: "boa",
   exp: now + 10 years, iat: now}`.
5. Signs a service role key: `{role: "service_role",
   iss: "boa", exp: now + 10 years, iat: now}`.
6. Outputs `{"anonKey": "...", "serviceRoleKey": "..."}`
   to stdout.

**Important:** This script must have zero npm dependencies.
It runs on the developer's machine during bootstrap before
`npm install`. Use `import { createHmac } from 'node:crypto'`.

## Acceptance Criteria

- All generate-keys tests pass.
- Script runs standalone: `node generate-keys.mjs <secret>`
  produces valid output.
- No dependencies beyond Node.js built-ins.

## Conflict Criteria

- If all target tests already pass before any code changes
  are made, investigate whether the tests are true positives
  before marking the task complete.
