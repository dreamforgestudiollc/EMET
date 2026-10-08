/**
 * Every startup carries a load_id, so every host can open a session
 * (2026-10-03). A paged startup carried one already; this suite covers the
 * startups served whole: page "all", a startup that fits one result, and a
 * store that is not set up yet - each returns `startup_page.load_id`, recorded
 * with every page fetched, and a notice to pass it to emet_session_open. A
 * made-up load_id is refused: the server has no record of it, so its pages
 * cannot be checked, and the refusal says to fetch the startup again.
 * In-memory store, real code through dispatchTool; no database.
 */
import { test, testGroup, summary } from './harness.js';
import assert from 'assert';
import { makeStore, withStore } from './memstore.js';
import { liveSizedStore, payloadOf } from './startup-fixture.js';

process.env.MONGODB_URI = 'mongodb://in-memory.test/emet';
for (const k of ['EMET_SOURCE_TAG', 'EMET_SOURCE_TAGS', 'EMET_TEMPLATE_MAP', 'EMET_GAP_BASELINE', 'EMET_RECORD_DOCS', 'CASCADE_RECORD_DOCS',
  'EMET_CHARACTER_DOC', 'EMET_INSTALL_DOC', 'EMET_INIT_PAGE_BYTES', 'EMET_SESSION_GRAPH'])
  delete process.env[k];

console.log('\n=== every startup carries a load_id ===');

const { dispatchTool } = await import('../src/dispatch.js');
const pg = await import('../src/startup-pages.js');
const sg = await import('../src/session-graph.js');

function managerFor(store) {
  return {
    async ensureClient() { return new store.Client().db(); },
    async transcriptPosition(sid) {
      const base = String(sid).replace(/_verbatim_part\d+$/, '');
      const live = store.collection('transcripts').docs.filter((d) => (d.session_id === base || String(d.session_id).startsWith(`${base}_`)) && !d.superseded_by);
      const highest = live.reduce((m, d) => Math.max(m, ...(d.exchanges || []).map((e) => Number(e.exchange_index))), 0);
      return { base, present: live.length > 0, highest, last_part: live.length ? live[live.length - 1].session_id : null };
    }
  };
}
const call = (store, tool, args) => withStore(store, () => dispatchTool(tool, args, { dbManager: managerFor(store), logger: null }));
const dataOf = (r) => { assert.ok(!r.isError, r.content[0].text.slice(0, 400)); return JSON.parse(r.content[0].text).data; };
const errorOf = (r) => { assert.ok(r.isError, r.content[0].text.slice(0, 300)); return JSON.parse(r.content[0].text).error.message; };

testGroup('page "all": the whole startup in one result opens with its load_id', () => {
  test('page "all" returns startup_page.load_id and a notice to pass it; emet_session_open with it succeeds, checked complete', async () => {
    pg.clearPageCache();
    const store = await liveSizedStore();
    const whole = dataOf(await call(store, 'emet_initialize', { page: 'all' }));
    assert.strictEqual(whole.state, 'ready');
    payloadOf(whole, 'all');
    const id = whole.startup_page.load_id;
    assert.ok(whole.page_notice.includes(`Pass "load_id": "${id}" to emet_session_open`), whole.page_notice);
    const opened = dataOf(await call(store, 'emet_session_open', { slug: 'host-page-all', load_id: id }));
    assert.ok(opened.session_id);
    assert.deepStrictEqual(opened.startup_pages, { load_id: id, checked: true, complete: true });
  });
  test('the load_id is the one page 1 of the same startup carries', async () => {
    pg.clearPageCache();
    const store = await liveSizedStore();
    const whole = dataOf(await call(store, 'emet_initialize', { page: 'all' }));
    const p1 = dataOf(await call(store, 'emet_initialize', {}));
    assert.strictEqual(whole.startup_page.load_id, p1.startup_page.load_id);
  });
});

