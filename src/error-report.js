/**
 * Owner-only error report. This module does not send mail and does not
 * open a network connection. A calling assistant may pass the structured
 * email to its own mail tool only after the user has seen the report and agreed.
 */

import crypto from 'node:crypto';
import { ValidationError } from './validation.js';
import { currentActor, getPerson } from './persons.js';
import { EMET_VERSION } from './version.js';
import { ERROR_CODES, EMET_CODE_RE } from './error-codes.js';
import { redactText } from './redact.js';
import { logClientId, logDoor, logGrantId } from './grants.js';
import { queryErrorLog, logSessionId } from './error-log.js';

export const SEND_INSTRUCTION = 'The calling assistant may send this report only after showing the report to its user and getting their OK.';
export const DEFAULT_REPORT_EMAIL = 'dreamforgestudio@mail.hubbot.com';
export const MAILTO_MAX = 1800;

/**
 * One plain address: exactly one @. The local part is letters, digits, and
 * . _ + - , and it does not start or end with a dot or contain "..".
 * The domain is two or more labels separated by dots. A label is letters,
 * digits, and -, and it does not start or end with -.
 */
export function plainReportAddress(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  const at = value.indexOf('@');
  if (at < 1 || at !== value.lastIndexOf('@') || at === value.length - 1) return false;
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (!/^[A-Za-z0-9._+-]+$/.test(local)) return false;
  if (local.startsWith('.') || local.endsWith('.') || local.includes('..')) return false;
  const labels = domain.split('.');
  if (labels.length < 2) return false;
  const labelOk = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
  if (labels.some((label) => !labelOk.test(label))) return false;
  return true;
}

export function reportEmailAddress() {
  if (!plainReportAddress(DEFAULT_REPORT_EMAIL)) return '';
  if (process.env.EMET_REPORT_EMAIL == null) return DEFAULT_REPORT_EMAIL;
  const raw = process.env.EMET_REPORT_EMAIL;
  if (raw === '' || !plainReportAddress(raw)) return '';
  return raw;
}

export async function assertReportOwner(db) {
  const actor = currentActor();
  if (actor.transport === 'stdio') return;
  const person = actor.transport === 'http' && actor.personId && db ? await getPerson(db, actor.personId) : null;
  if (!person || person.role !== 'owner') {
    throw new ValidationError('The error report is owner-only.', { code: 'EMET-AUTH-038' });
  }
}

export function validateReportArgs(args = {}, now = new Date()) {
  const out = { since: null, codes: null, correlation_id: null, limit: 50, now };
  if (args.correlation_id != null && args.correlation_id !== '') {
    if (typeof args.correlation_id !== 'string' || !/^[0-9a-f]{16}$/.test(args.correlation_id)) {
      throw new ValidationError('correlation_id must be 16 hex characters.', { code: 'EMET-TOOL-013' });
    }
    out.correlation_id = args.correlation_id;
  }
  if (args.limit != null) {
    if (typeof args.limit !== 'number' || !Number.isInteger(args.limit) || args.limit < 1 || args.limit > 200) {
      throw new ValidationError('limit must be a whole number from 1 to 200.', { code: 'EMET-TOOL-012' });
    }
    out.limit = args.limit;
  }
  if (args.codes != null) {
    if (!Array.isArray(args.codes) || args.codes.some((code) => typeof code !== 'string' || !EMET_CODE_RE.test(code))) {
      throw new ValidationError('codes must be a list of EMET codes.', { code: 'EMET-TOOL-011' });
    }
    out.codes = args.codes;
  }
  if (!out.correlation_id) {
    let since;
    if (args.since == null || args.since === '') {
      since = new Date(now.getTime() - 7 * 86400000);
    } else if (typeof args.since !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)?$/.test(args.since)) {
      throw new ValidationError('since must be an ISO date.', { code: 'EMET-TOOL-009' });
    } else {
      since = new Date(args.since.length === 10 ? `${args.since}T00:00:00.000Z` : args.since);
      if (Number.isNaN(since.getTime())) throw new ValidationError('since must be an ISO date.', { code: 'EMET-TOOL-009' });
    }
    const oldest = now.getTime() - 90 * 86400000;
    if (since.getTime() < oldest - 1000) {
      throw new ValidationError('since is older than 90 days.', { code: 'EMET-TOOL-010' });
    }
    out.since = since.toISOString();
  }
  return out;
}

