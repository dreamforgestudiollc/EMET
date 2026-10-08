/**
 * EMET - the session graph: the monorail under the guardrails (2026-09-29;
 * the practice is docs/GUARDRAILS-AND-MONORAILS.md).
 *
 * The owner: "guardrails give a field of movement and execution to allow an AI to do
 * processes where rails guide the AI through a process flow without it
 * processing" (a recorded lesson). The floor, the character and the served
 * instructions are the guardrails. This file is the monorail - the car cannot
 * leave the beam; where a flow forks, a small switch owned by the track (never
 * the model) picks the branch (designed 2026-09-29, not yet built): the next step of a
 * session is decided by the session's STATE, read before every call, not by
 * the model remembering it.
 *
 * The graph, for one session:
 *   (not open) --session_open / first append--> open
 *   open: turn k = any reads, writes that may declare `exchange: k`, then append k
 *   close chain, served order: board, episodic record, transcript, HANDOFF last
 *   emet_session_close returns complete --> closed (stop condition)
 *
 * Gates (each names the fix; nothing is written when one refuses):
 *   not_open        a write names a session that was never opened
 *   turn_skipped    a write or append declares exchange n while n-1 is not appended
 *   handoff_early   HANDOFF.md written before the board, the episodic record
 *                   and the transcript exist for this session; for a bot tag's
 *                   own bots/<tag>/HANDOFF.md, before the episodic record and
 *                   the transcript (no board; C1, 2026-10-01)
 *   no_session      a write names no session at all (2026-10-03): open
 *                   one with emet_session_open, or pass the session_id
 *                   already opened, and resubmit the same write
 *   startup_pages   emet_session_open with no load_id, or with pages of
 *                   that load never fetched (2026-10-03)
 *   closed          any write after a complete close, except the one
 *                   closing exchange inside the grace window and a
 *                   transcript correction (2026-10-01; the transcript doors
 *                   enforce the same rule outright, below)
 *
 * The honest limit: the server sees tool calls, never the reply text. A host
 * that answers without calling any tool is invisible until its next call; turn
 * coverage is only as strong as the exchange numbers hosts report. Hosts we run
 * ourselves (a Claude Code hook, an owned runner) can be railed completely.
 *
 * MODE: enforce only (2026-10-03). Every skipped step is refused before
 * anything is written, as a ValidationError whose text says how to pass, and
 * the refusal is recorded in the lab. There is no report mode and no off
 * switch; EMET_SESSION_GRAPH is no longer read. A governed write that names a
 * session fails closed when the graph state cannot be read (dispatch.js).
 * A write that names no session still records verdict `unknown` and continues,
 * because there is no session to protect.
 */

import { setting } from './env.js';

export const GRAPH_MODES = Object.freeze(['enforce']);

/** Always 'enforce'. Kept as a function so every block and lab row names its mode. */
export function graphMode() {
  return 'enforce';
}

/** Tools the graph governs: every tool that writes. Reads are never gated. */
export const GRAPH_WRITE_TOOLS = Object.freeze(new Set([
  'save_to_layer', 'revise_memory', 'write_doc', 'patch_doc', 'retire_doc', 'rename_doc', 'restore_doc',
  'accept_nonconformance', 'emet_transcript_append', 'save_transcript', 'revise_transcript',
  'emet_session_close'
]));

export const HANDOFF_DOC = 'HANDOFF.md';
export const BOARD_DOC = 'STATE.md';

/**
 * Per-bot close records (C1, 2026-10-01; the owner's decisions 1-7). The rule, stated once: a session written
 * under a bot's source tag closes against that bot's own records
 * (bots/<tag>/HANDOFF.md); only that tag's own revisions in the session window
 * count; a bot tag never writes or cites the main HANDOFF.md or STATE.md.
 *
 * A tag T is a BOT TAG when bots/T/HANDOFF.md is listed in EMET_RECORD_DOCS,
 * the list that already marks ids as supersede-only records (tools.js
 * recordDocIds). No new setting: the owner adds one id per bot, and removing it
 * puts that tag back on the host rules. Bot records are named by the source
 * tag itself (decision 1), so no tag-to-name mapping exists. These are pure
 * reads of settings - no database - so the graph can key its bot-handoff gate
 * on a write's `source` without an extra read.
 */
export function botRecordDir(tag) { return `bots/${tag}/`; }
export function botHandoffDoc(tag) { return `bots/${tag}/HANDOFF.md`; }

