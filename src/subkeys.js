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
 *
 * A handle lasts 12 hours. In the last hour, and for a grace window after
 * expiry, the same key can close that session into the next one. A sweep
 * records auto_closed when the link is already ended or the grace window
 * is over. The row stays.
 */

import crypto from 'node:crypto';
import { setting } from './env.js';
import {
  personIsOwner, actorIsOwner, actorIsCos, cosTag, sessionBaseOf,
  rememberSubkeySession, WRITE_TOOLS
} from './attribution.js';
import { isOwlIdentity } from './owl.js';
import { isMasterBlasterActor } from './writer-approval.js';
import { isLegacyBoundHostSpelling } from './bound-door.js';
import { assignCode } from './error-codes.js';
import { parseReceipts } from './session.js';
import { storeFor, sweepFlagOffLiveSessions } from './subkey-store.js';
import { retainSessionClose } from './session-graph.js';
import {
  UNWRAPPED_NOTICE, RENEW_MESSAGE,
  clientKindValue, clientKindOf, phaseOf, renewalRequest,
  isTerminalState, sweepIntervalMs
} from './subkey-lifecycle.js';

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
  'emet_subkey_request', 'emet_subkey_claim', 'emet_subkey_revoke', 'emet_subkey_end_session', 'emet_subkey_set_kind'
]);
/** Tools a verified sub-key session must not call. Settings and access stay on the owner login. */
const OWNER_ONLY_TOOLS = Object.freeze(new Set([
  'emet_client_approve',
  'emet_subkey_request', 'emet_subkey_claim', 'emet_subkey_revoke', 'emet_subkey_end_session', 'emet_subkey_set_kind',
  'emet_invite_create', 'emet_member_access_create', 'emet_setup_complete'
]));

const KEY_RE = /^emk_([0-9a-f]{32})_([A-Za-z0-9_-]{43})$/;
const HANDLE_RE = /^emh_[A-Za-z0-9_-]{43}$/;
const NONCE_RE = /^emn_[A-Za-z0-9_-]{43}$/;

let openTokens = new WeakMap();
let openPlans = new WeakMap();
let openNotices = new WeakMap();
const throttle = createThrottle();

function subkeysEnabled() { return setting('SUBKEYS') === '1'; }

export function _resetForTests() {
  openTokens = new WeakMap();
  openPlans = new WeakMap();
  openNotices = new WeakMap();
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
  const live = rows.filter((s) => (s.state === 'live' || s.state === 'renewal_offered') && !past(s.expires_at, now));
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
  if (s.state !== 'live' && s.state !== 'renewal_offered') return null;
  if (past(s.expires_at, now)) return null;
  return s;
}

function timeIn(iso, fromIso, now) {
  const t = new Date(iso).getTime();
  const from = new Date(fromIso).getTime();
  const to = now instanceof Date ? now.getTime() : new Date(now).getTime();
  return Number.isFinite(t) && Number.isFinite(from) && Number.isFinite(to) && t >= from && t <= to;
}

/**
 * A wrap-up is a record of this tag written from the handle's issue time
 * through now. The owner's stored kind decides whether the check runs.
 * deps.wrapUps is the test seam. A handoff write and an episodic row with
 * metadata.wrap_up are the store records.
 */
export async function wrapUpFound(ctx, tag, fromIso, now) {
  if (!tag || !fromIso) return false;
  const deps = ctx && ctx.deps;
  const listed = deps && Array.isArray(deps.wrapUps) ? deps.wrapUps : [];
  if (listed.some((row) => row && row.tag === tag && timeIn(row.at, fromIso, now))) return true;
  const db = ctx && ctx.db;
  if (!db || typeof db.collection !== 'function') return false;
  try {
    const ids = ['HANDOFF.md', `HANDOFF/${tag}.md`, `bots/${tag}/HANDOFF.md`];
    const found = await db.collection('documents').find({ doc_id: { $in: ids } }).limit(20).toArray();
    for (const doc of found || []) {
      const by = doc && (doc.updated_by || (doc.metadata && doc.metadata.source));
      const at = doc && (doc.updated_at || doc.updatedAt);
      if (by === tag && timeIn(at, fromIso, now)) return true;
    }
  } catch { /* a missed read is not a wrap-up */ }
  const cols = ctx && Array.isArray(ctx.layerCollections) ? ctx.layerCollections : [];
  for (const col of cols) {
    if (!col || typeof col.find !== 'function') continue;
    try {
      const rows = await col.find({ 'metadata.source': tag, 'metadata.wrap_up': true }).limit(20).toArray();
      for (const row of rows || []) {
        const raw = row && (row.timestamp || row.updated_at);
        const iso = typeof raw === 'number' ? new Date(raw > 1e12 ? raw : raw * 1000).toISOString() : raw;
        if (timeIn(iso, fromIso, now)) return true;
      }
    } catch { /* a missed read is not a wrap-up */ }
  }
  return false;
}

