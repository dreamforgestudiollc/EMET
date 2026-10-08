/**
 * EMET - option A correction back-pointer (2026-10-02; the owner's approval, the owner's decision record item 4;
 * the reviewer's sketch in his second read of an incident record).
 *
 * Episodic entries are immutable events. A partial correction cannot supersede its parent (that would
 * hide the parent's items that still stand), so the new entry carries metadata.corrects = <parent id>
 * and the parent is marked: corrected_by gains the new id, content and is_live untouched, metadata
 * re-attested. Read paths return corrected_by; emet_gaps checks both directions (broken_correction).
 */
import { test, testGroup, summary } from './harness.js';
import assert from 'assert';
import { layerHonouringDb as fakeDb } from './memstore.js';
import { saveMemory, markCorrectedBy, queryLayer, recallMemories } from '../src/tools.js';
import { checkCorrectionLinks } from '../src/gaps.js';
import { metadataIntegrityOf } from '../src/aleph.js';
import { validateMetadata, MARKER_FIELDS } from '../src/validation.js';

// The fake honours the layer (the reviewer MUST FIX, 2026-10-02): rows live per
// layer, so a parent in another layer is NOT found, and updateOne supports
// what markCorrectedBy sends ($set, $addToSet on dotted paths, array-equality
// filters, matchedCount).
const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
const getPath = (o, path) => path.split('.').reduce((a, k) => (a == null ? undefined : a[k]), o);
const setPath = (o, path, v) => { const ks = path.split('.'); let a = o; for (const k of ks.slice(0, -1)) { if (a[k] == null || typeof a[k] !== 'object') a[k] = {}; a = a[k]; } a[ks[ks.length - 1]] = v; };
const matches = (row, q) => Object.entries(q).every(([k, v]) => JSON.stringify(getPath(row, k)) === JSON.stringify(v));

const SRC = { source: 'tester-bot', assertion_origin: 'assistant' };

testGroup('saving a correction marks its parent', () => {
  test('metadata.corrects is accepted; the parent gains corrected_by, content and is_live untouched, metadata re-attested', async () => {
    const db = fakeDb();
    const parent = await saveMemory(db, 'Episode with items (1), (2) and (3).', 'episodic', { ...SRC });
    const before = JSON.parse(JSON.stringify(db.row('episodic', parent.id)));
    const child = await saveMemory(db, 'Corrects episodic #' + parent.id + ', item (2).', 'episodic', { ...SRC, corrects: parent.id });
    assert.strictEqual(child.corrects, parent.id);
    assert.strictEqual(child.parent_marked, true);
    const p = db.row('episodic', parent.id);
    assert.deepStrictEqual(p.corrected_by, [child.id]);
    assert.deepStrictEqual(p.metadata.corrected_by, [child.id]);
    assert.strictEqual(p.content, before.content);
    assert.strictEqual(p.sha256, before.sha256);
    assert.notStrictEqual(p.is_live, false);
    assert.ok(!p.superseded_by);
    assert.strictEqual(metadataIntegrityOf(p), true, 'parent re-attested');
    assert.strictEqual(db.row('episodic', child.id).metadata.corrects, parent.id);
  });
  test('a second correction appends; the same id twice is not duplicated', async () => {
    const db = fakeDb();
    const parent = await saveMemory(db, 'Episode.', 'episodic', { ...SRC });
    const c1 = await saveMemory(db, 'Correction one.', 'episodic', { ...SRC, corrects: parent.id });
    const c2 = await saveMemory(db, 'Correction two.', 'episodic', { ...SRC, corrects: parent.id });
    assert.deepStrictEqual(db.row('episodic', parent.id).corrected_by, [c1.id, c2.id]);
    await markCorrectedBy(db, 'episodic', parent.id, c2.id);
    assert.deepStrictEqual(db.row('episodic', parent.id).corrected_by, [c1.id, c2.id]);
  });
  test('a correction naming a missing parent is refused before anything is written', async () => {
    const db = fakeDb();
    await assert.rejects(() => saveMemory(db, 'Corrects nothing.', 'episodic', { ...SRC, corrects: 9999 }),
      (e) => e.field === 'corrects' && /No entry with id 9999 in layer 'episodic'/.test(e.message) && /Nothing was written/.test(e.message));
    assert.strictEqual(db.writes.length, 0);
    assert.strictEqual(db.updates.length, 0);
  });
  test('corrects must be a positive integer', () => {
    assert.throws(() => validateMetadata({ corrects: 0 }));
    assert.throws(() => validateMetadata({ corrects: 'x' }));
    assert.strictEqual(validateMetadata({ corrects: 603 }).corrects, 603);
  });
  test('a caller cannot forge corrected_by: it is a door marker, dropped from incoming metadata', async () => {
    assert.ok(MARKER_FIELDS.includes('corrected_by'));
    const db = fakeDb();
    const r = await saveMemory(db, 'Claims to be corrected.', 'episodic', { ...SRC, corrected_by: [1, 2] });
    assert.strictEqual(db.row('episodic', r.id).metadata.corrected_by, undefined);
  });
  test('an entry without corrects writes no mark and its receipt carries no corrects field', async () => {
    const db = fakeDb();
    const r = await saveMemory(db, 'Plain episode.', 'episodic', { ...SRC });
    assert.strictEqual(r.corrects, undefined);
    assert.strictEqual(db.updates.length, 0);
  });
});

