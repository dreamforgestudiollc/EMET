/**
 * EMET - delegated client sub-keys (EMET-0001).
 *
 * Off unless EMET_SUBKEYS=1. One owner login, one server. Each AI client
 * writes under a tag the server verifies against an approved key, not a tag
 * the caller names. Keys, claim nonces and session handles are stored only
 * as peppered HMACs. Plaintext is returned once and never written into a
 * record, a receipt, a log line or session_graph.
 *
 * Records live in the subkeys collection and its history collection
 * (src/subkey-store.js), not in emet/CLIENT_APPROVALS.md. Nothing in this
 * module deletes a record. A later state is written beside the earlier one.
 * Each session open is its own record.
 */

import crypto from 'node:crypto';
import { setting } from './env.js';
import {
  personIsOwner, actorIsOwner, actorIsCos, cosTag, sessionBaseOf,
  rememberSubkeySession
} from './attribution.js';
import { parseReceipts } from './session.js';
import { storeFor, sweepFlagOffLiveSessions } from './subkey-store.js';

const KEY_PREFIX = 'emk_';
const HANDLE_PREFIX = 'emh_';
const NONCE_PREFIX = 'emn_';
const CLAIM_TTL_MS = 24 * 60 * 60 * 1000;
const HANDLE_TTL_MS = 12 * 60 * 60 * 1000;
const OPEN_STALE_MS = 5000;
const EXPIRY_NOTICE_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_FAIL_MAX = 5;
const DEFAULT_FAIL_WINDOW_MS = 15 * 60 * 1000;

export const SUBKEY_TOOLS = Object.freeze([
  'emet_subkey_request', 'emet_subkey_claim', 'emet_subkey_revoke', 'emet_subkey_end_session'
]);
/** Tools a verified sub-key session must not call. Settings and access stay on the owner login. */
const OWNER_ONLY_TOOLS = Object.freeze(new Set([
  'emet_client_approve',
  'emet_subkey_request', 'emet_subkey_claim', 'emet_subkey_revoke', 'emet_subkey_end_session',
  'emet_invite_create', 'emet_member_access_create', 'emet_setup_complete'
]));

const KEY_RE = /^emk_([0-9a-f]{32})_([A-Za-z0-9_-]{43})$/;
const HANDLE_RE = /^emh_[A-Za-z0-9_-]{43}$/;
const NONCE_RE = /^emn_[A-Za-z0-9_-]{43}$/;

let openTokens = new WeakMap();
const throttle = createThrottle();

function subkeysEnabled() { return setting('SUBKEYS') === '1'; }

export function _resetForTests() {
  openTokens = new WeakMap();
  throttle.reset();
}

function refusal(msg) {
  const e = new Error(msg);
  e.attributionRefusal = true;
  return e;
}

function b64(bytes) { return crypto.randomBytes(bytes).toString('base64url'); }
function hexId() { return crypto.randomBytes(16).toString('hex'); }

export function splitKeyToken(token) {
  const m = KEY_RE.exec(typeof token === 'string' ? token.trim() : '');
  return m ? { key_id: m[1], secret: m[2] } : null;
}

/** Current pepper, and the previous one while a rotation is in progress. */
export function pepperState() {
  const cur = setting('SUBKEY_PEPPER');
  if (typeof cur !== 'string' || Buffer.byteLength(cur) < 32) return null;
  const verRaw = Number(setting('SUBKEY_PEPPER_VERSION'));
  const version = Number.isInteger(verRaw) && verRaw > 0 ? verRaw : 1;
  const prev = setting('SUBKEY_PEPPER_PREV');
  const prevVerRaw = Number(setting('SUBKEY_PEPPER_PREV_VERSION'));
  const prevVersion = Number.isInteger(prevVerRaw) && prevVerRaw > 0 ? prevVerRaw : version - 1;
  const previous = typeof prev === 'string' && Buffer.byteLength(prev) >= 32 && prevVersion !== version
    ? { version: prevVersion, pepper: prev }
    : null;
  return { current: { version, pepper: cur }, previous };
}

function requirePepper() {
  const p = pepperState();
  if (!p) throw refusal('sub-keys are unavailable: EMET_SUBKEY_PEPPER is missing or shorter than 32 bytes. Nothing was changed.');
  return p;
}

function macOf(pepper, value) {
  return crypto.createHmac('sha256', pepper).update(String(value)).digest('hex');
}

/** Constant-time compare of two hex HMACs. A length mismatch is a miss, not a throw. */
export function macEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) {
    crypto.timingSafeEqual(ab, ab);
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

/**
 * Compare `value` with a stored `{ mac, pepper_version }`. Both the current
 * and previous peppers are hashed so a version check does not skip a compare.
 */
export function verifyMac(record, value, peppers) {
  const cur = macOf(peppers.current.pepper, value);
  const prevPepper = peppers.previous ? peppers.previous.pepper : peppers.current.pepper;
  const prev = macOf(prevPepper, value);
  const mac = record && typeof record.mac === 'string' ? record.mac : cur.replace(/[0-9a-f]/g, '0');
  const eqCur = macEqual(cur, mac);
  const eqPrev = macEqual(prev, mac);
  const wantCur = !!(record && record.pepper_version === peppers.current.version);
  const wantPrev = !!(peppers.previous && record && record.pepper_version === peppers.previous.version);
  return (eqCur && wantCur) || (eqPrev && wantPrev);
}

function seal(value, peppers) {
  return { mac: macOf(peppers.current.pepper, value), pepper_version: peppers.current.version };
}

function ttlMs() {
  const raw = setting('SUBKEY_TTL_DAYS');
  let days = 30;
  if (raw !== undefined && String(raw).trim() !== '') {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 1) days = Math.floor(n);
  }
  if (days > 90) days = 90;
  return days * 24 * 60 * 60 * 1000;
}

