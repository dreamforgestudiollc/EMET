/**
 * Real client ids and the install tag stay out of the repository.
 * The check walks every file from the repo root. It skips node_modules,
 * .git, and build output (dist, build, coverage).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, summary } from './harness.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage']);
const CLIENT = /\b8xm-[A-Za-z0-9_-]{10,}\b/;
const INSTALL_TAG = 'grok' + '-project';

function filesUnder(dir) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = path.join(dir, name);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) out.push(...filesUnder(full));
    else if (stat.isFile()) out.push(full);
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

function scan(root) {
  const bad = [];
  for (const file of filesUnder(root)) {
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); }
    catch { continue; }
    if (text.includes('\u0000')) continue;
    const lines = hits(text);
    if (lines.length) bad.push(`${path.relative(root, file)}:${lines.slice(0, 5).join(',')}`);
  }
  return bad;
}

console.log('\n=== Public tree scrub ===');

await test('the repository carries no live client id and no install tag', () => {
  assert.deepEqual(scan(ROOT), []);
});

await test('the client pattern and the install tag match a planted line', () => {
  const plantedId = '8xm-' + 'exampleclientid';
  const planted = `client ${plantedId} tag ${INSTALL_TAG}`;
  assert.equal(CLIENT.test(planted), true);
  assert.equal(planted.includes(INSTALL_TAG), true);
  assert.equal(hits('a short 8xm-abc token').length, 0);
});

await test('a planted leak in a root-level README is caught', () => {
  const readme = path.join(ROOT, 'README.md');
  const original = fs.readFileSync(readme, 'utf8');
  const leak = 'client ' + '8xm-' + 'exampleclientid tag ' + INSTALL_TAG;
  fs.writeFileSync(readme, `${original}\n${leak}\n`);
  try {
    const bad = scan(ROOT);
    assert.ok(bad.some((row) => row.startsWith('README.md:')), bad.join('\n'));
  } finally {
    fs.writeFileSync(readme, original);
  }
});

await summary('Public tree scrub');
