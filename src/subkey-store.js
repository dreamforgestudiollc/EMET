/**
 * Sub-key records (EMET-0001). Their own collections, not the approvals
 * document: a read token that can read emet/CLIENT_APPROVALS.md cannot read
 * them, and a last_used update does not rewrite that document.
 *
 *   ${prefix}subkeys          one document per key, one per session open
 *   ${prefix}subkeys_history  append-only events, each with its own id
 *
 * A change is a compare-and-set on that document's rev, and it writes only
 * the documents the change touched. Two writers that read the same rev: one
 * update matches, the other retries from a fresh read. A unique partial
 * index on a pending key's tag lets only one pending row exist for that tag.
 * History inserts use the event's own id and are never dropped on a
 * duplicate-key error.
 *
 * Nothing here deletes a document. A later state replaces that one document's
 * fields. Reads of either collection for a caller are refused unless the
 * caller is the owner or the chief of staff; that check lives in subkeys.js.
 *
 * The Mongo handle is the server's shared client (mongo-connect.js), not a
 * new connection per call.
 */

import crypto from 'node:crypto';
import { setting } from './env.js';
import { acquireSharedClient, testClientActive } from './mongo-connect.js';
import { MONGODB_URI, MONGODB_DB, COLLECTION_PREFIX } from './database.js';

const SUBKEYS_COLLECTION = `${COLLECTION_PREFIX}subkeys`;
const SUBKEYS_HISTORY_COLLECTION = `${COLLECTION_PREFIX}subkeys_history`;
const PENDING_TAG_INDEX = 'pending_tag';

function clone(v) { return JSON.parse(JSON.stringify(v)); }

/** In-memory stand-in. Tests attach one of these to deps.subkeys. */
export function createMemoryStore() {
  const keys = new Map();
  const sessions = new Map();
  const history = [];
  let lock = Promise.resolve();
  let touches = 0;
  const api = {
    backend: 'memory',
    touches() { return touches; },
    async snapshot() {
      return {
        keys: Object.fromEntries([...keys.entries()].map(([id, row]) => [id, clone(row)])),
        sessions: [...sessions.values()].map(clone),
        history: history.map(clone)
      };
    },
    async mutate(fn) {
      const run = async () => {
        const data = await api.snapshot();
        const beforeKeys = new Map(Object.entries(data.keys).map(([id, row]) => [id, clone(row)]));
        const beforeSessions = new Map((data.sessions || []).filter((s) => s && s.open_id).map((s) => [s.open_id, clone(s)]));
        const seen = new Set();
        for (const row of Object.values(data.keys)) {
          for (const ev of (row && row.history) || []) if (ev && ev.event_id) seen.add(ev.event_id);
        }
        const changed = await fn(data);
        if (changed === false) return { written: false };
        for (const [id, row] of Object.entries(data.keys || {})) {
          const prev = beforeKeys.get(id);
          const hist = Array.isArray(row.history) ? row.history : [];
          const prevLen = prev && Array.isArray(prev.history) ? prev.history.length : 0;
          hist.forEach((ev, i) => {
            if (!ev) return;
            if (ev.event_id) {
              if (seen.has(ev.event_id)) return;
              seen.add(ev.event_id);
            } else if (i < prevLen) return;
            history.push({ key_id: id, ...clone(ev) });
          });
          if (!prev || JSON.stringify(prev) !== JSON.stringify(row)) keys.set(id, clone(row));
        }
        for (const s of data.sessions || []) {
          if (!s || !s.open_id) continue;
          const prev = beforeSessions.get(s.open_id);
          if (!prev || JSON.stringify(prev) !== JSON.stringify(s)) sessions.set(s.open_id, clone(s));
        }
        return { written: true };
      };
      const p = lock.then(run, run);
      lock = p.catch(() => {});
      return p;
    },
    async touchLastUsed(keyId, iso) {
      const row = keys.get(keyId);
      if (!row) return false;
      row.last_used = iso;
      touches += 1;
      return true;
    }
  };
  return api;
}

const indexReady = new WeakMap();

async function mongoCols() {
  const client = await acquireSharedClient(MONGODB_URI, { serverSelectionTimeoutMS: 8000, maxPoolSize: 10 });
  const db = client.db(MONGODB_DB);
  const keys = db.collection(SUBKEYS_COLLECTION);
  if (setting('SUBKEYS') === '1' && !indexReady.has(client)) {
    indexReady.set(client, keys.createIndex(
      { tag: 1 },
      { name: PENDING_TAG_INDEX, unique: true, partialFilterExpression: { kind: 'key', status: 'pending' } }
    ).catch((err) => { indexReady.delete(client); throw err; }));
  }
  if (indexReady.has(client)) await indexReady.get(client);
  return { keys, hist: db.collection(SUBKEYS_HISTORY_COLLECTION) };
}

function revOf(doc) {
  return doc && Number.isInteger(doc.rev) && doc.rev > 0 ? doc.rev : 0;
}

