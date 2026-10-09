/**
 * EMET - the whole shipped tree is free of install-specific names, private
 * record numbers, named deploy services and private commit ids (public
 * snapshot, 2026-10-02). Supersedes the per-file name checks that used to live
 * in the roster and bootstrap template suites.
 *
 * The publish scrub removes the review checklist, the dated status note, and
 * the private CI workflow. While those files are present, the name and record
 * checks cover the public surface: site pages, the Pages workflow, and the
 * README opening (through "Shared memory across hosts", plus the Origin
 * section). The scrubbed public tree has none of those files, and then the
 * whole walk is checked. Either way the walk must include site/*.html,
 * site/*.css, site/sitemap.xml, site/robots.txt, site/.nojekyll,
 * .github/workflows/pages.yml, and glama.json, so the next public release
 * cannot drop the site, the workflow that publishes it, or the directory
 * listing. Image assets the HTML references have to be on that same publish
 * walk. The Pages deploy job if must be exactly the public repository and
 * main; a longer repository name that only contains that text does not pass.
 */
import { test, testGroup, summary } from './harness.js';
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { privateWordsIn, digest, PRIVATE_RECORD_REF, BARE_RECORD_REF, PRIVATE_PR_REF, APPROVAL_TIME, NAMED_SERVICE, SHORT_HEX, ALLOWED_HEX, BOARD_ID, boardIdLines, STAGING_STORE_PATH, SHORT_STORE_REF, INTERNAL_PAPER_REF, shippedTextFiles, shippedPublishFiles, siteImageRefs, isPrivateTree } from './scrub-tokens.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = shippedTextFiles(ROOT);
const published = shippedPublishFiles(ROOT);
const PAGES_IF = "github.repository == 'dreamforgestudiollc/EMET' && github.ref == 'refs/heads/main'";

