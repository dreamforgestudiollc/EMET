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
 * Tools Module - MCP tool definitions and handlers
 */

import { connectMongo } from './mongo-connect.js';
import { resolveModulePath } from './module-path.js';
import { replacedByOf } from './setup.js';
import { currentActor, writerStamp, boundSourceTag, LOCAL_SUBJECT } from './persons.js';
import {
  ValidationError,
  VALID_LAYERS,
  CONTENT_LIMITS,
  NUMERIC_LIMITS,
  validateLayer,
  validateContent,
  validateMetadata,
  relocatedFields,
  isPlainObject,
  validateLimit,
  validateQueryOptions,
  RECOGNISED_FILTER_KEYS,
  MARKER_FIELDS
} from './validation.js';
// The layer charter is the vocabulary home (2026-09-07): which layers may be
// revised, the importance band, and whether a provenance pointer is required
// are all read from it, not from constants here.
import { policyFor, bandFor, resolveImportance, FALLBACK_LAYER } from './layers.js';
// The full routing decision (confidence, signals, emotional intensity) is kept
// on every write so the receipt can say how the entry was placed (B1/B2).
import { ContentAnalyzer } from './content_analyzer.js';
const ROUTER = new ContentAnalyzer();
// Template validation (STANDARD 9). Runs inside writeDoc() on every document
// write, with no argument that can switch it off (9a L2). It marks; it never
// rejects, alters, or blocks a write.
import {
  validateDocument, templateFor, isGovernedByShippedCopy, isDropDoc, buildAcceptance,
  loadShipped, parseTemplate, checkRecord, VERDICT as CONFORMANCE_VERDICT
} from './conformance.js';
// Shipped guides (2026-09-28): read on demand; the release copy governs.
import { readShippedGuide } from './guides.js';

import {
  EmetError,
  DatabaseError,
  ErrorCodes,
  StatusCodes,
  MEMORY_LAYERS,
  MONGODB_DB,
  COLLECTION_PREFIX,
  determineLayer,
  containsRegex,
  sortFor,
  buildRankPipeline,
  buildMemoryFilter,
  sanitizeErrorMessage,
  sanitizeDetails
} from './database.js';

// MongoDB for Tier 2 transcript storage
import { setting } from './env.js';
// The session graph's governed-tool list (2026-09-29): one list, used for the schemas below.
import { GRAPH_WRITE_TOOLS, isBotTag, mainRecordIds, botRecordDir } from './session-graph.js';
// Startup page completion (2026-10-03): which startup pages a host never fetched, read at session open.
import { pageCompletion, noteOpenMissing, cachedLoad } from './startup-pages.js';
// Secret redaction (2026-09-07). Every write path below passes its content
// through this before the digest is computed, so the stored sha256 is the
// digest of what was stored. The result of each write reports `redacted` -
// the count of masked spans - because a control that acts silently is a
// summary, and the record must show that something was removed.
import { redactWithReport, redactDeep } from './redact.js';
import { EMET_VERSION } from './version.js';

// MongoDB connection URI â€” must be set via MONGODB_URI environment variable in .mcp.json
const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error("[EMET] WARNING: MONGODB_URI not set â€” MongoDB tools will fail");
}

// ============================================
// RATE LIMITING
// ============================================

/**
 * Rate Limiter Configuration
 */
export const RATE_LIMIT_CONFIG = {
  GLOBAL_WINDOW_MS: 60000,
  GLOBAL_MAX_REQUESTS: 300,
  TOOL_WINDOW_MS: 60000,
  TOOL_MAX_REQUESTS: {
    recall: 120,
    semantic_recall: 120,
    query_layer: 100,
    emet_status: 30,
    save_to_layer: 60
  },
  DEFAULT_TOOL_MAX: 60,
  CLEANUP_INTERVAL_MS: 300000
};

/**
 * Rate Limit Error class
 */
export class RateLimitError extends Error {
  constructor(message, retryAfterMs = 60000) {
    super(message);
    this.name = 'RateLimitError';
    this.retryAfterMs = retryAfterMs;
    this.statusCode = 429;
  }
}

/**
 * In-Memory Rate Limiter
 */
export class RateLimiter {
  constructor(logger = null) {
    this.buckets = new Map();
    this.logger = logger;

    this.cleanupInterval = setInterval(() => this.cleanup(), RATE_LIMIT_CONFIG.CLEANUP_INTERVAL_MS);

    if (this.cleanupInterval.unref) {
      this.cleanupInterval.unref();
    }

    this.log('debug', 'Rate limiter initialized', {
      globalLimit: RATE_LIMIT_CONFIG.GLOBAL_MAX_REQUESTS,
      cleanupIntervalMs: RATE_LIMIT_CONFIG.CLEANUP_INTERVAL_MS
    });
  }

  log(level, message, context = {}) {
    if (this.logger) {
      this.logger[level](message, context);
    }
  }

  _bucket(key) {
    const k = key || 'stdio';
    let bucket = this.buckets.get(k);
    if (!bucket) {
      bucket = { global: [], tools: new Map() };
      this.buckets.set(k, bucket);
    }
    return bucket;
  }

  checkLimit(toolName, bucketKey = 'stdio') {
    const now = Date.now();
    this.pruneExpired(now);
    const bucket = this._bucket(bucketKey);

    const globalWindowStart = now - RATE_LIMIT_CONFIG.GLOBAL_WINDOW_MS;
    const globalCount = bucket.global.filter(ts => ts > globalWindowStart).length;

    if (globalCount >= RATE_LIMIT_CONFIG.GLOBAL_MAX_REQUESTS) {
      const oldestInWindow = Math.min(...bucket.global.filter(ts => ts > globalWindowStart));
      const retryAfterMs = (oldestInWindow + RATE_LIMIT_CONFIG.GLOBAL_WINDOW_MS) - now;

      return {
        allowed: false,
        reason: `Global rate limit exceeded: ${globalCount}/${RATE_LIMIT_CONFIG.GLOBAL_MAX_REQUESTS} requests per minute`,
        retryAfterMs: Math.max(retryAfterMs, 1000)
      };
    }

    const toolWindowStart = now - RATE_LIMIT_CONFIG.TOOL_WINDOW_MS;
    const toolTimestamps = bucket.tools.get(toolName) || [];
    const toolCount = toolTimestamps.filter(ts => ts > toolWindowStart).length;
    const toolMax = RATE_LIMIT_CONFIG.TOOL_MAX_REQUESTS[toolName] || RATE_LIMIT_CONFIG.DEFAULT_TOOL_MAX;

    if (toolCount >= toolMax) {
      const oldestToolInWindow = Math.min(...toolTimestamps.filter(ts => ts > toolWindowStart));
      const retryAfterMs = (oldestToolInWindow + RATE_LIMIT_CONFIG.TOOL_WINDOW_MS) - now;

      return {
        allowed: false,
        reason: `Tool '${toolName}' rate limit exceeded: ${toolCount}/${toolMax} requests per minute`,
        retryAfterMs: Math.max(retryAfterMs, 1000)
      };
    }

    return { allowed: true };
  }

  recordRequest(toolName, bucketKey = 'stdio') {
    const now = Date.now();
    const bucket = this._bucket(bucketKey);
    bucket.global.push(now);

    if (!bucket.tools.has(toolName)) {
      bucket.tools.set(toolName, []);
    }
    bucket.tools.get(toolName).push(now);
  }

  pruneExpired(now = Date.now()) {
    const globalCutoff = now - RATE_LIMIT_CONFIG.GLOBAL_WINDOW_MS;
    const toolCutoff = now - RATE_LIMIT_CONFIG.TOOL_WINDOW_MS;

    for (const [key, bucket] of this.buckets) {
      bucket.global = bucket.global.filter(ts => ts > globalCutoff);
      for (const [toolName, timestamps] of bucket.tools.entries()) {
        const pruned = timestamps.filter(ts => ts > toolCutoff);
        if (pruned.length === 0) bucket.tools.delete(toolName);
        else bucket.tools.set(toolName, pruned);
      }
      if (bucket.global.length === 0 && bucket.tools.size === 0) this.buckets.delete(key);
    }
  }

  cleanup() {
    const count = (map) => {
      let n = 0;
      for (const bucket of map.values()) {
        n += bucket.global.length + Array.from(bucket.tools.values()).reduce((sum, arr) => sum + arr.length, 0);
      }
      return n;
    };
    const before = count(this.buckets);
    this.pruneExpired();
    const after = count(this.buckets);

    if (before !== after) {
      this.log('debug', 'Rate limiter cleanup completed', {
        entriesBefore: before,
        entriesAfter: after,
        entriesRemoved: before - after
      });
    }
  }

  getStatus(bucketKey = 'stdio') {
    const now = Date.now();
    const globalWindowStart = now - RATE_LIMIT_CONFIG.GLOBAL_WINDOW_MS;
    const bucket = this.buckets.get(bucketKey || 'stdio') || { global: [], tools: new Map() };

    const status = {
      bucket: bucketKey || 'stdio',
      global: {
        current: bucket.global.filter(ts => ts > globalWindowStart).length,
        limit: RATE_LIMIT_CONFIG.GLOBAL_MAX_REQUESTS,
        windowMs: RATE_LIMIT_CONFIG.GLOBAL_WINDOW_MS
      },
      tools: {}
    };

    const toolWindowStart = now - RATE_LIMIT_CONFIG.TOOL_WINDOW_MS;
    for (const [toolName, timestamps] of bucket.tools.entries()) {
      const count = timestamps.filter(ts => ts > toolWindowStart).length;
      const limit = RATE_LIMIT_CONFIG.TOOL_MAX_REQUESTS[toolName] || RATE_LIMIT_CONFIG.DEFAULT_TOOL_MAX;
      status.tools[toolName] = { current: count, limit };
    }

    return status;
  }

  stop() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }
}

/** Stdio shares one bucket per process. HTTP is per person and client id. */
export function rateBucket(actor) {
  if (!actor || actor.transport !== 'http') return 'stdio';
  return `${actor.personId || 'anonymous'}|${actor.clientId || 'anonymous'}`;
}

// ============================================
// ERROR HANDLING
// ============================================

/**
 * Wrap ValidationError to match EmetError interface
 */
function wrapValidationError(error) {
  return {
    success: false,
    error: {
      code: ErrorCodes.VALIDATION_ERROR,
      message: sanitizeErrorMessage(error.message),
      statusCode: StatusCodes.BAD_REQUEST,
      timestamp: Date.now(),
      field: error.field || 'unknown',
      validationMessage: sanitizeErrorMessage(error.validationMessage || error.message)
    }
  };
}

/**
 * Central error handler for all tool operations
 */
export function handleError(error, toolName, logger = null) {
  let errorResponse;

  if (error instanceof EmetError) {
    errorResponse = error.toSafeJSON();
  } else if (error instanceof ValidationError) {
    errorResponse = wrapValidationError(error);
  } else if (error instanceof RateLimitError) {
    errorResponse = {
      success: false,
      error: {
        code: ErrorCodes.RATE_LIMIT_EXCEEDED,
        message: sanitizeErrorMessage(error.message),
        statusCode: StatusCodes.RATE_LIMITED,
        timestamp: Date.now(),
        retryAfterMs: error.retryAfterMs,
        retryAfterSeconds: Math.ceil(error.retryAfterMs / 1000)
      }
    };
  } else if (error && error.code && error.code.startsWith('SQLITE')) {
    errorResponse = {
      success: false,
      error: {
        code: ErrorCodes.DATABASE_ERROR,
        message: 'Database operation failed',
        statusCode: StatusCodes.INTERNAL_ERROR,
        timestamp: Date.now(),
        details: {
          sqliteCode: error.code
        }
      }
    };
  } else {
    errorResponse = {
      success: false,
      error: {
        code: ErrorCodes.INTERNAL_ERROR,
        message: sanitizeErrorMessage(error?.message || 'Unknown error'),
        statusCode: StatusCodes.INTERNAL_ERROR,
        timestamp: Date.now()
      }
    };
  }

  errorResponse.error.tool = toolName;

  // Read at call time. Never attach a stack on the HTTP server.
  if (process.env.DEBUG === 'true' && error?.stack && currentActor().transport !== 'http') {
    errorResponse.error._debug = {
      originalMessage: error.message,
      stack: error.stack.split('\n').slice(0, 5).join('\n')
    };
  }

  if (logger) {
    logger.error('Tool error occurred', {
      tool: toolName,
      errorName: error?.name || 'Error',
      errorCode: error?.code || 'UNKNOWN',
      error
    });
  }

  return {
    content: [{
      type: "text",
      text: JSON.stringify(errorResponse)
    }],
    isError: true
  };
}

/**
 * Create success response with consistent format
 */
export function createSuccessResponse(data, toolName) {
  // A LIST payload can carry an advisory the caller needs to SEE - an ignored
  // filter key, say - and an array has nowhere to put one: JSON.stringify drops
  // non-index properties, and wrapping the array in an object would break every
  // caller that reads `data` as a list. So a tool attaches advisories with
  // attachWarnings() and they are hoisted here, beside `data`.
  //
  // Restricted to arrays deliberately. Object payloads such as the write
  // receipt already carry their own `warnings` field INSIDE `data`; hoisting
  // that one would duplicate it and change a shape callers already read.
  const warnings = Array.isArray(data) && Array.isArray(data.warnings) && data.warnings.length > 0
    ? data.warnings
    : null;

  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        success: true,
        tool: toolName,
        timestamp: Date.now(),
        ...(warnings ? { warnings } : {}),
        data
      })
      // Compact on purpose (code audit 2026-09-27, 2.6): the two-space indent was
      // ~12% of every response - 9,400 characters of the initialize payload -
      // and hosts parse JSON; nobody reads the whitespace.
    }]
  };
}

/**
 * Attach caller-facing advisories to an array payload without changing what the
 * array itself serialises to. Non-enumerable, so JSON.stringify(list) is
 * unaffected and any code iterating the list sees exactly what it saw before;
 * createSuccessResponse is what lifts them into the response envelope.
 * No-op unless both arguments are arrays and there is something to say.
 */
export function attachWarnings(list, warnings) {
  if (!Array.isArray(list) || !Array.isArray(warnings) || warnings.length === 0) {
    return list;
  }
  Object.defineProperty(list, 'warnings', {
    value: warnings,
    enumerable: false,
    configurable: true
  });
  return list;
}

// ============================================
// MEMORY OPERATIONS
// ============================================

/**
 * Save a memory record.
 */
export async function saveMemory(dbManager, content, layer = null, metadata = {}, logger = null, auditOperation = null, options = {}) {
  const startTime = Date.now();
  const requestId = logger?._generateRequestId?.() || `req-${Date.now()}`;

  try {
    // Redact BEFORE validation and BEFORE the digest: what is stored, hashed
    // and read back is the scrubbed text. The count travels to the result.
    const redaction = redactWithReport(content);
    const validatedContent = validateContent(redaction.text);
    const validatedLayer = layer ? validateLayer(layer) : null;

    // The tier-1 -> tier-2 pointer is pulled out BEFORE metadata validation and
    // stored as top-level columns, not inside metadata. When this was written
    // metadata was a JSON string the store could not filter into; it is a
    // subdocument now, but the pointer stays top-level because it is
    // indexed there and the reverse lookup depends on that index.
    const { derived_from: rawProvenance, ...restMetadata } = metadata || {};
    let provenance = validateProvenance(rawProvenance);
    const metaRedaction = redactDeep(restMetadata);
    redaction.hits += metaRedaction.hits;
    const incoming = { ...(metaRedaction.value || {}) };
    // The accountability markers are the door's verdict, not the caller's
    // claim: whatever the caller sent under these names is dropped and the
    // door writes what it actually found.
    for (const marker of MARKER_FIELDS) delete incoming[marker];
    // A null importance / emotional_intensity is "not supplied", not a value.
    // Left in place, the validator would turn a null importance into its own
    // fixed 0.7 and the charter band below would never be consulted.
    if (incoming.importance === null || incoming.importance === undefined) delete incoming.importance;
    if (incoming.emotional_intensity === null || incoming.emotional_intensity === undefined) delete incoming.emotional_intensity;
    // Bucket words are resolved after the layer is known. Pull them off so
    // validateMetadata does not reject a string on the numeric field.
    const rawImportance = incoming.importance;
    const rawBucket = incoming.importance_bucket;
    const rawDegree = incoming.importance_degree;
    delete incoming.importance;
    delete incoming.importance_bucket;
    delete incoming.importance_degree;
    // E3: absent (undefined) is the only condition that earns the marker. An
    // explicit null is the caller saying "unknown", which is an answer.
    const assertionOriginAbsent = incoming.assertion_origin === undefined;
    const validatedMetadata = validateMetadata(incoming);
    // A6: what the whitelist moved under metadata.custom is reported in the
    // receipt, so a field that landed somewhere other than where the caller put
    // it is visible at write time instead of discovered at read time.
    const relocatedToCustom = relocatedFields(validatedMetadata);
    const warnings = [];

    // B1: the full routing decision is computed on every write, whether or not
    // the caller named a layer, so the receipt can say how the entry was placed.
    // B5 (decided 2026-09-07): an unlabelled write is NOT placed by either
    // router. Both were measured against the record (keyword 41.4%, analyzer
    // 36.1%) and neither is fit to put material in a durable layer by guess.
    // It lands in the charter's fallback layer, flagged routing.method
    // 'fallback', and both routers' opinions are recorded beside it so the
    // decision is reviewable. Naming a layer is the norm; the receipt says so.
    const decision = ROUTER.analyze(validatedContent, {});
    const keywordLayer = determineLayer(validatedContent, validatedMetadata);
    const targetLayer = validatedLayer || FALLBACK_LAYER;
    // Lesson fields are refused at the door when the reader would never count
    // them (2026-09-29, a decision record): a malformed key, a key off the meta
    // layer, or a disposition that settles nothing. Checked on the caller's
    // metadata as sent, before anything is written.
    {
      const { checkLessonFields } = await import('./lessons-to-checks.js');
      const lessonProblem = checkLessonFields(targetLayer, incoming);
      if (lessonProblem) throw new ValidationError('metadata.lesson', `${lessonProblem} Nothing was written.`);
    }
    if (!validatedLayer) {
      warnings.push(
        `no layer given: landed in ${FALLBACK_LAYER} (fallback). Name the layer - ` +
        `the routers are recorded in routing but do not place entries.`
      );
    }

    // A3: the source tag is decided HERE and nowhere else.
    // Stdio: the caller's tag wins; the configured default is used and marked;
    // nothing at all is marked too.
    // HTTP: the tag bound at approval wins. A token issued before tags were
    // stored (no bound tag) may use the caller's tag only when that tag is an
    // exact member of EMET_SOURCE_TAGS. The shared default is not applied there.
    const sourceDecision = resolvedSourceTag(validatedMetadata.source);
    if (sourceDecision.from === 'caller') {
      const defaultTag = setting('SOURCE_TAG');
      if (sourceDecision.tag) {
        validatedMetadata.source = sourceDecision.tag;
      } else if (typeof defaultTag === 'string' && defaultTag.trim() !== '') {
        validatedMetadata.source = defaultTag;
        validatedMetadata.source_defaulted = true;
      } else {
        validatedMetadata.source = null;
        validatedMetadata.source_missing = true;
      }
    } else {
      validatedMetadata.source = sourceDecision.tag;
      delete validatedMetadata.source_defaulted;
      if (sourceDecision.tag) delete validatedMetadata.source_missing;
      else validatedMetadata.source_missing = true;
    }
    // Registry check: only when a registry is configured (a fresh install has
    // none yet), and only for a tag that exists - a missing tag is already marked.
    const registry = String(setting('SOURCE_TAGS') ?? '')
      .split(',').map((s) => s.trim()).filter((s) => s !== '');
    if (registry.length > 0 && typeof validatedMetadata.source === 'string' &&
        !registry.includes(validatedMetadata.source)) {
      validatedMetadata.source_unregistered = true;
    }
    // Person comes from the login, never from the caller's claim. Stdio is
    // one fixed local subject. A caller client_id never survives in custom.
    {
      const stamp = writerStamp();
      validatedMetadata.person_id = stamp.person_id;
      delete validatedMetadata.client_id;
      if (validatedMetadata.custom && typeof validatedMetadata.custom === 'object') {
        delete validatedMetadata.custom.client_id;
        delete validatedMetadata.custom.person_id;
        if (Object.keys(validatedMetadata.custom).length === 0) delete validatedMetadata.custom;
      }
      validatedMetadata.client_id = stamp.client_id;
    }

    // A4: importance is a named bucket. The float is the bucket midpoint
    // unless the caller named a degree (low/mid/high) or still sent a number.
    const band = bandFor(targetLayer);
    const resolved = resolveImportance(targetLayer, rawImportance, {
      importance_bucket: rawBucket,
      importance_degree: rawDegree
    });
    validatedMetadata.importance = resolved.importance;
    if (resolved.bucket) validatedMetadata.importance_bucket = resolved.bucket;
    if (resolved.degree) validatedMetadata.importance_degree = resolved.degree;
    if (resolved.defaulted) validatedMetadata.importance_defaulted = true;
    if (resolved.importance < band.min || resolved.importance > band.max) {
      warnings.push(`importance ${resolved.importance} is outside the ${targetLayer} band ${band.min}–${band.max}`);
    }

    // A5: the charter says whether this layer wants a provenance pointer.
    // 2026-09-29 (a decision record): the pointer is STAMPED when the caller names
    // its transcript session, and a layer whose charter REQUIRES provenance
    // (semantic, procedural) REFUSES a write that has no source at all. The
    // transport is stateless, so the server never guesses which host's session
    // a write belongs to - the caller names it (save_to_layer `session_id`),
    // and the server reads that session's own counter. The stamped exchange is
    // the one in progress: the highest stored index plus one, which the append
    // after the reply stores. Until it lands the pointer is pending, and
    // emet_gaps reports one that never does.
    let provenanceStamped = false;
    if (!provenance && options && options.session_id !== undefined && options.session_id !== null) {
      const sid = typeof options.session_id === 'string' ? options.session_id.trim() : '';
      if (!sid || sid.length > 200) throw new ValidationError('session_id', 'must be the non-empty transcript session id from emet_session_open. Nothing was written.');
      if (typeof dbManager.transcriptPosition !== 'function') throw new ValidationError('session_id', 'this store cannot read transcript positions, so the pointer cannot be stamped - pass derived_from instead. Nothing was written.');
      const pos = await dbManager.transcriptPosition(sid);
      const ex = pos.highest + 1;
      provenance = validateProvenance({ session_id: pos.base, exchange_start: ex, exchange_end: ex });
      provenanceStamped = true;
    }
    const provenancePolicy = policyFor(targetLayer).provenance;
    if (!provenance && provenancePolicy === 'required') {
      throw new ValidationError('derived_from',
        `${targetLayer} entries must carry their source. Pass session_id (your transcript session from ` +
        `emet_session_open - the server stamps the exchange), or derived_from {session_id, exchange_start, ` +
        `exchange_end}, or derived_from {entries: [ids]} for an entry consolidated from other entries. Nothing was written.`);
    }
    if (!provenance && provenancePolicy === 'encouraged') {
      validatedMetadata.provenance_missing = true;
    }

    // E3: the door never infers the origin; it only records that none was given.
    if (assertionOriginAbsent) {
      validatedMetadata.assertion_origin = null;
      validatedMetadata.assertion_origin_missing = true;
    }
    {
      const { CONTENT_ORIGINS } = await import('./validation.js');
      const given = validatedMetadata.content_origin;
      if (typeof given === 'string' && CONTENT_ORIGINS.includes(given)) {
        validatedMetadata.content_origin = given;
      } else if (validatedMetadata.assertion_origin === 'imported') {
        validatedMetadata.content_origin = 'external';
      } else if (validatedMetadata.assertion_origin === 'assistant') {
        validatedMetadata.content_origin = 'assistant';
      } else if (validatedMetadata.assertion_origin === 'user' || validatedMetadata.assertion_origin === 'consolidated') {
        validatedMetadata.content_origin = 'self';
      } else {
        validatedMetadata.content_origin = null;
      }
    }

    // E4: the redaction count lives in the stored metadata as well as the
    // receipt, so "which host keeps pasting secrets" is a query, not a memory.
    if (redaction.hits > 0) validatedMetadata.redacted_spans = redaction.hits;

    // B2: emotional intensity - caller, then analyzer, then the fixed baseline.
    let emotionalIntensity;
    let emotionalIntensitySource;
    if (validatedMetadata.emotional_intensity !== undefined) {
      emotionalIntensity = validatedMetadata.emotional_intensity;
      emotionalIntensitySource = 'caller';
    } else if (Number.isFinite(decision.emotional_intensity)) {
      emotionalIntensity = decision.emotional_intensity;
      emotionalIntensitySource = 'analyzer';
    } else {
      emotionalIntensity = 0.5;
      emotionalIntensitySource = 'default';
    }

    // B1: the routing record. A caller-supplied routing object is kept as-is.
    if (!isPlainObject(validatedMetadata.routing)) {
      validatedMetadata.routing = validatedLayer
        ? {
            method: 'explicit',
            layer: targetLayer,
            analyzer_layer: decision.layer,
            confidence: decision.confidence,
            emotional_intensity_source: emotionalIntensitySource
          }
        : {
            method: 'fallback',
            layer: targetLayer,
            keyword_layer: keywordLayer,
            analyzer_layer: decision.layer,
            confidence: decision.confidence,
            signals: Object.keys(decision.signals || {}).slice(0, 8),
            technical_density: decision.technical_density,
            emotional_intensity_source: emotionalIntensitySource
          };
    }

    logger?.debug('Saving memory', {
      requestId,
      layer: targetLayer,
      contentLength: validatedContent.length,
      hasMetadata: Object.keys(validatedMetadata).length > 0
    });

    await dbManager.getConnection(targetLayer);

    const timestamp = Date.now() / 1000;
    // Decided above (A4): the caller's value or the charter midpoint, marked.
    const importance = validatedMetadata.importance;

    const columns = provenanceColumns(provenance);
    // 2026-09-05: the digest is computed BEFORE the write and stored
    // as a column, not only compared in the read-back receipt. Without it the
    // aleph claim held for exactly one instant - verified at write, never again.
    const contentSha256 = digest(validatedContent);
    let prevSha256 = null;
    try {
      const head = await dbManager.collectionFor(targetLayer)
        .find({ sha256: { $exists: true, $nin: [null, ''] } })
        .sort({ id: -1 }).limit(1).toArray();
      prevSha256 = (head[0] && head[0].sha256) || null;
    } catch { prevSha256 = null; }
    const { chainDigest } = await import('./aleph.js');
    const chainSha256 = chainDigest(prevSha256, contentSha256);
    // C1 (2026-09-07): the metadata is attested too, in its own column, over
    // its canonical JSON - computed AFTER every marker above has been added,
    // so the digest covers the metadata as stored, not as received.
    const metadataSha256 = digestMetadata(validatedMetadata);
    const signingKey = setting('SIGNING_KEY') || null;
    const signature = signDigests(contentSha256, metadataSha256, signingKey);
    // The row as a document (stage 1 of the write-path rewrite, 2026-09-27).
    // `event` (a mirror of content) was retired with the SQL read path,
    // 2026-09-28; older rows keep theirs, untouched.
    const row = {
      timestamp,
      content: validatedContent,
      context: validatedMetadata.context || '',
      emotional_intensity: emotionalIntensity,
      importance,
      // 2026-09-05: stored as a real subdocument, not a JSON string.
      // The promoted columns below stay because they are indexed and the vector
      // filter reads them.
      metadata: validatedMetadata,
      // Promoted top-level columns (2026-08-24): what the liveness predicate reads.
      superseded_by: null,
      valid_until: _extractValidUntil(validatedMetadata),
      // is_live stays true when a row is superseded. The end of an entry is
      // superseded_at plus superseded_by (or valid_until when it expires).
      // A false value is a historical mark from before this rule; reads still
      // return that row and say it has ended. Nothing is hidden for age.
      is_live: true,
      // Provenance. Explicit nulls rather than absent fields: "no pointer" and
      // "this field was never part of the schema" must not look the same.
      source_session_id: columns.source_session_id,
      source_exchange_start: columns.source_exchange_start,
      source_exchange_end: columns.source_exchange_end,
      derived_from_ids: columns.derived_from_ids,
      sha256: contentSha256,
      metadata_sha256: metadataSha256,
      signature,
      prev_sha256: prevSha256,
      chain_sha256: chainSha256
    };

    // Option A correction back-pointer (the owner, 2026-10-02, the owner's decision record item 4): a new entry may name the
    // entry it partly corrects. The parent must exist in the same layer, and is checked BEFORE the insert so a
    // refused correction writes nothing.
    if (validatedMetadata.corrects !== undefined && validatedMetadata.corrects !== null) {
      const parent = await dbManager.readMemory(targetLayer, validatedMetadata.corrects);
      if (!parent) {
        throw new ValidationError('corrects', `No entry with id ${validatedMetadata.corrects} in layer '${targetLayer}' - a correction names an entry in its own layer. Nothing was written.`);
      }
    }

    const memoryId = await dbManager.insertMemory(targetLayer, row);

    // aleph: read the entry back and compare before reporting it saved.
    // Until this existed, save_to_layer returned an id the caller had no reason
    // to doubt and no way to check, while the README promised every write was
    // verified. The id is checked by CONTENT rather than existence because the
    // dangerous failure is an id collision - a counter read from the wrong
    // collection restarts at 1 and silently overwrites real entries.
    const stored = await dbManager.readMemory(targetLayer, memoryId);
    const receipt = verifyLayerEntry(stored, { id: memoryId, content: validatedContent, layer: targetLayer, metadata: validatedMetadata });
    const correction = (validatedMetadata.corrects !== undefined && validatedMetadata.corrects !== null)
      ? await markCorrectedBy(dbManager, targetLayer, validatedMetadata.corrects, memoryId)
      : null;
    // the second reader N4: a correction whose parent could not be marked is still saved,
    // but the caller is told in words, not only by a boolean.
    if (correction && correction.marked !== true) {
      warnings.push(`corrects: ${correction.parent_id} - the parent entry was not marked corrected_by (missing in ${targetLayer}, or the mark did not hold); the correction is saved, the link is one-sided until the parent is marked`);
    }

    const durationMs = Date.now() - startTime;

    if (logger && auditOperation) {
      logger.audit(auditOperation.MEMORY_SAVE, {
        requestId,
        layer: targetLayer,
        memoryId,
        contentLength: validatedContent.length,
        importance,
        emotionalIntensity,
        durationMs,
        success: true
      });
    }

    logger?.info('Memory saved successfully', {
      requestId,
      layer: targetLayer,
      memoryId,
      durationMs
    });

    // C3: the receipt is the fixture. One shape on both transports, keys in a
    // fixed order, and it says what happened to the write: every marker the
    // door set is echoed here, and `warnings` is always an array so a clean
    // write and a flagged write have the same shape.
    const md = validatedMetadata;
    return {
      layer: targetLayer,
      id: memoryId,
      timestamp,
      verified: true,
      sha256: receipt.sha256,
      // digest_stored: the read-back saw a sha256 COLUMN on the row and it agreed
      // with the content. false means the row has no column (pre-#12 build) - the
      // receipt above was computed, not read. The receipt is its own witness.
      digest_stored: receipt.digest_stored === true,
      // C1: the metadata digest, attested in its own column and read back.
      metadata_sha256: receipt.metadata_sha256,
      metadata_digest_stored: receipt.metadata_digest_stored === true,
      signed: signatureIntegrityOf(stored, signingKey),
      signature_stored: typeof stored?.signature === 'string' && stored.signature.length > 0,
      // Number of secret spans masked before storage. Zero is the normal case;
      // anything else is worth the caller's attention.
      redacted: redaction.hits,
      provenance: provenance || null,
      ...(provenanceStamped ? { provenance_stamped: 'from the named transcript session; the exchange is the one in progress, stored by the append after this reply' } : {}),
      ...(md.provenance_missing ? { provenance_missing: true } : {}),
      source: md.source,
      ...(md.source_defaulted ? { source_defaulted: true } : {}),
      ...(md.source_unregistered ? { source_unregistered: true } : {}),
      ...(md.source_missing ? { source_missing: true } : {}),
      assertion_origin: md.assertion_origin,
      ...(md.assertion_origin_missing ? { assertion_origin_missing: true } : {}),
      importance,
      ...(md.importance_defaulted ? { importance_defaulted: true } : {}),
      routing: md.routing,
      ...(correction ? { corrects: correction.parent_id, parent_marked: correction.marked } : {}),
      // Present only when the whitelist moved something: an absent key means
      // every field landed where the caller put it.
      ...(relocatedToCustom.length > 0 ? { relocated_to_custom: relocatedToCustom } : {}),
      warnings
    };
  } catch (error) {
    const durationMs = Date.now() - startTime;

    if (logger && auditOperation) {
      logger.audit(auditOperation.MEMORY_SAVE, {
        requestId,
        layer: layer || 'auto',
        contentLength: content ? content.length : 0,
        durationMs,
        success: false,
        errorCode: error.code || 'UNKNOWN',
        errorMessage: error.message
      });
    }

    logger?.error('Failed to save memory', {
      requestId,
      error,
      layer: layer || 'auto',
      durationMs
    });

    // AlephError is an EmetError, so it already propagates unchanged here - which
    // is deliberate. "The store does not contain what it should" must never be
    // flattened into "the save failed", because the two lead to opposite actions.
    if (error instanceof EmetError || error instanceof ValidationError) {
      throw error;
    }

    throw new DatabaseError(
      'Failed to save memory',
      'save_memory',
      { layer: layer || 'auto' }
    );
  }
}

