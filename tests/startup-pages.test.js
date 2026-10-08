/**
 * Paged startup (the owner approved paging 2026-10-03).
 * The connector gateway cuts a result at 20,000 bytes; the startup is ~64K.
 *
 *   Z   sizes: every page, envelope included, within the page budget (18,000
 *       by default, 2,000 under the cut); the budget setting is clamped
 *   O   order: binding first, fixed order, never by size; page 1 has the floor,
 *       close protocol, tools in force and short instructions, and source tags
 *       and seeds_due before identity; page 1 carries the plan
 *   C   completeness: every payload key on exactly one page (or in consecutive
 *       chunks); the pages join back to the one-result payload byte for byte,
 *       including a store whose documents are too big for one page
 *   N   notices: every page but the last says to call again with the next page
 *       before replying, and names what binding text is still to come
 *   L   one load: later pages come from page 1's build (load_id); a page asked
 *       for after the startup changed says to start over
 *   B   backward compatibility: page "all" is the old one-result payload led
 *       by its load_id (startup_page, page_notice); a startup that fits one
 *       page is returned whole the same way; setup_required is not paged and
 *       carries its load_id; recent_limit behaves as before
 * In-memory store, real code (initialize, dispatchTool); no database.
 */
import { test, testGroup, summary } from './harness.js';
import assert from 'assert';
import { makeStore, withStore, withEnv } from './memstore.js';
import { liveSizedStore, prose, payloadOf } from './startup-fixture.js';

process.env.MONGODB_URI = 'mongodb://in-memory.test/emet';
for (const k of ['EMET_SOURCE_TAG', 'EMET_SOURCE_TAGS', 'EMET_TEMPLATE_MAP', 'EMET_GAP_BASELINE', 'EMET_RECORD_DOCS', 'CASCADE_RECORD_DOCS', 'EMET_CHARACTER_DOC', 'EMET_INSTALL_DOC', 'EMET_INIT_PAGE_BYTES'])
  delete process.env[k];

console.log('\n=== startup-pages (paged emet_initialize) ===');

const { initialize, setupComplete } = await import('../src/setup.js');
const { dispatchTool } = await import('../src/dispatch.js');
const sp = await import('../src/startup-payload.js');
const pg = await import('../src/startup-pages.js');
const J = (v) => JSON.stringify(v);
const CUT = 20000;

const store = await liveSizedStore();
const full = payloadOf(await withStore(store, () => initialize({ page: 'all' })));

/** Fetch a whole load the way a host does: no page, then each `next`, through dispatch. */
async function fetchAll(s, first = {}) {
  const call = async (args) => {
    const res = await withStore(s, () => dispatchTool('emet_initialize', args, { dbManager: null, logger: null }));
    const text = res.content[0].text;
    return { data: JSON.parse(text).data, bytes: Buffer.byteLength(text, 'utf8') };
  };
  const out = [await call(first)];
  while (out[out.length - 1].data.startup_page && out[out.length - 1].data.startup_page.next) {
    out.push(await call(JSON.parse(out[out.length - 1].data.startup_page.next.replace(/^emet_initialize /, ''))));
  }
  return out;
}
const fetched = await fetchAll(store);
const pages = fetched.map((f) => f.data);
const payloadKeys = (p) => Object.keys(p).filter((k) => !pg.PAGE_FIELDS.includes(k));

