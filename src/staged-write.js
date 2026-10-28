/**
 * EMET - staged multi-part document write.
 *
 * A host that truncates a large tool argument cannot send a whole record in
 * one write_doc call. This file holds the parts, in order, in
 * `<prefix>doc_stages`. That collection is bookkeeping, not a document and
 * not a memory layer: a read token cannot read it through read_doc, and a
 * chunk is not a revision.
 *
 * commit assembles the parts, checks the caller's sha256 of that exact text,
 * and then calls writeDoc once. Versioning, the prior-copy archive, redaction,
 * the size floors, and the read-back all stay on that one door. An aborted,
 * incomplete, or expired stage leaves the current document untouched.
 *
 * Rows are updated in place (open, committing, committed, aborted, expired).
 * Nothing in this file is deleted.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { connectMongo } from './mongo-connect.js';
import { DatabaseError, EmetError, MONGODB_DB, COLLECTION_PREFIX } from './database.js';
import { ValidationError } from './validation.js';
import { digest } from './aleph.js';
import { setting } from './env.js';
import { writerStamp } from './persons.js';
import { isDropDoc } from './conformance.js';
import { isBotTag } from './session-graph.js';
import {
  writeDoc, refuseBotMainRecord, sourceRegistry, rightsTags, isRecordDoc, isWorkingDoc
} from './tools.js';

export const STAGED_LIMITS = Object.freeze({
  maxPartChars: 16000,
  maxParts: 128,
  maxTotalChars: 2000000,
  ttlMs: 30 * 60 * 1000,
  maxOpenPerWriter: 4
});

const STAGE_COLLECTION = `${COLLECTION_PREFIX}doc_stages`;

function stageFailure(error, tool) {
  if (error instanceof ValidationError || error instanceof EmetError) throw error;
  throw new DatabaseError(`Failed to stage a document write: ${error.message}`, tool, { code: 'EMET-DB-037' });
}

function limitsView() {
  return {
    max_part_chars: STAGED_LIMITS.maxPartChars,
    max_parts: STAGED_LIMITS.maxParts,
    max_total_chars: STAGED_LIMITS.maxTotalChars,
    ttl_minutes: STAGED_LIMITS.ttlMs / 60000,
    max_open_stages: STAGED_LIMITS.maxOpenPerWriter
  };
}

function at(value) {
  if (value instanceof Date) return value.getTime();
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : 0;
}

function partIndex(value) {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 1) return value;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const n = Number(value.trim());
    if (Number.isSafeInteger(n) && n >= 1) return n;
  }
  return null;
}

function wholeNumber(value) {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const n = Number(value.trim());
    if (Number.isSafeInteger(n) && n >= 0) return n;
  }
  return null;
}

function namedVersion(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return Number(value.trim());
  return value;
}

function normalizeSha(value) {
  if (typeof value !== 'string') return null;
  const sha = value.trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(sha) ? sha : null;
}

function shaMatches(expected, actual) {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(actual, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function sameWriter(row, stamp) {
  return row.person_id === stamp.person_id &&
    row.client_id === stamp.client_id &&
    row.grant_id === stamp.grant_id &&
    row.door === stamp.door;
}

async function stageDb() {
  const client = await connectMongo(process.env.MONGODB_URI || 'mongodb://test', { serverSelectionTimeoutMS: 5000, maxPoolSize: 10 });
  const db = client.db(MONGODB_DB);
  return { client, stages: db.collection(STAGE_COLLECTION), docs: db.collection('documents') };
}

function throwExpired(tool) {
  throw new ValidationError(`${tool}: this stage expired. Begin again. Nothing was written.`, { code: 'EMET-DOC-061' });
}

function throwAborted(tool) {
  throw new ValidationError(`${tool}: this stage was aborted. Nothing was written.`, { code: 'EMET-DOC-062' });
}

function throwCommitted(tool) {
  throw new ValidationError(`${tool}: this stage is already committed. Read the document. Nothing was written.`, { code: 'EMET-DOC-063' });
}

function throwCommitting(tool) {
  throw new ValidationError(`${tool}: this stage is already being committed. Nothing was written.`, { code: 'EMET-DOC-076' });
}

/**
 * Load one stage for this writer. An open stage past its TTL is marked expired
 * and refused. A missing id and someone else's id are the same refusal.
 */
