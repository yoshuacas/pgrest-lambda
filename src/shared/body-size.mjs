// body-size.mjs — shared request body size guard.
// Both rest/handler and auth/handler use this before JSON.parse to
// prevent large-body memory spikes. API Gateway caps at 10 MB; we
// want a tighter explicit bound.

import { PostgRESTError } from '../rest/errors.mjs';

export const MAX_BODY_BYTES = 1_048_576; // 1 MB

export function assertBodySize(rawBody) {
  if (rawBody == null) return;
  // AWS Lambda events always give us a string. Measure UTF-8 bytes
  // (not characters) since that's what Node allocates when parsing.
  const size = Buffer.byteLength(rawBody, 'utf8');
  if (size > MAX_BODY_BYTES) {
    throw new PostgRESTError(
      413, 'PGRST006',
      `Request body exceeds maximum size of ${MAX_BODY_BYTES} bytes`,
    );
  }
}
