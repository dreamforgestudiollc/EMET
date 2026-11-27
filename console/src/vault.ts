/**
 * Per-server isolation. Access tokens live in memory. Refresh tokens and
 * device keys live in the remembered store (IndexedDB in the browser), and
 * only after the person ticks remember on the server's sign-in page.
 * localStorage holds the server list and the time zone. It never holds a token.
 */

export type ServerMeta = {
  name?: string;
  version?: string;
  console_api?: number;
  features?: { phase?: number; add_note?: boolean; security_settings?: boolean };
};

export type ServerEntry = {
  id: string;
  name: string;
  baseUrl: string;
  meta: ServerMeta | null;
  signedIn: boolean;
};

export type ScreenState = {
  serverId: string | null;
  dashboard: unknown;
  area: unknown;
  documents: unknown;
  document: unknown;
  search: unknown;
  recent: unknown;
  transcript: unknown;
  note: unknown;
};

export type Remembered = {
  refreshToken: string;
  deviceId: string;
  nonce: string;
};

export interface RememberedStore {
  put(serverId: string, row: Remembered): Promise<void>;
  get(serverId: string): Promise<Remembered | null>;
  delete(serverId: string): Promise<void>;
}

const LIST_KEY = 'emet-console-servers';
const access = new Map<string, string>();

export function emptyScreen(serverId: string | null = null): ScreenState {
  return {
    serverId,
    dashboard: null,
    area: null,
    documents: null,
    document: null,
    search: null,
    recent: null,
    transcript: null,
    note: null
  };
}

/** Switching servers clears every record that was on screen. */
export function switchServer(nextId: string): ScreenState {
  return emptyScreen(nextId);
}

export function setAccessToken(serverId: string, token: string | null): void {
  if (token) access.set(serverId, token);
  else access.delete(serverId);
}

export function accessToken(serverId: string): string | null {
  return access.get(serverId) ?? null;
}

export function buildRequest(server: Pick<ServerEntry, 'id' | 'baseUrl'>, path: string): { url: string; headers: Record<string, string> } {
  const token = accessToken(server.id);
  const headers: Record<string, string> = { accept: 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const url = `${server.baseUrl.replace(/\/$/, '')}${path.startsWith('/') ? path : `/${path}`}`;
  return { url, headers };
}

export function loadServerList(): ServerEntry[] {
  try {
    const raw = localStorage.getItem(LIST_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as ServerEntry[];
    if (!Array.isArray(parsed)) return [];
    return parsed.map((row) => ({
      id: String(row.id),
      name: String(row.name || row.baseUrl),
      baseUrl: String(row.baseUrl),
      meta: row.meta ?? null,
      signedIn: false
    }));
  } catch {
    return [];
  }
}

export function saveServerList(list: ServerEntry[]): void {
  const safe = list.map((row) => ({
    id: row.id,
    name: row.name,
    baseUrl: row.baseUrl,
    meta: row.meta
  }));
  localStorage.setItem(LIST_KEY, JSON.stringify(safe));
}

export async function removeServer(list: ServerEntry[], id: string, store: RememberedStore): Promise<ServerEntry[]> {
  setAccessToken(id, null);
  await store.delete(id);
  const next = list.filter((row) => row.id !== id);
  saveServerList(next);
  return next;
}

export function newServerId(): string {
  return crypto.randomUUID();
}

export function normalizeBaseUrl(input: string): string | null {
  try {
    const url = new URL(input.trim());
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    url.pathname = '';
    url.search = '';
    url.hash = '';
    return url.origin;
  } catch {
    return null;
  }
}
