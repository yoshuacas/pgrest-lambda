// Lambda entry points for the AWS SAM deployment. This file is the
// glue that template.yaml references via `Handler: lambda.*`. Each
// export lazy-imports its dependencies so a lightweight trigger
// (Cognito PreSignUp) doesn't pay the cost of booting the full
// REST/auth pipeline.
//
// `CodeUri: ../../` in template.yaml means the bundled Lambda package
// contains the whole repo root, so relative imports into ../../src
// and ./authorizer.mjs resolve correctly inside the zipped function.

let pgrest;
async function getPgrest() {
  if (!pgrest) {
    const mod = await import('../../src/index.mjs');
    pgrest = mod.createPgrest();
  }
  return pgrest;
}

let authorizerHandler;
async function getAuthorizer() {
  if (!authorizerHandler) {
    const { createAuthorizer } = await import('./authorizer.mjs');
    authorizerHandler = createAuthorizer({
      jwtSecret: process.env.JWT_SECRET,
      jwksUrl: process.env.JWKS_URL || null,
    }).handler;
  }
  return authorizerHandler;
}

export const handler = async (event) => (await getPgrest()).handler(event);
export const authorizer = async (event) => (await getAuthorizer())(event);

// Cognito PreSignUp trigger — auto-confirm and auto-verify email.
// Kept independent of the main pipeline so it never touches database
// or auth subsystem initialization.
export const presignup = async (event) => {
  event.response.autoConfirmUser = true;
  event.response.autoVerifyEmail = true;
  return event;
};
