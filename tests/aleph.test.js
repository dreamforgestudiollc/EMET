/**
 * EMET - aleph (read-back verification) tests.
 *
 * No database: aleph's comparison logic is pure, and that is the part that must
 * never be wrong. A verifier that passes something it should have caught is
 * worse than no verifier, because it converts an undetected problem into a
 * confident assurance - so the failure cases are tested at least as carefully
 * as the success ones.
 */

import { test, testGroup, summary } from './harness.js';
import assert from 'assert';
import fs from 'fs';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { digest, verifyDocument, verifyLayerEntry, integrityOf, canonicalJson, digestMetadata, metadataIntegrityOf, signDigests, signatureIntegrityOf, chainDigest, chainIntegrityOf, walkChain, AlephError } from '../src/aleph.js';





testGroup('digest', () => {
  test('is deterministic', () => assert.strictEqual(digest('hello'), digest('hello')));
  test('is sensitive to a single character', () => assert.notStrictEqual(digest('hello'), digest('hellp')));
  test('is the sha256 of the shipped charter, and of a one-character string', () => {
    const shipped = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'CHARTER.md'));
    assert.strictEqual(digest(shipped.toString('utf8')), crypto.createHash('sha256').update(shipped).digest('hex'));
    assert.strictEqual(digest('x'), '2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881');
  });
  test('handles unicode', () => assert.match(digest('memory - אמת - 記憶'), /^[0-9a-f]{64}$/));
  test('distinguishes empty string from a space', () => assert.notStrictEqual(digest(''), digest(' ')));
});

testGroup('verifyDocument - accepts a real match', () => {
  const sha = digest('content');
  test('returns a verified receipt', () => {
    const r = verifyDocument({ sha256: sha, version: 3 }, { doc_id: 'd.md', sha256: sha, version: 3 });
    assert.strictEqual(r.verified, true);
    assert.strictEqual(r.version, 3);
  });
  test('tolerates an absent expected version', () => {
    const r = verifyDocument({ sha256: sha, version: 9 }, { doc_id: 'd.md', sha256: sha });
    assert.strictEqual(r.verified, true);
  });
});

testGroup('verifyDocument - catches what it exists to catch', () => {
  const sha = digest('content');
  test('missing document throws AlephError', () => {
    assert.throws(() => verifyDocument(null, { doc_id: 'd.md', sha256: sha, version: 1 }), AlephError);
  });
  test('digest mismatch throws AlephError', () => {
    assert.throws(() => verifyDocument({ sha256: digest('other'), version: 1 }, { doc_id: 'd.md', sha256: sha, version: 1 }), AlephError);
  });
  test('version drift throws AlephError even when content matches', () => {
    assert.throws(() => verifyDocument({ sha256: sha, version: 2 }, { doc_id: 'd.md', sha256: sha, version: 1 }), AlephError);
  });
  test('the error names the document', () => {
    try { verifyDocument(null, { doc_id: 'HANDOFF.md', sha256: sha, version: 1 }); assert.fail('should have thrown'); }
    catch (e) { assert(e.message.includes('HANDOFF.md')); }
  });
  test('the error tells the caller not to retry blindly', () => {
    try { verifyDocument({ sha256: digest('other'), version: 1 }, { doc_id: 'd.md', sha256: sha, version: 1 }); assert.fail('should have thrown'); }
    catch (e) { assert(/do not retry/i.test(e.message)); }
  });
});

testGroup('verifyLayerEntry', () => {
  test('accepts content stored under `content`', () => {
    const r = verifyLayerEntry({ content: 'remembered' }, { id: 7, content: 'remembered', layer: 'episodic' });
    assert.strictEqual(r.verified, true);
    assert.strictEqual(r.id, 7);
  });
  test('accepts content stored under the legacy `event` field', () => {
    const r = verifyLayerEntry({ event: 'remembered' }, { id: 7, content: 'remembered', layer: 'episodic' });
    assert.strictEqual(r.verified, true);
  });
  test('missing entry throws AlephError', () => {
    assert.throws(() => verifyLayerEntry(null, { id: 7, content: 'x', layer: 'meta' }), AlephError);
  });
  test('different content at the id throws AlephError', () => {
    assert.throws(() => verifyLayerEntry({ content: 'someone elses memory' }, { id: 7, content: 'mine', layer: 'meta' }), AlephError);
  });
  test('the id-collision error explains the counter cause', () => {
    try { verifyLayerEntry({ content: 'other' }, { id: 1, content: 'mine', layer: 'meta' }); assert.fail('should have thrown'); }
    catch (e) { assert(/counter/i.test(e.message) && /prefix/i.test(e.message)); }
  });
});

