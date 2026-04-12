# Task 08: S3 Policy Loading and template.yaml Changes

**Agent:** implementer
**Design:** docs/design/authorization-cedar.md
**Depends on:** Task 03

## Objective

Add S3-based policy loading to `src/rest/cedar.mjs` and
update `template.yaml` with the required environment
variables and IAM policies for Lambda deployment.

## Target Tests

No tests from Task 01 directly target S3 loading (it is
mocked in tests). This task adds the S3 code path and
infra configuration.

## Implementation

### Add S3 loading to `src/rest/cedar.mjs`

Add `loadFromS3(bucket, prefix)` function:

```javascript
import { S3Client, ListObjectsV2Command,
         GetObjectCommand } from '@aws-sdk/client-s3';

async function loadFromS3(bucket, prefix) {
  const s3 = new S3Client({
    region: process.env.REGION_NAME,
  });
  const list = await s3.send(new ListObjectsV2Command({
    Bucket: bucket,
    Prefix: prefix,
  }));
  const policyTexts = [];
  for (const obj of list.Contents || []) {
    if (!obj.Key.endsWith('.cedar')) continue;
    const resp = await s3.send(new GetObjectCommand({
      Bucket: bucket, Key: obj.Key,
    }));
    policyTexts.push(
      await resp.Body.transformToString()
    );
  }
  return policyTexts.join('\n');
}
```

Note: `@aws-sdk/client-s3` is available in the Lambda
Node.js 20.x runtime — do NOT add it to `package.json`.

### Update `loadPolicies()` source selection

Modify `loadPolicies()` to select the policy source:

```javascript
async function loadPolicyText() {
  const bucket = process.env.POLICIES_BUCKET;
  const prefix = process.env.POLICIES_PREFIX;
  if (bucket) {
    return loadFromS3(bucket, prefix || 'policies/');
  }
  const dirPath = process.env.POLICIES_PATH || './policies';
  return loadFromFilesystem(dirPath);
}
```

S3 takes precedence when `POLICIES_BUCKET` is set.
Otherwise, fall back to filesystem.

### Update `template.yaml`

Add environment variables to `ApiFunction.Properties.Environment.Variables`:

```yaml
POLICIES_BUCKET: !If
  - HasPolicyBucket
  - !Ref PolicyBucket
  - !Ref 'AWS::NoValue'
POLICIES_PREFIX: !If
  - HasPolicyBucket
  - policies/
  - !Ref 'AWS::NoValue'
POLICIES_PATH: !If
  - HasPolicyBucket
  - !Ref 'AWS::NoValue'
  - ./policies
```

Or, simpler — since the code handles defaults:

```yaml
# Only set POLICIES_BUCKET if S3 storage is configured
# Otherwise POLICIES_PATH defaults to ./policies in code
```

Add the appropriate approach based on how `template.yaml`
is currently structured. If there is no conditional logic
pattern, simply add:

```yaml
POLICIES_PATH: ./policies
```

And document that `POLICIES_BUCKET` and `POLICIES_PREFIX`
can be set manually for S3-based deployments.

Add S3 read IAM policy to `ApiFunction.Properties.Policies`:

```yaml
- Version: '2012-10-17'
  Statement:
    - Effect: Allow
      Action:
        - s3:GetObject
        - s3:ListBucket
      Resource:
        - !Sub 'arn:aws:s3:::${PolicyBucket}'
        - !Sub 'arn:aws:s3:::${PolicyBucket}/*'
```

Or if PolicyBucket is not a template parameter, use a
generic pattern and document that the bucket ARN should
be configured.

Read `template.yaml` first to understand the existing
structure before making changes.

## Test Requirements

Add a unit test for `loadFromS3` if feasible with mocking.
Otherwise, S3 loading is verified through manual deployment
testing.

At minimum, verify that:
- When `POLICIES_BUCKET` is not set, `loadPolicies()`
  falls back to filesystem loading (existing tests cover
  this implicitly)
- The `loadFromS3` function filters `.cedar` files only

## Acceptance Criteria

- `loadFromS3()` function exists in `cedar.mjs`
- `loadPolicies()` selects S3 or filesystem based on env vars
- `template.yaml` includes `POLICIES_PATH` env var
- `template.yaml` includes S3 read IAM policy (if a policy
  bucket is configured)
- Existing tests still pass (S3 path is not exercised in
  unit tests)

## Conflict Criteria

- If `template.yaml` does not define a PolicyBucket parameter,
  add the S3 IAM policy with a placeholder and document the
  required configuration.
- If `@aws-sdk/client-s3` is not available in the test
  environment, ensure the import is conditional or lazy-loaded
  so that tests (which use filesystem loading) are not
  affected.
- If all target tests already pass before changes,
  investigate.
