/**
 * Operational error log. Not a controlled document and not a memory.
 * Entries are capped and rotated. Nothing here stores message text,
 * arguments, document ids, names, or secrets.
 */

import { readySharedClient } from './mongo-connect.js';
import { MONGODB_URI, MONGODB_DB, ErrorCodes } from './database.js';
import { redactText } from './redact.js';
import { currentActor, getPerson } from './persons.js';
import { registeredSourceTags } from './setup.js';
import { EMET_VERSION } from './version.js';
import { CodedError, EMET_CODE_RE, EMET_INT_001, lookupEmetCode, newCorrelationId } from './error-codes.js';

export const ERROR_LOG_COLLECTION = 'error_log';
export const ERROR_LOG_SUMMARY_COLLECTION = 'error_log_summary';
export const ERROR_LOG_MAX = 10000;
export const ERROR_LOG_DAYS = 90;

const ENTRY_KEYS = Object.freeze([
  '_id', 't', 'emet_code', 'class_code', 'tool', 'version', 'transport', 'caller', 'role', 'correlation_id', 'count'
]);
const SUMMARY_KEYS = Object.freeze(['day', 'emet_code', 'tool', 'version', 'count']);
const CLASS_CODES = new Set(Object.values(ErrorCodes));

let backend = null;
let indexed = false;
let chain = Promise.resolve();

/** Test seam. Pass null to use Mongo again. */
export function setErrorLogBackend(store) {
  backend = store;
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

function callerTag() {
  let raw = null;
  try {
    const actor = currentActor();
    if (actor && typeof actor.sourceTag === 'string' && actor.sourceTag) raw = actor.sourceTag;
  } catch { raw = null; }
  const tags = registeredSourceTags();
  if (typeof raw !== 'string' || !tags.includes(raw)) return 'unregistered';
  const clean = scrub(raw);
  if (clean !== raw) return 'unregistered';
  return raw;
}

async function roleOf(db) {
  try {
    const actor = currentActor();
    if (actor.transport === 'stdio') return 'owner';
    if (actor.transport !== 'http' || !actor.personId || !db) return 'guest';
    const person = await getPerson(db, actor.personId);
    return person && person.role === 'owner' ? 'owner' : 'guest';
  } catch {
    return 'guest';
  }
}

function buildEntry(fields) {
  const doc = {
    _id: fields._id || newCorrelationId(),
    t: typeof fields.t === 'string' && fields.t ? fields.t : new Date().toISOString(),
    emet_code: safeCode(fields.emet_code),
    class_code: safeClass(fields.class_code),
    tool: safeTool(fields.tool),
    version: EMET_VERSION,
    transport: fields.transport === 'http' ? 'http' : 'stdio',
    caller: fields.caller === 'unregistered' || typeof fields.caller !== 'string' ? 'unregistered' : (scrub(fields.caller) === fields.caller ? fields.caller : 'unregistered'),
    role: fields.role === 'owner' ? 'owner' : 'guest',
    correlation_id: safeCorrelation(fields.correlation_id),
    count: 1
  };
  const out = {};
  for (const key of ENTRY_KEYS) out[key] = doc[key];
  return out;
}

function dbHandle() {
  if (!MONGODB_URI) return null;
  const client = readySharedClient();
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
    await db.collection(ERROR_LOG_SUMMARY_COLLECTION).createIndex(
      { day: 1, emet_code: 1, tool: 1, version: 1 },
      { unique: true }
    );
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
    count: Number(row.count) || 0
  };
  const stored = {};
  for (const key of SUMMARY_KEYS) stored[key] = summary[key];
  if (backend) {
    if (backend.fail) throw new CodedError('error log down', { code: 'EMET-INT-001' });
    const found = backend.summaries.find((s) => s.day === stored.day && s.emet_code === stored.emet_code && s.tool === stored.tool && s.version === stored.version);
    if (found) found.count += stored.count;
    else backend.summaries.push({ ...stored });
    return stored;
  }
  const db = await dbHandle();
  if (!db) return stored;
  await db.collection(ERROR_LOG_SUMMARY_COLLECTION).updateOne(
    { day: stored.day, emet_code: stored.emet_code, tool: stored.tool, version: stored.version },
    { $inc: { count: stored.count } },
    { upsert: true }
  );
  return stored;
}

async function loadRows() {
  if (backend) return backend.entries.map((row) => ({ ...row }));
  const col = await logCollection();
  if (!col) return [];
  return col.find({}, { projection: { t: 1, emet_code: 1, tool: 1, version: 1, count: 1 } }).toArray();
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
    const key = `${String(row.t).slice(0, 10)}\0${row.emet_code}\0${row.tool}\0${row.version}`;
    const group = groups.get(key) || {
      day: String(row.t).slice(0, 10),
      emet_code: row.emet_code,
      tool: row.tool,
      version: row.version,
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
  const job = (async () => {
    try {
      const db = backend ? null : await dbHandle();
      const actor = currentActor();
      await insertErrorLog({
        t: new Date().toISOString(),
        emet_code: input.emet_code,
        class_code: input.class_code,
        tool: input.tool,
        correlation_id: input.correlation_id,
        transport: actor.transport === 'http' ? 'http' : 'stdio',
        caller: callerTag(),
        role: await roleOf(db)
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
