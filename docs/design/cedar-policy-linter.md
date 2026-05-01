# V-06a — Cedar Policy Linter

Add a Cedar policy linter as a CLI command to close the most
portable limb of security finding V-06 (High). The auditor
recommended "a policy linter/validator that warns about overly
permissive policies (e.g., no conditions on `permit`)." This
linter works across all backends (DSQL, Aurora, standard PG),
does not require an RLS/DSQL architecture split, and hardens
the primary authorization layer.

Reference: `docs/security/findings/V-06-no-rls.md`
Source: `docs/design/prompts/security-v06a-policy-linter.md`

## Overview

Ship a `pgrest-lambda lint-policies` CLI command backed by a
pure library function `lintPolicies()` in
`src/policies/linter.mjs`. The linter parses `.cedar` files
using the `@cedar-policy/cedar-wasm` APIs already depended on
by `src/rest/cedar.mjs`, converts each policy to its JSON AST,
then walks the AST to detect permissiveness and correctness
issues. Four error rules and four warning rules ship in this
first version.

Scope boundary: this is V-06a only. RLS templates (V-06b) and
the INSERT fail-open branch investigation (V-06c) are separate
tracks.

## Current CX / Concepts

### Policy Authoring Today

Developers write `.cedar` files in `policies/` (or the path
named by `POLICIES_PATH`). The runtime loads them via
`src/rest/cedar.mjs:loadPolicies()`, parses with
`@cedar-policy/cedar-wasm`, and evaluates them on every
request. If a policy has a syntax error, the runtime fails
closed (every request returns `PGRST403`). If a policy is
syntactically valid but overly permissive, nothing warns the
developer — the policy silently grants more access than
intended.

### No Pre-Deploy Validation

There is no `pgrest-lambda` command that validates policies
before deployment. The `pgrest-lambda refresh` command
reloads policies at runtime but does not lint them. A
developer can deploy an unconditional `permit(principal,
action, resource)` without any feedback that this is almost
certainly a mistake.

### Existing CLI Conventions

`bin/pgrest-lambda.mjs` defines a `COMMANDS` dispatch map:

```javascript
const COMMANDS = {
  dev: cmdDev,
  refresh: cmdRefresh,
  'migrate-auth': cmdMigrateAuth,
  'generate-key': cmdGenerateKey,
  help: cmdHelp,
  '--help': cmdHelp,
  '-h': cmdHelp,
};
```

Each command is an async function receiving `argv`. Flags are
parsed via `parseFlags(argv, spec)` with `type: 'string'`,
`type: 'number'`, and `type: 'boolean'` variants. Exit codes
are `0` (success), `1` (runtime error), and `2` (usage error).

### Cedar WASM API Surface

The project imports from `@cedar-policy/cedar-wasm/nodejs`.
Relevant functions for the linter:

- `checkParsePolicySet(policies)` — returns `CheckParseAnswer`
  (`{ type: "success" }` or `{ type: "failure", errors }`).
  Validates syntax without evaluating.
- `policySetTextToParts(policyText)` — splits a multi-policy
  string into individual policy strings. Returns
  `{ type: "success", policies: string[], policy_templates: string[] }`
  or `{ type: "failure", errors: DetailedError[] }`.
- `policyToJson(policy)` — parses a single policy (string or
  `PolicyJson`). Returns `PolicyToJsonAnswer`:
  `{ type: "success", json: PolicyJson }` or
  `{ type: "failure", errors: DetailedError[] }`.
  Note: the `PolicyJson` is nested under the `.json` key
  of the success response.
  ```typescript
  interface PolicyJson {
    effect: "permit" | "forbid";
    principal: PrincipalConstraint;
    action: ActionConstraint;
    resource: ResourceConstraint;
    conditions: Clause[];
    annotations?: Record<string, string>;
  }
  ```

  Constraint types:
  ```typescript
  type PrincipalConstraint =
    | { op: "All" }
    | { op: "==", entity: EntityUidJson }
    | { op: "==", slot: string }
    | { op: "in", entity: EntityUidJson }
    | { op: "in", slot: string }
    | { op: "is", entity_type: string, in?: PrincipalOrResourceInConstraint };

  type ResourceConstraint = /* same shape as PrincipalConstraint */;

  type ActionConstraint =
    | { op: "All" }
    | { op: "==", entity: EntityUidJson }
    | { op: "==", slot: string }
    | { op: "in", entity: EntityUidJson }
    | { op: "in", entities: EntityUidJson[] };

  type Clause =
    | { kind: "when", body: Expr }
    | { kind: "unless", body: Expr };
  ```

- `SourceLabel` on errors (extends `SourceLocation`):
  `{ start: number, end: number, label: string | null }`
  with `start`/`end` as byte offsets into the source string.
  `DetailedError.sourceLocations` is `SourceLabel[]`.
  The linter converts `start` offsets to line numbers using
  the source text.

### Default Policies

`policies/default.cedar` contains three policies:

1. Authenticated users read/update/delete own rows (has a
   `when` clause, principal narrowed to `User`, resource
   narrowed to `Row`).
2. Authenticated users insert into any table (principal
   narrowed to `User`, action narrowed to `insert`, resource
   narrowed to `Table`). No `when` clause, but all three
   scope slots are narrowed — this is intentional.
