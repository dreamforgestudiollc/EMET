/**
 * In-memory MongoDB stand-in shared by the suites that run initialize() and
 * setupComplete() end to end. Helpers: valueMatches, matches, memDb, makeStore,
 * layerDb, layerHonouringDb. It counts every write, so a suite can assert that
 * a read path wrote nothing. Not a suite: the name does not end in .test.js.
 */
// --- in-memory store that counts every write --------------------------------

/**
 * Case fold for MongoDB regex option `i` (7.0): ASCII case, école/École,
 * and ẞ with ß. Full-width Ａ folds with full-width ａ, not with ASCII a.
 * İ (U+0130) stays itself and does not match i.
 */
function mongoCaseFoldChar(ch) {
  const cp = ch.codePointAt(0);
  if (cp >= 0xFF21 && cp <= 0xFF3A) return String.fromCodePoint(cp - 0xFF21 + 0xFF41);
  if (cp >= 0xFF41 && cp <= 0xFF5A) return ch;
  if (cp === 0x1E9E || cp === 0x00DF) return '\u00DF';
  if (cp === 0x0130) return '\u0130';
  if (cp >= 0x41 && cp <= 0x5A) return String.fromCodePoint(cp + 0x20);
  const lower = ch.toLowerCase();
  if ([...lower].length === 1) return lower;
  return ch;
}

function mongoCaseFold(text) {
  let out = '';
  for (const ch of String(text)) out += mongoCaseFoldChar(ch);
  return out;
}

/** Fold literal characters in a pattern. Operators such as `.` stay operators. */
function foldPatternLiterals(pattern) {
  let out = '';
  const chars = [...String(pattern)];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (ch === '\\' && i + 1 < chars.length) {
      const folded = mongoCaseFoldChar(chars[++i]);
      out += /[.*+?^${}()|[\]\\]/.test(folded) ? `\\${folded}` : folded;
      continue;
    }
    if (/[*+?^${}()|[\]\\.|]/.test(ch)) { out += ch; continue; }
    out += mongoCaseFoldChar(ch);
  }
  return out;
}

/** $regex / $regexMatch. Option `i` uses the MongoDB fold above, not JS `iu`. */
function mongoRegexTest(input, pattern, flags) {
  const safe = String(flags || '').replace(/[^gimsuy]/g, '');
  if (typeof input !== 'string' || typeof pattern !== 'string') return false;
  if (!safe.includes('i')) return new RegExp(pattern, safe).test(input);
  const rest = safe.replace(/i/g, '');
  return new RegExp(foldPatternLiterals(pattern), rest).test(mongoCaseFold(input));
}

/** The unhandled-drop scan: drops/ ids that are not retired. */
function unhandledDropRead(q) {
  const id = q && q.doc_id;
  const src = id && typeof id === 'object' ? id.$regex : null;
  const pattern = src instanceof RegExp ? src.source : src;
  const retired = q && q.retired;
  return pattern === '^drops/' && !!(retired && typeof retired === 'object' && retired.$ne === true);
}

function valueMatches(d, v) {
  if (v === null) return d == null;
  if (v instanceof RegExp) return typeof d === 'string' && v.test(d);
  if (v && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v)) {
    if ('$in' in v && !v.$in.some((x) => x === d || (x == null && d == null))) return false;
    if ('$ne' in v && (d === v.$ne || (v.$ne === null && d == null))) return false;
    if ('$gte' in v && !(d >= v.$gte)) return false;
    if ('$lte' in v && !(d <= v.$lte)) return false;
    if ('$gt' in v && !(d > v.$gt)) return false;
    if ('$lt' in v && !(d < v.$lt)) return false;
    if ('$nin' in v && v.$nin.some((x) => x === d || (x == null && d == null))) return false;
    if ('$exists' in v && (d !== undefined) !== Boolean(v.$exists)) return false;
    if ('$regex' in v) {
      const flags = typeof v.$options === 'string' ? v.$options.replace(/[^gimsuy]/g, '') : '';
      const source = v.$regex instanceof RegExp ? v.$regex.source : v.$regex;
      if (!mongoRegexTest(d, source, flags)) return false;
    }
    const unknown = Object.keys(v).filter((k) => k.startsWith('$') && !['$in', '$ne', '$gte', '$lte', '$gt', '$lt', '$nin', '$exists', '$regex', '$options'].includes(k));
    if (unknown.length) throw new Error(`memstore: unknown operator ${unknown[0]}`);
    return true;
  }
  if (v instanceof Date && d instanceof Date) return v.getTime() === d.getTime();
  return d === v;
}
const get = (o, k) => k.split('.').reduce((x, p) => (x == null ? x : x[p]), o);
const matches = (doc, q = {}) => Object.entries(q).every(([k, v]) => {
  if (k === '$or') return v.some((s) => matches(doc, s));
  if (k === '$and') return v.every((s) => matches(doc, s));
  return valueMatches(get(doc, k), v);
});
export { matches };

