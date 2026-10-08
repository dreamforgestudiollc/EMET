/**
 * Paged startup (the host-aware startup design, paging; approved by the owner
 * 2026-10-03). The connector gateway cuts a tool result at 20,000 UTF-8
 * bytes, and the full startup is about 64K, so on those hosts the floor,
 * install notes, source tags, seeds_due, record gaps and lessons never
 * arrived. Paging delivers the SAME full payload in pages, binding text first.
 *
 * The rules this file keeps:
 *   - Every page, envelope included, is at most the page budget
 *     (EMET_INIT_PAGE_BYTES, default 18,000 bytes: 2,000 under the cut;
 *     clamped to 12,000-19,000).
 *   - Keys go out in one fixed order, binding first (PAGE_ORDER), never
 *     reordered by size. A key splits only when it cannot fit a page on its
 *     own; its chunks run consecutively and join back exactly.
 *   - Page 1 carries the plan: which keys are on which page, and which of them
 *     are binding. Nothing binding can drop silently: a host that stops early
 *     has been told, in page 1, what it has not yet read.
 *   - Every page but the last says, first, to call again with the next page
 *     before replying. The pages of one load come from one build (load_id);
 *     a page asked for after the startup changed says to start over.
 *   - The pages joined back are the full payload byte for byte (assemblePages).
 *   - Full payload only. This file never builds or serves the abridged form.
 *   - `page: "all"` returns the whole payload in one result, unchanged, for a
 *     host with no 20,000-byte limit; a payload that fits one page is returned
 *     unchanged with no paging fields at all.
 */

import crypto from 'crypto';
import { resultSize } from './startup-payload.js';

export const DEFAULT_PAGE_BYTES = 18000;
export const MIN_PAGE_BYTES = 12000;
export const MAX_PAGE_BYTES = 19000;

/** The page budget in UTF-8 bytes of the whole result, from EMET_INIT_PAGE_BYTES, clamped. */
export function pageBudget(raw = process.env.EMET_INIT_PAGE_BYTES) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_PAGE_BYTES;
  return Math.min(MAX_PAGE_BYTES, Math.max(MIN_PAGE_BYTES, Math.floor(n)));
}

/** Binding first: the order keys are paged in. Keys not listed follow, in payload order. */
export const PAGE_ORDER = Object.freeze([
  'state', 'database', 'source_tag', 'person_id', 'unhandled_drops', 'unhandled_drops_more', 'retired_drops', 'emet_line', 'emet_line_if_unanswered',
  'tools_in_force', 'instructions_short', 'session_close_protocol', 'operating_discipline', 'charter',
  'floor', 'floor_precedence', 'floor_reassertion',
  'seeds_due', 'seeds_evaluated_on', 'install_notes_doc_id',
  'identity', 'character', 'character_doc_id', 'character_sha256', 'user',
  'record_gaps', 'named_items', 'lessons_pending', 'layer_health',
  'install_notes', 'instructions', 'layer_charter',
  'seeds', 'threads', 'recent_context', 'layer_counts', 'layer_counts_last_30d'
]);

/** Keys that bind the session (the startup rules): never optional, never dropped. */
export const BINDING_KEYS = Object.freeze([
  'tools_in_force', 'instructions_short', 'session_close_protocol',
  'floor', 'floor_precedence', 'floor_reassertion', 'identity', 'character', 'user'
]);

/** Page fields that are never payload keys. */
export const PAGE_FIELDS = Object.freeze(['startup_page', 'page_notice', 'page_plan']);

export const loadIdOf = (full) => crypto.createHash('sha256').update(JSON.stringify(full), 'utf8').digest('hex').slice(0, 16);

function orderedKeys(full) {
  const keys = PAGE_ORDER.filter((k) => k in full);
  for (const k of Object.keys(full)) if (!keys.includes(k)) keys.push(k);
  return keys;
}

const bytes = (s) => Buffer.byteLength(s, 'utf8');
const entryBytes = (key, value) => bytes(JSON.stringify({ [key]: value })) - 1; // `"key":value` plus a comma

/**
 * Pack the payload into pages of entries. budgets(k) = content bytes allowed
 * on page k (0-based). An entry is {key, value} or {key, value, chunk, of, json}.
 */
