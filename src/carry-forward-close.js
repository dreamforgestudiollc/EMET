/**
 * Carry-forward close.
 *
 * emet_session_close still compares this session's receipts with the store.
 * A later session advances HANDOFF and STATE, so those receipts no longer
 * match, the close stays blocked, and retries used to count toward the
 * three-close cap.
 *
 * A records/ session disposition (templates/SESSIONDISPOSITION.md)
 * documents that fact. The row does not close the graph and it is not a
 * receipt. This path closes the graph only when the owner door, or the
 * credential that wrote the session, cites that current row and the later
 * continuity versions that superseded the receipts. Transcripts stay.
 * A declared source is not authority. A refused call is not a blocked close
 * and is not counted.
 */

import { COLLECTION_PREFIX } from './database.js';
import { actorIsOwner } from './attribution.js';
import { rawActor, resolveTokenSubject } from './persons.js';
import {
  parseDispositionRows,
  SESSION_DISPOSITION_TEMPLATE
} from './conformance.js';
import { readDispositionCoverage } from './checkpoint.js';
import { isBotTag, botHandoffDoc, mainRecordIds } from './session-graph.js';

export const CARRY_FORWARD_DISPOSITIONS = Object.freeze([
  'CARRIED_FORWARD',
  'SUPERSEDED_BY_LATER_SESSION',
  'ABANDONED_NO_TRANSCRIPT'
]);
const CLOSABLE = new Set(CARRY_FORWARD_DISPOSITIONS);
const PART_SUFFIX = /_(?:verbatim_)?part\d+$/i;

export function closeBaseId(sessionId) {
  const id = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (!id) return null;
  return id.replace(PART_SUFFIX, '') || null;
}

function toMillis(value) {
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isFinite(t) ? t : null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value > 1e11 ? value : value * 1000;
  if (typeof value === 'string') {
    const t = Date.parse(value);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

export function hasCarryForward(options) {
  return !!options && Object.prototype.hasOwnProperty.call(options, 'carry_forward') && options.carry_forward != null;
}

export function parseCarryForward(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return { value, problem: null };
  if (typeof value === 'string' && value.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return { value: parsed, problem: null };
    } catch { /* text that does not parse is not a citation */ }
  }
  return { value: null, problem: 'carry_forward must be an object with disposition_doc, disposition_version, and citations' };
}

/**
 * Owner door, or the credential that wrote the session. A declared source,
 * a guest door, and a source named only on the call are not authority.
 * No HTTP actor is the local stdio owner, the same rule as actorIsOwner.
 */
function credentialTag(actor) {
  if (!actor || actor.sourceBasis === 'declared') return null;
  if (actor.sourceBasis === 'subkey' || actor.sourceBasis === 'credential') {
    const tag = typeof actor.effectiveTag === 'string' ? actor.effectiveTag.trim() : '';
    return tag || null;
  }
  if (actor.sourceBasis === 'login') {
    const tag = typeof actor.sourceTag === 'string' ? actor.sourceTag.trim() : '';
    return tag || null;
  }
  return null;
}

export function carryForwardAuthority(actor, evidence = {}) {
  const a = actor && typeof actor === 'object' ? actor : null;
  if (!a || a.transport !== 'http') return { ok: true, basis: 'owner' };
  if (a.door === 'guest') {
    return { ok: false, basis: null, reason: 'a guest door cannot carry-forward close a session' };
  }
  if (a.sourceBasis === 'declared') {
    return { ok: false, basis: null, reason: 'a declared source is not authority for a carry-forward close' };
  }
  if (actorIsOwner(a, a.ownerId) && (a.door === 'owner' || a.door == null)) {
    return { ok: true, basis: 'owner' };
  }
  const opened = evidence.openedBy && typeof evidence.openedBy === 'object' ? evidence.openedBy : null;
  if (opened && opened.person_id && a.personId && opened.person_id !== a.personId) {
    return { ok: false, basis: null, reason: 'carry-forward close needs the owner door, or the credential that opened this session' };
  }
  const credTag = credentialTag(a);
  const sameTag = !!credTag && !!evidence.sessionTag && credTag === evidence.sessionTag;
  const sameClient = !!(opened && a.clientId && opened.client_id === a.clientId && a.personId && opened.person_id === a.personId);
  const doorOk = a.door === 'member' || a.door === 'owner' || a.door == null;
  if (doorOk && (sameClient || sameTag)) return { ok: true, basis: 'writer' };
  return { ok: false, basis: null, reason: 'carry-forward close needs the owner door, or the credential that opened this session' };
}

function writerBase(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId.trim()) return null;
  return sessionId.trim().replace(PART_SUFFIX, '');
}