/** Whether `tag` is a bot tag: bots/<tag>/HANDOFF.md is in EMET_RECORD_DOCS. */
export function isBotTag(tag) {
  if (typeof tag !== 'string' || !tag.trim() || tag.includes('/')) return false;
  // The same comma list tools.js recordDocIds() reads.
  const listed = String(setting('RECORD_DOCS', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
  return listed.includes(botHandoffDoc(tag.trim()));
}

/** The hub's main records: the handoff and board ids session.js uses (EMET_HANDOFF_DOC / EMET_STATE_DOC). */
export function mainRecordIds() {
  return [setting('HANDOFF_DOC', 'HANDOFF.md'), setting('STATE_DOC', 'STATE.md')];
}

/**
 * The source tag a write names, read as dispatch.js sourceOf reads it
 * (`source`, then the older aliases). Repeated here because dispatch imports
 * this module. No default: a write with no source takes the host path in the
 * graph.
 */
export function writeSourceOf(args = {}) {
  const v = args.source ?? args.updated_by ?? args.retired_by ?? args.accepted_by ?? args.channel ?? null;
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** Whether this call writes a bot's own handoff under that bot's tag: write_doc of bots/<source>/HANDOFF.md by a bot tag. */
export function isBotHandoffWrite(tool, args = {}) {
  if (tool !== 'write_doc') return false;
  const tag = writeSourceOf(args);
  return !!tag && isBotTag(tag) && args.doc_id === botHandoffDoc(tag);
}

/** The base session id of a part id (2026-09-30_x_verbatim_part2 -> 2026-09-30_x). */
export function baseOf(sessionId) {
  return String(sessionId || '').replace(/_verbatim_part\d+$/, '') || null;
}

/**
 * A caller's id as a refusal echoes it: capped at 64 characters, so a long id
 * cannot push the pass instruction past the 500-character error cap
 * (database.js sanitizeErrorMessage).
 */
export const ID_ECHO_MAX = 64;
export function echoId(id) {
  const s = String(id ?? '');
  const cps = Array.from(s); // whole characters: never a lone surrogate in the echo
  return cps.length > ID_ECHO_MAX ? `${cps.slice(0, ID_ECHO_MAX).join('')}…` : s;
}

/**
 * Every session base an id could belong to, the way the close check groups a
 * session's documents (session.js inspectSession: ^base(_.*)?$). An id like
 * `<base>_extra` is counted by the close as part of `<base>`, so the closed-
 * session guard must treat it as `<base>` too (2026-10-01, the reviewer's gate
 * (a)). Longest first: the id itself, then each prefix ending before a `_`.
 */
export function candidateBases(sessionId) {
  const sid = String(sessionId || '').trim();
  if (!sid) return [];
  const out = [sid];
  for (let i = sid.length - 1; i > 0; i--) if (sid[i] === '_') out.push(sid.slice(0, i));
  return [...new Set(out)];
}

/** Whether `id` is `base` itself or a part id the server mints for it (<base>_verbatim_partN). */
export function isMintedPartOf(id, base) {
  const sid = String(id || '');
  const prefix = `${base}_verbatim_part`;
  return !!base && (sid === base || (sid.startsWith(prefix) && /^\d+$/.test(sid.slice(prefix.length))));
}

/** Whether `sessionId` is grouped under `base` by the close check (^base(_.*)?$). */
export function groupedUnder(sessionId, base) {
  const sid = String(sessionId || '');
  return !!base && (sid === base || sid.startsWith(`${base}_`));
}

/**
 * The session a call names: `session_id`, else the transcript span in
 * `metadata.derived_from` (revise_memory refuses metadata.session_id and names
 * its session there - live-caught 2026-09-29, a recorded lesson), else - for
 * emet_session_close, the only tool that takes `receipts` -
 * `receipts.transcript_session_id`. The close tool's description documents
 * that shape ("receipts.transcript_session_id is used when this is omitted")
 * and sessionClose checks that session; until 2026-10-01 the graph read only
 * `session_id`, so a close naming its session only in the receipts was never
 * recorded and the session stayed open (the second reader's nit 3 on an earlier draft, the reviewer's
 * condition 1). Receipts sent as JSON text are read as sessionClose reads
 * them (session.js parseReceipts).
 */
export function sessionOf(args = {}) {
  const pick = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  return pick(args.session_id) ||
    pick(args.metadata && args.metadata.derived_from && args.metadata.derived_from.session_id) ||
    pick(receiptsOf(args.receipts) && receiptsOf(args.receipts).transcript_session_id);
}

/** The close's receipts as an object (an object, or JSON text of one), else null. Mirrors session.js parseReceipts. */
function receiptsOf(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string' && value.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch { /* not JSON - treated as not supplied, as sessionClose does */ }
  }
  return null;
}

/**
 * An exchange number as sent, normalized ONCE (2026-10-01, the second reader's re-check of
 * an earlier draft). Hosts send numbers as numbers or as text ("4"). The guard read "4"
 * as 4 while emet_transcript_append only took real numbers, so a text "4" was a
 * "retry" to the guard and "the next exchange" to the tool. dispatch now runs
 * every exchange_index through this before the graph, the guard and the tool,
 * so all three see the same number.
 *   absent (undefined, null, '')     -> null  (the tool numbers it next)
 *   a whole number >= 1, or its text -> that number
 *   anything else                    -> {error}
 */
export function normalizeExchangeNumber(v) {
  if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) return { value: null };
  let n = v;
  if (typeof n === 'string' && /^\s*\d+\s*$/.test(n)) n = Number(n);
  if (typeof n === 'number' && Number.isInteger(n) && n >= 1) return { value: n };
  return { error: `exchange_index must be a whole number, 1 or more (got ${JSON.stringify(v)})` };
}

/** The exchange a call declares, if any: `exchange` on writes, `exchange_index` on an append. */
export function declaredExchange(tool, args) {
  let v = tool === 'emet_transcript_append' ? args.exchange_index : args.exchange;
  // Hosts send numbers as numbers or as text ("18") depending on how they read
  // the schema - found on the first live call, 2026-09-29. Both are the same claim.
  if (typeof v === 'string' && /^\s*\d+\s*$/.test(v)) v = Number(v);
  return Number.isInteger(v) && v > 0 ? v : null;
}

// Worded like the transcript doors' refusal (2026-10-01): "open a new session"
// pushed hosts into stray -N sessions opened just for one late write.
export const CLOSED_NEXT = 'none in this session: it is closed and locked, and nothing more is written to it. ' +
  'Further work belongs in the next session, opened the usual way at the next session start; do not open a session just for it';

/**
 * What the state says the next step is. `state` is the stored record
 * ({opened, board, episodic, handoff, closed}); `highest` is the transcript's
 * highest appended exchange (0 when none).
 */
export function nextStep(state = {}, highest = 0) {
  const opened = !!state.opened || highest > 0;
  if (!opened) return 'emet_session_open, then emet_transcript_append exchange 1 after your first reply';
  if (state.closed) return CLOSED_NEXT;
  if (state.handoff) return 'emet_session_close with receipts; the handoff is written';
  return `emet_transcript_append exchange ${highest + 1} after this reply`;
}

/**
 * The decision, pure. Returns null for a tool the graph does not govern, else
 * {verdict: 'ok'|'refuse', gate, reason, next}.
 */
export function evaluate(tool, args = {}, state = {}, highest = 0, now = new Date()) {
  if (!GRAPH_WRITE_TOOLS.has(tool)) return null;
  const next = nextStep(state, highest);
  const refuse = (gate, reason, owed = next) => ({ verdict: 'refuse', gate, reason, next: owed });
  const opened = !!state.opened || highest > 0;
  const n = declaredExchange(tool, args);

  if (!opened && !(tool === 'emet_transcript_append' && (n === null || n === 1))) {
    if (tool === 'write_doc' && typeof args.doc_id === 'string' && args.doc_id.startsWith('drops/')) {
      return { verdict: 'ok', gate: 'drop_only', reason: null, next: 'open a session to write anything other than a new drop' };
    }
    return refuse('not_open', `session ${echoId(baseOf(sessionOf(args)))} was never opened. Open it with emet_session_open ` +
      '(with the load_id from your startup pages), then resubmit this same write with the session_id it returns. Until then this session may read, and may write a new drop only.');
  }
  const lateOk = tool === 'revise_transcript' ||
    (tool === 'emet_transcript_append' && ['grace', 'retry'].includes(graceDecision(state, n, highest, now)));
  if (state.closed && !lateOk) {
    return refuse('closed', `session ${echoId(baseOf(sessionOf(args)))} is closed and locked, so nothing was written to it. ` +
      'This belongs in the next session you open the usual way, at the next session start; do not open a session just for it.',
      'the same write in the next session, at the next session start');
  }
  if (n !== null && n > highest + 1) {
    return refuse('turn_skipped', `exchange ${highest + 1} of session ${echoId(baseOf(sessionOf(args)))} was never appended. Append it with ` +
      `emet_transcript_append (this session_id, exchange_index ${highest + 1}, that turn's user message and reply)` +
      `${highest + 2 < n ? `, and each exchange after it up to ${n - 1}` : ''}, then resubmit this same call.`);
  }
  // A bot's own handoff takes the same gate, without the board: a bot session
  // has no board unless it keeps one as a working document (C1, decision 5).
  const botHandoff = isBotHandoffWrite(tool, args);
  if (tool === 'write_doc' && (args.doc_id === HANDOFF_DOC || botHandoff)) {
    const missing = [];
    if (!botHandoff && !state.board) missing.push(`the board (${BOARD_DOC}) with patch_doc`);
    if (!state.episodic) missing.push('the episodic session record with save_to_layer (layer "episodic")');
    if (!(highest > 0)) missing.push('the transcript with emet_transcript_append');
    if (missing.length) {
      return refuse('handoff_early', `the handoff is written last. First write ${missing.join(', ')}, each with this ` +
        'session_id, then resubmit this same handoff write.');
    }
  }
  // An allowed call reports the step AFTER itself: an append of exchange n
  // points to n+1, a handoff points to close. (Live-caught 2026-09-29: the
  // pre-call value named the exchange just appended.) A refusal keeps the
  // pre-call step, because that step is still the one owed.
  let after = { state, highest };
  if (tool === 'emet_transcript_append' && n !== null && n === highest + 1) after = { state: { ...state, opened: true }, highest: n };
  if (tool === 'write_doc' && (args.doc_id === HANDOFF_DOC || botHandoff)) after = { state: { ...state, handoff: true }, highest };
  return { verdict: 'ok', gate: null, reason: null, next: nextStep(after.state, after.highest) };
}

/**
 * What a SUCCESSFUL call adds to the session's state. Returns the fields to
 * set, or null. `data` is the tool's result payload.
 */
export function recordStep(tool, args = {}, data = {}, now = new Date()) {
  if (tool === 'emet_session_open') {
    // A suffixed id records what it is the suffix of, so a real slug ending in
    // -N is never handed the same id (and vice versa).
    const of = data && data.suffix_applied && data.suffix_applied.requested;
    return { opened: true, opened_at: now, ...(of ? { suffix_of: of } : {}) };
  }
  // An append never opens a board-editing session. The first append is still
  // allowed by evaluate(); the board path requires a verified drops_seen array
  // stamped only by emet_session_open.
  if (tool === 'emet_transcript_append' || tool === 'save_transcript') return null;
  if (tool === 'save_to_layer' && args.layer === 'episodic') return { episodic: true, episodic_id: data && data.id };
  if ((tool === 'write_doc' || tool === 'patch_doc' || tool === 'restore_doc') && args.doc_id === BOARD_DOC) return { board: true, board_version: data && data.version };
  if (tool === 'write_doc' && (args.doc_id === HANDOFF_DOC || isBotHandoffWrite(tool, args))) return { handoff: true, handoff_version: data && data.version };
  if (tool === 'emet_session_close' && data && data.state === 'complete') return { closed: true, closed_at: now };
  return null;
}

// ---------------------------------------------------------------------------
// The thin store layer. The state lives in `<prefix>sessions`, one document per
// base session id. This file owns that collection and writes nothing else.
// ---------------------------------------------------------------------------

async function sessionsCollection(dbManager) {
  const { COLLECTION_PREFIX } = await import('./database.js');
  const db = await dbManager.ensureClient();
  return db.collection(`${COLLECTION_PREFIX}sessions`);
}

/**
 * A session's recorded state, for emet_session_open (2026-10-01): whether a
 * row exists, whether it was closed complete, and - if the id was minted as a
 * `-N` suffix - which id it is the suffix of. Throws when the store cannot be
 * read; the caller must not treat "unknown" as "free".
 */
export async function sessionStatus(base, dbManager) {
  const col = await sessionsCollection(dbManager);
  const row = await col.findOne({ _id: base }, { projection: { closed: 1, suffix_of: 1 } });
  return { exists: !!row, closed: !!(row && row.closed), suffix_of: (row && row.suffix_of) || null };
}

/** Whether a session's state says it was closed complete. Throws when the store cannot be read. */
export async function isSessionClosed(base, dbManager) {
  return (await sessionStatus(base, dbManager)).closed;
}

/**
 * The closing exchange (2026-10-01, the owner's decision). In the closing turn the
 * assistant writes the handoff, gets `complete` from emet_session_close, and
 * only then replies - so the append of that last exchange always arrives
 * after the close. A closed session therefore takes exactly ONE more append:
 * numbered highest+1, within EMET_CLOSE_GRACE_MINUTES (default 5; 0 turns the
 * window off) of the RECORDED close time `closed_at`. Once it is saved, or
 * once the window passes, the session is locked. A retry of that same
 * exchange number is answered as already saved, never as a second write:
 * the guard answers it itself and the tool is not called, at any time after
 * the close, so a retry can write nothing anywhere (2026-10-01, the second reader's blocker
 * and the reviewer's gate on an earlier draft). The closing exchange itself is written
 * into the session's last live part, whatever part or base id the caller sent.
 *
 * graceDecision is pure: state is the session row, declared the exchange the
 * append names (null when none), highest the transcript's highest exchange.
 *   grace     the one closing exchange may be saved now
 *   retry     the closing exchange was saved; this is the same number again
 *   used      the closing exchange was already saved
 *   expired   the window has passed
 *   not_next  the append names a number other than highest+1
 *   none      no window applies (not closed, closed_at not recorded, or off)
 */
export const DEFAULT_CLOSE_GRACE_MINUTES = 5;
export const MAX_CLOSE_GRACE_MINUTES = 60;

/**
 * The window setting, checked (2026-10-01, the second reader's nit 4). Unset or blank: the
 * default, 5. A number from 0 to 60: that many minutes (0 turns the window
 * off). Anything else is NOT silently accepted: a negative or non-numeric value
 * falls back to the default 5, and a value over 60 is capped at 60; both come
 * back with a `note` that the guard logs as a warning. Only decimal numbers
 * count: "0x10" or "0b11" is non-numeric here. Returns {minutes, note}.
 *
 * The name is EMET_CLOSE_GRACE_MINUTES. It is read through env.js setting(),
 * so the legacy CASCADE_CLOSE_GRACE_MINUTES is still read as a deprecated
 * fallback; EMET_ wins when both are set. (Not every EMET_ setting does this:
 * a few read process.env directly - see
 * docs/DEPLOY.md.)
 */
function closeGraceName() {
  return process.env.EMET_CLOSE_GRACE_MINUTES === undefined && process.env.CASCADE_CLOSE_GRACE_MINUTES !== undefined
    ? 'CASCADE_CLOSE_GRACE_MINUTES (deprecated; use EMET_CLOSE_GRACE_MINUTES)'
    : 'EMET_CLOSE_GRACE_MINUTES';
}

export function closeGraceSetting(raw = setting('CLOSE_GRACE_MINUTES'), name = closeGraceName()) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return { minutes: DEFAULT_CLOSE_GRACE_MINUTES, note: null };
  // Decimal only: Number() also reads hex, octal and binary ("0x10" is 16),
  // which no one means for minutes (the second reader's nit 5 on an earlier draft).
  const text = String(raw).trim();
  const n = /^[+-]?(\d+(\.\d*)?|\.\d+)(e[+-]?\d+)?$/i.test(text) ? Number(text) : NaN;
  if (!Number.isFinite(n) || n < 0) {
    return { minutes: DEFAULT_CLOSE_GRACE_MINUTES,
      note: `${name}=${JSON.stringify(String(raw))} is not a number of minutes from 0 to ${MAX_CLOSE_GRACE_MINUTES}; the default ${DEFAULT_CLOSE_GRACE_MINUTES} is used.` };
  }
  if (n > MAX_CLOSE_GRACE_MINUTES) {
    return { minutes: MAX_CLOSE_GRACE_MINUTES,
      note: `${name}=${JSON.stringify(String(raw))} is over the ${MAX_CLOSE_GRACE_MINUTES}-minute cap; ${MAX_CLOSE_GRACE_MINUTES} is used.` };
  }
  return { minutes: n, note: null };
}

