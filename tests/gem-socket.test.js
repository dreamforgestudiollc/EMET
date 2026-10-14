/**
 * The GEM socket, every server refusal, and Neurendipity seated off.
 * An empty directory still logs nothing. The live startup is measured
 * against the 2026-10-11 figure from before this GEM: 65,493 bytes.
 */
import { test, testGroup, summary } from './harness.js';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.MONGODB_URI = 'mongodb://in-memory.test/emet';
for (const key of ['EMET_SOURCE_TAG', 'EMET_SOURCE_TAGS', 'EMET_TEMPLATE_MAP', 'EMET_GAP_BASELINE', 'EMET_RECORD_DOCS', 'CASCADE_RECORD_DOCS', 'EMET_CHARACTER_DOC', 'EMET_INSTALL_DOC', 'EMET_GEMS_ROOT', 'EMET_ACTIVE_GEMS', 'CASCADE_ACTIVE_GEMS']) {
  delete process.env[key];
}

const { makeStore, withStore } = await import('./memstore.js');
const { liveSizedStore, payloadOf } = await import('./startup-fixture.js');
const { resultSize, abridgeReadyPayload } = await import('../src/startup-payload.js');
const pages = await import('../src/startup-pages.js');
const { initialize, GEMS_NONE_LINE } = await import('../src/setup.js');
const { seatGems, releaseGemsRoot, MAX_INSTALLED, MAX_ACTIVE, MAX_ACTIVE_FLOOR_BYTES } = await import('../src/socket.js');
const { tempGem, tempRelease, floorDocument } = await import('./gem-fixture.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXAMPLE = path.join(ROOT, 'gem-library/examples/neurendipity');
const BEFORE_BYTES = 65493;

console.log('\n=== GEM socket (empty mount, refusals, startup cost) ===');

function quiet() {
  const warnings = [];
  const infos = [];
  return {
    warnings,
    infos,
    log: {
      warn(message, context) { warnings.push({ message, context }); },
      info(message, context) { infos.push({ message, context }); },
      error(message) { warnings.push({ message, context: { level: 'error' } }); }
    }
  };
}

testGroup('an empty mount is silence, and the example is not installed', () => {
  test('the release seats Neurendipity off, and an env path is ignored', async () => {
    const root = releaseGemsRoot();
    assert.ok(root.endsWith(`${path.sep}gems`), root);
    assert.ok(fs.existsSync(path.join(root, 'neurendipity', 'gem.json')));
    assert.ok(!EXAMPLE.startsWith(root + path.sep));
    process.env.EMET_GEMS_ROOT = EXAMPLE;
    try {
      const heard = quiet();
      const seated = await seatGems({ log: heard.log });
      assert.strictEqual(seated.gems_available.length, 1);
      const row = seated.gems_available[0];
      assert.strictEqual(row.id, 'neurendipity');
      assert.strictEqual(row.loadable, true, row.reason);
      assert.strictEqual(row.active, false);
      assert.strictEqual(row.defaultOn, false);
      assert.notStrictEqual(row.bytes, 953);
      assert.deepStrictEqual(seated.gems_active, []);
      assert.strictEqual(heard.warnings.length, 0);
      assert.strictEqual(heard.infos.length, 1);
      assert.match(heard.infos[0].message, /^GEMs seated: 1 installed, 0 active$/);
    } finally {
      delete process.env.EMET_GEMS_ROOT;
    }
  });
  test('an empty directory logs nothing', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'emet-gems-none-'));
    try {
      const heard = quiet();
      const seated = await seatGems({ root, releaseRoot: root, log: heard.log });
      assert.deepStrictEqual(seated.gems_available, []);
      assert.strictEqual(heard.infos.length, 0);
      assert.strictEqual(heard.warnings.length, 0);
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });
  test('a database handle passed by a caller is not read and not returned', async () => {
    const seated = await seatGems({ log: quiet().log, db: { uri: 'mongodb://user:secret@localhost/private' } });
    assert.strictEqual(JSON.stringify(seated).includes('secret'), false);
    assert.ok(!('db' in seated));
    const src = fs.readFileSync(path.join(ROOT, 'src/socket.js'), 'utf8');
    assert.doesNotMatch(src, /from ['"]mongodb['"]|from ['"]\.\/database|mongoose|MongoClient/);
  });
  test('a file sitting in gems/ is not a GEM', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'emet-gems-empty-'));
    try {
      await fs.promises.writeFile(path.join(root, 'readme.txt'), 'not a gem\n');
      const seated = await seatGems({ root, releaseRoot: root, log: quiet().log });
      assert.deepStrictEqual(seated.gems_available, []);
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });
});