function laterWriter(writers, docId, sessionBase) {
  if (!writers || typeof writers.get !== 'function' || !sessionBase) return false;
  const wrote = writerBase(writers.get(docId));
  return !!wrote && wrote !== sessionBase;
}

/**
 * True when every receipt problem is HANDOFF or STATE having moved forward
 * under a later session. A same-session mismatch, a missing receipt, or a
 * working-document mismatch is false: those still count toward the cap.
 * "Handoff was not the last write" counts as this case only together with
 * one of those later-session mismatches.
 */
export function supersededStrikeSkipped(problems, { writers, handoffDoc, sessionBase } = {}) {
  if (!Array.isArray(problems) || problems.length === 0 || !sessionBase) return false;
  let sawLater = false;
  for (const problem of problems) {
    const handoff = /^handoff: receipt says v(\d+), store holds v(\d+)$/.exec(problem);
    if (handoff) {
      if (!(Number(handoff[2]) > Number(handoff[1]))) return false;
      if (!laterWriter(writers, handoffDoc, sessionBase)) return false;
      sawLater = true;
      continue;
    }
    const board = /^board ([^:]+): receipt says v(\d+), store holds v(\d+)$/.exec(problem);
    if (board) {
      if (!(Number(board[3]) > Number(board[2]))) return false;
      if (!laterWriter(writers, board[1], sessionBase)) return false;
      sawLater = true;
      continue;
    }
    if (/^handoff v\d+ was written by session /.test(problem) || /^board .+ was written by session /.test(problem)) {
      sawLater = true;
      continue;
    }
    if (/^handoff was not the last write /.test(problem)) continue;
    return false;
  }
  return sawLater;
}

/**
 * Receipt versions that match the store, written by a different session.
 * Those numbers are the later continuity record, not this session's receipt.
 */
export function foreignContinuityProblems({ receipts, writers, handoffDoc, sessionBase, documents } = {}) {
  if (!receipts || !sessionBase) return [];
  const byId = new Map((documents || []).map((d) => [d.doc_id, d]));
  const problems = [];
  const handoff = handoffDoc ? byId.get(handoffDoc) : null;
  if (handoff && handoff.exists && typeof receipts.handoff_version === 'number' && receipts.handoff_version === handoff.version
      && laterWriter(writers, handoffDoc, sessionBase)) {
    const wrote = writerBase(writers.get(handoffDoc));
    problems.push(`handoff v${handoff.version} was written by session ${wrote}, not ${sessionBase}; cite it with carry_forward`);
  }
  const boardId = typeof receipts.board_doc === 'string' ? receipts.board_doc : null;
  const board = boardId ? byId.get(boardId) : null;
  if (board && board.exists && typeof receipts.board_version === 'number' && receipts.board_version === board.version
      && laterWriter(writers, boardId, sessionBase)) {
    const wrote = writerBase(writers.get(boardId));
    problems.push(`board ${boardId} v${board.version} was written by session ${wrote}, not ${sessionBase}; cite it with carry_forward`);
  }
  return problems;
}

