export async function handler(event) {
  event.response.autoConfirmUser = true;
  event.response.autoVerifyEmail = true;
  return event;
}