testGroup('server refusals', () => {
  test('the example, seated outside the release, is SR-01 and does not throw', async () => {
    const heard = quiet();
    const seated = await seatGems({ root: path.dirname(EXAMPLE), releaseRoot: releaseGemsRoot(), log: heard.log });
    assert.strictEqual(seated.gems_available.length, 1);
    const row = seated.gems_available[0];
    assert.strictEqual(row.id, 'neurendipity');
    assert.strictEqual(row.loadable, false);
    assert.strictEqual(row.active, false);
    assert.strictEqual(row.reason, 'SR-01');
    assert.strictEqual(seated.gems_active.length, 0);
    assert.strictEqual(heard.warnings.length, 1);
    assert.match(heard.warnings[0].message, /^GEM refused: neurendipity SR-01$/);
    assert.strictEqual(heard.warnings[0].context.reason, 'SR-01');
    assert.ok(!('stack' in heard.warnings[0].context));
  });
  test('a bundled copy inside the release with requires >=0.3.0 is SR-06, off, and still listed', async () => {
    const release = await tempRelease(['neurendipity'], (manifest) => {
      manifest.requires = { emet: '>=0.3.0' };
      manifest.defaultOn = true;
    });
    try {
      const seated = await seatGems({ root: release.root, releaseRoot: release.root, log: quiet().log });
      const row = seated.gems_available[0];
      assert.strictEqual(row.loadable, false);
      assert.strictEqual(row.reason, 'SR-06');
      assert.strictEqual(row.active, false);
      assert.ok(row.bytes > 0);
    } finally { await release.cleanup(); }
  });
  test('defaultOn false is loadable and not active', async () => {
    const release = await tempRelease(['neurendipity']);
    try {
      const seated = await seatGems({ root: release.root, releaseRoot: release.root, log: quiet().log });
      const row = seated.gems_available[0];
      assert.strictEqual(row.loadable, true);
      assert.strictEqual(row.active, false);
      assert.ok(!('reason' in row));
      assert.deepStrictEqual(seated.gems_active, []);
      assert.strictEqual(row.defaultOn, false);
    } finally { await release.cleanup(); }
  });
  test('defaultOn true with an empty override list activates, and the floor is served whole', async () => {
    const release = await tempRelease(['neurendipity'], (manifest) => { manifest.defaultOn = true; });
    try {
      const seated = await seatGems({ root: release.root, releaseRoot: release.root, log: quiet().log });
      assert.strictEqual(seated.gems_available[0].active, true);
      assert.strictEqual(seated.gems_active.length, 1);
      const active = seated.gems_active[0];
      assert.strictEqual(active.id, 'neurendipity');
      assert.match(active.floor_digest, /^sha256:[a-f0-9]{64}$/);
      assert.ok(active.floor.reading_people);
      assert.ok(active.reassertion.length >= 1);
    } finally { await release.cleanup(); }
  });
  test('overrides without consent are SR-05, and defaultOn is not consent', async () => {
    const release = await tempRelease(['neurendipity'], (manifest) => {
      manifest.defaultOn = true;
      manifest.overrides = ['voice.composure'];
    });
    try {
      const refused = await seatGems({ root: release.root, releaseRoot: release.root, log: quiet().log });
      assert.strictEqual(refused.gems_available[0].reason, 'SR-05');
      assert.strictEqual(refused.gems_active.length, 0);
      const manifest = JSON.parse(await fs.promises.readFile(path.join(release.root, 'neurendipity/gem.json'), 'utf8'));
      const consented = await seatGems({
        root: release.root,
        releaseRoot: release.root,
        log: quiet().log,
        consent: [{ id: 'neurendipity', digests: manifest.files.map((f) => f.digest) }]
      });
      assert.strictEqual(consented.gems_available[0].loadable, true, consented.gems_available[0].reason);
      assert.strictEqual(consented.gems_available[0].active, true);
    } finally { await release.cleanup(); }
  });
  test('a new digest needs new consent', async () => {
    const release = await tempRelease(['neurendipity'], (manifest) => {
      manifest.overrides = ['voice.composure'];
    });
    try {
      const seated = await seatGems({
        root: release.root,
        releaseRoot: release.root,
        log: quiet().log,
        consent: [{ id: 'neurendipity', digests: ['sha256:' + 'ab'.repeat(32)] }]
      });
      assert.strictEqual(seated.gems_available[0].reason, 'SR-05');
    } finally { await release.cleanup(); }
  });
  test('the 17th id is SR-03 and the first 16 stay listed in id order', async () => {
    const ids = Array.from({ length: MAX_INSTALLED + 1 }, (_, i) => `a${String(i + 1).padStart(2, '0')}`);
    const release = await tempRelease(ids);
    try {
      const seated = await seatGems({ root: release.root, releaseRoot: release.root, log: quiet().log });
      assert.deepStrictEqual(seated.gems_available.map((g) => g.id), [...ids].sort());
      const refused = seated.gems_available.filter((g) => g.reason === 'SR-03');
      assert.strictEqual(refused.length, 1);
      assert.strictEqual(refused[0].id, 'a17');
      assert.ok(seated.gems_available.slice(0, MAX_INSTALLED).every((g) => g.loadable === true));
    } finally { await release.cleanup(); }
  });
  test('the 5th activation is SR-02', async () => {
    const ids = ['a', 'b', 'c', 'd', 'e'].map((ch) => `g${ch}`);
    const release = await tempRelease(ids, (manifest) => { manifest.defaultOn = true; });
    try {
      const seated = await seatGems({ root: release.root, releaseRoot: release.root, log: quiet().log });
      const active = seated.gems_available.filter((g) => g.active);
      assert.strictEqual(active.length, MAX_ACTIVE);
      const fifth = seated.gems_available.find((g) => g.id === 'ge');
      assert.strictEqual(fifth.reason, 'SR-02');
      assert.strictEqual(seated.gems_active.length, MAX_ACTIVE);
    } finally { await release.cleanup(); }
  });
  test('active floor bytes over 16384 are SR-04', async () => {
    const release = await tempRelease(['aa', 'bb', 'cc'], async (manifest, dir) => {
      manifest.defaultOn = true;
      const text = floorDocument(manifest.id === 'cc' ? 800 : 8000);
      await fs.promises.writeFile(path.join(dir, 'floor.json'), text);
    });
    try {
      const seated = await seatGems({ root: release.root, releaseRoot: release.root, log: quiet().log });
      const sum = seated.gems_active.reduce((n, g) => n + Buffer.byteLength(JSON.stringify(g.floor)) , 0);
      assert.ok(sum <= MAX_ACTIVE_FLOOR_BYTES + 4000);
      const third = seated.gems_available.find((g) => g.id === 'cc');
      assert.strictEqual(third.reason, 'SR-04', JSON.stringify(seated.gems_available.map((g) => [g.id, g.reason, g.bytes])));
      assert.ok(seated.gems_available.filter((g) => g.active).every((g) => g.id !== 'cc'));
    } finally { await release.cleanup(); }
  });
  test('a library GEM is not bundled just because it sits in gems/', async () => {
    const release = await tempRelease(['neurendipity'], (manifest) => {
      manifest.distribution = 'library';
      manifest.signature = { alg: 'Ed25519', keyid: 'testkey', value: `${'A'.repeat(86)}==` };
    });
    try {
      const seated = await seatGems({ root: release.root, releaseRoot: release.root, log: quiet().log });
      assert.strictEqual(seated.gems_available[0].loadable, false);
      assert.strictEqual(seated.gems_available[0].reason, 'GC-11', seated.gems_available[0].reason);
    } finally { await release.cleanup(); }
  });
  test('a runed-gem is refused and its code does not run', async () => {
    const marker = `GEM_SOCKET_${process.pid}`;
    delete process.env[marker];
    const release = await tempRelease(['runner'], async (manifest, dir) => {
      manifest.kind = 'runed-gem';
      manifest.defaultOn = true;
      manifest.runes = [{
        name: 'look',
        description: 'Reads one layer and writes nothing.',
        inputSchema: { type: 'object' },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        reads: ['semantic'],
        writes: [],
        network: 'none'
      }];
      await fs.promises.mkdir(path.join(dir, 'runes'));
      await fs.promises.writeFile(path.join(dir, 'runes/look.js'), `process.env.${marker} = 'yes';\nexport const x = 1;\n`);
      manifest.files.push({ path: 'runes/look.js', digest: 'sha256:' + 'ab'.repeat(32), size: 1 });
    });
    try {
      const seated = await seatGems({ root: release.root, releaseRoot: release.root, log: quiet().log });
      assert.strictEqual(seated.gems_available[0].reason, 'GC-19');
      assert.strictEqual(seated.gems_active.length, 0);
      assert.strictEqual(process.env[marker], undefined);
    } finally { await release.cleanup(); }
  });
  test('a checker that throws is a refusal, not an exception', async () => {
    const release = await tempRelease(['neurendipity']);
    try {
      const seated = await seatGems({
        root: release.root,
        releaseRoot: release.root,
        log: quiet().log,
        check: async () => { throw new Error('boom'); }
      });
      assert.strictEqual(seated.gems_available[0].loadable, false);
      assert.strictEqual(seated.gems_available[0].reason, 'GC-01');
    } finally { await release.cleanup(); }
  });
  test('a symlink out of the release root is refused', async () => {
    const release = await tempRelease(['neurendipity']);
    const outside = await fs.promises.mkdtemp(path.join(path.dirname(release.root), 'emet-escape-'));
    try {
      await fs.promises.symlink(path.join(release.root, 'neurendipity'), path.join(outside, 'neurendipity'));
      const seated = await seatGems({ root: outside, releaseRoot: release.root, log: quiet().log });
      // The real path is the release copy, so SR-01 does not fire for that.
      // Pointing the symlink at a directory outside the root must refuse.
      await fs.promises.rm(path.join(outside, 'neurendipity'));
      await fs.promises.symlink(EXAMPLE, path.join(outside, 'neurendipity'));
      const escaped = await seatGems({ root: outside, releaseRoot: release.root, log: quiet().log });
      assert.strictEqual(escaped.gems_available[0].loadable, false);
      assert.notStrictEqual(escaped.gems_active.length, 1);
    } finally {
      await release.cleanup();
      await fs.promises.rm(outside, { recursive: true, force: true });
    }
  });
});