export function assessCitations(citations, docs, { requiredIds = [], forbiddenIds = [], sessionBase, anchorMs } = {}) {
  const problems = [];
  const byId = docs instanceof Map ? docs : new Map((docs || []).map((d) => [d.doc_id, d]));
  if (!Array.isArray(citations) || citations.length === 0) {
    problems.push('carry_forward.citations must name the later continuity records, each as {doc_id, version}');
    return problems;
  }
  const seen = new Set();
  for (const cite of citations) {
    const id = cite && typeof cite.doc_id === 'string' ? cite.doc_id.trim() : '';
    const version = cite && typeof cite.version === 'number' ? cite.version : null;
    if (!id || !Number.isInteger(version)) {
      problems.push('each citation needs a doc_id and an integer version');
      continue;
    }
    if (forbiddenIds.includes(id)) {
      problems.push(`citation ${id} is a main record this bot session does not cite`);
      continue;
    }
    seen.add(id);
    const doc = byId.get(id);
    if (!doc || doc.exists === false) {
      problems.push(`citation ${id} is not in the store`);
      continue;
    }
    if (doc.version !== version) { // citation-version
      problems.push(`citation ${id} says v${version}; the version in force is v${doc.version}`);
    }
    const wrote = writerBase(doc.session_id);
    if (wrote && sessionBase && wrote === sessionBase) {
      problems.push(`citation ${id} v${version} was written in this session; use a normal receipt close`);
    }
    const ms = toMillis(doc.updated_at);
    if (anchorMs == null || ms == null || ms <= anchorMs) { // citation-later
      problems.push(`citation ${id} v${version} is not later than this session`);
    }
  }
  for (const id of requiredIds) {
    if (!seen.has(id)) problems.push(`citation missing: ${id}`);
  }
  return problems;
}

function refused(problems, extra = {}) {
  return {
    state: 'refused',
    speak: [
      'Carry-forward close: refused',
      ...problems.map((p) => p),
      'Transcript: retained',
      'Close state: refused'
    ],
    missing: problems,
    warnings: [],
    carry_forward: { closed: false, transcripts_deleted: false, ...extra },
    close_attempts: { counted: false, escalated: false },
    instructions:
      'The session is NOT saved. The session graph stays open, and no transcript was deleted. ' +
      'This refusal is not a blocked close and is not counted. ' +
      'Cite the current records/ disposition and the later HANDOFF and STATE versions, ' +
      'or use a normal receipt close when this session\'s receipts still match the store.'
  };
}

function anchorMillis(session, rows) {
  const opened = toMillis(session && session.opened_at);
  if (opened != null) return opened;
  let max = null;
  for (const doc of rows || []) {
    const end = toMillis(doc && doc.session_end);
    if (end != null && (max == null || end > max)) max = end;
    for (const ex of (doc && doc.exchanges) || []) {
      const t = toMillis(ex && ex.timestamp);
      if (t != null && (max == null || t > max)) max = t;
    }
  }
  return max;
}

