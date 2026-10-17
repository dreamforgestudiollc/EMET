/**
 * One tool per active RUNE. The call returns the code and does not run it.
 * A kept result is sealed on the write path already in use.
 */
import { test, testGroup, summary } from './harness.js';
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { layerHonouringDb, makeStore } from './memstore.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { seatGems, releaseGemsRoot } = await import('../src/socket.js');
const { runeToolList, activeRune, bindRunes, reserveToolNames, metadataGemClause } = await import('../src/rune-registry.js');
const { serveRune, servePrincipal, matchServe, sealAttestation, resultsForArtifact, artifactRecord, setServeLogPath, appendServeStore, SERVE_CAP, SERVE_COLLECTION } = await import('../src/rune-dispatch.js');
const serveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emet-serves-'));
const serveLogFile = path.join(serveDir, 'gem-serves.json');
setServeLogPath(serveLogFile);
function removeServeDir() {
  fs.rmSync(serveDir, { recursive: true, force: true });
}
process.on('exit', removeServeDir);
const repoLog = path.join(ROOT, 'logs/gem-serves.json');
const repoLogBefore = fs.existsSync(repoLog) ? fs.readFileSync(repoLog) : null;
const { saveMemory, reviseMemory } = await import('../src/tools.js');
const { dispatchTool } = await import('../src/dispatch.js');
const { actorStore } = await import('../src/persons.js');
const { scopeForTool } = await import('../src/scopes.js');
const { gemStartupLine } = await import('../src/setup.js');
const { AuditOperation } = await import('../src/logger.js');

const log = { warn() {}, info() {}, error() {} };
const HEX = (byte) => 'sha256:' + byte.repeat(32);
const audits = [];
const logger = {
  audit(op, details) { audits.push({ op, details }); },
  error() {}, warn() {}, info() {}
};

function dataOf(res) {
  return JSON.parse(res.content[0].text).data;
}

function openDb() {
  const store = layerHonouringDb();
  store.transcriptPosition = async (sid) => ({ base: sid, highest: 0 });
  return store;
}

function queryable(db) {
  return {
    collectionFor(layer) {
      return {
        find(q) {
          return {
            async toArray() {
              const want = q['metadata.served_sha256'];
              return Object.values(db.byLayer[layer] || []).filter((row) => row.metadata && row.metadata.served_sha256 === want);
            }
          };
        }
      };
    }
  };
}