testGroup('AlephError is distinguishable from a database failure', () => {
  test('carries WRITE_ERROR, not DATABASE_ERROR', () => {
    try { verifyLayerEntry(null, { id: 1, content: 'x', layer: 'meta' }); assert.fail('should have thrown'); }
    catch (e) { assert.strictEqual(e.code, 'WRITE_ERROR'); }
  });
  test('carries verified: false', () => {
    try { verifyLayerEntry(null, { id: 1, content: 'x', layer: 'meta' }); assert.fail('should have thrown'); }
    catch (e) { assert.strictEqual(e.verified, false); }
  });
  test('serialises with verified: false for the caller', () => {
    try { verifyLayerEntry(null, { id: 1, content: 'x', layer: 'meta' }); assert.fail('should have thrown'); }
    catch (e) { assert.strictEqual(e.toSafeJSON().error.verified, false); }
  });
  test('is named AlephError', () => {
    try { verifyLayerEntry(null, { id: 1, content: 'x', layer: 'meta' }); assert.fail('should have thrown'); }
    catch (e) { assert.strictEqual(e.name, 'AlephError'); }
  });
});

testGroup('verifyLayerEntry - stored sha256 column', () => {
  const content = 'a memory';
  const sha = digest(content);
  test('accepts a row whose sha256 column matches its content, and reports the digest as stored', () => {
    const r = verifyLayerEntry({ id: 5, content, sha256: sha }, { id: 5, content, layer: 'semantic' });
    assert.strictEqual(r.verified, true);
    assert.strictEqual(r.sha256, sha);
    assert.strictEqual(r.digest_stored, true);
  });
  test('accepts a pre-#12 row with no sha256 column, and reports the digest as not stored', () => {
    const r = verifyLayerEntry({ id: 5, content }, { id: 5, content, layer: 'semantic' });
    assert.strictEqual(r.verified, true);
    assert.strictEqual(r.digest_stored, false);
  });
  test('treats a null sha256 column the same as absent', () => {
    const r = verifyLayerEntry({ id: 5, content, sha256: null }, { id: 5, content, layer: 'semantic' });
    assert.strictEqual(r.digest_stored, false);
  });
  test('rejects a row whose sha256 column disagrees with its own content', () => {
    assert.throws(
      () => verifyLayerEntry({ id: 5, content, sha256: digest('something else') }, { id: 5, content, layer: 'semantic' }),
      (e) => e instanceof AlephError && /internally inconsistent/.test(e.message)
    );
  });
  test('column mismatch is reported even when content otherwise matches what was written', () => {
    try { verifyLayerEntry({ id: 5, content, sha256: 'deadbeef' }, { id: 5, content, layer: 'meta' }); assert.fail('should throw'); }
    catch (e) { assert.strictEqual(e.details.column_sha256, 'deadbeef'); assert.strictEqual(e.details.content_sha256, sha); }
  });
});

