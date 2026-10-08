/**
 * EMET - provenance is stamped and required at the door (2026-09-29, a decision record).
 *
 * The owner's ruling: integrity was proven on every write, provenance was not.
 * The transcript is appended every exchange, so the pointer needs no
 * reconstruction - the caller names its session, the server reads that
 * session's own counter and stamps the exchange in progress. Semantic and
 * procedural entries (charter: provenance required) are refused with no source.
 * Revisions cite the entry they revise. saveMemory runs against a fake store.
 */

import { test, testGroup, summary } from './harness.js';
import assert from 'assert';
import { saveMemory, reviseMemory } from '../src/tools.js';
import { layerDb as fakeDb } from './memstore.js';
const SRC = { source: 'test' };

testGroup('semantic and procedural refuse a write with no source', () => {
  for (const layer of ['semantic', 'procedural']) {
    test(`${layer}: no derived_from, no session_id -> refused, nothing written`, async () => {
      const db = fakeDb();
      await assert.rejects(() => saveMemory(db, `a ${layer} claim`, layer, { ...SRC }),
        (e) => e.field === 'derived_from' && /must carry their source/.test(e.message) && /Nothing was written/.test(e.message));
      assert.strictEqual(db.writes.length, 0);
    });
  }
  test('the refusal names all three ways to supply a source', async () => {
    await assert.rejects(() => saveMemory(fakeDb(), 'x claim', 'semantic', { ...SRC }),
      (e) => /session_id/.test(e.message) && /exchange_start/.test(e.message) && /entries/.test(e.message));
  });
});

testGroup('the other layers are not refused', () => {
  for (const layer of ['episodic', 'meta', 'working', 'identity']) {
    test(`${layer}: writes without a source`, async () => {
      const db = fakeDb();
      await saveMemory(db, `a ${layer} note`, layer, { ...SRC });
      assert.strictEqual(db.writes.length, 1);
    });
  }
  test('an encouraged layer still carries the provenance_missing marker', async () => {
    const db = fakeDb();
    const r = await saveMemory(db, 'an episode', 'episodic', { ...SRC });
    assert.strictEqual(r.provenance_missing, true);
  });
});

testGroup('session_id stamps the exchange in progress', () => {
  test('highest stored 6 -> stamped exchange 7, on the base session id', async () => {
    const db = fakeDb({ highest: 6 });
    const r = await saveMemory(db, 'a fact', 'semantic', { ...SRC }, null, null, { session_id: '2026-09-30_x_verbatim_part1' });
    assert.deepStrictEqual(r.provenance, { session_id: '2026-09-30_x', exchange_start: 7, exchange_end: 7 });
    assert.ok(r.provenance_stamped);
    const row = db.writes[0].doc;
    assert.strictEqual(row.source_session_id, '2026-09-30_x');
    assert.strictEqual(row.source_exchange_start, 7);
    assert.strictEqual(row.source_exchange_end, 7);
  });
  test('a session opened but not yet appended stamps exchange 1', async () => {
    const r = await saveMemory(fakeDb({ highest: 0 }), 'a rule', 'procedural', { ...SRC }, null, null, { session_id: '2026-09-30_y' });
    assert.strictEqual(r.provenance.exchange_start, 1);
  });
  test('a caller-supplied derived_from wins; the transcript is not consulted', async () => {
    const db = fakeDb({ highest: 9 });
    const r = await saveMemory(db, 'a fact', 'semantic', { ...SRC, derived_from: { entries: [3, 4] } }, null, null, { session_id: '2026-09-30_z' });
    assert.deepStrictEqual(r.provenance, { entries: [3, 4] });
    assert.strictEqual(db.asked.length, 0);
    assert.strictEqual(r.provenance_stamped, undefined);
  });
  test('an empty session_id is refused, nothing written', async () => {
    const db = fakeDb();
    await assert.rejects(() => saveMemory(db, 'a fact', 'semantic', { ...SRC }, null, null, { session_id: '   ' }), /session_id/);
    assert.strictEqual(db.writes.length, 0);
  });
  test('session_id on a working-layer write stamps too (encouraged, not required)', async () => {
    const r = await saveMemory(fakeDb({ highest: 2 }), 'scratch', 'working', { ...SRC }, null, null, { session_id: '2026-09-30_w' });
    assert.strictEqual(r.provenance.exchange_start, 3);
  });
  test('a store with no transcript reader refuses rather than guessing', async () => {
    const db = fakeDb(); delete db.transcriptPosition;
    await assert.rejects(() => saveMemory(db, 'a fact', 'semantic', { ...SRC }, null, null, { session_id: '2026-09-30_q' }), /cannot be stamped/);
    assert.strictEqual(db.writes.length, 0);
  });
});

testGroup('a revision cites the entry it revises', () => {
  function reviseDb() {
    const db = fakeDb();
    const rows = {}; const orig = db.insertMemory;
    db.insertMemory = async (layer, doc) => { const id = await orig(layer, doc); rows[id] = { ...doc, id }; return id; };
    db.readMemory = async (_l, id) => rows[id] || null;
    rows[42] = { id: 42, content: 'the old claim', metadata: { source: 'test' }, superseded_by: null, is_live: true };
    db.collectionFor = () => ({
      async findOne(q) { return rows[q.id] || null; },
      async updateOne(q, u) { if (rows[q.id]) Object.assign(rows[q.id], u.$set || {}); }
    });
    return db;
  }
  test('a semantic revision with no source is written, citing its parent', async () => {
    const db = reviseDb();
    await reviseMemory(db, 'semantic', 42, 'the corrected claim', { source: 'test' });
    assert.strictEqual(db.writes.length, 1);
    assert.deepStrictEqual(db.writes[0].doc.derived_from_ids, [42]);
  });
  test('a revision with its own derived_from keeps it', async () => {
    const db = reviseDb();
    await reviseMemory(db, 'procedural', 42, 'the corrected rule', { source: 'test', derived_from: { session_id: '2026-09-30_r', exchange_start: 4, exchange_end: 4 } });
    assert.strictEqual(db.writes[0].doc.source_session_id, '2026-09-30_r');
    assert.strictEqual(db.writes[0].doc.derived_from_ids, null);
  });
});

summary('Provenance Stamp Test Summary');
