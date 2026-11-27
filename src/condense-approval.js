/**
 * EMET - Enduring Memory & Epistemic Tiers
 * Copyright (c) 2026 Dreamforge Studio LLC
 *
 * Licensed under the MIT License - see LICENSE
 *
 * Owner-approved condense (EMET-DOC-025). The floor still refuses a write
 * that leaves a document under half the size this session first saw.
 * The owner door, or a writer approval the owner has already granted, may pass
 * that floor when condense_approved is true and the reason is not empty.
 * A sub-key or a bot without that approval is still refused. The owner
 * password is not an approval for a bot. The prior revision stays in
 * documents_history.
 */

import { ValidationError } from './validation.js';
import { actorIsOwner } from './attribution.js';
import { isBotTag } from './session-graph.js';
import { hubTag } from './per-tag-handoff.js';
import { isOwlIdentity } from './owl.js';
import { getWriterRequest, hydrateWriterApprovals } from './writer-approval.js';

export const CONDENSE_APPROVAL_CODE = 'EMET-DOC-090';
export const CONDENSE_FLOOR_CODE = 'EMET-DOC-025';
const APPROVAL_ID = /^wr-[0-9a-f]{16}$/;
const REASON_MAX = 2000;

export function condenseActor(raw, current) {
  const actor = raw && typeof raw === 'object' ? raw : {};
  const cur = current && typeof current === 'object' ? current : {};
  const clientId = actor.clientId !== undefined ? actor.clientId : cur.clientId;
  return {
    transport: actor.transport || cur.transport || null,
    door: actor.door || cur.door || null,
    personId: actor.personId || cur.personId || null,
    ownerId: actor.ownerId || null,
    clientId: clientId || null,
    sourceTag: typeof actor.sourceTag === 'string' ? actor.sourceTag : (cur.sourceTag || null),
    declaredTag: typeof actor.declaredTag === 'string' ? actor.declaredTag : null,
    effectiveTag: typeof actor.effectiveTag === 'string' ? actor.effectiveTag : null,
    sourceBasis: actor.sourceBasis || null,
    subkeyId: actor.subkeyId || null,
    authenticated: actor.authenticated === true || cur.authenticated === true
  };
}

/**
 * A bot tag for this gate. EMET_RECORD_DOCS misses the hub: that tag is not
 * listed as bots/<tag>/HANDOFF.md. EMET_HUB_TAG is a bot. The owner password
 * does not change this.
 */
export function isCondenseBotTag(tag) {
  if (typeof tag !== 'string') return false;
  const text = tag.trim();
  if (!text || text.includes('/')) return false;
  if (isBotTag(text)) return true;
  if (hubTag() && text === hubTag()) return true;
  return false;
}

/** A sub-key, a key door, a secondary door, or a bot tag. The owner password does not clear this. */
export function isKeyCondenseSession(actor) {
  if (!actor || typeof actor !== 'object') return false;
  if (actor.sourceBasis === 'subkey' || actor.subkeyId) return true;
  if (actor.door === 'key' || actor.door === 'secondary') return true;
  return [actor.effectiveTag, actor.sourceTag, actor.declaredTag].some((tag) => isCondenseBotTag(tag));
}

/** The primary owner door. Stdio is the local owner. A key session is never this door. */
export function isOwnerDoorActor(actor) {
  if (isKeyCondenseSession(actor)) return false;
  if (!actor || actor.transport !== 'http') return true;
  if (actor.door !== 'owner') return false;
  return actorIsOwner(actor, actor.ownerId);
}

function actorTags(actor) {
  return [actor && actor.effectiveTag, actor && actor.sourceTag, actor && actor.declaredTag]
    .filter((tag) => typeof tag === 'string' && tag.trim())
    .map((tag) => tag.trim());
}

/**
 * A writer-approval row the owner already decided. `pending` is not a grant.
 * `approved` matches this caller's tag, the client when both name one, and
 * the document the row names. A door grant with no doc_id is not a condense
 * permit. A grant for another document is not this one.
 */
