/**
 * EMET - Enduring Memory & Epistemic Tiers
 * Copyright (c) 2026 Dreamforge Studio LLC
 *
 * Licensed under the MIT License - see LICENSE
 *
 * aleph - the read-back verification layer.
 *
 * EMET is אמת, Hebrew for truth. In the golem legend the word is inscribed to
 * animate the body, and erasing its first letter leaves מת - met, dead. One
 * character is the whole difference.
 *
 * That letter is aleph, and this is the layer named for it. Every write is read
 * back and compared before it is reported as saved. A memory system without that
 * step still returns answers, still reports healthy, and is quietly a corpse:
 * confidently serving things it never stored. Aleph is also the FIRST letter,
 * which matches the order the protocol insists on - read back before trusting,
 * verify before retrying, verify the premise before applying the remedy.
 *
 * The rule this enforces: **a write is not done because the call returned.**
 * A driver reports what it sent, not what the store kept. The two disagree on
 * a failed upsert, a wrong-collection write, a silently rejected field, and a
 * duplicate-id collision - and every one of those is invisible to the caller
 * unless someone goes and looks.
 *
 * A verification failure raises AlephError rather than a database error, because
 * the two mean different things and lead to different actions. A DatabaseError
 * means the store could not be reached and the write probably did not happen. An
 * AlephError means the call SUCCEEDED and the store does not contain what it
 * should - the more serious of the two, and the one that must never be retried
 * blindly.
 */

import crypto from 'crypto';
import { EmetError, ErrorCodes, StatusCodes } from './database.js';

