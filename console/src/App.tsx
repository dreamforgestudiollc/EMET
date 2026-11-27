import { useEffect, useState } from 'react';
import { healthDot, serverJson, type FetchLike } from './api.js';
import { authorizeUrl, clientId, redirectUri, signRefresh, takeVerifier } from './auth.js';
import { browserRememberedStore } from './idb.js';
import { formatWhen, setTimeZone, timeZone } from './format.js';
import {
  accessToken, buildRequest, emptyScreen, loadServerList, newServerId, normalizeBaseUrl,
  removeServer, saveServerList, setAccessToken, switchServer,
  type RememberedStore, type ScreenState, type ServerEntry, type ServerMeta
} from './vault.js';

type View = 'home' | 'dashboard' | 'areas' | 'area' | 'docs' | 'doc' | 'search' | 'recent' | 'transcript' | 'note' | 'settings';

type Props = {
  store?: RememberedStore;
  fetchImpl?: FetchLike;
};

const memoryStore: RememberedStore = {
  async put() {},
  async get() { return null; },
  async delete() {}
};

function pathOf(view: View, serverId: string | null, extra = ''): string {
  if (view === 'home') return '/';
  if (view === 'settings') return '/settings';
  if (!serverId) return '/';
  if (view === 'dashboard') return `/s/${serverId}`;
  if (view === 'area') return `/s/${serverId}/areas/${extra}`;
  if (view === 'doc') return `/s/${serverId}/doc?id=${encodeURIComponent(extra)}`;
  if (view === 'transcript') return `/s/${serverId}/transcript?session=${encodeURIComponent(extra)}`;
  return `/s/${serverId}/${view}`;
}