function pack(full, budgets) {
  const pages = [[]]; const used = [0];
  const room = () => budgets(pages.length - 1) - used[pages.length - 1];
  const newPage = () => { pages.push([]); used.push(0); };
  for (const key of orderedKeys(full)) {
    const value = full[key];
    const size = entryBytes(key, value);
    if (size <= room()) { pages[pages.length - 1].push({ key, value }); used[pages.length - 1] += size; continue; }
    if (size <= budgets(pages.length)) { newPage(); pages[pages.length - 1].push({ key, value }); used[pages.length - 1] += size; continue; }
    // Too big for any one page: chunk it. Strings split as text; anything else
    // as its JSON text. Code points are never split; chunks run consecutively.
    const json = typeof value !== 'string';
    const cps = Array.from(json ? JSON.stringify(value) : value);
    const mine = [];
    let i = 0;
    while (i < cps.length) {
      if (room() < 1000 && pages[pages.length - 1].length) newPage();
      const r = room() - 60; // the chunk marker in startup_page
      let lo = 1, hi = cps.length - i, best = 0;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (entryBytes(key, cps.slice(i, i + mid).join('')) <= r) { best = mid; lo = mid + 1; } else hi = mid - 1;
      }
      if (best === 0) best = 1;
      const piece = cps.slice(i, i + best).join('');
      const e = { key, value: piece, chunk: mine.length + 1, of: 0, json };
      mine.push(e);
      pages[pages.length - 1].push(e);
      used[pages.length - 1] += entryBytes(key, piece) + 60;
      i += best;
      if (i < cps.length) newPage();
    }
    for (const e of mine) e.of = mine.length;
  }
  return pages.filter((p, i) => p.length || i === 0);
}

function planOf(pages) {
  return pages.map((entries, i) => {
    const keys = entries.map((e) => (e.chunk ? `${e.key} (part ${e.chunk} of ${e.of})` : e.key));
    const binding = [...new Set(entries.filter((e) => BINDING_KEYS.includes(e.key)).map((e) => e.key))];
    return { page: i + 1, keys, ...(binding.length ? { binding } : {}) };
  });
}

function nextCall(k, loadId, recentLimit) {
  const args = { page: k, load_id: loadId };
  if (recentLimit !== undefined && recentLimit !== null && recentLimit !== '') args.recent_limit = Number(recentLimit);
  return `emet_initialize ${JSON.stringify(args)}`;
}

/** The last page's line (2026-10-03): the open is tied to this startup, so it names the load_id to pass. */
export function sessionOpenLine(loadId) {
  return `Pass "load_id": "${loadId}" to emet_session_open; the startup page check runs on that load.`;
}

/**
 * A startup served whole - page "all", a startup that fits one result, or a
 * store that is not ready (setup_required, unreachable, misconfigured) -
 * carries its load_id too (2026-10-03), in the same `startup_page` block a
 * page carries, with a notice to pass it to emet_session_open. The payload
 * follows unchanged, and the load_id is the payload's own (loadIdOf), the
 * same id its pages carry. The caller records it with every page fetched.
 */
export function wholeStartup(full, index = 1) {
  const loadId = loadIdOf(full);
  return {
    startup_page: { index, of: 1, load_id: loadId, next: null },
    page_notice: `The whole startup in one result (load ${loadId}). ${sessionOpenLine(loadId)}`,
    ...full
  };
}

/** The line page 1 and every next-call notice carry (2026-10-03): open checks, so fetch first. */
export function fetchAllLine(n) {
  return `Fetch all ${n} pages before emet_session_open; an open with any page not fetched is refused.`;
}

function noticeFor(k, n, plan, loadId, recentLimit) {
  if (k === n) {
    return `Startup page ${k} of ${n}, the last. You now hold the whole startup (load ${loadId}). ` +
      'Follow `instructions_short` from page 1 and `instructions`, now, in that order. ' +
      `${sessionOpenLine(loadId)}`;
  }
  const later = plan.slice(k).filter((p) => p.binding).map((p) => `page ${p.page}: ${p.binding.join(', ')}`);
  // "Fetch all N pages" says how far to keep calling, so it replaced "keep
  // calling until a page says it is the last" (2026-10-03): the notice did not
  // grow, and the binding text keeps its place on the page it was on.
  return `Startup page ${k} of ${n}. Do not reply to the user yet. Call ${nextCall(k + 1, loadId, recentLimit)} now. ` +
    `${fetchAllLine(n)} None is optional` +
    (later.length ? `; binding text is still to come (${later.join('; ')}).` : '.') +
    (k === 1 ? ' `page_plan` lists what each page carries.' : '');
}

