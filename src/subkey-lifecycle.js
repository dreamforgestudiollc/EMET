/**
 * Sub-key session lifetime (handle renewal, grace, and the backstop).
 *
 * A handle lasts 12 hours. The last hour is the renewal window. After
 * expiry, the same length is a grace window. Past that, the session is
 * stranded and the sweep can close it. This module is the clock and the
 * words. The store writes live in src/subkeys.js.
 *
 * A client_kind on the call is not a kind. The kind is the value the owner
 * stored on the key.
 */

import { setting } from './env.js';

export const HANDLE_TTL_MS = 12 * 60 * 60 * 1000;

export const UNWRAPPED_NOTICE =
  'The previous chat was not wrapped up. Go back to that chat and wrap it up to save it.';

export const RENEW_MESSAGE =
  'Wrap up and call emet_session_open with your sub-key and this session_handle. The server cannot push a new handle to an idle client.';

const TERMINAL = new Set(['closed', 'auto_closed', 'revoked']);

export function isTerminalState(state) {
  return TERMINAL.has(state);
}

/** 'chat', 'bot', or null when the value is absent or not one of those two. */
export function clientKindValue(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  if (!text) return null;
  if (text === 'chat' || text === 'bot') return text;
  return null;
}

/** The kind stored on the key. A missing value is a bot: the collision rule stays. */
export function clientKindOf(row) {
  return row && row.client_kind === 'chat' ? 'chat' : 'bot';
}

export function renewalWindowMs() {
  const raw = setting('SUBKEY_RENEWAL_MINUTES');
  const cap = Math.floor(HANDLE_TTL_MS / 60000) - 1;
  if (raw === undefined || raw === null || String(raw).trim() === '') return 60 * 60 * 1000;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return 60 * 60 * 1000;
  return Math.min(Math.floor(n), cap) * 60 * 1000;
}

export function handleGraceMs() {
  const raw = setting('SUBKEY_HANDLE_GRACE_MINUTES');
  if (raw === undefined || raw === null || String(raw).trim() === '') return 60 * 60 * 1000;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 60 * 60 * 1000;
  return Math.floor(n) * 60 * 1000;
}

export function sweepIntervalMs() {
  const raw = setting('SUBKEY_SWEEP_MINUTES');
  if (raw === undefined || raw === null || String(raw).trim() === '') return 15 * 60 * 1000;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return 15 * 60 * 1000;
  return Math.floor(n) * 60 * 1000;
}

/**
 * Where a handle sits against its expiry.
 * fresh: more than the renewal window remains.
 * window: inside the last stretch, the handle still verifies.
 * grace: expired, and a renewal that presents the key is still open.
 * beyond: the grace window is over.
 */
export function phaseOf(expiresAt, now, windowMs = renewalWindowMs(), graceMs = handleGraceMs()) {
  const exp = expiresAt ? new Date(expiresAt).getTime() : NaN;
  if (!Number.isFinite(exp)) return 'fresh';
  const t = now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (!Number.isFinite(t)) return 'fresh';
  if (t >= exp + graceMs) return 'beyond';
  if (t >= exp) return 'grace';
  if (t >= exp - windowMs) return 'window';
  return 'fresh';
}

export function renewalRequest(session) {
  return {
    action: 'reinitialize',
    session_id: session && session.session_id || null,
    open_id: session && session.open_id || null,
    expires_at: session && session.expires_at || null,
    message: RENEW_MESSAGE
  };
}

/**
 * The code http-remote puts on a preflight failure.
 * A stranded session is EMET-SESS-014. It is not EMET-AUTH-039.
 */
export function preflightHttpCode(err) {
  if (!err) return null;
  if (err.subkeyHold) return 'EMET-SESS-014';
  if (err.attributionRefusal) return err.emetCode === 'EMET-AUTH-044' ? 'EMET-AUTH-044' : 'EMET-AUTH-039';
  return null;
}
