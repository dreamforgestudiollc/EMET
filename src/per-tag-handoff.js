/**
 * EMET - Enduring Memory & Epistemic Tiers
 * Copyright (c) 2026 Dreamforge Studio LLC
 *
 * Licensed under the MIT License - see LICENSE
 *
 * Per-tag handoffs. One server, one store. The flag is off unless the
 * value is warn or enforce. Off leaves every existing door as it is.
 * Warn refuses the new HANDOFF/ prefix at once and logs the board-row
 * rule and the gap on the existing records. Enforce refuses those too.
 * The merged view is computed on read and is not a record.
 */

import crypto from 'node:crypto';
import { setting } from './env.js';
import { ValidationError } from './validation.js';
import { currentActor, declaredAttribution } from './persons.js';
import { isBotTagLocal, approvedTags } from './attribution.js';
import { COLLECTION_PREFIX } from './database.js';

export const TAG_HANDOFF_FLAG = 'EMET_TAG_HANDOFFS';
export const HUB_TAG_FLAG = 'EMET_HUB_TAG';
export const AGING_DAYS_FLAG = 'EMET_HANDOFF_AGING_DAYS';
export const STALE_OPEN_HOURS_FLAG = 'EMET_STALE_OPEN_HOURS';

const TAG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ROW_RE = /\bB-\d{3,}\b/;
const STAMP_SHA = /^[a-f0-9]{64}$/;

export function tagHandoffMode(raw = setting('TAG_HANDOFFS', 'off')) {
  const value = String(raw ?? 'off').trim().toLowerCase();
  if (value === 'warn' || value === 'enforce') return value;
  return 'off';
}

export function hubTag() {
  const value = String(setting('HUB_TAG', '') ?? '').trim();
  return value || null;
}

/** The flag on with no hub tag is a configuration refusal. Reads stay available. */
export function requireHubTag() {
  const mode = tagHandoffMode();
  if (mode === 'off') return hubTag();
  const hub = hubTag();
  if (!hub) {
    throw new ValidationError(
      'EMET_TAG_HANDOFFS is on and EMET_HUB_TAG is not set. Nothing was written.',
      { code: 'EMET-CFG-015' }
    );
  }
  return hub;
}

/** Handoff ids a close may name for this tag. Null while the flag is off. The hub's only id is HANDOFF.md. */
export function handoffIdsFor(tag) {
  if (!tag || tagHandoffMode() === 'off') return null;
  if (hubTag() && tag === hubTag()) return [setting('HANDOFF_DOC', 'HANDOFF.md')];
  const ids = [`HANDOFF/${tag}.md`];
  if (isBotTagLocal(tag)) ids.push(`bots/${tag}/HANDOFF.md`);
  return ids;
}

export const OPEN_SESSION_LOOKBACK_MS = 30 * 86400000;

export function handoffAgingDays() {
  const n = Number(setting('HANDOFF_AGING_DAYS', '7'));
  return Number.isFinite(n) && n > 0 ? n : 7;
}

export function staleOpenHours() {
  const n = Number(setting('STALE_OPEN_HOURS', '24'));
  return Number.isFinite(n) && n > 0 ? n : 24;
}

