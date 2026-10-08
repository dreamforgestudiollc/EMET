/**
 * EMET - Enduring Memory & Epistemic Tiers
 * Copyright (c) 2026 Dreamforge Studio LLC
 *
 * Licensed under the MIT License - see LICENSE
 *
 * Session close.
 *
 * A conversation ends. The model's context is discarded. Whatever was not
 * written to the store before that moment did not happen, as far as every later
 * session is concerned - and nothing about the ending announces itself in time
 * to be useful. This is the single largest source of lost continuity in
 * practice, and it is not a storage problem: the store was reachable the whole
 * time and simply never called.
 *
 * emet_session_close is the gate at that boundary. It does NOT write the
 * artifacts. It CHECKS whether they exist and reports precisely which are
 * missing, because:
 *
 *   - only the model holds the session's content; a tool cannot author a
 *     handoff, and one that generated a plausible-looking summary would be
 *     manufacturing exactly the false continuity the disciplines forbid;
 *   - a wrap-up step that reports success without evidence is worse than none,
 *     since it stops anyone from looking again. Same reasoning as
 *     emet_verify_connection: check the thing, do not assert it.
 *
 * The protocol is returned as data, so it reaches the model in a form it can
 * act on rather than as prose in a document nobody loads. emet_initialize
 * returns the same summary at session START, which is the only moment early
 * enough to matter - a model that first hears about the wrap-up when the user
 * says goodbye has already lost the room to do it.
 */

import { connectMongo } from './mongo-connect.js';
import { setting } from './env.js';
import { MONGODB_URI, MONGODB_DB, COLLECTION_PREFIX, DatabaseError } from './database.js';
import { LAYERS } from './layers.js';
import { parseMetadata } from './metadata.js';
import { applyCloseCap, scopeFor, escalateSpeak, CLOSE_CAP } from './lessons-to-checks.js';
import { isBotTag, botHandoffDoc, botRecordDir, mainRecordIds, echoId } from './session-graph.js';

const DOCS_COLLECTION = 'documents';
const TRANSCRIPTS_COLLECTION = 'transcripts';
/** Blocked-close counter per base session id (Build 2, 2026-09-27). */
const CLOSE_ATTEMPTS_COLLECTION = 'close_attempts';

/** Continuity document ids. Defaults match the convention the docs describe; an
 *  user using different names sets EMET_HANDOFF_DOC / EMET_STATE_DOC. */
export const handoffDoc = () => setting('HANDOFF_DOC', 'HANDOFF.md');
export const stateDoc = () => setting('STATE_DOC', 'STATE.md');

/** Default lookback when the caller cannot supply a session start. Deliberately
 *  generous: a false "missing" is a wasted check, a false "present" is a lost
 *  session. */
const DEFAULT_WINDOW_HOURS = 12;

export const CLOSE_PROTOCOL = Object.freeze([
  {
    step: 1,
    artifact: 'thread / project documents',
    what: 'Update the working documents for whatever the session actually changed, before writing the handoff.',
    why: 'A handoff written from memory carries stale priorities. It must be derived from the documents, not from recall.',
    tools: ['write_doc', 'patch_doc']
  },
  {
    step: 2,
    artifact: 'episodic entry',
    what: 'Save a summary of the session to the episodic layer, then read it back to confirm it landed.',
    why: 'The layers are what get searched first in a later session. A session absent from them is invisible to recall.',
    tools: ['save_to_layer', 'query_layer']
  },
  {
    step: 3,
    artifact: 'position marker',
    what: 'Update the platform-wide state document: active work, phase, blockers, open decisions.',
    why: 'The handoff describes one session. This describes where everything stands.',
    tools: ['write_doc', 'patch_doc']
  },
  {
    step: 4,
    artifact: 'transcript',
    what: 'Save the exchanges verbatim - word for word, every message, nothing summarised, condensed, paraphrased or trimmed. If the payload will not transmit, split it across parts named <session_id>_verbatim_part1, _part2, and so on, continuing the exchange_index sequence rather than restarting it - part 1 ending at 5 means part 2 opens at 6. Never compress it.',
    why: 'This is the second tier. Its whole value is being independent of the curated layers: when a layer entry is relevant but thin, the transcript around its timestamp holds the depth that was compressed out. Summarising here collapses the two tiers into one and destroys the second line of inquiry permanently. Parts are resolved and verified as one session, so a set with a hole in it is reported as incomplete rather than passing on the strength of the parts that did save.',
    tools: ['emet_session_open', 'emet_transcript_append', 'save_transcript', 'query_transcripts']
  },
  {
    step: 5,
    artifact: 'handoff - written LAST, in one write',
    what: 'A new revision of the handoff record, written whole with write_doc and `supersedes` set to the version in force - a record is superseded, never patched or appended. What was in progress, why it stopped, the exact next steps, and the state a successor needs - documents touched, decisions made, anything half-finished - plus a close verification naming the artifacts above and the evidence each returned.',
    why: 'The next session begins with no context at all; this document is the only thing that crosses the gap. It is written last because its close verification attests to the other artifacts. Written earlier it attests to things that do not yet exist, and needs a patch afterwards - which is how one reference install ended up with a handoff whose section 6 cited saves made after it was written. If a session ends mid-close the prior handoff stands, and the position marker and session record already carry the session.',
    tools: ['write_doc']
  }
]);

async function connect() {
  const { testClientActive } = await import('./mongo-connect.js');
  if (!MONGODB_URI && !testClientActive()) {
    throw new DatabaseError('MONGODB_URI is not set; cannot verify session artifacts.');
  }
  const client = await connectMongo(MONGODB_URI || 'mongodb://test', { serverSelectionTimeoutMS: 15000 });
  return { client, db: client.db(MONGODB_DB) };
}

/** Transcript timestamps are stored as BSON dates; layer timestamps as Unix
 *  seconds. Accept either and answer in milliseconds. */