3. Service role bypass — `permit` with `principal is
   PgrestLambda::ServiceRole` but unscoped action and resource.
   Because the principal IS narrowed (`op: "is"`, not
   `op: "All"`), this policy does not trigger E001 in the
   first place — E001 requires all three scope slots to be
   `op: "All"`. The `isServiceRoleBypass` exception exists
   as a defense-in-depth guard for future policy shapes where
   someone might write an unconditional permit annotated for
   service-role use without narrowing the principal type.

The linter must report zero findings on this file.

## Proposed CX / CX Specification

### Command Syntax

```
pgrest-lambda lint-policies [options]

Flags:
  --path <path>         Directory or URI of .cedar files.
                        Default: $POLICIES_PATH or ./policies.
  --format <fmt>        "text" (default) or "json".
  --max-severity <lvl>  "error" (default), "warn", or "off".
  --quiet               Suppress output when no findings.
```

### Exit Codes

| Code | Meaning |
|---|---|
| `0` | No findings above the severity threshold (or `--max-severity=off`). |
| `1` | One or more findings at or above the severity threshold. |
| `2` | Usage error: policy directory missing, unreadable, no `.cedar` files, or invalid flags. |

### Lint Rules

#### Errors (exit non-zero by default)

| Rule ID | Name | Trigger |
|---|---|---|
| `E001` | unconditional-permit | `permit` where all of `principal`, `action`, and `resource` have `op: "All"` (no type narrowing) AND the policy has no `when`/`unless` clause. Exception (defense-in-depth): policy whose `principal` constraint is `op: "is"` with `entity_type` ending in `ServiceRole`, or `op: "=="` with an entity whose `type` ends in `ServiceRole`, or policy annotated with `@lint_allow("unconditional-permit")`. Note: the default service-role bypass in `policies/default.cedar` narrows `principal` to `is PgrestLambda::ServiceRole` (`op: "is"`), so it does not match the trigger condition regardless of the exception. |
| `E002` | tautological-when | `permit` with a `when` clause whose body is a literal `true` (`{ Value: true }`), or a comparison of two identical literals (`{ "==": { left: { Value: X }, right: { Value: X } } }` where X === X). |
| `E003` | syntax-error | Cedar parse error from `checkParsePolicySet` or `policyToJson`. |
| `E004` | unknown-action | Action constraint references `PgrestLambda::Action::"<x>"` where `<x>` is not one of `select`, `insert`, `update`, `delete`, `call`. |

#### Warnings (advisory, do not cause exit 1 by default)

| Rule ID | Name | Trigger |
|---|---|---|
| `W001` | principal-type-missing | `permit` or `forbid` where `principal` has `op: "All"` (bare `principal` with no `is` or `==` narrowing). |
| `W002` | resource-type-missing | `permit` or `forbid` where `resource` has `op: "All"` (bare `resource` with no `is` or `==` narrowing). Exception: service-role bypass policies (detected by `isServiceRoleBypass`) are exempt — the service role intentionally covers all resource types. |
| `W003` | missing-has-guard | A `when` clause body (recursively) contains `resource.<col>` (an attribute access on the resource via `{ ".": { left: { Var: "resource" }, attr: "<col>" } }`) but no corresponding `resource has <col>` expression (`{ has: { left: { Var: "resource" }, attr: "<col>" } }`) appears in the same `when` body's AND-chain. |
| `W004` | unscoped-forbid | `forbid` where all of `principal`, `action`, and `resource` have `op: "All"` AND the policy has no `when`/`unless` clause. This blocks every caller from everything. |

### Service-Role Bypass Exception

Rules `E001` and `W002` must not fire on the service-role
bypass in `policies/default.cedar`. The `isServiceRoleBypass`
helper returns `true` when either:

1. The `principal` constraint has `op: "is"` with
   `entity_type` ending in `ServiceRole` (covers
   `PgrestLambda::ServiceRole`), OR
2. The `principal` constraint has `op: "=="` with an entity
   whose `type` ends in `ServiceRole`.

`E001` uses `isServiceRoleBypass` as a defense-in-depth
guard (see note in the E001 trigger). `W002` uses it to
avoid warning about unscoped `resource` on the service-role
bypass, which intentionally covers all resource types.

Additionally, any policy can suppress a specific rule by
adding a Cedar annotation:

```cedar
@lint_allow("unconditional-permit")
permit(
    principal is PgrestLambda::ServiceRole,
    action,
    resource
);
```

The `@lint_allow` annotation accepts a comma-separated list
of rule IDs. Suppressed rules are not reported for that
policy and do not affect the exit code.

### Text Output Format

One finding per line:

```
<file>:<line> <severity> <rule-id> <message>
```

Summary footer (always printed unless `--quiet` and zero
findings):

```
N policies scanned, E errors, W warnings
```

Example session with findings:

```
$ pgrest-lambda lint-policies --path ./policies
policies/custom.cedar:3 error E001 Unconditional permit — \
  no conditions and no principal/action/resource narrowing. \
  Add a when clause or narrow the scope.
policies/custom.cedar:10 warn W001 Principal type missing \
  — policy applies to all principal types including anon. \
  Add 'principal is PgrestLambda::User' or similar.
2 policies scanned, 1 error, 1 warning
```

Example clean run (against default `./policies` containing
`default.cedar` with 3 policies):

```
$ pgrest-lambda lint-policies
3 policies scanned, 0 errors, 0 warnings
```

With `--quiet` and zero findings, no output at all (exit 0).

### JSON Output Format

