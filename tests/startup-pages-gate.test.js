/**
 * The startup_pages gate (2026-10-03), enforce only. emet_session_open with no
 * load_id, or with pages of that load never fetched, is refused before
 * anything is written, the refusal names the exact calls that pass, and the
 * refusal is recorded in the lab. In-memory store, real code (initialize and
 * emet_session_open through dispatchTool); no database.
 */
import { test, testGroup, summary } from './harness.js';
import assert from 'assert';
import { withStore, makeStore } from './memstore.js';
import { liveSizedStore } from './startup-fixture.js';

process.env.MONGODB_URI = 'mongodb://in-memory.test/emet';
for (const k of ['EMET_SOURCE_TAG', 'EMET_SOURCE_TAGS', 'EMET_TEMPLATE_MAP', 'EMET_GAP_BASELINE', 'EMET_RECORD_DOCS', 'CASCADE_RECORD_DOCS', 'EMET_CHARACTER_DOC', 'EMET_INSTALL_DOC', 'EMET_INIT_PAGE_BYTES'])
  delete process.env[k];

console.log('\n=== startup_pages gate (emet_session_open) ===');

const { dispatchTool } = await import('../src/dispatch.js');
const pg = await import('../src/startup-pages.js');
const sg = await import('../src/session-graph.js');

const store = await liveSizedStore();
const graphStore = makeStore();
const dbManager = { async ensureClient() { return { collection: (n) => graphStore.collection(n) }; }, async transcriptPosition() { return { highest: 0 }; } };
const ctx = { dbManager, logger: { info() {}, warn() {}, error() {}, debug() {} } };
const call = (name, args) => withStore(store, () => dispatchTool(name, args, ctx));
const data = (res) => { assert.ok(!res.isError, res.content[0].text.slice(0, 400)); return JSON.parse(res.content[0].text).data; };
// labRecord and graphAfter are not awaited. Poll until the row is visible.
async function until(pred, label) {
  const deadline = Date.now() + 2000;
  for (;;) {
    if (pred()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setImmediate(r));
  }
}
async function untilSettled(read) {
  const deadline = Date.now() + 2000;
  let last = read();
  let stable = 0;
  for (;;) {
    await new Promise((r) => setImmediate(r));
    const now = read();
    if (now === last) stable += 1; else { stable = 0; last = now; }
    if (stable >= 8) return now;
    if (Date.now() > deadline) return read();
  }
}
const labRows = () => { for (const [n, c] of graphStore.cols) if (n.endsWith(sg.LAB_SUFFIX)) return c.docs; return []; };
const sessionRows = () => { for (const [n, c] of graphStore.cols) if (n.endsWith('sessions')) return c.docs; return []; };
// Sets EMET_SESSION_GRAPH, to show the value is no longer read.
async function withMode(mode, fn) {
  const saved = process.env.EMET_SESSION_GRAPH;
  process.env.EMET_SESSION_GRAPH = mode;
  try { return await fn(); } finally { if (saved === undefined) delete process.env.EMET_SESSION_GRAPH; else process.env.EMET_SESSION_GRAPH = saved; }
}
const allPages = async (p) => { while (p.startup_page.next) p = data(await call('emet_initialize', JSON.parse(p.startup_page.next.replace(/^emet_initialize /, '')))); return p; };
const reset = () => { pg.clearPageCache(); labRows().length = 0; sessionRows().length = 0; };

