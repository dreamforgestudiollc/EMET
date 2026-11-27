/**
 * Server clock for write receipts .
 *
 * A host writes its own local time into a HANDOFF heading or a board patch
 * line. That clock can be wrong. The server stamps its own time on the
 * receipt and on the stored row, and a skew check can warn. The check does
 * not refuse the write and does not rewrite the host's text.
 *
 * The formatter and the parser are pure. setServerNowForTests is the only
 * clock seam, and tests are the only caller.
 */

import { setting } from './env.js';
import { sessionTimeZone } from './transcript-session.js';

const DEFAULT_SKEW_MIN = 90;

/**
 * M/D ~h:mm AM|PM ET, and only that. A digit or letter glued to the month
 * (v11/9, 2311/2) is not a date. EST and UTC are not ET.
 */
const HOST_CLOCK_RE = /(?<![A-Za-z0-9])(\d{1,2})\/(\d{1,2})(?![0-9]) ~(\d{1,2}):(\d{2}) (AM|PM) ET\b/;

let nowOverride = null;

/** Pin the clock. Pass null to use the real clock again. Tests only. */
export function setServerNowForTests(date) {
  nowOverride = date == null ? null : new Date(date);
}

/** The instant a write stamps. A test pin wins over `fallback`. */
export function serverNow(fallback = new Date()) {
  return nowOverride ? new Date(nowOverride.getTime()) : fallback;
}

/** True when a test has pinned a readable instant. An invalid pin does not count. */
export function serverNowIsPinned() {
  return nowOverride instanceof Date && !Number.isNaN(nowOverride.getTime());
}

function zonedParts(date, zone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'short'
  }).formatToParts(date);
  const get = (type) => {
    const found = parts.find((p) => p.type === type);
    return found ? found.value : '';
  };
  let hour = get('hour');
  if (hour === '24') hour = '00';
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(hour),
    minute: Number(get('minute')),
    second: Number(get('second')),
    zoneName: get('timeZoneName')
  };
}

function pad(n) {
  return String(n).padStart(2, '0');
}

