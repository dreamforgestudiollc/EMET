/**
 * EMET - Enduring Memory & Epistemic Tiers
 * Copyright (c) 2026 Dreamforge Studio LLC
 *
 * Licensed under the MIT License - see LICENSE
 *
 * Tool dispatch - ONE table, both transports.
 *
 * Until 2026-09-27 index.js (stdio) and http-remote.js (HTTP) each carried a
 * full switch mapping tool name to handler. dispatch.test.js compared the two
 * by case NAME and caught one class of drift (the session_id alias divergence,
 * an earlier fix); it could not see argument drift, and the code audit of
 * 2026-09-27 found one - setupComplete received the logger on stdio and not on
 * HTTP. A rule stated twice drifts; this file is the one statement.
 *
 * Each transport keeps its own CallToolRequestSchema handler (rate limit,
 * actor, audit line) and routes here for the scope check and the call.
 */

import { EmetError, ErrorCodes, StatusCodes } from './database.js';
import { ValidationError } from './validation.js';
import { registeredSourceTags } from './setup.js';
import { echoId } from './session-graph.js';
import { currentActor } from './persons.js';
import {
  initialize, setupStatus, setupComplete, verifyConnection, sessionClose, findGaps, readFloor,
  handleError, createSuccessResponse,
  saveMemory, reviseMemory, recallMemories, semanticRecall, corpusRecall, queryLayer, getStatus,
  queryTranscripts, reviseTranscript, saveTranscript, sessionOpen, transcriptAppend,
  readDoc, READ_DOC_PAGE_DEFAULT, readDocHistory, writeDoc, validateDoc, acceptNonconformance,
  listDocs, retireDoc, renameDoc, restoreDoc, patchDoc, inviteCreate, memberAccessCreate,
  resolvedSourceTag
} from './tools.js';

/**
 * Route one tool call. `ctx` carries what the transport owns: dbManager, logger,
 * AuditOperation. Never throws: returns a success envelope or handleError's
 * isError envelope, so the transport's audit line always has an outcome.
 */
/**
 * The source tag under one name. `source` is the name on every write (the owner,
 * 2026-09-27, code audit 1.5c); the older per-tool names - updated_by,
 * retired_by, accepted_by on documents, channel on transcripts - are read as
 * aliases for one release and then dropped. metadata.source on the layers is
 * already `source`.
 */
export function sourceOf(args) {
  // Over HTTP a tag bound at approval wins, and a caller-supplied source is
  // never trusted. A token with no bound tag (issued before tags were stored)
  // may use the caller's tag only when it is an exact member of EMET_SOURCE_TAGS.
  // Stdio still reads the argument, and requireRegisteredSource checks the registry.
  const caller = args.source ?? args.updated_by ?? args.retired_by ?? args.accepted_by ?? args.channel ?? null;
  return resolvedSourceTag(caller).tag;
}

/**
 * A transcript write names a registered host or is refused (the owner, 2026-09-27,
 * code audit 1.5d: nine spellings for five hosts in the store). Registered =
 * EMET_SOURCE_TAGS, exact membership only. With no registry configured, any
 * non-empty tag passes. A refusal does not publish the registry.
 * Historical rows stand as written. `allowNull` is for revise_transcript,
 * where a missing tag means "the parent's".
 */
export const SOURCE_LIST_MAX = 8;      // registered tags named in a refusal at most; the rest as "+N more"
export const SOURCE_LIST_CHARS = 150;  // and no more characters of tags than this
export const LISTED_TAG_MAX = 24; // characters of each listed tag
// Cut on whole characters (code points), never inside a surrogate pair.
const capTo = (s, n) => { const cps = Array.from(String(s)); return cps.length > n ? `${cps.slice(0, n).join('')}\u2026` : String(s); };
/** The registered tags as a refusal names them: the first 8 (fewer if long), then "+N more", so it stays under the 500-character cap. */
export function sourceTagList(registry = registeredSourceTags()) {
  const shown = [];
  for (const t of registry.slice(0, SOURCE_LIST_MAX)) {
    const next = [...shown, capTo(t, LISTED_TAG_MAX)];
    if (shown.length && next.join(', ').length > SOURCE_LIST_CHARS) break;
    shown.push(next[next.length - 1]);
  }
  const more = registry.length - shown.length;
  return more > 0 ? `${shown.join(', ')} +${more} more` : shown.join(', ');
}

