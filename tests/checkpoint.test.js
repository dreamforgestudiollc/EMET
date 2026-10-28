/**
 * Continuous-chat checkpoint reminder (board 128).
 *
 * The night gate, the row gates, the live-save anchor, and the session match
 * each have a recurrence test. A mutant that reverts that line is loaded beside
 * the real module and must show the bad outcome the real module does not.
 */
import { test, testGroup, summary } from './harness.js';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

process.env.MONGODB_URI = 'mongodb://in-memory.test/emet';
delete process.env.EMET_SOURCE_TAGS;

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const NOW = new Date('2026-10-17T16:00:00.000Z');
const SECRET = 'checkpoint-secret-turn-should-not-echo';

const {
  CHECKPOINT_INTERVAL_MS, checkpointDecision, checkpointStatus, checkpointMillis,
  liveSaveMillis, applyCheckpoint, checkpointOnError, checkpointDay
} = await import('../src/checkpoint.js');
const { makeStore, withStore } = await import('./memstore.js');
const { dispatchTool } = await import('../src/dispatch.js');
const { TOOLS } = await import('../src/tools.js');

console.log('\n=== checkpoint reminder ===');

function at(msAgo) {
  return new Date(NOW.getTime() - msAgo);
}

function decision(row, now = NOW) {
  return checkpointDecision(row ? [row] : [], now);
}

function open(extra = {}) {
  return { session_id: '2026-10-16_chat', opened: true, opened_at: at(2 * DAY), ...extra };
}

function payload(res) {
  assert.ok(!res.isError, JSON.stringify(res).slice(0, 400));
  const body = JSON.parse(res.content[0].text);
  assert.strictEqual(body.success, true);
  return body.data;
}

function replaceMarked(src, marker, line) {
  const lines = src.split('\n');
  const atLine = [];
  lines.forEach((row, i) => { if (row.includes(marker)) atLine.push(i); });
  assert.strictEqual(atLine.length, 1, marker);
  if (line == null) lines.splice(atLine[0], 1);
  else lines[atLine[0]] = line;
  return lines.join('\n');
}

async function loadMutant(name, marker, line) {
  const dir = path.join(ROOT, 'tests/.mutants');
  await fs.promises.mkdir(dir, { recursive: true });
  const src = fs.readFileSync(path.join(ROOT, 'src/checkpoint.js'), 'utf8');
  const out = replaceMarked(src, marker, line).replaceAll("from './", "from '../../src/");
  const file = path.join(dir, name);
  await fs.promises.writeFile(file, out);
  return import(pathToFileURL(file).href);
}

