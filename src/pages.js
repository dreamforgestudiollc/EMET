/**
 * EMET - Enduring Memory & Epistemic Tiers
 * Copyright (c) 2026 Dreamforge Studio LLC
 *
 * Licensed under the MIT License - see LICENSE
 *
 * Topic pages. A page is a view computed from current records. It is not a
 * record: nothing in this module writes, the result is never stored, and it
 * is never something recall can return. The area document (areas/<slug>.md)
 * is the selector. It names what to look at. It does not state what is true.
 *
 * Read-only. The write-path invariant covers this file: no write verb here.
 * Lint flags. It does not revise, retire, or accept anything.
 */

import { connectMongo } from './mongo-connect.js';
import { MONGODB_URI, MONGODB_DB, COLLECTION_PREFIX, DatabaseError } from './database.js';
import { LAYERS } from './layers.js';
import { classifyRow } from './gaps.js';
import { parseMetadata } from './metadata.js';
import { ValidationError } from './validation.js';
import { currentActor, getPerson } from './persons.js';
import { setting } from './env.js';

export const DEFAULT_STALENESS_DAYS = 30;
export const DEFAULT_ITEM_CAP = 40;
export const PAGE_LINT_CLASSES = Object.freeze([
  'contradictions',
  'superseded_but_current',
  'unsourced',
  'duplicates',
  'broken_links',
  'long_unconfirmed'
]);

const GROUPS = Object.freeze([
  ['status', 'Status'],
  ['open', 'Open'],
  ['decisions', 'Decisions'],
  ['recent', 'Recent']
]);

const SEP = ' · ';

function meta(row) {
  return parseMetadata(row && row.metadata) || {};
}

