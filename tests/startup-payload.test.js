/**
 * The startup payload: its size, the one dedupe, and the abridged builder
 * (the host-aware startup design; conservative variant chosen by the owner
 * 2026-10-02).
 *
 *   M   measures the full ready payload on a fixture sized like the live store
 *       (document sizes from the 2026-10-02 list_docs read: IDENTITY 1,018,
 *       SOUL 6,790, USER 8,748, INSTALL 6,582 characters; 21 seeds; 25
 *       threads; 5 recent entries) and prints the full and abridged sizes
 *   D   the layer charter in the payload drops only importance_range, the twin
 *       of the importance band; every other field is byte-identical
 *   F   fidelity: floor, identity, character, user, close protocol and tools in
 *       force are the same bytes in the full and abridged forms, and equal the
 *       stored documents
 *   A   the abridged form: keep set byte-identical, pinned and indexed keys
 *       replaced by pointers with doc id, version and sha256, recent_context
 *       as a delta, layer_health only when it reports something
 *   S   the server alone decides the mode: emet_initialize takes no argument
 *       that asks for less, and every load it serves today is full
 * In-memory store, real code (initialize, setupComplete); no database.
 */
import { test, testGroup, summary } from './harness.js';
import assert from 'assert';
import crypto from 'crypto';
import { makeStore, withStore, withEnv } from './memstore.js';
import { liveSizedStore, payloadOf } from './startup-fixture.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

process.env.MONGODB_URI = 'mongodb://in-memory.test/emet';
for (const k of ['EMET_SOURCE_TAG', 'EMET_SOURCE_TAGS', 'EMET_TEMPLATE_MAP', 'EMET_GAP_BASELINE', 'EMET_RECORD_DOCS', 'CASCADE_RECORD_DOCS', 'EMET_CHARACTER_DOC', 'EMET_INSTALL_DOC'])
  delete process.env[k];

console.log('\n=== startup-payload (host-aware startup: size, dedupe, abridged builder) ===');

const { initialize, setupComplete } = await import('../src/setup.js');
const { LAYER_CHARTER } = await import('../src/layers.js');
const { FLOOR, FLOOR_REASSERTION, PRECEDENCE } = await import('../src/floor.js');
const { CLOSE_PROTOCOL } = await import('../src/session.js');
const { TOOLS } = await import('../src/tools.js');
const sp = await import('../src/startup-payload.js');
const pg = await import('../src/startup-pages.js');
const { dispatchTool } = await import('../src/dispatch.js');

const sha = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
const J = (v) => JSON.stringify(v);

const store = await liveSizedStore();
// page: "all" is the whole payload in one result, as initialize served it before paging.
const full = payloadOf(await withStore(store, () => initialize({ page: 'all' })));
const abridged = sp.abridgeReadyPayload(full, { since: full.recent_context[2].when });
const fullSize = sp.resultSize(full);
const abridgedSize = sp.resultSize(abridged);

testGroup('M: measure the full and abridged payloads on a live-sized fixture', () => {
  test('the fixture builds a ready payload', () => {
    assert.strictEqual(full.state, 'ready', J(full).slice(0, 300));
  });
  test('sizes (printed for the record)', () => {
    console.log(`    full:     ${fullSize.chars} chars, ${fullSize.bytes} bytes`);
    console.log(`    abridged: ${abridgedSize.chars} chars, ${abridgedSize.bytes} bytes (recent_context delta of 2)`);
    console.log('    full, largest keys: ' + sp.keySizes(full).slice(0, 12).map((k) => `${k.key} ${k.chars}`).join(', '));
    assert.ok(abridgedSize.chars < fullSize.chars);
  });
  test('the full payload on this fixture is within 10% of the live measurement (64,963 bytes, 2026-10-02)', () => {
    assert.ok(Math.abs(fullSize.bytes - 64963) / 64963 < 0.10, `full ${fullSize.bytes} bytes`);
  });
  test('abridging saves at least 30% on this fixture, and the abridged form is still above the 20,000-byte gateway cut (paging is still needed)', () => {
    assert.ok(abridgedSize.bytes <= fullSize.bytes * 0.70, `abridged ${abridgedSize.bytes} of ${fullSize.bytes}`);
    assert.ok(abridgedSize.bytes > 20000);
  });
});