export function classifyWriterApproval(row, actor, doc_id) {
  if (!row || typeof row !== 'object') return 'missing';
  const status = row.status;
  if (status === 'prepared' || status === 'validated' || status === 'approving') return 'pending';
  if (status !== 'approved' || row.issued !== true) return 'invalid';
  const decider = typeof row.decider === 'string' ? row.decider.trim() : '';
  if (!decider || decider === 'none' || isOwlIdentity(decider)) return 'invalid';
  const decided = Array.isArray(row.history) && row.history.some((step) => step && step.step === 'decide' && step.decision === 'approve');
  if (!decided) return 'invalid';
  const named = typeof row.doc_id === 'string' ? row.doc_id.trim() : '';
  if (!named || named !== doc_id) return 'invalid';
  const tag = typeof row.claimed_tag === 'string' ? row.claimed_tag.trim() : '';
  const tags = actorTags(actor);
  const tagOk = !!tag && tags.includes(tag);
  const client = typeof row.client_id === 'string' ? row.client_id.trim() : '';
  const actorClient = actor && typeof actor.clientId === 'string' ? actor.clientId : '';
  if (client && actorClient && client !== actorClient) return 'invalid';
  if (isKeyCondenseSession(actor)) return tagOk ? 'approved' : 'invalid';
  if (tagOk || (client && actorClient && client === actorClient)) return 'approved';
  if (isOwnerDoorActor(actor)) return 'approved';
  return 'invalid';
}

function reasonText(reason) {
  if (typeof reason !== 'string') return null;
  const text = reason.trim();
  if (!text || text.length > REASON_MAX) return null;
  return text;
}

function archiveText(value) {
  if (value == null || value === '') return { ok: true, archive_doc: null };
  if (typeof value !== 'string') return { ok: false, archive_doc: null };
  const text = value.trim();
  if (!text || text.length > 200 || /[\r\n]/.test(text)) return { ok: false, archive_doc: null };
  return { ok: true, archive_doc: text };
}

function missingReason(doc_id) {
  return `This condense of ${doc_id} needs a reason. Say what changed and why. Nothing was written.`;
}

function pendingMessage(doc_id) {
  return `The owner has not approved this condense of ${doc_id}. Nothing was written.`;
}

function invalidMessage(doc_id) {
  return `This condense of ${doc_id} needs the owner door, or an owner approval of this writer. The approval given here is missing or not valid. Nothing was written.`;
}

function archiveMessage(doc_id) {
  return `archive_doc for ${doc_id} must name one document. Nothing was written.`;
}

function refused() {
  return { state: 'refused', code: CONDENSE_FLOOR_CODE, message: null, approver: null, basis: null, reason: null, archive_doc: null, writer_approval_id: null };
}

function blocked(doc_id, kind) {
  const message = kind === 'pending' ? pendingMessage(doc_id) : (kind === 'reason' ? missingReason(doc_id) : (kind === 'archive' ? archiveMessage(doc_id) : invalidMessage(doc_id)));
  return { state: 'pending', code: CONDENSE_APPROVAL_CODE, message, approver: null, basis: null, reason: null, archive_doc: null, writer_approval_id: null };
}

/**
 * The floor already decided this write is under half. `flag` is false when
 * the caller did not pass condense_approved true.
 */
export function decideCondense({ doc_id, actor, approval, presentedId, reason, archiveDoc, flag }) {
  if (flag !== true) return refused();
  const who = actor || {};
  if (presentedId) {
    const kind = classifyWriterApproval(approval, who, doc_id);
    if (kind === 'pending') return { ...blocked(doc_id, 'pending'), writer_approval_id: presentedId };
    if (kind !== 'approved') return { ...blocked(doc_id, 'invalid'), writer_approval_id: presentedId };
    const text = reasonText(reason);
    if (!text) return { ...blocked(doc_id, 'reason'), writer_approval_id: presentedId };
    const archive = archiveText(archiveDoc);
    if (!archive.ok) return { ...blocked(doc_id, 'archive'), writer_approval_id: presentedId };
    const approver = typeof approval.decider === 'string' ? approval.decider.trim() : 'owner';
    return {
      state: 'approved', code: null, message: null, approver, basis: 'writer-approval',
      reason: text, archive_doc: archive.archive_doc, writer_approval_id: presentedId
    };
  }
  if (isKeyCondenseSession(who)) return refused();
  if (!isOwnerDoorActor(who)) return blocked(doc_id, 'invalid');
  const text = reasonText(reason);
  if (!text) return blocked(doc_id, 'reason');
  const archive = archiveText(archiveDoc);
  if (!archive.ok) return blocked(doc_id, 'archive');
  return {
    state: 'approved', code: null, message: null, approver: 'owner', basis: 'owner-door',
    reason: text, archive_doc: archive.archive_doc, writer_approval_id: null
  };
}