function revFilter(id, rev) {
  if (!rev) return { _id: id, $or: [{ rev: 0 }, { rev: { $exists: false } }] };
  return { _id: id, rev };
}

function changedFields(prev, next) {
  const set = {};
  const unset = {};
  const names = new Set([...Object.keys(prev || {}), ...Object.keys(next || {})]);
  for (const k of names) {
    if (k === '_id' || k === 'rev') continue;
    const a = prev ? prev[k] : undefined;
    const b = next ? next[k] : undefined;
    if (JSON.stringify(a) === JSON.stringify(b)) continue;
    if (b === undefined) unset[k] = '';
    else set[k] = b;
  }
  return { set, unset };
}

function sameDoc(a, b) {
  return JSON.stringify({ ...(a || {}), _id: undefined, rev: undefined }) === JSON.stringify({ ...(b || {}), _id: undefined, rev: undefined });
}

async function readWorking(keys) {
  const keyDocs = await keys.find({ kind: 'key' }).toArray();
  const sessionDocs = await keys.find({ kind: 'session' }).toArray();
  const map = {};
  for (const d of keyDocs) {
    const row = { ...d };
    delete row._id;
    map[d.key_id] = row;
  }
  return {
    keys: map,
    sessions: sessionDocs.map((d) => { const s = { ...d }; delete s._id; return s; })
  };
}

async function casUpdate(col, id, prev, next, extra) {
  const oldRev = revOf(prev);
  const { set, unset } = changedFields(prev, next);
  Object.assign(set, extra);
  delete set._id;
  delete set.rev;
  const update = { $inc: { rev: 1 } };
  if (Object.keys(set).length) update.$set = set;
  if (Object.keys(unset).length) update.$unset = unset;
  const res = await col.updateOne(revFilter(id, oldRev), update);
  return res.matchedCount === 1;
}

async function revertUpdate(col, id, prev) {
  const oldRev = revOf(prev);
  const body = { ...(prev || {}) };
  delete body._id;
  body.rev = oldRev;
  const res = await col.replaceOne({ _id: id, rev: oldRev + 1 }, { _id: id, ...body });
  if (res.matchedCount !== 1) {
    const err = new Error('a partial update persisted and could not be reverted.');
    err.partial = true;
    throw err;
  }
}

function pendingTagClash(err) {
  return !!(err && err.code === 11000 && String(err.message || '').includes(PENDING_TAG_INDEX));
}

