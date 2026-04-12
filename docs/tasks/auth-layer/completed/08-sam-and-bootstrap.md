# Task 08: SAM Template and Bootstrap Changes

**Agent:** implementer
**Design:** docs/design/auth-layer.md
**Depends on:** Task 02, Task 06, Task 07

## Objective

Update the SAM template to replace the Cognito authorizer
with the BOA authorizer, add auth routes, and update CORS.
Update bootstrap.sh to generate JWT secret, store in SSM,
generate keys, and write extended config.

## Target Tests

This task has no unit tests in Task 01 (infrastructure
changes). Acceptance is verified by manual review of the
SAM template and bootstrap script.

## Implementation

### backend.yaml changes

Modify `plugin/templates/backend.yaml`:

**1. Replace CognitoAuthorizer with BoaAuthorizer**
(currently lines 101-105):
```yaml
Auth:
  DefaultAuthorizer: BoaAuthorizer
  Authorizers:
    BoaAuthorizer:
      FunctionArn: !GetAtt AuthorizerFunction.Arn
      FunctionPayloadType: REQUEST
      Identity:
        Headers:
          - Authorization
          - apikey
        ReauthorizeEvery: 300
```

**2. Add AuthorizerFunction resource:**
```yaml
AuthorizerFunction:
  Type: AWS::Serverless::Function
  Properties:
    FunctionName: !Sub '${ProjectName}-authorizer'
    Handler: authorizer/index.handler
    CodeUri: ../lambda-templates/
    MemorySize: 128
    Environment:
      Variables:
        JWT_SECRET: !Sub '{{resolve:ssm:/${ProjectName}/jwt-secret}}'
```

**3. Add AuthorizerFunctionPermission:**
```yaml
AuthorizerFunctionPermission:
  Type: AWS::Lambda::Permission
  Properties:
    FunctionName: !GetAtt AuthorizerFunction.Arn
    Action: lambda:InvokeFunction
    Principal: apigateway.amazonaws.com
    SourceArn: !Sub 'arn:aws:execute-api:${AWS::Region}:${AWS::AccountId}:${Api}/*'
```

**4. Add auth proxy route to ApiFunction events**
(no authorizer):
```yaml
AuthProxy:
  Type: Api
  Properties:
    RestApiId: !Ref Api
    Path: /auth/v1/{proxy+}
    Method: ANY
    Auth:
      Authorizer: NONE
```

**5. Add env vars to ApiFunction:**
- `USER_POOL_CLIENT_ID: !Ref UserPoolClient`
- `JWT_SECRET: !Sub '{{resolve:ssm:/${ProjectName}/jwt-secret}}'`
- `AUTH_PROVIDER: cognito`

**6. Update CORS:**
```yaml
Cors:
  AllowMethods: "'GET,POST,PUT,PATCH,DELETE,OPTIONS'"
  AllowHeaders: "'Content-Type,Authorization,apikey,Prefer,Accept,x-client-info'"
  AllowOrigin: "'*'"
  MaxAge: "'600'"
```

### bootstrap.sh changes

Modify `plugin/scripts/bootstrap.sh`:

**Before `sam deploy` (after prerequisite checks):**
1. Generate JWT secret:
   ```bash
   JWT_SECRET=$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64'))")
   ```
2. Store in SSM:
   ```bash
   aws ssm put-parameter \
     --name "/${STACK_NAME}/jwt-secret" \
     --value "$JWT_SECRET" \
     --type SecureString \
     --overwrite \
     --region "$REGION"
   ```

**After `sam deploy` (after extracting outputs):**
3. Generate keys:
   ```bash
   KEYS=$(node "$SCRIPT_DIR/generate-keys.mjs" "$JWT_SECRET")
   ANON_KEY=$(echo "$KEYS" | jq -r '.anonKey')
   SERVICE_ROLE_KEY=$(echo "$KEYS" | jq -r '.serviceRoleKey')
   ```
4. Add `anonKey` and `serviceRoleKey` to the config.json
   output.
5. Update the deployment summary to show the new keys.

**Assumption:** The SSM parameter must exist before
`sam deploy` because the template uses
`{{resolve:ssm:...}}` which resolves at deploy time.
If SSM put-parameter fails, the script should exit.

## Acceptance Criteria

- SAM template validates with `sam validate`.
- CognitoAuthorizer is replaced by BoaAuthorizer.
- Auth routes are publicly accessible (no authorizer).
- ApiFunction has JWT_SECRET, USER_POOL_CLIENT_ID, and
  AUTH_PROVIDER env vars.
- CORS includes apikey, PATCH, and other supabase-js
  headers.
- Bootstrap generates JWT secret before deploy and keys
  after deploy.
- Config.json includes anonKey and serviceRoleKey.

## Conflict Criteria

- If all target tests already pass before any code changes
  are made, investigate whether the tests are true positives
  before marking the task complete.
- If the SAM template has been significantly modified by
  another feature (e.g., PostgREST layer), coordinate
  changes carefully to avoid overwriting. Escalate if the
  template structure has changed beyond what the design
  describes.