testGroup('Z: sizes', () => {
  test('the live-sized startup comes in several pages, each within 18,000 bytes as the host receives it', () => {
    console.log(`    full ${sp.resultSize(full).bytes} bytes -> ${pages.length} pages: ${fetched.map((f) => f.bytes).join(', ')} bytes`);
    assert.ok(pages.length >= 4 && pages.length <= 6, `${pages.length} pages`);
    for (const f of fetched) { assert.ok(f.bytes <= 18000, `${f.bytes}`); assert.ok(f.bytes <= CUT - 2000); }
  });
  test('the page budget setting is clamped to 12,000-19,000; nonsense means 18,000', () => {
    assert.strictEqual(pg.pageBudget(undefined), 18000);
    assert.strictEqual(pg.pageBudget('nonsense'), 18000);
    assert.strictEqual(pg.pageBudget('50000'), 19000);
    assert.strictEqual(pg.pageBudget('4000'), 12000);
    assert.strictEqual(pg.pageBudget('15000'), 15000);
  });
  test('a smaller budget gives more pages, each within it, still joining back exactly', () => {
    const { pages: small, sizes } = pg.paginate(full, { budget: 12000 });
    assert.ok(small.length > pages.length);
    for (const sz of sizes) assert.ok(sz <= 12000, `${sz}`);
    assert.strictEqual(J(pg.assemblePages(small)), J(full));
  });
  test('EMET_INIT_PAGE_BYTES reaches the server', async () => {
    await withEnv({ EMET_INIT_PAGE_BYTES: '14000' }, async () => {
      const got = await fetchAll(store);
      for (const f of got) assert.ok(f.bytes <= 14000, `${f.bytes}`);
      assert.strictEqual(J(pg.assemblePages(got.map((f) => f.data))), J(full));
    });
  });
});

testGroup('O: order - binding first, page 1 carries the plan', () => {
  const p1 = pages[0];
  test('page 1 has the floor (with precedence and reassertion), the close protocol, tools in force and the short instructions', () => {
    for (const k of ['emet_line', 'tools_in_force', 'instructions_short', 'session_close_protocol', 'operating_discipline', 'charter', 'floor', 'floor_precedence', 'floor_reassertion', 'seeds_due'])
      assert.strictEqual(J(p1[k]), J(full[k]), k);
  });
  test('identity, character and user are on the next page, together, whole', () => {
    for (const k of ['identity', 'character', 'user']) assert.strictEqual(pages[1][k], full[k], k);
  });
  test('keys run in the fixed order across pages (source tags and seeds_due before identity; indexes last)', () => {
    const seen = pages.flatMap(payloadKeys);
    const want = pg.PAGE_ORDER.filter((k) => k in full);
    assert.deepStrictEqual(seen, want);
    assert.ok(seen.indexOf('seeds_due') < seen.indexOf('identity'));
    assert.ok(seen.indexOf('floor') < seen.indexOf('identity'));
  });
  test('page 1 carries the plan: every page, its keys, and which binding keys it holds; every binding key is planned once', () => {
    assert.strictEqual(p1.page_plan.length, pages.length);
    p1.page_plan.forEach((pl, i) => assert.deepStrictEqual(pl.keys, pages[i].startup_page.keys));
    const planned = p1.page_plan.flatMap((pl) => pl.binding || []);
    assert.deepStrictEqual([...planned].sort(), pg.BINDING_KEYS.filter((k) => k in full).sort());
    for (const p of pages.slice(1)) assert.ok(!('page_plan' in p));
  });
  test('startup_page and page_notice lead every page', () => {
    for (const p of pages) assert.deepStrictEqual(Object.keys(p).slice(0, 2), ['startup_page', 'page_notice']);
  });
});

testGroup('C: completeness - the pages join back byte for byte', () => {
  test('every payload key is on exactly one page', () => {
    const seen = pages.flatMap(payloadKeys);
    assert.strictEqual(new Set(seen).size, seen.length);
    assert.deepStrictEqual([...seen].sort(), Object.keys(full).sort());
  });
  test('joined back, the pages are the one-result payload, byte for byte', () => {
    assert.strictEqual(J(pg.assemblePages(pages)), J(full));
    assert.deepStrictEqual(pages[pages.length - 1].startup_page.payload_order, Object.keys(full));
  });
  test('no payload key collides with a page field', () => {
    for (const k of pg.PAGE_FIELDS) assert.ok(!(k in full), k);
  });
  test('documents too big for one page are split in consecutive chunks and join back exactly (text and JSON values, multi-byte)', async () => {
    const s = await liveSizedStore();
    const docs = s.collection('documents').docs;
    const big = (n) => Array.from({ length: n }, (_, i) => (i % 7 === 0 ? 'é' : i % 11 === 0 ? '漢' : i % 97 === 0 ? '🙂' : 'a')).join('');
    docs.find((d) => d.doc_id === 'bootstrap/SOUL.md').content = big(30000); // character is never clipped
    docs.find((d) => d.doc_id === 'bootstrap/INSTALL.md').content = '漢'.repeat(15000); // 45,000 bytes inside an object
    const bigFull = payloadOf(await withStore(s, () => initialize({ page: 'all' })));
    const got = await fetchAll(s);
    for (const f of got) assert.ok(f.bytes <= 18000, `${f.bytes}`);
    const chunked = got.map((f) => f.data.startup_page.chunks || {});
    assert.ok(chunked.some((c) => c.character) && chunked.some((c) => c.install_notes && c.install_notes.json_text));
    assert.strictEqual(J(pg.assemblePages(got.map((f) => f.data))), J(bigFull));
    // the floor still leads: page 1 unchanged in what it carries
    assert.strictEqual(J(got[0].data.floor), J(full.floor));
  });
});