export function closeGraceMinutes(raw = setting('CLOSE_GRACE_MINUTES')) {
  return closeGraceSetting(raw).minutes;
}

const graceNotesLogged = new Set();
function logGraceNote(note, logger) {
  if (!note || graceNotesLogged.has(note)) return;
  graceNotesLogged.add(note);
  if (logger && typeof logger.warn === 'function') logger.warn(`closing exchange: ${note}`);
  else console.error(`[emet] closing exchange: ${note}`); // stderr: stdout is the stdio transport's
}

export function graceDecision(state = {}, declared = null, highest = 0, now = new Date(), minutes = closeGraceMinutes()) {
  if (!state || !state.closed) return 'none';
  if (state.grace_used) return declared !== null && declared === state.grace_index ? 'retry' : 'used';
  const at = state.closed_at ? new Date(state.closed_at).getTime() : NaN;
  if (!(minutes > 0) || !Number.isFinite(at)) return 'none';
  const elapsed = now.getTime() - at;
  if (elapsed < 0 || elapsed > minutes * 60000) return 'expired';
  if (declared !== null && declared !== highest + 1) return 'not_next';
  return 'grace';
}

/**
 * Claims (or, on `release`, gives back) the closing exchange, atomically: the
 * claim matches only a closed row whose grace is unused, so two racing
 * appends cannot both win. Released when the claimed append then fails or
 * wrote nothing, so a failed write does not spend the window. Returns true
 * when the claim landed. Its own collection, `<prefix>sessions` - never a
 * layer, document or transcript.
 */
