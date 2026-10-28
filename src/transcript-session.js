/** Session transcript: one exchange at a time. No end-of-day dump. */

import { setting } from './env.js';

export const EXCHANGES_PER_PART = 8;

/**
 * The zone a session id is dated in (2026-10-01, Alex's approval; dev team plan
 * Part B, fix 1). Ids were dated from UTC, so an evening session in New York
 * carried the next day's date (episodic ref 600: `2026-10-01_grok-init` minted on
 * the night of 9/30). The day is now the user's local day: EMET_TIMEZONE, an
 * IANA zone name, default America/New_York. A name the runtime does not know
 * falls back to the default and says so - marked, never guessed at.
 */
export const DEFAULT_TIME_ZONE = 'America/New_York';

export function sessionTimeZone(raw = setting('TIMEZONE')) {
  const wanted = typeof raw === 'string' ? raw.trim() : '';
  if (!wanted) return { zone: DEFAULT_TIME_ZONE, note: null };
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: wanted });
    return { zone: wanted, note: null };
  } catch {
    return {
      zone: DEFAULT_TIME_ZONE,
      note: `EMET_TIMEZONE "${wanted}" is not a time zone this server knows; session ids are dated in ${DEFAULT_TIME_ZONE}.`
    };
  }
}

/** The calendar day of `date` in `timeZone`, as YYYY-MM-DD. */
export function localDate(date = new Date(), timeZone = DEFAULT_TIME_ZONE) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/**
 * Mint grammar for a leading session date: YYYY-MM-DD_ with month 01-12 and
 * day 01-31. This is the same shape the error log accepts. It is not a
 * calendar check: 2026-02-31 matches, 2026-13-01 and 2026-10-32 do not, and a
 * hyphen after the day (2026-10-27-foo) is not a prefix.
 *
 * board 125(d): a caller slug that already begins with this prefix is the base.
 * The server does not prepend the local day, and it does not replace or
 * refuse a well-formed prefix that is not today's date. The text after the
 * prefix is still cleaned. -N reopen and _verbatim_partN are applied later.
 */
const DATED_SLUG_PREFIX = /^([0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01]))_([\s\S]*)$/;

function cleanSlugBody(raw) {
  return String(raw || 'session').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'session';
}

export function sessionBaseId(date = new Date(), slug = 'session', timeZone = sessionTimeZone().zone) {
  const day = localDate(date, timeZone);
  const raw = typeof slug === 'string' ? slug.trim() : '';
  const dated = raw ? DATED_SLUG_PREFIX.exec(raw) : null;
  if (dated) return `${dated[1]}_${cleanSlugBody(dated[2])}`;
  return `${day}_${cleanSlugBody(slug)}`;
}

export function partId(base, n) {
  return `${base}_verbatim_part${n}`;
}

export function partNumber(session_id) {
  const m = String(session_id || '').match(/_verbatim_part(\d+)$/);
  return m ? Number(m[1]) : 1;
}

export function baseFromPart(session_id) {
  return String(session_id || '').replace(/_verbatim_part\d+$/, '') || session_id;
}

export function nextExchangeIndex(exchanges) {
  if (!Array.isArray(exchanges) || exchanges.length === 0) return 1;
  const max = exchanges.reduce((m, e) => Math.max(m, Number(e.exchange_index) || 0), 0);
  return max + 1;
}

export function shouldStartNewPart(exchangeCount) {
  return Number(exchangeCount) >= EXCHANGES_PER_PART;
}

/**
 * A closed session is never reopened (2026-10-01, Alex's approval; episodic
 * 598: a session_open returned the previous night's CLOSED id and the next
 * append landed in it as exchange 9). Returns the first of base, base-2,
 * base-3, ... that is free, and the ids it passed over with the reason.
 *
 * `statusOf(id)` is async (a store read) and returns the id's session state
 * {exists, closed, suffix_of} - or null/{} when there is none. An id is passed
 * over when:
 *   - it is closed;
 *   - it is the plain id asked for, but it was minted as another session's
 *     suffix (a real slug `fix-2` must not join `fix`'s `-2` session);
 *   - it is a suffix candidate already in use by some other session (a real
 *     slug `fix-2`, say) - only a suffix minted for THIS base is resumed.
 * A read that throws propagates, so an unchecked id is never handed out.
 * The `-N` suffix keeps the ids apart for every reader that groups transcript
 * parts by `<base>_...`.
 */
export const MAX_SESSION_SUFFIX = 99;

export async function firstUnclosedBase(base, statusOf) {
  const skipped = [];
  for (let n = 1; n <= MAX_SESSION_SUFFIX; n++) {
    const candidate = n === 1 ? base : `${base}-${n}`;
    const s = (await statusOf(candidate)) || {};
    const reason = s.closed ? 'closed'
      : (n === 1 && s.suffix_of && s.suffix_of !== base) ? `in use as a suffixed id of ${s.suffix_of}`
      : (n > 1 && s.exists && s.suffix_of !== base) ? 'in use by a session under another slug'
      : null;
    if (!reason) {
      return { base: candidate, skipped, closed: skipped.filter((x) => x.reason === 'closed').map((x) => x.id) };
    }
    skipped.push({ id: candidate, reason });
  }
  const err = new Error(`${base} and its suffixes -2 to -${MAX_SESSION_SUFFIX} are all closed or in use; open the session under a new slug.`);
  err.allClosed = true;
  throw err;
}
