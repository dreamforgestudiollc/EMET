/**
 * Continuous-chat checkpoint reminder (board 128, the owner 2026-10-16, resumed 2026-10-27).
 *
 * Context compression drops older turns, so a session closed days later cannot
 * rebuild a word-for-word transcript. A bot saves verbatim exchanges at least
 * nightly, under the open session or a daily `YYYY-MM-DD_chat-daily` session,
 * and the close cites those saved parts.
 *
 * The server sees saved tool calls, not unsaved chat. This module only reads.
 * It does not add a tool: emet_status always carries `checkpoint`, and any
 * other tool result carries it when the call names an open session that is due.
 * The save itself is still emet_transcript_append (one exchange) or
 * save_transcript (the batch). emet_session_close cites the saved parts.
 *
 * A current conforming records/ session disposition covers a session for this
 * listing. The session stays open. The disposition is not a close and not a
 * receipt. A row that names inserted_id dispositions that transcript only.
 */

import { COLLECTION_PREFIX } from './database.js';
import { groupedUnder } from './session-graph.js';
import {
  SESSION_DISPOSITION_PREFIX, SESSION_DISPOSITION_TEMPLATE, VERDICT,
  dispositionResolvesOverdue, parseDispositionRows
} from './conformance.js';

/** At least nightly. Due when the anchor is this old or older. */
export const CHECKPOINT_INTERVAL_MS = 24 * 60 * 60 * 1000;

export const SAVE_WITH = Object.freeze(['emet_transcript_append', 'save_transcript']);
export const CLOSE_WITH = 'emet_session_close';

/** New York calendar day. The daily id is this zone, not EMET_TIMEZONE. */
export function checkpointDay(date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(date);
}

function saveWith() {
  return [...SAVE_WITH];
}

/**
 * A stored time as milliseconds. Dates and ISO strings are themselves.
 * A number below 1e12 is Unix seconds (the exchange shape); a larger number
 * is already milliseconds.
 */
export function checkpointMillis(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isFinite(t) ? t : null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 1e12 ? value * 1000 : value; // checkpoint-unix
  }
  if (typeof value === 'string') {
    const t = Date.parse(value);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

function iso(ms) {
  return ms == null ? null : new Date(ms).toISOString();
}

function coverageGet(covered, sessionId) {
  if (!covered || sessionId == null || sessionId === '') return null;
  const row = covered instanceof Map ? covered.get(sessionId) : covered[sessionId];
  if (!row || !dispositionResolvesOverdue(row.disposition)) return null;
  return {
    session_id: sessionId,
    disposition: row.disposition,
    doc_id: row.doc_id ?? null,
    version: row.version ?? null
  };
}

/**
 * Which open sessions owe a verbatim save. Pure. `rows` carry `opened`,
 * `closed`, `opened_at`, and `last_saved_at` (the newest live transcript
 * time, or null when nothing live is saved). The anchor is that save, else
 * the open. No anchor is not due: an unreadable clock is not "fresh".
 * `covered` maps a session id to a session-level disposition. A hit is not
 * checkpoint-due. The session is not closed here.
 */
export function checkpointDecision(rows, now = new Date(), covered = null) {
  const nowMs = checkpointMillis(now);
  const due = [];
  const dispositioned = [];
  for (const row of rows || []) {
    if (!row || row.opened !== true || row.closed === true) continue; // checkpoint-row
    const saved = checkpointMillis(row.last_saved_at);
    const opened = checkpointMillis(row.opened_at);
    const anchor = saved != null ? saved : opened;
    if (anchor == null || nowMs == null) continue;
    const age = nowMs - anchor;
    if (age < CHECKPOINT_INTERVAL_MS) continue; // checkpoint-night
    const cover = coverageGet(covered, row.session_id);
    if (cover) { dispositioned.push(cover); continue; } // disposition-cover
    due.push({
      session_id: row.session_id,
      last_saved_at: saved != null ? iso(saved) : null,
      opened_at: opened != null ? iso(opened) : null
    });
  }
  if (!due.length) {
    const quiet = { due: false, save_with: saveWith() };
    if (dispositioned.length) quiet.dispositioned = dispositioned;
    return quiet;
  }
  const day = checkpointDay(now instanceof Date ? now : new Date(nowMs));
  const daily = `${day}_chat-daily`;
  return {
    due: true,
    save_with: saveWith(),
    close_with: CLOSE_WITH,
    daily_session: daily,
    sessions: due,
    ...(dispositioned.length ? { dispositioned } : {}),
    text: `Checkpoint due. Save the verbatim exchanges with emet_transcript_append (one exchange) or save_transcript (the batch), under the open session or ${daily}. Do not reconstruct turns. Mark gaps as gaps. emet_session_close cites those saved parts.`
  };
}

function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // checkpoint-escape
}

