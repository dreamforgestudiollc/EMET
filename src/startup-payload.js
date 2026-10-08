/**
 * The startup payload's size and its abridged form (the host-aware startup
 * design, conservative variant chosen by the owner 2026-10-02).
 *
 * WHAT THIS FILE DOES AND DOES NOT DO (2026-10-03):
 *   - payloadForLayerCharter: the layer charter as the payload serves it, with
 *     the one exact duplicate removed. `importance_range` is the machine twin
 *     of the `importance` band and says the same thing (tests/layers.test.js
 *     pins them consistent), so the payload carries the band once. Every word
 *     of the charter prose stays; LAYER_CHARTER itself is unchanged.
 *   - abridgeReadyPayload: builds the conservative abridged payload from a
 *     full ready payload. It is NOT reachable from any host. No tool argument
 *     selects it: the amendment says the server decides the mode and the model
 *     does not, and a host can never ask for less than the server allows. The
 *     server can only prove a returning host with the startup receipts of
 *     stage 2 of the design, which do not exist yet, so emet_initialize serves
 *     the full payload to every caller. This function is the tested builder
 *     stage 2's mode check will call, and the measure of what abridging saves.
 *   - resultSize: the size of a payload as the host receives it, in characters
 *     and UTF-8 bytes (the connector gateway cuts at 20,000 bytes).
 *
 * FIDELITY RULE (the owner's startup rules): the floor, identity, character, user, the close
 * protocol and tools in force are never pointers and never shortened here.
 * Only install notes, the layer charter and the long instructions become
 * hash-pinned pointers in the abridged form, and the seed and thread indexes
 * and the layer counts become compact indexes.
 */

import crypto from 'crypto';
import { LAYER_CHARTER } from './layers.js';

const sha256 = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');

/** The layer charter as the startup payload serves it: every field except the duplicate importance_range. */
export function payloadForLayerCharter(charter = LAYER_CHARTER) {
  const out = {};
  for (const [layer, entry] of Object.entries(charter)) {
    const { importance_range, ...rest } = entry; // eslint-disable-line no-unused-vars
    out[layer] = rest;
  }
  return out;
}

/** Characters and UTF-8 bytes of the result text a host receives (createSuccessResponse's compact envelope). */
export function resultSize(data, tool = 'emet_initialize') {
  const text = JSON.stringify({ success: true, tool, timestamp: 1790000000000, data });
  return { chars: text.length, bytes: Buffer.byteLength(text, 'utf8') };
}

/** Per-key JSON size of a payload, largest first. */
export function keySizes(payload) {
  return Object.entries(payload)
    .map(([key, v]) => ({ key, chars: JSON.stringify(v === undefined ? null : v).length }))
    .sort((a, b) => b.chars - a.chars);
}

/** The keys every abridged load embeds exactly as the full load has them (the design's keep set; never dropped). */
export const ABRIDGED_KEEP = Object.freeze([
  'state', 'database', 'source_tag', 'person_id', 'unhandled_drops', 'unhandled_drops_more', 'retired_drops',
  'emet_line', 'emet_line_if_unanswered',
  'tools_in_force', 'instructions_short', 'session_close_protocol', 'operating_discipline', 'charter',
  'identity', 'character', 'character_doc_id', 'character_sha256', 'user',
  'install_notes_doc_id',
  'seeds_due', 'seeds_evaluated_on',
  'record_gaps', 'named_items', 'lessons_pending',
  'floor', 'floor_precedence', 'floor_reassertion'
]);

/** Keys that become hash-pinned pointers: text the host already echoed at a full load, unchanged. */
export const ABRIDGED_PINNED = Object.freeze(['install_notes', 'layer_charter', 'instructions']);

/** Keys that become compact indexes (not hash-pinned; the seed index is watermarked in stage 2). */
export const ABRIDGED_INDEXED = Object.freeze(['seeds', 'threads', 'layer_counts', 'layer_counts_last_30d']);

function layerHealthy(h) {
  return !!(h && h.assessed === true && Array.isArray(h.underused) && h.underused.length === 0);
}

/**
 * The conservative abridged payload, built from a full ready payload.
 * @param {object} full    the object initialize() returns in the ready state
 * @param {object} [opts]
 * @param {string} [opts.since]  ISO time of the host's last full-load receipt;
 *   recent_context then keeps only entries newer than it (at most 5). Without
 *   it recent_context is kept as served (the safe direction).
 * @param {string} [opts.reason] startup_reason to report
 */
export function abridgeReadyPayload(full, opts = {}) {
  if (!full || full.state !== 'ready') throw new Error('abridgeReadyPayload: only a ready payload can be abridged');
  const out = { startup_mode: 'abridged', startup_reason: opts.reason || 'returning configured bot (proven by receipt)' };
  for (const k of ABRIDGED_KEEP) if (k in full) out[k] = full[k];

  const pointers = [];
  if (full.install_notes) {
    pointers.push({
      key: 'install_notes', kind: 'hash_pinned', doc_id: full.install_notes.doc_id,
      version: full.install_notes.version ?? null, sha256: full.install_notes.sha256 || sha256(full.install_notes.content),
      read_via: `read_doc ${full.install_notes.doc_id}`
    });
  }
  for (const k of ['layer_charter', 'instructions']) {
    if (full[k] != null) {
      pointers.push({ key: k, kind: 'hash_pinned', sha256: sha256(JSON.stringify(full[k])), read_via: 'emet_initialize (a full load; the server serves the whole text again whenever this sha256 differs from the copy you hold)' });
    }
  }
  const seeds = Array.isArray(full.seeds) ? full.seeds : [];
  pointers.push({ key: 'seeds', kind: 'index', count: seeds.length, read_via: 'list_docs {prefix: "seeds/"}, then read_doc' });
  const threads = Array.isArray(full.threads) ? full.threads : [];
  pointers.push({
    key: 'threads', kind: 'index', count: threads.length,
    latest_updated_at: threads.map((t) => t.updated_at).filter(Boolean).sort().pop() || null,
    read_via: 'list_docs {prefix: "threads/"}'
  });
  pointers.push({ key: 'layer_counts', kind: 'index', read_via: 'emet_status' });

  // layer_health only when it reports something; recent_context as a delta.
  if (!layerHealthy(full.layer_health)) out.layer_health = full.layer_health;
  else pointers.push({ key: 'layer_health', kind: 'index', status: 'healthy', read_via: 'emet_status' });
  const recent = Array.isArray(full.recent_context) ? full.recent_context : [];
  out.recent_context = (opts.since ? recent.filter((r) => r.when && r.when > opts.since) : recent).slice(0, 5);

  out.pointers = pointers;
  return out;
}

export default { payloadForLayerCharter, resultSize, keySizes, abridgeReadyPayload, ABRIDGED_KEEP, ABRIDGED_PINNED, ABRIDGED_INDEXED };
