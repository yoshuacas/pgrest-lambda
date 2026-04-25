export function isSafeRedirect(url, baseUrl) {
  if (!url || typeof url !== 'string') return false;
  try {
    const target = new URL(url);
    const base = new URL(baseUrl);
    return target.origin === base.origin;
  } catch {
    return url.startsWith('/') && !url.startsWith('//');
  }
}