testGroup('N: notices', () => {
  test('every page but the last says not to reply yet and names the exact next call', () => {
    pages.slice(0, -1).forEach((p, i) => {
      assert.match(p.page_notice, new RegExp(`^Startup page ${i + 1} of ${pages.length}\\. Do not reply to the user yet\\. Call emet_initialize \\{"page":${i + 2},"load_id":"${p.startup_page.load_id}"\\} now`));
      assert.strictEqual(p.startup_page.next, `emet_initialize {"page":${i + 2},"load_id":"${p.startup_page.load_id}"}`);
      assert.strictEqual(p.startup_page.index, i + 1);
      assert.strictEqual(p.startup_page.of, pages.length);
    });
  });
  test('page 1 and every next-call notice say to fetch all N pages before emet_session_open', () => {
    const line = `Fetch all ${pages.length} pages before emet_session_open; an open with any page not fetched is refused.`;
    assert.strictEqual(pg.fetchAllLine(pages.length), line);
    for (const p of pages.slice(0, -1)) assert.ok(p.page_notice.includes(line), p.page_notice);
    assert.ok(pages[0].page_notice.includes(line));
  });
  test('the fetch-all line did not move binding text: identity, character and user stay together on page 2', () => {
    assert.deepStrictEqual(['identity', 'character', 'user'].filter((k) => k in pages[1]), ['identity', 'character', 'user']);
  });
  test('page 1 names the binding text still to come', () => {
    assert.match(pages[0].page_notice, /binding text is still to come \(page 2: identity, character, user\)/);
  });
  test('the last page names the load_id to pass to emet_session_open', () => {
    const last = pages[pages.length - 1];
    assert.ok(last.page_notice.endsWith(pg.sessionOpenLine(last.startup_page.load_id)), last.page_notice);
    assert.match(last.page_notice, new RegExp(`Pass "load_id": "${last.startup_page.load_id}" to emet_session_open`));
  });
  test('the last page says it is the last and has no next', () => {
    const last = pages[pages.length - 1];
    assert.match(last.page_notice, new RegExp(`^Startup page ${pages.length} of ${pages.length}, the last\\.`));
    assert.strictEqual(last.startup_page.next, null);
  });
});

