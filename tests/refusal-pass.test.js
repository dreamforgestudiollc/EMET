/**
 * Every refusal says how to pass, in the same reply (2026-10-03). The session
 * graph runs in enforce only, so each skipped step is refused before anything
 * is written; this suite sends each refused call through dispatchTool and
 * asserts the reply carries its pass instruction, uncut by the 500-character
 * error-message cap. In-memory store; no database.
 */
import { test, testGroup, summary } from './harness.js';
import assert from 'assert';
import { makeStore, withStore } from './memstore.js';
import { fullStartup } from './graph-session.js';

process.env.MONGODB_URI = 'mongodb://in-memory.test/emet';
for (const k of ['EMET_SOURCE_TAG', 'EMET_SOURCE_TAGS', 'EMET_TEMPLATE_MAP', 'EMET_RECORD_DOCS', 'CASCADE_RECORD_DOCS', 'EMET_CLOSE_GRACE_MINUTES', 'CASCADE_CLOSE_GRACE_MINUTES', 'EMET_SESSION_GRAPH'])
  delete process.env[k];

console.log('\n=== every refusal says how to pass ===');

const { dispatchTool } = await import('../src/dispatch.js');
const pg = await import('../src/startup-pages.js');

const BASE = '2026-10-03_refusal-pass-check-with-a-long-slug';
const SID = `${BASE}_verbatim_part1`;
const HOST = 'example-host';
const T = new Date();

function world({ session = null, exchanges = 0, base = BASE } = {}) {
  const store = makeStore();
  if (session) store.collection('emet_sessions').docs.push({ _id: base, ...session });
  if (exchanges) {
    store.collection('transcripts').docs.push({ _id: 'p1', session_id: `${base}_verbatim_part1`, exchange_count: exchanges,
      exchanges: Array.from({ length: exchanges }, (_, i) => ({ exchange_index: i + 1, user_message: 'u', assistant_message: 'a' })) });
  }
  const dbManager = {
    async ensureClient() { return new store.Client().db(); },
    async transcriptPosition(sid) {
      const base = String(sid).replace(/_verbatim_part\d+$/, '');
      const live = store.collection('transcripts').docs.filter((d) => (d.session_id === base || d.session_id.startsWith(`${base}_`)) && !d.superseded_by);
      const highest = live.reduce((m, d) => Math.max(m, ...(d.exchanges || []).map((e) => Number(e.exchange_index))), 0);
      return { base, present: live.length > 0, highest, last_part: live.length ? live[live.length - 1].session_id : null };
    }
  };
  return { store, dbManager };
}
const send = (w, tool, args, now = T) => withStore(w.store, () => dispatchTool(tool, args, { dbManager: w.dbManager, logger: null, now }));
// The refusal as the host receives it: the error message on the wire.
const refusalOf = (r) => {
  assert.ok(r.isError, `not refused: ${r.content[0].text.slice(0, 300)}`);
  const msg = JSON.parse(r.content[0].text).error.message;
  assert.ok(msg.length <= 500 && !msg.endsWith('\u2026'), `cut by the 500-character cap (${msg.length}): ${msg}`);
  return msg;
};
const has = (msg, ...parts) => { for (const p of parts) assert.ok(msg.includes(p), `missing "${p}" in: ${msg}`); };
const msg = { user_message: 'u', assistant_message: 'a', source: HOST };
const minutesBefore = (m) => new Date(T.getTime() - m * 60000);