export async function readStage(col, stageId, stamp, tool, now) {
  if (typeof stageId !== 'string' || !stageId.startsWith('stg_')) {
    throw new ValidationError(`${tool}: stage not found for this writer. Nothing was written.`, { code: 'EMET-DOC-060' });
  }
  const row = await col.findOne({ _id: stageId });
  if (!row || !sameWriter(row, stamp)) {
    throw new ValidationError(`${tool}: stage not found for this writer. Nothing was written.`, { code: 'EMET-DOC-060' });
  }
  if (row.status === 'open' && at(row.expires_at) <= at(now)) {
    await col.updateOne(
      { _id: row._id, status: 'open' },
      { $set: { status: 'expired', parts: [], size: 0, updated_at: now } }
    );
    row.status = 'expired';
    row.parts = [];
    row.size = 0;
  }
  if (row.status === 'expired') throwExpired(tool);
  return row;
}

/** Mark this writer's overdue open stages expired and return how many are still open. */
export async function expireOpenStages(col, stamp, now) {
  const rows = await col.find({
    status: 'open',
    person_id: stamp.person_id,
    client_id: stamp.client_id,
    grant_id: stamp.grant_id,
    door: stamp.door
  }).toArray();
  let live = 0;
  for (const row of rows) {
    if (at(row.expires_at) > at(now)) live += 1;
    else {
      await col.updateOne(
        { _id: row._id, status: 'open' },
        { $set: { status: 'expired', parts: [], size: 0, updated_at: now } }
      );
    }
  }
  return live;
}

function assertCallMatches(tool, row, source, sessionId) {
  if ((source || null) !== (row.source || null)) {
    throw new ValidationError(`${tool}: this call's source does not match the stage. Nothing was written.`, { code: 'EMET-DOC-079' });
  }
  if ((sessionId || null) !== (row.session_id || null)) {
    throw new ValidationError(`${tool}: this call's session does not match the stage. Nothing was written.`, { code: 'EMET-DOC-080' });
  }
}

function assertBeginAllowed(docId, source, prev, supersedes, reason) {
  if (!docId || typeof docId !== 'string') {
    throw new ValidationError('doc_id must be a non-empty string', { code: 'EMET-DOC-001' });
  }
  refuseBotMainRecord(docId, source, 'write_doc');
  if (prev && isRecordDoc(docId)) {
    const named = supersedes;
    if (named === undefined || named === null) {
      throw new ValidationError(
        `write_doc: ${docId} is a record and v${prev.version} is in force. A new revision must name what it ` +
        `supersedes - pass supersedes: ${prev.version}. Nothing was changed.`
      , { code: 'EMET-DOC-017' });
    }
    if (Number(named) !== prev.version) {
      throw new ValidationError(
        `write_doc: ${docId} - supersedes names v${named}, but v${prev.version} is in force. Re-read the record ` +
        `and supersede the current revision. Nothing was changed.`
      , { code: 'EMET-DOC-018' });
    }
    if (typeof reason !== 'string' || reason.trim().length < 10) {
      throw new ValidationError(
        `write_doc: ${docId} is a record. A new revision needs reason (at least 10 characters) as well as supersedes. Nothing was changed.`
      , { code: 'EMET-DOC-019' });
    }
  }
  const registry = sourceRegistry();
  const passes = (t) => registry.length === 0 || registry.includes(t || '') || (isBotTag(t) && docId.startsWith(`bots/${t}/`));
  if (!rightsTags(source).every(passes) && !(isDropDoc(docId) && !prev)) {
    throw new ValidationError(`write_doc: ${source || 'no source'} is not a registered source. This session may read, and may write a new drop only. Nothing was written.`, { code: 'EMET-DOC-020' });
  }
  if (docId === setting('STATE_DOC', 'STATE.md')) {
    if (prev) {
      throw new ValidationError('The board is never written. Edit it with patch_doc, with `reason` (and `origin` for an added row). Nothing was written.', { code: 'EMET-MEM-022' });
    }
    throw new ValidationError('The board is provisioned by the server at setup (emet_setup_complete). Nothing was written.', { code: 'EMET-MEM-023' });
  }
  if (prev && isWorkingDoc(docId)) {
    throw new ValidationError(
      `write_doc: ${docId} exists, so it is edited, not rewritten. Use patch_doc with \`reason\`. Nothing was written.`
    , { code: 'EMET-DOC-022' });
  }
  if (isDropDoc(docId) && prev) {
    throw new ValidationError(
      `write_doc: ${docId} is a drop and already exists, retired drops included. A drop is never patched or restored. Use a new id. Nothing was written.`
    , { code: 'EMET-DOC-023' });
  }
}