async function serveFieldnote(sessionId, seed = null) {
  const { seatGems } = await import('../src/socket.js');
  const { setServeLogPath } = await import('../src/rune-dispatch.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'emet-checkpoint-serve-'));
  setServeLogPath(path.join(dir, 'gem-serves.json'));
  await seatGems({ asked: ['fieldnote'], log: { warn() {}, info() {}, error() {} } });
  const db = makeStore();
  if (seed) seedOpen(db, sessionId, seed);
  return withStore(db, async () => payload(await dispatchTool('gem_fieldnote__fieldnote', {
    session_id: sessionId
  }, { dbManager: db, logger: null, now: NOW })));
}

function seedOpen(db, id, { openedAgo = 2 * DAY, closed = false, opened = true, end = null, exchange = null, superseded = null, sessionId = null } = {}) {
  const sessions = db.collection('emet_sessions').docs;
  if (!sessions.some((row) => row._id === id)) {
    sessions.push({ _id: id, opened, closed, opened_at: at(openedAgo) });
  }
  if (end !== null || exchange !== null || superseded || sessionId) {
    const sid = sessionId || id;
    db.collection('transcripts').docs.push({
      _id: `t-${sid}-${db.collection('transcripts').docs.length}`,
      session_id: sid,
      ...(end !== null ? { session_end: end } : {}),
      ...(superseded ? { superseded_by: superseded } : {}),
      exchanges: exchange ? [{ exchange_index: 1, user_message: SECRET, assistant_message: 'saved', timestamp: exchange }] : []
    });
  }
}

testGroup('nightly boundary', () => {
  test('the interval is 24 hours', () => {
    assert.strictEqual(CHECKPOINT_INTERVAL_MS, DAY);
  });

  test('a save exactly 24 hours old is due', () => {
    const cp = decision(open({ last_saved_at: at(DAY), opened_at: at(DAY) }));
    assert.strictEqual(cp.due, true);
    assert.strictEqual(cp.sessions[0].session_id, '2026-10-16_chat');
  });

  test('a save one millisecond newer than 24 hours is not due', () => {
    const cp = decision(open({ last_saved_at: at(DAY - 1) }));
    assert.deepStrictEqual(cp, { due: false, save_with: ['emet_transcript_append', 'save_transcript'] });
  });

  test('an open with no transcript is due at 24 hours and not one millisecond sooner', () => {
    assert.strictEqual(decision(open({ opened_at: at(DAY), last_saved_at: null })).due, true);
    assert.strictEqual(decision(open({ opened_at: at(DAY - 1) })).due, false);
    const due = decision(open({ opened_at: at(DAY) }));
    assert.strictEqual(due.sessions[0].last_saved_at, null);
    assert.strictEqual(due.sessions[0].opened_at, at(DAY).toISOString());
  });

  test('no anchor is not due, and an invalid clock does not mark every session due', () => {
    assert.strictEqual(decision({ session_id: 'bare', opened: true }).due, false);
    assert.strictEqual(decision(open({ opened_at: at(10 * DAY) }), new Date('nope')).due, false);
    assert.strictEqual(decision(null).due, false);
  });
});

testGroup('which sessions are reminded', () => {
  test('a closed session is not due', () => {
    assert.strictEqual(decision(open({ closed: true, last_saved_at: at(3 * DAY) })).due, false);
  });

  test('a session that was never opened is not due, including a truthy non-boolean', () => {
    assert.strictEqual(decision({ session_id: 'no', opened: false, opened_at: at(3 * DAY) }).due, false);
    assert.strictEqual(decision({ session_id: 'num', opened: 1, opened_at: at(3 * DAY) }).due, false);
    assert.strictEqual(decision({ session_id: 'missing', opened_at: at(3 * DAY) }).due, false);
  });

  test('a recent save beats an old open, and an old save beats a recent open', () => {
    assert.strictEqual(decision(open({ opened_at: at(10 * DAY), last_saved_at: at(DAY - 1) })).due, false);
    const cp = decision(open({ opened_at: at(HOUR), last_saved_at: at(DAY) }));
    assert.strictEqual(cp.due, true);
    assert.strictEqual(cp.sessions[0].last_saved_at, at(DAY).toISOString());
    assert.strictEqual(cp.sessions[0].opened_at, at(HOUR).toISOString());
  });

  test('only the stale session is listed', () => {
    const cp = checkpointDecision([
      null,
      open({ session_id: 'fresh', opened_at: at(HOUR), last_saved_at: at(HOUR) }),
      open({ session_id: 'stale', last_saved_at: at(DAY) })
    ], NOW);
    assert.deepStrictEqual(cp.sessions.map((s) => s.session_id), ['stale']);
  });

  test('a Unix-second save of now is not due', () => {
    const seconds = Math.floor(NOW.getTime() / 1000);
    assert.strictEqual(checkpointMillis(seconds), seconds * 1000);
    assert.strictEqual(decision(open({ last_saved_at: seconds })).due, false);
    assert.strictEqual(decision(open({ last_saved_at: NOW.getTime() - DAY })).due, true);
  });
});

testGroup('the reminder names the existing tools', () => {
  test('the due text names the save tools, the close, and the New York daily session', () => {
    const cp = decision(open({ last_saved_at: at(DAY) }));
    assert.strictEqual(cp.close_with, 'emet_session_close');
    assert.deepStrictEqual(cp.save_with, ['emet_transcript_append', 'save_transcript']);
    assert.strictEqual(cp.daily_session, '2026-10-17_chat-daily');
    assert.strictEqual(cp.text, 'Checkpoint due. Save the verbatim exchanges with emet_transcript_append (one exchange) or save_transcript (the batch), under the open session or 2026-10-17_chat-daily. Do not reconstruct turns. Mark gaps as gaps. emet_session_close cites those saved parts.');
    const late = new Date('2026-10-17T03:30:00.000Z');
    assert.strictEqual(checkpointDay(late), '2026-10-16');
    assert.strictEqual(decision(open({ opened_at: at(2 * DAY) }), late).daily_session, '2026-10-16_chat-daily');
    assert.strictEqual(checkpointDay(new Date('2026-10-17T04:30:00.000Z')), '2026-10-17');
  });

  test('save_with on a fresh result is a copy', () => {
    const first = decision(null);
    first.save_with.push('emet_checkpoint');
    assert.deepStrictEqual(decision(null).save_with, ['emet_transcript_append', 'save_transcript']);
  });

  test('no new tool is registered', () => {
    assert.strictEqual(TOOLS.some((tool) => /checkpoint/i.test(tool.name)), false);
    for (const name of ['emet_transcript_append', 'save_transcript', 'emet_session_close', 'emet_status']) {
      assert.ok(TOOLS.some((tool) => tool.name === name), name);
    }
    const desc = TOOLS.find((tool) => tool.name === 'emet_status').description;
    assert.ok(desc.includes('reports checkpoint on every call'));
    assert.ok(desc.includes('checkpoint.unread'));
    assert.ok(desc.includes('emet_transcript_append') && desc.includes('save_transcript') && desc.includes('emet_session_close'));
  });

  test('the changelog records the reminder', () => {
    const change = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
    const notes = change.slice(change.indexOf('## 0.3.2'), change.indexOf('## 0.3.0'));
    assert.ok(notes.includes('checkpoint.unread'));
    assert.ok(notes.includes('emet_transcript_append'));
  });
});

testGroup('live transcripts', () => {
  test('a superseded part is not a save, and session_end beats an older exchange', () => {
    assert.strictEqual(liveSaveMillis({ superseded_by: 'next', session_end: at(DAY) }), null);
    assert.strictEqual(liveSaveMillis({ superseded_by: null, session_end: at(HOUR) }), at(HOUR).getTime());
    assert.strictEqual(liveSaveMillis({ session_end: at(HOUR), exchanges: [{ timestamp: at(3 * DAY) }] }), at(HOUR).getTime());
    assert.strictEqual(liveSaveMillis({ exchanges: [{ timestamp: at(2 * DAY) }, { timestamp: at(DAY) }] }), at(DAY).getTime());
  });

  test('the loader ignores a superseded save, a closed row, and a near-miss id', async () => {
    const db = makeStore();
    seedOpen(db, 'recent-open', { openedAgo: HOUR });
    seedOpen(db, 'recent-open', { sessionId: 'recent-open', end: at(2 * DAY), superseded: 'gone' });
    seedOpen(db, 'closed-one', { closed: true, end: at(3 * DAY) });
    seedOpen(db, 'a.b', { openedAgo: 2 * DAY, sessionId: 'axb', end: NOW });
    seedOpen(db, 'a.b', { sessionId: 'a.bX', end: NOW });
    const before = db.writes.slice();
    const cp = await checkpointStatus(db, NOW);
    assert.deepStrictEqual(db.writes, before);
    assert.strictEqual(cp.due, true);
    assert.deepStrictEqual(cp.sessions.map((s) => s.session_id), ['a.b']);
    assert.strictEqual(cp.sessions[0].last_saved_at, null);
  });

  test('the newest live part is the anchor, including a part id and a seconds stamp', async () => {
    const db = makeStore();
    seedOpen(db, 'base', { openedAgo: 3 * DAY, sessionId: 'base_verbatim_part1', end: at(2 * DAY), exchange: at(2 * DAY) });
    seedOpen(db, 'base', { sessionId: 'base_verbatim_part2', end: at(HOUR) });
    assert.strictEqual((await checkpointStatus(db, NOW)).due, false);
    const old = makeStore();
    seedOpen(old, 'base', { openedAgo: HOUR, sessionId: 'base_verbatim_part1' });
    old.collection('transcripts').docs[0].session_end = undefined;
    old.collection('transcripts').docs[0].exchanges = [{ timestamp: Math.floor(at(2 * DAY).getTime() / 1000) }];
    const aged = await checkpointStatus(old, NOW);
    assert.strictEqual(aged.due, true);
    assert.strictEqual(aged.sessions[0].last_saved_at, at(2 * DAY).toISOString());
    const iso = makeStore();
    seedOpen(iso, 'base', { openedAgo: 3 * DAY, end: NOW.toISOString() });
    assert.strictEqual((await checkpointStatus(iso, NOW)).due, false);
  });

  test('the reminder is attached to the open session and its part ids only', () => {
    const cp = decision(open({ session_id: 'day_chat', last_saved_at: at(DAY) }));
    const part = {};
    assert.strictEqual(applyCheckpoint(part, cp, { sessionId: 'day_chat_verbatim_part2' }), true);
    assert.strictEqual(part.checkpoint.due, true);
    const exact = {};
    assert.strictEqual(applyCheckpoint(exact, cp, { sessionId: 'day_chat' }), true);
    const miss = {};
    assert.strictEqual(applyCheckpoint(miss, cp, { sessionId: 'day_chatX' }), false);
    assert.strictEqual('checkpoint' in miss, false);
    const other = {};
    assert.strictEqual(applyCheckpoint(other, cp, { sessionId: 'day_other' }), false);
    const unnamed = {};
    assert.strictEqual(applyCheckpoint(unnamed, cp, {}), false);
    const status = {};
    assert.strictEqual(applyCheckpoint(status, { due: false, save_with: ['emet_transcript_append', 'save_transcript'] }, { always: true }), true);
    assert.strictEqual(status.checkpoint.due, false);
    const list = [];
    assert.strictEqual(applyCheckpoint(list, cp, { always: true, sessionId: 'day_chat' }), false);
    assert.strictEqual(checkpointOnError('emet_status').due, null);
    assert.strictEqual(checkpointOnError('emet_status').unread, true);
    assert.strictEqual(checkpointOnError('list_docs'), null);
  });
});

testGroup('dispatch', () => {
  test('emet_status reports a stale open session and does not write or echo the turn', async () => {
    const db = makeStore();
    seedOpen(db, '2026-10-16_stale', {
      openedAgo: 30 * HOUR,
      sessionId: '2026-10-16_stale_verbatim_part1',
      end: at(25 * HOUR),
      exchange: at(25 * HOUR)
    });
    const before = db.writes.slice();
    const data = await withStore(db, async () => payload(await dispatchTool('emet_status', {}, { dbManager: db, logger: null, now: NOW })));
    assert.deepStrictEqual(db.writes, before);
    assert.strictEqual(data.checkpoint.due, true);
    assert.strictEqual(data.checkpoint.daily_session, '2026-10-17_chat-daily');
    assert.deepStrictEqual(data.checkpoint.save_with, ['emet_transcript_append', 'save_transcript']);
    assert.strictEqual(data.checkpoint.close_with, 'emet_session_close');
    assert.strictEqual(data.checkpoint.sessions[0].session_id, '2026-10-16_stale');
    assert.ok(data.database, 'status survived');
    assert.strictEqual(JSON.stringify(data).includes(SECRET), false);
  });

  test('a fresh store reports due false, and a tool that does not name the session stays quiet', async () => {
    const db = makeStore();
    const fresh = await withStore(db, async () => payload(await dispatchTool('emet_status', {}, { dbManager: db, logger: null, now: NOW })));
    assert.deepStrictEqual(fresh.checkpoint, { due: false, save_with: ['emet_transcript_append', 'save_transcript'] });
    seedOpen(db, '2026-10-16_stale', { openedAgo: 30 * HOUR, end: at(25 * HOUR) });
    await withStore(db, async () => {
      const named = payload(await dispatchTool('list_docs', { session_id: '2026-10-16_stale_verbatim_part1' }, { dbManager: db, logger: null, now: NOW }));
      assert.strictEqual(named.checkpoint.due, true);
      const exact = payload(await dispatchTool('list_docs', { session_id: '2026-10-16_stale' }, { dbManager: db, logger: null, now: NOW }));
      assert.strictEqual(exact.checkpoint.sessions[0].session_id, '2026-10-16_stale');
      const miss = payload(await dispatchTool('list_docs', { session_id: '2026-10-16_staleX' }, { dbManager: db, logger: null, now: NOW }));
      assert.strictEqual('checkpoint' in miss, false);
      const quiet = payload(await dispatchTool('list_docs', {}, { dbManager: db, logger: null, now: NOW }));
      assert.strictEqual('checkpoint' in quiet, false);
    });
  });

  test('a new append is read after the save, so the result is not due; a repeat of the saved exchange stays due', async () => {
    const db = makeStore();
    const base = '2026-10-16_stale';
    const sid = `${base}_verbatim_part1`;
    seedOpen(db, base, { openedAgo: 30 * HOUR, sessionId: sid, end: at(25 * HOUR), exchange: at(25 * HOUR) });
    db.collection('emet_sessions').docs[0].board = true;
    db.collection('emet_sessions').docs[0].episodic = true;
    db.collection('emet_sessions').docs[0].drops_seen = [];
    const now = new Date();
    db.collection('emet_sessions').docs[0].opened_at = new Date(now.getTime() - 30 * HOUR);
    const savedPart = db.collection('transcripts').docs[0];
    savedPart.session_end = new Date(now.getTime() - 25 * HOUR);
    savedPart.exchanges[0].timestamp = savedPart.session_end;
    await withStore(db, async () => {
      const before = payload(await dispatchTool('emet_status', {}, { dbManager: db, logger: null, now }));
      assert.strictEqual(before.checkpoint.due, true);
      const again = payload(await dispatchTool('emet_transcript_append', {
        session_id: sid, exchange_index: 1, user_message: 'u', assistant_message: 'a', source: 'checkpoint-test'
      }, { dbManager: db, logger: null, now }));
      assert.strictEqual(again.already_present, true);
      assert.strictEqual(again.checkpoint.due, true);
      assert.ok(again.checkpoint.text.includes('emet_transcript_append'));
      assert.ok(again.checkpoint.text.includes('save_transcript'));
      assert.ok(again.checkpoint.text.includes('emet_session_close'));
      const saved = payload(await dispatchTool('emet_transcript_append', {
        session_id: sid, exchange_index: 2, user_message: 'next', assistant_message: 'saved now', source: 'checkpoint-test'
      }, { dbManager: db, logger: null, now }));
      assert.strictEqual(saved.exchange_index, 2);
      assert.strictEqual('checkpoint' in saved, false);
      const after = payload(await dispatchTool('emet_status', {}, { dbManager: db, logger: null, now: new Date() }));
      assert.strictEqual(after.checkpoint.due, false);
    });
  });

  test('a store that cannot be read does not fail the call and does not claim the save is current', async () => {
    const db = makeStore();
    seedOpen(db, '2026-10-16_stale', { openedAgo: 30 * HOUR, end: at(25 * HOUR) });
    const sessions = db.collection('emet_sessions');
    sessions.find = () => { throw new Error('sessions unreadable'); };
    const status = await withStore(db, async () => payload(await dispatchTool('emet_status', {}, { dbManager: db, logger: null, now: NOW })));
    assert.strictEqual(status.checkpoint.due, null);
    assert.strictEqual(status.checkpoint.unread, true);
    assert.notStrictEqual(status.checkpoint.due, false);
    assert.deepStrictEqual(status.checkpoint.save_with, ['emet_transcript_append', 'save_transcript']);
    assert.ok(status.database);
    assert.strictEqual(JSON.stringify(status).includes('sessions unreadable'), false);
    const listed = await withStore(db, async () => payload(await dispatchTool('list_docs', { session_id: '2026-10-16_stale' }, { dbManager: db, logger: null, now: NOW })));
    assert.strictEqual('checkpoint' in listed, false);
    assert.strictEqual(typeof listed.count, 'number');
  });

  test('an unreadable transcript is not reported as a current save', async () => {
    const db = makeStore();
    seedOpen(db, '2026-10-16_stale', { openedAgo: HOUR, end: at(25 * HOUR) });
    const transcripts = db.collection('transcripts');
    transcripts.find = () => { throw new Error('transcripts unreadable'); };
    const status = await withStore(db, async () => payload(await dispatchTool('emet_status', {}, { dbManager: db, logger: null, now: NOW })));
    assert.strictEqual(status.checkpoint.unread, true);
    assert.strictEqual(status.checkpoint.due, null);
  });

  test('a closing-exchange retry that names a due open session carries checkpoint', async () => {
    const db = makeStore();
    const due = '2026-10-16_due';
    const closed = `${due}_closedpart`;
    db.collection('emet_sessions').docs.push(
      { _id: due, opened: true, closed: false, opened_at: at(2 * DAY) },
      { _id: closed, opened: true, closed: true, closed_at: NOW, grace_used: true, grace_index: 4, opened_at: at(HOUR) }
    );
    const data = await withStore(db, async () => payload(await dispatchTool('emet_transcript_append', {
      session_id: closed, exchange_index: 4, user_message: 'u', assistant_message: 'a', source: 'checkpoint-test'
    }, { dbManager: db, logger: null, now: NOW })));
    assert.strictEqual(data.written, false);
    assert.strictEqual(data.already_present, true);
    assert.strictEqual(data.closing_exchange.already_saved, true);
    assert.strictEqual(data.checkpoint.due, true);
    assert.ok(data.checkpoint.sessions.some((s) => s.session_id === due));
    assert.ok(data.checkpoint.text.includes('emet_transcript_append'));
    assert.ok(data.checkpoint.text.includes('save_transcript'));
    assert.ok(data.checkpoint.text.includes('emet_session_close'));
  });

  test('a rune serve that names a due session carries checkpoint', async () => {
    const data = await serveFieldnote('2026-10-16_stale', { openedAgo: 30 * HOUR });
    assert.ok(data.code.includes('function fieldnote'));
    assert.strictEqual(data.checkpoint.due, true);
    assert.strictEqual(data.checkpoint.sessions[0].session_id, '2026-10-16_stale');
    assert.ok(data.checkpoint.text.includes('Do not reconstruct turns'));
  });

  test('a checkpoint read failure does not fail a rune serve or change its result', async () => {
    const control = await serveFieldnote('2026-10-16_stale');
    assert.strictEqual('checkpoint' in control, false);
    assert.ok(control.code.includes('function fieldnote'));
    const db = makeStore();
    seedOpen(db, '2026-10-16_stale', { openedAgo: 30 * HOUR });
    db.collection('emet_sessions').find = () => { throw new Error('sessions unreadable'); };
    const served = await withStore(db, () => dispatchTool('gem_fieldnote__fieldnote', {
      session_id: '2026-10-16_stale'
    }, { dbManager: db, logger: null, now: NOW }));
    assert.ok(!served.isError, JSON.stringify(served).slice(0, 400));
    const data = payload(served);
    assert.deepStrictEqual(data, control);
    assert.strictEqual(JSON.stringify(served).includes('sessions unreadable'), false);
  });
});

testGroup('revert mutants', () => {
  test('deleting the night gate makes a fresh save due', async () => {
    const row = open({ last_saved_at: at(DAY - 1) });
    assert.strictEqual(decision(row).due, false);
    const mod = await loadMutant('night-deleted.mjs', '// checkpoint-night', null);
    assert.strictEqual(mod.checkpointDecision([row], NOW).due, true);
  });

  test('a night gate that always continues makes a 24-hour save look current', async () => {
    const row = open({ last_saved_at: at(DAY) });
    assert.strictEqual(decision(row).due, true);
    const mod = await loadMutant('night-always.mjs', '// checkpoint-night', '    if (true) continue; // checkpoint-night');
    assert.strictEqual(mod.checkpointDecision([row], NOW).due, false);
  });

  test('dropping the closed check reminds a closed session', async () => {
    const row = open({ closed: true, last_saved_at: at(2 * DAY) });
    assert.strictEqual(decision(row).due, false);
    const mod = await loadMutant('row-closed.mjs', '// checkpoint-row', '    if (!row || row.opened !== true) continue; // checkpoint-row');
    assert.strictEqual(mod.checkpointDecision([row], NOW).due, true);
  });

  test('a truthy opened check reminds a session that was never opened', async () => {
    const row = { session_id: 'num', opened: 1, opened_at: at(2 * DAY) };
    assert.strictEqual(decision(row).due, false);
    const mod = await loadMutant('row-opened.mjs', '// checkpoint-row', '    if (!row || !row.opened || row.closed === true) continue; // checkpoint-row');
    assert.strictEqual(mod.checkpointDecision([row], NOW).due, true);
  });

  test('treating Unix seconds as milliseconds makes a save of now look ancient', async () => {
    const seconds = Math.floor(NOW.getTime() / 1000);
    assert.strictEqual(decision(open({ last_saved_at: seconds })).due, false);
    const mod = await loadMutant('unix.mjs', '// checkpoint-unix', '    return value; // checkpoint-unix');
    assert.strictEqual(mod.checkpointDecision([open({ last_saved_at: seconds })], NOW).due, true);
  });

  test('a superseded part counts as saved once the live skip is gone', async () => {
    const doc = { superseded_by: 'next', session_end: at(2 * DAY) };
    assert.strictEqual(liveSaveMillis(doc), null);
    const mod = await loadMutant('live.mjs', '// checkpoint-live', '  if (!doc) return null; // checkpoint-live');
    assert.strictEqual(mod.liveSaveMillis(doc), at(2 * DAY).getTime());
    const db = makeStore();
    seedOpen(db, 's', { openedAgo: HOUR, end: at(2 * DAY), superseded: 'next' });
    assert.strictEqual((await mod.checkpointStatus(db, NOW)).due, true);
    assert.strictEqual((await checkpointStatus(db, NOW)).due, false);
  });

  test('ignoring session_end lets an old exchange override a fresh save', async () => {
    const doc = { session_end: NOW, exchanges: [{ timestamp: at(2 * DAY) }] };
    assert.strictEqual(liveSaveMillis(doc), NOW.getTime());
    const mod = await loadMutant('end.mjs', '// checkpoint-end', null);
    assert.strictEqual(mod.liveSaveMillis(doc), at(2 * DAY).getTime());
  });

  test('ignoring exchange stamps hides a save that has no session_end', async () => {
    const doc = { exchanges: [{ timestamp: at(2 * DAY) }] };
    assert.strictEqual(liveSaveMillis(doc), at(2 * DAY).getTime());
    const mod = await loadMutant('exchange.mjs', '// checkpoint-exchange', '  for (const ex of []) { // checkpoint-exchange');
    assert.strictEqual(mod.liveSaveMillis(doc), null);
  });

  test('a prefix match reminds a near-miss session id', async () => {
    const cp = decision(open({ session_id: 'day_chat', last_saved_at: at(DAY) }));
    const miss = {};
    applyCheckpoint(miss, cp, { sessionId: 'day_chatX' });
    assert.strictEqual('checkpoint' in miss, false);
    const mod = await loadMutant(
      'group.mjs',
      '// checkpoint-group',
      '  const hit = (checkpoint.sessions || []).some((s) => String(sessionId || \'\').startsWith(String(s.session_id || \'\'))); // checkpoint-group'
    );
    const bad = {};
    mod.applyCheckpoint(bad, cp, { sessionId: 'day_chatX' });
    assert.strictEqual(bad.checkpoint.due, true);
  });

  test('an unescaped session id treats a dot as any character', async () => {
    const db = makeStore();
    seedOpen(db, 'a.b', { openedAgo: 2 * DAY, sessionId: 'axb', end: NOW });
    assert.strictEqual((await checkpointStatus(db, NOW)).due, true);
    const mod = await loadMutant('escape.mjs', '// checkpoint-escape', '  return String(text); // checkpoint-escape');
    assert.strictEqual((await mod.checkpointStatus(db, NOW)).due, false);
  });

  test('a prefix span treats a longer id as the same session', async () => {
    const db = makeStore();
    seedOpen(db, 'a.b', { openedAgo: 2 * DAY, sessionId: 'a.bX', end: NOW });
    assert.strictEqual((await checkpointStatus(db, NOW)).due, true);
    const mod = await loadMutant('span.mjs', '// checkpoint-span', '    const pattern = `^${escapeRegex(id)}`; // checkpoint-span');
    assert.strictEqual((await mod.checkpointStatus(db, NOW)).due, false);
  });

  test('UTC day names the wrong daily session before midnight in New York', async () => {
    const late = new Date('2026-10-17T03:30:00.000Z');
    assert.strictEqual(decision(open(), late).daily_session, '2026-10-16_chat-daily');
    const mod = await loadMutant(
      'day.mjs',
      'America/New_York',
      "    timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit'"
    );
    assert.strictEqual(mod.checkpointDecision([open()], late).daily_session, '2026-10-17_chat-daily');
  });

  test('a read error that claims due false says the save is current', async () => {
    const real = checkpointOnError('emet_status');
    assert.strictEqual(real.due, null);
    assert.strictEqual(real.unread, true);
    const mod = await loadMutant('unread.mjs', '// checkpoint-unread-shape', '  return { due: false, save_with: saveWith() }; // checkpoint-unread-shape');
    assert.strictEqual(mod.checkpointOnError('emet_status').due, false);
    assert.strictEqual(mod.checkpointOnError('emet_status').unread, undefined);
    const every = await loadMutant('unread-all.mjs', '// checkpoint-unread-gate', '  if (false) return null; // checkpoint-unread-gate');
    assert.ok(every.checkpointOnError('list_docs'));
    assert.strictEqual(checkpointOnError('list_docs'), null);
  });
});

summary('checkpoint reminder');