testGroup('opening a session', () => {
  test('no load_id: says to pass load_id from the startup pages', async () => {
    const m = refusalOf(await send(world(), 'emet_session_open', { slug: 'x' }));
    has(m, 'emet_session_open needs load_id', 'Call emet_session_open again with "load_id" set to startup_page.load_id from your emet_initialize pages', 'call emet_initialize {} and fetch every page first');
  });
  test('a startup page never fetched: names the page and the exact call, then the open again', async () => {
    pg.clearPageCache();
    pg.notePageServed('feed0001feed0001', 1, 3);
    const m = refusalOf(await send(world(), 'emet_session_open', { slug: 'x', load_id: 'feed0001feed0001' }));
    has(m, 'Fetch startup pages 2-3 of 3', 'emet_initialize {"page": 2, "load_id": "feed0001feed0001"}', 'the same call for each page after it', 'emet_session_open again with "load_id": "feed0001feed0001"');
  });
  for (const of of [21, 41]) {
    test(`${of - 1} startup pages never fetched: the call and the open again survive the 500-character cap, pages named once as a range`, async () => {
      pg.clearPageCache();
      pg.notePageServed('feed0002feed0002', 1, of);
      const m = refusalOf(await send(world(), 'emet_session_open', { slug: 'x', load_id: 'feed0002feed0002' }));
      assert.ok(m.indexOf('Fetch startup pages') < m.indexOf('never fetched'), `the instruction does not come first: ${m}`);
      has(m, `Fetch startup pages 2-${of} of ${of}`, 'emet_initialize {"page": 2, "load_id": "feed0002feed0002"}', 'the same call for each page after it', 'then call emet_session_open again with "load_id": "feed0002feed0002"', 'If told the startup changed, call emet_initialize {} and read every page.');
      assert.strictEqual(m.split(`2-${of}`).length, 2, `the page list is printed more than once: ${m}`);
    });
  }
  test('scattered pages too many to list: says to fetch every page again from page 1, uncut', async () => {
    pg.clearPageCache();
    pg.notePageServed('feed0003feed0003', 1, 200);
    for (let p = 3; p <= 200; p += 2) pg.notePageServed('feed0003feed0003', p, 200);
    const m = refusalOf(await send(world(), 'emet_session_open', { slug: 'x', load_id: 'feed0003feed0003' }));
    has(m, 'Fetch every startup page of load feed0003feed0003, 1 to 200', 'emet_initialize {"page": 1, "load_id": "feed0003feed0003"}', 'then call emet_session_open again with "load_id": "feed0003feed0003"', '100 of its 200 pages were never fetched');
  });
  test('a load_id the server has no record of (made up, expired, or before a restart): fetch the startup again, then open with its load_id', async () => {
    pg.clearPageCache();
    for (const id of ['made-up', 'z'.repeat(420)]) {
      const m = refusalOf(await send(world(), 'emet_session_open', { slug: 'x', load_id: id }));
      has(m, 'Call emet_initialize {} and fetch every page, then call emet_session_open again with the load_id it returns', 'is not on record on this server', 'no session was opened and nothing was written');
    }
  });
  test('the session store cannot be read: says to call emet_session_open again', async () => {
    const w = world();
    w.dbManager.ensureClient = async () => { throw new Error('store down'); };
    const m = refusalOf(await send(w, 'emet_session_open', { slug: 'x', load_id: await fullStartup() }));
    has(m, 'no session was opened', 'Call emet_session_open again with the same slug and load_id');
  });
});

testGroup('writing in a session', () => {
  test('a write with no session: open one with emet_session_open and load_id, then resubmit with session_id', async () => {
    const m = refusalOf(await send(world(), 'write_doc', { doc_id: 'notes.md', content: '# n\n', source: HOST }));
    has(m, 'names no session', 'emet_session_open (with the load_id from your startup pages)', 'resubmit this same write with that session_id', 'Nothing was written');
  });
  test('a write naming a session never opened: open it with emet_session_open and load_id, resubmit with the id it returns', async () => {
    const m = refusalOf(await send(world(), 'write_doc', { doc_id: 'notes.md', content: '# n\n', source: HOST, session_id: SID }));
    has(m, 'was never opened', 'Open it with emet_session_open (with the load_id from your startup pages)', 'resubmit this same write with the session_id it returns');
  });
  test('a skipped exchange on a write: names the exchange and emet_transcript_append', async () => {
    const m = refusalOf(await send(world({ session: { opened: true }, exchanges: 2 }), 'save_to_layer', { layer: 'semantic', content: 'x', session_id: SID, exchange: 9, metadata: { source: HOST } }));
    has(m, 'exchange 3 of session', 'Append it with emet_transcript_append', 'exchange_index 3', 'each exchange after it up to 8', 'then resubmit this same call');
  });
  test('a skipped exchange on an append: names the exchange to append first', async () => {
    const m = refusalOf(await send(world({ session: { opened: true }, exchanges: 2 }), 'emet_transcript_append', { session_id: SID, exchange_index: 4, ...msg }));
    has(m, 'exchange 3 of session', 'emet_transcript_append', 'exchange_index 3', 'then resubmit this same call');
  });
  test('a 420-character session id is echoed at most 64 characters, so each instruction survives', async () => {
    const lb = `2026-10-03_${'y'.repeat(409)}`;
    assert.strictEqual(lb.length, 420);
    const lsid = `${lb}_verbatim_part1`;
    const short = `${lb.slice(0, 64)}\u2026`;
    let m = refusalOf(await send(world(), 'write_doc', { doc_id: 'notes.md', content: '# n\n', source: HOST, session_id: lsid }));
    has(m, `session ${short} was never opened`, 'resubmit this same write with the session_id it returns');
    m = refusalOf(await send(world({ base: lb, session: { opened: true }, exchanges: 2 }), 'save_to_layer', { layer: 'semantic', content: 'x', session_id: lsid, exchange: 9, metadata: { source: HOST } }));
    has(m, `exchange 3 of session ${short}`, 'Append it with emet_transcript_append', 'then resubmit this same call');
    const closedLong = () => world({ base: lb, session: { opened: true, closed: true, closed_at: minutesBefore(60) }, exchanges: 2 });
    m = refusalOf(await send(closedLong(), 'patch_doc', { doc_id: 'STATE.md', old_str: 'a', new_str: 'b', source: HOST, session_id: lsid }));
    has(m, `session ${short} is closed and locked`, 'belongs in the next session you open the usual way');
    m = refusalOf(await send(closedLong(), 'emet_transcript_append', { session_id: lsid, ...msg }));
    has(m, `session ${short} is closed and locked`, 'belongs in the next session you open the usual way');
  });
  test('the handoff before its steps: names each step and its tool, then the handoff again', async () => {
    const m = refusalOf(await send(world({ session: { opened: true } }), 'write_doc', { doc_id: 'HANDOFF.md', content: '# h\n', source: HOST, session_id: SID }));
    has(m, 'the handoff is written last', 'the board (STATE.md) with patch_doc', 'save_to_layer (layer "episodic")', 'the transcript with emet_transcript_append', 'resubmit this same handoff write');
    assert.ok(!m.includes('with write_doc'), m);
  });
});