testGroup('the layer is respected', () => {
  test('a parent that exists only in ANOTHER layer is refused; nothing is written or marked', async () => {
    const db = fakeDb();
    const sem = { id: await db.insertMemory('semantic', { content: 'A semantic fact.', metadata: {} }) };
    const writesBefore = db.writes.length;
    await assert.rejects(() => saveMemory(db, 'Corrects the fact.', 'episodic', { ...SRC, corrects: sem.id }),
      (e) => e.field === 'corrects' && new RegExp(`No entry with id ${sem.id} in layer 'episodic'`).test(e.message));
    assert.strictEqual(db.writes.length, writesBefore);
    assert.strictEqual(db.updates.length, 0);
    assert.strictEqual(db.row('semantic', sem.id).corrected_by, undefined);
  });
  test('markCorrectedBy against the wrong layer marks nothing and says so', async () => {
    const db = fakeDb();
    const sem = { id: await db.insertMemory('semantic', { content: 'A semantic fact.', metadata: {} }) };
    const r = await markCorrectedBy(db, 'episodic', sem.id, 999);
    assert.deepStrictEqual(r, { parent_id: sem.id, marked: false });
    assert.strictEqual(db.row('semantic', sem.id).corrected_by, undefined);
  });
});

testGroup('reads return corrected_by', () => {
  test('query_layer returns corrected_by on the parent and [] on an unmarked entry', async () => {
    const db = fakeDb();
    const parent = await saveMemory(db, 'Episode alpha.', 'episodic', { ...SRC });
    const child = await saveMemory(db, 'Corrects alpha.', 'episodic', { ...SRC, corrects: parent.id });
    const out = await queryLayer(db, 'episodic', {});
    const rows = out.results || out.memories || out.data || out;
    const p = rows.find((m) => m.id === parent.id);
    const c = rows.find((m) => m.id === child.id);
    assert.deepStrictEqual(p.corrected_by, [child.id]);
    assert.strictEqual(p.metadata_integrity, true);
    assert.deepStrictEqual(c.corrected_by, []);
  });
  test('recall returns corrected_by on the parent', async () => {
    const db = fakeDb();
    const parent = await saveMemory(db, 'Episode alpha.', 'episodic', { ...SRC });
    const child = await saveMemory(db, 'Corrects alpha.', 'episodic', { ...SRC, corrects: parent.id });
    const out = await recallMemories(db, 'alpha', 'episodic');
    const rows = out.results || out.memories || out.data || out;
    const p = rows.find((m) => m.id === parent.id);
    assert.deepStrictEqual(p.corrected_by, [child.id]);
  });
});

testGroup('broken_correction: both directions', () => {
  const findIn = (db) => async (layer, id) => db.row(layer, id) || null;
  test('a clean link reports nothing', async () => {
    const db = fakeDb();
    const parent = await saveMemory(db, 'Episode.', 'episodic', { ...SRC });
    const child = await saveMemory(db, 'Correction.', 'episodic', { ...SRC, corrects: parent.id });
    const out = await checkCorrectionLinks(
      [{ ref: `episodic#${parent.id}`, layer: 'episodic', id: parent.id, child: child.id }],
      [{ ref: `episodic#${child.id}`, layer: 'episodic', id: child.id, parent: parent.id }], findIn(db));
    assert.deepStrictEqual(out, []);
  });
  test('parent -> child: corrected_by names a missing child', async () => {
    const db = fakeDb();
    const parent = await saveMemory(db, 'Episode.', 'episodic', { ...SRC });
    const out = await checkCorrectionLinks([{ ref: `episodic#${parent.id}`, layer: 'episodic', id: parent.id, child: 9999 }], [], findIn(db));
    assert.deepStrictEqual(out, [`episodic#${parent.id} -> corrected_by 9999 (missing)`]);
  });
  test('parent -> child: the child exists but does not name the parent in corrects', async () => {
    const db = fakeDb();
    const parent = await saveMemory(db, 'Episode.', 'episodic', { ...SRC });
    const other = await saveMemory(db, 'Unrelated.', 'episodic', { ...SRC });
    const out = await checkCorrectionLinks([{ ref: `episodic#${parent.id}`, layer: 'episodic', id: parent.id, child: other.id }], [], findIn(db));
    assert.deepStrictEqual(out, [`episodic#${parent.id} -> corrected_by ${other.id} (it does not name ${parent.id} in corrects)`]);
  });
  test('child -> parent: corrects names a missing parent', async () => {
    const db = fakeDb();
    const out = await checkCorrectionLinks([], [{ ref: 'episodic#700', layer: 'episodic', id: 700, parent: 9999 }], findIn(db));
    assert.deepStrictEqual(out, ['episodic#700 corrects 9999 (parent missing)']);
  });
  test('child -> parent: the parent exists but is not marked', async () => {
    const db = fakeDb();
    const parent = await saveMemory(db, 'Episode.', 'episodic', { ...SRC });
    const out = await checkCorrectionLinks([], [{ ref: 'episodic#700', layer: 'episodic', id: 700, parent: parent.id }], findIn(db));
    assert.deepStrictEqual(out, [`episodic#700 corrects ${parent.id} (parent not marked)`]);
  });
  test('the parent lookup is per layer: a same-id parent in another layer is "missing"', async () => {
    const db = fakeDb();
    const sem = { id: await db.insertMemory('semantic', { content: 'A semantic fact.', metadata: {} }) };
    const out = await checkCorrectionLinks([], [{ ref: 'episodic#700', layer: 'episodic', id: 700, parent: sem.id }], findIn(db));
    assert.deepStrictEqual(out, [`episodic#700 corrects ${sem.id} (parent missing)`]);
  });
});

