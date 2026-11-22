/**
 * EMET - Enduring Memory & Epistemic Tiers
 * Copyright (c) 2026 Dreamforge Studio LLC
 *
 * Licensed under the MIT License - see LICENSE
 *
 * Continuity-currency gate. A read-time comparison of the served
 * HANDOFF against the live material episodic tip. This is not wiki page
 * currency (`src/currency.js`): that class is about a topic page. This one
 * is tip-lag. HANDOFF and STATE are records. This module never writes them,
 * never supersedes them, and never blocks a call. Phase 2 block stays off.
 */

import crypto from 'crypto';
import { setting } from './env.js';
import { parseMetadata } from './metadata.js';
import { handoffDoc } from './session.js';
import { COLLECTION_PREFIX } from './database.js';
import { tagHandoffMode, hubTag, worstStatus, partitionEpisodic, openSessionsFromRows, staleOpenHours, writeTagRegistry, OPEN_SESSION_LOOKBACK_MS } from './per-tag-handoff.js';

export const CONTINUITY_CURRENCY_FLAG = 'EMET_CONTINUITY_CURRENCY';
/** Reserved name. This revision does not read it to block. */
export const CONTINUITY_CURRENCY_BLOCK_FLAG = 'EMET_CONTINUITY_CURRENCY_BLOCK';
export const CONTINUITY_CURRENCY_BLOCK_ENABLED = false;

/**
 * Start of the UTC day 2026-09-27 (8:00 PM EDT on 2026-09-26).
 * Audit 1.5c renamed the write argument to `source` and did not change stored rows. A registered
 * tag is required on a transcript write (audit 1.5d). An episodic save does
 * not require one. A material row with no registered source written before
 * this instant is legacy (pre-attribution): the reading counts it and lists
 * its ids, and it does not make the overall status warn. A row at or after
 * this instant with no registered source still warns. A row with no
 * timestamp, or a timestamp that does not parse, still warns. A row with no
 * id is judged by its timestamp the same way. This check does not read
 * EMET_CONTINUITY_CURRENCY_BLOCK.
 */
export const TAG_ATTRIBUTION_BEGAN = '2026-09-27T00:00:00.000Z';
export const LEGACY_PRE_ATTRIBUTION = 'legacy (pre-attribution)';
export const LEGACY_CUTOFF_BASIS = 'after_last_unsourced_episodic';

/** No install-specific display-name aliases. The stored source is the source. */
const CONTINUITY_SOURCE_ALIAS = Object.freeze({});

/** No install-specific noted-legacy rows. A public store starts empty. */
const NOTED_LEGACY = Object.freeze([]);

/** Preferred tags, any one, compared case-insensitively. */
export const PREFERRED_TAGS = Object.freeze([
  'material', 'board', 'decision', 'deploy', 'go-live',
  'reconnect', 'reminder-clear', 'handoff', 'handoff-rewrite', 'handoff-relevant'
]);

const HARD_EXCLUDE = new Set(['scratch', 'probe', 'test', 'superseded', 'ended']);
const DIAGNOSIS = new Set(['diagnosis', 'transcript-flag', 'transcript-flag-only', 'transcript-flags']);
const PROJECT_EFFECT = Object.freeze([
  /\bhandoff\b/i,
  /\bSTATE\b/,
  /\bstate\.md\b/i,
  /\bboard\b/i,
  /\bdeploy\b/i,
  /\breconnect\b/i,
  /reminder-clear/i,
  /user decision/i
]);

const SUMMARY_CHARS = 160;
const NEWER_LIST_CAP = 20;

const EPISODIC_PROJECTION = Object.freeze({
  _id: 0,
  id: 1,
  timestamp: 1,
  content: 1,
  context: 1,
  metadata: 1,
  tags: 1,
  importance_bucket: 1,
  importance_degree: 1,
  kind: 1,
  is_live: 1,
  superseded_by: 1,
  ended: 1,
  valid_until: 1,
  layer_tip: 1
});

const EPISODIC_QUERY = Object.freeze({
  $or: [
    { id: { $gte: 1 } },
    { id: { $regex: '^\\d+$' } },
    { layer_tip: { $gte: 1 } },
    { layer_tip: { $regex: '^\\d+$' } },
    { 'metadata.layer_tip': { $gte: 1 } },
    { 'metadata.layer_tip': { $regex: '^\\d+$' } },
    { metadata: { $regex: '"layer_tip"' } }
  ]
});