export async function markCloseGrace(base, dbManager, { index = null, now = new Date(), release = false } = {}) {
  const col = await sessionsCollection(dbManager);
  if (release) {
    await col.updateOne({ _id: base }, { $unset: { grace_used: '', grace_index: '', grace_used_at: '' } });
    return true;
  }
  const res = await col.updateOne(
    { _id: base, closed: true, grace_used: { $ne: true } },
    { $set: { grace_used: true, grace_index: index, grace_used_at: now } }
  );
  return !!(res && res.modifiedCount === 1);
}

/**
 * The transcript doors and a closed session (2026-10-01). Runs before the tool,
 * so a refusal writes nothing. A closed session takes no new exchanges,
 * except its one closing exchange (above).
 *
 *   emet_transcript_append  refused, except the closing exchange
 *   save_transcript         refused (a whole-session save adds exchanges)
 *   revise_transcript       ALLOWED - corrections supersede and delete
 *                           nothing - but capped: a revision of a closed
 *                           session's part may correct the exchanges that part
 *                           holds, never add new ones, so the session's
 *                           exchange count cannot grow.
 *
 * Fail-safe: if the session's state, its transcript
 * position or the part to be revised cannot be read, nothing is written.
 * Returns null (go ahead), or:
 *   {grace, base, index, part, notice}  the closing exchange: dispatch writes it
 *                                       as exchange `index` into `part`, never
 *                                       where the caller pointed
 *   {retry, base, index, notice}        a retry of the saved closing exchange:
 *                                       dispatch answers it and the tool is
 *                                       NOT called, so nothing can be written
 *   {revise, base, exchanges}           a correction of a closed session:
 *                                       the exchanges, numbers normalized
 */
export const TRANSCRIPT_WRITE_TOOLS = Object.freeze(new Set(['emet_transcript_append', 'save_transcript', 'revise_transcript']));

async function refusal(field, message) {
  const { ValidationError } = await import('./validation.js');
  return new ValidationError(field, message);
}

async function unreadable(tool, base, what, e) {
  const { DatabaseError } = await import('./database.js');
  return new DatabaseError(`${tool} could not read ${what} for session ${echoId(base)}, so nothing was written: ${e && e.message}. ` +
    'Nothing was lost; send the same call again.', tool);
}