/**
 * MongoDB sort: ascending puts null and missing first; descending puts them last.
 * `dir` is 1 or -1. Equal nulls compare equal so a later key can break the tie.
 */
export function mongoCmp(av, bv, dir) {
  const aNull = av == null;
  const bNull = bv == null;
  if (aNull || bNull) {
    if (aNull && bNull) return 0;
    const nullsLow = aNull ? -1 : 1;
    return dir === 1 ? nullsLow : -nullsLow;
  }
  let a = av;
  let b = bv;
  if (a instanceof Date) a = a.getTime();
  if (b instanceof Date) b = b.getTime();
  if (a === b) return 0;
  if (a > b) return dir === 1 ? 1 : -1;
  return dir === 1 ? -1 : 1;
}

function sortDocs(docs, spec) {
  const keys = Object.entries(spec || {});
  return [...docs].sort((a, b) => {
    for (const [k, dir] of keys) {
      const c = mongoCmp(get(a, k), get(b, k), dir);
      if (c) return c;
    }
    return 0;
  });
}

function exprTruthy(v) {
  return !(v === false || v == null || v === 0);
}

function asDouble(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function evalExpr(doc, expr) {
  if (typeof expr === 'string' && expr.startsWith('$')) {
    if (expr.startsWith('$$')) throw new Error(`memstore: unknown operator ${expr}`);
    const v = get(doc, expr.slice(1));
    return v === undefined ? null : v;
  }
  if (expr == null || typeof expr !== 'object') return expr;
  if (expr instanceof Date || expr instanceof RegExp) return expr;
  if (Array.isArray(expr)) return expr.map((item) => evalExpr(doc, item));
  const keys = Object.keys(expr);
  const op = keys.find((k) => k.startsWith('$'));
  if (!op) return expr;
  if (keys.length !== 1) throw new Error(`memstore: unknown operator ${op}`);
  const arg = expr[op];
  const evalList = (list) => {
    if (!Array.isArray(list)) throw new Error(`memstore: ${op} expects a list`);
    return list.map((item) => evalExpr(doc, item));
  };
  switch (op) {
    case '$ifNull': {
      const [a, b] = evalList(arg);
      return a == null ? b : a;
    }
    case '$eq': {
      const [a, b] = evalList(arg);
      if (a == null && b == null) return true;
      if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
      return a === b;
    }
    case '$ne': {
      const [a, b] = evalList(arg);
      if (a == null && b == null) return false;
      if (a instanceof Date && b instanceof Date) return a.getTime() !== b.getTime();
      return a !== b;
    }
    case '$gt':
    case '$gte':
    case '$lt':
    case '$lte': {
      const [a, b] = evalList(arg);
      if (a == null || b == null || typeof a !== typeof b) return false;
      if (op === '$gt') return a > b;
      if (op === '$gte') return a >= b;
      if (op === '$lt') return a < b;
      return a <= b;
    }
    case '$and':
      return evalList(arg).every(exprTruthy);
    case '$or':
      return evalList(arg).some(exprTruthy);
    case '$not':
      return !exprTruthy(evalExpr(doc, arg));
    case '$cond': {
      const spec = Array.isArray(arg) ? { if: arg[0], then: arg[1], else: arg[2] } : arg;
      return exprTruthy(evalExpr(doc, spec.if)) ? evalExpr(doc, spec.then) : evalExpr(doc, spec.else);
    }
    case '$add': {
      const nums = evalList(arg);
      if (nums.some((n) => typeof n !== 'number' || !Number.isFinite(n))) return null;
      return nums.reduce((sum, n) => sum + n, 0);
    }
    case '$divide': {
      const [a, b] = evalList(arg);
      if (typeof a !== 'number' || typeof b !== 'number') return null;
      if (b === 0) throw new Error('memstore: $divide by zero');
      return a / b;
    }
    case '$convert': {
      const input = evalExpr(doc, arg.input);
      if (input == null) return 'onNull' in arg ? evalExpr(doc, arg.onNull) : null;
      let out = null;
      if (arg.to === 'double' || arg.to === 'int' || arg.to === 'long' || arg.to === 'decimal') out = asDouble(input);
      else if (arg.to === 'string') {
        if (typeof input === 'string') out = input;
        else if (typeof input === 'number' || typeof input === 'boolean') out = String(input);
      } else if (arg.to === 'bool') out = exprTruthy(input);
      if (out == null) return 'onError' in arg ? evalExpr(doc, arg.onError) : null;
      return out;
    }
    case '$literal':
      return arg;
    case '$regexMatch': {
      const input = evalExpr(doc, arg.input);
      const regex = evalExpr(doc, arg.regex);
      const options = arg.options === undefined ? '' : evalExpr(doc, arg.options);
      return mongoRegexTest(input, regex, options);
    }
    case '$toLower': {
      const v = evalExpr(doc, arg);
      if (typeof v !== 'string') throw new Error('memstore: $toLower expects a string');
      // MongoDB $toLower folds A-Z only. É stays É.
      return v.replace(/[A-Z]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 32));
    }
    case '$toString': {
      const v = evalExpr(doc, arg);
      if (v == null) return null;
      return String(v);
    }
    case '$indexOfCP': {
      const [hay, needle] = evalList(arg);
      if (typeof hay !== 'string' || typeof needle !== 'string') return -1;
      return Array.from(hay).join('').indexOf(needle);
    }
    case '$substrCP': {
      const [s, start, len] = evalList(arg);
      const chars = Array.from(s == null ? '' : String(s));
      const from = Number(start) || 0;
      const n = Number(len) || 0;
      return chars.slice(from, from + n).join('');
    }
    case '$strLenCP': {
      const v = evalExpr(doc, arg);
      return Array.from(v == null ? '' : String(v)).length;
    }
    default:
      throw new Error(`memstore: unknown operator ${op}`);
  }
}

