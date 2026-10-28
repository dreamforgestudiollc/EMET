/**
 * Refusal deep links (R4).
 *
 * A refused write can hand the human a URL. The URL is a server-generated
 * token stored only as a hash. It is short-lived, single-use, and bound to
 * this process instance plus the client grant (or `unknown`), the claimed
 * tag, and the door the refusal was about. Opening it does not grant a door.
 * The owner still decides on /owner/chooser.
 *
 * The proposed lifetime is 15 minutes (DEEP_LINK.ttl_ms). the owner can set
 * EMET_DEEP_LINK_TTL_MINUTES from 1 to 60. A value outside that range does
 * not lengthen the link.
 */

import crypto from 'node:crypto';
import { setting } from './env.js';
import { DEEP_LINK, logGrantId } from './grants.js';

export const CHOOSER_KINDS = Object.freeze([
  'deny',
  'rename_pending',
  'onboarding_required',
  'claimed_tag'
]);

const DOORS = new Set(['owner', 'member', 'guest']);
const TAG_MAX = 80;
const TOKEN_MAX = 128;

let instanceId = crypto.randomBytes(16).toString('hex');
let publicUrl = '';
const links = new Map();
const decisions = [];
let breakGlassUses = 0;
let breakGlassLastAt = null;

export function currentInstanceId() {
  return instanceId;
}

export function setInstanceIdForTests(id) {
  instanceId = typeof id === 'string' && id.trim() ? id.trim() : crypto.randomBytes(16).toString('hex');
}

export function setChooserPublicUrl(url) {
  publicUrl = typeof url === 'string' ? url.replace(/\/+$/, '') : '';
}

export function deepLinkTtlMs() {
  const raw = setting('DEEP_LINK_TTL_MINUTES');
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (/^\d+$/.test(text)) {
    const minutes = Number(text);
    if (minutes >= 1 && minutes <= 60) return minutes * 60 * 1000;
  }
  return DEEP_LINK.ttl_ms;
}

export function bindGrantId(id) {
  if (id === 'unknown') return 'unknown';
  const logged = logGrantId(id);
  return logged === 'none' ? 'unknown' : logged;
}

export function bindTag(tag) {
  if (typeof tag !== 'string') return 'unknown';
  const text = tag.trim().slice(0, TAG_MAX);
  return text || 'unknown';
}

export function bindDoor(door) {
  return DOORS.has(door) ? door : 'guest';
}

export function bindCorrelation(id) {
  return typeof id === 'string' && /^[0-9a-f]{16}$/.test(id) ? id : 'none';
}