export async function closedSessionGuard(tool, args = {}, dbManager, now = new Date(), logger = null) {
  if (!TRANSCRIPT_WRITE_TOOLS.has(tool)) return null;
  const sid = typeof args.session_id === 'string' ? args.session_id.trim() : '';
  if (!sid) return null;

  // The closed session this id belongs to, grouped as the close check groups
  // it: <base>, <base>_verbatim_partN and any other <base>_... id alike.
  let row = null;
  let base = baseOf(sid);
  try {
    const col = await sessionsCollection(dbManager);
    for (const b of candidateBases(sid)) {
      const r = await col.findOne({ _id: b }, { projection: { closed: 1, closed_at: 1, grace_used: 1, grace_index: 1 } });
      if (r && r.closed) { row = r; base = b; break; }
    }
  } catch (e) { throw await unreadable(tool, base, 'whether the session is closed', e); }
  if (!row) return null;

  const locked = (why) => refusal('session_id',
    `session ${echoId(base)} is closed and locked${why}, so nothing was written to it. Nothing in it was lost or changed. ` +
    'This exchange belongs in the next session you open the usual way, at the next session start; do not open a session just for it.');

  if (tool === 'revise_transcript') {
    let part;
    try {
      const db = await dbManager.ensureClient();
      const t = db.collection('transcripts');
      part = await t.findOne({ session_id: sid, superseded_by: { $in: [null, undefined] } }) || await t.findOne({ session_id: sid });
    } catch (e) { throw await unreadable(tool, base, 'the transcript part to be revised', e); }
    if (!part) return null; // the tool itself refuses a revision of a part that does not exist
    // A correction of a closed session keeps EXACTLY the exchange numbers the
    // part holds (2026-10-01, the second reader's nit 2): none added, none dropped, none
    // duplicated. Numbers sent as text are stored as numbers; the corrected
    // part is stored in exchange order.
    const held = [...new Set((part.exchanges || []).map((e) => Number(e && e.exchange_index)))].sort((a, b) => a - b);
    const heldText = held.join(', ') || 'none';
    const revised = Array.isArray(args.exchanges) ? args.exchanges : [];
    const fail = async (what) => refusal('exchanges',
      `session ${echoId(base)} is closed: a revision may correct the exchanges ${echoId(sid)} already holds (${held.length}: ${heldText}) ` +
      `and must carry exactly those numbers: never add new ones, never drop or repeat one - ${what}. Nothing was written.`);
    const numbered = [];
    for (let i = 0; i < revised.length; i++) {
      const ex = revised[i];
      const raw = ex && ex.exchange_index !== undefined ? ex.exchange_index : i; // the tool's own default
      const { value, error } = normalizeExchangeNumber(raw);
      if (error || value === null) throw await fail(`exchange ${i + 1} of the revision has no valid exchange_index (${JSON.stringify(raw)})`);
      numbered.push({ ...ex, exchange_index: value });
    }
    const nums = numbered.map((e) => e.exchange_index);
    const heldSet = new Set(held);
    const added = [...new Set(nums.filter((n) => !heldSet.has(n)))];
    if (added.length) {
      throw await fail(`exchange ${added.join(', ')} is not in that part` + (revised.length > held.length ? `, and the revision has ${revised.length}` : ''));
    }
    const repeated = [...new Set(nums.filter((n, i) => nums.indexOf(n) !== i))];
    if (repeated.length) throw await fail(`exchange ${repeated.join(', ')} appears more than once`);
    const dropped = held.filter((n) => !nums.includes(n));
    if (dropped.length) throw await fail(`exchange ${dropped.join(', ')} is missing from the revision`);
    return { revise: true, base, exchanges: numbered.sort((a, b) => a.exchange_index - b.exchange_index) };
  }

  if (tool === 'save_transcript') throw await locked(' (a whole-transcript save adds exchanges, which a closed session does not take)');

  // emet_transcript_append. dispatch has already normalized exchange_index.
  let pos;
  try {
    pos = typeof dbManager.transcriptPosition === 'function' ? await dbManager.transcriptPosition(base) : null;
    if (!pos || typeof pos.highest !== 'number') throw new Error('the transcript position is not available');
  } catch (e) { throw await unreadable(tool, base, 'the transcript position', e); }
  const highest = pos.highest;
  const declared = declaredExchange(tool, args);
  const setting = closeGraceSetting();
  logGraceNote(setting.note, logger);
  const minutes = setting.minutes;
  const d = graceDecision(row, declared, highest, now, minutes);

  if (d === 'retry') {
    // Answered HERE, and the tool is never called (2026-10-01, the second reader's blocker on
    // an earlier draft): a retry handed to the tool with the caller's arguments could
    // land in another part id, the base id, or - with the number sent as text -
    // as a new exchange, while the reply said nothing was written.
    return { retry: true, base, index: row.grace_index,
      notice: `Exchange ${row.grace_index} is already saved as the closing exchange of session ${base}. Nothing new was written; the session is locked.` };
  }
  if (d === 'grace') {
    const index = highest + 1;
    // Pinned to the session's last live part (2026-10-01, the second reader's nit 3), never
    // the part or base id the caller named. If that part is full, the append
    // rolls to the next part number exactly as a live append does.
    let part = typeof pos.last_part === 'string' && pos.last_part ? pos.last_part : null;
    if (!part && highest === 0) part = `${base}_verbatim_part1`;
    if (!part || !isMintedPartOf(part, base)) {
      throw await unreadable(tool, base, 'the last part of the transcript', new Error('the last part is not available'));
    }
    let claimed;
    try { claimed = await markCloseGrace(base, dbManager, { index, now }); }
    catch (e) { throw await unreadable(tool, base, 'the closing-exchange record', e); }
    if (claimed) {
      return { grace: true, base, index, part,
        notice: `Accepted as the closing exchange (exchange ${index}) of session ${base}, within ${minutes} minutes of its close. ` +
          'The session is now locked: no further exchanges are accepted.' };
    }
    throw await locked(' and its one closing exchange has already been saved');
  }
  const why = {
    used: ' and its one closing exchange has already been saved',
    expired: ` and the ${minutes}-minute window for its closing exchange has passed`,
    not_next: ` - only exchange ${highest + 1} could be saved as its closing exchange`,
    none: ''
  }[d] || '';
  throw await locked(why);
}

/**
 * The no_session gate's words (2026-10-03). Nothing was written, so the words
 * ask for the same write again, with a session.
 */
export const VISITOR_REASON =
  'Nothing was written. A visitor may read and leave a drop (drops/<date>-<slug>.md). Full access needs initialize, every page, and a registered source.';
export const NO_SESSION_REASON =
  'this write names no session. Open one with emet_session_open (with the load_id from your startup pages), or use the ' +
  'session_id of the session you already opened, then resubmit this same write with that session_id. ' + VISITOR_REASON;
