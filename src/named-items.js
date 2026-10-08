/**
 * Names the board and handoff already hold, so a session start can say them.
 *
 * The board template keeps half-finished work in §1, dates in §2, and open,
 * waiting, and parked rows in §3. The handoff keeps what was left undecided.
 * A section that is not a table is marked unread. An empty list is not a
 * claim that the document has nothing in it.
 */

function isPlaceholder(s) {
  const t = String(s || '').trim();
  if (!t || t === '__' || /^_+$/.test(t)) return true;
  if (/^none\b/i.test(t)) return true;
  return false;
}

function tableCells(line) {
  return String(line).trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}

function isSeparatorRow(cells) {
  return cells.length > 0 && cells.every((c) => /^:?-{3,}:?$/.test(c));
}

function sectionBodies(text) {
  const sections = new Map();
  let key = null;
  const buf = [];
  const flush = () => {
    if (key) sections.set(key, buf.join('\n'));
    buf.length = 0;
  };
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.match(/^##\s+§(\d+)\b/);
    if (m) { flush(); key = m[1]; }
    else if (key) buf.push(line);
  }
  flush();
  return sections;
}

function firstTable(sectionText) {
  const lines = String(sectionText || '').split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim().startsWith('|'));
  if (start < 0) return null;
  const raw = [];
  for (let i = start; i < lines.length; i++) {
    if (!lines[i].trim().startsWith('|')) break;
    raw.push(lines[i]);
  }
  if (!raw.length) return null;
  const header = tableCells(raw[0]).map((h) => h.toLowerCase());
  const data = [];
  for (const line of raw.slice(1)) {
    const cells = tableCells(line);
    if (isSeparatorRow(cells)) continue;
    data.push(cells);
  }
  return { header, data };
}

function colIndex(header, names) {
  return header.findIndex((h) => names.some((n) => h === n || h.startsWith(n)));
}

function cell(row, header, names) {
  const i = colIndex(header, names);
  return i >= 0 ? (row[i] || '').trim() : '';
}

function nameOf(header, row) {
  const named = cell(row, header, ['what', 'item']);
  if (named) return named;
  const i = header.findIndex((h, idx) => h !== 'id' && !isPlaceholder(row[idx]));
  return i >= 0 ? (row[i] || '').trim() : '';
}

function addDaysIso(iso, n) {
  const [y, m, d] = String(iso).split('-').map(Number);
  if (!y || !m || !d) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

function isoDateIn(text) {
  const m = String(text || '').match(/\d{4}-\d{2}-\d{2}/);
  return m ? m[0] : null;
}

function resumesWhen(statusRaw) {
  const m = String(statusRaw || '').match(/resumes when:\s*(.+)$/i);
  return m ? m[1].trim() : null;
}

function takeSection(board, sections, num, label, out) {
  if (typeof board !== 'string') {
    out.sections[label] = 'unread';
    return null;
  }
  if (!sections.has(num)) {
    out.sections[label] = 'unread';
    return null;
  }
  const table = firstTable(sections.get(num));
  // Prose is not a table the server could read. unread is not an empty list:
  // the session still has to read the document.
  out.sections[label] = table ? 'read' : 'unread';
  return table;
}

export function undecidedFrom(text) {
  if (typeof text !== 'string') return { section: 'unread', lines: [] };
  const m = text.match(/\*\*Left undecided this session:\*\*([^\n]*)((?:\n(?!-\s+\*\*|##\s).*)*)/i);
  if (!m) return { section: 'unread', lines: [] };
  const lines = [];
  const push = (s) => {
    const t = String(s || '').trim().replace(/^[-*]\s+/, '').replace(/^:\s*/, '').trim();
    if (!t || isPlaceholder(t)) return;
    if (/one line each/i.test(t) || /^drafts, proposals/i.test(t)) return;
    lines.push(t);
  };
  push(m[1]);
  for (const line of m[2].split('\n')) push(line);
  return { section: 'read', lines };
}

/**
 * @param {string|null|undefined} board
 * @param {string|null|undefined} handoff
 * @param {string} today  YYYY-MM-DD
 * @param {{ board_doc?: string, handoff_doc?: string }} [ids]
 */
export function namedItemsFrom(board, handoff, today, ids = {}) {
  const day = typeof today === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(today)
    ? today
    : new Date().toISOString().slice(0, 10);
  const end = addDaysIso(day, 7);
  const out = {
    board_doc: ids.board_doc || 'STATE.md',
    handoff_doc: ids.handoff_doc || 'HANDOFF.md',
    board_read: typeof board === 'string',
    handoff_read: typeof handoff === 'string',
    as_of: day,
    half_finished: [],
    dated: [],
    open: [],
    waiting: [],
    parked: [],
    undecided: [],
    sections: {},
    note: 'Say every name in this list. Parked names are their own list: say what brings each one back, and ask nothing of it. A section marked unread was not a table the server could read, so read that document and name what it holds. An empty list is not a reason to skip the document. Then name lessons_pending. A count never replaces the names.'
  };
  const sections = sectionBodies(board);
  const half = takeSection(board, sections, '1', 'half_finished', out);
  if (half) {
    for (const row of half.data) {
      const name = nameOf(half.header, row);
      if (isPlaceholder(name)) continue;
      out.half_finished.push({
        name,
        state: cell(row, half.header, ['state']) || null,
        next_action: cell(row, half.header, ['next action']) || null,
        id: cell(row, half.header, ['id']) || null
      });
    }
  }
  const dated = takeSection(board, sections, '2', 'dated', out);
  if (dated) {
    for (const row of dated.data) {
      const item = nameOf(dated.header, row);
      const dateRaw = cell(row, dated.header, ['date']);
      if (isPlaceholder(item) && isPlaceholder(dateRaw)) continue;
      const date = isoDateIn(dateRaw);
      out.dated.push({
        date: date || (isPlaceholder(dateRaw) ? null : dateRaw) || null,
        name: isPlaceholder(item) ? null : item,
        owner: cell(row, dated.header, ['owner']) || null,
        id: cell(row, dated.header, ['id']) || null,
        within_seven_days: date && end ? date >= day && date <= end : null
      });
    }
  }
  const open = takeSection(board, sections, '3', 'open', out);
  if (open) {
    for (const row of open.data) {
      const name = nameOf(open.header, row);
      if (isPlaceholder(name)) continue;
      const statusRaw = cell(row, open.header, ['status']);
      const status = (statusRaw || 'OPEN').toUpperCase();
      const entry = {
        name,
        status: status.split(/\s+/)[0],
        next_action: cell(row, open.header, ['next action']) || null,
        owner: cell(row, open.header, ['owner']) || null,
        id: cell(row, open.header, ['id']) || null,
        resumes_when: cell(row, open.header, ['resumes when']) || resumesWhen(statusRaw) || null
      };
      if (status.startsWith('PARKED')) out.parked.push(entry);
      else if (status.startsWith('WAITING')) out.waiting.push(entry);
      else out.open.push(entry);
    }
  }
  const und = undecidedFrom(handoff);
  out.sections.undecided = und.section;
  out.undecided = und.lines;
  return out;
}