/** Every job under jobs:. A job with no `if` is recorded with expr null. */
function pagesJobs(yaml) {
  const jobs = [];
  let inJobs = false;
  let current = null;
  const flush = () => { if (current) jobs.push(current); current = null; };
  for (const line of String(yaml).split(/\r?\n/)) {
    if (/^jobs:\s*$/.test(line)) { flush(); inJobs = true; continue; }
    if (!inJobs) continue;
    if (/^(?![\s#])\S/.test(line)) { flush(); inJobs = false; continue; }
    const jobLine = line.match(/^  ([A-Za-z0-9_-]+):\s*$/);
    if (jobLine) {
      flush();
      current = { job: jobLine[1], expr: null };
      continue;
    }
    if (!current) continue;
    const ifLine = line.match(/^    if:\s*(.*?)\s*$/);
    if (!ifLine) continue;
    let expr = ifLine[1];
    if ((expr.startsWith('"') && expr.endsWith('"') && expr.length >= 2) || (expr.startsWith("'") && expr.endsWith("'") && expr.length >= 2)) expr = expr.slice(1, -1);
    current.expr = current.expr == null ? expr : `${current.expr}\n${expr}`;
  }
  flush();
  return jobs;
}
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
const privateTree = isPrivateTree(ROOT);

function readmePublicParts(text) {
  const shared = text.indexOf('\n## Shared memory across hosts\n');
  const opening = shared >= 0 ? text.slice(0, shared) : text;
  const originAt = text.indexOf('\n## Origin\n');
  const licenseAt = text.indexOf('\n## License\n');
  const origin = originAt >= 0 && licenseAt > originAt ? text.slice(originAt, licenseAt) : '';
  return `${opening}\n${origin}`;
}

function scrubText(rel) {
  let text = read(rel);
  if (rel === 'package.json') text = withoutApprovedAuthor(text);
  if (privateTree && rel === 'README.md') text = readmePublicParts(text);
  return text;
}

const surface = [
  ...files.filter((f) => f.startsWith('site/') || f === '.github/workflows/pages.yml' || f === 'glama.json'),
  'README.md',
];
const checked = privateTree ? surface : files;
const others = checked.filter((f) => f !== SELF);

testGroup('the shipped tree is scrubbed', () => {
  test('the walk finds the tree (src, tests, docs, templates, scripts)', () => {
    for (const d of ['src/', 'tests/', 'docs/', 'templates/', 'scripts/']) assert.ok(files.some((f) => f.startsWith(d)), d);
    assert.ok(files.includes('README.md') && files.includes('CHARTER.md'));
    assert.ok(files.includes('site/index.html') && files.includes('site/styles.css'));
    assert.ok(files.includes('.github/workflows/pages.yml'));
    assert.ok(files.includes('glama.json'));
    for (const rel of ['site/sitemap.xml', 'site/robots.txt', 'site/.nojekyll']) assert.ok(files.includes(rel), rel);
  });
  test('the Pages deploy job if is exactly the public repository and main', () => {
    const pages = read('.github/workflows/pages.yml');
    const required = [{ job: 'deploy', expr: PAGES_IF }];
    assert.deepStrictEqual(pagesJobs(pages), required);
    const widened = pages.replace("dreamforgestudiollc/EMET'", "dreamforgestudiollc/EMET-private'");
    assert.notDeepStrictEqual(pagesJobs(widened), required);
    // The old checks were two unanchored matches anywhere in the file. Both strings
    // can sit in comments while the job if names a different repository.
    const split = pages.replace(
      `if: ${PAGES_IF}`,
      "if: github.repository == 'dreamforgestudiollc/EMET-private'\n    # github.repository == 'dreamforgestudiollc/EMET'\n    # github.ref == 'refs/heads/main'"
    );
    assert.match(split, /github\.repository == 'dreamforgestudiollc\/EMET'/);
    assert.match(split, /github\.ref == 'refs\/heads\/main'/);
    assert.notDeepStrictEqual(pagesJobs(split), required);
    // A second job with no if used to be invisible, because only jobs that had an if were recorded.
    const extra = `${pages}\n  other:\n    runs-on: ubuntu-latest\n`;
    assert.deepStrictEqual(pagesJobs(extra), [...required, { job: 'other', expr: null }]);
  });
  test('the publish walk keeps sitemap, .nojekyll, and every image the site HTML references', () => {
    for (const rel of ['site/sitemap.xml', 'site/robots.txt', 'site/.nojekyll']) assert.ok(published.includes(rel), rel);
    const referenced = [];
    const faults = [];
    for (const page of files.filter((f) => f.startsWith('site/') && f.endsWith('.html'))) {
      const found = siteImageRefs(read(page), page);
      referenced.push(...found.paths);
      faults.push(...found.faults);
    }
    assert.deepStrictEqual(faults, []);
    assert.ok(referenced.length > 0, 'no image references parsed from site HTML');
    const missing = referenced.filter((rel) => !published.includes(rel));
    assert.deepStrictEqual(missing, []);
    assert.deepStrictEqual(
      siteImageRefs('<img src="assets/a.png" srcset="assets/b.webp 1x, assets/c.webp 2x"><meta content="https://dreamforgestudiollc.github.io/EMET/assets/og.jpg"><script type="application/ld+json">{"image":"https://dreamforgestudiollc.github.io/EMET/assets/og.jpg"}</script>', 'site/index.html'),
      { paths: ['site/assets/a.png', 'site/assets/b.webp', 'site/assets/c.webp', 'site/assets/og.jpg'], faults: [] }
    );
    assert.deepStrictEqual(siteImageRefs('<img src="https://example.com/assets/og.jpg">', 'site/index.html'), { paths: [], faults: [] });
    const bad = siteImageRefs([
      '<img src="/EMET/assets/x.png">',
      '<img src="//dreamforgestudiollc.github.io/EMET/assets/x.png">',
      '<img src="../../secret.png">',
      '<script type="application/ld+json">{"image":"/EMET/assets/y.webp"}</script>',
    ].join(''), 'site/index.html');
    assert.deepStrictEqual(bad.paths, []);
    assert.deepStrictEqual(bad.faults, [
      '../../secret.png',
      '//dreamforgestudiollc.github.io/EMET/assets/x.png',
      '/EMET/assets/x.png',
      '/EMET/assets/y.webp',
    ]);
  });
  test('no install-specific names in any file', () => {
    const nameFiles = privateTree ? checked : files;
    const bad = nameFiles.map((f) => [f, privateWordsIn(scrubText(f))]).filter(([, w]) => w.length);
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
    const bad = others.filter((f) => PRIVATE_RECORD_REF.test(scrubText(f)));
    assert.deepStrictEqual(bad, []);
  });
  test('no bare record numbers, private PR numbers or ET approval times (snapshot v0.1.1)', () => {
    const bad = [];
    for (const f of others) for (const [name, re] of [['record', BARE_RECORD_REF], ['pr', PRIVATE_PR_REF], ['time', APPROVAL_TIME]]) if (re.test(scrubText(f))) bad.push(`${f}: ${name}`);
    assert.deepStrictEqual(bad, []);
    assert.ok(BARE_RECORD_REF.test('under #512.') && BARE_RECORD_REF.test('#513(1)') && !BARE_RECORD_REF.test('color:#333;') && !BARE_RECORD_REF.test('episodic#700'));
    assert.ok(PRIVATE_PR_REF.test('see PR #9') && APPROVAL_TIME.test('approved 2:05 PM ET') && !APPROVAL_TIME.test('at 9:30 PM in New York'));
  });
  test('no named deploy service in a command', () => {
    const bad = others.filter((f) => NAMED_SERVICE.test(scrubText(f)));
    assert.deepStrictEqual(bad, []);
  });
  test('no private commit or deploy ids (public upstream ids and fixture digests allowed)', () => {
    const bad = [];
    for (const f of others) for (const m of scrubText(f).match(SHORT_HEX) || []) if (!ALLOWED_HEX.has(m)) bad.push(`${f}: ${m}`);
    assert.deepStrictEqual(bad, []);
  });
  test('no board item ids, dated staging/ paths, short store refs or internal paper refs (0.2.1)', () => {
    const bad = [];
    for (const f of others) {
      const text = scrubText(f);
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
