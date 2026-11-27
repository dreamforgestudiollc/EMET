import { buildRequest, type ServerEntry } from './vault.js';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export async function serverJson<T>(server: ServerEntry, path: string, fetchImpl: FetchLike = fetch, init: RequestInit = {}): Promise<T> {
  const built = buildRequest(server, path);
  const headers = { ...built.headers, ...(init.headers as Record<string, string> | undefined) };
  const res = await fetchImpl(built.url, { ...init, headers });
  const text = await res.text();
  const body = text ? JSON.parse(text) as T : ({} as T);
  if (!res.ok) {
    const err = body as { message?: string; emet_code?: string };
    throw new Error(err.emet_code ? `${err.emet_code}: ${err.message || 'Refused.'}` : (err.message || `The server answered ${res.status}.`));
  }
  return body;
}

/** The home-screen dot. /console/api/meta sends exact-origin CORS. /health does not. */
export async function healthDot(baseUrl: string, fetchImpl: FetchLike = fetch): Promise<'up' | 'down'> {
  try {
    const res = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/console/api/meta`);
    if (!res.ok) return 'down';
    const body = await res.json() as { console_api?: number };
    return body.console_api === 1 ? 'up' : 'down';
  } catch {
    return 'down';
  }
}
