/**
 * EMET Console sessions.
 *
 * Access tokens live in the OAuth token collection and last 15 minutes.
 * A refresh row exists only when the person ticked "remember this phone"
 * on the server's own sign-in page. The row stores a hash of the refresh
 * token and the device public key, never the token and never a password.
 *
 * These rows are not memory, documents, or transcripts.
 */

import crypto from 'node:crypto';
import { COLLECTION_PREFIX } from './database.js';
import { setting } from './env.js';

export const CONSOLE_SCOPE = 'emet.console';
export const CONSOLE_SOURCE_TAG = 'emet-console';
export const CONSOLE_API_VERSION = 1;
export const CONSOLE_ACCESS_TTL_S = 15 * 60;
export const CONSOLE_NOTE_LAYERS = Object.freeze(['episodic', 'semantic', 'working']);

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_IDLE_DAYS = 14;
const DEFAULT_ABSOLUTE_DAYS = 30;
const SIGNATURE_SKEW_MS = 5 * 60 * 1000;

let nowFn = () => Date.now();

/** Wall clock for expiry. Tests pin it only while EMET_UNDER_TEST=1. */
export function consoleNow() {
  return nowFn();
}

export function setConsoleClockForTests(fn) {
  if (process.env.EMET_UNDER_TEST !== '1') return;
  nowFn = typeof fn === 'function' ? fn : (() => Date.now());
}

function positiveDays(name, fallback) {
  const raw = setting(name);
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

export function refreshLimits() {
  return {
    idleMs: positiveDays('CONSOLE_REFRESH_IDLE_DAYS', DEFAULT_IDLE_DAYS) * DAY_MS,
    absoluteMs: positiveDays('CONSOLE_REFRESH_ABSOLUTE_DAYS', DEFAULT_ABSOLUTE_DAYS) * DAY_MS
  };
}

/** Exact origins from EMET_CONSOLE_ORIGINS. Empty means the console API is off. */
export function consoleOrigins(env = process.env) {
  const raw = env.EMET_CONSOLE_ORIGINS ?? env.CASCADE_CONSOLE_ORIGINS ?? '';
  return String(raw).split(',').map((s) => s.trim()).filter(Boolean);
}

export function consoleApiEnabled(env = process.env) {
  return consoleOrigins(env).length > 0;
}

export function originAllowed(origin, env = process.env) {
  if (typeof origin !== 'string' || origin === '' || origin === 'null') return false;
  return consoleOrigins(env).includes(origin);
}

export function consoleAudience(issuer) {
  const base = String(issuer || '').replace(/\/+$/, '');
  return `${base}/console/api`;
}

export function refreshCollection(db, prefix = COLLECTION_PREFIX) {
  if (!db || typeof db.collection !== 'function') return null;
  return db.collection(`${prefix}console_refresh`);
}

export function tokenDigest(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

/** Stable id for one device key. The private key never enters this. */
export function deviceIdForKey(jwk) {
  if (!isDevicePublicJwk(jwk)) return null;
  return crypto.createHash('sha256').update(`${jwk.crv}.${jwk.x}.${jwk.y}`).digest('base64url');
}

export function isDevicePublicJwk(jwk) {
  if (!jwk || typeof jwk !== 'object' || Array.isArray(jwk)) return false;
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256') return false;
  if (typeof jwk.x !== 'string' || typeof jwk.y !== 'string' || !jwk.x || !jwk.y) return false;
  if (Object.prototype.hasOwnProperty.call(jwk, 'd')) return false;
  return true;
}

export function parseDeviceKey(raw) {
  if (typeof raw !== 'string' || raw.length < 20 || raw.length > 4000) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    return isDevicePublicJwk(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function verifyDeviceSignature(jwk, nonce, timestamp, signature) {
  if (!isDevicePublicJwk(jwk)) return false;
  if (typeof nonce !== 'string' || !nonce) return false;
  if (typeof signature !== 'string' || !signature) return false;
  const ts = typeof timestamp === 'number' ? timestamp : Number(timestamp);
  if (!Number.isInteger(ts)) return false;
  if (Math.abs(consoleNow() - ts) > SIGNATURE_SKEW_MS) return false;
  let key;
  try {
    key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  } catch {
    return false;
  }
  let sig;
  try { sig = Buffer.from(signature, 'base64url'); }
  catch { return false; }
  if (!sig.length) return false;
  try {
    return crypto.verify('sha256', Buffer.from(`${nonce}.${ts}`), { key, dsaEncoding: 'ieee-p1363' }, sig);
  } catch {
    return false;
  }
}

export async function findRefreshByDevice(db, prefix, deviceId) {
  const col = refreshCollection(db, prefix);
  if (!col || !deviceId) return null;
  return col.findOne({ device_id: deviceId });
}
