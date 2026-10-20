/**
 * EMET - Enduring Memory & Epistemic Tiers
 * Copyright (c) 2026 Dreamforge Studio LLC
 * Licensed under the MIT License - see LICENSE
 *
 * Serve one active RUNE. The call returns the code and does not run it.
 * A kept result is sealed on the existing write path: the principal comes
 * from authentication, the served hash is the pin, and the attestation
 * fields do not change on a later write. The file keeps SERVE_CAP rows per
 * principal. This release creates SERVE_COLLECTION (`<prefix>gem_serves`).
 * Alex approved it as an append-only write site on the write-path allow-list.
 * The collection keeps every row. Nothing is deleted.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ValidationError } from './validation.js';
import { activeRune, activeRunes, metadataGemClause, metadataGemValue } from './rune-registry.js';
import { writerStamp, declaredAttribution } from './persons.js';
import { resolveModulePath } from './module-path.js';
import { COLLECTION_PREFIX } from './database.js';

const SHA256_RE = /^sha256:[a-f0-9]{64}$/;
const LAYERS = ['identity', 'semantic', 'episodic', 'procedural', 'meta', 'working'];
/** File cap. The Mongo collection is not capped. */
export const SERVE_CAP = 200;
/** Created by this release. One document per serve, append-only. */
export const SERVE_COLLECTION = `${COLLECTION_PREFIX}gem_serves`;
const SEAL_KEYS = ['gem', 'rune', 'served_sha256'];
const STRIP_KEYS = ['gem', 'rune', 'served_sha256', 'client_sha256', 'input_sha256', 'input_ref', 'principal', 'rune_attested'];
const FREEZE_KEYS = ['gem', 'version', 'rune', 'served_sha256', 'client_sha256', 'input_sha256', 'input_ref', 'principal', 'rune_attested'];
const INSTRUCTIONS = 'Run this code in your own sandbox. It is a pure function of the inputs you pass in. EMET does not run it. If you have no sandbox, you have no result and must say so.';

const artifacts = new Map();
let artifactsLoaded = false;
let serveLogOverride = null;
let serveTurn = Promise.resolve();
const serveIndexReady = new WeakSet();

/** Tests point the file at a temp path. Production leaves this unset. */
export function setServeLogPath(file) {
  serveLogOverride = file || null;
}

function serveLogPath() {
  return serveLogOverride || resolveModulePath(import.meta.url, ['..', 'logs', 'gem-serves.json']);
}

function principalKey(principal) {
  return typeof principal === 'string' ? principal : '';
}

/** Latest SERVE_CAP file rows for each principal, in the order they were recorded. */
function capServeRows(rows) {
  const counts = new Map();
  const kept = [];
  const list = Array.isArray(rows) ? rows : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const row = list[i];
    if (!row || typeof row !== 'object') continue;
    const key = principalKey(row.principal);
    const n = counts.get(key) || 0;
    if (n >= SERVE_CAP) continue;
    counts.set(key, n + 1);
    kept.push(row);
  }
  kept.reverse();
  return kept;
}

function readServeLog() {
  try {
    const body = JSON.parse(fs.readFileSync(serveLogPath(), 'utf8'));
    if (!Array.isArray(body)) return [];
    return capServeRows(body);
  } catch { return []; }
}

function writeServeLog(rows) {
  const file = serveLogPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
  );
  try {
    fs.writeFileSync(tmp, JSON.stringify(capServeRows(rows)), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch { /* renamed into place */ }
  }
}

function afterServe(fn) {
  const run = serveTurn.then(fn, fn);
  serveTurn = run.then(() => {}, () => {});
  return run;
}

async function ensureServeIndex(db) {
  if (!db || serveIndexReady.has(db)) return;
  const col = db.collection(SERVE_COLLECTION);
  if (!col || typeof col.createIndex !== 'function') return;
  serveIndexReady.add(db);
  try {
    await col.createIndex({ principal: 1, session_id: 1 });
  } catch {
    // An index miss never blocks the serve. The next serve tries again.
    serveIndexReady.delete(db);
  }
}

export async function appendServeStore(db, event) {
  // A new document per serve. Two processes cannot overwrite each other's rows,
  // and nothing already stored is updated or removed.
  await ensureServeIndex(db);
  await db.collection(SERVE_COLLECTION).insertOne({
    _id: crypto.randomBytes(16).toString('hex'),
    principal: event.principal,
    session_id: event.session_id,
    gem: event.gem,
    rune: event.rune,
    version: event.version,
    sha256: event.sha256,
    time: event.time
  });
}