/**
 * Recall memories by keyword.
 */
// valid_until is an end date, not a hide. recall, query_layer and semantic_recall
// return an expired row marked ended, with valid_until as that date. The current
// entry is listed first. Nothing is dropped for age.
/** Pull valid_until out of metadata for promotion to a top-level column. */
function _extractValidUntil(metadata) {
  if (!metadata || typeof metadata !== 'object') return null;
  const vu = (metadata.valid_until !== undefined && metadata.valid_until !== null)
    ? metadata.valid_until
    : (metadata.custom && metadata.custom.valid_until !== undefined ? metadata.custom.valid_until : null);
  const n = Number(vu);
  return (vu === null || vu === undefined || Number.isNaN(n)) ? null : n;
}

function isMemoryExpired(metadata, nowSec = Date.now() / 1000) {
  const md = parseMetadata(metadata);
  const vu = (md.valid_until !== undefined && md.valid_until !== null) ? md.valid_until
           : (md.custom && md.custom.valid_until !== undefined ? md.custom.valid_until : null);
  if (vu === null || vu === undefined) return false;
  const n = Number(vu);
  if (!Number.isFinite(n) || n <= 0) return false;
  const expirySec = n > 1e12 ? n / 1000 : n;  // tolerate milliseconds
  return expirySec < nowSec;
}

// ============================================
// SUPERSESSION
// A revision is a NEW entry that declares what it replaces (metadata.supersedes = <id>);
// the parent entry is marked metadata.superseded_by = <new id>. Nothing is edited or
// deleted - retention plus obsolescence marking (ISO 7.5.3 pattern; write_doc
// versioning is the template).
//
// READ PATHS RETURN SUPERSEDED ENTRIES, MARKED. User's decision 2026-09-13:
// "a parent should still surface to give context to the revision". Retention plus
// obsolescence marking means the superseded record is IDENTIFIED, not hidden -
// hiding it by default meant a revision arrived with no sight of what it revised,
// and an entry that recorded a belief at a time stopped standing as the record of
// it. include_superseded: false does not hide the parent. The current entry is
// listed first; the parent stays, marked with its end date and what replaced it.
// Episodic revision is PROHIBITED - events are immutable.
// ============================================

/** The id of the entry that replaced this one, or null. */
function supersededByOf(memoryOrMetadata) {
  const row = memoryOrMetadata && memoryOrMetadata.metadata !== undefined ? memoryOrMetadata : null;
  const md = parseMetadata(row ? row.metadata : memoryOrMetadata);
  let sb = (md.superseded_by !== undefined && md.superseded_by !== null) ? md.superseded_by
         : (md.custom && md.custom.superseded_by !== undefined && md.custom.superseded_by !== null ? md.custom.superseded_by : null);
  // The promoted top-level column is authoritative where it is present: it is what
  // the store filters on, and a row can carry it without the metadata copy.
  if ((sb === null || sb === undefined) && row && row.superseded_by !== undefined && row.superseded_by !== null) {
    sb = row.superseded_by;
  }
  if (sb === null || sb === undefined) return null;
  const n = Number(sb);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function isMemorySuperseded(metadata) {
  return supersededByOf(metadata) !== null;
}

/**
 * Walk superseded_by from an entry to the live end of its chain.
 * Returns { live, ids } - ids is every id walked, starting with the entry
 * given, ending with the live one. Bounded so a cycle (a broken_supersession
 * gap) terminates instead of spinning; the walk stops at the first id that
 * cannot be read and reports what it reached.
 */
export async function resolveSupersessionChain(read, entry, maxHops = 50) {
  const ids = [entry.id];
  let current = entry;
  for (let hop = 0; hop < maxHops; hop++) {
    const next = supersededByOf(current);
    if (next === null || next === undefined) return { live: current, ids };
    if (ids.includes(Number(next))) return { live: null, ids, cycle: true };
    const row = await read(Number(next));
    if (!row) return { live: null, ids, missing: Number(next) };
    ids.push(row.id);
    current = row;
  }
  return { live: null, ids, truncated: true };
}

/**
 * Option A correction back-pointer (the owner, 2026-10-02, a decision record item 4; the reviewer's sketch in his
 * second read of an episodic record). Episodic entries are immutable events, so a PARTIAL correction cannot
 * supersede its parent: supersession would put an end date on the whole parent and present every item
 * in it as replaced. Instead the new entry carries metadata.corrects = <parent id>, and the parent is MARKED:
 * its corrected_by array gains the new id. The parent's content, digest and is_live are untouched; its
 * metadata is re-attested in the same write (as reviseMemory does for superseded_by), then read back.
 * Sanctioned in tests/write-path.test.js on the same grounds as reviseMemory and retireDoc: a mark on an
 * existing row, never a content write or a removal.
 */
/**
 * The re-attestation $set for a sanctioned metadata mark (supersession, a
 * corrected_by mark): the new metadata digest and, when a signing key is set
 * and the row's existing signature verifies against its metadata before the
 * marks (aleph.js signatureCoversPriorMetadata), a fresh signature over the
 * same content digest and the new metadata digest (2026-10-02, the reviewer's
 * finding: the marks left signed:false behind). With no key, or a signature
 * that does not verify, the signature is left exactly as it is: never re-signed
 * blindly, so a row changed outside the sanctioned path keeps reading
 * signed:false.
 */
export function resignedAttestation(row, newMetadata) {
  const metadataSha256 = digestMetadata(newMetadata);
  const set = { metadata_sha256: metadataSha256 };
  const key = setting('SIGNING_KEY') || null;
  if (key && signatureCoversPriorMetadata(row, key)) set.signature = signDigests(row.sha256, metadataSha256, key);
  return set;
}

export async function markCorrectedBy(dbManager, layer, parentId, childId) {
  await dbManager.getConnection(layer);
  const col = dbManager.collectionFor(layer);
  const parent = await col.findOne({ id: parentId });
  if (!parent) return { parent_id: parentId, marked: false };
  const cid = Number(childId);
  // Race-safe (the second reader N3 / the reviewer, 2026-10-02): the id is ADDED atomically
  // ($addToSet on the column and on the metadata copy), never written back
  // from a stale read, so two simultaneous corrections of one parent both
  // land. A legacy string-metadata row falls back to read-modify-write.
  if (parent.metadata && typeof parent.metadata === 'object') {
    await col.updateOne({ id: parentId }, { $addToSet: { corrected_by: cid, 'metadata.corrected_by': cid } });
  } else {
    const md = parseMetadata(parent.metadata);
    const list = Array.isArray(md.corrected_by) ? md.corrected_by.map(Number) : [];
    if (!list.includes(cid)) list.push(cid);
    md.corrected_by = list;
    await col.updateOne({ id: parentId }, { $set: { metadata: md, corrected_by: list } });
  }
  // Re-attest from what is actually stored. The digest is set only if the
  // stored metadata is still exactly the metadata it was computed from: the
  // compare-and-set filter is the WHOLE metadata value, not only corrected_by
  // (the reviewer, 2026-10-02), so a concurrent change to any metadata field in
  // between (another mark, a superseded_by, anything) makes the filter miss,
  // and the loop re-reads and re-digests. The last re-attest therefore always
  // covers what is stored. The value compared is the one just read back, so
  // MongoDB's order-sensitive embedded-document equality matches it as stored.
  let back = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    back = await col.findOne({ id: parentId });
    if (!back) break;
    const md = parseMetadata(back.metadata);
    const filter = { id: parentId, metadata: back.metadata };
    const res = await col.updateOne(filter, { $set: resignedAttestation(back, md) });
    if (res && res.matchedCount === 0) continue;
    back = await col.findOne({ id: parentId });
    break;
  }
  const backMd = back ? parseMetadata(back.metadata) : {};
  const marked = !!(back && Array.isArray(backMd.corrected_by) && backMd.corrected_by.map(Number).includes(cid)
    && metadataIntegrityOf(back) === true && back.content === parent.content);
  return { parent_id: parentId, marked };
}

const correctedByOf = (row) => {
  const md = parseMetadata(row && row.metadata) || {};
  const v = Array.isArray(row && row.corrected_by) ? row.corrected_by : md.corrected_by;
  return Array.isArray(v) && v.length ? v.map(Number) : [];
};

export async function reviseMemory(dbManager, layer, target_id, content, metadata = {}, logger = null) {
  try {
    const validatedLayer = validateLayer(layer, true);
    // Which layers may be revised is the charter's call (layers.js), not a
    // string comparison here. Today only episodic says false.
    if (policyFor(validatedLayer).revisable === false) {
      throw new ValidationError('layer', 'Episodic revision is prohibited - events are immutable history. Save a new episodic entry instead.');
    }
    const targetId = Number(target_id);
    if (!Number.isFinite(targetId) || !Number.isInteger(targetId) || targetId <= 0) {
      throw new ValidationError('target_id', 'target_id must be a positive integer');
    }
    const validatedContent = validateContent(content);
    // A7: metadata is validated exactly ONCE, inside saveMemory, with
    // `supersedes` already present as a first-class field. Validating here and
    // again there is what used to relocate it under custom on the second pass.
    if (metadata !== null && metadata !== undefined && !isPlainObject(metadata)) {
      throw new ValidationError('metadata', 'Metadata must be an object', typeof metadata);
    }
    // 2026-09-29 (a decision record): a revision with no source of its own cites
    // the entry it revises, so revising a semantic or procedural entry is never
    // refused for want of a pointer. A caller-supplied derived_from wins.
    const revisionMetadata = {
      ...(metadata || {}),
      supersedes: targetId,
      ...((metadata && metadata.derived_from) ? {} : { derived_from: { entries: [targetId] } })
    };

    await dbManager.getConnection(validatedLayer);
    const col = dbManager.collectionFor(validatedLayer);

    const target = await col.findOne({ id: targetId });
    if (!target) {
      throw new ValidationError('target_id', `No entry with id ${targetId} in layer '${validatedLayer}'`);
    }
    const targetMd = parseMetadata(target.metadata);
    if (isMemorySuperseded(targetMd)) {
      throw new ValidationError('target_id', `Entry ${targetId} is already superseded by ${targetMd.superseded_by} - revise the CURRENT entry, not the archived one`);
    }

    const saved = await saveMemory(dbManager, validatedContent, validatedLayer, revisionMetadata, logger, null);

    targetMd.superseded_by = saved.id;
    targetMd.superseded_at = saved.timestamp;
    // Write BOTH the metadata copy and the promoted top-level column. The
    // top-level one is what a reader follows (indexed); the metadata copy
    // stays for audit. Always written as a subdocument - a parent still
    // carrying the legacy string shape is converted by this touch.
    // is_live is left as it was. Supersession is the end date and the link
    // to the new entry, not a flag that hides the old one.
    await col.updateOne({ id: targetId }, { $set: {
      metadata: targetMd,
      superseded_by: saved.id,
      superseded_at: saved.timestamp,
      // C1: marking a parent is the ONE sanctioned mutation of stored metadata,
      // so the parent is re-attested in the same write. Without this every
      // superseded row would read as a metadata mismatch from then on. With a
      // signing key, a parent whose signature verified before the mark is
      // re-signed in the same write (resignedAttestation), so it does not read
      // signed:false; the check runs on the row as read, before targetMd's marks.
      ...resignedAttestation(target, targetMd)
    } });

    // Read-back verification, both sides (verification over performance)
    const newDoc = await col.findOne({ id: saved.id });
    const parentDoc = await col.findOne({ id: targetId });
    const parentMd = parentDoc ? parseMetadata(parentDoc.metadata) : null;
    const topLevelOk = !!(parentDoc
      && Number(parentDoc.superseded_by) === Number(saved.id)
      && parentDoc.superseded_at === saved.timestamp
      && parentDoc.is_live !== false);
    // C1: the parent's re-attestation must read back true, or the revision is
    // reported unverified - a parent that fails its own metadata digest after
    // being marked is exactly the inconsistency the column exists to expose.
    const parentMetaOk = metadataIntegrityOf(parentDoc) === true;
    const verified = !!(newDoc && parentMd && Number(parentMd.superseded_by) === Number(saved.id) && topLevelOk && parentMetaOk);

    logger?.info('Memory revised via supersession', { layer: validatedLayer, supersedes: targetId, newId: saved.id, verified });
    // C3: the same receipt saveMemory produced, plus what supersession added.
    // `verified` here covers both sides (child stored, parent marked).
    return {
      ...saved,
      verified,
      supersedes: targetId,
      parent_marked_superseded: verified
    };
  } catch (error) {
    if (error instanceof ValidationError || error instanceof EmetError) throw error;
    throw new DatabaseError(`Failed to revise memory: ${error.message}`, 'revise_memory');
  }
}

/**
 * How many rows a recall or layer query keeps after the store has ranked them.
 * The store sorts by the same keys as the page (current before ended, then
 * keyword hits and importance, or time when the query asks for the latest),
 * and only then applies this bound. Same floor semantic recall uses for its
 * candidate set: 20 times the page, and at least 200.
 */
export const RECALL_CANDIDATE_FLOOR = 200;
export const RECALL_CANDIDATE_FACTOR = 20;
export function candidateBound(limit) {
  const page = Number(limit);
  const n = Number.isFinite(page) && page > 0 ? page : 10;
  return Math.max(n * RECALL_CANDIDATE_FACTOR, RECALL_CANDIDATE_FLOOR);
}

function queryTokens(query) {
  return String(query ?? '').trim().split(/\s+/).filter((k) => k.length > 0).slice(0, 20);
}

/** Whole-token latest / newest / most recent. latest-budget is one token, so it is not this. */
function latestPhraseSpan(parts) {
  for (let i = 0; i < parts.length; i++) {
    if (/^(latest|newest)$/i.test(parts[i])) return [i, i + 1];
    if (/^most$/i.test(parts[i]) && /^recent$/i.test(parts[i + 1] || '')) return [i, i + 2];
  }
  return null;
}

/** "not latest" and "not the latest" (and the newest / most recent forms). */
function phraseIsNegated(parts, start) {
  const prev = parts[start - 1];
  const before = parts[start - 2];
  if (prev && /^not$/i.test(prev)) return true;
  if (prev && /^the$/i.test(prev) && before && /^not$/i.test(before)) return true;
  return false;
}

/**
 * Natural-language time order. A standalone latest, newest, or most recent
 * reorders rows that already match the other words. It does not match inside
 * a hyphenated token, and "not the latest" does not ask for time order.
 * With no other words left, the word stays an ordinary keyword and this is false.
 * Pass order: 'latest' when time order should not depend on the wording.
 */
export function queryAsksForLatest(query) {
  const parts = queryTokens(query);
  const span = latestPhraseSpan(parts);
  if (!span || phraseIsNegated(parts, span[0])) return false;
  const rest = parts.filter((_, i) => i < span[0] || i >= span[1]);
  return rest.length > 0;
}

/** Words the match set is built from. A latest phrase is removed only when other words remain. */
export function recallKeywords(query) {
  const parts = queryTokens(query);
  const span = latestPhraseSpan(parts);
  if (!span || phraseIsNegated(parts, span[0])) return parts;
  const rest = parts.filter((_, i) => i < span[0] || i >= span[1]);
  return rest.length > 0 ? rest : parts;
}

function wantsTimeOrder(query, options) {
  return !!(options && options.order === 'latest') || queryAsksForLatest(query);
}

/** How many of the keywords appear in content or context. One count per keyword.
 * Used only when the store did not already compute `_hits`. The store path
 * keeps that count: JavaScript `RegExp` `i` does not fold ẞ and ß. */
export function keywordHitCount(memory, keywords) {
  const content = memory && memory.content ? String(memory.content) : '';
  const context = memory && memory.context ? String(memory.context) : '';
  let n = 0;
  for (const k of keywords) {
    const spec = containsRegex(k);
    const re = new RegExp(spec.$regex, spec.$options);
    if (re.test(content) || re.test(context)) n += 1;
  }
  return n;
}

function finiteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * End date and replacement, for a row that is still returned.
 * ended is true when a later entry replaced it, valid_until has passed,
 * or an older write set is_live false. The row is not dropped.
 */
function columnExpiry(value) {
  const n = Number(value);
  if (value == null || !Number.isFinite(n) || n <= 0) return { validUntil: null, expired: false };
  const expirySec = n > 1e12 ? n / 1000 : n;
  return { validUntil: n, expired: expirySec < Date.now() / 1000 };
}

export function endMarks(memory) {
  const md = parseMetadata(memory && memory.metadata) || {};
  const supersededBy = supersededByOf(memory);
  const supersededAt = finiteNumber(memory && memory.superseded_at != null ? memory.superseded_at : md.superseded_at);
  const fromMetadata = _extractValidUntil(md);
  const stamped = fromMetadata != null
    ? { validUntil: fromMetadata, expired: isMemoryExpired(md) }
    : columnExpiry(memory && memory.valid_until);
  const validUntil = stamped.validUntil;
  const expired = stamped.expired;
  const historicalHide = !!(memory && memory.is_live === false);
  const ended = supersededBy !== null || expired || historicalHide;
  let end_date = null;
  if (supersededBy !== null) end_date = supersededAt;
  else if (expired) end_date = validUntil;
  return {
    superseded_by: supersededBy,
    superseded_at: supersededBy !== null ? supersededAt : null,
    is_superseded: supersededBy !== null,
    valid_until: validUntil,
    is_expired: expired,
    ended,
    end_date,
    replaced_by: supersededBy
  };
}