export function writeTagRegistry() {
  const env = String(setting('SOURCE_TAGS') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return [...new Set([...env, ...approvedTags()])];
}

/**
 * The credential is the sub-key stamp, the bound login, or the owner door
 * writing its own tag. A declared tag is not the credential.
 */
export function credentialForWrite(updatedBy) {
  const actor = currentActor();
  const attr = declaredAttribution();
  const http = actor && actor.transport === 'http';
  const basis = attr && attr.basis;
  if (http && basis === 'subkey' && attr.effective) {
    return { tag: attr.effective, claimedOnly: false, kind: 'subkey' };
  }
  if (http && (basis === 'declared' || basis === 'auto' || basis === 'legacy')) {
    return { tag: null, claimedOnly: true, kind: basis };
  }
  if (http && attr && attr.login) {
    return { tag: attr.login, claimedOnly: false, kind: 'bound' };
  }
  if (http && actor.sourceTag) {
    return { tag: actor.sourceTag, claimedOnly: false, kind: 'bound' };
  }
  const tag = (typeof updatedBy === 'string' && updatedBy.trim()) || setting('SOURCE_TAG') || null;
  return { tag: tag || null, claimedOnly: false, kind: 'owner-door' };
}

export function parseHandoffId(docId, ownerPerson = 'owner') {
  if (typeof docId !== 'string' || !docId) return { kind: 'other' };
  if (docId === 'HANDOFF.md' || docId === setting('HANDOFF_DOC', 'HANDOFF.md')) return { kind: 'hub' };
  if (docId.startsWith('handoffs/')) return { kind: 'draft-name' };
  const short = /^HANDOFF\/([^/]+)\.md$/.exec(docId);
  if (short) {
    return { kind: 'short', tag: short[1], person: ownerPerson, storedId: docId };
  }
  const long = /^HANDOFF\/([^/]+)\/([^/]+)\.md$/.exec(docId);
  if (long) return { kind: 'long', person: long[1], tag: long[2] };
  if (docId.startsWith('HANDOFF/')) return { kind: 'malformed' };
  const alias = /^bots\/([^/]+)\/HANDOFF\.md$/.exec(docId);
  if (alias) return { kind: 'alias', tag: alias[1], person: ownerPerson, storedId: `HANDOFF/${alias[1]}.md` };
  return { kind: 'other' };
}

export function isTagHandoffDoc(docId) {
  return parseHandoffId(docId).kind === 'short';
}

function personSet(personIds, ownerPerson) {
  const ids = new Set();
  if (ownerPerson) ids.add(String(ownerPerson));
  for (const id of personIds || []) if (id) ids.add(String(id));
  return ids;
}

function refuse(message, code) {
  const text = `${message} Nothing was written.`;
  if (code === 'EMET-DOC-084') throw new ValidationError(text, { code: 'EMET-DOC-084' });
  if (code === 'EMET-DOC-085') throw new ValidationError(text, { code: 'EMET-DOC-085' });
  if (code === 'EMET-DOC-086') throw new ValidationError(text, { code: 'EMET-DOC-086' });
  throw new ValidationError(text, { code: 'EMET-DOC-087' });
}

/**
 * Write check for a handoff id. `mode` off returns immediately.
 * The new prefix is refused in warn and in enforce. The gap on HANDOFF.md
 * and on another tag's bot folder warns in warn and refuses in enforce.
 */
export function authorizeHandoffWrite({
  docId,
  tool = 'write_doc',
  mode = tagHandoffMode(),
  credentialTag = null,
  claimedOnly = false,
  isBot = false,
  isHub = false,
  registered = true,
  ownerPerson = 'owner',
  personIds = []
} = {}) {
  if (mode === 'off') return { ok: true };
  const parsed = parseHandoffId(docId, ownerPerson);
  const people = personSet(personIds, ownerPerson);
  const where = `${tool}: ${docId}`;

  if (parsed.kind === 'draft-name') {
    refuse(`${where} is not a handoff id. A write tag's handoff is HANDOFF/<tag>.md.`, 'EMET-DOC-084');
  }
  if (parsed.kind === 'malformed') {
    refuse(`${where} is not HANDOFF/<tag>.md.`, 'EMET-DOC-086');
  }
  if (parsed.kind === 'long') {
    refuse(`${where} uses the reserved person segment. Phase 1 stores HANDOFF/<tag>.md, which resolves to the owner person. A two-segment id is refused.`, 'EMET-DOC-086');
  }

  const onNewPrefix = parsed.kind === 'short';
  if (onNewPrefix && claimedOnly) {
    refuse(`${where} is a handoff and this write is a claimed tag, not a credential. A claimed tag cannot own a handoff.`, 'EMET-DOC-087');
  }
  if (onNewPrefix && people.has(parsed.tag)) {
    refuse(`${where} uses a tag equal to a person id. A tag is not a person.`, 'EMET-DOC-086');
  }
  if (onNewPrefix && !TAG_RE.test(parsed.tag)) {
    refuse(`${where} is not a tag handoff id.`, 'EMET-DOC-086');
  }
  if (onNewPrefix && isHub && parsed.tag === credentialTag) {
    if (tool === 'retire_doc') return { ok: true, tag: parsed.tag, cleanup: true };
    refuse(`${where} is the hub tag. The hub handoff is HANDOFF.md.`, 'EMET-DOC-084');
  }
  if (onNewPrefix) {
    if (!credentialTag || parsed.tag !== credentialTag) {
      refuse(`${where} belongs to ${parsed.tag}. This credential is ${credentialTag || 'missing'} and cannot write another tag's handoff.`, 'EMET-DOC-084');
    }
    if (!registered) {
      refuse(`${where} needs a registered credential.`, 'EMET-DOC-084');
    }
    return { ok: true, tag: parsed.tag, person: ownerPerson, storedId: parsed.storedId };
  }

  if (parsed.kind === 'alias' && parsed.tag !== credentialTag) {
    const message = `${where} is ${parsed.tag}'s handoff. This credential is ${credentialTag || 'missing'}.`;
    if (mode === 'warn' && !isHub) return { ok: true, warning: `${message} Warn only: the write is kept. Enforce refuses it.` };
    refuse(message, 'EMET-DOC-084');
  }
  if (parsed.kind === 'alias' && people.has(parsed.tag)) {
    refuse(`${where} uses a tag equal to a person id. A tag is not a person.`, 'EMET-DOC-086');
  }

  if (parsed.kind === 'hub' && !isHub) {
    const message = `${where} is the hub handoff. Only the hub tag writes it.`;
    if (isBot) return { ok: true };
    if (mode === 'warn') return { ok: true, warning: `${message} Warn only: the write is kept. Enforce refuses it.` };
    refuse(message, 'EMET-DOC-084');
  }
  const nested = /^bots\/([^/]+)\/(.+)$/.exec(String(docId || ''));
  if (nested && nested[1] !== credentialTag && nested[2] !== 'HANDOFF.md') {
    const message = `${where} is in ${nested[1]}'s folder. This credential is ${credentialTag || 'missing'}.`;
    if (mode === 'warn') return { ok: true, warning: `${message} Warn only: the write is kept. Enforce refuses it.` };
    refuse(message, 'EMET-DOC-084');
  }
  return { ok: true };
}

export function guardTagHandoff(docId, updatedBy, tool) {
  const mode = tagHandoffMode();
  if (mode === 'off') return { ok: true };
  requireHubTag();
  const credential = credentialForWrite(updatedBy);
  const tag = credential.tag;
  const registry = writeTagRegistry();
  const hub = hubTag();
  const actor = currentActor();
  return authorizeHandoffWrite({
    docId,
    tool,
    mode,
    credentialTag: tag,
    claimedOnly: credential.claimedOnly,
    isBot: !!(tag && isBotTagLocal(tag)),
    isHub: !!(hub && tag === hub),
    registered: registry.length === 0 || (!!tag && registry.includes(tag)),
    ownerPerson: (actor && actor.personId) || 'owner',
    personIds: []
  });
}

function sectionBodies(text) {
  const sections = new Map();
  let key = null;
  const buf = [];
  const flush = () => {
    if (key) sections.set(key, buf.join('\n'));
    buf.length = 0;
  };
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = line.match(/^##\s+§(\d+)\b/);
    if (match) { flush(); key = match[1]; }
    else if (key) buf.push(line);
  }
  flush();
  return sections;
}

function tableRows(body) {
  const lines = String(body || '').split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim().startsWith('|'));
  if (start < 0) return [];
  const raw = [];
  for (let i = start; i < lines.length; i++) {
    if (!lines[i].trim().startsWith('|')) break;
    raw.push(lines[i]);
  }
  if (raw.length < 2) return [];
  const header = raw[0].trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim().toLowerCase());
  const idAt = header.findIndex((cell) => cell === 'id' || cell === 'row');
  const rows = [];
  for (const line of raw.slice(1)) {
    const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
    if (cells.every((cell) => /^:?-{3,}:?$/.test(cell))) continue;
    const idCell = (idAt >= 0 ? cells[idAt] : cells[0]) || '';
    const id = (idCell.match(ROW_RE) || [])[0] || null;
    if (!id) continue;
    const stateAt = header.findIndex((cell) => cell === 'state' || cell.startsWith('state'));
    const nextAt = header.findIndex((cell) => cell.startsWith('next'));
    const statusAt = header.findIndex((cell) => cell === 'status' || cell.startsWith('status'));
    rows.push({
      id,
      line: line.trim(),
      state: stateAt >= 0 ? (cells[stateAt] || '') : (statusAt >= 0 ? (cells[statusAt] || '') : ''),
      next: nextAt >= 0 ? (cells[nextAt] || '') : ''
    });
  }
  return rows;
}