testGroup('a missing startup page refuses emet_session_open', () => {
  test('only page 1 fetched: refused, nothing opened or written, the refusal names each missing page\'s exact call, the lab records refuse', async () => {
    reset();
    const p1 = data(await call('emet_initialize', {}));
    const id = p1.startup_page.load_id; const n = p1.startup_page.of;
    const res = await call('emet_session_open', { slug: 'gate-enforce', load_id: id });
    assert.ok(res.isError, 'refused');
    const text = JSON.parse(res.content[0].text).error.message;
    assert.ok(text.includes(`Fetch startup pages 2-${n} of ${n}`), `the missing pages are not named as a range: ${text}`); assert.match(text, /no session was opened and nothing was written/);
    assert.ok(text.includes(`emet_initialize {"page": 2, "load_id": "${id}"}, then the same call for each page after it`), `page 2's exact call is not named: ${text}`);
    assert.ok(text.includes(`then call emet_session_open again with "load_id": "${id}"`), text);
    assert.ok(!text.endsWith('\u2026'), 'the refusal was cut by the error-message cap');
    await until(() => labRows().some((x) => x.gate === 'startup_pages'), 'startup refusal recorded');
    assert.strictEqual(sessionRows().length, 0, 'no session state was written');
    const row = labRows().find((x) => x.gate === 'startup_pages');
    assert.strictEqual(row.verdict, 'refuse'); assert.strictEqual(row.mode, 'enforce');
    assert.deepStrictEqual(row.startup_pages.missing, Array.from({ length: n - 1 }, (_, i) => i + 2));
  });
  test('one page missing: the refusal names that one page and its call', () => {
    const d = sg.startupPagesDecision({ load_id: 'L1', of: 4, missing: [3] });
    assert.ok(d.reason.startsWith('Fetch startup page 3 of 4 (load L1): emet_initialize {"page": 3, "load_id": "L1"}; then call emet_session_open again with "load_id": "L1". That page was never fetched'), d.reason);
  });
  for (const of of [9, 21, 41]) {
    test(`${of - 1} pages missing of ${of}: the call comes first, the pages are named once as a range, and it fits the 500-character error cap`, () => {
      const d = sg.startupPagesDecision({ load_id: '1c9b607a5f846a98', of, missing: Array.from({ length: of - 1 }, (_, i) => i + 2) });
      const wire = `Validation failed for 'session_graph': ${d.reason}`;
      assert.ok(wire.length <= 500, `${wire.length}: ${wire}`);
      assert.ok(d.reason.startsWith(`Fetch startup pages 2-${of} of ${of} (load 1c9b607a5f846a98): emet_initialize {"page": 2, "load_id": "1c9b607a5f846a98"}, then the same call for each page after it`), d.reason);
      assert.ok(d.reason.includes('then call emet_session_open again with "load_id": "1c9b607a5f846a98"'), d.reason);
      assert.strictEqual(d.reason.split(`2-${of}`).length, 2, d.reason);
    });
  }
  test('page ranges: runs collapse, singles stay', () => {
    assert.strictEqual(sg.pageRanges([2, 3, 4, 7, 9, 10]), '2-4, 7, 9-10');
    assert.strictEqual(sg.pageRanges([5]), '5');
  });
  test('after fetching the missing pages the same open succeeds', async () => {
    reset();
    const p1 = data(await call('emet_initialize', {}));
    assert.ok((await call('emet_session_open', { slug: 'gate-retry', load_id: p1.startup_page.load_id })).isError);
    await allPages(p1);
    const r = data(await call('emet_session_open', { slug: 'gate-retry', load_id: p1.startup_page.load_id }));
    assert.ok(r.session_id); assert.strictEqual(r.startup_pages.complete, true);
    assert.strictEqual(r.session_graph.verdict, 'ok');
  });
  test('every page fetched: no gate row, the open is clean, the open is recorded', async () => {
    reset();
    const p = await allPages(data(await call('emet_initialize', {})));
    const r = data(await call('emet_session_open', { slug: 'gate-clean', load_id: p.startup_page.load_id }));
    assert.strictEqual(r.startup_pages.complete, true);
    await until(() => sessionRows().some((x) => x._id === r.base && x.opened), 'clean open recorded');
    await untilSettled(() => labRows().length);
    assert.ok(!labRows().some((x) => x.gate === 'startup_pages'));
    assert.ok(sessionRows().some((x) => x._id === r.base && x.opened), 'the open was recorded');
  });
  test('a named load_id the server has no record of is refused: fetch the startup again, nothing opened or written, the lab records refuse', async () => {
    reset();
    const res = await call('emet_session_open', { slug: 'gate-unknown', load_id: 'feedfacefeedface' });
    assert.ok(res.isError, 'refused');
    const text = JSON.parse(res.content[0].text).error.message;
    assert.ok(text.includes('Call emet_initialize {} and fetch every page, then call emet_session_open again with the load_id it returns'), text);
    await until(() => labRows().some((x) => x.gate === 'startup_pages'), 'unknown load recorded');
    assert.strictEqual(sessionRows().length, 0, 'no session state was written');
    const row = labRows().find((x) => x.gate === 'startup_pages');
    assert.strictEqual(row.verdict, 'refuse');
    assert.deepStrictEqual(row.startup_pages, { checked: false, load_id: 'feedfacefeedface', reason: 'no record of that load' });
  });
  test('up to SERVED_MAX startups in all, a host\'s own load stays on record and opens; one more evicts it, refused with the way back', async () => {
    assert.strictEqual(pg.SERVED_MAX, 2000);
    reset();
    const p = await allPages(data(await call('emet_initialize', {})));
    const id = p.startup_page.load_id;
    for (let i = 0; i < pg.SERVED_MAX - 1; i++) pg.notePageServed(`other-host-${i}`, 'all');
    assert.strictEqual(pg.pageCompletion(id).complete, true, 'the 2000th load in the record is still the host\'s own');
    pg.notePageServed('other-host-last', 'all');
    assert.strictEqual(pg.pageCompletion(id), null, 'the 2001st load evicts the least recently served');
    const res = await call('emet_session_open', { slug: 'gate-crowd', load_id: id });
    assert.ok(res.isError && JSON.parse(res.content[0].text).error.message.includes('Call emet_initialize {} and fetch every page'), res.content[0].text.slice(0, 300));
    reset();
    const q = await allPages(data(await call('emet_initialize', {})));
    for (let i = 0; i < 100; i++) pg.notePageServed(`other-host-${i}`, 'all');
    const r = data(await call('emet_session_open', { slug: 'gate-crowd', load_id: q.startup_page.load_id }));
    assert.ok(r.session_id); assert.strictEqual(r.startup_pages.complete, true);
  });
  test('an open 30 minutes after the last page passes; 61 minutes after, refused with the re-init instruction', async () => {
    reset();
    const MIN = 60 * 1000;
    pg.notePageServed('aaaa0030aaaa0030', 'all', undefined, Date.now() - 30 * MIN);
    const r = data(await call('emet_session_open', { slug: 'gate-thirty', load_id: 'aaaa0030aaaa0030' }));
    assert.ok(r.session_id); assert.deepStrictEqual(r.startup_pages, { load_id: 'aaaa0030aaaa0030', checked: true, complete: true });
    pg.notePageServed('aaaa0061aaaa0061', 'all', undefined, Date.now() - 61 * MIN);
    const res = await call('emet_session_open', { slug: 'gate-sixty-one', load_id: 'aaaa0061aaaa0061' });
    assert.ok(res.isError, 'refused');
    const text = JSON.parse(res.content[0].text).error.message;
    assert.ok(text.startsWith("Validation failed for 'session_graph': Call emet_initialize {} and fetch every page, then call emet_session_open again with the load_id it returns."), text);
    assert.ok(text.includes('expired after 60 minutes without a page'), text);
  });
  test('a restart (the record cleared) refuses the old load_id; a fresh startup opens', async () => {
    reset();
    const p = await allPages(data(await call('emet_initialize', {})));
    pg.clearPageCache();
    assert.ok((await call('emet_session_open', { slug: 'gate-restart', load_id: p.startup_page.load_id })).isError);
    const q = await allPages(data(await call('emet_initialize', {})));
    const r = data(await call('emet_session_open', { slug: 'gate-restart', load_id: q.startup_page.load_id }));
    assert.ok(r.session_id); assert.strictEqual(r.startup_pages.complete, true);
  });
  test('EMET_SESSION_GRAPH=off or report does not switch the gate off', () => withMode('off', async () => {
    reset();
    const p1 = data(await call('emet_initialize', {}));
    assert.ok((await call('emet_session_open', { slug: 'gate-off', load_id: p1.startup_page.load_id })).isError);
    await withMode('report', async () => assert.ok((await call('emet_session_open', { slug: 'gate-report', load_id: p1.startup_page.load_id })).isError));
    await assert.rejects(() => sg.startupPagesGate({ load_id: p1.startup_page.load_id }), /never fetched/);
  }));
});