async function openServeStore(ctx) {
  if (!ctx) return null;
  if (ctx.db && typeof ctx.db.collection === 'function') return ctx.db;
  const mgr = ctx.dbManager;
  if (!mgr) return null;
  if ((!mgr.db || typeof mgr.db.collection !== 'function') && typeof mgr.ensureClient === 'function') {
    try { await mgr.ensureClient(); } catch { return null; }
  }
  return mgr.db && typeof mgr.db.collection === 'function' ? mgr.db : null;
}

async function recordServe(event, db) {
  await afterServe(async () => {
    if (db) await appendServeStore(db, event);
    writeServeLog(readServeLog().concat(event));
  });
}

async function storeHasServe(db, query) {
  await ensureServeIndex(db);
  const row = await db.collection(SERVE_COLLECTION).findOne({
    principal: query.principal,
    session_id: query.session_id || null,
    gem: query.gem,
    rune: query.rune,
    sha256: query.sha256
  });
  return Boolean(row);
}

export function servePrincipal() {
  const attr = declaredAttribution();
  if (attr && attr.keyId) return attr.keyId;
  if (attr && attr.login) return attr.login;
  const stamp = writerStamp();
  return stamp.person_id || null;
}

function sessionOf(value) {
  if (value === undefined || value === null || value === '') return null;
  const text = typeof value === 'string' ? value.trim() : '';
  return text && text.length <= 200 ? text : null;
}

function digestOf(buf) {
  return 'sha256:' + crypto.createHash('sha256').update(buf).digest('hex');
}

function digestEqual(declared, actual) {
  const a = Buffer.from(String(declared));
  const b = Buffer.from(String(actual));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function indexPath() {
  return resolveModulePath(import.meta.url, ['..', 'gems', 'artifact-index.json']);
}

function loadArtifacts() {
  if (artifactsLoaded) return;
  artifactsLoaded = true;
  try {
    const body = JSON.parse(fs.readFileSync(indexPath(), 'utf8'));
    for (const [hash, row] of Object.entries(body)) {
      if (SHA256_RE.test(hash) && row && typeof row === 'object') artifacts.set(hash, row);
    }
  } catch { /* a release with no index still serves the files it has */ }
}

/** Remember a shipped artifact by hash. Entries are not removed. */
export function noteArtifact(row) {
  loadArtifacts();
  if (!row || !SHA256_RE.test(row.sha256 || '')) return;
  if (artifacts.has(row.sha256)) return;
  artifacts.set(row.sha256, { gem: row.gem, rune: row.rune, version: row.version });
}

export function artifactRecord(hash) {
  loadArtifacts();
  return artifacts.get(hash) || null;
}

function pinRune(rune) {
  if (!rune || typeof rune.gemDir !== 'string' || typeof rune.artifact !== 'string') return null;
  let buf;
  try { buf = fs.readFileSync(path.join(rune.gemDir, rune.artifact)); }
  catch { return null; }
  const actual = digestOf(buf);
  if (!digestEqual(rune.sha256, actual)) return null;
  noteArtifact({ sha256: actual, gem: rune.gemId, rune: rune.name, version: rune.version });
  return { code: buf.toString('utf8'), sha256: actual };
}

function activeByGem(gem, runeName) {
  if (typeof gem !== 'string' || typeof runeName !== 'string') return null;
  for (const rune of activeRunes()) {
    if (metadataGemValue(rune) === gem && rune.name === runeName) return rune;
  }
  return null;
}

export function matchServe(query) {
  return readServeLog().find((row) =>
    row.principal === query.principal &&
    row.session_id === (query.session_id || null) &&
    row.gem === query.gem &&
    row.rune === query.rune &&
    row.sha256 === query.sha256
  ) || null;
}

/**
 * Parent seal copied onto a revision. A different value is a refusal.
 * Returns null when the parent was not sealed by the server.
 */
export function frozenAttestation(parent, incoming) {
  if (!parent || parent.rune_attested !== true) return null;
  const prior = {};
  for (const key of FREEZE_KEYS) {
    if (key === 'rune_attested') prior[key] = true;
    else if (typeof parent[key] === 'string' && parent[key]) prior[key] = parent[key];
  }
  const sent = incoming && typeof incoming === 'object' ? incoming : {};
  for (const key of FREEZE_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(sent, key)) continue;
    if (sent[key] !== prior[key]) throw new ValidationError(key, 'attestation is immutable');
  }
  return prior;
}

function stripUnsealed(metadata) {
  for (const key of STRIP_KEYS) delete metadata[key];
}