/** YYYY-MM-DD HH:mm zzz in `zone`. */
export function formatLocal(date, zone) {
  const p = zonedParts(date, zone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)} ${p.zoneName}`;
}

/** Numeric offset of `zone` at `date`, as +HH:mm or -HH:mm. */
export function formatOffset(date, zone) {
  const off = offsetMs(date, zone);
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  const hours = Math.floor(abs / 3600000);
  const minutes = Math.floor((abs % 3600000) / 60000);
  return `${sign}${pad(hours)}:${pad(minutes)}`;
}

/**
 * `{ utc, local, zone, offset }` for `date`, or null when the clock or the
 * zone cannot be formatted. A null stamp does not fail the write.
 * `zone` defaults to EMET_TIMEZONE (America/New_York when unset or unknown).
 */
export function serverTime(date = new Date(), zone = sessionTimeZone().zone) {
  try {
    const when = date instanceof Date ? date : new Date(date);
    if (Number.isNaN(when.getTime())) return null;
    return {
      utc: when.toISOString(),
      local: formatLocal(when, zone),
      zone,
      offset: formatOffset(when, zone)
    };
  } catch {
    return null;
  }
}

/** Minutes. Unset, blank, or not a non-negative number uses 90. */
export function hostSkewMinutes(raw = setting('HOST_TIME_SKEW_MIN')) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return DEFAULT_SKEW_MIN;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_SKEW_MIN;
  return n;
}

function to24(hour, ap) {
  if (!Number.isInteger(hour) || hour < 1 || hour > 12) return null;
  if (ap === 'AM') return hour === 12 ? 0 : hour;
  return hour === 12 ? 12 : hour + 12;
}

/** Offset of `zone` at `date`, in milliseconds (local wall clock minus UTC). */
function offsetMs(date, zone) {
  const p = zonedParts(date, zone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - date.getTime();
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function calendarDayExists(year, month, day) {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  return day <= daysInMonth(year, month);
}

/**
 * A wall clock that falls in a spring-forward gap. Shift it forward by the
 * gap: read it with the offset in force before the gap. That instant is the
 * local time after the jump. A day that is not on the calendar stays empty.
 */
function gapShifted(year, month, day, hour, minute, zone) {
  if (!calendarDayExists(year, month, day)) return [];
  let y = year;
  let m = month;
  let d = day;
  let h = hour;
  let min = minute;
  for (let step = 0; step < 72; step++) {
    min -= 30;
    if (min < 0) { min += 60; h -= 1; }
    if (h < 0) { h += 24; d -= 1; }
    if (d < 1) {
      m -= 1;
      if (m < 1) { m = 12; y -= 1; }
      d = daysInMonth(y, m);
    }
    const found = instantsForWall(y, m, d, h, min, zone);
    if (!found.length) continue;
    const earlier = found.reduce((a, b) => (a.getTime() <= b.getTime() ? a : b));
    let off;
    try { off = offsetMs(earlier, zone); } catch { return []; }
    return [new Date(Date.UTC(year, month - 1, day, hour, minute, 0) - off)];
  }
  return [];
}

/**
 * Every UTC instant that reads as that wall clock in `zone`. A fall-back
 * hour has two. A spring-forward gap has none.
 */
function instantsForWall(year, month, day, hour, minute, zone) {
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour < 0 || hour > 23 || minute < 0 || minute > 59) return [];
  const nominal = Date.UTC(year, month - 1, day, hour, minute, 0);
  let off;
  try { off = offsetMs(new Date(nominal), zone); } catch { return []; }
  const seen = new Set();
  const out = [];
  for (const ms of [nominal - off, nominal - off - 3600000, nominal - off + 3600000]) {
    if (seen.has(ms)) continue;
    seen.add(ms);
    const when = new Date(ms);
    let p;
    try { p = zonedParts(when, zone); } catch { continue; }
    if (p.year === year && p.month === month && p.day === day && p.hour === hour && p.minute === minute) out.push(when);
  }
  return out;
}

/**
 * The first heading or the first `Patch` line, and only that line.
 * A later patch line is ignored. No match on that line means no host time.
 */
export function topHostClock(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const heading = /^#{1,6}\s+\S/.test(line);
    const patch = /^Patch\b/.test(line);
    if (!heading && !patch) continue;
    const m = HOST_CLOCK_RE.exec(line);
    if (!m) return null;
    return {
      month: Number(m[1]),
      day: Number(m[2]),
      hour: Number(m[3]),
      minute: Number(m[4]),
      ap: m[5],
      phrase: m[0]
    };
  }
  return null;
}

/**
 * A warning string when the top host time is more than `skewMin` minutes
 * from `stamped`, or null when there is nothing to say. Never a failure.
 */
export function hostTimeSkewWarning(content, stamped, skewMin = hostSkewMinutes()) {
  try {
    const clock = topHostClock(content);
    if (!clock || !stamped || typeof stamped.local !== 'string' || typeof stamped.utc !== 'string' || typeof stamped.zone !== 'string') return null;
    const hour = to24(clock.hour, clock.ap);
    if (hour === null || clock.minute > 59) return null;
    const server = new Date(stamped.utc);
    if (Number.isNaN(server.getTime())) return null;
    const serverYear = zonedParts(server, stamped.zone).year;
    if (!Number.isInteger(serverYear)) return null;
    // The heading has no year. The closest of the server year and its two
    // neighbors is the one a host meant, including either fall-back hour.
    // A spring-forward gap has no instant. Shift that wall clock forward by
    // the gap, so a 02:30 wall clock in the spring-forward hour is not a year-away skew.
    let best = Infinity;
    for (const year of [serverYear - 1, serverYear, serverYear + 1]) {
      let hosts = instantsForWall(year, clock.month, clock.day, hour, clock.minute, stamped.zone);
      if (hosts.length === 0) hosts = gapShifted(year, clock.month, clock.day, hour, clock.minute, stamped.zone);
      for (const host of hosts) {
        const delta = Math.abs(host.getTime() - server.getTime()) / 60000;
        if (delta < best) best = delta;
      }
    }
    if (!Number.isFinite(best) || !(best > skewMin)) return null;
    return `host-written time ${clock.phrase} differs from the server local time ${stamped.local} by more than ${skewMin} minutes`;
  } catch {
    return null;
  }
}
