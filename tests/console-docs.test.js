/**
 * The README collection list and the changelog stay aligned with the role
 * and with the console scope.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, testGroup, summary } from './harness.js';
import { DELETE_ALLOWED } from '../src/atlas-role.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

console.log('\n=== console docs ===');

testGroup('prefixed collections and the changelog', () => {
  test('every DELETE_ALLOWED prefix key is named in the README list', () => {
    const readme = read('README.md');
    const list = readme.slice(readme.indexOf('EMET_COLLECTION_PREFIX'), readme.indexOf('EMET_VECTOR_INDEX'));
    const prefixed = Object.keys(DELETE_ALLOWED)
      .filter((name) => name.startsWith('{prefix}'))
      .map((name) => name.slice('{prefix}'.length));
    assert.ok(prefixed.includes('console_refresh'));
    assert.ok(prefixed.includes('oauth_tokens'));
    for (const name of prefixed) assert.ok(list.includes(name), name);
  });

  test('0.3.8 names emet.console', () => {
    const log = read('CHANGELOG.md');
    const section = log.slice(log.indexOf('## 0.3.8'), log.indexOf('\n## ', log.indexOf('## 0.3.8') + 1));
    assert.match(section, /emet\.console/);
    assert.match(section, /EMET_CONSOLE_ORIGINS/);
    assert.match(section, /console_refresh/);
  });
});

await summary('CONSOLE DOCS');