function mongoStore() {
  return {
    backend: 'mongo',
    touches() { return 0; },
    async snapshot() {
      const { keys, hist } = await mongoCols();
      const working = await readWorking(keys);
      const histDocs = await hist.find({ kind: 'history' }).toArray();
      return {
        keys: working.keys,
        sessions: working.sessions,
        history: histDocs.map((d) => { const h = { ...d }; delete h._id; return h; })
      };
    },
    async mutate(fn) {
      const { keys, hist } = await mongoCols();
      for (let attempt = 0; attempt < 8; attempt++) {
        const snap = await readWorking(keys);
        const beforeKeys = clone(snap.keys);
        const beforeSessions = clone(snap.sessions);
        const changed = await fn(snap);
        if (changed === false) return { written: false };
        const seen = new Set();
        for (const row of Object.values(beforeKeys)) {
          for (const ev of (row && row.history) || []) if (ev && ev.event_id) seen.add(ev.event_id);
        }
        const events = [];
        for (const [id, row] of Object.entries(snap.keys || {})) {
          for (const ev of (row && row.history) || []) {
            if (!ev) continue;
            if (!ev.event_id) ev.event_id = `h:${id}:${crypto.randomBytes(16).toString('hex')}`;
            if (seen.has(ev.event_id)) continue;
            seen.add(ev.event_id);
            events.push({ key_id: id, ev });
          }
        }
        const keyOps = [];
        for (const [id, row] of Object.entries(snap.keys || {})) {
          const prev = beforeKeys[id];
          if (prev && sameDoc(prev, row)) continue;
          keyOps.push({ id, prev: prev || null, next: row, isNew: !prev });
        }
        const sessionOps = [];
        const beforeByOpen = new Map((beforeSessions || []).filter((s) => s && s.open_id).map((s) => [s.open_id, s]));
        for (const s of snap.sessions || []) {
          if (!s || !s.open_id) continue;
          const prev = beforeByOpen.get(s.open_id) || null;
          if (prev && sameDoc(prev, s)) continue;
          sessionOps.push({ id: s.open_id, prev, next: s, isNew: !prev });
        }
        let conflict = false;
        for (const op of keyOps) {
          if (!op.isNew || conflict) continue;
          const body = { ...op.next };
          delete body._id;
          delete body.rev;
          try {
            await keys.insertOne({ _id: `key:${op.id}`, ...body, kind: 'key', key_id: op.id, rev: 1 });
          } catch (err) {
            if (pendingTagClash(err)) { conflict = true; break; }
            throw err;
          }
        }
        const opening = [];
        if (!conflict) {
          for (const op of sessionOps) {
            if (!op.isNew) continue;
            const body = { ...op.next };
            delete body._id;
            delete body.rev;
            const asOpening = body.state === 'live';
            try {
              await keys.insertOne({ _id: `open:${op.id}`, ...body, state: asOpening ? 'opening' : body.state, kind: 'session', open_id: op.id, rev: 1 });
            } catch (err) {
              if (pendingTagClash(err)) { conflict = true; break; }
              throw err;
            }
            if (asOpening) opening.push({ id: op.id, keyId: body.key_id });
          }
        }
        const applied = [];
        if (!conflict) {
          for (const op of keyOps) {
            if (op.isNew) continue;
            const docId = `key:${op.id}`;
            const ok = await casUpdate(keys, docId, op.prev, op.next, { kind: 'key', key_id: op.id });
            if (!ok) { conflict = true; break; }
            applied.push({ id: docId, prev: op.prev });
          }
        }
        if (!conflict) {
          for (const op of sessionOps) {
            if (op.isNew) continue;
            const docId = `open:${op.id}`;
            const ok = await casUpdate(keys, docId, op.prev, op.next, { kind: 'session', open_id: op.id });
            if (!ok) { conflict = true; break; }
            applied.push({ id: docId, prev: op.prev });
          }
        }
        if (conflict) {
          for (const done of applied.reverse()) await revertUpdate(keys, done.id, done.prev);
          continue;
        }
        let flipFailed = false;
        for (const op of opening) {
          const still = await keys.findOne({ _id: `key:${op.keyId}`, live_session_id: op.id });
          if (!still) { flipFailed = true; break; }
          const res = await keys.updateOne({ _id: `open:${op.id}`, state: 'opening' }, { $set: { state: 'live' }, $inc: { rev: 1 } });
          if (res.matchedCount !== 1) { flipFailed = true; break; }
        }
        if (flipFailed) {
          let owned = true;
          for (const done of applied) {
            const cur = await keys.findOne({ _id: done.id });
            if (!cur || cur.rev !== revOf(done.prev) + 1) owned = false;
          }
          if (!owned) throw new Error('superseded by a concurrent open; this open was not made live.');
          for (const done of applied.reverse()) await revertUpdate(keys, done.id, done.prev);
          continue;
        }
        for (const { key_id, ev } of events) {
          await hist.insertOne({ kind: 'history', key_id, ...ev, _id: ev.event_id });
        }
        return { written: true };
      }
      throw new Error('sub-key store conflict. Nothing was written.');
    },
    async sweepFlagOff(note) {
      const client = await acquireSharedClient(MONGODB_URI, { serverSelectionTimeoutMS: 8000, maxPoolSize: 10 });
      const db = client.db(MONGODB_DB);
      const listed = await db.listCollections().toArray();
      if (!listed.some((c) => c.name === SUBKEYS_COLLECTION)) return 0;
      const keys = db.collection(SUBKEYS_COLLECTION);
      const hist = db.collection(SUBKEYS_HISTORY_COLLECTION);
      const sessions = await keys.find({ kind: 'session', state: { $in: ['live', 'opening'] } }).toArray();
      for (const doc of sessions) if (doc.session_id && note) note(doc.session_id);
      const at = new Date().toISOString();
      const put = async (event_id, doc) => {
        try { await hist.insertOne({ _id: event_id, kind: 'history', ...doc, event_id }); }
        catch (err) { if (!err || err.code !== 11000) throw err; }
      };
      let ended = 0;
      for (const doc of sessions) {
        await put(`h:flag_off:${doc.open_id}`, { key_id: doc.key_id || null, event: 'session_ended', at, reason: 'flag_off', session_id: doc.session_id, open_id: doc.open_id });
        const res = await keys.updateOne({ _id: doc._id, state: { $in: ['live', 'opening'] } }, { $set: { state: 'ended', end_reason: 'flag_off', ended_at: at }, $inc: { rev: 1 } });
        if (res.matchedCount !== 1) continue;
        if (doc.key_id && doc.open_id) await keys.updateOne({ _id: `key:${doc.key_id}`, live_session_id: doc.open_id }, { $set: { live_session_id: null, live_set_at: null }, $inc: { rev: 1 } });
        ended += 1;
      }
      return ended;
    },
    async touchLastUsed(keyId, iso) {
      const { keys } = await mongoCols();
      const res = await keys.updateOne({ _id: `key:${keyId}`, kind: 'key' }, { $set: { last_used: iso } });
      return res.matchedCount > 0;
    }
  };
}

export async function sweepFlagOffLiveSessions(note) {
  if (setting('SUBKEYS') === '1' || (!testClientActive() && !MONGODB_URI)) return 0;
  return mongoStore().sweepFlagOff(note);
}

/** An attached store, else the shared Mongo client. No process-memory fallback. */
export async function storeFor(deps) {
  if (deps && deps.subkeys && typeof deps.subkeys.mutate === 'function') return deps.subkeys;
  if (testClientActive() || MONGODB_URI) return mongoStore();
  return null;
}
