/**
 * EMET - the whole shipped tree is free of install-specific names, private
 * record numbers, named deploy services and private commit ids (public
 * snapshot, 2026-10-02). Supersedes the per-file name checks that used to live
 * in the roster and bootstrap template suites.
 */
import { test, testGroup, summary } from './harness.js';
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { privateWordsIn, digest, PRIVATE_RECORD_REF, BARE_RECORD_REF, PRIVATE_PR_REF, APPROVAL_TIME, NAMED_SERVICE, SHORT_HEX, ALLOWED_HEX, BOARD_ID, boardIdLines, STAGING_STORE_PATH, SHORT_STORE_REF, INTERNAL_PAPER_REF, shippedTextFiles } from './scrub-tokens.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = shippedTextFiles(ROOT);
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
// This file plants one example of each pattern to prove the checker; it is
// still checked for names.
const SELF = 'tests/public-scrub.test.js';
// The publisher's contact address, chosen by the owner for the package author
// field. Compared by digest so the address is not written here. It is removed
// from the author field of package.json only; anywhere else it is still caught.
const APPROVED_AUTHOR_DIGESTS = new Set(['546b0e9680de5374']);
function withoutApprovedAuthor(text) {
  return text.replace(/("author"\s*:\s*"[^"<]*<)([^>"]+)(>")/, (m, a, e, b) => (APPROVED_AUTHOR_DIGESTS.has(digest(e)) ? a + 'approved-author' + b : m));
}
const others = files.filter((f) => f !== SELF);

testGroup('the shipped tree is scrubbed', () => {
  test('the walk finds the tree (src, tests, docs, templates, scripts)', () => {
    for (const d of ['src/', 'tests/', 'docs/', 'templates/', 'scripts/']) assert.ok(files.some((f) => f.startsWith(d)), d);
    assert.ok(files.includes('README.md') && files.includes('CHARTER.md'));
    assert.ok(files.includes('site/index.html') && files.includes('site/styles.css'));
  });
  test('no install-specific names in any file', () => {
    const bad = files.map((f) => [f, privateWordsIn(f === 'package.json' ? withoutApprovedAuthor(read(f)) : read(f))]).filter(([, w]) => w.length);
    assert.deepStrictEqual(bad, []);
  });
  test('the only allowance is the approved author address, and only in package.json author', () => {
    const pkg = JSON.parse(read('package.json'));
    const email = (String(pkg.author || '').match(/<([^>]+)>/) || [])[1];
    assert.ok(!email || APPROVED_AUTHOR_DIGESTS.has(digest(email)), 'package.json author email is not the approved one');
    assert.deepStrictEqual(privateWordsIn(withoutApprovedAuthor('"author": "X <someone@example.com>"')), []);
    // The same address anywhere else is still caught.
    if (email) assert.ok(privateWordsIn(`contact ${email}`).length > 0, 'the checker no longer sees the address outside the author field');
  });
  test('no private decision or incident record numbers', () => {
    const bad = others.filter((f) => PRIVATE_RECORD_REF.test(read(f)));
    assert.deepStrictEqual(bad, []);
  });
  test('no bare record numbers, private PR numbers or ET approval times (snapshot v0.1.1)', () => {
    const bad = [];
    for (const f of others) for (const [name, re] of [['record', BARE_RECORD_REF], ['pr', PRIVATE_PR_REF], ['time', APPROVAL_TIME]]) if (re.test(read(f))) bad.push(`${f}: ${name}`);
    assert.deepStrictEqual(bad, []);
    assert.ok(BARE_RECORD_REF.test('under #512.') && BARE_RECORD_REF.test('#513(1)') && !BARE_RECORD_REF.test('color:#333;') && !BARE_RECORD_REF.test('episodic#700'));
    assert.ok(PRIVATE_PR_REF.test('see PR #9') && APPROVAL_TIME.test('approved 2:05 PM ET') && !APPROVAL_TIME.test('at 9:30 PM in New York'));
  });
  test('no named deploy service in a command', () => {
    const bad = others.filter((f) => NAMED_SERVICE.test(read(f)));
    assert.deepStrictEqual(bad, []);
  });
  test('no private commit or deploy ids (public upstream ids and fixture digests allowed)', () => {
    const bad = [];
    for (const f of others) for (const m of read(f).match(SHORT_HEX) || []) if (!ALLOWED_HEX.has(m)) bad.push(`${f}: ${m}`);
    assert.deepStrictEqual(bad, []);
  });
  test('no board item ids, dated staging/ paths, short store refs or internal paper refs (0.2.1)', () => {
    const bad = [];
    for (const f of others) {
      const text = read(f);
      bad.push(...boardIdLines(f, text));
      if (STAGING_STORE_PATH.test(text)) bad.push(`${f}: staging path`);
      if (SHORT_STORE_REF.test(text)) bad.push(`${f}: store ref`);
      if (INTERNAL_PAPER_REF.test(text)) bad.push(`${f}: internal paper ref`);
    }
    assert.deepStrictEqual(bad, []);
  });
  test('the board-id, staging and store-ref checks catch what they should and pass the generic forms', () => {
    assert.ok(BOARD_ID.test('closed under B-120') && BOARD_ID.test('(B-017)') && !BOARD_ID.test('ids (`B-001`, `B-002`)') && !BOARD_ID.test('every B-### in the body'));
    assert.deepStrictEqual(boardIdLines('src/x.js', 'a\n// see B-120\nb'), ['src/x.js:2']);
    assert.deepStrictEqual(boardIdLines('tests/x.test.js', "const ROW = '| B-031 | item |';"), []);
    assert.deepStrictEqual(boardIdLines('tests/x.test.js', ' * closed as B-031\n'), ['tests/x.test.js:1']);
    assert.deepStrictEqual(boardIdLines('tests/x.test.js', "testGroup('B-066 (1) - x', () => {"), ['tests/x.test.js:1']);
    assert.ok(STAGING_STORE_PATH.test('see staging/some-audit-2026-09.md') && !STAGING_STORE_PATH.test("'staging/': 'templates/STAGING.md'") && !STAGING_STORE_PATH.test('staging/close.md'));
    assert.ok(SHORT_STORE_REF.test('(observed, meta #83)') && SHORT_STORE_REF.test('EMET #12') && !SHORT_STORE_REF.test('EMET 0.2.1'));
    assert.ok(INTERNAL_PAPER_REF.test('(C1 admission paper §1a)') && INTERNAL_PAPER_REF.test("the admission gate's second read") && INTERNAL_PAPER_REF.test('(paper section 3.5)') && INTERNAL_PAPER_REF.test('(paper 3.2)') && !INTERNAL_PAPER_REF.test('threads, seeds, working papers, bootstrap'));
  });
  test('the checker itself works: it catches a planted name, record number, service and id', () => {
    assert.deepStrictEqual(privateWordsIn('The Zebra said so; zebras differ.', new Set([digest('zebra')])), ['zebra']);
    assert.ok(PRIVATE_RECORD_REF.test('see procedural #123'));
    assert.ok(!PRIVATE_RECORD_REF.test('episodic 42'));
    assert.ok(NAMED_SERVICE.test('railway run --service app node x'));
    assert.ok(!NAMED_SERVICE.test('railway run --service <service> node x'));
    assert.deepStrictEqual('fixed in 1a2b3c4.'.match(SHORT_HEX), ['1a2b3c4']);
  });
});

summary('PUBLIC SCRUB TEST SUMMARY');