function importanceRank(row) {
  const n = Number(row && row.importance);
  return Number.isFinite(n) ? n : 0;
}

/** Store `_ended` when the row came from the rank pipeline. Otherwise the marked flag. */
function endedRank(row) {
  if (row && row._endedRank != null) return row._endedRank;
  return row && row.ended ? 1 : 0;
}

/** Current entries first, then more keyword hits, then higher importance. Id breaks ties. Not time. */
export function compareByRelevance(a, b) {
  const ae = endedRank(a);
  const be = endedRank(b);
  if (ae !== be) return ae - be;
  const ah = a && a.hits ? a.hits : 0;
  const bh = b && b.hits ? b.hits : 0;
  if (ah !== bh) return bh - ah;
  const ai = importanceRank(a);
  const bi = importanceRank(b);
  if (ai !== bi) return bi - ai;
  return (Number(a && a.id) || 0) - (Number(b && b.id) || 0);
}

/** Current entries first, then newest timestamp. Used only for an explicit latest request. */
export function compareByRecency(a, b) {
  const ae = endedRank(a);
  const be = endedRank(b);
  if (ae !== be) return ae - be;
  const at = Number(a && a.timestamp) || 0;
  const bt = Number(b && b.timestamp) || 0;
  if (at !== bt) return bt - at;
  return (Number(a && a.id) || 0) - (Number(b && b.id) || 0);
}

/**
 * Default: the ranked list, cut at `limit` (current entries already sit first).
 * history: true returns ended rows only, up to the same limit, so a full page
 * of current matches cannot make the ended ones unreachable.
 */
export function applyReadLimit(rows, limit, history) {
  const cap = Number(limit);
  const n = Number.isFinite(cap) && cap > 0 ? cap : rows.length;
  const pool = history === true ? rows.filter((r) => endedRank(r) === 1) : rows;
  return pool.slice(0, n);
}

function recalledRow(memory, layer, extra = {}) {
  return {
    ...(layer ? { layer } : {}),
    id: memory.id,
    timestamp: memory.timestamp,
    content: memory.content,
    context: memory.context,
    importance: memory.importance,
    emotional_intensity: memory.emotional_intensity,
    metadata: parseMetadata(memory.metadata),
    ...endMarks(memory),
    corrected_by: correctedByOf(memory),
    integrity: integrityOf(memory),
    metadata_integrity: metadataIntegrityOf(memory),
    signed: signatureIntegrityOf(memory, setting('SIGNING_KEY') || null),
    ...extra
  };
}

/** Layer query order. Current entries come first in every order, including timestamp. */
export function compareQueryRows(a, b, orderBy) {
  const spec = sortFor(orderBy);
  const column = Object.keys(spec)[0];
  const dir = spec[column];
  const ae = endedRank(a);
  const be = endedRank(b);
  if (ae !== be) return ae - be;
  const av = a ? a[column] : undefined;
  const bv = b ? b[column] : undefined;
  if (av !== bv) {
    const aNull = av == null;
    const bNull = bv == null;
    if (aNull || bNull) {
      if (!(aNull && bNull)) {
        const nullsLow = aNull ? -1 : 1;
        return dir === 1 ? nullsLow : -nullsLow;
      }
    } else if (av > bv) return dir === 1 ? 1 : -1;
    else return dir === 1 ? -1 : 1;
  }
  return (Number(a && a.id) || 0) - (Number(b && b.id) || 0);
}

export function collectSemanticHits(docs, layer) {
  const out = [];
  for (const d of docs || []) out.push(recalledRow(d, layer, { score: d.score }));
  return out;
}

/** Vector score is the relevance. Importance breaks a score tie. Time only if the query asks. */
export function rankSemanticHits(rows, query) {
  if (queryAsksForLatest(query)) return [...rows].sort(compareByRecency);
  return [...rows].sort((a, b) => {
    const ae = a && a.ended ? 1 : 0;
    const be = b && b.ended ? 1 : 0;
    if (ae !== be) return ae - be;
    const as = Number(a && a.score) || 0;
    const bs = Number(b && b.score) || 0;
    if (as !== bs) return bs - as;
    const ai = importanceRank(a);
    const bi = importanceRank(b);
    if (ai !== bi) return bi - ai;
    return (Number(a && a.id) || 0) - (Number(b && b.id) || 0);
  });
}

export async function recallMemories(dbManager, query, layer = null, limit = 10, logger = null, auditOperation = null, options = null) {
  const startTime = Date.now();
  const requestId = logger?._generateRequestId?.() || `req-${Date.now()}`;

  try {
    if (query === null || query === undefined || (typeof query === 'string' && query.trim() === '')) {
      throw new ValidationError('query', 'Query is required');
    }
    if (typeof query !== 'string') {
      throw new ValidationError('query', 'Query must be a string');
    }
    if (query.length > CONTENT_LIMITS.MAX_QUERY_LENGTH) {
      throw new ValidationError('query', `Query exceeds maximum length of ${CONTENT_LIMITS.MAX_QUERY_LENGTH} characters`);
    }
    const validatedQuery = query.trim();
    const validatedLayer = layer ? validateLayer(layer) : null;
    const validatedLimit = validateLimit(limit);
    if (options && options.order != null && options.order !== 'latest') {
      throw new ValidationError('order', "order must be 'latest' when it is set");
    }

    logger?.debug('Recalling memories', {
      requestId,
      queryLength: validatedQuery.length,
      layer: validatedLayer || 'all',
      limit: validatedLimit
    });

    const layers = validatedLayer ? [validatedLayer] : Object.keys(MEMORY_LAYERS);
    const results = [];

    // order: 'latest' is the explicit time order. A standalone latest phrase
    // only reorders rows that match the other words. It never widens the match
    // set, and a bare "latest" stays a keyword.
    const asksForLatest = wantsTimeOrder(validatedQuery, options);
    const keywords = recallKeywords(validatedQuery);
    const keywordFilter = keywords.length === 0
      ? null
      : { $or: keywords.flatMap((k) => [{ content: containsRegex(k) }, { context: containsRegex(k) }]) };
    // Rank in the store, then limit. A column sort before the limit would
    // drop a better keyword match, or a current row behind newer ended ones.
    const bound = candidateBound(validatedLimit);
    const history = !!(options && options.history === true);

    for (const currentLayer of layers) {
      await dbManager.getConnection(currentLayer);

      const memories = keywordFilter === null ? [] : await dbManager.aggregateMemories(
        currentLayer,
        buildRankPipeline({
          filter: keywordFilter,
          keywords,
          latest: asksForLatest,
          bound,
          history,
          kind: 'recall'
        })
      );

      for (const memory of memories) {
        // The pipeline's _hits is the count the window was ranked with.
        // A JavaScript recount folds a different set of letters and can drop
        // every row the store kept. keywordHitCount is only for a row that
        // did not come from that pipeline.
        const fromStore = memory._hits != null;
        const hits = fromStore
          ? (Number(memory._hits) || 0)
          : (keywords.length === 0 ? 0 : keywordHitCount(memory, keywords));
        if (!fromStore && keywords.length > 0 && hits === 0) continue;
        const row = recalledRow(memory, currentLayer);
        row.hits = hits;
        if (memory._ended != null) row._endedRank = Number(memory._ended) === 1 ? 1 : 0;
        results.push(row);
      }
    }

    results.sort(asksForLatest ? compareByRecency : compareByRelevance);
    const finalResults = applyReadLimit(results, validatedLimit, options && options.history === true);
    for (const row of finalResults) {
      delete row.hits;
      delete row._endedRank;
    }
    const durationMs = Date.now() - startTime;

    if (logger && auditOperation) {
      logger.audit(auditOperation.MEMORY_RECALL, {
        requestId,
        queryLength: validatedQuery.length,
        layer: validatedLayer || 'all',
        layersSearched: layers.length,
        limit: validatedLimit,
        resultsFound: finalResults.length,
        durationMs,
        success: true
      });
    }

    logger?.info('Memories recalled successfully', {
      requestId,
      resultsFound: finalResults.length,
      durationMs
    });

    return finalResults;
  } catch (error) {
    const durationMs = Date.now() - startTime;

    if (logger && auditOperation) {
      logger.audit(auditOperation.MEMORY_RECALL, {
        requestId,
        queryLength: query ? query.length : 0,
        layer: layer || 'all',
        durationMs,
        success: false,
        errorCode: error.code || 'UNKNOWN',
        errorMessage: error.message
      });
    }

    logger?.error('Failed to recall memories', {
      requestId,
      error,
      layer: layer || 'all',
      durationMs
    });

    if (error instanceof EmetError || error instanceof ValidationError) {
      throw error;
    }

    throw new DatabaseError(
      'Failed to recall memories',
      'recall_memories',
      { layer: layer || 'all' }
    );
  }
}

/**
 * Query specific layer
 */
export async function queryLayer(dbManager, layer, options = {}, logger = null, auditOperation = null) {
  const startTime = Date.now();
  const requestId = logger?._generateRequestId?.() || `req-${Date.now()}`;

  try {
    const validatedLayer = validateLayer(layer, true);
    const validatedOptions = validateQueryOptions(options);
    // Superseded and expired rows are returned, marked. include_superseded: false
    // does not hide them. Current entries are ordered first in every order,
    // including timestamp. history: true returns the ended rows on their own.

    logger?.debug('Querying layer', {
      requestId,
      layer: validatedLayer,
      hasFilters: !!validatedOptions.filters,
      limit: validatedOptions.limit
    });

    await dbManager.getConnection(validatedLayer);
    const limit = validatedOptions.limit;
    let filter = {};

    if (validatedOptions._deprecated_where_used) {
      logger?.warn('Deprecated WHERE clause usage', {
        requestId,
        message: 'Arbitrary WHERE clauses are deprecated for security. Use structured filters instead.'
      });
    }

    // An unrecognised filter key is dropped by the whitelist in validateFilters,
    // leaving the query unfiltered - which reads to the caller as a broken
    // filter rather than a rejected argument. Say so instead of swallowing it.
    if (validatedOptions._unknown_filter_keys) {
      logger?.warn('Unrecognised filter keys ignored', {
        requestId,
        layer: validatedLayer,
        ignored: validatedOptions._unknown_filter_keys,
        recognised: RECOGNISED_FILTER_KEYS,
        message: 'These filter keys are not recognised and were ignored; the query did not filter on them.'
      });
    }

    filter = buildMemoryFilter(validatedOptions.filters);

    if (!validatedOptions.filters && validatedOptions.params && Array.isArray(validatedOptions.params) && validatedOptions.params.length > 0) {
      const searchTerm = validatedOptions.params[0];
      if (typeof searchTerm === 'string') {
        if (searchTerm.length > CONTENT_LIMITS.MAX_QUERY_LENGTH) {
          throw new ValidationError('params[0]', `Search term exceeds maximum length of ${CONTENT_LIMITS.MAX_QUERY_LENGTH}`);
        }
        filter = { $or: [{ content: containsRegex(searchTerm) }, { context: containsRegex(searchTerm) }] };
      }
    }


    // Rank in the store with the same keys as the page, then limit. Ended rows
    // stay in the window; they are not dropped for being expired.
    const memories = await dbManager.aggregateMemories(validatedLayer, buildRankPipeline({
      filter,
      orderBy: validatedOptions.order_by,
      bound: candidateBound(limit),
      history: !!(options && options.history === true),
      kind: 'query'
    }));

    // CHAIN RESOLUTION (2026-09-15, the consolidated revision). A lookup BY ID
    // that lands on a superseded entry also returns the live end of its chain,
    // marked, so a cross-reference written against any id in the chain keeps
    // resolving after every later revision. Before this, every revise_memory
    // minted a new id and a hand-kept name->id index had to be revised in the
    // same pass; the index was the reminder standing in for the control.
    const requestedId = validatedOptions.filters && validatedOptions.filters.id !== undefined ? Number(validatedOptions.filters.id) : null;
    if (requestedId !== null && memories.length === 1 && supersededByOf(memories[0]) !== null) {
      const chain = await resolveSupersessionChain((id) => dbManager.readMemory(validatedLayer, id), memories[0]);
      if (chain.live && !memories.some(m => m.id === chain.live.id)) {
        chain.live._resolved_via = { requested_id: requestedId, chain: chain.ids };
        memories.unshift(chain.live);
      }
    }

    const results = memories.map(m => {
      const row = recalledRow(m, null, {
        sha256: m.sha256 || null,
        prev_sha256: m.prev_sha256 || null,
        chain_sha256: m.chain_sha256 || null,
        chain: chainIntegrityOf(m),
        // Present only on the live entry a chain lookup resolved to: which id was
        // asked for and every id walked to get here, oldest first.
        ...(m._resolved_via ? { resolved_via: m._resolved_via } : {})
      });
      if (m._ended != null) row._endedRank = Number(m._ended) === 1 ? 1 : 0;
      return row;
    });
    results.sort((a, b) => compareQueryRows(a, b, validatedOptions.order_by));
    const via = results.findIndex((row) => row.resolved_via);
    if (via > 0) {
      const [resolved] = results.splice(via, 1);
      results.unshift(resolved);
    }
    const ranked = applyReadLimit(results, limit, options && options.history === true);
    for (const row of ranked) delete row._endedRank;
    // Keep the name `results` for the audit log and the warning attach below.
    results.length = 0;
    results.push(...ranked);

    const durationMs = Date.now() - startTime;

    if (logger && auditOperation) {
      logger.audit(auditOperation.MEMORY_QUERY, {
        requestId,
        layer: validatedLayer,
        filterCount: validatedOptions.filters ? Object.keys(validatedOptions.filters).length : 0,
        limit,
        orderBy: validatedOptions.order_by || 'importance DESC',
        resultsFound: results.length,
        durationMs,
        success: true
      });
    }

    logger?.info('Layer query completed', {
      requestId,
      layer: validatedLayer,
      resultsFound: results.length,
      durationMs
    });

    // The caller cannot read a server-side log line, and on the HTTP transport
    // there is not even one to read - that transport's logger discards warn().
    // So the ignored keys ride back in the response envelope, where the person
    // who wrote the bad filter will actually see them. This is the surface that
    // would have caught the 2026-09-08 phantom defect as it happened.
    if (validatedOptions._unknown_filter_keys) {
      attachWarnings(results, [
        `Ignored unrecognised filter key(s): ${validatedOptions._unknown_filter_keys.join(', ')}. `
        + `The query did NOT filter on them. `
        + `Recognised filter keys: ${RECOGNISED_FILTER_KEYS.join(', ')}.`
      ]);
    }

    return results;
  } catch (error) {
    const durationMs = Date.now() - startTime;

    if (logger && auditOperation) {
      logger.audit(auditOperation.MEMORY_QUERY, {
        requestId,
        layer: layer || 'unknown',
        durationMs,
        success: false,
        errorCode: error.code || 'UNKNOWN',
        errorMessage: error.message
      });
    }

    logger?.error('Failed to query layer', {
      requestId,
      error,
      layer: layer || 'unknown',
      durationMs
    });

    if (error instanceof EmetError || error instanceof ValidationError) {
      throw error;
    }

    throw new DatabaseError(
      'Failed to query layer',
      'query_layer',
      { layer: layer || 'unknown' }
    );
  }
}

/**
 * Get server status.
 */
export async function getStatus(dbManager, logger = null) {
  try {
    const status = {
      database: `mongodb:${MONGODB_DB}`,
      storage_backend: 'mongodb',
      system: 'EMET',
      version: EMET_VERSION,
      layers: {},
      total_memories: 0,
      health: 'healthy'
    };

    for (const layer of Object.keys(MEMORY_LAYERS)) {
      try {
        await dbManager.getConnection(layer);
        const count = (await dbManager.countMemories(layer)) || 0;

        status.layers[layer] = {
          status: 'connected',
          count,
          path: `mongodb:${MONGODB_DB}.${COLLECTION_PREFIX}${layer}`
        };
        status.total_memories += count;
      } catch (error) {
        status.layers[layer] = { status: 'error', error: error.message };
        status.health = 'degraded';
      }
    }

    logger?.info(`EMET status: ${status.total_memories} total memories, health: ${status.health}`);

    return status;
  } catch (error) {
    logger?.error('Error getting system status:', { error });

    if (error instanceof EmetError || error instanceof ValidationError) {
      throw error;
    }

    throw new DatabaseError(
      'Failed to get system status',
      'emet_status'
    );
  }
}

/**
 * Query session transcripts - the live tier-2 store AND the legacy archive.
 *
 * Two collections hold word-for-word dialog. `transcripts` is the live store
 * written by save_transcript (one document per session). `exchanges` is an
 * archive that stopped receiving writes around June 2026 (one document per
 * exchange, imported from earlier hosts). Until 2026-09 the archive had its own
 * reader, query_exchanges; folding it in here means one reader for tier 2 and
 * lets the five overlapping tools go (the user's decision, 2026-09-14).
 *
 * Nothing is migrated. Archive rows are grouped by session_id into the same
 * session shape the live store returns, every result carries `source` naming
 * the collection it came from, and the two sets are merged in session_start
 * order. A session_id filter applies to both.
 */
export async function queryTranscripts(timestamp_start, timestamp_end, session_id = null, limit = 50, logger = null) {
  const startTime = Date.now();
  try {
    if (typeof timestamp_start !== 'number' || typeof timestamp_end !== 'number')
      throw new ValidationError('timestamp_start and timestamp_end must be numbers (Unix timestamps)');
    if (timestamp_start >= timestamp_end)
      throw new ValidationError('timestamp_start must be less than timestamp_end');
    // Security audit 2026-09-29: session_id reached the query unchecked, so an
    // object such as {"$ne": null} was an operator, not an id. Every other
    // doc_id / session_id door already refused a non-string.
    if (session_id !== null && session_id !== undefined && typeof session_id !== 'string')
      throw new ValidationError('session_id', 'must be a string');
    const effectiveLimit = Math.min(Math.max(1, limit || 50), 500);
    const client = await connectMongo(MONGODB_URI, { serverSelectionTimeoutMS: 5000, maxPoolSize: 10 });
    const db = client.db(MONGODB_DB);
    const windowStart = new Date(timestamp_start * 1000);
    const windowEnd = new Date(timestamp_end * 1000);

    // Live store: one document per session, filtered by session_start.
    const liveQuery = { _type: { $ne: 'architecture_note' }, session_start: { $gte: windowStart, $lte: windowEnd } };
    if (session_id) liveQuery.session_id = session_id;
    const live = await db.collection('transcripts').find(liveQuery).sort({ session_start: 1 }).limit(effectiveLimit).toArray();
    for (const row of live) row.source = 'transcripts';

    // Archive: one document per exchange. A session is in the window if any of
    // its exchanges is (rows carry session_start, but the CLI-era rows have a
    // session_start a month before their timestamps, so the row time is the
    // honest key). Every row of a matched session is returned, so a session is
    // never returned with a hole in it.
    const archived = await archivedSessions(db, windowStart, windowEnd, session_id, effectiveLimit);

    await client.close();
    const merged = [...live, ...archived]
      .sort((a, b) => new Date(a.session_start) - new Date(b.session_start))
      .slice(0, effectiveLimit);
    const duration = Date.now() - startTime;
    return {
      count: merged.length,
      sessions: merged,
      sources: { transcripts: live.length, exchanges: archived.length },
      query: { timestamp_start, timestamp_end, session_id: session_id || 'all', limit: effectiveLimit },
      performance: { duration_ms: duration }
    };
  } catch (error) {
    if (error instanceof ValidationError || error instanceof EmetError) throw error;
    throw new DatabaseError(`Failed to query transcripts: ${error.message}`, 'query_transcripts');
  }
}

/**
 * Group archive exchanges into sessions. Exported for its test; not a tool.
 * Pure over its inputs apart from the two reads, so the grouping can be tested
 * against rows without a database - see groupArchivedExchanges.
 */
async function archivedSessions(db, windowStart, windowEnd, session_id, limit) {
  const col = db.collection('exchanges');
  const rowFilter = { timestamp: { $gte: windowStart, $lte: windowEnd } };
  if (session_id) rowFilter.session_id = session_id;
  const ids = await col.distinct('session_id', rowFilter);
  if (ids.length === 0) return [];
  const rows = await col.find({ session_id: { $in: ids } }).sort({ session_id: 1, exchange_index: 1, timestamp: 1 }).toArray();
  return groupArchivedExchanges(rows).slice(0, limit);
}

/**
 * The archive's rows, grouped by session_id into the live store's session
 * shape. Exchange indices are kept as stored (the archive counts from 0; the
 * live store from 1) - renumbering would be a rewrite of the record.
 */
export function groupArchivedExchanges(rows) {
  const bySession = new Map();
  for (const r of rows) {
    const key = r.session_id || `unkeyed_${r.conversation_uuid || r.channel || 'archive'}`;
    let s = bySession.get(key);
    if (!s) {
      s = {
        session_id: key,
        source: 'exchanges',
        channel: r.channel || null,
        conversation_name: r.conversation_name || null,
        conversation_uuid: r.conversation_uuid || null,
        session_start: r.session_start || r.timestamp,
        session_end: r.timestamp,
        exchange_count: 0,
        exchanges: []
      };
      bySession.set(key, s);
    }
    if (r.session_start && new Date(r.session_start) < new Date(s.session_start)) s.session_start = r.session_start;
    if (r.timestamp && new Date(r.timestamp) > new Date(s.session_end)) s.session_end = r.timestamp;
    s.exchanges.push({
      exchange_index: r.exchange_index,
      user_message: r.user_message,
      assistant_message: r.assistant_message,
      timestamp: r.timestamp
    });
    s.exchange_count = s.exchanges.length;
  }
  const out = [...bySession.values()];
  for (const s of out) s.exchanges.sort((a, b) => (a.exchange_index ?? 0) - (b.exchange_index ?? 0));
  return out.sort((a, b) => new Date(a.session_start) - new Date(b.session_start));
}

/** One message field, and the whole transcript request. */
export const EXCHANGE_FIELD_MAX = 32000;
export const EXCHANGE_REQUEST_MAX = 256000;

export function assertExchangeBudget(parts) {
  let total = 0;
  for (const part of parts) {
    const text = String(part ?? '');
    if (text.length > EXCHANGE_FIELD_MAX) {
      throw new ValidationError(`an exchange field exceeds ${EXCHANGE_FIELD_MAX} characters. Nothing was written.`);
    }
    total += text.length;
  }
  if (total > EXCHANGE_REQUEST_MAX) {
    throw new ValidationError(`this transcript request exceeds ${EXCHANGE_REQUEST_MAX} characters. Nothing was written.`);
  }
}

/**
 * Save a full session transcript to the transcripts collection.
 * Hardcoded rule: full word-for-word dialog only - no summaries.
 * The caller passes exchanges. The server does not read a file path.
 * Every host writes here, so continuity is shared.
 */
export async function saveTranscript(session_id, session_start, session_end, exchanges = null, channel = null, logger = null) {
  const startTime = Date.now();
  const requestId = logger?._generateRequestId?.() || `req-${Date.now()}`;

  try {
    if (!session_id || typeof session_id !== 'string') {
      throw new ValidationError('session_id must be a non-empty string');
    }
    if (typeof session_start !== 'number') {
      throw new ValidationError('session_start must be a Unix timestamp (number)');
    }

    const resolvedChannel = channel || 'claude_project';
    if (!Array.isArray(exchanges) || exchanges.length === 0) {
      throw new ValidationError('exchanges must be a non-empty array');
    }
    assertExchangeBudget(exchanges.flatMap((ex) => [ex && ex.user_message, ex && ex.assistant_message]));
    const resolvedExchanges = exchanges;

    const client = await connectMongo(MONGODB_URI, { serverSelectionTimeoutMS: 5000, maxPoolSize: 10 });
    const db = client.db(MONGODB_DB);
    const col = db.collection('transcripts');
    try { await col.createIndex({ 'exchanges.client_id': 1 }, { sparse: true }); } catch { /* an index miss never blocks the write */ }

    const existingCount = await col.countDocuments();
    if (existingCount === 0) {
      await col.insertOne({
        _type: 'architecture_note',
        created_at: new Date(),
        note: 'Full session dialog, stored verbatim. Search by timestamp window.'
      });
    }

    // Verbatim means every word the user said, not every secret they
    // pasted. A masked span is visible in the record as '*****'; the rest of
    // the exchange is untouched. This is the one edit the verbatim rule allows.
    let redactedSpans = 0;
    const scrub = (s) => { const r = redactWithReport(s || ''); redactedSpans += r.hits; return r.text; };

    const sessionDoc = {
      session_id,
      channel: resolvedChannel,
      session_start: new Date(session_start * 1000),
      session_end: session_end ? new Date(session_end * 1000) : new Date(),
      exchange_count: resolvedExchanges.length,
      exchanges: resolvedExchanges.map((ex, i) => stampExchange(storedExchange(ex, i, scrub), resolvedChannel)),
      created_at: new Date()
    };
    if (redactedSpans > 0) sessionDoc.redacted_spans = redactedSpans;
    const timestampsDefaulted = sessionDoc.exchanges.filter(e => e.timestamp_defaulted).length;

    const result = await col.insertOne(sessionDoc);
    await client.close();

    const duration = Date.now() - startTime;
    return {
      success: true,
      session_id,
      channel: resolvedChannel,
      inserted_id: result.insertedId.toString(),
      exchange_count: resolvedExchanges.length,
      redacted: redactedSpans,
      ...(timestampsDefaulted > 0 ? { timestamps_defaulted: timestampsDefaulted } : {}),
      performance: { duration_ms: duration }
    };

  } catch (error) {
    if (error instanceof ValidationError || error instanceof EmetError) throw error;
    throw new DatabaseError(`Failed to save session transcript: ${error.message}`, 'save_transcript');
  }
}

