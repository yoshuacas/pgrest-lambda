// Lambda entry point — creates pgrest-lambda from environment variables.
// Used by SAM/CloudFormation deployments.

import { createPgrest } from './src/index.mjs';

const pgrest = createPgrest();

export const handler = pgrest.handler;
export const authorizer = pgrest.authorizer;
export const presignup = (event) => {
  event.response.autoConfirmUser = true;
  event.response.autoVerifyEmail = true;
  return event;
};
