// SAM deployment wrapper — creates pgrest-lambda from environment variables.
// This is the Lambda entry point referenced by template.yaml.

import { createPgrest } from '../../../src/index.mjs';

const pgrest = createPgrest();

export const handler = pgrest.handler;
export const authorizer = pgrest.authorizer;