```json
{
  "summary": {
    "policiesScanned": 2,
    "errors": 1,
    "warnings": 1
  },
  "findings": [
    {
      "file": "policies/custom.cedar",
      "line": 3,
      "severity": "error",
      "rule": "E001",
      "message": "Unconditional permit — no conditions ..."
    }
  ]
}
```

With `--quiet` and zero findings, no output at all (exit 0),
matching the text format behavior.

### Error Messages

Each rule has a fixed message template:

| Rule | Message |
|---|---|
| `E001` | `Unconditional permit — no conditions and no principal/action/resource narrowing. Add a when clause or narrow the scope.` |
| `E002` | `Tautological when clause — condition is always true. The permit is effectively unconditional.` |
| `E003` | `Syntax error: <cedar-error-message>` |
| `E004` | `Unknown action '<x>'. Valid actions: select, insert, update, delete, call.` |
| `W001` | `Principal type missing — policy applies to all principal types including anon. Add 'principal is PgrestLambda::User' or similar.` |
| `W002` | `Resource type missing — policy applies to all resource types. Add 'resource is PgrestLambda::Row' or 'resource is PgrestLambda::Table'.` |
| `W003` | `Column access 'resource.<col>' without 'resource has <col>' guard — the policy fails-closed on tables missing this column.` |
| `W004` | `Unscoped forbid — denies every principal, action, and resource with no conditions. This blocks all access.` |

### CI Integration Example

```yaml
# GitHub Actions
- name: Lint Cedar policies
  run: npx pgrest-lambda lint-policies --max-severity warn --format json
```

```bash
# Shell script — strict mode (fail on warnings too)
pgrest-lambda lint-policies --max-severity warn || exit 1
```

> Note: `parseFlags` uses space-separated `--flag value`
> syntax, not `--flag=value`. All examples use the correct
> form.

## Technical Design

### Module: `src/policies/linter.mjs`

New module. Pure library function with no side effects (no
`process.exit`, no `console.log`). The CLI composes it.

#### Imports

```javascript
import {
  checkParsePolicySet,
  policySetTextToParts,
  policyToJson,
} from '@cedar-policy/cedar-wasm/nodejs';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { parsePolicySource } from '../rest/cedar.mjs';
```

Return type notes (from the `.d.ts`):
- `checkParsePolicySet(policies: PolicySet)` returns
  `CheckParseAnswer` — no `.json` wrapper.
- `policySetTextToParts(str: string)` returns
  `PolicySetTextToPartsAnswer` with `.policies` and
  `.policy_templates` on success.
- `policyToJson(policy: Policy)` returns
  `PolicyToJsonAnswer` — on success the `PolicyJson` is
  at `.json`, not at the top level.

Reuses `parsePolicySource` from the existing `cedar.mjs`
module to resolve `POLICIES_PATH` forms (filesystem paths,
`file://`, `s3://`). For S3 loading, the linter delegates
to the same `loadFromS3` helper — but since `loadFromS3`
is not currently exported, the linter either re-exports it
or duplicates the filesystem-only loader for the initial
implementation (S3 linting is a follow-up if needed; the
CLI runs locally where filesystem access is the norm).

For the initial implementation, the linter supports
filesystem paths only. If `parsePolicySource` returns
`scheme: 's3'`, the linter returns a usage error. This
keeps the dependency surface minimal.

#### Exports

```javascript
// Lint all .cedar files at the given path.
// Returns { findings: Finding[], summary: Summary }.
export async function lintPolicies({ path }) { ... }

// Rule definitions (exported for testing).
export const RULES = { ... };
```

#### Types (JSDoc)

```javascript
/**
 * @typedef {Object} Finding
 * @property {string} file    - Relative path to the .cedar file
 * @property {number} line    - 1-based line number (0 if unknown)
 * @property {'error'|'warn'} severity
 * @property {string} rule    - Rule ID (E001, W001, etc.)
 * @property {string} message - Human-readable description
 */

/**
 * @typedef {Object} Summary
 * @property {number} policiesScanned
 * @property {number} errors
 * @property {number} warnings
 */
```

#### Algorithm

```
lintPolicies({ path })
  1. Resolve path via parsePolicySource (default ./policies).
  2. Read directory, collect all *.cedar files.
     If the directory does not exist or is unreadable, throw
     an error (the CLI catches it and exits 2).
     If the directory exists but contains no *.cedar files,
     throw an error with message "No .cedar files found in
     <path>." (exit 2). This matches the exit code table:
     "no `.cedar` files" is a usage error, not a clean run.
  3. For each file:
     a. Read file contents. If the file is empty (zero bytes or
        whitespace only), skip it — do not count it in
        `policiesScanned` and do not emit a finding.
     b. Run checkParsePolicySet({ staticPolicies: text }).
        If failure → emit E003 for each error, skip further checks on this file.
     c. Run policySetTextToParts(text) to split into individual policies.
        If failure → emit E003 (shouldn't happen if step b passed, but guard).
        The response also includes `policy_templates`; the linter ignores
        templates (they are not evaluated standalone).
     d. For each individual policy string:
        i.   Run policyToJson(policyString) → PolicyToJsonAnswer.
             On success, extract the PolicyJson from the `.json` key.
             On failure, emit E003 and skip further checks on this policy.
        ii.  Compute the policy's start line from the byte offset in the source.
        iii. Check @lint_allow annotation — build a set of suppressed rule IDs.
        iv.  Run each rule check function against the PolicyJson.
        v.   Filter out suppressed findings.
  4. Aggregate findings. Count errors and warnings.
  5. Return { findings, summary }.
```