function hold(message, extra = {}) {
  const e = new Error(message);
  e.subkeyHold = { message, action: 'reinitialize', ...extra };
  e.emetCode = 'EMET-SESS-014';
  return e;
}

function sessionsForKey(data, keyId) {
  return (data.sessions || []).filter((s) => s && s.key_id === keyId);
}

function handleMatches(session, handle, peppers) {
  if (!session || !session.handle_hmac || !HANDLE_RE.test(handle || '')) return false;
  return verifyMac(session.handle_hmac, handle, peppers);
}

function priorByHandle(data, keyId, handle, peppers) {
  if (!HANDLE_RE.test(handle || '')) return null;
  return sessionsForKey(data, keyId).find((s) => !isTerminalState(s.state) && handleMatches(s, handle, peppers)) || null;
}

function isSessionStranded(session, now) {
  if (!session || session.state === 'revoked') return false;
  if (isTerminalState(session.state)) return true;
  if (session.state === 'ended' || session.state === 'expired' || session.state === 'unwrapped') return true;
  if (session.state === 'opening') return openIsStale(session.opened_at, now);
  const phase = phaseOf(session.expires_at, now);
  return (session.state === 'live' || session.state === 'renewal_offered') && (phase === 'grace' || phase === 'beyond');
}

/** What this open does to the key's current slot. A bot's healthy slot collides. */
function openDecision(data, row, now, handle, peppers) {
  const prior = priorByHandle(data, row.key_id, handle, peppers);
  if (prior) {
    const phase = phaseOf(prior.expires_at, now);
    if (phase === 'window' || phase === 'grace') return { action: 'renew', prior };
  }
  const healthy = livePointer(row, data, now);
  if (healthy && clientKindOf(row) !== 'chat') return { action: 'collision', prior: healthy };
  if (healthy) return { action: 'reclaim', prior: healthy };
  const rest = sessionsForKey(data, row.key_id).find((s) => !isTerminalState(s.state));
  if (rest) return { action: 'reclaim', prior: rest };
  return { action: 'open', prior: null };
}

function clearPointer(row, openId) {
  if (row && row.live_session_id === openId) {
    row.live_session_id = null;
    row.live_set_at = null;
  }
}

function carryForwardClose(data, session, now, reason, event, next) {
  if (!session || isTerminalState(session.state)) return false;
  session.state = 'closed';
  session.ended_at = now.toISOString();
  session.end_reason = reason;
  session.retained = true;
  session.deleted = false;
  if (next) {
    session.next_open_id = next.open_id;
    session.next_session_id = next.session_id;
    next.prev_open_id = session.open_id;
    next.prev_session_id = session.session_id;
  }
  const row = keyById(data, session.key_id);
  clearPointer(row, session.open_id);
  if (row) {
    pushHistory(row, event, {
      at: session.ended_at,
      session_id: session.session_id,
      open_id: session.open_id,
      reason,
      next_open_id: next ? next.open_id : null,
      next_session_id: next ? next.session_id : null
    });
  }
  return true;
}

function markUnwrapped(data, session, now, next) {
  if (!session || isTerminalState(session.state)) return false;
  const row = keyById(data, session.key_id);
  if (session.state !== 'unwrapped') {
    session.state = 'unwrapped';
    session.unwrapped_at = now.toISOString();
    session.retained = true;
    session.deleted = false;
    if (row) pushHistory(row, 'unwrapped', { at: session.unwrapped_at, session_id: session.session_id, open_id: session.open_id });
  }
  if (next) {
    session.next_open_id = next.open_id;
    session.next_session_id = next.session_id;
    if (!next.prev_open_id) {
      next.prev_open_id = session.open_id;
      next.prev_session_id = session.session_id;
    }
  }
  clearPointer(row, session.open_id);
  return true;
}

function autoCloseSession(data, session, now, reason, next) {
  if (!session || isTerminalState(session.state)) return false;
  session.state = 'auto_closed';
  session.ended_at = now.toISOString();
  session.end_reason = reason || 'abandoned';
  session.retained = true;
  session.deleted = false;
  if (next) {
    session.next_open_id = next.open_id;
    session.next_session_id = next.session_id;
    if (!next.prev_open_id) {
      next.prev_open_id = session.open_id;
      next.prev_session_id = session.session_id;
    }
  }
  const row = keyById(data, session.key_id);
  clearPointer(row, session.open_id);
  if (row) {
    pushHistory(row, 'session_auto_closed', {
      at: session.ended_at,
      session_id: session.session_id,
      open_id: session.open_id,
      reason: session.end_reason,
      next_open_id: next ? next.open_id : null
    });
  }
  return true;
}