/** Live save time. A superseded part is not a save. session_end wins over an older exchange stamp. */
export function liveSaveMillis(doc) {
  if (!doc || doc.superseded_by) return null; // checkpoint-live
  const end = checkpointMillis(doc.session_end);
  if (end != null) return end; // checkpoint-end
  let max = null;
  for (const ex of doc.exchanges || []) { // checkpoint-exchange
    const t = checkpointMillis(ex && ex.timestamp);
    if (t != null && (max == null || t > max)) max = t;
  }
  return max;
}

function docTime(doc) {
  return checkpointMillis(doc && doc.updated_at) ?? 0;
}

/**
 * Session-level covers from current conforming records/ documents.
 * A row with inserted_id dispositions that transcript only and is not a cover.
 * The latest write wins. A retired or nonconforming record does not cover.
 * Throws when the store cannot be read.
 */
export async function readDispositionCoverage(db) {
  const docs = await db.collection('documents').find({
    doc_id: { $regex: `^${escapeRegex(SESSION_DISPOSITION_PREFIX)}` },
    retired: { $ne: true }
  }).toArray();
  const ranked = [...(docs || [])].sort((a, b) => {
    const dt = docTime(a) - docTime(b);
    if (dt !== 0) return dt;
    const dv = (Number(a && a.version) || 0) - (Number(b && b.version) || 0);
    if (dv !== 0) return dv;
    return String(a && a.doc_id).localeCompare(String(b && b.doc_id));
  });
  const best = new Map();
  for (const doc of ranked) {
    const conf = doc && doc.conformance;
    if (!conf || conf.verdict !== VERDICT.CONFORMS) continue;
    if (conf.template !== SESSION_DISPOSITION_TEMPLATE) continue;
    const when = docTime(doc);
    for (const row of parseDispositionRows(doc && doc.content)) {
      if (row.inserted_id) continue; // disposition-transcript
      if (!dispositionResolvesOverdue(row.disposition)) continue;
      best.set(row.session_id, {
        session_id: row.session_id,
        disposition: row.disposition,
        doc_id: doc.doc_id,
        version: doc.version ?? null,
        updated_ms: when
      });
    }
  }
  return best;
}

/**
 * Read open sessions and their live transcripts. Throws when the store cannot
 * be read; the caller must not turn that into `due: false`.
 */
export async function checkpointStatus(dbManager, now = new Date()) {
  const db = await dbManager.ensureClient();
  const covered = await readDispositionCoverage(db);
  const sessions = await db.collection(`${COLLECTION_PREFIX}sessions`)
    .find({ opened: true, closed: { $ne: true } })
    .toArray();
  const rows = [];
  for (const row of sessions) {
    const id = row && row._id != null ? String(row._id) : '';
    if (!id) continue;
    const pattern = `^${escapeRegex(id)}(_.*)?$`; // checkpoint-span
    const parts = await db.collection('transcripts').find({ session_id: { $regex: pattern } }).toArray();
    let last = null;
    for (const doc of parts) {
      const ms = liveSaveMillis(doc);
      if (ms != null && (last == null || ms > last)) last = ms;
    }
    rows.push({
      session_id: id,
      opened: row.opened === true,
      closed: row.closed === true,
      opened_at: row.opened_at ?? null,
      last_saved_at: last
    });
  }
  return checkpointDecision(rows, now, covered);
}

/**
 * Attach the reminder. emet_status always gets it, including `due: false`.
 * Any other result gets it only when the call's session is grouped under a
 * due open session (the base, or a part id `<base>_...`).
 */
export function applyCheckpoint(data, checkpoint, { always = false, sessionId = null } = {}) {
  if (!data || typeof data !== 'object' || Array.isArray(data) || !checkpoint) return false;
  if (always) {
    data.checkpoint = checkpoint;
    return true;
  }
  if (checkpoint.due !== true || sessionId == null || sessionId === '') return false;
  const hit = (checkpoint.sessions || []).some((s) => groupedUnder(sessionId, s.session_id)); // checkpoint-group
  if (!hit) return false;
  data.checkpoint = checkpoint;
  return true;
}

/** A failed read. Not `due: false`: that would claim the save is current. Only emet_status carries it. */
export function checkpointOnError(name) {
  if (name !== 'emet_status') return null; // checkpoint-unread-gate
  return { due: null, unread: true, save_with: saveWith() }; // checkpoint-unread-shape
}