function toMillis(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value > 1e11 ? value : value * 1000;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

/**
 * A session too large to transmit in one call is split across parts named
 * `<base>_verbatim_part1`, `_part2`, and so on. That convention lives in the
 * protocol below and in the user's documents; the check did not know about
 * it, and the two disagreed in both directions:
 *
 *   - asked about the base id, findOne matched no part and reported a fully
 *     saved session as never written;
 *   - asked about a part id, it inspected that part alone, found it internally
 *     sound, and returned `complete` for a session whose other parts did not
 *     exist. A wrap-up step that certifies a partial record is worse than none,
 *     which is the same reasoning that put this tool here.
 *
 * So parts are resolved as a set. Indices continue across parts rather than
 * restarting - part 1 ends at 5, part 2 opens at 6 - so contiguity is a
 * property of the whole session and cannot be judged from one part.
 */
const PART_SUFFIX = /_(?:verbatim_)?part(\d+)$/i;

function baseSessionId(sessionId) {
  return sessionId.replace(PART_SUFFIX, '');
}

function partNumber(sessionId) {
  const m = PART_SUFFIX.exec(sessionId);
  return m ? Number(m[1]) : 0;
}

/** Escapes a session id for use inside a regular expression, so an id
 *  containing regex metacharacters matches literally. */
function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Verifies a transcript the way the protocol requires rather than trusting that
 * the write returned. A truncated or partly-empty transcript is the failure this
 * exists to catch, because it looks like success from the outside.
 *
 * `startIndex` is where this document's exchanges are expected to begin: 1 for a
 * whole session, or the running total for a continuation part.
 */
function inspectTranscript(doc, startIndex = 1) {
  if (!doc) return { present: false };

  const exchanges = Array.isArray(doc.exchanges) ? doc.exchanges : [];
  const indices = exchanges.map((e) => e && e.exchange_index);
  const contiguous =
    exchanges.length > 0 && indices.every((n, i) => n === startIndex + i);
  const emptyFields = exchanges.filter(
    (e) => !e || !e.user_message || !e.assistant_message || !e.exchange_index || !e.timestamp
  ).length;
  const declared = typeof doc.exchange_count === 'number' ? doc.exchange_count : null;

  return {
    present: true,
    session_id: doc.session_id,
    exchanges_stored: exchanges.length,
    exchange_count_field: declared,
    count_matches: declared === null ? null : declared === exchanges.length,
    first_index: indices.length ? indices[0] : null,
    last_index: indices.length ? indices[indices.length - 1] : null,
    expected_first_index: startIndex,
    indices_contiguous: contiguous,
    exchanges_with_empty_fields: emptyFields,
    characters_stored: exchanges.reduce(
      (n, e) => n + String((e && e.user_message) || '').length + String((e && e.assistant_message) || '').length,
      0
    ),
    intact: contiguous && emptyFields === 0 && (declared === null || declared === exchanges.length)
  };
}

/**
 * Resolves every document belonging to a session, whether it was saved whole or
 * split into parts, and judges the set rather than any single document.
 *
 * Exported for the tests: the split-part behaviour is the part that was wrong,
 * so it is the part that needs to be assertable without a live database.
 */
export async function inspectSession(collection, requestedId) {
  const base = baseSessionId(requestedId);
  const all = await collection
    .find({ session_id: { $regex: `^${escapeRegex(base)}(_.*)?$` } })
    .toArray();

  // A part corrected with revise_transcript leaves both copies in place. The
  // live one is whatever nothing supersedes; superseded copies stay readable but
  // must not be counted, or a corrected session reads as an overlapping one.
  const superseded = all.filter((d) => d.superseded_by);
  const liveDocs = all.filter((d) => !d.superseded_by);
  const docs = liveDocs.length > 0 ? liveDocs : all;

  if (docs.length === 0) {
    return {
      present: false,
      requested_session_id: requestedId,
      base_session_id: base,
      note: requestedId === base
        ? undefined
        : 'A part id was supplied and no document matched it or the session it belongs to.'
    };
  }

  docs.sort((a, b) => partNumber(a.session_id) - partNumber(b.session_id));

  // Single document saved under the base id: the whole session, unsplit.
  if (docs.length === 1 && partNumber(docs[0].session_id) === 0) {
    const single = inspectTranscript(docs[0], 1);
    return { ...single, split: false, requested_session_id: requestedId, base_session_id: base };
  }

  const parts = [];
  let expectedNext = 1;
  const gaps = [];
  for (const doc of docs) {
    const inspected = inspectTranscript(doc, expectedNext);
    if (inspected.first_index !== null && inspected.first_index !== expectedNext) {
      gaps.push(
        `${doc.session_id} opens at exchange ${inspected.first_index}; ${expectedNext} was expected` +
        (inspected.first_index > expectedNext
          ? ` - exchanges ${expectedNext}-${inspected.first_index - 1} are in no saved part`
          : ' - it overlaps the previous part')
      );
    }
    parts.push(inspected);
    if (inspected.last_index !== null) expectedNext = Math.max(expectedNext, inspected.last_index + 1);
  }

  const totalExchanges = parts.reduce((n, p) => n + p.exchanges_stored, 0);
  const partsIntact = parts.every((p) => p.intact);

  return {
    present: true,
    split: true,
    requested_session_id: requestedId,
    base_session_id: base,
    parts_found: docs.map((d) => d.session_id),
    revisions: superseded.length === 0 ? null : {
      corrected_parts: [...new Set(superseded.map((d) => d.session_id))],
      superseded_copies_retained: superseded.length,
      reasons: docs.filter((d) => d.revision_reason).map((d) => ({ session_id: d.session_id, revision: d.revision, reason: d.revision_reason })),
      note: 'One or more parts were corrected with revise_transcript. The superseded copies are retained and readable; the counts above describe the live versions.'
    },
    part_count: docs.length,
    exchanges_stored: totalExchanges,
    highest_exchange_index: expectedNext - 1,
    gaps,
    exchanges_with_empty_fields: parts.reduce((n, p) => n + p.exchanges_with_empty_fields, 0),
    characters_stored: parts.reduce((n, p) => n + p.characters_stored, 0),
    parts,
    // A set of parts is intact only if every part verifies AND they join without
    // a gap. Either failing means exchanges are missing, however sound each
    // surviving part looks on its own.
    intact: partsIntact && gaps.length === 0
  };
}

/**
 * Corroborates transcript coverage against evidence written for another purpose.
 *
 * A missing TAIL is invisible to the transcript alone: nothing in a set of parts
 * records how long the session was meant to be, so a set that stops early looks
 * exactly like a set that finished. Asking the model to declare the length would
 * be one more promise, and promises are the reason this tool exists.
 *
 * The evidence is already there. Semantic and procedural writes carry
 * derived_from {session_id, exchange_start, exchange_end}, promoted to the
 * indexed source_* columns. An entry citing exchange 41 is an independent
 * assertion - written during the session, for an unrelated reason - that the
 * session reached at least 41. Against the highest saved transcript index it
 * prices the tail without anyone having declared anything.
 *
 * Same construction as aleph: not a claim about the write, but a second artifact
 * that has to agree with the first.
 *
 * The residual limit is real and is reported rather than glossed - exchanges
 * after the LAST layer write cite nothing and stay invisible. This yields a
 * floor on how far the session ran, never a proof that it is whole.
 */
export async function corroborateCoverage(db, baseId) {
  const pattern = new RegExp(`^${escapeRegex(baseId)}(_.*)?$`);
  let citedMax = null;
  let citingEntries = 0;
  let supersededSkipped = 0;
  const byLayer = {};

  for (const layer of LAYERS) {
    let rows;
    try {
      rows = await db
        .collection(`${COLLECTION_PREFIX}${layer}`)
        .find(
          { source_session_id: { $regex: pattern } },
          { projection: { id: 1, source_exchange_end: 1, source_exchange_start: 1,
                          superseded_by: 1, is_live: 1, metadata: 1 } }
        )
        .toArray();
    } catch {
      continue;
    }
    if (rows.length === 0) continue;
    for (const row of rows) {
      // A SUPERSEDED entry's pointer is not evidence about this session. It is
      // the pointer the revision was written to replace, and a corrected span
      // is the commonest reason for a revision - so counting it means a
      // correction makes the check permanently worse, and the flag can never
      // clear because superseded entries cannot be edited. Found live at the
      // 2026-09-11 close: nine entries superseded with correct spans, and the
      // check still read the old record's 31-33 against a 27-exchange session.
      // Every other read in EMET hides superseded entries by default; this one
      // now does too - and says how many it set aside, because dropping
      // evidence silently is the other half of the same mistake.
      const md = parseMetadata(row.metadata) || {};
      if (row.superseded_by || md.superseded_by || row.is_live === false) { supersededSkipped++; continue; }
      byLayer[layer] = (byLayer[layer] || 0) + 1;
      citingEntries++;
      const end = typeof row.source_exchange_end === 'number'
        ? row.source_exchange_end
        : (typeof row.source_exchange_start === 'number' ? row.source_exchange_start : null);
      if (end !== null && (citedMax === null || end > citedMax)) citedMax = end;
    }
  }

  return {
    citing_entries: citingEntries,
    entries_by_layer: byLayer,
    highest_exchange_cited: citedMax,
    superseded_entries_excluded: supersededSkipped,
    note: citingEntries === 0
      ? 'No layer entry cites this session, so coverage cannot be corroborated from independent evidence. Absence of a contradiction is not confirmation.'
      : 'Layer entries written during the session cite exchange numbers; the highest is a floor on how far the session actually ran. Exchanges after the last such write cite nothing and remain unverifiable.'
  };
}

/**
 * Close receipts - the blocking half of the close verify (2026-09-26).
 *
 * The store check above answers "do the artifacts exist". It could not answer
 * "did the host actually do each step", and a host that skipped a step, or
 * never read the transcript back, could still walk away with `complete`
 * because the store happened to look fine. The owner's requirement (a decision record,
 * 389, 391): the wrap steps HAVE TO BE FOLLOWED, whichever model is hosting,
 * and a skipped step blocks the close the same way a skipped opening is caught
 * at initialize.
 *
 * So `complete` now requires receipts: the host states, per step, what it
 * wrote and what it read back, and every receipt is compared against the
 * store. A receipt the host could only have produced by doing the step - the
 * version it wrote, the episodic id it got back, the transcript part ids and
 * exchange count it queried - is the evidence. Omitted receipts, or receipts
 * that disagree with the store, return `blocked`.
 *
 * The four-item verify: working documents, episodic session record, board,
 * verbatim transcript read back from MongoDB. The handoff is written last and
 * is checked for being last.
 *
 * What this still cannot do, stated rather than hidden: it cannot make a host
 * call close at all, and it cannot tell a verbatim exchange from a condensed
 * one. It can make sure a host that calls close after skipping a step cannot
 * get `complete`, and that what the user hears is copied from the check.
 */
export const RECEIPT_FIELDS = Object.freeze({
  working_docs: 'array of document ids (or {doc_id, version}) updated this session before the handoff - [] if none',
  episodic_id: 'id of the episodic session record, as returned by save_to_layer and read back',
  board_doc: 'board document id, usually STATE.md',
  board_version: 'version of the board document after this session\'s update',
  transcript_session_id: 'base transcript session id',
  transcript_parts: 'the part ids query_transcripts returned for this session',
  transcript_exchanges: 'highest exchange index query_transcripts returned',
  handoff_version: 'version of the handoff written last'
});

/**
 * A bot session's receipts (C1, 2026-10-01).
 * Seven: no board is required - a bot that keeps one lists it under
 * bots/<tag>/ as board_doc (checked when given) or as a working document - and
 * handoff_doc names the bot's own handoff. Host receipts stay at the eight
 * above, unchanged.
 */
export const BOT_RECEIPT_FIELDS = Object.freeze({
  working_docs: RECEIPT_FIELDS.working_docs,
  episodic_id: 'id of the episodic session record, written under this bot\'s tag with derived_from citing this session, as returned by save_to_layer and read back',
  transcript_session_id: RECEIPT_FIELDS.transcript_session_id,
  transcript_parts: RECEIPT_FIELDS.transcript_parts,
  transcript_exchanges: RECEIPT_FIELDS.transcript_exchanges,
  handoff_doc: 'the bot\'s own handoff record, bots/<tag>/HANDOFF.md',
  handoff_version: RECEIPT_FIELDS.handoff_version
});

/** The message every bot-records refusal carries. */
export function hubRecordsMessage(tag) {
  return `a bot session closes against ${botRecordDir(tag)} records; the main handoff and board are the hub's`;
}

/**
 * The session's tag: the source tag on its transcript (`channel`, checked
 * against the registry on every append). Pure, from the transcript rows of one
 * session. Live parts are read (superseded copies only if nothing is live);
 * the tag is known only when every part carries the same one. Returns
 * {tag, tags}: tag null when there is none or the parts disagree.
 */
export function sessionTagOf(rows = []) {
  const live = rows.filter((r) => r && !r.superseded_by);
  const use = live.length ? live : rows.filter(Boolean);
  const tags = [...new Set(use.flatMap((r) => {
    const fromEx = (r.exchanges || []).map((e) => (e && e.source) || r.channel).filter((s) => typeof s === 'string' && s.trim());
    return fromEx.length ? fromEx : [r.channel];
  }).map((s) => (typeof s === 'string' ? s.trim() : '')).filter(Boolean))];
  return { tag: tags.length === 1 ? tags[0] : null, tags };
}

/**
 * Hosts do not all pass an object argument the same way. A client working from
 * a cached tool list that predates `receipts` - or a host that serialises every
 * nested argument - sends the receipts as JSON TEXT. Found live at the first
 * close under the new rule (2026-09-26, cloud-host): every artifact present,
 * receipts sent, and the server saw none. Consistent execution across hosts
 * means accepting both forms. Text that does not parse is treated as absent,
 * so it still blocks - it is never guessed at.
 */
export function parseReceipts(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string' && value.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch { /* not JSON - treated as not supplied */ }
  }
  return null;
}