const SESSION_PROJECTION = Object.freeze({
  _id: 0,
  episodic_id: 1,
  closed: 1,
  handoff: 1,
  handoff_version: 1
});

const SESSION_QUERY = Object.freeze({
  $or: [
    { closed: true },
    { handoff: true }
  ]
});

/** Phase 1 is on only when the setting is the digit 1. Anything else is off. */
export function continuityCurrencyEnabled() {
  return setting('CONTINUITY_CURRENCY') === '1';
}

/**
 * Phase 2 is not enabled in this revision. The reserved setting is reported
 * and ignored. This revision does not turn a block on.
 */
export function continuityCurrencyBlockEnabled() {
  return CONTINUITY_CURRENCY_BLOCK_ENABLED;
}

export function continuityCurrencyBlockRequested() {
  return setting('CONTINUITY_CURRENCY_BLOCK') === '1';
}

function finiteId(value) {
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) value = Number(value.trim());
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) return null;
  return value;
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

function isoFromMs(ms) {
  if (ms == null) return null;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function tagsOf(entry) {
  const md = parseMetadata(entry && entry.metadata);
  const raw = Array.isArray(md.tags) ? md.tags : (Array.isArray(entry && entry.tags) ? entry.tags : []);
  const out = [];
  for (const tag of raw) {
    const name = String(tag == null ? '' : tag).trim().toLowerCase();
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

function bucketOf(entry) {
  const md = parseMetadata(entry && entry.metadata);
  return String(md.importance_bucket || (entry && entry.importance_bucket) || '').trim().toLowerCase();
}

function degreeOf(entry) {
  const md = parseMetadata(entry && entry.metadata);
  return String(md.importance_degree || (entry && entry.importance_degree) || '').trim().toLowerCase();
}

function kindOf(entry) {
  const md = parseMetadata(entry && entry.metadata);
  return String(md.kind || (entry && entry.kind) || '').trim().toLowerCase();
}

function oneLine(text) {
  const line = String(text || '').split(/\r?\n/).map((part) => part.trim()).find(Boolean) || '';
  const flat = line.replace(/\s+/g, ' ').trim();
  const chars = Array.from(flat);
  if (chars.length <= SUMMARY_CHARS) return flat;
  return `${chars.slice(0, SUMMARY_CHARS - 1).join('')}…`;
}

function projectEffect(text) {
  const body = String(text || '');
  return PROJECT_EFFECT.some((pattern) => pattern.test(body));
}

function hardExclude(entry, tags, nowMs) {
  if (!entry || typeof entry !== 'object') return 'unreadable';
  if (entry.is_live === false) return 'ended';
  const md = parseMetadata(entry.metadata);
  const superseded = entry.superseded_by ?? md.superseded_by;
  if (superseded != null && superseded !== '') return 'superseded';
  if (entry.ended === true || md.ended === true) return 'ended';
  const until = epochMs(entry.valid_until ?? md.valid_until);
  if (until != null && until <= nowMs) return 'ended';
  if (bucketOf(entry) === 'scratch') return 'scratch';
  for (const tag of tags) if (HARD_EXCLUDE.has(tag)) return tag;
  return null;
}

function diagnosisOnly(entry, tags) {
  if (tags.some((tag) => DIAGNOSIS.has(tag))) return true;
  return DIAGNOSIS.has(kindOf(entry));
}

function fallbackTags(entry, tags) {
  const binding = tags.includes('binding') || tags.includes('durable') || bucketOf(entry) === 'binding' || bucketOf(entry) === 'durable';
  const event = tags.includes('event') || bucketOf(entry) === 'event';
  const high = degreeOf(entry) === 'high' || tags.includes('high');
  if (!projectEffect(entry && entry.content)) return null;
  if (binding) return tags.filter((tag) => tag === 'binding' || tag === 'durable');
  if (event && high) return tags.filter((tag) => tag === 'event' || tag === 'high');
  return null;
}

/**
 * One episodic row. `pointers.closeVerification` holds ids from closed
 * sessions and the handoff's own close-verification claim. `pointers.layerTip`
 * holds ids named by a layer-tip field.
 * Scratch, superseded, ended, probe, and test lose before a preferred tag.
 * A preferred tag is the only thing that keeps a diagnosis-only or
 * transcript-flags row. Those exclusions run before any pointer match.
 * Fallback is pilot-logged and is not, by itself, a future block.
 */
export function classifyEpisodic(entry, pointers, nowMs = Date.now()) {
  const tags = tagsOf(entry);
  const excluded = hardExclude(entry, tags, nowMs);
  if (excluded) return { material: false, excluded, tags, basis: null, matching: [], pilot_logged: false };
  const matching = PREFERRED_TAGS.filter((tag) => tags.includes(tag));
  if (matching.length) {
    return { material: true, excluded: null, tags, basis: 'preferred_tag', matching, pilot_logged: false };
  }
  if (diagnosisOnly(entry, tags)) {
    return { material: false, excluded: 'diagnosis', tags, basis: null, matching: [], pilot_logged: false };
  }
  const id = finiteId(entry && entry.id);
  if (id != null && pointers && pointers.closeVerification && pointers.closeVerification.has(id)) {
    return { material: true, excluded: null, tags, basis: 'close_verification', matching: [], pilot_logged: false };
  }
  if (id != null && pointers && pointers.layerTip && pointers.layerTip.has(id)) {
    return { material: true, excluded: null, tags, basis: 'layer_tip', matching: [], pilot_logged: false };
  }
  const fallback = fallbackTags(entry, tags);
  if (fallback) {
    return { material: true, excluded: null, tags, basis: 'fallback', matching: fallback, pilot_logged: true };
  }
  return { material: false, excluded: null, tags, basis: null, matching: [], pilot_logged: false };
}

function collectIds(text) {
  const ids = [];
  const body = String(text || '');
  // A year-month or a full date is not an id.
  const patterns = [
    /\bepisodic(?:[\s_-]*(?:id|entry|#))?[\s:#_-]*#?\s*(\d{1,12})\b(?!-\d{2}(?:-\d{2})?\b)/gi,
    /\brecord\s+id\s+#?\s*(\d{1,12})\b(?!-\d{2}(?:-\d{2})?\b)/gi
  ];
  for (const pattern of patterns) {
    for (const match of body.matchAll(pattern)) {
      const id = finiteId(match[1]);
      if (id != null) ids.push(id);
    }
  }
  return ids;
}

function isCloseHeading(line) {
  return /^#{1,6}\s/.test(line) && (/§\s*6\b/i.test(line) || /close verification/i.test(line));
}

/** The label starts the line. A bullet or a bold mark may precede it. */
function isInlineCloseLine(line) {
  const text = String(line).replace(/^\s+/, '');
  const unbulleted = text.replace(/^(?:[-*+]|\d+[.)])\s+/, '');
  const unbold = unbulleted.replace(/^(?:\*\*|__)/, '').replace(/^\s+/, '');
  return /^close verification\b/i.test(unbold);
}

/**
 * Close-verification sites in document order. A newest-first handoff puts the
 * current session first and keeps older `## §6` tables below it. The first
 * site is the one in force: an inline "Close verification" line, or a §6
 * table. A retained table further down is not the claim.
 */
function closeVerificationSites(content) {
  const lines = String(content || '').split(/\n/);
  const sites = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isCloseHeading(line)) {
      const section = [line];
      let j = i + 1;
      while (j < lines.length && !/^#{1,6}\s/.test(lines[j])) section.push(lines[j++]);
      const sessionLine = section.find((row) => /session record/i.test(row));
      const ids = sessionLine ? collectIds(sessionLine) : collectIds(section.join('\n'));
      if (ids.length) sites.push(ids[0]);
      i = j - 1;
      continue;
    }
    if (isInlineCloseLine(line)) {
      const ids = collectIds(line);
      if (ids.length) sites.push(ids[0]);
    }
  }
  return sites;
}

/**
 * What the served HANDOFF claims is current.
 * 1. The episodic id in the first close verification in the document. On a
 *    newest-first handoff that is the current session: an inline line that
 *    starts with "Close verification" (a bullet or bold mark may precede it),
 *    or a §6 table when that is the first close verification. A mention later
 *    in a line is not a close verification. A later retained §6 table is not
 *    used. A year-month or a full date, such as 2026-11 or 2026-11-06, is not an id.
 * 2. Else the episodic id stored on the session that wrote this HANDOFF version.
 * 3. Else the highest episodic id explicitly cited in the body.
 * 4. Else updated_at. A version number alone is not a claim that can see lag.
 */
export function handoffClaim(handoff, sessions = []) {
  const content = handoff && typeof handoff.content === 'string' ? handoff.content : '';
  const sites = closeVerificationSites(content);
  if (sites.length) return { cited_episodic_id: sites[0], claim_basis: 'close_receipt' };
  const version = finiteId(handoff && handoff.version);
  if (version != null) {
    const tied = [];
    for (const row of sessions || []) {
      if (!row || row.handoff !== true) continue;
      if (finiteId(row.handoff_version) !== version) continue;
      const id = finiteId(row.episodic_id);
      if (id != null) tied.push(id);
    }
    if (tied.length) return { cited_episodic_id: Math.max(...tied), claim_basis: 'session_graph' };
  }
  const cited = collectIds(content);
  if (cited.length) return { cited_episodic_id: Math.max(...cited), claim_basis: 'body_citation' };
  if (epochMs(handoff && handoff.updated_at) != null) return { cited_episodic_id: null, claim_basis: 'updated_at' };
  return { cited_episodic_id: null, claim_basis: 'version_only' };
}

/**
 * The title and the first body section. A level-1 title does not end the
 * section. The next heading at that body level, or higher, does. A retained
 * section below that line is not the current note.
 */
function currentSection(content) {
  const text = String(content || '');
  const lines = text.split('\n');
  let bodyAt = -1;
  let bodyLevel = 0;
  let sawTitle = false;
  for (let i = 0; i < lines.length; i++) {
    const match = /^(#{1,6})\s+\S/.exec(lines[i]);
    if (!match) continue;
    const level = match[1].length;
    if (!sawTitle && level === 1 && bodyAt < 0) {
      sawTitle = true;
      continue;
    }
    if (bodyAt < 0) {
      bodyAt = i;
      bodyLevel = level;
      continue;
    }
    if (level <= bodyLevel) return lines.slice(0, i).join('\n');
  }
  return text;
}

function documentedNoOp(content) {
  return /documented\s+no-?op\b/i.test(currentSection(content));
}

function pointerSets(entries, sessions, claimId) {
  const closeVerification = new Set();
  const layerTip = new Set();
  if (claimId != null) closeVerification.add(claimId);
  for (const row of sessions || []) {
    if (!row || row.closed !== true) continue;
    const id = finiteId(row.episodic_id);
    if (id != null) closeVerification.add(id);
  }
  for (const entry of entries || []) {
    const md = parseMetadata(entry && entry.metadata);
    const tip = finiteId(md.layer_tip != null ? md.layer_tip : entry && entry.layer_tip);
    if (tip != null) layerTip.add(tip);
  }
  return { closeVerification, layerTip };
}

function sha256Of(handoff) {
  if (handoff && typeof handoff.sha256 === 'string' && /^[a-f0-9]{64}$/i.test(handoff.sha256)) {
    return { sha256: handoff.sha256.toLowerCase(), sha256_source: 'stored' };
  }
  if (handoff && typeof handoff.content === 'string') {
    return {
      sha256: crypto.createHash('sha256').update(handoff.content, 'utf8').digest('hex'),
      sha256_source: 'computed'
    };
  }
  return { sha256: null, sha256_source: null };
}

function envelope(status, extra = {}) {
  const blockIgnored = extra.block_requested === true;
  return {
    gate: 'continuity-currency',
    flag: CONTINUITY_CURRENCY_FLAG,
    phase: 1,
    status,
    does_not_block: true,
    block_enabled: false,
    block_ignored: blockIgnored,
    ...(blockIgnored ? {
      block_note: 'The block stays off. EMET_CONTINUITY_CURRENCY_BLOCK is not applied.'
    } : {}),
    ...extra,
    does_not_block: true,
    block_enabled: false
  };
}

function handoffFields(handoff, claim) {
  const digest = sha256Of(handoff);
  return {
    doc_id: (handoff && handoff.doc_id) || handoffDoc(),
    version: handoff && handoff.version != null ? handoff.version : null,
    sha256: digest.sha256,
    sha256_source: digest.sha256_source,
    updated_at: isoFromMs(epochMs(handoff && handoff.updated_at)),
    cited_episodic_id: claim ? claim.cited_episodic_id : null,
    claim_basis: claim ? claim.claim_basis : null
  };
}

function tipFields(row) {
  if (!row) return null;
  return {
    id: row.id,
    timestamp: row.timestamp,
    tags: row.tags,
    basis: row.basis,
    matching_tags: row.matching,
    summary: row.summary
  };
}

function hostAction(fields, tipId, citedId) {
  const version = fields.version == null ? 'the version in force' : String(fields.version);
  const digest = fields.sha256 ? `sha256 ${fields.sha256}` : 'sha256 was not on the stored revision; read_doc it before writing';
  const when = fields.updated_at ? `, updated_at ${fields.updated_at}` : '';
  const cite = tipId == null ? 'the live material tip' : `episodic ${tipId}`;
  const from = citedId == null ? 'No episodic id is cited on the handoff.' : `The handoff cites episodic ${citedId}.`;
  return `Rewrite ${fields.doc_id} whole with supersedes set to ${version} (${digest}${when}). ${from} Cite ${cite} in §6 close verification and name each newer material entry. Do not patch the record. The server does not rewrite HANDOFF or STATE.`;
}

/**
 * Pure comparison. `handoff` is the document in force, or null when it is
 * absent. `entries` are episodic rows. `sessions` are session-graph rows
 * (`episodic_id`, `handoff`, `handoff_version`). Nothing in the arguments
 * is modified.
 */
export function assessContinuityCurrency({ handoff = null, entries = [], sessions = [], now = Date.now(), blockRequested = false, openEpisodicIds = null } = {}) {
  const nowMs = epochMs(now) || Date.now();
  const block_requested = blockRequested === true;
  const openIds = openEpisodicIds instanceof Set ? openEpisodicIds : null;
  if (!handoff || typeof handoff.content !== 'string') {
    return envelope('no_handoff', {
      block_requested,
      handoff: null,
      material_tip: null,
      documented_no_op: false
    });
  }
  let claim = handoffClaim(handoff, sessions);
  if (openIds && claim.cited_episodic_id != null && openIds.has(claim.cited_episodic_id)) {
    claim = { cited_episodic_id: null, claim_basis: 'open_session' };
  }
  const pointers = pointerSets(entries, sessions, claim.cited_episodic_id);
  if (openIds) for (const id of openIds) pointers.closeVerification.delete(id);
  const classified = [];
  for (const entry of entries || []) {
    const id = finiteId(entry && entry.id);
    if (openIds && id != null && openIds.has(id)) continue;
    const row = classifyEpisodic(entry, pointers, nowMs);
    if (!row.material) continue;
    if (id == null) continue;
    classified.push({
      id,
      timestamp: isoFromMs(epochMs(entry.timestamp)),
      timestamp_ms: epochMs(entry.timestamp),
      tags: row.tags,
      basis: row.basis,
      matching: row.matching,
      pilot_logged: row.pilot_logged === true,
      summary: oneLine(entry.content || entry.context || '')
    });
  }
  classified.sort((a, b) => a.id - b.id);
  const tip = classified.length ? classified[classified.length - 1] : null;
  const claimMs = epochMs(handoff.updated_at);
  let newer = [];
  if (claim.cited_episodic_id != null) {
    newer = classified.filter((row) => row.id > claim.cited_episodic_id);
  } else if (claim.claim_basis === 'updated_at' && claimMs != null) {
    newer = classified.filter((row) => row.timestamp_ms != null && row.timestamp_ms > claimMs);
  }
  const lag = newer.length > 0 && claim.claim_basis !== 'version_only';
  const noOp = documentedNoOp(handoff.content);
  const fields = handoffFields(handoff, claim);
  const fallbackAll = classified.filter((row) => row.pilot_logged).sort((a, b) => b.id - a.id);
  const fallbackLogged = fallbackAll.slice(0, NEWER_LIST_CAP).map((row) => ({
    id: row.id,
    timestamp: row.timestamp,
    tags: row.matching,
    summary: row.summary
  }));
  const shared = {
    block_requested,
    handoff: fields,
    material_tip: tipFields(tip),
    documented_no_op: noOp,
    fallback_logged: fallbackLogged,
    fallback_logged_truncated: fallbackAll.length > fallbackLogged.length
  };
  if (!lag) {
    return envelope(noOp ? 'no_op' : 'current', shared);
  }
  const listed = [...newer].sort((a, b) => b.id - a.id).slice(0, NEWER_LIST_CAP).map((row) => ({
    id: row.id,
    timestamp: row.timestamp,
    tags: row.tags,
    matching_tags: row.matching,
    basis: row.basis,
    summary: row.summary
  }));
  if (tip && newer.some((row) => row.id === tip.id) && !listed.some((row) => row.id === tip.id)) {
    listed.push({
      id: tip.id,
      timestamp: tip.timestamp,
      tags: tip.tags,
      matching_tags: tip.matching,
      basis: tip.basis,
      summary: tip.summary
    });
  }
  const matching = [];
  for (const row of newer) {
    for (const tag of row.matching) if (!matching.includes(tag)) matching.push(tag);
  }
  const blockEligible = newer.some((row) => row.basis !== 'fallback');
  return envelope('warn', {
    ...shared,
    matching_tags: matching,
    lag_span: {
      cited_episodic_id: claim.cited_episodic_id,
      claim_updated_at: fields.updated_at,
      material_tip_id: tip ? tip.id : null,
      material_tip_timestamp: tip ? tip.timestamp : null,
      newer_material_count: newer.length,
      claim_basis: claim.claim_basis
    },
    newer_material: listed,
    newer_material_truncated: newer.length > listed.length,
    fallback_only: !blockEligible,
    block_eligible: blockEligible,
    recommended_host_action: hostAction(fields, tip ? tip.id : null, claim.cited_episodic_id)
  });
}

export function continuityCurrencyUnreadable() {
  return envelope('unreadable', {
    block_requested: continuityCurrencyBlockRequested(),
    handoff: null,
    material_tip: null,
    documented_no_op: false,
    note: 'The continuity-currency comparison could not be read. Nothing was blocked and nothing was written.'
  });
}

function projectRow(row, projection) {
  const out = {};
  if (!row || typeof row !== 'object') return out;
  for (const [key, flag] of Object.entries(projection || {})) {
    if (!flag || key === '_id') continue;
    if (Object.prototype.hasOwnProperty.call(row, key)) out[key] = row[key];
  }
  return out;
}

function dedupeById(rows, nowMs) {
  const index = new Map();
  const out = [];
  const excluded = (row) => hardExclude(row, tagsOf(row), nowMs) != null;
  for (const row of rows || []) {
    const id = finiteId(row && row.id);
    if (id == null) {
      out.push(row);
      continue;
    }
    if (!index.has(id)) {
      index.set(id, out.length);
      out.push(row);
      continue;
    }
    const at = index.get(id);
    if (excluded(out[at]) && !excluded(row)) out[at] = row;
  }
  return out;
}

/**
 * One find. The projection is applied again so a driver that returns extra
 * fields still feeds the gate only the fields the comparison uses, including
 * the episodic text. Rows that share an id are kept once, and the copy that
 * is not excluded wins.
 */
async function readProjected(collection, query, projection, sort, nowMs) {
  let cursor = collection.find(query, { projection });
  if (!cursor || typeof cursor.toArray !== 'function') return [];
  if (sort && typeof cursor.sort === 'function') cursor = cursor.sort(sort);
  const rows = await cursor.toArray();
  if (!Array.isArray(rows)) return [];
  return dedupeById(rows.map((row) => projectRow(row, projection)), nowMs);
}

/**
 * Read the hub handoff, the episodic layer, and session-graph pointers.
 * Find and findOne only. No insert, update, or delete.
 */
export async function loadContinuityCurrency(db, options = {}) {
  const docId = options.docId || handoffDoc();
  const prefix = options.prefix || COLLECTION_PREFIX;
  const nowMs = epochMs(options.now) || Date.now();
  const handoff = await db.collection('documents').findOne({ doc_id: docId });
  const episodic = await readProjected(
    db.collection(`${prefix}episodic`),
    EPISODIC_QUERY,
    EPISODIC_PROJECTION,
    { id: -1 },
    nowMs
  );
  let sessions = [];
  try {
    sessions = await readProjected(
      db.collection(`${prefix}sessions`),
      SESSION_QUERY,
      SESSION_PROJECTION,
      { episodic_id: -1 },
      nowMs
    );
  } catch {
    sessions = [];
  }
  const assessed = assessContinuityCurrency({
    handoff: handoff ? {
      doc_id: handoff.doc_id,
      version: handoff.version ?? null,
      sha256: handoff.sha256 || null,
      updated_at: handoff.updated_at ?? null,
      content: typeof handoff.content === 'string' ? handoff.content : ''
    } : null,
    entries: episodic,
    sessions,
    now: options.now,
    blockRequested: options.blockRequested != null ? options.blockRequested === true : continuityCurrencyBlockRequested()
  });
  if (tagHandoffMode() === 'off') return assessed;
  try {
    return await perTagCurrency(db, assessed, episodic, sessions, prefix, nowMs, options);
  } catch {
    return { ...assessed, per_tag_unreadable: true, does_not_block: true, block_enabled: false };
  }
}

async function perTagCurrency(db, assessed, episodic, sessions, prefix, nowMs, options) {
  const tags = writeTagRegistry();
  const hub = hubTag();
  const writeTags = [...new Set([...(hub ? [hub] : []), ...tags])];
  let openRows = [];
  try {
    const cutoff = new Date(nowMs - OPEN_SESSION_LOOKBACK_MS);
    openRows = await db.collection(`${prefix}sessions`).find(
      {
        closed: { $ne: true },
        $or: [
          { updated_at: { $gte: cutoff } },
          { opened_at: { $gte: cutoff } }
        ]
      },
      { projection: { tag: 1, source: 1, channel: 1, opened_at: 1, updated_at: 1, episodic: 1, episodic_id: 1, closed: 1 } }
    ).toArray();
  } catch {
    openRows = [];
  }
  const openSessions = openSessionsFromRows(openRows, nowMs);
  const openIds = new Set();
  for (const row of openRows || []) {
    const id = finiteId(row && row.episodic_id);
    if (id != null) openIds.add(id);
  }
  const { byTag, unattributed } = partitionEpisodic(applyContinuitySourceAlias(episodic), writeTags);
  const per_tag = [];
  for (const tag of writeTags) {
    let doc = null;
    try {
      if (hub && tag === hub) {
        doc = await db.collection('documents').findOne({ doc_id: handoffDoc() });
      } else {
        doc = await db.collection('documents').findOne({ doc_id: `HANDOFF/${tag}.md` });
        if (!doc) doc = await db.collection('documents').findOne({ doc_id: `bots/${tag}/HANDOFF.md` });
      }
    } catch {
      doc = null;
    }
    const one = assessContinuityCurrency({
      handoff: doc && typeof doc.content === 'string' ? {
        doc_id: doc.doc_id, version: doc.version ?? null, sha256: doc.sha256 || null,
        updated_at: doc.updated_at ?? null, content: doc.content
      } : null,
      entries: byTag.get(tag) || [],
      sessions,
      now: options.now,
      blockRequested: false,
      openEpisodicIds: openIds
    });
    per_tag.push({
      tag,
      status: one.status,
      does_not_block: true,
      handoff_doc: doc && doc.doc_id ? doc.doc_id : null,
      cited_episodic_id: one.handoff && one.handoff.cited_episodic_id
    });
  }
  const split = splitUnattributedMaterial(unattributed, nowMs);
  const hours = staleOpenHours();
  const stale_open = openSessions.filter((row) => {
    const since = Date.parse(row.since);
    return Number.isFinite(since) && nowMs - since > hours * 3600000;
  });
  const cutoffMs = epochMs(TAG_ATTRIBUTION_BEGAN);
  const noted = notedLegacyRows(byTag);
  const statuses = [];
  for (const row of per_tag) {
    if (row.status === 'no_handoff' && !tagHasMaterialOnOrAfterCutoff(byTag.get(row.tag), row.tag, nowMs, cutoffMs)) continue;
    statuses.push(row.status);
  }
  if (split.unattributed.length) statuses.push('warn');
  const overall = worstStatus([assessed.status, ...statuses]);
  return {
    ...assessed,
    status: overall,
    per_tag,
    overall_status: overall,
    in_progress: openSessions.map((row) => ({ tag: row.tag, since: row.since, session_id: row.session_id, pointer: false, lag: false })),
    stale_open,
    legacy_pre_attribution: {
      reading: LEGACY_PRE_ATTRIBUTION,
      count: split.legacy.length,
      ids: split.legacy,
      cutoff: TAG_ATTRIBUTION_BEGAN,
      cutoff_basis: LEGACY_CUTOFF_BASIS
    },
    noted_legacy: {
      count: noted.length,
      rows: noted
    },
    unattributed_material: split.unattributed.filter((id) => id != null),
    does_not_block: true,
    block_enabled: false
  };
}

function storedSource(entry) {
  const md = entry && entry.metadata;
  if (md && typeof md === 'object' && typeof md.source === 'string') return md.source.trim();
  if (typeof md === 'string') {
    const match = md.match(/"source"\s*:\s*"([^"]+)"/);
    if (match) return match[1].trim();
  }
  return null;
}

/** A copy of the row with the alias source. The caller's row is left as stored. */
function aliasEntry(entry, source, alias) {
  const md = entry.metadata;
  if (md && typeof md === 'object') return { ...entry, metadata: { ...md, source: alias } };
  if (typeof md !== 'string') return entry;
  const match = md.match(/"source"\s*:\s*"([^"]+)"/);
  if (!match || match[1].trim() !== source) return entry;
  const at = match.index + match[0].indexOf(match[1]);
  const metadata = md.slice(0, at) + alias + md.slice(at + match[1].length);
  return { ...entry, metadata };
}

function applyContinuitySourceAlias(entries) {
  const out = [];
  for (const entry of entries || []) {
    const source = storedSource(entry);
    const alias = source != null ? CONTINUITY_SOURCE_ALIAS[source] : null;
    out.push(alias ? aliasEntry(entry, source, alias) : entry);
  }
  return out;
}

/**
 * Material rows already split out of the registered write tags.
 * The timestamp is read before the id. A time before TAG_ATTRIBUTION_BEGAN
 * is legacy, and a missing id is still legacy: it is not listed and it does
 * not warn. A missing id at or after the cutoff is pushed as null so the
 * row still warns. A missing timestamp, or one that does not parse, warns.
 */
export function splitUnattributedMaterial(entries, nowMs = Date.now(), cutoffMs = epochMs(TAG_ATTRIBUTION_BEGAN)) {
  const legacy = [];
  const unattributed = [];
  for (const entry of entries || []) {
    const row = classifyEpisodic(entry, { closeVerification: new Set(), layerTip: new Set() }, nowMs);
    if (!row.material) continue;
    const written = epochMs(entry && entry.timestamp);
    const id = finiteId(entry && entry.id);
    if (cutoffMs != null && written != null && written < cutoffMs) {
      if (id != null) legacy.push(id);
      continue;
    }
    unattributed.push(id);
  }
  return { legacy, unattributed };
}

/**
 * A registered tag has material episodic work that counts toward a missing
 * handoff: a readable time at or after the cutoff, or no readable timestamp.
 */
function isNotedLegacy(tag, id) {
  return NOTED_LEGACY.some((row) => row.tag === tag && row.id === id);
}

function notedLegacyRows(byTag) {
  const rows = [];
  for (const note of NOTED_LEGACY) {
    const entries = byTag.get(note.tag) || [];
    const present = entries.some((entry) => finiteId(entry && entry.id) === note.id);
    if (present) rows.push({ id: note.id, tag: note.tag, noted: note.noted, reason: note.reason });
  }
  return rows;
}

function tagHasMaterialOnOrAfterCutoff(entries, tag, nowMs, cutoffMs) {
  for (const entry of entries || []) {
    const id = finiteId(entry && entry.id);
    if (id != null && isNotedLegacy(tag, id)) continue;
    const row = classifyEpisodic(entry, { closeVerification: new Set(), layerTip: new Set() }, nowMs);
    if (!row.material) continue;
    const written = epochMs(entry && entry.timestamp);
    if (written == null || cutoffMs == null || written >= cutoffMs) return true;
  }
  return false;
}
