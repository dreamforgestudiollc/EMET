/**
 * EMET - attribution per session, v2 (2026-10-12).
 *
 * Alex approved PROPOSAL.md with its 7 defaults;
 * v1 (PR 32) was reverted after the reviewer's review (A1-A4). This version:
 *
 *  STAMP vs RIGHTS. Several agents share one OAuth login (the Grok client
 *  8xm-7ILLKEDFc3-QRxqlgw). A bot's declared tag is what its writes are
 *  stamped with (source_basis "declared", source_login = the login's tag),
 *  but a declared tag never gains rights beyond the login's tag (A3): every
 *  guard is run for BOTH tags and the write must pass both (rightsTags()).
 *
 *  NEW CLIENTS (Alex, 2026-10-12). A tag is known when it is in
 *  EMET_SOURCE_TAGS, approved in the approvals record, or bound to a login at
 *  consent (the owner approved that at the consent page). The first write by
 *  any other tag is refused (read-limited) and queued in the approvals
 *  record `emet/CLIENT_APPROVALS.md` with who connected, the declared name,
 *  client_id and what it tried to write. The flag is routed:
 *    - to the chief-of-staff bot when EMET_COS_TAG is set (it sees the queue
 *      in emet_initialize / emet_status and approves with emet_client_approve);
 *    - to the owner directly when no COS is configured (single-instance users:
 *      one Claude or ChatGPT). The owner always may approve.
 *  A first, solo client on a store with no registry and no approvals is
 *  approved at once as the owner's primary: beginners meet no friction.
 *
 *  SESSION TIES (A1, A4). Every write naming a session_id is checked against
 *  the tag that session belongs to, whatever was declared. The tie is cached
 *  in memory and rebuilt after a restart from the session's stored rows
 *  (transcript parts, documents, layer entries): if those rows carry another
 *  tag, the write is refused.
 *
 *  OWNER (A2). Live owner tokens carry the owner's person id (e.g. "alex");
 *  older ones carry "owner" or nothing. All three are the owner.
 */

import { setting } from './env.js';

export const APPROVALS_DOC = 'emet/CLIENT_APPROVALS.md';
export const WRITE_TOOLS = new Set([
  'save_to_layer', 'revise_memory', 'write_doc', 'patch_doc', 'retire_doc', 'rename_doc', 'restore_doc',
  'accept_nonconformance', 'emet_transcript_append', 'save_transcript', 'revise_transcript', 'emet_session_close',
  // the reviewer's re-review (2026-10-12): opening a session claims it; deciding a client is a write.
  'emet_session_open', 'emet_client_approve',
  // the reviewer's PR 47 review: setup writes durable identity and board docs.
  'emet_setup_complete'
]);
/** Tools the strict login tag also covers. emet_initialize can provision, so a
 *  mismatched declared tag is refused under EMET_STRICT_LOGIN_TAG=1. It is kept out
 *  of WRITE_TOOLS so the default path (denied or multi-tag clients) can still start a session. */
export const STRICT_TAG_TOOLS = new Set([...WRITE_TOOLS, 'emet_initialize']);
export const BINDING_MAX = 5000;
export const SESSION_BINDINGS = new Map();
const APPROVALS_TTL_MS = 15000;

/** approvalsCache.data is null when not loaded; .missing / .broken describe the record. */
let approvalsCache = { at: 0, data: null, version: null, missing: false, broken: false };
let approvalsLock = Promise.resolve();
const seenSubkeySessions = new Set();
export function rememberSubkeySession(base) {
  if (typeof base === 'string' && base) seenSubkeySessions.add(base);
}
export function _resetForTests() {
  SESSION_BINDINGS.clear();
  seenSubkeySessions.clear();
  approvalsCache = { at: 0, data: null, version: null, missing: false, broken: false };
  approvalsLock = Promise.resolve();
}

/** Off unless EMET_STRICT_LOGIN_TAG=1: a bound login tag cannot be overridden on a write. */
export function strictLoginTag() { return setting('STRICT_LOGIN_TAG') === '1'; }