export function boardRows(content, sections = ['1', '2', '3', '4']) {
  const bodies = sectionBodies(content);
  const out = [];
  const seen = new Set();
  for (const num of sections) {
    for (const row of tableRows(bodies.get(num))) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      out.push({ ...row, section: num });
    }
  }
  return out;
}

export function closedRowIds(content) {
  const closed = new Set();
  for (const row of boardRows(content, ['3'])) {
    if (/^closed\b/i.test(row.state)) closed.add(row.id);
  }
  for (const row of boardRows(content, ['4'])) closed.add(row.id);
  return closed;
}

export function changedRowIds(previous, next) {
  const before = new Map(boardRows(previous).map((row) => [row.id, row.line]));
  const after = new Map(boardRows(next).map((row) => [row.id, row.line]));
  const changed = [];
  for (const [id, line] of before) {
    if (!after.has(id) || after.get(id) !== line) changed.push(id);
  }
  for (const id of after.keys()) {
    if (!before.has(id)) changed.push(id);
  }
  return changed;
}

/**
 * Rows already on the board when the map is first stored belong to the hub.
 * A row id that appears for the first time belongs to the credential that added it.
 */
export function seedOpeners(previousContent, stored, hub, at, version) {
  const map = stored && typeof stored === 'object' ? { ...stored } : {};
  const when = at || new Date(0).toISOString();
  for (const row of boardRows(previousContent)) {
    if (!map[row.id]) {
      map[row.id] = { opener_tag: hub, opened_at: when, opened_in_version: version || 0, seeded: true };
    }
  }
  return map;
}

