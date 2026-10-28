/**
 * Writer approval (R6a).
 *
 * Master Hub prepares a request: client, claimed tag, door, reason,
 * correlation_id. The server validates that draft. Validation is a check.
 * It does not approve. the owner decides on /owner/chooser with the owner
 * passphrase session. No AI grants a writer, including Master Hub and
 * the retired owl account.
 *
 * The validator that runs is the server. the owner can later name another
 * existing reviewer credential. The owl account is not that credential.
 * Every step records grant_id, correlation_id, preparer, validator, and
 * decider. Rows are retained. Nothing here deletes a request.
 */

import crypto from 'node:crypto';
import { COLLECTION_PREFIX } from './database.js';
import { logClientId, logGrantId } from './grants.js';
import { isOwlIdentity } from './owl.js';

export const MB_TAG = 'hub-bot';
export const SERVER_VALIDATOR = 'server';
const COLLECTION = 'writer_approvals';
const REASON_MAX = 500;
const TAG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const CORR_RE = /^[0-9a-f]{16}$/;

const memory = new Map();
const steps = [];

function refusal(msg) {
  const error = new Error(msg);
  error.attributionRefusal = true;
  return error;
}

function safeLabel(value, fallback) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || /[\r\n\s]/.test(text) || text.length > 80) return fallback;
  return text;
}

export function _resetWriterApprovalsForTests() {
  memory.clear();
  steps.length = 0;
}

export function writerApprovalLog() {
  return steps.map((row) => ({ ...row }));
}

export function writerApprovalMetric() {
  const rows = [...memory.values()];
  const count = (status) => rows.filter((row) => row && row.status === status).length;
  return {
    rung: 'R6a',
    preparer: MB_TAG,
    validator: SERVER_VALIDATOR,
    decider: 'owner-session',
    decision_path: '/owner/chooser',
    ai_may_approve: false,
    prepared: rows.length,
    validated: count('validated'),
    invalid: count('invalid'),
    approved: count('approved'),
    denied: count('denied'),
    since_process_start: true
  };
}

/** Login or sub-key for Master Hub. A declared tag is a claim, not this credential. */
export function mbCredential(actor) {
  if (!actor || actor.transport !== 'http' || actor.authenticated !== true) return false;
  if (isOwlIdentity(actor)) return false;
  if (actor.ownerSession === true) return false;
  const basis = actor.sourceBasis || null;
  if (basis !== 'login' && basis !== 'subkey') return false;
  if (actor.declaredTag) return false;
  const tag = basis === 'subkey' ? (actor.effectiveTag || actor.sourceTag) : actor.sourceTag;
  return typeof tag === 'string' && tag.trim() === MB_TAG;
}

/** Master Hub, including a declared copy. Used to refuse approval, not to authorize preparation. */
export function isMasterBlasterActor(actor) {
  if (!actor || typeof actor !== 'object') return false;
  return [actor.effectiveTag, actor.sourceTag, actor.declaredTag].some((tag) => typeof tag === 'string' && tag.trim() === MB_TAG);
}

function collection(db, prefix) {
  if (!db || typeof db.collection !== 'function') return null;
  return db.collection(`${prefix}${COLLECTION}`);
}

async function persist(db, prefix, row) {
  memory.set(row.request_id, row);
  const col = collection(db, prefix);
  if (!col) return;
  const existing = await col.findOne({ _id: row.request_id });
  const stored = { ...row, _id: row.request_id, deleted: false, retained: true };
  if (!existing) await col.insertOne(stored);
  else await col.updateOne({ _id: row.request_id }, { $set: stored });
}

export async function hydrateWriterApprovals(db, prefix = COLLECTION_PREFIX) {
  const col = collection(db, prefix);
  if (!col) return;
  const cursor = col.find({});
  if (!cursor || typeof cursor.toArray !== 'function') return;
  const rows = await cursor.toArray();
  for (const row of rows) {
    if (row && row.request_id && !memory.has(row.request_id)) memory.set(row.request_id, row);
  }
}

function logStep(entry) {
  const row = {
    step: entry.step,
    grant_id: logGrantId(entry.grant_id),
    correlation_id: CORR_RE.test(entry.correlation_id) ? entry.correlation_id : 'none',
    preparer: safeLabel(entry.preparer, 'none'),
    validator: entry.validator === SERVER_VALIDATOR ? SERVER_VALIDATOR : 'none',
    decider: safeLabel(entry.decider, 'none'),
    at: entry.at
  };
  steps.push(row);
  if (steps.length > 500) steps.shift();
  console.error(`[emet] writer-approval step=${row.step} grant_id=${row.grant_id} correlation_id=${row.correlation_id} preparer=${row.preparer} validator=${row.validator} decider=${row.decider}`);
  return row;
}

/**
 * Server-side check of a prepared draft. A passing check still is not
 * approval. A failing check is retained as invalid.
 */