testGroup('a write with no source', () => {
  test('no tags registered: says to pass "source" and that any non-empty tag passes', async () => {
    const m = refusalOf(await send(world({ session: { opened: true }, exchanges: 1 }), 'emet_transcript_append', { session_id: SID, user_message: 'u', assistant_message: 'a' }));
    has(m, 'emet_transcript_append: pass "source"', 'any non-empty tag passes', 'bootstrap/INSTALL.md', 'nothing was written');
  });
  test('tags registered: says to pass "source" and does not publish the registry', async () => {
    process.env.EMET_SOURCE_TAGS = 'host-a,host-b';
    try {
      const m = refusalOf(await send(world({ session: { opened: true }, exchanges: 1 }), 'emet_transcript_append', { session_id: SID, user_message: 'u', assistant_message: 'a' }));
      has(m, 'emet_transcript_append: pass "source" set to the registered tag', 'nothing was written');
      assert.ok(!m.includes('host-a') && !m.includes('cloud-scheduled'), m);
    } finally { delete process.env.EMET_SOURCE_TAGS; }
  });
  for (const n of [20, 50]) {
    test(`${n} registered tags: missing, unregistered and a 420-character tag all lead with the pass instruction and do not list the registry`, async () => {
      process.env.EMET_SOURCE_TAGS = Array.from({ length: n }, (_, i) => `member-bot${String(i).padStart(2, '0')}`).join(',');
      try {
        const w = () => world({ session: { opened: true }, exchanges: 1 });
        let m = refusalOf(await send(w(), 'emet_transcript_append', { session_id: SID, user_message: 'u', assistant_message: 'a' }));
        assert.ok(m.startsWith("Validation failed for 'source': emet_transcript_append: pass \"source\""), m);
        has(m, 'nothing was written');
        assert.ok(!m.includes('member-bot') && !m.includes('cloud-scheduled'), m);
        m = refusalOf(await send(w(), 'emet_transcript_append', { session_id: SID, ...msg, source: 'stranger' }));
        assert.ok(m.startsWith("Validation failed for 'source': emet_transcript_append: pass \"source\" set to a registered tag"), m);
        has(m, 'Source tag "stranger" is not registered, so nothing was written.');
        assert.ok(!m.includes('member-bot'), m);
        m = refusalOf(await send(w(), 'emet_transcript_append', { session_id: SID, ...msg, source: 's'.repeat(420) }));
        has(m, 'pass "source" set to a registered tag', `Source tag "${'s'.repeat(64)}\u2026" is not registered, so nothing was written.`);
        assert.ok(m.length <= 500, m.length);
      } finally { delete process.env.EMET_SOURCE_TAGS; }
    });
  }
  test('long registered tags: the refusal does not list them and stays uncut', async () => {
    process.env.EMET_SOURCE_TAGS = Array.from({ length: 30 }, (_, i) => `${'h'.repeat(300)}${i}`).join(',');
    try {
      const m = refusalOf(await send(world({ session: { opened: true }, exchanges: 1 }), 'emet_transcript_append', { session_id: SID, ...msg, source: 'z'.repeat(420) }));
      has(m, 'pass "source" set to a registered tag', 'is not registered, so nothing was written.');
      assert.ok(!m.includes('h'.repeat(24)) && !m.includes('cloud-scheduled'), m);
      assert.ok(m.length <= 500, m.length);
    } finally { delete process.env.EMET_SOURCE_TAGS; }
  });
});

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
testGroup('echoes are cut on whole characters', () => {
  const E = '\u{1F600}';
  test('an emoji exactly at the 64-character cut of a session id stays whole', async () => {
    const lb = `2026-10-03_${'a'.repeat(52)}${E}${'b'.repeat(100)}`; // the emoji is character 64
    const m = refusalOf(await send(world(), 'write_doc', { doc_id: 'notes.md', content: '# n\n', source: HOST, session_id: `${lb}_verbatim_part1` }));
    has(m, `session 2026-10-03_${'a'.repeat(52)}${E}\u2026 was never opened`);
    assert.ok(!LONE_SURROGATE.test(m), `lone surrogate in: ${m}`);
  });
  test('an emoji exactly at the 64-character cut of a load_id and of a source tag stays whole', async () => {
    pg.clearPageCache();
    let m = refusalOf(await send(world(), 'emet_session_open', { slug: 'x', load_id: `${'c'.repeat(63)}${E}${'d'.repeat(50)}` }));
    has(m, `Startup load ${'c'.repeat(63)}${E}\u2026 is not on record`);
    assert.ok(!LONE_SURROGATE.test(m), `lone surrogate in: ${m}`);
    process.env.EMET_SOURCE_TAGS = 'host-a';
    try {
      m = refusalOf(await send(world({ session: { opened: true }, exchanges: 1 }), 'emet_transcript_append', { session_id: SID, ...msg, source: `${'s'.repeat(63)}${E}tail` }));
      has(m, `Source tag "${'s'.repeat(63)}${E}\u2026" is not registered`);
      assert.ok(!LONE_SURROGATE.test(m), `lone surrogate in: ${m}`);
    } finally { delete process.env.EMET_SOURCE_TAGS; }
  });
  test('an emoji exactly at the 24-character cut of a listed registered tag stays whole', async () => {
    process.env.EMET_SOURCE_TAGS = `${'h'.repeat(23)}${E}tail,host-b`;
    try {
      const m = refusalOf(await send(world({ session: { opened: true }, exchanges: 1 }), 'emet_transcript_append', { session_id: SID, ...msg, source: 'stranger' }));
      has(m, 'Source tag "stranger" is not registered');
      assert.ok(!m.includes('h'.repeat(23)), m);
      assert.ok(!LONE_SURROGATE.test(m), `lone surrogate in: ${m}`);
    } finally { delete process.env.EMET_SOURCE_TAGS; }
  });
});