function registry() {
  return String(setting('SOURCE_TAGS') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

/** Unix seconds. Milliseconds and ISO dates are accepted. Null when absent. */
export function toSec(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) return value.getTime() / 1000;
  if (typeof value === 'number' && Number.isFinite(value)) return value > 1e12 ? value / 1000 : value;
  const s = String(value).trim();
  if (/^\d{9,12}(\.\d+)?$/.test(s)) {
    const n = Number(s);
    return n > 1e12 ? n / 1000 : n;
  }
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? null : ms / 1000;
}

export function parseAsOf(raw) {
  if (raw == null || raw === '') return null;
  const sec = toSec(raw);
  if (sec == null) throw new ValidationError('as_of', 'emet_page: as_of must be an ISO date or unix seconds.', { code: 'EMET-PAGE-001' });
  return sec;
}

function ymd(sec) {
  return new Date(sec * 1000).toISOString().slice(0, 10);
}

function isoWeek(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export function isAreaDoc(doc_id) {
  return typeof doc_id === 'string' && doc_id.startsWith('areas/');
}

export function areaSlug(doc_id) {
  const m = /^areas\/([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/.exec(String(doc_id || ''));
  return m ? m[1] : null;
}

function localOwner(actor) {
  return actor.transport === 'stdio' || (actor.transport !== 'http' && !actor.personId);
}

/**
 * Area documents are owner-only writes. Stdio, and an in-process actor with
 * no person id, is the owner. An HTTP login must be the person whose role
 * is owner.
 */
export async function assertAreaOwner(db, tool) {
  const actor = currentActor();
  if (localOwner(actor)) return;
  const person = actor.personId ? await getPerson(db, actor.personId) : null;
  if (!person || person.role !== 'owner') {
    throw new ValidationError(`${tool}: only the owner can create or edit an area document. Nothing was written.`, { code: 'EMET-PAGE-002' });
  }
}

async function assertPageOwner(db, tool) {
  const actor = currentActor();
  if (localOwner(actor)) return;
  const person = actor.personId ? await getPerson(db, actor.personId) : null;
  if (!person || person.role !== 'owner') {
    throw new ValidationError(`${tool}: only the owner can read topic pages.`, { code: 'EMET-PAGE-003' });
  }
}

function uri() {
  return process.env.MONGODB_URI || MONGODB_URI;
}

async function withDb(fn) {
  const u = uri();
  if (!u) throw new DatabaseError('MONGODB_URI is not set; cannot read topic pages.', 'emet_page', { code: 'EMET-DB-001' });
  const client = await connectMongo(u, { serverSelectionTimeoutMS: 15000 });
  try {
    return await fn(client.db(process.env.MONGODB_DB || MONGODB_DB));
  } finally {
    await client.close();
  }
}

function sectionBody(text, num) {
  const re = new RegExp(`^##[ \\t]*§${num}\\b.*$`, 'm');
  const m = re.exec(String(text || ''));
  if (!m) return String(text || '');
  const rest = text.slice(m.index + m[0].length);
  const next = rest.search(/^##[ \t]/m);
  return next === -1 ? rest : rest.slice(0, next);
}

function boldField(text, label) {
  const re = new RegExp(`^\\s*[-*]?\\s*\\*\\*${label}:\\*\\*\\s*(.*)$`, 'im');
  const m = re.exec(String(text || ''));
  return m ? m[1].trim() : '';
}

function lineValue(text, label) {
  const re = new RegExp(`^\\s*[-*]?\\s*${label}\\s*:\\s*(.+)$`, 'im');
  const m = re.exec(String(text || ''));
  return m ? m[1].replace(/`/g, '').trim() : '';
}

function listField(raw) {
  if (raw == null) return [];
  const s = String(raw).trim();
  if (!s || /^(any|none|n\/a)$/i.test(s)) return [];
  return s.split(',').map((x) => x.trim()).filter(Boolean);
}

/**
 * The selector an area document holds. The page body is not in here.
 * A missing staleness window is 30 days. A missing cap is 40.
 */
export function parseArea(content, doc_id) {
  const text = String(content || '');
  const slug = areaSlug(doc_id) || lineValue(sectionBody(text, '0'), 'Slug');
  const title = lineValue(sectionBody(text, '0'), 'Title') || slug;
  const body = sectionBody(text, '1');
  const layers = listField(boldField(body, 'Layers')).map((s) => s.toLowerCase()).filter((l) => LAYERS.includes(l));
  const stalenessRaw = Number(String(boldField(body, 'Staleness days') || '').trim());
  const capRaw = Number(String(boldField(body, 'Item cap') || '').trim());
  return {
    slug,
    title,
    doc_id,
    layers,
    tags: listField(boldField(body, 'Tags')).map((t) => t.toLowerCase()),
    keywords: listField(boldField(body, 'Keywords')),
    prefixes: listField(boldField(body, 'Doc id prefixes')),
    clients: listField(boldField(body, 'Source clients')).map((c) => c.toLowerCase()),
    staleness_days: Number.isFinite(stalenessRaw) && stalenessRaw >= 1 ? Math.min(3650, Math.floor(stalenessRaw)) : DEFAULT_STALENESS_DAYS,
    item_cap: Number.isFinite(capRaw) && capRaw >= 1 ? Math.min(200, Math.floor(capRaw)) : DEFAULT_ITEM_CAP
  };
}

export function clientOf(row) {
  const md = meta(row);
  const raw = md.source ?? md.client ?? row.client ?? row.updated_by ?? '';
  const client = String(raw).trim().replace(/[·\]]/g, ' ').replace(/\s+/g, ' ').trim();
  return client || null;
}

export function citeMemory(row) {
  if (!row || row.id == null || row.id === '') return null;
  if (!row.layer || !LAYERS.includes(row.layer)) return null;
  const client = clientOf(row);
  if (!client) return null;
  const sec = toSec(row.timestamp);
  if (sec == null) return null;
  return `[mem:${row.id}${SEP}${row.layer}${SEP}${client}${SEP}${ymd(sec)}]`;
}

export function citeDoc(doc) {
  if (!doc || !doc.doc_id) return null;
  const version = Number(doc.version);
  if (!Number.isFinite(version)) return null;
  return `[doc:${doc.doc_id}@v${version}]`;
}

function tagsOf(row) {
  const md = meta(row);
  const raw = Array.isArray(md.tags) ? md.tags : (Array.isArray(row.tags) ? row.tags : []);
  return raw.map((t) => String(t).trim().toLowerCase()).filter(Boolean);
}

function endMarks(row) {
  const md = meta(row);
  const superseded = (row.superseded_by != null && row.superseded_by !== '') || (md.superseded_by != null && md.superseded_by !== '');
  const retired = row.retired === true || row.is_live === false || row.retired_at != null || md.retired_at != null;
  return {
    superseded,
    supersededAt: toSec(row.superseded_at ?? md.superseded_at),
    retired,
    retiredAt: toSec(row.retired_at ?? md.retired_at)
  };
}

function timeOf(row) {
  return toSec(row.timestamp ?? row.updated_at);
}

/**
 * Ended, for the view at `at`. A missing end date means the record is not
 * current now, and a past view cannot treat it as already ended.
 */
function endedBefore(ended, endedAt, asOf, at) {
  if (!ended) return false;
  if (endedAt == null) return asOf == null;
  return endedAt <= at;
}

/** Current at `asOf` (unix seconds). Null asOf means now. */
export function currentAt(row, asOf, nowSec = Date.now() / 1000) {
  const sec = timeOf(row);
  if (asOf != null && (sec == null || sec > asOf)) return false;
  const at = asOf == null ? nowSec : asOf;
  const end = endMarks(row);
  if (endedBefore(end.superseded, end.supersededAt, asOf, at)) return false;
  if (endedBefore(end.retired, end.retiredAt, asOf, at)) return false;
  return true;
}

/**
 * The document revision in force at `asOf`. Candidates are the current row
 * and documents_history rows for the same id that had been written by then.
 * The newest of those is the one in force: latest updated_at, then the
 * highest version, so an older row with no archive date does not stay
 * current once a later revision exists. If that newest revision was
 * archived at or before asOf, the document is absent. The area selector
 * stays the current area document.
 */
function revisionAt(doc, history, asOf) {
  if (!doc || asOf == null) return doc;
  const candidates = [doc, ...(history || []).filter((row) => row && row.doc_id === doc.doc_id)];
  const writtenByThen = candidates.filter((row) => {
    const written = toSec(row.updated_at ?? row.timestamp);
    return written != null && written <= asOf;
  });
  if (!writtenByThen.length) return null;
  writtenByThen.sort((a, b) => {
    const byTime = (toSec(b.updated_at ?? b.timestamp) || 0) - (toSec(a.updated_at ?? a.timestamp) || 0);
    if (byTime) return byTime;
    return (Number(b.version) || 0) - (Number(a.version) || 0);
  });
  const newest = writtenByThen[0];
  const archived = toSec(newest.archived_at);
  if (archived != null && archived <= asOf) return null;
  return newest;
}

function confirmedSec(row) {
  const md = meta(row);
  return toSec(md.confirmed_at) ?? toSec(md.revised_at) ?? toSec(row.timestamp);
}

export function staleAt(row, days, asOf, nowSec) {
  const confirmed = confirmedSec(row);
  if (confirmed == null) return true;
  const at = asOf == null ? nowSec : asOf;
  return confirmed < at - days * 86400;
}

export function groupOf(row) {
  const md = meta(row);
  const explicit = String(md.page_group || '').toLowerCase();
  if (explicit === 'status' || explicit === 'open' || explicit === 'decisions' || explicit === 'recent') return explicit;
  const tags = tagsOf(row);
  const status = String(md.status || '').toLowerCase();
  if (tags.includes('decision') || tags.includes('decisions') || md.kind === 'decision') return 'decisions';
  if (tags.includes('open') || status === 'open' || status === 'waiting' || status === 'parked') return 'open';
  if (row.layer === 'procedural') return 'decisions';
  if (row.layer === 'episodic') return 'recent';
  if (row.layer === 'working') return 'open';
  return 'status';
}

function memoryMatches(row, selector) {
  if (!selector.layers.length || !selector.layers.includes(row.layer)) return false;
  const client = clientOf(row);
  if (selector.clients.length && (!client || !selector.clients.includes(client.toLowerCase()))) return false;
  if (!selector.tags.length && !selector.keywords.length) return true;
  const tags = tagsOf(row);
  if (selector.tags.some((t) => tags.includes(t))) return true;
  const hay = `${row.content || ''} ${row.context || ''}`.toLowerCase();
  return selector.keywords.some((k) => hay.includes(String(k).toLowerCase()));
}

function docMatches(doc, selector) {
  if (!doc || !doc.doc_id || isAreaDoc(doc.doc_id)) return false;
  if (!selector.prefixes.length) return false;
  if (!selector.prefixes.some((p) => doc.doc_id.startsWith(p))) return false;
  if (selector.clients.length) {
    const client = String(doc.updated_by || doc.client || '').toLowerCase();
    if (!selector.clients.includes(client)) return false;
  }
  return true;
}

function oneLine(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function docClaims(content) {
  const out = [];
  for (const raw of String(content || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (/^\*\*(?:Template|Record) control:\*\*/.test(line)) continue;
    if (line.startsWith('|') || /^[-|: ]+$/.test(line)) continue;
    const text = oneLine(line.replace(/^[-*]\s+/, '').replace(/\*\*/g, ''));
    if (text.length < 3) continue;
    out.push(text);
    if (out.length >= 12) break;
  }
  return out;
}

function importanceOf(row) {
  const n = Number(row.importance ?? meta(row).importance);
  return Number.isFinite(n) ? n : 0.5;
}

function byRank(a, b) {
  const ia = importanceOf(a.row);
  const ib = importanceOf(b.row);
  if (ia !== ib) return ib - ia;
  const ta = timeOf(a.row) ?? 0;
  const tb = timeOf(b.row) ?? 0;
  if (ta !== tb) return tb - ta;
  return String(a.ref).localeCompare(String(b.ref));
}

function watermark(rows) {
  let best = null;
  for (const row of rows) {
    const sec = timeOf(row);
    if (sec == null) continue;
    if (best == null || sec > best) best = sec;
  }
  return best == null ? null : new Date(best * 1000).toISOString();
}

function unknownEnd(row, asOf) {
  if (asOf == null) return false;
  const end = endMarks(row);
  return (end.superseded && end.supersededAt == null) || (end.retired && end.retiredAt == null);
}

function renderMarkdown(selector, lines, history, computedAt, includeHistory, unknownEnds) {
  const grouped = { status: [], open: [], decisions: [], recent: [] };
  for (const line of lines) grouped[line.group].push(line);
  const parts = [
    `# ${selector.title}`,
    '',
    `Area \`${selector.slug}\`. Computed ${computedAt}. cache_hit: false.`,
    ''
  ];
  for (const [key, heading] of GROUPS) {
    parts.push(`## ${heading}`, '');
    if (!grouped[key].length) parts.push('None.', '');
    else {
      for (const line of grouped[key]) {
        parts.push(`- ${line.text}${line.stale ? ' (stale)' : ''} ${line.cite}`);
      }
      parts.push('');
    }
  }
  if (unknownEnds.length) {
    parts.push('## End date unknown', '', 'Superseded or retired, and the date they ended was not recorded. Not current.', '');
    for (const line of unknownEnds) parts.push(`- ${line.text} (end date unknown) ${line.cite}`);
    parts.push('');
  }
  if (includeHistory) {
    parts.push('## History', '', 'Superseded and retired records. Not current.', '');
    if (!history.length) parts.push('None.', '');
    else {
      for (const line of history) parts.push(`- ${line.text} (${line.ended}) ${line.cite}`);
      parts.push('');
    }
  }
  return parts.join('\n').replace(/\n+$/, '\n');
}

/**
 * Pure page compiler. `memories` carry `layer`. `documents` are store rows.
 * Nothing here is written back.
 */
export function compilePage(selector, memories, documents, { asOf = null, includeHistory = false, now = new Date(), revisions = [] } = {}) {
  const nowSec = now.getTime() / 1000;
  const matchedMem = memories.filter((row) => memoryMatches(row, selector));
  const docsAt = asOf == null ? documents : documents.map((doc) => revisionAt(doc, revisions, asOf)).filter(Boolean);
  const matchedDocs = docsAt.filter((doc) => docMatches(doc, selector));
  const read = [...matchedMem, ...matchedDocs].filter((row) => {
    if (asOf == null) return true;
    const sec = timeOf(row);
    return sec != null && sec <= asOf;
  });

  const dropped = [];
  const current = [];
  const history = [];
  const unknownEnds = [];

  for (const row of matchedMem) {
    if (asOf != null) {
      const sec = timeOf(row);
      if (sec == null || sec > asOf) continue;
    }
    const cite = citeMemory(row);
    const text = oneLine(row.content);
    const ref = `${row.layer}#${row.id}`;
    if (!cite || !text) {
      dropped.push({ ref, text, reason: 'unsourced' });
      continue;
    }
    const item = {
      text,
      cite,
      stale: staleAt(row, selector.staleness_days, asOf, nowSec),
      group: groupOf(row),
      row,
      ref
    };
    if (unknownEnd(row, asOf)) unknownEnds.push({ ...item, label: 'end date unknown' });
    else if (currentAt(row, asOf, nowSec)) current.push(item);
    else if (includeHistory) {
      const end = endMarks(row);
      history.push({ ...item, ended: end.retired && !end.superseded ? 'retired' : 'superseded', stale: false });
    }
  }

  for (const doc of matchedDocs) {
    if (asOf != null) {
      const sec = timeOf(doc);
      if (sec == null || sec > asOf) continue;
    }
    const cite = citeDoc(doc);
    const claims = docClaims(doc.content);
    if (!cite || !claims.length) {
      dropped.push({ ref: `doc:${doc.doc_id}`, text: '', reason: 'unsourced' });
      continue;
    }
    const stale = staleAt(doc, selector.staleness_days, asOf, nowSec);
    const isCurrent = currentAt(doc, asOf, nowSec);
    claims.forEach((text, i) => {
      const item = { text, cite, stale, group: 'status', row: doc, ref: `doc:${doc.doc_id}@v${doc.version}#${i}` };
      if (unknownEnd(doc, asOf)) unknownEnds.push({ ...item, label: 'end date unknown' });
      else if (isCurrent) current.push(item);
      else if (includeHistory) {
        const end = endMarks(doc);
        history.push({ ...item, ended: end.retired ? 'retired' : 'superseded', stale: false });
      }
    });
  }

  current.sort(byRank);
  history.sort(byRank);
  unknownEnds.sort(byRank);
  const lines = current.slice(0, selector.item_cap).map(({ text, cite, stale, group, ref }) => ({ text, cite, stale, group, ref }));
  const historyLines = history.slice(0, selector.item_cap).map(({ text, cite, ended, ref }) => ({ text, cite, ended, ref }));
  const unknownLines = unknownEnds.slice(0, selector.item_cap).map(({ text, cite, label, ref }) => ({ text, cite, label, ref }));
  const computed_at = now.toISOString();
  return {
    slug: selector.slug,
    title: selector.title,
    lines,
    history: historyLines,
    end_date_unknown: unknownLines,
    dropped,
    computed_at,
    source_watermark: watermark(read),
    cache_hit: false,
    markdown: renderMarkdown(selector, lines, historyLines, computed_at, includeHistory, unknownLines)
  };
}

async function loadCorpus(db) {
  const memories = [];
  for (const layer of LAYERS) {
    const col = db.collection(`${COLLECTION_PREFIX}${layer}`);
    for await (const row of col.find({})) memories.push({ ...row, layer });
  }
  const documents = [];
  for await (const doc of db.collection('documents').find({})) documents.push(doc);
  const history = [];
  for await (const doc of db.collection('documents_history').find({})) history.push(doc);
  return { memories, documents, history };
}

function liveAreas(documents) {
  return documents.filter((doc) => areaSlug(doc.doc_id) && currentAt(doc, null));
}

function selectorFor(doc) {
  return parseArea(doc.content, doc.doc_id);
}

function requireSlug(area, tool) {
  const slug = String(area || '').trim();
  if (!areaSlug(`areas/${slug}.md`)) {
    throw new ValidationError('area', `${tool}: area must be a slug like "finances".`, { code: 'EMET-PAGE-004' });
  }
  return slug;
}

export async function readPage({ area, as_of = null, include_history = false } = {}, now = new Date()) {
  const slug = requireSlug(area, 'emet_page');
  const asOf = parseAsOf(as_of);
  return withDb(async (db) => {
    await assertPageOwner(db, 'emet_page');
    const { memories, documents, history } = await loadCorpus(db);
    const doc = liveAreas(documents).find((d) => areaSlug(d.doc_id) === slug);
    if (!doc) throw new ValidationError('area', `emet_page: no current area document areas/${slug}.md. The owner writes it with write_doc.`, { code: 'EMET-PAGE-005' });
    const page = compilePage(selectorFor(doc), memories, documents, { asOf, includeHistory: include_history === true, now, revisions: history });
    return {
      area: slug,
      title: page.title,
      markdown: page.markdown,
      lines: page.lines.map(({ text, cite, stale }) => ({ text, cite, stale })),
      end_date_unknown: page.end_date_unknown.map(({ text, cite, label }) => ({ text, cite, label })),
      ...(include_history === true ? { history: page.history } : {}),
      computed_at: page.computed_at,
      source_watermark: page.source_watermark,
      cache_hit: false
    };
  });
}

export async function listPages(now = new Date()) {
  return withDb(async (db) => {
    await assertPageOwner(db, 'emet_pages');
    const { memories, documents } = await loadCorpus(db);
    const areas = liveAreas(documents).map((doc) => {
      const selector = selectorFor(doc);
      const page = compilePage(selector, memories, documents, { now });
      return {
        area: selector.slug,
        title: selector.title,
        doc_id: doc.doc_id,
        version: doc.version ?? null,
        lines: page.lines.length,
        stale: page.lines.filter((line) => line.stale).length,
        last_source_change: page.source_watermark
      };
    }).sort((a, b) => a.area.localeCompare(b.area));
    return { areas };
  });
}

function pushFinding(findings, seen, finding) {
  const key = `${finding.class}|${finding.area}|${[...finding.ids].sort().join(',')}`;
  if (seen.has(key)) return;
  seen.add(key);
  findings.push(finding);
}

function normText(text) {
  return oneLine(text).toLowerCase();
}

/**
 * Flag only. `area` omitted lints every current area. Builds on classifyRow
 * from gaps.js for unsourced assertions. Writes nothing.
 */
export async function lintPages({ area = null } = {}, now = new Date()) {
  const only = area == null || area === '' ? null : requireSlug(area, 'emet_page_lint');
  const nowSec = now.getTime() / 1000;
  return withDb(async (db) => {
    await assertPageOwner(db, 'emet_page_lint');
    const { memories, documents } = await loadCorpus(db);
    let areas = liveAreas(documents);
    if (only) {
      areas = areas.filter((doc) => areaSlug(doc.doc_id) === only);
      if (!areas.length) throw new ValidationError('area', `emet_page_lint: no current area document areas/${only}.md.`, { code: 'EMET-PAGE-006' });
    }
    const memById = new Map();
    for (const row of memories) {
      const id = String(row.id);
      if (!memById.has(id)) memById.set(id, []);
      memById.get(id).push(row);
    }
    const docById = new Map(documents.map((doc) => [doc.doc_id, doc]));
    const findings = [];
    const seen = new Set();
    const slugs = [];

    for (const areaDoc of areas) {
      const selector = selectorFor(areaDoc);
      slugs.push(selector.slug);
      const page = compilePage(selector, memories, documents, { now });
      const matched = memories.filter((row) => memoryMatches(row, selector) && currentAt(row, null, nowSec));

      for (const drop of page.dropped) {
        pushFinding(findings, seen, {
          class: 'unsourced',
          ids: drop.ref ? [drop.ref] : [],
          area: selector.slug,
          detail: 'A page line had no source citation and was dropped.'
        });
      }

      for (const row of matched) {
        const ref = `${row.layer}#${row.id}`;
        const gaps = classifyRow(row.layer, row, { registry: registry(), nowSec });
        if (gaps.includes('unsourced_assertions') && citeMemory(row)) {
          pushFinding(findings, seen, {
            class: 'unsourced',
            ids: [ref],
            area: selector.slug,
            detail: 'A current record in this area has no provenance pointer (emet_gaps unsourced_assertions).'
          });
        }
      }

      const MEM_REF = /mem:(\d+)/g;
      const DOC_REF = /doc:([A-Za-z0-9_./-]+\.md)(?:@v(\d+))?/g;
      for (const row of matched) {
        const ref = `${row.layer}#${row.id}`;
        const text = String(row.content || '');
        for (const m of text.matchAll(MEM_REF)) {
          const hits = memById.get(m[1]) || [];
          if (!hits.length) {
            pushFinding(findings, seen, {
              class: 'broken_links',
              ids: [ref, `mem:${m[1]}`],
              area: selector.slug,
              detail: `mem:${m[1]} does not resolve.`
            });
          } else if (hits.every((hit) => !currentAt(hit, null, nowSec))) {
            pushFinding(findings, seen, {
              class: 'superseded_but_current',
              ids: [ref, ...hits.map((hit) => `${hit.layer}#${hit.id}`)],
              area: selector.slug,
              detail: `A current record claims mem:${m[1]}, which is superseded or retired.`
            });
          }
        }
        for (const m of text.matchAll(DOC_REF)) {
          const target = docById.get(m[1]);
          const version = m[2] != null ? Number(m[2]) : null;
          if (!target || !currentAt(target, null, nowSec) && target.retired !== true && !target.retired_at) {
            if (!target) {
              pushFinding(findings, seen, {
                class: 'broken_links',
                ids: [ref, `doc:${m[1]}`],
                area: selector.slug,
                detail: `doc:${m[1]} does not resolve.`
              });
            }
          }
          if (target && !currentAt(target, null, nowSec)) {
            pushFinding(findings, seen, {
              class: 'superseded_but_current',
              ids: [ref, `doc:${target.doc_id}@v${target.version}`],
              area: selector.slug,
              detail: `A current record claims ${m[1]}, which is retired.`
            });
          } else if (target && version != null && version !== Number(target.version)) {
            pushFinding(findings, seen, {
              class: 'broken_links',
              ids: [ref, `doc:${m[1]}@v${version}`],
              area: selector.slug,
              detail: `doc:${m[1]}@v${version} does not resolve. The current version is v${target.version}.`
            });
          }
        }
      }

      const bySubject = new Map();
      for (const row of matched) {
        const subject = String(meta(row).subject || '').trim().toLowerCase();
        if (!subject) continue;
        const claim = oneLine(meta(row).claim != null ? meta(row).claim : row.content);
        if (!bySubject.has(subject)) bySubject.set(subject, []);
        bySubject.get(subject).push({ ref: `${row.layer}#${row.id}`, claim });
      }
      for (const [subject, group] of bySubject) {
        const claims = new Set(group.map((g) => g.claim));
        if (claims.size > 1) {
          pushFinding(findings, seen, {
            class: 'contradictions',
            ids: group.map((g) => g.ref),
            area: selector.slug,
            detail: `Current records disagree on "${subject}".`
          });
        }
      }

      const byText = new Map();
      const currentItems = [
        ...matched.map((row) => ({ text: oneLine(row.content), ref: `${row.layer}#${row.id}` })),
        ...page.lines.filter((line) => line.ref.startsWith('doc:')).map((line) => ({ text: line.text, ref: line.ref }))
      ];
      for (const item of currentItems) {
        const key = normText(item.text);
        if (!key) continue;
        if (!byText.has(key)) byText.set(key, []);
        const list = byText.get(key);
        if (!list.includes(item.ref)) list.push(item.ref);
      }
      for (const [text, ids] of byText) {
        if (ids.length < 2) continue;
        pushFinding(findings, seen, {
          class: 'duplicates',
          ids,
          area: selector.slug,
          detail: `The same current line appears ${ids.length} times: ${text.slice(0, 80)}`
        });
      }

      for (const row of matched) {
        const status = meta(row).status;
        const group = groupOf(row);
        if (group !== 'status' && (status == null || status === '')) continue;
        if (!staleAt(row, selector.staleness_days, null, nowSec)) continue;
        if (!citeMemory(row)) continue;
        pushFinding(findings, seen, {
          class: 'long_unconfirmed',
          ids: [`${row.layer}#${row.id}`],
          area: selector.slug,
          detail: `A status has not been confirmed or revised within ${selector.staleness_days} days.`
        });
      }
    }

    return { findings, areas: slugs, read_only: true };
  });
}

/**
 * The weekly summary for emet_initialize. Monday (UTC) carries counts.
 * Other days name the cadence. Non-owners receive no findings. Nothing is stored.
 */
export async function pageLintDigest(now = new Date()) {
  try {
    const actor = currentActor();
    if (!localOwner(actor)) {
      const allowed = await withDb(async (db) => {
        const person = actor.personId ? await getPerson(db, actor.personId) : null;
        return !!(person && person.role === 'owner');
      });
      if (!allowed) return { cadence: 'weekly', included: false, owner_only: true };
    }
    const week = isoWeek(now);
    if (now.getUTCDay() !== 1) {
      return {
        cadence: 'weekly',
        week,
        included: false,
        note: 'The weekly page-lint summary is included on Monday (UTC). emet_page_lint reads the same checks on demand.'
      };
    }
    const lint = await lintPages({}, now);
    const counts = {};
    for (const name of PAGE_LINT_CLASSES) counts[name] = 0;
    for (const finding of lint.findings) counts[finding.class] = (counts[finding.class] || 0) + 1;
    return {
      cadence: 'weekly',
      week,
      included: true,
      assessed: true,
      areas: lint.areas,
      findings: lint.findings.length,
      counts,
      note: 'Computed for this initialize. emet_page_lint returns the findings. A fix goes through revise_memory, retire_doc, or accept_nonconformance.'
    };
  } catch (e) {
    return { cadence: 'weekly', included: false, assessed: false, error: e && e.message ? e.message : String(e) };
  }
}
