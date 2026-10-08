/**
 * The close is recorded - through the door (2026-10-01, the second reader's re-check 4 and
 * the reviewer's re-gate of an earlier draft).
 *
 * Every test here calls emet_session_close through dispatchTool, the way both
 * transports do, against an in-memory store that is complete enough for
 * sessionClose to return state 'complete' for real: the transcript parts, the
 * documents (STATE.md, HANDOFF.md), the episodic session record, a layer entry
 * citing the transcript (derived_from), and the receipts that match them.
 * No database, and no calls to a live server.
 *
 *  1. A close that names its session only in receipts.transcript_session_id
 *     (a shape the close tool documents) is recorded, so the session locks and
 *     its id is not handed out again. (review nit 3 / the reviewer condition 1.)
 *  2. A failed closed-flag write is retried once; if it fails again the reply
 *     says closed_recorded: false with a warning, instead of reading as a
 *     locked session. (review nit 2 / the reviewer condition 2.)
 *  3. A close-and-reopen cycle, and the 4:59 grace case, with the close driven
 *     through emet_session_close, not by writing the session row directly.
 *     (review nit 1 / the reviewer item 4.)
 */
import { test, testGroup, summary } from './harness.js';
import assert from 'assert';
import { fullStartup } from './graph-session.js';

// sessionClose connects for itself and refuses when MONGODB_URI is unset. The
// in-memory client below is installed through mongo-connect's test seam, so
// this URI is never dialled. Set before any src module is imported (all src
// imports in this file are dynamic).
process.env.MONGODB_URI = 'mongodb://in-memory.test/emet';
delete process.env.EMET_CLOSE_GRACE_MINUTES;
delete process.env.CASCADE_CLOSE_GRACE_MINUTES;

console.log('\n=== session-close-record ===');

/**
 * A store. `failCloseWrites`: how many times the write that records a close
 * ({$set: {closed: true}} on the sessions collection) throws before it works.
 */
import { makeStore as sharedMakeStore } from './memstore.js';
function makeStore(opts = {}) { return sharedMakeStore(opts); }