function assemble(parts) {
  const ordered = [...(parts || [])].sort((a, b) => a.index - b.index);
  for (let i = 0; i < ordered.length; i++) {
    if (!ordered[i] || ordered[i].index !== i + 1 || typeof ordered[i].text !== 'string') return null;
  }
  return ordered.map((part) => part.text).join('');
}

function receiptOf(row) {
  const receipt = row.receipt || {};
  return {
    doc_id: row.doc_id,
    sha256: receipt.sha256,
    version: receipt.version,
    size: receipt.size,
    updated_at: receipt.updated_at || row.updated_at,
    verified: true,
    stage_id: row._id,
    assembled_sha256: row.assembled_sha256,
    parts: receipt.part_count,
    staged: true,
    already: true
  };
}

export async function beginStagedDoc(input = {}, logger = null, now = new Date()) {
  let client;
  try {
    const opened = await stageDb();
    client = opened.client;
    const docId = input.doc_id;
    const source = input.source || null;
    const sessionId = input.session_id || null;
    const supersedes = namedVersion(input.supersedes);
    const reason = typeof input.reason === 'string' && input.reason.length ? input.reason : null;
    const prev = docId && typeof docId === 'string' ? await opened.docs.findOne({ doc_id: docId }) : null;
    assertBeginAllowed(docId, source, prev, supersedes, reason);
    const stamp = writerStamp();
    const live = await expireOpenStages(opened.stages, stamp, now);
    if (live >= STAGED_LIMITS.maxOpenPerWriter) {
      throw new ValidationError(`write_doc_begin: this writer already has ${STAGED_LIMITS.maxOpenPerWriter} open stages. Commit or abort one, then begin again. Nothing was written.`, { code: 'EMET-DOC-074' });
    }
    const stageId = `stg_${randomBytes(16).toString('hex')}`;
    const expiresAt = new Date(at(now) + STAGED_LIMITS.ttlMs);
    await opened.stages.insertOne({
      _id: stageId,
      doc_id: docId,
      source,
      person_id: stamp.person_id,
      client_id: stamp.client_id,
      grant_id: stamp.grant_id,
      door: stamp.door,
      session_id: sessionId,
      supersedes,
      reason,
      parts: [],
      next_part: 1,
      size: 0,
      status: 'open',
      created_at: now,
      updated_at: now,
      expires_at: expiresAt
    });
    logger?.debug?.('staged write begun', { stage_id: stageId, doc_id: docId });
    return {
      stage_id: stageId,
      doc_id: docId,
      next_part: 1,
      expires_at: expiresAt,
      parts: 0,
      limits: limitsView()
    };
  } catch (error) {
    stageFailure(error, 'write_doc_begin');
  } finally {
    if (client) await client.close().catch(() => {});
  }
}

