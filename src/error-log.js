/**
 * Operational error log. Not a controlled document and not a memory.
 * Entries are capped and rotated. Nothing here stores message text,
 * arguments, document ids, or secrets. client_id and grant_id are
 * the caller's credential ids (a registration id or metadata URL, and the
 * token family). A value that is not that shape is stored as unknown or none.
 * A refused or failed emet_session_close also stores session_id when it is a
 * minted session id (YYYY-MM-DD_slug, optional -N through -99, optional
 * _verbatim_partN). A bearer, a JWT, a URI, or any other shape is unknown.
 * Every other row stores none. A caller-supplied session id on any other
 * tool is not stored.
 * A daily summary keeps client_id with the count when its index can.
 */

import { readySharedClient } from './mongo-connect.js';
import { MONGODB_DB, ErrorCodes } from './database.js';
import { redactText } from './redact.js';
import { currentActor, getPerson } from './persons.js';
import { logClientId, logDoor, logGrantId } from './grants.js';
import { registeredSourceTags } from './setup.js';
import { EMET_VERSION } from './version.js';
import { CodedError, EMET_CODE_RE, EMET_INT_001, lookupEmetCode, newCorrelationId } from './error-codes.js';

export const ERROR_LOG_COLLECTION = 'error_log';
export const ERROR_LOG_SUMMARY_COLLECTION = 'error_log_summary';
export const ERROR_LOG_MAX = 10000;
export const ERROR_LOG_DAYS = 90;

const ENTRY_KEYS = Object.freeze([
  '_id', 't', 'emet_code', 'class_code', 'tool', 'version', 'transport', 'caller', 'role',
  'client_id', 'grant_id', 'door', 'session_id', 'correlation_id', 'count'
]);
// Minted by sessionBaseId / firstUnclosedBase / partId only:
//   YYYY-MM-DD_slug[-N][_verbatim_partN]
// The slug is lowercase, hyphens only between alphanumerics, at most 40
// characters, or 43 when a closed base is reopened as -2..-99. A bearer
// (ghp_, sk-), a JWT, a URI, a space, or any other shape is unknown.
// redactText leaves ghp_ and sk- unchanged, and a JWT whose signature is
// shorter than 8 characters, so the grammar is the guard, not the scrub.
const SESSION_ID_RE = /^([0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01]))_([a-z0-9]+(?:-[a-z0-9]+)*)(?:_verbatim_part([1-9][0-9]{0,3}))?$/;
const SESSION_SLUG_MAX = 43;
const SUMMARY_KEYS = Object.freeze(['day', 'emet_code', 'tool', 'version', 'client_id', 'count']);
const CLASS_CODES = new Set(Object.values(ErrorCodes));

let backend = null;
let indexed = false;
let chain = Promise.resolve();
// False when an older unique summary index cannot be replaced. The server
// role may create indexes and may not drop them. Rotation then keeps the
// old counts and does not invent a client on a shared summary row.
let summaryKeepsClient = true;

/** Test seam. Pass null to use Mongo again. */
export function setErrorLogBackend(store) {
  backend = store;
}

/** Test seam. The summary index decision is once per process. */
export function _resetErrorLogForTests() {
  indexed = false;
  summaryKeepsClient = true;
}

export function useMemoryErrorLog() {
  const store = { entries: [], summaries: [], fail: false };
  backend = store;
  return store;
}

export function flushErrorLog() {
  return chain;
}

function scrub(value) {
  return redactText(String(value ?? ''));
}

function safeCode(code) {
  return typeof code === 'string' && EMET_CODE_RE.test(code) && lookupEmetCode(code) ? code : EMET_INT_001;
}

function safeClass(code) {
  return CLASS_CODES.has(code) ? code : ErrorCodes.INTERNAL_ERROR;
}

function safeTool(name) {
  return typeof name === 'string' && /^[a-z0-9_]{1,80}$/.test(name) ? name : 'unknown';
}

function safeCorrelation(id) {
  return typeof id === 'string' && /^[0-9a-f]{16}$/.test(id) ? id : newCorrelationId();
}

/** Log-safe session id. Only a minted YYYY-MM-DD_slug[-N][_verbatim_partN] is kept. */
export function logSessionId(id) {
  if (typeof id !== 'string') return 'unknown';
  const trimmed = id.trim();
  const match = SESSION_ID_RE.exec(trimmed);
  if (!match || match[2].length > SESSION_SLUG_MAX) return 'unknown';
  const clean = scrub(trimmed);
  return clean === trimmed ? trimmed : 'unknown';
}

function callerTag(actor) {
  let raw = null;
  try {
    const who = actor || currentActor();
    if (who && typeof who.sourceTag === 'string' && who.sourceTag) raw = who.sourceTag;
  } catch { raw = null; }
  const tags = registeredSourceTags();
  if (typeof raw !== 'string' || !tags.includes(raw)) return 'unregistered';
  const clean = scrub(raw);
  if (clean !== raw) return 'unregistered';
  return raw;
}