export function applyOpeners(map, nextContent, writer, at, version) {
  const out = { ...map };
  const when = at || new Date(0).toISOString();
  for (const row of boardRows(nextContent)) {
    if (!out[row.id]) {
      out[row.id] = { opener_tag: writer, opened_at: when, opened_in_version: version };
    }
  }
  return out;
}

function stampHasAsOf(stamp) {
  return !!(stamp && typeof stamp === 'object' && typeof stamp.as_of === 'string' && stamp.as_of.trim());
}

/**
 * A tag patches a row it opened. The hub patches a foreign row only when
 * that row is marked in conflict and the write names the stamp it resolved.
 */
export function decideRowWrite({
  mode = tagHandoffMode(),
  writer = null,
  hub = null,
  openers = {},
  changed = [],
  conflicts = [],
  resolve = null,
  currentStamp = null
} = {}) {
  if (mode === 'off') return { ok: true, warnings: [], resolved: [] };
  const conflictSet = new Set(conflicts || []);
  const warnings = [];
  const resolved = [];
  const named = resolve && resolve.row_id;
  for (const id of changed) {
    const opener = openers && openers[id];
    const openerTag = opener && opener.opener_tag;
    if (!openerTag || openerTag === writer) continue;
    const marked = conflictSet.has(id);
    const hubResolving = writer && hub && writer === hub && marked && named === id;
    if (hubResolving) {
      if (!stampHasAsOf(resolve.handoff_view)) {
        refuse(`The conflict on ${id} was named without as_of. Re-read the handoff view.`, 'EMET-DOC-085');
      }
      if (currentStamp && resolve.handoff_view.view_sha256 !== currentStamp.view_sha256) {
        refuse(`The conflict on ${id} was named against a stamp that is not the view in force. Re-read the handoff view.`, 'EMET-DOC-085');
      }
      resolved.push(id);
      continue;
    }
    const message = `${id} was opened by ${openerTag}. ${writer || 'This credential'} patches only a row it opened.`;
    if (mode === 'warn') {
      warnings.push(`${message} Warn only: the write is kept. Enforce refuses it.`);
      continue;
    }
    refuse(message, 'EMET-DOC-085');
  }
  return { ok: true, warnings, resolved };
}

function dayOf(value) {
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString().slice(0, 10);
}

function msOf(value) {
  if (value instanceof Date) return value.getTime();
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function pictureLines(content) {
  const body = sectionBodies(content).get('1') || '';
  const table = tableRows(body);
  if (table.length) {
    return table.slice(0, 10).map((row) => ({
      row_id: row.id,
      state: row.state,
      next: row.next,
      text: row.line
    }));
  }
  const lines = [];
  for (const line of body.split(/\r?\n/)) {
    const match = line.match(/^\s*[-*]\s+(B-\d{3,})\s*\|\s*([^|]+?)\s*\|\s*(.+?)\s*$/);
    if (!match) continue;
    lines.push({ row_id: match[1], state: match[2].trim(), next: match[3].trim(), text: line.trim() });
    if (lines.length === 10) break;
  }
  return lines;
}

function closeLine(content) {
  const lines = String(content || '').split(/\r?\n/);
  for (const line of lines) {
    const text = line.replace(/^\s+/, '').replace(/^(?:[-*+]|\d+[.)])\s+/, '').replace(/^(?:\*\*|__)/, '');
    if (/^close verification\b/i.test(text)) return line.trim();
  }
  return null;
}

function canonicalId(doc) {
  if (doc && doc.canonical_id) return doc.canonical_id;
  const parsed = parseHandoffId(doc && doc.doc_id);
  if (parsed.kind === 'alias') return parsed.storedId;
  return doc && doc.doc_id;
}

export function stampSessions(list) {
  return (list || [])
    .filter((row) => row && row.tag && row.material === true && row.closed !== true)
    .map((row) => ({
      session_id: row.session_id || null,
      tag: row.tag,
      since: row.since || null,
      material: true
    }))
    .sort((a, b) => String(a.session_id).localeCompare(String(b.session_id)) || String(a.tag).localeCompare(String(b.tag)));
}

function sameStringList(a, b) {
  return JSON.stringify([...(a || [])].sort()) === JSON.stringify([...(b || [])].sort());
}

/**
 * The stamp names every input the view used. A resolve is accepted only when
 * those versions, settings, and sessions are still the ones in force, and the
 * bytes rebuild at the stamp's own as_of.
 */