async function withStore(db, fn) {
  const mongoConnect = await import('../src/mongo-connect.js');
  mongoConnect.useTestClient(db.Client);
  try { return await fn(); } finally { mongoConnect.useTestClient(null); }
}
const go = (db, tool, args, now) => withStore(db, async () => {
  const { dispatchTool } = await import('../src/dispatch.js');
  return dispatchTool(tool, args, { dbManager: db, logger: null, now });
});
// Non-close steps are recorded without being awaited. Poll until that write shows up.
async function until(pred, label) {
  const deadline = Date.now() + 2000;
  for (;;) {
    if (pred()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((res) => setImmediate(res));
  }
}
const sessionWrites = (db) => db.writes.filter((w) => w.startsWith('update emet_sessions')).length;
const dataOf = (r) => JSON.parse(r.content[0].text).data;
const text = (r) => JSON.stringify(r);
const at = (t, minutes, seconds = 0) => new Date(t.getTime() + minutes * 60000 + seconds * 1000);
const msg = (u, a = 'reply') => ({ user_message: u, assistant_message: a, source: 'test' });

/**
 * A real session up to the close: opened and two exchanges appended through
 * dispatchTool; then the close artifacts a host writes (board, episodic record
 * citing the transcript, handoff last) seeded into the store. Returns what the
 * close needs. `T` is the clock the dispatch calls run on; the artifacts are
 * dated on the wall clock, as sessionClose judges "this session" by it.
 */
async function sessionReadyToClose(db, slug, T) {
  const opened = await go(db, 'emet_session_open', { slug, load_id: await fullStartup() }, T);
  assert.ok(!opened.isError, text(opened).slice(0, 300));
  const { session_id: sid, base } = dataOf(opened);
  await until(() => db.row(base)?.opened === true, 'session opened');
  const beforeAppend = sessionWrites(db);
  const a1 = await go(db, 'emet_transcript_append', { session_id: sid, ...msg('hi', 'no local shell MCP. hello') }, T);
  assert.ok(!a1.isError, text(a1).slice(0, 300));
  const a2 = await go(db, 'emet_transcript_append', { session_id: sid, ...msg('wrap up please', 'wrapping up') }, T);
  assert.ok(!a2.isError, text(a2).slice(0, 300));
  // An append does not record a session step, so it cannot open a board-editing session.
  assert.strictEqual(sessionWrites(db), beforeAppend, 'an append does not record a session step');
  const wall = Date.now();
  db.col('documents').docs.push(
    { doc_id: 'STATE.md', version: 7, updated_at: new Date(wall - 5 * 60000), updated_by: 'test', size: 10 },
    { doc_id: 'HANDOFF.md', version: 3, updated_at: new Date(wall - 60000), updated_by: 'test', size: 10 }
  );
  db.col('emet_episodic').docs.push({ id: 42, timestamp: (wall - 10 * 60000) / 1000, importance: 0.5, metadata: { source: 'test' },
    source_session_id: base, source_exchange_start: 1, source_exchange_end: 2 });
  const receipts = { working_docs: [], episodic_id: 42, board_doc: 'STATE.md', board_version: 7,
    transcript_session_id: base, transcript_parts: [sid], transcript_exchanges: 2, handoff_version: 3 };
  return { sid, base, receipts, session_start: Math.floor((wall - 3600000) / 1000) };
}
const exchangesOf = (db, sid) => db.transcripts().filter((d) => d.session_id === sid && !d.superseded_by).flatMap((d) => d.exchanges.map((e) => e.exchange_index));

// -----------------------------------------------------------------------------
testGroup('a close that names its session only in receipts.transcript_session_id is recorded (review nit 3, the reviewer condition 1)', () => {
  test('through dispatchTool: close with no session_id, receipts naming the session -> complete, recorded closed; an append after the window is refused, nothing written; the id is not reused', async () => {
    const db = makeStore();
    const T = new Date();
    const s = await sessionReadyToClose(db, 'receipts-only', T);
    const closed = await go(db, 'emet_session_close', { receipts: s.receipts, session_start: s.session_start }, T);
    assert.ok(!closed.isError, text(closed).slice(0, 400));
    const c = dataOf(closed);
    assert.strictEqual(c.state, 'complete', JSON.stringify(c.missing));
    assert.strictEqual(db.row(s.base)?.closed, true, 'the close was not recorded');
    assert.strictEqual(new Date(db.row(s.base).closed_at).getTime(), T.getTime());
    assert.strictEqual(c.closed_recorded, true);
    const late = await go(db, 'emet_transcript_append', { session_id: s.sid, ...msg('one more', 'x') }, at(T, 6));
    assert.ok(late.isError && /closed and locked/.test(text(late)) && /5-minute window/.test(text(late)), text(late).slice(0, 400));
    assert.deepStrictEqual(exchangesOf(db, s.sid), [1, 2]);
    const reopened = await go(db, 'emet_session_open', { slug: 'receipts-only', load_id: await fullStartup() }, T);
    assert.ok(!reopened.isError, text(reopened).slice(0, 300));
    assert.strictEqual(dataOf(reopened).base, `${s.base}-2`, 'the closed id was handed out again');
  });
  test('receipts sent as JSON text are read the same way: the close is recorded', async () => {
    const db = makeStore();
    const T = new Date();
    const s = await sessionReadyToClose(db, 'receipts-text', T);
    const closed = await go(db, 'emet_session_close', { receipts: JSON.stringify(s.receipts), session_start: s.session_start }, T);
    assert.ok(!closed.isError && dataOf(closed).state === 'complete', text(closed).slice(0, 400));
    assert.strictEqual(db.row(s.base)?.closed, true, 'the close was not recorded');
    const late = await go(db, 'emet_transcript_append', { session_id: s.sid, ...msg('one more', 'x') }, at(T, 6));
    assert.ok(late.isError && /closed and locked/.test(text(late)), text(late).slice(0, 400));
  });
  test('sessionOf reads receipts.transcript_session_id last: session_id and derived_from still come first', async () => {
    const { sessionOf } = await import('../src/session-graph.js');
    assert.strictEqual(sessionOf({ receipts: { transcript_session_id: ' 2026-09-30_a ' } }), '2026-09-30_a');
    assert.strictEqual(sessionOf({ receipts: '{"transcript_session_id":"2026-09-30_a"}' }), '2026-09-30_a');
    assert.strictEqual(sessionOf({ session_id: '2026-09-30_b', receipts: { transcript_session_id: '2026-09-30_a' } }), '2026-09-30_b');
    assert.strictEqual(sessionOf({ receipts: 'not json' }), null);
    assert.strictEqual(sessionOf({ receipts: { transcript_session_id: 7 } }), null);
  });
});

testGroup('a failed closed-flag write is not swallowed (review nit 2, the reviewer condition 2)', () => {
  test('the write fails once: it is retried, the close is recorded, closed_recorded: true, and the session locks', async () => {
    const db = makeStore();
    const T = new Date();
    const s = await sessionReadyToClose(db, 'retry-once', T);
    db.state.failCloseWrites = 1;
    const closed = await go(db, 'emet_session_close', { session_id: s.sid, receipts: s.receipts, session_start: s.session_start }, T);
    assert.ok(!closed.isError && dataOf(closed).state === 'complete', text(closed).slice(0, 400));
    assert.strictEqual(db.state.closeWriteAttempts, 2, 'the failed write was not retried');
    assert.strictEqual(db.row(s.base)?.closed, true, 'the retried close was not recorded');
    assert.strictEqual(dataOf(closed).closed_recorded, true);
    assert.strictEqual(dataOf(closed).closed_record_warning, undefined);
    const late = await go(db, 'emet_transcript_append', { session_id: s.sid, ...msg('one more', 'x') }, at(T, 6));
    assert.ok(late.isError && /closed and locked/.test(text(late)), text(late).slice(0, 400));
  });
  test('the write fails twice: the reply says closed_recorded: false with a clear warning (in warnings and instructions), and does not pretend the session is locked', async () => {
    const db = makeStore();
    const T = new Date();
    const s = await sessionReadyToClose(db, 'retry-fails', T);
    db.state.failCloseWrites = 2;
    const closed = await go(db, 'emet_session_close', { session_id: s.sid, receipts: s.receipts, session_start: s.session_start }, T);
    assert.ok(!closed.isError, text(closed).slice(0, 400));
    const c = dataOf(closed);
    assert.strictEqual(c.state, 'complete');
    assert.strictEqual(db.state.closeWriteAttempts, 2, 'expected one try and one retry');
    assert.strictEqual(c.closed_recorded, false);
    const w = c.closed_record_warning || '';
    assert.ok(new RegExp(`could not record session ${s.base} as closed`).test(w) && /sessions store write failed/.test(w) &&
      /NOT locked/.test(w) && /Call emet_session_close again/.test(w), w);
    assert.ok(c.warnings.includes(w), 'the warning is not in warnings');
    assert.ok(c.instructions.includes(w), 'the warning is not in instructions');
    assert.ok(!db.row(s.base)?.closed, 'the row says closed although the write failed');
    // Calling the close again, once the store takes writes, records it.
    const again = await go(db, 'emet_session_close', { session_id: s.sid, receipts: s.receipts, session_start: s.session_start }, T);
    assert.ok(!again.isError && dataOf(again).closed_recorded === true, text(again).slice(0, 400));
    assert.strictEqual(db.row(s.base)?.closed, true);
  });
  test('graphAfter reports what happened: recorded true, recorded false with the error, or null when there is nothing to record', async () => {
    const sg = await import('../src/session-graph.js');
    const ok = makeStore();
    assert.deepStrictEqual(await sg.graphAfter('emet_session_close', { session_id: '2026-09-30_g_verbatim_part1' }, { state: 'complete' }, ok, null), { recorded: true, base: '2026-09-30_g' });
    const bad = makeStore({ failCloseWrites: 1 });
    const r = await sg.graphAfter('emet_session_close', { session_id: '2026-09-30_g' }, { state: 'complete' }, bad, null);
    assert.strictEqual(r.recorded, false); assert.strictEqual(r.base, '2026-09-30_g'); assert.ok(/write failed/.test(r.error), r.error);
    assert.strictEqual(await sg.graphAfter('emet_session_close', { session_id: '2026-09-30_g' }, { state: 'blocked' }, ok, null), null);
  });
});

testGroup('close and reopen through emet_session_close (review nit 1, the reviewer item 4)', () => {
  test('a real cycle: open, two appends, emet_session_close via dispatchTool (complete), the closing exchange at 4:59, then locked; reopen gives -2, which starts at exchange 1', async () => {
    const db = makeStore();
    const T = new Date();
    const s = await sessionReadyToClose(db, 'cycle-door', T);
    const closed = await go(db, 'emet_session_close', { session_id: s.sid, receipts: s.receipts, session_start: s.session_start }, T);
    assert.ok(!closed.isError && dataOf(closed).state === 'complete', text(closed).slice(0, 400));
    assert.strictEqual(db.row(s.base)?.closed, true);
    const closing = await go(db, 'emet_transcript_append', { session_id: s.sid, ...msg('thanks', 'closed') }, at(T, 4, 59));
    assert.ok(!closing.isError, text(closing).slice(0, 400));
    assert.strictEqual(dataOf(closing).exchange_index, 3);
    assert.ok(dataOf(closing).closing_exchange.accepted && dataOf(closing).closing_exchange.locked, text(closing).slice(0, 400));
    const late = await go(db, 'emet_transcript_append', { session_id: s.sid, ...msg('one more', 'x') }, at(T, 4, 59.5));
    assert.ok(late.isError && /closed and locked/.test(text(late)) && /closing exchange has already been saved/.test(text(late)), text(late).slice(0, 400));
    assert.deepStrictEqual(exchangesOf(db, s.sid), [1, 2, 3]);
    const reopened = await go(db, 'emet_session_open', { slug: 'cycle-door', load_id: await fullStartup() }, T);
    assert.strictEqual(dataOf(reopened).base, `${s.base}-2`);
    assert.ok(/already closed/.test(dataOf(reopened).notice), dataOf(reopened).notice);
    await until(() => db.row(`${s.base}-2`)?.opened === true, 'reopened session recorded');
    const b1 = await go(db, 'emet_transcript_append', { session_id: dataOf(reopened).session_id, ...msg('hi again', 'no local shell MCP. hello') }, T);
    assert.ok(!b1.isError && dataOf(b1).exchange_index === 1, text(b1).slice(0, 300));
    assert.deepStrictEqual(exchangesOf(db, s.sid), [1, 2, 3], 'the closed session changed');
  });
  test('the 4:59 grace case: a closing append 4 minutes 59 seconds after a close made through emet_session_close is accepted; 5:01 after another such close is refused', async () => {
    const db = makeStore();
    const T = new Date();
    const s = await sessionReadyToClose(db, 'grace-459', T);
    const closed = await go(db, 'emet_session_close', { session_id: s.sid, receipts: s.receipts, session_start: s.session_start }, T);
    assert.ok(!closed.isError && dataOf(closed).state === 'complete', text(closed).slice(0, 400));
    const r = await go(db, 'emet_transcript_append', { session_id: s.sid, ...msg('thanks', 'bye') }, at(T, 4, 59));
    assert.ok(!r.isError && dataOf(r).closing_exchange.accepted, text(r).slice(0, 400));
    assert.deepStrictEqual(exchangesOf(db, s.sid), [1, 2, 3]);
    const db2 = makeStore();
    const s2 = await sessionReadyToClose(db2, 'grace-501', T);
    const closed2 = await go(db2, 'emet_session_close', { session_id: s2.sid, receipts: s2.receipts, session_start: s2.session_start }, T);
    assert.ok(!closed2.isError && dataOf(closed2).state === 'complete', text(closed2).slice(0, 400));
    const r2 = await go(db2, 'emet_transcript_append', { session_id: s2.sid, ...msg('thanks', 'bye') }, at(T, 5, 1));
    assert.ok(r2.isError && /5-minute window/.test(text(r2)), text(r2).slice(0, 400));
    assert.deepStrictEqual(exchangesOf(db2, s2.sid), [1, 2]);
  });
});

testGroup('the close attributes only a registered tag that wrote the session; anything else warns, nothing is refused', () => {
  const NO_TAG = /No source tag/;
  const NOT_ATTRIBUTED = /not attributed/;
  // The appends in sessionReadyToClose are written under the tag 'test'.
  const withEnv = async (vars, fn) => {
    const keys = ['EMET_SOURCE_TAG', 'CASCADE_SOURCE_TAG', 'EMET_SOURCE_TAGS', 'CASCADE_SOURCE_TAGS'];
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    for (const k of keys) delete process.env[k];
    for (const [k, v] of Object.entries(vars)) process.env[k] = v;
    try { return await fn(); } finally {
      for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    }
  };
  const closeWith = async (slug, extra = {}) => {
    const db = makeStore();
    const T = new Date();
    const s = await sessionReadyToClose(db, slug, T);
    const closed = await go(db, 'emet_session_close', { session_id: s.sid, receipts: s.receipts, session_start: s.session_start, ...extra }, T);
    assert.ok(!closed.isError, text(closed).slice(0, 400));
    return dataOf(closed);
  };
  const attributionWarnings = (c) => c.warnings.filter((w) => NO_TAG.test(w) || NOT_ATTRIBUTED.test(w));
  test('a registered source that wrote the session: complete, no attribution warning; it is trimmed and echoed', async () => {
    await withEnv({ EMET_SOURCE_TAGS: 'test,laptop' }, async () => {
      const c = await closeWith('tag-match', { source: '  test  ' });
      assert.strictEqual(c.state, 'complete', JSON.stringify(c.missing));
      assert.deepStrictEqual(attributionWarnings(c), []);
      assert.strictEqual(c.checked.close_source, 'test');
    });
  });
  test('no registry configured: any tag that wrote the session is attributed', async () => {
    await withEnv({}, async () => {
      const c = await closeWith('tag-noreg', { source: 'test' });
      assert.deepStrictEqual(attributionWarnings(c), []);
    });
  });
  test('an unregistered source warns (not registered) and the close is not refused', async () => {
    await withEnv({ EMET_SOURCE_TAGS: 'test,laptop' }, async () => {
      const c = await closeWith('tag-unreg', { source: 'phone' });
      assert.strictEqual(c.state, 'complete', JSON.stringify(c.missing));
      const w = attributionWarnings(c).join(' ');
      assert.ok(/"phone"/.test(w) && /not registered in EMET_SOURCE_TAGS/.test(w) && /not refused/.test(w), w || JSON.stringify(c.warnings));
    });
  });
  test('a registered source that did not write the session warns and names the session\'s tag', async () => {
    await withEnv({ EMET_SOURCE_TAGS: 'test,laptop' }, async () => {
      const c = await closeWith('tag-other', { source: 'laptop' });
      const w = attributionWarnings(c).join(' ');
      assert.ok(/"laptop"/.test(w) && /not among the tags that wrote this session \("test"\)/.test(w), w || JSON.stringify(c.warnings));
      assert.ok(!/not registered/.test(w), w);
    });
  });
  test('a long source is echoed capped at whole characters, in checked.close_source and in the warning', async () => {
    await withEnv({ EMET_SOURCE_TAGS: 'test' }, async () => {
      const long = `${'\u{1F600}'.repeat(70)}x`;
      const c = await closeWith('tag-long', { source: long });
      const echo = c.checked.close_source;
      assert.strictEqual(Array.from(echo).length, 65, echo);
      assert.ok(echo.endsWith('\u2026') && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(echo), 'lone surrogate or no cap mark');
      const w = attributionWarnings(c).join(' ');
      assert.ok(w.includes(echo) && !w.includes(long), 'the warning did not use the capped echo');
    });
  });
  test('shared server, no source on the close: the no-tag warning, which says to pass source and register it', async () => {
    await withEnv({}, async () => {
      const c = await closeWith('tag-missing');
      const w = c.warnings.find((x) => NO_TAG.test(x)) || '';
      assert.ok(/`source`/.test(w) && /EMET_SOURCE_TAGS/.test(w) && /unset on a server several hosts share/.test(w), w || JSON.stringify(c.warnings));
      assert.ok(!/Set EMET_SOURCE_TAG\./.test(w), w);
      assert.strictEqual(c.checked.close_source, null);
    });
  });
  test('a single-host default tag is judged the same way: the session\'s own tag is attributed, another is warned', async () => {
    await withEnv({ EMET_SOURCE_TAG: 'test' }, async () => {
      assert.deepStrictEqual(attributionWarnings(await closeWith('tag-default')), []);
    });
    await withEnv({ EMET_SOURCE_TAG: 'laptop' }, async () => {
      const w = attributionWarnings(await closeWith('tag-default-other')).join(' ');
      assert.ok(/default tag "laptop"/.test(w) && /not among the tags that wrote this session/.test(w), w);
    });
  });
  test('the rule as a pure function, and the lab row keeps the trimmed tag', async () => {
    const { sourceTagWarning, closeSourceOf, isRegisteredSource } = await import('../src/session.js');
    const { labRow } = await import('../src/session-graph.js');
    assert.strictEqual(closeSourceOf({ source: '   ' }), null);
    assert.strictEqual(closeSourceOf({ source: ' phone ' }), 'phone');
    assert.strictEqual(sourceTagWarning('phone', null, { registry: ['phone'], sessionTags: ['phone'] }), null);
    assert.ok(/not registered/.test(sourceTagWarning('phone', null, { registry: ['laptop'], sessionTags: ['phone'] })));
    assert.ok(/no transcript of this session was read/.test(sourceTagWarning('phone', null, { registry: [], sessionTags: [] })));
    assert.ok(NO_TAG.test(sourceTagWarning(null, null)));
    assert.ok(!isRegisteredSource('cloud-scheduled-weekly', ['laptop']) && isRegisteredSource('x', []) && !isRegisteredSource('x', ['laptop']));
    const graph = { mode: 'enforce', base: '2026-10-03_x', decision: { verdict: 'pass', next: null } };
    assert.strictEqual(labRow('emet_session_close', { session_id: '2026-10-03_x', source: '  test  ' }, graph).source, 'test');
  });
  test('the close tool takes source', async () => {
    const { TOOLS } = await import('../src/tools.js');
    const close = TOOLS.find((t) => t.name === 'emet_session_close');
    assert.strictEqual(close.inputSchema.properties.source.type, 'string');
  });
});

testGroup("EMET_CLOSE_GRACE_MINUTES takes decimal numbers only (the second reader's nit 5)", () => {
  test('"0x10", "0b11" and "0o7" are not minutes: the default 5 is used, with a note', async () => {
    const { closeGraceSetting } = await import('../src/session-graph.js');
    for (const v of ['0x10', '0b11', '0o7', '0X1F']) {
      const s = closeGraceSetting(v);
      assert.strictEqual(s.minutes, 5, `${v} read as ${s.minutes}`);
      assert.ok(/default 5 is used/.test(s.note || ''), `${v}: ${s.note}`);
    }
    assert.deepStrictEqual(closeGraceSetting('2.5'), { minutes: 2.5, note: null });
    assert.deepStrictEqual(closeGraceSetting('010'), { minutes: 10, note: null });
  });
});

summary('Session Close Record Test Summary');
