/**
 * EMET - Enduring Memory & Epistemic Tiers
 * Copyright (c) 2026 Dreamforge Studio LLC
 *
 * Licensed under the MIT License - see LICENSE
 *
 * emet_gaps - the record's honesty about its own holes, as a query (work list E4).
 *
 * Everything the door writes as a visible marker (E3), every digest it stores
 * (C1), every pointer it keeps (provenance), and every supersession
 * link exists so that ABSENCE can be counted. This module counts it. It
 * identifies and never fills: a gap that is honestly recorded and honestly
 * left is a stronger record than a backfilled one, and the discipline for
 * closing a gap (revise_memory with a real pointer, on a revisable layer, when
 * the source is actually knowable) belongs to a person, not to this tool.
 *
 * Read-only. The write-path invariant test confirms it: no write verb here.
 *
 * Two shapes: `findGaps` returns counts AND the ids behind them (the tool);
 * `gapCounts` returns counts only (the startup line in emet_initialize, a
 * sibling of layer_health - the same move layers.js made for the silent meta
 * layer).
 */

import { connectMongo } from './mongo-connect.js';
import { MONGODB_URI, MONGODB_DB, COLLECTION_PREFIX, DatabaseError } from './database.js';
import { LAYERS, policyFor } from './layers.js';
import { integrityOf, metadataIntegrityOf, walkChain } from './aleph.js';
import { parseMetadata } from './metadata.js';
import { crossCheckProvenance } from './provenance.js';
import { isOpenNonconformance, isAcceptedNonconformance } from './conformance.js';
import { setting } from './env.js';

const TRANSCRIPTS = 'transcripts';
const DOCUMENTS = 'documents';

/** The gap classes, in the order they are reported. Names are the contract. */
export const GAP_CLASSES = Object.freeze({
  unsourced_assertions:      'semantic/procedural entries with no provenance pointer (no session span, no consolidated-from ids)',
  unattributed_inferences:   'semantic/procedural entries whose assertion_origin is assistant or unknown AND that carry no provenance pointer - an inference the record merely holds',
  ambiguous_attribution:     'entries whose source tag was defaulted, is missing, or is not in the registered list (EMET_SOURCE_TAGS) - grouped by tag and by session',
  uncertain_routing:         'entries the door routed itself (routing.method other than explicit) - no instance chose the layer',
  unattestable:              'entries written before the content digest existed (2026-09-05) - a dated boundary, not a defect',
  digest_mismatch:           'entries whose stored content or metadata digest disagrees with the row - the alarm; expected zero',
  broken_chain:              'entries whose chain digest does not match their own content digest and recorded predecessor - altered after writing; expected zero',
  chain_discontinuities:     'linked entries whose recorded predecessor is not the entry just before them in id order - a row between them was removed, or two writes forked the chain; expected zero',
  pointer_disagreements:     'entries whose provenance pointer sits outside the window of the session it names, or names a session whose transcript was never written although later sessions have closed since',
  pointers_pending_transcript: 'entries pointing at a session whose transcript has not been written yet - expected while that session is still open, and it resolves at close. Not a defect, and counted apart so it never inflates the disagreement count',
  broken_supersession:       'a parent marked superseded by an id that does not exist, or a live child whose parent is still live',
  broken_correction:         'a parent whose corrected_by names an id that does not exist in its layer or does not name it back in metadata.corrects, or a correction (metadata.corrects) whose parent is missing or not marked - option A back-pointer, 2026-10-02',
  expired_but_live:          'entries past valid_until that are still flagged live. They stay in recall and queries, marked with that end date',
  consolidation_candidates:  'families of three to eight live entries in one layer sharing three or more tags - identified for a person to consolidate, never consolidated here (approximate: tag overlap, not semantic similarity; larger families are topics, not candidates, and are not reported)',
  redacted_spans:            'entries and transcripts stored with secret spans masked - which host keeps pasting secrets',
  nonconforming_documents:   'controlled documents carrying an OPEN nonconformance marker - form or continuity failed against the template in force, and it has not been corrected by a later revision or accepted in writing',
  accepted_nonconformances:  'nonconformance markers dispositioned in writing for the revision they name - counted separately because an acceptance is a disposition, not a disappearance (STANDARD 9a L6)'
});

const ASSERTING = new Set(['semantic', 'procedural']);