export function cosTag() {
  const t = String(setting('COS_TAG') ?? '').trim();
  return t || null;
}

/** Same rule as session-graph.js isBotTag (kept local: no import cycle). */
export function isBotTagLocal(tag) {
  if (typeof tag !== 'string' || !tag.trim() || tag.includes('/')) return false;
  const listed = String(setting('RECORD_DOCS', '') || '').split(',').map((x) => x.trim()).filter(Boolean);
  return listed.includes(`bots/${tag.trim()}/HANDOFF.md`);
}

/** Approved tags as last loaded (sync; for the registry checks). */
export function approvedTags() {
  const d = approvalsCache.data;
  return d ? Object.keys(d.approved || {}) : [];
}

export function cachedApprovals() { return approvalsCache.data; }

export function emptyApprovals() { return { approved: {}, pending: {}, denied: {}, clients: {} }; }

/**
 * Remembered tags for one client_id (Alex 2026-10-12): approved clients keep
 * their tag across logins. A shared client_id can carry several approved tags
 * (one per bot), so this is a set. Retired entries (renamed away) are skipped.
 * Approvals recorded before the map existed count through their request.
 */
export function rememberedFor(d, clientId) {
  if (!d || !clientId) return [];
  const out = new Set();
  const row = d.clients && d.clients[clientId];
  const retired = new Set();
  if (row && row.tags) for (const [t, v] of Object.entries(row.tags)) (v && v.retired ? retired : out).add(t);
  for (const [t, v] of Object.entries(d.approved || {})) {
    const cid = v && (v.client_id || (v.request && v.request.client_id));
    if (cid === clientId && !retired.has(t)) out.add(t);
  }
  return [...out];
}

function remember(d, clientId, tag, { declared_name = null, basis = null, at, renamed_from = null } = {}) {
  if (!clientId || !tag) return;
  d.clients = d.clients || {};
  const row = d.clients[clientId] = d.clients[clientId] || { tags: {} };
  row.tags = row.tags || {};
  if (!row.tags[tag] || row.tags[tag].retired) row.tags[tag] = { declared_name: declared_name || tag, basis, since: at, ...(renamed_from ? { renamed_from } : {}) };
  if (renamed_from && row.tags[renamed_from]) row.tags[renamed_from] = { ...row.tags[renamed_from], retired: true, renamed_to: tag, retired_at: at };
}

/** Strict: returns null when the record does not parse (fail closed, the reviewer 4). */
export function parseApprovals(content) {
  const m = /```json\n([\s\S]*?)\n```/.exec(String(content || ''));
  if (!m) return null;
  try {
    const d = JSON.parse(m[1]);
    if (!d || typeof d !== 'object' || Array.isArray(d)) return null;
    for (const k of ['approved', 'pending', 'denied', 'clients']) {
      if (d[k] !== undefined && (typeof d[k] !== 'object' || Array.isArray(d[k]) || d[k] === null)) return null;
    }
    return { approved: d.approved || {}, pending: d.pending || {}, denied: d.denied || {}, clients: d.clients || {} };
  } catch { return null; }
}