function projectDoc(doc, spec) {
  const entries = Object.entries(spec);
  const drops = entries.filter(([, v]) => v === 0).map(([k]) => k);
  const keeps = entries.filter(([, v]) => v !== 0);
  const exclusion = drops.some((k) => k !== '_id');
  if (exclusion && keeps.length) throw new Error('memstore: $project mixes inclusion and exclusion');
  if (exclusion) {
    const out = { ...doc };
    for (const k of drops) delete out[k];
    return out;
  }
  const out = {};
  if (!('_id' in spec)) out._id = doc._id;
  for (const [k, v] of entries) {
    if (v === 0) continue;
    out[k] = v === 1 ? doc[k] : evalExpr(doc, v);
  }
  return out;
}

/**
 * Aggregation the recall rank pipeline and startup scans use.
 * $vectorSearch is recognized and yields no rows: this store has no vector index.
 * Any other stage, and any other expression operator, throws.
 */
export function applyAggregate(docs, pipeline) {
  let out = (docs || []).map((d) => clone(d));
  for (const st of pipeline) {
    const names = Object.keys(st);
    if (names.length !== 1 || !names[0].startsWith('$')) throw new Error('memstore: unknown stage');
    const name = names[0];
    if (name === '$match') out = out.filter((d) => matches(d, st.$match));
    else if (name === '$addFields' || name === '$set') {
      for (const d of out) {
        for (const [k, v] of Object.entries(st[name])) d[k] = evalExpr(d, v);
      }
    } else if (name === '$sort') out = sortDocs(out, st.$sort);
    else if (name === '$limit') out = out.slice(0, st.$limit);
    else if (name === '$skip') out = out.slice(st.$skip);
    else if (name === '$project') out = out.map((d) => projectDoc(d, st.$project));
    else if (name === '$vectorSearch') out = [];
    else throw new Error(`memstore: unknown stage ${name}`);
  }
  return out;
}
function setPath(doc, k, v) {
  const path = k.split('.'); let o = doc;
  for (const p of path.slice(0, -1)) { if (!o[p] || typeof o[p] !== 'object') o[p] = {}; o = o[p]; }
  o[path[path.length - 1]] = v;
}
function unsetPath(doc, k) {
  const path = k.split('.'); let o = doc;
  for (const p of path.slice(0, -1)) { if (!o || typeof o !== 'object') return; o = o[p]; }
  if (o && typeof o === 'object') delete o[path[path.length - 1]];
}
function applyUpdate(doc, u) {
  if (!Object.keys(u).some((k) => k.startsWith('$'))) { for (const k of Object.keys(doc)) if (k !== '_id') delete doc[k]; Object.assign(doc, u); return; }
  for (const [k, v] of Object.entries(u.$set || {})) setPath(doc, k, v);
  for (const k of Object.keys(u.$unset || {})) unsetPath(doc, k);
  for (const [k, v] of Object.entries(u.$push || {})) doc[k] = [...(doc[k] || []), v];
  for (const [k, v] of Object.entries(u.$addToSet || {})) {
    const each = v && typeof v === 'object' && Array.isArray(v.$each) ? v.$each : [v];
    const cur = Array.isArray(doc[k]) ? doc[k] : [];
    doc[k] = [...cur, ...each.filter((x) => !cur.includes(x))];
  }
  for (const [k, v] of Object.entries(u.$inc || {})) setPath(doc, k, (get(doc, k) || 0) + v);
}
const clone = (d) => (d == null ? d : structuredClone(d));