testGroup('D: the layer charter dedupe removes importance_range and nothing else', () => {
  test('every layer is served; each entry equals the charter entry minus importance_range', () => {
    assert.deepStrictEqual(Object.keys(full.layer_charter), Object.keys(LAYER_CHARTER));
    for (const [layer, entry] of Object.entries(LAYER_CHARTER)) {
      const { importance_range, ...rest } = entry;
      assert.ok(Array.isArray(importance_range));
      assert.strictEqual(J(full.layer_charter[layer]), J(rest), layer);
      assert.ok(!('importance_range' in full.layer_charter[layer]));
      assert.strictEqual(full.layer_charter[layer].importance, entry.importance, `${layer} keeps its importance band`);
    }
  });
  test('LAYER_CHARTER itself still carries importance_range (only the payload copy changed)', () => {
    for (const entry of Object.values(LAYER_CHARTER)) assert.strictEqual(entry.importance_range.length, 2);
  });
  test('the setup_required payload takes the same charter copy', async () => {
    const fresh = await withStore(makeStore(), () => initialize({}));
    assert.strictEqual(fresh.state, 'setup_required');
    assert.strictEqual(J(fresh.layer_charter), J(sp.payloadForLayerCharter()));
  });
  test('the full payload keeps every key it had before this change, in the same order', () => {
    assert.deepStrictEqual(Object.keys(full), [
      'state', 'database', 'source_tag', 'person_id', 'unhandled_drops', 'unhandled_drops_more', 'retired_drops', 'emet_line', 'emet_line_if_unanswered', 'tools_in_force',
      'instructions_short', 'session_close_protocol', 'operating_discipline', 'charter', 'identity', 'character',
      'character_doc_id', 'character_sha256', 'user', 'install_notes', 'install_notes_doc_id',
      'seeds', 'seeds_due', 'seeds_evaluated_on', 'threads', 'recent_context', 'layer_counts', 'layer_counts_last_30d',
      'layer_charter', 'layer_health', 'record_gaps', 'named_items', 'lessons_pending', 'floor', 'floor_precedence', 'floor_reassertion', 'instructions'
    ]);
  });
});

testGroup('F: fidelity - the binding text is the same bytes in both forms and equals the store', () => {
  const doc = (id) => store.collection('documents').docs.find((d) => d.doc_id === id).content;
  test('identity, character and user equal the stored documents, whole', () => {
    assert.strictEqual(full.identity, doc('bootstrap/IDENTITY.md'));
    assert.strictEqual(full.character, doc('bootstrap/SOUL.md'));
    assert.strictEqual(full.user, doc('bootstrap/USER.md'));
    assert.strictEqual(full.character_doc_id, 'bootstrap/SOUL.md');
  });
  test('floor, precedence, reassertion and close protocol are the shipped constants in both forms', () => {
    for (const p of [full, abridged]) {
      assert.strictEqual(J(p.floor), J(FLOOR));
      assert.strictEqual(J(p.floor_precedence), J(PRECEDENCE));
      assert.strictEqual(J(p.floor_reassertion), J(FLOOR_REASSERTION));
      assert.strictEqual(J(p.session_close_protocol), J(CLOSE_PROTOCOL));
    }
  });
  test('the full install notes are whole', () => {
    assert.strictEqual(full.install_notes.content, doc('bootstrap/INSTALL.md'));
  });
});