testGroup('a closed session: the work belongs in the next session', () => {
  const closed = (minutes) => world({ session: { opened: true, closed: true, closed_at: minutesBefore(minutes) }, exchanges: 2 });
  test('a document write naming the closed session', async () => {
    const m = refusalOf(await send(closed(60), 'patch_doc', { doc_id: 'STATE.md', old_str: 'a', new_str: 'b', source: HOST, session_id: SID }));
    has(m, 'is closed and locked', 'belongs in the next session you open the usual way', 'do not open a session just for it');
  });
  test('an append after the closing window', async () => {
    const m = refusalOf(await send(closed(60), 'emet_transcript_append', { session_id: SID, ...msg }));
    has(m, 'closed and locked', 'window for its closing exchange has passed', 'belongs in the next session you open the usual way');
  });
  test('an append inside the window that is not the next exchange', async () => {
    const m = refusalOf(await send(closed(1), 'emet_transcript_append', { session_id: SID, exchange_index: 5, ...msg }));
    has(m, 'only exchange 3 could be saved as its closing exchange', 'belongs in the next session');
  });
  test('a whole-transcript save', async () => {
    const m = refusalOf(await send(closed(1), 'save_transcript', { session_id: SID, session_start: 1790000000, exchanges: [{ exchange_index: 1, user_message: 'u', assistant_message: 'a' }], source: HOST }));
    has(m, 'closed and locked', 'belongs in the next session');
  });
  test('a correction that adds an exchange: says which numbers it must carry', async () => {
    const ex = (n) => ({ exchange_index: n, user_message: 'u', assistant_message: 'a' });
    const m = refusalOf(await send(closed(60), 'revise_transcript', { session_id: SID, exchanges: [ex(1), ex(2), ex(3)], reason: 'fix', source: HOST }));
    has(m, 'must carry exactly those numbers', '(2: 1, 2)', 'exchange 3 is not in that part');
  });
  test('the closed state cannot be read: says to send the same call again', async () => {
    const w = closed(60);
    w.dbManager.ensureClient = async () => { throw new Error('store down'); };
    const m = refusalOf(await send(w, 'emet_transcript_append', { session_id: SID, ...msg }));
    has(m, 'Nothing was written', 'session graph unavailable');
  });
});

await summary('Refusal Pass Instruction Test Summary');