export function stampInForce(stamp, live) {
  if (!stampHasAsOf(stamp)) return { ok: false, reason: 'stamp has no as_of' };
  const problems = [];
  const liveInputs = (live.inputs || [])
    .filter((doc) => doc && doc.doc_id && doc.version != null)
    .map((doc) => `${doc.doc_id}@v${doc.version}`);
  if (!sameStringList(stamp.inputs, liveInputs)) problems.push('inputs');
  const board = live.board || {};
  const boardLabel = `${board.doc_id || 'STATE.md'}@v${board.version != null ? board.version : 0}`;
  if (stamp.board !== boardLabel) problems.push('board');
  if (stamp.person !== live.person) problems.push('person');
  if (stamp.aging_days !== live.aging_days) problems.push('aging');
  if (stamp.stale_open_hours !== live.stale_open_hours) problems.push('stale-open');
  if (JSON.stringify(stamp.registry || []) !== JSON.stringify(live.registry || [])) problems.push('registry');
  if (JSON.stringify(stamp.open_sessions || null) !== JSON.stringify(stampSessions(live.open_sessions))) problems.push('open sessions');
  if (problems.length) return { ok: false, reason: problems.join(', ') };
  const rebuilt = buildView({
    inputs: live.inputs,
    board: live.board,
    as_of: stamp.as_of,
    person: live.person,
    open_sessions: live.open_sessions,
    registry: live.registry,
    aging_days: live.aging_days,
    stale_open_hours: live.stale_open_hours,
    settled: live.settled || null
  });
  if (!rebuilt.stamp || rebuilt.stamp.view_sha256 !== stamp.view_sha256) {
    return { ok: false, reason: 'view_sha256' };
  }
  return { ok: true, view: rebuilt };
}

/**
 * The merged view. Pure: the same inputs, board, and as_of return the same bytes.
 * A stamp without as_of is flagged and is not reproducible.
 */
