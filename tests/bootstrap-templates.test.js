/**
 * Bootstrap templates — structure ships, personal data does not (2026-09-26).
 */
import { test, summary } from './harness.js';
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { baseMap } from '../src/conformance.js';
import { privateWordsIn } from './scrub-tokens.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

console.log('\n=== Bootstrap templates ===');
for (const name of ['IDENTITY.md', 'CHARACTER.md', 'USER.md', 'INSTALL.md']) {
  test(name + ' ships in templates/', () => {
    assert.ok(fs.existsSync(path.join(ROOT, 'templates', name)));
  });
}
test('map sends bootstrap/IDENTITY.md to templates/IDENTITY.md', () => {
  assert.strictEqual(baseMap().exact['bootstrap/IDENTITY.md'], 'templates/IDENTITY.md');
});
test('map sends bootstrap/USER.md to templates/USER.md', () => {
  assert.strictEqual(baseMap().exact['bootstrap/USER.md'], 'templates/USER.md');
});
test('map sends character aliases to templates/CHARACTER.md', () => {
  const m = baseMap().exact;
  assert.strictEqual(m['bootstrap/CHARACTER.md'], 'templates/CHARACTER.md');
  assert.strictEqual(m['bootstrap/SOUL.md'], 'templates/CHARACTER.md');
});
test('templates use assistant/user, not an install name', () => {
  const id = fs.readFileSync(path.join(ROOT, 'templates', 'IDENTITY.md'), 'utf8');
  assert.deepStrictEqual(privateWordsIn(id), []);
});

summary('Bootstrap Templates Test Summary');