/**
 * What a pointer finding actually IS.
 *
 * ⚠ A POINTER NAMING A SESSION WITH NO TRANSCRIPT IS NOT A DISAGREEMENT WHILE
 * THAT SESSION IS STILL OPEN. A transcript is written at close, so every entry
 * written DURING a session points at a session the store cannot know about yet.
 * Reported as a disagreement, that made the count rise through a working
 * session and fall again at wrap-up - noise that looked like a fault, and it
 * trained a reader to discount the one class that is meant to be read. The
 * user's framing, 2026-09-12: establish the pointer at write time, judge it
 * at wrap-up.
 *
 * THE DISCRIMINATOR IS THE STORE ITSELF, NOT A CLOCK AND NOT A TOLERANCE.
 * `closedThroughSec` is the newest moment any transcript covers. An entry
 * written AFTER that names a session that plausibly has not closed yet, so the
 * absence is expected. An entry written BEFORE it names a session that should
 * have been saved, because other sessions have closed since - that absence is a
 * transcript that was never written, and it is a real finding. No magic number
 * is involved, which is deliberate: a tolerance in hours would have to be
 * guessed, and would be wrong for both a ten-minute session and a long one.
 *
 * Pure, so the rule is assertable without a live store.
 *
 * @param {object} entry  the stored row (needs source_session_id, timestamp)
 * @param {object|null} window  the session's transcript window, or null if absent
 * @param {number|null} closedThroughSec  newest moment covered by any transcript
 * @returns {{kind: 'agrees'|'pending'|'disagrees', finding?: string}}
 */
export function classifyPointer(entry, window, closedThroughSec = null) {
  if (!entry || !entry.source_session_id) return { kind: 'agrees' };
  const sid = entry.source_session_id;

  if (!window) {
    const at = typeof entry.timestamp === 'number' ? entry.timestamp : null;
    // No transcript has ever been written, or this entry is newer than the
    // newest one: the session it names may still be running.
    if (closedThroughSec === null || at === null || at > closedThroughSec) {
      return {
        kind: 'pending',
        finding: `Entry points at session "${sid}", whose transcript has not been written yet. Expected while that session is open; it resolves at close.`
      };
    }
    return {
      kind: 'disagrees',
      finding: `Entry points at session "${sid}", which has no transcript even though later sessions have closed since. The transcript was never written.`
    };
  }

  const check = crossCheckProvenance(entry, window);
  if (check.checked && check.agrees === false) return { kind: 'disagrees', finding: check.finding };
  return { kind: 'agrees' };
}