/**
 * One exchange as stored, for both transcript doors (save and revise).
 *
 * A missing timestamp is still filled with the save time - the record needs a
 * Date - but it is now MARKED `timestamp_defaulted: true`, so the fill is
 * visible and queryable instead of indistinguishable from an observed time.
 * Found 2026-09-10: two exchanges saved without timestamps read back as if both
 * had happened at the save instant, with nothing to say otherwise. Same
 * principle as the layer door - a missing field is written as a marker, never
 * silently filled - applied to the one path that still filled silently.
 * Semantics otherwise unchanged: a falsy timestamp is treated as absent.
 */
export function storedExchange(ex, i, scrub, now = new Date()) {
  const observed = Boolean(ex.timestamp);
  return {
    exchange_index: ex.exchange_index !== undefined ? ex.exchange_index : i,
    user_message: scrub(ex.user_message),
    assistant_message: scrub(ex.assistant_message),
    timestamp: observed ? new Date(ex.timestamp * 1000) : now,
    ...(observed ? {} : { timestamp_defaulted: true })
  };
}

function stampExchange(row, source) {
  const stamp = writerStamp();
  return {
    ...row,
    source: source || setting('SOURCE_TAG') || null,
    person_id: stamp.person_id,
    client_id: stamp.client_id
  };
}

/** Store wait for the boot drop list. Tests set EMET_DROP_LIST_TIMEOUT_MS short so a missing store does not stall the suite. */
function dropListTimeoutMs() {
  const n = Number(process.env.EMET_DROP_LIST_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 1500;
}

/** Unhandled drops from the store. Used when the startup cache has no list. */
async function unhandledDropIds() {
  const client = await Promise.race([
    connectMongo(MONGODB_URI, { serverSelectionTimeoutMS: dropListTimeoutMs(), maxPoolSize: 10 }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('unhandled drop list timed out')), dropListTimeoutMs()))
  ]);
  try {
    const open = await client.db(MONGODB_DB).collection('documents')
      .find({ doc_id: { $regex: '^drops/' }, retired: { $ne: true } }, { projection: { doc_id: 1 } })
      .sort({ updated_at: -1 })
      .toArray();
    return open.map((d) => d.doc_id).filter((id) => typeof id === 'string');
  } finally { await client.close(); }
}

/** New York calendar day, the drop-cap boundary. */
function nyDay(date) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}
/**
 * 20/day bucket. Stdio is one bucket for the process. HTTP with no OAuth
 * client stays http:visitor, and a caller-supplied source never moves it.
 * An approval-bound source is 20 per source per New York day. Any other
 * OAuth client is its own bucket.
 */
function dropBucket(clientId, _source) {
  const actor = currentActor();
  if (actor.transport === 'http' || clientId === 'http:visitor' || clientId === null) {
    if (!clientId || clientId === 'http:visitor') return 'http:visitor';
    const bound = boundSourceTag();
    if (bound) return `source:${bound}`;
    return `client:${clientId}`;
  }
  if (!clientId || clientId === 'stdio') return 'stdio';
  const bound = boundSourceTag();
  if (bound) return `source:${bound}`;
  return `client:${clientId}`;
}

/** Drops this open must stamp. Always from the store, so an expired or evicted startup cache cannot stamp an empty list. Never caller input. */
export async function dropsSeenForOpen(load_id) {
  try {
    return await unhandledDropIds();
  } catch (e) {
    const boot = cachedLoad(load_id);
    const cached = boot && Array.isArray(boot.unhandled_drops) ? boot.unhandled_drops.filter((id) => typeof id === 'string') : [];
    if (cached.length) return cached;
    throw new DatabaseError(
      `emet_session_open could not load unhandled drops from the store, so no session was opened: ${e && e.message}. Nothing was stamped.`,
      'emet_session_open'
    );
  }
}

export async function sessionOpen({ slug, load_id } = {}, logger = null, dbManager = null, now = new Date()) {
  const { sessionBaseId, sessionTimeZone, partId, firstUnclosedBase } = await import('./transcript-session.js');
  const { sessionStatus } = await import('./session-graph.js');
  const tz = sessionTimeZone();
  const requested = sessionBaseId(now, slug || 'session', tz.zone);
  // A closed session is never reopened (2026-10-01): a closed id is replaced by
  // the next free <id>-2, -3, ... and the response says so. If the session
  // state cannot be read, nothing is opened - an unchecked id could be a
  // closed one.
  let resolved;
  try {
    resolved = await firstUnclosedBase(requested, (b) => sessionStatus(b, dbManager));
  } catch (e) {
    if (e && e.allClosed) throw new ValidationError('slug', `${e.message} Nothing was opened.`);
    throw new DatabaseError(`emet_session_open could not check whether ${requested} is already closed, so no session was opened: ${e && e.message}. ` +
      'Call emet_session_open again with the same slug and load_id.', 'emet_session_open');
  }
  const base = resolved.base;
  const session_id = partId(base, 1);
  const suffixed = base !== requested;
  const phrase = (x) => (x.reason === 'closed' ? `${x.id} is already closed` : `${x.id} is ${x.reason}`);
  const notice = suffixed
    ? `${resolved.skipped.map(phrase).join('; ')}, so this session was opened as ${base} instead. ` +
      (resolved.closed.length
        ? 'A closed session is never reopened: nothing was written to it and nothing was merged into it.'
        : 'Nothing was merged into another session.')
    : null;
  logger?.info?.('transcript session open', { session_id, ...(suffixed ? { requested } : {}) });
  // Startup page completion (2026-10-03). Through dispatch, an open with no
  // load_id or with pages missing is refused before this runs (the
  // startup_pages gate); a direct call is told what was checked.
  const pages = startupPagesCheck(load_id, logger, session_id);
  // Opened with pages missing: a page fetched from now on is recorded as late,
  // under the label the open's lab row carries (the id asked for).
  if (pages && pages.checked && pages.complete === false) {
    try { noteOpenMissing(pages.load_id, requested, pages.missing); } catch { /* never fails the open */ }
  }
  // Server-side, from the stored drop list the board session must see.
  // Never args.drops_seen. A cache miss loads the store. A failed load does
  // not stamp an empty seen-list (that would fail open): the open stands,
  // and a board edit is refused until the list is known.
  let drops_seen = [];
  let drops_unverified = false;
  try {
    drops_seen = await dropsSeenForOpen(load_id);
  } catch (e) {
    drops_seen = null;
    drops_unverified = true;
  }
  return {
    session_id,
    base,
    drops_seen,
    ...(drops_unverified ? { drops_unverified: true } : {}),
    next_exchange_index: 1,
    time_zone: tz.zone,
    ...(tz.note ? { time_zone_note: tz.note } : {}),
    ...(suffixed ? {
      suffix_applied: { requested, closed: resolved.closed, skipped: resolved.skipped, opened_as: base, reason: 'closed sessions are never reopened, and a suffixed id is never shared' },
      notice
    } : {}),
    ...(pages ? { startup_pages: pages } : {}),
    instructions:
      (suffixed ? `Tell the user, in one line: ${notice} ` : '') +
      (pages && pages.notice ? `${pages.notice} ` : '') +
      'After EVERY reply, call emet_transcript_append with this session_id, the user message, and your reply. One exchange per call. Do not wait until the session ends. Do not reconstruct earlier turns.'
  };
}

/** Which pages of a startup load were never served (the session graph's startup_pages gate reads it here). */
export function startupPageCompletion(loadId = null) {
  return pageCompletion(loadId);
}

const LOAD_ID_ECHO_MAX = 64;
export const NO_LOAD_ID_NOTICE =
  'Startup pages not checked: no load_id. Pass load_id from your startup pages (startup_page.load_id on every ' +
  'emet_initialize page) to emet_session_open, so the check runs on your own startup.';
/** What emet_session_open says about the startup pages: null when there is nothing to say. Never throws. */
export function startupPagesCheck(loadId, logger = null, sessionId = null, now = Date.now()) {
  // No load_id (2026-10-03): the open is not tied to a startup, so nothing was
  // checked - say so, never stay silent, and never check the latest startup
  // this server built in its place (it may be another host's).
  if (!loadId || (typeof loadId === 'string' && !loadId.trim())) {
    return { load_id: null, checked: false, reason: 'no load_id', notice: NO_LOAD_ID_NOTICE };
  }
  let c;
  try { c = pageCompletion(loadId, now); } catch { return null; }
  if (!c) {
    // A host-supplied id is echoed back capped, so a bogus one cannot bloat the reply.
    let echoed;
    try { echoed = String(loadId); } catch { return null; }
    const cps = Array.from(echoed); // whole characters: never a lone surrogate in the echo
    if (cps.length > LOAD_ID_ECHO_MAX) echoed = `${cps.slice(0, LOAD_ID_ECHO_MAX).join('')}…`;
    return { load_id: echoed, checked: false, reason: 'no record of that startup load on this server in the last 60 minutes (it expired, or the server restarted)' };
  }
  if (c.complete) return { load_id: c.load_id, checked: true, complete: true };
  const list = c.missing.join(', ');
  const notice = `Startup pages ${list} of ${c.of} (load ${c.load_id}) were never fetched, so you are working from part of your memory. ` +
    `Fetch each now with emet_initialize {"page": N, "load_id": "${c.load_id}"} before you rely on memory; if the server says the startup changed, ` +
    'call emet_initialize {} and read every page. This session was opened; nothing was blocked.';
  try { logger?.warn?.('session opened with startup pages missing', { session_id: sessionId, load_id: c.load_id, missing: c.missing, of: c.of }); } catch { /* a failing logger never fails the open */ }
  return { load_id: c.load_id, checked: true, complete: false, of: c.of, served: c.served, missing: c.missing, notice };
}

export async function transcriptAppend(args = {}, logger = null) {
  const session_id = args.session_id;
  const user_message = args.user_message;
  const assistant_message = args.assistant_message;
  const exchange_index = args.exchange_index;
  const session_start = args.session_start;
  const channel = args.channel;
  redactWithReport(String(user_message || '') + String(assistant_message || ''));
  if (!session_id || typeof session_id !== 'string') {
    throw new ValidationError('session_id is required');
  }
  if (typeof user_message !== 'string' || typeof assistant_message !== 'string') {
    throw new ValidationError('user_message and assistant_message must be strings');
  }
  assertExchangeBudget([user_message, assistant_message]);
  const {
    partId, partNumber, baseFromPart, nextExchangeIndex, shouldStartNewPart, EXCHANGES_PER_PART
  } = await import('./transcript-session.js');

  const client = await connectMongo(MONGODB_URI, { serverSelectionTimeoutMS: 5000, maxPoolSize: 10 });
  try {
    const col = client.db(MONGODB_DB).collection('transcripts');
    let part = session_id;
    let live = await col.findOne({ session_id: part, superseded_by: { $in: [null, undefined] } })
      || await col.findOne({ session_id: part });

    if (live && shouldStartNewPart(live.exchange_count || (live.exchanges || []).length)) {
      const n = partNumber(part) + 1;
      part = partId(baseFromPart(part), n);
      live = await col.findOne({ session_id: part, superseded_by: { $in: [null, undefined] } });
    }

    const exchanges = (live && live.exchanges) || [];
    const idx = Number.isFinite(exchange_index) ? exchange_index : nextExchangeIndex(exchanges);
    if (exchanges.some((e) => Number(e.exchange_index) === idx)) {
      return { session_id: part, exchange_index: idx, already_present: true, exchange_count: exchanges.length };
    }

    const scrub = (s) => redactWithReport(s || '').text;
    const stamp = writerStamp();
    const row = {
      ...storedExchange({
        exchange_index: idx,
        user_message,
        assistant_message,
        timestamp: Date.now() / 1000
      }, idx - 1, scrub),
      source: channel || setting('SOURCE_TAG') || null,
      person_id: stamp.person_id,
      client_id: stamp.client_id
    };

    // Build 1 (2026-09-27): the first append of a session must carry the
    // measured machine line, or say there is no local shell. The rule lived in
    // host instructions and was skipped twice on 2026-09-26; the server now
    // refuses to start a transcript without it. Known names come from the
    // user's install notes; with none, the check is reported as not enforced.
    let machineCheck = null;
    if (!live && partNumber(part) === 1 && idx === 1) {
      const { knownMachinesFromInstallNotes, machineLineCheck } = await import('./lessons-to-checks.js');
      const { installDoc } = await import('./setup.js');
      const notes = await client.db(MONGODB_DB).collection('documents')
        .findOne({ doc_id: installDoc(), retired: { $ne: true } }, { projection: { content: 1 } });
      machineCheck = machineLineCheck(assistant_message, knownMachinesFromInstallNotes(notes && notes.content));
      if (!machineCheck.ok) throw new ValidationError(machineCheck.reason);
    }

    if (!live) {
      const start = typeof session_start === 'number' ? session_start : Date.now() / 1000;
      await col.insertOne({
        session_id: part,
        channel: channel || setting('SOURCE_TAG') || 'mcp',
        session_start: new Date(start * 1000),
        session_end: new Date(),
        exchange_count: 1,
        exchanges: [row],
        created_at: new Date()
      });
      return {
        session_id: part, exchange_index: idx, exchange_count: 1, rolled: part !== session_id,
        ...(machineCheck ? { machine_line: machineCheck.enforced ? `checked: ${machineCheck.matched}` : machineCheck.reason } : {})
      };
    }

    await col.updateOne(
      { _id: live._id },
      { $push: { exchanges: row }, $inc: { exchange_count: 1 }, $set: { session_end: new Date() } }
    );
    logger?.info?.('transcript append', { session_id: part, exchange_index: idx });
    return {
      session_id: part,
      exchange_index: idx,
      exchange_count: (live.exchange_count || exchanges.length) + 1,
      rolled: part !== session_id,
      next_part_after: EXCHANGES_PER_PART
    };
  } finally {
    await client.close();
  }
}

/**
 * Supersede a stored transcript part with a corrected one.
 *
 * Everything else in this store is non-destructive: layer entries supersede,
 * documents version with the prior copy archived. Transcripts had no such path,
 * so a part written with a mispaired or missing exchange could only be annotated
 * from the outside and left standing - which is how a record ends up complete in
 * shape and wrong in content.
 *
 * This does NOT edit or delete. It writes a NEW document under the same
 * session_id carrying an incremented revision and a pointer to its parent, and
 * marks the parent superseded. Both remain readable; readers take the live one.
 * The reason is REQUIRED - a correction with no stated cause is a silent rewrite
 * wearing a version number, and the point of keeping the parent is that someone
 * can see what changed and why.
 */
export async function reviseTranscript(session_id, exchanges, reason, session_start = null, session_end = null, channel = null, logger = null) {
  const startTime = Date.now();
  try {
    if (!session_id || typeof session_id !== 'string')
      throw new ValidationError('session_id must be a non-empty string');
    if (!Array.isArray(exchanges) || exchanges.length === 0)
      throw new ValidationError('exchanges must be a non-empty array - a revision replaces the whole part, not a field within it');
    if (!reason || typeof reason !== 'string' || reason.trim().length < 10)
      throw new ValidationError('reason is required and must describe what was wrong - at least 10 characters. An unexplained correction is a silent rewrite.');

    const client = await connectMongo(MONGODB_URI, { serverSelectionTimeoutMS: 5000, maxPoolSize: 10 });
    const db = client.db(MONGODB_DB);
    const col = db.collection('transcripts');

    // The live document is the one nothing supersedes.
    const parent = await col.findOne({ session_id, superseded_by: { $in: [null, undefined] } })
      || await col.findOne({ session_id });
    if (!parent) {
      await client.close();
      throw new ValidationError(`No transcript found under session_id "${session_id}". Use save_transcript to write a new part; revise_transcript only corrects one that exists.`);
    }

    const revision = (typeof parent.revision === 'number' ? parent.revision : 1) + 1;
    let redactedSpans = 0;
    const scrub = (s) => { const r = redactWithReport(s || ''); redactedSpans += r.hits; return r.text; };
    const revised = {
      session_id,
      channel: channel || parent.channel || null,
      session_start: session_start ? new Date(session_start * 1000) : parent.session_start,
      session_end: session_end ? new Date(session_end * 1000) : parent.session_end,
      exchange_count: exchanges.length,
      exchanges: exchanges.map((ex, i) => stampExchange(storedExchange(ex, i, scrub), channel || parent.channel)),
      ...(redactedSpans > 0 ? { redacted_spans: redactedSpans } : {}),
      revision,
      supersedes: parent._id,
      superseded_by: null,
      revision_reason: reason.trim(),
      revised_at: new Date(),
      created_at: new Date()
    };

    const result = await col.insertOne(revised);
    await col.updateOne({ _id: parent._id }, { $set: { superseded_by: result.insertedId } });

    // Read back rather than trust the write, and confirm the parent survived -
    // a supersession that lost the original would be a deletion with extra steps.
    const stored = await col.findOne({ _id: result.insertedId });
    const parentAfter = await col.findOne({ _id: parent._id });
    await client.close();

    const verified = Boolean(stored)
      && stored.exchange_count === exchanges.length
      && Array.isArray(stored.exchanges)
      && stored.exchanges.length === exchanges.length
      && Boolean(parentAfter)
      && String(parentAfter.superseded_by) === String(result.insertedId);

    return {
      success: true,
      verified,
      session_id,
      revision,
      inserted_id: result.insertedId.toString(),
      supersedes_id: parent._id.toString(),
      parent_retained: Boolean(parentAfter),
      parent_marked_superseded: Boolean(parentAfter && parentAfter.superseded_by),
      exchange_count: exchanges.length,
      ...(revised.exchanges.some(e => e.timestamp_defaulted)
        ? { timestamps_defaulted: revised.exchanges.filter(e => e.timestamp_defaulted).length } : {}),
      previous_exchange_count: parent.exchange_count ?? null,
      redacted: redactedSpans,
      revision_reason: reason.trim(),
      note: verified
        ? 'The prior version is retained and marked superseded. Readers take the revision; the original stays auditable.'
        : 'Write completed but read-back did not confirm. Do not report this as corrected - check the collection.',
      performance: { duration_ms: Date.now() - startTime }
    };
  } catch (error) {
    if (error instanceof ValidationError || error instanceof EmetError) throw error;
    throw new DatabaseError(`Failed to revise transcript: ${error.message}`, 'revise_transcript');
  }
}

// ============================================
// DOCUMENT STORE - versioned continuity documents
// Added 2026-07-18: HANDOFF/STATE/threads/bootstrap served interface-independently
// ============================================

async function _docsClient() {
  const client = await connectMongo(MONGODB_URI, { serverSelectionTimeoutMS: 5000, maxPoolSize: 10 });
  const db = client.db(MONGODB_DB);
  const col = db.collection('documents');
  const hist = db.collection('documents_history');
  if (!docIndexesReady) {
    try {
      await col.createIndex({ person_id: 1 }, { sparse: true });
      await col.createIndex({ client_id: 1 }, { sparse: true });
      await hist.createIndex({ person_id: 1 }, { sparse: true });
      await hist.createIndex({ client_id: 1 }, { sparse: true });
      docIndexesReady = true;
    } catch { /* an index miss never blocks the write */ }
  }
  return { client, col, hist };
}
let docIndexesReady = false;

/**
 * The default page for a read_doc TOOL call, in bytes (2026-09-26; bytes and
 * 18,000 since 2026-10-03). A host that caps tool output returned a
 * 69,000-character board as an overflow file rather than as the board, and a
 * host with no file fallback would simply lose it. Hosts cap the result they
 * RECEIVE (commonly 20,000 bytes), and that is the page as JSON text - every
 * newline, quote and backslash costs a byte more there - plus the envelope
 * (sha256, version, conformance, the page note). So a page is cut where its
 * JSON-escaped bytes plus READ_DOC_ENVELOPE_SPARE would pass the limit. The
 * tool pages at this size unless the caller asks otherwise; `limit: 0` returns
 * the whole document. Internal callers pass no page and always get the whole
 * document - patch_doc and friends must never operate on a slice.
 */
export const READ_DOC_PAGE_DEFAULT = Number(setting('READ_DOC_PAGE', 18000)) || 18000;

/** Bytes of a page's limit kept for the read_doc result's envelope (2026-10-03). */
export const READ_DOC_ENVELOPE_SPARE = 1500;

/** The bytes a string takes as JSON text, quotes included: what a host receives for it. */
export function jsonEscapedBytes(s) {
  return Buffer.byteLength(JSON.stringify(s), 'utf8');
}

/** UTF-8 length of one code point (a lone surrogate encodes as U+FFFD: 3 bytes). */
function utf8Length(cp) {
  return cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
}

/** JSON-escaped length of one code point, as JSON.stringify writes it (a lone surrogate is \uXXXX: 6 bytes). */
function jsonLength(cp) {
  if (cp === 0x22 || cp === 0x5c || cp === 0x08 || cp === 0x09 || cp === 0x0a || cp === 0x0c || cp === 0x0d) return 2;
  if (cp < 0x20) return 6;
  if (cp >= 0xd800 && cp <= 0xdfff) return 6;
  return utf8Length(cp);
}

/**
 * Cut one page from a document's content. Returns the content and, when the
 * page is not the whole document, a `page` block saying where it sits.
 *
 * `offset`, `next_offset`, `returned` and `size` are UTF-8 BYTES of the whole
 * document. `limit` bounds what the host receives: a page ends before its
 * JSON-escaped bytes (jsonEscapedBytes, quotes included) plus
 * READ_DOC_ENVELOPE_SPARE would pass `limit`; `returned_escaped` is that
 * escaped size. A page never splits a character (a code point), and
 * `next_offset` is always the byte where the next character starts. An `offset` that falls inside a character is moved back to
 * that character's first byte, so nothing is skipped. A `limit` smaller than
 * the character at `offset` still returns that one character, so paging always
 * moves forward. Joining the pages in order gives back the document exactly.
 */
export function pageContent(full, offset = 0, limit = null) {
  const text = String(full ?? '');
  const n = text.length;
  const unitsAt = (i) => {
    const cp = text.codePointAt(i);
    return { bytes: utf8Length(cp), json: jsonLength(cp), units: cp > 0xffff ? 2 : 1 };
  };
  let size = 0;
  for (let i = 0; i < n;) { const c = unitsAt(i); size += c.bytes; i += c.units; }
  const want = Math.max(0, Math.min(Number(offset) || 0, size));
  const lim = limit === null || limit === undefined ? 0 : Math.max(0, Number(limit) || 0);
  // Start: the first byte of the character holding byte `want`.
  let i = 0; let start = 0;
  while (i < n) { const c = unitsAt(i); if (start + c.bytes > want) break; start += c.bytes; i += c.units; }
  // End: the last whole character whose JSON-escaped page, plus the envelope
  // spare, stays within `lim` (at least one character, so paging moves forward).
  let j = i; let end = start;
  if (lim === 0) { j = n; end = size; } else {
    let escaped = 2; // the quotes
    while (j < n) {
      const c = unitsAt(j);
      if (escaped + c.json + READ_DOC_ENVELOPE_SPARE > lim && j > i) break;
      escaped += c.json; end += c.bytes; j += c.units;
    }
  }
  const content = text.slice(i, j);
  if (start === 0 && end === size) return { content, page: null };
  return {
    content,
    page: {
      unit: 'bytes',
      offset: start,
      returned: end - start,
      returned_escaped: jsonEscapedBytes(content),
      envelope_spare: READ_DOC_ENVELOPE_SPARE,
      size,
      size_bytes: size,
      next_offset: end < size ? end : null,
      note: end < size
        ? 'Partial: this is one page of the document. Call read_doc again with offset = next_offset for the rest, and pass expected_version (this result\'s version) so a change between pages is refused rather than mixed. sha256 is the WHOLE document\'s digest.'
        : 'Final page. sha256 is the WHOLE document\'s digest.'
    }
  };
}

/**
 * The version pin for a paged read (2026-10-03). A caller reading page 2 onward
 * passes the `version` (or `sha256`) its first page returned; if the document
 * was rewritten in between, the read is refused, so pages of two versions are
 * never joined. A shipped guide has no version: pin it by sha256. Throws a
 * ValidationError naming what changed; returns nothing when the pin holds.
 */
export function checkReadPin(doc_id, current, opts = {}) {
  const wantV = opts.expected_version;
  const wantS = opts.expected_sha256;
  const hasV = wantV !== undefined && wantV !== null && wantV !== '';
  const hasS = typeof wantS === 'string' && wantS.trim() !== '';
  if (!hasV && !hasS) return;
  if (hasV && !(Number.isInteger(Number(wantV)) && Number(wantV) >= 1)) {
    throw new ValidationError('expected_version', 'expected_version is the whole-number `version` an earlier page of this document returned.');
  }
  const vChanged = hasV && current.version !== undefined && current.version !== null && Number(wantV) !== Number(current.version);
  const sChanged = hasS && String(current.sha256 || '').toLowerCase() !== wantS.trim().toLowerCase();
  if (!vChanged && !sChanged) return;
  const was = [hasV ? `version ${Number(wantV)}` : null, hasS ? `sha256 ${wantS.trim().slice(0, 12)}...` : null].filter(Boolean).join(', ');
  const now = [current.version !== undefined && current.version !== null ? `version ${current.version}` : null,
    current.sha256 ? `sha256 ${String(current.sha256).slice(0, 12)}...` : null].filter(Boolean).join(', ');
  throw new ValidationError('expected_version',
    `${doc_id}: document changed - restart from offset 0. You read earlier pages of ${was}; it is now ${now}. ` +
    'Pages of two versions are never joined, so nothing was returned. Call read_doc again with offset 0 and no expected_version, ' +
    'discard the pages you already have, and read every page of the new version.');
}