/** sha256 of a string, hex. The canonical digest for everything EMET stores. */
export function digest(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

export class AlephError extends EmetError {
  constructor(message, operation = 'unknown', details = {}) {
    super(message, ErrorCodes.WRITE_ERROR, StatusCodes.INTERNAL_ERROR, details);
    this.name = 'AlephError';
    this.operation = operation;
    this.verified = false;
  }

  toSafeJSON() {
    const base = super.toSafeJSON();
    base.error.operation = this.operation;
    base.error.verified = false;
    return base;
  }
}

/**
 * Verify a document write.
 *
 * Compares the digest AND the version. Digest alone would pass if a concurrent
 * writer had stored identical content under a different version, which is not
 * the same document state and must not be reported as this write succeeding.
 *
 * @param {object} readBack   the document as read back from the store
 * @param {object} expected   { doc_id, sha256, version }
 * @returns {object} a receipt carrying verified: true
 */
export function verifyDocument(readBack, expected) {
  const { doc_id, sha256, version } = expected;

  if (!readBack) {
    throw new AlephError(
      `Read-back found no document at ${doc_id} immediately after writing it. The write reported ` +
      `success and the store does not contain it.`,
      'aleph.verifyDocument',
      { doc_id }
    );
  }
  if (readBack.sha256 !== sha256) {
    throw new AlephError(
      `Read-back of ${doc_id} does not match what was written: content digest differs. Do not ` +
      `retry until the stored content has been inspected - a retry would overwrite whatever is ` +
      `actually there.`,
      'aleph.verifyDocument',
      { doc_id, expected_sha256: sha256, stored_sha256: readBack.sha256 }
    );
  }
  if (version !== undefined && readBack.version !== version) {
    throw new AlephError(
      `Read-back of ${doc_id} is at version ${readBack.version}, not the ${version} this write ` +
      `created. Another writer reached the document between the write and the read.`,
      'aleph.verifyDocument',
      { doc_id, expected_version: version, stored_version: readBack.version }
    );
  }
  return { verified: true, doc_id, sha256, version };
}

/**
 * Verify a layer-entry write.
 *
 * The id matters as much as the content here. Ids are allocated from a counters
 * collection, and a misconfigured prefix points that counter at an empty
 * collection - so ids restart at 1 and collide with entries that already exist.
 * The failure looks like a successful save and reads back as somebody else's
 * memory, which is why this compares the CONTENT at the id rather than merely
 * confirming that a record with that id exists.
 *
 * @param {object} readBack  the row as read back from the store
 * @param {object} expected  { id, content, layer }
 */
export function verifyLayerEntry(readBack, expected) {
  const { id, content, layer } = expected;

  if (!readBack) {
    throw new AlephError(
      `Read-back found no ${layer} entry at id ${id} immediately after writing it. The save ` +
      `reported success and the store does not contain it.`,
      'aleph.verifyLayerEntry',
      { layer, id }
    );
  }
  const wrote = digest(content);
  const stored = digest(readBack.content !== undefined && readBack.content !== null
    ? readBack.content
    : readBack.event);

  // If the row carries its own sha256 column (written from 2026-09-05),
  // it must agree with the content it sits beside. Rows written before the column
  // existed carry none and are judged on content alone - absence is not a failure,
  // but a PRESENT digest that disagrees is: the row is internally inconsistent.
  const storedColumn = readBack.sha256 !== undefined && readBack.sha256 !== null ? String(readBack.sha256) : null;
  if (storedColumn !== null && storedColumn !== stored) {
    throw new AlephError(
      `Read-back of ${layer} entry ${id} carries a sha256 column that does not match its own content. ` +
      `The row is internally inconsistent - either the content or the digest was altered after the write.`,
      'aleph.verifyLayerEntry',
      { layer, id, column_sha256: storedColumn, content_sha256: stored }
    );
  }

  if (stored !== wrote) {
    throw new AlephError(
      `Read-back of ${layer} entry ${id} returned different content than was written. The most ` +
      `likely cause is an id collision: ids come from a counters collection, and a counter read ` +
      `from the wrong collection restarts at 1 and overwrites existing entries. Check the ` +
      `collection prefix before writing anything else to this store.`,
      'aleph.verifyLayerEntry',
      { layer, id, expected_sha256: wrote, stored_sha256: stored }
    );
  }
  // C1 (2026-09-07): the metadata column, when present, must agree with the
  // metadata it sits beside, and with what the caller says it wrote. Same
  // rule as the content column: absence is a dated boundary, disagreement is
  // an inconsistency. When the caller supplies `expected.metadata`, the stored
  // metadata must also digest to the same value - a row whose metadata was
  // rewritten between the insert and the read-back is not the row that was
  // attested.
  let metadataDigestStored = false;
  let metadataSha256 = null;
  const metaColumn = readBack.metadata_sha256 !== undefined && readBack.metadata_sha256 !== null
    ? String(readBack.metadata_sha256) : null;
  if (metaColumn !== null) {
    const storedMeta = digestMetadata(readBack.metadata);
    if (storedMeta !== metaColumn) {
      throw new AlephError(
        `Read-back of ${layer} entry ${id} carries a metadata_sha256 column that does not match its own metadata. ` +
        `The row is internally inconsistent - either the metadata or its digest was altered after the write.`,
        'aleph.verifyLayerEntry',
        { layer, id, column_metadata_sha256: metaColumn, metadata_sha256: storedMeta }
      );
    }
    metadataDigestStored = true;
    metadataSha256 = metaColumn;
  }
  if (expected.metadata !== undefined) {
    const wroteMeta = digestMetadata(expected.metadata);
    const storedMeta = digestMetadata(readBack.metadata);
    if (storedMeta !== wroteMeta) {
      throw new AlephError(
        `Read-back of ${layer} entry ${id} returned different metadata than was written.`,
        'aleph.verifyLayerEntry',
        { layer, id, expected_metadata_sha256: wroteMeta, stored_metadata_sha256: storedMeta }
      );
    }
    metadataSha256 = wroteMeta;
  }

  return {
    verified: true, layer, id, sha256: wrote, digest_stored: storedColumn !== null,
    metadata_sha256: metadataSha256, metadata_digest_stored: metadataDigestStored
  };
}

/**
 * Canonical JSON: keys sorted at every depth, no whitespace, so the same
 * metadata produces the same bytes whatever order it was assembled in or
 * returned in. undefined values and functions are dropped as JSON.stringify
 * would drop them; a legacy metadata STRING (written before 2026-09-05) is parsed first so
 * both stored shapes digest identically.
 */
export function canonicalJson(value) {
  const norm = (v) => {
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(norm);
    if (v instanceof Date) return v.toISOString();
    const out = {};
    for (const k of Object.keys(v).sort()) {
      if (v[k] === undefined || typeof v[k] === 'function') continue;
      out[k] = norm(v[k]);
    }
    return out;
  };
  return JSON.stringify(norm(value));
}

/** sha256 of the canonical JSON of a metadata object (C1, 2026-09-07). */
export function digestMetadata(metadata) {
  let md = metadata;
  if (typeof md === 'string') { try { md = JSON.parse(md); } catch { /* digest the string as given */ } }
  if (md === null || md === undefined) md = {};
  return digest(canonicalJson(md));
}

/**
 * Metadata integrity of a stored row at READ time (C1). Same three values as
 * integrityOf: true / false / 'unattested' (no metadata_sha256 column).
 */
export function metadataIntegrityOf(row) {
  if (!row || typeof row !== 'object') return 'unattested';
  const stored = row.metadata_sha256;
  if (typeof stored !== 'string' || stored.length === 0) return 'unattested';
  return digestMetadata(row.metadata) === stored;
}

/**
 * Integrity of a stored layer row at READ time (work list E2, 2026-09-07).
 *
 * verifyLayerEntry above runs once, at the write. The sha256 column it stores
 * makes a second check possible every time the row is read, so a
 * row altered after its write - by a migration, a hand edit, a bug - is
 * flagged where it is used rather than discovered by accident. One hash per
 * row; the cost is small and the alternative is trusting a receipt from the
 * past.
 *
 * Returns:
 *   true          - the content's digest equals the stored column
 *   false         - the column exists and DISAGREES: the row is not what was
 *                   attested at write. The row is still returned; the caller
 *                   decides. Never silently dropped.
 *   'unattested'  - no sha256 column: written before 2026-09-05 (#12). Not a
 *                   defect, a dated boundary; countable.
 *
 * The content column is `content`; older rows exposed it as `event` as well
 * (both were written with the same value). Either is accepted, `content` first.
 */
export function integrityOf(row) {
  if (!row || typeof row !== 'object') return 'unattested';
  const stored = row.sha256;
  if (typeof stored !== 'string' || stored.length === 0) return 'unattested';
  const text = typeof row.content === 'string' ? row.content
             : typeof row.event === 'string' ? row.event : null;
  if (text === null) return false;
  return digest(text) === stored;
}

/** Per-layer hash chain. Forward-only: rows without chain_sha256 are unlinked, not broken. */
export function chainDigest(prevSha256, contentSha256) {
  return digest(`${prevSha256 || ''}\n${contentSha256}`);
}

export function chainIntegrityOf(row) {
  if (!row || typeof row !== 'object') return 'unlinked';
  if (typeof row.chain_sha256 !== 'string' || !row.chain_sha256) return 'unlinked';
  if (typeof row.sha256 !== 'string' || !row.sha256) return false;
  return row.chain_sha256 === chainDigest(row.prev_sha256 || '', row.sha256);
}

/**
 * Walk one layer's chain in id order (2026-09-29). chainIntegrityOf checks a
 * row against ITSELF, so a row removed from the middle goes unseen while its
 * neighbours stay self-consistent. At write time a row records as prev_sha256
 * the sha256 of the highest-id row that carried one, so in id order every
 * linked row's prev_sha256 must equal the sha256 of the nearest earlier row
 * that has a sha256. When it does not, a row between them was removed, or two
 * writes read the same head (a fork) - either way the record is no longer one
 * line, and it is reported, never repaired.
 *
 * `rows` need {id, sha256, prev_sha256, chain_sha256}; order does not matter.
 * `seedSha256`: the sha256 of the row just before the first one passed, when
 * the walk covers only part of a layer.
 * Returns counts, the live head, and up to `sample` ids per finding.
 * Used by emet_gaps (every host) and scripts/chain-verify.mjs (the outside copy).
 */
export function walkChain(rows, { seedSha256 = null, sample = 20 } = {}) {
  const sorted = [...(Array.isArray(rows) ? rows : [])].filter((r) => r && r.id !== undefined).sort((a, b) => a.id - b.id);
  const out = { total: sorted.length, linked: 0, unlinked: 0, broken: 0, discontinuities: 0, broken_ids: [], discontinuity_ids: [], head: null };
  let prevSha = seedSha256 || null;
  for (const row of sorted) {
    const v = chainIntegrityOf(row);
    if (v === 'unlinked') out.unlinked++;
    else if (v === false) { out.broken++; if (out.broken_ids.length < sample) out.broken_ids.push(row.id); }
    else {
      out.linked++;
      out.head = { id: row.id, chain_sha256: row.chain_sha256, sha256: row.sha256, timestamp: row.timestamp ?? null };
      if (prevSha !== null && (row.prev_sha256 || null) !== prevSha) {
        out.discontinuities++;
        if (out.discontinuity_ids.length < sample) out.discontinuity_ids.push(row.id);
      }
    }
    if (typeof row.sha256 === 'string' && row.sha256) prevSha = row.sha256;
  }
  return out;
}

/** Payload the service signs: the two digests, not the raw text. */
export function signaturePayload(contentSha256, metadataSha256) {
  return `${contentSha256}\n${metadataSha256 || ''}`;
}

/** HMAC-SHA256 of the two digests. Key never stored in the database. */
export function signDigests(contentSha256, metadataSha256, key) {
  if (!key) return null;
  return crypto.createHmac('sha256', String(key))
    .update(signaturePayload(contentSha256, metadataSha256), 'utf8')
    .digest('hex');
}

/**
 * true  - signature present and matches the stored digests under this key
 * false - signature present and does not match (row was altered after sign, or wrong key)
 * 'unsigned' - no signature column (written before this control)
 * 'no_key' - service has no signing key configured; cannot judge
 */
export function signatureIntegrityOf(row, key) {
  if (!row || typeof row !== 'object') return 'unsigned';
  const sig = row.signature;
  if (typeof sig !== 'string' || sig.length === 0) return 'unsigned';
  if (!key) return 'no_key';
  const expected = signDigests(row.sha256, row.metadata_sha256, key);
  return expected === sig;
}

/**
 * May a row be RE-SIGNED after one of the sanctioned metadata marks? (2026-10-02,
 * the reviewer's finding: the marks re-attested metadata_sha256 but left the
 * signature over the old metadata digest, so every superseded or corrected
 * row read signed:false.)
 *
 * Re-signing is never blind. It is allowed only when the row's EXISTING
 * signature verifies, under this key, against the row's content digest and
 * the metadata as it stood before the sanctioned marks, i.e. the stored
 * metadata with only the back-pointers the server itself manages rolled back:
 *   - superseded_by / superseded_at: as stored, or absent;
 *   - corrected_by: as stored, or any shorter prefix of it, or absent
 *     ($addToSet appends, so every earlier list is a prefix of the current one).
 * Anything else (no key, no signature, a signature from another key, or any
 * other metadata field changed since it was signed) returns false, and the
 * caller leaves the signature alone, so the row keeps reading signed:false
 * and the change stays visible.
 */
export const SANCTIONED_MARK_FIELDS = ['superseded_by', 'superseded_at', 'corrected_by'];
export function signatureCoversPriorMetadata(row, key) {
  if (!key || !row || typeof row !== 'object') return false;
  const sig = row.signature;
  if (typeof sig !== 'string' || sig.length === 0) return false;
  if (typeof row.sha256 !== 'string' || row.sha256.length === 0) return false;
  let md = row.metadata;
  if (typeof md === 'string') { try { md = JSON.parse(md); } catch { md = null; } }
  const ok = (candidate) => signDigests(row.sha256, digestMetadata(candidate), key) === sig;
  // The signature already covers the stored metadata (nothing to roll back).
  if (typeof row.metadata_sha256 === 'string' && signDigests(row.sha256, row.metadata_sha256, key) === sig
      && metadataIntegrityOf(row) === true) return true;
  if (!md || typeof md !== 'object' || Array.isArray(md)) return false;
  const supersededVariants = [md];
  if ('superseded_by' in md || 'superseded_at' in md) {
    const { superseded_by, superseded_at, ...rest } = md;
    supersededVariants.push(rest);
  }
  for (const base of supersededVariants) {
    if (ok(base)) return true;
    if (Array.isArray(base.corrected_by)) {
      const list = base.corrected_by;
      for (let k = list.length - 1; k >= 0; k--) {
        if (ok({ ...base, corrected_by: list.slice(0, k) })) return true;
      }
      const { corrected_by, ...withoutCorrected } = base;
      if (ok(withoutCorrected)) return true;
    }
  }
  return false;
}

export default { digest, verifyDocument, verifyLayerEntry, integrityOf, canonicalJson, digestMetadata, metadataIntegrityOf, signDigests, signaturePayload, signatureIntegrityOf, signatureCoversPriorMetadata, SANCTIONED_MARK_FIELDS, AlephError };