function receiptDocId(entry) {
  if (typeof entry === 'string') return entry;
  if (entry && typeof entry.doc_id === 'string') return entry.doc_id;
  return null;
}

/**
 * Compares receipts against what the store holds. Pure: `observed` is built by
 * sessionClose from the database, so the rule itself is testable without one.
 *
 * observed = {
 *   documents: [{doc_id, exists, version, updated_at, updated_this_session}],
 *   episodic: {id, timestamp_ms} | null   (the entry named by the receipt, in window)
 *   transcript: inspectSession() result,
 *   handoff_doc: 'HANDOFF.md'
 * }
 */
export function checkReceipts(receipts, observed) {
  const problems = [];
  // A bot session (C1): observed.bot = {tag, handoff_doc, dir, main_records}.
  const bot = observed && observed.bot ? observed.bot : null;
  const FIELDS = bot ? BOT_RECEIPT_FIELDS : RECEIPT_FIELDS;
  if (!receipts || typeof receipts !== 'object' || Array.isArray(receipts)) {
    return {
      supplied: false,
      problems: [
        'receipts not supplied - pass `receipts` with one entry per close step (' +
        Object.keys(FIELDS).join(', ') + '). Without them the close cannot be complete.'
      ]
    };
  }

  for (const field of Object.keys(FIELDS)) {
    if (receipts[field] === undefined || receipts[field] === null || receipts[field] === '') {
      problems.push(`receipt missing: ${field} - ${FIELDS[field]}`);
    }
  }

  const docs = new Map((observed.documents || []).map((d) => [d.doc_id, d]));

  // A bot session never names the main records: any
  // receipt that does is refused here, and those ids get no other check.
  const mainIds = bot ? (bot.main_records || []) : [];
  const isMain = (id) => mainIds.includes(id);
  if (bot) {
    const named = [
      ...(Array.isArray(receipts.working_docs) ? receipts.working_docs.map(receiptDocId) : []),
      typeof receipts.board_doc === 'string' ? receipts.board_doc : null,
      typeof receipts.handoff_doc === 'string' ? receipts.handoff_doc : null
    ].filter((id) => id && isMain(id));
    if (named.length) {
      problems.push(`receipts name ${[...new Set(named)].join(', ')} - ${hubRecordsMessage(bot.tag)}`);
    }
    if (typeof receipts.handoff_doc === 'string' && receipts.handoff_doc && !isMain(receipts.handoff_doc) &&
        receipts.handoff_doc !== bot.handoff_doc) {
      problems.push(`handoff_doc names ${receipts.handoff_doc}; this session's handoff is ${bot.handoff_doc}`);
    }
  }

  // 1. working documents
  if (receipts.working_docs !== undefined && !Array.isArray(receipts.working_docs)) {
    problems.push('receipt working_docs must be an array ([] if the session changed no working document)');
  } else if (Array.isArray(receipts.working_docs)) {
    for (const entry of receipts.working_docs) {
      const id = receiptDocId(entry);
      if (!id) { problems.push('receipt working_docs has an entry with no doc_id'); continue; }
      if (isMain(id)) continue; // refused above
      const d = docs.get(id);
      if (!d || !d.exists) problems.push(`working document ${id} does not exist in the store`);
      else if (!d.updated_this_session) problems.push(`working document ${id} was not updated this session`);
      else if (entry && typeof entry === 'object' && typeof entry.version === 'number' && entry.version !== d.version) {
        problems.push(`working document ${id}: receipt says v${entry.version}, store holds v${d.version}`);
      }
    }
  }

  // 2. episodic session record
  if (receipts.episodic_id !== undefined && receipts.episodic_id !== null) {
    if (!observed.episodic) {
      problems.push(observed.episodic_rejected
        ? `episodic entry ${receipts.episodic_id} was not accepted as this session's record - ${observed.episodic_rejected}`
        : `episodic entry ${receipts.episodic_id} was not found among this session's episodic entries`);
    }
  }

  // 3. board (a bot session's, if it keeps one, is under bots/<tag>/)
  if (bot && receipts.board_doc && !isMain(receipts.board_doc) && !String(receipts.board_doc).startsWith(bot.dir)) {
    problems.push(`board ${receipts.board_doc} is not under ${bot.dir} - a bot session's board, if it keeps one, is its own`);
  } else if (receipts.board_doc && !isMain(receipts.board_doc)) {
    const b = docs.get(receipts.board_doc);
    if (!b || !b.exists) problems.push(`board ${receipts.board_doc} does not exist in the store`);
    else {
      if (!b.updated_this_session) problems.push(`board ${receipts.board_doc} was not updated this session`);
      if (typeof receipts.board_version === 'number' && receipts.board_version !== b.version) {
        problems.push(`board ${receipts.board_doc}: receipt says v${receipts.board_version}, store holds v${b.version}`);
      }
    }
  }

  // 4. verbatim transcript, read back
  const t = observed.transcript || {};
  if (receipts.transcript_session_id && t.base_session_id &&
      baseSessionId(String(receipts.transcript_session_id)) !== t.base_session_id) {
    problems.push(`transcript receipt names ${receipts.transcript_session_id}, but the session checked is ${t.base_session_id}`);
  }
  if (t.present === true) {
    const storedParts = t.split ? (t.parts_found || []) : [t.session_id];
    if (Array.isArray(receipts.transcript_parts)) {
      const claimed = [...new Set(receipts.transcript_parts.map(String))].sort();
      const actual = [...new Set(storedParts.map(String))].sort();
      if (claimed.join('|') !== actual.join('|')) {
        problems.push(`transcript parts: receipt lists [${claimed.join(', ')}], store holds [${actual.join(', ')}] - read them back with query_transcripts`);
      }
    } else if (receipts.transcript_parts !== undefined) {
      problems.push('receipt transcript_parts must be an array of part ids');
    }
    const highest = typeof t.highest_exchange_index === 'number' ? t.highest_exchange_index : t.last_index;
    if (typeof receipts.transcript_exchanges === 'number' && receipts.transcript_exchanges !== highest) {
      problems.push(`transcript exchanges: receipt says ${receipts.transcript_exchanges}, store holds ${highest}`);
    }
  }

  // 5. handoff, written last
  const h = docs.get(observed.handoff_doc);
  if (typeof receipts.handoff_version === 'number' && h && h.exists) {
    if (receipts.handoff_version !== h.version) {
      problems.push(`handoff: receipt says v${receipts.handoff_version}, store holds v${h.version}`);
    }
    const hMs = toMillis(h.updated_at);
    if (hMs !== null) {
      const later = [];
      const others = [
        ...(Array.isArray(receipts.working_docs) ? receipts.working_docs.map(receiptDocId) : []),
        receipts.board_doc
      ].filter((id) => id && id !== observed.handoff_doc);
      for (const id of new Set(others)) {
        const d = docs.get(id);
        const ms = d ? toMillis(d.updated_at) : null;
        if (ms !== null && ms > hMs) later.push(id);
      }
      if (observed.episodic && observed.episodic.timestamp_ms > hMs) later.push(`episodic ${receipts.episodic_id}`);
      if (later.length) {
        problems.push(`handoff was not the last write - written after it: ${later.join(', ')}. Rewrite the handoff last.`);
      }
    }
  }

  return { supplied: true, problems };
}

