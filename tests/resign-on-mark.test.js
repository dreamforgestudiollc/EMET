/**
 * EMET - re-sign on the sanctioned metadata marks (2026-10-02; the reviewer's finding).
 *
 * The signature is an HMAC over the content digest and the metadata digest. saveMemory signs at insert,
 * but markCorrectedBy (a corrected_by mark) and reviseMemory (the parent's superseded_by mark) re-attested
 * metadata_sha256 without re-signing, so every marked row read signed:false. Now both re-sign in the same
 * write when EMET_SIGNING_KEY is set and the existing signature verifies against the metadata before the
 * marks; with no key nothing changes, and a row altered outside the sanctioned path is never re-signed.
 */
import { test, testGroup, summary } from './harness.js';
import assert from 'assert';
import { layerHonouringDb as fakeDb } from './memstore.js';
import { saveMemory, markCorrectedBy, reviseMemory, queryLayer } from '../src/tools.js';
import { signatureIntegrityOf, metadataIntegrityOf, signatureCoversPriorMetadata, signDigests } from '../src/aleph.js';

const KEY = 'resign-unit-test-key';
const ENV_KEYS = ['EMET_SIGNING_KEY', 'CASCADE_SIGNING_KEY', 'EMET_SOURCE_TAGS', 'CASCADE_SOURCE_TAGS'];
async function withKey(key, fn) {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  if (key) process.env.EMET_SIGNING_KEY = key;
  try { return await fn(); } finally {
    for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}


const SRC = { source: 'tester-bot', assertion_origin: 'assistant' };
const POINTER = { session_id: '2026-10-02_resign-fixture', exchange_start: 1, exchange_end: 1 };
const resultsOf = (out) => (Array.isArray(out) ? out : (out.results || out.memories || out.entries || []));
const readOne = async (db, layer, id) => resultsOf(await queryLayer(db, layer, { include_superseded: true })).find((m) => Number(m.id) === Number(id));

testGroup('with a signing key, a marked row is re-signed and reads signed:true', () => {
  test('(a) a corrected-by mark: the parent reads signed:true (and metadata_integrity true) on read-back', () => withKey(KEY, async () => {
    const db = fakeDb();
    const parent = await saveMemory(db, 'Episode with items (1) and (2).', 'episodic', { ...SRC });
    assert.strictEqual(signatureIntegrityOf(db.row('episodic', parent.id), KEY), true, 'signed at insert');
    const child = await saveMemory(db, 'Corrects item (2).', 'episodic', { ...SRC, corrects: parent.id });
    assert.strictEqual(child.parent_marked, true);
    const m = await readOne(db, 'episodic', parent.id);
    assert.ok(m, 'parent read back');
    assert.deepStrictEqual(m.corrected_by, [child.id]);
    assert.strictEqual(m.metadata_integrity, true);
    assert.strictEqual(m.signed, true, 'the corrected parent stays signed');
    // a second mark, and two at once, keep it signed
    await Promise.all([markCorrectedBy(db, 'episodic', parent.id, 901), markCorrectedBy(db, 'episodic', parent.id, 902)]);
    const m2 = await readOne(db, 'episodic', parent.id);
    assert.deepStrictEqual([...m2.corrected_by].sort(), [child.id, 901, 902].sort());
    assert.strictEqual(m2.signed, true, 'still signed after concurrent marks');
  }));
  test('(b) a supersession: the superseded parent reads signed:true on read-back, and so does the new entry', () => withKey(KEY, async () => {
    const db = fakeDb();
    const parent = await saveMemory(db, 'The rule as first written.', 'procedural', { ...SRC, derived_from: POINTER });
    const rev = await reviseMemory(db, 'procedural', parent.id, 'The rule as revised.', { ...SRC });
    assert.strictEqual(rev.verified, true);
    const p = await readOne(db, 'procedural', parent.id);
    assert.ok(p && p.is_superseded && Number(p.superseded_by) === Number(rev.id), JSON.stringify(p && p.superseded_by));
    assert.strictEqual(p.metadata_integrity, true);
    assert.strictEqual(p.signed, true, 'the superseded parent stays signed');
    const c = await readOne(db, 'procedural', rev.id);
    assert.strictEqual(c.signed, true);
  }));
  test('a corrected parent that is later superseded is still re-signed (both marks rolled back in the check)', () => withKey(KEY, async () => {
    const db = fakeDb();
    const parent = await saveMemory(db, 'A semantic fact.', 'semantic', { ...SRC, derived_from: POINTER });
    await markCorrectedBy(db, 'semantic', parent.id, 777);
    const rev = await reviseMemory(db, 'semantic', parent.id, 'The fact, revised.', { ...SRC });
    const p = await readOne(db, 'semantic', parent.id);
    assert.strictEqual(rev.verified, true);
    assert.strictEqual(p.signed, true);
  }));
});

testGroup('never re-signed blindly; no key keeps today\'s behaviour', () => {
  test('a row whose metadata was changed outside the sanctioned path is NOT re-signed by a later mark', () => withKey(KEY, async () => {
    const db = fakeDb();
    const parent = await saveMemory(db, 'Episode.', 'episodic', { ...SRC });
    const sigBefore = db.row('episodic', parent.id).signature;
    db.row('episodic', parent.id).metadata.importance = 0.99;   // an edit no write path made
    await markCorrectedBy(db, 'episodic', parent.id, 801);
    const row = db.row('episodic', parent.id);
    assert.strictEqual(row.signature, sigBefore, 'signature untouched');
    const m = await readOne(db, 'episodic', parent.id);
    assert.strictEqual(m.signed, false, 'still reads signed:false, so the edit stays visible');
  }));
  test('a signature made with another key is not replaced', () => withKey(KEY, async () => {
    const db = fakeDb();
    const parent = await withKey('some-other-key', () => saveMemory(db, 'Episode.', 'episodic', { ...SRC }));
    const sigBefore = db.row('episodic', parent.id).signature;
    await markCorrectedBy(db, 'episodic', parent.id, 801);
    assert.strictEqual(db.row('episodic', parent.id).signature, sigBefore);
    assert.strictEqual((await readOne(db, 'episodic', parent.id)).signed, false);
  }));
  test('an unsigned row (written with no key) is not signed by a mark made with a key', () => withKey(KEY, async () => {
    const db = fakeDb();
    const parent = await withKey(null, () => saveMemory(db, 'Episode.', 'episodic', { ...SRC }));
    await markCorrectedBy(db, 'episodic', parent.id, 801);
    assert.ok(!db.row('episodic', parent.id).signature);
    assert.strictEqual((await readOne(db, 'episodic', parent.id)).signed, 'unsigned');
  }));
  test('with no key: the marks leave the signature column exactly as it was (today\'s behaviour)', () => withKey(null, async () => {
    const db = fakeDb();
    const signedParent = await withKey(KEY, () => saveMemory(db, 'Signed episode.', 'episodic', { ...SRC }));
    const sigBefore = db.row('episodic', signedParent.id).signature;
    await markCorrectedBy(db, 'episodic', signedParent.id, 801);
    assert.strictEqual(db.row('episodic', signedParent.id).signature, sigBefore);
    assert.strictEqual((await readOne(db, 'episodic', signedParent.id)).signed, 'no_key');
    const p = await saveMemory(db, 'A procedure.', 'procedural', { ...SRC, derived_from: POINTER });
    await reviseMemory(db, 'procedural', p.id, 'A procedure, revised.', { ...SRC });
    assert.strictEqual(db.row('procedural', p.id).signature, null);
    assert.strictEqual(metadataIntegrityOf(db.row('procedural', p.id)), true);
  }));
  test('signatureCoversPriorMetadata: only the three managed back-pointers are rolled back', () => {
    const md = { source: 'x', importance: 0.5 };
    const sha = 'a'.repeat(64);
    const row = (metadata, signedOver) => ({ sha256: sha, metadata, metadata_sha256: 'stale', signature: signDigests(sha, signedOver, KEY) });
    // signed over the original metadata digest
    return import('../src/aleph.js').then(({ digestMetadata: dm }) => {
      const sig = dm(md);
      assert.strictEqual(signatureCoversPriorMetadata(row({ ...md, superseded_by: 9, superseded_at: 't', corrected_by: [3, 4] }, sig), KEY), true);
      assert.strictEqual(signatureCoversPriorMetadata(row({ ...md, corrected_by: [3, 4] }, dm({ ...md, corrected_by: [3] })), KEY), true, 'a prefix of corrected_by');
      assert.strictEqual(signatureCoversPriorMetadata(row({ ...md, corrected_by: [4, 3] }, dm({ ...md, corrected_by: [3] })), KEY), false, 'not a prefix');
      assert.strictEqual(signatureCoversPriorMetadata(row({ ...md, importance: 0.6 }, sig), KEY), false, 'another field changed');
      assert.strictEqual(signatureCoversPriorMetadata(row({ ...md, superseded_by: 9 }, sig), null), false, 'no key');
      assert.strictEqual(signatureCoversPriorMetadata({ ...row(md, sig), signature: null }, KEY), false, 'no signature');
    });
  });
});

summary('RE-SIGN ON METADATA MARKS TEST SUMMARY');
