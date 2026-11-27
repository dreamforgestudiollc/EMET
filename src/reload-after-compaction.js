/**
 * EMET - Enduring Memory & Epistemic Tiers
 * Copyright (c) 2026 Dreamforge Studio LLC
 *
 * Licensed under the MIT License - see LICENSE
 *
 * Reload after compaction. A host's chat summary is not the
 * continuity record. After a compaction or a summary, and before multi-step
 * work, the host re-runs emet_initialize for every page and works from
 * HANDOFF and STATE.
 *
 * The rule is on every initialize. The checks ride EMET_CONTINUITY_CURRENCY
 * (off unless the value is 1), the same warn-only gate as tip-lag. A skipped
 * reload is a warning on the tool result. It does not block. It does not
 * rewrite HANDOFF or STATE. It does not delete. EMET_CONTINUITY_CURRENCY_BLOCK
 * stays inert.
 *
 * EMET cannot see a host's context window. A host declares compaction with
 * compacted: true (after_compaction is the same flag). A fresh load_id is a
 * complete initialize served within EMET_RELOAD_FRESH_MINUTES (default 15).
 * The load id is a hash of the payload, so the same text hashes the same;
 * freshness is the time that initialize was served. A session whose last
 * transcript activity is older than EMET_RELOAD_GAP_HOURS (default 6) warns
 * unless that fresh initialize is on the call. A write whose initialize saw
 * an older HANDOFF or STATE version warns. A close with no transcript append
 * warns.
 */

import { setting } from './env.js';
import { connectMongo } from './mongo-connect.js';
import { MONGODB_URI, MONGODB_DB, COLLECTION_PREFIX } from './database.js';
import { serverTime } from './server-time.js';
import { reloadBaseline } from './startup-pages.js';

export const RELOAD_RULE = 'After any compaction or summary, and before multi-step work, re-run emet_initialize for every page and work from HANDOFF and STATE. Do not continue from the chat summary.';

export const COMPACTION_NOTICE = 'Compaction was declared and this call has no fresh complete initialize. Re-run emet_initialize for every page, then work from HANDOFF and STATE, not from the summary. This warning does not block. Nothing was rewritten.';

export const NO_TRANSCRIPT_NOTICE = 'This session has no transcript appends. Append each exchange with emet_transcript_append. This warning does not block. Nothing was rewritten.';

export const RELOADED_NOTICE = 'A fresh complete initialize covers this compaction or gap. Work from HANDOFF and STATE, not from the summary. This does not block.';

export const CURRENT_NOTICE = 'No compaction marker, long gap, stale continuity version, or missing transcript was seen. This does not block.';

export const LOADED_NOTICE = 'This initialize is the reload. Work from HANDOFF and STATE. After any later compaction or summary, call emet_initialize again for every page before multi-step work.';

export const OFF_NOTICE = 'The reload check is off until EMET_CONTINUITY_CURRENCY is 1. The rule still applies: after any compaction or summary, re-run emet_initialize for every page and work from HANDOFF and STATE.';

export const UNREADABLE_NOTICE = 'The reload check could not be read. Nothing was blocked and nothing was rewritten.';

/** Same switch as continuity currency. Off unless the value is the digit 1. */
export function reloadCheckEnabled() {
  return setting('CONTINUITY_CURRENCY') === '1';
}

/** Reported and ignored. Phase-2 block is not approved. */
export function reloadBlockRequested() {
  return setting('CONTINUITY_CURRENCY_BLOCK') === '1';
}

export function reloadGapMs() {
  const n = Number(setting('RELOAD_GAP_HOURS'));
  if (!Number.isFinite(n) || n <= 0) return 6 * 60 * 60 * 1000;
  return n * 60 * 60 * 1000;
}

export function reloadFreshMs() {
  const n = Number(setting('RELOAD_FRESH_MINUTES'));
  if (!Number.isFinite(n) || n <= 0) return 15 * 60 * 1000;
  return n * 60 * 1000;
}

export function gapNotice(hours) {
  return `This session continued after a gap of ${hours} hours with no fresh initialize. Re-run emet_initialize for every page and work from HANDOFF and STATE. This warning does not block. Nothing was rewritten.`;
}

export function staleNotice(handoffSeen, handoffLive, stateSeen, stateLive) {
  return `This write is against a stale continuity version. Initialize saw HANDOFF v${versionText(handoffSeen)} and STATE v${versionText(stateSeen)}; live is HANDOFF v${versionText(handoffLive)} and STATE v${versionText(stateLive)}. Re-run emet_initialize and read HANDOFF and STATE. This warning does not block. HANDOFF and STATE were not rewritten.`;
}