/**
 * The lines the host must say, in order. Built from the check, not from the
 * host's recollection, so the wrap speech cannot drop a step the store shows.
 */
export function buildSpeak({ state, documents = [], receipts, episodic, transcript, handoff_doc, board_doc, bot = null }) {
  const byId = new Map(documents.map((d) => [d.doc_id, d]));
  const fmt = (id) => {
    const d = byId.get(id);
    return d && d.exists ? `${id} v${d.version}` : `${id} (not found)`;
  };
  const working = receipts && Array.isArray(receipts.working_docs) ? receipts.working_docs.map(receiptDocId).filter(Boolean) : null;
  const t = transcript || {};
  const parts = t.present === true ? (t.split ? t.parts_found : [t.session_id]) : [];
  const highest = typeof t.highest_exchange_index === 'number' ? t.highest_exchange_index : t.last_index;
  return [
    `Working documents: ${working === null ? 'no receipt' : (working.length ? working.map(fmt).join(', ') : 'none changed this session')}`,
    `Session record: ${episodic ? `episodic ${episodic.id}` : 'not found'}`,
    `Board: ${board_doc ? fmt(board_doc) : (bot ? 'none (a bot session keeps no main board)' : 'no receipt')}`,
    `Transcript: ${t.present === true
      ? `${parts.join(', ')} - ${highest} exchanges, intact ${t.intact ? 'yes' : 'no'}, read back from MongoDB collection transcripts`
      : 'not found in MongoDB'}`,
    `Handoff: ${fmt(handoff_doc)}`,
    `Close state: ${state}`
  ];
}

