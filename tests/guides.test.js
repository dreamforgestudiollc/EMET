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
import { readFloor } from '../src/floor.js';


console.log('\n=== Shipped guides ===');
const ID = 'guides/NEURODIVERGENT_SUPPORT.md';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const GEM_GUIDE = path.join(ROOT, 'gems', 'neurendipity', 'guides', 'NEURODIVERGENT_SUPPORT.md');
test('the neurodivergent support guide ships', () => assert(shippedGuides().includes(ID)));
test('the old id is one file, under the GEM', () => {
  const g = readShippedGuide(ID);
  assert(g && g.source === 'release' && g.content.length > 1000);
  const shipped = fs.readFileSync(GEM_GUIDE);
  // Size pinned by the GEM manifest (gem.json), so a guide revision updates one place.
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'gems', 'neurendipity', 'gem.json'), 'utf8'));
  assert.strictEqual(shipped.length, manifest.files.find((f) => f.path === 'guides/NEURODIVERGENT_SUPPORT.md').size);
  assert.strictEqual(g.sha256, crypto.createHash('sha256').update(shipped).digest('hex'));
  assert.strictEqual(g.content, shipped.toString('utf8'));
  assert.strictEqual(fs.existsSync(path.join(ROOT, 'guides', 'NEURODIVERGENT_SUPPORT.md')), false);
});
test('only a bare file name under guides/ is accepted', () => {
  for (const bad of ['guides/../CHARTER.md', 'guides/sub/x.md', 'CHARTER.md', 'guides/x.txt', null, 42]) {
    assert.strictEqual(readShippedGuide(bad), null, String(bad));
  }
});
test('a missing guide returns null, not a throw', () => assert.strictEqual(readShippedGuide('guides/NOPE.md'), null));
test('the GEM floor points at the old guide id', async () => {
  const r = await readFloor({ gem: 'neurendipity' });
  assert(r.floor.neurodivergent_support.lines.guide.includes(ID));
});
test('the guide carries the burnout and masking method', () => {
  const t = readShippedGuide(ID).content;
  assert(/burnout is not depression/i.test(t));
  assert(/basic survival/i.test(t));
});

summary('Guides Test Summary');test('a bundled GEM guide is served by its guides/ id (AUTISTIC_BURNOUT)', async () => {
  const { readShippedGuide } = await import('../src/guides.js');
  const g = readShippedGuide('guides/AUTISTIC_BURNOUT.md');
  assert.ok(g && /Autistic Burnout Support Guide/.test(g.content));
  assert.ok(/Support only\./.test(g.content));
  assert.strictEqual(readShippedGuide('guides/NOPE_NOT_A_GUIDE.md'), null);
});