export function App({ store = browserRememberedStore(), fetchImpl = fetch }: Props) {
  const [servers, setServers] = useState<ServerEntry[]>(() => loadServerList());
  const [active, setActive] = useState<string | null>(null);
  const [view, setView] = useState<View>('home');
  const [screen, setScreen] = useState<ScreenState>(() => emptyScreen());
  const [draft, setDraft] = useState('');
  const [preview, setPreview] = useState<ServerMeta | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [layer, setLayer] = useState<'episodic' | 'semantic' | 'working'>('episodic');
  const [confirmNote, setConfirmNote] = useState(false);
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<'keyword' | 'semantic'>('keyword');
  const [zone, setZone] = useState(timeZone);
  const [theme, setTheme] = useState<'light' | 'dark'>(() => (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  const [health, setHealth] = useState<Record<string, 'up' | 'down' | 'unknown'>>({});

  const current = servers.find((row) => row.id === active) ?? null;

  function go(nextView: View, serverId: string | null, extra = '') {
    const url = pathOf(nextView, serverId, extra);
    window.history.pushState({}, '', url);
    setView(nextView);
  }

  function selectServer(id: string) {
    setActive(id);
    setScreen(switchServer(id));
    setError('');
    setConfirmNote(false);
    go('dashboard', id);
  }

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const next: Record<string, 'up' | 'down' | 'unknown'> = {};
      for (const row of servers) next[row.id] = await healthDot(row.baseUrl, fetchImpl);
      if (!cancelled) setHealth(next);
    })();
    return () => { cancelled = true; };
  }, [servers, fetchImpl]);

  useEffect(() => {
    if (!current || view === 'home' || view === 'settings') return;
    let cancelled = false;
    (async () => {
      try {
        if (view === 'dashboard') {
          const data = await serverJson(current, '/console/api/dashboard', fetchImpl);
          if (!cancelled) setScreen((prev) => (prev.serverId === current.id ? { ...prev, dashboard: data } : prev));
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'The server did not answer.');
      }
    })();
    return () => { cancelled = true; };
  }, [current, view, fetchImpl]);

  async function previewServer() {
    const baseUrl = normalizeBaseUrl(draft);
    if (!baseUrl) {
      setError('Paste a server URL, including https.');
      return;
    }
    setError('');
    try {
      const res = await fetchImpl(`${baseUrl}/console/api/meta`);
      const meta = await res.json() as ServerMeta;
      setPreview(meta);
      setPreviewUrl(baseUrl);
    } catch {
      setError('That URL did not return console meta.');
    }
  }

  function savePreview() {
    if (!previewUrl || !preview) return;
    const entry: ServerEntry = {
      id: newServerId(),
      name: preview.name || previewUrl,
      baseUrl: previewUrl,
      meta: preview,
      signedIn: false
    };
    const next = [...servers, entry];
    setServers(next);
    saveServerList(next);
    setDraft('');
    setPreview(null);
    setPreviewUrl(null);
  }

  async function forget(id: string) {
    const next = await removeServer(servers, id, store);
    setServers(next);
    if (active === id) {
      setActive(null);
      setScreen(emptyScreen());
      go('home', null);
    }
  }

  async function signIn(server: ServerEntry) {
    const url = await authorizeUrl(server);
    window.location.assign(url);
  }

  async function finishCallback() {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    const state = params.get('state');
    if (!code || !state) return;
    const server = servers.find((row) => row.id === state);
    const verifier = takeVerifier(state);
    if (!server || !verifier) {
      setError('That sign-in did not match a server on this phone.');
      return;
    }
    const tokenRes = await fetchImpl(`${server.baseUrl}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri(),
        client_id: clientId(),
        code_verifier: verifier
      }).toString()
    });
    const token = await tokenRes.json() as { access_token?: string; refresh_token?: string; nonce?: string; device_id?: string };
    if (!token.access_token) {
      setError('The server did not return a console session.');
      return;
    }
    setAccessToken(server.id, token.access_token);
    if (token.refresh_token && token.device_id && token.nonce) {
      await store.put(server.id, { refreshToken: token.refresh_token, deviceId: token.device_id, nonce: token.nonce });
    }
    const next = servers.map((row) => (row.id === server.id ? { ...row, signedIn: true } : row));
    setServers(next);
    selectServer(server.id);
  }

  useEffect(() => {
    if (window.location.pathname === '/callback') {
      void finishCallback();
    }
    // The callback runs once on load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function openArea(slug: string) {
    if (!current) return;
    setScreen((prev) => ({ ...prev, area: null }));
    const data = await serverJson(current, `/console/api/areas/${slug}`, fetchImpl);
    setScreen((prev) => (prev.serverId === current.id ? { ...prev, area: data } : prev));
    go('area', current.id, slug);
  }

  async function openDoc(id: string) {
    if (!current) return;
    setScreen((prev) => ({ ...prev, document: null }));
    const data = await serverJson(current, `/console/api/docs/${id.split('/').map(encodeURIComponent).join('/')}`, fetchImpl);
    setScreen((prev) => (prev.serverId === current.id ? { ...prev, document: data } : prev));
    go('doc', current.id, id);
  }

  async function runSearch() {
    if (!current || !query.trim()) return;
    setScreen((prev) => ({ ...prev, search: null }));
    const data = await serverJson(current, `/console/api/search?mode=${mode}&q=${encodeURIComponent(query)}`, fetchImpl);
    setScreen((prev) => (prev.serverId === current.id ? { ...prev, search: data } : prev));
  }

  async function loadRecent() {
    if (!current) return;
    const data = await serverJson<unknown>(current, '/console/api/episodic/recent', fetchImpl);
    setScreen((prev) => (prev.serverId === current.id ? { ...prev, recent: data } : prev));
    go('recent', current.id);
  }

  async function loadDocs() {
    if (!current) return;
    const data = await serverJson<unknown>(current, '/console/api/docs', fetchImpl);
    setScreen((prev) => (prev.serverId === current.id ? { ...prev, documents: data } : prev));
    go('docs', current.id);
  }

  async function saveNote() {
    if (!current) return;
    const data = await serverJson<{ receipt?: { sha256?: string; source?: string } }>(current, '/console/api/notes', fetchImpl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ layer, content: note })
    });
    setScreen((prev) => (prev.serverId === current.id ? { ...prev, note: data } : prev));
    setConfirmNote(false);
    setNote('');
  }

  async function refreshIfNeeded(server: ServerEntry) {
    if (accessToken(server.id)) return;
    const row = await store.get(server.id);
    if (!row) return;
    const timestamp = Date.now();
    const signature = await signRefresh(server.id, row.nonce, timestamp);
    if (!signature) return;
    const built = buildRequest(server, '/console/api/session/refresh');
    const res = await fetchImpl(built.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ refresh_token: row.refreshToken, nonce: row.nonce, timestamp, signature })
    });
    if (!res.ok) {
      await store.delete(server.id);
      return;
    }
    const body = await res.json() as { access_token?: string; refresh_token?: string; nonce?: string; device_id?: string; step_up?: null };
    if (body.access_token) setAccessToken(server.id, body.access_token);
    if (body.refresh_token && body.nonce && body.device_id) {
      await store.put(server.id, { refreshToken: body.refresh_token, deviceId: body.device_id, nonce: body.nonce });
    }
  }

  const dash = screen.dashboard as { as_of?: string; state_line?: string; handoff?: string; recent_episodic?: number; areas?: { areas?: { slug?: string; title?: string }[] } } | null;

  return (
    <div className="app">
      <header className="bar">
        <button type="button" className="text" onClick={() => { setActive(null); setScreen(emptyScreen()); go('home', null); }}>EMET</button>
        <button type="button" className="text" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? 'Light' : 'Dark'}</button>
      </header>
      {error ? <p className="error" role="alert">{error}</p> : null}
      {view === 'home' || !current ? (
        <main>
          <h1>Servers</h1>
          <ul className="cards">
            {servers.map((row) => (
              <li key={row.id}>
                <button type="button" className="card" onClick={() => { void refreshIfNeeded(row).then(() => selectServer(row.id)); }}>
                  <span className={`dot ${health[row.id] || 'unknown'}`} aria-label={health[row.id] === 'up' ? 'up' : 'not up'} />
                  <strong>{row.name}</strong>
                  <span className="muted">{row.baseUrl}</span>
                  <span className="muted">{row.meta?.version ? `EMET ${row.meta.version}` : 'version unknown'} · {accessToken(row.id) ? 'signed in' : 'signed out'}</span>
                </button>
                <button type="button" onClick={() => { void forget(row.id); }}>Remove</button>
              </li>
            ))}
          </ul>
          <section className="panel">
            <h2>Add server</h2>
            <label>Server URL
              <input value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="https://emet.example" inputMode="url" />
            </label>
            <button type="button" onClick={() => { void previewServer(); }}>Check</button>
            {preview && previewUrl ? (
              <div className="preview">
                <p>{preview.name || 'EMET'} · {preview.version || 'unknown version'} · console API {preview.console_api ?? '?'}</p>
                <button type="button" onClick={savePreview}>Save {previewUrl}</button>
              </div>
            ) : null}
          </section>
        </main>
      ) : (
        <main>
          <p className="muted">{current.name}</p>
          <nav className="tabs">
            <button type="button" onClick={() => go('dashboard', current.id)}>Dashboard</button>
            <button type="button" onClick={() => { void loadDocs(); }}>Documents</button>
            <button type="button" onClick={() => go('search', current.id)}>Search</button>
            <button type="button" onClick={() => { void loadRecent(); }}>Recent</button>
            <button type="button" onClick={() => go('note', current.id)}>Add note</button>
          </nav>
          {!accessToken(current.id) ? <button type="button" onClick={() => { void signIn(current); }}>Sign in</button> : null}
          {view === 'dashboard' && dash ? (
            <section>
              <h1>Dashboard</h1>
              <p>As of {dash.as_of ? formatWhen(dash.as_of, zone) : '—'}</p>
              <p>{dash.state_line || 'No STATE line.'}</p>
              <pre>{dash.handoff || 'No handoff section.'}</pre>
              <p>Recent episodic: {dash.recent_episodic ?? '—'}</p>
              <ul className="cards">
                {(dash.areas?.areas || []).map((area) => (
                  <li key={area.slug}>
                    <button type="button" className="card" onClick={() => { if (area.slug) void openArea(area.slug); }}>{area.title || area.slug}</button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {view === 'docs' ? (
            <DocList screen={screen} onOpen={(id) => { void openDoc(id); }} />
          ) : null}
          {view === 'doc' ? <DocView screen={screen} /> : null}
          {view === 'area' ? <pre>{JSON.stringify(screen.area, null, 2)}</pre> : null}
          {view === 'search' ? (
            <section>
              <h1>Search</h1>
              <label>Query
                <input value={query} onChange={(event) => setQuery(event.target.value)} />
              </label>
              <button type="button" onClick={() => setMode(mode === 'keyword' ? 'semantic' : 'keyword')}>{mode}</button>
              <button type="button" onClick={() => { void runSearch(); }}>Search</button>
              <SearchList data={screen.search} />
            </section>
          ) : null}
          {view === 'recent' ? <pre>{JSON.stringify(screen.recent, null, 2)}</pre> : null}
          {view === 'note' ? (
            <section>
              <h1>Add note</h1>
              <label>Layer
                <select value={layer} onChange={(event) => setLayer(event.target.value as typeof layer)}>
                  <option value="episodic">episodic</option>
                  <option value="semantic">semantic</option>
                  <option value="working">working</option>
                </select>
              </label>
              <label>Note
                <textarea value={note} onChange={(event) => setNote(event.target.value)} rows={6} />
              </label>
              {!confirmNote ? (
                <button type="button" onClick={() => setConfirmNote(true)} disabled={!note.trim()}>Continue</button>
              ) : (
                <div className="panel">
                  <p>Save this note on {current.name}?</p>
                  <button type="button" onClick={() => { void saveNote(); }}>Save on {current.name}</button>
                  <button type="button" onClick={() => setConfirmNote(false)}>Back</button>
                </div>
              )}
              {screen.note ? <p>Receipt {(screen.note as { receipt?: { sha256?: string } }).receipt?.sha256}</p> : null}
            </section>
          ) : null}
          <p>
            <button type="button" className="text" onClick={() => go('settings', null)}>Time zone</button>
          </p>
        </main>
      )}
      {view === 'settings' ? (
        <section className="panel">
          <h1>Time zone</h1>
          <label>Zone
            <input value={zone} onChange={(event) => { setZone(event.target.value); setTimeZone(event.target.value); }} />
          </label>
          <p>Times show with {zone === 'America/New_York' ? 'ET' : zone}.</p>
        </section>
      ) : null}
    </div>
  );
}

function DocList({ screen, onOpen }: { screen: ScreenState; onOpen: (id: string) => void }) {
  const data = screen.documents as { documents?: { doc_id?: string; version?: number; retired?: boolean }[] } | null;
  return (
    <section>
      <h1>Documents</h1>
      <ul className="cards">
        {(data?.documents || []).map((doc) => (
          <li key={doc.doc_id}>
            <button type="button" className="card" onClick={() => { if (doc.doc_id) onOpen(doc.doc_id); }}>
              {doc.doc_id} {doc.retired ? <span className="badge">retired</span> : null}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function DocView({ screen }: { screen: ScreenState }) {
  const doc = screen.document as { doc_id?: string; version?: number; sha256?: string; updated_by?: string; session_id?: string; retired?: boolean; superseded?: boolean; content?: string } | null;
  if (!doc) return null;
  const sha = doc.sha256 || '';
  return (
    <article>
      <h1>{doc.doc_id}</h1>
      <p>version {doc.version ?? '—'} · {doc.updated_by || 'unknown writer'}</p>
      <p>sha256 {sha.slice(0, 12)} <span className="muted">{sha}</span></p>
      {doc.retired ? <span className="badge">retired</span> : null}
      {doc.superseded ? <span className="badge">superseded</span> : null}
      <pre>{doc.content}</pre>
    </article>
  );
}

function SearchList({ data }: { data: unknown }) {
  const rows = Array.isArray((data as { data?: unknown[] } | null)?.data)
    ? (data as { data: { content?: string; ended_at?: string; superseded_at?: string }[] }).data
    : [];
  return (
    <ul>
      {rows.map((row, index) => {
        const ended = row.ended_at || row.superseded_at;
        return <li key={index} className={ended ? 'ended' : undefined}>{row.content}{ended ? ` · ended ${ended}` : ''}</li>;
      })}
    </ul>
  );
}

export { memoryStore };