testGroup('late pages: a refused open records none; older rows still pair in the summary', () => {
  test('pages fetched after a refused open add no late row (the open never happened)', async () => {
    reset();
    const p1 = data(await call('emet_initialize', {}));
    assert.ok((await call('emet_session_open', { slug: 'gate-late', load_id: p1.startup_page.load_id })).isError);
    data(await call('emet_initialize', { page: 2, load_id: p1.startup_page.load_id }));
    await until(() => labRows().some((x) => x.verdict === 'refuse'), 'refused open recorded');
    await untilSettled(() => labRows().filter((x) => x.verdict === 'late').length);
    assert.strictEqual(labRows().filter((x) => x.verdict === 'late').length, 0);
  });
  test('rows from before enforce-only: a would_refuse open whose pages all came late is settled; one still missing stays flagged', () => {
    const t = new Date('2026-10-03T13:00:00Z');
    const open = (sess, missing) => sg.labRow('emet_session_open', { slug: 'x' }, { mode: 'report', base: sess, decision: { verdict: 'refuse', gate: 'startup_pages', reason: 'r', next: 'n' }, startup_pages: { load_id: 'L', of: 3, missing } }, t);
    const late = (sess, page) => sg.labRow('emet_initialize', {}, { mode: 'report', base: sess, decision: { verdict: 'late', gate: 'startup_pages', reason: 'r', next: null }, startup_pages: { load_id: 'L', of: 3, page, late: true } }, t);
    const rows = [{ ...open('a', [2, 3]), verdict: 'would_refuse' }, late('a', 2), late('a', 3), { ...open('b', [2, 3]), verdict: 'would_refuse' }, late('b', 2)];
    const s = sg.labSummary(rows);
    assert.strictEqual(s.flagged, 1);
    assert.strictEqual(s.startup_pages.pages_still_missing, 1);
    assert.strictEqual(s.startup_pages.pages_late, 3);
  });
  test('an enforced refusal stays flagged: a refused open is not settled by later pages', () => {
    const t = new Date('2026-10-03T13:00:00Z');
    const refused = sg.labRow('emet_session_open', { slug: 'x' }, { mode: 'enforce', base: 'b', decision: { verdict: 'refuse', gate: 'startup_pages', reason: 'r', next: 'n' }, startup_pages: { load_id: 'L', of: 3, missing: [2] } }, t);
    const late = sg.labRow('emet_initialize', {}, { mode: 'enforce', base: 'b', decision: { verdict: 'late', gate: 'startup_pages', reason: 'r', next: null }, startup_pages: { load_id: 'L', of: 3, page: 2, late: true } }, t);
    const s = sg.labSummary([refused, late]);
    assert.strictEqual(s.flagged, 1); assert.strictEqual(s.startup_pages.opens_refused, 1);
  });
});

