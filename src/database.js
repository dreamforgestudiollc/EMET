/**
 * EMET - Enduring Memory & Epistemic Tiers
 * Copyright (c) 2026 Dreamforge Studio LLC
 *
 * Derived from CASCADE Memory System
 * Copyright (c) 2025-2026 CIPS Corp (C.I.P.S. LLC)
 * Licensed under the MIT License - see LICENSE
 *
 * https://github.com/For-Sunny/cascade-memory-enterprise
 *
 * Database Module - MongoDB backend
 *
 * Storage backend: MongoDB.
 * Storage backend converted from file-based SQLite to MongoDB to
 * eliminate file-sync fork corruption between machines. The public interface
 * of this module (all exports, the EmetDatabase method surface, and the
 * SQL shapes accepted by connection objects) is preserved exactly so that
 * tools.js and index.js require no changes. Original SQLite implementation
 * preserved at database.js.sqlite_backup_2026-07-15.
 *
 * Env: MONGODB_URI (required), MONGODB_DB (optional, default 'emet').
 * Collections: <prefix><layer> per memory layer; <prefix>counters for ids.
 */

import './env.js';
import { connectMongo } from './mongo-connect.js';
import path from 'path';

import {
  ValidationError,
  VALID_LAYERS,
  CONTENT_LIMITS,
  validateLayer,
  validateContent,
  validateMetadata,
  validateLimit
} from './validation.js';
import { isMetadataPath } from './metadata.js';

// ============================================
// CONFIGURATION
// ============================================

// Legacy path constants retained for interface compatibility (status display).



export const DEBUG = process.env.DEBUG === 'true';

// MongoDB configuration
export const MONGODB_URI = process.env.MONGODB_URI || null;
export const MONGODB_DB = process.env.MONGODB_DB || 'emet';
export const COLLECTION_PREFIX = process.env.EMET_COLLECTION_PREFIX || 'emet_';
export const COUNTERS_COLLECTION = `${COLLECTION_PREFIX}counters`;

// Memory layer definitions (value kept as legacy filename for compatibility;
// collection names are derived as COLLECTION_PREFIX + layer)
export const MEMORY_LAYERS = Object.freeze(
  VALID_LAYERS.reduce((acc, layer) => {
    acc[layer] = `${layer}_memory.db`;
    return acc;
  }, {})
);

// ============================================
// ERROR CLASSES
// ============================================

export const ErrorCodes = Object.freeze({
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  INVALID_INPUT: 'INVALID_INPUT',
  INVALID_LAYER: 'INVALID_LAYER',
  INVALID_CONTENT: 'INVALID_CONTENT',
  INVALID_QUERY: 'INVALID_QUERY',

  RATE_LIMIT_EXCEEDED: 'RATE_LIMIT_EXCEEDED',

  DATABASE_ERROR: 'DATABASE_ERROR',
  CONNECTION_ERROR: 'CONNECTION_ERROR',
  QUERY_ERROR: 'QUERY_ERROR',
  WRITE_ERROR: 'WRITE_ERROR',

  INTERNAL_ERROR: 'INTERNAL_ERROR',
  UNKNOWN_TOOL: 'UNKNOWN_TOOL',
  CONFIGURATION_ERROR: 'CONFIGURATION_ERROR'
});

export const StatusCodes = Object.freeze({
  OK: 200,
  BAD_REQUEST: 400,
  NOT_FOUND: 404,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
  SERVICE_UNAVAILABLE: 503
});

/**
 * Error-message redaction.
 *
 * Storage-layer errors are handed straight back across the transport by most MCP
 * servers, which leaks absolute paths, connection strings and internal addresses
 * to whoever is on the other end. Each rule below substitutes a TYPED token
 * rather than one uniform marker, so a user reading a redacted error can
 * still tell what kind of thing was removed and keep debugging.
 *
 * Order is load-bearing: rules run most-specific first, so a credentialed
 * connection string is labelled as such before the generic path rules can claim
 * a fragment of it.
 */