export async function readDoc(doc_id, logger = null, opts = {}) {
  try {
    if (!doc_id || typeof doc_id !== 'string') throw new ValidationError('doc_id must be a non-empty string');
    const guide = readShippedGuide(doc_id);
    if (guide) {
      checkReadPin(doc_id, guide, opts);
      const { content, page } = pageContent(guide.content, opts.offset ?? 0, opts.limit ?? null);
      return { ...guide, content, size_unit: 'characters', size_bytes: Buffer.byteLength(guide.content, 'utf8'), ...(page ? { page } : {}) };
    }
    const { client, col } = await _docsClient();
    try {
      const doc = await col.findOne({ doc_id });
      if (!doc) throw new ValidationError(`Document not found: ${doc_id}`);
      checkReadPin(doc_id, doc, opts);
      const { content, page } = pageContent(doc.content, opts.offset ?? 0, opts.limit ?? null);
      // A retired document is still returned in full - retain and mark, never
      // withhold. The caller is TOLD it is obsolete so it is not used as
      // current, which is the whole of "prevent unintended use".
      return { doc_id: doc.doc_id, content, sha256: doc.sha256, version: doc.version,
               updated_at: doc.updated_at, updated_by: doc.updated_by || null,
               client_id: doc.client_id || null, session_id: doc.session_id || null,
               path_hint: doc.path_hint || null, size: doc.content.length,
               size_unit: 'characters', size_bytes: Buffer.byteLength(doc.content, 'utf8'),
               ...(page ? { page } : {}),
               // The conformance verdict travels with the document the same way
               // `integrity` travels with a layer row: a reader is told what the
               // record knows about itself rather than having to ask separately.
               // null on documents written before validation existed - a dated
               // boundary, not a defect.
               conformance: doc.conformance || null,
               signed: signatureIntegrityOf(doc, setting('SIGNING_KEY') || null),
               ...(doc.retired === true ? {
                 retired: true, retired_at: doc.retired_at || null,
                 retired_by: doc.retired_by || null,
                 retired_reason: doc.retired_reason || null,
                 note: 'This document is marked OBSOLETE. It is retained in full and readable, but it is not current - do not act on it as live state.'
               } : {}) };
    } finally { await client.close(); }
  } catch (error) {
    if (error instanceof ValidationError || error instanceof EmetError) throw error;
    throw new DatabaseError(`Failed to read document: ${error.message}`, 'read_doc');
  }
}

/**
 * Read a retained revision of a document, or list the revisions retained.
 *
 * Every write archives the prior copy to documents_history (commitment 2:
 * nothing is deleted). Until 2026-09-15 nothing could read one back - the
 * retention held but an audit asking "what did this say at version N" had no
 * tool to answer with. Read-only; the write-path invariant test confirms it.
 */
export async function readDocHistory(doc_id, version = null, logger = null) {
  try {
    if (!doc_id || typeof doc_id !== 'string') throw new ValidationError('doc_id must be a non-empty string');
    if (version !== null && version !== undefined && (!Number.isInteger(version) || version < 1)) throw new ValidationError('version must be a positive integer');
    const { client, col, hist } = await _docsClient();
    try {
      const current = await col.findOne({ doc_id });
      if (version === null || version === undefined) {
        const retained = await hist.find({ doc_id }, { projection: { content: 0 } }).sort({ version: 1 }).toArray();
        const rows = retained.map(r => ({ version: r.version, sha256: r.sha256 || null, size: r.size ?? null,
          updated_at: r.updated_at || null, updated_by: r.updated_by || null, client_id: r.client_id || null, session_id: r.session_id || null, archived_at: r.archived_at || null,
          conformance: r.conformance ? r.conformance.verdict : null }));
        return { doc_id, current_version: current ? current.version : null, retained_count: rows.length, retained: rows,
                 note: current ? null : 'No current document by this id; only retained revisions, if any.' };
      }
      if (current && current.version === version) {
        return { doc_id, version, is_current: true, content: current.content, sha256: current.sha256, size: current.content.length,
                 updated_at: current.updated_at, updated_by: current.updated_by || null,
                 client_id: current.client_id || null, session_id: current.session_id || null,
                 conformance: current.conformance || null };
      }
      // More than one archived row can carry a version when a write was retried;
      // the most recently archived is the one the store last held at that number.
      const row = await hist.find({ doc_id, version }).sort({ archived_at: -1 }).limit(1).next();
      if (!row) throw new ValidationError(`No retained revision ${version} of ${doc_id}`);
      const integrity = row.sha256 ? (digest(row.content) === row.sha256) : 'unattested';
      return { doc_id, version, is_current: false, content: row.content, sha256: row.sha256 || null, size: row.content.length,
               updated_at: row.updated_at || null, updated_by: row.updated_by || null, archived_at: row.archived_at || null,
               client_id: row.client_id || null, session_id: row.session_id || null,
               conformance: row.conformance || null,
               // Re-hashed on read, as a layer row is: a retained revision that
               // does not match its own digest is returned and flagged, never hidden.
               integrity };
    } finally { await client.close(); }
  } catch (error) {
    if (error instanceof ValidationError || error instanceof EmetError) throw error;
    throw new DatabaseError(`Failed to read document history: ${error.message}`, 'read_doc_history');
  }
}

/**
 * Records are superseded, never amended (2026-09-26, the owner: "enforce
 * supersession ISO practices"). ISO 9001 7.5.3 / ISO 13485 4.2.5 separate
 * DOCUMENTS, which are revised under control, from RECORDS, which are evidence
 * of what happened and are not altered. The handoff is a record: it attests to
 * one session's close. So:
 *   - patch_doc is refused on a record - no in-place amendment;
 *   - a new revision goes through write_doc WHOLE and must name the revision it
 *     supersedes (`supersedes`), which must be the one currently in force;
 *   - the prior revision is retained in documents_history and marked obsolete
 *     there (superseded_by_version), as it is for every document.
 * The record set is the handoff plus any ids in EMET_RECORD_DOCS (comma-list).
 */