testGroup('an open must name its startup: no load_id is refused, never checked against another load', () => {
  // Host B fetched every page of its load; then host A fetched only page 1 of a newer load.
  const twoHosts = () => {
    pg.clearPageCache();
    for (let k = 1; k <= 5; k++) pg.notePageServed('b0b0b0b0b0b0b0b0', k, 5);
    pg.notePageServed('a1a1a1a1a1a1a1a1', 1, 5);
  };
  test('an open with no load_id is refused before any write, saying to pass load_id from the startup pages; the refusal is recorded', async () => {
    reset(); twoHosts();
    const res = await call('emet_session_open', { slug: 'host-b-enforce' });
    assert.ok(res.isError, 'refused');
    const text = res.content[0].text;
    assert.match(text, /emet_session_open needs load_id/); assert.match(text, /no session was opened and nothing was written/);
    assert.match(text, /Call emet_session_open again with \\"load_id\\" set to startup_page.load_id from your emet_initialize pages/);
    assert.ok(!text.includes('a1a1a1a1a1a1a1a1'), 'never names another host\'s load');
    await until(() => labRows().some((x) => x.gate === 'startup_pages' && x.startup_pages && x.startup_pages.reason === 'no load_id'), 'missing load_id recorded');
    assert.strictEqual(sessionRows().length, 0, 'no session state was written');
    const row = labRows().find((x) => x.gate === 'startup_pages');
    assert.strictEqual(row.verdict, 'refuse'); assert.strictEqual(row.mode, 'enforce');
    assert.deepStrictEqual(row.startup_pages, { checked: false, load_id: null, reason: 'no load_id' });
    assert.strictEqual(row.reason, sg.NO_LOAD_ID_REASON);
    const s = sg.labSummary(labRows());
    assert.strictEqual(s.startup_pages.opens_refused_no_load_id, 1);
  });
  test('with load_id: the same host passing its own load_id is checked as before', async () => {
    reset(); twoHosts();
    const ok = data(await call('emet_session_open', { slug: 'host-b-own', load_id: 'b0b0b0b0b0b0b0b0' }));
    assert.strictEqual(ok.startup_pages.complete, true);
    assert.ok((await call('emet_session_open', { slug: 'host-a-own', load_id: 'a1a1a1a1a1a1a1a1' })).isError);
  });
  test('the gate itself: no load_id (or a blank one) refuses, whatever EMET_SESSION_GRAPH says, and never reads the latest load', async () => {
    twoHosts();
    await assert.rejects(() => sg.startupPagesGate({}), (e) => /needs load_id/.test(e.message) && e.graph.startup_pages.checked === false && !e.message.includes('a1a1'));
    await assert.rejects(() => sg.startupPagesGate({ load_id: '  ' }), /needs load_id/);
    await withMode('off', () => assert.rejects(() => sg.startupPagesGate({ slug: 'x' }), /needs load_id/));
    await withMode('report', () => assert.rejects(() => sg.startupPagesGate({ slug: 'x' }), /needs load_id/));
  });
});

await summary();