/**
 * Check which end-of-session artifacts exist.
 *
 * @param {object}  options
 * @param {string}  options.session_id     Transcript id to look for. Without it the
 *                                         transcript check reports unknown rather
 *                                         than passing.
 * @param {number}  options.session_start  Unix seconds. Defaults to 12h ago.
 * @param {string[]} options.thread_docs   Additional document ids that should have
 *                                         been updated this session.
 */
/** The source tag the close itself was given (`source`), trimmed; null when none. */
export function closeSourceOf(options = {}) {
  const s = options && typeof options.source === 'string' ? options.source.trim() : '';
  return s || null;
}

/** Whether a tag passes the source registry, as the write path reads it: any tag when none is configured. */
export function isRegisteredSource(tag, registry = []) {
  if (!registry.length) return true;
  return registry.includes(tag);
}

const SESSION_TAGS_NAMED = 4; // the session's tags named in a warning at most

/**
 * The close's attribution warning. The close warns and never refuses (as a
 * layer write marks source_unregistered and is still saved). The tag it judges
 * is the `source` passed on the close, else the server's default tag. Only a
 * registered tag that is one of the tags that wrote this session's transcript
 * is attributed; anything else gets a warning that says why. A tag is echoed
 * capped at whole characters (echoId).
 *   passedSource  the close's `source`, trimmed (closeSourceOf), or null
 *   configuredTag EMET_SOURCE_TAG, or null
 *   registry      EMET_SOURCE_TAGS as a list ([] = none configured)
 *   sessionTags   the tags on this session's transcript parts ([] = not read)
 */
export function sourceTagWarning(passedSource, configuredTag, { registry = [], sessionTags = [] } = {}) {
  const tag = passedSource || configuredTag || null;
  if (!tag) {
    return 'No source tag was passed on this close and this server has no default tag, so the close ' +
      'cannot be attributed. Pass your host\'s tag as `source` on the close and on your writes, and ' +
      'register it in EMET_SOURCE_TAGS. Leave EMET_SOURCE_TAG unset on a server several hosts share; ' +
      'set it only on a server one host uses.';
  }
  const what = passedSource ? `The close's source "${echoId(tag)}"` : `This server's default tag "${echoId(tag)}" (no source was passed on the close)`;
  const problems = [];
  if (!isRegisteredSource(tag, registry)) problems.push('is not registered in EMET_SOURCE_TAGS');
  if (!sessionTags.length) {
    problems.push('could not be matched to a tag that wrote this session, because no transcript of this session was read');
  } else if (!sessionTags.includes(tag)) {
    const named = sessionTags.slice(0, SESSION_TAGS_NAMED).map((t) => `"${echoId(t)}"`).join(', ');
    const more = sessionTags.length > SESSION_TAGS_NAMED ? ` +${sessionTags.length - SESSION_TAGS_NAMED} more` : '';
    problems.push(`is not among the tags that wrote this session (${named}${more})`);
  }
  if (!problems.length) return null;
  return `${what} ${problems.join(', and ')}, so the close is not attributed to it. Pass as \`source\` the ` +
    'registered tag this session was written under. The close itself is not refused.';
}