/** Ended links, and sessions past the grace window. Rows stay. */
function closeStranded(data, now) {
  let n = 0;
  for (const session of data.sessions || []) {
    if (!session || isTerminalState(session.state)) continue;
    const phase = phaseOf(session.expires_at, now);
    const ended = session.state === 'ended';
    const beyond = phase === 'beyond' && ['live', 'renewal_offered', 'expired', 'unwrapped', 'opening'].includes(session.state);
    if ((ended || beyond) && autoCloseSession(data, session, now, ended ? 'link ended' : 'abandoned')) n += 1;
  }
  return n;
}

function healthyPointer(row, session, now) {
  if (!row || !session || row.live_session_id !== session.open_id) return false;
  if (session.state !== 'live' && session.state !== 'renewal_offered') return false;
  const phase = phaseOf(session.expires_at, now);
  return phase === 'fresh' || phase === 'window';
}

/** A sub-key link that is ended, expired, or no longer the live pointer. */
function linkGone(row, session, now) {
  if (!session || !session.session_id) return false;
  if (healthyPointer(row, session, now)) return false;
  if (['ended', 'expired', 'unwrapped', 'auto_closed', 'closed', 'revoked'].includes(session.state)) return true;
  const phase = phaseOf(session.expires_at, now);
  if (phase === 'grace' || phase === 'beyond') return true;
  return !row || row.live_session_id !== session.open_id;
}

function strandedTranscripts(data, now) {
  const out = [];
  const seen = new Set();
  for (const session of data.sessions || []) {
    if (!session || !session.session_id || seen.has(session.session_id)) continue;
    const siblings = (data.sessions || []).filter((item) => item && item.session_id === session.session_id);
    if (siblings.some((item) => healthyPointer(keyById(data, item.key_id), item, now))) continue;
    if (!siblings.some((item) => linkGone(keyById(data, item.key_id), item, now))) continue;
    seen.add(session.session_id);
    out.push({
      session_id: session.session_id,
      key_id: session.key_id,
      closed_by: 'server-sweep',
      note: `Closed ${now.toISOString()} by server-sweep. The transcript stays.`
    });
  }
  return out;
}

function reclaimCloser(keyId) {
  return `reclaim by key ${keyId}`;
}

async function closeTranscriptList(deps, items, now) {
  if (!items || !items.length || !deps || !deps.dbManager) return 0;
  const seen = new Set();
  let n = 0;
  for (const item of items) {
    if (!item || !item.session_id || seen.has(item.session_id)) continue;
    seen.add(item.session_id);
    try {
      const res = await retainSessionClose(deps.dbManager, item.session_id, {
        at: now,
        closed_by: item.closed_by,
        note: item.note
      });
      if (res && res.recorded) n += 1;
    } catch { /* a transcript close that cannot be written does not undo the sub-key record */ }
  }
  return n;
}

function loseOpening(data, session, now) {
  if (!session || session.state !== 'opening') return false;
  const row = keyById(data, session.key_id);
  session.state = 'ended';
  session.ended_at = now.toISOString();
  session.end_reason = 'session lost';
  session.retained = true;
  session.deleted = false;
  clearPointer(row, session.open_id);
  if (row) {
    pushHistory(row, 'session_lost', {
      at: session.ended_at,
      open_id: session.open_id,
      session_id: session.session_id,
      reason: 'session lost'
    });
  }
  return true;
}

/**
 * Close or flag every non-terminal session of this key, then the caller
 * stores `created` as the one live session.
 */
function settlePriors(data, row, created, now, { action, prior, wrapFound }, transcripts) {
  let notice = null;
  const kind = clientKindOf(row);
  const noteTranscript = (session) => {
    if (!transcripts || !session || !session.session_id) return;
    transcripts.push({
      session_id: session.session_id,
      key_id: row.key_id,
      closed_by: reclaimCloser(row.key_id),
      note: `Closed ${now.toISOString()} by ${reclaimCloser(row.key_id)}. The transcript stays.`
    });
  };
  for (const session of sessionsForKey(data, row.key_id)) {
    if (!session || isTerminalState(session.state)) continue;
    const phase = phaseOf(session.expires_at, now);
    const isPrior = !!(prior && session.open_id === prior.open_id);
    if (session.state === 'opening') {
      loseOpening(data, session, now);
      noteTranscript(session);
      continue;
    }
    if (isPrior && action === 'renew') {
      carryForwardClose(data, session, now, 'renewed', 'session_renewed', created);
      noteTranscript(session);
      notice = {
        action: 'continued',
        session_id: created.session_id,
        previous_session_id: session.session_id,
        message: 'This session continues the previous one. The previous session is closed. Keep this session_handle.'
      };
      continue;
    }
    if (phase === 'beyond') {
      autoCloseSession(data, session, now, 'abandoned', created);
      noteTranscript(session);
      continue;
    }
    if (kind === 'chat' && wrapFound !== true && isPrior && session.state !== 'ended') {
      markUnwrapped(data, session, now, created);
      noteTranscript(session);
      notice = {
        ...renewalRequest(created),
        previous_session_id: session.session_id,
        wrap_up_notice: UNWRAPPED_NOTICE,
        message: `${UNWRAPPED_NOTICE} ${RENEW_MESSAGE}`
      };
      continue;
    }
    carryForwardClose(data, session, now, 'reclaimed', 'session_reclaimed', created);
    noteTranscript(session);
  }
  return notice;
}