export const NO_SESSION_NEXT = 'emet_session_open with load_id, then resubmit this same write with session_id';
export function noSessionDecision() {
  return { verdict: 'refuse', gate: 'no_session', reason: NO_SESSION_REASON, next: NO_SESSION_NEXT };
}

/**
 * The startup_pages gate (2026-10-03). emet_session_open with pages of the
 * paged startup never fetched is a skipped step and is refused before
 * anything is written. An open must name its startup: with no load_id the
 * pages cannot be checked, so the open is refused - never checked against
 * another load. A named load the server has no record of (made up, expired,
 * or from before a restart) cannot be checked either, so it is refused too,
 * with the way back: a fresh emet_initialize. Returns null when every page of
 * the named load was fetched.
 */
export const STARTUP_PAGES_TOOL = 'emet_session_open';
export const NO_LOAD_ID_REASON =
  'emet_session_open needs load_id, so no session was opened and nothing was written. Call emet_session_open again with ' +
  '"load_id" set to startup_page.load_id from your emet_initialize pages (every page carries it); if you have no startup ' +
  'pages, call emet_initialize {} and fetch every page first. ' + VISITOR_REASON;
export function noLoadIdDecision() {
  return { verdict: 'refuse', gate: 'startup_pages', reason: NO_LOAD_ID_REASON, next: 'emet_session_open with "load_id" from your startup pages' };
}
/** Page numbers as ranges, once: [2,3,4,7,9,10] -> "2-4, 7, 9-10". */
export function pageRanges(pages = []) {
  const out = [];
  for (let i = 0; i < pages.length; i++) {
    let j = i;
    while (j + 1 < pages.length && pages[j + 1] === pages[j] + 1) j++;
    out.push(j > i ? `${pages[i]}-${pages[j]}` : `${pages[i]}`);
    i = j;
  }
  return out.join(', ');
}
// The pass instruction comes first, and the missing pages are named once, as
// ranges, so the refusal fits the 500-character error-message cap
// (database.js sanitizeErrorMessage); pages too scattered to list in 60
// characters are asked for again from page 1. Tests pin 20 and 40 missing.
export const PAGE_LIST_MAX = 60;
export function startupPagesDecision(c) {
  const one = c.missing.length === 1;
  const first = `emet_initialize {"page": ${c.missing[0]}, "load_id": "${c.load_id}"}`;
  const ranges = pageRanges(c.missing);
  if (ranges.length > PAGE_LIST_MAX) {
    // Scattered pages too many to list: fetch every page again (harmless).
    return { verdict: 'refuse', gate: 'startup_pages',
      reason: `Fetch every startup page of load ${c.load_id}, 1 to ${c.of}: emet_initialize {"page": 1, "load_id": "${c.load_id}"}, then the ` +
        `same call for each page after it; then call emet_session_open again with "load_id": "${c.load_id}". ${c.missing.length} of its ` +
        `${c.of} pages were never fetched, so no session was opened and nothing was written. If told the startup changed, call emet_initialize {} and read every page.`,
      next: 'every page, then emet_session_open again' };
  }
  return { verdict: 'refuse', gate: 'startup_pages',
    reason: `Fetch startup page${one ? '' : 's'} ${ranges} of ${c.of} (load ${c.load_id}): ${first}` +
      `${one ? '' : ', then the same call for each page after it in that list'}; then call emet_session_open again with ` +
      `"load_id": "${c.load_id}". ${one ? 'That page was' : 'Those pages were'} never fetched, so no session was opened and nothing was written. ` +
      'If told the startup changed, call emet_initialize {} and read every page.',
    next: 'the missing pages, then emet_session_open again' };
}
// A load_id with no record here (never served by this process, expired after
// 60 minutes without a page, or from before a restart) cannot be checked, so
// the open is refused: pages are never taken as checked when they were not.
export const UNKNOWN_LOAD_ID_REASON = (id) =>
  'Call emet_initialize {} and fetch every page, then call emet_session_open again with the load_id it returns. ' +
  `Startup load ${echoId(id)} is not on record on this server (it was not served here, it expired after 60 minutes ` +
  'without a page, or the server restarted), so its pages cannot be checked: no session was opened and nothing was written.';
export function unknownLoadIdDecision(id) {
  return { verdict: 'refuse', gate: 'startup_pages', reason: UNKNOWN_LOAD_ID_REASON(id), next: 'emet_initialize {}, every page, then emet_session_open with its load_id' };
}
// The fetched-page record the gate reads is held in THIS process only: pages
// served by another server instance are not on it, so enforce assumes EMET
// runs as one process. With no load_id the open is unchecked - never checked
// against the latest startup this server built, which may be another host's.
export async function startupPagesGate(args = {}, now = new Date()) {
  const mode = graphMode();
  const loadId = typeof args.load_id === 'string' ? args.load_id.trim() : '';
  let base = null;
  try {
    const { sessionBaseId, sessionTimeZone } = await import('./transcript-session.js');
    base = sessionBaseId(now, args.slug || 'session', sessionTimeZone().zone); // the id asked for; a closed one opens as -2
  } catch { base = null; }
  let decision; let startupPages;
  if (!loadId) {
    decision = noLoadIdDecision();
    startupPages = { checked: false, load_id: null, reason: 'no load_id' };
  } else {
    let c = null;
    try {
      const { startupPageCompletion } = await import('./tools.js');
      c = startupPageCompletion(loadId);
    } catch { return null; }
    if (!c) {
      decision = unknownLoadIdDecision(loadId);
      startupPages = { checked: false, load_id: echoId(loadId), reason: 'no record of that load' };
    } else {
      if (c.complete || !Array.isArray(c.missing) || !c.missing.length) return null;
      decision = startupPagesDecision(c);
      startupPages = { load_id: c.load_id, of: c.of, missing: c.missing };
    }
  }
  const graph = { mode, base, highest: null, decision, startup_pages: startupPages };
  const { ValidationError } = await import('./validation.js');
  // The reason already names the exact calls that pass; no "Next:" repeat, so
  // the message stays inside the 500-character error cap.
  const err = new ValidationError('session_graph', decision.reason);
  err.graph = graph; // so the lab records the refusal too
  throw err;
}

/**
 * Before a governed call: read the state, decide. Returns
 * {mode, decision, base} or null when the graph does not apply.
 * Throws a ValidationError when the decision is a refusal.
 */