export function buildView({
  inputs = [],
  board = null,
  as_of = null,
  person = 'owner',
  open_sessions = [],
  retired_tags = [],
  registry = [],
  aging_days = 7,
  stale_open_hours = 24,
  now = null,
  settled = null
} = {}) {
  const asOf = typeof as_of === 'string' && as_of.trim() ? as_of.trim() : null;
  const asOfMs = asOf ? msOf(asOf) : null;
  const flagged = !asOf;
  const boardRowsInOrder = boardRows(board && board.content, ['1', '3']);
  const order = boardRowsInOrder.map((row) => row.id);
  const closed = closedRowIds(board && board.content);
  const retired = new Set(retired_tags || []);
  const rank = new Map((registry || []).map((tag, index) => [tag, index]));
  const lines = [];
  for (const doc of inputs || []) {
    if (!doc || typeof doc.content !== 'string' || !doc.doc_id || doc.version == null) continue;
    const tag = doc.tag || parseHandoffId(doc.doc_id).tag;
    if (!tag) continue;
    const updated = msOf(doc.updated_at);
    const date = dayOf(doc.updated_at) || 'unknown-date';
    const cite = `[doc:${canonicalId(doc)}@v${doc.version} · ${tag} · ${date}]`;
    const ageMs = aging_days * 86400000;
    const aging = asOfMs != null && updated != null && asOfMs - updated > ageMs;
    for (const picture of pictureLines(doc.content)) {
      const rowClosed = closed.has(picture.row_id);
      const tagRetired = retired.has(tag);
      let currency = 'current';
      if (tagRetired || rowClosed) currency = 'superseded-context';
      else if (aging) currency = 'aging';
      lines.push({
        row_id: picture.row_id,
        on_board: order.includes(picture.row_id),
        tag,
        state: picture.state,
        next: picture.next,
        currency,
        updated_at: updated,
        cite,
        kind: 'picture'
      });
    }
    const verify = closeLine(doc.content);
    if (verify) {
      lines.push({
        row_id: null,
        on_board: false,
        tag,
        state: '',
        next: '',
        currency: retired.has(tag) ? 'superseded-context' : 'current',
        updated_at: updated,
        cite,
        kind: 'close',
        text: verify
      });
    }
  }
  const byRow = new Map();
  const loose = [];
  const closes = [];
  for (const line of lines) {
    if (line.kind === 'close') { closes.push(line); continue; }
    if (!line.on_board) { loose.push(line); continue; }
    if (!byRow.has(line.row_id)) byRow.set(line.row_id, []);
    byRow.get(line.row_id).push(line);
  }
  const sortLines = (list) => list.slice().sort((a, b) => {
    const time = (b.updated_at || 0) - (a.updated_at || 0);
    if (time !== 0) return time;
    return (rank.get(a.tag) ?? 999) - (rank.get(b.tag) ?? 999);
  });
  const inputIds = (inputs || [])
    .filter((doc) => doc && doc.doc_id && doc.version != null)
    .map((doc) => `${doc.doc_id}@v${doc.version}`)
    .sort();
  const settlementCovers = (id) => {
    const mark = settled && settled[id];
    if (!mark || !Array.isArray(mark.inputs)) return false;
    return mark.inputs.slice().sort().join('|') === inputIds.join('|');
  };
  const conflicts = [];
  for (const id of order) {
    const group = sortLines(byRow.get(id) || []);
    const latest = new Map();
    for (const line of group) if (!latest.has(line.tag)) latest.set(line.tag, line);
    const views = [...latest.values()];
    if (views.length >= 2) {
      const first = views[0];
      const disagree = views.some((line) => line.state !== first.state || line.next !== first.next);
      if (disagree && !settlementCovers(id)) conflicts.push(id);
    }
  }
  const conflictSet = new Set(conflicts);
  const progress = [];
  const stale = [];
  const sessions = stampSessions(open_sessions);
  const clock = asOfMs != null ? asOfMs : msOf(now);
  for (const session of sessions) {
    if (!session || session.closed === true || !session.tag || session.material !== true) continue;
    const since = session.since || session.opened_at;
    const sinceMs = msOf(since);
    const hours = clock != null && sinceMs != null ? (clock - sinceMs) / 3600000 : 0;
    const mark = hours > stale_open_hours;
    progress.push({ tag: session.tag, since: since || null, session_id: session.session_id || null, stale: mark });
    if (mark) stale.push({ tag: session.tag, since: since || null, session_id: session.session_id || null });
  }
  const blocks = [];
  blocks.push(`person: ${person}`);
  blocks.push(`as_of: ${asOf || ''}`);
  blocks.push(`board: ${board && board.doc_id ? board.doc_id : 'STATE.md'}@v${board && board.version != null ? board.version : 0}`);
  for (const id of order) {
    const group = sortLines(byRow.get(id) || []);
    if (!group.length) continue;
    blocks.push('');
    blocks.push(`## ${id}`);
    if (conflictSet.has(id)) blocks.push('- conflict');
    for (const line of group) {
      blocks.push(`- ${line.cite} state: ${line.state}; next: ${line.next}`);
      blocks.push(`  class: ${line.currency}`);
    }
  }
  const looseSorted = sortLines(loose);
  if (looseSorted.length) {
    blocks.push('');
    blocks.push('## not on the board yet');
    for (const line of looseSorted) {
      blocks.push(`- ${line.cite} ${line.row_id} state: ${line.state}; next: ${line.next}`);
      blocks.push(`  class: ${line.currency}`);
    }
  }
  if (closes.length) {
    blocks.push('');
    blocks.push('## close verification');
    for (const line of sortLines(closes)) blocks.push(`- ${line.cite} ${line.text}`);
  }
  if (progress.length) {
    blocks.push('');
    blocks.push('## in progress');
    for (const line of progress) {
      blocks.push(`- in progress by ${line.tag} since ${line.since || 'unknown'}`);
      if (line.stale) blocks.push('  stale-open');
    }
  }
  const text = `${blocks.join('\n')}\n`;
  const view_sha256 = crypto.createHash('sha256').update(text, 'utf8').digest('hex');
  const stamp = flagged ? null : {
    as_of: asOf,
    person,
    inputs: inputIds,
    board: `${board && board.doc_id ? board.doc_id : 'STATE.md'}@v${board && board.version != null ? board.version : 0}`,
    open_sessions: sessions,
    aging_days,
    stale_open_hours,
    registry: [...(registry || [])],
    view_sha256
  };
  return {
    text,
    stamp,
    conflicts,
    in_progress: progress,
    stale_open: stale,
    reproducible: !flagged,
    stamp_flagged: flagged,
    flag_reason: flagged ? 'stamp has no as_of' : null
  };
}

export function initViewText(view, limit = 40) {
  const lines = String(view && view.text || '').split('\n');
  if (lines.length <= limit) return view.text;
  const head = lines.slice(0, limit);
  head.push('read_doc the handoff documents named in the stamp.');
  return `${head.join('\n')}\n`;
}

export function stampWithoutAsOf(stamp) {
  if (!stamp || typeof stamp !== 'object') return { ok: false, flagged: true, reason: 'stamp has no as_of' };
  if (!stampHasAsOf(stamp)) return { ok: false, flagged: true, reason: 'stamp has no as_of' };
  if (!STAMP_SHA.test(String(stamp.view_sha256 || ''))) return { ok: false, flagged: true, reason: 'stamp has no view_sha256' };
  return { ok: true, flagged: false };
}

const STATUS_RANK = { unreadable: 0, warn: 1, no_handoff: 2, no_op: 3, current: 4 };

export function worstStatus(statuses) {
  let worst = 'current';
  for (const status of statuses || []) {
    if (STATUS_RANK[status] == null) continue;
    if (STATUS_RANK[status] < STATUS_RANK[worst]) worst = status;
  }
  return worst;
}

export function openSessionsFromRows(rows, nowMs = Date.now()) {
  const out = [];
  for (const row of rows || []) {
    if (!row || row.closed === true) continue;
    const tag = row.tag || row.source || row.channel || null;
    if (!tag) continue;
    const material = row.material === true || row.episodic === true || row.episodic_id != null;
    if (!material) continue;
    out.push({
      tag,
      since: row.opened_at || row.updated_at || null,
      session_id: row.session_id || row._id || null,
      material: true,
      closed: false,
      now: nowMs
    });
  }
  return out;
}