function registeredTags() {
  return String(setting('SOURCE_TAGS') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * Classify ONE row. Pure: takes the row and what it needs to know about the
 * world (registry, now) and returns the gap-class names that apply. Row shape
 * is the stored document: top-level columns + `metadata` (subdocument or
 * legacy string).
 */
export function classifyRow(layer, row, { registry = [], nowSec = Date.now() / 1000 } = {}) {
  const gaps = [];
  if (!row || typeof row !== 'object') return gaps;
  const md = parseMetadata(row.metadata) || {};
  const live = row.is_live !== false && !row.superseded_by && !md.superseded_by;

  const hasPointer = Boolean(row.source_session_id) || (Array.isArray(row.derived_from_ids) && row.derived_from_ids.length > 0);

  if (ASSERTING.has(layer) && !hasPointer && policyFor(layer).provenance === 'required') {
    gaps.push('unsourced_assertions');
    const origin = md.assertion_origin;
    if (origin === 'assistant' || origin === null || origin === undefined) gaps.push('unattributed_inferences');
  }

  const source = md.source;
  if (md.source_defaulted === true || md.source_missing === true || source === undefined || source === null || source === '' ||
      md.source_unregistered === true || (registry.length > 0 && typeof source === 'string' && !registry.includes(source))) {
    gaps.push('ambiguous_attribution');
  }

  if (md.routing && typeof md.routing === 'object' && md.routing.method && md.routing.method !== 'explicit') {
    gaps.push('uncertain_routing');
  }

  const ci = integrityOf(row);
  const mi = metadataIntegrityOf(row);
  if (ci === 'unattested') gaps.push('unattestable');
  if (ci === false || mi === false) gaps.push('digest_mismatch');

  const vu = typeof row.valid_until === 'number' ? row.valid_until
           : typeof md.valid_until === 'number' ? md.valid_until : null;
  if (vu !== null && vu < nowSec && live) gaps.push('expired_but_live');

  if ((typeof md.redacted_spans === 'number' && md.redacted_spans > 0)) gaps.push('redacted_spans');

  return gaps;
}

/**
 * Consolidation candidates by tag overlap. Families of >= minFamily live rows
 * that pairwise share >= minShared tags. Approximate on purpose - the honest
 * version of "autonomous consolidation" is a list for a person.
 */
export function tagFamilies(rows, { minShared = 3, minFamily = 3, maxFamily = 8 } = {}) {
  const items = rows
    .map((r) => ({ id: r.id, tags: new Set((parseMetadata(r.metadata) || {}).tags || []) }))
    .filter((x) => x.tags.size >= minShared);
  const parent = new Map(items.map((x) => [x.id, x.id]));
  const find = (a) => { while (parent.get(a) !== a) { parent.set(a, parent.get(parent.get(a))); a = parent.get(a); } return a; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      let shared = 0;
      for (const t of items[i].tags) if (items[j].tags.has(t)) { shared++; if (shared >= minShared) break; }
      if (shared >= minShared) union(items[i].id, items[j].id);
    }
  }
  const groups = new Map();
  for (const x of items) { const r = find(x.id); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(x.id); }
  // A family larger than maxFamily is a TOPIC (a batch import sharing five
  // tags across forty rows), not a consolidation candidate. Dry run on the
  // 2026-09-07 corpus produced families of 44 and 26 that way. They are
  // dropped here, not reported: a candidate list a person will not read is
  // no better than none.
  return [...groups.values()]
    .filter((g) => g.length >= minFamily && g.length <= maxFamily)
    .map((g) => g.sort((a, b) => a - b));
}

async function connect() {
  if (!MONGODB_URI) throw new DatabaseError('MONGODB_URI is not set; cannot assess gaps.', 'emet_gaps');
  const client = await connectMongo(MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
  return { client, db: client.db(MONGODB_DB) };
}

/**
 * Run every gap class over the store. Returns counts and ids (capped at
 * `limit` per class) plus the groupings that make a count actionable.
 */
/**
 * broken_correction, both directions (option A, 2026-10-02). Pure apart
 * from the row lookup, so the suite can drive it with a layer-honouring fake.
 *   corrected:   [{ ref, layer, id, child }]  - a parent's corrected_by entries:
 *                the child must exist in the SAME layer and name the parent in
 *                metadata.corrects;
 *   corrections: [{ ref, layer, id, parent }] - a child's metadata.corrects: the
 *                parent must exist in the same layer and list the child in
 *                corrected_by (column first, else the metadata copy).
 * findRow(layer, id) returns the row or null. Returns the finding texts.
 */
export async function checkCorrectionLinks(corrected, corrections, findRow) {
  const out = [];
  const mdOf = (row) => (typeof row.metadata === 'string' ? (() => { try { return JSON.parse(row.metadata); } catch { return {}; } })() : (row.metadata || {}));
  for (const c of corrected) {
    const child = await findRow(c.layer, c.child);
    if (!child) out.push(`${c.ref} -> corrected_by ${c.child} (missing)`);
    else if (Number(mdOf(child).corrects) !== Number(c.id)) out.push(`${c.ref} -> corrected_by ${c.child} (it does not name ${c.id} in corrects)`);
  }
  for (const c of corrections) {
    const parent = await findRow(c.layer, c.parent);
    if (!parent) { out.push(`${c.ref} corrects ${c.parent} (parent missing)`); continue; }
    const pmd = mdOf(parent);
    const list = Array.isArray(parent.corrected_by) ? parent.corrected_by : (Array.isArray(pmd.corrected_by) ? pmd.corrected_by : []);
    if (!list.map(Number).includes(Number(c.id))) out.push(`${c.ref} corrects ${c.parent} (parent not marked)`);
  }
  return out;
}

export async function findGaps({ layer = null, since = null, limit = 50 } = {}) {
  const layers = layer ? [layer] : [...LAYERS];
  if (layer && !LAYERS.includes(layer)) throw new DatabaseError(`Unknown layer '${layer}'`, 'emet_gaps');
  const cap = Math.max(1, Math.min(500, Number(limit) || 50));
  const nowSec = Date.now() / 1000;
  const registry = registeredTags();
  const sinceSec = typeof since === 'number' ? since : null;

  const classes = {};
  for (const name of Object.keys(GAP_CLASSES)) classes[name] = { count: 0, ids: [] };
  const byTag = {}, bySession = {}, redactedBySource = {};
  const push = (name, ref) => { const c = classes[name]; c.count++; if (c.ids.length < cap) c.ids.push(ref); };

  // Declared outside the try: the return below reads it (live-caught 2026-09-29,
  // "chain is not defined", in a live deploy).
  const chain = {};
  let graphLab = null;
  const { client, db } = await connect();
  try {
    const pointers = []; // { ref, entry }
    const idsByLayer = {};
    const parentsToCheck = []; // { ref, layer, superseded_by }
    const childrenToCheck = []; // { ref, layer, supersedes }
    const correctedToCheck = []; // { ref, layer, id, child } - a parent's corrected_by entries
    const correctionsToCheck = []; // { ref, layer, id, parent } - a child's metadata.corrects
    const liveRowsByLayer = {};
    // The full chain walk (2026-09-29): until today it lived only in
    // scripts/chain-verify.mjs, runnable from a machine with the repo and the
    // Railway CLI - no host could ask for it. It rides on this scan, so it
    // costs no extra pass; the script stays as the outside auditor's copy.
    const chainRowsByLayer = {};

    for (const l of layers) {
      const col = db.collection(`${COLLECTION_PREFIX}${l}`);
      const filter = sinceSec !== null ? { timestamp: { $gte: sinceSec } } : {};
      const ids = new Set();
      const liveRows = [];
      const chainRows = [];
      for await (const row of col.find(filter)) {
        const ref = `${l}#${row.id}`;
        ids.add(row.id);
        chainRows.push({ id: row.id, sha256: row.sha256, prev_sha256: row.prev_sha256, chain_sha256: row.chain_sha256, timestamp: row.timestamp });
        const md = parseMetadata(row.metadata) || {};
        const rowGaps = classifyRow(l, row, { registry, nowSec });
        for (const g of rowGaps) push(g, ref);
        if (rowGaps.includes('ambiguous_attribution')) {
          const tag = md.source === undefined || md.source === null || md.source === '' ? '(none)' : String(md.source);
          byTag[tag] = (byTag[tag] || 0) + 1;
          const s = row.source_session_id || '(no session)';
          bySession[s] = (bySession[s] || 0) + 1;
        }
        if (typeof md.redacted_spans === 'number' && md.redacted_spans > 0) {
          const s = md.source || '(none)'; redactedBySource[s] = (redactedBySource[s] || 0) + md.redacted_spans;
        }
        if (row.source_session_id) pointers.push({ ref, entry: row });
        if (row.superseded_by) parentsToCheck.push({ ref, layer: l, superseded_by: Number(row.superseded_by) });
        const cby = Array.isArray(row.corrected_by) ? row.corrected_by : md.corrected_by;
        if (Array.isArray(cby)) for (const c of cby) correctedToCheck.push({ ref, layer: l, id: row.id, child: Number(c) });
        if (md.corrects !== undefined && md.corrects !== null) correctionsToCheck.push({ ref, layer: l, id: row.id, parent: Number(md.corrects) });
        const sup = md.supersedes ?? (md.custom && md.custom.supersedes);
        const live = row.is_live !== false && !row.superseded_by && !md.superseded_by;
        if (live && sup) childrenToCheck.push({ ref, layer: l, supersedes: Number(sup) });
        if (live) liveRows.push(row);
      }
      idsByLayer[l] = ids;
      liveRowsByLayer[l] = liveRows;
      chainRowsByLayer[l] = chainRows;
    }

    for (const l of layers) {
      const rows = chainRowsByLayer[l];
      let seedSha256 = null;
      if (sinceSec !== null && rows.length) {
        // A partial walk starts mid-chain: seed it with the digest of the row
        // just before the first one scanned.
        const minId = Math.min(...rows.map((r) => r.id));
        const before = await db.collection(`${COLLECTION_PREFIX}${l}`)
          .find({ id: { $lt: minId }, sha256: { $exists: true, $nin: [null, ''] } }, { projection: { sha256: 1 } })
          .sort({ id: -1 }).limit(1).toArray();
        seedSha256 = before[0] ? before[0].sha256 : null;
      }
      const w = walkChain(rows, { seedSha256, sample: cap });
      for (const id of w.broken_ids) push('broken_chain', `${l}#${id}`);
      classes.broken_chain.count += w.broken - w.broken_ids.length;
      for (const id of w.discontinuity_ids) push('chain_discontinuities', `${l}#${id}`);
      classes.chain_discontinuities.count += w.discontinuities - w.discontinuity_ids.length;
      chain[l] = { total: w.total, linked: w.linked, unlinked: w.unlinked, broken: w.broken, discontinuities: w.discontinuities, head: w.head };
    }

    // Broken supersession: the referenced id must exist in the same layer
    // (fetched only when the scan was filtered, since the set is then partial).
    for (const p of parentsToCheck) {
      let exists = idsByLayer[p.layer].has(p.superseded_by);
      if (!exists && sinceSec !== null) exists = Boolean(await db.collection(`${COLLECTION_PREFIX}${p.layer}`).findOne({ id: p.superseded_by }, { projection: { id: 1 } }));
      if (!exists) push('broken_supersession', `${p.ref} -> superseded_by ${p.superseded_by} (missing)`);
    }
    for (const f of await checkCorrectionLinks(correctedToCheck, correctionsToCheck,
      (layer, id) => db.collection(`${COLLECTION_PREFIX}${layer}`).findOne({ id }, { projection: { id: 1, metadata: 1, corrected_by: 1 } }))) {
      push('broken_correction', f);
    }
    for (const c of childrenToCheck) {
      const parent = await db.collection(`${COLLECTION_PREFIX}${c.layer}`).findOne({ id: c.supersedes }, { projection: { id: 1, is_live: 1, superseded_by: 1 } });
      if (parent && parent.is_live !== false && !parent.superseded_by) push('broken_supersession', `${c.ref} supersedes ${c.supersedes} (parent still live)`);
      if (!parent) push('broken_supersession', `${c.ref} supersedes ${c.supersedes} (parent missing)`);
    }

    // Pointer disagreements: resolve each distinct session once.
    const sessions = [...new Set(pointers.map((p) => p.entry.source_session_id))];
    const windows = {};
    if (sessions.length) {
      const tcol = db.collection(TRANSCRIPTS);
      for (const sid of sessions) {
        const esc = sid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const parts = await tcol.find({ session_id: { $regex: `^${esc}(_(?:verbatim_)?part\\d+)?$` } }, { projection: { session_start: 1, session_end: 1 } }).toArray();
        if (!parts.length) { windows[sid] = null; continue; }
        const starts = parts.map((p) => p.session_start).filter(Boolean);
        const ends = parts.map((p) => p.session_end).filter(Boolean);
        windows[sid] = { session_start: new Date(Math.min(...starts.map((d) => new Date(d).getTime()))), session_end: new Date(Math.max(...ends.map((d) => new Date(d).getTime()))) };
      }
    }
    // How far the transcript store has been written through. Read once, and
    // only when something actually needs it: it is the discriminator between a
    // session that has not closed yet and a transcript that was never written.
    let closedThroughSec = null;
    if (sessions.some((sid) => !windows[sid])) {
      let newestMs = null;
      for await (const t of db.collection(TRANSCRIPTS).find({}, { projection: { session_start: 1, session_end: 1 } })) {
        for (const v of [t.session_end, t.session_start]) {
          if (!v) continue;
          const ms = new Date(v).getTime();
          if (Number.isFinite(ms) && (newestMs === null || ms > newestMs)) newestMs = ms;
        }
      }
      if (newestMs !== null) closedThroughSec = newestMs / 1000;
    }

    for (const p of pointers) {
      const verdict = classifyPointer(p.entry, windows[p.entry.source_session_id], closedThroughSec);
      if (verdict.kind === 'disagrees') push('pointer_disagreements', `${p.ref}: ${verdict.finding}`);
      else if (verdict.kind === 'pending') push('pointers_pending_transcript', `${p.ref}: ${verdict.finding}`);
    }

    // Consolidation candidates, per layer, live rows only.
    for (const l of layers) {
      for (const fam of tagFamilies(liveRowsByLayer[l])) push('consolidation_candidates', `${l}: ${fam.map((id) => '#' + id).join(', ')}`);
    }

    // Redacted transcripts.
    const tfilter = { redacted_spans: { $gt: 0 } };
    for await (const t of db.collection(TRANSCRIPTS).find(tfilter, { projection: { session_id: 1, channel: 1, redacted_spans: 1 } })) {
      push('redacted_spans', `transcript ${t.session_id} (${t.channel || '?'}): ${t.redacted_spans}`);
      const s = t.channel || '(none)'; redactedBySource[s] = (redactedBySource[s] || 0) + (t.redacted_spans || 0);
    }

    // Controlled documents. This is the count the board's "Nonconformance
    // markers open" column asks for, which until the validator existed could
    // only answer "validator not built". A marker leaves in one of two ways -
    // a later revision that passes, or a written acceptance - and the second
    // is counted separately rather than folded into the first, because an
    // acceptance is a disposition and not a disappearance (L6).
    const dfilter = { conformance: { $exists: true } };
    if (sinceSec !== null) dfilter.updated_at = { $gte: new Date(sinceSec * 1000) };
    for await (const d of db.collection(DOCUMENTS).find(dfilter,
      { projection: { doc_id: 1, version: 1, conformance: 1 } })) {
      const c = d.conformance;
      if (isOpenNonconformance(c, d.version)) {
        const n = (c.failures || []).length;
        push('nonconforming_documents',
          `${d.doc_id} v${d.version}: ${n} failure${n === 1 ? '' : 's'}${c.template ? ` against ${c.template}` : ''}`);
      } else if (isAcceptedNonconformance(c, d.version)) {
        push('accepted_nonconformances',
          `${d.doc_id} v${d.version}: ${String(c.accepted && c.accepted.reason).slice(0, 90)}`);
      }
    }
    // Lab results (2026-09-29): the monorail's own record of every check it
    // made, for the probationary review before enforce. Read, never written here.
    try {
      const { labSummary, LAB_SUFFIX } = await import('./session-graph.js');
      const lfilter = sinceSec !== null ? { ts: { $gte: new Date(sinceSec * 1000) } } : {};
      const labRows = await db.collection(`${COLLECTION_PREFIX}${LAB_SUFFIX}`)
        .find(lfilter, { projection: { _id: 0 } }).toArray();
      graphLab = labSummary(labRows, { limit: cap });
    } catch (e) {
      graphLab = { assessed: false, error: e && e.message ? e.message : String(e) };
    }
  } finally {
    await client.close();
  }

  const total = Object.values(classes).reduce((s, c) => s + c.count, 0);
  return {
    assessed_at: new Date().toISOString(),
    scope: { layers, since: sinceSec, id_limit_per_class: cap },
    total_findings: total,
    classes: Object.fromEntries(Object.entries(classes).map(([k, v]) => [k, { description: GAP_CLASSES[k], ...v }])),
    chain,
    graph_lab: graphLab,
    ambiguous_attribution_by_tag: byTag,
    ambiguous_attribution_by_session: bySession,
    redacted_spans_by_source: redactedBySource,
    discipline:
      'Identify, never fill. Where the true source is knowable (the writer is still in session; the span is unambiguous) ' +
      'the fix is revise_memory with a real derived_from on a revisable layer. Where it is not knowable, or the layer is episodic, ' +
      'the gap stands as a fact and the count stops growing from that date. unattestable is a dated boundary; digest_mismatch ' +
      'is the alarm; consolidation_candidates is a list for a person.'
  };
}

/** Counts only - the startup line. Never throws: a failed assessment is itself reported. */
export async function gapCounts(options = {}) {
  try {
    const full = await findGaps({ ...options, limit: 1 });
    const counts = Object.fromEntries(Object.entries(full.classes).map(([k, v]) => [k, v.count]));
    const out = { assessed: true, total_findings: full.total_findings, counts };
    // THE BASELINE (2026-09-15). A lifetime total is dominated by rows written
    // before the door and the pointer existed - 1,086 of the first 1,087 rows
    // in the reference install carry no provenance, by rule, forever. A count
    // that can never fall is not a control. EMET_GAP_BASELINE (ISO date or
    // Unix seconds) names the date from which the record is held to the
    // current rules; startup then reports gaps since that date beside the
    // lifetime figure, and the since-baseline figure is the one that should
    // trend to zero. No baseline set: the block is absent, not defaulted -
    // a product must not encode one install's history.
    const baselineSec = parseBaseline(setting('GAP_BASELINE'));
    if (baselineSec !== null && (typeof options.since !== 'number')) {
      const since = await findGaps({ ...options, since: baselineSec, limit: 1 });
      out.since_baseline = {
        baseline: new Date(baselineSec * 1000).toISOString(),
        total_findings: since.total_findings,
        counts: Object.fromEntries(Object.entries(since.classes).map(([k, v]) => [k, v.count]))
      };
    }
    return out;
  } catch (e) {
    return { assessed: false, error: e && e.message ? e.message : String(e) };
  }
}

/** EMET_GAP_BASELINE as Unix seconds, or null when unset or unparseable. Exported for its test. */
export function parseBaseline(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const str = String(raw).trim();
  if (/^\d{9,11}$/.test(str)) return Number(str);
  const ms = Date.parse(str);
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}
