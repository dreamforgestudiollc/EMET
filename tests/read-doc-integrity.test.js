/**
 * read_doc re-hashes the stored body against sha256.
 * integrity is true, false, or 'unattested' on the whole body, including
 * when the result is one page. A mismatch is returned and marked.
 * In-memory store, real readDoc and readDocHistory. No database.
 */
import { test, testGroup, summary } from './harness.js';
import assert from 'assert';
import crypto from 'crypto';
import { makeStore, withStore } from './memstore.js';

process.env.MONGODB_URI = 'mongodb://in-memory.test/emet';

console.log('\n=== read_doc body integrity ===');

const { readDoc, readDocHistory, TOOLS } = await import('../src/tools.js');

const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const store = makeStore();
const docs = store.collection('documents');
const hist = store.collection('documents_history');
const MISMATCH = 'The stored sha256 does not match the document body. The body is returned and flagged.';
const RETIRED = 'This document is marked OBSOLETE. It is retained in full and readable, but it is not current - do not act on it as live state.';

function put(doc_id, content, extra = {}) {
  const row = {
    doc_id, content, version: 1, updated_at: '2026-11-27T00:00:00.000Z', updated_by: 'cursor-cloud-agent',
    ...extra
  };
  if (!('sha256' in extra)) row.sha256 = sha(content);
  docs.docs.push(row);
  return row;
}

const read = (id, opts) => withStore(store, () => readDoc(id, null, opts));
const history = (id, version, opts) => withStore(store, () => readDocHistory(id, version, null, opts));

const clean = 'the body matches its digest\n';
put('notes/clean.md', clean);

const original = 'the body as written\n';
const tampered = 'the body as altered\n';
put('notes/tampered.md', tampered, { sha256: sha(original) });

put('notes/none.md', 'written before a digest\n', { sha256: undefined });
delete docs.docs[docs.docs.length - 1].sha256;
put('notes/null.md', 'digest column null\n', { sha256: null });
put('notes/empty.md', 'digest column empty\n', { sha256: '' });

put('notes/retired-clean.md', 'kept in full\n', { retired: true, retired_reason: 'merged away', retired_at: '2026-11-27T00:00:00.000Z' });
put('notes/retired-tampered.md', 'retired and altered\n', {
  sha256: sha('retired original\n'), retired: true, retired_reason: 'litter', retired_at: '2026-11-27T00:00:00.000Z'
});

const head = 'HEAD '.repeat(80);
const tail = 'TAIL-MARKER-NOT-ON-PAGE';
const whole = head + tail;
const changedTail = head + 'TAIL-CHANGED-NOT-ON-PAGE';
put('notes/paged-clean.md', whole);
put('notes/paged-tail.md', changedTail, { sha256: sha(whole), version: 4 });
put('notes/paged-none.md', whole, { sha256: undefined, version: 2 });
delete docs.docs[docs.docs.length - 1].sha256;

put('notes/current.md', 'live revision\n', { version: 3 });
put('notes/current-bad.md', 'live altered\n', { sha256: sha('live original\n'), version: 5 });
put('notes/current-none.md', 'live undigested\n', { sha256: null, version: 1 });

hist.docs.push({
  doc_id: 'notes/archived.md', version: 1, content: 'archive altered\n', sha256: sha('archive original\n'),
  size: 'archive altered\n'.length, archived_at: '2026-11-01T00:00:00.000Z', updated_by: 'cursor-cloud-agent'
});
hist.docs.push({
  doc_id: 'notes/archived.md', version: 2, content: 'archive matches\n', sha256: sha('archive matches\n'),
  size: 'archive matches\n'.length, archived_at: '2026-11-01T00:00:01.000Z', updated_by: 'cursor-cloud-agent'
});
put('notes/archived.md', 'archive current\n', { version: 3 });

testGroup('read_doc integrity is the whole stored body', () => {
  test('a matching body is integrity true and has no mismatch note', async () => {
    const before = store.writes.length;
    const r = await read('notes/clean.md');
    assert.strictEqual(r.content, clean);
    assert.strictEqual(r.sha256, sha(clean));
    assert.strictEqual(r.integrity, true);
    assert.ok(!('note' in r));
    assert.ok('signed' in r);
    assert.strictEqual(store.writes.length, before);
  });

  test('tampered content with an untouched sha256 is returned, flagged, and not thrown', async () => {
    const before = store.writes.length;
    const stored = docs.docs.find((d) => d.doc_id === 'notes/tampered.md');
    const r = await read('notes/tampered.md', { limit: 0 });
    assert.strictEqual(r.content, tampered);
    assert.strictEqual(r.sha256, sha(original));
    assert.notStrictEqual(r.sha256, sha(tampered));
    assert.strictEqual(r.integrity, false);
    assert.strictEqual(r.note, MISMATCH);
    assert.strictEqual(stored.content, tampered);
    assert.strictEqual(stored.sha256, sha(original));
    assert.strictEqual(store.writes.length, before);
  });

  test('no sha256, a null sha256, and an empty sha256 are unattested', async () => {
    for (const id of ['notes/none.md', 'notes/null.md', 'notes/empty.md']) {
      const r = await read(id);
      assert.strictEqual(r.integrity, 'unattested', id);
      assert.ok(!('note' in r), id);
      assert.ok(r.content.length > 0, id);
    }
  });

  test('a retired document that still matches keeps the obsolete note and integrity true', async () => {
    const r = await read('notes/retired-clean.md');
    assert.strictEqual(r.retired, true);
    assert.strictEqual(r.integrity, true);
    assert.strictEqual(r.content, 'kept in full\n');
    assert.strictEqual(r.note, RETIRED);
  });

  test('a retired document with a mismatched body keeps both marks and the body', async () => {
    const r = await read('notes/retired-tampered.md');
    assert.strictEqual(r.retired, true);
    assert.strictEqual(r.integrity, false);
    assert.strictEqual(r.content, 'retired and altered\n');
    assert.ok(r.note.startsWith(RETIRED));
    assert.ok(r.note.endsWith(MISMATCH));
  });
});