export async function graphBefore(tool, args, dbManager, now = new Date()) {
  const mode = graphMode();
  if (tool === STARTUP_PAGES_TOOL) return startupPagesGate(args, now);
  if (!GRAPH_WRITE_TOOLS.has(tool)) return null;
  const sid = sessionOf(args);
  let base = null; let highest = null; let decision;
  if (!sid) {
    // A session that is not open is not fully initialized: read access, and a
    // new drop, are the only writes. Everything else still refuses.
    if (tool === 'write_doc' && typeof args.doc_id === 'string' && args.doc_id.startsWith('drops/')) {
      return { mode, base: null, highest: 0, decision: { verdict: 'ok', gate: 'drop_only', reason: null, next: 'open a session to write anything other than a new drop' } };
    }
    decision = noSessionDecision();
  } else {
    base = baseOf(sid);
    const col = await sessionsCollection(dbManager);
    let state = (await col.findOne({ _id: base })) || {};
    // A transcript id is grouped as the close check groups it (<base>_extra
    // belongs to <base>), so a closed session is found under any of its ids.
    if (TRANSCRIPT_WRITE_TOOLS.has(tool) && !state.closed) {
      for (const b of candidateBases(sid)) {
        if (b === base) continue;
        const r = await col.findOne({ _id: b });
        if (r && r.closed) { state = r; base = b; break; }
      }
    }
    const pos = typeof dbManager.transcriptPosition === 'function' ? await dbManager.transcriptPosition(sid) : { highest: 0 };
    highest = pos.highest || 0;
    // A transcript write into a closed session is decided by closedSessionGuard,
    // which always runs next and says why (the closing exchange already saved,
    // its window passed, or which exchange could still close it).
    decision = state.closed && TRANSCRIPT_WRITE_TOOLS.has(tool)
      ? { verdict: 'ok', gate: null, reason: null, next: CLOSED_NEXT }
      : evaluate(tool, args, state, highest, now);
  }
  if (decision && decision.verdict === 'refuse') {
    const { ValidationError } = await import('./validation.js');
    const said = /nothing was written/i.test(decision.reason || '');
    const err = new ValidationError('session_graph', `${decision.reason}${said ? '' : ' Nothing was written.'} Next: ${decision.next}.`);
    err.graph = { mode, base, highest, decision }; // so the lab records the refusal too
    throw err;
  }
  return { mode, base, highest, decision };
}

// ---------------------------------------------------------------------------
// Lab results (2026-09-29, the owner: "a 'lab results' location for storing the
// results in real time with time stamps so we can have a resource to look at
// after the probationary period"). Every check the monorail makes - ok,
// refuse, unknown (would_refuse in rows from before enforce-only) - is one timestamped row in
// `<prefix>graph_lab`, written as it happens. emet_gaps reads the summary.
// ---------------------------------------------------------------------------

export const LAB_SUFFIX = 'graph_lab';

/** One lab row, pure. `graph` is what graphBefore returned (or attached to its refusal). */
export function labRow(tool, args = {}, graph = null, now = new Date(), actor = {}) {
  const block = graphBlock(graph);
  if (!block) return null;
  const d = graph.decision;
  return {
    ts: now,
    session: graph.base || baseOf(sessionOf(args)),
    tool,
    // writeSourceOf reads source and its aliases; save_to_layer and
    // revise_memory carry the tag in metadata.source (2026-10-03 lab fix).
    source: writeSourceOf(args) ?? (args.metadata && typeof args.metadata.source === 'string' && args.metadata.source.trim() ? args.metadata.source.trim() : null),
    person_id: actor.personId || null,
    client_id: actor.clientId || 'stdio',
    exchange_declared: declaredExchange(tool, args),
    highest_appended: Number.isInteger(graph.highest) ? graph.highest : null,
    mode: block.mode,
    verdict: block.verdict,
    gate: d.gate || null,
    reason: d.reason || null,
    ...(tool === 'write_doc' || tool === 'patch_doc' ? { doc_id: args.doc_id || null } : {}),
    ...(graph.startup_pages ? { startup_pages: graph.startup_pages } : {})
  };
}

/** Write the lab row. Never throws and never blocks the call: a lost row is logged. */
export async function labRecord(tool, args, graph, dbManager, logger = null) {
  try {
    const { currentActor } = await import('./persons.js');
    const row = labRow(tool, args, graph, new Date(), currentActor());
    if (!row) return;
    const { COLLECTION_PREFIX } = await import('./database.js');
    const db = await dbManager.ensureClient();
    const lab = db.collection(`${COLLECTION_PREFIX}${LAB_SUFFIX}`);
    try { await lab.createIndex({ client_id: 1 }, { sparse: true }); } catch { /* an index miss never blocks the row */ }
    await lab.insertOne(row);
  } catch (e) {
    logger?.warn?.('session graph: lab row not recorded', { tool, error: e && e.message });
  }
}

/**
 * Startup pages fetched after the session opened without them (2026-10-03):
 * one lab row each, verdict `late`, gate `startup_pages`. Inserted, never an
 * update of the open's row; labSummary pairs them up so a page fetched late
 * is not counted as still missing. Never throws, never awaited by a page.
 */
export function recordLatePages(late = [], dbManager, logger = null) {
  if (!Array.isArray(late) || !late.length || !dbManager) return;
  for (const e of late) {
    const graph = {
      mode: graphMode(), base: e.session, highest: null,
      decision: { verdict: 'late', gate: 'startup_pages',
        reason: `startup page ${e.page} of ${e.of} (load ${e.load_id}) was fetched after the session opened: late, not missing`, next: null },
      startup_pages: { load_id: e.load_id, of: e.of, page: e.page, late: true }
    };
    labRecord('emet_initialize', {}, graph, dbManager, logger);
  }
}

/**
 * The lab summary emet_gaps serves, from a list of rows (pure, so it is
 * tested without a database). Totals by verdict, gate, source and tool; the
 * flagged rows (anything not ok) newest first, up to `limit`.
 */
