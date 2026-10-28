/**
 * EMET - Enduring Memory & Epistemic Tiers
 * Copyright (c) 2026 Dreamforge Studio LLC
 *
 * Licensed under the MIT License - see LICENSE
 *
 * conformance - template validation for controlled documents.
 *
 * A template is a control: it puts the answer in front of whoever fills it
 * before the moment a field could be skipped. That only holds if the filled
 * record is actually checked against it, so this module does the checking and
 * `writeDoc()` calls it on every document write. There is no way to ask it not
 * to (STANDARD 9a L2): an optional control is a reminder, and an instruction to
 * be careful is not a control (charter 3, commitment 5).
 *
 * WHAT IT DOES NOT DO. A nonconforming write is never rejected and never
 * altered - the user's decision, 2026-09-10: "Mark for audit and review."
 * The document lands, carries a visible marker naming what failed, and stays
 * counted at session start until it is corrected by a later revision or
 * accepted with a written reason. A validator that could block a write would be
 * a validator that could lose one.
 *
 * WHAT IT CANNOT DO, stated so no one assumes otherwise: it checks FORM and
 * CONTINUITY, never truth. Whether a "none" states its scope honestly, and
 * whether any answer is true, remain the author's and the reader's.
 *
 * The templates are their own specification: required sections are read from
 * the template document's own headings, so the rule lives once, in the
 * template, and never in a second copy here (charter 3, commitment 4).
 */

import fs from 'fs';
import path from 'path';
import { resolveModulePath } from './module-path.js';
import { setting } from './env.js';
import { CodedError } from './error-codes.js';

const HERE = resolveModulePath(import.meta.url);

/**
 * L1: the SHIPPED copy governs. Required sections and status are read from the
 * copy that ships with the release, never from the store copy - otherwise a
 * template can be loosened by editing the store, or validation switched off by
 * flipping a template to DRAFT. The store copy is still compared against this
 * one, and a difference is itself a nonconformance.
 */
export const SHIPPED_TEMPLATES_DIR = path.resolve(HERE, '..', 'templates');

export const STATUS = Object.freeze({ DRAFT: 'DRAFT', IN_FORCE: 'IN FORCE', RETIRED: 'RETIRED' });

export const VERDICT = Object.freeze({
  CONFORMS: 'conforms',
  NONCONFORMING: 'nonconforming',
  UNTEMPLATED: 'untemplated',   // no template maps to this doc_id
  UNGATED: 'ungated'            // a template maps, but it is not IN FORCE yet
});

// ============================================
// PARSING - a template is its own specification
// ============================================

/** `## §3 OPEN BOARD` -> { num: '3', title: 'OPEN BOARD' }. The section number
 *  may carry a letter suffix (9a), which the standard itself uses. */
const SECTION_RE = /^##[ \t]*§([0-9]+[a-z]?)[ \t]*(.*)$/gm;

/** The control line, template or record. Both open with a bolded label. */
const CONTROL_RE = /^\*\*(?:Template|Record) control:\*\*(.*)$/m;

/** Field inside a control line: `status: IN FORCE`, up to the next separator. */
function controlField(controlLine, name) {
  if (!controlLine) return null;
  const re = new RegExp(`${name}\\s*:\\s*([^·|\\n]+)`, 'i');
  const m = re.exec(controlLine);
  return m ? m[1].trim() : null;
}

/**
 * A doc id written as `templates/BOARD.md`, in backticks or bare.
 *
 * ⚠ THE `id` TOKEN MUST BE BOUNDED, and it was not. Written bare, the pattern
 * matched the letters inside "val-id-ation-v1-pricing-2026-09.md" (without the
 * hyphens) and captured the tail, reporting a declared template of
 * "ation-v1-pricing-2026-09.md" - a filename mentioned in passing turning into
 * a template the record never declared. Found by running the validator against
 * the reference install's own board, 2026-09-11.
 *
 * The boundary is written as lookaround rather than \b on purpose: `_` is a
 * word character, so \bid\b would refuse a control line that writes `doc_id:`.
 * Lookaround on [A-Za-z0-9] rejects "validation" and "identifier" while still
 * accepting `id`, `doc_id` and `Record id`.
 */
