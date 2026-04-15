# Task 07: SAM Template — Conditional Cognito Resources

**Agent:** implementer
**Design:** docs/design/gotrue-native-auth.md

## Objective

Modify `docs/deploy/aws-sam/template.yaml` to make Cognito
resources conditional. A fresh deployment uses GoTrue by
default; Cognito is opt-in via `AUTH_PROVIDER=cognito`.

## Target Tests

No automated tests. SAM template changes are verified by
`sam validate` or manual review.

## Implementation

**Modified: `docs/deploy/aws-sam/template.yaml`**

### 1. Add `AuthProvider` parameter

In the `Parameters` section, add:
```yaml
AuthProvider:
  Type: String
  Default: gotrue
  AllowedValues: [gotrue, cognito]
```

### 2. Add `IsCognito` condition

In the `Conditions` section, add:
```yaml
IsCognito: !Equals [!Ref AuthProvider, cognito]
```

### 3. Make Cognito resources conditional

Add `Condition: IsCognito` to each of these four resources:
- `UserPool`
- `UserPoolClient`
- `PreSignUpFunction`
- `PreSignUpPermission`

### 4. Update `ApiFunction` environment variables

Replace the hardcoded Cognito env vars with conditional
values:
```yaml
USER_POOL_ID: !If
  [IsCognito, !Ref UserPool, !Ref 'AWS::NoValue']
USER_POOL_CLIENT_ID: !If
  [IsCognito, !Ref UserPoolClient, !Ref 'AWS::NoValue']
AUTH_PROVIDER: !Ref AuthProvider
```

### 5. Make Cognito outputs conditional

Add `Condition: IsCognito` to the `UserPoolId` and
`UserPoolClientId` outputs:

```yaml
UserPoolId:
  Condition: IsCognito
  Value: !Ref UserPool
UserPoolClientId:
  Condition: IsCognito
  Value: !Ref UserPoolClient
```

## Acceptance Criteria

- Fresh deployment (default params) creates no Cognito
  resources.
- Deployment with `AuthProvider=cognito` creates all four
  Cognito resources.
- `ApiFunction` environment includes `AUTH_PROVIDER` set
  to the parameter value.
- Cognito-specific env vars are only set when
  `AuthProvider=cognito`.
- Template is valid YAML.
- `npm test` still passes (template not tested by unit
  tests).

## Conflict Criteria

- If the template already has an `AuthProvider` parameter
  or `IsCognito` condition, investigate whether this task
  was already completed.
- If Cognito resources are already conditional, skip
  those changes.