testGroup('paging reports the whole body, not the page', () => {
  test('each page of a matching document reports integrity true, and the pages join', async () => {
    let r = await read('notes/paged-clean.md', { limit: 1600 });
    assert.ok(r.page && r.page.next_offset !== null);
    assert.notStrictEqual(r.content, whole);
    assert.match(r.page.note, /whole body/);
    let out = '';
    let guard = 0;
    while (guard++ < 20) {
      assert.strictEqual(r.integrity, true);
      assert.strictEqual(r.sha256, sha(whole));
      assert.ok(!('note' in r));
      out += r.content;
      if (!r.page || r.page.next_offset === null) break;
      r = await read('notes/paged-clean.md', { offset: r.page.next_offset, limit: 1600, expected_version: 1 });
    }
    assert.strictEqual(out, whole);
  });

  test('a tail edit the first page does not include still reports integrity false', async () => {
    let r = await read('notes/paged-tail.md', { limit: 1600 });
    assert.ok(r.page && r.page.next_offset !== null);
    assert.ok(!r.content.includes('TAIL-CHANGED'));
    assert.ok(r.content.length < changedTail.length);
    assert.strictEqual(r.sha256, sha(whole));
    let out = '';
    let guard = 0;
    let sawTail = false;
    while (guard++ < 20) {
      assert.strictEqual(r.integrity, false);
      assert.strictEqual(r.note, MISMATCH);
      assert.strictEqual(r.sha256, sha(whole));
      if (r.content.includes('TAIL-CHANGED')) sawTail = true;
      out += r.content;
      if (!r.page || r.page.next_offset === null) break;
      r = await read('notes/paged-tail.md', { offset: r.page.next_offset, limit: 1600, expected_sha256: sha(whole) });
    }
    assert.strictEqual(out, changedTail);
    assert.strictEqual(sawTail, true);
  });

  test('a paged document with no sha256 stays unattested', async () => {
    const r = await read('notes/paged-none.md', { limit: 1600 });
    assert.ok(r.page);
    assert.notStrictEqual(r.content, whole);
    assert.strictEqual(r.integrity, 'unattested');
    assert.ok(!('note' in r));
  });
});

testGroup('read_doc_history reports integrity for the revision now in force', () => {
  test('the current revision is integrity true', async () => {
    const r = await history('notes/current.md', 3);
    assert.strictEqual(r.is_current, true);
    assert.strictEqual(r.content, 'live revision\n');
    assert.strictEqual(r.integrity, true);
    assert.ok(!('note' in r));
  });

  test('a tampered current revision is returned with integrity false', async () => {
    const r = await history('notes/current-bad.md', 5, { limit: 0 });
    assert.strictEqual(r.is_current, true);
    assert.strictEqual(r.content, 'live altered\n');
    assert.strictEqual(r.sha256, sha('live original\n'));
    assert.strictEqual(r.integrity, false);
    assert.strictEqual(r.note, MISMATCH);
  });

  test('a current revision with no sha256 is unattested', async () => {
    const r = await history('notes/current-none.md', 1);
    assert.strictEqual(r.is_current, true);
    assert.strictEqual(r.integrity, 'unattested');
    assert.ok(!('note' in r));
  });

  test('a retained revision still flags a mismatch and still returns the body', async () => {
    const bad = await history('notes/archived.md', 1);
    assert.strictEqual(bad.is_current, false);
    assert.strictEqual(bad.content, 'archive altered\n');
    assert.strictEqual(bad.integrity, false);
    assert.strictEqual(bad.note, MISMATCH);
    const good = await history('notes/archived.md', 2);
    assert.strictEqual(good.integrity, true);
    assert.strictEqual(good.content, 'archive matches\n');
    assert.ok(!('note' in good));
  });
});

testGroup('shipped guides are not re-hashed', () => {
  test('a shipped guide has no integrity field', async () => {
    const r = await read('guides/README.md', { limit: 400 });
    assert.ok(r.content && r.content.length > 0);
    assert.ok(!('integrity' in r));
    assert.match(r.note, /shipped guide/);
    if (r.page) assert.ok(!/whole body/.test(r.page.note));
  });

  test('the read_doc description names integrity of the whole document', () => {
    const tool = TOOLS.find((t) => t.name === 'read_doc');
    assert.match(tool.description, /WHOLE document/);
    assert.match(tool.description, /integrity/);
    assert.match(tool.description, /unattested/);
    assert.match(tool.description, /shipped guide/);
    const historyTool = TOOLS.find((t) => t.name === 'read_doc_history');
    assert.match(historyTool.description, /revision now in force/);
    assert.match(historyTool.description, /integrity false/);
  });
});

await summary();