testGroup('integrityOf - the write-time attestation, re-checked on read (E2)', () => {
  const content = 'a row that was attested at write';
  test('true when the content digest equals the stored column', () => {
    assert.strictEqual(integrityOf({ content, sha256: digest(content) }), true);
  });
  test('accepts the legacy event column when content is absent', () => {
    assert.strictEqual(integrityOf({ event: content, sha256: digest(content) }), true);
  });
  test('prefers content over event when both are present', () => {
    assert.strictEqual(integrityOf({ content, event: 'something else', sha256: digest(content) }), true);
  });
  test('false when the stored column disagrees - the row is not what was attested', () => {
    assert.strictEqual(integrityOf({ content, sha256: digest(content + ' altered') }), false);
    assert.strictEqual(integrityOf({ content, sha256: 'deadbeef' }), false);
  });
  test('false when a column exists but there is no content to hash', () => {
    assert.strictEqual(integrityOf({ sha256: digest(content) }), false);
  });
  test("'unattested' for a row with no sha256 column (pre-2026-09-05)", () => {
    assert.strictEqual(integrityOf({ content }), 'unattested');
    assert.strictEqual(integrityOf({ content, sha256: '' }), 'unattested');
    assert.strictEqual(integrityOf({ content, sha256: null }), 'unattested');
  });
  test("'unattested' for a non-row, never a throw", () => {
    assert.strictEqual(integrityOf(null), 'unattested');
    assert.strictEqual(integrityOf(undefined), 'unattested');
    assert.strictEqual(integrityOf('text'), 'unattested');
  });
  test('the three values are distinguishable: a mismatch is never confused with a missing column', () => {
    const results = [integrityOf({ content, sha256: digest(content) }), integrityOf({ content, sha256: 'x' }), integrityOf({ content })];
    assert.deepStrictEqual(results, [true, false, 'unattested']);
  });
});

testGroup('canonicalJson / digestMetadata - the same metadata always digests the same (C1)', () => {
  test('key order does not matter, at any depth', () => {
    const a = { b: 1, a: { y: [1, { q: 2, p: 1 }], x: 'z' } };
    const b = { a: { x: 'z', y: [1, { p: 1, q: 2 }] }, b: 1 };
    assert.strictEqual(canonicalJson(a), canonicalJson(b));
    assert.strictEqual(digestMetadata(a), digestMetadata(b));
  });
  test('array order DOES matter - tags in a different order are different metadata', () => {
    assert.notStrictEqual(digestMetadata({ tags: ['a', 'b'] }), digestMetadata({ tags: ['b', 'a'] }));
  });
  test('undefined values are dropped, null values are kept', () => {
    assert.strictEqual(canonicalJson({ a: undefined, b: null }), '{"b":null}');
    assert.strictEqual(digestMetadata({ a: undefined, b: 1 }), digestMetadata({ b: 1 }));
    assert.notStrictEqual(digestMetadata({ b: null }), digestMetadata({}));
  });
  test('a legacy JSON-string metadata digests the same as its parsed object', () => {
    const md = { importance: 0.7, tags: ['x'], custom: { k: 'v' } };
    assert.strictEqual(digestMetadata(JSON.stringify(md)), digestMetadata(md));
  });
  test('null / undefined metadata digest as the empty object', () => {
    assert.strictEqual(digestMetadata(null), digestMetadata({}));
    assert.strictEqual(digestMetadata(undefined), digestMetadata({}));
  });
  test('a one-character change anywhere changes the digest', () => {
    assert.notStrictEqual(digestMetadata({ source: 'cloud-host' }), digestMetadata({ source: 'cloud-hosT' }));
    assert.notStrictEqual(digestMetadata({ importance: 0.7 }), digestMetadata({ importance: 0.71 }));
  });
});

testGroup('metadataIntegrityOf - the metadata attestation re-checked on read (C1)', () => {
  const md = { source: 'x', tags: ['a'], routing: { method: 'explicit' } };
  test('true when the stored column agrees with the metadata beside it', () => {
    assert.strictEqual(metadataIntegrityOf({ metadata: md, metadata_sha256: digestMetadata(md) }), true);
  });
  test('true regardless of the key order the store returns', () => {
    const reordered = { routing: { method: 'explicit' }, tags: ['a'], source: 'x' };
    assert.strictEqual(metadataIntegrityOf({ metadata: reordered, metadata_sha256: digestMetadata(md) }), true);
  });
  test('false when the metadata was changed after attestation', () => {
    assert.strictEqual(metadataIntegrityOf({ metadata: { ...md, source: 'y' }, metadata_sha256: digestMetadata(md) }), false);
  });
  test("'unattested' when there is no column", () => {
    assert.strictEqual(metadataIntegrityOf({ metadata: md }), 'unattested');
    assert.strictEqual(metadataIntegrityOf({ metadata: md, metadata_sha256: null }), 'unattested');
    assert.strictEqual(metadataIntegrityOf(null), 'unattested');
  });
  test('a legacy string-shaped metadata still verifies against its column', () => {
    assert.strictEqual(metadataIntegrityOf({ metadata: JSON.stringify(md), metadata_sha256: digestMetadata(md) }), true);
  });
});