function pageObject(pages, plan, k, loadId, recentLimit, payloadOrder) {
  const entries = pages[k - 1];
  const n = pages.length;
  const chunks = {};
  const content = {};
  for (const e of entries) {
    content[e.key] = e.value;
    if (e.chunk) chunks[e.key] = { part: e.chunk, of: e.of, ...(e.json ? { json_text: true } : {}) };
  }
  const startup_page = {
    index: k, of: n, load_id: loadId,
    keys: plan[k - 1].keys,
    ...(Object.keys(chunks).length ? { chunks } : {}),
    next: k < n ? nextCall(k + 1, loadId, recentLimit) : null,
    // The last page names the payload's own key order, so the pages join back
    // to the exact bytes of the one-result payload (assemblePages).
    ...(k === n ? { payload_order: payloadOrder } : {})
  };
  return {
    startup_page,
    page_notice: noticeFor(k, n, plan, loadId, recentLimit),
    ...(k === 1 ? { page_plan: plan } : {}),
    ...content
  };
}

/**
 * Lay the full payload out in pages that each fit the budget. Returns
 * {pages: [pageObject...], plan, load_id}. Pure: the same payload and budget
 * always give the same pages.
 */
export function paginate(full, { budget = pageBudget(), recentLimit } = {}) {
  const loadId = loadIdOf(full);
  const order = Object.keys(full);
  // The page fields (notice, plan, next call) cost bytes that depend on the
  // layout, so the layout is found by iterating: pack with the overheads last
  // measured, build, measure again. Stops at the first layout that fits and
  // has stopped changing.
  let overhead = [2400]; let other = 900;
  let best = null; let lastShape = null;
  for (let attempt = 0; attempt < 16; attempt++) {
    const pages = pack(full, (i) => budget - (overhead[i] ?? other) - 48);
    const plan = planOf(pages);
    const objs = pages.map((_, i) => pageObject(pages, plan, i + 1, loadId, recentLimit, order));
    const sizes = objs.map((o) => resultSize(o).bytes);
    const fits = sizes.every((sz) => sz <= budget);
    const shape = JSON.stringify(plan);
    if (fits) {
      best = { pages: objs, plan, load_id: loadId, sizes };
      if (shape === lastShape) break;
    }
    lastShape = shape;
    const measured = pages.map((entries, i) => sizes[i] - entries.reduce((n, e) => n + entryBytes(e.key, e.value) + (e.chunk ? 60 : 0), 0));
    overhead = measured.map((m, i) => (fits ? m : Math.max(m, overhead[i] ?? other)));
    other = Math.max(...measured.slice(1), 600);
    if (!fits) sizes.forEach((sz, i) => { if (sz > budget) overhead[i] += sz - budget + 64; });
  }
  if (!best) throw new Error('startup paging: could not fit the pages to the budget');
  return best;
}

/** Join pages back into the payload, exactly, in the payload's own key order (for hosts and tests). */
export function assemblePages(pages) {
  const got = {}; const text = {}; const done = {};
  const ordered = [...pages].sort((a, b) => a.startup_page.index - b.startup_page.index);
  for (const p of ordered) {
    const chunks = p.startup_page.chunks || {};
    for (const [k, v] of Object.entries(p)) {
      if (PAGE_FIELDS.includes(k)) continue;
      if (!chunks[k]) { got[k] = v; continue; }
      text[k] = (text[k] || '') + v;
      if (chunks[k].part === chunks[k].of) { got[k] = chunks[k].json_text ? JSON.parse(text[k]) : text[k]; done[k] = true; }
    }
  }
  const last = ordered[ordered.length - 1];
  const order = (last && last.startup_page.payload_order) || Object.keys(got);
  const out = {};
  for (const k of order) if (k in got) out[k] = got[k];
  for (const k of Object.keys(got)) if (!(k in out)) out[k] = got[k];
  return out;
}