export function requireRegisteredSource(tag, tool, allowNull = false) {
  // Each refusal leads with what to pass. The registry is not published, and
  // the caller's tag is echoed capped (echoId), so the instruction fits the
  // 500-character error-message cap. Only an exact EMET_SOURCE_TAGS member counts.
  if (tag === null || tag === undefined || tag === '') {
    if (allowNull) return null;
    const reg = registeredSourceTags();
    throw new ValidationError('source', reg.length
      ? `${tool}: pass "source" set to the registered tag of the host this write comes from. A new host adopts one in bootstrap/INSTALL.md first. No source tag was given and one is required, so nothing was written.`
      : `${tool}: pass "source" set to the tag of the host this write comes from. No tags are registered on this server, so any non-empty tag passes: use the one bootstrap/INSTALL.md gives this host. No source tag was given and one is required, so nothing was written.`);
  }
  const registry = registeredSourceTags();
  if (registry.length && !registry.includes(tag)) {
    throw new ValidationError('source', `${tool}: pass "source" set to a registered tag. A new host adopts one in bootstrap/INSTALL.md first. Source tag "${echoId(tag)}" is not registered, so nothing was written.`);
  }
  return tag;
}

export async function dispatchTool(name, args, ctx) {
  const { dbManager, logger, AuditOperation } = ctx;
  args = args || {};
  // The clock for the date-dependent rules (session ids, the closing-exchange
  // window). Transports never set it; the suites pin it.
  const now = ctx.now instanceof Date ? ctx.now : new Date();
  let grace = null; // a claimed closing exchange, released if the write then fails
  try {
    const actor = currentActor();
    const { scopesAllow, deniedMessage } = await import('./scopes.js');
    const { scopes } = actor;
    if (!scopesAllow(scopes, name, { http: actor.transport === 'http', authenticated: actor.authenticated === true, args })) {
      throw new EmetError(deniedMessage(name, scopes, args), ErrorCodes.VALIDATION_ERROR, StatusCodes.BAD_REQUEST);
    }
    // The session graph (2026-09-29): the monorail (docs/GUARDRAILS-AND-MONORAILS.md). State is read BEFORE a
    // governed write; the write's result carries `session_graph` with the next
    // step; the step is recorded after it succeeds. Enforce only (2026-10-03):
    // a skipped step is refused before anything is written. A governed write
    // that names a session fails closed when the graph cannot be read.
    const sg = await import('./session-graph.js');
    // The exchange number, normalized ONCE, before the graph, the closed-session
    // guard and the tool all read it (2026-10-01, the second reader's blocker on an earlier draft: the
    // guard read "4" as 4, the tool did not, so a text "4" was a retry to one and
    // a new exchange to the other). A whole number, or its text, or absent.
    if (name === 'emet_transcript_append') {
      const { value, error } = sg.normalizeExchangeNumber(args.exchange_index);
      if (error) throw new ValidationError('exchange_index', `${error}. Nothing was written.`);
      args = { ...args };
      if (value === null) delete args.exchange_index; else args.exchange_index = value;
    }
    let graph = null;
    // emet_session_open passes the startup_pages gate (2026-10-03).
    if (sg.GRAPH_WRITE_TOOLS.has(name) || name === sg.STARTUP_PAGES_TOOL) {
      try {
        graph = await sg.graphBefore(name, args, dbManager, now);
      } catch (e) {
        if (e instanceof ValidationError) { // a refusal: logged to the lab, then thrown
          sg.labRecord(name, args, e.graph || null, dbManager, logger);
          throw e;
        }
        // A governed write that names a session fails closed on any graph
        // error. An unreadable session is not a reason to edit the board.
        if (sg.GRAPH_WRITE_TOOLS.has(name) && sg.sessionOf(args)) {
          const closed = new ValidationError('session', `session graph unavailable: ${e && e.message}. Nothing was written.`);
          closed.graph = { mode: sg.graphMode(), decision: { verdict: 'refuse', gate: 'unavailable', reason: closed.message, next: null } };
          sg.labRecord(name, args, closed.graph, dbManager, logger);
          throw closed;
        }
        graph = { mode: sg.graphMode(), decision: { verdict: 'unknown', gate: null, reason: `session graph unavailable: ${e && e.message}`, next: null } };
      }
    }
    // A session recorded as closed takes no new exchanges, except its one
    // closing exchange inside the grace window; a correction keeps exactly the
    // exchange numbers its part holds (2026-10-01). Throws before the tool runs,
    // so nothing is written.
    try {
      grace = await sg.closedSessionGuard(name, args, dbManager, now, logger);
    } catch (e) {
      // The lab row says what really happened: refused by the closed guard.
      if (graph && graph.decision) {
        graph = { ...graph,
          decision: { ...graph.decision, verdict: 'refuse', gate: 'closed', reason: e && e.message ? e.message : graph.decision.reason } };
      }
      if (graph) sg.labRecord(name, args, graph, dbManager, logger);
      throw e;
    }
    // emet_session_open's lab row (verdict unknown only: a refusal was recorded
    // above) is written only after the open succeeds (in ok, below).
    if (graph && name !== sg.STARTUP_PAGES_TOOL) sg.labRecord(name, args, graph, dbManager, logger); // lab results: every check, timestamped, never awaited
    // The closing exchange: numbered highest+1 and written into the session's
    // last live part, exactly - never where the caller pointed.
    if (grace && grace.grace) args = { ...args, session_id: grace.part, exchange_index: grace.index };
    // A correction of a closed session: the exchanges with their numbers normalized.
    if (grace && grace.revise) { args = { ...args, exchanges: grace.exchanges }; grace = null; }
    // A retry of the saved closing exchange is answered here; the tool is NOT
    // called, so nothing can be written (the second reader's blocker on an earlier draft).
    if (grace && grace.retry) {
      const block = sg.graphBlock(graph);
      return createSuccessResponse({
        session_id: grace.base, exchange_index: grace.index, already_present: true, written: false,
        closing_exchange: { accepted: true, session: grace.base, exchange_index: grace.index, locked: true, already_saved: true, notice: grace.notice },
        ...(block ? { session_graph: block } : {})
      }, name);
    }
    const ok = (data) => {
      const block = sg.graphBlock(graph);
      if (block && data && typeof data === 'object' && !Array.isArray(data)) data.session_graph = block;
      if (name === sg.STARTUP_PAGES_TOOL && graph) sg.labRecord(name, args, graph, dbManager, logger); // the open succeeded
      if (name === 'emet_session_open' && data && typeof data === 'object') {
        data.session_graph = { mode: sg.graphMode(), verdict: 'ok', next: sg.nextStep({ opened: true }, 0) };
      }
      if (grace && data && typeof data === 'object' && !Array.isArray(data)) {
        if (grace.grace && data.already_present) {
          sg.markCloseGrace(grace.base, dbManager, { release: true }).catch(() => {}); // nothing was written: the window is not spent
        } else {
          data.closing_exchange = { accepted: true, session: grace.base, exchange_index: grace.index, locked: true, notice: grace.notice };
        }
      }
      if (name === 'emet_session_close' && graph) return recordClose(data);
      if (graph || name === 'emet_session_open') {
        sg.graphAfter(name, args, data, dbManager, logger, now); // never throws; not awaited
      }
      return createSuccessResponse(data, name);
    };
    // The close's state write is awaited (the second reader's nit 6), so an append sent after
    // the close returns already finds the session closed - when the write
    // succeeds. A failed write is retried once; if it still fails the reply
    // says so (closed_recorded: false, with a warning) instead of reading as a
    // locked session (2026-10-01, the second reader's nit 2 on an earlier draft, the reviewer's
    // condition 2). Every other step is recorded without holding up the reply.
    const recordClose = async (data) => {
      let rec = await sg.graphAfter(name, args, data, dbManager, logger, now);
      if (rec && rec.recorded === false) rec = await sg.graphAfter(name, args, data, dbManager, logger, now);
      if (rec && data && typeof data === 'object' && !Array.isArray(data)) {
        data.closed_recorded = rec.recorded;
        if (!rec.recorded) {
          const warning = `The close checked ${data.state}, but the server could not record session ${rec.base} as closed ` +
            `(tried twice: ${rec.error}). Until it is recorded the session is NOT locked: a later transcript write could still ` +
            'land in it, and emet_session_open could hand its id out again. Call emet_session_close again with the same ' +
            'receipts to record it, and tell the user the session lock was not recorded.';
          data.closed_record_warning = warning;
          data.warnings = [...(Array.isArray(data.warnings) ? data.warnings : []), warning];
          if (typeof data.instructions === 'string') data.instructions = `${data.instructions} ${warning}`;
        }
      }
      return createSuccessResponse(data, name);
    };
    switch (name) {
      case 'emet_initialize':        return ok(await initialize(args, { onLate: (late) => sg.recordLatePages(late, dbManager, logger) }));
      case 'emet_setup_complete':    return ok(await setupComplete(args.answers || {}, logger, { reissue: args.reissue === true, source: sourceOf(args) }));
      case 'emet_session_close':     return await ok(await sessionClose(args));
      case 'emet_gaps':              return ok(await findGaps(args));
      case 'emet_floor':             return ok(readFloor(args));
      case 'recall':                 return ok(await recallMemories(dbManager, args.query, args.layer || null, args.limit || 10, logger, AuditOperation, { history: args.history === true, order: args.order }));
      case 'query_layer':            return ok(await queryLayer(dbManager, args.layer, args.options || {}, logger, AuditOperation));
      case 'emet_status': {
        // One diagnostic (2026-09-27, the owner: one tool with several functions over
        // several overlapping ones). setupStatus + the per-layer counts, and the
        // write-path probe on request.
        const status = await setupStatus();
        if (status.reachable) {
          const layers = await getStatus(dbManager, logger);
          status.layers = layers.layers; status.total_memories = layers.total_memories; status.health = layers.health;
        }
        if (args.probe === true) status.probe = await verifyConnection();
        return ok(status);
      }
      case 'save_to_layer':          return ok(await saveMemory(dbManager, args.content, args.layer, args.metadata || {}, logger, AuditOperation, { session_id: args.session_id }));
      case 'revise_memory':          return ok(await reviseMemory(dbManager, args.layer, args.target_id, args.content, args.metadata || {}, logger));
      case 'query_transcripts':      return ok(await queryTranscripts(args.timestamp_start, args.timestamp_end, args.session_id || null, args.limit || 50, logger));
      case 'revise_transcript':      return ok(await reviseTranscript(args.session_id, args.exchanges, args.reason, args.session_start || null, args.session_end || null, requireRegisteredSource(sourceOf(args), name, true), logger));
      case 'save_transcript':        return ok(await saveTranscript(args.session_id, args.session_start, args.session_end || null, args.exchanges || null, requireRegisteredSource(sourceOf(args), name), logger));
      case 'emet_session_open':      return ok(await sessionOpen(args, logger, dbManager, now));
      case 'emet_transcript_append': return ok(await transcriptAppend({ ...args, channel: requireRegisteredSource(sourceOf(args), name) }, logger));
      case 'read_doc':               return ok(await readDoc(args.doc_id, logger, { offset: args.offset ?? 0, limit: args.limit ?? READ_DOC_PAGE_DEFAULT, expected_version: args.expected_version, expected_sha256: args.expected_sha256 }));
      case 'read_doc_history':       return ok(await readDocHistory(args.doc_id, args.version ?? null, logger));
      case 'write_doc':              return ok(await writeDoc(args.doc_id, args.content, sourceOf(args), null, logger, { supersedes: args.supersedes ?? null, reason: args.reason || null, session_id: args.session_id || null }));
      case 'list_docs':              return ok(await listDocs(args.prefix || null, logger, args.include_retired === true));
      case 'retire_doc':             return ok(await retireDoc(args.doc_id, args.reason || null, sourceOf(args), logger, { session_id: args.session_id || null }));
      case 'rename_doc':             return ok(await renameDoc(args.old_id, args.new_id, sourceOf(args), logger, args.reason || null, { session_id: args.session_id || null }));
      case 'restore_doc':            return ok(await restoreDoc(args.doc_id, args.version, sourceOf(args), logger, args.reason || null, { session_id: args.session_id || null }));
      case 'validate_doc':           return ok(await validateDoc({ doc_id: args.doc_id || null, content: args.content || null, template_id: args.template_id || null }, logger));
      case 'accept_nonconformance':  return ok(await acceptNonconformance(args.doc_id, args.reason, sourceOf(args), logger, { session_id: args.session_id || null }));
      case 'patch_doc':              return ok(await patchDoc(args.doc_id, args.old_str, args.new_str, sourceOf(args), args.expected_version ?? null, logger, { reason: args.reason || null, origin: args.origin || null, edits: args.edits || null, session_id: args.session_id || null }));
      case 'corpus_recall':          return ok(await corpusRecall(args.query, args.corpus || null, args.limit || 5, logger));
      case 'semantic_recall':        return ok(await semanticRecall(args.query, args.layer || null, args.limit || 10, logger, { history: args.history === true }, dbManager));
      case 'emet_invite_create':     return ok(await inviteCreate(dbManager, args, logger));
      case 'emet_member_access_create': return ok(await memberAccessCreate(dbManager, args, logger));
      default:
        throw new EmetError(`Unknown tool: ${name}`, ErrorCodes.UNKNOWN_TOOL, StatusCodes.BAD_REQUEST);
    }
  } catch (error) {
    if (grace && grace.grace) { // the claimed closing exchange was not written: give the window back
      try { const sg = await import('./session-graph.js'); await sg.markCloseGrace(grace.base, dbManager, { release: true }); }
      catch (e) { logger?.warn?.('closing exchange: claim not released', { error: e && e.message }); }
    }
    return handleError(error, name, logger);
  }
}

export default { dispatchTool };
