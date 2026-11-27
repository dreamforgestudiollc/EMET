import { readFileSync } from 'node:fs';
import path from 'node:path';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from './App.js';
import { cacheShell } from './cache-policy.js';
import { healthDot } from './api.js';
import { accessToken, buildRequest, removeServer, setAccessToken, switchServer, type Remembered, type RememberedStore, type ServerEntry } from './vault.js';

const A = 'token-for-server-a';
const B = 'token-for-server-b';

function servers(): ServerEntry[] {
  return [
    { id: 'a', name: 'Server A', baseUrl: 'https://a.example', meta: { name: 'A', version: '0.3.2' }, signedIn: true },
    { id: 'b', name: 'Server B', baseUrl: 'https://b.example', meta: { name: 'B', version: '0.3.2' }, signedIn: true }
  ];
}

function memoryStore(): RememberedStore & { rows: Map<string, Remembered>; deleted: string[] } {
  const rows = new Map<string, Remembered>();
  const deleted: string[] = [];
  return {
    rows,
    deleted,
    async put(id, row) { rows.set(id, row); },
    async get(id) { return rows.get(id) ?? null; },
    async delete(id) { rows.delete(id); deleted.push(id); }
  };
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  setAccessToken('a', null);
  setAccessToken('b', null);
});

describe('per-server requests', () => {
  it('uses only the active server token and clears the screen on switch', async () => {
    localStorage.setItem('emet-console-servers', JSON.stringify(servers()));
    setAccessToken('a', A);
    setAccessToken('b', B);
    const calls: { url: string; authorization: string | null }[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      calls.push({ url, authorization: headers.get('authorization') });
      if (url.endsWith('/console/api/meta')) return new Response(JSON.stringify({ name: 'EMET', console_api: 1 }), { status: 200 });
      const token = headers.get('authorization');
      const line = token === `Bearer ${A}` ? 'dashboard from A' : 'dashboard from B';
      return new Response(JSON.stringify({ as_of: '2026-11-24T16:00:00.000Z', state_line: line, handoff: '', recent_episodic: 1, areas: { areas: [] } }), { status: 200 });
    };
    render(<App store={memoryStore()} fetchImpl={fetchImpl} />);
    fireEvent.click(screen.getByRole('button', { name: /Server A/ }));
    await waitFor(() => expect(screen.getByText('dashboard from A')).toBeTruthy());
    const aCall = calls.find((call) => call.url === 'https://a.example/console/api/dashboard');
    expect(aCall?.authorization).toBe(`Bearer ${A}`);
    expect(calls.some((call) => call.url.startsWith('https://b.example') && call.authorization === `Bearer ${A}`)).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'EMET' }));
    fireEvent.click(screen.getByRole('button', { name: /Server B/ }));
    await waitFor(() => expect(screen.getByText('dashboard from B')).toBeTruthy());
    expect(screen.queryByText('dashboard from A')).toBeNull();
    const bCall = calls.filter((call) => call.url === 'https://b.example/console/api/dashboard').at(-1);
    expect(bCall?.authorization).toBe(`Bearer ${B}`);
    expect(calls.filter((call) => call.url === 'https://b.example/console/api/dashboard').every((call) => call.authorization !== `Bearer ${A}`)).toBe(true);
    expect(switchServer('b').dashboard).toBeNull();
    expect(buildRequest({ id: 'b', baseUrl: 'https://b.example' }, '/console/api/dashboard').headers.authorization).toBe(`Bearer ${B}`);
  });

  it('removing a server deletes its token and remembered key', async () => {
    const list = servers();
    localStorage.setItem('emet-console-servers', JSON.stringify(list));
    setAccessToken('a', A);
    const store = memoryStore();
    await store.put('a', { refreshToken: 'refresh-a', deviceId: 'device-a', nonce: 'nonce-a' });
    const next = await removeServer(list, 'a', store);
    expect(next.map((row) => row.id)).toEqual(['b']);
    expect(accessToken('a')).toBeNull();
    expect(store.deleted).toContain('a');
    expect(store.rows.has('a')).toBe(false);
    expect(localStorage.getItem('emet-console-servers')).not.toContain(A);
    expect(localStorage.getItem('emet-console-servers')).not.toContain('refresh-a');
    render(<App store={store} fetchImpl={async () => new Response(JSON.stringify({ ok: true }), { status: 200 })} />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove' })[0]);
    await waitFor(() => expect(screen.queryByText('Server B')).toBeNull());
  });
});

describe('status dot', () => {
  it('reads GET /console/api/meta and not /health', async () => {
    const urls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ console_api: 1, name: 'EMET' }), { status: 200 });
    };
    expect(await healthDot('https://a.example/', fetchImpl)).toBe('up');
    expect(urls).toEqual(['https://a.example/console/api/meta']);
  });
});

describe('service worker cache', () => {
  it('does not cache console API responses', () => {
    expect(cacheShell('https://console.example/console/api/dashboard', 'https://console.example')).toBe(false);
    expect(cacheShell('https://a.example/console/api/notes', 'https://console.example')).toBe(false);
    expect(cacheShell('https://console.example/assets/app.js', 'https://console.example')).toBe(true);
    expect(cacheShell('https://console.example/', 'https://console.example')).toBe(true);
    const worker = readFileSync(path.join(process.cwd(), 'public/sw.js'), 'utf8');
    const guard = worker.indexOf("pathname.startsWith('/console/api')");
    const put = worker.indexOf('cache.put');
    expect(guard).toBeGreaterThan(-1);
    expect(put).toBeGreaterThan(guard);
  });
});