async function roleOf(db, actor) {
  try {
    const who = actor || currentActor();
    if (who.transport === 'stdio') return 'owner';
    if (who.transport !== 'http' || !who.personId || !db) return 'guest';
    const person = await getPerson(db, who.personId);
    return person && person.role === 'owner' ? 'owner' : 'guest';
  } catch {
    return 'guest';
  }
}

/** Credential for the log. Stdio with no client id is the local client. logClientId turns anything else missing or unrecognised into unknown. */
function clientIdForLog(actor) {
  if (actor && typeof actor.clientId === 'string' && actor.clientId) return actor.clientId;
  if (actor && actor.transport === 'stdio') return 'stdio';
  return null;
}

/** The pre-client_id unique summary index: day, code, tool, version. A client_id key is the new index. */
function legacySummaryIndex(indexes) {
  return (indexes || []).find((idx) => {
    const key = idx && idx.key;
    if (!idx || idx.unique !== true || !key) return false;
    const names = Object.keys(key);
    return names.length === 4 && key.day === 1 && key.emet_code === 1 && key.tool === 1 && key.version === 1;
  });
}

async function ensureSummaryIndex(db) {
  const summary = db.collection(ERROR_LOG_SUMMARY_COLLECTION);
  let indexes = [];
  try { indexes = await summary.indexes(); } catch { indexes = []; }
  const legacy = legacySummaryIndex(indexes);
  if (legacy) {
    if (!legacy.name) summaryKeepsClient = false;
    else {
      try { await summary.dropIndex(legacy.name); }
      catch { summaryKeepsClient = false; }
    }
  }
  if (!summaryKeepsClient) return;
  await summary.createIndex(
    { day: 1, emet_code: 1, tool: 1, version: 1, client_id: 1 },
    { unique: true }
  );
}

function buildEntry(fields) {
  const tool = safeTool(fields.tool);
  const doc = {
    _id: fields._id || newCorrelationId(),
    t: typeof fields.t === 'string' && fields.t ? fields.t : new Date().toISOString(),
    emet_code: safeCode(fields.emet_code),
    class_code: safeClass(fields.class_code),
    tool,
    version: EMET_VERSION,
    transport: fields.transport === 'http' ? 'http' : 'stdio',
    caller: fields.caller === 'unregistered' || typeof fields.caller !== 'string' ? 'unregistered' : (scrub(fields.caller) === fields.caller ? fields.caller : 'unregistered'),
    role: fields.role === 'owner' ? 'owner' : 'guest',
    client_id: logClientId(fields.client_id),
    grant_id: logGrantId(fields.grant_id),
    door: logDoor(fields.door),
    // Only a session-close row carries a session id. Other tools stay none,
    // even when the caller put a session id on the input.
    session_id: tool === 'emet_session_close' ? logSessionId(fields.session_id) : 'none',
    correlation_id: safeCorrelation(fields.correlation_id),
    count: 1
  };
  const out = {};
  for (const key of ENTRY_KEYS) out[key] = doc[key];
  return out;
}

function dbHandle() {
  const client = readySharedClient();
  // No open client means there is no log database. A URI with no client yet
  // is the same. A client already bound (including a test double) is the store.
  if (!client) return null;
  return client.db(MONGODB_DB);
}

async function logCollection() {
  const db = await dbHandle();
  if (!db) return null;
  const col = db.collection(ERROR_LOG_COLLECTION);
  if (!indexed) {
    indexed = true;
    await col.createIndex({ t: -1 });
    await col.createIndex({ emet_code: 1, t: -1 });
    await col.createIndex({ correlation_id: 1 }, { unique: true });
    await ensureSummaryIndex(db);
  }
  return col;
}

export async function insertErrorLog(fields) {
  const doc = buildEntry(fields);
  if (backend) {
    if (backend.fail) throw new CodedError('error log down', { code: 'EMET-INT-001' });
    backend.entries.push(doc);
    return doc;
  }
  const col = await logCollection();
  if (!col) return doc;
  await col.insertOne(doc);
  return doc;
}

export async function upsertErrorSummary(row) {
  const summary = {
    day: String(row.day || '').slice(0, 10),
    emet_code: safeCode(row.emet_code),
    tool: safeTool(row.tool),
    version: typeof row.version === 'string' ? row.version : EMET_VERSION,
    client_id: logClientId(row.client_id),
    count: Number(row.count) || 0
  };
  const stored = {};
  for (const key of SUMMARY_KEYS) stored[key] = summary[key];
  if (backend) {
    if (backend.fail) throw new CodedError('error log down', { code: 'EMET-INT-001' });
    const found = backend.summaries.find((s) => s.day === stored.day && s.emet_code === stored.emet_code && s.tool === stored.tool && s.version === stored.version && s.client_id === stored.client_id);
    if (found) found.count += stored.count;
    else backend.summaries.push({ ...stored });
    return stored;
  }
  const db = await dbHandle();
  if (!db) return stored;
  // Decide the summary index before the first upsert. A rotation can be the
  // process's first write, and the old unique index must not be asked to
  // hold one row per client until we know whether it can be replaced.
  if (!indexed) await logCollection();
  const filter = {
    day: stored.day,
    emet_code: stored.emet_code,
    tool: stored.tool,
    version: stored.version
  };
  if (summaryKeepsClient) filter.client_id = stored.client_id;
  await db.collection(ERROR_LOG_SUMMARY_COLLECTION).updateOne(
    filter,
    { $inc: { count: stored.count } },
    { upsert: true }
  );
  return stored;
}