testGroup('the startup itself says to open with its load_id', () => {
  test('instructions_short and tools_in_force name the load_id; every page of the live-sized startup, as received, stays within the 18,000-byte page budget', async () => {
    pg.clearPageCache();
    const store = await liveSizedStore();
    const r1 = await call(store, 'emet_initialize', {});
    const p1 = dataOf(r1);
    assert.match(p1.instructions_short, /After every startup page, call emet_session_open with its load_id/);
    assert.ok(p1.tools_in_force.during_session.includes("emet_session_open with the startup's load_id, after every startup page"), JSON.stringify(p1.tools_in_force));
    const sizes = [Buffer.byteLength(r1.content[0].text)];
    for (let k = 2; k <= p1.startup_page.of; k++) {
      sizes.push(Buffer.byteLength((await call(store, 'emet_initialize', { page: k, load_id: p1.startup_page.load_id })).content[0].text));
    }
    console.log(`    pages as received: ${sizes.join(', ')} bytes`);
    assert.strictEqual(pg.pageBudget(), 18000);
    for (const b of sizes) assert.ok(b <= pg.pageBudget(), `a page of ${b} bytes`);
  });
});

testGroup('a startup that fits one result opens with its load_id', () => {
  // A ready startup never fits one page today (the shipped floor, charter and
  // instructions alone come to about 29.8K on a fresh store), so the first test
  // drives initialize's one-page branch end to end through dispatch with a
  // test seam that swaps only the payload builder; the second drives the same
  // two steps directly: wholeStartup, then the load recorded as fully fetched.
  test('end to end through dispatch: emet_initialize returns the one page whole with its load_id and notice; emet_session_open with it succeeds', async () => {
    const setup = await import('../src/setup.js');
    pg.clearPageCache();
    const tiny = { state: 'ready', database: 'x', emet_line: 'Truth stands. Memory connected.', floor: { a: 'b' } };
    let builds = 0;
    setup.setStartupBuildForTests(async () => { builds++; return { ...tiny }; });
    try {
      assert.strictEqual(pg.pageBudget('1'), pg.MIN_PAGE_BYTES, 'the EMET_INIT_PAGE_BYTES clamp is unchanged');
      assert.strictEqual(pg.pageBudget('999999'), pg.MAX_PAGE_BYTES);
      const store = makeStore();
      const r = dataOf(await call(store, 'emet_initialize', {}));
      assert.strictEqual(builds, 1, 'initialize built the startup through the seam');
      assert.deepStrictEqual(Object.keys(r).slice(0, 2), ['startup_page', 'page_notice']);
      const id = r.startup_page.load_id;
      assert.deepStrictEqual(r.startup_page, { index: 1, of: 1, load_id: id, next: null });
      assert.strictEqual(id, pg.loadIdOf(tiny), 'the load_id is the payload\'s own');
      assert.ok(r.page_notice.includes(`Pass "load_id": "${id}" to emet_session_open`), r.page_notice);
      assert.strictEqual(JSON.stringify(payloadOf(r, 1)), JSON.stringify(tiny), 'the payload follows unchanged');
      assert.strictEqual(pg.pageCompletion(id).complete, true, 'recorded with every page fetched');
      const opened = dataOf(await call(store, 'emet_session_open', { slug: 'host-one-page-e2e', load_id: id }));
      assert.ok(opened.session_id);
      assert.deepStrictEqual(opened.startup_pages, { load_id: id, checked: true, complete: true });
      assert.strictEqual(opened.session_graph.verdict, 'ok');
    } finally { setup.setStartupBuildForTests(null); }
  });
  test('one page: returned whole with startup_page.load_id; emet_session_open with it succeeds, checked complete', async () => {
    pg.clearPageCache();
    const tiny = { state: 'ready', database: 'x', emet_line: 'Truth stands. Memory connected.', floor: { a: 'b' } };
    assert.strictEqual(pg.paginate(tiny).pages.length, 1);
    const whole = pg.wholeStartup(tiny, 1);
    pg.notePageServed(whole.startup_page.load_id, 'all');
    assert.strictEqual(JSON.stringify(payloadOf(whole, 1)), JSON.stringify(tiny));
    const store = makeStore();
    const opened = dataOf(await call(store, 'emet_session_open', { slug: 'host-one-page', load_id: whole.startup_page.load_id }));
    assert.deepStrictEqual(opened.startup_pages, { load_id: whole.startup_page.load_id, checked: true, complete: true });
  });
});