export async function resolveCondense(db, { doc_id, options, actor }) {
  const flag = !!(options && options.condense_approved === true);
  let presentedId = null;
  let approval = null;
  const rawId = options && options.writer_approval_id;
  if (flag && rawId != null && rawId !== '') {
    if (typeof rawId !== 'string' || !APPROVAL_ID.test(rawId.trim())) {
      return blocked(doc_id, 'invalid');
    }
    presentedId = rawId.trim();
    if (db) {
      await hydrateWriterApprovals(db);
      approval = getWriterRequest(presentedId);
    }
  }
  return decideCondense({
    doc_id,
    actor,
    approval,
    presentedId,
    reason: options && options.reason,
    archiveDoc: options && options.archive_doc,
    flag
  });
}

/**
 * Below the session floor, an incomplete approval is EMET-DOC-090 here, before
 * the record-reason check. A plain refusal stays EMET-DOC-025 at the floor.
 */
export async function condenseGate(db, { doc_id, prev, content, baseline, floorExempt, options, actor }) {
  const below = !!(prev && !floorExempt && baseline > 0 && String(content || '').length * 2 < baseline);
  if (!below) return { below: false, decision: null };
  const decision = await resolveCondense(db, { doc_id, options, actor });
  return { below: true, decision };
}

export function assertRetainedPrior(kept, prev, doc_id) {
  const prior = prev && typeof prev.content === 'string' ? prev.content : null;
  const same = !!(kept && typeof kept.content === 'string' && kept.content === prior);
  const digestOk = !(prev && prev.sha256) || (kept && kept.sha256 === prev.sha256);
  if (!same || !digestOk) {
    throw new ValidationError(
      `The prior revision of ${doc_id} is not in documents_history byte for byte. Nothing further was written.`,
      { code: 'EMET-DOC-003' }
    );
  }
}

export function condenseEpisodeText(fields) {
  const archive = fields.archive_doc ? ` An archive copy is named ${fields.archive_doc}.` : '';
  return `Condensed ${fields.doc_id} from ${fields.prior_size} characters to ${fields.new_size}. Reason: ${fields.reason}. Approver: ${fields.approver}.${archive} The prior revision stays in documents_history.`;
}

/** The episodic note saveMemory stores. The structured facts sit under custom. */
export function condenseEpisodePayload(fields) {
  return {
    content: condenseEpisodeText(fields),
    metadata: {
      source: fields.source || undefined,
      custom: {
        kind: 'document_condense',
        doc_id: fields.doc_id,
        reason: fields.reason,
        approver: fields.approver,
        basis: fields.basis,
        writer_approval_id: fields.writer_approval_id || null,
        prior_size: fields.prior_size,
        prior_sha256: fields.prior_sha256,
        new_size: fields.new_size,
        new_sha256: fields.new_sha256,
        archive_doc: fields.archive_doc || null,
        prior_version: fields.prior_version,
        version: fields.version
      }
    }
  };
}

export function condenseRecordOf(decision, fields) {
  const approver = decision.basis === 'writer-approval' ? decision.approver : (fields.person_id || 'owner');
  return {
    approved: true,
    reason: decision.reason,
    approver,
    basis: decision.basis,
    writer_approval_id: decision.writer_approval_id,
    prior_size: fields.prior_size,
    prior_sha256: fields.prior_sha256,
    new_size: fields.new_size,
    new_sha256: fields.new_sha256,
    archive_doc: decision.archive_doc,
    prior_version: fields.prior_version,
    version: fields.version,
    episodic_id: fields.episodic_id
  };
}

export function condenseToolFields(args) {
  if (!args || typeof args !== 'object') return {};
  const out = {};
  if (args.condense_approved === true) out.condense_approved = true;
  if (args.archive_doc != null) out.archive_doc = args.archive_doc;
  if (args.writer_approval_id != null) out.writer_approval_id = args.writer_approval_id;
  return out;
}

