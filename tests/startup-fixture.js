/**
 * A store sized like the live one (document sizes from the 2026-10-02 list_docs
 * read: IDENTITY 1,018, SOUL 6,790, USER 8,748, INSTALL 6,582 characters; 21
 * seeds; 25 threads; 5 recent entries), shared by the startup suites. Moved
 * from startup-payload.test.js (2026-10-03). Not a suite.
 */
import crypto from 'crypto';
import assert from 'assert';
import { makeStore, withStore } from './memstore.js';
import { loadIdOf, sessionOpenLine } from '../src/startup-pages.js';

/**
 * The payload inside a startup served whole (page "all", a startup that fits
 * one result, or a store that is not ready). Pins the two fields that lead it
 * (2026-10-03): `startup_page` with the payload's own load_id, of 1, no next
 * call, and `page_notice` naming that load_id for emet_session_open. Returns
 * the payload exactly as it was before those fields were added.
 */
export function payloadOf(whole, index = 'all') {
  const [first, second] = Object.keys(whole);
  assert.deepStrictEqual([first, second], ['startup_page', 'page_notice'], 'a whole startup leads with startup_page and page_notice');
  const { startup_page, page_notice, ...payload } = whole;
  const id = loadIdOf(payload);
  assert.deepStrictEqual(startup_page, { index, of: 1, load_id: id, next: null });
  assert.strictEqual(page_notice, `The whole startup in one result (load ${id}). ${sessionOpenLine(id)}`);
  return payload;
}

const sha = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');

// Prose of an exact length, with an em dash every so often so UTF-8 bytes run
// a little over characters, as they do in the live documents.
export function prose(n, seed) {
  const words = ['memory', 'record', 'the', 'user', 'session', 'and', 'host', 'floor', 'keeps', 'what', 'was', 'said', '—', 'board', 'handoff', 'seed'];
  let s = `# ${seed}\n\n`; let i = seed.length;
  while (s.length < n) { s += words[i++ % words.length] + (i % 13 === 0 ? '.\n' : ' '); }
  return s.slice(0, n);
}
function seedDoc(i) {
  return `---\nstatus: planted\ntrigger:\n  - kind: topic\n    test: "When the user mentions project ${i} or anything about its budget, timeline, partners or the open questions from the last review"\n  - kind: date\n    test: "2027-0${(i % 9) + 1}-15"\n---\n# SEED — Example idea number ${i} with a reasonably descriptive title\n\n${prose(1200, 'seed body ' + i)}`;
}

export const DOC_SIZES = { 'bootstrap/IDENTITY.md': 1018, 'bootstrap/SOUL.md': 6790, 'bootstrap/USER.md': 8748, 'bootstrap/INSTALL.md': 6582 };

export async function liveSizedStore() {
  const { setupComplete } = await import('../src/setup.js');
  const s = makeStore();
  await withStore(s, () => setupComplete({ assistant_name: 'Ada', assistant_character: 'Plain and careful.', user_name: 'Sam Example', user_context: 'Testing.', source_tag: 'example-host' }));
  const docs = s.collection('documents');
  const now = new Date('2026-10-02T12:00:00Z');
  // The live store keeps its character document as bootstrap/SOUL.md; setup
  // wrote bootstrap/CHARACTER.md, which would win resolution, so it goes.
  docs.docs.splice(docs.docs.findIndex((d) => d.doc_id === 'bootstrap/CHARACTER.md'), 1);
  for (const [doc_id, n] of Object.entries(DOC_SIZES)) {
    const content = prose(n, doc_id);
    const existing = docs.docs.find((d) => d.doc_id === doc_id);
    if (existing) Object.assign(existing, { content, sha256: sha(content), version: (existing.version || 1) + 1 });
    else docs.docs.push({ _id: `doc-${doc_id}`, doc_id, content, sha256: sha(content), version: 9, updated_at: now });
  }
  for (let i = 1; i <= 21; i++) docs.docs.push({ _id: `seed-${i}`, doc_id: `seeds/example-idea-${String(i).padStart(2, '0')}.md`, content: seedDoc(i), version: 2, updated_at: now });
  for (let i = 1; i <= 25; i++) docs.docs.push({ _id: `thread-${i}`, doc_id: `threads/example-project-${String(i).padStart(2, '0')}.md`, content: prose(3000 + i * 100, 'thread ' + i), version: 3, updated_at: new Date(now.getTime() - i * 3600e3) });
  // Enough entries in every layer for layer_health to assess (and find healthy).
  const t0 = now.getTime() / 1000;
  const per = { episodic: 20, semantic: 12, procedural: 12, meta: 6, identity: 2, working: 6 };
  for (const [layer, n] of Object.entries(per)) {
    const c = s.collection(`emet_${layer}`);
    for (let i = 0; i < n; i++) c.docs.push({ _id: `${layer}-${i}`, id: i + 1, content: prose(900, `${layer} ${i}`), context: layer === 'episodic' ? prose(800, `context ${i}`) : undefined, timestamp: t0 - i * 3600, importance: 0.6 });
  }
  return s;
}