testGroup('one tool per RUNE, and it runs nothing', () => {
  test('fieldnote off registers nothing; asked, it serves the code', async () => {
    const off = await seatGems({ log });
    const note = off.gems_available.find((g) => g.id === 'fieldnote');
    assert.strictEqual(note.loadable, true, note.reason);
    assert.strictEqual(note.active, false);
    assert.strictEqual(note.defaultOn, false);
    assert.deepStrictEqual(runeToolList(), []);
    const offLine = gemStartupLine(off.gems_available);
    assert.match(offLine, /fieldnote, Fieldnote, off/);
    assert.doesNotMatch(offLine, /runtime node/);

    const asked = await seatGems({ asked: ['fieldnote'], log });
    const on = asked.gems_available.find((g) => g.id === 'fieldnote');
    assert.strictEqual(on.active, true);
    const tool = runeToolList().find((row) => row.name === 'gem_fieldnote__fieldnote');
    assert.ok(tool, JSON.stringify(runeToolList().map((row) => row.name)));
    assert.strictEqual(tool.annotations.readOnlyHint, true);
    assert.strictEqual(tool.annotations.destructiveHint, false);
    assert.strictEqual(tool.annotations.openWorldHint, false);
    assert.strictEqual(tool.runtime, 'node');
    assert.strictEqual(tool.sha256, on.runes[0].sha256);
    assert.match(tool.description, /does not run it/);
    assert.match(tool.description, new RegExp(tool.sha256));
    assert.strictEqual(scopeForTool('gem_fieldnote__fieldnote'), 'emet.read');
    const line = gemStartupLine(asked.gems_available);
    assert.match(line, /fieldnote, Fieldnote, on fieldnote runtime node inputs rows outputs count sha256 sha256:[a-f0-9]{64}/);

    const served = await serveRune('gem_fieldnote__fieldnote', { session_id: 's1' }, { logger, AuditOperation });
    const body = dataOf(served);
    const file = fs.readFileSync(path.join(ROOT, 'gems/fieldnote/runes/fieldnote.js'), 'utf8');
    assert.strictEqual(body.code, file);
    assert.strictEqual(body.sha256, tool.sha256);
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'gems/fieldnote/gem.json'), 'utf8'));
    assert.strictEqual(body.version, manifest.version);
    assert.strictEqual(body.runtime, 'node');
    assert.match(body.instructions, /EMET does not run it/);
    assert.ok(body.inputSchema.properties.rows);
    assert.ok(body.outputSchema.properties.count);
    assert.strictEqual(body.count, undefined);
    assert.strictEqual(audits.at(-1).op, 'GEM_SERVE');
    assert.strictEqual(audits.at(-1).details.principal, 'local');
    assert.strictEqual(audits.at(-1).details.session_id, 's1');
    assert.strictEqual(audits.at(-1).details.gem, 'fieldnote');
    assert.strictEqual(audits.at(-1).details.sha256, body.sha256);
    assert.strictEqual(await serveRune('not_a_rune', {}, { logger }), null);
  });

  test('the tool states the exact metadata.gem value', async () => {
    await seatGems({ asked: ['fieldnote'], log });
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'gems/fieldnote/gem.json'), 'utf8'));
    const value = `fieldnote@${manifest.version}`;
    const exact = metadataGemClause(activeRune('gem_fieldnote__fieldnote'));
    assert.strictEqual(exact, `To seal a result, set metadata.gem to \`${value}\`.`);
    const tool = runeToolList().find((row) => row.name === 'gem_fieldnote__fieldnote');
    const served = await serveRune('gem_fieldnote__fieldnote', { session_id: 'gem-form' }, { logger, AuditOperation });
    const servedDescription = dataOf(served).description;
    assert.ok(tool.description.endsWith(exact));
    assert.ok(servedDescription.endsWith(exact));
    assert.ok(tool.description.includes(`\`${value}\``));
    assert.ok(servedDescription.includes(`\`${value}\``));
    assert.ok(!tool.description.includes(`${value}.`));
    assert.ok(!servedDescription.includes(`${value}.`));
  });

  test('a read token may call it, and a write-only token may not', async () => {
    const denied = await actorStore.run(
      { transport: 'http', authenticated: true, scopes: ['emet.write'], personId: 'guest', clientId: 'c' },
      () => dispatchTool('gem_fieldnote__fieldnote', {}, { dbManager: null, logger: null })
    );
    assert.strictEqual(denied.isError, true);
    const allowed = await actorStore.run(
      { transport: 'http', authenticated: true, scopes: ['emet.read'], personId: 'guest', clientId: 'c', sourceTag: 'owner-login' },
      () => dispatchTool('gem_fieldnote__fieldnote', { session_id: 's-read' }, { dbManager: null, logger })
    );
    assert.notStrictEqual(allowed.isError, true);
    assert.strictEqual(dataOf(allowed).code.includes('function fieldnote'), true);
  });

  test('a reserved tool name is not registered', () => {
    reserveToolNames(['gem_sneak__look']);
    bindRunes([{
      gemId: 'sneak', name: 'look', description: 'no', runtime: 'node', sha256: HEX('ab'),
      inputSchema: { type: 'object' }, outputSchema: { type: 'object' },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    }]);
    assert.strictEqual(activeRune('gem_sneak__look'), null);
    bindRunes([]);
  });

  test('a copy outside the release is SR-01', async () => {
    const release = releaseGemsRoot();
    const root = await fs.promises.mkdtemp(path.join(path.dirname(release), 'emet-copy-'));
    try {
      await fs.promises.cp(path.join(release, 'fieldnote'), path.join(root, 'fieldnote'), { recursive: true });
      const seated = await seatGems({ root, releaseRoot: release, log });
      const row = seated.gems_available.find((g) => g.id === 'fieldnote');
      assert.strictEqual(row.loadable, false);
      assert.strictEqual(row.reason, 'SR-01');
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });

  test('src has no exemption flag for a GEM write', () => {
    const hits = [];
    const walk = (dir) => {
      for (const name of fs.readdirSync(dir)) {
        const abs = path.join(dir, name);
        if (fs.statSync(abs).isDirectory()) { walk(abs); continue; }
        if (!abs.endsWith('.js')) continue;
        if (/gemExempt|runeExempt|GEM_EXEMPT/.test(fs.readFileSync(abs, 'utf8'))) hits.push(abs);
      }
    };
    walk(path.join(ROOT, 'src'));
    assert.deepStrictEqual(hits, []);
  });

  test('swapping the RUNE file after load fails the serve', async () => {
    const release = await fs.promises.mkdtemp(path.join(path.dirname(releaseGemsRoot()), 'emet-swap-'));
    try {
      await fs.promises.cp(path.join(ROOT, 'gems/fieldnote'), path.join(release, 'fieldnote'), { recursive: true });
      const seated = await seatGems({ root: release, releaseRoot: release, asked: ['fieldnote'], bindRunes: true, log });
      const on = seated.gems_available.find((g) => g.id === 'fieldnote');
      assert.strictEqual(on.active, true, on.reason);
      const first = await serveRune('gem_fieldnote__fieldnote', { session_id: 'swap' }, { logger, AuditOperation });
      assert.notStrictEqual(first.isError, true);
      await fs.promises.writeFile(path.join(release, 'fieldnote/runes/fieldnote.js'), 'export default function fieldnote() { return { count: 9 }; }\n');
      const second = await serveRune('gem_fieldnote__fieldnote', { session_id: 'swap-2' }, { logger, AuditOperation });
      assert.strictEqual(second.isError, true);
      assert.match(second.content[0].text, /hash pin/);
    } finally {
      await fs.promises.rm(release, { recursive: true, force: true });
      await seatGems({ asked: ['fieldnote'], log });
    }
  });
});

