/**
 * Per-bot close records (C1, 2026-10-01; the owner's decisions).
 *
 * The rule: a session written under a bot's source
 * tag closes against that bot's own records (bots/<tag>/HANDOFF.md). Only that
 * tag's own revisions in the session window count. A bot tag never writes or
 * cites the main HANDOFF.md or STATE.md.
 *
 * Every close here goes through dispatchTool, the way both transports call it,
 * against an in-memory store (no database, no live server) and the store's own
 * transcriptPosition, as in session-close-record.test.js. The numbered groups
 * follow the design's test list:
 *
 *   M1  a bot close against bots/T/HANDOFF.md is complete, and the main
 *       STATE.md / HANDOFF.md versions are identical before and after
 *       (before the bot rule: incomplete, "STATE.md was not updated this session" and
 *       "HANDOFF.md was not updated this session")
 *   M2  another tag's revisions in the window are not counted for a bot
 *       session, and a host close carries attribution_warnings naming them
 *       (before the bot rule: counted - a false pass)
 *   2   a host close is unchanged in verdict and receipts (regression guard)
 *   3   a bot receipt naming the main records is blocked, with the message
 *   4   write_doc / patch_doc of the main records under a bot tag are refused
 *   5   a revision by another tag in the bot window is not counted
 *   6   episodic attribution: wrong source, or another base, is not accepted
 *   7   the graph's handoff_early gate for a bot handoff
 *   8   close-rule interplay: -N on reopen, lock, the closing exchange, receipts-only
 *   9   a tag with no bots/T/HANDOFF.md record follows the host path
 *   D4  decision 4: EMET_TEMPLATE_MAP marks a bot handoff's conformance and
 *       never rejects it
 *   F1  (review, the reviewer) retire_doc, rename_doc and
 *       accept_nonconformance refuse the main records under a bot tag
 *   F2  (review, the reviewer) mixed transcript tags with a bot tag are
 *       incomplete; a main record in thread_docs is dropped with a warning
 *   +   (review, the second reader) the bot handoff receipt: handoff_doc, version,
 *       written last
 * (10: the runner is run in New York time and with TZ=UTC.)
 */
import { test, testGroup, summary } from './harness.js';
import assert from 'assert';
import { GRAPH_WRITE_TOOLS, sessionOf } from '../src/session-graph.js';
import { makeStore, withStore } from './memstore.js';

process.env.MONGODB_URI = 'mongodb://in-memory.test/emet';
delete process.env.EMET_CLOSE_GRACE_MINUTES;
delete process.env.CASCADE_CLOSE_GRACE_MINUTES;
delete process.env.EMET_SOURCE_TAG;
delete process.env.EMET_SOURCE_TAGS;
delete process.env.EMET_TEMPLATE_MAP;
delete process.env.EMET_HANDOFF_DOC;
delete process.env.EMET_STATE_DOC;

const BOT = 'intake-bot';
const BOT_HANDOFF = `bots/${BOT}/HANDOFF.md`;
const HOST = 'cloud-host';
// The owner adds bots/<tag>/HANDOFF.md per bot to EMET_RECORD_DOCS: that is what
// makes the tag a bot tag (decision 1: named by source tag, no mapping).
process.env.EMET_RECORD_DOCS = BOT_HANDOFF;

console.log('\n=== bot-session-close (C1) ===');