export async function appendStagedChunk(input = {}, logger = null, now = new Date()) {
  let client;
  try {
    const opened = await stageDb();
    client = opened.client;
    const stamp = writerStamp();
    const row = await readStage(opened.stages, input.stage_id, stamp, 'write_doc_append', now);
    assertCallMatches('write_doc_append', row, input.source, input.session_id);
    if (row.status === 'aborted') throwAborted('write_doc_append');
    if (row.status === 'committed') throwCommitted('write_doc_append');
    if (row.status === 'committing') throwCommitting('write_doc_append');
    if (row.status !== 'open') throwCommitting('write_doc_append');
    const chunk = input.chunk;
    if (typeof chunk !== 'string' || chunk.length === 0) {
      throw new ValidationError('write_doc_append: a staged chunk must be a non-empty string. Nothing was written.', { code: 'EMET-DOC-071' });
    }
    const part = partIndex(input.part);
    if (part === null) {
      throw new ValidationError('write_doc_append: part must be a whole number starting at 1. Nothing was written.', { code: 'EMET-DOC-072' });
    }
    if (chunk.length > STAGED_LIMITS.maxPartChars) {
      throw new ValidationError(`write_doc_append: part ${part} is ${chunk.length} characters and the part limit is ${STAGED_LIMITS.maxPartChars}. Nothing was written.`, { code: 'EMET-DOC-064' });
    }
    const prior = (row.parts || []).find((item) => item.index === part);
    if (prior) {
      if (prior.text !== chunk) {
        throw new ValidationError(`write_doc_append: part ${part} was already stored with different bytes. Nothing was written.`, { code: 'EMET-DOC-066' });
      }
      return {
        stage_id: row._id, part, next_part: row.next_part, parts: row.parts.length,
        size: row.size, expires_at: row.expires_at, duplicate: true
      };
    }
    if (part !== row.next_part) {
      throw new ValidationError(`write_doc_append: part ${part} is out of order. The next part is ${row.next_part}. Nothing was written.`, { code: 'EMET-DOC-065' });
    }
    if (part > STAGED_LIMITS.maxParts) {
      throw new ValidationError(`write_doc_append: a staged write holds at most ${STAGED_LIMITS.maxParts} parts. Nothing was written.`, { code: 'EMET-DOC-068' });
    }
    if (row.size + chunk.length > STAGED_LIMITS.maxTotalChars) {
      throw new ValidationError(`write_doc_append: staged content would exceed the ${STAGED_LIMITS.maxTotalChars} character limit. Nothing was written.`, { code: 'EMET-DOC-067' });
    }
    const claimed = await opened.stages.updateOne(
      {
        _id: row._id, status: 'open', next_part: part,
        person_id: stamp.person_id, client_id: stamp.client_id, grant_id: stamp.grant_id, door: stamp.door
      },
      {
        $inc: { next_part: 1, size: chunk.length },
        $push: { parts: { index: part, text: chunk } },
        $set: { updated_at: now }
      }
    );
    if (claimed.matchedCount !== 1) {
      const again = await readStage(opened.stages, row._id, stamp, 'write_doc_append', now);
      const stored = (again.parts || []).find((item) => item.index === part);
      if (stored && stored.text === chunk) {
        return {
          stage_id: again._id, part, next_part: again.next_part, parts: again.parts.length,
          size: again.size, expires_at: again.expires_at, duplicate: true
        };
      }
      if (stored) {
        throw new ValidationError(`write_doc_append: part ${part} was already stored with different bytes. Nothing was written.`, { code: 'EMET-DOC-066' });
      }
      throw new ValidationError(`write_doc_append: part ${part} is out of order. The next part is ${again.next_part}. Nothing was written.`, { code: 'EMET-DOC-065' });
    }
    logger?.debug?.('staged chunk stored', { stage_id: row._id, part });
    return {
      stage_id: row._id, part, next_part: part + 1, parts: (row.parts || []).length + 1,
      size: row.size + chunk.length, expires_at: row.expires_at, duplicate: false
    };
  } catch (error) {
    stageFailure(error, 'write_doc_append');
  } finally {
    if (client) await client.close().catch(() => {});
  }
}

