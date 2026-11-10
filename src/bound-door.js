/**
 * BOUND's door (init audit items 3 and 5, 2026-10-27).
 *
 * bound-host is a host tag. It is not a declared claim on the hub login's
 * token that shares OAuth client bound-login-client. That token
 * is bound to hub-bot. A bound-host claim on it is refused
 * and is not stamped hub-bot.
 *
 * A credential is the token's own source_tag bound-host (member, owner, or
 * a legacy token with no door) or a sub-key whose tag is bound-host. Guest
 * is not a writer credential. One EMET server. No second instance.
 *
 * The approvals row lists that credential. It does not remember bound-host
 * onto the shared client, so the claim path stays closed. CI does not mint a
 * live key and does not approve a production client.
 */

import crypto from 'node:crypto';
import { rawActor } from './persons.js';
import { chooserBinding } from './deep-links.js';
import { ValidationError } from './validation.js';

export const CLAIM_TAG = 'bound-host';
/** First 16 hex of sha256(the exact 0.3.4 bound-door tag). The spelling stays out of this file. */
export const LEGACY_CLAIM_TAG_DIGEST = '43897607a89a6b2e';
/** Same string as writer-approval.js MB_TAG. */
export const MB_TAG = 'hub-bot';
export const SHARED_GROK_CLIENT = 'bound-login-client';
export const CORRECTION_NOTE_DATE = '2026-10-27';

export const BOUND_LOGIN_MESSAGE =
  'A bound login cannot stamp another tag (EMET-AUTH-044). Nothing was written.';

/**
 * HTTP, authenticated, and the tag is on the credential rather than a claim.
 * Guest is not a writer credential. A declared tag does not remove a login
 * credential and is not itself a credential.
 */
export function boundHostTagDigest(tag) {
  return crypto.createHash('sha256').update(String(tag).trim()).digest('hex').slice(0, 16);
}

/** Current `bound-host`, or the exact 0.3.4 spelling still stored on a token, approval row, writer request, or sub-key. A different case is not that door. */
export function isBoundHostTag(tag) {
  if (typeof tag !== 'string') return false;
  const text = tag.trim();
  if (!text) return false;
  if (text === CLAIM_TAG) return true;
  return boundHostTagDigest(text) === LEGACY_CLAIM_TAG_DIGEST;
}

function boundHostMapKey(map) {
  if (!map || typeof map !== 'object') return null;
  if (Object.prototype.hasOwnProperty.call(map, CLAIM_TAG)) return CLAIM_TAG;
  for (const key of Object.keys(map)) {
    if (isBoundHostTag(key)) return key;
  }
  return null;
}

export function isBoundHostCredential(actor) {
  if (!actor || actor.transport !== 'http' || actor.authenticated !== true) return false;
  if (actor.door === 'guest') return false;
  if (actor.subkeySession === true && isBoundHostTag(actor.subkeyTag)) return true;
  const login = typeof actor.sourceTag === 'string' ? actor.sourceTag.trim() : '';
  if (!isBoundHostTag(login)) return false;
  return actor.door === 'member' || actor.door === 'owner' || actor.door == null;
}

/**
 * The shared Grok client, bound to the hub login, claiming bound-host.
 * A BOUND credential is not this claim. Only the caller string counts, so a
 * tag left on a reused actor object cannot refuse a later write that names
 * no source.
 */
export function boundHostClaimOnSharedLogin(actor, callerTag) {
  if (!actor || actor.transport !== 'http' || actor.authenticated !== true) return false;
  if (actor.clientId !== SHARED_GROK_CLIENT) return false;
  const bound = typeof actor.sourceTag === 'string' ? actor.sourceTag.trim() : '';
  if (bound !== MB_TAG) return false;
  if (isBoundHostCredential(actor)) return false;
  const declared = typeof callerTag === 'string' ? callerTag.trim() : '';
  return isBoundHostTag(declared);
}

/** Stamp bound-host when the credential's caller is empty, itself, or the hub login. */
export function boundHostCredentialOverrides(actor, callerTag) {
  if (!isBoundHostCredential(actor)) return false;
  const caller = typeof callerTag === 'string' ? callerTag.trim() : '';
  return caller === '' || isBoundHostTag(caller) || caller === MB_TAG;
}