function shown(entry) {
  return {
    t: redactText(String(entry.t || '')),
    emet_code: redactText(String(entry.emet_code || '')),
    tool: redactText(String(entry.tool || '')),
    transport: entry.transport === 'http' ? 'http' : 'stdio',
    caller: redactText(String(entry.caller || 'unregistered')),
    role: entry.role === 'owner' ? 'owner' : 'guest',
    client_id: logClientId(entry.client_id),
    grant_id: logGrantId(entry.grant_id),
    door: logDoor(entry.door),
    session_id: shownSessionId(entry.session_id),
    correlation_id: redactText(String(entry.correlation_id || ''))
  };
}

/** A stored session id, or none when the row is not a session close. */
function shownSessionId(id) {
  if (id == null || id === '' || id === 'none') return 'none';
  if (id === 'unknown') return 'unknown';
  return logSessionId(id);
}

function totalsOf(rows) {
  const map = new Map();
  for (const row of rows) {
    const code = row.emet_code;
    const cur = map.get(code) || { emet_code: code, count: 0, tools: new Map() };
    cur.count += 1;
    cur.tools.set(row.tool, (cur.tools.get(row.tool) || 0) + 1);
    map.set(code, cur);
  }
  return [...map.values()]
    .sort((a, b) => b.count - a.count || (a.emet_code < b.emet_code ? -1 : 1))
    .map((row) => {
      let tool = 'unknown';
      let best = -1;
      for (const [name, count] of row.tools) {
        if (count > best) { tool = name; best = count; }
      }
      const known = ERROR_CODES[row.emet_code];
      return { emet_code: row.emet_code, summary: known ? known.summary : row.emet_code, count: row.count, tool };
    });
}

function assemble({ version, shortId, generated, windowStart, windowEnd, nodeVersion, totals, recent, notes }) {
  const lines = [];
  lines.push(`EMET error report ${version} ${shortId}`);
  lines.push(`Generated: ${generated}   EMET ${version}   Node ${nodeVersion}`);
  lines.push(`Window: ${windowStart} to ${windowEnd} (UTC)`);
  lines.push('');
  lines.push('Totals');
  if (!totals.length) lines.push('  (none)');
  for (const row of totals) lines.push(`  ${row.emet_code}  ${row.summary}  ${row.count}   ${row.tool}`);
  for (const note of notes) lines.push(note);
  lines.push('');
  lines.push('Most recent');
  if (!recent.length) lines.push('  (none)');
  for (const entry of recent) {
    lines.push(`  ${entry.t}  ${entry.emet_code}  ${entry.tool}  ${entry.transport}  ${entry.caller}  ${entry.role}  ${entry.client_id}  ${entry.grant_id}  ${entry.door}  ${entry.session_id}  ${entry.correlation_id}`);
  }
  lines.push('');
  lines.push('Contains: codes, times, tool names, versions, caller tags, client ids, grant ids, doors, session ids.');
  lines.push('Does not contain: memory, documents, arguments, message text, or tokens.');
  lines.push('You are sending this yourself. EMET has not sent it anywhere.');
  return lines.join('\n');
}

function mailtoLink(to, subject, body) {
  const text = String(body).replace(/\r?\n/g, '\r\n');
  return `mailto:${to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(text)}`;
}