export function validateWriterDraft(fields, actor) {
  const failures = [];
  const client = typeof fields.client === 'string' ? fields.client.trim() : '';
  if (!client || logClientId(client) === 'unknown' || client === 'stdio' || isOwlIdentity(client)) failures.push('client');
  const tag = typeof fields.claimed_tag === 'string' ? fields.claimed_tag.trim() : '';
  if (!TAG_RE.test(tag) || isOwlIdentity(tag)) failures.push('claimed_tag');
  const door = fields.door === 'member' || fields.door === 'guest' ? fields.door : null;
  if (!door) failures.push('door');
  const reason = typeof fields.reason === 'string' ? fields.reason.trim() : '';
  if (!reason || reason.length > REASON_MAX || /[\r\n]/.test(reason)) failures.push('reason');
  const correlation = typeof fields.correlation_id === 'string' ? fields.correlation_id.trim() : '';
  if (!CORR_RE.test(correlation)) failures.push('correlation_id');
  const grant = logGrantId(actor && actor.grantId);
  if (grant === 'none') failures.push('grant_id');
  if (!mbCredential(actor)) failures.push('preparer');
  return {
    ok: failures.length === 0,
    failures,
    client: client || null,
    claimed_tag: tag || null,
    door,
    reason: reason || null,
    correlation_id: CORR_RE.test(correlation) ? correlation : 'none',
    grant_id: grant
  };
}

export async function prepareWriterRequest(db, prefix = COLLECTION_PREFIX, actor, fields = {}, now = new Date()) {
  if (isOwlIdentity(actor)) {
    throw refusal('emet_client_approve: the owl MCP clone account was retired by R6 and cannot prepare or approve. the owner decides a new writer on /owner/chooser. Nothing was changed.');
  }
  if (!mbCredential(actor)) {
    throw refusal('emet_client_approve: only Master Hub, on its own login or sub-key, prepares a writer request. A declared tag does not. Nothing was changed.');
  }
  if (fields.decision && fields.decision !== 'prepare') {
    throw refusal('emet_client_approve: Master Hub prepares a writer request and cannot approve it. the owner decides it on /owner/chooser. Nothing was changed.');
  }
  await hydrateWriterApprovals(db, prefix);
  const at = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  const checked = validateWriterDraft(fields, actor);
  const prior = [...memory.values()].find((row) => row && row.correlation_id === checked.correlation_id && checked.correlation_id !== 'none');
  if (prior) {
    logStep({
      step: 'prepare',
      grant_id: prior.grant_id,
      correlation_id: prior.correlation_id,
      preparer: prior.preparer,
      validator: prior.validator || 'none',
      decider: prior.decider || 'none',
      at
    });
    return { ...prior, unchanged: true };
  }
  const request_id = `wr-${crypto.randomBytes(8).toString('hex')}`;
  const base = {
    request_id,
    client_id: checked.client,
    claimed_tag: checked.claimed_tag,
    door: checked.door,
    reason: checked.reason,
    correlation_id: checked.correlation_id,
    grant_id: checked.grant_id,
    preparer: MB_TAG,
    validator: 'none',
    decider: 'none',
    status: 'prepared',
    writer: checked.door === 'member',
    issued: false,
    deleted: false,
    retained: true,
    history: [],
    at
  };
  logStep({ step: 'prepare', ...base, at });
  base.history.push({ step: 'prepare', grant_id: base.grant_id, correlation_id: base.correlation_id, preparer: MB_TAG, validator: 'none', decider: 'none', at });
  const validated = {
    ...base,
    status: checked.ok ? 'validated' : 'invalid',
    validator: SERVER_VALIDATOR,
    failures: checked.failures,
    validated_at: at
  };
  logStep({
    step: 'validate',
    grant_id: validated.grant_id,
    correlation_id: validated.correlation_id,
    preparer: MB_TAG,
    validator: SERVER_VALIDATOR,
    decider: 'none',
    at
  });
  validated.history.push({
    step: 'validate',
    grant_id: validated.grant_id,
    correlation_id: validated.correlation_id,
    preparer: MB_TAG,
    validator: SERVER_VALIDATOR,
    decider: 'none',
    ok: checked.ok,
    at
  });
  await persist(db, prefix, validated);
  return { ...validated };
}

export async function listWriterRequests(db, prefix = COLLECTION_PREFIX) {
  await hydrateWriterApprovals(db, prefix);
  return [...memory.values()].sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')) || String(a.request_id).localeCompare(String(b.request_id)));
}

export function getWriterRequest(requestId) {
  return memory.get(requestId) || null;
}

function decidedAt(now) {
  return now instanceof Date ? now.toISOString() : new Date(now).toISOString();
}