export function refuseBoundHostDoor(actor) {
  const grantId = actor && typeof actor.grantId === 'string' && actor.grantId.trim() ? actor.grantId.trim() : 'unknown';
  const err = new ValidationError('source', BOUND_LOGIN_MESSAGE, { code: 'EMET-AUTH-044' });
  err.chooser = chooserBinding({ kind: 'onboarding_required', grantId, tag: CLAIM_TAG, door: 'member' });
  throw err;
}

/**
 * Dated correction note. The parent stays. This is not
 * revise_memory and it does not supersede the row. The hub login writes it
 * on the live store after merge, from the hub login, and does not
 * pass source bound-host on that login.
 */
export function boundHostCorrectionNote() {
  return {
    layer: 'episodic',
    content: [
      `Correction note dated ${CORRECTION_NOTE_DATE}.`,
      `A row written from client ${SHARED_GROK_CLIENT} and stamped ${MB_TAG}.`,
      `That stamp is a misattribution when the writer was BOUND (${CLAIM_TAG}).`,
      'The original row is retained. This note does not edit it in place and does not supersede it.',
      `A BOUND write carries ${CLAIM_TAG} from its own door.`,
      `The hub login writes this note on the live store after merge, from the hub login, and does not pass source ${CLAIM_TAG} on that login.`
    ].join(' '),
    metadata: {
      assertion_origin: 'assistant',
      custom: {
        correction: 'misattribution',
        cited_source: MB_TAG,
        correct_source: CLAIM_TAG,
        cited_client: SHARED_GROK_CLIENT,
        dated: CORRECTION_NOTE_DATE
      }
    }
  };
}

/**
 * List bound-host as a credential door. Does not remember() it onto the
 * shared client. Idempotent for the same client, door, and grant.
 */
export async function recordBoundHostCredential(deps, { client_id, door, grant_id, by } = {}, now = new Date()) {
  if (!deps || typeof deps.readDoc !== 'function' || typeof deps.writeDoc !== 'function') {
    return { written: false, reason: 'no-approvals-io' };
  }
  const doorName = door === 'owner' || door === 'member' ? door : null;
  if (!doorName) return { written: false, reason: door === 'guest' ? 'guest' : 'door' };
  if (typeof client_id !== 'string' || !client_id.trim()) return { written: false, reason: 'client' };
  const clientId = client_id.trim();
  const grant = typeof grant_id === 'string' && grant_id.trim() ? grant_id.trim() : null;
  const { mutateApprovals } = await import('./attribution.js');
  const at = (now instanceof Date ? now : new Date(now)).toISOString();
  const out = await mutateApprovals(deps, (d) => {
    const key = boundHostMapKey(d.approved) || CLAIM_TAG;
    const prev = d.approved[key];
    const pendingKey = boundHostMapKey(d.pending);
    const pending = pendingKey ? d.pending[pendingKey] : undefined;
    const same = prev
      && prev.basis === 'credential'
      && prev.door === doorName
      && prev.client_id === clientId
      && (prev.grant_id || null) === grant
      && !pending;
    if (same) return false;
    d.approved[key] = {
      basis: 'credential',
      door: doorName,
      client_id: clientId,
      grant_id: grant,
      source_tag: key,
      separate_from_client: SHARED_GROK_CLIENT,
      separate_from_tag: MB_TAG,
      by: by || 'owner',
      at,
      rule: `separate login, then assign ${key}, then initialize`
    };
    if (pendingKey) delete d.pending[pendingKey];
    return true;
  });
  const storedKey = boundHostMapKey(out.data.approved) || CLAIM_TAG;
  return { written: out.written, approved: out.data.approved[storedKey] };
}

/** After the owner's chooser issues a bound-host door. The preparer's grant is not stored. */
export async function boundHostListingAfterWriterIssue({ recorded, issued, deps, by, now } = {}) {
  if (!recorded || !isBoundHostTag(recorded.claimed_tag)) return { written: false, reason: 'tag' };
  if (!issued || issued.issued !== true) return { written: false, reason: 'not-issued' };
  if (recorded.door === 'guest') return { written: false, reason: 'guest' };
  try {
    return await recordBoundHostCredential(deps, {
      client_id: recorded.client_id,
      door: recorded.door,
      grant_id: null,
      by: by || 'owner'
    }, now instanceof Date ? now : new Date());
  } catch {
    return { written: false, reason: 'failed' };
  }
}

/** The actor in force, for stamp sites that do not take one. */
export function boundHostActor() {
  return rawActor();
}