#### Line Number Resolution

`policySetTextToParts` returns individual policy strings.
To find each policy's line in the original file, search for
the policy's first non-whitespace content within the file
text:

```javascript
// searchFrom tracks the byte offset of the last found
// policy to avoid matching an earlier policy with the
// same first line (e.g., two policies that both start
// with `permit(`).
function findPolicyLine(fileText, policyText, searchFrom = 0) {
  // policySetTextToParts reformats — find by first token.
  // Fallback: use the policy's annotation or effect keyword.
  const needle = policyText.trim().split('\n')[0].trim();
  const idx = fileText.indexOf(needle, searchFrom);
  if (idx === -1) return { line: 0, endOffset: searchFrom };
  const line = fileText.slice(0, idx).split('\n').length;
  return { line, endOffset: idx + needle.length };
}
```

The caller passes `searchFrom` as the previous policy's
`endOffset` to advance through the file sequentially.

Alternatively, since Cedar parse errors carry `SourceLocation`
(`{ start, end }` byte offsets), those can be converted:

```javascript
function byteOffsetToLine(text, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === '\n') line++;
  }
  return line;
}
```

For non-syntax-error findings, the line is the start of the
policy in the file (found via string search for the `permit`
or `forbid` keyword matching each split policy).

#### Rule Implementation Details

**E001 — unconditional-permit:**

```javascript
function checkE001(json) {
  if (json.effect !== 'permit') return null;
  if (isServiceRoleBypass(json)) return null;
  const unscoped =
    json.principal.op === 'All' &&
    json.action.op === 'All' &&
    json.resource.op === 'All';
  if (!unscoped) return null;
  const hasConditions = json.conditions.length > 0;
  if (hasConditions) return null;
  return { severity: 'error', rule: 'E001', message: MESSAGES.E001 };
}

function isServiceRoleBypass(json) {
  const p = json.principal;
  if (p.op === 'is' && p.entity_type?.endsWith('ServiceRole')) {
    return true;
  }
  if (p.op === '==' && p.entity?.__entity?.type?.endsWith('ServiceRole')) {
    return true;
  }
  if (p.op === '==' && p.entity?.type?.endsWith('ServiceRole')) {
    return true;
  }
  return false;
}
```

**E002 — tautological-when:**

```javascript
function checkE002(json) {
  if (json.effect !== 'permit') return null;
  for (const clause of json.conditions) {
    if (clause.kind !== 'when') continue;
    if (isTautology(clause.body)) {
      return {
        severity: 'error', rule: 'E002',
        message: MESSAGES.E002,
      };
    }
  }
  return null;
}

function isTautology(expr) {
  if ('Value' in expr && expr.Value === true) return true;
  // Check 1 == 1, "x" == "x", etc.
  if ('==' in expr) {
    const { left, right } = expr['=='];
    if ('Value' in left && 'Value' in right) {
      return JSON.stringify(left.Value)
          === JSON.stringify(right.Value);
    }
  }
  return false;
}
```

**E003 — syntax-error:**

Emitted during the parse phase. The message is constructed
from the Cedar `DetailedError` (which carries `message`,
`help`, `code`, `url`, `severity`, and `sourceLocations`):

```javascript
function syntaxFinding(file, cedarError, fileText) {
  // cedarError is a DetailedError; sourceLocations is
  // SourceLabel[] where SourceLabel = { start, end, label }.
  const loc = cedarError.sourceLocations?.[0];
  const line = loc
    ? byteOffsetToLine(fileText, loc.start)
    : 0;
  return {
    file, line,
    severity: 'error',
    rule: 'E003',
    message: `Syntax error: ${cedarError.message}`,
  };
}
```

**E004 — unknown-action:**

```javascript
const KNOWN_ACTIONS = new Set([
  'select', 'insert', 'update', 'delete', 'call',
]);

function checkE004(json) {
  const action = json.action;
  const entities = extractActionEntities(action);
  for (const entity of entities) {
    const id = entity?.__entity?.id ?? entity?.id;
    const type = entity?.__entity?.type ?? entity?.type;
    // Use strict equality (not includes) to avoid matching
    // hypothetical PgrestLambda::ActionFoo namespaces.
    if (type === 'PgrestLambda::Action' && id
        && !KNOWN_ACTIONS.has(id)) {
      return {
        severity: 'error', rule: 'E004',
        message: `Unknown action '${id}'. Valid actions: `
          + `select, insert, update, delete, call.`,
      };
    }
  }
  return null;
}

function extractActionEntities(action) {
  if (action.op === '==' && action.entity) {
    return [action.entity];
  }
  if (action.op === 'in') {
    if (action.entities) return action.entities;
    if (action.entity) return [action.entity];
  }
  return [];
}
```

**W001 — principal-type-missing:**

Note: W001 fires on both `permit` and `forbid`. The message
uses "policy" rather than "permit" to cover both effects.

```javascript
function checkW001(json) {
  if (json.principal.op === 'All') {
    return {
      severity: 'warn', rule: 'W001',
      message: MESSAGES.W001,
    };
  }
  return null;
}
```

**W002 — resource-type-missing:**

```javascript
function checkW002(json) {
  if (json.resource.op === 'All') {
    // Service-role bypass policies intentionally cover all
    // resource types; suppress W002 for them.
    if (isServiceRoleBypass(json)) return null;
    return {
      severity: 'warn', rule: 'W002',
      message: MESSAGES.W002,
    };
  }
  return null;
}
```

**W003 — missing-has-guard:**

Walk the `when` clause body recursively. Collect all
`resource.<col>` accesses and all `resource has <col>` guards.
Report any column accessed without a guard in the same
AND-chain.

```javascript
function checkW003(json) {
  const findings = [];
  for (const clause of json.conditions) {
    if (clause.kind !== 'when') continue;
    const accessed = new Set();
    const guarded = new Set();
    collectColumnAccess(clause.body, accessed, guarded);
    for (const col of accessed) {
      if (!guarded.has(col)) {
        findings.push({
          severity: 'warn', rule: 'W003',
          message: `Column access 'resource.${col}' without `
            + `'resource has ${col}' guard — the policy `
            + `fails-closed on tables missing this column.`,
        });
      }
    }
  }
  return findings.length ? findings : null;
}

function collectColumnAccess(expr, accessed, guarded) {
  if (!expr || typeof expr !== 'object') return;

  // Direct checks for resource attribute access and guards.
  if ('.' in expr) {
    const dot = expr['.'];
    if (dot.left?.Var === 'resource' || isResourceRef(dot.left)) {
      accessed.add(dot.attr);
    }
  }

  if ('has' in expr) {
    const has = expr.has;
    if (has.left?.Var === 'resource' || isResourceRef(has.left)) {
      guarded.add(has.attr);
    }
  }

  // Recurse into sub-expressions. The Cedar Expr JSON AST
  // uses keyed objects for operators. Binary operators carry
  // { left, right }, unary operators carry { arg }, and
  // if-then-else carries { if, then, else }.
  for (const key of Object.keys(expr)) {
    const val = expr[key];
    if (val && typeof val === 'object') {
      if ('left' in val) {
        collectColumnAccess(val.left, accessed, guarded);
        if ('right' in val) {
          collectColumnAccess(val.right, accessed, guarded);
        }
      }
      if ('arg' in val) {
        collectColumnAccess(val.arg, accessed, guarded);
      }
      // if-then-else
      if ('if' in val) {
        collectColumnAccess(val['if'], accessed, guarded);
        collectColumnAccess(val['then'], accessed, guarded);
        collectColumnAccess(val['else'], accessed, guarded);
      }
    }
  }
}

function isResourceRef(node) {
  if (node?.Var === 'resource') return true;
  if (Array.isArray(node?.unknown)
      && node.unknown[0]?.Value === 'resource') return true;
  return false;
}
```

**W004 — unscoped-forbid:**

```javascript
function checkW004(json) {
  if (json.effect !== 'forbid') return null;
  const unscoped =
    json.principal.op === 'All' &&
    json.action.op === 'All' &&
    json.resource.op === 'All';
  if (!unscoped) return null;
  if (json.conditions.length > 0) return null;
  return {
    severity: 'warn', rule: 'W004',
    message: MESSAGES.W004,
  };
}
```

#### Annotation Parsing for Suppression

`policyToJson` includes `annotations` on the `PolicyJson`
result. Cedar annotations look like `@key("value")` before
the `permit`/`forbid` keyword. The linter checks for
`@lint_allow`:

```javascript
function getSuppressedRules(json) {
  if (!json.annotations?.lint_allow) return new Set();
  const raw = json.annotations.lint_allow;
  return new Set(raw.split(',').map((s) => s.trim()));
}
```

### Changes to `bin/pgrest-lambda.mjs`

#### New Command

```javascript
const COMMANDS = {
  dev: cmdDev,
  refresh: cmdRefresh,
  'migrate-auth': cmdMigrateAuth,
  'generate-key': cmdGenerateKey,
  'lint-policies': cmdLintPolicies,  // new
  help: cmdHelp,
  '--help': cmdHelp,
  '-h': cmdHelp,
};
```

#### `cmdLintPolicies` Implementation

```javascript
import { lintPolicies } from '../src/policies/linter.mjs';

async function cmdLintPolicies(argv) {
  const opts = parseFlags(argv, {
    path: { type: 'string', default: null },
    format: { type: 'string', default: 'text' },
    'max-severity': { type: 'string', default: 'error' },
    quiet: { type: 'boolean', default: false },
  });

  const format = opts.format;
  if (format !== 'text' && format !== 'json') {
    console.error(
      `Invalid --format '${format}'. Use 'text' or 'json'.`,
    );
    process.exit(2);
  }

  const maxSeverity = opts['max-severity'];
  if (!['error', 'warn', 'off'].includes(maxSeverity)) {
    console.error(
      `Invalid --max-severity '${maxSeverity}'. `
      + `Use 'error', 'warn', or 'off'.`,
    );
    process.exit(2);
  }

  const policyPath = opts.path
    || process.env.POLICIES_PATH
    || './policies';

  let result;
  try {
    result = await lintPolicies({ path: policyPath });
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }

  const { findings, summary } = result;

  if (format === 'json') {
    if (!opts.quiet || findings.length > 0) {
      console.log(JSON.stringify({
        summary: {
          policiesScanned: summary.policiesScanned,
          errors: summary.errors,
          warnings: summary.warnings,
        },
        findings,
      }, null, 2));
    }
  } else {
    for (const f of findings) {
      console.log(
        `${f.file}:${f.line} ${f.severity} ${f.rule} `
        + f.message,
      );
    }
    if (!opts.quiet || findings.length > 0) {
      console.log(
        `${summary.policiesScanned} policies scanned, `
        + `${summary.errors} errors, `
        + `${summary.warnings} warnings`,
      );
    }
  }

  if (maxSeverity === 'off') {
    process.exit(0);
  }

  const threshold =
    maxSeverity === 'warn'
      ? (summary.errors > 0 || summary.warnings > 0)
      : summary.errors > 0;

  process.exit(threshold ? 1 : 0);
}
```

#### Help Text Addition

Add to `cmdHelp()`:

```text
  lint-policies [--path DIR] [--format text|json]
                [--max-severity error|warn|off] [--quiet]
      Lint .cedar policy files for permissiveness and
      correctness. Default path: ./policies (or $POLICIES_PATH).
      Exit 0 if clean, 1 if findings above threshold, 2 on
      usage error.
```

### Reuse of `parsePolicySource`

`parsePolicySource` is already exported from
`src/rest/cedar.mjs`. The linter calls it to normalize the
path input. For the initial implementation, the linter only
handles `scheme: 'file'`. If the scheme is `'s3'`, the linter
throws with message:

```
S3 policy sources are not supported by the linter.
Copy .cedar files locally and pass --path.
```

This is a usage error (exit 2).

### Policy Count in Summary

`policiesScanned` counts individual policies (not files).
One `.cedar` file can contain multiple `permit`/`forbid`
statements. `policySetTextToParts` splits them and the count
is the number of individual policies that were successfully
parsed and checked.

## Code Architecture / File Changes

### New Files

| File | Purpose | ~Lines |
|---|---|---|
| `src/policies/linter.mjs` | Library: `lintPolicies()`, rule check functions, AST walkers | ~350 |
| `src/policies/__tests__/linter.test.mjs` | Unit tests: fixture per rule, happy/violation | ~400 |
| `src/policies/__tests__/fixtures/clean.cedar` | Clean policy file (zero findings expected) | ~30 |
| `src/policies/__tests__/fixtures/e001-violation.cedar` | Unconditional permit | ~5 |
| `src/policies/__tests__/fixtures/e002-violation.cedar` | Tautological when | ~5 |
| `src/policies/__tests__/fixtures/e003-violation.cedar` | Syntax error | ~3 |
| `src/policies/__tests__/fixtures/e004-violation.cedar` | Unknown action | ~5 |
| `src/policies/__tests__/fixtures/w001-violation.cedar` | Missing principal type | ~5 |
| `src/policies/__tests__/fixtures/w002-violation.cedar` | Missing resource type | ~5 |
| `src/policies/__tests__/fixtures/w003-violation.cedar` | Missing has guard | ~5 |
| `src/policies/__tests__/fixtures/w004-violation.cedar` | Unscoped forbid | ~5 |
| `src/policies/__tests__/fixtures/suppressed.cedar` | Policy with `@lint_allow` annotation | ~10 |
| `src/policies/__tests__/fixtures/empty-dir/` | Empty directory (no `.cedar` files) for CLI smoke test | 0 |
| `.kiro/skills/cedar-policy-author/SKILL.md` | Agent skill for Cedar policy authoring | ~40 |

### Modified Files

| File | Change |
|---|---|
| `bin/pgrest-lambda.mjs` | Add `'lint-policies': cmdLintPolicies` to `COMMANDS`; add `cmdLintPolicies` function; add entry in `cmdHelp()` |
| `docs/reference/cli.md` | New `### pgrest-lambda lint-policies` section |
| `docs/guide/write-cedar-policies.md` | New "Step 5 — Lint the policy" section |
| `docs/reference/authorization.md` | Cross-link to linter in "See also" section |
| `CHANGELOG.md` | Unreleased → Security entry for V-06a |
| `docs/security/findings/V-06-no-rls.md` | Partial closure evidence (not flipped to Fixed) |

### Files That Do NOT Change

- `src/rest/cedar.mjs` — the linter reuses exports but does
  not modify the runtime authorization path.
- `src/rest/handler.mjs` — no runtime linting gate.
- `src/index.mjs` — no new library export (the linter is a
  standalone module; the CLI imports it directly).
- `package.json` — no new dependencies. The linter uses
  `@cedar-policy/cedar-wasm` which is already installed.

## Testing Strategy

### Unit Tests: `src/policies/__tests__/linter.test.mjs`

All tests use `node:test` + `assert/strict`, matching
project convention. Each test runs `lintPolicies` against a
fixture directory containing specific `.cedar` files.

#### E001 — unconditional-permit

| Input fixture | Expected |
|---|---|
| `permit(principal, action, resource);` | 1 finding, severity `error`, rule `E001` |
| `permit(principal is PgrestLambda::User, action, resource);` | 0 findings (principal is narrowed) |
| `permit(principal, action == PgrestLambda::Action::"select", resource);` | 0 findings (action is narrowed) |
| `permit(principal, action, resource is PgrestLambda::Row);` | 0 findings (resource is narrowed) |
| `permit(principal, action, resource) when { context.table == "posts" };` | 0 findings (has when clause) |
| Service-role bypass from `policies/default.cedar` | 0 findings (principal is narrowed to ServiceRole, so E001 does not trigger) |
| `@lint_allow("unconditional-permit") permit(principal, action, resource);` | 0 `E001` findings (suppressed); W001 and W002 still fire unless also suppressed |

> Warning: The "0 findings" rows above could pass even if E001 is broken
> (e.g., if the linter never reports anything). Each "0 findings" test
> MUST be paired with a companion fixture in the same test run that
> DOES trigger E001, to prove the rule is active. The first row
> (`permit(principal, action, resource);` -> 1 finding) serves this
> purpose. The implementing agent should verify that removing the
> narrowing from a "0 findings" fixture flips it to "1 finding".

#### E002 — tautological-when

| Input fixture | Expected |
|---|---|
| `permit(principal, action, resource) when { true };` | 1 finding, rule `E002` |
| `permit(principal, action, resource) when { 1 == 1 };` | 1 finding, rule `E002` |
| `permit(principal, action, resource) when { "x" == "x" };` | 1 finding, rule `E002` |
| `permit(principal is PgrestLambda::User, action, resource) when { resource has user_id };` | 0 findings |

> Warning: The first three fixtures also trigger E001 (all
> three scope slots are `op: "All"`, and E001 checks before
> conditions are considered — wait, E001 checks
> `conditions.length > 0` and skips if true). Actually, `when
> { true }` IS a condition, so `conditions.length > 0` is
> true and E001 does NOT fire. The implementing agent should
> verify this: the fixture should produce exactly 1 finding
> (E002) and 0 E001 findings, plus W001 and W002 warnings.
> Consider using `@lint_allow("W001,W002")` in the fixture or
> asserting the full finding set to avoid confusion.

#### E003 — syntax-error

| Input fixture | Expected |
|---|---|
| `permit(principal, action, resource` (missing semicolon/paren) | 1+ findings, rule `E003`, line > 0 |
| Valid policy text | 0 findings |

#### E004 — unknown-action

| Input fixture | Expected |
|---|---|
| `permit(principal, action == PgrestLambda::Action::"drop", resource);` | 1 finding, rule `E004`, message contains `'drop'` |
| `permit(principal, action == PgrestLambda::Action::"select", resource);` | 0 findings |
| `permit(principal, action in [PgrestLambda::Action::"select", PgrestLambda::Action::"nuke"], resource);` | 1 finding for `nuke` |

#### W001 — principal-type-missing

| Input fixture | Expected |
|---|---|
| `permit(principal, action == PgrestLambda::Action::"select", resource is PgrestLambda::Row) when { context.table == "posts" };` | 1 finding, severity `warn`, rule `W001` |
| `permit(principal is PgrestLambda::User, action, resource);` | 0 `W001` findings |

#### W002 — resource-type-missing

| Input fixture | Expected |
|---|---|
| `permit(principal is PgrestLambda::User, action, resource) when { principal.admin == true };` | 1 finding, rule `W002` |
| `permit(principal, action, resource is PgrestLambda::Row);` | 0 `W002` findings |

#### W003 — missing-has-guard

In the fixtures below, `(...)` is shorthand for a fully
scoped head like `(principal is PgrestLambda::User, action, resource is PgrestLambda::Row)`.
The actual test fixtures must use valid Cedar syntax.

| Input fixture | Expected |
|---|---|
| `permit(...) when { resource.user_id == principal };` | 1 finding, rule `W003`, message contains `user_id` |
| `permit(...) when { resource has user_id && resource.user_id == principal };` | 0 `W003` findings |
| `permit(...) when { resource has status && resource.status == "archived" && resource.user_id == principal };` | 1 finding for `user_id` (guarded for `status` but not `user_id`) |

#### W004 — unscoped-forbid

| Input fixture | Expected |
|---|---|
| `forbid(principal, action, resource);` | 1 `W004` finding; also triggers `W001` and `W002` (all three scope slots unscoped) |
| `forbid(principal, action, resource) when { resource has status && resource.status == "archived" };` | 0 `W004` findings (has condition); W001 and W002 still fire |
| `forbid(principal, action == PgrestLambda::Action::"delete", resource);` | 0 `W004` findings (action narrowed); W001 and W002 still fire |

#### Default policies — clean

| Input | Expected |
|---|---|
| `lintPolicies({ path: '<repo>/policies' })` against real `policies/default.cedar` | 0 findings, exit 0 |

> Warning: If the default policies produce any findings,
> either the rules are wrong or the exception logic is wrong.
> This is the primary integration check.

#### Annotation suppression

| Input fixture | Expected |
|---|---|
| `@lint_allow("unconditional-permit,W001,W002") permit(principal, action, resource);` | 0 findings (`E001`, `W001`, `W002` all suppressed) |
| `@lint_allow("unconditional-permit") permit(principal, action, resource);` | 0 `E001` findings (suppressed), but 2 warnings (`W001` for unscoped principal, `W002` for unscoped resource) |
| `@lint_allow("W001,W002") permit(principal, action, resource) when { context.table == "x" };` | 0 `W001` or `W002` findings; `E001` not suppressed but does not trigger (has `when` clause) |

#### Summary counts

| Input | Expected |
|---|---|
| Dir with 2 clean policies | `summary.policiesScanned >= 2`, `errors: 0`, `warnings: 0` |
| Dir with 1 E001 violation and 1 W001 violation | `errors: 1`, `warnings: 1` |

### CLI Smoke Tests

Run `bin/pgrest-lambda.mjs lint-policies` as a subprocess
against fixture directories and verify. Paths below are
relative to the test file; the test creates `clean/` and
`violations/` temp directories (or uses the existing
fixture files). Alternatively, use `policies/` (the real
default directory containing `default.cedar`) for the
"clean" scenario.

| Scenario | Expected exit code | Stdout check |
|---|---|---|
| `--path <clean-dir>` (only valid policies) | `0` | Contains `0 errors, 0 warnings` |
| `--path <violations-dir>` (has E001) | `1` | Contains `E001` |
| `--path <violations-dir> --max-severity off` | `0` | Still prints findings |
| `--path <violations-dir> --max-severity warn` | `1` | Exits non-zero on warnings too |
| `--path ./nonexistent` | `2` | stderr message |
| `--path <empty-dir>` (dir exists, no .cedar files) | `2` | stderr message about no .cedar files |
| `--format json --path <violations-dir>` | `1` | Valid JSON with `findings` array |
| `--quiet --path <clean-dir>` | `0` | No stdout |
| `--format invalid` | `2` | stderr message about format |

> Note: `parseFlags` uses space-separated `--flag value`
> syntax, not `--flag=value`. All CLI invocations must
> pass flags and values as separate argv tokens.

### Regression

All existing tests must pass. Verify with `npm test`.

## Implementation Order

### Phase 1: Library Foundation

1. Create `src/policies/linter.mjs` with:
   - `lintPolicies({ path })` orchestration function.
   - File loading (filesystem only).
   - Parse phase (syntax error detection via
     `checkParsePolicySet`).
   - Policy splitting via `policySetTextToParts`.
   - Policy-to-JSON conversion via `policyToJson`.
   - Line number resolution.
   - Annotation suppression (`@lint_allow`).

2. Implement rules E001 and E002 (the permit-permissiveness
   checks). These are the highest-value rules.

3. Create test fixture files and unit tests for E001 and E002.

4. Verify: `node --test src/policies/__tests__/linter.test.mjs`

### Phase 2: Remaining Rules

5. Implement E003 (syntax errors — already partly done in
   Phase 1's parse phase; wire the findings into the return).

6. Implement E004 (unknown action).

7. Implement W001, W002, W003, W004.

8. Add fixture files and unit tests for every rule.

9. Verify all rules pass against `policies/default.cedar`
   with zero findings.

### Phase 3: CLI Integration

10. Add `cmdLintPolicies` to `bin/pgrest-lambda.mjs`.

11. Wire into `COMMANDS` and `cmdHelp()`.

12. Add CLI smoke tests (subprocess-based).

13. Verify: `npm test`

### Phase 4: Documentation

14. Update `docs/reference/cli.md` — add `lint-policies`
    section.

15. Update `docs/guide/write-cedar-policies.md` — add
    "Step 5 — Lint the policy" section.

16. Update `docs/reference/authorization.md` — add
    cross-link to linter in "See also".

17. Update `CHANGELOG.md` — Unreleased → Security entry.

18. Update `docs/security/findings/V-06-no-rls.md` —
    partial closure evidence.

### Phase 5: Skill File

19. Create `.kiro/skills/cedar-policy-author/SKILL.md`.

20. Review existing skills (`design-author`, `task-author`)
    for Cedar mentions — add linter step if relevant.

## Open Questions

1. **S3 policy linting.** The linter ships with filesystem
   support only. Should it also support `s3://` paths by
   reusing the S3 loader from `cedar.mjs`? The loader is
   currently a private function inside `createCedar`.
   **Recommendation:** Defer. The linter is a pre-deploy CLI
   tool; developers have the `.cedar` files locally. If
   S3 support is needed later, export the S3 loader or
   refactor it into a shared helper.

2. **Annotation syntax.** Cedar annotations are
   `@key("value")`. The linter uses
   `@lint_allow("E001,W001")`. Cedar's spec allows
   arbitrary annotations, so this works. However, the
   annotation value is a single string — commas inside it
   are a convention, not a Cedar feature.
   **Recommendation:** Ship the comma-separated convention.
   It is simple and sufficient.

3. **Runtime linting gate.** Should `createPgrest` optionally
   run the linter at startup and refuse to serve if errors
   are found? **Recommendation:** Not in V-06a. A runtime
   gate risks bricking deployments. The CLI is the right
   enforcement point; CI pipelines can add it as a blocking
   step.

4. **W003 false positives with `unless` clauses.** A policy
   that uses `unless { resource has col }` as a guard instead
   of `when { resource has col && ... }` would not be
   detected by the current W003 logic. The `unless` clause
   body would need separate analysis. **Recommendation:**
   Ship the `when`-only check. `unless` is rare in
   pgrest-lambda policies. Add `unless` support in a
   follow-up if false positives appear.

5. **Multi-file error deduplication.** If two files contain
   the same violation pattern, the linter reports both. This
   is correct behavior (each is a separate policy). No
   deduplication is needed.

6. **Multiple files with the same name.** Not possible
   within a single directory (the OS prevents it).
   Subdirectories are not scanned — only top-level
   `*.cedar` files in the resolved path. If recursive
   scanning is added later, file paths in findings will
   be relative and unique.

7. **Very large policy sets.** The linter loads every
   `.cedar` file into memory and passes each to
   `policyToJson`, which invokes the WASM runtime.
   For typical deployments (single-digit files, < 1 KB
   each), this is negligible. No streaming or pagination
   is needed in V-06a. If a deployment has hundreds of
   policy files, the implementer should verify WASM memory
   limits do not apply; add a note to the CLI docs if
   they do.
