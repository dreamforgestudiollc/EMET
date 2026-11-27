/** The service worker may cache the app shell only. API responses stay on the network. */

const SHELL = new Set(['/', '/index.html', '/manifest.webmanifest', '/sw.js']);

export function cacheShell(url: string, appOrigin: string): boolean {
  let parsed: URL;
  try { parsed = new URL(url, appOrigin); }
  catch { return false; }
  if (parsed.origin !== appOrigin) return false;
  if (parsed.pathname.startsWith('/console/api')) return false;
  if (parsed.pathname.startsWith('/api')) return false;
  if (SHELL.has(parsed.pathname)) return true;
  if (parsed.pathname.startsWith('/assets/')) return true;
  if (parsed.pathname.startsWith('/icons/')) return true;
  return parsed.pathname.endsWith('.css') || parsed.pathname.endsWith('.js') || parsed.pathname.endsWith('.svg');
}