export async function runCarryForwardClose(db, options = {}) {
  const parsed = parseCarryForward(options.carry_forward);
  if (parsed.problem) return refused([parsed.problem]);
  const spec = parsed.value;
  const requested = typeof options.session_id === 'string' ? options.session_id.trim() : '';
  const base = closeBaseId(requested);
  if (!base) return refused(['carry_forward requires session_id of the open session to close']);

  const sessions = db.collection(`${COLLECTION_PREFIX}sessions`);
  const session = await sessions.findOne({ _id: base });
  if (!session || session.opened !== true) {
    return refused([`session ${base} has no open session row`], { session_id: base });
  }
  if (session.closed === true) {
    return refused([`session ${base} is already closed`], { session_id: base });
  }

  const loaded = await (async () => {
    const { sessionTagOf } = await import('./session.js');
    const pattern = `^${String(base).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(_.*)?$`;
    const rows = await db.collection('transcripts').find({ session_id: { $regex: pattern } }).toArray();
    return { rows, tag: sessionTagOf(rows).tag };
  })();

  const actor = rawActor();
  let ownerId = actor && actor.ownerId;
  if (actor && actor.transport === 'http' && !ownerId) {
    try { ownerId = await resolveTokenSubject(db); } catch { ownerId = null; }
  }
  const auth = carryForwardAuthority(actor ? { ...actor, ownerId: ownerId || actor.ownerId } : null, {
    sessionTag: loaded.tag,
    openedBy: session.opened_by || null
  });
  if (!auth.ok) return refused([auth.reason], { session_id: base });

  const docId = typeof spec.disposition_doc === 'string' ? spec.disposition_doc.trim() : '';
  const dispositionVersion = typeof spec.disposition_version === 'number' ? spec.disposition_version : null;
  if (!docId || !docId.startsWith('records/') || !Number.isInteger(dispositionVersion)) {
    return refused(['carry_forward.disposition_doc must be a records/ id and disposition_version its integer version in force'], { session_id: base });
  }

  const covered = await readDispositionCoverage(db);
  const exact = covered.get(requested) || covered.get(base);
  if (!exact) {
    const named = await db.collection('documents').findOne(
      { doc_id: docId },
      { projection: { content: 1, conformance: 1, retired: 1 } }
    );
    const rows = named ? parseDispositionRows(named.content) : [];
    const transcriptOnly = rows.some((row) => (row.session_id === base || row.session_id === requested) && row.inserted_id);
    const problems = transcriptOnly
      ? [`${docId} dispositions a transcript inserted_id only. That row does not close ${base}`]
      : [`no current conforming session-level disposition covers ${base}`];
    if (named && named.retired === true) problems.push(`${docId} is retired`);
    if (named && named.conformance && named.conformance.template && named.conformance.template !== SESSION_DISPOSITION_TEMPLATE) {
      problems.push(`${docId} is not a ${SESSION_DISPOSITION_TEMPLATE} record`);
    }
    return refused(problems, { session_id: base });
  }
  if (exact.doc_id !== docId || exact.version !== dispositionVersion) { // disposition-in-force
    return refused([
      `the disposition in force for ${base} is ${exact.doc_id} v${exact.version} (${exact.disposition}), not ${docId} v${dispositionVersion}`
    ], { session_id: base });
  }
  if (!CLOSABLE.has(exact.disposition)) { // closable-disposition
    const why = exact.disposition === 'RETAINED_OPEN_CRITICAL'
      ? `${base} is RETAINED_OPEN_CRITICAL. That row keeps the session open.`
      : `${base} is ${exact.disposition}. carry_forward closes only ${CARRY_FORWARD_DISPOSITIONS.join(', ')}. Use a normal receipt close for CLOSED_NORMAL.`;
    return refused([why], { session_id: base, disposition: exact.disposition });
  }

  const mains = mainRecordIds();
  const bot = loaded.tag && isBotTag(loaded.tag);
  const requiredIds = bot ? [botHandoffDoc(loaded.tag)] : mains;
  const forbiddenIds = bot ? mains : [];
  const citeIds = new Set(requiredIds);
  for (const cite of Array.isArray(spec.citations) ? spec.citations : []) {
    if (cite && typeof cite.doc_id === 'string' && cite.doc_id.trim()) citeIds.add(cite.doc_id.trim());
  }
  const found = new Map();
  for (const id of citeIds) {
    const row = await db.collection('documents').findOne(
      { doc_id: id },
      { projection: { doc_id: 1, version: 1, updated_at: 1, session_id: 1, retired: 1 } }
    );
    found.set(id, row && row.retired !== true
      ? { doc_id: id, exists: true, version: row.version, updated_at: row.updated_at, session_id: row.session_id || null }
      : { doc_id: id, exists: false });
  }
  const anchorMs = anchorMillis(session, loaded.rows);
  const citeProblems = assessCitations(spec.citations, found, {
    requiredIds, forbiddenIds, sessionBase: base, anchorMs
  });
  if (citeProblems.length) return refused(citeProblems, { session_id: base, disposition: exact.disposition });

  const citations = (spec.citations || []).map((cite) => ({ doc_id: cite.doc_id.trim(), version: cite.version }));
  const citedText = citations.map((c) => `${c.doc_id} v${c.version}`).join(', ');
  return {
    state: 'complete',
    speak: [
      `Carry-forward close: ${base}`,
      `Authority: ${auth.basis}`,
      `Disposition: ${exact.doc_id} v${exact.version} ${exact.disposition}`,
      `Later continuity: ${citedText}`,
      'Transcript: retained',
      'Close state: complete'
    ],
    missing: [],
    warnings: [],
    carry_forward: {
      closed: true,
      authority: auth.basis,
      disposition_doc: exact.doc_id,
      disposition_version: exact.version,
      disposition: exact.disposition,
      citations,
      transcripts_deleted: false,
      session_id: base
    },
    close_attempts: { counted: false, escalated: false },
    instructions:
      'Say every line of `speak` to the user, in order. ' +
      'This session is closed by carry-forward. The disposition and the later continuity versions were cited. ' +
      'The transcript was kept. This is not a receipt close. After `speak`, tell the user the session is saved, in one line.'
  };
}