testGroup('verifyLayerEntry - metadata attestation at the write (C1)', () => {
  const content = 'attested content';
  const md = { source: 'x', importance: 0.6 };
  test('reports the metadata digest and that the column was stored', () => {
    const r = verifyLayerEntry(
      { id: 9, content, sha256: digest(content), metadata: md, metadata_sha256: digestMetadata(md) },
      { id: 9, content, layer: 'working', metadata: md }
    );
    assert.strictEqual(r.metadata_sha256, digestMetadata(md));
    assert.strictEqual(r.metadata_digest_stored, true);
  });
  test('a row without the column is unattested for metadata but still verifies', () => {
    const r = verifyLayerEntry({ id: 9, content, metadata: md }, { id: 9, content, layer: 'working', metadata: md });
    assert.strictEqual(r.verified, true);
    assert.strictEqual(r.metadata_digest_stored, false);
    assert.strictEqual(r.metadata_sha256, digestMetadata(md));
  });
  test('throws when the column disagrees with the metadata beside it', () => {
    assert.throws(
      () => verifyLayerEntry({ id: 9, content, metadata: md, metadata_sha256: 'deadbeef' }, { id: 9, content, layer: 'working' }),
      (e) => e instanceof AlephError && /metadata_sha256 column that does not match/.test(e.message)
    );
  });
  test('throws when the stored metadata differs from what was written', () => {
    assert.throws(
      () => verifyLayerEntry({ id: 9, content, metadata: { ...md, source: 'y' } }, { id: 9, content, layer: 'working', metadata: md }),
      (e) => e instanceof AlephError && /different metadata than was written/.test(e.message)
    );
  });
  test('callers that do not supply expected.metadata are unaffected', () => {
    const r = verifyLayerEntry({ id: 9, content }, { id: 9, content, layer: 'working' });
    assert.strictEqual(r.verified, true);
    assert.strictEqual(r.metadata_sha256, null);
  });
});

testGroup('signed digests - key never in the row', () => {
  const key = 'test-signing-key';
  const c = digest('body');
  const m = digestMetadata({ source: 'project-host' });
  test('sign is deterministic for the same digests and key', () => {
    assert.strictEqual(signDigests(c, m, key), signDigests(c, m, key));
  });
  test('a different key produces a different signature', () => {
    assert.notStrictEqual(signDigests(c, m, key), signDigests(c, m, 'other-key'));
  });
  test('changing either digest changes the signature', () => {
    assert.notStrictEqual(signDigests(c, m, key), signDigests(digest('other'), m, key));
  });
  test('no key means no signature', () => assert.strictEqual(signDigests(c, m, null), null));
  test('a signed row verifies', () => {
    const sig = signDigests(c, m, key);
    assert.strictEqual(signatureIntegrityOf({ sha256: c, metadata_sha256: m, signature: sig }, key), true);
  });
  test('an altered digest fails the signature', () => {
    const sig = signDigests(c, m, key);
    assert.strictEqual(signatureIntegrityOf({ sha256: digest('tampered'), metadata_sha256: m, signature: sig }, key), false);
  });
  test('a row with no signature column is unsigned, not a failure', () => {
    assert.strictEqual(signatureIntegrityOf({ sha256: c, metadata_sha256: m }, key), 'unsigned');
  });
  test('a signed row with no key configured is no_key', () => {
    assert.strictEqual(signatureIntegrityOf({ sha256: c, metadata_sha256: m, signature: 'abc' }, null), 'no_key');
  });
});

