/**
 * the reviewer round 3 (2026-10-12), condition 1: the client-approvals record is
 * written with an atomic compare-and-set. The update filter carries
 * { doc_id, version: expected }, so a second process that read the same
 * version loses even if it passed the early check. Real writeDoc, in-memory store.
 */
import { test, summary } from './harness.js';
import assert from 'assert';
import { makeStore, withStore } from './memstore.js';

process.env.MONGODB_URI = 'mongodb://in-memory.test/emet';
console.log('\n=== approvals compare-and-set ===');
const { approvalsDeps } = await import('../src/tools.js');
const ID = 'emet/CLIENT_APPROVALS.md';
const body = (n) => `# Client approvals\n\n<!-- emet-approvals ${JSON.stringify({ approved: {}, pending: {}, denied: {}, n })} -->\n`;

await test('first write needs expected null; a second "first" write loses', async () => {
  const store = makeStore();
  await withStore(store, async () => {
    const r = await approvalsDeps.writeDoc(ID, body(1), null);
    assert.strictEqual(r.version, 1);
    await assert.rejects(() => approvalsDeps.writeDoc(ID, body(2), null), (e) => e.versionConflict === true);
  });
});

await test('stale expected version is refused; current one wins', async () => {
  const store = makeStore();
  await withStore(store, async () => {
    await approvalsDeps.writeDoc(ID, body(1), null);
    await approvalsDeps.writeDoc(ID, body(2), 1);
    await assert.rejects(() => approvalsDeps.writeDoc(ID, body(3), 1), (e) => e.versionConflict === true);
    const row = store.collection('documents').docs.find((d) => d.doc_id === ID);
    assert.strictEqual(row.version, 2);
  });
});

await test('update filter carries version: expected (race after the early check loses)', async () => {
  const store = makeStore();
  const col = store.collection('documents');
  await withStore(store, async () => {
    await approvalsDeps.writeDoc(ID, body(1), null);
    const real = col.updateOne.bind(col);
    const filters = [];
    // Another process lands version 2 between our read and our update.
    col.updateOne = async (q, u, o) => {
      filters.push(q);
      if (q && q.doc_id === ID && q.version === 1) { const row = col.docs.find((d) => d.doc_id === ID); row.version = 2; }
      return real(q, u, o);
    };
    try {
      await assert.rejects(() => approvalsDeps.writeDoc(ID, body(2), 1), (e) => e.versionConflict === true);
    } finally { col.updateOne = real; }
    assert.ok(filters.some((q) => q.doc_id === ID && q.version === 1), 'filter must include version: expected');
    assert.strictEqual(col.docs.find((d) => d.doc_id === ID).version, 2, 'the other process\'s version stands');
  });
});

await test('M1: racing first creates leave exactly one record on the deterministic _id', async () => {
  const store = makeStore();
  const col = store.collection('documents');
  await withStore(store, async () => {
    const res = await Promise.allSettled([approvalsDeps.writeDoc(ID, body(1), null), approvalsDeps.writeDoc(ID, body(2), null)]);
    assert.strictEqual(res.filter((r) => r.status === 'fulfilled').length, 1);
    assert.ok(res.some((r) => r.status === 'rejected' && r.reason.versionConflict === true));
    const rows = col.docs.filter((d) => d.doc_id === ID);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0]._id, `${ID}#current`);
  });
});

await test('M1: the first create filters on the deterministic _id, not doc_id', async () => {
  const store = makeStore();
  const col = store.collection('documents');
  const real = col.updateOne.bind(col); const seen = [];
  col.updateOne = async (q, u, o) => { seen.push({ q, o }); return real(q, u, o); };
  await withStore(store, () => approvalsDeps.writeDoc(ID, body(1), null));
  assert.ok(seen.some(({ q, o }) => q._id === `${ID}#current` && o && o.upsert === true));
});

summary();