export function renderApprovals(d) {
  const lines = ['# CLIENT APPROVALS', '',
    'Server-kept record of connecting clients (EMET attribution v2). Server-only: hosts cannot write, patch, retire or rename it. Decide with `emet_client_approve`.',
    `Routed to: ${cosTag() ? `chief-of-staff \`${cosTag()}\`` : 'the owner (no EMET_COS_TAG set)'}.`, '',
    '```json', JSON.stringify(d, null, 2), '```', ''];
  return lines.join('\n');
}

/** deps: { readDoc(doc_id) -> {content, version}|throws not found, writeDoc(doc_id, content, expectedVersion) -> {version} } */
export async function loadApprovals(deps, { fresh = false } = {}) {
  if (!fresh && approvalsCache.at && Date.now() - approvalsCache.at < APPROVALS_TTL_MS) return approvalsCache;
  let doc = null;
  try { doc = await deps.readDoc(APPROVALS_DOC); }
  catch (e) {
    if (!/not found/i.test(String(e && e.message))) throw e;
  }
  if (!doc) approvalsCache = { at: Date.now(), data: emptyApprovals(), version: null, missing: true, broken: false };
  else {
    const data = parseApprovals(doc.content);
    approvalsCache = data
      ? { at: Date.now(), data, version: doc.version ?? null, missing: false, broken: false }
      : { at: Date.now(), data: null, version: doc.version ?? null, missing: false, broken: true };
  }
  return approvalsCache;
}

/**
 * Compare-and-set (the reviewer 3): mutations run one at a time in this process, each
 * re-reads the record and writes with the version it read; a version moved by
 * another writer is retried on the fresh copy. `fn(data)` returns false to write nothing.
 */
export async function mutateApprovals(deps, fn, { tries = 4 } = {}) {
  const run = async () => {
    for (let i = 0; i < tries; i++) {
      const cur = await loadApprovals(deps, { fresh: true });
      if (cur.broken) throw refusal(`${APPROVALS_DOC} does not parse; client approvals fail closed. Nothing was written.`);
      const data = JSON.parse(JSON.stringify(cur.data));
      const changed = await fn(data, cur);
      if (changed === false) return { data: cur.data, written: false };
      try {
        const out = await deps.writeDoc(APPROVALS_DOC, renderApprovals(data), cur.version);
        approvalsCache = { at: Date.now(), data, version: out && out.version != null ? out.version : (cur.version || 0) + 1, missing: false, broken: false };
        return { data, written: true };
      } catch (e) {
        if (!(e && e.versionConflict)) throw e;
      }
    }
    throw refusal(`${APPROVALS_DOC} kept changing under this write; try again. Nothing was written.`);
  };
  const p = approvalsLock.then(run, run);
  approvalsLock = p.catch(() => {});
  return p;
}

/** The person behind the token is the owner (person level: for D3 only). */
export function isOwnerSubject(subject, ownerId) {
  return subject === null || subject === undefined || subject === 'owner' || (ownerId && subject === ownerId);
}
export function personIsOwner(actor, ownerId) {
  const oid = ownerId || (actor && actor.ownerId) || null;
  return !!actor && (actor.personId === 'owner' || (!!oid && actor.personId === oid));
}

/**
 * The owner acting as the owner (the reviewer A2 re-review). Over HTTP the person must be
 * the owner AND the call must carry the login's own tag (no declared or
 * generated tag) AND that tag must not be a bot tag. Every bot on the owner's
 * shared login is therefore not the owner. Stdio is the local owner.
 */
export function actorIsOwner(actor, ownerId) {
  if (!actor || actor.transport !== 'http') return true;
  if (!personIsOwner(actor, ownerId)) return false;
  const login = typeof actor.sourceTag === 'string' && actor.sourceTag.trim() ? actor.sourceTag.trim() : null;
  if (actor.sourceBasis && actor.sourceBasis !== 'login') return false;
  if (actor.declaredTag) return false;
  return !!login && !isBotTagLocal(login);
}

/** The configured chief of staff acting on its own login tag (never a declared copy of it). */
export function actorIsCos(actor) {
  const cos = cosTag();
  if (!cos || !actor || actor.transport !== 'http') return false;
  const login = typeof actor.sourceTag === 'string' ? actor.sourceTag.trim() : '';
  return login === cos && (!actor.sourceBasis || actor.sourceBasis === 'login') && !actor.declaredTag;
}

export function declaredTagOf(args) {
  const a = args || {};
  const v = a.source ?? a.updated_by ?? a.retired_by ?? a.accepted_by ?? a.channel ??
    (a.metadata && typeof a.metadata === 'object' ? a.metadata.source : undefined) ?? null;
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

export function sessionBaseOf(args) {
  const a = args || {};
  const v = a.session_id ?? (a.metadata && typeof a.metadata === 'object' ? a.metadata.session_id : undefined) ??
    (a.metadata && a.metadata.derived_from && a.metadata.derived_from.session_id) ?? null;
  if (typeof v !== 'string' || !v.trim()) return null;
  return v.trim().replace(/_verbatim_part\d+$/, '').replace(/_part\d+$/, '');
}

export function autoTag(clientId) {
  const slug = String(clientId || 'client').toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 8) || 'client';
  return `auto-${slug}`;
}

function refusal(msg) { const e = new Error(msg); e.attributionRefusal = true; return e; }

export function bindSession(base, tag, extra = {}) {
  if (SESSION_BINDINGS.has(base)) return;
  while (SESSION_BINDINGS.size >= BINDING_MAX) SESSION_BINDINGS.delete(SESSION_BINDINGS.keys().next().value);
  SESSION_BINDINGS.set(base, { agent_tag: tag, ...extra, bound_at: new Date() });
}

/** Tags already on the session's stored rows (A4: survives a restart). Read only; fails closed (the reviewer A4). */
export async function storedSessionTags(db, base, layerCollections = []) {
  if (!base) return [];
  if (!db) throw refusal(`the store cannot be read to check who owns session ${base}; nothing was written.`);
  const esc = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^${esc}(_|$)`);
  const tags = new Set();
  const add = (t) => { if (typeof t === 'string' && t.trim()) tags.add(t.trim()); };
  try {
    for (const r of await db.collection('transcripts').find({ session_id: re }, { projection: { channel: 1 } }).limit(50).toArray()) add(r.channel);
    for (const r of await db.collection('documents').find({ session_id: re }, { projection: { updated_by: 1 } }).limit(50).toArray()) add(r.updated_by);
    for (const col of layerCollections) {
      for (const r of await col.find({ 'metadata.derived_from.session_id': re }, { projection: { 'metadata.source': 1 } }).limit(50).toArray()) add(r.metadata && r.metadata.source);
    }
  } catch (e) {
    throw refusal(`the store could not be read to check who owns session ${base} (${String(e && e.message || e).slice(0, 80)}); writes fail closed, nothing was written.`);
  }
  return [...tags];
}