testGroup('the mark is race-safe', () => {
  test('two corrections marked at the same time both land, and the parent stays attested', async () => {
    const db = fakeDb();
    const parent = await saveMemory(db, 'Episode.', 'episodic', { ...SRC });
    const [a, b] = await Promise.all([
      markCorrectedBy(db, 'episodic', parent.id, 801),
      markCorrectedBy(db, 'episodic', parent.id, 802)
    ]);
    const p = db.row('episodic', parent.id);
    assert.deepStrictEqual([...p.corrected_by].sort(), [801, 802]);
    assert.deepStrictEqual([...p.metadata.corrected_by].sort(), [801, 802]);
    assert.strictEqual(metadataIntegrityOf(p), true);
    assert.strictEqual(a.marked, true);
    assert.strictEqual(b.marked, true);
  });
  test('a mark that lands between read-back and re-attest is caught: the digest is retried and covers both ids', async () => {
    const db = fakeDb();
    const parent = await saveMemory(db, 'Episode.', 'episodic', { ...SRC });
    let fired = false;
    db.hooks.beforeUpdate = async (layer, q, u) => {
      if (!fired && u.$set && u.$set.metadata_sha256) {
        fired = true;
        const r = db.row(layer, parent.id);
        r.corrected_by.push(803); r.metadata.corrected_by.push(803);
      }
    };
    const res = await markCorrectedBy(db, 'episodic', parent.id, 801);
    const p = db.row('episodic', parent.id);
    assert.deepStrictEqual(p.metadata.corrected_by, [801, 803]);
    assert.strictEqual(metadataIntegrityOf(p), true, 'the last re-attest covers the concurrent id');
    assert.strictEqual(res.marked, true);
  });
  test('a change to ANOTHER metadata field between read-back and re-attest is caught too (full-metadata compare-and-set)', async () => {
    const db = fakeDb();
    const parent = await saveMemory(db, 'Episode.', 'episodic', { ...SRC });
    let fired = false;
    db.hooks.beforeUpdate = async (layer, q, u) => {
      if (!fired && u.$set && u.$set.metadata_sha256) {
        fired = true;
        // corrected_by is untouched; only another field moves (e.g. a concurrent supersession marker)
        db.row(layer, parent.id).metadata.superseded_by = 950;
      }
    };
    const res = await markCorrectedBy(db, 'episodic', parent.id, 801);
    const p = db.row('episodic', parent.id);
    assert.strictEqual(fired, true);
    assert.deepStrictEqual(p.metadata.corrected_by, [801]);
    assert.strictEqual(p.metadata.superseded_by, 950);
    const attests = db.updates.filter((x) => x.u.$set && x.u.$set.metadata_sha256);
    assert.ok(attests.length >= 2, `the re-attest was retried (${attests.length})`);
    assert.ok('metadata' in attests[0].q && !('metadata.corrected_by' in attests[0].q), 'the filter is the whole metadata value');
    assert.strictEqual(metadataIntegrityOf(p), true, 'the digest covers the concurrent superseded_by');
    assert.strictEqual(res.marked, true);
  });
  test('a mark that does not hold is reported: parent_marked false and a warning in words', async () => {
    const db = fakeDb();
    const parent = await saveMemory(db, 'Episode.', 'episodic', { ...SRC });
    db.hooks.freezeUpdates = true;
    const child = await saveMemory(db, 'Correction.', 'episodic', { ...SRC, corrects: parent.id });
    assert.strictEqual(child.parent_marked, false);
    assert.ok(child.warnings.some((w) => new RegExp(`corrects: ${parent.id} - the parent entry was not marked`).test(w)), JSON.stringify(child.warnings));
  });
});

summary('EPISODIC CORRECTIONS (OPTION A) TEST SUMMARY');
