/**
 * read_doc version pin (2026-10-03). A paged read passes the `version` (or
 * `sha256`) its first page returned; if the document is rewritten between
 * pages the read is refused - "document changed, restart from offset 0" - so
 * pages of two versions are never joined. In-memory store, real code
 * (readDoc through dispatchTool); no database.
 */
import { test, testGroup, summary } from './harness.js';
import assert from 'assert';
import crypto from 'crypto';
import { makeStore, withStore } from './memstore.js';

process.env.MONGODB_URI = 'mongodb://in-memory.test/emet';

console.log('\n=== read_doc version pin ===');

const { dispatchTool } = await import('../src/dispatch.js');
const TOOLS_MOD = await import('../src/tools.js');
const { checkReadPin } = TOOLS_MOD;

const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const store = makeStore();
const docs = store.collection('documents');
const put = async (content, version) => {
  await docs.updateOne({ doc_id: 'STATE.md' }, { $set: { doc_id: 'STATE.md', content, version, sha256: sha(content), updated_at: new Date() } }, { upsert: true });
};
const call = (args) => withStore(store, () => dispatchTool('read_doc', { doc_id: 'STATE.md', ...args }, { dbManager: null, logger: null }));
const data = (res) => { assert.ok(!res.isError, res.content[0].text.slice(0, 300)); return JSON.parse(res.content[0].text).data; };
const v1 = ('| B-1 | caf\u00e9 \u2014 row one | OPEN |\n').repeat(60);
const v2 = ('| B-1 | caf\u00e9 \u2014 row one | DONE |\n').repeat(60) + '| B-2 | new row | OPEN |\n';

testGroup('a version change between pages is refused, never mixed', () => {
  test('a pinned read of an unchanged document pages normally and joins exactly', async () => {
    await put(v1, 1);
    let r = data(await call({ limit: 2000 }));
    const pin = r.version; let out = r.content; let guard = 0;
    assert.strictEqual(pin, 1);
    assert.match(r.page.note, /expected_version/);
    while (r.page && r.page.next_offset !== null && guard++ < 50) {
      r = data(await call({ offset: r.page.next_offset, limit: 2000, expected_version: pin }));
      out += r.content;
    }
    assert.strictEqual(out, v1); assert.strictEqual(sha(out), r.sha256);
  });
  test('the document changes after page 1: page 2 with expected_version is refused', async () => {
    await put(v1, 1);
    const p1 = data(await call({ limit: 2000 }));
    await put(v2, 2);
    const res = await call({ offset: p1.page.next_offset, limit: 2000, expected_version: p1.version });
    assert.ok(res.isError, 'refused');
    const text = res.content[0].text;
    assert.match(text, /document changed - restart from offset 0/);
    assert.match(text, /version 1/); assert.match(text, /now version 2/);
    assert.match(text, /nothing was returned/);
    assert.ok(!text.includes('DONE'), 'no content of the new version leaks into the refusal');
  });
  test('the same change with expected_sha256 is refused too', async () => {
    await put(v1, 1);
    const p1 = data(await call({ limit: 2000 }));
    await put(v2, 2);
    const res = await call({ offset: p1.page.next_offset, limit: 2000, expected_sha256: p1.sha256 });
    assert.ok(res.isError); assert.match(res.content[0].text, /document changed - restart from offset 0/);
  });
  test('restarting from offset 0 with the new version reads the new document whole', async () => {
    await put(v2, 2);
    let r = data(await call({ limit: 2000 }));
    const pin = r.version; let out = r.content; let guard = 0;
    while (r.page && r.page.next_offset !== null && guard++ < 50) {
      r = data(await call({ offset: r.page.next_offset, limit: 2000, expected_version: pin, expected_sha256: sha(v2) }));
      out += r.content;
    }
    assert.strictEqual(pin, 2); assert.strictEqual(out, v2);
  });
  test('without a pin the read still works as before (the pin is optional)', async () => {
    await put(v1, 1);
    const p1 = data(await call({ limit: 2000 }));
    await put(v2, 2);
    const r = data(await call({ offset: p1.page.next_offset, limit: 2000 }));
    assert.strictEqual(r.version, 2);
  });
  test('a malformed expected_version is refused with a clear message', async () => {
    await put(v1, 1);
    const res = await call({ expected_version: 'one' });
    assert.ok(res.isError); assert.match(res.content[0].text, /whole-number `version`/);
  });
  test('a shipped guide pins by sha256; a wrong sha256 is refused, expected_version alone is not checked', () => {
    const guide = { doc_id: 'guides/X.md', sha256: sha('guide'), version: undefined };
    assert.doesNotThrow(() => checkReadPin('guides/X.md', guide, { expected_sha256: sha('guide') }));
    assert.doesNotThrow(() => checkReadPin('guides/X.md', guide, { expected_version: 3 }));
    assert.throws(() => checkReadPin('guides/X.md', guide, { expected_sha256: sha('other') }), /document changed - restart from offset 0/);
  });
  test('the read_doc schema offers expected_version and expected_sha256', async () => {
    const { TOOLS } = await import('../src/tools.js');
    const tool = TOOLS.find((t) => t.name === 'read_doc');
    assert.ok(tool.inputSchema.properties.expected_version && tool.inputSchema.properties.expected_sha256);
    assert.match(tool.description, /restart from offset 0/);
  });
});

