/**
 * Startup page completion (2026-10-03). sessionOpen says which pages of the
 * startup a host never fetched; through dispatch the startup_pages gate
 * refuses such an open first. In memory, kept 60 minutes after a load's last
 * page (its own lifetime, not the 10-minute page cache). In-memory store, real
 * code (initialize, dispatchTool); no database.
 */
import { test, testGroup, summary } from './harness.js';
import assert from 'assert';
import { makeStore, withStore } from './memstore.js';
import { liveSizedStore } from './startup-fixture.js';

process.env.MONGODB_URI = 'mongodb://in-memory.test/emet';
for (const k of ['EMET_SOURCE_TAG', 'EMET_SOURCE_TAGS', 'EMET_TEMPLATE_MAP', 'EMET_GAP_BASELINE', 'EMET_RECORD_DOCS', 'CASCADE_RECORD_DOCS', 'EMET_CHARACTER_DOC', 'EMET_INSTALL_DOC', 'EMET_INIT_PAGE_BYTES'])
  delete process.env[k];

console.log('\n=== startup page completion (emet_session_open) ===');

const { initialize } = await import('../src/setup.js');
const { sessionOpen, startupPagesCheck, NO_LOAD_ID_NOTICE } = await import('../src/tools.js');
const { dispatchTool } = await import('../src/dispatch.js');
const pg = await import('../src/startup-pages.js');

const store = await liveSizedStore();
const page = (args) => withStore(store, () => initialize(args));
// The session store sessionOpen reads (closed ids), kept apart from the startup store.
const sessionsStore = makeStore();
const SESSIONS_DB = { async ensureClient() { return new sessionsStore.Client().db(); } };
const open = (args = {}, logger = null) => sessionOpen({ slug: 'pages', ...args }, logger, SESSIONS_DB);

