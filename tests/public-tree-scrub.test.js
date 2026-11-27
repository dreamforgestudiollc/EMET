/**
 * Real client ids and the install tag stay out of the shipped tree.
 * The check walks src, tests, docs, and site.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, summary } from './harness.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOTS = ['src', 'tests', 'docs', 'site'];
const CLIENT = /\b8xm-[A-Za-z0-9_-]{10,}\b/;
const INSTALL_TAG = 'grok' + '-project';

function filesUnder(dir) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git') continue;
    const full = path.join(dir, name);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) out.push(...filesUnder(full));
    else if (stat.isFile() && stat.size < 2_000_000) out.push(full);
  }
  return out;
}

function hits(text) {
  const found = [];
  const lines = text.split(/\n/);
  for (let i = 0; i < lines.length; i++) {
    if (CLIENT.test(lines[i]) || lines[i].includes(INSTALL_TAG)) found.push(i + 1);
  }
  return found;
}

console.log('\n=== Public tree scrub ===');

await test('src, tests, docs, and site carry no live client id and no install tag', () => {
  const bad = [];
  for (const rel of ROOTS) {
    for (const file of filesUnder(path.join(ROOT, rel))) {
      let text = '';
      try { text = fs.readFileSync(file, 'utf8'); }
      catch { continue; }
      if (text.includes('\u0000')) continue;
      const lines = hits(text);
      if (lines.length) bad.push(`${path.relative(ROOT, file)}:${lines.slice(0, 5).join(',')}`);
    }
  }
  assert.deepEqual(bad, []);
});

await test('the client pattern and the install tag match a planted line', () => {
  const plantedId = '8xm-' + 'exampleclientid';
  const planted = `client ${plantedId} tag ${INSTALL_TAG}`;
  assert.equal(CLIENT.test(planted), true);
  assert.equal(planted.includes(INSTALL_TAG), true);
  assert.equal(hits('a short 8xm-abc token').length, 0);
});

await summary('Public tree scrub');
