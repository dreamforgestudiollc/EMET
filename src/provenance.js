/**
 * EMET - Enduring Memory & Epistemic Tiers
 * Copyright (c) 2026 Dreamforge Studio LLC
 *
 * Licensed under the MIT License - see LICENSE
 *
 * Provenance: how a tier-1 entry reaches the tier-2 record that justifies it.
 *
 * "Epistemic Tiers" names the pairing of a claim with its evidence. A layer
 * entry that asserts something, with no reachable source, is a claim the system
 * merely happens to hold - so the link between the tiers is not a convenience,
 * it is the half of the name that makes the other half worth anything.
 *
 * TWO MECHANISMS, DELIBERATELY, AND THEY ARE NOT REDUNDANT COPIES.
 *
 *   POINTER   - the entry records the transcript span it came from: a session id
 *               and a range of exchange indices. Exact. Conditional: absent on
 *               everything written before pointers existed, and legitimately
 *               absent on entries consolidated from other entries rather than
 *               from a conversation.
 *
 *   TIMESTAMP - every entry has one, unconditionally, so a window around it can
 *               always be searched. Universal. Approximate: it depends on
 *               choosing the window, it degrades when sessions overlap or run
 *               long, and when it is wrong it returns the NEIGHBOURING span
 *               rather than failing. A silent wrong answer is the worst possible
 *               failure shape for a provenance mechanism.
 *
 * PRECEDENCE IS WHAT KEEPS THEM FROM CONFLICTING. The pointer wins whenever it
 * is present; the timestamp is the fallback when it is null. They are never
 * averaged, never combined, and the timestamp is never preferred merely because
 * it returned something. Without a stated precedence two links are ambiguity;
 * with one they are a primary and a fallback.
 *
 * AND KEEPING BOTH BUYS SOMETHING NEITHER GIVES ALONE: they can check each
 * other. If an entry's pointer names a session whose span sits nowhere near that
 * entry's own timestamp, something is wrong - a mis-written pointer, a field
 * copied from another entry, an entry attributed to the wrong session. Two
 * independently derived answers that can disagree is redundancy in the
 * engineering sense. A single link that can only be trusted is not.
 *
 * WHY THESE ARE TOP-LEVEL FIELDS. They sit beside the entry, not inside the
 * metadata JSON string, for the same reason `superseded_by`, `valid_until` and
 * `is_live` were promoted: the store cannot filter into a JSON string, so a
 * pointer buried there could be written but never queried - and the reverse
 * question, "what did we take from this session?", is exactly a query.
 *
 * NO BACKFILL. An entry written before pointers existed cannot be given a true
 * one; the only way to invent it is to infer the span from the timestamp, which
 * is precisely the weaker method the pointer exists to replace. Historical
 * entries keep a null pointer and resolve by timestamp, and that remains correct
 * for them - superseded, not wrong. Old records are not rewritten to look like
 * new ones; the method that applies to them is written down instead.
 */

import { ValidationError } from './validation.js';

/** Default half-width of the timestamp fallback window, in seconds. */
export const FALLBACK_WINDOW_SECONDS = 3600;

/** How far a pointer's session may sit from an entry's timestamp before the
 *  cross-check calls it suspicious. Generous: long sessions are normal, and a
 *  false alarm here trains its reader to ignore the check. */
const CROSS_CHECK_TOLERANCE_SECONDS = 24 * 3600;

function isPositiveInt(v) {
  return Number.isInteger(v) && v > 0;
}

/**
 * Validate a caller-supplied provenance object.
 *
 * Accepts either shape, and only one of them:
 *   { session_id, exchange_start, exchange_end }  - derived from a conversation
 *   { entries: [id, ...] }                        - consolidated from other entries
 *
 * The second shape exists because a required field with no honest value invites
 * fabrication. An entry consolidated from three others has no transcript span,
 * and must be able to say so explicitly rather than carry a nearest-timestamp
 * guess dressed as a citation.
 */
export function validateProvenance(input) {
  if (input === null || input === undefined) return null;
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError('derived_from', 'must be an object');
  }

  const hasSpan = input.session_id !== undefined;
  const hasEntries = input.entries !== undefined;

  if (hasSpan && hasEntries) {
    throw new ValidationError(
      'derived_from',
      'give a transcript span or a list of source entries, not both - an entry has one origin'
    );
  }
  if (!hasSpan && !hasEntries) {
    throw new ValidationError(
      'derived_from',
      'needs either session_id (with optional exchange_start/exchange_end) or entries'
    );
  }

  if (hasEntries) {
    if (!Array.isArray(input.entries) || input.entries.length === 0) {
      throw new ValidationError('derived_from.entries', 'must be a non-empty array of entry ids');
    }
    if (!input.entries.every(isPositiveInt)) {
      throw new ValidationError('derived_from.entries', 'entry ids must be positive integers');
    }
    return { entries: [...input.entries] };
  }

  if (typeof input.session_id !== 'string' || input.session_id.length === 0) {
    throw new ValidationError('derived_from.session_id', 'must be a non-empty string');
  }
  const start = input.exchange_start;
  const end = input.exchange_end;
  if (start !== undefined && !isPositiveInt(start)) {
    throw new ValidationError('derived_from.exchange_start', 'must be a positive integer');
  }
  if (end !== undefined && !isPositiveInt(end)) {
    throw new ValidationError('derived_from.exchange_end', 'must be a positive integer');
  }
  if (isPositiveInt(start) && isPositiveInt(end) && end < start) {
    throw new ValidationError('derived_from.exchange_end', 'must not be before exchange_start');
  }

  return {
    session_id: input.session_id,
    exchange_start: isPositiveInt(start) ? start : null,
    exchange_end: isPositiveInt(end) ? end : (isPositiveInt(start) ? start : null)
  };
}

