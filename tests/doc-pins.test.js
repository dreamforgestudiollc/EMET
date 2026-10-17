/**
 * EMET - pinned documentation lines (board 127, board 128, the GEP-0003 Changed entry).
 *
 * A correction is settled by a check. These assertions fail if the GEM
 * expansion moves off first use, or if the continuous-chat lines drop out.
 * ISO 9001 7.5.3 / ISO 13485 4.2.5 document-control wording stays as written
 * in the Changed entry; iso-positioning.test.js holds the standing ISO text.
 */
import { test, testGroup, summary } from './harness.js';
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const LEAD = 'Golem Expertise Module (';
const EXPANSION = `${LEAD}GEM)`;

function assertFirstGemUse(rel) {
  const text = read(rel);
  const match = /\bGEM\b/.exec(text);
  assert.ok(match, `${rel} uses GEM`);
  assert.ok(match.index >= LEAD.length, `${rel} expands GEM on first use`);
  assert.strictEqual(
    text.slice(match.index - LEAD.length, match.index + 'GEM)'.length),
    EXPANSION,
    `${rel} first use`
  );
  assert.doesNotMatch(text, /GEM \(Golem Expertise Module\)/);
  assert.doesNotMatch(text, /GEMs \(Golem Expertise Modules\)/);
}

testGroup('the GEM expansion and the standing chat lines do not drift', () => {
  test('README spells out Golem Expertise Module (GEM) on first use', () => {
    assertFirstGemUse('README.md');
  });

  test('the GEM spec spells out Golem Expertise Module (GEM) on first use', () => {
    assertFirstGemUse('gem-library/SPEC.md');
  });

  test('the GEP-0003 Changed entry says Fieldnote is off by default', () => {
    const change = read('CHANGELOG.md');
    const unreleased = change.slice(change.indexOf('## Unreleased'), change.indexOf('## 0.2.5'));
    const changed = unreleased.slice(unreleased.indexOf('### Changed'), unreleased.indexOf('### Docs'));
    assert.match(changed, /GEP-0003/);
    assert.match(changed, /Fieldnote is off by default\./);
    assert.doesNotMatch(changed, /Fieldnote stays off/);
    assert.match(changed, /ISO 9001 7\.5\.3 \/ ISO 13485 4\.2\.5 document-control wording is unchanged\./);
  });

  test('continuous long-running chats keep the nightly checkpoint and the polling rule', () => {
    const readme = read('README.md');
    const at = readme.indexOf('**Continuous chats.**');
    assert.ok(at >= 0);
    const para = readme.slice(at, readme.indexOf('\n\n', at));
    for (const line of [
      'word for word at least nightly (a checkpoint)',
      'Prefer event triggers over time-based polling.',
      'When polling is unavoidable, use the longest interval the job allows.',
    ]) {
      assert.ok(para.includes(line), line);
    }
  });
});

summary('doc pins');