const REDACTION_RULES = Object.freeze([
  { token: '[credentialed-uri]', match: /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'@/]+:[^\s"'@/]+@[^\s"']+/gi },
  { token: '[db-uri]', match: /\bmongodb(?:\+srv)?:\/\/[^\s"']+/gi },
  { token: '[env-var]', match: /\bprocess\.env(?:\.[A-Za-z_$][\w$]*|\[[^\]]*\])/g },
  { token: '[stack-frame]', match: /\bat\s+\S+\s+\([^)]*\)/gi },
  { token: '[home-dir]', match: /\b[A-Za-z]:[\\/]Users[\\/][^\s"']*/g },
  { token: '[home-dir]', match: /\/(?:home|Users|root)\/[^\s"']*/g },
  { token: '[path]', match: /\b[A-Za-z]:[\\/][^\s"']*/g },
  { token: '[path]', match: /(?:^|(?<=[\s"'(]))\/[^\s"')]*\/[^\s"')]*/g },
  { token: '[private-ip]', match: /\b(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|127(?:\.\d{1,3}){3})\b/g }
]);

const REDACTED_FALLBACK = 'An error occurred';
const MAX_REDACTED_LENGTH = 500;

export function sanitizeErrorMessage(input) {
  const raw =
    input instanceof Error ? input.message :
    typeof input === 'string' ? input :
    null;

  if (raw === null) return REDACTED_FALLBACK;

  const cleaned = REDACTION_RULES
    .reduce((text, rule) => text.replace(rule.match, rule.token), raw)
    .replace(/(\[[a-z-]+\])(?:\s*\1)+/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();

  if (!cleaned) return REDACTED_FALLBACK;
  return cleaned.length > MAX_REDACTED_LENGTH
    ? cleaned.slice(0, MAX_REDACTED_LENGTH - 1) + '\u2026'
    : cleaned;
}

export function sanitizeDetails(details) {
  if (!details || typeof details !== 'object') {
    return {};
  }

  const sanitized = {};
  const sensitiveKeys = ['path', 'file', 'directory', 'stack', 'trace', 'pwd', 'cwd', 'home', 'uri', 'connection'];

  for (const [key, value] of Object.entries(details)) {
    if (sensitiveKeys.some(sk => key.toLowerCase().includes(sk))) {
      continue;
    }

    if (typeof value === 'string') {
      sanitized[key] = sanitizeErrorMessage(value);
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      sanitized[key] = value;
    } else if (Array.isArray(value)) {
      sanitized[key] = value.map(v =>
        typeof v === 'string' ? sanitizeErrorMessage(v) : v
      ).slice(0, 10);
    }
  }

  return sanitized;
}

export class EmetError extends Error {
  constructor(message, code = ErrorCodes.INTERNAL_ERROR, statusCode = StatusCodes.INTERNAL_ERROR, details = {}) {
    super(message);
    this.name = 'EmetError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
    this.timestamp = Date.now();
  }

  toSafeJSON() {
    return {
      success: false,
      error: {
        code: this.code,
        message: sanitizeErrorMessage(this.message),
        statusCode: this.statusCode,
        timestamp: this.timestamp,
        ...(Object.keys(this.details).length > 0 && { details: sanitizeDetails(this.details) })
      }
    };
  }
}

export class DatabaseError extends EmetError {
  constructor(message, operation = 'unknown', details = {}) {
    super(message, ErrorCodes.DATABASE_ERROR, StatusCodes.INTERNAL_ERROR, details);
    this.name = 'DatabaseError';
    this.operation = operation;
  }

  toSafeJSON() {
    const base = super.toSafeJSON();
    base.error.operation = this.operation;
    return base;
  }
}

export class ConfigurationError extends EmetError {
  constructor(message, details = {}) {
    super(message, ErrorCodes.CONFIGURATION_ERROR, StatusCodes.SERVICE_UNAVAILABLE, details);
    this.name = 'ConfigurationError';
  }
}

// ============================================
// LAYER FIELDS
// ============================================
//
// The read and write paths are native MongoDB (stage 1 writes 2026-09-27,
// stage 2 reads 2026-09-28). The SQL dialect tools.js used to speak, and the
// translator that turned it into Mongo queries, are gone. What remains is the
// list of known layer fields: insertMemory refuses any key not on it, so a new
// field that was only half-wired is caught at the write instead of going
// silently missing. `event` is no longer written or read; rows written before
// 2026-09-28 still carry it, untouched - the record is not rewritten.

const FIELD_SET = new Set([
  'id', 'timestamp', 'content', 'context', 'emotional_intensity', 'importance', 'metadata',
  'superseded_by', 'valid_until', 'is_live',
  'source_session_id', 'source_exchange_start', 'source_exchange_end', 'derived_from_ids',
  // sha256 of content, written at save time (2026-09-05). Before this the
  // digest was computed for the read-back receipt and then discarded, so no layer
  // entry could ever be re-verified after the moment it was written.
  'sha256',
  // sha256 of the canonical JSON of metadata, written at save time (C1,
  // 2026-09-07). A separate column so the content digest above stays
  // comparable across the 2026-09-05 boundary and the two boundaries stay
  // distinguishable. Re-attested by reviseMemory when it marks a parent.
  'metadata_sha256',
  // HMAC of the two digests. Key lives on the service, never in this row.
  'signature',
  'prev_sha256',
  'chain_sha256'
]);

// ============================================
// LIVENESS PREDICATE (added 2026-08-24 - post-LIMIT filter fix)
// ============================================
// THE DEFECT THIS FIXES: supersession/expiry used to be applied in JS AFTER the
// database had already sorted and limited, so superseded rows silently consumed
// result slots -- `importance DESC limit 3` on a layer with three high-importance
// superseded rows returned ONE row. A short result set looked like a small layer.
//
// WHY IT COULD NOT SIMPLY BE PUSHED INTO THE FILTER (at the time): `metadata`
// was stored as a JSON *string*, so Mongo could not see inside it. Dot-paths like
// `metadata.superseded_by` matched ZERO documents. Confirmed by probe 2026-08-24.
// The fix therefore PROMOTED the two fields to real top-level columns, which are
// queryable and indexable, and filters on those. Since 2026-09-05 metadata is a
// real subdocument and its copy IS visible to Mongo - but the promoted
// columns remain the fields the liveness predicate reads: they are indexed, and
// the vector-search filter can only see top-level booleans. The JS-level checks
// in tools.js remain as a second line of defence.
//
// Mongo equality-matches missing fields against null, so `{ superseded_by: null }`
// correctly matches rows written before this change AND rows never superseded.

// TWO DIFFERENT IDEAS LIVED IN ONE PREDICATE UNTIL 2026-09-13, and conflating them
// had a consequence nobody intended: asking to see superseded entries also switched
// OFF expiry, so an audit read resurrected entries whose valid_until had passed.
//
// They are not the same kind of thing. Expiry is time-relative and says a fact has
// lapsed - it stops being true. Supersession says a fact was REPLACED, and the
// entry that recorded it remains the honest record of what was believed then. The
// user's decision, 2026-09-13: a superseded parent still surfaces, so a reader
// sees the revision in the context of what it revised. Recall and query_layer
// do not apply this predicate: an expired row is returned and marked.

/** A lapsed fact's end date. Not applied by recall or query_layer. */
export function expiryFilter(nowSec = Date.now() / 1000) {
  return {
    $or: [
      { valid_until: null },
      { valid_until: { $exists: false } },
      { valid_until: { $gt: nowSec } }
    ]
  };
}

/** The supersession clause alone. Applied only when a caller asks to exclude. */
export function notSupersededFilter() {
  return { superseded_by: null };
}

/** Both, for callers that genuinely want only live, unreplaced entries. */
export function livenessFilter(nowSec = Date.now() / 1000) {
  return { ...notSupersededFilter(), ...expiryFilter(nowSec) };
}

/**
 * Merge the read predicate into a caller filter without clobbering an existing
 * $and/$or. Expiry is applied unconditionally; the supersession exclusion only
 * when the caller asks for it. `includeSuperseded: true` no longer means "no
 * filter at all", which is what silently unhid expired entries.
 */
export function withLiveness(filter, includeSuperseded = false) {
  const clauses = [expiryFilter()];
  if (!includeSuperseded) clauses.push(notSupersededFilter());
  const base = filter && Object.keys(filter).length ? filter : null;
  const all = base ? [base, ...clauses] : clauses;
  return all.length === 1 ? all[0] : { $and: all };
}

function stripMongoId(doc) {
  if (!doc) return doc;
  const { _id, ...rest } = doc;
  return rest;
}

// ============================================
// DATABASE CONNECTION POOL (MongoDB)
// ============================================

/**
 * MongoDB-backed database manager. Layer reads and writes are native:
 * insertMemory / readMemory / findMemories / countMemories.
 */
export class EmetDatabase {
  constructor(logger = null) {
    this.logger = logger;
    this.client = null;
    this.db = null;
    this.connectPromise = null;
    this.readConnections = new Map();   // layer -> handle
    this.lastInsertIds = new Map();     // layer -> last allocated id
    this.indexedLayers = new Set();
  }

  log(level, message, context = {}) {
    if (this.logger) {
      this.logger[level](message, context);
    } else {
      console.error(`[${level.toUpperCase()}] ${message}`, context);
    }
  }

  /**
   * Lazily connect the Mongo client (once).
   */
  async ensureClient() {
    if (this.db) return this.db;
    if (this.connectPromise) {
      await this.connectPromise;
      return this.db;
    }

    if (!MONGODB_URI) {
      throw new ConfigurationError('MONGODB_URI is not set - EMET requires a MongoDB connection');
    }

    this.connectPromise = (async () => {
      const opts = { serverSelectionTimeoutMS: 8000, connectTimeoutMS: 8000 };
      // The public-DNS fallback for resolvers that refuse SRV queries lives in
      // one place now (mongo-connect.js, 2026-09-29), shared by every connection.
      let client;
      let fellBack = false;
      try {
        client = await connectMongo(MONGODB_URI, opts, {
          onFallback: (msg) => { fellBack = true; this.log('info', msg); }
        });
      } catch (error) {
        this.connectPromise = null;
        throw new DatabaseError(
          `Failed to connect to MongoDB Atlas${fellBack ? ' after DNS fallback' : ''} - check network and cluster state (cluster may be paused)`,
          'connection',
          { reason: error.message }
        );
      }
      this.client = client;
      this.db = client.db(MONGODB_DB);
      this.log('info', `Connected to MongoDB database '${MONGODB_DB}'`);
    })();

    await this.connectPromise;
    return this.db;
  }

  collectionFor(layer) {
    return this.db.collection(COLLECTION_PREFIX + layer);
  }

  /**
 * Native layer reads (stage 2, 2026-09-28). `filter` is a MongoDB filter.
 * Recall and query_layer use aggregateMemories so the rank happens before
 * the limit. applyLiveness stays off on this path: ended rows are marked,
 * not dropped.
   */
  async findMemories(layer, filter = {}, { sort = { timestamp: -1 }, limit = null, applyLiveness = false, includeSuperseded = false } = {}) {
    await this.ensureClient();
    const col = this.collectionFor(layer);
    try {
      const effective = applyLiveness ? withLiveness(filter, includeSuperseded === true) : filter;
      let cursor = col.find(effective);
      if (sort) cursor = cursor.sort(sort);
      if (limit !== null && limit !== undefined && Number.isFinite(Number(limit))) cursor = cursor.limit(Number(limit));
      return (await cursor.toArray()).map(stripMongoId);
    } catch (error) {
      if (error instanceof EmetError) throw error;
      throw new DatabaseError(`Query failed on layer ${layer}`, 'query', { reason: error.message });
    }
  }

  /**
   * Ranked layer read. The pipeline matches, adds the rank keys, sorts, then
   * limits. See buildRankPipeline.
   */
  async aggregateMemories(layer, pipeline) {
    await this.ensureClient();
    const col = this.collectionFor(layer);
    try {
      return (await col.aggregate(pipeline, { allowDiskUse: true }).toArray()).map(stripMongoId);
    } catch (error) {
      if (error instanceof EmetError) throw error;
      throw new DatabaseError(`Query failed on layer ${layer}`, 'query', { reason: error.message });
    }
  }

  /** How many rows a layer holds, every row counted. */
  async countMemories(layer) {
    await this.ensureClient();
    try {
      return await this.collectionFor(layer).countDocuments({});
    } catch (error) {
      throw new DatabaseError(`Count failed on layer ${layer}`, 'query', { reason: error.message });
    }
  }

  /**
   * THE layer insert, native (2026-09-27, code audit 1.7 stage 1 - the owner: "if SQL
   * is the old and needs to be updated then update it"). Takes the document as
   * a document. Every key must be a known layer field; the id is allocated
   * here. The INSERT-string shim it replaced went with the SQL translator in
   * stage 2 (2026-09-28).
   */
  async insertMemory(layer, doc) {
    for (const k of Object.keys(doc)) {
      if (!FIELD_SET.has(k)) throw new DatabaseError(`Unknown layer field: ${k}`, 'insert_memory', { layer });
    }
    const col = this.collectionFor(layer);
    try {
      const id = await this.nextId(layer);
      const row = { ...doc, id };
      await col.insertOne(row);
      this.lastInsertIds.set(layer, id);
      return id;
    } catch (error) {
      if (error instanceof EmetError) throw error;
      throw new DatabaseError('Failed to write to primary storage', 'storage_write', { layer, isPrimary: true, reason: error.message });
    }
  }

  /** Read one layer row by id, native. The read-back half of the aleph. */
  async readMemory(layer, id) {
    const row = await this.collectionFor(layer).findOne({ id });
    return row ? stripMongoId(row) : null;
  }

  /**
   * Where a transcript session stands, for the provenance auto-stamp
   * (2026-09-29, a decision record). Read-only. Resolves a base id or any part id
   * to its base and the highest exchange index stored across every live part;
   * 0 when nothing is stored yet (a session opened but not yet appended).
   */
  async transcriptPosition(sessionId) {
    const db = await this.ensureClient();
    const { inspectSession } = await import('./session.js');
    const t = await inspectSession(db.collection('transcripts'), sessionId);
    const highest = typeof t.highest_exchange_index === 'number' ? t.highest_exchange_index
      : (typeof t.last_index === 'number' ? t.last_index : 0);
    // The last live part the server minted for this session (<base> or
    // <base>_verbatim_partN, highest N), so the closing exchange is written
    // there and never where a caller pointed (2026-10-01). null when none.
    const base = t.base_session_id || sessionId;
    const { isMintedPartOf } = await import('./session-graph.js');
    const ids = (Array.isArray(t.parts_found) ? t.parts_found : (t.present && t.session_id ? [t.session_id] : []))
      .filter((id) => isMintedPartOf(id, base));
    const num = (id) => { const m = /_verbatim_part(\d+)$/.exec(id); return m ? Number(m[1]) : 0; };
    const last_part = ids.length ? ids.reduce((a, b) => (num(b) > num(a) ? b : a)) : null;
    return { base, present: !!t.present, highest: Math.max(0, highest || 0), last_part };
  }

  /**
   * Atomically allocate the next integer id for a layer.
   */
  async nextId(layer) {
    const counters = this.db.collection(COUNTERS_COLLECTION);
    const res = await counters.findOneAndUpdate(
      { _id: layer },
      { $inc: { seq: 1 } },
      { upsert: true, returnDocument: 'after' }
    );
    const docResult = res && res.value !== undefined ? res.value : res; // driver v4/v5+ shape tolerance
    if (docResult && typeof docResult.seq === 'number') return docResult.seq;
    // Extremely defensive fallback: derive from max existing id
    const maxDoc = await this.collectionFor(layer).find({}).sort({ id: -1 }).limit(1).toArray();
    const next = (maxDoc.length ? maxDoc[0].id : 0) + 1;
    await counters.updateOne({ _id: layer }, { $set: { seq: next } }, { upsert: true });
    return next;
  }

  /**
   * Get connection (shim) for a layer.
   */
  async getConnection(layer) {
    const validatedLayer = validateLayer(layer, true);
    if (!MEMORY_LAYERS[validatedLayer]) {
      throw new ValidationError('layer', `Invalid memory layer: ${layer}`);
    }

    if (this.readConnections.has(validatedLayer)) {
      return this.readConnections.get(validatedLayer);
    }

    await this.ensureClient();
    await this.ensureSchema(null, validatedLayer);

    // A handle, not a query surface: reads go through findMemories /
    // readMemory / countMemories. Kept because callers use it to warm the
    // client and the layer's indexes.
    const handle = { layer: validatedLayer };
    this.readConnections.set(validatedLayer, handle);
    this.log('info', `Connected to ${validatedLayer} memory layer (MongoDB)`);
    return handle;
  }

  /**
   * Ensure indexes exist for a layer's collection.
   */
  async ensureSchema(db, layer) {
    if (this.indexedLayers.has(layer)) return;
    try {
      const col = this.collectionFor(layer);
      await col.createIndex({ id: 1 }, { unique: true });
      await col.createIndex({ timestamp: -1 });
      await col.createIndex({ importance: -1 });
      // The tier-1 -> tier-2 pointer. Indexed because the REVERSE question -
      // "what did we take from this session?" - is answered by querying entries
      // whose pointer names that session. That makes the reverse direction the
      // same data read the other way, rather than a second stored structure
      // that would have to be kept in agreement with this one.
      await col.createIndex({ source_session_id: 1 }, { sparse: true });
      await col.createIndex({ person_id: 1 }, { sparse: true });
      await col.createIndex({ client_id: 1 }, { sparse: true });
      this.indexedLayers.add(layer);
    } catch (error) {
      this.log('error', `Schema error for ${layer}:`, { error: error.message });
      throw new DatabaseError(
        `Failed to initialize schema for layer: ${layer}`,
        'schema_creation',
        { layer }
      );
    }
  }

  /**
   * Close the Mongo client.
   */
  async closeAll() {
    this.readConnections.clear();
    this.indexedLayers.clear();
    if (this.client) {
      await this.client.close();
      this.client = null;
      this.db = null;
      this.connectPromise = null;
      this.log('info', 'Closed MongoDB client');
    }
  }
}

// ============================================
// HELPER FUNCTIONS
// ============================================

/**
 * Determine appropriate memory layer based on content
 */
export function determineLayer(content, metadata = {}) {
  const contentLower = content.toLowerCase();

  if (metadata.layer && MEMORY_LAYERS[metadata.layer]) {
    return metadata.layer;
  }

  if (contentLower.includes('session') || contentLower.includes('conversation') ||
      contentLower.includes('today') || contentLower.includes('happened') ||
      contentLower.includes('event') || contentLower.includes('experience')) {
    return 'episodic';
  }

  if (contentLower.includes('definition') || contentLower.includes('concept') ||
      contentLower.includes('theory') || contentLower.includes('fact') ||
      contentLower.includes('knowledge') || contentLower.includes('meaning')) {
    return 'semantic';
  }

  if (contentLower.includes('how to') || contentLower.includes('process') ||
      contentLower.includes('step') || contentLower.includes('procedure') ||
      contentLower.includes('technique') || contentLower.includes('workflow')) {
    return 'procedural';
  }

  if (contentLower.includes('thinking') || contentLower.includes('awareness') ||
      contentLower.includes('pattern') || contentLower.includes('reflection') ||
      contentLower.includes('learning') || contentLower.includes('insight')) {
    return 'meta';
  }

  if (contentLower.includes('identity') || contentLower.includes('core values') ||
      contentLower.includes('strategic focus') || contentLower.includes('purpose') ||
      contentLower.includes('principle') || contentLower.includes('belief')) {
    return 'identity';
  }

  return 'working';
}

/** A case-insensitive "contains" match for a plain string, regex-escaped. */
export function containsRegex(text) {
  return { $regex: String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
}

/** Columns a caller may sort on (whitelist). */
export const ALLOWED_COLUMNS = ['id', 'timestamp', 'content', 'context', 'emotional_intensity', 'importance'];
export const ALLOWED_ORDER_DIRECTIONS = ['ASC', 'DESC'];

/**
 * Rank pipeline for recall and query_layer.
 *
 * $match the caller's filter, then $addFields _ended (and _hits for keyword
 * recall), then $sort by the same keys the page uses, then $limit. The limit
 * is applied after that rank, so a better match is not cut for having a lower
 * importance or an older timestamp. Stages are $match, $addFields, $sort,
 * $limit, and $project. Operators are $cond, $or, $and, $eq, $ne, $gt, $lt,
 * $gte, $ifNull, $convert, $add, $divide, $regexMatch, and $literal. All of
 * these are aggregation features in MongoDB 4.4 and in Atlas 7.0.
 * A keyword is a $literal pattern, the same escaped text containsRegex puts
 * in the $match filter, so a word that starts with $ is not a field path.
 *
 * history flips _ended so the window is the ended rows, which is what that
 * page returns. The tiebreak is id, then _id.
 */
function rankNumber(path) {
  return { $convert: { input: { $ifNull: [path, null] }, to: 'double', onError: null, onNull: null } };
}

function supersededFlag(path) {
  return { $gt: [{ $convert: { input: { $ifNull: [path, 0] }, to: 'double', onError: 0, onNull: 0 } }, 0] };
}

/** null when the field is absent. Otherwise true when that end date has passed. */
function expiryFlag(path, nowSec) {
  const n = rankNumber(path);
  const seconds = { $cond: [{ $gt: [n, 1e12] }, { $divide: [n, 1000] }, n] };
  return {
    $cond: [
      { $eq: [{ $ifNull: [path, null] }, null] },
      null,
      { $and: [{ $ne: [n, null] }, { $gt: [n, 0] }, { $lt: [seconds, nowSec] }] }
    ]
  };
}

export function endedExpression(nowSec = Date.now() / 1000) {
  const fromMetadata = expiryFlag('$metadata.valid_until', nowSec);
  const fromCustom = expiryFlag('$metadata.custom.valid_until', nowSec);
  const fromColumn = expiryFlag('$valid_until', nowSec);
  const expired = {
    $cond: [
      { $ne: [fromMetadata, null] },
      fromMetadata,
      { $cond: [{ $ne: [fromCustom, null] }, fromCustom, { $ifNull: [fromColumn, false] }] }
    ]
  };
  return {
    $cond: [
      { $or: [
        supersededFlag('$superseded_by'),
        supersededFlag('$metadata.superseded_by'),
        supersededFlag('$metadata.custom.superseded_by'),
        { $eq: ['$is_live', false] },
        expired
      ] },
      1,
      0
    ]
  };
}

function keywordHitExpression(keyword) {
  // Same pattern and 'i' option as the $match filter. $literal keeps a keyword
  // such as $gt from being read as a field path. $toLower is not used: it
  // folds only A-Z, so École would not count as a hit for école.
  const pattern = containsRegex(keyword).$regex;
  const has = (path) => ({
    $regexMatch: {
      input: { $convert: { input: { $ifNull: [path, ''] }, to: 'string', onError: '', onNull: '' } },
      regex: { $literal: pattern },
      options: 'i'
    }
  });
  return { $cond: [{ $or: [has('$content'), has('$context')] }, 1, 0] };
}

export function hitsExpression(keywords) {
  const list = Array.isArray(keywords) ? keywords : [];
  if (list.length === 0) return 0;
  if (list.length === 1) return keywordHitExpression(list[0]);
  return { $add: list.map(keywordHitExpression) };
}

export function buildRankPipeline({ filter, keywords, latest = false, orderBy = null, bound, nowSec = Date.now() / 1000, history = false, kind = 'recall' } = {}) {
  const stages = [];
  if (filter && typeof filter === 'object' && Object.keys(filter).length) stages.push({ $match: filter });
  const add = { _ended: endedExpression(nowSec) };
  const endedDir = history ? -1 : 1;
  let sort;
  if (kind === 'recall') {
    add._hits = hitsExpression(keywords);
    sort = latest
      ? { _ended: endedDir, timestamp: -1 }
      : { _ended: endedDir, _hits: -1, importance: -1 };
  } else {
    const spec = sortFor(orderBy);
    const column = Object.keys(spec)[0];
    sort = { _ended: endedDir, [column]: spec[column] };
  }
  if (!('id' in sort)) sort.id = 1;
  if (!('_id' in sort)) sort._id = 1;
  stages.push({ $addFields: add });
  stages.push({ $sort: sort });
  stages.push({ $limit: bound });
  // _ended and _hits stay on the documents. The page orders by those store
  // values and then drops them. Recomputing the hit count in JavaScript folds
  // a different set of letters than $regexMatch.
  return stages;
}

/** order_by text ("importance DESC") -> a MongoDB sort. No order, or an unknown field, is importance descending. Timestamp is used only when the caller names it. */
export function sortFor(orderBy) {
  if (!orderBy) return { importance: -1 };
  const parts = String(orderBy).trim().split(/\s+/);
  const column = parts[0]?.toLowerCase();
  const direction = (parts[1] || 'DESC').toUpperCase();
  if (!ALLOWED_COLUMNS.includes(column)) return { importance: -1 };
  return { [column]: direction === 'ASC' ? 1 : -1 };
}

/** Structured query_layer filters -> a MongoDB filter. Unknown keys are ignored (the validator reports them). */
export function buildMemoryFilter(filters) {
  if (!filters || typeof filters !== 'object') return {};
  const and = [];
  const range = (field, min, max) => {
    const r = {};
    if (min !== undefined) r.$gte = Number(min);
    if (max !== undefined) r.$lte = Number(max);
    if (Object.keys(r).length) and.push({ [field]: r });
  };
  range('importance', filters.importance_min, filters.importance_max);
  range('emotional_intensity', filters.emotional_intensity_min, filters.emotional_intensity_max);
  range('timestamp', filters.timestamp_after, filters.timestamp_before);
  if (filters.content_contains !== undefined) and.push({ content: containsRegex(filters.content_contains) });
  if (filters.context_contains !== undefined) and.push({ context: containsRegex(filters.context_contains) });
  if (filters.id !== undefined) and.push({ id: Number(filters.id) });
  return and.length === 0 ? {} : (and.length === 1 ? and[0] : { $and: and });
}

// ============================================
// EXPORT DEFAULT
// ============================================

export default {
  // Configuration
  DEBUG,
  MEMORY_LAYERS,
  MONGODB_URI,
  MONGODB_DB,

  // Error classes
  ErrorCodes,
  StatusCodes,
  EmetError,
  DatabaseError,
  ConfigurationError,

  // Database class
  EmetDatabase,

  // Helper functions
  determineLayer,
  containsRegex,
  sortFor,
  buildMemoryFilter,
  sanitizeErrorMessage,
  sanitizeDetails,

  // Constants
  ALLOWED_COLUMNS,
  ALLOWED_ORDER_DIRECTIONS
};
