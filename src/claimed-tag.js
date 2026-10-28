/**
 * Claimed-tag-only attribution (R3).
 *
 * A write is claimed-tag-only when it is HTTP, the door has no grant id, and
 * the source tag is a caller claim (declared, legacy, or auto). A bound login
 * tag and a sub-key are credentials. Stdio is the local door and is not this path.
 *
 * EMET_CLAIMED_TAG_KILL_DATE (YYYY-MM-DD, UTC) is the owner's date. Before that day
 * the write is kept and the receipt warns. On that day and after, the write
 * is refused. Unset uses PROPOSED_CLAIMED_TAG_KILL_DATE.
 *
 * The traffic counter is this process. Railway EMET is one long-lived process.
 * It is not a backfill of older rows.
 */

import { setting } from './env.js';
import { ValidationError as EmetValidationError } from './validation.js';
import { chooserBinding } from './deep-links.js';

export const PROPOSED_CLAIMED_TAG_KILL_DATE = '2026-12-15';
export const CLAIMED_TAG_WINDOW_DAYS = 7;

const CLAIMED_FROM = new Set(['declared', 'legacy', 'auto']);
const ONBOARDING = 'keyed link, then owner sign-in, then assign tag, then initialize';
const events = [];

let invalidKillWarned = '';

export function _resetClaimedTagForTests() {
  events.length = 0;
  invalidKillWarned = '';
}

/**
 * The date in force, and whether the owner's setting was usable.
 * A value that is not YYYY-MM-DD does not move the date. It is reported
 * (kill_date_invalid on claimed_tag_traffic) and warned once per distinct value.
 */
export function claimedTagKillSetting() {
  const raw = setting('CLAIMED_TAG_KILL_DATE');
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) {
    return { kill_date: PROPOSED_CLAIMED_TAG_KILL_DATE, source: 'proposed', invalid: false, raw: null };
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return { kill_date: text, source: 'env', invalid: false, raw: text };
  }
  const shown = text.slice(0, 80);
  if (invalidKillWarned !== shown) {
    invalidKillWarned = shown;
    console.error(`EMET_CLAIMED_TAG_KILL_DATE ${JSON.stringify(shown)} is not YYYY-MM-DD. The kill date stays ${PROPOSED_CLAIMED_TAG_KILL_DATE} until the setting is a date.`);
  }
  return { kill_date: PROPOSED_CLAIMED_TAG_KILL_DATE, source: 'invalid', invalid: true, raw: shown };
}

export function claimedTagKillDate() {
  return claimedTagKillSetting().kill_date;
}

export function claimedTagKillReached(now = new Date(), kill = claimedTagKillDate()) {
  return now.toISOString().slice(0, 10) >= kill;
}

/** HTTP, no door grant, source taken from a claim. */
export function isClaimedTagOnly({ transport, grant_id, sourceFrom } = {}) {
  return transport === 'http' && (grant_id === null || grant_id === undefined) && CLAIMED_FROM.has(sourceFrom);
}

function noteClaimedTag(row) {
  events.push({
    t: row.t || new Date().toISOString(),
    caller: typeof row.caller === 'string' && row.caller.trim() ? row.caller.trim().slice(0, 80) : 'unregistered',
    tool: typeof row.tool === 'string' && row.tool ? row.tool.slice(0, 80) : 'write',
    grant_id: 'unknown',
    source_basis: 'claimed'
  });
  const cutoff = Date.now() - 30 * 86400000;
  while (events.length && Date.parse(events[0].t) < cutoff) events.shift();
}

/**
 * Warn, or refuse once the kill date has arrived. Notes the attempt either way.
 * Returns { claimed, warning }. Throws EMET-AUTH-040 when the path is closed.
 */
export function guardClaimedTag({ transport, grant_id, sourceFrom, caller, tool, now = new Date() } = {}) {
  if (!isClaimedTagOnly({ transport, grant_id, sourceFrom })) return { claimed: false, warning: null };
  const kill = claimedTagKillDate();
  noteClaimedTag({ t: now.toISOString(), caller, tool });
  if (claimedTagKillReached(now, kill)) {
    // The coded throw stays `throw new ValidationError` so the error-code
    // snapshot still sees EMET-AUTH-040. The local constructor returns that
    // error with the chooser binding attached. `new` uses the returned object.
    function ValidationError(field, message, options) {
      const err = new EmetValidationError(field, message, options);
      err.chooser = chooserBinding({ kind: 'claimed_tag', grantId: 'unknown', tag: caller, door: 'guest' });
      return err;
    }
    throw new ValidationError(
      'source',
      `This write is attributed only by a claimed source tag, and that path ended on ${kill}. A write needs a credential: ${ONBOARDING}. Nothing was written.`,
      { code: 'EMET-AUTH-040' }
    );
  }
  return {
    claimed: true,
    warning: `Claimed source tag only (no grant). This path warns until ${kill} and is refused on that date. A write needs a credential: ${ONBOARDING}.`
  };
}

/** Remaining claimed-tag attempts in the window, for emet_status. */
export function claimedTagTraffic(now = new Date()) {
  const days = CLAIMED_TAG_WINDOW_DAYS;
  const since = now.getTime() - days * 86400000;
  const callers = new Map();
  let count = 0;
  for (const row of events) {
    const t = Date.parse(row.t);
    if (!Number.isFinite(t) || t < since) continue;
    count += 1;
    callers.set(row.caller, (callers.get(row.caller) || 0) + 1);
  }
  const cfg = claimedTagKillSetting();
  return {
    window_days: days,
    count,
    callers: [...callers.entries()]
      .map(([caller, n]) => ({ caller, count: n }))
      .sort((a, b) => b.count - a.count || (a.caller < b.caller ? -1 : a.caller > b.caller ? 1 : 0)),
    kill_date: cfg.kill_date,
    proposed_kill_date: PROPOSED_CLAIMED_TAG_KILL_DATE,
    // env: the owner's date parsed. default: unset, the proposed date.
    // invalid_env: the setting was not YYYY-MM-DD, so the date did not move.
    kill_date_source: cfg.source === 'env' ? 'env' : cfg.source === 'invalid' ? 'invalid_env' : 'default',
    kill_date_invalid: cfg.invalid,
    kill_date_raw: cfg.raw,
    // This process only. Not a count of older rows.
    since_process_start: true,
    mode: claimedTagKillReached(now, cfg.kill_date) ? 'refuse' : 'warn'
  };
}
