/**
 * BOUND's door (init audit items 3 and 5, 2026-10-27).
 *
 * grok-project is a host tag. It is not a declared claim on the Master
 * Hub token that shares OAuth client bound-login-client. That token
 * is bound to hub-bot. A grok-project claim on it is refused
 * and is not stamped hub-bot.
 *
 * A credential is the token's own source_tag grok-project (member, owner, or
 * a legacy token with no door) or a sub-key whose tag is grok-project. Guest
 * is not a writer credential. One EMET server. No second instance.
 *
 * The approvals row lists that credential. It does not remember grok-project
 * onto the shared client, so the claim path stays closed. CI does not mint a
 * live key and does not approve a production client.
 */

import { rawActor } from './persons.js';
import { chooserBinding } from './deep-links.js';
import { ValidationError } from './validation.js';

export const CLAIM_TAG = 'grok-project';
/** Same string as writer-approval.js MB_TAG. */
export const MB_TAG = 'hub-bot';
export const SHARED_GROK_CLIENT = 'bound-login-client';
export const EPISODIC_697_ID = 697;
export const CORRECTION_NOTE_DATE = '2026-10-27';

export const BOUND_LOGIN_MESSAGE =
  'A bound login cannot stamp another tag (EMET-AUTH-044). Nothing was written.';

/**
 * HTTP, authenticated, and the tag is on the credential rather than a claim.
 * Guest is not a writer credential. A declared tag does not remove a login
 * credential and is not itself a credential.
 */
export function isSophiaCredential(actor) {
  if (!actor || actor.transport !== 'http' || actor.authenticated !== true) return false;
  if (actor.door === 'guest') return false;
  if (actor.subkeySession === true && actor.subkeyTag === CLAIM_TAG) return true;
  const login = typeof actor.sourceTag === 'string' ? actor.sourceTag.trim() : '';
  if (login !== CLAIM_TAG) return false;
  return actor.door === 'member' || actor.door === 'owner' || actor.door == null;
}

/**
 * The shared Grok client, bound to Master Hub, claiming grok-project.
 * A BOUND credential is not this claim. Only the caller string counts, so a
 * tag left on a reused actor object cannot refuse a later write that names
 * no source.
 */
export function sophiaClaimOnSharedLogin(actor, callerTag) {
  if (!actor || actor.transport !== 'http' || actor.authenticated !== true) return false;
  if (actor.clientId !== SHARED_GROK_CLIENT) return false;
  const bound = typeof actor.sourceTag === 'string' ? actor.sourceTag.trim() : '';
  if (bound !== MB_TAG) return false;
  if (isSophiaCredential(actor)) return false;
  const declared = typeof callerTag === 'string' ? callerTag.trim() : '';
  return declared === CLAIM_TAG;
}

/** Stamp grok-project when the credential's caller is empty, itself, or Master Hub. */
export function sophiaCredentialOverrides(actor, callerTag) {
  if (!isSophiaCredential(actor)) return false;
  const caller = typeof callerTag === 'string' ? callerTag.trim() : '';
  return caller === '' || caller === CLAIM_TAG || caller === MB_TAG;
}

export function refuseSophiaDoor(actor) {
  const grantId = actor && typeof actor.grantId === 'string' && actor.grantId.trim() ? actor.grantId.trim() : 'unknown';
  const err = new ValidationError('source', BOUND_LOGIN_MESSAGE, { code: 'EMET-AUTH-044' });
  err.chooser = chooserBinding({ kind: 'onboarding_required', grantId, tag: CLAIM_TAG, door: 'member' });
  throw err;
}

/**
 * Dated episodic correction for 697. The parent stays. This is not
 * revise_memory and it does not supersede the row. Master Hub writes it
 * on the live store after merge, from the Master Hub login, and does not
 * pass source grok-project on that login.
 */
export function episodic697CorrectionNote() {
  return {
    layer: 'episodic',
    content: [
      `Correction note dated ${CORRECTION_NOTE_DATE}.`,
      `Episodic ${EPISODIC_697_ID} was written from client ${SHARED_GROK_CLIENT} and stamped ${MB_TAG}.`,
      `That stamp is a misattribution when the writer was BOUND (${CLAIM_TAG}).`,
      'The original row is retained. This note does not edit it in place and does not supersede it.',
      `A BOUND write carries ${CLAIM_TAG} from its own door.`,
      `Master Hub writes this note on the live store after merge, from the Master Hub login, and does not pass source ${CLAIM_TAG} on that login.`
    ].join(' '),
    metadata: {
      corrects: EPISODIC_697_ID,
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
 * List grok-project as a credential door. Does not remember() it onto the
 * shared client. Idempotent for the same client, door, and grant.
 */
export async function recordSophiaCredential(deps, { client_id, door, grant_id, by } = {}, now = new Date()) {
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
    const prev = d.approved[CLAIM_TAG];
    const pending = d.pending && d.pending[CLAIM_TAG];
    const same = prev
      && prev.basis === 'credential'
      && prev.door === doorName
      && prev.client_id === clientId
      && (prev.grant_id || null) === grant
      && !pending;
    if (same) return false;
    d.approved[CLAIM_TAG] = {
      basis: 'credential',
      door: doorName,
      client_id: clientId,
      grant_id: grant,
      source_tag: CLAIM_TAG,
      separate_from_client: SHARED_GROK_CLIENT,
      separate_from_tag: MB_TAG,
      by: by || 'owner',
      at,
      rule: 'separate login, then assign grok-project, then initialize'
    };
    if (d.pending && d.pending[CLAIM_TAG]) delete d.pending[CLAIM_TAG];
    return true;
  });
  return { written: out.written, approved: out.data.approved[CLAIM_TAG] };
}

/** After the owner's chooser issues a grok-project door. The preparer's grant is not stored. */
export async function sophiaListingAfterWriterIssue({ recorded, issued, deps, by, now } = {}) {
  if (!recorded || recorded.claimed_tag !== CLAIM_TAG) return { written: false, reason: 'tag' };
  if (!issued || issued.issued !== true) return { written: false, reason: 'not-issued' };
  if (recorded.door === 'guest') return { written: false, reason: 'guest' };
  try {
    return await recordSophiaCredential(deps, {
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
export function sophiaActor() {
  return rawActor();
}