/** The base a session open will claim: <local date>_<slug>, as emet_session_open names it. */
export function sessionOpenBase(args, now = new Date()) {
  const slug = args && typeof args.slug === 'string' ? args.slug.trim() : '';
  if (!slug) return null;
  const tz = setting('TIMEZONE', 'America/New_York') || 'America/New_York';
  let day;
  try { day = now.toLocaleDateString('en-CA', { timeZone: tz }); } catch { day = now.toISOString().slice(0, 10); }
  return `${day}_${slug}`;
}

/** Whether the store has seen any client but this one (a truly fresh store has not). */
async function storeHasOtherClients(db, prefix, actor) {
  if (!db) return true;
  try {
    const rows = await db.collection(`${prefix}oauth_tokens`).find({}, { projection: { client_id: 1 } }).limit(200).toArray();
    return rows.some((r) => r.client_id && r.client_id !== actor.clientId);
  } catch { return true; }
}

/**
 * Decide the tag for one HTTP call before the tool runs. Mutates the actor
 * (declaredTag, sourceBasis, effectiveTag, approvalState). Throws an
 * attributionRefusal on a refusal; nothing is written then.
 * ctx: { db, prefix, ownerId, deps (approvals doc io), layerCollections, registry: string[], now }
 */
export async function preflight(ctx, actor, args, toolName) {
  if (!actor || actor.transport !== 'http' || !actor.authenticated) return actor;
  const { db, prefix = '', ownerId = null, deps = null, layerCollections = [], registry = [], now = new Date() } = ctx || {};
  const bound = typeof actor.sourceTag === 'string' && actor.sourceTag.trim() ? actor.sourceTag.trim() : null;
  const declared = declaredTagOf(args);
  const isWrite = WRITE_TOOLS.has(toolName);

  // Sub-keys (EMET_SUBKEYS=1, off by default). The handle check runs here,
  // before the strict login check, and only when the flag is on. With the
  // flag off the check is the handle shape and the sessions this process has
  // already seen. It does not open the sub-key store.
  if (setting('SUBKEYS') === '1') {
    const { prepareSubkeyCall } = await import('./subkeys.js');
    await prepareSubkeyCall({ ...ctx, now }, actor, args, toolName);
  } else if (isWrite) {
    const handle = args && typeof args.session_handle === 'string' ? args.session_handle.trim() : '';
    if (handle.startsWith('emh_')) throw refusal('a sub-key session handle was presented and EMET_SUBKEYS is off. Nothing was written.');
    const base = sessionBaseOf(args);
    if (base && seenSubkeySessions.has(base)) throw refusal('session ' + base + ' is a sub-key session and EMET_SUBKEYS is off. Nothing was written.');
  }

  // Strict login tags (EMET_STRICT_LOGIN_TAG=1, off by default): a login that
  // carries a bound tag writes only under that tag. A different declared tag is
  // refused, so one login cannot stamp another client's name. A valid sub-key
  // handle for that tag is the exception. Off keeps attribution v2.
  const subkeyCovers = actor.subkeySession === true && actor.subkeyTag && (!declared || declared === actor.subkeyTag);
  if (STRICT_TAG_TOOLS.has(toolName) && bound && declared && declared !== bound && strictLoginTag() && !subkeyCovers) {
    throw refusal(`this login is bound to "${bound}"; it may not write as "${declared}". Each client writes under its own login. Nothing was written.`);
  }
  if (declared && declared !== bound && db) {
    // D3: a tag bound to another person's login (person level: the owner's
    // tokens carry the owner id, "owner" or no subject).
    const rows = await db.collection(`${prefix}oauth_tokens`).find({ source_tag: declared }, { projection: { subject: 1 } }).limit(20).toArray();
    const ownerPerson = personIsOwner(actor, ownerId);
    const foreign = rows.some((r) => ownerPerson ? !isOwnerSubject(r.subject, ownerId || actor.ownerId) : r.subject !== actor.personId);
    if (foreign) throw refusal(`source "${declared}" is bound to another person's login, so this session may not write under it. Pass your own tag. Nothing was written.`);
  }
  if (actor.subkeySession && actor.subkeyTag && actor.subkeyTag !== bound && db) {
    const rows = await db.collection(`${prefix}oauth_tokens`).find({ source_tag: actor.subkeyTag }, { projection: { subject: 1 } }).limit(20).toArray();
    const ownerPerson = personIsOwner(actor, ownerId);
    const foreign = rows.some((r) => ownerPerson ? !isOwnerSubject(r.subject, ownerId || actor.ownerId) : r.subject !== actor.personId);
    if (foreign) throw refusal(`source "${actor.subkeyTag}" is bound to another person's login, so this session may not write under it. Pass your own tag. Nothing was written.`);
  }

  if (actor.subkeySession && actor.subkeyTag) {
    actor.declaredTag = null;
    actor.sourceBasis = 'subkey';
    actor.effectiveTag = actor.subkeyTag;
    actor.approvalState = 'subkey';
    const base = !isWrite ? null : (toolName === 'emet_session_open' ? sessionOpenBase(args, now) : sessionBaseOf(args));
    if (base && actor.effectiveTag) {
      let row = SESSION_BINDINGS.get(base);
      if (!row) {
        const stored = await storedSessionTags(db, base, layerCollections);
        const other = stored.find((t) => t !== actor.effectiveTag);
        if (other) row = { agent_tag: other };
      }
      if (row && row.agent_tag !== actor.effectiveTag) {
        throw refusal(`session ${base} belongs to "${row.agent_tag}"; "${actor.effectiveTag}" may not write in it. Open your own session. Nothing was written.`);
      }
      bindSession(base, actor.effectiveTag, { basis: 'subkey', key_id: actor.subkeyId || null, client_id: actor.clientId || null, person_id: actor.personId || null, login_tag: bound });
    }
    return actor;
  }

  // Remembered tags for this client_id (Alex 2026-10-12).
  let remembered = [];
  if (deps && actor.clientId && actor.clientId !== 'http:visitor') {
    const cur0 = await loadApprovals(deps);
    if (cur0.data) remembered = rememberedFor(cur0.data, actor.clientId);
  }
  actor.rememberedTags = remembered;
  if (!declared && !bound && remembered.length > 1 && isWrite) {
    throw refusal(`this client is remembered under several tags (${remembered.join(', ')}); pass "source" with yours. Nothing was written.`);
  }
  if (declared && declared !== bound && remembered.length && !remembered.includes(declared) && !registry.includes(declared)) {
    // A different tag than the remembered one: a rename, which needs the owner.
    actor.declaredTag = declared; actor.sourceBasis = 'declared'; actor.effectiveTag = declared; actor.approvalState = 'rename_pending';
    if (isWrite) {
      await mutateApprovals(deps, (d) => {
        if (d.pending[declared]) return false;
        d.pending[declared] = {
          kind: 'rename', rename_from: remembered, first_seen: now.toISOString(), declared_name: declared, basis: 'declared',
          client_id: actor.clientId || null, grant_id: actor.grantId || null, person_id: actor.personId || null, login_tag: bound,
          tool: toolName, what: summarizeWrite(toolName, args), routed_to: cosTag() || 'owner'
        };
        return true;
      });
      throw refusal(`this client is remembered as ${remembered.map((t) => `"${t}"`).join(', ')}; "${declared}" is a rename and waits for ${cosTag() ? `the chief of staff (${cosTag()})` : 'the owner'} to approve it. Use your remembered tag. Nothing was written.`);
    }
    return actor;
  }
  const keptAuto = !declared && !bound && remembered.length === 1 ? remembered[0] : null;
  const effective = declared || bound || keptAuto || (actor.clientId && actor.clientId !== 'http:visitor' ? autoTag(actor.clientId) : null);
  const basis = declared && declared !== bound ? 'declared' : (bound ? 'login' : (keptAuto ? 'remembered' : (effective ? 'auto' : null)));
  actor.declaredTag = basis === 'declared' || basis === 'auto' || basis === 'remembered' ? effective : null;
  actor.sourceBasis = basis;
  actor.effectiveTag = effective;
  actor.approvalState = basis === 'login' ? 'login' : (registry.includes(effective) ? 'registered' : null);

  // New-client gate (Alex 2026-10-12). Bound tags were approved at consent;
  // registered tags by the owner's env. Everything else needs the record.
  if (deps && effective && basis !== 'login' && !registry.includes(effective)) {
    const cur = await loadApprovals(deps);
    if (cur.broken) {
      actor.approvalState = 'unreadable';
      if (isWrite) throw refusal(`${APPROVALS_DOC} does not parse, so new clients fail closed. Nothing was written.`);
      return actor;
    }
    const appr = cur.data;
    if (Object.prototype.hasOwnProperty.call(appr.approved, effective)) actor.approvalState = 'approved';
    else if (Object.prototype.hasOwnProperty.call(appr.denied, effective)) {
      actor.approvalState = 'denied';
      if (isWrite) throw refusal(`"${effective}" was denied as a client on this store; it may read only. Nothing was written.`);
    } else {
      const fresh = cur.missing && registry.length === 0 && personIsOwner(actor, ownerId) && !(await storeHasOtherClients(db, prefix, actor));
      if (fresh && isWrite) {
        await mutateApprovals(deps, (d, c) => {
          if (!c.missing || Object.keys(d.approved).length) return false; // someone else got there first
          d.approved[effective] = { by: 'auto: first solo client on a fresh store', at: now.toISOString(), primary: true, client_id: actor.clientId || null, person_id: actor.personId || null };
          remember(d, actor.clientId, effective, { declared_name: declared || effective, basis, at: now.toISOString() });
          return true;
        });
        if (!approvalsCache.data.approved[effective]) throw refusal(`"${effective}" is a new client and the store already has a primary; it waits for approval. Nothing was written.`);
        actor.approvalState = 'approved';
      } else {
        actor.approvalState = appr.pending[effective] ? 'pending' : 'new';
        if (isWrite) {
          // A missing record on a store that has other clients is never a fresh
          // store: no auto-approve (fail closed). Queuing creates the record.
          await mutateApprovals(deps, (d) => {
            if (d.pending[effective] || d.approved[effective] || d.denied[effective]) return false;
            d.pending[effective] = {
              first_seen: now.toISOString(), declared_name: effective, basis,
              client_id: actor.clientId || null, grant_id: actor.grantId || null, person_id: actor.personId || null, login_tag: bound,
              tool: toolName, what: summarizeWrite(toolName, args), routed_to: cosTag() || 'owner'
            };
            return true;
          });
          actor.approvalState = 'pending';
          throw refusal(`"${effective}" is a new client on this store and is read-limited until ${cosTag() ? `the chief of staff (${cosTag()})` : 'the owner'} approves it with emet_client_approve. The request is queued; nothing was written.`);
        }
      }
    }
  }

  // Session tie on every write (A1), rebuilt from stored rows after a restart (A4).
  // emet_session_open claims the session it is about to open.
  const base = !isWrite ? null : (toolName === 'emet_session_open' ? sessionOpenBase(args, now) : sessionBaseOf(args));
  if (base && effective) {
    let row = SESSION_BINDINGS.get(base);
    if (!row) {
      const stored = await storedSessionTags(db, base, layerCollections);
      const other = stored.find((t) => t !== effective);
      if (other) row = { agent_tag: other };
    }
    if (row && row.agent_tag !== effective) {
      throw refusal(`session ${base} belongs to "${row.agent_tag}"; "${effective}" may not write in it. Open your own session. Nothing was written.`);
    }
    bindSession(base, effective, { client_id: actor.clientId || null, person_id: actor.personId || null, login_tag: bound });
  }
  return actor;
}