async function loadRows() {
  if (backend) return backend.entries.map((row) => ({ ...row }));
  const col = await logCollection();
  if (!col) return [];
  return col.find({}, { projection: { t: 1, emet_code: 1, tool: 1, version: 1, client_id: 1, count: 1 } }).toArray();
}

export async function rotateErrorLog(options = {}) {
  const max = options.maxEntries ?? ERROR_LOG_MAX;
  const days = options.maxAgeDays ?? ERROR_LOG_DAYS;
  const now = options.now instanceof Date ? options.now : new Date();
  const ageCutoff = new Date(now.getTime() - days * 86400000).toISOString();
  const rows = await loadRows();
  const sorted = [...rows].sort((a, b) => (a.t < b.t ? 1 : a.t > b.t ? -1 : String(a._id) < String(b._id) ? 1 : -1));
  const keep = new Set(sorted.slice(0, max).map((row) => row._id));
  const removed = sorted.filter((row) => row.t < ageCutoff || !keep.has(row._id));
  if (!removed.length) return { removed: 0 };
  let day = ageCutoff.slice(0, 10);
  if (removed.some((row) => row.t >= ageCutoff)) {
    const kept = sorted.filter((row) => !removed.includes(row));
    const oldest = kept[kept.length - 1];
    if (oldest) day = String(oldest.t).slice(0, 10);
  }
  const groups = new Map();
  for (const row of removed) {
    const client_id = logClientId(row.client_id);
    const key = `${String(row.t).slice(0, 10)}\0${row.emet_code}\0${row.tool}\0${row.version}\0${client_id}`;
    const group = groups.get(key) || {
      day: String(row.t).slice(0, 10),
      emet_code: row.emet_code,
      tool: row.tool,
      version: row.version,
      client_id,
      count: 0
    };
    group.count += Number(row.count) || 1;
    groups.set(key, group);
  }
  for (const group of groups.values()) await upsertErrorSummary(group);
  const ids = removed.map((row) => row._id);
  if (backend) {
    const drop = new Set(ids);
    backend.entries = backend.entries.filter((row) => !drop.has(row._id));
  } else {
    const col = await logCollection();
    if (col) await col.deleteMany({ _id: { $in: ids } });
  }
  console.error(`rotated ${removed.length} entries older than ${day}`);
  return { removed: removed.length, day };
}

export async function queryErrorLog({ since, correlation_id, codes } = {}) {
  let rows;
  if (backend) rows = backend.entries.map((row) => ({ ...row }));
  else {
    const col = await logCollection();
    rows = col ? await col.find({}).toArray() : [];
  }
  if (correlation_id) rows = rows.filter((row) => row.correlation_id === correlation_id);
  else {
    if (since) rows = rows.filter((row) => row.t >= since);
    if (Array.isArray(codes) && codes.length) {
      const wanted = new Set(codes);
      rows = rows.filter((row) => wanted.has(row.emet_code));
    }
  }
  rows.sort((a, b) => (a.t < b.t ? 1 : a.t > b.t ? -1 : 0));
  return rows;
}

export async function recordError(input = {}) {
  // Read the credential now. The write itself may await, and the row has to
  // name the client that was refused, not whoever is current when it lands.
  // A client_id on the input is not read.
  const actor = currentActor();
  const client_id = clientIdForLog(actor);
  const grant_id = actor.grantId ? actor.grantId : 'unknown';
  const transport = actor.transport === 'http' ? 'http' : 'stdio';
  const caller = callerTag(actor);
  // Stdio is an explicit transport. No actor, or a null transport, is not
  // that door: an error raised outside actorStore.run must not be logged
  // as stdio. logDoor stores anything else as `unknown`.
  const door = actor.transport === 'http' ? actor.door : (actor.transport === 'stdio' ? 'stdio' : 'unknown');
  const job = (async () => {
    try {
      const db = backend ? null : await dbHandle();
      await insertErrorLog({
        t: new Date().toISOString(),
        emet_code: input.emet_code,
        class_code: input.class_code,
        tool: input.tool,
        correlation_id: input.correlation_id,
        transport,
        caller,
        role: await roleOf(db, actor),
        client_id,
        // A missing door grant is the string `unknown`. buildEntry runs that
        // value through logGrantId, which keeps `unknown` and turns a bearer into `none`.
        grant_id,
        door,
        // Read only for emet_session_close. buildEntry drops it on every other tool.
        session_id: input.session_id
      });
    } catch {
      console.error('error log write failed');
    }
  })();
  chain = chain.then(() => job, () => job);
  return job;
}

export function startErrorLogRotation() {
  const run = () => {
    rotateErrorLog().catch(() => { console.error('error log write failed'); });
  };
  const kick = setTimeout(run, 1000);
  if (kick.unref) kick.unref();
  const timer = setInterval(run, 24 * 60 * 60 * 1000);
  if (timer.unref) timer.unref();
  return timer;
}