// A write naming no session is refused (gate no_session) before any other
// door. The main-record tests below run their calls inside an opened session
// whose board, episodic record and transcript exist, so the door they pin is
// still the one reached.
const OPEN_SID = '2026-10-03_enforce-door-check';
function openSession(db) {
  if (db.col('emet_sessions').docs.some((d) => d._id === OPEN_SID)) return;
  db.col('emet_sessions').docs.push({ _id: OPEN_SID, opened: true, board: true, episodic: true, drops_seen: [] });
  db.col('transcripts').docs.push({ session_id: OPEN_SID, exchanges: [{ exchange_index: 1 }] });
}
const inSession = (args) => ({ ...args, session_id: OPEN_SID });
// The session graph runs in enforce only: a governed write that names no
// session goes through the seeded open session here, so the door under test
// is what answers. goBare sends the call exactly as given.
const goBare = (db, tool, args, now = new Date()) => withStore(db, async () => {
  const { dispatchTool } = await import('../src/dispatch.js');
  return dispatchTool(tool, args, { dbManager: db, logger: null, now });
});
const go = (db, tool, args, now = new Date()) => {
  if (GRAPH_WRITE_TOOLS.has(tool) && !sessionOf(args)) { openSession(db); args = inSession(args); }
  if ((tool === 'patch_doc' || tool === 'write_doc' || tool === 'rename_doc' || tool === 'retire_doc') && !args.reason) args = { ...args, reason: 'fixture reason for the edit' };
  return goBare(db, tool, args, now);
};
// graphAfter is not awaited. Poll the session row until the step is visible.
async function until(pred, label) {
  const deadline = Date.now() + 2000;
  for (;;) {
    if (pred()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((res) => setImmediate(res));
  }
}
const sessionWrites = (db) => db.writes.filter((w) => w.startsWith('update emet_sessions')).length;
// An open names its startup (2026-10-03): a startup every page of which was
// served, so the startup_pages gate passes.
let loadSeq = 0;
const fullStartup = async () => {
  const pg = await import('../src/startup-pages.js');
  const id = `bot-close-load-${String(++loadSeq).padStart(4, '0')}`;
  pg.notePageServed(id, 'all');
  return id;
};
const dataOf = (r) => JSON.parse(r.content[0].text).data;
const text = (r) => JSON.stringify(r);
const at = (t, minutes, seconds = 0) => new Date(t.getTime() + minutes * 60000 + seconds * 1000);
const msg = (u, a, source) => ({ user_message: u, assistant_message: a, source });
const versionOf = (db, id) => (db.doc(id) ? db.doc(id).version : null);
const HUB_MESSAGE = new RegExp(`a bot session closes against bots/${BOT}/ records; the main handoff and board are the hub's`);

/** the owner's main records, last revised by the hub two days ago (outside any window). */
function seedMainRecords(db, { by = HOST, ageMs = 2 * 86400000 } = {}) {
  const when = new Date(Date.now() - ageMs);
  db.col('documents').docs.push(
    { doc_id: 'STATE.md', version: 7, content: '# Board\n\n## §0 RECORD CONTROL AND COUNTS\n- Template: `templates/BOARD.md` rev none yet\n- Session id: none yet\n- Scope of the session that wrote this revision: provisioned by the server\n\n| Half-state | Dated ≤14 days | Open | Waiting | Parked | Closed this revision | Seed triggers met | Nonconformance markers open |\n|---|---|---|---|---|---|---|---|\n| 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |\n\n## §1 HALF-STATE — highest priority\nNone — checked against: none yet.\n\n## §2 DATED — next 14 days, and hard dates beyond\nNone — checked against: none yet.\n\n## §3 OPEN BOARD\nNone — checked against: none yet.\n\n## §4 CLOSED THIS REVISION\nNone closed this revision.\n\n## §5 SEEDS\n- Last full scan: none yet\n- Triggers met: None met, per the scan above.\n\n## §6 STANDING GUARDS\nNone retired.\n\n## §7 SYSTEM STATE\nactive: hub work\n', updated_at: when, updated_by: by, size: 26 },
    { doc_id: 'HANDOFF.md', version: 3, content: '# Handoff\nhub session\n', updated_at: when, updated_by: by, size: 20 }
  );
}
async function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  try { return await fn(); } finally {
    for (const k of Object.keys(vars)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}

/**
 * The M1 fixture: a bot session (tag `tag`) opened and run through dispatch -
 * exchange 1 appended under the tag, its intake doc written, one episodic
 * entry citing exchange 1 (recorded in the graph as save_to_layer would), and
 * its handoff written last. Returns what a 7-receipt close needs.
 * `episodic` overrides fields of the session record; `extraEpisodic` seeds
 * more entries before the handoff; `skipHandoff` stops before it.
 */
async function botSessionReadyToClose(db, slug, T, { tag = BOT, episodic = {}, extraEpisodic = [], skipHandoff = false, seedMain = true } = {}) {
  if (seedMain) seedMainRecords(db);
  const opened = await go(db, 'emet_session_open', { slug, load_id: await fullStartup() }, T);
  assert.ok(!opened.isError, text(opened).slice(0, 300));
  const { session_id: sid, base } = dataOf(opened);
  await until(() => db.row(base)?.opened === true, 'bot session opened');
  const beforeAppend = sessionWrites(db);
  const a1 = await go(db, 'emet_transcript_append', { session_id: sid, ...msg('run the weekly intake', 'no local shell MCP. intake done', tag) }, T);
  assert.ok(!a1.isError, text(a1).slice(0, 300));
  // An append does not record a session step, so it cannot open a board-editing session.
  assert.strictEqual(sessionWrites(db), beforeAppend, 'an append does not record a session step');
  const wall = Date.now();
  const intakeId = `bots/${tag}/intake-weekly.md`;
  const intake = await go(db, 'write_doc', { doc_id: intakeId, content: '# Weekly intake\n3 items filed\n', source: tag, session_id: sid }, T);
  assert.ok(!intake.isError, text(intake).slice(0, 300));
  const record = { id: 77, timestamp: (wall - 2000) / 1000, importance: 0.5, metadata: { source: tag },
    source_session_id: base, source_exchange_start: 1, source_exchange_end: 1, ...episodic };
  db.col('emet_episodic').docs.push(record, ...extraEpisodic.map((e) => ({ timestamp: (wall - 3000) / 1000, importance: 0.5, ...e })));
  const sg = await import('../src/session-graph.js');
  await sg.graphAfter('save_to_layer', { layer: 'episodic', session_id: sid }, { id: record.id }, db, null, T);
  let handoffVersion = null;
  if (!skipHandoff) {
    const handoffId = `bots/${tag}/HANDOFF.md`;
    const beforeHandoff = sessionWrites(db);
    const h = await go(db, 'write_doc', { doc_id: handoffId, content: `# Handoff (${tag})\nnext: next week's intake\n`, source: tag, session_id: sid }, T);
    assert.ok(!h.isError, text(h).slice(0, 300));
    handoffVersion = dataOf(h).version;
    // A bot handoff records handoff:true. A write the graph does not treat as
    // one records nothing; either way the in-flight step has finished.
    let quiet = 0;
    await until(() => {
      if (db.row(base)?.handoff === true) return true;
      if (sessionWrites(db) === beforeHandoff) quiet += 1; else quiet = 0;
      return quiet >= 10;
    }, 'bot handoff step settled');
  }
  const receipts = { working_docs: [intakeId], episodic_id: record.id, transcript_session_id: base, transcript_parts: [sid],
    transcript_exchanges: 1, handoff_doc: `bots/${tag}/HANDOFF.md`, handoff_version: handoffVersion };
  return { sid, base, receipts, intakeId, session_start: Math.floor((wall - 3600000) / 1000) };
}

/** A host session (as session-close-record.test.js): two exchanges, then the main records and episodic 42 seeded. */
async function hostSessionReadyToClose(db, slug, T, { docsBy = 'test', episodicSource = 'test' } = {}) {
  const opened = await go(db, 'emet_session_open', { slug, load_id: await fullStartup() }, T);
  const { session_id: sid, base } = dataOf(opened);
  await until(() => db.row(base)?.opened === true, 'host session opened');
  const beforeAppend = sessionWrites(db);
  const h1 = await go(db, 'emet_transcript_append', { session_id: sid, ...msg('hi', 'no local shell MCP. hello', 'test') }, T);
  const h2 = await go(db, 'emet_transcript_append', { session_id: sid, ...msg('wrap up please', 'wrapping up', 'test') }, T);
  assert.ok(!h1.isError && !h2.isError, `${text(h1).slice(0, 200)} ${text(h2).slice(0, 200)}`);
  assert.strictEqual(sessionWrites(db), beforeAppend, 'an append does not record a session step');
  const wall = Date.now();
  db.col('documents').docs.push(
    { doc_id: 'STATE.md', version: 7, updated_at: new Date(wall - 5 * 60000), updated_by: docsBy, size: 10 },
    { doc_id: 'HANDOFF.md', version: 3, updated_at: new Date(wall - 60000), updated_by: docsBy, size: 10 }
  );
  db.col('emet_episodic').docs.push({ id: 42, timestamp: (wall - 10 * 60000) / 1000, importance: 0.5, metadata: { source: episodicSource },
    source_session_id: base, source_exchange_start: 1, source_exchange_end: 2 });
  const receipts = { working_docs: [], episodic_id: 42, board_doc: 'STATE.md', board_version: 7,
    transcript_session_id: base, transcript_parts: [sid], transcript_exchanges: 2, handoff_version: 3 };
  return { sid, base, receipts, wall, session_start: Math.floor((wall - 3600000) / 1000) };
}
const close = (db, s, receipts = s.receipts, extra = {}) => go(db, 'emet_session_close', { session_id: s.sid, receipts, session_start: s.session_start, ...extra });

// -----------------------------------------------------------------------------
testGroup('M1 (test 1): a bot session closes complete against bots/<tag>/HANDOFF.md, and the main records are untouched', () => {
  test('M1 dispatch fixture: intake doc, one episodic entry citing exchange 1, handoff last, 7 receipts -> complete, closed_recorded true, main STATE.md/HANDOFF.md versions identical before and after', async () => {
    const db = makeStore();
    const T = new Date();
    const s = await botSessionReadyToClose(db, 'corpus-intake-weekly', T);
    const before = { state: versionOf(db, 'STATE.md'), handoff: versionOf(db, 'HANDOFF.md') };
    assert.deepStrictEqual(before, { state: 7, handoff: 3 });
    const closed = await close(db, s);
    assert.ok(!closed.isError, text(closed).slice(0, 400));
    const c = dataOf(closed);
    assert.strictEqual(c.state, 'complete', JSON.stringify(c.missing));
    assert.strictEqual(c.closed_recorded, true);
    assert.strictEqual(db.row(s.base)?.closed, true, 'the bot close was not recorded');
    assert.ok(!c.missing.some((m) => /STATE\.md|^HANDOFF\.md/.test(m)), JSON.stringify(c.missing));
    assert.deepStrictEqual({ state: versionOf(db, 'STATE.md'), handoff: versionOf(db, 'HANDOFF.md') }, before, 'a main record changed');
    assert.strictEqual(c.checked.session_records.kind, 'bot');
    assert.strictEqual(c.checked.session_records.tag, BOT);
    assert.strictEqual(c.checked.session_records.handoff_doc, BOT_HANDOFF);
    assert.ok(c.speak.includes(`Handoff: ${BOT_HANDOFF} v1`), JSON.stringify(c.speak));
    // The measure: no checked document is counted unless the bot's tag wrote it.
    for (const d of c.checked.documents) {
      if (d.updated_this_session) assert.strictEqual(d.updated_by, BOT, `${d.doc_id} counted although ${d.updated_by} wrote it`);
    }
    assert.ok(!c.checked.documents.some((d) => d.doc_id === 'STATE.md' || d.doc_id === 'HANDOFF.md'), 'the main records are in the checked set');
  });
  test('the 7 receipts are the required set; board_doc and board_version are not required', async () => {
    const { BOT_RECEIPT_FIELDS } = await import('../src/session.js');
    assert.deepStrictEqual(Object.keys(BOT_RECEIPT_FIELDS).sort(),
      ['episodic_id', 'handoff_doc', 'handoff_version', 'transcript_exchanges', 'transcript_parts', 'transcript_session_id', 'working_docs']);
  });
  test('a bot that keeps its own board lists it under bots/<tag>/ (board_doc optional, checked when given)', async () => {
    const db = makeStore();
    const T = new Date();
    seedMainRecords(db);
    const s = await botSessionReadyToClose(db, 'intake-with-board', T, { seedMain: false, skipHandoff: true });
    const b = await go(db, 'write_doc', { doc_id: `bots/${BOT}/STATE.md`, content: '# bot board\n', source: BOT, session_id: s.sid }, T);
    assert.ok(!b.isError, text(b).slice(0, 300));
    const h = await go(db, 'write_doc', { doc_id: BOT_HANDOFF, content: '# Handoff\n', source: BOT, session_id: s.sid }, T);
    const receipts = { ...s.receipts, board_doc: `bots/${BOT}/STATE.md`, board_version: 1, handoff_version: dataOf(h).version };
    const c = dataOf(await close(db, s, receipts));
    assert.strictEqual(c.state, 'complete', JSON.stringify(c.missing));
    const wrong = makeStore();
    const s2 = await botSessionReadyToClose(wrong, 'intake-board-elsewhere', T);
    wrong.col('documents').docs.push({ doc_id: 'threads/board.md', version: 2, updated_at: new Date(), updated_by: BOT, size: 1 });
    const c2 = dataOf(await close(wrong, s2, { ...s2.receipts, board_doc: 'threads/board.md', board_version: 2 }));
    assert.notStrictEqual(c2.state, 'complete');
    assert.ok(c2.missing.some((m) => /threads\/board\.md is not under bots\/intake-bot\//.test(m)), JSON.stringify(c2.missing));
  });
});

testGroup('M2 (test 5): only the session tag\'s own revisions count', () => {
  test('M2 bot: another tag revised STATE.md, HANDOFF.md and the bot\'s handoff in the window - they are not counted, the bot close is incomplete', async () => {
    const db = makeStore();
    const T = new Date();
    const s = await botSessionReadyToClose(db, 'intake-m2', T, { seedMain: false, skipHandoff: true });
    // The hub (another tag) revised the main board and handoff, and the bot's
    // handoff, inside this window and after the bot's own writes.
    seedMainRecords(db, { ageMs: -1000 });
    db.col('documents').docs.push({ doc_id: BOT_HANDOFF, version: 1, updated_at: new Date(Date.now() + 1000), updated_by: HOST, size: 5 });
    // The receipts a host would send (the 8): before the bot rule this close is complete.
    const receipts = { working_docs: [s.intakeId], episodic_id: 77, board_doc: 'STATE.md', board_version: 7,
      transcript_session_id: s.base, transcript_parts: [s.sid], transcript_exchanges: 1, handoff_version: 3 };
    const c = dataOf(await close(db, s, receipts));
    assert.strictEqual(c.state, 'incomplete', JSON.stringify(c.missing));
    assert.ok(c.missing.some((m) => m.startsWith(`${BOT_HANDOFF} was not updated this session by ${BOT}`)), JSON.stringify(c.missing));
    for (const d of c.checked.documents) {
      if (d.updated_this_session) assert.strictEqual(d.updated_by, BOT, `${d.doc_id} counted although ${d.updated_by} wrote it`);
    }
  });
  test('M2 host: another tag revised STATE.md and HANDOFF.md in the window - the verdict is kept (complete), with attribution_warnings naming both', async () => {
    const db = makeStore();
    const T = new Date();
    const s = await hostSessionReadyToClose(db, 'host-m2', T, { docsBy: HOST });
    const c = dataOf(await close(db, s));
    assert.strictEqual(c.state, 'complete', JSON.stringify(c.missing));
    assert.ok(Array.isArray(c.attribution_warnings), 'no attribution_warnings');
    const w = c.attribution_warnings.join('\n');
    assert.ok(/STATE\.md was revised in the window by cloud-host/.test(w) && /HANDOFF\.md was revised in the window by cloud-host/.test(w), w);
    assert.ok(/this session's tag test/.test(w), w);
  });
  test('test 5: a working doc revised in the bot window by another tag is not counted (incomplete)', async () => {
    const db = makeStore();
    const T = new Date();
    const s = await botSessionReadyToClose(db, 'intake-shared-doc', T);
    db.col('documents').docs.push({ doc_id: 'threads/shared.md', version: 4, updated_at: new Date(Date.now() - 1000), updated_by: HOST, size: 3 });
    const c = dataOf(await close(db, s, { ...s.receipts, working_docs: [s.intakeId, 'threads/shared.md'] }));
    assert.strictEqual(c.state, 'incomplete', JSON.stringify(c.missing));
    assert.ok(c.missing.some((m) => m === `threads/shared.md was not updated this session by ${BOT} - its revision in the window is by ${HOST}`), JSON.stringify(c.missing));
  });
  test('a host revision during a bot window is not counted for the bot: an episodic entry by another tag does not satisfy "an episodic entry this session"', async () => {
    const db = makeStore();
    const T = new Date();
    const s = await botSessionReadyToClose(db, 'intake-no-own-episodic', T, { episodic: { metadata: { source: HOST } } });
    const c = dataOf(await close(db, s));
    assert.strictEqual(c.state, 'incomplete', JSON.stringify(c.missing));
    assert.ok(c.missing.includes(`no episodic entry was written this session under ${BOT}`), JSON.stringify(c.missing));
  });
});

testGroup('test 2: a host close is unchanged in verdict and receipts (regression guard)', () => {
  test('a complete host close: same state, missing, receipt problems, speak, receipt fields and checked documents as before the bot rule; no bot fields, no attribution warnings', async () => {
    const db = makeStore();
    const T = new Date();
    const s = await hostSessionReadyToClose(db, 'host-regression', T);
    const c = dataOf(await close(db, s));
    assert.strictEqual(c.state, 'complete');
    assert.deepStrictEqual(c.missing, []);
    assert.deepStrictEqual(c.checked.receipt_problems, []);
    assert.deepStrictEqual(Object.keys(c.receipt_fields),
      ['working_docs', 'episodic_id', 'board_doc', 'board_version', 'transcript_session_id', 'transcript_parts', 'transcript_exchanges', 'handoff_version']);
    assert.deepStrictEqual(c.speak, [
      'Working documents: none changed this session', 'Session record: episodic 42', 'Board: STATE.md v7',
      `Transcript: ${s.sid} - 2 exchanges, intact yes, read back from MongoDB collection transcripts`,
      'Handoff: HANDOFF.md v3', 'Close state: complete']);
    assert.deepStrictEqual(c.checked.documents, [
      { doc_id: 'HANDOFF.md', exists: true, version: 3, updated_at: new Date(s.wall - 60000).toISOString(), updated_by: 'test', updated_this_session: true },
      { doc_id: 'STATE.md', exists: true, version: 7, updated_at: new Date(s.wall - 5 * 60000).toISOString(), updated_by: 'test', updated_this_session: true }]);
    assert.strictEqual(c.attribution_warnings, undefined);
    assert.strictEqual(c.checked.session_records, undefined);
    assert.strictEqual(c.closed_recorded, true);
  });
  test('a host close missing its board receipt is blocked exactly as before; a host close without the main records is incomplete exactly as before', async () => {
    const db = makeStore();
    const T = new Date();
    const s = await hostSessionReadyToClose(db, 'host-regression-blocked', T);
    const { board_doc, ...noBoard } = s.receipts;
    const c = dataOf(await close(db, s, noBoard));
    assert.strictEqual(c.state, 'blocked');
    assert.deepStrictEqual(c.missing, ['receipt missing: board_doc - board document id, usually STATE.md']);
    const db2 = makeStore();
    const s2 = await hostSessionReadyToClose(db2, 'host-regression-incomplete', T);
    db2.col('documents').docs.splice(0); // no main records at all
    const c2 = dataOf(await close(db2, s2));
    assert.strictEqual(c2.state, 'incomplete');
    assert.deepStrictEqual(c2.missing.slice(0, 2), ['HANDOFF.md does not exist', 'STATE.md does not exist']);
  });
});

testGroup('test 3: a bot session that names or revises the main records does not close', () => {
  for (const [label, patch] of [
    ['handoff_doc: HANDOFF.md', { handoff_doc: 'HANDOFF.md' }],
    ['board_doc: STATE.md', { board_doc: 'STATE.md', board_version: 7 }],
    ['working_docs naming STATE.md', { working_docs: ['bots/intake-bot/intake-weekly.md', 'STATE.md'] }]
  ]) {
    test(`a receipt naming the main records (${label}) -> blocked, with the message`, async () => {
      const db = makeStore();
      const T = new Date();
      const s = await botSessionReadyToClose(db, `intake-names-main-${Object.keys(patch)[0]}`, T);
      const c = dataOf(await close(db, s, { ...s.receipts, ...patch }));
      assert.strictEqual(c.state, 'blocked', JSON.stringify(c.missing));
      assert.ok(c.missing.some((m) => HUB_MESSAGE.test(m)), JSON.stringify(c.missing));
    });
  }
  test('a main record revised by the bot\'s tag in the window -> incomplete, with the message', async () => {
    const db = makeStore();
    const T = new Date();
    const s = await botSessionReadyToClose(db, 'intake-revised-main', T);
    const st = db.doc('STATE.md'); st.version = 8; st.updated_at = new Date(Date.now() - 1500); st.updated_by = BOT; // e.g. written before C1 shipped
    const c = dataOf(await close(db, s));
    assert.strictEqual(c.state, 'incomplete', JSON.stringify(c.missing));
    assert.ok(c.missing.some((m) => /^STATE\.md was revised by intake-bot this session/.test(m) && HUB_MESSAGE.test(m)), JSON.stringify(c.missing));
  });
});

testGroup('no_session through the door: refused before any write, and the refusal says how to pass (2026-10-03)', () => {
  test('a sessionless write_doc is refused, nothing is written, and the refusal names emet_session_open with load_id and resubmitting with session_id', async () => {
    const db = makeStore();
    seedMainRecords(db);
    const r = await goBare(db, 'write_doc', { doc_id: 'STATE.md', content: '# Board\nno session\n', source: HOST });
    assert.ok(r.isError, text(r).slice(0, 300));
    assert.match(text(r), /names no session/);
    assert.match(text(r), /emet_session_open \(with the load_id from your startup pages\)/);
    assert.match(text(r), /resubmit this same write with that session_id/);
    assert.match(text(r), /Nothing was written/);
    assert.strictEqual(versionOf(db, 'STATE.md'), 7, 'nothing was saved');
  });
});

testGroup('test 4: the write door refuses the main records under a bot tag', () => {
  {
    test(`write_doc and patch_doc of HANDOFF.md / STATE.md under ${BOT} are refused, nothing written; under a host tag they are allowed`, async () => {
      const db = makeStore();
      seedMainRecords(db);
      openSession(db);
      const bare = await goBare(db, 'write_doc', { doc_id: 'STATE.md', content: '# no session\n', source: HOST });
      assert.ok(bare.isError && /names no session/.test(text(bare)) && /emet_session_open/.test(text(bare)) && /Nothing was written/.test(text(bare)), text(bare).slice(0, 300));
      const tries = [
        ['write_doc', { doc_id: 'HANDOFF.md', content: '# bot handoff\n', source: BOT, supersedes: 3 }],
        ['write_doc', { doc_id: 'STATE.md', content: '# bot board\n', source: BOT }],
        ['patch_doc', { doc_id: 'STATE.md', old_str: 'hub work', new_str: 'bot work', source: BOT }],
        ['patch_doc', { doc_id: 'HANDOFF.md', old_str: 'the owner', new_str: 'bot', source: BOT }],
        ['write_doc', { doc_id: 'STATE.md', content: '# bot board\n', updated_by: BOT }] // the older alias is the same claim
      ];
      for (const [tool, args] of tries) {
        const r = await go(db, tool, inSession(args));
        assert.ok(r.isError, `${tool} ${args.doc_id} was not refused: ${text(r).slice(0, 300)}`);
        assert.ok(HUB_MESSAGE.test(text(r)) && /Nothing was written/.test(text(r)), text(r).slice(0, 400));
      }
      assert.strictEqual(versionOf(db, 'HANDOFF.md'), 3);
      assert.strictEqual(versionOf(db, 'STATE.md'), 7);
      assert.strictEqual(db.col('documents_history').docs.length, 0, 'a refused write archived something');
      const ok1 = await go(db, 'patch_doc', inSession({ doc_id: 'STATE.md', old_str: 'hub work', new_str: 'hub', source: HOST }));
      assert.ok(!ok1.isError, text(ok1).slice(0, 300));
      const ok2 = await go(db, 'patch_doc', inSession({ doc_id: 'STATE.md', old_str: 'hub', new_str: 'hub v9', source: HOST }));
      assert.ok(!ok2.isError, text(ok2).slice(0, 300));
      const ok3 = await go(db, 'write_doc', inSession({ doc_id: 'HANDOFF.md', content: '# Handoff\nhub\n', source: HOST, supersedes: 3 }));
      assert.ok(!ok3.isError, text(ok3).slice(0, 300));
      assert.strictEqual(versionOf(db, 'STATE.md'), 9);
      assert.strictEqual(versionOf(db, 'HANDOFF.md'), 4);
    });
  }
  test('a write with no source takes the door\'s default (EMET_SOURCE_TAG): unset, it is the host path and allowed; set to a bot tag, it is refused', async () => {
    const db = makeStore();
    seedMainRecords(db);
    const r1 = await go(db, 'patch_doc', { doc_id: 'STATE.md', old_str: 'hub work', new_str: 'hub work, no source' });
    assert.ok(!r1.isError, text(r1).slice(0, 300));
    await withEnv({ EMET_SOURCE_TAG: BOT }, async () => {
      const r2 = await go(db, 'write_doc', { doc_id: 'STATE.md', content: '# Board again\n' });
      assert.ok(r2.isError && HUB_MESSAGE.test(text(r2)), text(r2).slice(0, 300));
    });
    assert.strictEqual(versionOf(db, 'STATE.md'), 8);
  });
  test('a bot tag still writes its own records and any other document', async () => {
    const db = makeStore();
    const r1 = await go(db, 'write_doc', { doc_id: BOT_HANDOFF, content: '# Handoff\n', source: BOT });
    const r2 = await go(db, 'write_doc', { doc_id: 'threads/intake-notes.md', content: 'notes\n', source: BOT });
    assert.ok(!r1.isError && !r2.isError, text(r1).slice(0, 200) + text(r2).slice(0, 200));
  });
});

testGroup('test 6: the episodic session record must be the bot\'s and cite this session', () => {
  test('episodic_id naming an entry written under another tag is not accepted (blocked)', async () => {
    const db = makeStore();
    const T = new Date();
    const s = await botSessionReadyToClose(db, 'intake-ep-source', T, { extraEpisodic: [{ id: 78, metadata: { source: HOST } }] });
    const c = dataOf(await close(db, s, { ...s.receipts, episodic_id: 78 }));
    assert.strictEqual(c.state, 'blocked', JSON.stringify(c.missing));
    assert.ok(c.missing.some((m) => /^episodic entry 78 was not accepted/.test(m) && /metadata\.source is cloud-host, not intake-bot/.test(m)), JSON.stringify(c.missing));
  });
  test('episodic_id naming an entry that cites another session\'s base is not accepted (blocked)', async () => {
    const db = makeStore();
    const T = new Date();
    const s = await botSessionReadyToClose(db, 'intake-ep-base', T, {
      extraEpisodic: [{ id: 79, metadata: { source: BOT }, source_session_id: '2026-09-28_corpus-intake-weekly', source_exchange_start: 1, source_exchange_end: 1 }] });
    const c = dataOf(await close(db, s, { ...s.receipts, episodic_id: 79 }));
    assert.strictEqual(c.state, 'blocked', JSON.stringify(c.missing));
    assert.ok(c.missing.some((m) => /^episodic entry 79 was not accepted/.test(m) && /cites 2026-09-28_corpus-intake-weekly/.test(m)), JSON.stringify(c.missing));
  });
  test('episodic_id naming an entry with no derived_from is not accepted (blocked)', async () => {
    const db = makeStore();
    const T = new Date();
    const s = await botSessionReadyToClose(db, 'intake-ep-none', T, { extraEpisodic: [{ id: 80, metadata: { source: BOT } }] });
    const c = dataOf(await close(db, s, { ...s.receipts, episodic_id: 80 }));
    assert.strictEqual(c.state, 'blocked', JSON.stringify(c.missing));
    assert.ok(c.missing.some((m) => /^episodic entry 80 was not accepted/.test(m) && /cites no session/.test(m)), JSON.stringify(c.missing));
  });
});

testGroup('test 7: the graph gates a bot handoff the way it gates the main one', () => {
  const early = async () => {
    const db = makeStore();
    const T = new Date();
    const opened = await go(db, 'emet_session_open', { slug: 'gate-early', load_id: await fullStartup() }, T);
    const sid = dataOf(opened).session_id;
    const base = dataOf(opened).base;
    await until(() => db.row(base)?.opened === true, 'early session opened');
    const beforeAppend = sessionWrites(db);
    const a1 = await go(db, 'emet_transcript_append', { session_id: sid, ...msg('go', 'no local shell MCP. ok', BOT) }, T);
    assert.ok(!a1.isError, text(a1).slice(0, 300));
    assert.strictEqual(sessionWrites(db), beforeAppend, 'an append does not record a session step');
    // No episodic record yet: the handoff is early.
    const h = await go(db, 'write_doc', { doc_id: BOT_HANDOFF, content: '# Handoff\n', source: BOT, session_id: sid }, T);
    return { db, sid, h };
  };
  test('a bot handoff written before its episodic record is refused (handoff_early), nothing is written, no board is asked for, and the refusal names the tool that passes', async () => {
    const { db, h } = await early();
    assert.ok(h.isError && /handoff is written last/.test(text(h)), text(h).slice(0, 300));
    assert.ok(/the episodic session record with save_to_layer/.test(text(h)) && !/board/.test(text(h)), text(h).slice(0, 400));
    assert.ok(/resubmit this same handoff write/.test(text(h)), text(h).slice(0, 400));
    assert.strictEqual(versionOf(db, BOT_HANDOFF), null);
  });
  test('with the episodic record and the transcript in place the bot handoff is allowed without any board, and the next step is the close', async () => {
    const db = makeStore();
    const T = new Date();
    const s = await botSessionReadyToClose(db, 'gate-ok', T, { skipHandoff: true });
    const h = await go(db, 'write_doc', { doc_id: BOT_HANDOFF, content: '# Handoff\n', source: BOT, session_id: s.sid }, T);
    assert.ok(!h.isError, text(h).slice(0, 300));
    assert.strictEqual(dataOf(h).session_graph.verdict, 'ok');
    assert.strictEqual(dataOf(h).session_graph.next, 'emet_session_close with receipts; the handoff is written');
    await until(() => db.row(s.base)?.handoff === true, 'allowed handoff recorded');
    assert.strictEqual(db.row(s.base).handoff, true);
    assert.strictEqual(db.row(s.base).handoff_version, 1);
  });
  test('evaluate (pure): the bot gate keys on the write\'s source; no source, another tag, or a tag with no record takes the host path', async () => {
    const sg = await import('../src/session-graph.js');
    const st = { opened: true };
    const bot = sg.evaluate('write_doc', { doc_id: BOT_HANDOFF, source: BOT, session_id: 's' }, st, 1);
    assert.strictEqual(bot.verdict, 'refuse'); assert.strictEqual(bot.gate, 'handoff_early');
    assert.strictEqual(sg.evaluate('write_doc', { doc_id: BOT_HANDOFF, updated_by: BOT, session_id: 's' }, st, 1).gate, 'handoff_early', 'the updated_by alias is the same claim');
    assert.strictEqual(sg.evaluate('write_doc', { doc_id: BOT_HANDOFF, source: BOT, session_id: 's' }, { ...st, episodic: true }, 1).verdict, 'ok');
    assert.strictEqual(sg.evaluate('write_doc', { doc_id: BOT_HANDOFF, source: BOT, session_id: 's' }, { ...st, episodic: true }, 0).gate, 'handoff_early', 'no transcript yet');
    assert.strictEqual(sg.evaluate('write_doc', { doc_id: BOT_HANDOFF, session_id: 's' }, st, 1).verdict, 'ok', 'no source: host path');
    assert.strictEqual(sg.evaluate('write_doc', { doc_id: BOT_HANDOFF, source: HOST, session_id: 's' }, st, 1).verdict, 'ok', 'another tag: host path');
    assert.strictEqual(sg.evaluate('write_doc', { doc_id: 'bots/other-bot/HANDOFF.md', source: 'other-bot', session_id: 's' }, st, 1).verdict, 'ok', 'no record: host path');
    assert.strictEqual(sg.evaluate('patch_doc', { doc_id: BOT_HANDOFF, source: BOT, session_id: 's' }, st, 1).verdict, 'ok', 'patch_doc is not the handoff gate (records are refused patch anyway)');
    const main = sg.evaluate('write_doc', { doc_id: 'HANDOFF.md', source: HOST, session_id: 's' }, st, 1);
    assert.ok(main.verdict === 'refuse' && /the board \(STATE\.md\)/.test(main.reason), 'the main handoff gate changed');
    assert.deepStrictEqual(sg.recordStep('write_doc', { doc_id: BOT_HANDOFF, source: BOT }, { version: 2 }), { handoff: true, handoff_version: 2 });
    assert.strictEqual(sg.recordStep('write_doc', { doc_id: BOT_HANDOFF, source: HOST }, { version: 2 }), null);
  });
});

testGroup('test 8: close-rule interplay holds for a bot session', () => {
  test('receipts-only bot close (no session_id) -> complete and recorded; the closing exchange at 4:59 is accepted; then locked; reopening gives -2', async () => {
    const db = makeStore();
    const T = new Date();
    const s = await botSessionReadyToClose(db, 'intake-cycle', T);
    const closed = await go(db, 'emet_session_close', { receipts: s.receipts, session_start: s.session_start }, T);
    const c = dataOf(closed);
    assert.strictEqual(c.state, 'complete', JSON.stringify(c.missing));
    assert.strictEqual(c.closed_recorded, true);
    assert.strictEqual(db.row(s.base)?.closed, true, 'the bot close did not lock the session');
    const closing = await go(db, 'emet_transcript_append', { session_id: s.sid, ...msg('thanks', 'closed', BOT) }, at(T, 4, 59));
    assert.ok(!closing.isError && dataOf(closing).exchange_index === 2 && dataOf(closing).closing_exchange.locked, text(closing).slice(0, 400));
    const late = await go(db, 'emet_transcript_append', { session_id: s.sid, ...msg('more', 'x', BOT) }, at(T, 4, 59.5));
    assert.ok(late.isError && /closed and locked/.test(text(late)), text(late).slice(0, 300));
    const reopened = await go(db, 'emet_session_open', { slug: 'intake-cycle', load_id: await fullStartup() }, T);
    assert.strictEqual(dataOf(reopened).base, `${s.base}-2`);
  });
  test('after a complete bot close, a write naming the closed session is refused (the lock), and an append after the window is refused', async () => {
    const db = makeStore();
    const T = new Date();
    const s = await botSessionReadyToClose(db, 'intake-lock', T);
    assert.strictEqual(dataOf(await close(db, s)).state, 'complete');
    const late = await go(db, 'emet_transcript_append', { session_id: s.sid, ...msg('more', 'x', BOT) }, at(T, 6));
    assert.ok(late.isError && /5-minute window/.test(text(late)), text(late).slice(0, 300));
    const w = await go(db, 'write_doc', { doc_id: BOT_HANDOFF, content: '# again\n', source: BOT, session_id: s.sid, supersedes: 1 }, at(T, 6));
    assert.ok(w.isError && /closed and locked/.test(text(w)) && /belongs in the next session/.test(text(w)), text(w).slice(0, 300));
    assert.strictEqual(versionOf(db, BOT_HANDOFF), 1);
  });
});

testGroup('test 9: a tag with no bots/<tag>/HANDOFF.md record follows the host path', () => {
  test('a bot-shaped close under an unlisted tag still requires the main records and the 8 receipts (unchanged from before the bot rule)', async () => {
    const db = makeStore();
    const T = new Date();
    const s = await botSessionReadyToClose(db, 'unlisted-bot', T, { tag: 'other-bot' });
    const c = dataOf(await close(db, s));
    assert.strictEqual(c.state, 'incomplete');
    assert.ok(c.missing.includes('STATE.md was not updated this session') && c.missing.includes('HANDOFF.md was not updated this session'), JSON.stringify(c.missing));
    assert.ok(c.missing.some((m) => /^receipt missing: board_doc/.test(m)), JSON.stringify(c.missing));
    assert.strictEqual(c.checked.session_records, undefined);
    const w = await go(db, 'write_doc', { doc_id: 'STATE.md', content: '# Board\n', source: 'other-bot' });
    assert.ok(w.isError && /never written/.test(text(w)), text(w).slice(0, 300));
  });
});

testGroup('decision 4: EMET_TEMPLATE_MAP checks a bot handoff against templates/HANDOFF.md and never rejects it', () => {
  test('mapped: the write lands and carries a conformance record against templates/HANDOFF.md; unmapped: untemplated', async () => {
    const db = makeStore();
    await withEnv({ EMET_TEMPLATE_MAP: `${BOT_HANDOFF}=templates/HANDOFF.md` }, async () => {
      const r = await go(db, 'write_doc', { doc_id: BOT_HANDOFF, content: 'not in the template form\n', source: BOT });
      assert.ok(!r.isError, text(r).slice(0, 300));
      assert.strictEqual(dataOf(r).conformance.template, 'templates/HANDOFF.md');
    });
    const db2 = makeStore();
    const r2 = await go(db2, 'write_doc', { doc_id: BOT_HANDOFF, content: 'free form\n', source: BOT });
    assert.strictEqual(dataOf(r2).conformance.verdict, 'untemplated');
  });
});

// --- review fixes (the reviewer's F1/F2, the second reader's receipt test) ---------------
testGroup('F1: every other door to the main records refuses a bot tag (retire_doc, rename_doc from/onto, accept_nonconformance)', () => {
  const NC = { verdict: 'nonconforming', failures: ['section 2 missing'], warnings: [], checked_at: new Date().toISOString() };
  const seed = (db, { withState = true } = {}) => {
    const when = new Date(Date.now() - 86400000);
    if (withState) db.col('documents').docs.push({ doc_id: 'STATE.md', version: 7, content: '# Board\nhub\n', sha256: 'x', updated_at: when, updated_by: HOST, size: 12, conformance: NC });
    db.col('documents').docs.push(
      { doc_id: 'HANDOFF.md', version: 3, content: '# Handoff\nhub\n', sha256: 'y', updated_at: when, updated_by: HOST, size: 14, conformance: NC },
      { doc_id: `bots/${BOT}/notes.md`, version: 1, content: 'notes\n', sha256: 'z', updated_at: when, updated_by: BOT, size: 6 });
  };
  const unchanged = (db, { withState = true } = {}) => {
    if (withState) {
      const st = db.doc('STATE.md');
      assert.ok(st && st.version === 7 && !st.retired && !st.retired_by && !(st.conformance && st.conformance.accepted), `STATE.md changed: ${JSON.stringify(st)}`);
    } else {
      assert.strictEqual(db.doc('STATE.md'), undefined, 'STATE.md was created');
    }
    const h = db.doc('HANDOFF.md');
    assert.ok(h.version === 3 && !h.retired && !h.retired_by && !(h.conformance && h.conformance.accepted), `HANDOFF.md changed: ${JSON.stringify(h)}`);
    assert.ok(!db.doc(`bots/${BOT}/notes.md`).retired, 'the rename source was retired');
    assert.strictEqual(db.doc(`bots/${BOT}/STATE.md`), undefined, 'a rename copy was written');
  };
  {
    test(`under ${BOT}, retire_doc of HANDOFF.md/STATE.md, rename_doc from STATE.md, rename_doc onto an absent STATE.md and accept_nonconformance on either are refused; nothing changes`, async () => {
      const db = makeStore();
      seed(db);
      openSession(db);
      const tries = [
        ['retire_doc', { doc_id: 'HANDOFF.md', reason: 'bot tidy', source: BOT }],
        ['retire_doc', { doc_id: 'STATE.md', reason: 'bot tidy', retired_by: BOT }],
        ['rename_doc', { old_id: 'STATE.md', new_id: `bots/${BOT}/STATE.md`, source: BOT }],
        ['accept_nonconformance', { doc_id: 'STATE.md', reason: 'accepted by the bot for now', source: BOT }],
        ['accept_nonconformance', { doc_id: 'HANDOFF.md', reason: 'accepted by the bot for now', accepted_by: BOT }]
      ];
      for (const [tool, args] of tries) {
        const r = await go(db, tool, inSession(args));
        assert.ok(r.isError, `${tool} ${args.doc_id || args.old_id} was not refused: ${text(r).slice(0, 300)}`);
        assert.ok(HUB_MESSAGE.test(text(r)) && /Nothing was written/.test(text(r)) && text(r).includes(`${tool}:`), text(r).slice(0, 400));
      }
      unchanged(db);
      const empty = makeStore();
      seed(empty, { withState: false });
      openSession(empty);
      const onto = await go(empty, 'rename_doc', inSession({ old_id: `bots/${BOT}/notes.md`, new_id: 'STATE.md', source: BOT }));
      assert.ok(onto.isError && HUB_MESSAGE.test(text(onto)), `rename onto an absent STATE.md was not refused: ${text(onto).slice(0, 300)}`);
      unchanged(empty, { withState: false });
    });
  }
  test(`under a host tag (${HOST}) the same calls are allowed`, async () => {
    const db = makeStore();
    seed(db);
    const acc = await go(db, 'accept_nonconformance', { doc_id: 'STATE.md', reason: 'accepted by the hub for now', source: HOST });
    assert.ok(!acc.isError, text(acc).slice(0, 300));
    assert.ok(db.doc('STATE.md').conformance.accepted, 'the acceptance was not recorded');
    const ret = await go(db, 'retire_doc', { doc_id: 'HANDOFF.md', reason: 'hub tidy of the record', source: HOST });
    assert.ok(ret.isError && /not a drop/.test(text(ret)), text(ret).slice(0, 300));
    const ren = await go(db, 'rename_doc', { old_id: 'STATE.md', new_id: 'archive/STATE-2026-10.md', source: HOST });
    assert.ok(ren.isError && /never renamed/.test(text(ren)), text(ren).slice(0, 300));
    const empty = makeStore();
    seed(empty, { withState: false });
    const onto = await go(empty, 'rename_doc', { old_id: `bots/${BOT}/notes.md`, new_id: 'STATE.md', source: HOST });
    assert.ok(onto.isError && /never renamed/.test(text(onto)), text(onto).slice(0, 300));
  });
});

testGroup('F2: one session, one tag; a main record in thread_docs is dropped with a warning', () => {
  test('a bot session whose transcript has a part under another tag closes incomplete (not on the host rules), even with host receipts and hub revisions in the window', async () => {
    const db = makeStore();
    const T = new Date();
    const s = await botSessionReadyToClose(db, 'intake-mixed', T, { seedMain: false, skipHandoff: true });
    db.col('transcripts').docs.push({ session_id: `${s.base}_verbatim_part2`, channel: HOST, session_start: new Date(), session_end: new Date(), exchange_count: 1,
      exchanges: [{ exchange_index: 2, user_message: 'and one more', assistant_message: 'done', timestamp: Date.now() / 1000 }], created_at: new Date() });
    seedMainRecords(db, { ageMs: -1000 }); // the hub revised both in the window, after the bot's writes
    const receipts = { working_docs: [s.intakeId], episodic_id: 77, board_doc: 'STATE.md', board_version: 7, transcript_session_id: s.base,
      transcript_parts: [s.sid, `${s.base}_verbatim_part2`], transcript_exchanges: 2, handoff_version: 3 };
    const c = dataOf(await close(db, s, receipts));
    assert.strictEqual(c.state, 'incomplete', JSON.stringify(c.missing));
    assert.ok(c.missing.some((m) => /^the transcript's parts carry more than one source tag/.test(m) && m.includes(`including bot tag ${BOT}`)), JSON.stringify(c.missing));
    assert.strictEqual(db.row(s.base)?.closed, undefined, 'the mixed session was recorded closed');
  });
  test('a bot close whose thread_docs name STATE.md is still complete, does not check STATE.md, and says so in warnings', async () => {
    const db = makeStore();
    const T = new Date();
    const s = await botSessionReadyToClose(db, 'intake-thread-main', T);
    const c = dataOf(await close(db, s, s.receipts, { thread_docs: ['STATE.md'] }));
    assert.strictEqual(c.state, 'complete', JSON.stringify(c.missing));
    assert.ok(!c.checked.documents.some((d) => d.doc_id === 'STATE.md'), 'STATE.md was checked');
    assert.ok(c.warnings.some((w) => w.startsWith('thread_docs named STATE.md;') && HUB_MESSAGE.test(w) && /so they were not checked/.test(w)), JSON.stringify(c.warnings));
  });
});

// The second reader's test check in review: the 7th receipt and the bot handoff's version /
// written-last checks had no test (mutations m6 and m8 survived).
testGroup('bot handoff receipts', () => {
  test('bot receipts: handoff_doc missing or naming another handoff, a stale handoff_version, or a handoff not written last -> blocked', async () => {
    const T = new Date();
    const cases = [
      [(r) => { const { handoff_doc, ...x } = r; return x; }, /^receipt missing: handoff_doc/],
      [(r) => ({ ...r, handoff_doc: 'bots/other-bot/HANDOFF.md' }), /^handoff_doc names bots\/other-bot\/HANDOFF\.md; this session's handoff is bots\/intake-bot\/HANDOFF\.md/],
      [(r) => ({ ...r, handoff_version: 9 }), /^handoff: receipt says v9, store holds v1/]
    ];
    for (const [i, [patch, want]] of cases.entries()) {
      const db = makeStore();
      const s = await botSessionReadyToClose(db, `intake-hdoc-${i}`, T);
      const c = dataOf(await close(db, s, patch(s.receipts)));
      assert.strictEqual(c.state, 'blocked', JSON.stringify(c.missing));
      assert.ok(c.missing.some((m) => want.test(m)), JSON.stringify(c.missing));
    }
    const db = makeStore();
    const s = await botSessionReadyToClose(db, 'intake-hlast', T);
    db.col('emet_episodic').docs.find((e) => e.id === 77).timestamp = (Date.now() + 5000) / 1000;
    const c = dataOf(await close(db, s));
    assert.strictEqual(c.state, 'blocked', JSON.stringify(c.missing));
    assert.ok(c.missing.some((m) => /^handoff was not the last write - written after it: episodic 77/.test(m)), JSON.stringify(c.missing));
  });
});

// The second reader's re-check of an earlier draft: thread_docs sent as text threw a TypeError in a
// bot close. The close path spreads a non-array thread_docs as it always has
// (host and bot alike); the result must be a reply that is not complete, never
// a thrown error.
testGroup('thread_docs sent as text on a bot close', () => {
  test('a bot close with thread_docs as a string does not throw: it returns a close reply, not complete, with no thread_docs warning', async () => {
    const db = makeStore();
    const T = new Date();
    const s = await botSessionReadyToClose(db, 'intake-thread-text', T);
    const r = await close(db, s, s.receipts, { thread_docs: 'STATE.md' });
    assert.ok(!r.isError, `the close threw: ${text(r).slice(0, 300)}`);
    const c = dataOf(r);
    assert.ok(['incomplete', 'blocked'].includes(c.state), `state ${c.state}: ${JSON.stringify(c.missing)}`);
    assert.strictEqual(c.checked.session_records.kind, 'bot');
    assert.ok(!c.warnings.some((w) => w.startsWith('thread_docs named')), JSON.stringify(c.warnings));
    assert.strictEqual(db.row(s.base)?.closed, undefined, 'a close that was not complete was recorded closed');
  });
});

testGroup('F1 rename onto an existing main record', () => {
  test('under the bot tag, rename_doc onto an existing STATE.md or HANDOFF.md is refused by the bot-records rule (not only by "Destination already exists"); nothing changes', async () => {
    for (const target of ['STATE.md', 'HANDOFF.md']) {
      const db = makeStore();
      seedMainRecords(db);
      db.col('documents').docs.push({ doc_id: `bots/${BOT}/notes.md`, version: 1, content: 'notes\n', sha256: 'z', updated_at: new Date(), updated_by: BOT, size: 6 });
      const r = await go(db, 'rename_doc', { old_id: `bots/${BOT}/notes.md`, new_id: target, source: BOT });
      assert.ok(r.isError && HUB_MESSAGE.test(text(r)) && text(r).includes('rename_doc:'), text(r).slice(0, 300));
      assert.strictEqual(db.doc(target).version, target === 'STATE.md' ? 7 : 3);
      assert.ok(!db.doc(`bots/${BOT}/notes.md`).retired, 'the rename source was retired');
    }
  });
});

summary('Bot Session Close (C1) Test Summary');
