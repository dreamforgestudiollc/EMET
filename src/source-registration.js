/**
 * EMET - Enduring Memory & Epistemic Tiers
 * Copyright (c) 2026 Dreamforge Studio LLC
 *
 * Licensed under the MIT License - see LICENSE
 *
 * One membership test for a source tag.
 *
 * emet_transcript_append refuses a tag that is not an exact member of
 * registeredSourceTags() (EMET_SOURCE_TAGS, plus approved tags once that
 * record is loaded). save_to_layer and the document writes that still store
 * an unregistered tag use the same test. Before the cutoff those saves are
 * kept and the receipt warns. On the cutoff date, America/New_York, they
 * are refused and nothing is written.
 *
 * A missing tag is not this refusal. Transcript writes already require one.
 * A save with no tag stays source_missing. Historical rows are not rewritten.
 */

import { setting } from './env.js';
import { registeredSourceTags } from './setup.js';
import { echoId } from './session-graph.js';
import { ValidationError } from './validation.js';
import { serverNow, serverNowIsPinned } from './server-time.js';
import { sourceSaveOutcome } from './source-save-statechart.js';

export const PROPOSED_SOURCE_SAVE_CUTOFF = '2026-12-15';
export const SOURCE_SAVE_ZONE = 'America/New_York';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
let invalidCutoffWarned = '';

export function _resetSourceSaveCutoffWarningForTests() {
  invalidCutoffWarned = '';
}

/**
 * The civil date in force. A value that is not YYYY-MM-DD does not move it.
 * The shape check does not test that the month and day are a real date.
 */
export function sourceSaveCutoffSetting() {
  const raw = setting('SOURCE_SAVE_CUTOFF');
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) {
    return { cutoff: PROPOSED_SOURCE_SAVE_CUTOFF, source: 'proposed', invalid: false, raw: null };
  }
  if (DATE_RE.test(text)) {
    return { cutoff: text, source: 'env', invalid: false, raw: text };
  }
  const shown = text.slice(0, 80);
  if (invalidCutoffWarned !== shown) {
    invalidCutoffWarned = shown;
    console.error(`EMET_SOURCE_SAVE_CUTOFF ${JSON.stringify(shown)} is not YYYY-MM-DD. The cutoff stays ${PROPOSED_SOURCE_SAVE_CUTOFF} until the setting is a date.`);
  }
  return { cutoff: PROPOSED_SOURCE_SAVE_CUTOFF, source: 'invalid', invalid: true, raw: shown };
}

export function sourceSaveCutoff() {
  return sourceSaveCutoffSetting().cutoff;
}

/**
 * YYYY-MM-DD in America/New_York. The process time zone is not consulted.
 * A clock that cannot be formatted returns null. The save is not refused
 * for that. A clock failure does not fail the write.
 */
export function sourceSaveCivilDate(now = new Date()) {
  const date = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(date.getTime())) return null;
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: SOURCE_SAVE_ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(date);
  } catch {
    return null;
  }
}

/**
 * `before` the cutoff date, or `on_or_after` it. The cutoff day itself refuses.
 * An unreadable clock stays `before`, so the save is not refused.
 */
export function sourceSavePhase(now = new Date(), cutoff = sourceSaveCutoff()) {
  const day = sourceSaveCivilDate(now);
  if (!day) return 'before';
  return day >= cutoff ? 'on_or_after' : 'before';
}

/**
 * The same membership emet_transcript_append uses.
 * `open` — no registry, any tag passes.
 * `registered` — exact member of registeredSourceTags().
 * `absent` — no tag. Not an unregistered tag.
 * `unregistered` — a tag that is not a member.
 */
export function sourceMembership(tag, registry = registeredSourceTags()) {
  if (!registry.length) return 'open';
  if (typeof tag === 'string' && tag !== '' && registry.includes(tag)) return 'registered';
  if (tag === null || tag === undefined || tag === '') return 'absent';
  return 'unregistered';
}

function refusalMessage(tool, tag, cutoff) {
  return `${tool}: source "${echoId(tag)}" is not registered. Unregistered saves are refused from ${cutoff} (${SOURCE_SAVE_ZONE}). Pass a registered source. Nothing was written.`;
}

function warningMessage(tag, cutoff) {
  return `Source "${echoId(tag)}" is not registered. This save is kept until ${cutoff} (${SOURCE_SAVE_ZONE}) and is refused on that date. Pass a registered source.`;
}

/**
 * Warn, or refuse once the cutoff date has arrived in America/New_York.
 * Returns { membership, unregistered, warning }. Throws EMET-MEM-035 when
 * the save is closed. Call before any insert.
 */
/**
 * EMET_TEST_CLOCK is the suite run after 2026-12-15. It is ignored unless
 * EMET_UNDER_TEST=1, which the test runner sets and a server does not.
 * A production process with the clock variable set still uses the wall clock.
 */
function testClock() {
  if (process.env.EMET_UNDER_TEST !== '1') return null;
  const raw = process.env.EMET_TEST_CLOCK;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const pinned = new Date(raw.trim());
  return Number.isNaN(pinned.getTime()) ? null : pinned;
}

/**
 * The cutoff clock. An explicit instant wins, then a serverNow test pin, then
 * the test clock. Otherwise the real clock. The test clock does not move
 * receipts or the claimed-tag kill date.
 */
export function sourceSaveNow(explicit) {
  if (explicit instanceof Date && !Number.isNaN(explicit.getTime())) return explicit;
  if (serverNowIsPinned()) return serverNow();
  return testClock() || serverNow();
}

export function guardUnregisteredSourceSave({ tag, tool = 'save_to_layer', now } = {}) {
  const at = sourceSaveNow(now);
  const cutoff = sourceSaveCutoff();
  const membership = sourceMembership(tag);
  const phase = sourceSavePhase(at, cutoff);
  const outcome = sourceSaveOutcome({ membership, phase });
  if (outcome.refused) {
    throw new ValidationError('source', refusalMessage(tool, tag, cutoff), { code: 'EMET-MEM-035' });
  }
  return {
    membership,
    unregistered: membership === 'unregistered',
    warning: outcome.warned ? warningMessage(tag, cutoff) : null
  };
}