testGroup('A: the abridged form', () => {
  test('every keep-set key is byte-identical to the full payload', () => {
    for (const k of sp.ABRIDGED_KEEP) {
      assert.ok(k in abridged, `missing ${k}`);
      assert.strictEqual(J(abridged[k]), J(full[k]), k);
    }
  });
  test('pinned and indexed keys carry no content in the abridged form', () => {
    for (const k of [...sp.ABRIDGED_PINNED, ...sp.ABRIDGED_INDEXED]) assert.ok(!(k in abridged), `${k} still embedded`);
  });
  test('every full key is kept, pointed or indexed - nothing silently disappears', () => {
    const accounted = new Set([...sp.ABRIDGED_KEEP, ...sp.ABRIDGED_PINNED, ...sp.ABRIDGED_INDEXED, 'recent_context', 'layer_health']);
    for (const k of Object.keys(full)) assert.ok(accounted.has(k), `unaccounted key ${k}`);
  });
  test('the install-notes pointer carries the doc id, version and sha256 of the full load', () => {
    const p = abridged.pointers.find((x) => x.key === 'install_notes');
    assert.strictEqual(p.kind, 'hash_pinned');
    assert.strictEqual(p.doc_id, full.install_notes.doc_id);
    assert.strictEqual(p.version, full.install_notes.version);
    assert.strictEqual(p.sha256, full.install_notes.sha256);
  });
  test('the layer charter and long instructions pointers pin the sha256 of the text the full load served', () => {
    for (const k of ['layer_charter', 'instructions']) {
      const p = abridged.pointers.find((x) => x.key === k);
      assert.strictEqual(p.sha256, sha(J(full[k])), k);
      assert.match(p.read_via, /^emet_initialize \(a full load/);
      assert.ok(!/full: true/.test(p.read_via), 'names no argument the tool does not have');
    }
  });
  test('the seed and thread indexes carry counts; seeds_due stays embedded', () => {
    assert.strictEqual(abridged.pointers.find((x) => x.key === 'seeds').count, 21);
    const t = abridged.pointers.find((x) => x.key === 'threads');
    assert.strictEqual(t.count, 25);
    assert.strictEqual(t.latest_updated_at, full.threads.map((x) => x.updated_at).sort().pop());
    assert.deepStrictEqual(abridged.seeds_due, full.seeds_due);
  });
  test('recent_context is the delta since the receipt; without one it is kept whole', () => {
    assert.deepStrictEqual(abridged.recent_context, full.recent_context.slice(0, 2));
    assert.deepStrictEqual(sp.abridgeReadyPayload(full).recent_context, full.recent_context.slice(0, 5));
  });
  test('layer_health is embedded only when it reports something', () => {
    assert.strictEqual(full.layer_health.assessed, true);
    assert.deepStrictEqual(full.layer_health.underused, [], J(full.layer_health));
    assert.ok(!('layer_health' in abridged));
    const sick = { ...full, layer_health: { assessed: true, underused: [{ layer: 'meta' }] } };
    assert.deepStrictEqual(sp.abridgeReadyPayload(sick).layer_health, sick.layer_health);
    const unassessed = { ...full, layer_health: { assessed: false, reason: 'few' } };
    assert.deepStrictEqual(sp.abridgeReadyPayload(unassessed).layer_health, unassessed.layer_health);
  });
  test('only a ready payload can be abridged', () => {
    assert.throws(() => sp.abridgeReadyPayload({ state: 'setup_required' }), /only a ready payload/);
    assert.throws(() => sp.abridgeReadyPayload(null), /only a ready payload/);
  });
  test('the abridged form says it is abridged', () => {
    assert.strictEqual(abridged.startup_mode, 'abridged');
    assert.ok(typeof abridged.startup_reason === 'string' && abridged.startup_reason);
  });
});

testGroup('S: the server decides the mode, and today every load is full', () => {
  test('emet_initialize takes recent_limit and the paging arguments only (no host-chosen abridging)', () => {
    const def = TOOLS.find((t) => t.name === 'emet_initialize');
    assert.deepStrictEqual(Object.keys(def.inputSchema.properties), ['recent_limit', 'page', 'load_id']);
  });
  // Every page of a load, fetched the way a host does: page 1, then each `next`.
  const allPages = async (call) => {
    const pages = [await call({})];
    while (pages[pages.length - 1].startup_page && pages[pages.length - 1].startup_page.next) {
      pages.push(await call(JSON.parse(pages[pages.length - 1].startup_page.next.replace(/^emet_initialize /, ''))));
    }
    return pages;
  };
  test('initialize ignores look-alike arguments and serves the full payload (paged, joined back)', async () => {
    for (const extra of [{ mode: 'abridged' }, { abridged: true }, { full: false }, { startup_mode: 'abridged' }]) {
      const pages = await allPages((args) => withStore(store, () => initialize({ ...args, ...extra })));
      for (const p of pages) assert.ok(!('pointers' in p) && !('startup_mode' in p), J(extra));
      assert.strictEqual(J(pg.assemblePages(pages)), J(full), J(extra));
      const one = payloadOf(await withStore(store, () => initialize({ ...extra, page: 'all' })));
      assert.strictEqual(J(one), J(full), J(extra));
    }
  });
  test('a page that is not a whole number from 1 (or "all") is refused with the valid forms', async () => {
    for (const page of ['abridged', 0, -1, 2.5, 'two', true, false, {}, [2], '2.5']) {
      await assert.rejects(() => withStore(store, () => initialize({ page })), (e) => /whole number from 1/.test(e.message) && /"all"/.test(e.message), J(page));
    }
  });
  // The reviewer's check of the first draft: an env switch read inside initialize(), or an
  // argument read in dispatch's emet_initialize handler, passed every test
  // above. The two tests below close both routes.
  const LOOKALIKE_ARGS = [{}, { mode: 'abridged' }, { abridged: true }, { abridge: true }, { full: false }, { startup_mode: 'abridged' }];
  const LOOKALIKE_ENV = { EMET_STARTUP_MODE: 'abridged', EMET_STARTUP_ABRIDGE: 'on', EMET_ABRIDGE: '1', EMET_INIT_MODE: 'abridged' };
  test('through the dispatch handler, with look-alike arguments and look-alike env switches set, every load is full', async () => {
    await withEnv(LOOKALIKE_ENV, async () => {
      for (const args of LOOKALIKE_ARGS) {
        const viaDispatch = (a) => withStore(store, async () => JSON.parse((await dispatchTool('emet_initialize', { ...a, ...args }, { dbManager: null, logger: null })).content[0].text).data);
        const pages = await allPages(viaDispatch);
        for (const pgx of pages) assert.ok(!('pointers' in pgx) && !('startup_mode' in pgx), J(args));
        const p = pg.assemblePages(pages);
        assert.strictEqual(J(p), J(full), J(args));
        assert.strictEqual(p.state, 'ready', J(args));
        assert.ok(!('pointers' in p) && !('startup_mode' in p), J(args));
        assert.strictEqual(J(p.install_notes), J(full.install_notes), J(args));
        assert.strictEqual(J(p.layer_charter), J(full.layer_charter), J(args));
        assert.strictEqual(p.instructions, full.instructions, J(args));
        assert.strictEqual(J(p.seeds), J(full.seeds), J(args));
      }
    });
  });
  // Static pin: the abridged builder is reachable only through the paths named
  // here. ALLOWED is the whole list of src files that may name it; adding a
  // file to it is a design change that needs the owner's approval (the server
  // decides the mode, never a host, env switch or flag).
  const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
  // Paging (2026-10-03, the owner approved) adds one startup path: setup.js pages
  // the FULL payload through startup-pages.js, which measures pages with
  // resultSize. Neither names the abridged builder; nothing else imports them.
  const ALLOWED = {
    abridge: ['startup-payload.js'],
    modules: {
      'startup-payload.js': { 'setup.js': ['payloadForLayerCharter'], 'startup-pages.js': ['resultSize'] },
      // Page completion (2026-10-03, the owner approved the check): setup.js notes
      // each page served; tools.js reads which were missed at session open.
      // tools.js also notes an open with pages missing, so a page fetched
      // later is recorded late (2026-10-03). setup.js wraps a startup served
      // whole with its load_id (wholeStartup, 2026-10-03).
      'startup-pages.js': { 'setup.js': ['paginate', 'cacheLoad', 'cachedLoad', 'loadIdOf', 'restartPage', 'notePageServed', 'wholeStartup'], 'tools.js': ['pageCompletion', 'noteOpenMissing', 'cachedLoad'] }
    }
  };
  const srcFiles = fs.readdirSync(SRC).filter((f) => f.endsWith('.js'));
  test('no src file except the allowed ones names abridgeReadyPayload, ABRIDGED_ or startup_mode', () => {
    for (const f of srcFiles) {
      const text = fs.readFileSync(path.join(SRC, f), 'utf8');
      if (ALLOWED.abridge.includes(f)) continue;
      for (const needle of ['abridgeReadyPayload', 'ABRIDGED_', 'startup_mode']) {
        assert.ok(!text.includes(needle), `${f} names ${needle}`);
      }
    }
  });
  test('no src file uses import() with a built-up or variable path (every dynamic import names one literal module)', () => {
    for (const f of srcFiles) {
      const text = fs.readFileSync(path.join(SRC, f), 'utf8');
      const all = (text.match(/\bimport\s*\(/g) || []).length;
      const literal = (text.match(/\bimport\s*\(\s*(['"])[^'"`+]*\1\s*\)/g) || []).length;
      assert.strictEqual(all, literal, `${f}: a dynamic import that is not one string literal`);
    }
  });
  test('a page given as the text of a whole number is read as that page', async () => {
    const p2 = await withStore(store, () => initialize({ page: ' 2 ' }));
    assert.strictEqual(p2.startup_page.index, 2);
  });
  for (const [mod, importers] of Object.entries(ALLOWED.modules)) {
    test(`${mod} is imported only by the allowed files, and only for the allowed names`, () => {
      const stem = mod.replace(/\.js$/, '');
      for (const f of srcFiles) {
        if (f === mod) continue;
        const text = fs.readFileSync(path.join(SRC, f), 'utf8');
        const refs = text.match(new RegExp(`['"\`][^'"\`]*${stem}(\\.js)?['"\`]`, 'g')) || []; // module specifiers, not prose
        if (!importers[f]) { assert.strictEqual(refs.length, 0, `${f} references ${mod}`); continue; }
        const imports = [...text.matchAll(new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*['"]\\./${stem}\\.js['"]`, 'g'))];
        assert.strictEqual(imports.length, 1, `${f}: one static import of ${mod}`);
        assert.strictEqual(refs.length, 1, `${f}: no other reference to ${mod} (dynamic import, re-export)`);
        const names = imports[0][1].split(',').map((x) => x.trim()).filter(Boolean);
        assert.deepStrictEqual(names, importers[f], `${f} imports ${names.join(', ')} from ${mod}`);
      }
    });
  }
});

await summary();
