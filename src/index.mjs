import { handler as authHandler } from './auth/handler.mjs';
import { handler as apiHandler } from './rest/handler.mjs';

export async function handler(event) {
  const path = event.path || '';
  if (path.startsWith('/auth/v1/')) {
    return authHandler(event);
  }
  return apiHandler(event);
}