/** The binding a refusal carries. Null when the kind is not one of the four. */
export function chooserBinding({ kind, grantId, tag, door } = {}) {
  if (!CHOOSER_KINDS.includes(kind)) return null;
  return {
    kind,
    grant_id: bindGrantId(grantId),
    tag: bindTag(tag),
    door: bindDoor(door)
  };
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

/**
 * Mint a link. The raw token is returned once, for the refusal payload.
 * The store keeps the hash.
 */
export function mintDeepLink({ kind, grant_id, tag, door, correlationId, now = Date.now(), ttlMs, instanceId: boundInstance } = {}) {
  if (!CHOOSER_KINDS.includes(kind)) return null;
  const token = crypto.randomBytes(32).toString('base64url');
  const hash = hashToken(token);
  const ttl = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : deepLinkTtlMs();
  links.set(hash, {
    hash,
    instance_id: typeof boundInstance === 'string' && boundInstance ? boundInstance : instanceId,
    grant_id: bindGrantId(grant_id),
    tag: bindTag(tag),
    door: bindDoor(door),
    kind,
    correlation_id: bindCorrelation(correlationId),
    created_at: now,
    expires_at: now + ttl,
    used_at: null
  });
  const base = publicUrl || '';
  return { url: `${base}/owner/chooser?d=${token}`, token };
}

function publicBinding(row) {
  return {
    grant_id: row.grant_id,
    tag: row.tag,
    door: row.door,
    kind: row.kind,
    correlation_id: row.correlation_id,
    instance_id: row.instance_id,
    link_id: row.hash.slice(0, 12)
  };
}

/**
 * First use consumes the link. A second use is a replay. A different
 * instance does not consume it. A different grant, tag, or door on this
 * instance consumes it and is refused.
 */
export function presentDeepLink(token, claimed = {}, now = Date.now()) {
  if (typeof token !== 'string' || token.length < 16 || token.length > TOKEN_MAX) {
    return { ok: false, reason: 'unknown' };
  }
  const row = links.get(hashToken(token));
  if (!row) return { ok: false, reason: 'unknown' };
  const instance = claimed.instanceId || instanceId;
  if (row.instance_id !== instance) return { ok: false, reason: 'wrong_instance' };
  if (row.revoked_by) return { ok: false, reason: 'rotated' };
  if (row.expires_at <= now) return { ok: false, reason: 'expired' };
  if (row.used_at) return { ok: false, reason: 'replay' };
  const scopeMismatch = (claimed.grantId != null && bindGrantId(claimed.grantId) !== row.grant_id)
    || (claimed.tag != null && bindTag(claimed.tag) !== row.tag)
    || (claimed.door != null && bindDoor(claimed.door) !== row.door);
  if (scopeMismatch) {
    row.used_at = now;
    return { ok: false, reason: 'wrong_scope' };
  }
  row.used_at = now;
  return { ok: true, binding: publicBinding(row) };
}

/** True when the raw token was stored. It must not be. */
export function deepLinkContainsRaw(token) {
  const raw = String(token || '');
  if (!raw) return false;
  for (const row of links.values()) {
    if (JSON.stringify(row).includes(raw)) return true;
  }
  return false;
}

/**
 * Put the link on a refusal envelope. The plain reason stays. The URL is
 * chooser_url, and it is appended to the message when that still fits the
 * 500-character cap. The link is not written onto the Error object.
 */
export function attachChooserLink(errorResponse, error, correlationId) {
  const binding = error && error.chooser;
  if (!binding || !errorResponse || !errorResponse.error) return errorResponse;
  let minted = null;
  try {
    minted = mintDeepLink({ ...binding, correlationId });
  } catch {
    return errorResponse;
  }
  if (!minted) return errorResponse;
  errorResponse.error.chooser_url = minted.url;
  const reason = typeof errorResponse.error.message === 'string' ? errorResponse.error.message : '';
  const extra = ` Open ${minted.url} The link grants nothing. The owner decides. correlation_id: ${correlationId}`;
  if ((reason + extra).length <= 500) errorResponse.error.message = reason + extra;
  return errorResponse;
}

export function recordAccessDecision(entry) {
  const row = {
    at: entry && entry.at ? entry.at : new Date().toISOString(),
    grant_id: bindGrantId(entry && entry.grant_id),
    correlation_id: bindCorrelation(entry && entry.correlation_id),
    decider: typeof entry?.decider === 'string' && entry.decider.trim() ? entry.decider.trim().slice(0, 80) : 'owner',
    decision: typeof entry?.decision === 'string' ? entry.decision.slice(0, 40) : 'none',
    surface: entry && entry.surface === 'break_glass' ? 'break_glass' : 'chooser',
    door: entry && entry.door ? bindDoor(entry.door) : null,
    tag: entry && entry.tag ? bindTag(entry.tag) : 'unknown',
    kind: entry && entry.kind ? String(entry.kind).slice(0, 40) : null,
    issued: entry && entry.issued === true
  };
  decisions.push(row);
  if (decisions.length > 500) decisions.shift();
  return row;
}

export function accessDecisions() {
  return decisions.map((row) => ({ ...row }));
}

export function noteBreakGlassUse(action, fields = {}) {
  breakGlassUses += 1;
  breakGlassLastAt = new Date().toISOString();
  const grant = bindGrantId(fields.grant_id);
  const decider = typeof fields.decider === 'string' && fields.decider.trim() ? fields.decider.trim().slice(0, 80) : 'owner';
  const safeAction = String(action || 'use').replace(/[^a-z_]/g, '').slice(0, 40) || 'use';
  const line = `[emet] break-glass action=${safeAction} decider=${decider} grant_id=${grant} uses=${breakGlassUses}`;
  console.error(line);
  return line;
}

export function breakGlassMetric() {
  return {
    path: '/owner/break-glass',
    uses: breakGlassUses,
    last_at: breakGlassLastAt,
    since_process_start: true,
    rung: 'R4'
  };
}

export function breakGlassStartupLine() {
  return `[emet] break-glass path=/owner/break-glass rung=R4 uses=${breakGlassUses}`;
}

/**
 * Unused deep links die with a rotation. The row stays in this process so
 * the refusal can name rotation instead of waiting out the TTL. all: true
 * is household. Otherwise a tag or a grant id selects one member.
 */
export function retireUnusedDeepLinks(eventId, filter = {}, now = Date.now()) {
  let n = 0;
  const grants = filter.grantIds ? new Set(filter.grantIds) : null;
  for (const row of links.values()) {
    if (!row || row.used_at || row.revoked_by) continue;
    if (!filter.all) {
      const tagHit = filter.tag && row.tag === filter.tag;
      const grantHit = grants && grants.has(row.grant_id);
      if (!tagHit && !grantHit) continue;
    }
    row.revoked_by = eventId;
    row.revoked_at = now;
    row.retired = true;
    n += 1;
  }
  return n;
}

export function _resetDeepLinksForTests() {
  links.clear();
  decisions.length = 0;
  breakGlassUses = 0;
  breakGlassLastAt = null;
  instanceId = crypto.randomBytes(16).toString('hex');
  publicUrl = '';
}