/**
 * The top-level columns to store for a validated provenance object.
 * Always returns every key, so an entry without provenance stores explicit nulls
 * rather than absent fields - absence and "no pointer" must not be the same
 * shape as "this field was never part of the schema".
 */
export function provenanceColumns(provenance) {
  if (!provenance) {
    return { source_session_id: null, source_exchange_start: null, source_exchange_end: null, derived_from_ids: null };
  }
  if (provenance.entries) {
    return { source_session_id: null, source_exchange_start: null, source_exchange_end: null, derived_from_ids: provenance.entries };
  }
  return {
    source_session_id: provenance.session_id,
    source_exchange_start: provenance.exchange_start,
    source_exchange_end: provenance.exchange_end,
    derived_from_ids: null
  };
}

/**
 * Resolve how to reach the evidence for an entry.
 *
 * This is the precedence rule, in one place, so no caller has to decide it.
 */
export function resolveProvenance(entry, windowSeconds = FALLBACK_WINDOW_SECONDS) {
  if (!entry) throw new ValidationError('entry', 'is required');

  if (entry.source_session_id) {
    return {
      method: 'pointer',
      exact: true,
      session_id: entry.source_session_id,
      exchange_start: entry.source_exchange_start ?? null,
      exchange_end: entry.source_exchange_end ?? null,
      how: 'Read this session\'s transcript and take the named exchange range.'
    };
  }

  if (Array.isArray(entry.derived_from_ids) && entry.derived_from_ids.length > 0) {
    return {
      method: 'entries',
      exact: true,
      entries: entry.derived_from_ids,
      how: 'This entry was consolidated from other entries. Read those; they carry their own provenance.'
    };
  }

  const timestamp = typeof entry.timestamp === 'number' ? entry.timestamp : null;
  if (timestamp === null) {
    return {
      method: 'none',
      exact: false,
      how: 'No pointer and no timestamp. The source of this entry cannot be reached; treat the claim as unsourced.'
    };
  }

  return {
    method: 'timestamp',
    exact: false,
    timestamp_start: timestamp - windowSeconds,
    timestamp_end: timestamp + windowSeconds,
    how:
      'No pointer on this entry, so fall back to searching transcripts over a window around its ' +
      'timestamp. This is approximate: it can return a neighbouring span rather than the real ' +
      'one, and an empty result is not proof that nothing was recorded. Do not cite a window ' +
      'result with the confidence of a pointer.'
  };
}

/**
 * Cross-check a pointer against the entry's own timestamp.
 *
 * The reason to keep both mechanisms rather than replacing one with the other:
 * two independently derived answers can disagree, and a disagreement is
 * information. Returns a finding; it never throws and never blocks a write,
 * because a suspicious pointer is a thing to look at, not a thing to refuse.
 */
export function crossCheckProvenance(entry, transcript, toleranceSeconds = CROSS_CHECK_TOLERANCE_SECONDS) {
  if (!entry || !entry.source_session_id) return { checked: false, reason: 'no pointer to check' };
  if (!transcript) {
    return {
      checked: true,
      agrees: false,
      finding: `Entry points at session "${entry.source_session_id}", which does not exist in the transcript store.`
    };
  }

  const toSeconds = (v) => {
    if (v instanceof Date) return v.getTime() / 1000;
    if (typeof v === 'number') return v > 1e11 ? v / 1000 : v;
    return null;
  };
  const start = toSeconds(transcript.session_start);
  const end = toSeconds(transcript.session_end) ?? start;
  const at = typeof entry.timestamp === 'number' ? entry.timestamp : null;

  if (at === null || start === null) return { checked: false, reason: 'not enough timing information to compare' };

  const distance = at < start ? start - at : (at > end ? at - end : 0);
  if (distance <= toleranceSeconds) return { checked: true, agrees: true, distance_seconds: Math.round(distance) };

  return {
    checked: true,
    agrees: false,
    distance_seconds: Math.round(distance),
    finding:
      `Entry timestamp sits ${Math.round(distance / 3600)}h outside the session its pointer names. ` +
      `The pointer and the timestamp disagree about where this entry came from - likely a field ` +
      `copied from another entry, or an entry attributed to the wrong session. Report it; do not ` +
      `silently prefer either one.`
  };
}

export default {
  validateProvenance,
  provenanceColumns,
  resolveProvenance,
  crossCheckProvenance,
  FALLBACK_WINDOW_SECONDS
};