export async function sessionClose(options = {}) {
  const nowMs = Date.now();
  const startMs = options.session_start
    ? toMillis(options.session_start)
    : nowMs - DEFAULT_WINDOW_HOURS * 3600 * 1000;

  const window = {
    from: new Date(startMs).toISOString(),
    to: new Date(nowMs).toISOString(),
    inferred: !options.session_start,
    note: options.session_start
      ? undefined
      : `No session_start given, so a ${DEFAULT_WINDOW_HOURS}h window was assumed. Pass session_start for an exact answer.`
  };

  let client;
  try {
    const conn = await connect();
    client = conn.client;
    // Baselines are bookkeeping on the document row, not a new revision.
    // A writeDoc here would archive a revision that changed nothing the user wrote.
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const oldClosed = await conn.db.collection(`${COLLECTION_PREFIX}sessions`)
      .find({ closed: true, closed_at: { $lt: cutoff } }, { projection: { _id: 1 } })
      .toArray();
    const idleOpen = await conn.db.collection(`${COLLECTION_PREFIX}sessions`)
      .find({ closed: { $ne: true }, updated_at: { $lt: cutoff } }, { projection: { _id: 1 } })
      .toArray();
    const liveRows = await conn.db.collection(`${COLLECTION_PREFIX}sessions`)
      .find({ closed: { $ne: true }, updated_at: { $gte: cutoff } }, { projection: { _id: 1 } })
      .toArray();
    const live = new Set(liveRows.map((s) => s && s._id).filter((id) => typeof id === 'string' && id));
    if (options.session_id) live.add(String(options.session_id).replace(/_verbatim_part\d+$/, ''));
    const stale = [...oldClosed, ...idleOpen].map((row) => row && row._id).filter((id) => typeof id === 'string' && id && !id.includes('.') && !id.includes('$') && !live.has(id));
    if (stale.length) {
      const unset = {};
      for (const id of stale) unset['size_baselines.' + id] = '';
      const or = stale.map((id) => ({ ['size_baselines.' + id]: { $exists: true } }));
      await conn.db.collection(DOCS_COLLECTION).updateMany({ $or: or }, { $unset: unset });
    }
    const docs = conn.db.collection(DOCS_COLLECTION);

    // --- transcript -------------------------------------------------------
    const receipts = parseReceipts(options.receipts);
    const sessionId = options.session_id || (receipts && receipts.transcript_session_id) || null;
    let transcript;
    let corroboration = null;
    if (sessionId) {
      transcript = await inspectSession(
        conn.db.collection(TRANSCRIPTS_COLLECTION),
        sessionId
      );
      corroboration = await corroborateCoverage(conn.db, transcript.base_session_id || sessionId);
    } else {
      const recent = await conn.db
        .collection(TRANSCRIPTS_COLLECTION)
        .find({}, { projection: { session_id: 1, session_start: 1 } })
        .sort({ session_start: -1 })
        .limit(3)
        .toArray();
      transcript = {
        present: null,
        reason: 'No session_id supplied, so no transcript could be checked.',
        most_recent_session_ids: recent.map((r) => r.session_id)
      };
    }

    // --- whose session (C1, 2026-10-01) -----------------------------------
    // The session's tag is the source tag on its transcript. A tag with a
    // bots/<tag>/HANDOFF.md record is a bot: its close checks the bot's own
    // records and counts only that tag's revisions. With no such record, or a
    // transcript that cannot be read, the close is exactly the host close.
    let sessionTag = null;
    let sessionTags = [];
    if (transcript.present === true && transcript.base_session_id) {
      try {
        const rows = await conn.db
          .collection(TRANSCRIPTS_COLLECTION)
          .find({ session_id: { $regex: `^${escapeRegex(transcript.base_session_id)}(_.*)?$` } },
                { projection: { session_id: 1, channel: 1, superseded_by: 1 } })
          .toArray();
        ({ tag: sessionTag, tags: sessionTags } = sessionTagOf(rows));
      } catch { sessionTag = null; }
    }
    const bot = sessionTag && isBotTag(sessionTag)
      ? { tag: sessionTag, handoff_doc: botHandoffDoc(sessionTag), dir: botRecordDir(sessionTag), main_records: mainRecordIds() }
      : null;
    const sessionHandoff = bot ? bot.handoff_doc : handoffDoc();

    // --- continuity documents --------------------------------------------
    const receiptDocs = receipts
      ? [...(Array.isArray(receipts.working_docs) ? receipts.working_docs.map(receiptDocId) : []),
         typeof receipts.board_doc === 'string' ? receipts.board_doc : null].filter(Boolean)
      : [];
    // A bot session checks its own handoff and no board; the main records are
    // read separately below, only to see whether the bot revised them.
    const wanted = bot
      ? [...new Set([bot.handoff_doc, ...(options.thread_docs || []), ...receiptDocs])].filter((id) => !bot.main_records.includes(id))
      : [...new Set([handoffDoc(), stateDoc(), ...(options.thread_docs || []), ...receiptDocs])];
    const readDoc = async (docId) => {
      const found = await docs.findOne(
        { doc_id: docId },
        { projection: { doc_id: 1, version: 1, updated_at: 1, updated_by: 1, size: 1 } }
      );
      const updatedMs = found ? toMillis(found.updated_at) : null;
      return {
        doc_id: docId,
        exists: Boolean(found),
        version: found ? found.version : null,
        updated_at: found && found.updated_at ? new Date(updatedMs).toISOString() : null,
        updated_by: found ? found.updated_by || null : null,
        in_window: updatedMs !== null && updatedMs >= startMs
      };
    };
    const documents = [];
    const attributionWarnings = [];
    for (const docId of wanted) {
      const { in_window, ...d } = await readDoc(docId);
      if (bot) {
        // Revised this session = in the window AND by this session's tag.
        documents.push({ ...d, updated_this_session: in_window && d.updated_by === bot.tag, updated_in_window: in_window });
      } else {
        documents.push({ ...d, updated_this_session: in_window });
        // Host sessions keep today's verdict; what the full rule would no
        // longer count is reported (decision 2).
        if (in_window && sessionTag && d.updated_by !== sessionTag) {
          attributionWarnings.push(
            `${docId} was revised in the window by ${d.updated_by || '(no tag)'}, not by this session's tag ${sessionTag}; ` +
            'it is counted for now, and would not be under the full attribution rule.'
          );
        }
      }
    }
    const mainRecords = [];
    if (bot) {
      for (const docId of bot.main_records) {
        const { in_window, ...d } = await readDoc(docId);
        mainRecords.push({ ...d, revised_by_session_tag: in_window && d.updated_by === bot.tag });
      }
    }

    // --- episodic entries -------------------------------------------------
    const episodic = await conn.db
      .collection(`${COLLECTION_PREFIX}episodic`)
      .find(
        { timestamp: { $gte: startMs / 1000 } },
        { projection: { id: 1, timestamp: 1, importance: 1, metadata: 1 } }
      )
      .sort({ timestamp: -1 })
      .limit(10)
      .toArray();

    // The session record named by the receipt, looked up directly so a record
    // outside the newest ten is still found - and only if it falls in window.
    let receiptEpisodic = null;
    let episodicRejected = null;
    let receiptEpisodicSource = null;
    if (receipts && receipts.episodic_id !== undefined && receipts.episodic_id !== null) {
      const wantedId = Number(receipts.episodic_id);
      const row = Number.isFinite(wantedId)
        ? await conn.db.collection(`${COLLECTION_PREFIX}episodic`).findOne(
            { id: wantedId },
            { projection: bot || sessionTag
              ? { id: 1, timestamp: 1, metadata: 1, source_session_id: 1 }
              : { id: 1, timestamp: 1 } }
          )
        : null;
      const ms = row ? toMillis(row.timestamp) : null;
      if (row && ms !== null && ms >= startMs) {
        receiptEpisodicSource = parseMetadata(row.metadata).source || null;
        if (bot) {
          // A bot's session record is its own and cites this session.
          const cited = typeof row.source_session_id === 'string' && row.source_session_id ? row.source_session_id : null;
          if (receiptEpisodicSource !== bot.tag) {
            episodicRejected = `its metadata.source is ${receiptEpisodicSource || '(none)'}, not ${bot.tag}`;
          } else if (!cited) {
            episodicRejected = `it cites no session (derived_from); a bot's session record cites ${transcript.base_session_id}`;
          } else if (baseSessionId(cited) !== transcript.base_session_id) {
            episodicRejected = `it cites ${cited}, not this session ${transcript.base_session_id}`;
          } else {
            receiptEpisodic = { id: row.id, timestamp_ms: ms };
          }
        } else {
          receiptEpisodic = { id: row.id, timestamp_ms: ms };
        }
      }
    }

    // Source tags live in metadata - a subdocument since 2026-09-05, a JSON
    // string before that; parseMetadata reads either.
    const sourceTags = new Set();
    for (const entry of episodic) {
      const meta = parseMetadata(entry.metadata);
      if (meta.source) sourceTags.add(meta.source);
    }

    // Entries in the window written under this session's tag (C1). Read
    // without the ten-entry cap above, so a busy window cannot hide one.
    let ownEpisodicCount = null;
    if (bot || sessionTag) {
      const inWindow = await conn.db
        .collection(`${COLLECTION_PREFIX}episodic`)
        .find({ timestamp: { $gte: startMs / 1000 } }, { projection: { id: 1, metadata: 1 } })
        .toArray();
      ownEpisodicCount = inWindow.filter((e) => parseMetadata(e.metadata).source === sessionTag).length;
      if (!bot && episodic.length > 0 && ownEpisodicCount === 0) {
        attributionWarnings.push(
          `no episodic entry in the window was written under this session's tag ${sessionTag}; the entries counted are other tags' ` +
          '(counted for now, not under the full attribution rule).'
        );
      }
      if (!bot && receiptEpisodic && receiptEpisodicSource !== sessionTag) {
        attributionWarnings.push(
          `episodic entry ${receiptEpisodic.id} was written under ${receiptEpisodicSource || '(no tag)'}, not this session's tag ${sessionTag}; ` +
          'it is accepted for now, and would not be under the full attribution rule.'
        );
      }
    }

    // --- verdict ----------------------------------------------------------
    const missing = [];
    if (transcript.present === false) missing.push('transcript was never saved');
    if (transcript.present === true && !transcript.intact) {
      if (transcript.gaps && transcript.gaps.length) {
        // Named individually: "which exchanges are missing" is the only form of
        // this answer the user can act on.
        for (const gap of transcript.gaps) missing.push(`transcript is incomplete - ${gap}`);
      } else {
        missing.push('transcript is present but does not verify');
      }
    }
    if (transcript.present === null) missing.push('transcript unverified (no session_id supplied)');

    // The tail check. A transcript that stops short of an exchange some layer
    // entry already cited is missing exchanges, and neither record had to
    // declare anything for that to be provable.
    let uncorroborated = false;
    if (corroboration && transcript.present === true) {
      const saved = typeof transcript.highest_exchange_index === 'number'
        ? transcript.highest_exchange_index
        : (typeof transcript.last_index === 'number' ? transcript.last_index : transcript.exchanges_stored);
      const cited = corroboration.highest_exchange_cited;
      if (typeof cited === 'number' && typeof saved === 'number' && cited > saved) {
        missing.push(
          `transcript stops at exchange ${saved}, but a layer entry written during this session cites ` +
          `exchange ${cited} - exchanges ${saved + 1}-${cited} were never saved`
        );
      } else if (corroboration.citing_entries === 0) {
        uncorroborated = true;
      }
    }
    for (const d of documents) {
      if (!d.exists) missing.push(`${d.doc_id} does not exist`);
      else if (bot && !d.updated_this_session && d.updated_in_window) {
        missing.push(`${d.doc_id} was not updated this session by ${bot.tag} - its revision in the window is by ${d.updated_by || '(no tag)'}`);
      } else if (!d.updated_this_session) missing.push(`${d.doc_id} was not updated this session`);
    }
    if (bot) {
      for (const m of mainRecords) {
        if (m.revised_by_session_tag) missing.push(`${m.doc_id} was revised by ${bot.tag} this session - ${hubRecordsMessage(bot.tag)}`);
      }
      if (ownEpisodicCount === 0) missing.push(`no episodic entry was written this session under ${bot.tag}`);
    } else if (episodic.length === 0) missing.push('no episodic entry was written this session');

    const configuredTag = setting('SOURCE_TAG') || null;
    const passedSource = closeSourceOf(options);
    const warnings = [];
    const tagWarning = sourceTagWarning(passedSource, configuredTag, {
      registry: String(setting('SOURCE_TAGS') ?? '').split(',').map((s) => s.trim()).filter(Boolean),
      sessionTags
    });
    if (tagWarning) warnings.push(tagWarning);
    if (window.inferred) warnings.push(window.note);
    if (!receipts && options.receipts !== undefined && options.receipts !== null) {
      warnings.push(`receipts arrived as ${typeof options.receipts} and could not be read as an object; pass an object or JSON text.`);
    }
    const mixedBotTags = !sessionTag && sessionTags.length > 1 ? sessionTags.filter((t) => isBotTag(t)) : [];
    if (mixedBotTags.length) {
      missing.push(`the transcript's parts carry more than one source tag (${sessionTags.join(', ')}), including bot tag ${mixedBotTags.join(', ')}; ` +
        'a session has one tag, and a bot session closes only under its own - supersede the stray part under the session\'s tag, then close again.');
    }
    const droppedMain = bot && Array.isArray(options.thread_docs) ? options.thread_docs.filter((id) => bot.main_records.includes(id)) : [];
    if (droppedMain.length) {
      warnings.push(`thread_docs named ${droppedMain.join(', ')}; ${hubRecordsMessage(bot.tag)}, so they were not checked.`);
    }

    // Store-level gaps make the session incomplete. Receipt problems, and a
    // transcript nothing independently corroborates, BLOCK it (the owner 2026-09-26,
    // A decision record: receipts required from the first deploy; the former
    // `unconfirmed` state is blocked, not passed).
    const storeMissing = [...missing];
    const receiptCheck = checkReceipts(receipts, {
      documents,
      episodic: receiptEpisodic,
      episodic_rejected: episodicRejected,
      transcript,
      handoff_doc: sessionHandoff,
      ...(bot ? { bot } : {})
    });
    for (const p of receiptCheck.problems) missing.push(p);
    if (uncorroborated) {
      missing.push(
        'transcript coverage is uncorroborated - no layer entry written this session cites the transcript. ' +
        'Save the episodic session record (or another entry) with derived_from {session_id, exchange_start, exchange_end}.'
      );
    }

    const computed = storeMissing.length > 0 ? 'incomplete' : (missing.length > 0 ? 'blocked' : 'complete');

    // Build 2 (2026-09-27): cap blocked closes at three, then escalate. The
    // counter is keyed to the base session id and never resets on a changed
    // receipt (the user's ruling): three blocked closes means the wrap plan is
    // wrong, and the loop cannot see the plan. A close that would be complete
    // is never refused. Counting is skipped when no session id is known - a
    // counter with no key would merge every session into one.
    const baseId = transcript && transcript.base_session_id ? transcript.base_session_id : null;
    let priorBlocked = 0;
    const attempts = conn.db.collection(CLOSE_ATTEMPTS_COLLECTION);
    if (baseId) {
      const row = await attempts.findOne({ base_session_id: baseId }, { projection: { blocked_count: 1 } });
      priorBlocked = row && typeof row.blocked_count === 'number' ? row.blocked_count : 0;
    }
    const capped = applyCloseCap(computed, priorBlocked);
    const state = capped.state;
    if (baseId && computed === 'blocked' && capped.blocked_count !== priorBlocked) {
      await attempts.updateOne(
        { base_session_id: baseId },
        { $set: { blocked_count: capped.blocked_count, last_state: state, updated_at: new Date() },
          $setOnInsert: { created_at: new Date() } },
        { upsert: true }
      );
    }
    const scoped = missing.map((m) => ({ missing: m, scope: scopeFor(m) }));

    const speak = buildSpeak({
      state,
      documents,
      receipts,
      episodic: receiptEpisodic,
      transcript,
      handoff_doc: sessionHandoff,
      board_doc: receipts && typeof receipts.board_doc === 'string' ? receipts.board_doc : null,
      bot
    });

    if (state === 'escalate') speak.push(...escalateSpeak(missing));

    return {
      state,
      speak,
      close_attempts: { blocked_count: capped.blocked_count, cap: CLOSE_CAP, escalated: state === 'escalate' },
      scope: scoped,
      window,
      checked: {
        transcript,
        transcript_corroboration: corroboration,
        documents,
        episodic_entries_this_session: episodic.length,
        episodic_ids: episodic.map((e) => e.id),
        receipts_supplied: receiptCheck.supplied,
        receipt_problems: receiptCheck.problems,
        source_tags_seen: [...sourceTags],
        configured_source_tag: configuredTag,
        close_source: passedSource === null ? null : echoId(passedSource),
        ...(bot ? {
          session_records: {
            kind: 'bot',
            tag: bot.tag,
            handoff_doc: bot.handoff_doc,
            board_required: false,
            main_records: mainRecords,
            episodic_entries_by_tag: ownEpisodicCount,
            note: `${hubRecordsMessage(bot.tag)}. Only ${bot.tag}'s own revisions in the window count. ` +
              'No board is required (step 3 of `protocol` does not apply); a bot board, if kept, is listed under ' +
              `${bot.dir}. Receipts: ${Object.keys(BOT_RECEIPT_FIELDS).join(', ')}.`
          }
        } : {})
      },
      missing,
      warnings,
      ...(attributionWarnings.length ? { attribution_warnings: attributionWarnings } : {}),
      protocol: CLOSE_PROTOCOL,
      receipt_fields: bot ? BOT_RECEIPT_FIELDS : RECEIPT_FIELDS,
      instructions:
        'Say every line of `speak` to the user, in order, as given. A wrap that leaves out `speak` is a failed ' +
        'close even when the state is complete. ' +
        (state === 'complete'
          ? 'Every step has a receipt that matches the store, the handoff was written last, and the transcript ' +
            'is corroborated. After `speak`, tell the user the session is saved, in one line. Do not recite the rest of this payload.'
          : state === 'escalate'
          ? `The session is NOT saved, and this session has now had ${CLOSE_CAP} blocked closes. STOP retrying. ` +
            'Say the `speak` lines, including the list, and wait for the user\'s word. The counter does not reset ' +
            'on a changed receipt; a close that would be complete is still accepted if the user directs the fix. ' +
            'Each line of `missing` has a `scope` in `scope`: touch only what it names.'
          : state === 'blocked'
          ? 'The session is NOT saved. The store holds the artifacts, but the close is BLOCKED: a receipt is ' +
            'missing or disagrees with the store, the handoff was not the last write, or the transcript is not ' +
            'corroborated. Fix each line of `missing` - read the transcript back with query_transcripts, read ' +
            'back the session record, rewrite the handoff last - then call emet_session_close again with ' +
            'corrected `receipts`. Each line of `missing` has a `scope` in `scope`: touch only what it names. ' +
            `Blocked closes are capped at ${CLOSE_CAP} per session; the ${CLOSE_CAP}rd returns "escalate". ` +
            'Do not tell the user the session is saved until a call returns "complete".'
          : 'The session is NOT saved. Work through `missing` now, in the order given by `protocol`, ' +
            'using the tools each step names. The order is stated once, in `protocol`. Then call ' +
            'emet_session_close again with `receipts`. Do not tell the user the session is saved until a ' +
            'call returns "complete". If something genuinely cannot be written, say which artifact is ' +
            'missing and why - an undisclosed gap is worse than a disclosed one.')
    };
  } finally {
    if (client) await client.close();
  }
}

export default { sessionClose, CLOSE_PROTOCOL, RECEIPT_FIELDS, BOT_RECEIPT_FIELDS, checkReceipts, buildSpeak, sessionTagOf, hubRecordsMessage };