/** Stamp a kept result from the active RUNE and a serve event. No-op otherwise. */
export async function sealAttestation(metadata, opts = {}) {
  if (!metadata || typeof metadata !== 'object') return;
  if (opts.inherited) return;
  const full = SEAL_KEYS.every((key) => typeof metadata[key] === 'string' && metadata[key]);
  if (!full) { stripUnsealed(metadata); return; }
  const rune = activeByGem(metadata.gem, metadata.rune);
  if (!rune) throw new ValidationError('gem', "metadata.gem must be '<gem>@<version>' and match an active directive");
  const pinned = pinRune(rune);
  if (!pinned) throw new ValidationError('served_sha256', 'hash pin');
  const principal = servePrincipal();
  if (!principal) throw new ValidationError('principal', 'no authenticated principal');
  const session_id = sessionOf(opts.session_id);
  const query = { principal, session_id, gem: rune.gemId, rune: rune.name, sha256: pinned.sha256 };
  let db = opts.db && typeof opts.db.collection === 'function' ? opts.db : null;
  let served = Boolean(matchServe(query));
  if (!served && !db && opts.dbManager && typeof opts.dbManager.ensureClient === 'function') {
    try { await opts.dbManager.ensureClient(); } catch { /* the file was the only copy */ }
    const opened = opts.dbManager.db;
    if (opened && typeof opened.collection === 'function') db = opened;
  }
  if (!served && db) {
    try { served = await storeHasServe(db, query); }
    catch (e) {
      if (e instanceof ValidationError) throw e;
      throw new ValidationError('gem', 'serve log');
    }
  }
  if (!served) throw new ValidationError('gem', 'no serve event');
  if (!SHA256_RE.test(metadata.client_sha256 || '')) {
    throw new ValidationError('client_sha256', 'client-reported sha256');
  }
  const inputHash = SHA256_RE.test(metadata.input_sha256 || '');
  const inputRef = typeof metadata.input_ref === 'string' && metadata.input_ref.trim().length > 0;
  if (!inputHash && !inputRef) throw new ValidationError('input_sha256', 'input hash or reference');
  metadata.gem = metadataGemValue(rune);
  metadata.version = rune.version;
  metadata.rune = rune.name;
  metadata.served_sha256 = pinned.sha256;
  metadata.principal = principal;
  metadata.rune_attested = true;
  if (!inputHash) delete metadata.input_sha256;
  if (!inputRef) delete metadata.input_ref;
}

/** Results whose served hash is this one, plus the index row when the release kept it. */
export async function resultsForArtifact(dbManager, sha256) {
  loadArtifacts();
  const artifact = artifacts.get(sha256) || null;
  const results = [];
  if (!dbManager || typeof dbManager.collectionFor !== 'function') return { artifact, results };
  for (const layer of LAYERS) {
    let rows = [];
    try { rows = await dbManager.collectionFor(layer).find({ 'metadata.served_sha256': sha256 }).toArray(); }
    catch { rows = []; }
    for (const row of rows || []) results.push({ layer, id: row.id, served_sha256: sha256 });
  }
  return { artifact, results };
}

/** Serve an active RUNE. Returns null when the name is not one. Runs nothing. */
export async function serveRune(name, args, ctx) {
  const rune = activeRune(name);
  if (!rune) return null;
  const { handleError, createSuccessResponse } = await import('./tools.js');
  const pinned = pinRune(rune);
  if (!pinned) return handleError(new ValidationError('rune', 'hash pin'), name, ctx && ctx.logger);
  const principal = servePrincipal();
  const session_id = sessionOf(args && args.session_id);
  const event = {
    principal,
    session_id,
    gem: rune.gemId,
    rune: rune.name,
    version: rune.version,
    sha256: pinned.sha256,
    time: new Date().toISOString()
  };
  const db = await openServeStore(ctx);
  try { await recordServe(event, db); }
  catch (e) {
    const err = e instanceof ValidationError ? e : new ValidationError('gem', 'serve log');
    return handleError(err, name, ctx && ctx.logger);
  }
  const op = ctx && ctx.AuditOperation && ctx.AuditOperation.GEM_SERVE ? ctx.AuditOperation.GEM_SERVE : 'GEM_SERVE';
  if (ctx && ctx.logger && typeof ctx.logger.audit === 'function') ctx.logger.audit(op, event);
  return createSuccessResponse({
    code: pinned.code,
    sha256: pinned.sha256,
    version: rune.version,
    runtime: rune.runtime,
    instructions: INSTRUCTIONS,
    inputSchema: rune.inputSchema,
    outputSchema: rune.outputSchema,
    description: `${rune.description} ${metadataGemClause(rune)}`
  }, name);
}