export function recordDocIds() {
  const extra = String(setting('RECORD_DOCS', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
  return [setting('HANDOFF_DOC', 'HANDOFF.md'), ...extra];
}
export function isRecordDoc(doc_id) {
  return recordDocIds().includes(doc_id);
}
/** Every document that is not a record, a drop, or a shipped copy. */
export function isWorkingDoc(doc_id) {
  return !isRecordDoc(doc_id) && !isDropDoc(doc_id) && !isGovernedByShippedCopy(doc_id);
}
function stateDoc() {
  return setting('STATE_DOC', 'STATE.md');
}
function _refuseRecordAmendment(doc_id, tool) {
  if (isRecordDoc(doc_id)) {
    throw new ValidationError(
      `${tool}: ${doc_id} is a record. Records are superseded, not amended (ISO 9001 7.5.3 / 13485 4.2.5). ` +
      `Issue a new revision with write_doc - the whole record, with \`supersedes\` set to the version now in force. ` +
      `The prior revision is retained and marked obsolete. Nothing was changed.`
    );
  }
}

/**
 * The main records are the hub's (C1, 2026-10-01). write_doc and patch_doc refuse the main HANDOFF.md or STATE.md when the
 * write's source is a bot tag (bots/<tag>/HANDOFF.md listed in
 * EMET_RECORD_DOCS), and nothing is written. So do the other doors that can
 * change a main record (the reviewer's F1 in review): retire_doc, rename_doc (from
 * or onto one) and accept_nonconformance - retire and rename set retired_by,
 * not updated_by, so the close alone could not see them. The source is the one the door
 * stamps as updated_by: the caller's, else EMET_SOURCE_TAG. A records rule like
 * the record-amendment refusal above, so it applies in every graph mode.
 *
 * Two further guards on the same doors (2026-10-01, the owner's approval to
 * make the bot tags fully functional; the reviewer's review of the bot tags):
 *   - REGISTERED HOSTS ONLY on the main records. With a source registry
 *     configured (EMET_SOURCE_TAGS, parsed as save_to_layer parses it), the
 *     main handoff and board take writes only from a registered tag. An
 *     unlisted or misspelled bot tag, a write naming no source (which falls
 *     back to EMET_SOURCE_TAG), and cloud-scheduled-* runs are refused - the
 *     transcript registry's cloud-scheduled exception is deliberately not
 *     copied: unattended runs do not write the hub's records. With no registry
 *     (a fresh install) nothing changes.
 *   - EACH BOT IN ITS OWN DIRECTORY. A bot tag writes under bots/ only inside
 *     bots/<its own tag>/: not another bot's handoff, not bots/ROSTER.md.
 *     Hosts (the hub) keep writing anywhere under bots/.
 */
export function sourceRegistry() {
  return String(setting('SOURCE_TAGS') ?? '').split(',').map((s) => s.trim()).filter((s) => s !== '');
}

/**
 * The tag a write is stamped with.
 * `from: 'bound'` — HTTP, the tag stored at approval. The caller's tag is ignored.
 * `from: 'legacy'` — HTTP, the token has no bound tag. The caller's tag is kept
 * only when it is an exact member of EMET_SOURCE_TAGS. An empty registry has no
 * members, so the tag stays unset.
 * `from: 'caller'` — stdio. The caller tag is returned as given; saveMemory may
 * still apply EMET_SOURCE_TAG when it is empty.
 */
export function resolvedSourceTag(caller) {
  const bound = boundSourceTag();
  const tag = typeof caller === 'string' ? caller.trim() : '';
  if (typeof bound === 'string' && bound) return { tag: bound, from: 'bound' };
  if (bound === undefined) return { tag: tag || null, from: 'caller' };
  if (tag && sourceRegistry().includes(tag)) return { tag, from: 'legacy' };
  return { tag: null, from: 'legacy' };
}

// Look-alike doc ids (the second reader's recheck d1-d5, 2026-10-02): a `.` or `..` segment,
// a leading `/`, or a `bots/` prefix in the wrong case would let a write pass
// the prefix checks below while naming a record they are meant to fence (d1:
// bots/tester-bot/../intake-bot/HANDOFF.md passed the own-dir check). Doc
// ids are flat strings, never resolved as paths, so these shapes are refused
// outright, before any guard, on every door that calls this.
//
// Hardening (the reviewer's scope on the doc-id fix, 2026-10-02): also refused are
// control and invisible-format characters (\p{Cc}, \p{Cf}) anywhere; leading or
// trailing whitespace on the id or on any segment; a backslash; the `/`, `.`/`..`
// and `bots/` checks run on the NFKC form too (so full-width dots and slashes,
// the two-dot leader and full-width letters fold first); a first segment that
// folds to `bots` must be exactly the ASCII `bots`; and a case or Unicode variant
// of a main-record id (HANDOFF.md -> handoff.md). No confusables table: a
// Cyrillic look-alike is a different id and falls to the ordinary guards. `%2e`
// is not decoded: ids are never URL-decoded, so it is just three characters.
const FOLD = (s) => s.normalize('NFKC').toLowerCase();
export function lookalikeDocIdReason(doc_id) {
  if (typeof doc_id !== 'string') return null;
  if (/[\p{Cc}\p{Cf}]/u.test(doc_id)) return 'has a control or invisible formatting character';
  if (doc_id.includes('\\')) return 'has a backslash';
  if (doc_id !== doc_id.trim() || doc_id.split('/').some((seg) => seg !== seg.trim())) {
    return 'has leading or trailing whitespace on the id or on a segment';
  }
  const nfkc = doc_id.normalize('NFKC');
  if (doc_id.startsWith('/')) return 'starts with "/"';
  if (nfkc.startsWith('/')) return 'starts with a character that normalises to "/"';
  if (doc_id.split('/').some((seg) => seg === '.' || seg === '..')) return 'has a "." or ".." segment';
  if (nfkc.split('/').some((seg) => seg === '.' || seg === '..')) return 'has a segment that normalises to "." or ".."';
  const first = doc_id.split('/')[0];
  const firstFolded = FOLD(nfkc.split('/')[0]);
  if (doc_id.slice(0, 5).toLowerCase() === 'bots/' && !doc_id.startsWith('bots/')) {
    return `starts with "${doc_id.slice(0, 5)}" - the bot records folder is "bots/", lower case`;
  }
  if (firstFolded === 'bots' && first !== 'bots') {
    return `starts with "${first}", which folds to "bots" - the bot records folder is the ASCII "bots", lower case`;
  }
  const mains = mainRecordIds();
  if (!mains.includes(doc_id) && mains.some((m) => typeof m === 'string' && FOLD(m) === FOLD(doc_id))) {
    return 'is a case or Unicode variant of a main record id';
  }
  return null;
}

export function refuseLookalikeDocId(doc_id, tool) {
  const why = lookalikeDocIdReason(doc_id);
  if (why) {
    throw new ValidationError(
      `${tool}: doc_id ${JSON.stringify(doc_id)} ${why}. Doc ids are not paths and are not resolved; write the id ` +
      `exactly as it is meant to be stored. Nothing was written.`
    );
  }
}

// Cleanup path (the reviewer's scope): a look-alike id may already exist in a store
// written before these checks. retire_doc, and rename_doc FROM such an id, are let
// through for a registered host tag only: EMET_SOURCE_TAGS set, the tag listed,
// and not a bot tag. Never for a write, a patch, a rename onto it, or a bot.
function mayCleanUpLookalike(tag) {
  const registry = sourceRegistry();
  return !!tag && !isBotTag(tag) && registry.length > 0 && registry.includes(tag);
}

export function refuseBotMainRecord(doc_id, updated_by, tool, options = {}) {
  const tag = updated_by || setting('SOURCE_TAG') || null;
  if (!(options.cleanup === true && mayCleanUpLookalike(tag))) refuseLookalikeDocId(doc_id, tool);
  const bot = !!tag && isBotTag(tag);
  if (bot && typeof doc_id === 'string' && doc_id.startsWith('bots/') && !doc_id.startsWith(botRecordDir(tag))) {
    throw new ValidationError(
      `${tool}: ${doc_id} is outside ${botRecordDir(tag)} and ${tag} is a bot tag - a bot writes only its own ` +
      `${botRecordDir(tag)} records; other bots' records and the roster are not its to change. ` +
      `Hand it to the hub instead. Nothing was written.`
    );
  }
  // Registry guard on bots/ too (the reviewer's review of the bot guards; the second reader's fix (a), 2026-10-02): with EMET_SOURCE_TAGS
  // set, a non-bot write under bots/ is refused unless its tag is registered; a missing source counts as
  // unregistered. Without this, a misspelled or unregistered tag is not a bot tag, so the cross-bot guard
  // above never fires and it can write any bot's records or the roster. A listed bot is already fenced to
  // its own bots/<tag>/ above; registered hosts (the hub) still write anywhere under bots/.
  const registry = sourceRegistry();
  if (!bot && registry.length && typeof doc_id === 'string' && doc_id.startsWith('bots/') && !(tag && registry.includes(tag))) {
    throw new ValidationError(
      `${tool}: ${doc_id} is a bot record and ${tag ? `"${tag}" is not a registered source tag` : 'this write names no source tag'} - ` +
      `only a registered host or the bot itself writes under bots/. Nothing was written.`
    );
  }
  if (!mainRecordIds().includes(doc_id)) return;
  if (bot) {
    throw new ValidationError(
      `${tool}: ${doc_id} is a main record and ${tag} is a bot tag - a bot session closes against ` +
      `${botRecordDir(tag)} records; the main handoff and board are the hub's. Write the bot's own ` +
      `${botRecordDir(tag)}HANDOFF.md instead. Nothing was written.`
    );
  }
  if (options && options.serverProvision === true) return;
  if (registry.length && !(tag && registry.includes(tag))) {
    throw new ValidationError(
      `${tool}: ${doc_id} is a main record and ` +
      `${tag ? `"${tag}" is not a registered source tag` : 'this write names no source tag'} - only a registered ` +
      `host writes the main handoff and board. Pass the host's registered \`source\` (EMET_SOURCE_TAGS). Nothing was written.`
    );
  }
}

/**
 * retire_doc and rename_doc are not bot tools at all (the owner, 2026-10-01,
 * decision 1, as relayed: "retire_doc isn't needed for bots: keep it
 * the owner/hub only and out of every bot profile"; the owner's decision record; stage 1 of the
 * host-aware startup amendment, admitted by the reviewer 2026-10-02). A profile is not a
 * security boundary, so the door refuses them under ANY bot tag, for every
 * doc_id - not only the main records refuseBotMainRecord covers. The owner's decision record (item 1)
 * covers retire_doc only; rename_doc stays owner-only under a later decision record
 * (owner-confirmed 2026-10-02: every other owner-only tool is
 * unchanged), and it retires its old id internally, so it is refused too. The tag is the
 * one the door would stamp: the caller's, else EMET_SOURCE_TAG. Hosts and the
 * hub have no bots/<tag>/HANDOFF.md record and are unaffected. Nothing is
 * written when refused.
 */
export function refuseBotRetireRename(tag, tool) {
  const t = tag || setting('SOURCE_TAG') || null;
  if (!t || !isBotTag(t)) return;
  throw new ValidationError(
    'source',
    `${tool} is not a bot tool: ${t} is a bot tag, and ` +
    (tool === 'retire_doc'
      ? `retiring documents is the owner's and the hub's (decision 1, the owner's decision record item 1)`
      : `renaming documents stays owner-only (the owner's decision record)`) +
    `. Ask the hub. Nothing was changed.`
  );
}

export async function writeDoc(doc_id, rawContent, updated_by = null, path_hint = null, logger = null, options = {}) {
  try {
    if (!doc_id || typeof doc_id !== 'string') throw new ValidationError('doc_id must be a non-empty string');
    // write_doc, patch_doc (which lands here) and rename_doc's copy (reissued_from).
    refuseBotMainRecord(doc_id, updated_by, options && options.reissued_from ? 'rename_doc' : 'write_doc', options && options.serverProvision === true ? { serverProvision: true } : {});
    if (typeof rawContent !== 'string' || rawContent.length === 0) throw new ValidationError('content must be a non-empty string');
    if (rawContent.length > 2000000) throw new ValidationError('content exceeds 2MB limit');
    // patch_doc lands here too, so one
    // scrub covers every document write. The digest is of the stored text.
    const redaction = redactWithReport(rawContent);
    const content = redaction.text;
    const sha256 = digest(content);
    const signingKey = setting('SIGNING_KEY') || null;
    const signature = signDigests(sha256, '', signingKey);
    const { client, col, hist } = await _docsClient();
    try {
      const prev = await col.findOne({ doc_id });
      const version = (prev && prev.version ? prev.version : 0) + 1;
      // A record in force is superseded only by a revision that names it.
      // Checked before anything is archived, so a refused write leaves no trace.
      if (prev && isRecordDoc(doc_id) && options && options.restore_of && (options.supersedes === undefined || options.supersedes === null)) {
        options = { ...options, supersedes: prev.version };
      }
      if (prev && isRecordDoc(doc_id)) {
        const named = options && options.supersedes;
        if (named === undefined || named === null) {
          throw new ValidationError(
            `write_doc: ${doc_id} is a record and v${prev.version} is in force. A new revision must name what it ` +
            `supersedes - pass supersedes: ${prev.version}. Nothing was changed.`
          );
        }
        if (Number(named) !== prev.version) {
          throw new ValidationError(
            `write_doc: ${doc_id} - supersedes names v${named}, but v${prev.version} is in force. Re-read the record ` +
            `and supersede the current revision. Nothing was changed.`
          );
        }
        const reason = options && options.reason;
        if (typeof reason !== 'string' || reason.trim().length < 10) {
          throw new ValidationError(
            `write_doc: ${doc_id} is a record. A new revision needs reason (at least 10 characters) as well as supersedes. Nothing was changed.`
          );
        }
      }
      const registry = sourceRegistry();
      const tag = updated_by || '';
      const registered = registry.length === 0 || registry.includes(tag);
      const ownBotFolder = isBotTag(updated_by) && doc_id.startsWith(`bots/${updated_by}/`);
      const serverProvision = options && options.serverProvision === true;
      if (!registered && !ownBotFolder && !serverProvision && !(isDropDoc(doc_id) && !prev)) {
        throw new ValidationError(`write_doc: ${updated_by || 'no source'} is not a registered source. This session may read, and may write a new drop only. Nothing was written.`);
      }
      if (isDropDoc(doc_id) && !prev) {
        const { writerStamp } = await import('./persons.js');
        const bucket = dropBucket(writerStamp().client_id, updated_by);
        const day = nyDay(new Date());
        const same = (await col.find({ doc_id: { $regex: '^drops/' } }).toArray()).filter((d) => (d.drop_bucket || dropBucket(d.client_id, d.updated_by)) === bucket && nyDay(d.updated_at instanceof Date ? d.updated_at : new Date(d.updated_at || 0)) === day);
        if (same.length >= 20) throw new ValidationError(`write_doc: this connected app already wrote 20 drops today. Nothing was written.`);
        options = { ...options, drop_bucket: bucket };
      }
      const floorExempt = options && options.provision;
      const internal = options && (options.provision || options.edited || options.setupReissue || options.restore_of);
      if (options && options.provision && prev && doc_id === stateDoc()) {
        throw new ValidationError('The board already exists. Provision does not replace it. Nothing was written.');
      }
      if (doc_id === stateDoc() && !(options && (options.provision || options.edited || options.restore_of))) {
        throw new ValidationError(prev
          ? 'The board is never written. Edit it with patch_doc, with `reason` (and `origin` for an added row). Nothing was written.'
          : 'The board is provisioned by the server at setup (emet_setup_complete). Nothing was written.');
      }
      if (prev && isWorkingDoc(doc_id) && !internal) {
        throw new ValidationError(
          `write_doc: ${doc_id} exists, so it is edited, not rewritten. Use patch_doc with \`reason\`. Nothing was written.`
        );
      }
      if (isDropDoc(doc_id) && (prev || (options && options.restore_of))) {
        throw new ValidationError(
          `write_doc: ${doc_id} is a drop and already exists, retired drops included. A drop is never patched or restored. Use a new id. Nothing was written.`
        );
      }
      if (isGovernedByShippedCopy(doc_id) && !(options && options.provision)) {
        const { readFileSync } = await import('node:fs');
        const shippedPath = resolveModulePath(import.meta.url, ['..', doc_id]);
        let shipped = '';
        try { shipped = readFileSync(shippedPath, 'utf8'); } catch { shipped = ''; }
        if (content !== shipped) {
          throw new ValidationError(`write_doc: ${doc_id} is governed by the copy shipped with this release. Only that text may be stored. Nothing was written.`);
        }
      }
      const sid = (options && options.session_id) || null;
      const base = String(sid || '').replace(/_verbatim_part\d+$/, '').trim() || null;
      const baselines = prev && prev.size_baselines && typeof prev.size_baselines === 'object' ? { ...prev.size_baselines } : {};
      let baseline;
      if (base && Number.isInteger(baselines[base])) baseline = baselines[base];
      else {
        baseline = prev ? String(prev.content || '').length : content.length;
        if (base) baselines[base] = baseline;
      }
      if (prev && !floorExempt && baseline > 0 && content.length * 2 < baseline) {
        const pct = Math.floor((content.length / baseline) * 100);
        throw new ValidationError(
          `This change would leave ${doc_id} at ${pct}% of its size when this session first touched it. Condensing below half is not done on the EMET server. Nothing was written.`
        );
      }
      // Cross-session floor. The per-session floor is measured from this
      // session's first touch, so a new session can shrink a document once.
      // It cannot shrink it again below half of the largest size stored in
      // the last 24 hours. The window is a security floor, not memory decay.
      const CROSS_SESSION_FLOOR_MS = 24 * 60 * 60 * 1000;
      const nowMs = Date.now();
      const recentSamples = (prev && Array.isArray(prev.size_samples) ? prev.size_samples : [])
        .filter((s) => s && typeof s.size === 'number' && s.at && (nowMs - new Date(s.at).getTime()) <= CROSS_SESSION_FLOOR_MS);
      let peak = 0;
      for (const s of recentSamples) peak = Math.max(peak, s.size);
      if (prev && prev.updated_at && (nowMs - new Date(prev.updated_at).getTime()) <= CROSS_SESSION_FLOOR_MS) {
        peak = Math.max(peak, String(prev.content || '').length);
      }
      if (prev && !floorExempt && peak > 0 && content.length * 2 < peak) {
        const pct = Math.floor((content.length / peak) * 100);
        throw new ValidationError(
          `This change would leave ${doc_id} at ${pct}% of its largest size in the last 24 hours. A write may not fall below half of that peak. Nothing was written.`
        );
      }
      const sizeSamples = recentSamples.slice();
      if (prev) sizeSamples.push({ size: String(prev.content || '').length, at: prev.updated_at || new Date() });
      if (prev) {
        const { _id, size_baselines: _liveBaselines, ...rest } = prev;
        // Retained and marked obsolete (ISO 7.5.3 / 4.2.5): the archived copy
        // says which revision replaced it. Baselines stay on the live row only.
        await hist.insertOne({ ...rest, archived_at: new Date(), superseded_by_version: version });
      }
      const now = new Date();
      // Validation runs HERE: after redaction, on the exact text that will be
      // stored, with the previous revision already in hand for the
      // carry-forward comparison. It marks and never rejects, so its
      // result is a field on the row rather than a branch in this function.
      // Writing the field whole also enforces L6 - the fresh object carries no
      // acceptance, so an acceptance covers the one revision it was given to.
      const conformance = validateDocument(doc_id, content, prev ? prev.content : null);
      // L5, set only when renameDoc reaches this door. The destination passes
      // validation as "untemplated" when no template maps to it - which is the
      // evasion rather than the answer if the id it came FROM was governed.
      // Marked here, inside the one door, rather than by a second write after
      // the fact: a marker applied by a separate updateOne would be exactly the
      // kind of side entrance the write-path invariant exists to prevent.
      const from = options && options.reissued_from;
      if (from && templateFor(from) && !templateFor(doc_id)) {
        conformance.verdict = CONFORMANCE_VERDICT.NONCONFORMING;
        conformance.failures = [...(conformance.failures || []),
          `reissued from ${from}, which ${templateFor(from)} governs, to ${doc_id}, which no template governs (L5)`];
      }
      const writtenRow = {
        doc_id, content, sha256, signature, version, size: content.length, updated_at: now,
        conformance,
        supersedes_version: prev ? prev.version : null,
        updated_by: updated_by || (isDropDoc(doc_id) ? 'visitor' : (setting('SOURCE_TAG') || null)),
        edit_reason: (options && options.reason) || null,
        edit_origin: (options && options.origin) || null,
        person_id: (await import('./persons.js').then((m) => m.writerStamp())).person_id,
        client_id: (await import('./persons.js').then((m) => m.writerStamp())).client_id,
        session_id: sid,
        restored_from_version: (options && options.restore_of) || null,
        size_at_session_start: baseline,
        size_session_id: base,
        size_baselines: baselines,
        size_samples: typeof sizeSamples !== 'undefined' ? sizeSamples : (prev && prev.size_samples) || [],
        drop_bucket: (options && options.drop_bucket) || (prev && prev.drop_bucket) || null,
        path_hint: path_hint || (prev && prev.path_hint) || null,
        // Writing a retired document brings it back into the working view.
        // Without this a retired id would take writes and stay invisible, which
        // is a trap; it is also the un-retire path, so retirement is not a
        // one-way door.
        retired: false,
        size_note: 'baseline is the size when this session first touched the document'
      };
      if (options && options.provision && doc_id === stateDoc()) {
        const ins = await col.updateOne({ doc_id }, { $setOnInsert: writtenRow }, { upsert: true });
        if (ins && ins.upsertedCount === 0) {
          throw new ValidationError('The board already exists. Provision does not replace it. Nothing was written.');
        }
      } else {
        await col.updateOne({ doc_id }, { $set: writtenRow }, { upsert: true });
      }
      // aleph: the write is not done because the call returned.
      const check = await col.findOne({ doc_id });
      verifyDocument(check, { doc_id, sha256, version });
      return { doc_id, sha256, version, size: content.length, updated_at: now, verified: true,
               signed: signatureIntegrityOf(check, signingKey),
               signature_stored: typeof check?.signature === 'string' && check.signature.length > 0,
               redacted: redaction.hits, conformance };
    } finally { await client.close(); }
  } catch (error) {
    if (error instanceof ValidationError || error instanceof EmetError) throw error;
    throw new DatabaseError(`Failed to write document: ${error.message}`, 'write_doc');
  }
}

export async function listDocs(prefix = null, logger = null, include_retired = false) {
  try {
    const { client, col } = await _docsClient();
    try {
      const q = prefix ? { doc_id: { $regex: '^' + prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') } } : {};
      // Retired documents stay in the list. Current documents come first.
      // include_retired is accepted for older callers and does not hide anything.
      logger?.debug?.('Listing documents', { include_retired: include_retired === true });
      const docs = await col.find(q, { projection: { content: 0 } }).toArray();
      docs.sort((a, b) => {
        const ar = a.retired === true ? 1 : 0;
        const br = b.retired === true ? 1 : 0;
        if (ar !== br) return ar - br;
        return String(a.doc_id).localeCompare(String(b.doc_id));
      });
      const retiredCount = docs.filter(d => d.retired === true).length;
      return { count: docs.length, include_retired: true,
        retired_shown: retiredCount,
        documents: docs.map(d => {
          const replaced_by = d.retired === true ? replacedByOf(d) : null;
          return {
        doc_id: d.doc_id, sha256: d.sha256, version: d.version, size: d.size !== undefined ? d.size : null,
        updated_at: d.updated_at, updated_by: d.updated_by || null, path_hint: d.path_hint || null,
        ...(d.conformance ? { conformance: d.conformance.verdict,
          ...(d.conformance.failures && d.conformance.failures.length ? { nonconformances: d.conformance.failures.length } : {}) } : {}),
        ...(d.retired === true ? { retired: true, retired_at: d.retired_at || null, retired_reason: d.retired_reason || null, replaced_by } : {}) };
        }) };
    } finally { await client.close(); }
  } catch (error) {
    if (error instanceof ValidationError || error instanceof EmetError) throw error;
    throw new DatabaseError(`Failed to list documents: ${error.message}`, 'list_docs');
  }
}

// ============================================
// DOC-STORE LIFECYCLE (added 2026-09-08)
//
// ⭐ THERE IS NO DELETE, AND THERE IS NOT GOING TO BE ONE. the user's decision,
// 2026-09-08, on ISO grounds: document control is retain-and-mark-obsolete, not
// remove. ISO 7.5.3's requirement is to issue the revision, mark the prior copy
// obsolete, RETAIN it, and prevent its unintended use. Removal fails the third
// clause outright, and "recoverable from the history collection" does not fix
// that - a record you must reconstruct from an archive is not a retained record.
//
// The layers have always worked this way: entries are superseded, never edited
// and never deleted, and episodic events are immutable. The document store was
// the one place that lacked the mechanism, and the honest fix is to give it the
// SAME one rather than to give it a delete verb.
//
// So: retire_doc marks a document obsolete. The content stays exactly where it
// is, at its own id, readable forever. list_docs and the startup scan keep it,
// after the current documents, marked with retired_at and what replaced it.
// That is the mark the seed needed, and it never needed a removal to solve.
//
// An earlier draft of this section deleted rows and archived them first. It was
// written from seeds/cascade-tools-js-improvements.md §C, which proposed
// delete_doc / rename_doc - a proposal authored by an instance, never decided by
// the user. It is exactly the audit candidate the meta-layer index has open: content
// in the record that reads as the user's and is not.
// ============================================

/**
 * Mark a document obsolete. Nothing is removed and nothing is archived, because
 * nothing is lost: the row keeps its id, its content, its version and its
 * digest. list_docs and startup keep it, marked, after the current documents.
 *
 * This is the document-store analogue of revise_memory marking a parent
 * superseded, and it is a sanctioned write for the same reason: it is a
 * supersession marker, not a content write, and it has exactly one door.
 * Reversible by writing the document again - write_doc clears the flag.
 */
export async function retireDoc(doc_id, reason = null, retired_by = null, logger = null, options = {}) {
  try {
    if (!doc_id || typeof doc_id !== 'string') throw new ValidationError('doc_id must be a non-empty string');
    refuseBotMainRecord(doc_id, retired_by, 'retire_doc', { cleanup: true });
    refuseBotRetireRename(retired_by, 'retire_doc');
    if (doc_id === stateDoc()) throw new ValidationError('retire_doc: the board is never retired. Edit it with patch_doc and a reason. Nothing was changed.');
    if (!isDropDoc(doc_id) && !(options && options.fromRename)) throw new ValidationError(`retire_doc: ${doc_id} is not a drop. Working documents are edited, not retired. Nothing was changed.`);
    if (typeof reason !== 'string' || reason.trim().length < 10) throw new ValidationError('retire_doc needs reason (at least 10 characters), naming where the drop went. Nothing was changed.');

    const { client, col } = await _docsClient();
    try {
      const doc = await col.findOne({ doc_id });
      if (!doc) throw new ValidationError(`Document not found: ${doc_id}`);
      if (doc.retired) {
        return { doc_id, retired: true, already_retired: true, verified: true,
                 retired_at: doc.retired_at, retired_reason: doc.retired_reason || null,
                 version: doc.version, sha256: doc.sha256 };
      }

      const now = new Date();
      await col.updateOne({ doc_id }, { $set: {
        retired: true,
        retired_at: now,
        retired_by: retired_by || setting('SOURCE_TAG') || null,
        retired_reason: reason || null,
        retired_person_id: (await import('./persons.js').then((m) => m.currentPersonId())) || null,
        retired_client_id: (await import('./persons.js').then((m) => m.currentClientId())) || 'stdio',
        retired_session_id: (options && options.session_id) || null
      } });

      // aleph: the mark is not set because the call returned. Content and
      // digest are re-checked too - retiring must not touch either.
      const check = await col.findOne({ doc_id });
      if (!check || check.retired !== true) {
        throw new DatabaseError(`Retirement mark did not persist: ${doc_id}`, 'retire_doc');
      }
      if (check.sha256 !== doc.sha256 || check.version !== doc.version) {
        throw new DatabaseError(`Retiring altered the document: ${doc_id}`, 'retire_doc');
      }

      // L5 - retirement is not an escape hatch. retireDoc is the one document
      // write that deliberately does NOT pass through writeDoc(): it changes
      // visibility, never content, and re-running the whole content pipeline
      // for a flag would be a second door for no gain. That is exactly why the
      // marker has to be set HERE rather than assumed to have been set there.
      // Nothing is blocked - the retirement stands and carries its mark.
      let conformance = null;
      if (isGovernedByShippedCopy(doc_id) || templateFor(doc_id)) {
        conformance = {
          template: templateFor(doc_id), template_status: null,
          verdict: CONFORMANCE_VERDICT.NONCONFORMING,
          failures: [`${doc_id} is a controlled document and has been retired; the checks that governed it stop here (L5)`],
          warnings: [], checked_at: new Date().toISOString()
        };
        await col.updateOne({ doc_id }, { $set: { conformance } });
      }

      return { doc_id, retired: true, verified: true, retired_at: now, conformance,
               retired_reason: reason || null, version: check.version,
               sha256: check.sha256, content_unchanged: true,
               note: 'Content retained at this id. list_docs keeps it after the current documents, marked with retired_at and, when a rename replaced it, what replaced it. read_doc still returns it. Nothing was deleted.' };
    } finally { await client.close(); }
  } catch (error) {
    if (error instanceof ValidationError || error instanceof EmetError) throw error;
    throw new DatabaseError(`Failed to retire document: ${error.message}`, 'retire_doc');
  }
}

export async function renameDoc(old_id, new_id, updated_by = null, logger = null, reason = null, options = {}) {
  try {
    if (!old_id || typeof old_id !== 'string') throw new ValidationError('old_id must be a non-empty string');
    if (!new_id || typeof new_id !== 'string') throw new ValidationError('new_id must be a non-empty string');
    if (old_id === new_id) throw new ValidationError('old_id and new_id name the same document');
    refuseBotMainRecord(old_id, updated_by, 'rename_doc', { cleanup: true });
    refuseBotMainRecord(new_id, updated_by, 'rename_doc');
    refuseBotRetireRename(updated_by, 'rename_doc');
    if (typeof reason !== 'string' || reason.trim().length < 10) throw new ValidationError('rename_doc needs reason (at least 10 characters). Nothing was changed.');
    if (old_id === stateDoc() || new_id === stateDoc()) throw new ValidationError('rename_doc: the board is never renamed. Nothing was changed.');
    if (isDropDoc(old_id) || isDropDoc(new_id)) throw new ValidationError('rename_doc: a drop is write-once. Use a new id. Nothing was changed.');

    let content, path_hint;
    const { client, col } = await _docsClient();
    try {
      const source = await col.findOne({ doc_id: old_id });
      if (!source) throw new ValidationError(`Document not found: ${old_id}`);
      // Never clobber. A rename onto an occupied id is a MERGE decision, and a
      // merge is not something to guess at on the caller's behalf.
      const occupied = await col.findOne({ doc_id: new_id });
      if (occupied) {
        throw new ValidationError(`Destination already exists: ${new_id} (version ${occupied.version}). Rename refused; nothing was changed.`);
      }
      content = source.content;
      path_hint = source.path_hint || null;
    } finally { await client.close(); }

    // One write path: the new id is created through writeDoc, so it inherits
    // the same redaction, digest, versioning and sha256 read-back as any other
    // write rather than getting a second, parallel implementation.
    // `reissued_from` carries the L5 question to the door, so the mark is set
    // by the same write that creates the document rather than by a second one.
    const written = await writeDoc(new_id, content, updated_by, path_hint, logger, { reissued_from: old_id, reason, session_id: options && options.session_id });

    // Ordering is deliberate: the copy exists and is verified BEFORE the old id
    // is marked obsolete. Nothing is removed at any point - a "rename" here is a
    // reissue plus an obsolescence mark, which is what document control actually
    // asks for. The old id keeps its content and stays readable at its own id.
    const retired = await retireDoc(old_id, `Reissued as ${new_id}`, updated_by, logger, { fromRename: true });

    return {
      from: old_id, to: new_id, verified: written.verified === true && retired.verified === true,
      conformance: written.conformance || null,
      sha256: written.sha256, version: written.version, size: written.size,
      redacted: written.redacted,
      old_id_retired: true, old_id_retired_at: retired.retired_at,
      old_content_retained: true,
      note: `${old_id} is retained and readable at its own id, marked obsolete, and list_docs keeps it after the current documents with retired_at and replaced_by ${new_id}. Nothing was deleted.`
    };
  } catch (error) {
    if (error instanceof ValidationError || error instanceof EmetError) throw error;
    throw new DatabaseError(`Failed to rename document: ${error.message}`, 'rename_doc');
  }
}

async function unretiredBootDrops(session_id) {
  if (!session_id || typeof session_id !== 'string' || !String(session_id).trim()) {
    throw new ValidationError('a board edit or restore needs session_id from emet_session_open, with a verified drop list. Nothing was written.');
  }
  const base = String(session_id).replace(/_verbatim_part\d+$/, '').trim();
  if (!base) {
    throw new ValidationError('a board edit or restore needs session_id from emet_session_open, with a verified drop list. Nothing was written.');
  }
  const { COLLECTION_PREFIX } = await import('./database.js');
  const client = await connectMongo(MONGODB_URI, { serverSelectionTimeoutMS: dropListTimeoutMs(), maxPoolSize: 10 });
  try {
    const db = client.db(MONGODB_DB);
    const row = await db.collection(`${COLLECTION_PREFIX}sessions`).findOne({ _id: base });
    if (!row || row.drops_unverified === true || !Array.isArray(row.drops_seen)) {
      throw new ValidationError('unhandled drops could not be loaded at this session boot, so the board cannot be edited or restored until the list is known. Nothing was written.');
    }
    const listed = row.drops_seen;
    if (!listed.length) return [];
    const open = await db.collection('documents').find({ doc_id: { $in: listed }, retired: { $ne: true } }).toArray();
    return open.map((d) => d.doc_id);
  } finally { await client.close(); }
}

export async function restoreDoc(doc_id, version, updated_by = null, logger = null, reason = null, options = {}) {
  refuseBotMainRecord(doc_id, updated_by, 'restore_doc');
  refuseBotRetireRename(updated_by, 'restore_doc');
  if (typeof reason !== 'string' || reason.trim().length < 10) throw new ValidationError('restore_doc needs reason (at least 10 characters). Nothing was written.');
  if (!updated_by) throw new ValidationError('restore_doc needs a source. Nothing was written.');
  if (isDropDoc(doc_id)) throw new ValidationError('restore_doc: a drop is never restored. Nothing was written.');
  if (isRecordDoc(doc_id)) throw new ValidationError('restore_doc: a record is not restored. Records are superseded via revise_memory, not restored. Nothing was written.');
  if (isGovernedByShippedCopy(doc_id)) throw new ValidationError('restore_doc: a shipped copy is not restored. Nothing was written.');
  const allowed = (setting('RESTORE_TAGS') || setting('SOURCE_TAG') || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!allowed.includes(updated_by)) throw new ValidationError(`restore_doc: ${updated_by} is not in EMET_RESTORE_TAGS. Nothing was written.`);
  const prior = await readDocHistory(doc_id, version, logger);
  if (!prior || typeof prior.content !== 'string') throw new ValidationError(`No retained revision ${version} of ${doc_id}`);
  if (prior.integrity !== true) throw new ValidationError(`restore_doc: retained revision ${version} of ${doc_id} does not match its digest. Nothing was written.`);
  const verdict = prior.conformance && prior.conformance.verdict;
  const accepted = prior.conformance && prior.conformance.accepted;
  if (!verdict) {
    if (templateFor(doc_id)) throw new ValidationError(`restore_doc: ${doc_id} is templated and the retained revision has no conformance verdict. Only an untemplated document can be restored without a verdict. Nothing was written.`);
  } else if (verdict !== 'conforms' && verdict !== 'untemplated' && !accepted) {
    throw new ValidationError(`restore_doc: retained revision ${version} of ${doc_id} was not conforming. Nothing was written.`);
  }
  const current = await readDoc(doc_id, logger).catch(() => null);
  const checked = validateDocument(doc_id, prior.content, current && current.content);
  const lost = (checked.failures || []).filter((f) => /no disposition/.test(f));
  if (doc_id === stateDoc() && (await unretiredBootDrops(options && options.session_id)).length) {
    throw new ValidationError('restore_doc: unhandled drops were listed at this session boot and must be retired with retire_doc before the board is restored. Nothing was written.');
  }
  const written = await writeDoc(doc_id, prior.content, updated_by, null, logger, { restore_of: version, reason, session_id: options && options.session_id, supersedes: current && current.version });
  return { ...written, rows_lost: lost, restored_from_version: version };
}

// ============================================
// TEMPLATE VALIDATION - freestanding (STANDARD 9)
// ============================================
//
// The same check the door runs, callable without writing anything. Three uses,
// all of them the reason it exists separately: auditing records written before
// validation existed, counting what adoption will mark BEFORE it marks it, and
// checking a new local template against the standard before anyone fills it.

export async function validateDoc(options = {}, logger = null) {
  const { doc_id = null, content = null, template_id = null } = options || {};
  try {
    if (!doc_id && !content) {
      throw new ValidationError(
        'Give a doc_id to check a stored document, or content (with template_id) to check text that is not stored yet.'
      );
    }

    if (content) {
      const tpl_id = template_id || (doc_id ? templateFor(doc_id) : null);
      if (!tpl_id) {
        return { checked: doc_id || '(content)', template: null, verdict: CONFORMANCE_VERDICT.UNTEMPLATED,
                 failures: [], warnings: ['No template_id was given and no map entry matches, so nothing governs this content.'] };
      }
      const template = loadShipped(tpl_id);
      if (!template) throw new ValidationError(`No template ${tpl_id} ships with this release.`);
      const r = checkRecord(content, template, { doc_id });
      return { checked: doc_id || '(content)', template: tpl_id, template_status: template.status,
               verdict: r.failures.length ? CONFORMANCE_VERDICT.NONCONFORMING : CONFORMANCE_VERDICT.CONFORMS,
               failures: r.failures, warnings: r.warnings, stored: false,
               note: 'Checked against the copy shipped with this release (L1). Nothing was written.' };
    }

    const { client, col, hist } = await _docsClient();
    try {
      const doc = await col.findOne({ doc_id });
      if (!doc) throw new ValidationError(`Document not found: ${doc_id}`);
      // The carry-forward check needs the revision before this one, which is
      // exactly what the history collection archived when this one was written.
      const prior = await hist.find({ doc_id }).sort({ version: -1 }).limit(1).toArray();
      const result = validateDocument(doc_id, doc.content, prior.length ? prior[0].content : null);
      return {
        checked: doc_id, version: doc.version, stored: false,
        compared_against_revision: prior.length ? prior[0].version : null,
        ...result,
        stored_verdict: doc.conformance ? doc.conformance.verdict : null,
        note: 'Nothing was written. To record a disposition for a standing marker, use accept_nonconformance; to clear one, revise the document so it passes.'
      };
    } finally { await client.close(); }
  } catch (error) {
    if (error instanceof ValidationError || error instanceof EmetError) throw error;
    throw new DatabaseError(`Failed to validate document: ${error.message}`, 'validate_doc');
  }
}

/**
 * Record the written disposition STANDARD 9 requires for a nonconformance that
 * will not be corrected. The marker is KEPT, with the acceptance beside it -
 * never deleted, and never silently cleared. It covers the one revision it
 * names (L6); the next revision is validated fresh.
 */
export async function acceptNonconformance(doc_id, reason, accepted_by = null, logger = null, options = {}) {
  try {
    refuseBotMainRecord(doc_id, accepted_by, 'accept_nonconformance');
    if (!doc_id || typeof doc_id !== 'string') throw new ValidationError('doc_id must be a non-empty string');
    if (typeof reason !== 'string' || reason.trim().length < 10) {
      throw new ValidationError(
        'An acceptance needs a written reason of at least 10 characters. It is the disposition of ' +
        'record for a nonconformance and is what an audit reads later - the same rule revise_transcript uses.'
      );
    }
    const { client, col } = await _docsClient();
    try {
      const doc = await col.findOne({ doc_id });
      if (!doc) throw new ValidationError(`Document not found: ${doc_id}`);
      const current = doc.conformance;
      if (!current || current.verdict !== CONFORMANCE_VERDICT.NONCONFORMING) {
        throw new ValidationError(
          `${doc_id} version ${doc.version} carries no nonconformance marker, so there is nothing to accept. ` +
          `Its verdict is "${current ? current.verdict : 'not yet checked'}".`
        );
      }
      const { currentPersonId, currentClientId } = await import('./persons.js');
      const accepted = buildAcceptance({
        reason, by: accepted_by || setting('SOURCE_TAG') || null, version: doc.version,
        person_id: currentPersonId() || null,
        client_id: currentClientId() || 'stdio',
        session_id: (options && options.session_id) || null
      });
      await col.updateOne({ doc_id }, { $set: { 'conformance.accepted': accepted } });
      // aleph: the disposition is not recorded because the call returned.
      const check = await col.findOne({ doc_id });
      const stored = check && check.conformance && check.conformance.accepted;
      if (!stored || stored.reason !== accepted.reason || Number(stored.covers_version) !== Number(doc.version)) {
        throw new DatabaseError(`The acceptance did not persist on ${doc_id}.`, 'accept_nonconformance');
      }
      return {
        doc_id, verified: true, version: doc.version, covers_version: doc.version,
        accepted, failures_accepted: current.failures || [],
        note: 'The marker is retained with this acceptance beside it. It covers this revision only - the next write is validated fresh, and accepted markers stay counted at session start, separately from open ones.'
      };
    } finally { await client.close(); }
  } catch (error) {
    if (error instanceof ValidationError || error instanceof EmetError) throw error;
    throw new DatabaseError(`Failed to accept nonconformance: ${error.message}`, 'accept_nonconformance');
  }
}

// ============================================
// DOC-STORE PARTIAL UPDATES (added 2026-08-24)
// Server-side read-modify-write. The whole point: existing content never
// crosses the wire, so document size stops being bounded by an MCP client's
// context/output budget. All three delegate the actual write to writeDoc(),
// which owns archiving to documents_history, version increment, and the
// sha256 read-back -- one write path, not four.
// ============================================

function _assertStr(v, name) {
  if (typeof v !== 'string' || v.length === 0) {
    throw new ValidationError(`${name} must be a non-empty string`);
  }
}

function _assertVersion(cur, expected_version, tool) {
  if (expected_version === undefined || expected_version === null) return;
  if (cur.version !== expected_version) {
    throw new ValidationError(
      `${tool}: version conflict - document is at v${cur.version}, caller expected v${expected_version}. Re-read and retry.`
    );
  }
}

/** Find `needle` in `hay`; require exactly one occurrence. Returns [before, after]. */
function _splitUnique(hay, needle, tool, what, doc_id) {
  const parts = hay.split(needle);
  const n = parts.length - 1;
  if (n === 0) throw new ValidationError(`${tool}: ${what} not found in ${doc_id}`);
  if (n > 1) {
    throw new ValidationError(
      `${tool}: ${what} matches ${n} times in ${doc_id} - must match exactly once. Add surrounding context to disambiguate.`
    );
  }
  return [parts[0], parts[1]];
}

export async function patchDoc(doc_id, old_str, new_str, updated_by = null, expected_version = null, logger = null, options = {}) {
  try {
    _assertStr(doc_id, 'doc_id');
    refuseBotMainRecord(doc_id, updated_by, 'patch_doc');
    _refuseRecordAmendment(doc_id, 'patch_doc');
    if (!(Array.isArray(options.edits) && options.edits.length)) _assertStr(old_str, 'old_str');
    const reason = options && options.reason;
    if (typeof reason !== 'string' || reason.trim().length < 10) {
      throw new ValidationError('patch_doc needs reason (at least 10 characters). Nothing was written.');
    }
    const cur = await readDoc(doc_id, logger);
    _assertVersion(cur, expected_version, 'patch_doc');
    if (isDropDoc(doc_id)) throw new ValidationError('patch_doc: a drop is write-once. Use a new id. Nothing was written.');
    const edits = Array.isArray(options.edits) && options.edits.length
      ? options.edits
      : [{ old_str, new_str }];
    for (const edit of edits) {
      if (typeof edit.old_str !== 'string' || edit.old_str.length === 0) throw new ValidationError('old_str must be a non-empty string');
      if (typeof edit.new_str !== 'string') throw new ValidationError('new_str must be a string (empty string allowed = delete)');
      _splitUnique(cur.content, edit.old_str, 'patch_doc', 'old_str', doc_id);
    }
    const spans = edits.map((edit) => {
      const at = cur.content.indexOf(edit.old_str);
      return { at, len: edit.old_str.length, new_str: edit.new_str };
    });
    const ordered = [...spans].sort((a, b) => a.at - b.at);
    for (let i = 1; i < ordered.length; i++) {
      if (ordered[i].at < ordered[i - 1].at + ordered[i - 1].len) throw new ValidationError('patch_doc: edits overlap. Nothing was written.');
    }
    let next = cur.content;
    for (const span of [...spans].sort((a, b) => b.at - a.at)) next = next.slice(0, span.at) + span.new_str + next.slice(span.at + span.len);
    if (doc_id === stateDoc()) {
      if ((await unretiredBootDrops(options && options.session_id)).length) throw new ValidationError('patch_doc: unhandled drops were listed at this session boot and must be retired with retire_doc before the board is edited. Nothing was written.');
      const ids = (text) => new Set([...String(text || '').matchAll(/\bB-\d+\b/g)].map((m) => m[0]));
      const added = [...ids(next)].filter((id) => !ids(cur.content).has(id));
      if (added.length && !(options && options.origin)) throw new ValidationError('patch_doc: an added board row needs origin. Nothing was written.');
      const checked = validateDocument(doc_id, next, cur.content);
      if (checked && checked.verdict === 'nonconforming') {
        throw new ValidationError(`patch_doc: the board edit is nonconforming. ${(checked.failures || []).join('; ')} Nothing was written.`);
      }
    }
    const res = await writeDoc(doc_id, next, updated_by, null, logger, { edited: true, reason, origin: options.origin || null, session_id: options.session_id || null });
    return { ...res, previous_version: cur.version, replaced: edits.length,
             size_delta: next.length - cur.content.length };
  } catch (error) {
    if (error instanceof ValidationError || error instanceof EmetError) throw error;
    throw new DatabaseError(`Failed to patch document: ${error.message}`, 'patch_doc');
  }
}

// Restored 2026-09-19: both constants were dropped in an earlier commit while the function
// kept referencing them, which made every semantic_recall call throw
// "SEMANTIC_RECALL_LAYERS is not defined".
const SEMANTIC_RECALL_LAYERS = ['episodic', 'semantic', 'procedural', 'meta', 'identity', 'working'];
const SEMANTIC_RECALL_INDEX = process.env.EMET_VECTOR_INDEX || 'emet_content_auto';

export async function semanticRecall(query, layer = null, limit = 10, logger = null, options = null, dbManager = null) {
  try {
    if (!query || typeof query !== 'string' || query.trim() === '') {
      throw new ValidationError('query', 'query must be a non-empty string');
    }
    if (query.length > CONTENT_LIMITS.MAX_QUERY_LENGTH) {
      throw new ValidationError('query', `query exceeds maximum length of ${CONTENT_LIMITS.MAX_QUERY_LENGTH}`);
    }
    const validatedLimit = validateLimit(limit);
    const layers = layer ? [validateLayer(layer)] : SEMANTIC_RECALL_LAYERS;
    // vectorRecall is the in-memory stand-in. Production has no such method
    // and uses Atlas. The stand-in lets a test see history and rank without a
    // vector index. It does not change what Atlas returns.
    const useStandIn = !!(dbManager && typeof dbManager.vectorRecall === 'function');

    const client = useStandIn ? null : await connectMongo(MONGODB_URI, { serverSelectionTimeoutMS: 5000, maxPoolSize: 10 });
    try {
      const db = client ? client.db(MONGODB_DB) : null;
      const results = [];
      for (const l of layers) {
        if (useStandIn) {
          const docs = await dbManager.vectorRecall(l, query.trim(), validatedLimit);
          results.push(...collectSemanticHits(docs, l));
          continue;
        }
        const col = db.collection(`${COLLECTION_PREFIX}${l}`);
        const docs = await col.aggregate([
          { $vectorSearch: {
              index: SEMANTIC_RECALL_INDEX,
              path: 'content',
              query: query.trim(),
              numCandidates: candidateBound(validatedLimit),
              limit: validatedLimit,
              // THE INDEX-LEVEL PRE-FILTER ON is_live WAS REMOVED 2026-09-13.
              // It excluded superseded rows from Atlas before ranking, which is
              // exactly what the user's decision reverses: a parent surfaces so
              // a revision is read in the context of what it revised.
              //
              // THE COST, STATED RATHER THAN DISCOVERED LATER: this is a ranked
              // top-N path, so both halves of a supersession chain can now occupy
              // slots that previously held two distinct entries. That is the price
              // of the context, and it is a real one on this path in a way it is
              // not on the unranked paths. If it bites, the fix is to rank the
              // chain as one and return the live entry with its parent attached -
              // NOT to quietly re-hide the parent.
              //
              // is_live remains a `filter` field on the configured vector index on
              // all six layers; nothing was removed from the index. Retained note:
              // {superseded_by: {$eq: null}} returns ZERO rows here because vector
              // filters do not match null, which is why the boolean exists at all.
          } },
          { $project: { _id: 0, id: 1, timestamp: 1, content: 1, context: 1,
                        importance: 1, emotional_intensity: 1, metadata: 1, sha256: 1, metadata_sha256: 1,
                        superseded_by: 1, superseded_at: 1, valid_until: 1, is_live: 1,
                        score: { $meta: 'vectorSearchScore' } } }
        ]).toArray();
        // Expired and superseded hits stay. collectSemanticHits marks them;
        // it does not drop them. Current entries rank ahead of ended ones.
        results.push(...collectSemanticHits(docs, l));
      }
      const ranked = rankSemanticHits(results, query);
      const top = applyReadLimit(ranked, validatedLimit, options && options.history === true);
      logger?.info('Semantic recall completed', { layers: layers.length, resultsFound: top.length });
      return { count: top.length, query: query.trim(), layers_searched: layers, results: top };
    } finally { if (client) await client.close(); }
  } catch (error) {
    if (error instanceof ValidationError || error instanceof EmetError) throw error;
    throw new DatabaseError(`Failed semantic recall: ${error.message}`, 'semantic_recall');
  }
}



// ============================================
// TOOL DEFINITIONS
// ============================================

/**
 * MCP tool definitions
 */

// ============================================
// CORPUS RECALL (Stage B, 2026-07-27)
// Semantic search over an optional corpus collection you populate yourself.
// ============================================

const CORPUS_RECALL_INDEX = process.env.EMET_CORPUS_INDEX || 'corpus_content_auto';
// Corpus names are whatever you populate. Empty by default - this tool returns
// nothing until you load documents into the corpus collection yourself.
const CORPUS_VALUES = (process.env.EMET_CORPORA || '').split(',').map(s => s.trim()).filter(Boolean);

export async function corpusRecall(query, corpus = null, limit = 5, logger = null) {
  try {
    if (!query || typeof query !== 'string' || query.trim() === '') {
      throw new ValidationError('query', 'query must be a non-empty string');
    }
    if (query.length > CONTENT_LIMITS.MAX_QUERY_LENGTH) {
      throw new ValidationError('query', `query exceeds maximum length of ${CONTENT_LIMITS.MAX_QUERY_LENGTH}`);
    }
    const validatedLimit = Math.min(Math.max(parseInt(limit) || 5, 1), 25);
    // An empty EMET_CORPORA means "unrestricted", not "nothing allowed".
    if (corpus && CORPUS_VALUES.length && !CORPUS_VALUES.includes(corpus)) {
      throw new ValidationError('corpus', `corpus must be one of: ${CORPUS_VALUES.join(', ')}`);
    }
    const client = await connectMongo(MONGODB_URI, { serverSelectionTimeoutMS: 5000, maxPoolSize: 10 });
    try {
      const db = client.db(MONGODB_DB);
      const col = db.collection(process.env.EMET_CORPUS_COLLECTION || 'corpus_chunks');
      // Native corpus filter on the index (filter field added 2026-07-27); dedupe post-search.
      const fetchN = validatedLimit * 3;
      const vs = {
        index: CORPUS_RECALL_INDEX,
        path: 'content',
        query: query.trim(),
        numCandidates: Math.max(fetchN * 20, 300),
        limit: fetchN
      };
      if (corpus) vs.filter = { corpus: { $eq: corpus } };
      const docs = await col.aggregate([
        { $vectorSearch: vs },
        { $project: { _id: 1, corpus: 1, video_id: 1, video_title: 1, url: 1, chunk_seq: 1,
                      start_sec: 1, content: 1, epistemic: 1, work: 1, story_num: 1, topic: 1,
                      score: { $meta: 'vectorSearchScore' } } }
      ]).toArray();
      const filtered = corpus ? docs.filter(d => d.corpus === corpus) : docs;
      const perKey = {}; const out = [];
      for (const d of filtered) {
        const key = `${d.corpus}:${d.video_id || d.work || d.video_title}`;
        perKey[key] = (perKey[key] || 0) + 1;
        if (perKey[key] <= 2) out.push(d);
        if (out.length >= validatedLimit) break;
      }
      const results = out.map(d => ({
        corpus: d.corpus,
        title: d.video_title,
        url: d.url ? (d.start_sec != null ? `${d.url}&t=${Math.floor(d.start_sec)}s` : d.url) : null,
        start_sec: d.start_sec != null ? d.start_sec : null,
        epistemic: d.epistemic || null,
        score: d.score,
        content: d.content,
        chunk_id: d._id
      }));
      logger?.info('Corpus recall completed', { corpus: corpus || 'all', resultsFound: results.length });
      return { count: results.length, query: query.trim(), corpus: corpus || 'all', results };
    } finally { await client.close(); }
  } catch (error) {
    if (error instanceof ValidationError || error instanceof EmetError) throw error;
    throw new DatabaseError(`Failed corpus recall: ${error.message}`, 'corpus_recall');
  }
}

import { digest, verifyDocument, verifyLayerEntry, integrityOf, digestMetadata, metadataIntegrityOf, signDigests, signatureIntegrityOf, signatureCoversPriorMetadata, chainIntegrityOf, AlephError } from './aleph.js';
import { parseMetadata } from './metadata.js';
export { parseMetadata, isLegacyMetadataString, isMetadataPath } from './metadata.js';
import { validateProvenance, provenanceColumns } from './provenance.js';
export { validateProvenance, provenanceColumns, resolveProvenance, crossCheckProvenance } from './provenance.js';
export { digest, verifyDocument, verifyLayerEntry, integrityOf, canonicalJson, digestMetadata, metadataIntegrityOf, signDigests, signatureIntegrityOf, signatureCoversPriorMetadata, AlephError } from './aleph.js';
import { annotate } from './annotations.js';
export { sessionClose, CLOSE_PROTOCOL } from './session.js';
export { findGaps, gapCounts, GAP_CLASSES } from './gaps.js';
export { TOOL_ANNOTATIONS } from './annotations.js';

export { DISCIPLINE_SUMMARY } from './disciplines.js';
export { FLOOR, FLOOR_REASSERTION, FLOOR_SECTIONS, PRECEDENCE, readFloor } from './floor.js';

export {
  initialize,
  setupStatus,
  setupComplete,
  verifyConnection,
  SETUP_INTERVIEW
} from './setup.js';

/**
 * Who may mint a guest or member code. The local stdio actor has no person id
 * and is the owner. HTTP still requires a loaded person whose role is owner.
 * An in-process actor that names a person is checked the same way.
 */
async function codeCreator(dbManager, refusal) {
  const { currentActor, getPerson } = await import('./persons.js');
  const actor = currentActor();
  if (actor.transport === 'stdio' || (actor.transport !== 'http' && !actor.personId)) {
    return actor.personId || LOCAL_SUBJECT;
  }
  if (!actor.personId) throw new ValidationError(refusal);
  const person = await getPerson(dbManager.db, actor.personId);
  if (!person || person.role !== 'owner') throw new ValidationError(refusal);
  return actor.personId;
}

export async function inviteCreate(dbManager, { display_name, scopes, days, source } = {}, logger = null) {
  if (!display_name || !String(display_name).trim()) {
    throw new ValidationError('display_name is required — the name the guest will be known by');
  }
  await dbManager.getConnection('working');
  const { createInvite, INVITES_FROZEN, INVITES_FROZEN_REASON } = await import('./invites.js');
  if (INVITES_FROZEN) throw new ValidationError(INVITES_FROZEN_REASON);
  const { registeredSourceTags } = await import('./setup.js');
  const actor = await codeCreator(dbManager, 'Only the owner can create invites');
  const requested = Array.isArray(scopes) ? scopes : ['emet.read'];
  if (requested.length !== 1 || requested[0] !== 'emet.read') {
    throw new ValidationError('A guest invite accepts only emet.read');
  }
  const registry = registeredSourceTags();
  const tag = typeof source === 'string' ? source.trim() : '';
  if (registry.length && tag && !registry.includes(tag)) {
    throw new ValidationError('source', 'A guest invite source must be a registered tag. Nothing was created.');
  }
  const out = await createInvite(dbManager.db, {
    created_by: actor,
    display_name,
    scopes: ['emet.read'],
    days: days || 14,
    source_tag: tag || null
  });
  logger?.info?.('Invite created', { display_name: out.display_name });
  return {
    ...out,
    note: 'Show the code once. It is not stored in the clear. The guest pastes it on the connect screen instead of the passphrase.'
  };
}

export async function memberAccessCreate(dbManager, { display_name, days, source } = {}, logger = null) {
  if (!display_name || !String(display_name).trim()) {
    throw new ValidationError('display_name is required \u2014 the name the member will be known by');
  }
  await dbManager.getConnection('working');
  const { createMemberAccess, MEMBER_ACCESS_FROZEN, MEMBER_ACCESS_FROZEN_REASON } = await import('./invites.js');
  if (MEMBER_ACCESS_FROZEN) throw new ValidationError(MEMBER_ACCESS_FROZEN_REASON);
  const { registeredSourceTags } = await import('./setup.js');
  const actor = await codeCreator(dbManager, 'Only the owner can create EMET Member Access');
  const registry = registeredSourceTags();
  const tag = typeof source === 'string' ? source.trim() : '';
  if (registry.length && tag && !registry.includes(tag)) {
    throw new ValidationError('source', 'A member code source must be a registered tag. Nothing was created.');
  }
  const out = await createMemberAccess(dbManager.db, { created_by: actor, display_name, days: days || 14, source_tag: tag || null });
  logger?.info?.('EMET Member Access created', { display_name: out.display_name });
  return {
    ...out,
    label: 'EMET Member Access',
    note: 'Show the code once. It is not stored in the clear. This is not EMET Guest Access. The person pastes it on the connect screen. They get a new person id with read and write access, never the owner identity.'
  };
}

// Raw tool definitions. Exported as TOOLS below, with annotations attached.
const TOOL_DEFINITIONS = [
  {
    name: "emet_initialize",
    description: "START HERE. Call this FIRST in every session, before answering anything that might have prior context, and always when the user opens with 'initialize', 'start', 'begin', 'hello' or similar. It is the only setup step a user should ever have to know about. A large startup comes in pages: read `page_notice` first and call again with the page it names until the last page, before replying. If this memory store is new it returns a short interview to run conversationally; if it is established it returns who you are, how you speak (`character`, when the store keeps one - authoritative on voice for the whole session), who you are serving, and where things were left. The user never needs to know which case applied.",
    inputSchema: {
      type: "object",
      properties: {
        recent_limit: { type: "number", description: "How many recent context entries to return (default 5)." },
        page: { description: "The startup is served in pages when it is larger than one result (each page fits under 20,000 bytes). Omit for page 1; every page but the last says which page to ask for next - call again with that page, before replying, until a page says it is the last. \"all\" returns the whole startup in one result, for a host with no size limit." },
        load_id: { type: "string", description: "The load_id your startup returned in `startup_page.load_id`: every emet_initialize result carries one (each page of a paged startup, the whole startup with page \"all\" or when it fits one result, and a store that is not set up yet). Pass it with every later page so all pages come from the same startup, and pass the same load_id to emet_session_open so its startup page check runs on this startup." }
      }
    }
  },
  {
    name: "emet_status",
    description: "Diagnostic in one call (replaces emet_setup_status, get_status and emet_verify_connection, 2026-09-27). Reports environment, database, collections, vector index, whether identity and user documents exist, and per-layer counts and health. Pass probe: true to also prove the write path - connect, write a probe document, read the same value back, remove it; a read alone cannot reveal a broken write path. Prefer emet_initialize for a normal session start.",
    inputSchema: {
      type: "object",
      properties: {
        probe: { type: "boolean", description: "Also write and read back a probe document (default false). Use after a deploy or a configuration change." }
      }
    }
  },
  {
    name: "emet_setup_complete",
    description: "First-time setup, the owner's only: record the user's interview answers as bootstrap/IDENTITY.md, bootstrap/CHARACTER.md and bootstrap/USER.md and as an identity-layer entry, and create the owner person. Every write is read-back verified. Refused under a bot tag. On a store that is already set up it is refused unless reissue is true (the owner's explicit word): a re-run writes new versions of the user's identity documents; prior versions are archived, never destroyed.",
    inputSchema: {
      type: "object",
      properties: {
        answers: {
          type: "object",
          description: "Answers keyed exactly as the interview questions returned by emet_initialize.",
          properties: {
            assistant_name: { type: "string" },
            assistant_character: { type: "string" },
            user_name: { type: "string" },
            user_context: { type: "string" },
            user_preferences: { type: "string" },
            source_tag: { type: "string" }
          },
          required: ["assistant_name", "assistant_character", "user_name", "user_context"]
        },
        reissue: { type: "boolean", description: "Only on the owner's explicit word: re-run setup on a store that is already set up. Without it, a re-run is refused and nothing is written." },
        source: { type: "string", description: "Your source tag. Setup is refused under a bot tag." }
      },
      required: ["answers"]
    }
  },
  {
    name: "corpus_recall",
    description: "Semantic search over an optional supplementary knowledge corpus that the user has loaded separately from memory. Returns nothing unless a corpus has been populated; this is not where session memory lives.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Natural-language query (raw text; concept match, phrased however the experience is phrased)"
        },
        corpus: {
          type: "string",
                    description: "Optional: restrict to one corpus name"
        },
        limit: {
          type: "number",
          description: "Max results (default 5, max 25)"
        }
      },
      required: ["query"]
    }
  },

  {
    name: "recall",
    description: "Search memories by keyword. Ranked by how many of your words match, then by importance. Current entries come first in every order. Pass order: 'latest' for time order. A standalone latest, newest, or most recent, together with other words, also asks for time order: it reorders those matches and does not change which rows match. A hyphenated word such as latest-budget, a negated 'not the latest', and a bare 'latest' are ordinary keywords. Expired and superseded entries stay in the result, marked with their end date and what replaced them. Pass history: true to read ended entries when current ones fill the limit.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query to match against memory content. order: 'latest' is how you ask for time order. A standalone latest, newest, or most recent reorders the other words' matches."
        },
        layer: {
          type: "string",
          enum: ["episodic", "semantic", "procedural", "meta", "identity", "working"],
          description: "Optional: Search only in specific layer"
        },
        limit: {
          type: "number",
          description: "Maximum number of results to return (default: 10)"
        },
        history: {
          type: "boolean",
          description: "Return ended entries (superseded or expired), marked, up to limit. Default false: ended entries are included after current ones until limit."
        },
        order: {
          type: "string",
          enum: ["latest"],
          description: "Pass 'latest' for time order: current matches first, then newer ones. This does not change which rows match the query."
        }
      },
      required: ["query"]
    }
  },
  {
    name: "query_layer",
    description: "Query a specific memory layer with structured filters",
    inputSchema: {
      type: "object",
      properties: {
        layer: {
          type: "string",
          enum: ["episodic", "semantic", "procedural", "meta", "identity", "working"],
          description: "Memory layer to query"
        },
        options: {
          type: "object",
          description: "Query options with structured filters",
          properties: {
            filters: {
              type: "object",
              description: "Structured filter conditions (safe parameterized queries)",
              properties: {
                importance_min: { type: "number", description: "Minimum importance (0-1)" },
                importance_max: { type: "number", description: "Maximum importance (0-1)" },
                importance_bucket: { type: "string", description: "Named bucket: constitutive, durable, binding, event, or scratch. Maps to that band's numeric range so older rows still match." },
                emotional_intensity_min: { type: "number", description: "Minimum emotional intensity (0-1)" },
                emotional_intensity_max: { type: "number", description: "Maximum emotional intensity (0-1)" },
                timestamp_after: { type: "number", description: "Unix timestamp - memories after this time" },
                timestamp_before: { type: "number", description: "Unix timestamp - memories before this time" },
                content_contains: { type: "string", description: "Text to search in content/event" },
                context_contains: { type: "string", description: "Text to search in context" },
                id: { type: "number", description: "Exact memory ID" }
              }
            },
            limit: { type: "number", description: "Max results (1-1000, default: 10)" },
            order_by: { type: "string", description: "Sort field and direction, e.g. 'importance DESC' or 'timestamp DESC'. Fields: id, timestamp, importance, emotional_intensity, content, context. Default is importance descending. Current entries come first in every order, including timestamp. Anything else falls back to importance descending." },
            include_superseded: { type: "boolean", description: "Accepted, and it does not hide anything. Superseded and expired entries are always returned, marked with their end date and what replaced them. Current entries are listed first." },
            history: { type: "boolean", description: "Return ended entries only, up to limit, so a page full of current entries cannot leave them out. Default false: ended entries follow the current ones until limit." }
          }
        }
      },
      required: ["layer"]
    }
  },
  {
    name: "save_to_layer",
    description: "Save memory to a specific layer with full control over metadata. PASS session_id - your transcript session from emet_session_open - on every save made inside a session: the server stamps derived_from with the exchange in progress. Semantic and procedural entries are REFUSED without a source (session_id, or metadata.derived_from); nothing is written when refused.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: {
          type: "string",
          description: "Your transcript session id (from emet_session_open). The server reads that session's counter and stamps derived_from {session_id, exchange_start, exchange_end} with the exchange in progress. Ignored when metadata.derived_from is given. Required in practice for semantic and procedural saves made in a session."
        },
        layer: {
          type: "string",
          enum: ["episodic", "semantic", "procedural", "meta", "identity", "working"],
          description: "Target memory layer"
        },
        content: {
          type: "string",
          description: "Memory content to save"
        },
        metadata: {
          type: "object",
          description: "Full metadata control",
          properties: {
            importance: { description: "Bucket word (constitutive|durable|binding|event|scratch), optional :low|:mid|:high, or a number kept for compatibility." },
            importance_bucket: { type: "string", description: "constitutive|durable|binding|event|scratch" },
            importance_degree: { type: "string", description: "low|mid|high — only when degree inside the bucket matters" },
            emotional_intensity: { type: "number" },
            context: { type: "string" },
            source: { type: "string", description: "Which host produced this write. A shared default tag is ambiguity, not attribution." },
            tags: { type: "array", items: { type: "string" } },
            valid_until: { type: "number", description: "Unix seconds. After this the entry is marked ended and stays in recall and queries, with this date as its end date. It is not hidden and it is not deleted." },
            derived_from: {
              type: "object",
              description: "Where this entry came from, so the claim can be checked later. Either the transcript span it was drawn from - {session_id, exchange_start, exchange_end} - or, for an entry consolidated from other entries, {entries: [id, ...]}. One or the other, never both. REQUIRED on semantic and procedural entries unless session_id is passed (the server then stamps it): an assertion whose source cannot be reached is a claim the system merely happens to hold. Never guess - a nearest-timestamp guess recorded as a citation is worse than no citation."
            }
          }
        }
      },
      required: ["layer", "content"]
    }
  },
  {
    name: "revise_memory",
    description: "Supersede an existing entry with a revised one (supersession, not mutation). Creates a NEW entry carrying metadata.supersedes=<target_id> and marks the target with superseded_by and superseded_at. The old entry stays readable: it is not hidden and is_live is not cleared. Recall, query_layer and semantic_recall return it marked with that end date and the id of the new entry. The current entry is listed first. Episodic revision is prohibited - events are immutable.",
    inputSchema: {
      type: "object",
      properties: {
        layer: {
          type: "string",
          enum: ["semantic", "procedural", "meta", "identity", "working"],
          description: "Layer of the entry being revised (episodic is prohibited)"
        },
        target_id: {
          type: "number",
          description: "ID of the entry this revision supersedes"
        },
        content: {
          type: "string",
          description: "Full revised content - must stand alone without the superseded entry"
        },
        metadata: {
          type: "object",
          description: "Metadata for the new entry (supersedes is set automatically; include source tag)"
        }
      },
      required: ["layer", "target_id", "content"]
    }
  },
  {
    name: "revise_transcript",
    description: "Supersede a stored transcript part with a corrected one. Nothing is edited or deleted: a NEW document is written under the same session_id with an incremented revision and a pointer to its parent, and the parent is marked superseded. Use when a saved part has a mispaired, missing or wrong exchange. The reason parameter is required - an unexplained correction is a silent rewrite. To ADD a new part, use save_transcript instead. Allowed on a closed session (a correction deletes nothing), but there a revision may only correct the exchanges the part already holds - never add new ones - and must carry exactly the same exchange numbers (none dropped or repeated; numbers sent as text are stored as numbers).",
    inputSchema: {
      type: "object",
      properties: {
        session_id: {
          type: "string",
          description: "The session_id of the part to correct, e.g. '2026-09-04_x_verbatim_part14'. Must already exist."
        },
        exchanges: {
          type: "array",
          description: "The COMPLETE corrected exchange list for this part, verbatim. A revision replaces the whole part.",
          items: {
            type: "object",
            properties: {
              exchange_index: { type: "number" },
              user_message: { type: "string" },
              assistant_message: { type: "string" },
              timestamp: { type: "number" }
            }
          }
        },
        reason: {
          type: "string",
          description: "What was wrong and how this differs. Required, minimum 10 characters. This is the audit record of the correction."
        },
        session_start: { type: "number", description: "Optional. Defaults to the parent's." },
        session_end: { type: "number", description: "Optional. Defaults to the parent's." },
        source: { type: "string", description: "Source tag - which host produced this write. Defaults to the parent's." },
        channel: { type: "string", description: "Alias of `source` (the older name, kept one release). Prefer `source`." }
      },
      required: ["session_id", "exchanges", "reason"]
    }
  },
  {
    name: "query_transcripts",
    description: "Retrieve session transcripts - the second tier, word for word. Reads the live store written by save_transcript AND the legacy archive (exchanges written by earlier hosts, June 2025 to June 2026), grouped into the same session shape; every result carries `source` naming the collection it came from. Nothing is migrated between them. Use it when a layer entry is relevant but thin: the transcript around its timestamp holds the depth the layer compressed out.",
    inputSchema: {
      type: "object",
      properties: {
        timestamp_start: {
          type: "number",
          description: "Unix timestamp - start of time range (filters by session_start)"
        },
        timestamp_end: {
          type: "number",
          description: "Unix timestamp - end of time range (filters by session_start)"
        },
        session_id: {
          type: "string",
          description: "Optional: Filter by specific session ID (e.g. '2026-04-16_001')"
        },
        limit: {
          type: "number",
          description: "Maximum number of sessions to return (default: 50, max: 500)"
        }
      },
      required: ["timestamp_start", "timestamp_end"]
    }
  },
    {
    name: "save_transcript",
    description: "FALLBACK. The primary path is emet_session_open then emet_transcript_append after every reply; use this only where a host cannot append per reply. Saves the full word-for-word dialog of a session - full transcripts only, no summaries. Pass exchanges in the call. The server does not read a file. Refused for a session that was closed complete.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: {
          type: "string",
          description: "Unique session identifier, e.g. 'claude_project_2026-05-23_001'"
        },
        session_start: {
          type: "number",
          description: "Unix timestamp — session start"
        },
        session_end: {
          type: "number",
          description: "Unix timestamp — session end (optional, defaults to now)"
        },
        exchanges: {
          type: "array",
          description: "Claude.ai Project mode: full array of exchange objects for this session",
          items: {
            type: "object",
            properties: {
              exchange_index: { type: "number" },
              user_message: { type: "string" },
              assistant_message: { type: "string" },
              timestamp: { type: "number", description: "Optional Unix timestamp for this exchange" }
            },
            required: ["user_message", "assistant_message"]
          }
        },
        source: { type: "string", description: "Source tag - which host produced this write. One name on every write since 2026-09-27." },
        channel: { type: "string", description: "Alias of `source` (the older name, kept one release). Prefer `source`." }
      },
      required: ["session_id", "session_start", "exchanges"]
    }
  },
  {
    name: "emet_session_open",
    description: "Open a transcript session. Returns session_id, dated in the configured local time zone (EMET_TIMEZONE, default America/New_York). A slug whose id is already CLOSED is never reopened: the session opens as <id>-2, -3, ... and the result's `notice` says so. Pass load_id from your startup pages (startup_page.load_id on every emet_initialize page) so the startup page check runs on your own startup; an open without load_id, or with a page of that startup never fetched, is refused (the refusal says how to pass). After every reply, call emet_transcript_append with that id and the one exchange that just happened. Do not dump the whole chat at close.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string", description: "Short name for the session, e.g. grok-init" },
        load_id: { type: "string", description: "Required for the startup page check (by policy; the schema leaves it optional so older hosts can still open): the load_id from `startup_page` on your emet_initialize pages - page 1 returns it, every page carries it, and the last page names it. An open without load_id, or with a page of that load known not fetched, is refused before anything is written (gate startup_pages); the refusal names the exact calls that pass." }
      }
    }
  },
  {
    name: "emet_transcript_append",
    description: "Append ONE exchange to the session transcript. Call after every reply. Idempotent on exchange_index. Rolls to a new part after 8 exchanges. After a complete close the session takes exactly ONE more append - its closing exchange, numbered next, within EMET_CLOSE_GRACE_MINUTES (default 5) of the close; it is written into the session's last part whatever session_id it names, and the result's `closing_exchange` says it was accepted and that the session is now locked. A retry of that exchange number is answered as already saved and writes nothing. exchange_index, when given, must be a whole number of 1 or more (a number or its text). Any other append to a closed session is refused and nothing is written; that exchange belongs in the next session you open the usual way. THE FIRST APPEND OF A SESSION IS CHECKED: its assistant_message must carry the measured machine line - a machine name from the install notes plus the clock reading, as the shell returned them - or the words `no local shell MCP`. Without one of those the append is refused and the transcript does not start.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        user_message: { type: "string" },
        assistant_message: { type: "string" },
        exchange_index: { type: "number" },
        session_start: { type: "number" },
        source: { type: "string", description: "Source tag - which host produced this write. One name on every write since 2026-09-27." },
        channel: { type: "string", description: "Alias of `source` (the older name, kept one release). Prefer `source`." }
      },
      required: ["session_id", "user_message", "assistant_message"]
    }
  },
  {
    name: "read_doc",
    description: "Read a continuity document from the versioned document store. A document longer than one page (18,000 UTF-8 bytes by default) comes back in pages: the result then carries `page` with `next_offset` - call again with that offset (and `expected_version` set to the first page's `version`) until `next_offset` is null, and do not act on a document you have only part of. If the document changes between pages the read is refused: restart from offset 0. `sha256` and `size` (characters; `size_bytes` in UTF-8 bytes) always describe the WHOLE document.",
    inputSchema: { type: "object", properties: {
      doc_id: { type: "string", description: "Document id, e.g. 'STATE.md', 'HANDOFF.md', 'threads/pcb-laser-board.md', 'bootstrap/IDENTITY.md'" },
      offset: { type: "number", description: "Optional: UTF-8 byte offset to start from (default 0). Use the previous page's `page.next_offset`." },
      limit: { type: "number", description: "Optional: page size in bytes as the host receives it (default 18,000): a page ends before its JSON-escaped text plus 1,500 bytes kept for the result envelope would pass it, and never splits a character. 0 returns the whole document in one result." },
      expected_version: { type: "number", description: "Optional: the `version` your first page returned. Pass it with every later page; if the document changed in between, the read is refused (restart from offset 0) so pages of two versions are never joined." },
      expected_sha256: { type: "string", description: "Optional: the `sha256` your first page returned - the same pin as expected_version, and the only pin for a shipped guide (guides have no version)." }
    }, required: ["doc_id"] }
  },
  {
    name: "read_doc_history",
    description: "Read a RETAINED revision of a document, or list the revisions retained for it. Every write archives the prior copy (nothing is deleted); this is the reader for that archive. Without a version: the list of retained revisions with their digests and dates. With a version: that revision's full content, re-hashed against its stored digest. Read-only. Use it for an audit question - what did this document say at version N - or to compare a document with what it replaced.",
    inputSchema: { type: "object", properties: {
      doc_id: { type: "string", description: "Document id, e.g. 'CHARTER.md', 'STATE.md'" },
      version: { type: "number", description: "Optional: the revision to read. Omit to list what is retained." }
    }, required: ["doc_id"] }
  },
  {
    name: "write_doc",
    description: "Write or update a continuity document in the document store (versioned, prior copy archived to documents_history and marked obsolete, sha256 read-back verified). RECORDS - the handoff (HANDOFF.md) and any id in EMET_RECORD_DOCS - are superseded, never amended: patch_doc is refused on them, and a new revision is written here WHOLE with `supersedes` set to the version currently in force (ISO 9001 7.5.3 / 13485 4.2.5).",
    inputSchema: { type: "object", properties: {
      doc_id: { type: "string" },
      content: { type: "string" },
      supersedes: { type: "number", description: "Required when writing a new revision of a RECORD (the handoff): the version currently in force, which this revision supersedes. Ignored for ordinary documents." },
      reason: { type: "string", description: "Required on a record revision (at least 10 characters). Stored as edit_reason." },
      session_id: { type: "string", description: "Transcript session id. The floor is measured from the size when this session first touched the document." },
      source: { type: "string", description: "Source tag - which host produced this write. One name on every write since 2026-09-27." },
      updated_by: { type: "string", description: "Alias of `source` (the older name, kept one release). Prefer `source`." }
    }, required: ["doc_id", "content"] }
  },
  {
    name: "list_docs",
    description: "List continuity documents (metadata only; optional doc_id prefix filter, e.g. 'threads/'). Current documents come first. Retired documents stay in the list, marked with retired_at and, when a rename replaced them, what replaced them.",
    inputSchema: { type: "object", properties: {
      prefix: { type: "string" },
      include_retired: { type: "boolean", description: "Accepted. Retired documents are always listed, after the current ones. This flag does not hide them." }
    } }
  },
  {
    name: "retire_doc",
    description: "Mark a continuity document OBSOLETE. Nothing is deleted: the document keeps its id, its full content, its version and its digest, and read_doc still returns it, flagged retired, with the reason. list_docs and the startup scan keep it too, after the current documents, with retired_at and what replaced it. A retired drop is not an unhandled drop. This is document control as ISO 7.5.3 describes it - issue the revision, mark the prior copy obsolete, retain it - and it is the document-store counterpart of revise_memory superseding a layer entry. THE STORE HAS NO DELETE, BY DESIGN. Use for genuine litter: tombstones, merged staging documents, test scratch. Reversible: write_doc on the same id brings it back into the working view.",
    inputSchema: { type: "object", properties: {
      doc_id: { type: "string", description: "Document id to mark obsolete." },
      reason: { type: "string", description: "Why it is obsolete. Required, at least 10 characters. Drops only." },
      session_id: { type: "string", description: "Transcript session id." },
      source: { type: "string", description: "Source tag - which host produced this write. One name on every write since 2026-09-27." },
      retired_by: { type: "string", description: "Alias of `source` (the older name, kept one release). Prefer `source`." }
    }, required: ["doc_id", "reason"] }
  },
  {
    name: "rename_doc",
    description: "Reissue a continuity document under a new doc_id. The destination is written first through the normal write path (same redaction, digest, versioning and sha256 read-back), and only then is the old id marked obsolete with retire_doc. NOTHING IS DELETED: the old id keeps its content and stays readable at its own id, flagged retired with the reason 'Reissued as <new_id>'. list_docs keeps it after the current documents and names the new id in replaced_by. No tombstone document is needed, because the retired original IS the tombstone and it still carries the real content. Refuses if the destination already exists, because a rename onto an occupied id is a merge decision and merges are not guessed.",
    inputSchema: { type: "object", properties: {
      old_id: { type: "string", description: "Existing document id to reissue from. It is retired, not removed." },
      new_id: { type: "string", description: "Destination document id. Must not already exist." },
      reason: { type: "string", description: "Why the document is reissued. Required, at least 10 characters." },
      session_id: { type: "string", description: "Transcript session id." },
      source: { type: "string", description: "Source tag - which host produced this write. One name on every write since 2026-09-27." },
      updated_by: { type: "string", description: "Alias of `source` (the older name, kept one release). Prefer `source`." }
    }, required: ["old_id", "new_id", "reason"] }
  },
  {
    name: "restore_doc",
    description: "Write a retained revision back as the current document. The retained row is copied through the normal write path, with a reason. Nothing is deleted.",
    inputSchema: { type: "object", properties: {
      doc_id: { type: "string", description: "Document id to restore." },
      version: { type: "integer", description: "Retained revision number to write back." },
      reason: { type: "string", description: "Why this revision is restored. At least 10 characters." },
      session_id: { type: "string", description: "Transcript session id. Required on Path 2." },
      source: { type: "string", description: "Source tag. Must be in EMET_RESTORE_TAGS. A missing source is refused." }
    }, required: ["doc_id", "version", "reason", "source"] }
  },
  {
    name: "validate_doc",
    description: "Check a controlled document against the template that governs it, WITHOUT writing anything. The same check the write path runs on every document write - this is the freestanding form, for auditing records written before validation existed, for counting what adoption will mark before it marks anything, and for checking new content before it is stored. Pass doc_id to check a stored document (the previous revision is pulled from the archive so the carry-forward check runs). Pass content, with template_id or a doc_id the map covers, to check text that is not stored. Checks FORM and CONTINUITY only: sections present, in order and filled; no placeholder left unfilled; NOT COMPLETED carrying a reason; a board's counts matching its rows; every row on the previous revision still present or dispositioned. It cannot check whether an answer is true, or whether a 'none' states its scope honestly - those stay with the author and the reader.",
    inputSchema: { type: "object", properties: {
      doc_id: { type: "string", description: "Stored document to check. Alone, it is read from the store and compared against its own previous revision." },
      content: { type: "string", description: "Text to check instead of a stored document. Requires template_id, or a doc_id the map covers." },
      template_id: { type: "string", description: "Template to check against, e.g. 'templates/BOARD.md'. Read from the copy shipped with this release, never the store copy." }
    } }
  },
  {
    name: "accept_nonconformance",
    description: "Record the written disposition for a nonconformance that will not be corrected. A marker is never cleared silently: it leaves either because a later revision passes, or because someone accepts it in writing here. The marker is RETAINED with the acceptance beside it, and the acceptance covers only the revision it names - the next write is validated fresh, and accepted markers stay counted at session start, separately from open ones. The reason must be at least 10 characters: it is what an audit reads later.",
    inputSchema: { type: "object", properties: {
      doc_id: { type: "string", description: "Document carrying the open marker." },
      reason: { type: "string", description: "Why this nonconformance is accepted rather than corrected. At least 10 characters." },
      source: { type: "string", description: "Source tag - which host produced this write. One name on every write since 2026-09-27." },
      session_id: { type: "string", description: "Transcript session id." },
      accepted_by: { type: "string", description: "Alias of `source` (the older name, kept one release). Prefer `source`." }
    }, required: ["doc_id", "reason"] }
  },
  {
    name: "patch_doc",
    description: "Replace one exact substring in a document (str_replace semantics) without resending the whole file. THE PREFERRED WAY TO MAKE SMALL EDITS to large docs like STATE.md. old_str must match EXACTLY ONCE - zero or multiple matches are rejected rather than guessed. Pass new_str as an empty string to delete. Same versioning, archiving, and sha256 read-back as write_doc.",
    inputSchema: { type: "object", properties: {
      doc_id: { type: "string" },
      old_str: { type: "string", description: "Exact text to replace. Must occur exactly once in the current text. Omit when `edits` is set." },
      new_str: { type: "string", description: "Replacement text. Empty string deletes the matched text." },
      reason: { type: "string", description: "Required, at least 10 characters. A removed or closed board row says why." },
      origin: { type: "string", description: "Required when a board edit adds a row id. Names the session, chat or drop the row came from." },
      edits: { type: "array", description: "Several replacements in one revision. Each old_str must match the current text exactly once. Applied together, so a failed edit writes nothing.", items: { type: "object" } },
      session_id: { type: "string", description: "Transcript session id. The floor is measured from the size when this session first touched the document." },
      source: { type: "string", description: "Source tag - which host produced this write. One name on every write since 2026-09-27." },
      updated_by: { type: "string", description: "Alias of `source` (the older name, kept one release). Prefer `source`." },
      expected_version: { type: "number", description: "Optional optimistic-concurrency guard." }
    }, required: ["doc_id", "reason"] }
  },
  {
    name: "semantic_recall",
    description: "Semantic (meaning-based) memory search across all six memory layers via Atlas Vector Search autoEmbed. Finds conceptually related memories even without keyword overlap. Complements keyword-based recall/query_layer.",
    inputSchema: { type: "object", properties: {
      query: { type: "string", description: "Natural-language query - embedded automatically server-side (voyage-4)" },
      layer: { type: "string", enum: ["episodic", "semantic", "procedural", "meta", "identity", "working"], description: "Optional: restrict to one layer" },
      limit: { type: "number", description: "Max results (default 10)" },
      history: { type: "boolean", description: "Return ended entries only, up to limit. Default false: current matches come first and ended matches follow until limit, marked with their end date." }
    }, required: ["query"] }
  },
  {
    name: "emet_gaps",
    description: "The record's honesty about its own holes, as a query. Read-only; identifies and never fills. Counts, with the ids behind them, for each gap class: unsourced assertions, unattributed inferences, ambiguous attribution (by tag and by session), uncertain routing, unattestable rows (pre-2026-09-05 boundary), digest mismatches (the alarm - expect zero), pointer disagreements against the transcript store, broken supersession, expired-but-live rows, consolidation candidates (tag families; a list for a person), and redacted spans by source. Call it when asked how trustworthy the record is, before a consolidation pass, or after any migration. Closing a gap is a person's decision: revise_memory with a real derived_from where the source is knowable; otherwise the gap stands as a fact.",
    inputSchema: {
      type: "object",
      properties: {
        layer: { type: "string", enum: ["episodic", "semantic", "procedural", "meta", "identity", "working"], description: "Restrict to one layer. Default: all six." },
        since: { type: "number", description: "Unix seconds; only entries with timestamp >= since. Default: the whole store." },
        limit: { type: "number", description: "Max ids returned per class (1-500, default 50). Counts are always complete." }
      }
    }
  },
  {
    name: "emet_floor",
    description: "Read the floor: the standing description of how this assistant engages with the person using it. It ships in the server code, so setup cannot overwrite it and no install can lose it - the character document holds the user's modifiers on top of it. emet_initialize already returns the whole floor at session start; call this to read it again without re-running initialize. Use `compact: true` for the short form partway through a long session, when the start of the conversation is far behind. Read-only, and re-reading is not the same as being bound by it.",
    inputSchema: {
      type: "object",
      properties: {
        compact: { type: "boolean", description: "Return the short re-assertion form instead of the whole floor." },
        section: { type: "string", description: "Return one section only, e.g. 'neurodivergent_support'. Call with no arguments to see the section names." }
      }
    }
  },
  {
    name: "emet_invite_create",
    description: "EMET Guest Access: create a one-time code for a guest. They paste it on the connect screen instead of the passphrase. Default access is read-only. Only the owner can create a guest code. EMET Member Access is a different door.",
    inputSchema: {
      type: "object",
      properties: {
        display_name: { type: "string", description: "Name the guest will be known by in this store" },
        scopes: { type: "array", items: { type: "string", enum: ["emet.read"] }, description: "Guest invites accept only emet.read." },
        days: { type: "number", description: "Days until the code expires. Default 14." },
        source: { type: "string", description: "Source tag bound to this guest at approval. Exact membership of EMET_SOURCE_TAGS when a registry is set." }
      },
      required: ["display_name"]
    }
  },
  {
    name: "emet_member_access_create",
    description: "EMET Member Access: create a one-time code for a new person with read and write access. They paste it on the connect screen instead of the passphrase. This is not EMET Guest Access, and it never makes them the owner. Only the owner can create it. Off unless EMET_MEMBER_ACCESS=1.",
    inputSchema: {
      type: "object",
      properties: {
        display_name: { type: "string", description: "Name this person will be known by in this store. A name never selects an existing person." },
        days: { type: "number", description: "Days until the code expires. Default 14." },
        source: { type: "string", description: "Source tag bound to this member at approval. Exact membership of EMET_SOURCE_TAGS when a registry is set. Required for this member to write documents over HTTP while a registry is set." }
      },
      required: ["display_name"]
    }
  },
  {
    name: "emet_session_close",
    description: "Call this when the session is ending - the user says goodbye, asks you to wrap up, mentions restarting or opening a new session, or you are about to run out of room. An acknowledgement of the turn just completed - thanks, great, perfect - is not a session end; if it is ambiguous, ask rather than close. Checks whether this session's work has actually been written to the store and reports exactly what is missing. It does not write anything itself. RECEIPTS ARE REQUIRED: pass `receipts` naming what you wrote and read back for each close step - working documents, the episodic session record id, the board and its version, the transcript part ids and highest exchange index as query_transcripts returned them, and the handoff version (written last). Each receipt is compared with the store; omitted or mismatched receipts, a handoff that was not the last write, or a transcript no layer entry cites (derived_from) return state 'blocked'. Each missing line carries a `scope`: touch only what it names. THREE blocked closes on one session return state 'escalate': stop retrying, say the `speak` lines, and hand the user the list - the counter does not reset on a changed receipt, only with a new session. Say every line of the returned `speak` to the user, in order - a wrap that leaves it out is a failed close. Never tell the user their session is saved unless this returns state 'complete'.",
    inputSchema: {
      type: "object",
      properties: {
        receipts: {
          type: "object",
          description: "Required for state 'complete'. One entry per close step, taken from what the tools returned this session - not from recall.",
          properties: {
            working_docs: { type: "array", items: { type: "string" }, description: "Document ids updated this session before the handoff, e.g. ['threads/emet-publication.md']. [] if none." },
            episodic_id: { type: "number", description: "Id of the episodic session record, as save_to_layer returned it and query_layer read it back." },
            board_doc: { type: "string", description: "Board document id, usually 'STATE.md'." },
            board_version: { type: "number", description: "Board version after this session's update." },
            transcript_session_id: { type: "string", description: "Base transcript session id." },
            transcript_parts: { type: "array", items: { type: "string" }, description: "Part ids query_transcripts returned for this session." },
            transcript_exchanges: { type: "number", description: "Highest exchange index query_transcripts returned." },
            handoff_version: { type: "number", description: "Version of the handoff, written last." },
            handoff_doc: { type: "string", description: "Bot sessions only: the bot's own handoff record, bots/<source tag>/HANDOFF.md. A bot session needs no board receipt and never names the main HANDOFF.md or STATE.md." }
          }
        },
        session_id: { type: "string", description: "The session_id used (or to be used) for this session's transcript, e.g. '2026-09-03_short-description'. Without it the transcript cannot be checked; receipts.transcript_session_id is used when this is omitted." },
        session_start: { type: "number", description: "Unix seconds when the session began. Defaults to 12 hours ago, which makes the answer approximate." },
        thread_docs: { type: "array", items: { type: "string" }, description: "Additional document ids this session should have updated, e.g. ['threads/some-project.md']." },
        source: { type: "string", description: "Your host's source tag: the registered tag this session was written under. The close is never refused for it; an unregistered tag, one that did not write this session, or none (with no server default) gets a warning that the close is not attributed." }
      }
    }
  }
];