export function summarizeWrite(toolName, args) {
  const a = args || {};
  const parts = [toolName];
  if (a.doc_id) parts.push(`doc ${a.doc_id}`);
  if (a.layer) parts.push(`layer ${a.layer}`);
  if (a.session_id) parts.push(`session ${a.session_id}`);
  const text = a.content || a.new_str || a.assistant_message || '';
  if (text) parts.push(`"${String(text).slice(0, 200)}"`);
  return parts.join(' · ');
}

/** The approvals view for a startup or status payload, or null for callers who do not see it. */
export function approvalsView(data, actor, ownerId) {
  if (!data) return null;
  const cos = cosTag();
  const isCos = actorIsCos(actor);
  const owner = actorIsOwner(actor, ownerId);
  if (!(isCos || owner)) return null;
  const pending = Object.entries(data.pending || {}).map(([t, p]) => ({ tag: t, ...p }));
  // Routed to the COS when one is set; the owner then sees the count.
  if (cos && !isCos) return { routed_to: cos, pending_count: pending.length };
  return { routed_to: cos || 'owner', pending, approve_with: 'emet_client_approve {"tag": "<tag>", "decision": "approve"|"deny"}' };
}

/**
 * emet_client_approve. Only the owner acting as the owner, or the configured
 * COS on its own login tag; never the client deciding itself (the reviewer 1).
 * Idempotent: the same decision again writes nothing (the reviewer 2).
 */