testGroup('a store that is not set up yet: load_id returned, and the setup flow opens, records and closes a session', () => {
  test('setup_required returns startup_page.load_id; open with it, append, emet_setup_complete (sessionless by design), close', async () => {
    pg.clearPageCache();
    const store = makeStore();
    const first = dataOf(await call(store, 'emet_initialize', {}));
    assert.strictEqual(first.state, 'setup_required');
    payloadOf(first, 1);
    const id = first.startup_page.load_id;
    assert.ok(first.page_notice.includes(`Pass "load_id": "${id}" to emet_session_open`));
    const opened = dataOf(await call(store, 'emet_session_open', { slug: 'first-setup', load_id: id }));
    assert.deepStrictEqual(opened.startup_pages, { load_id: id, checked: true, complete: true });
    const sid = opened.session_id;
    const a1 = dataOf(await call(store, 'emet_transcript_append', { session_id: sid, user_message: 'initialize', assistant_message: 'no local shell MCP. Let us set up your memory.', source: 'example-host' }));
    assert.strictEqual(a1.exchange_index, 1);
    // emet_setup_complete is not a governed write: the interview's answers are
    // recorded with or without a session, so a host mid-setup is never refused.
    assert.ok(!sg.GRAPH_WRITE_TOOLS.has('emet_setup_complete'));
    const done = dataOf(await call(store, 'emet_setup_complete', { answers: { assistant_name: 'Ada', assistant_character: 'Plain and careful.', user_name: 'Sam Example', user_context: 'Testing a new store.' }, source: 'example-host' }));
    assert.strictEqual(done.ok, true);
    const a2 = dataOf(await call(store, 'emet_transcript_append', { session_id: sid, user_message: 'thanks', assistant_message: 'Set up.', source: 'example-host' }));
    assert.strictEqual(a2.exchange_index, 2);
    // The close is answered by the close check (a first session has no board or
    // handoff yet, so it is not complete); the session graph does not refuse it.
    const c = dataOf(await call(store, 'emet_session_close', { session_id: sid, session_start: Math.floor(Date.now() / 1000) - 60, receipts: {} }));
    assert.strictEqual(c.session_graph.verdict, 'ok', JSON.stringify(c.session_graph));
    assert.strictEqual(c.state, 'incomplete', 'a first session with no board or handoff yet closes incomplete, as any session would');
    // After setup the store is ready: the next startup is paged, with its own load_id.
    const ready = dataOf(await call(store, 'emet_initialize', {}));
    assert.strictEqual(ready.state, 'ready');
    assert.ok(ready.startup_page.load_id && ready.startup_page.load_id !== id);
  });
  test('an unreachable store returns a load_id too; the open is still refused, because the session store cannot be read, and says to call again', async () => {
    pg.clearPageCache();
    const store = makeStore();
    store.Client = class { constructor() {} async connect() { throw new Error('connection refused'); } db() { throw new Error('no db'); } async close() {} };
    const r = dataOf(await call(store, 'emet_initialize', {}));
    assert.strictEqual(r.state, 'unreachable');
    payloadOf(r, 1);
    const m = errorOf(await call(store, 'emet_session_open', { slug: 'down', load_id: r.startup_page.load_id }));
    assert.ok(/no session was opened/.test(m) && /Call emet_session_open again/.test(m), m);
  });
});

testGroup('a made-up load_id: refused, with the way back', () => {
  test('a load_id the server has no record of is refused; emet_initialize {} then gives one that opens', async () => {
    pg.clearPageCache();
    const store = makeStore();
    const m = errorOf(await call(store, 'emet_session_open', { slug: 'made-up', load_id: 'not-a-real-load' }));
    assert.ok(m.includes('Call emet_initialize {} and fetch every page, then call emet_session_open again with the load_id it returns'), m);
    assert.strictEqual(store.collection('emet_sessions').docs.length, 0, 'nothing opened');
    const first = dataOf(await call(store, 'emet_initialize', {}));
    const opened = dataOf(await call(store, 'emet_session_open', { slug: 'made-up', load_id: first.startup_page.load_id }));
    assert.ok(opened.session_id);
  });
});

await summary('Startup load_id Test Summary');