export async function commitStagedDoc(input = {}, logger = null, now = new Date()) {
  let client;
  try {
    const opened = await stageDb();
    client = opened.client;
    const stamp = writerStamp();
    const row = await readStage(opened.stages, input.stage_id, stamp, 'write_doc_commit', now);
    const sha = normalizeSha(input.sha256);
    if (!sha) {
      throw new ValidationError('write_doc_commit: sha256 must be a 64-character hex digest of the assembled text. Nothing was written.', { code: 'EMET-DOC-073' });
    }
    if (typeof input.doc_id !== 'string' || input.doc_id !== row.doc_id) {
      throw new ValidationError(`write_doc_commit: this commit names a different document than the stage (${row.doc_id}). Nothing was written.`, { code: 'EMET-DOC-075' });
    }
    assertCallMatches('write_doc_commit', row, input.source, input.session_id);
    const named = namedVersion(input.supersedes);
    const supersedesGiven = !(input.supersedes === undefined || input.supersedes === null || input.supersedes === '');
    if (supersedesGiven && named !== row.supersedes) {
      throw new ValidationError('write_doc_commit: supersedes does not match the stage. Nothing was written.', { code: 'EMET-DOC-077' });
    }
    const reasonGiven = typeof input.reason === 'string' && input.reason.length > 0;
    if (reasonGiven && input.reason !== row.reason) {
      throw new ValidationError('write_doc_commit: reason does not match the stage. Nothing was written.', { code: 'EMET-DOC-078' });
    }
    const partCount = wholeNumber(input.part_count);
    if (row.status === 'committed') {
      if (row.receipt && row.assembled_sha256 && shaMatches(sha, row.assembled_sha256) && partCount === row.receipt.part_count) {
        return receiptOf(row);
      }
      throwCommitted('write_doc_commit');
    }
    if (row.status === 'aborted') throwAborted('write_doc_commit');
    if (row.status === 'committing') throwCommitting('write_doc_commit');
    if (row.status !== 'open') throwCommitting('write_doc_commit');
    if (partCount === null || partCount !== (row.parts || []).length) {
      const held = (row.parts || []).length;
      throw new ValidationError(`write_doc_commit: part_count is ${input.part_count} but this stage has ${held} parts. Nothing was written.`, { code: 'EMET-DOC-070' });
    }
    const content = assemble(row.parts);
    if (content === null) {
      throw new ValidationError(`write_doc_commit: part_count is ${partCount} but the stored parts are not contiguous. Nothing was written.`, { code: 'EMET-DOC-070' });
    }
    const assembled = digest(content);
    if (!shaMatches(sha, assembled)) {
      throw new ValidationError('write_doc_commit: sha256 does not match the assembled content. Nothing was written.', { code: 'EMET-DOC-069' });
    }
    const claimed = await opened.stages.updateOne(
      { _id: row._id, status: 'open', person_id: stamp.person_id },
      { $set: { status: 'committing', updated_at: now } }
    );
    if (claimed.matchedCount !== 1) {
      const again = await opened.stages.findOne({ _id: row._id });
      if (again && again.status === 'committed' && again.assembled_sha256 && shaMatches(sha, again.assembled_sha256) && again.receipt && again.receipt.part_count === partCount) {
        return receiptOf(again);
      }
      throwCommitting('write_doc_commit');
    }
    let written;
    try {
      written = await writeDoc(row.doc_id, content, row.source, null, logger, {
        supersedes: row.supersedes,
        reason: row.reason,
        session_id: row.session_id
      });
    } catch (error) {
      await opened.stages.updateOne(
        { _id: row._id, status: 'committing' },
        { $set: { status: 'open', updated_at: new Date() } }
      );
      throw error;
    }
    const receipt = {
      version: written.version,
      sha256: written.sha256,
      size: written.size,
      updated_at: written.updated_at,
      assembled_sha256: assembled,
      part_count: partCount
    };
    await opened.stages.updateOne(
      { _id: row._id, status: 'committing' },
      {
        $set: {
          status: 'committed',
          parts: [],
          size: 0,
          updated_at: now,
          assembled_sha256: assembled,
          part_count: partCount,
          receipt
        }
      }
    );
    logger?.debug?.('staged write committed', { stage_id: row._id, doc_id: row.doc_id, version: written.version });
    return { ...written, stage_id: row._id, assembled_sha256: assembled, parts: partCount, staged: true };
  } catch (error) {
    stageFailure(error, 'write_doc_commit');
  } finally {
    if (client) await client.close().catch(() => {});
  }
}

export async function abortStagedDoc(input = {}, logger = null, now = new Date()) {
  let client;
  try {
    const opened = await stageDb();
    client = opened.client;
    const stamp = writerStamp();
    const row = await readStage(opened.stages, input.stage_id, stamp, 'write_doc_abort', now);
    assertCallMatches('write_doc_abort', row, input.source, input.session_id);
    if (row.status === 'aborted') return { stage_id: row._id, aborted: true, already: true };
    if (row.status === 'committed') throwCommitted('write_doc_abort');
    if (row.status === 'committing') throwCommitting('write_doc_abort');
    if (row.status !== 'open') throwCommitting('write_doc_abort');
    const claimed = await opened.stages.updateOne(
      { _id: row._id, status: 'open', person_id: stamp.person_id },
      { $set: { status: 'aborted', parts: [], size: 0, updated_at: now } }
    );
    if (claimed.matchedCount !== 1) {
      const again = await opened.stages.findOne({ _id: row._id });
      if (again && again.status === 'aborted') return { stage_id: row._id, aborted: true, already: true };
      throwCommitting('write_doc_abort');
    }
    logger?.debug?.('staged write aborted', { stage_id: row._id });
    return { stage_id: row._id, aborted: true, already: false };
  } catch (error) {
    stageFailure(error, 'write_doc_abort');
  } finally {
    if (client) await client.close().catch(() => {});
  }
}