function graceMs() {
  const raw = setting('SUBKEY_GRACE_MINUTES');
  if (raw === undefined || raw === null || String(raw).trim() === '') return 10 * 60 * 1000;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 10 * 60 * 1000;
  return Math.floor(n) * 60 * 1000;
}

function failMax() {
  const n = Number(setting('SUBKEY_FAIL_MAX'));
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_FAIL_MAX;
}
function failWindowMs() {
  const n = Number(setting('SUBKEY_FAIL_WINDOW_MS'));
  return Number.isFinite(n) && n >= 1000 ? Math.floor(n) : DEFAULT_FAIL_WINDOW_MS;
}

function bucketKeys({ keyId, clientId, sessionId }) {
  const out = [];
  if (keyId) out.push(`key:${keyId}`);
  if (clientId) out.push(`client:${clientId}`);
  if (sessionId) out.push(`session:${sessionId}`);
  return out;
}

/**
 * Failed presentations only. A later correct handle or nonce is not refused:
 * the secret is checked first, and a match clears the buckets it touches.
 * Buckets are per key, per client, and per session.
 */
function createThrottle() {
  const buckets = new Map();
  const live = (key, now) => {
    const windowMs = failWindowMs();
    const kept = (buckets.get(key) || []).filter((ts) => now - ts < windowMs);
    if (kept.length) buckets.set(key, kept); else buckets.delete(key);
    return kept;
  };
  return {
    reset() { buckets.clear(); },
    blocked(parts, now = Date.now()) {
      const max = failMax();
      return bucketKeys(parts).some((k) => live(k, now).length >= max);
    },
    fail(parts, now = Date.now()) {
      for (const k of bucketKeys(parts)) {
        const list = live(k, now);
        list.push(now);
        buckets.set(k, list);
      }
    },
    clear(parts) {
      for (const k of bucketKeys(parts)) buckets.delete(k);
    }
  };
}

const THROTTLE_MSG = 'too many failed sub-key presentations. Try again later. Nothing was written.';

/** Record a failed present. Returns the throttle sentence once a bucket is already full, else null. */
function noteFailure(parts, now) {
  const t = now.getTime();
  if (throttle.blocked(parts, t)) return THROTTLE_MSG;
  throttle.fail(parts, t);
  return null;
}

function clearPresent(parts) { throttle.clear(parts); }

function assertHttpOwner(actor, ownerId) {
  if (!actor || actor.transport !== 'http' || !actor.authenticated) {
    throw refusal('sub-keys apply only to authenticated HTTP. Stdio keeps the registry rules. Nothing was changed.');
  }
  if (!personIsOwner(actor, ownerId || actor.ownerId)) {
    throw refusal('sub-keys are limited to the owner\'s own login. Invite and Member Access logins cannot request, claim or present one. Nothing was changed.');
  }
}

function assertOwnerActor(actor, ownerId, what) {
  assertHttpOwner(actor, ownerId);
  if (!actorIsOwner(actor, ownerId || actor.ownerId)) {
    throw refusal(`${what}: only the owner's own login may do this. Nothing was changed.`);
  }
}

function tagAllowed(tag, registry) {
  const t = typeof tag === 'string' ? tag.trim() : '';
  if (!t || t.includes('/') || t.length > 80) return null;
  const list = Array.isArray(registry) ? registry : [];
  if (!list.includes(t)) return null;
  return t;
}

function past(iso, now) {
  if (!iso) return false;
  const ms = new Date(iso).getTime();
  return Number.isFinite(ms) && ms <= now.getTime();
}

function pushHistory(row, event, extra = {}) {
  row.history = Array.isArray(row.history) ? row.history : [];
  const event_id = extra.event_id || `h:${row.key_id || 'key'}:${hexId()}`;
  row.history.push({ ...extra, event_id, event, at: extra.at || new Date().toISOString() });
}

function ensureMaps(data) {
  if (!data.keys || typeof data.keys !== 'object' || Array.isArray(data.keys)) data.keys = {};
  if (!Array.isArray(data.sessions)) data.sessions = [];
}

function keyById(data, keyId) {
  const row = data.keys && data.keys[keyId];
  return row && typeof row === 'object' ? row : null;
}

function pendingForTag(data, tag) {
  return Object.values(data.keys || {}).find((k) => k && k.tag === tag && k.status === 'pending') || null;
}

function usableKey(row, now) {
  if (!row) return false;
  if (row.status === 'active') return !past(row.expires_at, now);
  if (row.status === 'grace') return !past(row.grace_until, now) && !past(row.expires_at, now);
  return false;
}

function sessionByOpen(data, openId) {
  if (!openId) return null;
  return (data.sessions || []).find((s) => s && s.open_id === openId) || null;
}

function sessionsForBase(data, base) {
  return (data.sessions || []).filter((s) => s && s.session_id === base);
}

/** The unexpired live open for a base, or the latest open when none is. */
function currentSession(data, base, now) {
  const rows = sessionsForBase(data, base);
  const live = rows.filter((s) => s.state === 'live' && !past(s.expires_at, now));
  if (live.length) return live[live.length - 1];
  return rows.length ? rows[rows.length - 1] : null;
}

