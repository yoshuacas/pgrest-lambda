// Lambda entry points for SAM/CloudFormation deployments.
// Each exported handler lazy-imports what it needs so a light-weight
// trigger (Cognito PreSignUp) does not pay the cost of booting the full
// REST/auth pipeline.

let pgrest;
async function getPgrest() {
  if (!pgrest) {
    const mod = await import('./src/index.mjs');
    pgrest = mod.createPgrest();
  }
  return pgrest;
}

export const handler = async (event) => (await getPgrest()).handler(event);
export const authorizer = async (event) => (await getPgrest()).authorizer(event);

// Cognito PreSignUp trigger — auto-confirm and auto-verify email.
// Kept independent of the main pipeline so it never touches database or
// auth subsystem initialization.
export const presignup = async (event) => {
  event.response.autoConfirmUser = true;
  event.response.autoVerifyEmail = true;
  return event;
};