export function labSummary(rows = [], { limit = 50 } = {}) {
  const count = (key) => rows.reduce((m, r) => { const k = r[key] ?? 'none'; m[k] = (m[k] || 0) + 1; return m; }, {});
  // Startup pages (2026-10-03): a page fetched after the open (a `late` row)
  // is not still missing. An open whose every missing page came late is not
  // flagged; a `late` row is never flagged; an enforced refusal stays flagged.
  const sp = (r) => (r.gate === 'startup_pages' && r.startup_pages ? r.startup_pages : null);
  const lateKeys = new Set(rows.filter((r) => sp(r) && r.verdict === 'late').map((r) => `${r.session}|${r.startup_pages.load_id}|${r.startup_pages.page}`));
  const stillMissing = (r) => (sp(r) && Array.isArray(r.startup_pages.missing)
    ? r.startup_pages.missing.filter((p) => !lateKeys.has(`${r.session}|${r.startup_pages.load_id}|${p}`)) : null);
  const settled = (r) => r.verdict === 'late' || (r.verdict === 'would_refuse' && sp(r) && stillMissing(r) && stillMissing(r).length === 0);
  const flagged = rows.filter((r) => r.verdict !== 'ok' && !settled(r)).sort((a, b) => new Date(b.ts) - new Date(a.ts));
  const opens = rows.filter((r) => sp(r) && r.tool === STARTUP_PAGES_TOOL && Array.isArray(r.startup_pages.missing));
  const unchecked = rows.filter((r) => sp(r) && r.tool === STARTUP_PAGES_TOOL && r.startup_pages.checked === false);
  const times = rows.map((r) => new Date(r.ts).getTime()).filter(Number.isFinite);
  return {
    location: `<prefix>${LAB_SUFFIX}`,
    checks: rows.length,
    first_at: times.length ? new Date(Math.min(...times)).toISOString() : null,
    last_at: times.length ? new Date(Math.max(...times)).toISOString() : null,
    sessions: new Set(rows.map((r) => r.session).filter(Boolean)).size,
    by_verdict: count('verdict'),
    by_gate: count('gate'),
    by_source: count('source'),
    flagged: flagged.length,
    flagged_rows: flagged.slice(0, limit).map((r) => ({
      ts: new Date(r.ts).toISOString(), session: r.session, source: r.source, tool: r.tool,
      verdict: r.verdict, gate: r.gate, exchange_declared: r.exchange_declared,
      highest_appended: r.highest_appended, reason: r.reason,
      ...(r.doc_id !== undefined ? { doc_id: r.doc_id } : {}),
      ...(r.startup_pages ? { startup_pages: { ...r.startup_pages, ...(stillMissing(r) ? { still_missing: stillMissing(r) } : {}) } } : {})
    })),
    ...(opens.length || lateKeys.size || unchecked.length ? { startup_pages: {
      opens_refused_no_load_id: unchecked.filter((r) => r.verdict === 'refuse').length,
      opens_with_missing: opens.filter((r) => r.verdict === 'would_refuse').length,
      opens_refused: opens.filter((r) => r.verdict === 'refuse').length,
      pages_still_missing: opens.filter((r) => r.verdict === 'would_refuse').reduce((n, r) => n + stillMissing(r).length, 0),
      pages_late: lateKeys.size
    } } : {}),
    reading:
      'Each flagged row is either a real skipped step that was refused (the monorail working) or a gate that is wrong (fix it). ' +
      'Rows with verdict would_refuse are from before enforce-only (2026-10-03), when those writes were saved and flagged.'
  };
}

/** The block a governed write's result carries. */
export function graphBlock(g) {
  if (!g || !g.decision) return null;
  const d = g.decision;
  return {
    mode: g.mode,
    verdict: d.verdict,
    ...(d.gate ? { gate: d.gate } : {}),
    ...(d.reason ? { reason: d.reason } : {}),
    next: d.next
  };
}

/**
 * After a successful call: record the step. Never throws - a failed record is
 * logged, not fatal. Returns what happened, so the close can say so
 * (2026-10-01, the second reader's nit 2 on an earlier draft, the reviewer's condition 2):
 *   null                          nothing to record (no session, or no step)
 *   {recorded: true, base}        the step was written
 *   {recorded: false, base, error} the write failed (logged as a warning)
 * The write is an idempotent $set, so a caller may simply call it again.
 */
export async function graphAfter(tool, args, data, dbManager, logger = null, now = new Date()) {
  let base = null;
  try {
    base = tool === 'emet_session_open' ? (data && data.base) : baseOf(sessionOf(args));
    if (!base) return null;
    const set = recordStep(tool, args, data, now);
    if (!set) return null;
    const col = await sessionsCollection(dbManager);
    const { currentPersonId, currentClientId } = await import('./persons.js');
    const listed = tool === 'emet_session_open' && data && Array.isArray(data.drops_seen) ? data.drops_seen.filter((id) => typeof id === 'string') : [];
    const opened = tool === 'emet_session_open'
      ? { opened_by: { person_id: currentPersonId() || null, client_id: currentClientId() || 'stdio' } }
      : {};
    // Merge, never overwrite: a reopen keeps drops already stamped.
    // An unverified boot is stored as a flag, never as an empty seen-list.
    const addDrops = tool === 'emet_session_open' && listed.length ? { $addToSet: { drops_seen: { $each: listed } } } : {};
    const unverified = tool === 'emet_session_open' && data && data.drops_unverified === true ? { drops_unverified: true } : {};
    const verifiedOpen = tool === 'emet_session_open' && data && data.drops_unverified !== true && Array.isArray(data.drops_seen);
    const clearUnverified = verifiedOpen ? { $unset: { drops_unverified: '' } } : {};
    await col.updateOne({ _id: base }, { $set: { ...set, ...unverified, updated_at: now }, $setOnInsert: { created_at: now, ...opened }, ...addDrops, ...clearUnverified }, { upsert: true });
    return { recorded: true, base };
  } catch (e) {
    logger?.warn?.('session graph: step not recorded', { tool, error: e && e.message });
    return { recorded: false, base, error: (e && e.message) || String(e) };
  }
}

export default { GRAPH_MODES, graphMode, ID_ECHO_MAX, echoId, pageRanges, PAGE_LIST_MAX, unknownLoadIdDecision, GRAPH_WRITE_TOOLS, STARTUP_PAGES_TOOL, noLoadIdDecision, startupPagesDecision, startupPagesGate, recordLatePages, botRecordDir, botHandoffDoc, isBotTag, mainRecordIds, writeSourceOf, isBotHandoffWrite, baseOf, candidateBases, groupedUnder, isMintedPartOf, sessionOf, normalizeExchangeNumber, declaredExchange, CLOSED_NEXT, nextStep, evaluate, recordStep, graphBefore, graphBlock, graphAfter, sessionStatus, isSessionClosed, DEFAULT_CLOSE_GRACE_MINUTES, MAX_CLOSE_GRACE_MINUTES, closeGraceSetting, closeGraceMinutes, graceDecision, markCloseGrace, TRANSCRIPT_WRITE_TOOLS, closedSessionGuard, LAB_SUFFIX, labRow, labRecord, labSummary };