function openIsStale(iso, now) {
  const ms = iso ? new Date(iso).getTime() : NaN;
  return !Number.isFinite(ms) || now.getTime() - ms >= OPEN_STALE_MS;
}

function livePointer(row, data, now) {
  if (!row || !row.live_session_id) return null;
  const s = sessionByOpen(data, row.live_session_id);
  if (!s) {
    if (openIsStale(row.live_set_at, now)) return null;
    return { open_id: row.live_session_id, key_id: row.key_id, state: 'opening' };
  }
  if (s.key_id !== row.key_id) return null;
  if (s.state === 'opening') return openIsStale(s.opened_at || row.live_set_at, now) ? null : s;
  if (s.state !== 'live') return null;
  if (past(s.expires_at, now)) return null;
  return s;
}

function registryOf(envList) {
  if (Array.isArray(envList)) return envList;
  return String(setting('SOURCE_TAGS') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

async function requireStore(deps) {
  const store = await storeFor(deps);
  if (!store) throw refusal('sub-key store is unavailable. Nothing was written.');
  return store;
}

async function edit(deps, fn) {
  try {
    const store = await requireStore(deps);
    return await store.mutate(fn);
  } catch (e) {
    if (e && e.attributionRefusal) throw e;
    const message = e && e.message ? e.message : 'unknown error';
    if (e && e.partial) throw refusal(`sub-key store failed. ${message}`);
    throw refusal(`sub-key store failed. Nothing was written. (${message})`);
  }
}

/** Snapshot of keys, session opens, and history. Server-side. Callers that show it use subkeysView or readSubkeyHistory. */
export async function loadSubkeyRecords(deps) {
  return (await requireStore(deps)).snapshot();
}

/** One flag-off sweep. Null when it failed. Never throws. */
export async function sweepFlagOffSessions(log) {
  if (subkeysEnabled()) return 0;
  try {
    const ended = await sweepFlagOffLiveSessions((base) => rememberSubkeySession(base));
    if (ended > 0 && typeof log === 'function') log(`sub-key flag-off sweep ended ${ended} live session${ended === 1 ? '' : 's'}`);
    return ended || 0;
  } catch (e) {
    if (typeof log === 'function') log(`sub-key flag-off sweep failed: ${e && e.message ? e.message : 'unknown error'}`);
    return null;
  }
}

const SWEEP_BACKOFF_MS = [1000, 2000, 4000];

/** One sweep after listen, then a few retries. It does not retry forever. */
export function startFlagOffSweep(log) {
  if (subkeysEnabled()) return;
  const go = (n) => {
    sweepFlagOffSessions(log).then((ended) => {
      if (ended !== null || n >= SWEEP_BACKOFF_MS.length) return;
      const t = setTimeout(() => go(n + 1), SWEEP_BACKOFF_MS[n]);
      if (t.unref) t.unref();
    });
  };
  go(0);
}

/**
 * The session a close releases. `receipts.transcript_session_id` is the field
 * the close check compares. When that field is present it wins. A session_id
 * that names a different session does not release either one.
 */
export function sessionIdForClose(args) {
  const a = args || {};
  const receipts = parseReceipts(a.receipts);
  const receiptRaw = receipts && typeof receipts.transcript_session_id === 'string' ? receipts.transcript_session_id.trim() : '';
  const argRaw = typeof a.session_id === 'string' ? a.session_id.trim() : '';
  const receiptBase = receiptRaw ? sessionBaseOf({ session_id: receiptRaw }) : null;
  const argBase = argRaw ? sessionBaseOf({ session_id: argRaw }) : null;
  if (receiptBase && argBase && receiptBase !== argBase) return { mismatch: true, base: null };
  return { mismatch: false, base: receiptBase || argBase };
}

/**
 * Request a sub-key for one registered tag. The response carries the claim
 * nonce once. The record stores only its HMAC.
 */
export async function requestSubkey(deps, actor, { tag } = {}, registry = [], now = new Date()) {
  if (!subkeysEnabled()) throw refusal('sub-keys are off (EMET_SUBKEYS is not 1). Nothing was changed.');
  const peppers = requirePepper();
  assertHttpOwner(actor, actor && actor.ownerId);
  const list = registryOf(registry);
  const t = tagAllowed(tag, list);
  if (!t) throw refusal('emet_subkey_request: "tag" must be an exact member of EMET_SOURCE_TAGS. Nothing was changed.');
  const nonce = `${NONCE_PREFIX}${b64(32)}`;
  const key_id = hexId();
  let created = null;
  await edit(deps, (data) => {
    ensureMaps(data);
    if (pendingForTag(data, t)) throw refusal(`a sub-key for "${t}" is already awaiting approval. Nothing was changed.`);
    const current = Object.values(data.keys).filter((k) => k && k.tag === t && (k.status === 'active' || k.status === 'grace') && usableKey(k, now));
    const replaces = current.length ? current[current.length - 1].key_id : null;
    const row = {
      key_id, tag: t, status: 'pending',
      client_id: actor.clientId || null, grant_id: actor.grantId || null,
      person_id: actor.personId || null, login_tag: actor.sourceTag || null,
      requested_at: now.toISOString(),
      nonce_hmac: seal(nonce, peppers), nonce_spent: false,
      replaces, collisions: [], history: []
    };
    pushHistory(row, 'request', { at: row.requested_at, by: actor.clientId || null, client_id: actor.clientId || null });
    data.keys[key_id] = row;
    created = { key_id, tag: t, replaces };
    return true;
  });
  return { key_id, tag: t, nonce, claim_expires_after: '24 hours from approval', replaces: created && created.replaces, status: 'pending' };
}

/**
 * Approve or deny a pending sub-key. Same client_id or grant as the request
 * is refused. A key_id decides that row; a different pending row for the tag
 * is a mismatch and is refused. With no key_id, the pending row for the tag
 * is decided. Returns null when nothing is pending, so the ordinary client
 * approval can proceed.
 */
export async function decideSubkeyIfPending(deps, actor, ownerId, { tag, decision, reason, key_id, via } = {}, now = new Date()) {
  if (!subkeysEnabled()) return null;
  const id = typeof key_id === 'string' ? key_id.trim() : '';
  const t = typeof tag === 'string' ? tag.trim() : '';
  if (!id && !t) return null;
  const cur = await loadSubkeyRecords(deps);
  if (id) {
    const row = keyById(cur, id);
    if (!row || row.status !== 'pending') return null;
  } else if (!pendingForTag(cur, t)) return null;
  requirePepper();
  assertHttpOwner(actor, ownerId);
  const ownerOk = actorIsOwner(actor, ownerId);
  const cosOk = actorIsCos(actor);
  if (!(ownerOk || cosOk)) throw refusal(`emet_client_approve: only the owner${cosTag() ? ` or the chief of staff (${cosTag()})` : ''} may decide a sub-key. Nothing was changed.`);
  const why = typeof reason === 'string' ? reason.trim() : '';
  const channel = typeof via === 'string' ? via.trim() : '';
  let result = null;
  await edit(deps, (data) => {
    ensureMaps(data);
    const row = id ? keyById(data, id) : pendingForTag(data, t);
    if (!row || row.status !== 'pending') { result = null; return false; }
    if (t && row.tag !== t) throw refusal('emet_client_approve: that sub-key does not match the tag. Nothing was changed.');
    const label = row.tag;
    const sameClient = !!row.client_id && row.client_id === (actor.clientId || null);
    const sameGrant = !!row.grant_id && row.grant_id === (actor.grantId || null);
    if (actor.transport === 'http' && (sameClient || sameGrant)) {
      throw refusal(`emet_client_approve: this connection requested the sub-key for "${label}", so it may not decide it. Decide from the owner's own login. Nothing was changed.`);
    }
    const by = ownerOk ? `owner (${actor.personId || 'local'})` : `cos ${cosTag()}`;
    const hist = { at: now.toISOString(), by, client_id: actor.clientId || null };
    if (why) hist.reason = why;
    if (channel) hist.via = channel;
    if (decision === 'approve') {
      row.status = 'approved';
      row.approved_by = by;
      row.approved_at = hist.at;
      row.approve_reason = why || null;
      pushHistory(row, 'approve', hist);
    } else if (decision === 'deny') {
      row.status = 'denied';
      row.approved_by = by;
      row.approved_at = hist.at;
      row.approve_reason = why || null;
      pushHistory(row, 'deny', hist);
    } else {
      throw refusal('emet_client_approve: "decision" must be "approve" or "deny". Nothing was changed.');
    }
    const replaces = row.replaces || null;
    result = {
      kind: 'subkey', tag: label, key_id: row.key_id, decision, by, at: row.approved_at,
      replaces,
      replaces_existing_key: !!replaces,
      ...(replaces ? { approval_note: `This approval replaces the existing key ${replaces} for "${label}". The old key stays in its grace window, then stops.` } : {})
    };
    return true;
  });
  return result;
}

export async function claimSubkey(deps, actor, { key_id, nonce } = {}, now = new Date()) {
  if (!subkeysEnabled()) throw refusal('sub-keys are off (EMET_SUBKEYS is not 1). Nothing was changed.');
  const peppers = requirePepper();
  assertHttpOwner(actor, actor && actor.ownerId);
  const id = typeof key_id === 'string' ? key_id.trim() : '';
  const presented = typeof nonce === 'string' ? nonce.trim() : '';
  const parts = { keyId: id || null, clientId: actor.clientId || null, sessionId: null };
  if (!id || !NONCE_RE.test(presented)) {
    const throttled = noteFailure(parts, now);
    throw refusal(throttled || 'emet_subkey_claim: pass "key_id" and the one-time "nonce" from emet_subkey_request. Nothing was changed.');
  }
  const secret = b64(32);
  const token = `${KEY_PREFIX}${id}_${secret}`;
  let result = null;
  let mismatch = false;
  await edit(deps, (data) => {
    ensureMaps(data);
    const row = keyById(data, id);
    const nonceOk = !!(row && verifyMac(row.nonce_hmac, presented, peppers));
    if (!row || row.nonce_spent || row.status !== 'approved' || !nonceOk) {
      mismatch = true;
      return false;
    }
    if (past(new Date(new Date(row.approved_at).getTime() + CLAIM_TTL_MS).toISOString(), now)) {
      row.status = 'expired';
      pushHistory(row, 'claim_expired', { at: now.toISOString(), client_id: actor.clientId || null });
      result = { expired: true };
      return true;
    }
    const grace = graceMs();
    if (row.replaces && data.keys[row.replaces]) {
      const old = data.keys[row.replaces];
      if (grace === 0) {
        old.status = 'revoked';
        old.revoked_at = now.toISOString();
        old.revoke_reason = 'rotated';
        old.replaced_by = id;
        endLive(data, old, 'revoked', now, 'rotated');
        pushHistory(old, 'revoked', { at: old.revoked_at, by: 'rotation', reason: 'rotated' });
      } else {
        old.status = 'grace';
        old.grace_until = new Date(now.getTime() + grace).toISOString();
        old.replaced_by = id;
        pushHistory(old, 'grace', { at: now.toISOString(), until: old.grace_until, replaced_by: id });
      }
    }
    row.nonce_spent = true;
    row.status = 'active';
    row.secret_hmac = seal(secret, peppers);
    row.owner_subject = actor.personId || null;
    row.created_at = now.toISOString();
    row.expires_at = new Date(now.getTime() + ttlMs()).toISOString();
    row.claimed_at = row.created_at;
    row.last_used = null;
    pushHistory(row, 'claim', { at: row.claimed_at, client_id: actor.clientId || null, pepper_version: peppers.current.version });
    result = { key_id: id, tag: row.tag, expires_at: row.expires_at };
    return true;
  });
  if (mismatch) {
    const throttled = noteFailure(parts, now);
    throw refusal(throttled || 'emet_subkey_claim: the key id or nonce does not match an unclaimed approval, or this nonce was already used. Nothing was changed.');
  }
  if (result && result.expired) throw refusal('emet_subkey_claim: this approval expired after 24 hours unclaimed. Request it again. Nothing was changed.');
  clearPresent(parts);
  return { ...result, subkey: token };
}

function endLive(data, row, state, now, reason) {
  if (!row || !row.live_session_id) return;
  const openId = row.live_session_id;
  const s = sessionByOpen(data, openId);
  if (s && s.key_id === row.key_id && s.state === 'live') {
    s.state = state;
    s.ended_at = now.toISOString();
    s.end_reason = reason || null;
  } else {
    if (s && s.key_id === row.key_id && s.state === 'opening') {
      s.state = 'ended';
      s.ended_at = now.toISOString();
      s.end_reason = reason || 'session lost';
    }
    pushHistory(row, 'session_lost', { at: now.toISOString(), open_id: openId, session_id: s ? s.session_id : null, reason: reason || null });
  }
  row.live_session_id = null;
  row.live_set_at = null;
}

export async function revokeSubkey(deps, actor, ownerId, { tag, key_id, reason } = {}, now = new Date()) {
  if (!subkeysEnabled()) throw refusal('sub-keys are off (EMET_SUBKEYS is not 1). Nothing was changed.');
  requirePepper();
  assertHttpOwner(actor, ownerId);
  const ownerOk = actorIsOwner(actor, ownerId);
  const cosOk = actorIsCos(actor);
  if (!(ownerOk || cosOk)) throw refusal('emet_subkey_revoke: only the owner\'s own login may revoke a sub-key. Nothing was changed.');
  const id = typeof key_id === 'string' ? key_id.trim() : '';
  const t = typeof tag === 'string' ? tag.trim() : '';
  if (!id && !t) throw refusal('emet_subkey_revoke: pass "tag" or "key_id". Nothing was changed.');
  let result = null;
  await edit(deps, (data) => {
    ensureMaps(data);
    const rows = id
      ? [keyById(data, id)].filter(Boolean)
      : Object.values(data.keys).filter((k) => k && k.tag === t && k.status !== 'revoked' && k.status !== 'denied');
    if (!rows.length) throw refusal('emet_subkey_revoke: no sub-key matched. Nothing was changed.');
    for (const row of rows) {
      if (!ownerOk && cosOk) {
        const same = (!!row.client_id && row.client_id === actor.clientId) || (!!row.grant_id && row.grant_id === actor.grantId);
        const live = sessionByOpen(data, row.live_session_id);
        const sameSession = live && ((live.client_id && live.client_id === actor.clientId) || (live.grant_id && live.grant_id === actor.grantId));
        if (same || sameSession) throw refusal('emet_subkey_revoke: the chief of staff can revoke only from a different OAuth client than the key\'s sessions. On this shared login, revoke from the owner\'s own login. Nothing was changed.');
      }
      if (row.status === 'revoked') continue;
      row.status = 'revoked';
      row.revoked_at = now.toISOString();
      row.revoked_by = ownerOk ? `owner (${actor.personId || 'local'})` : `cos ${cosTag()}`;
      row.revoke_reason = reason || null;
      endLive(data, row, 'revoked', now, reason || 'revoked');
      pushHistory(row, 'revoked', { at: row.revoked_at, by: row.revoked_by, reason: reason || null, client_id: actor.clientId || null });
      result = { key_id: row.key_id, tag: row.tag, status: 'revoked', at: row.revoked_at };
    }
    return true;
  });
  return result;
}

/** End the key's live session without revoking the key. Owner login only. */
export async function endSubkeySession(deps, actor, ownerId, { tag, key_id, reason } = {}, now = new Date()) {
  if (!subkeysEnabled()) throw refusal('sub-keys are off (EMET_SUBKEYS is not 1). Nothing was changed.');
  requirePepper();
  assertOwnerActor(actor, ownerId, 'emet_subkey_end_session');
  const id = typeof key_id === 'string' ? key_id.trim() : '';
  const t = typeof tag === 'string' ? tag.trim() : '';
  if (!id && !t) throw refusal('emet_subkey_end_session: pass "tag" or "key_id". Nothing was changed.');
  let result = null;
  await edit(deps, (data) => {
    ensureMaps(data);
    const row = id
      ? keyById(data, id)
      : Object.values(data.keys).find((k) => k && k.tag === t && k.live_session_id);
    if (!row) throw refusal('emet_subkey_end_session: no sub-key matched. Nothing was changed.');
    if (!row.live_session_id) throw refusal(`emet_subkey_end_session: "${row.tag}" has no live session. The key was not changed.`);
    const live = sessionByOpen(data, row.live_session_id);
    const base = live ? live.session_id : null;
    endLive(data, row, 'ended', now, reason || 'owner ended the live session');
    pushHistory(row, 'session_ended', { at: now.toISOString(), by: `owner (${actor.personId || 'local'})`, session_id: base, reason: reason || null });
    result = { key_id: row.key_id, tag: row.tag, status: row.status, session_id: base, ended: true };
    return true;
  });
  return result;
}

function lookupUsable(data, keyId, secret, peppers, now) {
  const row = keyById(data, keyId);
  const macOk = !!(row && row.secret_hmac && verifyMac(row.secret_hmac, secret, peppers));
  if (!row || !macOk) return { row: row || null, ok: false, changed: false, reason: 'mismatch' };
  if (row.status === 'grace' && past(row.grace_until, now)) {
    row.status = 'revoked';
    row.revoked_at = now.toISOString();
    row.revoke_reason = 'grace ended';
    endLive(data, row, 'revoked', now, 'grace ended');
    pushHistory(row, 'revoked', { at: row.revoked_at, by: 'grace', reason: 'grace ended' });
    return { row, ok: false, changed: true, reason: 'grace' };
  }
  if ((row.status === 'active' || row.status === 'grace') && past(row.expires_at, now)) {
    row.status = 'expired';
    endLive(data, row, 'expired', now, 'key expired');
    pushHistory(row, 'expired', { at: now.toISOString() });
    return { row, ok: false, changed: true, reason: 'expired' };
  }
  if (!usableKey(row, now)) return { row, ok: false, changed: false, reason: row.status };
  return { row, ok: true, changed: false };
}

function presentFailure(found) {
  if (found.reason === 'expired') return 'this sub-key is expired. Ask the owner to reissue it. Nothing was opened.';
  if (found.reason === 'grace' || (found.row && found.row.status === 'revoked')) return 'sub-key revoked; open a new session with a current key. Nothing was opened.';
  return 'emet_session_open: this sub-key does not match an active key. Nothing was opened.';
}

/**
 * Validate a presented key or handle before the strict login check.
 * The secret is checked before any throttle. A correct handle or key is
 * let through. Only a miss is counted, per key, per client, and per session.
 * Sets actor.subkeySession / subkeyTag / subkeyId. Stashes the raw key only
 * in a WeakMap for emet_session_open to commit, never on a logged field.
 */
export async function prepareSubkeyCall(ctx, actor, args, toolName) {
  if (!subkeysEnabled()) return;
  const now = (ctx && ctx.now) || new Date();
  const a = args || {};
  const handle = typeof a.session_handle === 'string' ? a.session_handle.trim() : '';
  const token = typeof a.subkey === 'string' ? a.subkey.trim() : '';
  const presentingKey = KEY_RE.test(token);
  const presentingHandle = handle.length > 0;

  if (SUBKEY_TOOLS.includes(toolName) && !presentingHandle && !presentingKey) {
    requirePepper();
    assertHttpOwner(actor, ctx && ctx.ownerId);
    return;
  }

  if (presentingKey && toolName !== 'emet_session_open') {
    throw refusal('a sub-key is presented only at emet_session_open. Pass session_handle on later writes. Nothing was written.');
  }

  const base = toolName === 'emet_session_open' ? null : sessionBaseOf(a);

  if (toolName === 'emet_session_open' && presentingKey) {
    const peppers = requirePepper();
    assertHttpOwner(actor, ctx && ctx.ownerId);
    const parts = splitKeyToken(token);
    const bucket = { keyId: parts.key_id, clientId: actor.clientId || null, sessionId: null };
    let outcome = null;
    await edit(ctx.deps, (data) => {
      ensureMaps(data);
      const found = lookupUsable(data, parts.key_id, parts.secret, peppers, now);
      if (!found.ok) { outcome = { fail: found }; return found.changed === true; }
      const live = livePointer(found.row, data, now);
      if (live) {
        found.row.collisions = Array.isArray(found.row.collisions) ? found.row.collisions : [];
        found.row.collisions.push({ at: now.toISOString(), client_id: actor.clientId || null, grant_id: actor.grantId || null });
        pushHistory(found.row, 'collision', { at: now.toISOString(), client_id: actor.clientId || null, grant_id: actor.grantId || null });
        outcome = { collision: true, key_id: found.row.key_id, tag: found.row.tag };
        return true;
      }
      outcome = { key_id: found.row.key_id, tag: found.row.tag };
      return false;
    });
    if (!outcome || (outcome.fail && outcome.fail.reason === 'mismatch')) {
      const throttled = noteFailure(bucket, now);
      throw refusal(throttled || presentFailure(outcome ? outcome.fail : { reason: 'mismatch' }));
    }
    if (outcome.fail) throw refusal(presentFailure(outcome.fail));
    clearPresent(bucket);
    if (outcome.collision) throw refusal('this sub-key already has a live session. Close it, or ask the owner to end it, before opening another. Nothing was opened.');
    actor.subkeySession = true;
    actor.subkeyTag = outcome.tag;
    actor.subkeyId = outcome.key_id;
    openTokens.set(actor, token);
    const declared = typeof a.source === 'string' && a.source.trim() ? a.source.trim() : '';
    if (declared && declared !== outcome.tag) {
      throw refusal(`this sub-key is bound to "${outcome.tag}"; "${declared}" does not match. Nothing was opened.`);
    }
    return;
  }

  if (toolName === 'emet_session_open' && token && !presentingKey) {
    const throttled = noteFailure({ keyId: null, clientId: actor.clientId || null, sessionId: null }, now);
    throw refusal(throttled || 'emet_session_open: this sub-key does not match an active key. Nothing was opened.');
  }

  if (!ctx || !ctx.deps) {
    if (presentingHandle) throw refusal('sub-keys are unavailable. Nothing was written.');
    return;
  }

  let session = null;
  await edit(ctx.deps, (data) => {
    ensureMaps(data);
    if (base) session = currentSession(data, base, now);
    return false;
  });

  if (session) {
    const peppers = requirePepper();
    assertHttpOwner(actor, ctx && ctx.ownerId);
    const bucket = { keyId: session.key_id, clientId: actor.clientId || null, sessionId: base };
    if (session.state !== 'live') {
      const why = session.state === 'revoked'
        ? 'sub-key revoked; open a new session with a current key'
        : session.state === 'ended'
          ? 'this sub-key session was ended; open a new session'
          : session.state === 'closed'
            ? 'this sub-key session is closed; open a new session'
            : 'this sub-key session is no longer live; open a new session';
      throw refusal(`${why}. Nothing was written.`);
    }
    if (past(session.expires_at, now)) {
      await edit(ctx.deps, (data) => {
        const s = currentSession(data, base, now);
        const row = s && keyById(data, s.key_id);
        if (s && s.state === 'live') { s.state = 'expired'; s.ended_at = now.toISOString(); s.end_reason = 'handle expired'; }
        if (row && row.live_session_id === s.open_id) row.live_session_id = null;
        if (row) pushHistory(row, 'handle_expired', { at: now.toISOString(), session_id: base });
        return true;
      });
      throw refusal('this session handle has expired. Open a new session. Nothing was written.');
    }
    if (!HANDLE_RE.test(handle)) {
      const throttled = noteFailure(bucket, now);
      throw refusal(throttled || `session ${base} is a sub-key session; pass its session_handle. Nothing was written.`);
    }
    if (!verifyMac(session.handle_hmac, handle, peppers)) {
      const throttled = noteFailure(bucket, now);
      throw refusal(throttled || 'session handle does not match this sub-key session. Nothing was written.');
    }
    clearPresent(bucket);
    if (OWNER_ONLY_TOOLS.has(toolName)) {
      throw refusal('a sub-key session cannot call this tool. Nothing was changed.');
    }
    const cur = await loadSubkeyRecords(ctx.deps);
    const row = keyById(cur, session.key_id);
    if (!row || row.status === 'revoked') throw refusal('sub-key revoked; open a new session with a current key. Nothing was written.');
    if (row.live_session_id !== session.open_id) throw refusal('this sub-key session is no longer the live session for its key. Nothing was written.');
    if (!usableKey(row, now)) throw refusal('this sub-key is no longer active. Nothing was written.');
    const declared = typeof a.source === 'string' && a.source.trim() ? a.source.trim() : (a.metadata && typeof a.metadata.source === 'string' ? a.metadata.source.trim() : '');
    if (declared && declared !== row.tag) {
      throw refusal(`this session is bound to "${row.tag}"; "${declared}" does not match. Nothing was written.`);
    }
    await (await storeFor(ctx.deps)).touchLastUsed(session.key_id, now.toISOString());
    actor.subkeySession = true;
    actor.subkeyTag = row.tag;
    actor.subkeyId = row.key_id;
    return;
  }

  if (presentingHandle) {
    const throttled = noteFailure({ keyId: null, clientId: actor.clientId || null, sessionId: base }, now);
    throw refusal(throttled || 'session handle does not match a sub-key session. Nothing was written.');
  }
}

/** Bind the resolved session base to the key and return the handle once. One new record per open. */
export async function commitLiveSession(deps, actor, base, now = new Date()) {
  const token = openTokens.get(actor);
  if (!token || !base) return null;
  const peppers = requirePepper();
  const parts = splitKeyToken(token);
  if (!parts) throw refusal('emet_session_open: this sub-key does not match an active key. Nothing was opened.');
  const handle = `${HANDLE_PREFIX}${b64(32)}`;
  let collision = false;
  let failed = null;
  await edit(deps, (data) => {
    ensureMaps(data);
    const found = lookupUsable(data, parts.key_id, parts.secret, peppers, now);
    if (!found.ok) { failed = found; return found.changed === true; }
    const live = livePointer(found.row, data, now);
    if (live) {
      found.row.collisions = Array.isArray(found.row.collisions) ? found.row.collisions : [];
      found.row.collisions.push({ at: now.toISOString(), client_id: actor.clientId || null, grant_id: actor.grantId || null });
      pushHistory(found.row, 'collision', { at: now.toISOString(), client_id: actor.clientId || null });
      collision = true;
      return true;
    }
    if (found.row.live_session_id) endLive(data, found.row, 'ended', now, 'session lost');
    const open_id = hexId();
    const expires_at = new Date(now.getTime() + HANDLE_TTL_MS).toISOString();
    data.sessions.push({
      open_id, session_id: base,
      key_id: found.row.key_id, tag: found.row.tag, state: 'live',
      handle_hmac: seal(handle, peppers),
      opened_at: now.toISOString(), expires_at,
      client_id: actor.clientId || null, grant_id: actor.grantId || null
    });
    found.row.live_session_id = open_id;
    found.row.live_set_at = now.toISOString();
    found.row.last_used = now.toISOString();
    pushHistory(found.row, 'session_open', { at: now.toISOString(), session_id: base, open_id, client_id: actor.clientId || null, expires_at });
    return true;
  });
  if (failed) throw refusal(presentFailure(failed));
  if (collision) throw refusal('this sub-key already has a live session. Nothing was opened.');
  openTokens.delete(actor);
  return handle;
}

export function takeOpenToken(actor) { return openTokens.get(actor) || null; }

/**
 * Release a live sub-key session when its own close completes. The caller
 * must present that session's sub-key and its session handle. A close that
 * names another session, or that lacks either secret, leaves the record live.
 */
export async function releaseClosedSession(deps, base, now = new Date(), proof = null) {
  if (!subkeysEnabled() || !base) return null;
  const handle = proof && typeof proof.handle === 'string' ? proof.handle.trim() : '';
  const token = proof && typeof proof.subkey === 'string' ? proof.subkey.trim() : '';
  const parts = splitKeyToken(token);
  if (!HANDLE_RE.test(handle) || !parts) return null;
  const peppers = pepperState();
  if (!peppers) return null;
  let released = null;
  await edit(deps, (data) => {
    ensureMaps(data);
    const s = (data.sessions || []).find((row) => row && row.session_id === base && row.state === 'live' && row.key_id === parts.key_id && !past(row.expires_at, now));
    if (!s) return false;
    const row = keyById(data, s.key_id);
    if (!row || !verifyMac(s.handle_hmac, handle, peppers) || !verifyMac(row.secret_hmac, parts.secret, peppers)) return false;
    s.state = 'closed';
    s.ended_at = now.toISOString();
    s.end_reason = 'session closed';
    if (row.live_session_id === s.open_id) row.live_session_id = null;
    pushHistory(row, 'session_closed', { at: s.ended_at, session_id: base, open_id: s.open_id });
    released = { key_id: s.key_id, session_id: base, open_id: s.open_id };
    return true;
  });
  return released;
}

function keyMapOf(data) {
  if (!data) return {};
  if (data.keys && typeof data.keys === 'object' && !Array.isArray(data.keys)) return data.keys;
  if (data.subkeys && typeof data.subkeys === 'object' && !Array.isArray(data.subkeys)) return data.subkeys;
  return {};
}

/** Key list for the owner and the COS. Everyone else gets null. No secrets. */
export function subkeysView(data, actor, ownerId, now = new Date()) {
  if (!subkeysEnabled()) return null;
  if (!data) return null;
  const owner = actorIsOwner(actor, ownerId);
  const cos = actorIsCos(actor);
  if (!(owner || cos)) return null;
  const keys = Object.values(keyMapOf(data)).map((k) => {
    const expires_at = k.expires_at || null;
    const soon = !!(expires_at && !past(expires_at, now) && (new Date(expires_at).getTime() - now.getTime()) <= EXPIRY_NOTICE_MS);
    const replaces = k.replaces || null;
    const pendingReplacement = !!replaces && (k.status === 'pending' || k.status === 'approved');
    return {
      tag: k.tag, key_id: k.key_id, status: k.status,
      requested_at: k.requested_at || null,
      approved_at: k.approved_at || null,
      created_at: k.created_at || null,
      expires_at, last_used: k.last_used || null,
      grace_until: k.grace_until || null,
      live_session_id: k.live_session_id || null,
      replaces,
      replaces_existing_key: pendingReplacement,
      ...(pendingReplacement ? { approval_note: `Replaces the existing key ${replaces} for "${k.tag}". Approving starts that key's grace window.` } : {}),
      collision_flags: Array.isArray(k.collisions) ? k.collisions.map((c) => ({ at: c.at, client_id: c.client_id || null })) : [],
      expires_within_7_days: soon
    };
  });
  return {
    keys,
    expiring_within_7_days: keys.filter((k) => k.expires_within_7_days).map((k) => k.key_id),
    replacements_pending: keys.filter((k) => k.replaces_existing_key).map((k) => ({ tag: k.tag, key_id: k.key_id, replaces: k.replaces }))
  };
}

/**
 * History of the sub-key collection. Owner and COS only. A bot, a guest, and
 * any other read token get null. The events carry no HMAC and no secret.
 */
export async function readSubkeyHistory(deps, actor, ownerId) {
  if (!subkeysEnabled()) return null;
  if (!(actorIsOwner(actor, ownerId) || actorIsCos(actor))) return null;
  const snap = await loadSubkeyRecords(deps);
  return (snap.history || []).map((ev) => ({
    key_id: ev.key_id || null,
    event: ev.event || null,
    at: ev.at || null,
    client_id: ev.client_id || null,
    session_id: ev.session_id || null,
    open_id: ev.open_id || null
  }));
}

export async function dispatchSubkey(name, deps, actor, ownerId, args, registry, now) {
  const a = args || {};
  if (name === 'emet_subkey_request') return requestSubkey(deps, actor, a, registry, now);
  if (name === 'emet_subkey_claim') return claimSubkey(deps, actor, a, now);
  if (name === 'emet_subkey_revoke') return revokeSubkey(deps, actor, ownerId, a, now);
  if (name === 'emet_subkey_end_session') return endSubkeySession(deps, actor, ownerId, a, now);
  throw refusal(`unknown sub-key tool ${name}. Nothing was changed.`);
}

export default {
  requestSubkey, claimSubkey, revokeSubkey, endSubkeySession,
  decideSubkeyIfPending, prepareSubkeyCall, commitLiveSession, releaseClosedSession,
  subkeysView, readSubkeyHistory, dispatchSubkey, verifyMac, macEqual, splitKeyToken, pepperState
};