export function fitReportEmail({ to, subject, base }) {
  const full = assemble({ ...base, notes: [] });
  const fullLink = mailtoLink(to, subject, full);
  if (fullLink.length <= MAILTO_MAX) {
    return { body: full, mailto: fullLink, truncated: false, entries_in_link: base.recent.length, report: full };
  }
  const listed = base.recent.length;
  for (let count = listed - 1; count >= 1; count--) {
    const notes = [`Truncated: showing the ${count} most recent of ${listed} entries. The full report is in the tool output above.`];
    const body = assemble({ ...base, recent: base.recent.slice(0, count), notes });
    const link = mailtoLink(to, subject, body);
    if (link.length <= MAILTO_MAX) return { body, mailto: link, truncated: true, entries_in_link: count, report: full };
  }
  for (let keep = base.totals.length; keep >= 0; keep--) {
    const omitted = base.totals.length - keep;
    const notes = [];
    if (listed) notes.push(`Truncated: showing none of the ${listed} most recent entries. The full report is in the tool output above.`);
    if (omitted) notes.push(`Truncated: totals omit ${omitted} codes. The full report is in the tool output above.`);
    const body = assemble({ ...base, totals: base.totals.slice(0, keep), recent: [], notes });
    const link = mailtoLink(to, subject, body);
    if (link.length <= MAILTO_MAX) return { body, mailto: link, truncated: true, entries_in_link: 0, report: full };
  }
  const body = assemble({ ...base, totals: [], recent: [], notes: ['Truncated: the full report is in the tool output above.'] });
  const link = mailtoLink(to, subject, body);
  if (link.length <= MAILTO_MAX) {
    return { body, mailto: link, truncated: true, entries_in_link: 0, report: full };
  }
  return {
    body,
    mailto: null,
    reason: 'The mailto link would exceed 1800 characters.',
    truncated: true,
    entries_in_link: 0,
    report: full
  };
}

function windowLabel(rows, since, now) {
  if (rows.length) {
    const oldest = rows[rows.length - 1].t.slice(0, 10);
    const newest = rows[0].t.slice(0, 10);
    return [oldest, newest];
  }
  const end = now.toISOString().slice(0, 10);
  const start = since ? since.slice(0, 10) : end;
  return [start, end];
}

export function composeErrorReport(rows, { since, now, shortId, limit = rows.length, nodeVersion = process.versions.node } = {}) {
  const version = EMET_VERSION;
  const generated = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const [windowStart, windowEnd] = windowLabel(rows, since, now);
  const shownRows = rows.map(shown);
  const recent = shownRows.slice(0, limit);
  const totals = totalsOf(shownRows);
  const base = { version, shortId, generated, windowStart, windowEnd, nodeVersion, totals, recent };
  const report = assemble({ ...base, notes: [] });
  const to = reportEmailAddress();
  const subject = `EMET error report ${version} ${shortId}`;
  if (to === '') {
    return { report, email: null, instruction: SEND_INSTRUCTION };
  }
  const fitted = fitReportEmail({ to, subject, base });
  const email = {
    to,
    subject,
    body_text: fitted.report,
    short_id: shortId,
    version,
    body: fitted.body,
    mailto: fitted.mailto,
    truncated: fitted.truncated,
    entries_in_link: fitted.entries_in_link,
    entries_total: shownRows.length
  };
  if (fitted.mailto == null) email.reason = fitted.reason;
  return { report: fitted.report, email, instruction: SEND_INSTRUCTION };
}

export async function runErrorReport(args = {}, dbManager = null) {
  const db = dbManager && dbManager.db ? dbManager.db : (dbManager && dbManager.collection ? dbManager : null);
  await assertReportOwner(db);
  const now = args.now instanceof Date ? args.now : new Date();
  const query = validateReportArgs(args, now);
  const rows = await queryErrorLog(query);
  const shortId = crypto.randomBytes(3).toString('hex');
  return composeErrorReport(rows, { since: query.since, now, shortId, limit: query.limit });
}
