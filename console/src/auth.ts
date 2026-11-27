import { loadDeviceKey, saveDeviceKey } from './idb.js';
import type { ServerEntry } from './vault.js';

const VERIFIER_KEY = 'emet-console-pkce';

function randomUrlBytes(size: number): string {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

export async function ensureDeviceKey(serverId: string): Promise<string> {
  const existing = await loadDeviceKey(serverId);
  if (existing) return existing.publicEncoded;
  const key = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const jwk = await crypto.subtle.exportKey('jwk', key.publicKey);
  const pub = { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y };
  const publicEncoded = btoa(JSON.stringify(pub)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
  await saveDeviceKey(serverId, key, publicEncoded);
  return publicEncoded;
}

export function clientId(): string {
  return `${location.origin}/.well-known/emet-console-client.json`;
}

export function redirectUri(): string {
  return `${location.origin}/callback`;
}

/** Opens that server's own /authorize. The password is typed there, not here. */
export async function authorizeUrl(server: ServerEntry): Promise<string> {
  const verifier = randomUrlBytes(32);
  sessionStorage.setItem(`${VERIFIER_KEY}:${server.id}`, verifier);
  const deviceKey = await ensureDeviceKey(server.id);
  const url = new URL('/authorize', server.baseUrl);
  url.searchParams.set('client_id', clientId());
  url.searchParams.set('redirect_uri', redirectUri());
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'emet.console');
  url.searchParams.set('code_challenge', await s256(verifier));
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', server.id);
  url.searchParams.set('resource', `${server.baseUrl.replace(/\/$/, '')}/console/api`);
  url.searchParams.set('device_key', deviceKey);
  return url.toString();
}

export function takeVerifier(serverId: string): string | null {
  const key = `${VERIFIER_KEY}:${serverId}`;
  const value = sessionStorage.getItem(key);
  sessionStorage.removeItem(key);
  return value;
}

export async function signRefresh(serverId: string, nonce: string, timestamp: number): Promise<string | null> {
  const stored = await loadDeviceKey(serverId);
  if (!stored) return null;
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    stored.key.privateKey,
    new TextEncoder().encode(`${nonce}.${timestamp}`)
  );
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}
