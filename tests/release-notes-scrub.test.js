/**
 * EMET - the 0.3.2 release notes and Unreleased, when present, carry no
 * private-sync leaks. The public-surface scrub does not read CHANGELOG on
 * this tree, so a host path or a live client id planted in ## 0.3.2 used to
 * stay green. This suite is the red check.
 *
 * PUBLIC-SYNC.md ## Leave here is pinned to the paths that stay private and
 * to the line that keeps them out of the npm package.
 */
import { test, testGroup, summary } from './harness.js';
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** Text of one ## heading, through the line before the next ## heading. */
export function headingSlice(text, heading) {
  const at = text.indexOf(heading);
  if (at < 0) return '';
  const rest = text.slice(at);
  const next = rest.slice(heading.length).search(/\n## /);
  return next < 0 ? rest : rest.slice(0, heading.length + next);
}

const LIVE_CLIENT = /\b8xm-[A-Za-z0-9_-]{10,}\b/;
const PLANTED_CLIENT = '8xm-exampleclientid';

const LEAVE_PATHS = Object.freeze([
  'hosts/GROK.md',
  'hosts/',
  'records/',
  'docs/proof',
  'docs/proposals/',
  'docs/status/',
]);

/** Markers that must not appear in a release-note section. */
export function releaseNoteLeaks(text) {
  const hits = [];
  const body = String(text);
  for (const marker of LEAVE_PATHS) {
    if (body.includes(marker)) hits.push(marker);
  }
  const client = body.match(LIVE_CLIENT);
  if (client) hits.push(client[0]);
  return hits;
}

testGroup('0.3.2 release notes reject private leaks', () => {
  const change = read('CHANGELOG.md');
  const notes = `${headingSlice(change, '## Unreleased')}\n${headingSlice(change, '## 0.3.2')}`;

  test('## 0.3.2 is present and Unreleased is included when it exists', () => {
    assert.ok(change.includes('## 0.3.2'), '## 0.3.2 is missing');
    assert.ok(headingSlice(change, '## 0.3.2').includes('### Added'));
    assert.ok(change.includes('## Unreleased'));
    assert.ok(notes.includes('Nothing is waiting above 0.3.2.'));
  });

  test('the 0.3.2 and Unreleased sections have no leave-here path or live client id', () => {
    assert.deepStrictEqual(releaseNoteLeaks(notes), []);
  });

  test('planting hosts/GROK.md and a live client id in ## 0.3.2 is red', () => {
    const client = PLANTED_CLIENT;
    assert.match(client, LIVE_CLIENT);
    const planted = `${notes}\nSee hosts/GROK.md for client ${client}. Also records/ and docs/proof/.\n`;
    const hits = releaseNoteLeaks(planted);
    assert.ok(hits.includes('hosts/GROK.md'), hits.join(','));
    assert.ok(hits.includes('hosts/'), hits.join(','));
    assert.ok(hits.includes(client), hits.join(','));
    assert.ok(hits.includes('records/'), hits.join(','));
    assert.ok(hits.includes('docs/proof'), hits.join(','));
    assert.deepStrictEqual(releaseNoteLeaks('client_id on a write is not a live id'), []);
    assert.deepStrictEqual(releaseNoteLeaks('## 0.3.0 still names older upgrade steps'), []);
  });

  test('an older changelog section is not the slice under test', () => {
    const older = headingSlice(change, '## 0.3.0');
    assert.ok(older.includes('## 0.3.0'));
    assert.ok(!notes.includes('Upgrading to 0.3.0:'));
    assert.ok(older.includes('Upgrading to 0.3.0:'));
  });
});

summary('RELEASE NOTES SCRUB');