function healthySlot(session, now) {
  if (!session) return false;
  if (session.state !== 'live' && session.state !== 'renewal_offered') return false;
  const phase = phaseOf(session.expires_at, now);
  return phase === 'fresh' || phase === 'window';
}

function recordCollision(row, now, actor) {
  row.collisions = Array.isArray(row.collisions) ? row.collisions : [];
  row.collisions.push({ at: now.toISOString(), client_id: actor.clientId || null, grant_id: actor.grantId || null });
  pushHistory(row, 'collision', { at: now.toISOString(), client_id: actor.clientId || null, grant_id: actor.grantId || null });
}

function strandedWriteMessage(session, kind, wrap, now) {
  if (!session) return `${RENEW_MESSAGE} Nothing was written.`;
  if (session.state === 'closed' || session.state === 'auto_closed') {
    return 'This sub-key session is closed. Call emet_session_open with your sub-key. Nothing was written.';
  }
  const phase = phaseOf(session.expires_at, now);
  if (kind === 'chat' && wrap !== true && (session.state === 'unwrapped' || session.state === 'expired' || phase === 'grace' || phase === 'beyond')) {
    return `${UNWRAPPED_NOTICE} ${RENEW_MESSAGE} Nothing was written.`;
  }
  if (phase === 'beyond') return 'This session handle is past its grace window. Call emet_session_open with your sub-key. Nothing was written.';
  return `${RENEW_MESSAGE} Nothing was written.`;
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
export async function requestSubkey(deps, actor, { tag, client_kind } = {}, registry = [], now = new Date()) {
  if (!subkeysEnabled()) throw refusal('sub-keys are off (EMET_SUBKEYS is not 1). Nothing was changed.');
  const peppers = requirePepper();
  assertHttpOwner(actor, actor && actor.ownerId);
  const list = registryOf(registry);
  const t = tagAllowed(tag, list);
  if (!t) throw refusal('emet_subkey_request: "tag" must be an exact member of EMET_SOURCE_TAGS. Nothing was changed.');
  if (isLegacyBoundHostSpelling(t)) throw assignCode(refusal('emet_subkey_request: use bound-host. Nothing was changed.'), 'EMET-AUTH-045');
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
      replaces, collisions: [], history: [],
      requested_client_kind: clientKindValue(client_kind)
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
export async function decideSubkeyIfPending(deps, actor, ownerId, { tag, decision, reason, key_id, via, client_kind } = {}, now = new Date()) {
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
  if (isOwlIdentity(actor)) throw refusal('emet_client_approve: the owl MCP clone account was retired by R6 and cannot approve. the owner decides a new writer on /owner/chooser. Nothing was changed.');
  if (decision === 'approve' && (cosOk || isMasterBlasterActor(actor)) && actor.sourceTag !== 'owner') {
    throw refusal('emet_client_approve: an AI cannot grant a writer. The hub login prepares a request. the owner decides it on /owner/chooser. Nothing was changed.');
  }
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
      const named = clientKindValue(client_kind);
      const rawKind = client_kind === undefined || client_kind === null ? '' : String(client_kind).trim();
      if (rawKind && !named) throw refusal('emet_client_approve: "client_kind" must be "bot" or "chat". Nothing was changed.');
      row.client_kind = named || 'bot';
      row.status = 'approved';
      row.approved_by = by;
      row.approved_at = hist.at;
      row.approve_reason = why || null;
      hist.client_kind = row.client_kind;
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
      client_kind: row.client_kind || null,
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
  if (s && s.key_id === row.key_id && (s.state === 'live' || s.state === 'renewal_offered')) {
    s.state = state;
    s.ended_at = now.toISOString();
    s.end_reason = reason || null;
    s.retained = true;
    s.deleted = false;
  } else if (s && s.key_id === row.key_id && s.state === 'opening') {
    s.state = 'ended';
    s.ended_at = now.toISOString();
    s.end_reason = reason || 'session lost';
    s.retained = true;
    s.deleted = false;
    pushHistory(row, 'session_lost', { at: now.toISOString(), open_id: openId, session_id: s.session_id, reason: reason || null });
  } else if (!s || s.key_id !== row.key_id) {
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

const ROTATION_LIVE = new Set(['pending', 'approved', 'active', 'grace']);

/**
 * Retire sub-keys for a rotation. tags null is the household. An empty set
 * matches nobody. Rows and session opens stay. Status revoked is not a grace.
 */
export async function retireSubkeysForRotation(deps, { eventId, tags = null, now = new Date() } = {}) {
  if (!subkeysEnabled()) return { revoked: 0, sessions: 0, skipped: true };
  const store = await storeFor(deps || {});
  if (!store) return { revoked: 0, sessions: 0, unavailable: true };
  if (tags instanceof Set && tags.size === 0) return { revoked: 0, sessions: 0, unavailable: false };
  const at = (now instanceof Date ? now : new Date(now)).toISOString();
  let revoked = 0;
  let sessions = 0;
  await edit(deps, (data) => {
    ensureMaps(data);
    const allow = tags instanceof Set ? tags : null;
    for (const row of Object.values(data.keys)) {
      if (!row || (allow && !allow.has(row.tag)) || !ROTATION_LIVE.has(row.status)) continue;
      row.status = 'revoked';
      row.revoked_at = at;
      row.revoked_by = 'owner';
      row.revoke_reason = 'rotation';
      row.superseded_by = eventId;
      row.retired = true;
      row.deleted = false;
      pushHistory(row, 'revoked', {
        event_id: `h:${row.key_id}:${eventId}`,
        at,
        reason: 'rotation',
        superseded_by: eventId
      });
      row.live_session_id = null;
      row.live_set_at = null;
      revoked += 1;
    }
    for (const s of data.sessions) {
      if (!s || (s.state !== 'live' && s.state !== 'opening')) continue;
      if (allow) {
        const key = Object.values(data.keys).find((item) => item && item.key_id === s.key_id);
        if (!key || !allow.has(key.tag)) continue;
      }
      s.state = 'revoked';
      s.ended_at = at;
      s.end_reason = 'rotation';
      s.superseded_by = eventId;
      s.retained = true;
      s.deleted = false;
      sessions += 1;
    }
    return revoked > 0 || sessions > 0;
  });
  return { revoked, sessions, unavailable: false };
}

/**
 * Carry-forward close every non-terminal session of the key.
 * The key stays. The rows stay. The state is closed, not a lock.
 */
export async function endSubkeySession(deps, actor, ownerId, { tag, key_id, reason } = {}, now = new Date()) {
  if (!subkeysEnabled()) throw refusal('sub-keys are off (EMET_SUBKEYS is not 1). Nothing was changed.');
  requirePepper();
  assertOwnerActor(actor, ownerId, 'emet_subkey_end_session');
  const id = typeof key_id === 'string' ? key_id.trim() : '';
  const t = typeof tag === 'string' ? tag.trim() : '';
  if (!id && !t) throw refusal('emet_subkey_end_session: pass "tag" or "key_id". Nothing was changed.');
  let result = null;
  const transcripts = [];
  await edit(deps, (data) => {
    ensureMaps(data);
    const row = id
      ? keyById(data, id)
      : Object.values(data.keys).find((k) => k && k.tag === t && sessionsForKey(data, k.key_id).some((s) => !isTerminalState(s.state)));
    if (!row) throw refusal('emet_subkey_end_session: no sub-key matched. Nothing was changed.');
    const pointed = sessionByOpen(data, row.live_session_id);
    const targets = sessionsForKey(data, row.key_id).filter((s) => {
      if (isTerminalState(s.state)) return false;
      if (pointed && s.open_id === pointed.open_id) return true;
      return isSessionStranded(s, now);
    });
    if (!targets.length) throw refusal(`emet_subkey_end_session: "${row.tag}" has no session to close. The key was not changed.`);
    const why = reason || 'owner carry-forward';
    for (const session of targets) {
      carryForwardClose(data, session, now, why, 'session_closed', null);
      transcripts.push({
        session_id: session.session_id,
        key_id: row.key_id,
        closed_by: reclaimCloser(row.key_id),
        note: `Closed ${now.toISOString()} by ${reclaimCloser(row.key_id)}. The transcript stays.`
      });
    }
    row.live_session_id = null;
    row.live_set_at = null;
    const base = targets[0] ? targets[0].session_id : null;
    pushHistory(row, 'session_ended', { at: now.toISOString(), by: `owner (${actor.personId || 'local'})`, session_id: base, reason: why });
    result = {
      key_id: row.key_id, tag: row.tag, status: row.status, session_id: base,
      ended: true, carried_forward: true, state: 'closed', sessions: targets.length
    };
    return true;
  });
  await closeTranscriptList(deps, transcripts, now);
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
  if (actor) delete actor.subkeyRenewal;
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

  if (presentingKey && toolName !== 'emet_session_open' && toolName !== 'emet_session_close') {
    throw refusal('a sub-key is presented only at emet_session_open. Pass session_handle on later writes. emet_session_close may also present the key that opened the session. Nothing was written.');
  }

  const base = toolName === 'emet_session_open' ? null : sessionBaseOf(a);

  if (toolName === 'emet_session_open' && presentingKey) {
    const peppers = requirePepper();
    assertHttpOwner(actor, ctx && ctx.ownerId);
    const parts = splitKeyToken(token);
    const bucket = { keyId: parts.key_id, clientId: actor.clientId || null, sessionId: null };
    const priorHandle = handle;
    let outcome = null;
    let priorOpened = null;
    let priorId = null;
    await edit(ctx.deps, (data) => {
      ensureMaps(data);
      const found = lookupUsable(data, parts.key_id, parts.secret, peppers, now);
      if (!found.ok) { outcome = { fail: found }; return found.changed === true; }
      const decision = openDecision(data, found.row, now, priorHandle, peppers);
      if (decision.action === 'collision') {
        found.row.collisions = Array.isArray(found.row.collisions) ? found.row.collisions : [];
        found.row.collisions.push({ at: now.toISOString(), client_id: actor.clientId || null, grant_id: actor.grantId || null });
        pushHistory(found.row, 'collision', { at: now.toISOString(), client_id: actor.clientId || null, grant_id: actor.grantId || null });
        outcome = { collision: true, key_id: found.row.key_id, tag: found.row.tag };
        return true;
      }
      if (decision.prior) {
        priorOpened = decision.prior.opened_at || null;
        priorId = decision.prior.open_id || null;
      }
      outcome = { key_id: found.row.key_id, tag: found.row.tag, kind: clientKindOf(found.row), action: decision.action };
      return false;
    });
    if (!outcome || (outcome.fail && outcome.fail.reason === 'mismatch')) {
      const throttled = noteFailure(bucket, now);
      throw refusal(throttled || presentFailure(outcome ? outcome.fail : { reason: 'mismatch' }));
    }
    if (outcome.fail) throw refusal(presentFailure(outcome.fail));
    clearPresent(bucket);
    if (outcome.collision) throw refusal('this sub-key already has a live session. Close it, or ask the owner to end it, before opening another. Nothing was opened.');
    let wrapFound = false;
    if (outcome.kind === 'chat' && priorOpened) wrapFound = await wrapUpFound(ctx, outcome.tag, priorOpened, now);
    openPlans.set(actor, { handle: priorHandle, wrapFound, prior_open_id: priorId });
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
  let keyStatus = null;
  await edit(ctx.deps, (data) => {
    ensureMaps(data);
    if (base) session = currentSession(data, base, now);
    if (session) {
      const row = keyById(data, session.key_id);
      keyStatus = row ? row.status : null;
    }
    return false;
  });

  if (session) {
    const peppers = requirePepper();
    assertHttpOwner(actor, ctx && ctx.ownerId);
    const bucket = { keyId: session.key_id, clientId: actor.clientId || null, sessionId: base };
    if (session.state === 'revoked' || keyStatus === 'revoked') {
      throw refusal('sub-key revoked; open a new session with a current key. Nothing was written.');
    }
    const stranded = isSessionStranded(session, now);
    const read = !WRITE_TOOLS.has(toolName);
    if (!stranded) {
      if (session.state !== 'live' && session.state !== 'renewal_offered') {
        const why = session.state === 'ended'
          ? 'this sub-key session was ended; open a new session'
          : session.state === 'closed'
            ? 'this sub-key session is closed; open a new session'
            : 'this sub-key session is no longer live; open a new session';
        throw refusal(`${why}. Nothing was written.`);
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
      if (toolName === 'emet_status') {
        if (phaseOf(session.expires_at, now) === 'window') actor.subkeyRenewal = renewalRequest(session);
        actor.subkeySession = true;
        actor.subkeyTag = row.tag;
        actor.subkeyId = row.key_id;
        return;
      }
      if (phaseOf(session.expires_at, now) === 'window') {
        await edit(ctx.deps, (data) => {
          const s = currentSession(data, base, now);
          if (s && s.state === 'live' && s.open_id === session.open_id) {
            s.state = 'renewal_offered';
            return true;
          }
          return false;
        });
        actor.subkeyRenewal = renewalRequest(session);
      }
      await (await storeFor(ctx.deps)).touchLastUsed(session.key_id, now.toISOString());
      actor.subkeySession = true;
      actor.subkeyTag = row.tag;
      actor.subkeyId = row.key_id;
      return;
    }

    const cur = await loadSubkeyRecords(ctx.deps);
    const row = keyById(cur, session.key_id);
    const kind = clientKindOf(row);
    const handleOk = handleMatches(session, handle, peppers);
    let keyOk = false;
    if (presentingKey) {
      const parts = splitKeyToken(token);
      keyOk = !!(parts && row && parts.key_id === row.key_id && verifyMac(row.secret_hmac, parts.secret, peppers));
    }
    const owner = actorIsOwner(actor, (ctx && ctx.ownerId) || (actor && actor.ownerId));
    if (handleOk) clearPresent(bucket);
    if (toolName === 'emet_session_close' && (owner || handleOk || keyOk)) {
      if (row && (handleOk || keyOk)) {
        actor.subkeySession = true;
        actor.subkeyTag = row.tag;
        actor.subkeyId = row.key_id;
      }
      return;
    }
    let wrap = true;
    if (kind === 'chat' && row && (handleOk || session.state === 'expired' || session.state === 'unwrapped' || phaseOf(session.expires_at, now) === 'grace')) {
      wrap = await wrapUpFound(ctx, row.tag, session.opened_at, now);
    }
    const notice = kind === 'chat' && !wrap
      ? { ...renewalRequest(session), wrap_up_notice: UNWRAPPED_NOTICE, message: UNWRAPPED_NOTICE }
      : renewalRequest(session);
    if (read) {
      actor.subkeyRenewal = notice;
      if (handleOk && row) {
        actor.subkeySession = true;
        actor.subkeyTag = row.tag;
        actor.subkeyId = row.key_id;
      }
      return;
    }
    const message = strandedWriteMessage(session, kind, wrap, now);
    throw hold(message, { ...notice, message, session_id: base });
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
  const plan = openPlans.get(actor) || { handle: '', wrapFound: false, prior_open_id: null };
  const peppers = requirePepper();
  const parts = splitKeyToken(token);
  if (!parts) throw refusal('emet_session_open: this sub-key does not match an active key. Nothing was opened.');
  const handle = `${HANDLE_PREFIX}${b64(32)}`;
  let collision = false;
  let failed = null;
  let notice = null;
  const transcripts = [];
  await edit(deps, (data) => {
    ensureMaps(data);
    const found = lookupUsable(data, parts.key_id, parts.secret, peppers, now);
    if (!found.ok) { failed = found; return found.changed === true; }
    const decision = openDecision(data, found.row, now, plan.handle, peppers);
    if (decision.action === 'collision') {
      recordCollision(found.row, now, actor);
      collision = true;
      return true;
    }
    if (decision.action === 'reclaim' && healthySlot(decision.prior, now)) recordCollision(found.row, now, actor);
    const wrapFound = !!(decision.prior && decision.prior.open_id === plan.prior_open_id && plan.wrapFound === true);
    const open_id = hexId();
    const expires_at = new Date(now.getTime() + HANDLE_TTL_MS).toISOString();
    const created = {
      open_id, session_id: base,
      key_id: found.row.key_id, tag: found.row.tag, state: 'live',
      handle_hmac: seal(handle, peppers),
      opened_at: now.toISOString(), expires_at,
      client_id: actor.clientId || null, grant_id: actor.grantId || null,
      retained: true, deleted: false
    };
    notice = settlePriors(data, found.row, created, now, { action: decision.action, prior: decision.prior, wrapFound }, transcripts);
    if (found.row.live_session_id && found.row.live_session_id !== created.open_id) {
      endLive(data, found.row, 'ended', now, 'session lost');
    }
    data.sessions.push(created);
    found.row.live_session_id = created.open_id;
    found.row.live_set_at = now.toISOString();
    found.row.last_used = now.toISOString();
    pushHistory(found.row, 'session_open', {
      at: now.toISOString(), session_id: base, open_id, client_id: actor.clientId || null, expires_at,
      prev_open_id: created.prev_open_id || null, prev_session_id: created.prev_session_id || null
    });
    return true;
  });
  if (failed) throw refusal(presentFailure(failed));
  if (collision) throw refusal('this sub-key already has a live session. Nothing was opened.');
  await closeTranscriptList(deps, transcripts, now);
  openTokens.delete(actor);
  openPlans.delete(actor);
  if (notice) {
    actor.subkeyRenewal = notice;
    openNotices.set(actor, notice);
  }
  return handle;
}

export function takeOpenToken(actor) { return openTokens.get(actor) || null; }

/** The notice commit stored for this open. One read. */
export function takeOpenNotice(actor) {
  const notice = actor ? openNotices.get(actor) || null : null;
  if (actor) openNotices.delete(actor);
  return notice;
}

/**
 * Release a sub-key session when its own close completes. The caller
 * presents that session's key and its handle. An expired handle still
 * releases when the key matches. A different key releases nothing.
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
    const row = keyById(data, parts.key_id);
    if (!row || !verifyMac(row.secret_hmac, parts.secret, peppers)) return false;
    const s = (data.sessions || []).find((item) => item && item.session_id === base && item.key_id === parts.key_id && !isTerminalState(item.state) && verifyMac(item.handle_hmac, handle, peppers));
    if (!s) return false;
    carryForwardClose(data, s, now, 'session closed', 'session_closed', null);
    released = { key_id: s.key_id, session_id: base, open_id: s.open_id, state: 'closed' };
    return true;
  });
  return released;
}

/** Close ended links and sessions past the grace window. Nothing is deleted. */
export async function sweepStrandedSessions(deps, now = new Date()) {
  if (!subkeysEnabled()) return 0;
  let n = 0;
  let transcripts = [];
  await edit(deps || {}, (data) => {
    ensureMaps(data);
    n = closeStranded(data, now);
    transcripts = strandedTranscripts(data, now);
    return n > 0;
  });
  const closed = await closeTranscriptList(deps, transcripts, now);
  return n + closed;
}

/** One pass at startup, then a periodic pass. It does not block listen. */
export function startStrandedSweep(log, dbManager) {
  if (!subkeysEnabled()) return;
  const go = () => {
    sweepStrandedSessions({ dbManager }).then((n) => {
      if (n > 0 && typeof log === 'function') log(`sub-key sweep closed ${n} stranded session${n === 1 ? '' : 's'}`);
    }).catch((e) => {
      if (typeof log === 'function') log(`sub-key sweep failed: ${e && e.message ? e.message : 'unknown error'}`);
    });
  };
  go();
  const timer = setInterval(go, sweepIntervalMs());
  if (timer.unref) timer.unref();
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
      client_kind: k.client_kind === 'chat' ? 'chat' : (k.client_kind === 'bot' ? 'bot' : null),
      requested_client_kind: k.requested_client_kind || null,
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

/** Set the kind stored on an approved key. Owner only. A missing kind stays bot until this writes one. */
export async function setSubkeyClientKind(deps, actor, ownerId, { tag, key_id, client_kind } = {}, now = new Date()) {
  if (!subkeysEnabled()) throw refusal('sub-keys are off (EMET_SUBKEYS is not 1). Nothing was changed.');
  requirePepper();
  assertOwnerActor(actor, ownerId, 'emet_subkey_set_kind');
  const kind = clientKindValue(client_kind);
  if (!kind) throw refusal('emet_subkey_set_kind: "client_kind" must be "bot" or "chat". Nothing was changed.');
  const id = typeof key_id === 'string' ? key_id.trim() : '';
  const t = typeof tag === 'string' ? tag.trim() : '';
  if (!id && !t) throw refusal('emet_subkey_set_kind: pass "tag" or "key_id". Nothing was changed.');
  let result = null;
  await edit(deps, (data) => {
    ensureMaps(data);
    const row = id
      ? keyById(data, id)
      : Object.values(data.keys).find((k) => k && k.tag === t && ['approved', 'active', 'grace'].includes(k.status));
    if (!row) throw refusal('emet_subkey_set_kind: no sub-key matched. Nothing was changed.');
    if (!['approved', 'active', 'grace'].includes(row.status)) {
      throw refusal(`emet_subkey_set_kind: "${row.tag}" is not an approved key. Nothing was changed.`);
    }
    const previous = row.client_kind === 'chat' ? 'chat' : (row.client_kind === 'bot' ? 'bot' : null);
    if ((previous || 'bot') === kind && row.client_kind === kind) {
      result = { key_id: row.key_id, tag: row.tag, client_kind: kind, previous: previous || 'bot', unchanged: true };
      return false;
    }
    row.client_kind = kind;
    pushHistory(row, 'client_kind', {
      at: now.toISOString(),
      by: `owner (${actor.personId || 'local'})`,
      client_kind: kind,
      previous: previous || 'bot'
    });
    result = { key_id: row.key_id, tag: row.tag, client_kind: kind, previous: previous || 'bot', unchanged: false };
    return true;
  });
  return result;
}

export async function dispatchSubkey(name, deps, actor, ownerId, args, registry, now) {
  const a = args || {};
  if (name === 'emet_subkey_request') return requestSubkey(deps, actor, a, registry, now);
  if (name === 'emet_subkey_claim') return claimSubkey(deps, actor, a, now);
  if (name === 'emet_subkey_revoke') return revokeSubkey(deps, actor, ownerId, a, now);
  if (name === 'emet_subkey_end_session') return endSubkeySession(deps, actor, ownerId, a, now);
  if (name === 'emet_subkey_set_kind') return setSubkeyClientKind(deps, actor, ownerId, a, now);
  throw refusal(`unknown sub-key tool ${name}. Nothing was changed.`);
}

export default {
  requestSubkey, claimSubkey, revokeSubkey, endSubkeySession,
  decideSubkeyIfPending, prepareSubkeyCall, commitLiveSession, releaseClosedSession,
  sweepStrandedSessions, startStrandedSweep, takeOpenNotice, wrapUpFound, setSubkeyClientKind,
  subkeysView, readSubkeyHistory, dispatchSubkey, verifyMac, macEqual, splitKeyToken, pepperState
};