function decideHistory(row, who, decision, at) {
  return [...(row.history || []), {
    step: 'decide',
    grant_id: row.grant_id,
    correlation_id: row.correlation_id,
    preparer: row.preparer,
    validator: row.validator || SERVER_VALIDATOR,
    decider: who,
    decision,
    at
  }];
}

/**
 * Claim the decision before any door is minted. The status must still be
 * `validated`. The memory update is synchronous, then the database
 * compare-and-set (`status: 'validated'`) is the cross-process lock.
 * Approve becomes `approving`. Deny becomes `denied`. This does not mint.
 */
export async function claimWriterDecision(db, prefix = COLLECTION_PREFIX, { requestId, decision, decider, ownerSession } = {}, now = new Date()) {
  if (ownerSession !== true) {
    throw refusal('A new writer is decided only by the owner on /owner/chooser with an owner session. Nothing was changed.');
  }
  if (decision !== 'approve' && decision !== 'deny') {
    throw refusal('Decision must be approve or deny. Nothing was changed.');
  }
  await hydrateWriterApprovals(db, prefix);
  const row = memory.get(requestId);
  if (!row) throw refusal('That writer request is not on file. Nothing was changed.');
  if (row.status !== 'validated') throw refusal('That writer request is not awaiting a decision. Nothing was changed.');
  const at = decidedAt(now);
  const who = safeLabel(decider, 'owner');
  const next = {
    ...row,
    status: decision === 'approve' ? 'approving' : 'denied',
    decider: who,
    decision,
    decided_at: at,
    issued: false,
    deleted: false,
    retained: true,
    history: decideHistory(row, who, decision, at)
  };
  // No await between the status read above and this set. A second caller
  // in this process sees approving or denied and does not mint.
  memory.set(requestId, next);
  const col = collection(db, prefix);
  if (col) {
    const won = await col.findOneAndUpdate(
      { _id: requestId, status: 'validated' },
      { $set: { ...next, _id: requestId } }
    );
    if (!won) {
      const current = await col.findOne({ _id: requestId });
      memory.set(requestId, current || row);
      throw refusal('That writer request is not awaiting a decision. Nothing was changed.');
    }
  }
  logStep({
    step: 'decide',
    grant_id: next.grant_id,
    correlation_id: next.correlation_id,
    preparer: next.preparer,
    validator: next.validator,
    decider: who,
    at
  });
  return { ...next };
}

/** After the door minted. Only an `approving` row becomes `approved`. */
export async function stampWriterIssued(db, prefix = COLLECTION_PREFIX, { requestId } = {}) {
  const row = memory.get(requestId);
  if (!row || row.status !== 'approving') {
    throw refusal('That writer request is not awaiting a door. Nothing was changed.');
  }
  const next = { ...row, status: 'approved', issued: true, deleted: false, retained: true };
  memory.set(requestId, next);
  const col = collection(db, prefix);
  if (col) {
    const won = await col.findOneAndUpdate(
      { _id: requestId, status: 'approving' },
      { $set: { ...next, _id: requestId } }
    );
    if (!won) {
      const current = await col.findOne({ _id: requestId });
      memory.set(requestId, current || row);
      throw refusal('That writer request is not awaiting a door. Nothing was changed.');
    }
  }
  return { ...next };
}

/**
 * The claim won and the door did not mint. Put the row back to `validated`
 * so the owner can retry. Nothing is deleted.
 */
export async function releaseWriterClaim(db, prefix = COLLECTION_PREFIX, { requestId } = {}, now = new Date()) {
  const row = memory.get(requestId);
  if (!row || row.status !== 'approving') return row ? { ...row } : null;
  const at = decidedAt(now);
  const next = {
    ...row,
    status: 'validated',
    issued: false,
    decider: 'none',
    decision: null,
    deleted: false,
    retained: true,
    history: [...(row.history || []), {
      step: 'release',
      grant_id: row.grant_id,
      correlation_id: row.correlation_id,
      preparer: row.preparer,
      validator: row.validator || SERVER_VALIDATOR,
      decider: 'none',
      at
    }]
  };
  logStep({
    step: 'release',
    grant_id: next.grant_id,
    correlation_id: next.correlation_id,
    preparer: next.preparer,
    validator: next.validator,
    decider: 'none',
    at
  });
  await persist(db, prefix, next);
  return { ...next };
}

/**
 * Claim, then stamp only when the caller already minted (`issued === true`).
 * The chooser does not use this for a new door: it claims, then issues,
 * then stamps. An AI caller does not get ownerSession.
 */
export async function recordWriterDecision(db, prefix = COLLECTION_PREFIX, { requestId, decision, decider, ownerSession, issued } = {}, now = new Date()) {
  const claimed = await claimWriterDecision(db, prefix, { requestId, decision, decider, ownerSession }, now);
  if (decision === 'approve' && issued === true) return stampWriterIssued(db, prefix, { requestId });
  return claimed;
}
