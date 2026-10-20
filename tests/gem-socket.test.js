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
import { fileURLToPath, pathToFileURL } from 'node:url';

process.env.MONGODB_URI = 'mongodb://in-memory.test/emet';
for (const key of ['EMET_SOURCE_TAG', 'EMET_SOURCE_TAGS', 'EMET_TEMPLATE_MAP', 'EMET_GAP_BASELINE', 'EMET_RECORD_DOCS', 'CASCADE_RECORD_DOCS', 'EMET_CHARACTER_DOC', 'EMET_INSTALL_DOC', 'EMET_GEMS_ROOT', 'EMET_ACTIVE_GEMS', 'CASCADE_ACTIVE_GEMS']) {
  delete process.env[key];
}

const { makeStore, withStore } = await import('./memstore.js');
const { liveSizedStore, payloadOf } = await import('./startup-fixture.js');
const { resultSize, abridgeReadyPayload } = await import('../src/startup-payload.js');
const pages = await import('../src/startup-pages.js');
const { initialize, GEMS_NONE_LINE } = await import('../src/setup.js');
const { seatGems, gemCost, releaseGemsRoot, releasedReason, RELEASED_LEGACY, MAX_INSTALLED, MAX_ACTIVE, MAX_ACTIVE_FLOOR_BYTES } = await import('../src/socket.js');
const { tempGem, tempRelease, floorDocument, rune, sha256 } = await import('./gem-fixture.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXAMPLE = path.join(ROOT, 'gem-library/examples/neurendipity');
const BEFORE_BYTES = 65493;

console.log('\n=== GEM socket (empty mount, refusals, startup cost) ===');

const LSS_FIXTURE = path.join(ROOT, 'tests/fixtures/lss-0.9.0/lean-six-sigma');

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

async function writeGemJson(dir, mutate) {
  const file = path.join(dir, 'gem.json');
  const manifest = JSON.parse(await fs.promises.readFile(file, 'utf8'));
  mutate(manifest);
  await fs.promises.writeFile(file, JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

async function setReleased(dir, value) {
  await writeGemJson(dir, (manifest) => {
    if (value === undefined) delete manifest.released;
    else manifest.released = value;
  });
}

/** Drop listed files from neurendipity so the manifest is a strict subset of the pin. */
async function dropNeurendipityFiles(root, drop) {
  const dir = path.join(root, 'neurendipity');
  await writeGemJson(dir, (manifest) => {
    delete manifest.released;
    manifest.files = manifest.files.filter((file) => !drop.includes(file.path));
    manifest.guides = manifest.guides.filter((rel) => !drop.includes(rel));
  });
  for (const rel of drop) await fs.promises.rm(path.join(dir, rel), { force: true });
  const guides = path.join(dir, 'guides');
  const left = await fs.promises.readdir(guides).catch(() => []);
  if (left.length === 0) await fs.promises.rm(guides, { recursive: true, force: true });
}

/** Today's gems/neurendipity and gems/fieldnote, byte for byte. */
async function bootToday() {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'emet-boot-'));
  await fs.promises.cp(path.join(ROOT, 'gems/neurendipity'), path.join(root, 'neurendipity'), { recursive: true });
  await fs.promises.cp(path.join(ROOT, 'gems/fieldnote'), path.join(root, 'fieldnote'), { recursive: true });
  return root;
}

/**
 * Lean Six Sigma beside today's boot, from the lss-0.9.0 fixture. That copy has
 * released false and requires.emet >=0.3.0. A missing fixture fails the test.
 */
async function placeLss(root) {
  const dest = path.join(root, 'lean-six-sigma');
  assert.ok(fs.existsSync(path.join(LSS_FIXTURE, 'gem.json')), 'tests/fixtures/lss-0.9.0/lean-six-sigma is required');
  const commit = fs.readFileSync(path.join(LSS_FIXTURE, '..', 'COMMIT'), 'utf8');
  assert.match(commit, /lss-0\.9\.0/);
  assert.match(commit, /guides\/BELTS\.md/);
  assert.match(commit, /gem\.json/);
  assert.match(commit, /named a person/);
  await fs.promises.cp(LSS_FIXTURE, dest, { recursive: true });
  return dest;
}

function byId(seated) {
  return Object.fromEntries(seated.gems_available.map((row) => [row.id, row]));
}

async function loadSocketMutant(name, mutate) {
  const mutants = path.join(ROOT, 'tests/.mutants');
  await fs.promises.rm(mutants, { recursive: true, force: true });
  await fs.promises.mkdir(mutants, { recursive: true });
  const src = fs.readFileSync(path.join(ROOT, 'src/socket.js'), 'utf8');
  const out = mutate(src).replaceAll("from './", "from '../../src/");
  const file = path.join(mutants, name);
  await fs.promises.writeFile(file, out);
  return import(pathToFileURL(file).href);
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
      assert.strictEqual(seated.gems_available.length, 4);
      const row = seated.gems_available.find((g) => g.id === 'neurendipity');
      const note = seated.gems_available.find((g) => g.id === 'fieldnote');
      const backup = seated.gems_available.find((g) => g.id === 'bot-team-backup');
      const lss = seated.gems_available.find((g) => g.id === 'lean-six-sigma');
      assert.ok(row && note && backup && lss);
      assert.strictEqual(row.loadable, true, row.reason);
      assert.strictEqual(row.active, false);
      assert.strictEqual(row.defaultOn, false);
      assert.strictEqual(note.kind, 'runed-gem');
      assert.strictEqual(note.active, false);
      assert.strictEqual(note.defaultOn, false);
      assert.strictEqual(note.loadable, true, note.reason);
      assert.strictEqual(backup.kind, 'gem');
      assert.strictEqual(backup.active, false);
      assert.strictEqual(backup.defaultOn, false);
      assert.strictEqual(backup.loadable, true, backup.reason);
      assert.strictEqual(lss.kind, 'runed-gem');
      assert.strictEqual(lss.active, false);
      assert.strictEqual(lss.defaultOn, false);
      assert.strictEqual(lss.loadable, true, lss.reason);
      assert.strictEqual(lss.version, '0.9.0');
      assert.notStrictEqual(row.bytes, 953);
      assert.deepStrictEqual(seated.gems_active, []);
      assert.deepStrictEqual(heard.infos.map((row) => row.message), [
        'GEM seated: bot-team-backup',
        'GEM seated: fieldnote',
        'GEM seated: lean-six-sigma',
        'GEM seated: neurendipity',
        'GEMs seated: 4 installed, 0 active'
      ]);
      assert.strictEqual(heard.warnings.length, 0);
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
  test('the example, seated outside the release, is SR-08 and does not throw', async () => {
    const heard = quiet();
    const seated = await seatGems({ root: path.dirname(EXAMPLE), releaseRoot: releaseGemsRoot(), log: heard.log });
    assert.strictEqual(seated.gems_available.length, 1);
    const row = seated.gems_available[0];
    assert.strictEqual(row.id, 'neurendipity');
    assert.strictEqual(row.loadable, false);
    assert.strictEqual(row.active, false);
    assert.strictEqual(row.reason, 'SR-08');
    assert.strictEqual(seated.gems_active.length, 0);
    assert.strictEqual(heard.warnings.length, 1);
    assert.match(heard.warnings[0].message, /^GEM refused: neurendipity SR-08: released is missing/);
    assert.strictEqual(heard.warnings[0].context.reason, 'SR-08');
    assert.ok(!('stack' in heard.warnings[0].context));
  });
  test('a released GEM seated outside the release is SR-01', async () => {
    const release = await tempRelease(['neurendipity']);
    const other = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'emet-other-release-'));
    try {
      const seated = await seatGems({ root: release.root, releaseRoot: other, log: quiet().log });
      assert.strictEqual(seated.gems_available[0].loadable, false);
      assert.strictEqual(seated.gems_available[0].reason, 'SR-01');
    } finally {
      await release.cleanup();
      await fs.promises.rm(other, { recursive: true, force: true });
    }
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
  test('a runed-gem that passes the hash check is loadable, and its code does not run in the server', async () => {
    const marker = `GEM_SOCKET_${process.pid}`;
    const release = await tempRelease(['runner'], async (manifest, dir) => {
      manifest.kind = 'runed-gem';
      manifest.defaultOn = true;
      manifest.runes = [rune('look', { description: 'Count nothing. A call returns the code and does not run it.' })];
      await fs.promises.mkdir(path.join(dir, 'runes'));
      // Top-level throw: seating reads the file and must not evaluate it. The source stays legal for the load gate.
      await fs.promises.writeFile(path.join(dir, 'runes/look.js'), `throw new Error(${JSON.stringify(marker)});\nexport const x = 1;\n`);
      manifest.files.push({ path: 'runes/look.js', digest: 'sha256:' + 'ab'.repeat(32), size: 1 });
    });
    try {
      const seated = await seatGems({ root: release.root, releaseRoot: release.root, log: quiet().log });
      assert.strictEqual(seated.gems_available[0].loadable, true, seated.gems_available[0].reason);
      assert.strictEqual(seated.gems_available[0].active, true);
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
  test('a symlinked GEM folder is refused, not omitted', async () => {
    const release = await tempRelease(['neurendipity']);
    try {
      await fs.promises.symlink(path.join(release.root, 'neurendipity'), path.join(release.root, 'linked-gem'));
      const seated = await seatGems({ root: release.root, releaseRoot: release.root, log: quiet().log });
      const linked = seated.gems_available.find((row) => row.id === 'linked-gem');
      assert.ok(linked, seated.gems_available.map((row) => row.id).join(','));
      assert.strictEqual(linked.loadable, false);
      assert.strictEqual(linked.reason, 'GC-01');
      const real = seated.gems_available.find((row) => row.id === 'neurendipity');
      assert.ok(real);
      assert.strictEqual(real.loadable, true, real.reason);
    } finally { await release.cleanup(); }
  });
  test('the allowlist is the shipped neurendipity and fieldnote version and digests', () => {
    assert.deepStrictEqual(RELEASED_LEGACY.map((row) => row.id), ['neurendipity', 'fieldnote']);
    for (const pin of RELEASED_LEGACY) {
      const manifest = JSON.parse(fs.readFileSync(path.join(releaseGemsRoot(), pin.id, 'gem.json'), 'utf8'));
      assert.strictEqual(manifest.id, pin.id);
      assert.strictEqual(manifest.version, pin.version);
      assert.strictEqual(Object.prototype.hasOwnProperty.call(manifest, 'released'), false);
      assert.strictEqual(manifest.files.length, Object.keys(pin.digests).length);
      for (const file of manifest.files) assert.strictEqual(pin.digests[file.path], file.digest, file.path);
    }
    assert.match(releasedReason(null), /released is missing/);
    assert.match(releasedReason({ released: null }), /got null/);
  });
  test('today\'s boot seats the shipped GEMs, and refuses LSS unless released is true', async () => {
    const root = await bootToday();
    const lss = await placeLss(root);
    const ledger = path.join(root, 'ledger');
    try {
      const missing = quiet();
      let seated = await seatGems({ root, releaseRoot: root, log: missing.log });
      let rows = byId(seated);
      assert.strictEqual(rows.neurendipity.loadable, true, rows.neurendipity.reason);
      assert.strictEqual(rows.fieldnote.loadable, true, rows.fieldnote.reason);
      const fixtureManifest = JSON.parse(await fs.promises.readFile(path.join(lss, 'gem.json'), 'utf8'));
      assert.strictEqual(fixtureManifest.released, false);
      assert.strictEqual(fixtureManifest.requires.emet, '>=0.3.0');
      assert.strictEqual(rows['lean-six-sigma'].loadable, false);
      assert.strictEqual(rows['lean-six-sigma'].reason, 'SR-08');
      assert.match(missing.warnings.map((row) => row.message).join('\n'), /GEM refused: lean-six-sigma SR-08: released must be boolean true, got boolean false/);
      assert.ok(missing.infos.some((row) => row.message === 'GEM seated: neurendipity'));
      assert.ok(missing.infos.some((row) => row.message === 'GEM seated: fieldnote'));
      assert.ok(!missing.infos.some((row) => row.message === 'GEM seated: lean-six-sigma'));

      await setReleased(path.join(root, 'neurendipity'), false);
      const pinnedFalse = quiet();
      seated = await seatGems({ root, releaseRoot: root, log: pinnedFalse.log });
      rows = byId(seated);
      assert.strictEqual(rows.neurendipity.loadable, false);
      assert.strictEqual(rows.neurendipity.reason, 'SR-08');
      assert.match(pinnedFalse.warnings.map((row) => row.message).join('\n'), /neurendipity SR-08: released must be boolean true, got boolean false/);
      await setReleased(path.join(root, 'neurendipity'), undefined);
      seated = await seatGems({ root, releaseRoot: root, log: quiet().log });
      assert.strictEqual(byId(seated).neurendipity.loadable, true, byId(seated).neurendipity.reason);

      const cases = [
        [false, /got boolean false/],
        ['true', /got string "true"/],
        [1, /got number 1/],
        [null, /got null/]
      ];
      for (const [value, pattern] of cases) {
        await setReleased(lss, value);
        const heard = quiet();
        seated = await seatGems({ root, releaseRoot: root, asked: ['lean-six-sigma'], log: heard.log });
        rows = byId(seated);
        assert.strictEqual(rows['lean-six-sigma'].loadable, false, String(value));
        assert.strictEqual(rows['lean-six-sigma'].reason, 'SR-08', String(value));
        assert.strictEqual(rows['lean-six-sigma'].active, false);
        assert.strictEqual(rows.neurendipity.loadable, true, rows.neurendipity.reason);
        assert.strictEqual(rows.fieldnote.loadable, true, rows.fieldnote.reason);
        assert.match(heard.warnings.map((row) => row.message).join('\n'), pattern);
      }

      await setReleased(lss, true);
      seated = await seatGems({ root, releaseRoot: root, log: quiet().log });
      rows = byId(seated);
      assert.strictEqual(rows['lean-six-sigma'].loadable, false);
      assert.strictEqual(rows['lean-six-sigma'].reason, 'SR-06');
      await writeGemJson(lss, (manifest) => { manifest.requires.emet = '>=0.2.6'; });
      seated = await seatGems({ root, releaseRoot: root, log: quiet().log });
      rows = byId(seated);
      assert.strictEqual(rows['lean-six-sigma'].loadable, true, rows['lean-six-sigma'].reason);
      assert.strictEqual(rows.neurendipity.loadable, true, rows.neurendipity.reason);
      assert.strictEqual(rows.fieldnote.loadable, true, rows.fieldnote.reason);

      await fs.promises.cp(path.join(root, 'neurendipity'), ledger, { recursive: true });
      await writeGemJson(ledger, (manifest) => { manifest.id = 'ledger'; });
      const unlisted = quiet();
      seated = await seatGems({ root, releaseRoot: root, log: unlisted.log });
      rows = byId(seated);
      assert.strictEqual(rows.ledger.loadable, false);
      assert.strictEqual(rows.ledger.reason, 'SR-08');
      assert.match(unlisted.warnings.map((row) => row.message).join('\n'), /GEM refused: ledger SR-08: released is missing/);
      assert.strictEqual(rows.neurendipity.loadable, true, rows.neurendipity.reason);
      assert.strictEqual(rows.fieldnote.loadable, true, rows.fieldnote.reason);

      await setReleased(lss, false);
      await fs.promises.rm(path.join(root, 'fieldnote'), { recursive: true, force: true });
      const deleted = quiet();
      seated = await seatGems({ root, releaseRoot: root, asked: ['lean-six-sigma'], log: deleted.log });
      rows = byId(seated);
      assert.strictEqual(rows.fieldnote, undefined);
      assert.strictEqual(rows['lean-six-sigma'].loadable, false);
      assert.strictEqual(rows['lean-six-sigma'].reason, 'SR-08');
      assert.match(deleted.warnings.map((row) => row.message).join('\n'), /got boolean false/);
      assert.strictEqual(rows.neurendipity.loadable, true, rows.neurendipity.reason);

      await fs.promises.mkdir(path.join(root, 'fieldnote'));
      await fs.promises.writeFile(path.join(root, 'fieldnote', 'gem.json'), '{');
      const corrupt = quiet();
      seated = await seatGems({ root, releaseRoot: root, log: corrupt.log });
      rows = byId(seated);
      assert.strictEqual(rows.fieldnote.loadable, false);
      assert.notStrictEqual(rows.fieldnote.reason, null);
      assert.strictEqual(rows['lean-six-sigma'].loadable, false);
      assert.strictEqual(rows['lean-six-sigma'].reason, 'SR-08');
      assert.strictEqual(rows.neurendipity.loadable, true, rows.neurendipity.reason);
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });
  test('a bumped version or a different digest with no released field is refused', async () => {
    const root = await bootToday();
    try {
      await writeGemJson(path.join(root, 'neurendipity'), (manifest) => { manifest.version = '1.2.4'; });
      let seated = await seatGems({ root, releaseRoot: root, log: quiet().log });
      let rows = byId(seated);
      assert.strictEqual(rows.neurendipity.loadable, false);
      assert.strictEqual(rows.neurendipity.reason, 'SR-08');
      const heard = quiet();
      seated = await seatGems({ root, releaseRoot: root, log: heard.log });
      assert.match(heard.warnings.map((row) => row.message).join('\n'), /neurendipity SR-08: released is missing/);
      assert.strictEqual(byId(seated).fieldnote.loadable, true);

      const floorPath = path.join(root, 'neurendipity', 'floor.json');
      const floorText = await fs.promises.readFile(floorPath, 'utf8');
      const edited = floorText.replace('Reading People', 'Reading Person');
      assert.notStrictEqual(edited, floorText);
      await fs.promises.writeFile(floorPath, edited);
      await writeGemJson(path.join(root, 'neurendipity'), (manifest) => {
        manifest.version = '1.2.3';
        const entry = manifest.files.find((file) => file.path === 'floor.json');
        const buf = fs.readFileSync(floorPath);
        entry.size = buf.length;
        entry.digest = sha256(buf);
      });
      seated = await seatGems({ root, releaseRoot: root, log: quiet().log });
      rows = byId(seated);
      assert.strictEqual(rows.neurendipity.loadable, false, rows.neurendipity.reason);
      assert.strictEqual(rows.neurendipity.reason, 'SR-08');
      assert.strictEqual(rows.fieldnote.loadable, true, rows.fieldnote.reason);
      assert.match(heard.warnings.map((row) => row.message).join('\n'), /legacy pin mismatch: version\/digests/);
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });
  test('the legacy pin hint is only for a pinned id that missed the pin', async () => {
    const root = await bootToday();
    const lss = await placeLss(root);
    try {
      await setReleased(lss, undefined);
      await writeGemJson(path.join(root, 'neurendipity'), (manifest) => { manifest.version = '1.2.4'; });
      const heard = quiet();
      const seated = await seatGems({ root, releaseRoot: root, log: heard.log });
      const lines = heard.warnings.map((row) => row.message);
      assert.strictEqual(byId(seated)['lean-six-sigma'].reason, 'SR-08');
      assert.strictEqual(byId(seated).neurendipity.reason, 'SR-08');
      assert.strictEqual(
        lines.find((line) => line.includes('lean-six-sigma')),
        'GEM refused: lean-six-sigma SR-08: released is missing; boolean true is required'
      );
      assert.ok(lines.includes('GEM refused: neurendipity SR-08: released is missing; boolean true is required (legacy pin mismatch: version/digests)'));
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });
  test('a near-miss id with no released field gets no legacy pin hint', async () => {
    const root = await bootToday();
    const near = ['neurendipity-x', 'xneurendipity'];
    const plain = 'released is missing; boolean true is required';
    try {
      for (const id of near) {
        const dir = path.join(root, id);
        await fs.promises.cp(path.join(ROOT, 'gems/neurendipity'), dir, { recursive: true });
        await writeGemJson(dir, (manifest) => { manifest.id = id; });
      }
      const heard = quiet();
      const seated = await seatGems({ root, releaseRoot: root, log: heard.log });
      const lines = heard.warnings.map((row) => row.message);
      for (const id of near) {
        assert.strictEqual(byId(seated)[id].reason, 'SR-08', id);
        assert.strictEqual(lines.find((line) => line.startsWith(`GEM refused: ${id} `)), `GEM refused: ${id} SR-08: ${plain}`);
        assert.strictEqual(releasedReason({ id, version: '1.2.3' }), plain, id);
      }
      assert.strictEqual(releasedReason({ id: 'Fieldnote', version: '1.0.1' }), plain);
      assert.match(releasedReason({ id: 'neurendipity', version: '1.2.4' }), /legacy pin mismatch: version\/digests/);
      assert.match(releasedReason({ id: 'fieldnote', version: '1.0.2' }), /legacy pin mismatch: version\/digests/);
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });
  test('a pinned GEM whose file list is only floor.json is refused SR-08', async () => {
    const root = await bootToday();
    try {
      await dropNeurendipityFiles(root, [
        'guides/NEURODIVERGENT_SUPPORT.md',
        'guides/AUTISTIC_BURNOUT.md'
      ]);
      const heard = quiet();
      const seated = await seatGems({ root, releaseRoot: root, log: heard.log });
      const row = byId(seated).neurendipity;
      assert.strictEqual(row.loadable, false, row.reason);
      assert.strictEqual(row.reason, 'SR-08');
      assert.match(heard.warnings.map((line) => line.message).join('\n'), /GEM refused: neurendipity SR-08: released is missing; boolean true is required \(legacy pin mismatch: version\/digests\)/);
      assert.strictEqual(byId(seated).fieldnote.loadable, true, byId(seated).fieldnote.reason);
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });
  test('neurendipity 1.2.3 with AUTISTIC_BURNOUT.md dropped from the manifest and disk is refused SR-08', async () => {
    const root = await bootToday();
    try {
      await dropNeurendipityFiles(root, ['guides/AUTISTIC_BURNOUT.md']);
      const manifest = JSON.parse(await fs.promises.readFile(path.join(root, 'neurendipity', 'gem.json'), 'utf8'));
      assert.strictEqual(manifest.version, '1.2.3');
      assert.strictEqual(manifest.files.some((file) => file.path === 'guides/AUTISTIC_BURNOUT.md'), false);
      assert.strictEqual(fs.existsSync(path.join(root, 'neurendipity', 'guides/AUTISTIC_BURNOUT.md')), false);
      const heard = quiet();
      const seated = await seatGems({ root, releaseRoot: root, log: heard.log });
      const row = byId(seated).neurendipity;
      assert.strictEqual(row.loadable, false, row.reason);
      assert.strictEqual(row.reason, 'SR-08');
      assert.match(heard.warnings.map((line) => line.message).join('\n'), /legacy pin mismatch: version\/digests/);
      assert.strictEqual(byId(seated).fieldnote.loadable, true, byId(seated).fieldnote.reason);
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });
  test('dropping the file-count pin seats a subset manifest', async () => {
    const root = await bootToday();
    const mutants = path.join(ROOT, 'tests/.mutants');
    try {
      await dropNeurendipityFiles(root, ['guides/AUTISTIC_BURNOUT.md']);
      const real = await seatGems({ root, releaseRoot: root, log: quiet().log });
      assert.strictEqual(byId(real).neurendipity.reason, 'SR-08');
      const from = '  if (files.length !== keys.length) return false;\n';
      const mod = await loadSocketMutant('released-subset.mjs', (src) => {
        assert.strictEqual(src.split(from).length - 1, 1);
        return src.replace(from, '');
      });
      const seated = await mod.seatGems({ root, releaseRoot: root, log: quiet().log });
      const row = byId(seated).neurendipity;
      assert.strictEqual(row.loadable, true, 'subset still refused without the length check');
    } finally {
      await fs.promises.rm(mutants, { recursive: true, force: true });
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });
  test('two candidates that share an id keep their own refusal', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'emet-shared-id-'));
    try {
      const source = path.join(ROOT, 'gems/neurendipity');
      await fs.promises.cp(source, path.join(root, 'lean-six-sigma'), { recursive: true });
      await writeGemJson(path.join(root, 'lean-six-sigma'), (manifest) => {
        manifest.id = 'lean-six-sigma';
        manifest.released = false;
      });
      await fs.promises.cp(source, path.join(root, 'other'), { recursive: true });
      await writeGemJson(path.join(root, 'other'), (manifest) => {
        manifest.id = 'lean-six-sigma';
        manifest.released = true;
      });
      await fs.promises.appendFile(path.join(root, 'other', 'floor.json'), '\n');
      const heard = quiet();
      const seated = await seatGems({ root, releaseRoot: root, log: heard.log });
      const shared = seated.gems_available.filter((row) => row.id === 'lean-six-sigma');
      assert.strictEqual(shared.length, 2, seated.gems_available.map((row) => `${row.id}:${row.reason}`).join(','));
      const lines = heard.warnings.map((row) => row.message);
      const sr = lines.find((line) => line.includes('SR-08'));
      const gc = lines.find((line) => line.includes('GC-'));
      assert.match(sr, /^GEM refused: lean-six-sigma SR-08: released must be boolean true, got boolean false$/);
      assert.match(gc, /^GEM refused: lean-six-sigma GC-/);
      assert.doesNotMatch(gc, /released/);
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });
  test('restoring the global switch seats LSS false once fieldnote is gone', async () => {
    const root = await bootToday();
    const lss = await placeLss(root);
    const mutants = path.join(ROOT, 'tests/.mutants');
    try {
      await setReleased(lss, false);
      await writeGemJson(lss, (manifest) => { manifest.requires.emet = '>=0.2.6'; });
      await fs.promises.rm(path.join(root, 'fieldnote'), { recursive: true, force: true });
      const real = await seatGems({ root, releaseRoot: root, asked: ['lean-six-sigma'], log: quiet().log });
      assert.strictEqual(byId(real)['lean-six-sigma'].reason, 'SR-08');
      const always = `    const why = releasedReason(candidate.manifest); // sr-08-always
    if (why) {
      candidate.loadable = false;
      candidate.active = false;
      candidate.reason = 'SR-08';
      candidate.releasedWhy = why;
      return;
    }`;
      const gated = `    if (enforceReleased) {
      const why = releasedReason(candidate.manifest);
      if (why) {
        candidate.loadable = false;
        candidate.active = false;
        candidate.reason = 'SR-08';
        candidate.releasedWhy = why;
        return;
      }
    }`;
      const loop = '  candidates.forEach((candidate, index) => {';
      const switched = `  const enforceReleased = options.enforceReleased === true || (options.enforceReleased !== false && await releasedGateOpen(releaseReal));
  candidates.forEach((candidate, index) => {`;
      const gateFn = `async function releasedGateOpen(releaseReal) {
  if (!releaseReal) return false;
  for (const id of ['fieldnote', 'neurendipity']) {
    let text;
    try { text = await fs.promises.readFile(path.join(releaseReal, id, 'gem.json'), 'utf8'); }
    catch { return false; }
    let manifest;
    try { manifest = JSON.parse(text); }
    catch { return false; }
    if (!manifest || manifest.released !== true) return false;
  }
  return true;
}

`;
      const mod = await loadSocketMutant('released-switch.mjs', (src) => {
        assert.strictEqual(src.split(always).length - 1, 1);
        assert.strictEqual(src.split(loop).length - 1, 1);
        const next = src.replace(always, gated).replace(loop, switched);
        assert.notStrictEqual(next, src);
        return next.replace('export async function seatGems(options = {}) {', gateFn + 'export async function seatGems(options = {}) {');
      });
      const seated = await mod.seatGems({ root, releaseRoot: root, asked: ['lean-six-sigma'], log: quiet().log });
      const row = byId(seated)['lean-six-sigma'];
      assert.strictEqual(row.loadable, true, 'old condition still refused LSS');
    } finally {
      await fs.promises.rm(mutants, { recursive: true, force: true });
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });
  test('widening the allowlist seats a bumped neurendipity with no released field', async () => {
    const root = await bootToday();
    const mutants = path.join(ROOT, 'tests/.mutants');
    try {
      await fs.promises.rm(path.join(root, 'fieldnote'), { recursive: true, force: true });
      await writeGemJson(path.join(root, 'neurendipity'), (manifest) => { manifest.version = '1.2.4'; });
      const real = await seatGems({ root, releaseRoot: root, log: quiet().log });
      assert.strictEqual(byId(real).neurendipity.reason, 'SR-08');
      const from = 'if (!pin || manifest.version !== pin.version || !legacyDigests(manifest, pin)) return false; // legacy-pin';
      const to = 'if (!pin) return false; // legacy-pin';
      const mod = await loadSocketMutant('released-widen.mjs', (src) => {
        assert.strictEqual(src.split(from).length - 1, 1);
        return src.replace(from, to);
      });
      const seated = await mod.seatGems({ root, releaseRoot: root, log: quiet().log });
      const row = byId(seated).neurendipity;
      assert.strictEqual(row.loadable, true, 'widened allowlist still refused the bumped version');
    } finally {
      await fs.promises.rm(mutants, { recursive: true, force: true });
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });
  test('a symlink that is not a directory is refused, not skipped', async () => {
    const release = await tempRelease(['neurendipity']);
    try {
      await fs.promises.symlink(path.join(release.root, 'neurendipity', 'gem.json'), path.join(release.root, 'notadir'));
      const seated = await seatGems({ root: release.root, releaseRoot: release.root, log: quiet().log });
      const row = seated.gems_available.find((item) => item.id === 'notadir');
      assert.ok(row, seated.gems_available.map((item) => item.id).join(','));
      assert.strictEqual(row.loadable, false);
      assert.strictEqual(row.reason, 'GC-01');
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
    assert.strictEqual(full.gems_available.length, 4);
    const row = full.gems_available.find((g) => g.id === 'neurendipity');
    const note = full.gems_available.find((g) => g.id === 'fieldnote');
    assert.ok(row && note);
    assert.strictEqual(row.active, false);
    assert.strictEqual(row.loadable, true);
    assert.strictEqual(note.active, false);
    assert.strictEqual(note.loadable, true, note.reason);
    assert.deepStrictEqual(full.gems_active, []);
    const line = 'neurendipity, Neurendipity, off';
    const noteLine = 'fieldnote, Fieldnote, off';
    const lssLine = 'lean-six-sigma, Lean Six Sigma, off';
    assert.ok(full.instructions.includes(line));
    assert.ok(full.instructions.includes(noteLine));
    assert.ok(full.instructions.includes(lssLine));
    assert.ok(full.instructions_short.includes(lssLine));
    assert.ok(full.instructions_short.includes(line));
    assert.ok(full.instructions_short.includes(noteLine));
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
    assert.deepStrictEqual(pages.assemblePages(laid.pages).gems_available.map((g) => g.id), ['bot-team-backup', 'fieldnote', 'lean-six-sigma', 'neurendipity']);
    assert.deepStrictEqual(pages.assemblePages(laid.pages).gems_active, []);
    const abridged = abridgeReadyPayload(full);
    assert.deepStrictEqual(abridged.gems_available.map((g) => g.id), ['bot-team-backup', 'fieldnote', 'lean-six-sigma', 'neurendipity']);
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
    assert.deepStrictEqual(body.gems_available.map((g) => g.id), ['bot-team-backup', 'fieldnote', 'lean-six-sigma', 'neurendipity']);
    assert.ok(body.gems_available.every((g) => g.active === false));
    assert.deepStrictEqual(body.gems_active, []);
    assert.ok(body.instructions.includes('neurendipity, Neurendipity, off'));
    assert.ok(body.instructions.includes('fieldnote, Fieldnote, off'));
    assert.ok(body.instructions.includes('lean-six-sigma, Lean Six Sigma, off'));
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
      assert.deepStrictEqual(ids, ['bot-team-backup', 'broken', 'fieldnote', 'lean-six-sigma', 'neurendipity']);
      const refused = full.gems_available.find((g) => g.id === 'broken');
      assert.strictEqual(refused.loadable, false);
      assert.strictEqual(refused.active, false);
      assert.strictEqual(refused.reason, 'GC-01');
      assert.strictEqual(full.gems_available.find((g) => g.id === 'neurendipity').loadable, true);
      assert.ok(full.instructions.includes('broken'));
      assert.ok(!full.instructions.includes('not json'));
      const refusedLines = lines.filter((line) => line.includes('GEM refused:'));
      assert.ok(refusedLines.some((line) => line.includes('GEM refused: broken GC-01')));
      assert.strictEqual(full.gems_available.find((g) => g.id === 'fieldnote').loadable, true);
      assert.strictEqual(refusedLines.length, 1);
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
      const neu = shipped.gems_available.find((g) => g.id === 'neurendipity');
      const note = shipped.gems_available.find((g) => g.id === 'fieldnote');
      assert.strictEqual(neu.active, true);
      assert.strictEqual(note.active, false);
      assert.strictEqual(shipped.gems_active.length, 1);
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

testGroup('socket PR 4: each GEM byte cost for emet_status', () => {
  test('an empty seating reports zero cost and the enforced caps', async () => {
    const cost = gemCost({ gems_available: [], gems_active: [] });
    assert.deepStrictEqual(cost, {
      installed: 0, active: 0, active_floor_bytes: 0, headroom_bytes: MAX_ACTIVE_FLOOR_BYTES,
      caps: { max_installed: MAX_INSTALLED, max_active: MAX_ACTIVE, max_active_floor_bytes: MAX_ACTIVE_FLOOR_BYTES },
      per_gem: []
    });
    assert.deepStrictEqual(gemCost(undefined).per_gem, []);
  });
  test('an active GEM counts its trusted floor bytes; an off GEM is listed but not counted', async () => {
    const release = await tempRelease(['neurendipity']);
    try {
      const on = await seatGems({ root: release.root, releaseRoot: release.root, asked: ['neurendipity'], log: quiet().log });
      const onCost = gemCost(on);
      const row = onCost.per_gem[0];
      assert.strictEqual(row.id, 'neurendipity');
      assert.strictEqual(row.active, true);
      assert.ok(row.bytes > 0);
      assert.strictEqual(row.bytes, on.gems_available[0].bytes);
      assert.strictEqual(onCost.active_floor_bytes, row.bytes);
      assert.strictEqual(onCost.headroom_bytes, MAX_ACTIVE_FLOOR_BYTES - row.bytes);
      assert.ok(onCost.active_floor_bytes <= MAX_ACTIVE_FLOOR_BYTES);
      const off = await seatGems({ root: release.root, releaseRoot: release.root, asked: [], log: quiet().log });
      const offCost = gemCost(off);
      assert.strictEqual(offCost.installed, 1);
      assert.strictEqual(offCost.active, 0);
      assert.strictEqual(offCost.active_floor_bytes, 0);
      assert.ok(offCost.per_gem[0].bytes > 0);
      assert.ok(!JSON.stringify(onCost).includes('reading_people'), 'cost view carries no floor text');
    } finally { await release.cleanup(); }
  });
  test('a refused GEM keeps its reason and costs nothing', async () => {
    const release = await tempRelease(['neurendipity'], (manifest) => {
      manifest.overrides = ['voice.concrete'];
      manifest.defaultOn = false;
    });
    try {
      const seated = await seatGems({ root: release.root, releaseRoot: release.root, asked: ['neurendipity'], log: quiet().log });
      const cost = gemCost(seated);
      assert.strictEqual(cost.per_gem[0].loadable, false);
      assert.strictEqual(cost.per_gem[0].reason, 'SR-05');
      assert.strictEqual(cost.active_floor_bytes, 0);
    } finally { await release.cleanup(); }
  });
});

summary('GEM socket');