export function makeStore(opts = {}) {
  const cols = new Map();
  const writes = [];
  const note = (name, op) => writes.push(`${op} ${name}`);
  const failState = { failCloseWrites: opts.failCloseWrites || 0, closeWriteAttempts: 0 };
  function collection(name) {
    if (cols.has(name)) return cols.get(name);
    const docs = []; let seq = 0;
    const c = {
      docs,
      async findOne(q = {}) {
        if (opts.failRead === true) throw new Error('store down');
        if (opts.failTranscriptRead && name === 'transcripts') throw new Error('transcripts down');
        return clone(docs.find((d) => matches(d, q))) || null;
      },
      find(q = {}) {
        if (opts.failRead === true) throw new Error('store down');
        // The boot drop list is this query and no other. A suite flips
        // failUnhandledDropRead so emet_session_open's load fails while
        // initialize can still read retired drops.
        if (opts.failUnhandledDropRead === true && unhandledDropRead(q)) throw new Error('unhandled drop list unavailable');
        let out = docs.filter((d) => matches(d, q));
        const cur = {
          sort(spec) { out = sortDocs(out, spec); return cur; },
          limit(n) { out = out.slice(0, n); return cur; },
          skip(n) { out = out.slice(n); return cur; },
          project() { return cur; },
          async toArray() { return out.map(clone); },
          async next() { return out.length ? clone(out[0]) : null; },
          async *[Symbol.asyncIterator]() { for (const d of out) yield clone(d); }
        };
        return cur;
      },
      aggregate(pipeline) {
        const out = applyAggregate(docs, pipeline);
        return { async toArray() { return out; } };
      },
      async insertOne(doc) {
        if (opts.failTranscriptWrite && name === 'transcripts') throw new Error('write failed');
        note(name, 'insert'); const _id = doc._id ?? `${name}-${++seq}`; docs.push({ ...clone(doc), _id }); return { insertedId: _id, acknowledged: true };
      },
      async insertMany(arr) { for (const d of arr) await c.insertOne(d); return { insertedCount: arr.length }; },
      async updateOne(q, u, upOpts = {}) {
        if (opts.failTranscriptWrite && name === 'transcripts') throw new Error('write failed');
        if (/sessions$/.test(name) && u && u.$set && u.$set.closed === true) {
          failState.closeWriteAttempts++;
          if (failState.failCloseWrites > 0) { failState.failCloseWrites--; throw new Error('sessions store write failed'); }
        }
        let d = docs.find((x) => matches(x, q));
        if (!d) {
          if (!upOpts.upsert) return { matchedCount: 0, modifiedCount: 0 };
          d = { _id: `${name}-${++seq}` }; for (const [k, v] of Object.entries(q)) if (!k.startsWith('$') && (v === null || typeof v !== 'object')) d[k] = v;
          Object.assign(d, u.$setOnInsert || {}); docs.push(d);
        }
        note(name, 'update'); applyUpdate(d, u);
        return { matchedCount: 1, modifiedCount: 1, acknowledged: true };
      },
      async updateMany(q, u) { const hit = docs.filter((x) => matches(x, q)); for (const d of hit) applyUpdate(d, u); if (hit.length) note(name, 'updateMany'); return { matchedCount: hit.length, modifiedCount: hit.length }; },
      async replaceOne(q, doc, opts = {}) { return c.updateOne(q, doc, opts); },
      async findOneAndUpdate(q, u, opts = {}) {
        let d = docs.find((x) => matches(x, q));
        if (!d && opts.upsert) { d = { _id: q._id ?? `${name}-${++seq}` }; docs.push(d); }
        if (!d) return null;
        note(name, 'findOneAndUpdate'); applyUpdate(d, u);
        const v = clone(d); return opts.includeResultMetadata ? { value: v } : v;
      },
      async deleteOne(q) { note(name, 'delete'); const i = docs.findIndex((x) => matches(x, q)); if (i >= 0) docs.splice(i, 1); return { deletedCount: i >= 0 ? 1 : 0 }; },
      async countDocuments(q = {}) { return docs.filter((d) => matches(d, q)).length; },
      async estimatedDocumentCount() { return docs.length; },
      async distinct(k, q = {}) { return [...new Set(docs.filter((d) => matches(d, q)).map((d) => get(d, k)))]; },
      async createIndex() { return 'ok'; },
      async indexes() { return []; },
      listSearchIndexes() { return { async toArray() { throw new Error('not queryable on this tier'); } }; },
      async drop() { cols.delete(name); return true; }
    };
    cols.set(name, c);
    return c;
  }
  const dbObj = {
    collection,
    listCollections() { return { async toArray() { return [...cols.entries()].filter(([, c]) => c.docs.length).map(([n]) => ({ name: n })); } }; },
    async command() { return { ok: 1 }; }
  };
  const baseOf = (sid) => String(sid).replace(/_verbatim_part\d+$/, '');
  const partNo = (sid) => { const m = /_verbatim_part(\d+)$/.exec(sid); return m ? Number(m[1]) : 0; };
  const store = {
    cols, writes, collection, state: failState,
    col: collection,
    row: (id) => collection('emet_sessions').docs.find((d) => d._id === id),
    doc: (id) => collection('documents').docs.find((d) => d.doc_id === id),
    transcripts: () => collection('transcripts').docs,
    sessions: () => collection('emet_sessions').docs,
    async ensureClient() { return { collection }; },
    async transcriptPosition(sid) {
      if (opts.failPosition) throw new Error('position down');
      const base = opts.base || baseOf(sid);
      const live = collection('transcripts').docs.filter((d) => (d.session_id === base || String(d.session_id).startsWith(`${base}_`)) && !d.superseded_by);
      const minted = live.map((d) => d.session_id).filter((id) => id === base || new RegExp(`^${base}_verbatim_part\\d+$`).test(id));
      const last_part = minted.length ? minted.reduce((a, b) => (partNo(b) > partNo(a) ? b : a)) : null;
      const fromDocs = live.reduce((m, d) => Math.max(m, ...(d.exchanges || []).map((e) => Number(e.exchange_index))), 0);
      return { base, present: live.length > 0 || opts.highest > 0, highest: opts.highest != null ? opts.highest : fromDocs, last_part };
    },
    Client: class { constructor() {} async connect() { return this; } db() { return dbObj; } async close() {} }
  };
  store.rows = { get: (id) => collection('emet_sessions').docs.find((d) => d._id === id) };
  if (opts.state) collection('emet_sessions').docs.push({ _id: opts.sessionId, ...opts.state });
  return store;
}
export async function withStore(store, fn) {
  const mongoConnect = await import('../src/mongo-connect.js');
  mongoConnect.useTestClient(store.Client);
  try { return await fn(); } finally { mongoConnect.useTestClient(null); }
}
export function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  const restore = () => { for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } };
  try { const r = fn(); if (r && typeof r.then === 'function') return r.finally(restore); restore(); return r; } catch (e) { restore(); throw e; }
}