testGroup('host-received page size: escaped page plus the envelope spare stays within the limit (real read_doc path)', () => {
  const { READ_DOC_ENVELOPE_SPARE, jsonEscapedBytes } = TOOLS_MOD;
  const kinds = {
    'quote-heavy': ('| B-7 | "Row\'s" \u201cquoted\u201d \\"escaped\\" "a" "b" "c" | caf\u00e9 \u2014 \u65e5\u672c |\n').repeat(900),
    'code-like': ('{"key": "value", "list": [1, "two", {"x": "\\n\\t"}], "path": "C:\\\\dir\\\\file"}\n\t\tif (a && "b") { return "c\\\\d"; }\n').repeat(700),
    'short-line': ('a\n"\n\\\n\t\n\u00e9\n').repeat(9000)
  };
  for (const [kind, doc] of Object.entries(kinds)) {
    test(`${kind} text: every page within 18,000 as received, and the pages join back exactly`, async () => {
      await put(doc, 1);
      let r = null; let off = 0; let out = ''; let n = 0; let maxWire = 0;
      do {
        const res = await call({ offset: off, expected_version: 1 });
        const wire = Buffer.byteLength(res.content[0].text, 'utf8');
        maxWire = Math.max(maxWire, wire);
        r = data(res); out += r.content; n++;
        assert.ok(r.page, 'the document is paged');
        assert.strictEqual(r.page.returned_escaped, jsonEscapedBytes(r.content));
        assert.strictEqual(r.page.envelope_spare, READ_DOC_ENVELOPE_SPARE);
        assert.ok(r.page.returned_escaped + READ_DOC_ENVELOPE_SPARE <= 18000, `${kind} page ${n}: ${r.page.returned_escaped} escaped bytes`);
        assert.ok(wire <= 18000, `${kind} page ${n}: the whole result is ${wire} bytes as received`);
        off = r.page.next_offset;
      } while (off !== null && n < 100);
      assert.strictEqual(out, doc); assert.strictEqual(sha(out), r.sha256);
      assert.strictEqual(r.size, doc.length); assert.strictEqual(r.size_unit, 'characters');
      assert.strictEqual(r.size_bytes, Buffer.byteLength(doc, 'utf8')); assert.strictEqual(r.page.size_bytes, r.size_bytes);
      assert.ok(n >= 3, `${kind}: ${n} pages`);
    });
  }
});

await summary();