/**
 * The tool list as hosts receive it, with MCP annotations attached.
 *
 * annotate() throws if any tool is missing an entry, so a new tool cannot reach
 * a host unannotated - which would make it look, to any host that asks before
 * acting, exactly as risky as an arbitrary shell command.
 */
/**
 * The session graph's two inputs on every write tool (2026-09-29):
 * `session_id` names the session the write belongs to, `exchange` the turn.
 * Added here, once, rather than hand-copied into each schema; a schema that
 * already declares one keeps its own description.
 */
const GRAPH_INPUTS = {
  session_id: { type: 'string', description: 'Your transcript session id from emet_session_open. The session graph reads this session\'s state before the write and returns `session_graph.next` - the next step. A governed write with no session is refused (open one with emet_session_open and load_id).' },
  exchange: { type: 'number', description: 'The exchange (turn) this write belongs to, counting from 1. A write for exchange n while exchange n-1 was never appended is refused by the session graph until n-1 is appended.' }
};
for (const t of TOOL_DEFINITIONS) {
  // One list of governed tools: session-graph.js. The append already carries
  // session_id and exchange_index, its own names for the same two inputs.
  if (!GRAPH_WRITE_TOOLS.has(t.name) || t.name === 'emet_transcript_append' || !t.inputSchema) continue;
  t.inputSchema.properties = t.inputSchema.properties || {};
  for (const [k, v] of Object.entries(GRAPH_INPUTS)) if (!t.inputSchema.properties[k]) t.inputSchema.properties[k] = v;
}

export const TOOLS = annotate(TOOL_DEFINITIONS);


// ============================================
// EXPORTS
// ============================================

export default {
  // Rate limiting
  RATE_LIMIT_CONFIG,
  RateLimitError,
  RateLimiter,

  // Error handling
  handleError,
  createSuccessResponse,

  // Memory operations
  saveMemory,
  recallMemories,
  semanticRecall,
  queryLayer,
  getStatus,
  queryTranscripts,
  reviseTranscript,
  saveTranscript,
  sessionOpen,
  transcriptAppend,

  // Tool definitions
  TOOLS
};