// One load's pages are served from the build that made page 1, so a write
// between two calls never moves a key across pages. In memory, per process.
const CACHE_MS = 10 * 60 * 1000;
const CACHE_MAX = 32;
// The fetched-page record outlives the payload cache: the startup_pages gate
// refuses an open whose load has no record, so a host that reads its startup
// and opens a while later (up to 60 minutes after its last page) still opens.
// Its own lifetime, never the payload cache's.
export const SERVED_MS = 60 * 60 * 1000;
// The fetched-page record is a few numbers per load, so it keeps far more
// loads than the payload cache: an open with an evicted load is refused (the
// startup_pages gate cannot check it), so many hosts starting at once must not
// push a load out before its host opens.
export const SERVED_MAX = 2000;
const cache = new Map();
export function cacheLoad(full, now = Date.now()) {
  const id = loadIdOf(full);
  cache.set(id, { full, at: now });
  for (const [k, v] of cache) if (now - v.at > CACHE_MS) cache.delete(k);
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return id;
}
export function cachedLoad(id, now = Date.now()) {
  const hit = id && cache.get(String(id));
  if (!hit) return null;
  if (now - hit.at > CACHE_MS) { cache.delete(String(id)); return null; }
  return hit.full;
}
export function clearPageCache() { cache.clear(); served.clear(); }

// Which pages of each load a host was given (2026-10-03): read by the
// startup_pages gate, which refuses an open with any page never fetched.
// In memory, per process, same lifetime as the cache. Keyed by load_id, a hash
// of the content, so two hosts that load the same startup share one record.
const served = new Map();
/**
 * Note that page `index` of `of` was served for a load; index 'all' = the
 * whole startup at once. Returns the LATE pages this serve settles
 * (2026-10-03): for each session opened while this page was missing,
 * {load_id, session, page, of}. A page fetched after the open is late, not
 * still missing, so the lab does not count it as missing. [] when none.
 */
export function notePageServed(loadId, index, of, now = Date.now()) {
  if (!loadId) return [];
  const id = String(loadId);
  const rec = served.get(id) || { of: null, pages: new Set(), all: false, at: now, opens: new Map() };
  if (index === 'all') rec.all = true;
  else { rec.pages.add(index); rec.of = of; }
  rec.at = now;
  const late = [];
  for (const [session, missing] of rec.opens || []) {
    for (const p of [...missing]) {
      if (index === 'all' || p === index) { missing.delete(p); late.push({ load_id: id, session, page: p, of: rec.of }); }
    }
    if (!missing.size) rec.opens.delete(session);
  }
  served.delete(id); served.set(id, rec); // keep insertion order = recency
  for (const [k, v] of served) if (now - v.at > SERVED_MS) served.delete(k);
  while (served.size > SERVED_MAX) served.delete(served.keys().next().value);
  return late;
}
/**
 * Note that a session opened while pages of a load were missing (report
 * mode), so a page fetched afterwards is recorded as late. `session` is the
 * label the open's lab row carries. Same lifetime as the served record.
 */
export function noteOpenMissing(loadId, session, missing = []) {
  const rec = loadId ? served.get(String(loadId)) : null;
  if (!rec || !session || !missing.length) return;
  if (!rec.opens) rec.opens = new Map();
  const set = rec.opens.get(session) || new Set();
  for (const p of missing) set.add(p);
  rec.opens.set(session, set);
}
/**
 * Which pages of the named load were never served. null when no load is
 * named, or there is no record of it (no page of it served in the last 60
 * minutes, SERVED_MS, or the server restarted). Never another load in its place. Never throws, never blocks.
 */
export function pageCompletion(loadId = null, now = Date.now()) {
  const id = loadId ? String(loadId) : null;
  const rec = id ? served.get(id) : null;
  if (!rec || now - rec.at > SERVED_MS) return null;
  if (rec.all || !rec.of) return { load_id: id, complete: true, missing: [] };
  const missing = [];
  for (let i = 1; i <= rec.of; i++) if (!rec.pages.has(i)) missing.push(i);
  return { load_id: id, of: rec.of, served: [...rec.pages].sort((a, b) => a - b), missing, complete: missing.length === 0 };
}

/** The reply to a page asked for after the startup changed (or the server restarted). */
export function restartPage(page, loadId) {
  return {
    state: 'ready',
    startup_page: { index: null, requested: page, load_id: loadId || null, restart: true, next: 'emet_initialize {}' },
    page_notice: 'The startup changed after page 1 was built (new memory was written, or the server restarted), so ' +
      `page ${page} of that load can no longer be served. Call emet_initialize {} now to start again from page 1, and ` +
      'use the new pages in place of the earlier ones. Do not reply to the user until you have every page.'
  };
}

export default { fetchAllLine, sessionOpenLine, wholeStartup, pageBudget, PAGE_ORDER, BINDING_KEYS, PAGE_FIELDS, paginate, assemblePages, loadIdOf, cacheLoad, cachedLoad, clearPageCache, restartPage, notePageServed, noteOpenMissing, pageCompletion };