/** Plain collections map for suites that hand a db straight to a module. */
function memMatch(row, q) {
  if (!q) return true;
  return Object.entries(q).every(([k, v]) => {
    const cur = row[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)) {
      if ('$exists' in v && ((cur !== undefined) !== Boolean(v.$exists))) return false;
      if ('$gt' in v && !(cur > v.$gt)) return false;
      if ('$gte' in v && !(cur >= v.$gte)) return false;
      if ('$lt' in v && !(cur < v.$lt)) return false;
      if ('$lte' in v && !(cur <= v.$lte)) return false;
      if ('$ne' in v && cur === v.$ne) return false;
      if ('$in' in v && !v.$in.includes(cur)) return false;
      const ops = ['$exists', '$gt', '$gte', '$lt', '$lte', '$ne', '$in'];
      if (Object.keys(v).some((op) => ops.includes(op))) return true;
    }
    return cur === v;
  });
}
export function memDb({ counter } = {}) {
  const cols = {};
  function memCollection() {
    const rows = [];
    const indexes = [];
    return {
      rows,
      async findOne(q) {
        await Promise.resolve();
        if (counter) counter.lookups++;
        return rows.find((r) => memMatch(r, q)) || null;
      },
      async insertOne(doc) {
        for (const idx of indexes) {
          if (!idx.unique) continue;
          const keys = Object.keys(idx.spec);
          const clash = rows.find((r) => keys.every((k) => doc[k] !== undefined && r[k] === doc[k]));
          if (clash) {
            const err = new Error('E11000 duplicate key');
            err.code = 11000;
            throw err;
          }
        }
        rows.push({ _id: rows.length + 1, ...doc });
        return { insertedId: doc.person_id || rows.length };
      },
      async updateOne(q, u, upOpts = {}) {
        const row = rows.find((r) => memMatch(r, q));
        if (row) { Object.assign(row, u.$set || {}); return { matchedCount: 1 }; }
        if (upOpts.upsert) {
          const plain = {};
          for (const [k, v] of Object.entries(q || {})) {
            if (!k.startsWith('$') && (v === null || typeof v !== 'object')) plain[k] = v;
          }
          rows.push({ _id: rows.length + 1, ...plain, ...(u.$set || {}) });
          return { upsertedCount: 1 };
        }
        return { matchedCount: 0 };
      },
      async findOneAndUpdate(q, u) {
        const row = rows.find((r) => memMatch(r, q));
        if (!row) return null;
        if (u && u.$set) Object.assign(row, u.$set);
        return { ...row };
      },
      async deleteOne(q) { const i = rows.findIndex((r) => memMatch(r, q)); if (i >= 0) rows.splice(i, 1); return { deletedCount: i >= 0 ? 1 : 0 }; },
      async deleteMany(q) {
        const before = rows.length;
        for (let i = rows.length - 1; i >= 0; i--) if (memMatch(rows[i], q)) rows.splice(i, 1);
        return { deletedCount: before - rows.length };
      },
      async createIndex(spec, opts = {}) { indexes.push({ spec, unique: !!(opts && opts.unique) }); return 'ok'; }
    };
  }
  const db = {
    cols,
    collection(name = 'persons') { return cols[name] || (cols[name] = memCollection()); },
    get _rows() { return this.collection('persons').rows; }
  };
  if (counter) db.counter = counter;
  return db;
}