testGroup('page completion at session open', () => {
  test('no load_id: the open says the pages were not checked - never silent, never another load', async () => {
    pg.clearPageCache();
    pg.notePageServed('eeee', 1, 3); // another host's load with pages missing: never used in its place
    const r = await open();
    assert.deepStrictEqual(r.startup_pages, { load_id: null, checked: false, reason: 'no load_id', notice: NO_LOAD_ID_NOTICE });
    assert.ok(r.instructions.startsWith(NO_LOAD_ID_NOTICE), r.instructions.slice(0, 200));
    assert.match(NO_LOAD_ID_NOTICE, /^Startup pages not checked: no load_id\. Pass load_id from your startup pages/);
  });
  test('only page 1 fetched: the missing pages are named, the session still opens, and it is logged', async () => {
    pg.clearPageCache();
    const p1 = await page({});
    const n = p1.startup_page.of;
    assert.ok(n >= 3, `live-sized startup has ${n} pages`);
    const warned = [];
    const r = await open({ load_id: p1.startup_page.load_id }, { info() {}, warn: (msg, meta) => warned.push({ msg, meta }) });
    assert.ok(r.session_id, 'the session opened');
    const sp = r.startup_pages;
    assert.strictEqual(sp.complete, false);
    assert.strictEqual(sp.load_id, p1.startup_page.load_id);
    assert.deepStrictEqual(sp.served, [1]);
    assert.deepStrictEqual(sp.missing, Array.from({ length: n - 1 }, (_, i) => i + 2));
    assert.ok(r.instructions.startsWith(sp.notice), r.instructions.slice(0, 200));
    assert.ok(/nothing was blocked/i.test(sp.notice) && sp.notice.includes(`"load_id": "${sp.load_id}"`), sp.notice);
    assert.strictEqual(warned.length, 1);
    assert.deepStrictEqual(warned[0].meta.missing, sp.missing);
  });
  test('every page fetched: complete, and the instructions carry no page notice', async () => {
    pg.clearPageCache();
    let p = await page({});
    while (p.startup_page.next) p = await page(JSON.parse(p.startup_page.next.replace(/^emet_initialize /, '')));
    const r = await open({ load_id: p.startup_page.load_id });
    assert.deepStrictEqual(r.startup_pages, { load_id: p.startup_page.load_id, checked: true, complete: true });
    assert.ok(!/Startup pages/.test(r.instructions));
  });
  test('page "all" counts as every page, under the load_id it returns', async () => {
    pg.clearPageCache();
    const whole = await page({ page: 'all' });
    assert.strictEqual((await open({ load_id: whole.startup_page.load_id })).startup_pages.complete, true);
  });
  test('a named load_id is checked; without one the open is flagged unchecked, never checked against the latest load', async () => {
    pg.clearPageCache();
    pg.notePageServed('aaaa', 1, 3); pg.notePageServed('aaaa', 3, 3);
    pg.notePageServed('bbbb', 1, 3);
    assert.deepStrictEqual((await open({ load_id: 'aaaa' })).startup_pages.missing, [2]);
    const r = await open();
    assert.strictEqual(r.startup_pages.checked, false, 'without load_id the latest load (bbbb, missing pages) is not used');
    assert.ok(!('missing' in r.startup_pages));
    assert.strictEqual(startupPagesCheck(null).reason, 'no load_id');
    assert.strictEqual(startupPagesCheck('  ').reason, 'no load_id');
    assert.strictEqual(pg.pageCompletion(), null, 'no named load, no record: the latest-load fallback is gone');
  });
  test('sessionOpen called directly with an unknown load_id says it cannot check (through dispatch the startup_pages gate refuses it first)', async () => {
    pg.clearPageCache();
    const r = await open({ load_id: 'feedfacefeedface' });
    assert.ok(r.session_id);
    assert.strictEqual(r.startup_pages.checked, false);
    assert.ok(/60 minutes/.test(r.startup_pages.reason));
  });
  test('a long bogus load_id is echoed back capped at 64 characters', async () => {
    pg.clearPageCache();
    const r = await open({ load_id: 'x'.repeat(5000) });
    assert.strictEqual(r.startup_pages.checked, false);
    assert.ok(r.startup_pages.load_id.length <= 65, `echoed ${r.startup_pages.load_id.length} chars`);
    assert.ok(r.startup_pages.load_id.startsWith('x'.repeat(64)));
  });
  test('an emoji exactly at the 64-character cut of a bogus load_id is echoed whole, never a lone surrogate', async () => {
    pg.clearPageCache();
    const r = await open({ load_id: `${'x'.repeat(63)}\u{1F600}${'y'.repeat(40)}` });
    assert.strictEqual(r.startup_pages.load_id, `${'x'.repeat(63)}\u{1F600}\u2026`);
    assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(r.startup_pages.load_id));
  });
  test('a logger that throws never fails the open', async () => {
    pg.clearPageCache();
    pg.notePageServed('dddd', 1, 3);
    const r = await open({ load_id: 'dddd' }, { info() {}, warn() { throw new Error('logger down'); } });
    assert.ok(r.session_id);
    assert.deepStrictEqual(r.startup_pages.missing, [2, 3]);
  });
  test('the record lasts 60 minutes after the last page (its own lifetime, not the 10-minute page cache), then nothing is said', () => {
    pg.clearPageCache();
    const t0 = Date.now();
    pg.notePageServed('cccc', 1, 4, t0);
    assert.strictEqual(pg.SERVED_MS, 60 * 60 * 1000);
    assert.deepStrictEqual(startupPagesCheck('cccc', null, null, t0 + 11 * 60 * 1000).missing, [2, 3, 4]);
    assert.deepStrictEqual(startupPagesCheck('cccc', null, null, t0 + 59 * 60 * 1000).missing, [2, 3, 4]);
    assert.strictEqual(startupPagesCheck('cccc', null, null, t0 + 61 * 60 * 1000).checked, false);
  });
  test('a failing completion check never blocks the open', async () => {
    pg.clearPageCache();
    const r = startupPagesCheck({ toString() { throw new Error('boom'); } });
    assert.strictEqual(r, null);
  });
  test('through dispatch: an open with pages missing is refused; with every page fetched it opens and returns startup_pages', async () => {
    pg.clearPageCache();
    const p1 = await page({});
    const ctx = { dbManager: SESSIONS_DB, logger: null };
    const refused = await withStore(store, () => dispatchTool('emet_session_open', { slug: 'pages', load_id: p1.startup_page.load_id }, ctx));
    assert.ok(refused.isError && refused.content[0].text.includes(`emet_initialize {\\"page\\": 2, \\"load_id\\": \\"${p1.startup_page.load_id}\\"}`), refused.content[0].text.slice(0, 400));
    let p = p1;
    while (p.startup_page.next) p = await page(JSON.parse(p.startup_page.next.replace(/^emet_initialize /, '')));
    const res = await withStore(store, () => dispatchTool('emet_session_open', { slug: 'pages', load_id: p1.startup_page.load_id }, ctx));
    assert.ok(!res.isError, res.content[0].text.slice(0, 300));
    const data = JSON.parse(res.content[0].text).data;
    assert.strictEqual(data.startup_pages.complete, true);
  });
});

await summary();