testGroup('L: one load per startup', () => {
  test('a later page comes from page 1\'s build even after a new memory is written', async () => {
    const s = await liveSizedStore();
    const p1 = await withStore(s, () => initialize({}));
    s.collection('emet_episodic').docs.push({ _id: 'late', id: 999, content: 'written between pages', timestamp: Date.now() / 1000 + 60, importance: 0.6 });
    const rest = [];
    let next = p1.startup_page.next;
    while (next) { const p = await withStore(s, () => initialize(JSON.parse(next.replace(/^emet_initialize /, '')))); rest.push(p); next = p.startup_page.next; }
    const joined = pg.assemblePages([p1, ...rest]);
    assert.ok(!J(joined).includes('written between pages'));
    assert.strictEqual(joined.recent_context.length, 5);
  });
  test('with the build gone (server restart) and the startup changed, a later page says to start over', async () => {
    const s = await liveSizedStore();
    const p1 = await withStore(s, () => initialize({}));
    pg.clearPageCache();
    s.collection('emet_episodic').docs.push({ _id: 'late', id: 999, content: 'changed', timestamp: Date.now() / 1000 + 60, importance: 0.6 });
    const r = await withStore(s, () => initialize({ page: 2, load_id: p1.startup_page.load_id }));
    assert.strictEqual(r.startup_page.restart, true);
    assert.match(r.page_notice, /Call emet_initialize \{\} now to start again from page 1/);
  });
  test('with the build gone but the startup unchanged, the later page is served as it was', async () => {
    const s = await liveSizedStore();
    const p1 = await withStore(s, () => initialize({}));
    const want = await withStore(s, () => initialize({ page: 2, load_id: p1.startup_page.load_id }));
    pg.clearPageCache();
    const again = await withStore(s, () => initialize({ page: 2, load_id: p1.startup_page.load_id }));
    assert.strictEqual(J(again), J(want));
  });
  test('a page past the last is refused, naming how many pages there are', async () => {
    await assert.rejects(() => withStore(store, () => initialize({ page: 99, load_id: pages[0].startup_page.load_id })), new RegExp(`has ${pages.length} pages`));
  });
});

testGroup('B: backward compatibility', () => {
  test('page "all" is the one-result payload led by its load_id: startup_page and page_notice, then every key in the old order', async () => {
    const whole = await withStore(store, () => initialize({ page: 'all' }));
    assert.deepStrictEqual(Object.keys(whole), ['startup_page', 'page_notice', ...Object.keys(full)]);
    assert.strictEqual(J(payloadOf(whole)), J(full));
    assert.strictEqual(whole.startup_page.load_id, pages[0].startup_page.load_id, 'the same load_id the pages carry');
    for (const k of pg.PAGE_FIELDS) assert.ok(!(k in full), k);
    assert.deepStrictEqual(Object.keys(full).slice(0, 4), ['state', 'database', 'source_tag', 'person_id']);
    assert.strictEqual(Object.keys(full)[Object.keys(full).length - 1], 'instructions');
  });
  test('even a brand-new store\'s startup is paged (the shipped floor, charter and instructions alone pass one page); page "all" is the same payload in one result', async () => {
    const s = makeStore();
    await withStore(s, () => setupComplete({ assistant_name: 'Ada', assistant_character: 'Plain.', user_name: 'Sam Example', user_context: 'Testing.', source_tag: 'example-host' }));
    const all = payloadOf(await withStore(s, () => initialize({ page: 'all' })));
    assert.ok(sp.resultSize(all).bytes > 18000);
    const got = await fetchAll(s);
    assert.ok(got.length >= 2);
    assert.strictEqual(J(pg.assemblePages(got.map((f) => f.data))), J(all));
    assert.strictEqual(got[0].data.person_id, 'sam-example');
  });
  test('a payload that fits one page is laid out as a single page (initialize then returns it whole, with its load_id)', () => {
    const tiny = { state: 'ready', database: 'x', emet_line: 'Truth stands. Memory connected.', floor: { a: 'b' } };
    assert.strictEqual(pg.paginate(tiny).pages.length, 1);
    assert.strictEqual(J(payloadOf(pg.wholeStartup(tiny, 1), 1)), J(tiny));
  });
  test('setup_required is not paged: served whole, led by its load_id', async () => {
    const a = await withStore(makeStore(), () => initialize({}));
    assert.strictEqual(a.state, 'setup_required');
    const payload = payloadOf(a, 1);
    assert.ok(!('page_plan' in payload) && !('startup_page' in payload));
  });
  test('recent_limit is honoured and carried into every next call', async () => {
    const got = await fetchAll(store, { recent_limit: 2 });
    assert.match(got[0].data.startup_page.next, /"recent_limit":2/);
    assert.strictEqual(pg.assemblePages(got.map((f) => f.data)).recent_context.length, 2);
  });
});

await summary();