/** dbManager stand-in for saveMemory / reviseMemory (preset transcript position). */
export function layerDb({ highest = 0, base = null, lastId = 500 } = {}) {
  const writes = []; const rows = {}; let seq = lastId; const asked = [];
  return {
    writes, asked,
    async getConnection() { return { async getAsync(_sql, params) { return rows[params[0]] || null; } }; },
    async insertMemory(layer, doc) { const id = ++seq; writes.push({ layer, doc, id }); rows[id] = { ...doc, id }; return id; },
    async readMemory(_layer, id) { return rows[id] || null; },
    async transcriptPosition(sid) { asked.push(sid); return { base: base || String(sid).replace(/_verbatim_part\d+$/, ''), present: highest > 0, highest }; }
  };
}

/** Layer-honouring stand-in shared by resign-on-mark and episodic-corrections. */
const layerClone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
const layerGet = (o, path) => path.split('.').reduce((a, k) => (a == null ? undefined : a[k]), o);
const layerSet = (o, path, v) => { const ks = path.split('.'); let a = o; for (const k of ks.slice(0, -1)) { if (a[k] == null || typeof a[k] !== 'object') a[k] = {}; a = a[k]; } a[ks[ks.length - 1]] = v; };
const layerMatches = (row, q) => Object.entries(q).every(([k, v]) => JSON.stringify(layerGet(row, k)) === JSON.stringify(v));
export function layerHonouringDb() {
  const byLayer = {}; let lastId = 600; const writes = []; const updates = [];
  const hooks = { beforeUpdate: null, freezeUpdates: false };
  const layerRows = (layer) => (byLayer[layer] ||= {});
  const colFor = (layer) => ({
    async findOne(q) { await null; const r = Object.values(layerRows(layer)).find((row) => layerMatches(row, q)); return r ? layerClone(r) : null; },
    async updateOne(q, u) {
      await null;
      if (hooks.beforeUpdate) await hooks.beforeUpdate(layer, q, u);
      updates.push({ layer, q, u });
      const r = Object.values(layerRows(layer)).find((row) => layerMatches(row, q));
      if (!r) return { matchedCount: 0, modifiedCount: 0 };
      if (hooks.freezeUpdates) return { matchedCount: 1, modifiedCount: 0 };
      for (const [k, v] of Object.entries(u.$set || {})) layerSet(r, k, layerClone(v));
      for (const [k, v] of Object.entries(u.$addToSet || {})) {
        const cur = layerGet(r, k);
        const list = Array.isArray(cur) ? cur : [];
        if (!list.some((x) => JSON.stringify(x) === JSON.stringify(v))) list.push(layerClone(v));
        layerSet(r, k, list);
      }
      return { matchedCount: 1, modifiedCount: 1 };
    }
  });
  const cols = {};
  return {
    byLayer, writes, updates, hooks,
    row(layer, id) { return layerRows(layer)[id]; },
    async getConnection() { return {}; },
    collectionFor(layer) { return (cols[layer] ||= colFor(layer)); },
    async insertMemory(layer, doc) { const id = ++lastId; writes.push({ layer, doc, id }); layerRows(layer)[id] = layerClone({ ...doc, id }); return id; },
    async readMemory(layer, id) { const r = layerRows(layer)[id]; return r ? layerClone(r) : null; },
    async findMemories(layer, filter = {}, opts = {}) {
      let rows = Object.values(layerRows(layer)).map(layerClone);
      if (filter && typeof filter === 'object' && Object.keys(filter).length) rows = rows.filter((r) => matches(r, filter));
      const sort = opts && opts.sort;
      if (sort && typeof sort === 'object' && Object.keys(sort).length) {
        const keys = Object.entries(sort);
        rows.sort((a, b) => {
          for (const [k, dir] of keys) {
            const c = mongoCmp(layerGet(a, k), layerGet(b, k), dir);
            if (c) return c;
          }
          return 0;
        });
      } else {
        rows.sort((a, b) => b.id - a.id);
      }
      const limit = opts && opts.limit;
      if (limit !== null && limit !== undefined && Number.isFinite(Number(limit))) rows = rows.slice(0, Number(limit));
      return rows;
    },
    async aggregateMemories(layer, pipeline) {
      return applyAggregate(Object.values(layerRows(layer)), pipeline);
    }
  };
}