testGroup('hash chain', () => {
  const a = digest('one');
  const b = digest('two');
  test('chain digest is deterministic', () => assert.strictEqual(chainDigest(a, b), chainDigest(a, b)));
  test('changing the previous hash breaks the chain', () => assert.notStrictEqual(chainDigest(a, b), chainDigest(digest('other'), b)));
  test('a linked row verifies', () => {
    const row = { sha256: b, prev_sha256: a, chain_sha256: chainDigest(a, b) };
    assert.strictEqual(chainIntegrityOf(row), true);
  });
  test('an edited content hash fails the chain', () => {
    const row = { sha256: digest('tampered'), prev_sha256: a, chain_sha256: chainDigest(a, b) };
    assert.strictEqual(chainIntegrityOf(row), false);
  });
  test('a pre-chain row is unlinked, not broken', () => {
    assert.strictEqual(chainIntegrityOf({ sha256: a }), 'unlinked');
  });
});

// 2026-09-29: the walk in id order - what chainIntegrityOf alone cannot see.
testGroup('walkChain', () => {
  // Build rows exactly as the write path does: prev = sha256 of the previous row.
  const build = (n, { unlinkedFirst = 0 } = {}) => {
    const rows = []; let prev = null;
    for (let i = 1; i <= n; i++) {
      const sha = digest(`row ${i}`);
      const row = i <= unlinkedFirst ? { id: i, sha256: sha } : { id: i, sha256: sha, prev_sha256: prev, chain_sha256: chainDigest(prev, sha) };
      rows.push(row); prev = sha;
    }
    return rows;
  };
  test('an intact chain: all linked, nothing broken, no discontinuity, head is the last row', () => {
    const w = walkChain(build(5));
    assert.deepStrictEqual([w.total, w.linked, w.broken, w.discontinuities], [5, 5, 0, 0]);
    assert.strictEqual(w.head.id, 5);
  });
  test('THE POINT: a row removed from the middle is caught, though every remaining row is self-consistent', () => {
    const rows = build(5).filter((r) => r.id !== 3);
    assert.ok(rows.every((r) => chainIntegrityOf(r) === true), 'each row alone still verifies');
    const w = walkChain(rows);
    assert.strictEqual(w.discontinuities, 1);
    assert.deepStrictEqual(w.discontinuity_ids, [4]);
  });
  test('removing the newest row is not detectable by walking - the head moves back (stated limit)', () => {
    const w = walkChain(build(5).filter((r) => r.id !== 5));
    assert.strictEqual(w.discontinuities, 0);
    assert.strictEqual(w.head.id, 4);
  });
  test('an edited row is broken, and the row after it still links to the stored digest', () => {
    const rows = build(4); rows[1] = { ...rows[1], sha256: digest('tampered') };
    const w = walkChain(rows);
    assert.strictEqual(w.broken, 1); assert.deepStrictEqual(w.broken_ids, [2]);
    assert.strictEqual(w.discontinuities, 1, 'row 3 recorded the original digest of row 2');
  });
  test('a fork - two rows recording the same predecessor - is a discontinuity', () => {
    const rows = build(3);
    const sha4 = digest('row 4');
    rows.push({ id: 4, sha256: sha4, prev_sha256: rows[1].sha256, chain_sha256: chainDigest(rows[1].sha256, sha4) });
    assert.strictEqual(walkChain(rows).discontinuities, 1);
  });
  test('attested rows written before the chain existed are unlinked, and the first linked row joins them', () => {
    const w = walkChain(build(5, { unlinkedFirst: 2 }));
    assert.deepStrictEqual([w.unlinked, w.linked, w.discontinuities], [2, 3, 0]);
  });
  test('input order does not matter', () => {
    const w = walkChain(build(5).reverse());
    assert.deepStrictEqual([w.linked, w.discontinuities], [5, 0]);
  });
  test('a partial walk is judged against its seed', () => {
    const rows = build(6);
    assert.strictEqual(walkChain(rows.slice(3), { seedSha256: rows[2].sha256 }).discontinuities, 0);
    assert.strictEqual(walkChain(rows.slice(3), { seedSha256: digest('wrong') }).discontinuities, 1);
  });
  test('empty input is an empty, clean walk', () => {
    const w = walkChain([]);
    assert.deepStrictEqual([w.total, w.linked, w.broken, w.discontinuities, w.head], [0, 0, 0, 0, null]);
  });
});

summary('ALEPH TEST SUMMARY');