const CONTROL_ID_RE = /(?<![A-Za-z0-9])id(?![A-Za-z0-9])\s*:?\s*[`']?([A-Za-z0-9_./-]+\.md)[`']?/i;
const CONTROL_TEMPLATE_RE = /Template\s*:\s*[`']?([A-Za-z0-9_./-]+\.md)[`']?/i;

function controlDocId(controlLine) {
  if (!controlLine) return null;
  const m = CONTROL_ID_RE.exec(controlLine) || CONTROL_TEMPLATE_RE.exec(controlLine);
  return m ? m[1] : null;
}

/**
 * ⚠ ORDER IS LOAD-BEARING, and it is not obvious. The conventional way to write
 * an unadopted template's status is `status: DRAFT, not in force` - and
 * "NOT IN FORCE" CONTAINS "IN FORCE". Testing for IN FORCE first therefore reads
 * every draft as adopted, which is the precise failure the gating exists to
 * prevent: validation firing against templates nobody approved. Caught by
 * tests/conformance.test.js on the first run, 2026-09-11.
 *
 * RETIRED and DRAFT are checked first because they are unambiguous, and an
 * explicit negation is honoured before anything else.
 */
function normaliseStatus(raw) {
  if (!raw) return null;
  const s = raw.toUpperCase();
  if (s.includes('RETIRED')) return STATUS.RETIRED;
  if (s.includes('DRAFT')) return STATUS.DRAFT;
  if (/\bNOT IN FORCE\b/.test(s)) return STATUS.DRAFT;
  if (s.includes('IN FORCE')) return STATUS.IN_FORCE;
  return null;
}

/** Sections in document order, with the body that follows each heading. */
export function parseSections(text) {
  const src = String(text || '');
  const found = [];
  SECTION_RE.lastIndex = 0;
  let m;
  while ((m = SECTION_RE.exec(src)) !== null) {
    found.push({ num: m[1], title: m[2].trim(), start: m.index, bodyStart: m.index + m[0].length });
  }
  return found.map((s, i) => ({
    num: s.num,
    title: s.title,
    first_word: (s.title.split(/[\s—-]+/)[0] || '').toUpperCase(),
    body: src.slice(s.bodyStart, i + 1 < found.length ? found[i + 1].start : src.length).trim()
  }));
}

/**
 * Parse a template document into the specification it is.
 * `source` is 'shipped' or 'store' - which copy this came from, so a caller
 * can never confuse the authority (L1) with the copy being audited.
 */
export function parseTemplate(text, { doc_id = null, source = 'shipped' } = {}) {
  const src = String(text || '');
  const control = (CONTROL_RE.exec(src) || [])[1] || null;
  const sections = parseSections(src);
  return {
    template_id: controlDocId(control) || doc_id,
    status: normaliseStatus(controlField(control, 'status')),
    approved: controlField(control, 'approved'),
    revision: controlField(control, 'revision'),
    owner: controlField(control, 'owner'),
    source,
    required_sections: sections.map((s) => ({ num: s.num, title: s.title, first_word: s.first_word })),
    placeholder_count: countPlaceholders(src),
    body: src
  };
}

// Front matter is the record control block for templates that declare it that way
// - a seed is the case in hand. It must open the file: anything indented, or sitting
// below prose, is body text and is not read. This is deliberately strict, because a
// trigger buried in a fenced block inside the body is exactly what an automated scan
// cannot see, and four seeds in the reference store are invisible for that reason.
const FRONT_MATTER_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

export function parseFrontMatter(text) {
  const m = FRONT_MATTER_RE.exec(String(text || ''));
  return m ? m[1] : null;
}

const SEED_KINDS = new Set(['DATE', 'ROW', 'SIGNAL', 'TOPIC']);
const SEED_STATUSES = new Set(['DORMANT', 'MET', 'SHELVED', 'ACTED ON']);

/** Field checks for a seed whose record control is YAML front matter.
 *  Presence of the block is not enough: trigger kind and status have to be
 *  values the template names, or a seed can pass while remaining invisible
 *  to a startup scan. */
export function checkSeedFrontMatter(block) {
  const failures = [];
  const src = String(block || '');
  const kinds = [];
  const tests = [];
  let status = null, resumes = null, planted = null, plantedBy = null, session = null;
  for (const raw of src.split(/\r?\n/)) {
    const line = raw.trim().replace(/^-\s+/, '');
    const kv = line.match(/^([A-Za-z_]+):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1].toLowerCase();
    const val = kv[2].trim();
    if (key === 'kind') kinds.push(val.split(/\s+/)[0].toUpperCase());
    else if (key === 'test') tests.push(val);
    else if (key === 'status') status = val.toUpperCase();
    else if (key === 'resumes_when') resumes = val;
    else if (key === 'planted') planted = val;
    else if (key === 'planted_by') plantedBy = val;
    else if (key === 'session') session = val;
  }
  if (kinds.length === 0) failures.push('seed front matter names no trigger kind');
  for (const k of kinds) {
    if (!SEED_KINDS.has(k)) failures.push(`seed trigger kind "${k}" is not DATE, ROW, SIGNAL or TOPIC`);
  }
  if (tests.length === 0 || tests.every((t) => !t || /^_+$/.test(t))) {
    failures.push('seed front matter trigger has no test');
  }
  if (!status) failures.push('seed front matter names no status');
  else if (!SEED_STATUSES.has(status)) failures.push(`seed status "${status}" is not DORMANT, MET, SHELVED or ACTED ON`);
  if (status === 'SHELVED' && (!resumes || /^_+$/.test(resumes))) {
    failures.push('shelved seed names no resumes_when');
  }
  if (!planted || /^_+$/.test(planted)) failures.push('seed front matter names no planted date');
  if (!plantedBy || /^_+$/.test(plantedBy)) failures.push('seed front matter names no planted_by');
  if (!session || /^_+$/.test(session)) failures.push('seed front matter names no session');
  return failures;
}

/**
 * An unfilled placeholder is a run of two or more underscores that is not part
 * of a longer word (snake__case is not a placeholder). Limit stated plainly:
 * markdown's `__bold__` would also match, so templates and records use `**` for
 * emphasis. Flagged rather than silently tolerated - a half-filled record
 * reported as done is the failure this check exists for.
 */
const PLACEHOLDER_RE = /(?<![A-Za-z0-9])_{2,}(?![A-Za-z0-9])/g;

export function countPlaceholders(text) {
  const m = String(text || '').match(PLACEHOLDER_RE);
  return m ? m.length : 0;
}

// ============================================
// THE MAP - which documents are templated
// ============================================
//
// L3: settings may ADD a mapping; they may never remove or redirect a base one.
// The board and handoff ids come from the same settings emet_initialize and
// emet_session_close use, so the document the startup reads is always the
// document that is validated - it cannot be unmapped by renaming it.
//
// Leaving the record control block out does not evade the check: the map is
// consulted by doc_id, independently of what the record declares.

/** The base map. Exact ids first, then prefixes. Never removable. */
export function baseMap() {
  return {
    exact: {
      [setting('HANDOFF_DOC', 'HANDOFF.md')]: 'templates/HANDOFF.md',
      [setting('STATE_DOC', 'STATE.md')]: 'templates/BOARD.md',
      'bootstrap/IDENTITY.md': 'templates/IDENTITY.md',
      'bootstrap/CHARACTER.md': 'templates/CHARACTER.md',
      'bootstrap/SOUL.md': 'templates/CHARACTER.md',
      'bootstrap/PERSONALITY.md': 'templates/CHARACTER.md',
      'bootstrap/USER.md': 'templates/USER.md',
      [setting('INSTALL_DOC', 'bootstrap/INSTALL.md')]: 'templates/INSTALL.md'
    },
    prefix: {
      'seeds/': 'templates/SEED.md',
      'threads/': 'templates/THREAD.md',
      'staging/': 'templates/STAGING.md',
      'procedures/': 'templates/PROCEDURE.md',
      'areas/': 'templates/AREA.md',
      [SESSION_DISPOSITION_PREFIX]: SESSION_DISPOSITION_TEMPLATE
    }
  };
}

/**
 * Additional mappings from EMET_TEMPLATE_MAP, formatted `id=template,...`.
 * Additive only: an entry that would redirect or remove a base mapping is
 * IGNORED and reported, never applied (L3).
 */
export function extraMappings(raw = setting('TEMPLATE_MAP')) {
  const added = {}, refused = [];
  const base = baseMap();
  for (const pair of String(raw ?? '').split(',')) {
    const [k, v] = pair.split('=').map((s) => (s || '').trim());
    if (!k || !v) continue;
    const collides = Object.prototype.hasOwnProperty.call(base.exact, k)
      || Object.keys(base.prefix).some((p) => k === p);
    if (collides) { refused.push(`${k} is a base mapping and cannot be redirected (L3)`); continue; }
    added[k] = v;
  }
  return { added, refused };
}

/** Which template governs this doc_id, or null. */
export function templateFor(doc_id) {
  if (!doc_id) return null;
  const base = baseMap();
  if (base.exact[doc_id]) return base.exact[doc_id];
  const { added } = extraMappings();
  if (added[doc_id]) return added[doc_id];
  for (const [prefix, tpl] of Object.entries(base.prefix)) {
    if (doc_id.startsWith(prefix)) return tpl;
  }
  for (const [k, tpl] of Object.entries(added)) {
    if (k.endsWith('/') && doc_id.startsWith(k)) return tpl;
  }
  return null;
}

/** Base templates and the charter - the documents L1 and L5 protect. */
export function isGovernedByShippedCopy(doc_id) {
  return doc_id === 'CHARTER.md' || /^templates\/[A-Z]+\.md$/.test(String(doc_id || ''));
}

/** A drop id. Retired drops still count. */
export function isDropDoc(doc_id) {
  return String(doc_id || '').startsWith('drops/');
}

// ============================================
// THE SHIPPED COPIES (L1)
// ============================================

const shippedCache = new Map();

/** Read a shipped template from the release. Absence is reported, never thrown:
 *  a release built without its templates must still serve writes. */
export function loadShipped(template_id, { dir = SHIPPED_TEMPLATES_DIR, cache = true } = {}) {
  // The directory is part of the key. Caching by template id alone would let a
  // lookup against one directory answer a lookup against another, which is
  // wrong in exactly the case that matters: two copies of the same template id
  // that differ.
  const key = `${dir}|${template_id}`;
  if (cache && shippedCache.has(key)) return shippedCache.get(key);
  const file = path.join(dir, path.basename(template_id));
  let parsed = null;
  try {
    parsed = parseTemplate(fs.readFileSync(file, 'utf8'), { doc_id: template_id, source: 'shipped' });
  } catch {
    parsed = null;
  }
  if (cache) shippedCache.set(key, parsed);
  return parsed;
}

/** Test seam: forget what was read from disk. */
export function clearShippedCache() { shippedCache.clear(); }

// ============================================
// THE CHECKS (STANDARD 9)
// ============================================

const ID_RE = /\bB-\d{3,}\b/g;

/** The cells of a markdown table row. `| a | b |` splits to ['', ' a ', ' b ', ''];
 *  the outer empties are dropped so cells[i] is the i-th column. */
function cells(row) {
  const parts = String(row || '').split('|');
  if (parts.length > 2) return parts.slice(1, -1).map((c) => c.trim());
  return [String(row || '').trim()];
}

/** The id cell of a row. The id column is located by its HEADER ("Id"), not by
 *  position: the user asked (2026-09-15) that the id, which means nothing to
 *  him in conversation, sit at the END of each row rather than lead it. A
 *  template that still puts it first is read the same way. No "Id" header at
 *  all falls back to the first cell, which is what every board before this
 *  revision had. */
function idCell(row, idIndex) {
  const c = cells(row);
  return (idIndex !== null && idIndex < c.length ? c[idIndex] : c[0]) || '';
}

/**
 * Row ids taken from the ID COLUMN of each section's table.
 *
 * ⚠ NOT SCRAPED FROM THE SECTION BODY, and that is the whole point. Reading
 * every B-### in the body made an id MENTIONED IN PROSE inside another row -
 * a closed row named in a note, an item cross-referenced in a next action -
 * read as a row of its own, so the carry-forward check reported it missing
 * from the next revision. Found by running the validator against the reference
 * install's own board, 2026-09-11: board 012 and board 050 were both closed on the
 * prior revision and appeared only inside another row's text.
 *
 * The failure direction matters and is recorded so no one "fixes" this by
 * loosening it: the bug made the check NOISY, never permissive. Nothing passed
 * that should have failed. A row that genuinely leaves the board undispositioned
 * is still caught, because a real row has a cell in the id column.
 */
function rowIds(sections, nums) {
  const wanted = new Set(nums);
  const ids = new Set();
  for (const s of sections) {
    if (!wanted.has(s.num)) continue;
    const idIndex = idColumnIndex(s.body);
    for (const row of tableRows(s.body)) {
      for (const id of idCell(row, idIndex).match(ID_RE) || []) ids.add(id);
    }
  }
  return ids;
}

/** Index of the column headed "Id" in the first table of a section body, or
 *  null when no such header exists. */
function idColumnIndex(body) {
  const header = String(body || '').split('\n').map((l) => l.trim()).find((l) => l.startsWith('|'));
  if (!header) return null;
  const i = cells(header).findIndex((h) => /^id$/i.test(h));
  return i === -1 ? null : i;
}

/**
 * Session disposition (templates/SESSIONDISPOSITION.md).
 * A batch under records/ notes overdue or duplicate sessions. It does not close
 * them and it does not write a receipt. An inserted_id row dispositions that
 * transcript and leaves the transcript in the store. A session-level row
 * (no inserted_id) is what checkpoint overdue listing reads.
 */
export const SESSION_DISPOSITION_TEMPLATE = 'templates/SESSIONDISPOSITION.md';
export const SESSION_DISPOSITION_PREFIX = 'records/';
export const SESSION_DISPOSITIONS = Object.freeze([
  'CARRIED_FORWARD',
  'ABANDONED_NO_TRANSCRIPT',
  'SUPERSEDED_BY_LATER_SESSION',
  'CLOSED_NORMAL',
  'RETAINED_OPEN_CRITICAL'
]);
const SESSION_DISPOSITION_SET = new Set(SESSION_DISPOSITIONS);
const NEEDS_DESTINATION = new Set(['CARRIED_FORWARD', 'SUPERSEDED_BY_LATER_SESSION']);
const INSERTED_ID_RE = /^[a-f0-9]{24}$/i;

export function dispositionResolvesOverdue(name) {
  return SESSION_DISPOSITION_SET.has(name);
}

function markdownTable(body) {
  const lines = String(body || '').split('\n').map((l) => l.trim());
  let header = null;
  let seenRule = false;
  const rows = [];
  for (const line of lines) {
    if (!line.startsWith('|')) {
      if (seenRule && rows.length) break;
      continue;
    }
    if (!header) { header = cells(line); continue; }
    if (!seenRule) { seenRule = /^\|[\s:|-]+\|$/.test(line); continue; }
    rows.push(cells(line));
  }
  return { header: header || [], rows };
}

function columnIndex(header, ...names) {
  const norm = (header || []).map((h) => String(h || '').toLowerCase().replace(/[\s-]+/g, '_'));
  for (const name of names) {
    const i = norm.indexOf(name);
    if (i !== -1) return i;
  }
  return -1;
}

function cellAt(row, index) {
  if (index == null || index < 0) return '';
  return String((row && row[index]) || '').trim();
}

function unanswered(value, label) {
  const v = String(value ?? '').trim();
  if (!v || /^_{2,}$/.test(v)) return `${label} is blank`;
  if (/^(none|n\/a)$/i.test(v)) return `${label} is an unscoped none`;
  if (/^(none|n\/a)\b/i.test(v) && !/^(?:none|n\/a)\s*[—–-]\s*\S/i.test(v)) return `${label} is an unscoped none`;
  return null;
}

function isScopedNone(value) {
  return /^(?:none|n\/a)\b/i.test(String(value ?? '').trim());
}

function controlValue(body, label) {
  const re = new RegExp(`${String(label).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:\\s*([^·\\n]+)`, 'i');
  const m = re.exec(String(body || ''));
  return m ? m[1].trim() : null;
}

/** A real transcript id, or null when the cell is empty or a scoped none. */
export function realInsertedId(value) {
  const v = String(value ?? '').trim();
  if (!v || isScopedNone(v)) return null;
  return INSERTED_ID_RE.test(v) ? v.toLowerCase() : v;
}

function dispositionKey(sessionId, insertedId) {
  return `${sessionId}\0${insertedId || ''}`;
}

function indexDispositionColumns(header) {
  return {
    session_id: columnIndex(header, 'session_id'),
    opened_at: columnIndex(header, 'opened_at'),
    last_saved_at: columnIndex(header, 'last_saved_at'),
    disposition: columnIndex(header, 'disposition'),
    reason: columnIndex(header, 'reason'),
    evidence: columnIndex(header, 'evidence'),
    carried_forward_to: columnIndex(header, 'carried_forward_to'),
    inserted_id: columnIndex(header, 'inserted_id')
  };
}

/**
 * §1 rows. `inserted_id` is the 24-hex id, or null when the row is session-level.
 * A row that fails form still parses, so a reader can see what was written.
 */
export function parseDispositionRows(content) {
  const one = parseSections(content).find((s) => s.num === '1');
  if (!one) return [];
  const table = markdownTable(one.body);
  const idx = indexDispositionColumns(table.header);
  if (idx.session_id < 0) return [];
  const out = [];
  for (const raw of table.rows) {
    const session_id = cellAt(raw, idx.session_id);
    if (!session_id) continue;
    out.push({
      session_id,
      opened_at: cellAt(raw, idx.opened_at),
      last_saved_at: cellAt(raw, idx.last_saved_at),
      disposition: cellAt(raw, idx.disposition),
      reason: cellAt(raw, idx.reason),
      evidence: cellAt(raw, idx.evidence),
      carried_forward_to: cellAt(raw, idx.carried_forward_to),
      inserted_id: realInsertedId(cellAt(raw, idx.inserted_id))
    });
  }
  return out;
}

function dispositionSubjects(content) {
  return parseDispositionRows(content).map((row) => ({
    key: dispositionKey(row.session_id, row.inserted_id),
    session_id: row.session_id,
    inserted_id: row.inserted_id
  }));
}

/**
 * Form checks for a session-disposition record. The write path calls this
 * from checkRecord. It checks form, not whether the disposition is true.
 */
export function checkDispositionRecord(content, { previous = null } = {}) {
  const failures = [];
  const sections = parseSections(content);
  const byNum = new Map(sections.map((s) => [s.num, s]));
  const zero = byNum.get('0');
  if (zero) {
    for (const label of ['Session id', 'Source tag', 'Written (local)', 'Scope', 'Rows']) {
      const problem = unanswered(controlValue(zero.body, label), label);
      if (problem) failures.push(`record control ${problem}`);
    }
    const declared = controlValue(zero.body, 'Rows');
    const stated = declared == null ? NaN : Number(String(declared).replace(/[^0-9-]/g, ''));
    const one = byNum.get('1');
    const table = one ? markdownTable(one.body) : { header: [], rows: [] };
    if (Number.isFinite(stated) && one && stated !== table.rows.length) {
      failures.push(`§0 states Rows ${stated}; §1 holds ${table.rows.length} row${table.rows.length === 1 ? '' : 's'}`);
    }
  }

  const one = byNum.get('1');
  if (one) {
    if (/no session in this record/i.test(one.body) && markdownTable(one.body).rows.length > 0) {
      failures.push('§1 says no session in this record and also holds rows');
    }
    const table = markdownTable(one.body);
    if (table.rows.length === 0) {
      if (!/None\s*[—–-]\s*\S/i.test(one.body)) {
        failures.push('§1 names no session and states no scoped none');
      }
    } else {
      const idx = indexDispositionColumns(table.header);
      const required = ['session_id', 'opened_at', 'last_saved_at', 'disposition', 'reason', 'evidence', 'carried_forward_to', 'inserted_id'];
      for (const name of required) {
        if (idx[name] < 0) failures.push(`§1 table has no ${name} column`);
      }
      if (required.every((name) => idx[name] >= 0)) {
        const seen = new Map();
        table.rows.forEach((raw, n) => {
          const at = `§1 row ${n + 1}`;
          const session_id = cellAt(raw, idx.session_id);
          const opened_at = cellAt(raw, idx.opened_at);
          const last_saved_at = cellAt(raw, idx.last_saved_at);
          const disposition = cellAt(raw, idx.disposition);
          const reason = cellAt(raw, idx.reason);
          const evidence = cellAt(raw, idx.evidence);
          const carried = cellAt(raw, idx.carried_forward_to);
          const insertedRaw = cellAt(raw, idx.inserted_id);
          const inserted = realInsertedId(insertedRaw);
          if (!session_id || isScopedNone(session_id)) failures.push(`${at} session_id is not a session id`);
          for (const [label, value] of [['opened_at', opened_at], ['last_saved_at', last_saved_at], ['carried_forward_to', carried], ['inserted_id', insertedRaw]]) {
            const problem = unanswered(value, label);
            if (problem) failures.push(`${at} ${problem}`);
          }
          if (!SESSION_DISPOSITION_SET.has(disposition)) {
            failures.push(`${at} disposition "${disposition}" is not one of ${SESSION_DISPOSITIONS.join(', ')}`);
          }
          if (reason.trim().length < MIN_ACCEPTANCE_REASON) {
            failures.push(`${at} reason is shorter than ${MIN_ACCEPTANCE_REASON} characters`);
          }
          if (isScopedNone(evidence) || evidence.trim().length < MIN_ACCEPTANCE_REASON) {
            failures.push(`${at} evidence must name a record, revision, inserted id, or dated words (at least ${MIN_ACCEPTANCE_REASON} characters)`);
          }
          if (NEEDS_DESTINATION.has(disposition) && isScopedNone(carried)) {
            failures.push(`${at} ${disposition} must name carried_forward_to`);
          }
          if (insertedRaw && !isScopedNone(insertedRaw) && !INSERTED_ID_RE.test(insertedRaw)) {
            failures.push(`${at} inserted_id is not a 24-hex transcript id or a scoped none`);
          }
          if (inserted) {
            if (disposition !== 'SUPERSEDED_BY_LATER_SESSION') {
              failures.push(`${at} an inserted_id row uses SUPERSEDED_BY_LATER_SESSION`);
            }
            if (!evidence.includes(inserted)) failures.push(`${at} evidence does not name inserted_id ${inserted}`);
          }
          const key = dispositionKey(session_id, inserted);
          if (session_id && seen.has(key)) failures.push(`${at} repeats ${session_id}${inserted ? ` inserted_id ${inserted}` : ''}`);
          if (session_id) seen.set(key, n + 1);
        });
      }
    }
  }

  const three = byNum.get('3');
  if (three && previous && typeof previous === 'string') {
    const before = dispositionSubjects(previous);
    const after = new Set(dispositionSubjects(content).map((s) => s.key));
    const released = new Set();
    const release = markdownTable(three.body);
    const idCol = columnIndex(release.header, 'session_id');
    const insCol = columnIndex(release.header, 'inserted_id');
    const whyCol = columnIndex(release.header, 'why_it_left', 'why');
    const evCol = columnIndex(release.header, 'evidence');
    if (release.rows.length && (idCol < 0 || whyCol < 0 || evCol < 0)) {
      failures.push('§3 table needs session_id, why it left, and evidence');
    }
    release.rows.forEach((raw, n) => {
      const session_id = cellAt(raw, idCol);
      const inserted = realInsertedId(cellAt(raw, insCol));
      const why = cellAt(raw, whyCol);
      const evidence = cellAt(raw, evCol);
      if (!session_id) failures.push(`§3 row ${n + 1} session_id is blank`);
      if (why.trim().length < MIN_ACCEPTANCE_REASON) failures.push(`§3 row ${n + 1} why it left is shorter than ${MIN_ACCEPTANCE_REASON} characters`);
      if (evidence.trim().length < MIN_ACCEPTANCE_REASON) failures.push(`§3 row ${n + 1} evidence is shorter than ${MIN_ACCEPTANCE_REASON} characters`);
      const key = dispositionKey(session_id, inserted);
      if (after.has(key)) failures.push(`§3 releases ${session_id} that §1 still holds`);
      released.add(key);
    });
    const dropped = before.filter((s) => !after.has(s.key) && !released.has(s.key));
    if (dropped.length) {
      const names = dropped.map((s) => s.inserted_id ? `${s.session_id}#${s.inserted_id}` : s.session_id);
      failures.push(
        `${dropped.length} subject${dropped.length === 1 ? '' : 's'} on the previous revision left this one with no disposition: ${names.sort().join(', ')}`
      );
    }
  }
  return failures;
}

/** Data rows of the first markdown table in a section body. */
function tableRows(body) {
  const lines = String(body || '').split('\n').map((l) => l.trim());
  const rows = [];
  let seenHeader = false, seenRule = false;
  for (const line of lines) {
    if (!line.startsWith('|')) { if (seenRule && rows.length) break; continue; }
    if (!seenHeader) { seenHeader = true; continue; }
    if (!seenRule) { seenRule = /^\|[\s:|-]+\|$/.test(line); continue; }
    rows.push(line);
  }
  return rows;
}

/**
 * Check one record against one parsed template.
 *
 * Returns failures (nonconformances) and warnings (reported, not counted).
 * Pure: no database, no disk, no clock beyond `checked_at` supplied by the
 * caller - so every check is assertable in a test without a live store.
 */
export function checkRecord(content, template, { previous = null, doc_id = null } = {}) {
  const failures = [], warnings = [];
  const text = String(content || '');
  const sections = parseSections(text);
  const byNum = new Map(sections.map((s) => [s.num, s]));

  // 1. Record control: a §0 section that names the template it was filled from -
  // or, where the record control IS the front matter, the front matter itself.
  //
  // This demanded a `## §0` heading unconditionally until 2026-09-13. A seed's
  // record control is YAML front matter by design, and front matter cannot sit
  // underneath a heading and remain front matter, so no correctly-written seed
  // could satisfy it. Every seed in the reference store was marked nonconforming
  // for obeying its own template, and a check that cannot be passed is worse than
  // no check: it marks everything, and a marker that is always on is one nobody
  // reads. Nothing is relaxed here - a record carrying neither still fails.
  const zero = byNum.get('0');
  const control = zero ? zero.body : parseFrontMatter(text);
  if (!control) {
    failures.push('record control block missing: no `## §0` section and no front matter');
  } else if (!controlDocId(control) && !/Template\s*:/i.test(control)) {
    failures.push('record control block names no template id');
  }

  // Seed record control is front matter by design (templates/SEED.md product
  // note). Presence of the block was already required above; kind and status
  // are checked here so a seed can fail for a bad trigger rather than only
  // for a missing heading.
  if (template.template_id === 'templates/SEED.md') {
    const fm = parseFrontMatter(text) || (!zero ? control : null);
    if (fm) failures.push(...checkSeedFrontMatter(fm));
  }

  // 2. Every required section present, in order.
  const present = sections.map((s) => s.num);
  let cursor = -1;
  for (const req of template.required_sections) {
    const at = present.indexOf(req.num);
    if (at === -1) { failures.push(`required section §${req.num} ${req.title} is missing`); continue; }
    if (at < cursor) failures.push(`section §${req.num} appears out of order`);
    cursor = Math.max(cursor, at);
    const got = byNum.get(req.num);
    // Heading drift is a warning, never a failure: matching on the § number and
    // the first word keeps a retitled section from reading as an absent one.
    if (req.first_word && got.first_word && got.first_word !== req.first_word) {
      warnings.push(`§${req.num} is titled "${got.title}"; the template says "${req.title}"`);
    }
    // 3. No empty required section.
    if (!got.body || got.body.replace(/[\s|:-]/g, '') === '') {
      failures.push(`required section §${req.num} ${req.title} is empty`);
    }
  }

  // 4. No unfilled placeholder survived from the template.
  const left = countPlaceholders(text);
  if (left > 0) failures.push(`${left} unfilled template placeholder${left === 1 ? '' : 's'} left in the record`);

  // 5. NOT COMPLETED carries a reason.
  for (const m of text.match(/NOT (?:COMPLETED|CHECKED)[^\n]*/g) || []) {
    if (!/NOT (?:COMPLETED|CHECKED)\s*[—–-]\s*\S/.test(m)) {
      failures.push(`"${m.trim().slice(0, 60)}" states no reason`);
    }
  }

  // 6. The board's own check: the §0 counts must match the rows they describe.
  if (template.template_id === 'templates/BOARD.md' && zero) {
    const counted = {
      'Half-state': tableRows((byNum.get('1') || {}).body).length,
      'Closed this revision': tableRows((byNum.get('4') || {}).body).length
    };
    const declared = tableRows(zero.body)[0];
    if (declared) {
      const cells = declared.split('|').map((c) => c.trim()).filter((c) => c !== '');
      const headerCells = (zero.body.split('\n').find((l) => l.includes('Half-state')) || '')
        .split('|').map((c) => c.trim()).filter((c) => c !== '');
      for (const [label, actual] of Object.entries(counted)) {
        const i = headerCells.findIndex((h) => h.toLowerCase() === label.toLowerCase());
        if (i === -1) continue;
        const stated = Number(cells[i]);
        if (Number.isFinite(stated) && stated !== actual) {
          failures.push(`§0 states ${label} ${stated}; §${label === 'Half-state' ? '1' : '4'} holds ${actual} row${actual === 1 ? '' : 's'}`);
        }
      }
    }
  }

  // 7. CARRY-FORWARD. Every row id on the previous revision's open sections is
  //    still present in this one, somewhere - open, or dispositioned in §4.
  //    The prior revision is already in hand at the door, so this is a
  //    comparison and not a judgment. This check alone would have caught the
  //    two job-application rows that left the board with nobody deciding they
  //    should (reference install, September 2026).
  if (previous && typeof previous === 'string') {
    const before = rowIds(parseSections(previous), ['1', '2', '3']);
    const after = rowIds(sections, ['1', '2', '3', '4']);
    const dropped = [...before].filter((id) => !after.has(id));
    if (dropped.length) {
      failures.push(
        `${dropped.length} row${dropped.length === 1 ? '' : 's'} on the previous revision ` +
        `left this one with no disposition: ${dropped.sort().join(', ')}`
      );
    }
  }

  // Session disposition. A records/ batch is checked for its own columns.
  // Board carry-forward above looks for B-### ids and does not see session ids.
  if (template && template.template_id === SESSION_DISPOSITION_TEMPLATE) {
    failures.push(...checkDispositionRecord(text, { previous }));
  }

  return { failures, warnings };
}

// ============================================
// THE DOOR'S ENTRY POINT
// ============================================

/**
 * Validate one document write. Called from writeDoc() on every write, with no
 * argument that can turn it off (L2).
 *
 * NEVER THROWS for nonconformance and never alters the content. A validator
 * fault is itself reported as a warning rather than failing the write: the
 * write path's job is to store the document, and a check that can block one is
 * a check that can lose one.
 *
 * @param {string} doc_id
 * @param {string} content    the content about to be written, post-redaction
 * @param {string|null} previous  the prior revision's content, already in hand
 * @returns {object} the conformance record stored on the row and returned in
 *                   the receipt.
 */
export function validateDocument(doc_id, content, previous = null, { dir } = {}) {
  const checked_at = new Date().toISOString();
  try {
    const failures = [], warnings = [];

    // L1/L5: a base template or the charter, written into the store. The
    // shipped copy is the authority; the store copy is for reading. Drift is a
    // nonconformance on the STORE copy and changes nothing about the shipped one.
    if (isGovernedByShippedCopy(doc_id)) {
      // The charter ships at the repository ROOT, beside the templates
      // directory, not inside it. Until 2026-09-15 this lookup joined the
      // templates directory with the charter's basename, found nothing, and
      // reported "no shipped copy" as a warning - so the L1 lock the charter's
      // own section 9 promises had never once fired. Found by the store write
      // of the revised charter returning that warning.
      const shippedDir = dir ? dir : (doc_id === 'CHARTER.md' ? path.dirname(SHIPPED_TEMPLATES_DIR) : SHIPPED_TEMPLATES_DIR);
      const shipped = loadShipped(doc_id, { dir: shippedDir });
      if (!shipped) {
        warnings.push(`no shipped copy of ${doc_id} found in this release; the store copy cannot be checked against it (L1)`);
      } else if (String(shipped.body).replace(/\r\n/g, '\n').trim() !== String(content).replace(/\r\n/g, '\n').trim()) {
        failures.push(`store copy of ${doc_id} differs from the copy shipped with this release; the shipped copy governs (L1)`);
      }
      return {
        template: null, template_status: null, verdict: failures.length ? VERDICT.NONCONFORMING : VERDICT.CONFORMS,
        governed_by: 'shipped release copy', failures, warnings, checked_at
      };
    }

    const mapped_id = templateFor(doc_id);
    const { refused } = extraMappings();
    for (const r of refused) warnings.push(r);

    if (!mapped_id) {
      return { template: null, template_status: null, verdict: VERDICT.UNTEMPLATED, failures: [], warnings, checked_at };
    }

    const template = loadShipped(mapped_id, dir ? { dir } : {});
    if (!template) {
      return {
        template: mapped_id, template_status: null, verdict: VERDICT.UNGATED,
        failures: [], checked_at,
        warnings: [...warnings, `${mapped_id} is not present in this release, so ${doc_id} could not be validated`]
      };
    }

    // Gating: nothing is marked until the user adopts a template. Before
    // that, the build is silent - which is what let it ship ahead of adoption.
    if (template.status !== STATUS.IN_FORCE) {
      return {
        template: mapped_id, template_status: template.status, verdict: VERDICT.UNGATED,
        failures: [], warnings, checked_at,
        note: `${mapped_id} is ${template.status || 'unstated'}; records are checked but not marked until it is IN FORCE.`
      };
    }
    // A template cannot be IN FORCE without its approval recorded (STANDARD 6;
    // ISO 13485 4.2.4 - review and approval before issue).
    if (!template.approved) {
      warnings.push(`${mapped_id} is IN FORCE with no approval recorded (who · date · decision record)`);
    }

    const result = checkRecord(content, template, { previous, doc_id });
    failures.push(...result.failures);
    warnings.push(...result.warnings);

    // L4: a record that declares a DIFFERENT template is checked against BOTH.
    // Declaring a weaker local template adds a check; it never replaces one.
    const declared = controlDocId((parseSections(content).find((s) => s.num === '0') || {}).body || '');
    if (declared && declared !== mapped_id) {
      warnings.push(`record declares ${declared}; the map says ${mapped_id}. Validated against both (L4).`);
      const alt = loadShipped(declared, dir ? { dir } : {});
      if (alt && alt.status === STATUS.IN_FORCE) {
        const second = checkRecord(content, alt, { previous, doc_id });
        for (const f of second.failures) if (!failures.includes(f)) failures.push(`against ${declared}: ${f}`);
      }
    }

    return {
      template: mapped_id, template_status: template.status,
      verdict: failures.length ? VERDICT.NONCONFORMING : VERDICT.CONFORMS,
      failures, warnings, checked_at
    };
  } catch (error) {
    // The check failed, not the write. Say so and store the document.
    return {
      template: null, template_status: null, verdict: VERDICT.UNTEMPLATED, failures: [], checked_at,
      warnings: [`conformance check could not run: ${error && error.message ? error.message : String(error)}`]
    };
  }
}

// ============================================
// ACCEPTANCE (L6)
// ============================================
//
// A marker is never cleared silently. It leaves in one of two ways: the next
// revision passes, or a person accepts it in writing. An acceptance binds to
// the revision it names and to nothing after it - the next revision is
// validated fresh, and accepted markers stay counted at session start,
// separately from open ones, so an acceptance is a disposition and not a
// disappearance.

export const MIN_ACCEPTANCE_REASON = 10;

export function buildAcceptance({ reason, by = null, version = null, person_id = null, client_id = null, grant_id = null, door = null, session_id = null }) {
  const text = String(reason || '').trim();
  if (text.length < MIN_ACCEPTANCE_REASON) {
    throw new CodedError(
      `An acceptance needs a written reason of at least ${MIN_ACCEPTANCE_REASON} characters. ` +
      `It is the disposition of record for a nonconformance and is read by whoever audits it later.`
    , { code: 'EMET-DOC-049' });
  }
  return {
    reason: text, accepted_by: by, accepted_at: new Date().toISOString(), covers_version: version,
    person_id, client_id: client_id || 'stdio', grant_id: grant_id || null, door: door || null, session_id
  };
}

/** True when this row's marker is open: nonconforming, and not accepted FOR
 *  THIS revision. An acceptance from an earlier version does not carry. */
export function isOpenNonconformance(conformance, version = null) {
  if (!conformance || conformance.verdict !== VERDICT.NONCONFORMING) return false;
  const a = conformance.accepted;
  if (!a) return true;
  if (a.covers_version === null || a.covers_version === undefined) return false;
  return Number(a.covers_version) !== Number(version);
}

/** True when the marker stands but has been dispositioned for this revision. */
export function isAcceptedNonconformance(conformance, version = null) {
  if (!conformance || conformance.verdict !== VERDICT.NONCONFORMING) return false;
  return Boolean(conformance.accepted) && !isOpenNonconformance(conformance, version);
}

export default {
  SHIPPED_TEMPLATES_DIR, STATUS, VERDICT, MIN_ACCEPTANCE_REASON,
  parseSections, parseTemplate, countPlaceholders,
  baseMap, extraMappings, templateFor, isGovernedByShippedCopy,
  loadShipped, clearShippedCache, checkRecord, validateDocument,
  buildAcceptance, isOpenNonconformance, isAcceptedNonconformance,
  SESSION_DISPOSITION_TEMPLATE, SESSION_DISPOSITION_PREFIX, SESSION_DISPOSITIONS,
  dispositionResolvesOverdue, parseDispositionRows, checkDispositionRecord
};