function sourceOf(entry) {
  const md = entry && entry.metadata;
  if (md && typeof md === 'object' && typeof md.source === 'string') return md.source.trim();
  if (typeof md === 'string') {
    const match = md.match(/"source"\s*:\s*"([^"]+)"/);
    if (match) return match[1].trim();
  }
  return null;
}

export function partitionEpisodic(entries, tags) {
  const known = new Set(tags || []);
  const byTag = new Map();
  const unattributed = [];
  for (const tag of known) byTag.set(tag, []);
  for (const entry of entries || []) {
    const source = sourceOf(entry);
    if (source && known.has(source)) byTag.get(source).push(entry);
    else unattributed.push(entry);
  }
  return { byTag, unattributed };
}

async function readDocs(db, query) {
  const rows = await db.collection('documents').find(query).toArray();
  return Array.isArray(rows) ? rows : [];
}

export async function boardWritePlan(col, {
  previous = null,
  next = '',
  writer = null,
  hub = null,
  mode = tagHandoffMode(),
  resolve = null,
  at = new Date().toISOString(),
  person = 'owner',
  docId = 'STATE.md',
  db = null
} = {}) {
  if (mode === 'off') return { openers: null, warnings: [], conflict_settled: null };
  requireHubTag();
  const stored = previous && previous.row_openers && typeof previous.row_openers === 'object' ? previous.row_openers : null;
  const openers = seedOpeners(previous && previous.content, stored, hub, at, previous && previous.version);
  const changed = changedRowIds(previous && previous.content, next);
  const loaded = db
    ? await loadHandoffInputs(db, { person, hub })
    : await loadHandoffInputsFromCol(col, { person, hub });
  const board = {
    doc_id: docId,
    version: previous && previous.version != null ? previous.version : 0,
    content: previous && previous.content ? previous.content : ''
  };
  const named = resolve && resolve.handoff_view;
  const asOf = stampHasAsOf(named) ? named.as_of.trim() : at;
  const priorSettled = previous && previous.conflict_settled && typeof previous.conflict_settled === 'object'
    ? previous.conflict_settled
    : null;
  const live = {
    inputs: loaded.inputs,
    board,
    person,
    open_sessions: loaded.open_sessions || [],
    registry: loaded.registry || [],
    aging_days: handoffAgingDays(),
    stale_open_hours: staleOpenHours(),
    settled: priorSettled
  };
  if (stampHasAsOf(named)) {
    const force = stampInForce(named, live);
    if (!force.ok) {
      refuse(`The conflict was named against a stamp that is not the view in force (${force.reason}). Re-read the handoff view.`, 'EMET-DOC-085');
    }
  }
  const view = buildView({ ...live, as_of: asOf });
  const decision = decideRowWrite({
    mode,
    writer,
    hub,
    openers,
    changed,
    conflicts: view.conflicts,
    resolve,
    currentStamp: view.stamp
  });
  const settled = { ...(priorSettled || {}) };
  const inputIds = (view.stamp && view.stamp.inputs) || [];
  for (const id of decision.resolved || []) settled[id] = { inputs: inputIds };
  return {
    openers: applyOpeners(openers, next, writer, at, (previous && previous.version ? previous.version : 0) + 1),
    warnings: decision.warnings,
    conflicts: view.conflicts,
    conflict_settled: settled
  };
}

async function loadHandoffInputsFromCol(col, { person, hub }) {
  const tags = writeTagRegistry();
  const hubName = hub === undefined ? hubTag() : hub;
  const wanted = new Set(tags);
  if (hubName) wanted.add(hubName);
  let docs = [];
  try {
    docs = await col.find({
      $or: [
        { doc_id: 'HANDOFF.md' },
        { doc_id: { $regex: '^HANDOFF/' } },
        { doc_id: { $regex: '^bots/[^/]+/HANDOFF\\.md$' } }
      ]
    }).toArray();
  } catch {
    docs = [];
  }
  const byTag = new Map();
  for (const doc of docs || []) {
    if (!doc || doc.retired === true) continue;
    const parsed = parseHandoffId(doc.doc_id, person);
    if (parsed.kind === 'hub' && hubName) {
      byTag.set(hubName, docInput(doc, hubName, 'HANDOFF.md'));
      continue;
    }
    if (parsed.kind !== 'short' && parsed.kind !== 'alias') continue;
    if (parsed.kind === 'short' && hubName && parsed.tag === hubName) continue;
    if (!wanted.has(parsed.tag)) continue;
    const current = byTag.get(parsed.tag);
    if (parsed.kind === 'alias' && current && String(current.doc_id).startsWith('HANDOFF/')) continue;
    byTag.set(parsed.tag, docInput(doc, parsed.tag, parsed.kind === 'alias' ? parsed.storedId : doc.doc_id));
  }
  return { inputs: [...byTag.values()], registry: [...wanted] };
}

