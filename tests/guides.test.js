/**
 * EMET - shipped guide tests. No database.
 */

import { test, summary } from './harness.js';
import assert from 'assert';
import fs from 'fs';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { readShippedGuide, shippedGuides } from '../src/guides.js';
import { FLOOR } from '../src/floor.js';


console.log('\n=== Shipped guides ===');
const ID = 'guides/NEURODIVERGENT_SUPPORT.md';
test('the neurodivergent support guide ships', () => assert(shippedGuides().includes(ID)));
test('it is read from the release', () => {
  const g = readShippedGuide(ID);
  assert(g && g.source === 'release' && g.content.length > 1000);
  const shipped = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'guides', 'NEURODIVERGENT_SUPPORT.md'));
  assert.strictEqual(g.sha256, crypto.createHash('sha256').update(shipped).digest('hex'));
  assert.strictEqual(g.content, shipped.toString('utf8'));
});
test('only a bare file name under guides/ is accepted', () => {
  for (const bad of ['guides/../CHARTER.md', 'guides/sub/x.md', 'CHARTER.md', 'guides/x.txt', null, 42]) {
    assert.strictEqual(readShippedGuide(bad), null, String(bad));
  }
});
test('a missing guide returns null, not a throw', () => assert.strictEqual(readShippedGuide('guides/NOPE.md'), null));
test('the floor points to the guide by its doc_id', () => {
  assert(FLOOR.neurodivergent_support.guide.includes(ID));
});
test('the guide carries the burnout and masking method', () => {
  const t = readShippedGuide(ID).content;
  assert(/burnout is not depression/i.test(t));
  assert(/basic survival/i.test(t));
});

summary('Guides Test Summary');