export async function clientApprove(deps, actor, ownerId, { tag, decision, reason, as, from } = {}, _registry = [], now = new Date()) {
  const t = typeof tag === 'string' ? tag.trim() : '';
  if (!t) throw refusal('emet_client_approve: pass "tag", the pending client to decide. Nothing was changed.');
  if (decision !== 'approve' && decision !== 'deny') throw refusal('emet_client_approve: "decision" must be "approve" or "deny". Nothing was changed.');
  const me = actor && (actor.effectiveTag || actor.sourceTag) || null;
  if (actor && actor.transport === 'http' && me === t) throw refusal('emet_client_approve: a client may not decide its own approval. Nothing was changed.');
  const ownerOk = actorIsOwner(actor, ownerId);
  const cosOk = actorIsCos(actor);
  if (!(ownerOk || cosOk)) throw refusal(`emet_client_approve: only the owner${cosTag() ? ` or the chief of staff (${cosTag()})` : ''} may decide new clients. Nothing was changed.`);
  if (setting('SUBKEYS') === '1') {
    const { decideSubkeyIfPending } = await import('./subkeys.js');
    const decided = await decideSubkeyIfPending(deps, actor, ownerId, { tag: t, decision, reason }, now);
    if (decided) return decided;
  }
  const by = ownerOk ? `owner (${actor && actor.personId || 'local'})` : `cos ${cosTag()}`;
  let result = null;
  await mutateApprovals(deps, (d) => {
    // the reviewer round 3: whatever path made the caller "owner" or "COS", it may never
    // decide a request that its own connection queued (same client_id or same
    // grant), nor a tag equal to its own. A bot on a shared login that omits
    // `source` looks like the login; this catches it.
    const req = d.pending[t] || (d.approved[t] && d.approved[t].request) || (d.denied[t] && d.denied[t].request) || null;
    if (actor && actor.transport === 'http' && req) {
      const sameClient = !!req.client_id && req.client_id === (actor.clientId || null);
      const sameGrant = !!req.grant_id && req.grant_id === (actor.grantId || null);
      if (sameClient || sameGrant) throw refusal('emet_client_approve: this connection queued the request for "' + t + '", so it may not decide it. Decide from another client. Nothing was changed.');
    }
    // the reviewer delta M2: a client_id that already has approved tags needs an explicit
    // `as` ('add' keeps every sibling, 'rename' retires one named tag).
    const cidReq = (d.pending[t] && d.pending[t].client_id) || null;
    const siblings = decision === 'approve' && cidReq ? rememberedFor(d, cidReq).filter((x) => x !== t) : [];
    let retireFrom = null;
    if (siblings.length && !(d.approved[t] && !d.pending[t])) {
      if (as !== 'add' && as !== 'rename') throw refusal(`emet_client_approve: client ${cidReq} already has approved tags (${siblings.join(', ')}). Pass "as": "add" to keep them and add "${t}", or "as": "rename" to replace one. Nothing was changed.`);
      if (as === 'rename') {
        retireFrom = siblings.length === 1 ? siblings[0] : (typeof from === 'string' && siblings.includes(from.trim()) ? from.trim() : null);
        if (!retireFrom) throw refusal(`emet_client_approve: client ${cidReq} has several approved tags (${siblings.join(', ')}); a rename must name the one it replaces with "from". Nothing was changed.`);
      }
    }
    const into = decision === 'approve' ? d.approved : d.denied;
    const other = decision === 'approve' ? d.denied : d.approved;
    if (into[t] && !d.pending[t]) { result = { tag: t, decision, by: into[t].by, at: into[t].at, unchanged: true }; return false; }
    const pend = d.pending[t] || (other[t] && other[t].request) || null;
    delete d.pending[t];
    delete other[t];
    into[t] = { by, at: now.toISOString(), reason: reason || null, ...(pend ? { request: pend } : {}) };
    if (decision === 'approve' && pend && pend.client_id) {
      remember(d, pend.client_id, t, { declared_name: pend.declared_name || t, basis: pend.basis || null, at: into[t].at, renamed_from: retireFrom });
    }
    result = { tag: t, decision, by, at: into[t].at };
    return true;
  });
  return result;
}

/** What emet_initialize tells a client about its remembered tag (Alex 2026-10-12). */
export function rememberedView(actor) {
  const tags = actor && Array.isArray(actor.rememberedTags) ? actor.rememberedTags : [];
  if (!tags.length) return null;
  const declared = actor.declaredTag || null;
  const use = declared && tags.includes(declared) ? declared : (tags.length === 1 ? tags[0] : null);
  return {
    remembered_tags: tags, use_tag: use,
    instruction: use
      ? `This client is remembered as "${use}". Pass source "${use}" on every write; a different tag is a rename and needs the owner's approval.`
      : `This client is remembered under several tags (${tags.join(', ')}). Pass source with the one that is yours; a new tag needs the owner's approval.`
  };
}