testGroup('startup lists Neurendipity off, and the guide stays out of the payload', () => {
  const storePromise = liveSizedStore();
  test('ready startup: Neurendipity installed and off, guide absent, init stays cheap', async () => {
    delete process.env.EMET_ACTIVE_GEMS;
    const store = await storePromise;
    const times = [];
    let full;
    for (let n = 0; n < 7; n++) {
      const start = process.hrtime.bigint();
      full = payloadOf(await withStore(store, () => initialize({ page: 'all' })));
      times.push(Number(process.hrtime.bigint() - start) / 1e6);
    }
    times.sort((a, b) => a - b);
    const median = times[3];
    const bytes = resultSize(full).bytes;
    console.log(`    init off median ${median.toFixed(2)} ms, min ${times[0].toFixed(2)} ms, bytes ${bytes} (before ${BEFORE_BYTES})`);
    assert.strictEqual(full.gems_available.length, 1);
    assert.strictEqual(full.gems_available[0].id, 'neurendipity');
    assert.strictEqual(full.gems_available[0].active, false);
    assert.strictEqual(full.gems_available[0].loadable, true);
    assert.deepStrictEqual(full.gems_active, []);
    const line = 'neurendipity, Neurendipity, off';
    assert.ok(full.instructions.includes(line));
    assert.ok(full.instructions_short.includes(line));
    assert.ok(full.instructions.indexOf(line) < full.instructions.indexOf('Never open with a question alone'));
    assert.ok(full.instructions_short.length < 1400);
    const packed = JSON.stringify(full);
    assert.ok(!packed.includes('AuDHD'));
    assert.ok(!packed.includes('Draft for review: 2026-09-28'));
    assert.ok(!packed.includes('burnout is not depression'));
    assert.ok(median < 100, `median init ${median} ms`);
  });
  test('paging does not chunk either list, and the abridged form does not pointer them', async () => {
    const store = await storePromise;
    const full = payloadOf(await withStore(store, () => initialize({ page: 'all' })));
    const laid = pages.paginate(full);
    for (const page of laid.pages) {
      const chunks = page.startup_page.chunks || {};
      assert.ok(!('gems_available' in chunks));
      assert.ok(!('gems_active' in chunks));
    }
    const seen = laid.pages.flatMap((page) => Object.keys(page).filter((key) => key === 'gems_available' || key === 'gems_active'));
    assert.deepStrictEqual(seen.sort(), ['gems_active', 'gems_available']);
    assert.strictEqual(pages.assemblePages(laid.pages).gems_available[0].id, 'neurendipity');
    assert.deepStrictEqual(pages.assemblePages(laid.pages).gems_active, []);
    const abridged = abridgeReadyPayload(full);
    assert.strictEqual(abridged.gems_available[0].id, 'neurendipity');
    assert.deepStrictEqual(abridged.gems_active, []);
    assert.ok(!abridged.pointers.some((p) => p.key === 'gems_available' || p.key === 'gems_active'));
  });
  test('a list that fits a page but not the remainder moves whole', () => {
    const payload = {
      state: 'ready',
      floor: 'f'.repeat(16000),
      gems_available: [{ id: 'abcd', pad: 'p'.repeat(2500) }],
      gems_active: [{ id: 'abcd', floor: { a: 'b' } }]
    };
    const laid = pages.paginate(payload, { budget: 18000 });
    for (const page of laid.pages) {
      const chunks = page.startup_page.chunks || {};
      assert.ok(!('gems_available' in chunks) && !('gems_active' in chunks));
    }
    const hosts = laid.pages.filter((page) => page.gems_available);
    assert.strictEqual(hosts.length, 1);
    assert.ok(!hosts[0].floor, 'the list left the page the floor filled');
    assert.deepStrictEqual(pages.assemblePages(laid.pages).gems_available, payload.gems_available);
  });
  test('setup_required names Neurendipity off', async () => {
    const fresh = await withStore(makeStore(), () => initialize({ page: 'all' }));
    const body = payloadOf(fresh);
    assert.strictEqual(body.state, 'setup_required');
    assert.strictEqual(body.gems_available[0].id, 'neurendipity');
    assert.strictEqual(body.gems_available[0].active, false);
    assert.deepStrictEqual(body.gems_active, []);
    assert.ok(body.instructions.includes('neurendipity, Neurendipity, off'));
    assert.ok(!body.instructions.includes(GEMS_NONE_LINE));
  });
  test('a refused GEM in the release directory does not stop initialize', async () => {
    const root = releaseGemsRoot();
    const broken = path.join(root, 'broken');
    const lines = [];
    const orig = console.error;
    console.error = (...args) => { lines.push(args.map(String).join(' ')); };
    try {
      await fs.promises.mkdir(broken, { recursive: true });
      await fs.promises.writeFile(path.join(broken, 'gem.json'), '{ not json');
      const store = await storePromise;
      const full = payloadOf(await withStore(store, () => initialize({ page: 'all' })));
      assert.strictEqual(full.state, 'ready');
      const ids = full.gems_available.map((g) => g.id);
      assert.deepStrictEqual(ids, ['broken', 'neurendipity']);
      const refused = full.gems_available.find((g) => g.id === 'broken');
      assert.strictEqual(refused.loadable, false);
      assert.strictEqual(refused.active, false);
      assert.strictEqual(refused.reason, 'GC-01');
      assert.strictEqual(full.gems_available.find((g) => g.id === 'neurendipity').loadable, true);
      assert.ok(full.instructions.includes('broken'));
      assert.ok(!full.instructions.includes('not json'));
      assert.strictEqual(lines.filter((line) => line.includes('GEM refused:')).length, 1);
      assert.ok(lines.some((line) => line.includes('GEM refused: broken GC-01')));
    } finally {
      console.error = orig;
      await fs.promises.rm(broken, { recursive: true, force: true });
    }
  });
  test('EMET_ACTIVE_GEMS=neurendipity turns it on, and an explicit empty ask stays off', async () => {
    const release = await tempRelease(['neurendipity']);
    process.env.EMET_ACTIVE_GEMS = 'neurendipity';
    try {
      const off = await seatGems({ root: release.root, releaseRoot: release.root, asked: [], log: quiet().log });
      assert.strictEqual(off.gems_available[0].active, false);
      const on = await seatGems({ root: release.root, releaseRoot: release.root, log: quiet().log });
      assert.strictEqual(on.gems_available[0].loadable, true, on.gems_available[0].reason);
      assert.strictEqual(on.gems_available[0].active, true);
      assert.strictEqual(on.gems_active.length, 1);
      assert.ok(on.gems_active[0].floor.reading_people);
      const askedOther = await seatGems({ root: release.root, releaseRoot: release.root, asked: ['other-gem'], log: quiet().log });
      assert.strictEqual(askedOther.gems_active.length, 0);
      const shipped = await seatGems({ log: quiet().log });
      assert.strictEqual(shipped.gems_available[0].id, 'neurendipity');
      assert.strictEqual(shipped.gems_available[0].active, true);
      assert.strictEqual(shipped.gems_active[0].floor.neurodivergent_support.lines.burnout_is_not_depression.includes('Burnout is not depression'), true);
      assert.ok(!JSON.stringify(shipped).includes('AuDHD'));
    } finally {
      delete process.env.EMET_ACTIVE_GEMS;
      await release.cleanup();
    }
  });
  test('asking does not waive consent when overrides is non-empty', async () => {
    const release = await tempRelease(['neurendipity'], (manifest) => {
      manifest.overrides = ['voice.concrete'];
      manifest.defaultOn = false;
    });
    try {
      const seated = await seatGems({ root: release.root, releaseRoot: release.root, asked: ['neurendipity'], log: quiet().log });
      assert.strictEqual(seated.gems_available[0].reason, 'SR-05');
      assert.strictEqual(seated.gems_active.length, 0);
    } finally { await release.cleanup(); }
  });
});

summary('GEM socket');