testGroup('a kept result is sealed', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'gems/fieldnote/gem.json'), 'utf8'));
  const pin = manifest.runes[0].sha256;
  const kept = {
    source: 'test',
    assertion_origin: 'assistant',
    gem: `fieldnote@${manifest.version}`,
    rune: 'fieldnote',
    served_sha256: HEX('00'),
    client_sha256: HEX('11'),
    input_sha256: HEX('22'),
    principal: 'forged'
  };

  test('no serve event refuses the write, then the seal uses the server principal and the pin', async () => {
    await seatGems({ asked: ['fieldnote'], log });
    const db = openDb();
    await assert.rejects(
      () => saveMemory(db, 'counted 2', 'working', { ...kept }),
      (e) => /no serve event/.test(e.message)
    );
    await serveRune('gem_fieldnote__fieldnote', { session_id: 's1' }, { logger, AuditOperation });
    await assert.rejects(
      () => saveMemory(db, 'counted 2', 'working', { ...kept, client_sha256: 'nope' }, null, null, { session_id: 's1' }),
      (e) => /client-reported sha256/.test(e.message)
    );
    await assert.rejects(
      () => saveMemory(db, 'counted 2', 'working', { ...kept, input_sha256: '', input_ref: '' }, null, null, { session_id: 's1' }),
      (e) => /input hash/.test(e.message)
    );
    await assert.rejects(
      () => saveMemory(db, 'counted 2', 'working', { ...kept }, null, null, { session_id: 'other' }),
      (e) => /no serve event/.test(e.message)
    );
    const saved = await saveMemory(db, 'counted 2', 'working', { ...kept }, null, null, { session_id: 's1' });
    const row = db.row('working', saved.id);
    assert.strictEqual(row.metadata.principal, 'local');
    assert.strictEqual(row.metadata.served_sha256, pin);
    assert.strictEqual(row.metadata.client_sha256, HEX('11'));
    assert.strictEqual(row.metadata.input_sha256, HEX('22'));
    assert.strictEqual(row.metadata.gem, `fieldnote@${manifest.version}`);
    assert.strictEqual(row.metadata.version, manifest.version);
    assert.strictEqual(row.metadata.rune_attested, true);
    assert.notStrictEqual(row.metadata.principal, 'forged');

    const referred = await saveMemory(db, 'counted by ref', 'working', {
      ...kept, input_sha256: '', input_ref: 'working#1'
    }, null, null, { session_id: 's1' });
    const refRow = db.row('working', referred.id);
    assert.strictEqual(refRow.metadata.input_ref, 'working#1');
    assert.strictEqual(refRow.metadata.input_sha256, undefined);

    const plain = await saveMemory(db, 'ordinary note', 'working', {
      source: 'test', version: '1.0.0', principal: 'forged', client_sha256: HEX('11'),
      gem: 'fieldnote', rune_attested: true
    });
    const plainRow = db.row('working', plain.id);
    assert.strictEqual(plainRow.metadata.principal, undefined);
    assert.strictEqual(plainRow.metadata.client_sha256, undefined);
    assert.strictEqual(plainRow.metadata.gem, undefined);
    assert.strictEqual(plainRow.metadata.rune_attested, undefined);
    assert.strictEqual(plainRow.metadata.version, '1.0.0');
    const corrected = await reviseMemory(db, 'working', plain.id, 'ordinary note revised', { source: 'test', version: '2.0.0' });
    assert.strictEqual(db.row('working', corrected.id).metadata.version, '2.0.0');
  });

  test('a sealed result with no authenticated principal is refused', async () => {
    const db = openDb();
    await actorStore.run({
      transport: 'http', authenticated: true, personId: null, clientId: 'c'
    }, async () => {
      assert.strictEqual(servePrincipal(), null);
      await serveRune('gem_fieldnote__fieldnote', { session_id: 's-anon' }, { logger, AuditOperation });
      await assert.rejects(
        () => saveMemory(db, 'counted 2', 'working', { ...kept, principal: 'local' }, null, null, { session_id: 's-anon' }),
        (e) => /no authenticated principal/.test(e.message)
      );
    });
  });

  test('a sub-key principal replaces a forged one', async () => {
    const db = openDb();
    await actorStore.run({
      transport: 'http', personId: 'owner', clientId: 'login-1', sourceTag: 'owner-login', subkeyId: 'emk_test'
    }, async () => {
      assert.strictEqual(servePrincipal(), 'emk_test');
      await serveRune('gem_fieldnote__fieldnote', { session_id: 's-key' }, { logger, AuditOperation });
      const saved = await saveMemory(db, 'counted 1', 'working', { ...kept, principal: 'forged' }, null, null, { session_id: 's-key' });
      assert.strictEqual(db.row('working', saved.id).metadata.principal, 'emk_test');
    });
  });

  test('a later write cannot change the attestation', async () => {
    const db = openDb();
    await serveRune('gem_fieldnote__fieldnote', { session_id: 's1' }, { logger, AuditOperation });
    const saved = await saveMemory(db, 'counted 2', 'working', { ...kept }, null, null, { session_id: 's1' });
    await assert.rejects(
      () => reviseMemory(db, 'working', saved.id, 'counted 3', { served_sha256: HEX('33'), source: 'test' }),
      (e) => /attestation is immutable/.test(e.message)
    );
    await assert.rejects(
      () => reviseMemory(db, 'working', saved.id, 'counted 3', { version: '9.9.9', source: 'test' }),
      (e) => /attestation is immutable/.test(e.message)
    );
    const revised = await actorStore.run(
      { transport: 'http', personId: 'other', clientId: 'c2', sourceTag: 'other-login', subkeyId: 'emk_other' },
      () => reviseMemory(db, 'working', saved.id, 'counted 3', { source: 'test', assertion_origin: 'assistant' })
    );
    const child = db.row('working', revised.id);
    assert.strictEqual(child.metadata.served_sha256, pin);
    assert.strictEqual(child.metadata.principal, 'local');
    assert.strictEqual(child.metadata.client_sha256, HEX('11'));
    assert.strictEqual(child.metadata.input_sha256, HEX('22'));
  });

  test('a superseded hash still finds its results', async () => {
    const db = openDb();
    const index = JSON.parse(fs.readFileSync(path.join(ROOT, 'gems/artifact-index.json'), 'utf8'));
    const old = Object.keys(index).find((hash) => hash !== pin);
    assert.ok(old, 'the index keeps the superseded artifact');
    assert.strictEqual(artifactRecord(old).gem, 'fieldnote');
    await db.insertMemory('working', {
      content: 'old count', timestamp: 't', importance: 0.4, is_live: true,
      metadata: { served_sha256: old, gem: 'fieldnote@1.0.0', rune: 'fieldnote' }
    });
    await serveRune('gem_fieldnote__fieldnote', { session_id: 's1' }, { logger, AuditOperation });
    const saved = await saveMemory(db, 'counted 2', 'working', { ...kept }, null, null, { session_id: 's1' });
    const prior = await resultsForArtifact(queryable(db), old);
    const current = await resultsForArtifact(queryable(db), pin);
    assert.strictEqual(prior.artifact.version, '1.0.0');
    assert.ok(prior.results.some((row) => row.id !== saved.id && row.served_sha256 === old));
    assert.ok(current.results.some((row) => row.id === saved.id && row.served_sha256 === pin));
    assert.strictEqual(await sealAttestation({}), undefined);
    assert.strictEqual(current.artifact.version, manifest.version);
  });

  test('a serve row written on disk matches, and the cap is per principal', async () => {
    const prior = [{
      principal: 'local', session_id: 'from-disk', gem: 'fieldnote', rune: 'fieldnote',
      version: manifest.version, sha256: pin, time: 't'
    }];
    fs.writeFileSync(serveLogFile, JSON.stringify(prior));
    assert.ok(matchServe({ principal: 'local', session_id: 'from-disk', gem: 'fieldnote', rune: 'fieldnote', sha256: pin }));
    const db = openDb();
    const saved = await saveMemory(db, 'counted from disk', 'working', { ...kept }, null, null, { session_id: 'from-disk' });
    assert.strictEqual(db.row('working', saved.id).metadata.principal, 'local');
    assert.strictEqual(db.row('working', saved.id).metadata.served_sha256, pin);
    const padded = [];
    for (let i = 0; i < 200; i++) {
      padded.push({ principal: 'emk_other', session_id: `keep-${i}`, gem: 'fieldnote', rune: 'fieldnote', sha256: pin, time: 't' });
    }
    for (let i = 0; i < 205; i++) {
      padded.push({ principal: 'local', session_id: `cap-${i}`, gem: 'fieldnote', rune: 'fieldnote', sha256: pin, time: 't' });
    }
    fs.writeFileSync(serveLogFile, JSON.stringify(padded));
    await serveRune('gem_fieldnote__fieldnote', { session_id: 'cap-last' }, { logger, AuditOperation });
    const keptRows = JSON.parse(fs.readFileSync(serveLogFile, 'utf8'));
    const localRows = keptRows.filter((row) => row.principal === 'local');
    const otherRows = keptRows.filter((row) => row.principal === 'emk_other');
    assert.ok(localRows.length <= 200);
    assert.strictEqual(otherRows.length, 200);
    assert.strictEqual(otherRows[0].session_id, 'keep-0');
    assert.strictEqual(keptRows.at(-1).session_id, 'cap-last');
    assert.strictEqual(matchServe({ principal: 'local', session_id: 'cap-0', gem: 'fieldnote', rune: 'fieldnote', sha256: pin }), null);
    assert.ok(matchServe({ principal: 'emk_other', session_id: 'keep-0', gem: 'fieldnote', rune: 'fieldnote', sha256: pin }));
    const after = fs.existsSync(repoLog) ? fs.readFileSync(repoLog) : null;
    assert.strictEqual(after === null, repoLogBefore === null);
    if (repoLogBefore) assert.ok(repoLogBefore.equals(after));
  });

  test('concurrent serves do not share one temp file', async () => {
    const seen = [];
    const orig = fs.writeFileSync;
    fs.writeFileSync = (file, data, opts) => {
      seen.push(String(file));
      return orig(file, data, opts);
    };
    try {
      await Promise.all([
        serveRune('gem_fieldnote__fieldnote', { session_id: 'race-a' }, { logger, AuditOperation }),
        serveRune('gem_fieldnote__fieldnote', { session_id: 'race-b' }, { logger, AuditOperation })
      ]);
    } finally {
      fs.writeFileSync = orig;
    }
    const body = JSON.parse(fs.readFileSync(serveLogFile, 'utf8'));
    assert.ok(body.some((row) => row.session_id === 'race-a'));
    assert.ok(body.some((row) => row.session_id === 'race-b'));
    const tmps = seen.filter((file) => file.endsWith('.tmp'));
    assert.ok(tmps.length >= 2);
    assert.strictEqual(new Set(tmps).size, tmps.length);
    assert.ok(tmps.every((file) => !file.endsWith('gem-serves.json.tmp')));
  });

  test('one process records one serve at a time', async () => {
    const store = makeStore();
    const col = store.collection(SERVE_COLLECTION);
    const orig = col.insertOne.bind(col);
    let inflight = 0;
    let max = 0;
    col.insertOne = async (doc) => {
      inflight++;
      max = Math.max(max, inflight);
      await new Promise((resolve) => setTimeout(resolve, 30));
      inflight--;
      return orig(doc);
    };
    await Promise.all([
      serveRune('gem_fieldnote__fieldnote', { session_id: 'lock-a' }, { logger, AuditOperation, db: store }),
      serveRune('gem_fieldnote__fieldnote', { session_id: 'lock-b' }, { logger, AuditOperation, db: store })
    ]);
    assert.strictEqual(max, 1);
    const body = JSON.parse(fs.readFileSync(serveLogFile, 'utf8'));
    assert.ok(body.some((row) => row.session_id === 'lock-a'));
    assert.ok(body.some((row) => row.session_id === 'lock-b'));
  });

  test('two processes cannot drop each other\'s serve rows', async () => {
    // insertOne keeps both. A shared rewrite of one document keeps the last
    // writer only. This fails when that rewrite replaces the insert.
    const docs = [];
    let finds = 0;
    let releaseFirst = null;
    const col = {
      async insertOne(doc) {
        docs.push({ ...doc });
        return { insertedId: doc._id };
      },
      async findOne() {
        finds += 1;
        if (finds === 1) {
          await new Promise((resolve) => {
            releaseFirst = resolve;
            setTimeout(resolve, 400);
          });
        } else if (releaseFirst) releaseFirst();
        return null;
      },
      async updateOne(_q, update) {
        const set = update && update.$set;
        const rows = set && Array.isArray(set.rows) ? set.rows : [set];
        docs.length = 0;
        docs.push({ rows });
        return { matchedCount: 1, modifiedCount: 1, upsertedCount: 1 };
      }
    };
    const db = { collection() { return col; } };
    const event = (session_id) => ({
      principal: 'local', session_id, gem: 'fieldnote', rune: 'fieldnote',
      version: manifest.version, sha256: pin, time: 't'
    });
    await Promise.all([
      appendServeStore(db, event('proc-a')),
      appendServeStore(db, event('proc-b'))
    ]);
    assert.ok(docs.some((row) => row.session_id === 'proc-a'));
    assert.ok(docs.some((row) => row.session_id === 'proc-b'));
  });

  test('the store keeps every row while the file keeps SERVE_CAP', async () => {
    const store = makeStore();
    const col = store.collection(SERVE_COLLECTION);
    await col.insertOne({
      _id: 'other-row',
      principal: 'emk_other', session_id: 'stay', gem: 'fieldnote', rune: 'fieldnote',
      version: manifest.version, sha256: pin, time: '2020-01-01T00:00:00.000Z'
    });
    const before = JSON.parse(fs.readFileSync(serveLogFile, 'utf8'));
    const otherBefore = before.filter((row) => row.principal === 'emk_other').length;
    for (let i = 0; i <= SERVE_CAP; i++) {
      const served = await serveRune('gem_fieldnote__fieldnote', { session_id: `over-${i}` }, { logger, AuditOperation, db: store });
      assert.notStrictEqual(served.isError, true, `over-${i}`);
    }
    const keptRows = JSON.parse(fs.readFileSync(serveLogFile, 'utf8'));
    const localRows = keptRows.filter((row) => row.principal === 'local');
    assert.strictEqual(localRows.length, SERVE_CAP);
    assert.ok(!localRows.some((row) => row.session_id === 'over-0'));
    assert.ok(localRows.some((row) => row.session_id === `over-${SERVE_CAP}`));
    assert.strictEqual(keptRows.filter((row) => row.principal === 'emk_other').length, otherBefore);
    const stored = await col.find({ principal: 'local' }).toArray();
    assert.ok(stored.length > SERVE_CAP);
    assert.ok(stored.some((row) => row.session_id === 'over-0'));
    assert.strictEqual((await col.findOne({ _id: 'other-row' })).session_id, 'stay');
    fs.rmSync(serveLogFile, { force: true });
    assert.strictEqual(matchServe({ principal: 'local', session_id: 'over-0', gem: 'fieldnote', rune: 'fieldnote', sha256: pin }), null);
    const meta = { ...kept };
    await sealAttestation(meta, { session_id: 'over-0', db: store });
    assert.strictEqual(meta.rune_attested, true);
    assert.strictEqual(meta.principal, 'local');
    assert.strictEqual(meta.served_sha256, pin);
    await assert.rejects(
      () => sealAttestation({ ...kept }, { session_id: 'never-served', db: store }),
      (e) => /no serve event/.test(e.message)
    );
    await actorStore.run({
      transport: 'http', personId: 'owner', clientId: 'c', sourceTag: 'owner-login', subkeyId: 'emk_other'
    }, async () => {
      const stayed = { ...kept };
      await sealAttestation(stayed, { session_id: 'stay', db: store });
      assert.strictEqual(stayed.principal, 'emk_other');
      assert.strictEqual(stayed.rune_attested, true);
    });
  });

  test('the documented collection name and retention match the code', () => {
    const spec = fs.readFileSync(path.join(ROOT, 'gem-library/SPEC.md'), 'utf8');
    const section = spec.slice(spec.indexOf('**Serve log.**'), spec.indexOf('**Principal binding.**'));
    const change = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
    const fixed = change.slice(change.indexOf('### Fixed'), change.indexOf('### Changed'));
    const gate = fs.readFileSync(path.join(ROOT, 'tests/write-path.test.js'), 'utf8');
    const note = gate.slice(gate.indexOf('ADDED 2026-10-16 with the serve log'), gate.indexOf("'rune-dispatch.js'"));
    assert.ok(SERVE_COLLECTION.endsWith('gem_serves'));
    for (const text of [section, fixed, note]) {
      assert.match(text, /creates the new collection `<prefix>gem_serves`/);
      assert.match(text, /SERVE_COLLECTION/);
      assert.match(text, /Alex approved it as an append-only write site on the write-path allow-list/);
      assert.match(text, /The collection keeps every row\. Nothing is deleted\./);
      assert.doesNotMatch(text, /existing Mongo/);
    }
    assert.match(section, /keeps the latest `SERVE_CAP` rows for each principal/);
    assert.match(section, new RegExp(`\\(${SERVE_CAP}\\)`));
    assert.match(fixed, new RegExp(`SERVE_CAP\` \\(${SERVE_CAP}\\)`));
    assert.match(note, /SERVE_CAP/);
    assert.match(note, /inserts one document per serve and never updates or removes one/);
    assert.match(section, /grows with every serve/);
    assert.match(section, /There is no rate limiter/);
  });

  test('the store matches a serve only for the caller\'s principal', async () => {
    const store = makeStore();
    await store.collection(SERVE_COLLECTION).insertOne({
      _id: 'other-session',
      principal: 'emk_other', session_id: 'same-session', gem: 'fieldnote', rune: 'fieldnote',
      version: manifest.version, sha256: pin, time: 't'
    });
    fs.rmSync(serveLogFile, { force: true });
    await actorStore.run({
      transport: 'http', personId: 'owner', clientId: 'c', sourceTag: 'owner-login', subkeyId: 'emk_caller'
    }, async () => {
      assert.strictEqual(servePrincipal(), 'emk_caller');
      await assert.rejects(
        () => sealAttestation({ ...kept }, { session_id: 'same-session', db: store }),
        (e) => /no serve event/.test(e.message)
      );
    });
  });

  test('fieldnote@9.9.9 is refused for sealing', async () => {
    await seatGems({ asked: ['fieldnote'], log });
    const db = openDb();
    await serveRune('gem_fieldnote__fieldnote', { session_id: 's-wrong-ver' }, { logger, AuditOperation });
    await assert.rejects(
      () => saveMemory(db, 'counted 2', 'working', { ...kept, gem: 'fieldnote@9.9.9' }, null, null, { session_id: 's-wrong-ver' }),
      (e) => /metadata\.gem must be '<gem>@<version>'/.test(e.message)
    );
  });

  test('a save names the metadata.gem format', async () => {
    await seatGems({ asked: ['fieldnote'], log });
    const db = openDb();
    await serveRune('gem_fieldnote__fieldnote', { session_id: 's-form' }, { logger, AuditOperation });
    await assert.rejects(
      () => saveMemory(db, 'counted 2', 'working', { ...kept, gem: 'fieldnote' }, null, null, { session_id: 's-form' }),
      (e) => /metadata\.gem must be '<gem>@<version>'/.test(e.message)
    );
  });

  test('a serve still succeeds when the principal and session_id index throws', async () => {
    // Fail-open. Creating {principal, session_id} on <prefix>gem_serves can throw.
    // The serve still returns the code and the row is still stored.
    const store = makeStore();
    const col = store.collection(SERVE_COLLECTION);
    col.createIndex = async () => { throw new Error('index failed'); };
    const served = await serveRune('gem_fieldnote__fieldnote', { session_id: 'idx-throw' }, { logger, AuditOperation, db: store });
    assert.notStrictEqual(served.isError, true);
    assert.strictEqual(dataOf(served).sha256, pin);
    const row = await col.findOne({ session_id: 'idx-throw' });
    assert.ok(row);
    assert.strictEqual(row.principal, 'local');
    assert.strictEqual(row.gem, 'fieldnote');
  });

  test('one connection indexes principal and session_id once', async () => {
    const store = makeStore();
    const col = store.collection(SERVE_COLLECTION);
    const specs = [];
    let calls = 0;
    col.createIndex = async (spec) => {
      calls += 1;
      specs.push(spec);
      if (calls > 1) throw new Error('index already exists');
      return 'principal_1_session_id_1';
    };
    const first = await serveRune('gem_fieldnote__fieldnote', { session_id: 'idx-a' }, { logger, AuditOperation, db: store });
    const second = await serveRune('gem_fieldnote__fieldnote', { session_id: 'idx-b' }, { logger, AuditOperation, db: store });
    assert.notStrictEqual(first.isError, true);
    assert.notStrictEqual(second.isError, true);
    assert.deepStrictEqual(specs, [{ principal: 1, session_id: 1 }]);
    const looked = makeStore();
    const lookedCol = looked.collection(SERVE_COLLECTION);
    const lookedSpecs = [];
    lookedCol.createIndex = async (spec) => { lookedSpecs.push(spec); return 'principal_1_session_id_1'; };
    fs.rmSync(serveLogFile, { force: true });
    await assert.rejects(
      () => sealAttestation({ ...kept }, { session_id: 'idx-none', db: looked }),
      (e) => /no serve event/.test(e.message)
    );
    assert.deepStrictEqual(lookedSpecs, [{ principal: 1, session_id: 1 }]);
  });

  test('the serve temp dir is removed on exit', () => {
    assert.ok(fs.existsSync(serveDir));
    assert.ok(process.listeners('exit').includes(removeServeDir));
    removeServeDir();
    assert.strictEqual(fs.existsSync(serveDir), false);
  });
});

await summary('RUNE SERVE');