function docInput(doc, tag, canonical) {
  return {
    doc_id: doc.doc_id,
    tag,
    version: doc.version,
    updated_at: doc.updated_at,
    content: typeof doc.content === 'string' ? doc.content : '',
    canonical_id: canonical
  };
}

export async function loadHandoffInputs(db, { person = 'owner', registry = null, hub } = {}) {
  const tags = registry || writeTagRegistry();
  const hubName = hub === undefined ? hubTag() : hub;
  const wanted = new Set(tags);
  if (hubName) wanted.add(hubName);
  const docs = await readDocs(db, {
    $or: [
      { doc_id: 'HANDOFF.md' },
      { doc_id: { $regex: '^HANDOFF/' } },
      { doc_id: { $regex: '^bots/[^/]+/HANDOFF\\.md$' } }
    ]
  });
  const byTag = new Map();
  let board = null;
  const stateId = setting('STATE_DOC', 'STATE.md');
  const state = await db.collection('documents').findOne({ doc_id: stateId });
  if (state) {
    board = {
      doc_id: state.doc_id,
      version: state.version,
      content: state.content || '',
      updated_at: state.updated_at,
      row_openers: state.row_openers || null,
      conflict_settled: state.conflict_settled || null
    };
  }
  for (const doc of docs) {
    if (!doc || doc.retired === true) continue;
    const parsed = parseHandoffId(doc.doc_id, person);
    if (parsed.kind === 'hub') {
      if (hubName) {
        byTag.set(hubName, {
          doc_id: doc.doc_id,
          tag: hubName,
          version: doc.version,
          updated_at: doc.updated_at,
          content: typeof doc.content === 'string' ? doc.content : '',
          canonical_id: 'HANDOFF.md'
        });
      }
      continue;
    }
    if (parsed.kind !== 'short' && parsed.kind !== 'alias') continue;
    if (parsed.kind === 'short' && hubName && parsed.tag === hubName) continue;
    if (!wanted.has(parsed.tag)) continue;
    const current = byTag.get(parsed.tag);
    if (parsed.kind === 'alias' && current && String(current.doc_id).startsWith('HANDOFF/')) continue;
    byTag.set(parsed.tag, {
      doc_id: doc.doc_id,
      tag: parsed.tag,
      version: doc.version,
      updated_at: doc.updated_at,
      content: typeof doc.content === 'string' ? doc.content : '',
      canonical_id: parsed.kind === 'alias' ? parsed.storedId : doc.doc_id
    });
  }
  let openRows = [];
  try {
    const cutoff = new Date(Date.now() - OPEN_SESSION_LOOKBACK_MS);
    openRows = await db.collection(`${COLLECTION_PREFIX}sessions`).find(
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
  return { inputs: [...byTag.values()], board, open_sessions: openSessionsFromRows(openRows), registry: [...wanted] };
}

export async function attachHandoffView(db, target, tag = null) {
  if (!target || tagHandoffMode() === 'off') return target;
  const actor = currentActor();
  const readOnly = !!(actor && actor.door === 'guest');
  const person = (actor && actor.personId) || 'owner';
  const view = await loadHandoffView(db, {
    person,
    asOf: new Date().toISOString(),
    readOnly,
    tag: readOnly ? null : tag
  });
  Object.assign(target, view);
  return target;
}

export async function loadHandoffView(db, { person = 'owner', asOf = new Date().toISOString(), readOnly = false, tag = null } = {}) {
  const loaded = await loadHandoffInputs(db, { person });
  const view = buildView({
    inputs: loaded.inputs,
    board: loaded.board,
    as_of: asOf,
    person,
    open_sessions: loaded.open_sessions,
    registry: loaded.registry,
    aging_days: handoffAgingDays(),
    stale_open_hours: staleOpenHours(),
    settled: loaded.board && loaded.board.conflict_settled
  });
  const own = !readOnly && tag ? loaded.inputs.find((doc) => doc.tag === tag) : null;
  const ownLines = own ? pictureLines(own.content) : [];
  const stale = readOnly ? [] : (view.stale_open || []).filter((row) => !tag || row.tag === tag);
  return {
    handoff_view: view.stamp,
    handoff_view_text: initViewText(view),
    handoff_view_conflicts: view.conflicts,
    ...(readOnly ? {} : { own_handoff: own ? { doc_id: own.doc_id, version: own.version, section_1: ownLines } : { doc_id: tag ? `HANDOFF/${tag}.md` : null, version: null, section_1: [], note: 'no handoff yet' } }),
    ...(readOnly ? {} : { stale_open: stale })
  };
}