function versionText(value) {
  return value == null || value === '' ? 'none' : String(value);
}

function versionOf(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}

function shaOf(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function pinOf(row, docId) {
  return {
    doc_id: (row && row.doc_id) || docId,
    seen_version: versionOf(row && row.version),
    seen_sha256: shaOf(row && row.sha256)
  };
}

/** The rule every initialize carries. Versions are included only while the check is on. */
export function initializeReloadReport({ handoff, state, handoffDocId = 'HANDOFF.md', stateDocId = 'STATE.md' } = {}) {
  const base = {
    does_not_block: true,
    block_enabled: false,
    block_requested: reloadBlockRequested(),
    rule: RELOAD_RULE,
    reasons: []
  };
  if (!reloadCheckEnabled()) {
    return { ...base, status: 'off', notice: OFF_NOTICE };
  }
  return {
    ...base,
    status: 'loaded',
    notice: LOADED_NOTICE,
    continuity: {
      handoff: pinOf(handoff, handoffDocId),
      state: pinOf(state, stateDocId)
    }
  };
}

/** compacted: true, 1, "1", or "true". after_compaction is the same flag. */
export function compactedFlag(args) {
  if (!args || typeof args !== 'object') return false;
  const value = args.compacted !== undefined ? args.compacted : args.after_compaction;
  return value === true || value === 1 || value === '1' || value === 'true';
}

function epochMs(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value > 1e12) return value;
    if (value > 1e9) return Math.round(value * 1000);
    return null;
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

/**
 * Activity before this call. An exchange written in the last two minutes is
 * the append that just landed, so the gap is the exchange before it. A first
 * append has no prior activity.
 */
export function priorActivityMs(exchanges, nowMs) {
  const times = [];
  for (const row of exchanges || []) {
    const ms = epochMs(row && row.timestamp);
    if (ms != null) times.push(ms);
  }
  times.sort((a, b) => b - a);
  if (!times.length) return null;
  if (Math.abs(times[0] - nowMs) <= 120000) return times.length >= 2 ? times[1] : null;
  return times[0];
}

function pinsDiffer(seen, live) {
  if (!seen || !live) return false;
  if (seen.seen_version != null && live.seen_version != null && seen.seen_version !== live.seen_version) return true;
  if (seen.seen_sha256 && live.seen_sha256 && seen.seen_sha256 !== live.seen_sha256) return true;
  if (seen.seen_version != null && live.seen_version == null) return true;
  return false;
}

function continuityView(seen, live) {
  const side = (label, pin, livePin) => ({
    doc_id: (livePin && livePin.doc_id) || (pin && pin.doc_id) || label,
    seen_version: pin ? pin.seen_version : null,
    seen_sha256: pin ? pin.seen_sha256 : null,
    live_version: livePin ? livePin.seen_version : null,
    live_sha256: livePin ? livePin.seen_sha256 : null,
    stale: pinsDiffer(pin, livePin)
  });
  return {
    handoff: side('HANDOFF.md', seen && seen.handoff, live && live.handoff),
    state: side('STATE.md', seen && seen.state, live && live.state)
  };
}

function isFresh(baseline, nowMs, freshMs) {
  if (!baseline || baseline.complete !== true || typeof baseline.at !== 'number') return false;
  const age = nowMs - baseline.at;
  return age <= freshMs && age >= -5000;
}

/**
 * Pure check. `blocked` is not a result: the caller does not refuse.
 * HANDOFF and STATE are not inputs that this function writes.
 */
export function assessReload({
  tool = '',
  compacted = false,
  loadId = null,
  baseline = null,
  seen = null,
  live = null,
  session = null,
  now = new Date(),
  freshMs = reloadFreshMs(),
  gapMs = reloadGapMs()
} = {}) {
  const nowMs = epochMs(now) || Date.now();
  const fresh = isFresh(baseline, nowMs, freshMs);
  const pins = seen || (baseline && baseline.continuity) || null;
  const continuity = continuityView(pins, live);
  const stale = continuity.handoff.stale || continuity.state.stale;
  const exchangeCount = session && Number.isInteger(session.exchange_count) ? session.exchange_count : null;
  const lastMs = session && session.last_activity_ms != null ? session.last_activity_ms : null;
  const gap = lastMs != null && nowMs - lastMs >= gapMs;
  const gapHours = gap ? Math.max(1, Math.floor((nowMs - lastMs) / 3600000)) : null;
  const close = tool === 'emet_session_close';
  const noTranscript = close && exchangeCount === 0;
  const reasons = [];
  if (stale) reasons.push('stale_continuity');
  if (compacted && !fresh) reasons.push('compaction_without_reload');
  if (gap && !fresh && !noTranscript) reasons.push('gap_without_reload');
  if (noTranscript) reasons.push('no_transcript');
  const covered = (compacted || gap) && fresh && !stale && !noTranscript;
  const status = reasons.length ? 'warn' : (covered ? 'reloaded' : 'current');
  const notices = [];
  if (reasons.includes('stale_continuity')) {
    notices.push(staleNotice(
      continuity.handoff.seen_version,
      continuity.handoff.live_version,
      continuity.state.seen_version,
      continuity.state.live_version
    ));
  }
  if (reasons.includes('compaction_without_reload')) notices.push(COMPACTION_NOTICE);
  if (reasons.includes('gap_without_reload')) notices.push(gapNotice(gapHours));
  if (reasons.includes('no_transcript')) notices.push(NO_TRANSCRIPT_NOTICE);
  const notice = notices.length ? notices.join(' ') : (status === 'reloaded' ? RELOADED_NOTICE : CURRENT_NOTICE);
  return {
    status,
    does_not_block: true,
    block_enabled: false,
    block_requested: reloadBlockRequested(),
    rule: RELOAD_RULE,
    notice,
    reasons,
    compacted: compacted === true,
    load_id: loadId || null,
    fresh_initialize: fresh,
    continuity,
    session: session ? {
      id: session.id || null,
      exchange_count: exchangeCount,
      last_activity_at: lastMs == null ? null : new Date(lastMs).toISOString(),
      gap_hours: gapHours
    } : null,
    observed_at: serverTime(new Date(nowMs))
  };
}

export function reloadUnreadable() {
  return {
    status: 'unreadable',
    does_not_block: true,
    block_enabled: false,
    block_requested: reloadBlockRequested(),
    rule: RELOAD_RULE,
    notice: UNREADABLE_NOTICE,
    reasons: []
  };
}

const RELOAD_TOOLS = new Set([
  'emet_session_open', 'emet_transcript_append', 'emet_session_close', 'save_transcript',
  'save_to_layer', 'revise_memory', 'write_doc', 'write_doc_begin', 'write_doc_commit', 'patch_doc',
  'revise_transcript', 'accept_nonconformance', 'retire_doc', 'rename_doc', 'restore_doc'
]);

export function reloadTool(name) {
  return RELOAD_TOOLS.has(name);
}

function loadIdFrom(args, data) {
  const named = args && typeof args.load_id === 'string' ? args.load_id.trim() : '';
  if (named) return named;
  const startup = data && data.startup_pages && typeof data.startup_pages.load_id === 'string'
    ? data.startup_pages.load_id.trim() : '';
  return startup || null;
}

function sessionIdFrom(args, data) {
  const named = args && typeof args.session_id === 'string' ? args.session_id.trim() : '';
  if (named) return named;
  const opened = data && typeof data.session_id === 'string' ? data.session_id.trim() : '';
  if (opened) return opened;
  const base = data && typeof data.base === 'string' ? data.base.trim() : '';
  return base || null;
}

function baseId(sessionId) {
  return String(sessionId || '').replace(/_verbatim_part\d+$/, '');
}

function handoffDocId() {
  return setting('HANDOFF_DOC', 'HANDOFF.md');
}

function stateDocId() {
  return setting('STATE_DOC', 'STATE.md');
}

async function readPin(db, docId) {
  const row = await db.collection('documents').findOne(
    { doc_id: docId },
    { projection: { _id: 0, doc_id: 1, version: 1, sha256: 1 } }
  );
  return pinOf(row, docId);
}

async function readSession(db, sessionId, nowMs, tool) {
  if (!sessionId) return null;
  const base = baseId(sessionId);
  const found = await db.collection('transcripts').find(
    { session_id: { $regex: `^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(_verbatim_part\\d+)?$` } },
    { projection: { _id: 0, session_id: 1, exchange_count: 1, superseded_by: 1, 'exchanges.timestamp': 1 } }
  ).toArray();
  const rows = Array.isArray(found) ? found : [];
  const live = rows.filter((row) => row && (row.superseded_by == null));
  const exchanges = [];
  let count = 0;
  for (const row of live) {
    if (Array.isArray(row.exchanges)) exchanges.push(...row.exchanges);
    const n = Number(row.exchange_count);
    count += Number.isInteger(n) && n >= 0 ? n : (Array.isArray(row.exchanges) ? row.exchanges.length : 0);
  }
  // A close with no transcript is the missing-append report. Any other call
  // with no transcript yet is not that report: the append comes after the reply.
  const exchangeCount = live.length ? count : (tool === 'emet_session_close' ? 0 : null);
  const stored = await db.collection(`${COLLECTION_PREFIX}sessions`).findOne(
    { _id: base },
    { projection: { _id: 0, continuity_seen: 1, reload_load_id: 1 } }
  );
  const seen = stored && stored.continuity_seen ? {
    handoff: {
      doc_id: stored.continuity_seen.handoff_doc || handoffDocId(),
      seen_version: versionOf(stored.continuity_seen.handoff_version),
      seen_sha256: shaOf(stored.continuity_seen.handoff_sha256)
    },
    state: {
      doc_id: stored.continuity_seen.state_doc || stateDocId(),
      seen_version: versionOf(stored.continuity_seen.state_version),
      seen_sha256: shaOf(stored.continuity_seen.state_sha256)
    }
  } : null;
  return {
    id: base,
    exchange_count: exchangeCount,
    last_activity_ms: priorActivityMs(exchanges, nowMs),
    seen,
    reload_load_id: stored && typeof stored.reload_load_id === 'string' ? stored.reload_load_id : null
  };
}

/**
 * Read-only. Returns null when the check is off or this tool is not one of
 * the reload tools. A read failure returns the unreadable report. Never throws.
 */
export async function loadReloadReport(db, { tool, args, data, now = new Date() } = {}) {
  if (!reloadCheckEnabled() || !reloadTool(tool)) return null;
  try {
    const nowMs = epochMs(now) || Date.now();
    const sessionId = sessionIdFrom(args, data);
    const session = await readSession(db, sessionId, nowMs, tool);
    let loadId = loadIdFrom(args, data);
    if (!loadId && session && session.reload_load_id) loadId = session.reload_load_id;
    const baseline = reloadBaseline(loadId, nowMs);
    const live = {
      handoff: await readPin(db, handoffDocId()),
      state: await readPin(db, stateDocId())
    };
    const seen = (baseline && baseline.continuity) || (session && session.seen) || null;
    return assessReload({
      tool,
      compacted: compactedFlag(args),
      loadId,
      baseline,
      seen,
      live,
      session: session ? {
        id: session.id,
        exchange_count: session.exchange_count,
        last_activity_ms: session.last_activity_ms
      } : null,
      now
    });
  } catch {
    return reloadUnreadable();
  }
}

/** The caller's database when dispatch already holds one. A new connection is only the fallback. */
async function databaseFor(dbManager) {
  if (dbManager && typeof dbManager.ensureClient === 'function') {
    const handle = await dbManager.ensureClient();
    if (handle && typeof handle.collection === 'function') return { db: handle, close: null };
    if (handle && typeof handle.db === 'function') return { db: handle.db(MONGODB_DB), close: null };
  }
  if (dbManager && typeof dbManager.collection === 'function') return { db: dbManager, close: null };
  const client = await connectMongo(MONGODB_URI, { serverSelectionTimeoutMS: 8000, maxPoolSize: 5 });
  return { db: client.db(MONGODB_DB), close: client };
}

/** Attach the report onto a tool result. Never throws. Does not rewrite records. */
export async function attachReloadReport(tool, args, data, now = new Date(), dbManager = null) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  if (tool === 'emet_initialize' || !reloadCheckEnabled() || !reloadTool(tool)) return null;
  let close = null;
  try {
    const opened = await databaseFor(dbManager);
    close = opened.close;
    const report = await loadReloadReport(opened.db, { tool, args, data, now });
    if (!report) return null;
    data.reload_after_compaction = report;
    if (tool === 'emet_session_close' && report.status === 'warn' && Array.isArray(data.warnings)) {
      if (!data.warnings.includes(report.notice)) data.warnings.push(report.notice);
    }
    return report;
  } catch {
    const report = reloadUnreadable();
    data.reload_after_compaction = report;
    return report;
  } finally {
    if (close) {
      try { await close.close(); } catch { /* the tool result already stands */ }
    }
  }
}
